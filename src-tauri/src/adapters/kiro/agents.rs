//! Kiro custom agents (kiro.dev docs/custom-agents, cross-checked with the
//! local 2.34.2 install in 01-exploration.md §2/§3).
//!
//! Directory contract: user-level `~/.kiro/agents/[name].json|.md` and
//! workspace `.kiro/agents/…` (nested directories form `team/planner` names;
//! with the same name in both scopes the workspace file wins — a native load
//! rule shown in the capability text, never simulated here). Documented fields
//! are `name`, `description`, `tools`, `excludedTools`, `includeMcpJson`,
//! `includePowers`, `resources` (`file://`/`skill://`), `permissions.rules`,
//! `prompt`, `model`, `welcomeMessage`; JSON and Markdown are equivalent, so
//! definitions are read and written whole-file — no field is parsed out or
//! rewritten, and only trusted workspaces are loaded (a CLI behavior Cliora
//! does not judge). The CLI hot-reloads saved definitions.

use super::Kiro;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use crate::resources::agents::{entry, read, AgentEntry, AgentRequest};
use crate::resources::plugins::PluginTarget;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Scan budget mirroring the shared definition walker.
const MAX_JSON_DEFINITIONS: usize = 512;
const MAX_DEPTH: usize = 12;

impl AgentAdapter for Kiro {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "2.34.2",
            supported: true,
            format: "markdown",
            detail: "原生 ~/.kiro/agents 与工作区 .kiro/agents 的 [name].md/.json（name/description 必填，嵌套目录形成 team/planner 名；同名时工作区优先为 CLI 加载语义，此处并列展示）。整文件读写保真，不改写 prompt/resources/permissions 等字段；仅受信工作区加载为 CLI 行为。保存后 CLI 热重载。",
            template: "---\nname: reviewer\ndescription: Review code changes\nmodel: claude-opus-5.5\n---\nReview code changes and report findings.\n",
        }
    }
    /// Same combination as cursor/deepseek: the adapter root is the config root
    /// and the default `definition_dirs() == ["agents"]` appends the agents
    /// directory, yielding `~/.kiro/agents` and `<project>/.kiro/agents`.
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(match scope {
            Scope::Global => super::kiro_root(home),
            Scope::Project => project.ok_or("请选择项目")?.join(".kiro"),
        })
    }
    /// Nested directories form `team/planner` definition names.
    fn recursive(&self) -> bool {
        true
    }
    fn namespaced_names(&self) -> bool {
        true
    }
    /// Native fields stay whole-file content: the shared engine still requires
    /// name/description, but no Kiro-private field is shape-checked here so a
    /// native evolution never gets silently rewritten or rejected.
    fn validate_fields(&self, _value: &Value) -> Result<(), String> {
        Ok(())
    }
    /// The shared directory scan covers `[name].md`; Kiro loads `[name].json`
    /// with the same semantics, so the JSON twins are inventoried here with the
    /// same writable owner (editing routes through `config_edit` because their
    /// format is `json`).
    fn additional_sources(
        &self,
        _home: &Path,
        target: &PluginTarget,
        root: &Path,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        for (dir, enabled) in [
            (root.join("agents"), true),
            (root.join(".cliora-disabled-agents").join("agents"), false),
        ] {
            scan_json_definitions(&target.tool_id, &dir, enabled, entries)?;
        }
        Ok(())
    }
    /// Whole-file editing for the JSON twins: the draft is validated as a Kiro
    /// JSON definition and then written back verbatim, so every native field
    /// (permissions, resources, welcomeMessage, future additions) survives.
    fn config_edit(&self, entry: &AgentEntry, request: &AgentRequest) -> Result<String, String> {
        match request.action.as_str() {
            "save" => {
                crate::adapters::agents::validate(
                    &request.target.tool_id,
                    "json",
                    &request.content,
                    &entry.name,
                )?;
                Ok(request.content.clone())
            }
            "delete" | "enable" | "disable" => Err(
                "Kiro JSON 定义原生无停用字段：请以保存整体编辑；删除与启停仅在 Markdown 定义提供".into(),
            ),
            _ => Err("未知 agent 操作".into()),
        }
    }
}

/// Inventory `[name].json` definitions under one agents directory. Names come
/// from the path below the directory (`team/planner`), matching the native
/// loader. The scan is fail-closed: an unreadable file fails the whole scan
/// with an error, while a readable but invalid definition only degrades to
/// the entry detail. Collecting silently stops once 512 files are held
/// (`MAX_JSON_DEFINITIONS`); nesting deeper than 12 levels is an error.
fn scan_json_definitions(
    tool: &str,
    dir: &Path,
    enabled: bool,
    entries: &mut Vec<AgentEntry>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let mut files = Vec::new();
    collect_json_files(dir, &mut files, 0)?;
    files.sort();
    for path in files {
        let fallback = path
            .strip_prefix(dir)
            .unwrap_or(&path)
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/");
        let content = match read(&path) {
            Ok(content) => content,
            Err(error) => {
                return Err(format!("无法读取 Kiro agent 定义 {}：{error}", path.display()));
            }
        };
        entries.push(entry(
            tool,
            &path,
            "json",
            content,
            &fallback,
            enabled,
            "独立定义",
        ));
    }
    Ok(())
}

fn collect_json_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
    if out.len() >= MAX_JSON_DEFINITIONS {
        return Ok(());
    }
    if depth > MAX_DEPTH {
        return Err("Kiro agent 目录超出扫描预算".into());
    }
    let items = std::fs::read_dir(dir).map_err(|error| format!("无法读取 Kiro agent 目录：{error}"))?;
    for item in items {
        if out.len() >= MAX_JSON_DEFINITIONS {
            break;
        }
        let item = item.map_err(|error| format!("无法读取 Kiro agent 文件：{error}"))?;
        let meta = std::fs::symlink_metadata(item.path())
            .map_err(|error| format!("无法读取 Kiro agent 文件：{error}"))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let path = item.path();
        if meta.is_dir() {
            collect_json_files(&path, out, depth + 1)?;
        } else if meta.is_file() && path.extension().is_some_and(|ext| ext == "json") {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents::{validate_registered, AgentAdapter};
    use crate::adapters::Registry;

    fn adapter() -> &'static dyn AgentAdapter {
        crate::adapters::agents::get_registered(&Registry::builtins(), "kiro").unwrap()
    }

    fn target() -> PluginTarget {
        PluginTarget {
            tool_id: "kiro".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        }
    }

    #[test]
    fn agent_roots_follow_the_official_user_and_workspace_layout() {
        let home = Path::new("/home/example");
        let global = Kiro.root(Scope::Global, home, None).unwrap();
        assert!(
            global
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with(".kiro"),
            "{global:?}"
        );
        let project = Kiro
            .root(Scope::Project, home, Some(Path::new("/work/p")))
            .unwrap();
        assert!(project
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/.kiro"));
        assert!(Kiro.root(Scope::Project, home, None).is_err());
        let adapter = adapter();
        assert_eq!(adapter.definition_dirs(), ["agents"]);
        assert!(adapter.recursive());
        assert!(adapter.namespaced_names());
        // The default writable definition lands in <root>/agents/<name>.md.
        let writable = adapter.writable_definition(&project, "reviewer").unwrap();
        assert!(writable
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/.kiro/agents/reviewer.md"));
    }

    #[test]
    fn frontmatter_contract_keeps_the_documented_required_fields() {
        let registry = Registry::builtins();
        let (name, description) = validate_registered(
            &registry,
            "kiro",
            "markdown",
            "---\nname: reviewer\ndescription: Review code\nmodel: claude-opus-5.5\nincludePowers: true\n---\nReview code.\n",
            "fallback",
        )
        .unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code");
        // description is required by the official frontmatter contract.
        assert!(validate_registered(
            &registry,
            "kiro",
            "markdown",
            "---\nname: reviewer\n---\nReview code.\n",
            "fallback"
        )
        .is_err());
        // Nested directory names stay valid definition names.
        assert!(validate_registered(
            &registry,
            "kiro",
            "markdown",
            "---\nname: team/planner\ndescription: Plan the work\n---\nPlan.\n",
            "fallback"
        )
        .is_ok());
        // Native private fields are never shape-checked: whole-file fidelity.
        assert!(validate_registered(
            &registry,
            "kiro",
            "markdown",
            "---\nname: welcome\ndescription: Greets\nwelcomeMessage: Hello\nresources:\n  - skill://reviewer\npermissions:\n  rules: []\n---\nGreet.\n",
            "fallback"
        )
        .is_ok());
        let capability = adapter().capability();
        assert!(capability.supported);
        assert_eq!(capability.format, "markdown");
        assert!(validate_registered(
            &registry,
            "kiro",
            "markdown",
            capability.template,
            "reviewer"
        )
        .is_ok());
    }

    #[test]
    fn json_definitions_list_read_and_save_with_file_level_fidelity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".kiro");
        let agents = root.join("agents");
        std::fs::create_dir_all(agents.join("team")).unwrap();
        std::fs::write(
            agents.join("planner.json"),
            r#"{
  "name": "team/planner",
  "description": "Plan the work",
  "prompt": "Break the request into steps.",
  "includeMcpJson": true,
  "includePowers": false,
  "resources": ["skill://reviewer"],
  "permissions": { "rules": [] },
  "welcomeMessage": "Let's plan."
}
"#,
        )
        .unwrap();
        std::fs::write(
            agents.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review code\n---\nReview.\n",
        )
        .unwrap();
        let mut entries = Vec::new();
        Kiro.additional_sources(temp.path(), &target(), &root, &mut entries)
            .unwrap();
        assert_eq!(entries.len(), 1, "仅 JSON 走补充扫描：{entries:?}");
        let planner = &entries[0];
        assert_eq!(planner.name, "team/planner");
        assert_eq!(planner.format, "json");
        assert!(!planner.read_only, "JSON 定义与 Markdown 同为独立定义，可编辑");
        assert_eq!(planner.description, "Plan the work");
        // Saving validates the draft and returns it verbatim: every native
        // field survives without field-level rewriting.
        let draft = r#"{
  "name": "team/planner",
  "description": "Plan the work in detail",
  "prompt": "Break the request into steps.",
  "includeMcpJson": true,
  "includePowers": false,
  "resources": ["skill://reviewer"],
  "permissions": { "rules": [] },
  "welcomeMessage": "Let's plan.",
  "futureNativeField": { "kept": true }
}
"#;
        let request = AgentRequest {
            target: target(),
            action: "save".into(),
            id: Some(planner.id.clone()),
            name: planner.name.clone(),
            content: draft.into(),
            baseline: String::new(),
            transaction_id: None,
        };
        assert_eq!(Kiro.config_edit(planner, &request).unwrap(), draft);
        // An invalid draft (missing description) is refused before any write.
        let invalid = AgentRequest {
            content: r#"{ "name": "team/planner" }"#.into(),
            ..request
        };
        assert!(Kiro.config_edit(planner, &invalid).is_err());
        // Native JSON has no disable field, so those actions stay honest.
        for action in ["delete", "enable", "disable"] {
            let refused = AgentRequest {
                action: action.into(),
                ..invalid.clone()
            };
            assert!(Kiro.config_edit(planner, &refused).is_err());
        }
    }

    #[test]
    fn disabled_json_definitions_list_under_the_disabled_marker_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".kiro");
        let disabled = root.join(".cliora-disabled-agents/agents");
        std::fs::create_dir_all(&disabled).unwrap();
        std::fs::write(
            disabled.join("archived.json"),
            r#"{ "name": "archived", "description": "Old", "prompt": "None" }"#,
        )
        .unwrap();
        let mut entries = Vec::new();
        Kiro.additional_sources(temp.path(), &target(), &root, &mut entries)
            .unwrap();
        let archived = entries.iter().find(|entry| entry.name == "archived").unwrap();
        assert!(!archived.enabled);
    }
}
