use super::CodeBuddy;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use std::path::{Path, PathBuf};

impl AgentAdapter for CodeBuddy {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "2.161.1",
            supported: true,
            format: "markdown",
            detail: "原生 agents/*.md YAML frontmatter 定义（项目 .codebuddy/agents 优先于用户 ~/.codebuddy/agents），正文为系统提示；tools/model/permissionMode/maxTurns 等字段可编辑。重启会话加载。",
            template: "---\nname: reviewer\ndescription: Review code changes\nmodel: default\n---\nReview code and report findings.\n",
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        if scope == Scope::Project {
            return Ok(project.ok_or("请选择项目")?.join(".codebuddy"));
        }
        Ok(super::config_root(home))
    }
    fn recursive(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_roots_follow_the_official_directories() {
        let home = Path::new("/home/example");
        let user = CodeBuddy.root(Scope::Global, home, None).unwrap();
        assert!(user
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("/.codebuddy"));
        let project = CodeBuddy
            .root(Scope::Project, home, Some(Path::new("/work/demo")))
            .unwrap();
        assert!(project
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("/work/demo/.codebuddy"));
        assert_eq!(CodeBuddy.definition_dirs(), &["agents"]);
    }

    #[test]
    fn template_passes_the_shared_markdown_validation() {
        let (name, description) = crate::adapters::agents::validate(
            "codebuddy",
            "markdown",
            CodeBuddy.capability().template,
            "fallback",
        )
        .unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code changes");
    }
}
