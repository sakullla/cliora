//! Devin CLI plugins: local-ledger discovery plus native commands.
//!
//! `devin plugins list` has no `--json` and prints a human-readable list
//! (verified `--help` on 3000.11.205), so discovery reads the product's own
//! ledger `%APPDATA%\devin\cli\plugins\lock.json`
//! (`requirements[]/{spec,origin,required}` + `resolved[]/{name,spec,identity,
//! resolved,version_dir,dependencies}` + `edges`, locally verified) instead of
//! parsing command output. The ledger is never written here: every lifecycle
//! change goes through `devin plugins install/update/remove`.
//!
//! All doc citations below were re-verified against the raw markdown fetched
//! with `curl -sL` on 2026-10-24 (docs.devin.ai `cli/extensibility/plugins/
//! overview.md`, 20874 bytes). The page carries no closed-beta wording on
//! that date (checked with grep -in beta: no match).
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::super::plugins::owned_resources;
use super::Devin;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::native::adapter::Scope;
use crate::native::format::FileKind;
use crate::resources::plugins::{PluginEntry, PluginResource, PluginTarget};

/// Read budget for cached manifests while resolving plugin roots.
const MAX_CACHE_ROOTS: usize = 64;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

impl PluginAdapter for Devin {
    fn discovery_only(&self) -> bool {
        true
    }

    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "3000.11.205",
            sources: "GitHub owner/repo、owner/repo#子目录、git URL 或本地路径（install --help 原文）",
            actions: vec!["install", "update", "uninstall"],
            project: false,
            detail: "安装/更新需先 devin auth login（overview.md 152 行）；默认安装记入 Devin Cloud 个人 manifest 跨机同步，--local 仅本机、本地目录直接链接源且编辑实时生效（overview.md 148-151、186 行）；企业可为成员禁用 CLI 插件，被治理拦截的插件在会话启动时跳过并警告而非中止（overview.md 152-154、409-411 行）；安装/卸载各带 -y 跳过原生信任提示与云移除确认（install/remove --help），卸载确认由本应用对话框承担；重启会话后加载。",
        }
    }

    /// `source` is the plugin `<NAME>` for update/remove (the shared service
    /// passes the entry id, which is the ledger's resolved name). Both install
    /// and remove carry `-y`: the shared runner executes with stdin closed, so
    /// the interactive trust prompt (install --help) and the interactive
    /// cloud-removal confirmation (remove --help) must never be reached; a
    /// locally installed `--local` probe plugin was removed under stdin-null
    /// without any prompt on 3000.11.205, while cloud-manifest installs would
    /// otherwise hang unverified. update has no confirmation flag
    /// (update --help). remove's `--local`/`--force` flags are not mapped:
    /// Cliora always performs the full default removal.
    fn command_args(
        &self,
        action: &str,
        source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = match action {
            "install" => vec!["plugins", "install", source, "-y"],
            "update" => vec!["plugins", "update", source],
            "uninstall" => vec!["plugins", "remove", source, "-y"],
            _ => return Err("此操作使用配置事务".into()),
        };
        Ok(args.into_iter().map(str::to_owned).collect())
    }

    fn config_location(
        &self,
        home: &Path,
        _target: &PluginTarget,
    ) -> Result<Option<(PathBuf, FileKind)>, String> {
        Ok(Some((ledger_path(home), FileKind::Json)))
    }

    fn snapshot_files(&self, home: &Path, _target: &PluginTarget) -> Vec<PathBuf> {
        vec![
            ledger_path(home),
            config_root(home)
                .join("cli")
                .join("plugins")
                .join("discovered.json"),
        ]
    }

    fn discover(
        &self,
        home: &Path,
        target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        if target.scope != Scope::Global {
            return Err("Devin 插件只有用户级安装（个人 manifest），没有项目级".into());
        }
        // A missing ledger (read_native returns "") or one without resolved[]
        // is an empty list, not an error: structure drift degrades to an empty
        // inventory instead of failing the page.
        let text = crate::native::transaction::read_native(&ledger_path(home))?;
        if text.trim().is_empty() {
            return Ok(vec![]);
        }
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            "Devin 插件账本 lock.json 结构漂移；请用原生 CLI 复核（形态以 3000.x 为准）".to_owned()
        })?;
        let Some(resolved) = value.get("resolved").and_then(Value::as_array) else {
            return Ok(vec![]);
        };
        let requirements = value.get("requirements").and_then(Value::as_array);
        let mut entries = Vec::new();
        for item in resolved {
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let spec = item.get("spec");
            // requirements[].spec matches the resolved spec verbatim; a
            // missing or unmatched requirement defaults to the user scope.
            let scope = requirements
                .and_then(|items| {
                    items
                        .iter()
                        .find(|requirement| requirement.get("spec") == spec)
                })
                .and_then(|requirement| requirement.get("origin"))
                .and_then(|origin| origin.get("scope"))
                .and_then(Value::as_str)
                .unwrap_or("user");
            let managed = scope != "user";
            let version_dir = item.get("version_dir").and_then(Value::as_str);
            let source = spec
                .filter(|spec| spec.get("source").and_then(Value::as_str) == Some("local"))
                .and_then(|spec| spec.get("path"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                // Non-local spec field names were not verified on 3000.11.205
                // (the local ledger only holds local entries and probing a
                // real github install would touch the user's cloud personal
                // manifest); degrade to text instead of guessing github fields.
                .unwrap_or_else(|| "非本机目录来源（spec 字段形态未实证，请用原生 CLI 查看）".into());
            let root = version_dir.and_then(|version| cache_root(home, name, version));
            let mut entry = PluginEntry {
                id: name.to_owned(),
                name: name.to_owned(),
                source,
                version: version_dir.map(str::to_owned),
                scope: scope.to_owned(),
                enabled: None,
                state: "installed_load_unknown".into(),
                policy: if managed {
                    "组织/云端管理，本应用只读呈现".into()
                } else {
                    "用户个人 manifest（Devin Cloud 同步）".into()
                },
                read_only: managed,
                root: root.as_ref().map(|path| path.display().to_string()),
                resources: Vec::new(),
            };
            self.resources(&mut entry, None)?;
            entries.push(entry);
        }
        Ok(entries)
    }

    /// The shared `owned_resources` probe already covers the Devin layout
    /// `.mcp.json` (overview.md line 34), `agents/` and `skills/`; supplement
    /// the four entries it does not know: root `rules/` (overview.md 30, 49)
    /// and root `AGENTS.md` (29) as rules, the single-file `hooks.json` (33;
    /// the shared probe matches a hooks directory only), and the
    /// Agent-Plugins-1.0.0 root `mcp.json` without the dot prefix (89-91,
    /// 256-257). `.mcp.json` wins on a server-name collision; these entries
    /// are display-only and no conflict resolution happens here.
    fn resources(&self, entry: &mut PluginEntry, _manifest: Option<&Value>) -> Result<(), String> {
        owned_resources(entry);
        let Some(root) = entry.root.as_deref().map(Path::new) else {
            return Ok(());
        };
        for (kind, relative) in [
            ("rules", "rules"),
            ("rules", "AGENTS.md"),
            ("hooks", "hooks.json"),
            ("mcp", "mcp.json"),
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

fn config_root(home: &Path) -> PathBuf {
    super::config_root(home)
}

fn plugins_dir(home: &Path) -> PathBuf {
    config_root(home).join("cli").join("plugins")
}

fn ledger_path(home: &Path) -> PathBuf {
    plugins_dir(home).join("lock.json")
}

/// The cache layout is `cache/<slug>/<version_dir>/` with the plugin root at
/// the version directory (locally verified on 3000.11.205:
/// `C__…_devin-plugin-b09e9e9a/2.2.107`). The slug hash is never recomputed;
/// a cached version directory matches when its `.devin-plugin/plugin.json`
/// names the same plugin.
fn cache_root(home: &Path, name: &str, version_dir: &str) -> Option<PathBuf> {
    let cache = plugins_dir(home).join("cache");
    let slugs = std::fs::read_dir(&cache).ok()?;
    let mut checked = 0;
    for slug in slugs.flatten() {
        let Ok(versions) = std::fs::read_dir(slug.path()) else {
            continue;
        };
        for version in versions.flatten() {
            if version.file_name().to_string_lossy() != version_dir {
                continue;
            }
            checked += 1;
            if checked > MAX_CACHE_ROOTS {
                return None;
            }
            let root = version.path();
            let manifest = root.join(".devin-plugin").join("plugin.json");
            let Ok(meta) = std::fs::metadata(&manifest) else {
                continue;
            };
            if meta.len() > MAX_MANIFEST_BYTES {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&manifest) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("name").and_then(Value::as_str) == Some(name) {
                return Some(root);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEDGER_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/devin-3000-plugins-lock.json");

    fn global_target() -> PluginTarget {
        PluginTarget {
            tool_id: "devin".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        }
    }

    #[test]
    fn capability_shape_pins_the_delivered_actions() {
        let capability = Devin.capability();
        assert_eq!(capability.version, "3000.11.205");
        assert_eq!(capability.actions, ["install", "update", "uninstall"]);
        assert!(!capability.project);
        // No closed-beta wording: the 2026-10-24 page has none.
        let detail = capability.detail.to_ascii_lowercase();
        assert!(!detail.contains("beta") && !detail.contains("closed"));
        assert!(!capability.detail.contains("内测"));
    }

    #[test]
    fn command_args_pin_the_native_subcommands_with_confirmation_skips() {
        assert_eq!(
            Devin.command_args("install", "acme/demo", false).unwrap(),
            ["plugins", "install", "acme/demo", "-y"]
        );
        assert_eq!(
            Devin.command_args("update", "demo-plugin", false).unwrap(),
            ["plugins", "update", "demo-plugin"]
        );
        // Symmetric -y: stdin-null execution must never reach the interactive
        // cloud-removal confirmation.
        assert_eq!(
            Devin.command_args("uninstall", "demo-plugin", false).unwrap(),
            ["plugins", "remove", "demo-plugin", "-y"]
        );
        assert!(Devin.command_args("enable", "demo-plugin", false).is_err());
    }

    #[test]
    fn discover_reads_the_sanitized_ledger_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        // A missing ledger degrades to an empty list, and the config location
        // plus snapshot files point at the product ledger and its sibling.
        assert!(Devin.discover(home, &global_target(), Path::new("")).unwrap().is_empty());
        let (ledger, kind) = Devin.config_location(home, &global_target()).unwrap().unwrap();
        assert_eq!(kind, FileKind::Json);
        assert!(ledger
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("devin/cli/plugins/lock.json"));
        let snapshot = Devin.snapshot_files(home, &global_target());
        assert_eq!(snapshot.len(), 2);
        assert!(snapshot.iter().any(|path| path.ends_with("discovered.json")));

        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(&ledger, LEDGER_FIXTURE).unwrap();
        // Cache layout: the local fixture plugin resolves its package root and
        // the shared owned_resources probe adds the skills entry.
        let root = plugins_dir(home)
            .join("cache")
            .join("C__home_example_tools_demo-plugin")
            .join("1.0.0");
        std::fs::create_dir_all(root.join(".devin-plugin")).unwrap();
        std::fs::write(
            root.join(".devin-plugin").join("plugin.json"),
            r#"{"name": "demo-plugin", "version": "1.0.0"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(root.join("skills").join("review")).unwrap();
        std::fs::write(
            root.join("skills").join("review").join("SKILL.md"),
            "---\nname: review\n---\nBody.\n",
        )
        .unwrap();

        let entries = Devin
            .discover(home, &global_target(), Path::new(""))
            .unwrap();
        assert_eq!(entries.len(), 3, "{entries:?}");
        let demo = entries.iter().find(|entry| entry.id == "demo-plugin").unwrap();
        assert_eq!(demo.name, "demo-plugin");
        assert_eq!(demo.version.as_deref(), Some("1.0.0"));
        assert_eq!(demo.source, "/home/example/tools/demo-plugin");
        assert_eq!(demo.scope, "user");
        assert!(!demo.read_only);
        assert!(demo
            .root
            .as_deref()
            .is_some_and(|root| root.replace('\\', "/").ends_with("1.0.0")));
        assert!(demo.resources.iter().any(|resource| resource.kind == "skills"));
        // Unknown spec form: degrade to text instead of guessing github fields.
        let unknown = entries.iter().find(|entry| entry.id == "unknown-shape").unwrap();
        assert!(unknown.source.contains("未实证"), "{}", unknown.source);
        assert!(!unknown.read_only);
        // Non-user origin scope: read-only with the managed policy note.
        let managed = entries
            .iter()
            .find(|entry| entry.id == "org-managed-plugin")
            .unwrap();
        assert!(managed.read_only);
        assert!(managed.policy.contains("组织/云端管理"));
        assert_eq!(managed.scope, "org");
    }

    #[test]
    fn resources_cover_the_devin_plugin_layout_and_agent_plugins_mcp() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("fake-plugin");
        for dir in ["rules", "agents", "skills"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["AGENTS.md", "hooks.json", ".mcp.json", "mcp.json"] {
            std::fs::write(root.join(file), "{}\n").unwrap();
        }
        let mut entry = PluginEntry {
            id: "demo-plugin".into(),
            name: "demo-plugin".into(),
            source: String::new(),
            version: None,
            scope: "user".into(),
            enabled: None,
            state: "installed_load_unknown".into(),
            policy: String::new(),
            read_only: false,
            root: Some(root.display().to_string()),
            resources: Vec::new(),
        };
        Devin.resources(&mut entry, None).unwrap();
        let kinds = |kind: &str| {
            entry
                .resources
                .iter()
                .filter(|resource| resource.kind == kind)
                .count()
        };
        assert_eq!(kinds("rules"), 2, "{:?}", entry.resources);
        assert_eq!(kinds("hooks"), 1);
        // Both MCP forms show up: the Devin `.mcp.json` (owned probe) and the
        // Agent-Plugins-1.0.0 root `mcp.json` (supplemental probe).
        assert_eq!(kinds("mcp"), 2);
        assert_eq!(kinds("agents"), 1);
        assert_eq!(kinds("skills"), 1);
        assert!(entry.resources.iter().all(|resource| resource.path
            .replace('\\', "/")
            .starts_with(&root.display().to_string().replace('\\', "/"))));
    }
}
