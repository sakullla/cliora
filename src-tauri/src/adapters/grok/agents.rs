use super::Grok;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::{
    accounts::selection,
    native::adapter::Scope,
    resources::{
        agents::{self, AgentEntry},
        plugins::PluginTarget,
    },
};
use agents::{project, scan_directory};
use std::path::{Path, PathBuf};

impl AgentAdapter for Grok {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("1.0.46", true, "markdown", "原生 agents/*.md YAML 定义；model、tools、disallowedTools、permissionMode 可编辑。重启会话加载；移出扫描目录只禁用此定义，同名内置或其他作用域可能重新生效。", "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep, Glob\n---\nReview code and report findings.\n");
        AgentCapability {
            version,
            supported,
            format,
            detail,
            template,
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        if scope == Scope::Project {
            return Ok(project.ok_or("请选择项目")?.join(".grok"));
        }
        Ok(selection::config_root("grok", || {
            std::env::var_os("GROK_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".grok"))
        }))
    }
    fn recursive(&self) -> bool {
        false
    }
    fn additional_sources(
        &self,
        home: &Path,
        target: &PluginTarget,
        root: &Path,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        scan_directory(
            &target.tool_id,
            &root.join("bundled/agents"),
            "md",
            true,
            "原生托管 bundle",
            entries,
        )?;
        let compatible = if target.scope == Scope::Project {
            project(target)?.unwrap().join(".claude/agents")
        } else {
            home.join(".claude/agents")
        };
        scan_directory(
            &target.tool_id,
            &compatible,
            "md",
            true,
            "Claude 兼容来源（在 Claude 工作区管理）",
            entries,
        )?;
        Ok(())
    }
}
