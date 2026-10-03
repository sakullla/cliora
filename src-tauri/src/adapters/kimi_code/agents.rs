use super::config_dir;
use super::KimiCode;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use crate::resources::agents::{self, AgentEntry};
use crate::resources::plugins::PluginTarget;
use agents::scan_directory;
use std::path::{Path, PathBuf};

impl AgentAdapter for KimiCode {
    fn capability(&self) -> AgentCapability {
        let (version, supported, format, detail, template) = (
            "0.31.1",
            true,
            "markdown",
            "Kimi Code 原生 agents/**/*.md（YAML frontmatter：name/description/whenToUse/tools 等，宽松透传）；会话以 --agent 选择，重启会话加载。",
            "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep, Glob\n---\nReview code and report findings.\n",
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
        match scope {
            Scope::Project => Ok(project
                .ok_or("请选择项目")?
                .join(".kimi-code")),
            Scope::Global => Ok(config_dir(home)),
        }
    }
    fn additional_sources(
        &self,
        home: &Path,
        target: &PluginTarget,
        _root: &Path,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        // Kimi Code also discovers the shared `.agents/agents` compatibility
        // root; definitions there stay read-only for this tool.
        let compatible = if target.scope == Scope::Project {
            crate::resources::plugins::project(target)?
                .unwrap()
                .join(".agents/agents")
        } else {
            home.join(".agents/agents")
        };
        scan_directory(
            &target.tool_id,
            &compatible,
            "md",
            true,
            "兼容来源 .agents/agents（在对应目录管理）",
            entries,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_roots_and_compatibility_directory_resolve() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(
            KimiCode.root(Scope::Global, temp.path(), None).unwrap(),
            temp.path().join(".kimi-code")
        );
        assert_eq!(
            KimiCode
                .root(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            project.join(".kimi-code")
        );
        let mut entries = Vec::new();
        let target = PluginTarget {
            tool_id: "kimi_code".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let compat = temp.path().join(".agents/agents");
        std::fs::create_dir_all(&compat).unwrap();
        std::fs::write(
            compat.join("shared.md"),
            "---\nname: shared\ndescription: Compatibility agent\n---\nBody\n",
        )
        .unwrap();
        KimiCode
            .additional_sources(temp.path(), &target, temp.path(), &mut entries)
            .unwrap();
        assert!(entries.iter().any(|entry| entry.name == "shared"));
        assert!(entries
            .iter()
            .all(|entry| entry.read_only), "兼容来源必须只读");
    }
}
