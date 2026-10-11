//! Cursor sub-agents: project and user markdown, plus read-only compatibility dirs.
use std::path::{Path, PathBuf};

use super::super::agents::{AgentAdapter, AgentCapability, BuiltinAgent};
use super::Cursor;
use crate::native::adapter::Scope;
use crate::resources::agents::scan_directory;
use crate::resources::plugins::PluginTarget;

const BUILTINS: &[BuiltinAgent] = &[
    BuiltinAgent {
        name: "Explore",
        description: "Cursor 内置探索子 Agent，只读",
    },
    BuiltinAgent {
        name: "Browser",
        description: "Cursor 内置浏览器子 Agent，只读",
    },
    BuiltinAgent {
        name: "Agent",
        description: "Cursor 内置通用 Agent，只读",
    },
];

impl AgentAdapter for Cursor {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "cursor-agents",
            supported: true,
            format: "markdown",
            detail: "项目 .cursor/agents 与用户 ~/.cursor/agents 的 Markdown 定义。兼容目录和内置项只读。",
            template: "---\nname: helper\ndescription: 说明\n---\n\n提示词\n",
        }
    }

    fn builtin_definitions(&self) -> &'static [BuiltinAgent] {
        BUILTINS
    }

    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        match scope {
            Scope::Global => Ok(home.join(".cursor")),
            Scope::Project => Ok(project.ok_or("请选择项目")?.join(".cursor")),
        }
    }

    fn recursive(&self) -> bool {
        false
    }

    fn validate_fields(&self, _value: &serde_json::Value) -> Result<(), String> {
        Ok(())
    }

    fn additional_sources(
        &self,
        home: &Path,
        target: &PluginTarget,
        _root: &Path,
        entries: &mut Vec<crate::resources::agents::AgentEntry>,
    ) -> Result<(), String> {
        let base = if target.scope == Scope::Project {
            crate::resources::plugins::project(target)?.ok_or("请选择项目")?
        } else {
            home.to_path_buf()
        };
        for (relative, owner) in [
            (".claude/agents", "兼容目录 .claude/agents"),
            (".codex/agents", "兼容目录 .codex/agents"),
        ] {
            scan_directory(
                &target.tool_id,
                &base.join(relative),
                "md",
                true,
                owner,
                entries,
            )?;
        }
        Ok(())
    }
}
