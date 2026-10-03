use super::ZCode;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use std::path::{Path, PathBuf};

impl AgentAdapter for ZCode {
    fn capability(&self) -> AgentCapability {
        let (version, supported, format, detail, template) = (
            "3.14.4",
            true,
            "markdown",
            "原生 ~/.zcode/agents 与工作区 .zcode/agents 的 Markdown frontmatter；name/description 必填，permissionMode 仅支持 auto/plan。重启会话后加载。",
            "---\nname: reviewer\ndescription: Review code changes\npermissionMode: auto\ntools: Read, Grep, Glob\n---\nReview code changes and report findings.\n",
        );
        AgentCapability {
            version,
            supported,
            format,
            detail,
            template,
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(match scope {
            // packages/services/src/subagents/subagentStorage.ts: user root is
            // <storage>/agents, workspace root is <ws>/.zcode/agents.
            Scope::Global => super::data_root(home).join("agents"),
            Scope::Project => project
                .ok_or("请选择项目")?
                .join(".zcode")
                .join("agents"),
        })
    }
    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents"]
    }
    fn validate_fields(&self, value: &serde_json::Value) -> Result<(), String> {
        crate::adapters::agents::validate_markdown_fields(value)?;
        // ZCode documents only auto/plan permission modes (subagentMarkdown.ts).
        if let Some(mode) = value.get("permissionMode") {
            if !matches!(mode.as_str(), Some("auto") | Some("plan")) {
                return Err("permissionMode 无效：ZCode 仅支持 auto 或 plan".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents::validate_registered;
    use crate::adapters::Registry;

    #[test]
    fn agent_roots_follow_the_official_user_and_workspace_layout() {
        let home = Path::new("/home/example");
        assert!(
            ZCode
                .root(Scope::Global, home, None)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with(".zcode/agents")
        );
        let project = ZCode
            .root(Scope::Project, home, Some(Path::new("/work/p")))
            .unwrap();
        assert!(project.to_string_lossy().replace('\\', "/").ends_with("p/.zcode/agents"));
    }

    #[test]
    fn frontmatter_contract_matches_the_official_required_fields() {
        let registry = Registry::builtins();
        let (name, description) = validate_registered(
            &registry,
            "zcode",
            "markdown",
            "---\nname: reviewer\ndescription: Review code\npermissionMode: plan\nmaxTurns: 5\ntools: Read, Grep\n---\nReview code.\n",
            "fallback",
        )
        .unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code");
        assert!(validate_registered(
            &registry,
            "zcode",
            "markdown",
            "---\ndescription: missing name\n---\nbody\n",
            "fallback"
        )
        .is_err());
        // ZCode only documents auto/plan permission modes.
        assert!(validate_registered(
            &registry,
            "zcode",
            "markdown",
            "---\nname: bad\ndescription: d\npermissionMode: bypassPermissions\n---\nbody\n",
            "fallback"
        )
        .is_err());
    }
}
