pub mod accounts;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
pub(crate) mod usage;
mod configuration;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

use super::{
    file, project_root, CliAdapter, InspectionFields, LaunchMode, McpLocation,
    NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::string_at;
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Claude;

// Injected by a running Claude Code into its subprocesses; a fresh terminal session
// must not inherit them (CLAUDE_CODE_CHILD_SESSION disables transcript saving).
const SESSION_ENV_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
];

impl CliAdapter for Claude {
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        Some(self)
    }
    fn supports_mcp(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn official_usage(&self) -> Option<&dyn crate::adapters::official::OfficialUsageAdapter> {
        Some(self)
    }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn accounts(&self) -> Option<&dyn crate::adapters::accounts::AccountAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "claude_code"
    }
    fn name(&self) -> &'static str {
        "Claude Code"
    }
    fn command(&self) -> &'static str {
        "claude"
    }
    fn npm_package(&self) -> &'static str {
        "@anthropic-ai/claude-code"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("claude")
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(root) => vec![
                file(
                    "settings",
                    root.join(".claude/settings.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
                file(
                    "local_settings",
                    root.join(".claude/settings.local.json"),
                    FileKind::Json,
                    known,
                    None,
                    false,
                ),
            ],
            None => vec![file(
                "settings",
                crate::accounts::selection::config_root("claude_code", || home.join(".claude"))
                    .join("settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &["anthropic_messages"]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if matches!(role, "settings" | "local_settings") {
            Ok(FileKind::Json)
        } else {
            Err("Claude Code 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["model", "env", "permissions", "alwaysThinkingEnabled", "effortLevel", "modelSettings", "modelPicker"]
        } else {
            &[]
        }
    }
    fn skill_switch_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
    ) -> Option<super::SkillSwitchLocation> {
        let file = self
            .native_files(scope, home, project, true)
            .into_iter()
            .find(|file| file.role == "settings")?;
        let kind = FileKind::for_name(&file.path).ok()?;
        Some(super::SkillSwitchLocation {
            path: file.path.into(),
            kind,
            field: vec!["skillOverrides".into(), name.into()],
        })
    }
    fn skill_switch_value(&self, _: &Value, enabled: bool, _: &Path) -> Value {
        json!(if enabled { "on" } else { "off" })
    }
    fn skill_switch_enabled(&self, current: &Value, _: &Path) -> bool {
        current.as_str() != Some("off")
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => crate::accounts::selection::current("claude_code")
                .map(|ctx| ctx.config_root.join(".claude.json"))
                .unwrap_or_else(|| home.join(".claude.json")),
            Scope::Project => project?.join(".mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目，Cliora 中的定义仍保留")
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // Claude Code has no per-entry enabled flag in .mcp.json. Removing the
        // native entry stops loading it; Cliora keeps the definition for re-enable.
        if !enabled {
            return Ok(None);
        }
        let mut map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        map.insert(
            "type".into(),
            json!(if definition.transport == McpTransport::Http {
                "http"
            } else {
                "stdio"
            }),
        );
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => {
                crate::accounts::selection::config_root("claude_code", || home.join(".claude"))
                    .join("skills")
            }
            Scope::Project => project?.join(".claude/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => {
                crate::accounts::selection::config_root("claude_code", || home.join(".claude"))
                    .join("CLAUDE.md")
            }
            Scope::Project => project?.join("CLAUDE.md"),
        })
    }
    fn auth_env_name(&self, connection: &Connection) -> Option<String> {
        connection.auth_env_var.clone().or_else(|| {
            connection
                .secret_ref
                .as_ref()
                .map(|_| "ANTHROPIC_API_KEY".into())
        })
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if connection.interface_format != "anthropic_messages" {
            return Err("Claude Code 此版本只支持 Anthropic Messages 接口".into());
        }
        let mut settings = json!({});
        set_json(&mut settings, &["model"], json!(connection.model));
        set_json(
            &mut settings,
            &["env", "ANTHROPIC_MODEL"],
            json!(connection.model),
        );
        set_json(
            &mut settings,
            &["env", "ANTHROPIC_BASE_URL"],
            json!(connection.base_url),
        );
        Ok(BTreeMap::from([("settings".into(), settings)]))
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let mut docs = self.connection_documents(connection, scope)?;
        let existing_settings = existing
            .get("settings")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(options) = catalog_options(connection, &existing_settings) {
            set_json(
                docs.get_mut("settings").expect("Claude settings document"),
                &["modelPicker", "options"],
                Value::Array(options),
            );
        }
        Ok(docs)
    }
    fn preserve_native_fields(
        &self,
        role: &str,
        original: &Value,
        fields: &mut BTreeMap<String, Value>,
        _: &RegisteredProfile,
    ) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        let Some(ours) = fields.get("/modelPicker/options").cloned() else {
            return Ok(());
        };
        let Some(native_rows) = original
            .get("modelPicker")
            .and_then(|picker| picker.get("options"))
            .and_then(Value::as_array)
        else {
            return Ok(());
        };
        let empty = Vec::new();
        fields.insert(
            "/modelPicker/options".into(),
            Value::Array(merge_catalog_rows(
                native_rows,
                ours.as_array().unwrap_or(&empty),
            )),
        );
        Ok(())
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        let name = connection
            .auth_env_var
            .as_deref()
            .unwrap_or("ANTHROPIC_API_KEY");
        if !matches!(name, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN") {
            return Err(
                "Claude Code 原生认证只支持 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN".into(),
            );
        }
        let destination = if scope == Scope::Project {
            "local_settings"
        } else {
            "settings"
        };
        secrets.put(destination, &["env", name], read_secret(id, credentials)?);
        secrets.remove(
            destination,
            &[
                "env",
                if name == "ANTHROPIC_API_KEY" {
                    "ANTHROPIC_AUTH_TOKEN"
                } else {
                    "ANTHROPIC_API_KEY"
                },
            ],
        );
        if scope == Scope::Project {
            secrets.remove("settings", &["env", "ANTHROPIC_API_KEY"]);
            secrets.remove("settings", &["env", "ANTHROPIC_AUTH_TOKEN"]);
        }
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        matches!(role, "settings" | "local_settings")
            && root
                .get("env")
                .and_then(Value::as_object)
                .is_some_and(|env| {
                    env.contains_key("ANTHROPIC_API_KEY")
                        || env.contains_key("ANTHROPIC_AUTH_TOKEN")
                })
    }
    fn inspect_values(
        &self,
        settings: &Value,
        local_settings: &Value,
        _: &Value,
    ) -> InspectionFields {
        InspectionFields {
            provider: Some("anthropic".into()),
            model: string_at(local_settings, &["env", "ANTHROPIC_MODEL"])
                .or_else(|| string_at(settings, &["env", "ANTHROPIC_MODEL"]))
                .or_else(|| string_at(local_settings, &["model"]))
                .or_else(|| string_at(settings, &["model"]))
                .map(str::to_owned),
            base: string_at(local_settings, &["env", "ANTHROPIC_BASE_URL"])
                .or_else(|| string_at(settings, &["env", "ANTHROPIC_BASE_URL"]))
                .map(str::to_owned),
            wire: Some("anthropic_messages"),
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        for role in ["settings", "local_settings"] {
            let mut text = files.get(role).cloned().unwrap_or_default();
            let parsed = crate::native::format::parse(FileKind::Json, &text)?;
            for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
                let Some(key) = string_at(&parsed, &["env", name]) else {
                    continue;
                };
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 API 密钥为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                text = crate::native::format::set_path(
                    FileKind::Json,
                    &text,
                    &["env".into(), name.into()],
                    None,
                )?;
                native_refs
                    .entry(role.into())
                    .or_default()
                    .insert(name.into(), id.clone());
                pending.push((id.clone(), key.to_owned()));
                if name == "ANTHROPIC_API_KEY" {
                    if let Some(connection) = found.connection.as_mut() {
                        connection.secret_ref = Some(id);
                        connection.auth_env_var = Some(name.into());
                    }
                }
            }
            if native_refs.contains_key(role) {
                files.insert(role.into(), text);
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if !matches!(role, "settings" | "local_settings") {
            return Ok(());
        }
        if let Some(env) = parsed.get("env").and_then(Value::as_object) {
            if env.contains_key("ANTHROPIC_API_KEY") || env.contains_key("ANTHROPIC_AUTH_TOKEN") {
                return Err(
                    "Claude Code 原生配置中的认证字段不能存入草稿；请通过安全接入迁入系统凭据库"
                        .into(),
                );
            }
        }
        Ok(())
    }
    fn accepts_native_credential(&self, role: &str, name: &str) -> bool {
        matches!(role, "settings" | "local_settings")
            && matches!(name, "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN")
    }
    fn imported_connection_overrides_native(&self) -> bool {
        true
    }
    fn restore_imported_secrets(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let project = scope == Scope::Project;
        for role in if project {
            &["settings", "local_settings"][..]
        } else {
            &["settings"][..]
        } {
            secrets.remove(role, &["env", "ANTHROPIC_API_KEY"]);
            secrets.remove(role, &["env", "ANTHROPIC_AUTH_TOKEN"]);
        }
        let local = profile.native_credentials.get("local_settings");
        for (role, entries) in &profile.native_credentials {
            for (name, id) in entries {
                if profile
                    .connection
                    .as_ref()
                    .is_some_and(|connection| connection.secret_ref.is_some())
                {
                    secrets.remove(
                        if project {
                            "local_settings"
                        } else {
                            "settings"
                        },
                        &["env", name],
                    );
                    if project {
                        secrets.remove("settings", &["env", name]);
                    }
                    continue;
                }
                if project && role == "settings" {
                    secrets.remove("settings", &["env", name]);
                    if local.is_some_and(|items| items.contains_key(name)) {
                        continue;
                    }
                }
                let destination = if project {
                    "local_settings"
                } else {
                    "settings"
                };
                secrets.put(destination, &["env", name], read_secret(id, credentials)?);
            }
        }
        Ok(())
    }
    fn request_model_id(&self, model: &str) -> String {
        if model.to_ascii_lowercase().ends_with("[1m]") {
            model[..model.len() - 4].into()
        } else {
            model.into()
        }
    }
    fn login_args(&self) -> Option<Vec<String>> {
        Some(vec!["auth".into(), "login".into()])
    }
    fn login_hint(&self) -> &'static str {
        "在终端完成 Claude Code 原生登录。"
    }
    fn session_env_markers(&self) -> &'static [&'static str] {
        SESSION_ENV_MARKERS
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--resume".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--dangerously-skip-permissions".into());
        }
        Ok(args)
    }
    fn history_sources(
        &self,
        home: &std::path::Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse(source)
    }
    fn history_sources_controlled(
        &self,
        home: &std::path::Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources_controlled(home, cancelled)
    }
    fn parse_history_controlled(
        &self,
        source: &crate::history::HistorySource,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse_controlled(source, cancelled)
    }
    fn history_supported(&self) -> bool {
        true
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        version.starts_with("2.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://code.claude.com/docs/en/setup",
            "按 Claude Code 安装来源更新；原生安装可使用 claude update。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "Claude Code 的 npm 安装需要 Node.js 22 或更新版本"
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase()
            .contains("/.local/bin/claude")
    }
    fn install_command(&self) -> Option<String> {
        self.native_install_command()
    }
    fn native_install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://claude.ai/install.ps1 | iex"
            } else {
                "curl -fsSL https://claude.ai/install.sh | bash"
            }
            .into(),
        )
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => self.npm_install_command(),
            "native" => Some("claude update".into()),
            _ => None,
        }
    }
    fn anthropic_base_url(&self) -> &'static str {
        "https://api.anthropic.com"
    }
}

const CATALOG_ROLES: &[(&str, &str)] = &[
    ("ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-4-6"),
    ("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-4-8"),
    ("ANTHROPIC_DEFAULT_FABLE_MODEL", "claude-fable-5"),
    ("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-4-5"),
    ("CLAUDE_CODE_SUBAGENT_MODEL", "claude-sonnet-4-6"),
];

fn strip_context_suffix(model: &str) -> &str {
    let mut id = model.trim();
    while id.len() >= 4 && id.get(id.len() - 4..).is_some_and(|suffix| suffix.eq_ignore_ascii_case("[1m]")) {
        id = &id[..id.len() - 4];
    }
    id.trim()
}

fn needs_catalog_row(model: &str) -> bool {
    let id = strip_context_suffix(model).to_ascii_lowercase();
    if id.is_empty() {
        return false;
    }
    if matches!(
        id.as_str(),
        "sonnet" | "opus" | "haiku" | "fable" | "best" | "default" | "opusplan"
    ) {
        return false;
    }
    !id.starts_with("claude-")
}

fn row_model(row: &Value) -> Option<&str> {
    row.get("model").and_then(Value::as_str).map(str::trim)
}

fn has_behavior(row: &Value) -> bool {
    row.get("behavesAs")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn upsert_catalog_row(
    options: &mut Vec<Value>,
    model: &str,
    behaves_as: &str,
    label: Option<&str>,
) -> bool {
    let mut changed = false;
    let mut ids = Vec::new();
    let raw = model.trim();
    if !raw.is_empty() {
        ids.push(raw);
    }
    let base = strip_context_suffix(raw);
    if !base.is_empty() && !base.eq_ignore_ascii_case(raw) {
        ids.push(base);
    }
    for id in ids {
        if !needs_catalog_row(id) {
            continue;
        }
        if let Some(row) = options
            .iter_mut()
            .find(|row| row_model(row).is_some_and(|current| current.eq_ignore_ascii_case(id)))
        {
            if !has_behavior(row) {
                row.as_object_mut()
                    .expect("model picker row")
                    .insert("behavesAs".into(), json!(behaves_as));
                changed = true;
            }
            continue;
        }
        let mut row = json!({ "model": id, "behavesAs": behaves_as });
        if let Some(name) = label.map(str::trim).filter(|name| !name.is_empty()) {
            row.as_object_mut()
                .expect("model picker row")
                .insert("label".into(), json!(name));
        }
        options.push(row);
        changed = true;
    }
    changed
}

fn catalog_options(connection: &Connection, settings: &Value) -> Option<Vec<Value>> {
    let mut options = settings
        .get("modelPicker")
        .and_then(|picker| picker.get("options"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut changed =
        upsert_catalog_row(&mut options, &connection.model, "claude-sonnet-4-6", None);
    if let Some(env) = settings.get("env").and_then(Value::as_object) {
        for (key, behaves_as) in CATALOG_ROLES {
            let Some(model) = env.get(*key).and_then(Value::as_str) else {
                continue;
            };
            let name_key = format!("{key}_NAME");
            let label = env.get(&name_key).and_then(Value::as_str);
            changed |= upsert_catalog_row(&mut options, model, behaves_as, label);
        }
    }
    changed.then_some(options)
}

fn merge_catalog_rows(native_rows: &[Value], ours: &[Value]) -> Vec<Value> {
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in native_rows {
        let Some(id) = row_model(row) else {
            continue;
        };
        let key = id.to_ascii_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        merged.push(row.clone());
    }
    for row in ours {
        let Some(id) = row_model(row) else {
            continue;
        };
        let key = id.to_ascii_lowercase();
        if let Some(existing) = merged
            .iter_mut()
            .find(|item| row_model(item).is_some_and(|current| current.eq_ignore_ascii_case(id)))
        {
            if !has_behavior(existing) {
                if let Some(behaves_as) = row.get("behavesAs") {
                    existing
                        .as_object_mut()
                        .expect("model picker row")
                        .insert("behavesAs".into(), behaves_as.clone());
                }
            }
            continue;
        }
        if seen.insert(key) {
            merged.push(row.clone());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(model: &str) -> Connection {
        Connection {
            provider_id: "zhipu".into(),
            interface_format: "anthropic_messages".into(),
            base_url: "https://open.bigmodel.cn/api/anthropic".into(),
            model: model.into(),
            secret_ref: None,
            auth_env_var: None,
            model_records: Vec::new(),
        }
    }

    #[test]
    fn unknown_model_is_mapped_without_changing_the_request_id() {
        let existing = BTreeMap::from([(
            "settings".into(),
            json!({
                "env": {
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opus-gateway",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Opus 网关",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet"
                },
                "modelPicker": {
                    "options": [{ "model": "kept-by-user", "label": "自有", "behavesAs": "claude-opus-4-8" }],
                    "replaceBuiltInOptions": true
                }
            }),
        )]);
        let docs = Claude
            .connection_documents_for_existing(&connection("glm-5.3"), Scope::Global, &existing)
            .unwrap();
        assert_eq!(docs["settings"]["model"], "glm-5.3");
        assert_eq!(docs["settings"]["env"]["ANTHROPIC_MODEL"], "glm-5.3");
        let options = docs["settings"]["modelPicker"]["options"]
            .as_array()
            .unwrap();
        assert_eq!(options[0]["model"], "kept-by-user");
        assert_eq!(options[0]["behavesAs"], "claude-opus-4-8");
        assert!(options
            .iter()
            .any(|row| row["model"] == "glm-5.3" && row["behavesAs"] == "claude-sonnet-4-6"));
        assert!(options.iter().any(|row| row["model"] == "opus-gateway"
            && row["behavesAs"] == "claude-opus-4-8"
            && row["label"] == "Opus 网关"));
        assert!(!options
            .iter()
            .any(|row| row["model"] == "claude-haiku-4-5" || row["model"] == "sonnet"));
        assert!(docs["settings"]["modelPicker"]
            .get("replaceBuiltInOptions")
            .is_none());
    }

    #[test]
    fn known_claude_model_does_not_add_a_catalog_row() {
        let docs = Claude
            .connection_documents_for_existing(
                &connection("claude-sonnet-5[1m]"),
                Scope::Global,
                &BTreeMap::new(),
            )
            .unwrap();
        assert!(docs["settings"].get("modelPicker").is_none());
        let docs = Claude
            .connection_documents_for_existing(
                &connection("glm-5.3[1m]"),
                Scope::Global,
                &BTreeMap::new(),
            )
            .unwrap();
        let models: Vec<_> = docs["settings"]["modelPicker"]["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["model"].as_str().unwrap())
            .collect();
        assert_eq!(models, vec!["glm-5.3[1m]", "glm-5.3"]);
    }

    #[test]
    fn native_catalog_rows_stay_when_a_new_model_is_mapped() {
        let original = json!({
            "modelPicker": {
                "options": [
                    { "model": "kept-by-user", "label": "自有" },
                    { "model": "glm-5.3", "label": "已有" }
                ]
            }
        });
        let merged = merge_catalog_rows(
            original["modelPicker"]["options"].as_array().unwrap(),
            &[
                json!({ "model": "glm-5.3", "behavesAs": "claude-sonnet-4-6" }),
                json!({ "model": "new-gateway", "behavesAs": "claude-sonnet-4-6" }),
            ],
        );
        assert_eq!(merged[0]["model"], "kept-by-user");
        assert!(merged[0].get("behavesAs").is_none());
        assert_eq!(merged[1]["label"], "已有");
        assert_eq!(merged[1]["behavesAs"], "claude-sonnet-4-6");
        assert_eq!(merged[2]["model"], "new-gateway");
    }
}
