use super::Claude;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::{
    accounts::selection,
    native::adapter::Scope,
    resources::{
        agents::{self, AgentEntry},
        plugins::PluginTarget,
    },
};
use agents::scan_directory;
use std::path::{Path, PathBuf};

impl AgentAdapter for Claude {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("2.1.287", true, "markdown", "原生 agents/**/*.md，YAML 字段保留；model、tools、disallowedTools、permissionMode 可编辑。下次委派加载；首次创建 agents 目录需重启。", "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep, Glob\nmodel: inherit\n---\nReview code and report findings.\n");
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
            return Ok(project.ok_or("请选择项目")?.join(".claude"));
        }
        Ok(selection::config_root("claude_code", || {
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"))
        }))
    }
    fn additional_sources(
        &self,
        _home: &Path,
        target: &PluginTarget,
        _root: &Path,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        let managed = if cfg!(windows) {
            std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("C:/Program Files"))
                .join("ClaudeCode/.claude/agents")
        } else if cfg!(target_os = "macos") {
            PathBuf::from("/Library/Application Support/ClaudeCode/.claude/agents")
        } else {
            PathBuf::from("/etc/claude-code/.claude/agents")
        };
        scan_directory(&target.tool_id, &managed, "md", true, "组织管理", entries)?;
        Ok(())
    }
    fn plugin_identity(
        &self,
        plugin_id: &str,
        agents_root: &Path,
        path: &Path,
        native_name: &str,
    ) -> String {
        let plugin = plugin_id.split('@').next().unwrap_or(plugin_id);
        let mut parts = vec![plugin.to_owned()];
        if let Ok(relative) = path.strip_prefix(agents_root) {
            if let Some(parent) = relative.parent() {
                parts.extend(parent.components().filter_map(|part| match part {
                    std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                    _ => None,
                }));
            }
        }
        parts.push(native_name.into());
        parts.join(":")
    }
}
