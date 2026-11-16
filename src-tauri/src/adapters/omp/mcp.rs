//! OMP native MCP: user `~/.omp/agent/mcp.json`, project `.omp/mcp.json`,
//! stdio/http/sse and OMP's own enabled/disabled overlays for external sources.
//!
//! Native paths follow the OMP settings/MCP documentation: `PI_CONFIG_DIR`
//! relocates the OMP home, `PI_CODING_AGENT_DIR` relocates the default profile
//! agent directory, and a named profile (`OMP_PROFILE`/`PI_PROFILE`) uses
//! `~/.omp/profiles/<name>/agent`. Project configuration is `.omp/mcp.json`.
//!
//! Third-party MCP files (Claude, Codex, Cursor, Windsurf, VS Code, Gemini and
//! the project-root fallback) are discovered read-only. Enabling or disabling
//! one writes only OMP's `enabledServers`/`disabledServers` list in its own user
//! file; the source file is never changed.
use crate::adapters::McpLocation;
use crate::native::adapter::Scope;
use crate::native::format::FileKind;
use crate::resources::mcp::{self, McpDefinition, McpTransport};
use serde_json::{json, Map, Value};
use std::env;
use std::path::{Path, PathBuf};
pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 原生 MCP：用户/项目 mcp.json、stdio/http/sse、外部来源启停覆盖，尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 原生 MCP 与外部来源启停覆盖，第三方文件保持只读";
/// OMP home (`~/.omp` by default). `PI_CONFIG_DIR` is a home-relative
/// directory, matching OMP's own `path.join(home, PI_CONFIG_DIR)`.
pub(crate) fn omp_config_root(home: &Path) -> PathBuf {
    match env::var_os("PI_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        Some(relative)
            if !relative.is_absolute()
                && !relative.components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir
                            | std::path::Component::RootDir
                            | std::path::Component::Prefix(_)
                    )
                }) =>
        {
            home.join(relative)
        }
        _ => home.join(".omp"),
    }
}
/// Effective user agent directory: the active profile or the default one.
/// Delegates the default/named profile rules to the configuration capability so
/// MCP, Skills and Agents cannot disagree with the config editor.
pub(crate) fn user_agent_directory(home: &Path) -> PathBuf {
    user_agent_directory_checked(home)
        .unwrap_or_else(|_| home.join(".cliora-unresolved-omp-profile"))
}

pub(crate) fn user_agent_directory_checked(home: &Path) -> Result<PathBuf, String> {
    let omp_profile = env::var_os("OMP_PROFILE").map(|value| value.to_string_lossy().into_owned());
    let pi_profile = if omp_profile.is_none() {
        env::var_os("PI_PROFILE").map(|value| value.to_string_lossy().into_owned())
    } else {
        None
    };
    let config_dir = env::var_os("PI_CONFIG_DIR")
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from);
    let coding_agent = env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from);
    user_agent_directory_from(
        home,
        omp_profile.as_deref(),
        pi_profile.as_deref(),
        config_dir.as_deref(),
        coding_agent.as_deref(),
    )
}

fn user_agent_directory_from(
    home: &Path,
    omp_profile: Option<&str>,
    pi_profile: Option<&str>,
    config_dir: Option<&Path>,
    coding_agent: Option<&Path>,
) -> Result<PathBuf, String> {
    let resolved = super::configuration::resolve_agent_root(
        home,
        omp_profile,
        pi_profile,
        config_dir,
        coding_agent,
    )?
    .root;
    // An active OAuth/account context keeps resources inside its own root, the
    // same rule the configuration capability uses.
    Ok(crate::accounts::selection::config_root(super::ID, || resolved))
}
/// Project `.omp` directory. OMP does not walk to a parent `.omp` for writes;
/// the selected project is the scope this adapter manages.
pub(crate) fn project_config_directory(project: &Path) -> PathBuf {
    project.join(".omp")
}
pub(crate) fn user_mcp_path(home: &Path) -> PathBuf {
    user_agent_directory(home).join("mcp.json")
}
pub(crate) fn project_mcp_path(project: &Path) -> PathBuf {
    project_config_directory(project).join("mcp.json")
}
pub(crate) fn supported() -> bool {
    true
}
pub(crate) fn facet() -> crate::adapters::Facet {
    if supported() {
        crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        }
    } else {
        crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        }
    }
}
pub(crate) fn location(scope: Scope, home: &Path, project: Option<&Path>) -> Option<McpLocation> {
    Some(McpLocation {
        path: match scope {
            Scope::Global => user_mcp_path(home),
            Scope::Project => project_mcp_path(project?),
        },
        kind: FileKind::Json,
        root: "mcpServers",
        child: None,
    })
}
/// One read-only server discovered from another tool's native file.
#[derive(Clone, Debug)]
pub(crate) struct Observation {
    pub name: String,

    pub entry: Value,

    /// Provider label shown to the user, for example `Claude Code`.
    pub source: &'static str,

    pub path: PathBuf,

    /// Source entry already has `enabled: false`.
    pub source_enabled: bool,
}
impl Observation {
    fn new(name: String, entry: Value, source: &'static str, path: PathBuf) -> Self {
        let source_enabled = entry
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        Self {
            name,
            entry,
            source,
            path,
            source_enabled,
        }
    }
}
/// One foreign source file that could not be read or parsed.
#[derive(Clone, Debug)]
pub(crate) struct ObservationIssue {
    pub source: &'static str,
    pub path: PathBuf,
    pub message: String,
}

/// Resolved foreign servers and the per-source errors of one pass.
#[derive(Clone, Debug, Default)]
pub(crate) struct ObservationSet {
    pub observations: Vec<Observation>,
    pub issues: Vec<ObservationIssue>,
}

fn string_map(root: Option<&Value>, table: &str, nested: &[&str]) -> Result<Map<String, Value>, String> {
    let Some(mut value) = root.and_then(|root| root.get(table)) else {
        return Ok(Map::new());
    };
    for part in nested {
        let Some(child) = value.get(*part) else {
            return Ok(Map::new());
        };
        value = child;
    }
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{table} 不是对象，无法读取 MCP 条目"))
}

fn read_document(path: &Path, kind: FileKind) -> Result<Option<Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取：{error}")),
    };
    crate::native::format::parse(kind, &text)
        .map(Some)
        .map_err(|error| format!("{} 无法解析：{error}", path.display()))
}
/// One table shape a foreign file may use: table name plus optional nested keys.
/// A file may declare MCP entries under more than one documented shape.
type ForeignShape = (&'static str, &'static [&'static str]);
/// One foreign MCP source file.
type ForeignFile = (
    &'static str,
    PathBuf,
    FileKind,
    &'static [ForeignShape],
    bool,
);
const MCP_SERVERS: &[ForeignShape] = &[("mcpServers", &[])];
const OPENCODE_SERVERS: &[ForeignShape] = &[("mcp", &[])];
/// VS Code's documented project file uses `mcp.servers`; native VS Code
/// files use a top-level `servers` table.
const VSCODE_SERVERS: &[ForeignShape] = &[("mcp", &["servers"]), ("servers", &[])];
/// Third-party native files OMP translates, in OMP's discovery priority order.
/// A file that does not exist contributes nothing; an unreadable or malformed
/// file becomes a per-source issue. The source file itself is never rewritten.
fn foreign_files(home: &Path, project: Option<&Path>) -> Vec<ForeignFile> {
    let mut files: Vec<ForeignFile> = Vec::new();
    // Project entries precede same-named user entries for these providers,
    // matching OMP's discovery order. Cross-provider priority follows the
    // documentation: Claude, Codex, Gemini, OpenCode, Cursor/Windsurf, VS Code
    // and finally the portable project fallbacks.
    if let Some(project) = project {
        files.extend([
            (
                "Claude Code",
                project.join(".claude").join(".mcp.json"),
                FileKind::Json,
                MCP_SERVERS,
                false,
            ),
            (
                "Claude Code",
                project.join(".claude").join("mcp.json"),
                FileKind::Json,
                MCP_SERVERS,
                false,
            ),
        ]);
    }
    files.extend([
        (
            "Claude Code",
            home.join(".claude.json"),
            FileKind::Json,
            MCP_SERVERS,
            true,
        ),
        (
            "Claude Code",
            home.join(".claude").join("mcp.json"),
            FileKind::Json,
            MCP_SERVERS,
            true,
        ),
    ]);
    if let Some(project) = project {
        files.push((
            "Codex",
            project.join(".codex").join("config.toml"),
            FileKind::Toml,
            &[("mcp_servers", &[])],
            false,
        ));
    }
    files.push((
        "Codex",
        home.join(".codex").join("config.toml"),
        FileKind::Toml,
        &[("mcp_servers", &[])],
        true,
    ));
    if let Some(project) = project {
        files.push((
            "Gemini CLI",
            project.join(".gemini").join("settings.json"),
            FileKind::Json,
            MCP_SERVERS,
            false,
        ));
    }
    files.push((
        "Gemini CLI",
        home.join(".gemini").join("settings.json"),
        FileKind::Json,
        MCP_SERVERS,
        true,
    ));
    // OpenCode deep-merges layers: `.opencode/` overrides the project root and
    // `.jsonc` overrides `.json` within a directory. The first same-named
    // entry seen therefore has to be the highest-precedence one.
    if let Some(project) = project {
        files.extend([
            (
                "OpenCode",
                project.join(".opencode").join("opencode.jsonc"),
                FileKind::Jsonc,
                OPENCODE_SERVERS,
                false,
            ),
            (
                "OpenCode",
                project.join(".opencode").join("opencode.json"),
                FileKind::Json,
                OPENCODE_SERVERS,
                false,
            ),
            (
                "OpenCode",
                project.join("opencode.jsonc"),
                FileKind::Jsonc,
                OPENCODE_SERVERS,
                false,
            ),
            (
                "OpenCode",
                project.join("opencode.json"),
                FileKind::Json,
                OPENCODE_SERVERS,
                false,
            ),
        ]);
    }
    files.extend([
        (
            "OpenCode",
            home.join(".config")
                .join("opencode")
                .join("opencode.jsonc"),
            FileKind::Jsonc,
            OPENCODE_SERVERS,
            true,
        ),
        (
            "OpenCode",
            home.join(".config").join("opencode").join("opencode.json"),
            FileKind::Json,
            OPENCODE_SERVERS,
            true,
        ),
    ]);
    if let Some(project) = project {
        files.push((
            "Cursor",
            project.join(".cursor").join("mcp.json"),
            FileKind::Json,
            MCP_SERVERS,
            false,
        ));
    }
    files.push((
        "Cursor",
        home.join(".cursor").join("mcp.json"),
        FileKind::Json,
        MCP_SERVERS,
        true,
    ));
    if let Some(project) = project {
        files.push((
            "Windsurf",
            project.join(".windsurf").join("mcp_config.json"),
            FileKind::Json,
            MCP_SERVERS,
            false,
        ));
    }
    files.push((
        "Windsurf",
        home.join(".codeium")
            .join("windsurf")
            .join("mcp_config.json"),
        FileKind::Json,
        MCP_SERVERS,
        true,
    ));
    if let Some(project) = project {
        files.push((
            "VS Code",
            project.join(".vscode").join("mcp.json"),
            FileKind::Json,
            VSCODE_SERVERS,
            false,
        ));
    }
    if let Some(project) = project {
        // OMP also reads these portable fallbacks, but does not own them.
        files.extend([
            (
                "项目 fallback",
                project.join("mcp.json"),
                FileKind::Json,
                MCP_SERVERS,
                false,
            ),
            (
                "项目 fallback",
                project.join(".mcp.json"),
                FileKind::Json,
                MCP_SERVERS,
                false,
            ),
        ]);
    }
    files
}
fn read_foreign(
    source: &'static str,
    path: PathBuf,
    kind: FileKind,
    shapes: &[ForeignShape],
) -> Result<Vec<Observation>, String> {
    let Some(value) = read_document(&path, kind)? else {
        return Ok(Vec::new());
    };
    for (table, nested) in shapes {
        let entries = string_map(Some(&value), table, nested)?;
        if !entries.is_empty() {
            return Ok(entries
                .into_iter()
                .map(|(name, entry)| Observation::new(name, entry, source, path.clone()))
                .collect());
        }
    }
    Ok(Vec::new())
}
fn provider_id(source: &str) -> Option<&'static str> {
    match source {
        "Claude Code" => Some("claude"),
        "Codex" => Some("codex"),
        "Gemini CLI" => Some("gemini"),
        "OpenCode" => Some("opencode"),
        "VS Code" => Some("vscode"),
        "Cursor" => Some("cursor"),
        "Windsurf" => Some("windsurf"),
        _ => None,
    }
}
/// Foreign user-level sources are opt-in for OMP. Project files load by
/// default unless `mcp.enableProjectConfig` is false. A missing settings file
/// keeps the documented defaults; an unreadable or malformed one is reported
/// instead of silently behaving as if every source were off.
struct UserSources {
    enabled: Vec<String>,
    disabled: Vec<String>,
    project_enabled: bool,
    config: PathBuf,
}

fn user_sources(home: &Path) -> Result<UserSources, (PathBuf, String)> {
    let agent = user_agent_directory_checked(home).map_err(|error| {
        (
            home.join(".cliora-unresolved-omp-profile").join("config.yml"),
            error,
        )
    })?;
    let yml = agent.join("config.yml");
    let config = if yml.is_file() {
        yml
    } else {
        agent.join("config.yaml")
    };
    let text = match std::fs::read_to_string(&config) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(UserSources {
                enabled: Vec::new(),
                disabled: Vec::new(),
                project_enabled: true,
                config,
            })
        }
        Err(error) => return Err((config, format!("无法读取：{error}"))),
    };
    let value = serde_yaml::from_str::<Value>(&text)
        .map_err(|error| (config.clone(), format!("YAML 无法解析：{error}")))?;
    let list = |field: &str| -> Vec<String> {
        value
            .get(field)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let project_enabled = value
        .pointer("/mcp/enableProjectConfig")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(UserSources {
        enabled: list("enabledProviders"),
        disabled: list("disabledProviders"),
        project_enabled,
        config,
    })
}
fn user_source_enabled(source: &str, enabled: &[String], disabled: &[String]) -> bool {
    let Some(id) = provider_id(source) else {
        return true;
    };
    if disabled
        .iter()
        .any(|item| item == id || item == "*" || item == "all")
    {
        return false;
    }
    // Cursor/Windsurf user roots are not part of OMP's opt-in foreign list.
    if !matches!(id, "claude" | "codex" | "gemini" | "opencode") {
        return true;
    }
    enabled
        .iter()
        .any(|item| item == id || item == "*" || item == "all")
}
pub(crate) fn observations(
    home: &Path,
    project: Option<&Path>,
) -> Result<ObservationSet, String> {
    let mut found: Vec<Observation> = Vec::new();
    let mut issues: Vec<ObservationIssue> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let (enabled_providers, disabled_providers, project_enabled, config) = match user_sources(home) {
        Ok(sources) => (
            sources.enabled,
            sources.disabled,
            sources.project_enabled,
            sources.config,
        ),
        Err((path, message)) => {
            issues.push(ObservationIssue {
                source: "OMP 配置",
                path,
                message: format!("{message}；用户级外部来源按未启用处理"),
            });
            (Vec::new(), Vec::new(), true, user_agent_directory(home).join("config.yml"))
        }
    };
    if project.is_some() && !project_enabled {
        issues.push(ObservationIssue {
            source: "OMP 项目 MCP",
            path: config,
            message: "OMP 配置 mcp.enableProjectConfig=false；项目来源未加载，项目条目不会生效".into(),
        });
    }
    for (source, path, kind, shapes, user_level) in foreign_files(home, project) {
        if !user_level && !project_enabled {
            continue;
        }
        if user_level && !user_source_enabled(source, &enabled_providers, &disabled_providers) {
            continue;
        }
        match read_foreign(source, path.clone(), kind, shapes) {
            Ok(observations) => {
                for observation in observations {
                    if seen.insert(observation.name.clone()) {
                        found.push(observation);
                    }
                }
            }
            Err(message) => issues.push(ObservationIssue {
                source,
                path,
                message,
            }),
        }
    }
    // OMP's own user overlays also decide whether a foreign entry loads.
    let overlay_path = user_mcp_path(home);
    let overlay = match std::fs::read_to_string(&overlay_path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(error) => {
                issues.push(ObservationIssue {
                    source: "OMP 覆盖配置",
                    path: overlay_path,
                    message: format!("JSON 无法解析：{error}；本次启停覆盖按空处理"),
                });
                json!({})
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => {
            issues.push(ObservationIssue {
                source: "OMP 覆盖配置",
                path: overlay_path,
                message: format!("无法读取：{error}；本次启停覆盖按空处理"),
            });
            json!({})
        }
    };
    let disabled: Vec<&str> = overlay
        .get("disabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let enabled: Vec<&str> = overlay
        .get("enabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for observation in &mut found {
        observation.source_enabled = if disabled.contains(&observation.name.as_str()) {
            false
        } else if enabled.contains(&observation.name.as_str()) {
            true
        } else {
            observation.source_enabled
        };
    }
    Ok(ObservationSet {
        observations: found,
        issues,
    })
}
/// Whether project-scoped MCP sources are loaded by the current OMP settings.
pub(crate) fn project_scope_effective(home: &Path) -> Result<bool, String> {
    user_sources(home)
        .map(|sources| sources.project_enabled)
        .map_err(|(_, message)| message)
}
/// Imported servers are switched through the active profile's own user file;
/// OMP has no project-level cross-source override.
pub(crate) fn external_switch(
    _scope: Scope,
    home: &Path,
    _project: Option<&Path>,
) -> Option<crate::adapters::McpExternalSwitch> {
    Some(crate::adapters::McpExternalSwitch {
        path: user_mcp_path(home),
        kind: FileKind::Json,
    })
}
/// OMP-owned field changes for one imported server. `overlay_lists` keeps every
/// unrelated entry and never mentions a source file.
pub(crate) fn external_changes(
    parsed: &Value,
    name: &str,
    enabled: bool,
    source_enabled: bool,
) -> Vec<crate::native::transaction::FieldChange> {
    let (disabled, allow) = overlay_lists(parsed, name, enabled, source_enabled);
    vec![
        crate::native::transaction::FieldChange {
            path: vec!["disabledServers".into()],
            value: (!disabled.is_empty()).then(|| json!(disabled)),
        },
        crate::native::transaction::FieldChange {
            path: vec!["enabledServers".into()],
            value: (!allow.is_empty()).then(|| json!(allow)),
        },
    ]
}
fn malformed_entry(entry: &Value) -> Option<&'static str> {
    let Some(object) = entry.as_object() else {
        return Some("条目不是对象");
    };
    let kind = object.get("type").and_then(Value::as_str);
    if let Some(kind) = kind {
        if !matches!(kind, "stdio" | "http" | "sse") {
            return Some("未知的 MCP 传输类型，应为 stdio/http/sse。");
        }
    }
    let command = object.get("command").and_then(Value::as_str).unwrap_or("");
    let url = object.get("url").and_then(Value::as_str).unwrap_or("");
    if !command.is_empty() && !url.is_empty() {
        return Some("同时设置了 command 和 url；OMP 会拒绝该条目");
    }
    let effective = kind.unwrap_or(if url.is_empty() { "stdio" } else { "http" });
    if effective == "stdio" && command.trim().is_empty() {
        return Some("stdio MCP 缺少 command");
    }
    if matches!(effective, "http" | "sse") {
        if url.trim().is_empty() {
            return Some("HTTP/SSE MCP 缺少 url");
        }
        match url::Url::parse(url) {
            Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => {}
            _ => return Some("MCP url 不是有效的 HTTP(S) 地址"),
        }
    }
    None
}
/// Entry view with the local effective enabled state and a validation issue.
/// `enabledServers`/`disabledServers` in the same user file are applied here.
pub(crate) fn entry_view(entry: &Value) -> Value {
    let mut view = entry.as_object().cloned().unwrap_or_default();
    if let Some(issue) = malformed_entry(entry) {
        view.insert("issue".into(), Value::String(issue.into()));
        view.insert("enabled".into(), Value::Bool(false));
    }
    Value::Object(view)
}
/// Entries from the parsed user/project file, with overlay arrays applied.
pub(crate) fn entries(
    parsed: &Value,
    location: &McpLocation,
) -> Result<Map<String, Value>, String> {
    let root = parsed.get(location.root);
    let entries = root
        .and_then(|root| location.child.map_or(Some(root), |child| root.get(child)))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let disabled: Vec<&str> = parsed
        .get("disabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let enabled: Vec<&str> = parsed
        .get("enabledServers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    Ok(entries
        .into_iter()
        .map(|(name, mut entry)| {
            let source_enabled = entry
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let effective = if disabled.contains(&name.as_str()) {
                false
            } else if enabled.contains(&name.as_str()) {
                true
            } else {
                source_enabled
            };
            if let Some(object) = entry.as_object_mut() {
                object.insert("enabled".into(), Value::Bool(effective));
            }
            (name, entry)
        })
        .collect())
}
pub(crate) fn document(
    definition: &McpDefinition,
    enabled: bool,
    existing: Option<&Value>,
) -> Result<Option<Value>, String> {
    if definition.transport == McpTransport::Stdio && definition.command.trim().is_empty() {
        return Err("stdio MCP 需要命令".into());
    }
    if matches!(definition.transport, McpTransport::Http | McpTransport::Sse)
        && definition.url.trim().is_empty()
    {
        return Err("HTTP/SSE MCP 需要地址".into());
    }
    let mut map = match definition.transport {
        McpTransport::Stdio => {
            let mut map = mcp::stdio_doc(definition, existing);
            mcp::apply_cwd(&mut map, definition);
            map
        }
        McpTransport::Http | McpTransport::Sse => mcp::http_doc(definition, existing, "headers"),
    };
    map.insert(
        "type".into(),
        json!(match definition.transport {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
            McpTransport::Sse => "sse",
        }),
    );
    map.insert("enabled".into(), json!(enabled));
    Ok(Some(Value::Object(map)))
}
pub(crate) fn disabled_description() -> Option<&'static str> {
    Some("停用写入 OMP 原生 enabled: false；第三方文件保持只读")
}
pub(crate) fn supports_cwd() -> bool {
    true
}
pub(crate) fn supports_sse() -> bool {
    true
}
/// Apply enable/disable to OMP's own user overlay for an external server.
/// The source file is untouched. Returns the next overlay arrays.
pub(crate) fn overlay_lists(
    parsed: &Value,
    name: &str,
    enabled: bool,
    source_enabled: bool,
) -> (Vec<String>, Vec<String>) {
    let list = |field: &str| -> Vec<String> {
        parsed
            .get(field)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut disabled = list("disabledServers");
    let mut allow = list("enabledServers");
    if enabled {
        disabled.retain(|item| item != name);
        if source_enabled {
            allow.retain(|item| item != name);
        } else if !allow.iter().any(|item| item == name) {
            allow.push(name.to_owned());
        }
    } else {
        allow.retain(|item| item != name);
        if !disabled.iter().any(|item| item == name) {
            disabled.push(name.to_owned());
        }
    }
    (disabled, allow)
}
pub(crate) fn remote_layout() -> crate::adapters::RemoteResourceLayout {
    crate::adapters::RemoteResourceLayout {
        mcp: Some(crate::adapters::RemoteMcpLayout {
            relative: ".omp/agent/mcp.json",
            format: "json",
            table: "mcpServers",
            nested: false,
        }),
        skill_root: Some(".omp/agent/skills"),
        agent_root: Some(".omp/agent/agents"),
        agent_extension: Some("md"),
    }
}
pub(crate) fn remote_native_documents() -> &'static [crate::adapters::RemoteNativeDocument] {
    &[]
}
fn checks(entries: Vec<(String, bool, String)>) -> Value {
    let failed = entries.iter().any(|(_, passed, _)| !passed);
    json!({
        "passed": !failed,
        "checks": entries
            .into_iter()
            .map(|(name, passed, detail)| json!({ "name": name, "passed": passed, "detail": detail }))
            .collect::<Vec<_>>(),
    })
}
pub(crate) fn verify_case(
    case: &serde_json::Value,
    context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    let action = case
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| super::verify::CaseError::Failed("mcp 用例缺少 action".into()))?;
    let mut entries = Vec::new();
    match action {
        "layout" => {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .ok_or_else(|| super::verify::CaseError::Failed("layout 用例缺少 expect".into()))?;
            let path = |scope: Scope| {
                location(scope, &context.home, Some(&context.project))
                    .map(|location| location.path.display().to_string().replace('\\', "/"))
                    .unwrap_or_default()
            };
            for (field, actual) in [
                ("user", path(Scope::Global)),
                ("project", path(Scope::Project)),
            ] {
                let expected = expect
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .replace(
                        "{home}",
                        &context.home.display().to_string().replace('\\', "/"),
                    )
                    .replace(
                        "{project}",
                        &context.project.display().to_string().replace('\\', "/"),
                    );
                entries.push((
                    format!("{field} 匹配"),
                    actual == expected,
                    format!("实际 {actual}，期望 {expected}"),
                ));
            }
            entries.push((
                "root key".into(),
                location(Scope::Global, &context.home, None)
                    .is_some_and(|location| location.root == "mcpServers"),
                "mcpServers".into(),
            ));
        }
        "documents" => {
            let items = case.get("cases").and_then(Value::as_array).ok_or_else(|| {
                super::verify::CaseError::Failed("documents 用例缺少 cases".into())
            })?;
            for item in items {
                let transport = match item.get("transport").and_then(Value::as_str) {
                    Some("http") => McpTransport::Http,
                    Some("sse") => McpTransport::Sse,
                    _ => McpTransport::Stdio,
                };
                let definition = McpDefinition {
                    id: "fixture".into(),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("fixture")
                        .to_owned(),
                    transport,
                    command: item
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    args: item
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    cwd: String::new(),
                    url: item
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    env: Default::default(),
                    headers: Default::default(),
                    in_library: true,
                    version: 1,
                    updated_at: None,
                };
                let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                let proposed = document(&definition, enabled, None)
                    .map_err(super::verify::CaseError::Failed)?;
                let proposed = proposed
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                let expected_type = match transport {
                    McpTransport::Stdio => "stdio",
                    McpTransport::Http => "http",
                    McpTransport::Sse => "sse",
                };
                entries.push((
                    format!("{} type", definition.name),
                    proposed.get("type").and_then(Value::as_str) == Some(expected_type),
                    format!("{:?}", proposed.get("type")),
                ));
                entries.push((
                    format!("{} enabled", definition.name),
                    proposed.get("enabled").and_then(Value::as_bool) == Some(enabled),
                    format!("{:?}", proposed.get("enabled")),
                ));
                if transport == McpTransport::Stdio {
                    entries.push((
                        format!("{} command", definition.name),
                        proposed.get("command").and_then(Value::as_str)
                            == Some(definition.command.as_str()),
                        format!("{:?}", proposed.get("command")),
                    ));
                } else {
                    entries.push((
                        format!("{} 不应写 command", definition.name),
                        !proposed.contains_key("command"),
                        "url 条目不应写 command".into(),
                    ));
                }
            }
        }
        "overlay" => {
            let list = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| super::verify::CaseError::Failed("overlay 用例缺少 cases".into()))?;
            for item in list {
                let parsed = item.get("config").cloned().unwrap_or_else(|| json!({}));
                let name = item.get("name").and_then(Value::as_str).unwrap_or("server");
                let enabled = item.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                let source_enabled = item
                    .get("sourceEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let (disabled, allow) = overlay_lists(&parsed, name, enabled, source_enabled);
                let expect_disabled: Vec<&str> = item
                    .get("expectDisabled")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let expect_enabled: Vec<&str> = item
                    .get("expectEnabled")
                    .and_then(Value::as_array)
                    .map(|items| items.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                entries.push((
                    format!("{name} disabledServers"),
                    disabled == expect_disabled,
                    format!("实际 {disabled:?}"),
                ));
                entries.push((
                    format!("{name} enabledServers"),
                    allow == expect_enabled,
                    format!("实际 {allow:?}"),
                ));
            }
        }
        "foreign" => {
            let home = context.home.join(
                case.get("base")
                    .and_then(Value::as_str)
                    .unwrap_or("foreign")
                    .to_owned()
                    + "/home",
            );
            let project = context.project.join(
                case.get("base")
                    .and_then(Value::as_str)
                    .unwrap_or("foreign")
                    .to_owned()
                    + "/project",
            );
            for directory in [&home, &project] {
                std::fs::create_dir_all(directory)
                    .map_err(|error| super::verify::CaseError::Failed(error.to_string()))?;
            }
            for file in case
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let root = match file.get("scope").and_then(Value::as_str) {
                    Some("project") => &project,
                    _ => &home,
                };
                let relative = file
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| super::verify::CaseError::Failed("foreign 用例缺少 path".into()))?;
                let path = root.join(relative);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| super::verify::CaseError::Failed(error.to_string()))?;
                }
                let content = file.get("content").and_then(Value::as_str).unwrap_or("");
                std::fs::write(&path, content)
                    .map_err(|error| super::verify::CaseError::Failed(error.to_string()))?;
            }
            let found = observations(&home, Some(&project)).map_err(super::verify::CaseError::Failed)?;
            for expected in case
                .get("expect")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let name = expected.get("name").and_then(Value::as_str).unwrap_or("server");
                let actual = found.observations.iter().find(|item| item.name == name);
                let source_ok = expected
                    .get("source")
                    .and_then(Value::as_str)
                    .is_none_or(|source| actual.is_some_and(|item| item.source == source));
                let enabled_ok = expected
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .is_none_or(|enabled| actual.is_some_and(|item| item.source_enabled == enabled));
                entries.push((
                    format!("{name} 来源"),
                    actual.is_some() && source_ok,
                    format!("{:?}", actual.map(|item| item.source)),
                ));
                entries.push((
                    format!("{name} 生效"),
                    actual.is_some() && enabled_ok,
                    format!("{:?}", actual.map(|item| item.source_enabled)),
                ));
            }
            for expected in case
                .get("expectIssues")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let message = expected.get("message").and_then(Value::as_str).unwrap_or("");
                let path = expected.get("path").and_then(Value::as_str).unwrap_or("");
                entries.push((
                    format!("来源错误 {path}"),
                    found.issues.iter().any(|issue| {
                        issue.path.display().to_string().replace('\\', "/").contains(path)
                            && issue.message.contains(message)
                    }),
                    format!("{:?}", found.issues.iter().map(|issue| &issue.message).collect::<Vec<_>>()),
                ));
            }
            for name in case
                .get("expectAbsent")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                entries.push((
                    format!("{name} 不应加载"),
                    !found.observations.iter().any(|item| item.name == name),
                    format!(
                        "{:?}",
                        found.observations.iter().map(|item| &item.name).collect::<Vec<_>>()
                    ),
                ));
            }
        }
        "entry-validation" => {
            let items = case.get("cases").and_then(Value::as_array).ok_or_else(|| {
                super::verify::CaseError::Failed("entry-validation 用例缺少 cases".into())
            })?;
            for item in items {
                let entry = item.get("entry").cloned().unwrap_or_else(|| json!({}));
                let view = entry_view(&entry);
                let expect_issue = item.get("issue").and_then(Value::as_str);
                match expect_issue {
                    Some(needle) => entries.push((
                        item.get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("entry")
                            .to_owned(),
                        view.get("issue")
                            .and_then(Value::as_str)
                            .is_some_and(|issue| issue.contains(needle)),
                        format!("{:?}", view.get("issue")),
                    )),
                    None => entries.push((
                        item.get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("entry")
                            .to_owned(),
                        view.get("issue").is_none(),
                        "无效条目的 issue".into(),
                    )),
                }
            }
        }
        other => {
            return Err(super::verify::CaseError::Failed(format!(
                "未知的 mcp 动作：{other}"
            )))
        }
    }
    Ok(json!({ "kind": "mcp", "action": action, "result": checks(entries) }))
}
#[cfg(test)]
mod tests {

    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/example")
    }
    #[test]

    fn native_paths_follow_default_profile_and_project() {
        assert_eq!(user_mcp_path(&home()), home().join(".omp/agent/mcp.json"));
        assert_eq!(
            project_mcp_path(Path::new("/work/app")),
            Path::new("/work/app/.omp/mcp.json")
        );
        let location = location(Scope::Global, &home(), None).unwrap();
        assert_eq!(location.path, home().join(".omp/agent/mcp.json"));
        assert_eq!(location.kind, FileKind::Json);
        assert_eq!(location.root, "mcpServers");
    }
    #[test]
    fn shared_profile_resolution_matches_accounts_and_configuration() {
        let home = home();
        assert_eq!(
            user_agent_directory_from(&home, Some(""), Some("work"), None, None).unwrap(),
            home.join(".omp/agent")
        );
        assert_eq!(
            user_agent_directory_from(&home, Some("  "), Some("work"), None, None).unwrap(),
            home.join(".omp/agent")
        );
        assert_eq!(
            user_agent_directory_from(&home, Some("default"), Some("work"), None, None).unwrap(),
            home.join(".omp/agent")
        );
        assert_eq!(
            user_agent_directory_from(&home, None, Some(" work "), None, None).unwrap(),
            home.join(".omp/profiles/work/agent")
        );
        let ignored = std::env::temp_dir().join("ignored-for-profile");
        assert_eq!(
            user_agent_directory_from(
                &home,
                None,
                Some("work"),
                Some(Path::new("custom-config")),
                Some(ignored.as_path()),
            )
            .unwrap(),
            home.join("custom-config/profiles/work/agent")
        );
        assert!(user_agent_directory_from(&home, Some("Work"), None, None, None).is_err());
        assert!(
            user_agent_directory_from(&home, None, None, None, Some(Path::new("relative")))
                .is_err()
        );
    }
    #[test]

    fn overlay_lists_never_touch_the_source_and_keep_priority() {
        let parsed = json!({"disabledServers":["keep"], "enabledServers":["force"]});
        let (disabled, allow) = overlay_lists(&parsed, "github", false, true);
        assert_eq!(disabled, vec!["keep", "github"]);
        assert_eq!(allow, vec!["force"]);
        let (disabled, allow) = overlay_lists(&parsed, "tool-owned", true, false);
        assert_eq!(disabled, vec!["keep"]);
        assert_eq!(allow, vec!["force", "tool-owned"]);
        let (disabled, allow) = overlay_lists(&parsed, "force", true, true);
        assert_eq!(disabled, vec!["keep"]);
        assert_eq!(allow, Vec::<String>::new());
    }
    #[test]

    fn invalid_entries_are_visible_per_entry_and_not_fatal() {
        assert!(malformed_entry(&json!({"type":"stdio","command":"npx"})).is_none());
        assert!(
            malformed_entry(&json!({"type":"http","url":"https://example.test/mcp"})).is_none()
        );
        assert!(malformed_entry(&json!({"type":"sse","url":"https://example.test/sse"})).is_none());
        assert!(
            malformed_entry(&json!({"type":"websocket","url":"https://example.test"})).is_some()
        );
        assert!(malformed_entry(&json!({"command":"npx","url":"https://example.test"})).is_some());
        assert!(malformed_entry(&json!({"type":"stdio","args":[]})).is_some());
        assert!(malformed_entry(&json!({"type":"http"})).is_some());
        let view = entry_view(&json!({"type":"unknown","command":"npx"}));
        assert!(view["issue"].as_str().unwrap().contains("未知"));
        assert_eq!(view["enabled"], json!(false));
    }
    #[test]

    fn entries_apply_overlay_arrays_without_rewriting_the_file() {
        let location = location(Scope::Global, &home(), None).unwrap();
        let parsed = json!({
            "mcpServers": {
                "one": {"command":"npx", "enabled": true},
                "two": {"command":"npx", "enabled": false},
                "three": {"command":"npx"}
            },
            "disabledServers": ["one"],
            "enabledServers": ["two"]
        });
        let entries = entries(&parsed, &location).unwrap();
        assert_eq!(entries["one"]["enabled"], json!(false));
        assert_eq!(entries["two"]["enabled"], json!(true));
        assert_eq!(entries["three"]["enabled"], json!(true));
        // Parsing is read-only: the original JSON was not changed.
        assert_eq!(parsed["mcpServers"]["one"]["enabled"], json!(true));
    }
    #[test]

    fn external_observations_are_deduplicated_and_use_omp_overlays() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let write = |relative: &str, text: &str| {
            let path = home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            ".claude/mcp.json",
            r#"{"mcpServers":{"github":{"type":"http","url":"https://example.test/mcp"},"force":{"command":"npx","enabled":false}}}"#,
        );
        write(
            ".cursor/mcp.json",
            r#"{"mcpServers":{"github":{"command":"shadowed"},"cursor-only":{"command":"uvx"}}}"#,
        );
        write(".omp/agent/mcp.json", r#"{"disabledServers":["github"]}"#);
        write(".omp/agent/config.yml", "enabledProviders:\n  - claude\n");
        let found = observations(home, None).unwrap();
        assert!(found.issues.is_empty());
        let found = found.observations;
        let github = found.iter().find(|item| item.name == "github").unwrap();
        assert_eq!(github.source, "Claude Code");
        assert!(
            !github.source_enabled,
            "OMP disabledServers must hide the foreign entry"
        );
        assert!(!found
            .iter()
            .any(|item| item.name == "cursor-only" && item.source == "Claude Code"));
        assert_eq!(
            found.iter().filter(|item| item.name == "github").count(),
            1,
            "the first provider wins by name"
        );
    }
    #[test]

    fn stdio_http_and_sse_documents_keep_their_transport() {
        let base = |transport| McpDefinition {
            id: "fixture".into(),
            name: "example".into(),
            transport,
            command: if transport == McpTransport::Stdio {
                "npx".into()
            } else {
                String::new()
            },
            args: vec!["-y".into(), "pkg".into()],
            cwd: String::new(),
            url: if transport == McpTransport::Stdio {
                String::new()
            } else {
                "https://example.test/mcp".into()
            },
            env: Default::default(),
            headers: Default::default(),
            in_library: true,
            version: 1,
            updated_at: None,
        };
        let stdio = document(&base(McpTransport::Stdio), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(stdio["type"], json!("stdio"));
        assert_eq!(stdio["command"], json!("npx"));
        let mut with_cwd = base(McpTransport::Stdio);
        with_cwd.cwd = "/work/root".into();
        let cwd = document(&with_cwd, true, None).unwrap().unwrap();
        assert_eq!(cwd["cwd"], json!("/work/root"));
        let cleared = document(&base(McpTransport::Stdio), true, Some(&cwd))
            .unwrap()
            .unwrap();
        assert!(cleared.get("cwd").is_none());
        let http = document(&base(McpTransport::Http), false, None)
            .unwrap()
            .unwrap();
        assert_eq!(http["type"], json!("http"));
        assert_eq!(http["enabled"], json!(false));
        assert!(http.get("command").is_none());
        let sse = document(&base(McpTransport::Sse), true, None)
            .unwrap()
            .unwrap();
        assert_eq!(sse["type"], json!("sse"));
        assert_eq!(sse["url"], json!("https://example.test/mcp"));
    }

    #[test]
    fn vscode_project_shapes_and_cross_provider_priority_are_read() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let write = |path: &Path, text: &str| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            &project.join(".vscode/mcp.json"),
            r#"{"mcp":{"servers":{"shared":{"type":"http","url":"https://vscode.test/mcp"}}}}"#,
        );
        write(
            &project.join(".opencode/opencode.json"),
            r#"{"mcp":{"shared":{"type":"local","command":["npx","opencode"]}}}"#,
        );
        write(
            &project.join(".cursor/mcp.json"),
            r#"{"mcpServers":{"shared":{"command":"cursor"}}}"#,
        );
        let found = observations(&home, Some(&project)).unwrap();
        assert!(found.issues.is_empty(), "{:?}", found.issues);
        let shared = found
            .observations
            .iter()
            .find(|item| item.name == "shared")
            .unwrap();
        assert_eq!(shared.source, "OpenCode", "OpenCode outranks Cursor/VS Code");
        let vs = found
            .observations
            .iter()
            .find(|item| item.name == "shared")
            .unwrap();
        // The VS Code entry is shadowed by the higher-priority OpenCode one.
        assert_eq!(vs.path, project.join(".opencode/opencode.json"));

        let other = temp.path().join("native-top");
        write(
            &other.join(".vscode/mcp.json"),
            r#"{"servers":{"top":{"command":"npx"}}}"#,
        );
        let found = observations(&home, Some(&other)).unwrap();
        let top = found
            .observations
            .iter()
            .find(|item| item.name == "top")
            .unwrap();
        assert_eq!(top.source, "VS Code");
    }

    #[test]
    fn unreadable_foreign_files_keep_valid_sources_and_expose_the_error() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let write = |relative: &str, text: &str| {
            let path = home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(".claude.json", "{ not json");
        write(".omp/agent/config.yml", "enabledProviders:\n  - claude\n");
        write(
            ".cursor/mcp.json",
            r#"{"mcpServers":{"cursor-only":{"command":"uvx"}}}"#,
        );
        let found = observations(home, None).unwrap();
        assert_eq!(found.observations.len(), 1);
        assert_eq!(found.observations[0].name, "cursor-only");
        assert!(found
            .issues
            .iter()
            .any(|issue| issue.path == home.join(".claude.json")
                && issue.message.contains("无法解析")));
    }

    #[test]
    fn disabled_project_config_skips_project_sources_with_an_issue() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        for (path, text) in [
            (
                home.join(".omp/agent/config.yml"),
                "mcp:\n  enableProjectConfig: false\n",
            ),
            (
                project.join(".claude/mcp.json"),
                r#"{"mcpServers":{"project-only":{"command":"npx"}}}"#,
            ),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let found = observations(&home, Some(&project)).unwrap();
        assert!(found.observations.is_empty());
        assert!(found
            .issues
            .iter()
            .any(|issue| issue.message.contains("enableProjectConfig=false")));
        assert!(!project_scope_effective(&home).unwrap());
    }
}
