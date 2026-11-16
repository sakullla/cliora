//! agy independent Agent definitions (1.5.9 remote evidence run).
//!
//! Verified on the authorized remote 1.5.9 machine
//! (`docs/verification/remote-workflow/agy-1.5.9/evidence/agents.json`,
//! sanitized samples `tests/fixtures/native/antigravity-cli-1.5.9/agents/
//! {global-main,workspace-main,workspace-subagent}/agent.md`): one directory
//! per agent holding `agent.md` — workspace `<project>/.agents/agents/{name}/
//! agent.md` (the project must be a committed git repo; roster discovery
//! needs no trust grant or sign-in) and global
//! `~/.gemini/config/agents/{name}/agent.md`. Frontmatter: `name` and
//! `description` are required; `mainAgent` (true or omitted = main),
//! `subagent`, `hidden`, `model` and `tools` (native tool names) plus
//! `agents`/`skills`/`plugins`/`rules`/`hooks` path lists are supported by
//! the native contract. The `--agent` launch roster holds main agents only —
//! `subagent: true` (+ `mainAgent: false`) entries are in-session
//! invocations and never appear in the roster; an unknown headless agent
//! exits 1 while enumerating the available roster.
//!
//! Plugin agents (`plugins/<name>/agents/<agent>.md`) join the same roster
//! when `mainAgent`; they are owned by the shared plugin scan
//! (`resources/agents.rs`, owner `插件：{id}`, read-only) and are NOT
//! re-implemented here. Validation covers only the verified frontmatter
//! contract above; other fields the CLI may add are preserved verbatim by
//! the shared save path (markdown content is never rewritten field-wise).

use super::Antigravity;
use crate::adapters::agents::AgentAdapter;
use crate::adapters::agents::AgentCapability;
use crate::native::adapter::Scope;
use crate::resources::agents::AgentEntry;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Verified reference line for this contract (the remote evidence install).
pub(crate) const EVIDENCE_VERSION: &str = "1.5.9";

/// Frontmatter object of a markdown definition, when it parses.
fn frontmatter(text: &str) -> Option<Value> {
    let normalized = text.replace("\r\n", "\n");
    let tail = normalized.strip_prefix("---\n")?;
    let (yaml, _) = tail.split_once("\n---\n")?;
    serde_yaml::from_str::<Value>(yaml).ok()
}

fn boolean_flag(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

/// Roster rule from the 1.5.9 evidence: `mainAgent: true` or omitted is a
/// main (launch-selectable) agent; `subagent: true` and `mainAgent: false`
/// entries never appear in the `--agent` roster. Unverified combinations
/// stay conservative (not launch-selectable) instead of guessed.
fn is_main_agent(value: &Value) -> bool {
    boolean_flag(value, "mainAgent") != Some(false) && boolean_flag(value, "subagent") != Some(true)
}

impl AgentAdapter for Antigravity {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: EVIDENCE_VERSION,
            supported: true,
            format: "markdown",
            detail: "独立 Agent 为每目录一个 agent.md：工作区 <project>/.agents/agents/{name}/ 与全局 ~/.gemini/config/agents/{name}/。frontmatter 的 name 必须与目录一致，description 必填；mainAgent（true 或省缺）为主 Agent，可经 --agent 启动选择，subagent:true 仅会话内调用。工具授权为原生工具名数组，保存完整保留未知字段。插件 Agent 随插件管理（只读）。",
            template: "---\nname: reviewer\ndescription: Review code and report findings\nmainAgent: true\ntools:\n  - read_file\n  - edit_file\n---\n# Reviewer\n\nReview the change and report findings.\n",
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(match scope {
            // The verified global definition root is the config tree itself;
            // the shared scan appends the `agents` definition directory.
            Scope::Global => super::gemini_root(home).join("config"),
            Scope::Project => project.ok_or("请选择项目")?.join(".agents"),
        })
    }
    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents"]
    }
    fn directory_name_matches_definition(&self) -> bool {
        true
    }
    fn writable_definition(&self, root: &Path, name: &str) -> Result<PathBuf, String> {
        Ok(root.join("agents").join(name).join("agent.md"))
    }
    fn definition_fallback(&self, path: &Path) -> Option<String> {
        // The file is always `agent.md`; the agent name is the parent directory.
        if path.file_name().is_some_and(|name| name == "agent.md") {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        } else {
            None
        }
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        // Only the verified frontmatter contract is checked; fields the CLI
        // knows beyond it stay valid input and are preserved on save.
        for key in ["mainAgent", "subagent", "hidden"] {
            if value.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("{key} 必须是布尔值"));
            }
        }
        if let Some(tools) = value.get("tools") {
            if !tools
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err("tools 必须是原生工具名数组".into());
            }
        }
        for key in ["agents", "skills", "plugins", "rules", "hooks"] {
            if let Some(list) = value.get(key) {
                if !list
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
                {
                    return Err(format!("{key} 必须是路径数组"));
                }
            }
        }
        Ok(())
    }
    fn annotate_entry(&self, entry: &mut AgentEntry) {
        if entry.format != "markdown" {
            return;
        }
        let Some(value) = frontmatter(&entry.content) else {
            return;
        };
        // A broken flag already failed validation; do not type a definition
        // whose frontmatter the contract cannot read.
        for key in ["mainAgent", "subagent"] {
            if value.get(key).is_some_and(|v| !v.is_boolean()) {
                return;
            }
        }
        let main = is_main_agent(&value);
        entry.launchable = Some(main);
        entry.detail.push_str(if main {
            " · 主 Agent（--agent 启动名单可选）"
        } else {
            " · 子代理（不在 --agent 启动名单，仅会话内调用）"
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents::validate;

    const GLOBAL_MAIN: &str = include_str!(
        "../../../../tests/fixtures/native/antigravity-cli-1.5.9/agents/global-main/agent.md"
    );
    const WORKSPACE_MAIN: &str = include_str!(
        "../../../../tests/fixtures/native/antigravity-cli-1.5.9/agents/workspace-main/agent.md"
    );
    const WORKSPACE_SUBAGENT: &str = include_str!(
        "../../../../tests/fixtures/native/antigravity-cli-1.5.9/agents/workspace-subagent/agent.md"
    );
    const PLUGIN_AGENT: &str = include_str!(
        "../../../../tests/fixtures/native/antigravity-cli-1.5.9/plugin/agents/fixture-agent.md"
    );

    #[test]
    fn roots_follow_the_verified_workspace_and_global_directories() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        std::fs::create_dir(&project).unwrap();
        assert_eq!(
            Antigravity
                .root(Scope::Global, temp.path(), None)
                .unwrap(),
            super::super::gemini_root(temp.path()).join("config")
        );
        assert_eq!(
            Antigravity
                .root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".agents")
        );
        assert!(Antigravity
            .root(Scope::Project, temp.path(), None)
            .is_err());
        // One directory per agent: the definition file is `{name}/agent.md`
        // and the frontmatter name must match the directory.
        assert_eq!(
            Antigravity
                .writable_definition(
                    &Antigravity.root(Scope::Global, temp.path(), None).unwrap(),
                    "reviewer"
                )
                .unwrap(),
            super::super::gemini_root(temp.path())
                .join("config")
                .join("agents")
                .join("reviewer")
                .join("agent.md")
        );
        assert_eq!(Antigravity.definition_dirs(), &["agents"]);
        assert!(Antigravity.directory_name_matches_definition());
        // The scan fallback names the parent directory, not the file stem.
        let file = Path::new("/work/repo/.agents/agents/probe-main/agent.md");
        assert_eq!(
            Antigravity.definition_fallback(file).as_deref(),
            Some("probe-main")
        );
        assert!(Antigravity
            .definition_fallback(Path::new("/work/repo/.agents/agents/loose.md"))
            .is_none());
    }

    #[test]
    fn frontmatter_follows_the_verified_contract_and_keeps_unknown_fields() {
        let capability = Antigravity.capability();
        assert_eq!(capability.version, EVIDENCE_VERSION);
        assert_eq!(capability.format, "markdown");
        assert!(validate("antigravity", "markdown", capability.template, "reviewer").is_ok());
        // The sanitized evidence samples all validate; the name matches the
        // directory each sample lives in.
        for (source, directory) in [
            (GLOBAL_MAIN, "global-main"),
            (WORKSPACE_MAIN, "workspace-main"),
            (WORKSPACE_SUBAGENT, "workspace-subagent"),
            (PLUGIN_AGENT, "fixture-agent"),
        ] {
            let parsed = validate("antigravity", "markdown", source, directory);
            assert!(parsed.is_ok(), "{directory}: {parsed:?}");
        }
        // Verified optional fields are type-checked.
        assert!(validate(
            "antigravity",
            "markdown",
            "---\nname: probe\ndescription: Probe\nmainAgent: yes\n---\nBody.\n",
            "probe"
        )
        .unwrap_err()
        .contains("布尔值"));
        assert!(validate(
            "antigravity",
            "markdown",
            "---\nname: probe\ndescription: Probe\ntools: read_file\n---\nBody.\n",
            "probe"
        )
        .unwrap_err()
        .contains("tools"));
        assert!(validate(
            "antigravity",
            "markdown",
            "---\nname: probe\ndescription: Probe\nskills:\n  - ./review\n---\nBody.\n",
            "probe"
        )
        .is_ok());
        // Fields beyond the verified contract are not rejected: the shared
        // save writes markdown verbatim, so unknown frontmatter survives.
        assert!(validate(
            "antigravity",
            "markdown",
            "---\nname: probe\ndescription: Probe\nfutureField: {nested: true}\n---\nBody.\n",
            "probe"
        )
        .is_ok());
    }

    #[test]
    fn roster_typing_marks_main_agents_launch_selectable_only() {
        let main = crate::resources::agents::entry(
            "antigravity",
            Path::new("/work/.agents/agents/probe-main/agent.md"),
            "markdown",
            WORKSPACE_MAIN.to_owned(),
            "probe-main",
            true,
            "独立定义",
        );
        assert_eq!(main.launchable, Some(true));
        assert!(main.detail.contains("主 Agent"));
        // mainAgent omitted defaults to main (evidence roster rule).
        let omitted = crate::resources::agents::entry(
            "antigravity",
            Path::new("/work/.agents/agents/default-kind/agent.md"),
            "markdown",
            "---\nname: probe-default-kind\ndescription: Defaults to main.\ntools: [read_file]\n---\nBody.\n".to_owned(),
            "default-kind",
            true,
            "独立定义",
        );
        assert_eq!(omitted.launchable, Some(true));
        // subagent:true + mainAgent:false never joins the --agent roster.
        let subagent = crate::resources::agents::entry(
            "antigravity",
            Path::new("/work/.agents/agents/probe-sub/agent.md"),
            "markdown",
            WORKSPACE_SUBAGENT.to_owned(),
            "probe-sub",
            true,
            "插件：fixture-plugin",
        );
        assert_eq!(subagent.launchable, Some(false));
        assert!(subagent.detail.contains("子代理"));
        // Unverified mainAgent:false without subagent stays conservative.
        let explicit_false = crate::resources::agents::entry(
            "antigravity",
            Path::new("/work/.agents/agents/probe-false/agent.md"),
            "markdown",
            "---\nname: probe-false\ndescription: Explicit false.\nmainAgent: false\n---\nBody.\n".to_owned(),
            "probe-false",
            true,
            "独立定义",
        );
        assert_eq!(explicit_false.launchable, Some(false));
        // A broken flag (validation failed) is not typed.
        let broken = crate::resources::agents::entry(
            "antigravity",
            Path::new("/work/.agents/agents/broken/agent.md"),
            "markdown",
            "---\nname: broken\ndescription: Broken\nmainAgent: maybe\n---\nBody.\n".to_owned(),
            "broken",
            true,
            "独立定义",
        );
        assert_eq!(broken.launchable, None);
        assert!(!broken.detail.contains("主 Agent"));
    }

    #[test]
    fn shared_scan_lists_definition_directories_with_relocation() {
        let temp = tempfile::tempdir().unwrap();
        let root = Antigravity
            .root(Scope::Project, temp.path(), Some(&temp.path().join("repo")))
            .unwrap();
        let agents = root.join("agents");
        std::fs::create_dir_all(agents.join("probe-main")).unwrap();
        std::fs::write(agents.join("probe-main").join("agent.md"), WORKSPACE_MAIN).unwrap();
        std::fs::create_dir_all(agents.join("probe-sub")).unwrap();
        std::fs::write(agents.join("probe-sub").join("agent.md"), WORKSPACE_SUBAGENT).unwrap();
        // The shared disabled relocation directory is part of the scan.
        let disabled = root.join(".cliora-disabled-agents").join("agents").join("probe-off");
        std::fs::create_dir_all(&disabled).unwrap();
        std::fs::write(disabled.join("agent.md"), GLOBAL_MAIN).unwrap();
        let mut entries = Vec::new();
        crate::resources::agents::scan_directory(
            "antigravity",
            &root.join("agents"),
            "md",
            true,
            "独立定义",
            &mut entries,
        )
        .unwrap();
        crate::resources::agents::scan_directory(
            "antigravity",
            &root.join(".cliora-disabled-agents").join("agents"),
            "md",
            false,
            "独立定义",
            &mut entries,
        )
        .unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<(&str, Option<bool>, bool)> = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.launchable, entry.enabled))
            .collect();
        assert_eq!(
            names,
            vec![
                ("fixture-global-main", Some(true), false),
                ("fixture-subagent", Some(false), true),
                ("fixture-workspace-main", Some(true), true),
            ]
        );
        for entry in &entries {
            assert!(!entry.read_only, "独立定义 stays writable: {}", entry.name);
            assert!(entry.path.replace('\\', "/").ends_with("/agent.md"));
        }
    }
}
