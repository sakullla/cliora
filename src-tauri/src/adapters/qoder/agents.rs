use super::Qoder;
use crate::adapters::agents::AgentAdapter;
use crate::native::adapter::Scope;
use std::path::{Path, PathBuf};

impl AgentAdapter for Qoder {
    fn capability(&self) -> crate::adapters::agents::AgentCapability {
        crate::adapters::agents::AgentCapability {
            version: "1.1.63",
            supported: true,
            format: "markdown",
            detail: "原生 agents/*.md（项目 .qoder/agents 与用户 ~/.qoder/agents），YAML frontmatter 必填 name/description，可选 model/tools/permissionMode/maxTurns 等字段宽松透传；优先级 内置 < 用户 < 项目。下次委派加载。",
            template: "---\nname: reviewer\ndescription: Review code\n---\nReview code and report findings.\n",
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        if scope == Scope::Project {
            return Ok(project.ok_or("请选择项目")?.join(".qoder"));
        }
        Ok(super::config_root(home))
    }
}
