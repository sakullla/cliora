//! agy Plugins port (1.5.9 remote evidence run).
//!
//! Verified on the authorized remote 1.5.9 machine
//! (`docs/verification/remote-workflow/agy-1.5.9/evidence/plugins.json`,
//! sanitized package sample `tests/fixtures/native/antigravity-cli-1.5.9/
//! plugin/`, ledger entry `tests/fixtures/plugins/sources.json`
//! `antigravity_2026_11_16`):
//!
//! * **Storage**: installs are directories under `~/.gemini/config/plugins/
//!   <name>/` (`agy plugin install <local-dir>` copies the tree there);
//!   enable/disable state is a separate ledger inside `~/.gemini/config/
//!   config.json` — `{"plugins":{"<dir>":{"enabled":false|true}}}`. Toggles
//!   never touch the plugin tree (2026-11-17 spot-check: plugin files stay
//!   byte-identical across a full disable/enable/uninstall/reinstall cycle),
//!   a fresh install writes no ledger row, and `plugin uninstall` removes
//!   the directory, the listing row and the ledger row natively.
//!   `plugin list --json` reports `{name,enabled,version,source,path,
//!   skills[],agents[],rules[],mcpServers[],hooks[]}`; both directions of a
//!   toggle keep the row listed.
//! * **Listing** is file-backed (directories + ledger); Cliora never starts
//!   a CLI process for the snapshot. The isolated probe listing contained
//!   only the probe plugin; the builtin `swarm` plugin is evidenced solely
//!   by the real machine's ledger entry, so ledger rows without an install
//!   directory surface read-only (builtin uninstall protection is native,
//!   documented in the embedded changelog).
//! * **Detail resources** follow the verified layout: `skills/`, `agents/`,
//!   `rules/` directories plus the root `hooks.json` (hooks live at the
//!   plugin root; the nested `hooks/hooks.json` form is only staged on
//!   gemini/claude import) and the root `mcp_config.json` (plugin MCP
//!   servers are namespaced `<plugin>_<server>` on collision — native
//!   behavior, not reproduced here).
//! * **Lifecycle**: install/uninstall stay native commands (`agy plugin
//!   install <dir>` / `agy plugin uninstall <name>`) spawned through the
//!   shared native command channel; enable/disable are ledger writes planned
//!   as one field change and applied by the shared config transaction
//!   (baseline conflict detection + encrypted backup). The plugin tree is
//!   never rewritten by Cliora.
//!
//! The contract is verified on the 1.5 line only — the 1.3.x `agy plugin`
//! storage is undocumented in every evidence class — so all mutating
//! operations are gated to `>=1.5.0, <2.0.0` through the version policy
//! while the read-only listing keeps working on any install.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::Antigravity;
use crate::adapters::plugins::{text, PluginAdapter, PluginCapability};
use crate::adapters::version::VersionPolicy;
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction::{FieldChange, read_native};
use crate::resources::plugins::{PluginEntry, PluginRequest, PluginResource, PluginTarget};

/// Upper bound on listed plugin rows (directories + ledger keys).
const MAX_PLUGINS: usize = 128;
/// Manifest size cap while resolving installed packages.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// The `~/.gemini/config` tree shared by the plugins directory and the ledger.
fn config_dir(home: &Path) -> PathBuf {
    super::gemini_root(home).join("config")
}

fn ledger_path(home: &Path) -> PathBuf {
    config_dir(home).join("config.json")
}

fn plugins_root(home: &Path) -> PathBuf {
    config_dir(home).join("plugins")
}

/// A name the native plugin surface can address: non-empty, no path
/// separators, no control characters. The CLI additionally rejects "unsafe"
/// names (embedded changelog); this checks only the subset Cliora needs to
/// build a filesystem child and a JSON field name — native validation stays
/// authoritative for the rest.
fn valid_plugin_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

/// Parse one package manifest. The native loader accepts JSONC
/// (`plugin.json` parses as JSONC, 1.5.9 evidence); every failure mode is
/// reported as a diagnosable reason, never as a silently missing manifest.
fn read_manifest(root: &Path) -> Result<Value, String> {
    let path = root.join("plugin.json");
    let meta = std::fs::metadata(&path)
        .map_err(|_| "缺少 plugin.json 清单（agy plugin validate 需要 manifest；未猜测内容）".to_owned())?;
    if !meta.is_file() {
        return Err("plugin.json 不是普通文件；请在原生 CLI 复核".into());
    }
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err("plugin.json 超过 256 KiB 读取上限".into());
    }
    let body = std::fs::read_to_string(&path).map_err(|_| "无法读取 plugin.json".to_owned())?;
    format::parse(FileKind::Jsonc, &body).map_err(|_| "plugin.json 不是有效 JSON/JSONC".into())
}

/// The manifest `name` install copies the tree under. Invalid or unsafe
/// values are refused instead of guessed (`agy plugin install` derives the
/// target directory from this field).
fn manifest_name(manifest: &Value) -> Result<String, String> {
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or("plugin.json 缺少有效的 name 字段")?;
    if !valid_plugin_name(name) {
        return Err(format!("plugin.json 的 name「{name}」不是安全的插件目录名"));
    }
    Ok(name.to_owned())
}

/// Install sources verified by the evidence: a local directory given as an
/// absolute path (the probe form) or a `file:` URL. Relative paths would be
/// resolved by the native CLI against its working directory — an unverified
/// contract — so they are refused with guidance instead.
fn install_source_root(source: &str) -> Option<PathBuf> {
    if source.starts_with("file:") {
        return url::Url::parse(source).ok()?.to_file_path().ok();
    }
    Path::new(source)
        .is_absolute()
        .then(|| PathBuf::from(source))
}

impl PluginAdapter for Antigravity {
    /// Listing is directory- and ledger-backed; a snapshot never starts a CLI
    /// process (the same file-only basis drives the agents plugin scan).
    fn discovery_only(&self) -> bool {
        true
    }

    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "1.5.9",
            sources: "本机插件目录的绝对路径（agy plugin install <目录>，1.5.9 实证：复制到 ~/.gemini/config/plugins/<name>/）",
            actions: vec!["list", "install", "enable", "disable", "uninstall"],
            project: false,
            detail: "安装落点 ~/.gemini/config/plugins/<name>/ 与启停分类账 config.json 的 plugins.<目录>.enabled 均为 1.5.9 实测（启停只写分类账、不改写插件文件；卸载由原生命令连同分类账行一并移除）。install/uninstall 走原生命令 agy plugin install|uninstall，失败以退出码如实上报；enable/disable 写分类账。内置插件只读呈现、不提供卸载。仅验证 1.5+：更早安装线的插件存储无证据，写入被拒绝。",
        }
    }

    /// The plugin contract is evidenced on the 1.5 line only. The 1.3.x
    /// `agy plugin` command exists but its storage is undocumented, so the
    /// accepted range stays inside the verified minor line instead of the
    /// whole major.
    fn version_policy(&self) -> VersionPolicy {
        VersionPolicy {
            requirements: vec![">=1.5.0, <2.0.0".into()],
            excluded: &[],
        }
    }

    fn command_args(
        &self,
        action: &str,
        source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = match action {
            "install" => vec!["plugin", "install", source],
            "uninstall" => vec!["plugin", "uninstall", source],
            _ => {
                return Err(
                    "Antigravity 插件启停走分类账事务；原生命令只有 install/uninstall".into(),
                )
            }
        };
        Ok(args.into_iter().map(str::to_owned).collect())
    }

    /// The enable/disable ledger lives in the config-root `config.json`, not
    /// in the settings file; the shared transaction owns reading and writing
    /// it.
    fn config_location(
        &self,
        home: &Path,
        _target: &PluginTarget,
    ) -> Result<Option<(PathBuf, FileKind)>, String> {
        Ok(Some((ledger_path(home), FileKind::Json)))
    }

    /// Ledger writes follow the verified install line: the shared service
    /// probes the version and refuses an unverified or too-old line before
    /// any write (`declaration_field` consults the version policy above).
    fn config_requires_version(&self) -> bool {
        true
    }

    /// The ledger field exists on the verified 1.5 line only. The version
    /// policy already refused everything else; this keeps the refusal local
    /// if the policy is ever widened.
    fn config_field_for_version(&self, version: Option<&str>) -> Option<&'static str> {
        let parsed = version
            .and_then(|text| semver::Version::parse(text.trim().trim_start_matches('v')).ok())?;
        (parsed.major == 1 && parsed.minor >= 5).then_some("plugins")
    }

    fn config_only(&self, action: &str, _entry: Option<&PluginEntry>) -> bool {
        matches!(action, "enable" | "disable")
    }

    /// One planned leaf write per toggle. Native semantics (1.5.9): both
    /// `plugin disable` and `plugin enable` leave an explicit
    /// `{"plugins":{"<dir>":{"enabled":<bool>}}}` record in config.json, so
    /// both directions are plain field writes and no app_settings recovery
    /// record is needed — the flag itself is the persistent native state.
    fn config_changes(
        &self,
        _parsed: &Value,
        _saved: &mut serde_json::Map<String, Value>,
        request: &PluginRequest,
    ) -> Result<Vec<FieldChange>, String> {
        if !matches!(request.action.as_str(), "enable" | "disable") {
            return Err("Antigravity 插件配置操作只有 enable/disable".into());
        }
        if !valid_plugin_name(&request.source) {
            return Err("插件目录名无效；未写入启停分类账".into());
        }
        Ok(vec![FieldChange {
            path: vec!["plugins".into(), request.source.clone(), "enabled".into()],
            value: Some(json!(request.action == "enable")),
        }])
    }

    fn validate_operation(
        &self,
        request: &PluginRequest,
        _entry: Option<&PluginEntry>,
    ) -> Result<(), String> {
        match request.action.as_str() {
            // Pre-flight the diagnosable failures before any native command
            // runs: missing source, missing manifest, invalid fields.
            "install" => {
                let root = install_source_root(&request.source)
                    .ok_or("安装来源须是本机插件目录的绝对路径（或 file: URL）")?;
                if !root.is_dir() {
                    return Err(format!("安装来源目录不存在：{}", root.display()));
                }
                let manifest = read_manifest(&root)?;
                manifest_name(&manifest)?;
                Ok(())
            }
            "enable" | "disable" | "uninstall" => {
                if !valid_plugin_name(&request.source) {
                    return Err("插件目录名无效".into());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn discover(
        &self,
        home: &Path,
        target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        if target.scope != Scope::Global {
            return Err("Antigravity 插件只有用户级安装（~/.gemini/config/plugins），没有项目级插件面".into());
        }
        let ledger_text = read_native(&ledger_path(home))?;
        let ledger = if ledger_text.trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            format::parse(FileKind::Json, &ledger_text)
                .map_err(|_| "config.json 不是有效 JSON；启停分类账无法读取，请用 agy plugin 复核（形态以 1.5.9 实证为准）")?
        };
        let empty = serde_json::Map::new();
        let records = match ledger.get("plugins") {
            None | Some(Value::Null) => &empty,
            Some(value) => value.as_object().ok_or(
                "config.json 的 plugins 字段不是对象；启停分类账无法读取，请用 agy plugin 复核",
            )?,
        };
        let installed = plugins_root(home);
        let mut names: Vec<String> = records.keys().cloned().collect();
        if installed.is_dir() {
            let rows = std::fs::read_dir(&installed)
                .map_err(|_| "无法读取 ~/.gemini/config/plugins 目录")?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "无法读取 ~/.gemini/config/plugins 目录")?;
            for row in rows {
                let name = row.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                // Only directories are installs; hidden entries are not
                // plugin surfaces.
                if !name.starts_with('.') && row.path().is_dir() {
                    names.push(name.to_owned());
                }
            }
        }
        names.sort();
        names.dedup();
        if names.len() > MAX_PLUGINS {
            return Err("插件目录/分类账条目超过 128 条上限；请在原生 CLI 管理".into());
        }
        let mut entries = Vec::new();
        for name in names {
            let root = installed.join(&name);
            let record = records.get(&name);
            let (enabled, ledger_note) = match record.and_then(|value| value.get("enabled")) {
                // No ledger row: the native list default is enabled (the
                // fresh install listed enabled:true before any toggle).
                None => (Some(true), None),
                Some(Value::Bool(value)) => (Some(*value), None),
                Some(_) => (None, Some("分类账 enabled 字段不是布尔值")),
            };
            if !valid_plugin_name(&name) {
                let mut policy = "名称不是有效的原生插件目录名，只读呈现；请在原生 CLI 复核".to_owned();
                if let Some(note) = ledger_note {
                    policy.push_str(&format!(" · {note}"));
                }
                entries.push(PluginEntry {
                    id: name.clone(),
                    name,
                    source: "antigravity".into(),
                    version: None,
                    scope: "user".into(),
                    enabled,
                    state: "installed_load_unknown".into(),
                    policy,
                    read_only: true,
                    root: None,
                    resources: Vec::new(),
                });
                continue;
            }
            let mut entry = PluginEntry {
                id: name.clone(),
                name: name.clone(),
                // The native list reports the install origin with this label.
                source: "antigravity".into(),
                version: None,
                scope: "user".into(),
                enabled,
                state: "installed_load_unknown".into(),
                policy: "原生启停分类账 config.json plugins.<目录名>.enabled（目录名即原生身份）".into(),
                read_only: false,
                root: root.is_dir().then(|| root.display().to_string()),
                resources: Vec::new(),
            };
            if !root.is_dir() {
                // A ledger key without an install directory: the real
                // machine's builtin entry (swarm) or a row left after the
                // tree was removed. Both stay read-only; builtin uninstall
                // protection is native (embedded changelog).
                entry.read_only = true;
                entry.policy = "config.json 分类账条目没有对应安装目录（内置插件或已删除的安装），只读呈现；内置插件不可卸载".into();
                if let Some(note) = ledger_note {
                    entry.policy.push_str(&format!(" · {note}"));
                }
                entries.push(entry);
                continue;
            }
            match read_manifest(&root).and_then(|manifest| {
                manifest_name(&manifest).map(|name| (name, text(&manifest, &["version"])))
            }) {
                Ok((display, version)) => {
                    entry.name = display;
                    entry.version = version;
                }
                // A broken manifest never fails the whole listing: the row
                // stays visible with its diagnosable reason, read-only, and
                // every other plugin is unaffected.
                Err(error) => {
                    entry.read_only = true;
                    entry.policy.push_str(&format!(" · {error}"));
                }
            }
            if let Some(note) = ledger_note {
                entry.enabled = None;
                entry.policy.push_str(&format!(" · {note}"));
            }
            self.resources(&mut entry, None)?;
            entries.push(entry);
        }
        Ok(entries)
    }

    /// The five verified resource locations. The shared `owned_resources`
    /// probe does not fit this layout: agy hooks live in the root
    /// `hooks.json` (not a `hooks/` directory) and the plugin MCP document
    /// is the root `mcp_config.json` (not `.mcp.json`), so the mapping is
    /// declared here from actual files only — nothing is listed for kinds a
    /// package does not carry, and an unreadable package tree is degraded by
    /// the shared digest (read-only with a policy note), never presented as
    /// a complete managed plugin.
    fn resources(&self, entry: &mut PluginEntry, _manifest: Option<&Value>) -> Result<(), String> {
        let Some(root) = entry.root.as_deref().map(Path::new) else {
            return Ok(());
        };
        for (kind, relative) in [
            ("agents", "agents"),
            ("skills", "skills"),
            ("rules", "rules"),
            ("hooks", "hooks.json"),
            ("mcp", "mcp_config.json"),
        ] {
            let path = root.join(relative);
            if path.exists() {
                entry.resources.push(PluginResource {
                    kind: kind.into(),
                    path: path.display().to_string(),
                    owner_id: entry.id.clone(),
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn global_target() -> PluginTarget {
        PluginTarget {
            tool_id: "antigravity".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        }
    }

    fn request(action: &str, source: &str) -> PluginRequest {
        PluginRequest {
            target: global_target(),
            action: action.into(),
            source: source.into(),
            baseline: String::new(),
            trusted: true,
        }
    }

    /// The committed sanitized 1.5.9 plugin fixture tree.
    fn fixture_plugin_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/native/antigravity-cli-1.5.9/plugin")
    }

    fn copy_tree(source: &Path, target: &Path) {
        std::fs::create_dir_all(target).unwrap();
        for row in std::fs::read_dir(source).unwrap() {
            let row = row.unwrap();
            let name = row.file_name();
            if row.path().is_dir() {
                copy_tree(&row.path(), &target.join(name));
            } else {
                std::fs::copy(row.path(), target.join(name)).unwrap();
            }
        }
    }

    #[test]
    fn capability_pins_the_verified_actions_and_the_version_range() {
        let capability = Antigravity.capability();
        assert_eq!(capability.version, "1.5.9");
        assert_eq!(
            capability.actions,
            ["list", "install", "enable", "disable", "uninstall"]
        );
        assert!(!capability.project, "1.5.9 证据没有项目级插件面");
        // The plugin contract is 1.5-line evidence only: 1.3.x stays outside
        // the accepted range while ordinary 1.5+/1.6 movement stays inside.
        let policy = Antigravity.version_policy();
        assert!(policy.accepts("1.5.9"));
        assert!(policy.accepts("1.6.0"));
        assert!(!policy.accepts("1.3.1"));
        assert!(!policy.accepts("2.0.0"));
        assert!(!policy.accepts("unknown"));
        // Ledger writes follow the same line; the trait default (whole
        // major) is overridden because the older line is undocumented.
        assert!(Antigravity.config_requires_version());
        assert_eq!(
            Antigravity.config_field_for_version(Some("1.5.9")),
            Some("plugins")
        );
        assert_eq!(
            Antigravity.config_field_for_version(Some("1.6.0")),
            Some("plugins")
        );
        assert_eq!(Antigravity.config_field_for_version(Some("1.3.1")), None);
        assert_eq!(Antigravity.config_field_for_version(None), None);
    }

    #[test]
    fn native_commands_pin_the_plugin_subcommands() {
        assert_eq!(
            Antigravity
                .command_args("install", "C:/tools/probe-kit", false)
                .unwrap(),
            ["plugin", "install", "C:/tools/probe-kit"]
        );
        assert_eq!(
            Antigravity.command_args("uninstall", "probe-kit", false).unwrap(),
            ["plugin", "uninstall", "probe-kit"]
        );
        // Enable/disable are ledger transactions, never native commands.
        assert!(Antigravity.command_args("enable", "probe-kit", false).is_err());
        assert!(Antigravity.command_args("disable", "probe-kit", false).is_err());
        assert!(Antigravity.command_args("update", "probe-kit", false).is_err());
    }

    #[test]
    fn enable_disable_plan_one_ledger_leaf_write_both_directions() {
        assert!(Antigravity.config_only("enable", None));
        assert!(Antigravity.config_only("disable", None));
        assert!(!Antigravity.config_only("install", None));
        assert!(!Antigravity.config_only("uninstall", None));
        let mut saved = serde_json::Map::new();
        let disable = Antigravity
            .config_changes(&json!({}), &mut saved, &request("disable", "probe-kit"))
            .unwrap();
        assert_eq!(disable.len(), 1);
        assert_eq!(
            disable[0].path,
            vec![
                "plugins".to_string(),
                "probe-kit".to_string(),
                "enabled".to_string()
            ]
        );
        assert_eq!(disable[0].value, Some(json!(false)));
        // Native enable writes an explicit true record (the flag survives
        // reinstall); no app_settings recovery record is stashed.
        let enable = Antigravity
            .config_changes(&json!({}), &mut saved, &request("enable", "probe-kit"))
            .unwrap();
        assert_eq!(enable[0].value, Some(json!(true)));
        assert!(saved.is_empty());
        assert!(Antigravity
            .config_changes(&json!({}), &mut saved, &request("uninstall", "probe-kit"))
            .is_err());
        // A directory name that cannot be a ledger key is refused.
        assert!(Antigravity
            .config_changes(&json!({}), &mut saved, &request("disable", "a/b"))
            .is_err());
        assert!(Antigravity
            .config_changes(&json!({}), &mut saved, &request("disable", ".."))
            .is_err());
        // Applying the planned change through the shared path writer
        // produces the exact native ledger document shape, creating
        // intermediate objects when the ledger is still empty.
        let text = format::set_path(
            FileKind::Json,
            "",
            &disable[0].path,
            disable[0].value.as_ref(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"plugins": {"probe-kit": {"enabled": false}}})
        );
        // An existing unrelated config.json key survives the leaf write.
        let existing = r#"{"theme":"dark","plugins":{"probe-kit":{"enabled":true}}}"#;
        let merged = format::set_path(
            FileKind::Json,
            existing,
            &disable[0].path,
            disable[0].value.as_ref(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&merged).unwrap(),
            json!({"theme":"dark","plugins":{"probe-kit":{"enabled":false}}})
        );
    }

    #[test]
    fn discover_reads_directories_and_the_ledger_without_a_cli() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        // Missing ledger and plugins directory degrade to an empty list, and
        // the config location points at the native ledger document.
        assert!(Antigravity
            .discover(home, &global_target(), Path::new(""))
            .unwrap()
            .is_empty());
        let (ledger, kind) = Antigravity
            .config_location(home, &global_target())
            .unwrap()
            .unwrap();
        assert_eq!(kind, FileKind::Json);
        assert!(ledger
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".gemini/config/config.json"));

        let installed = plugins_root(home).join("probe-kit");
        copy_tree(&fixture_plugin_dir(), &installed);
        // The committed fixture tree maps to exactly the five verified
        // resource kinds from actual files.
        let entries = Antigravity
            .discover(home, &global_target(), Path::new(""))
            .unwrap();
        assert_eq!(entries.len(), 1, "{entries:?}");
        let probe = &entries[0];
        assert_eq!(probe.id, "probe-kit");
        assert_eq!(probe.name, "fixture-kit");
        assert_eq!(probe.version.as_deref(), Some("1.0.0"));
        assert_eq!(probe.source, "antigravity");
        assert_eq!(probe.scope, "user");
        assert_eq!(probe.enabled, Some(true), "无分类账行时原生默认启用");
        assert!(!probe.read_only);
        let kinds: Vec<(&str, String)> = probe
            .resources
            .iter()
            .map(|resource| {
                (
                    resource.kind.as_str(),
                    Path::new(&resource.path)
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("agents", "agents".into()),
                ("skills", "skills".into()),
                ("rules", "rules".into()),
                ("hooks", "hooks.json".into()),
                ("mcp", "mcp_config.json".into()),
            ]
        );
        assert!(probe
            .root
            .as_deref()
            .is_some_and(|root| root.replace('\\', "/").ends_with("plugins/probe-kit")));

        // The ledger drives enabled state and surfaces builtins read-only
        // (the real machine's swarm row has no install directory).
        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(
            &ledger,
            r#"{"plugins":{"probe-kit":{"enabled":false},"swarm":{"enabled":true}}}"#,
        )
        .unwrap();
        let entries = Antigravity
            .discover(home, &global_target(), Path::new(""))
            .unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        let disabled = entries.iter().find(|entry| entry.id == "probe-kit").unwrap();
        assert_eq!(disabled.enabled, Some(false));
        assert!(!disabled.read_only, "禁用是用户选择，不是只读");
        let builtin = entries.iter().find(|entry| entry.id == "swarm").unwrap();
        assert!(builtin.read_only, "内置插件只读，不提供卸载");
        assert_eq!(builtin.enabled, Some(true));
        assert!(builtin.root.is_none());
        assert!(builtin.resources.is_empty());
        assert!(builtin.policy.contains("内置插件"));

        // A directory without a valid manifest stays listed with a
        // diagnosable reason, read-only, and the other rows are unaffected.
        let broken = plugins_root(home).join("broken-kit");
        std::fs::create_dir_all(broken.join("skills")).unwrap();
        let entries = Antigravity
            .discover(home, &global_target(), Path::new(""))
            .unwrap();
        let broken = entries.iter().find(|entry| entry.id == "broken-kit").unwrap();
        assert!(broken.read_only);
        assert_eq!(broken.name, "broken-kit");
        assert!(broken.policy.contains("plugin.json"), "{}", broken.policy);
        assert_eq!(
            entries.iter().filter(|entry| entry.id == "probe-kit").count(),
            1
        );
        // A non-boolean ledger flag is reported, not guessed.
        std::fs::write(
            &ledger,
            r#"{"plugins":{"probe-kit":{"enabled":"yes"}}}"#,
        )
        .unwrap();
        let entries = Antigravity
            .discover(home, &global_target(), Path::new(""))
            .unwrap();
        let probe = entries.iter().find(|entry| entry.id == "probe-kit").unwrap();
        assert_eq!(probe.enabled, None);
        assert!(probe.policy.contains("布尔值"), "{}", probe.policy);
        // A malformed ledger document is a diagnosable listing error.
        std::fs::write(&ledger, "{invalid").unwrap();
        assert!(Antigravity
            .discover(home, &global_target(), Path::new(""))
            .is_err());
        // Project scope is not an agy plugin surface.
        let project_target = PluginTarget {
            scope: Scope::Project,
            project_path: Some("/work/demo".into()),
            ..global_target()
        };
        assert!(Antigravity.discover(home, &project_target, Path::new("")).is_err());
    }

    #[test]
    fn install_pre_flight_reports_diagnosable_failures() {
        // The committed fixture package passes the manifest contract.
        Antigravity
            .validate_operation(&request("install", fixture_plugin_dir().to_string_lossy().as_ref()), None)
            .unwrap();
        // Missing source, relative paths, missing manifest and invalid
        // fields each carry their own reason; nothing is executed.
        assert!(Antigravity
            .validate_operation(&request("install", "relative/probe-kit"), None)
            .unwrap_err()
            .contains("绝对路径"));
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("no-such-dir");
        assert!(Antigravity
            .validate_operation(&request("install", missing.to_string_lossy().as_ref()), None)
            .unwrap_err()
            .contains("不存在"));
        let no_manifest = temp.path().join("no-manifest");
        std::fs::create_dir_all(&no_manifest).unwrap();
        assert!(Antigravity
            .validate_operation(&request("install", no_manifest.to_string_lossy().as_ref()), None)
            .unwrap_err()
            .contains("plugin.json"));
        let bad_name = temp.path().join("bad-name");
        std::fs::create_dir_all(&bad_name).unwrap();
        std::fs::write(
            bad_name.join("plugin.json"),
            "{\"name\":\"../escape\",\"version\":\"1.0.0\"}",
        )
        .unwrap();
        assert!(Antigravity
            .validate_operation(&request("install", bad_name.to_string_lossy().as_ref()), None)
            .unwrap_err()
            .contains("name"));
        // A `file:` URL resolves like an absolute path.
        let url = url::Url::from_file_path(fixture_plugin_dir()).unwrap();
        Antigravity
            .validate_operation(&request("install", url.as_str()), None)
            .unwrap();
        // Ledger keys and uninstall identities are directory names.
        Antigravity
            .validate_operation(&request("disable", "probe-kit"), None)
            .unwrap();
        assert!(Antigravity.validate_operation(&request("disable", ".."), None).is_err());
        Antigravity
            .validate_operation(&request("uninstall", "probe-kit"), None)
            .unwrap();
    }
}
