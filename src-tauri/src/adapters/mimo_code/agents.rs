//! MiMo Code agent definitions.
//!
//! [src] Evidence: XiaomiMiMo/MiMo-Code 0.1.15 `packages/cli/src/config/agent.ts`
//! — definitions load from `{agent,agents}/**/*.md` under every config directory
//! (global `~/.config/mimocode`, project `.mimocode`, `~/.mimocode`) with YAML
//! frontmatter plus the file body as `prompt`, and the config file's `agent`
//! key is a `Record<String, AgentConfig>` (model/variant/temperature/top_p/
//! prompt/tools/disable/description/mode subagent|primary|all/hidden/options/
//! color/steps/tool_allowlist/permission). Entry names come from the path under
//! the `agent`/`agents` segments.

use super::MiMoCode;
use crate::adapters::agents::{string, AgentAdapter, AgentCapability};
use crate::native::{adapter::Scope, format::{self, FileKind}};
use crate::resources::{
    agents::{self, AgentEntry, AgentRequest},
    plugins::PluginTarget,
};
use agents::{entry, project, read};
use serde_json::Value;
use std::path::{Path, PathBuf};

impl AgentAdapter for MiMoCode {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "0.1.15",
            supported: true,
            format: "markdown",
            detail: "原生 {agent,agents}/**/*.md 与配置文件 agent 键；model、mode、permission、steps 可编辑。重启会话加载。",
            template: "---\ndescription: Review code\nmode: subagent\npermission:\n  edit: deny\n  bash: ask\n---\nReview code and report findings.\n",
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        match scope {
            Scope::Project => Ok(project
                .ok_or("请选择项目")?
                .join(".mimocode")),
            Scope::Global => Ok(super::config_dir(home)),
        }
    }
    fn required_name(&self) -> bool {
        false
    }
    fn namespaced_names(&self) -> bool {
        true
    }
    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents", "agent"]
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        for key in ["disable", "hidden"] {
            if value.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("{key} 必须是布尔值"));
            }
        }
        if let Some(mode) = value.get("mode") {
            if !["subagent", "primary", "all"].contains(&mode.as_str().unwrap_or("")) {
                return Err("mode 无效".into());
            }
        }
        if let Some(tools) = value.get("tools") {
            if !tools
                .as_object()
                .is_some_and(|map| map.values().all(Value::is_boolean))
            {
                return Err("tools 必须是工具名到布尔值的对象".into());
            }
        }
        if let Some(allowlist) = value.get("tool_allowlist") {
            if !allowlist
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
            {
                return Err("tool_allowlist 必须是字符串数组".into());
            }
        }
        for key in ["temperature", "top_p"] {
            if value.get(key).is_some_and(|v| !v.is_f64()) {
                return Err(format!("{key} 必须是数字"));
            }
        }
        if let Some(color) = value.get("color") {
            let valid = color.as_str().is_some_and(|color| {
                color.starts_with('#') && color.len() == 7
                    || ["primary", "secondary", "accent", "success", "warning", "error", "info"]
                        .contains(&color)
            });
            if !valid {
                return Err("color 必须是 #RRGGBB 或主题色名".into());
            }
        }
        if let Some(permission) = value.get("permission") {
            validate_permission(permission)?;
        }
        string(value, "prompt", false)?;
        string(value, "variant", false)?;
        for key in ["steps", "maxSteps"] {
            if value
                .get(key)
                .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0))
            {
                return Err(format!("{key} 必须为正整数"));
            }
        }
        Ok(())
    }
    fn config_paths(
        &self,
        home: &Path,
        target: &PluginTarget,
        mut paths: Vec<PathBuf>,
    ) -> Result<Vec<PathBuf>, String> {
        // Native loads both file names in every config directory; inventory both
        // rather than silently selecting one.
        if let Some(path) = paths.first() {
            let parent = path.parent().ok_or("配置目录缺失")?;
            paths = vec![
                parent.join("mimocode.json"),
                parent.join("mimocode.jsonc"),
            ];
        }
        if target.scope == Scope::Project {
            let project = project(target)?;
            if let Some(project) = project {
                let root = self.root(target.scope, home, Some(&project))?;
                paths.extend([root.join("mimocode.json"), root.join("mimocode.jsonc")]);
            }
        }
        Ok(paths)
    }
    fn config_entries(
        &self,
        target: &PluginTarget,
        _root: &Path,
        path: &Path,
        value: &Value,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        if let Some(agents) = value.get("agent") {
            let agents = agents.as_object().ok_or("原生 agent 配置不是对象")?;
            for (name, value) in agents {
                let mut e = entry(
                    &target.tool_id,
                    path,
                    "json",
                    serde_json::to_string_pretty(value).map_err(|_| "定义无效")?,
                    name,
                    !value
                        .get("disable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "独立定义",
                );
                e.id = format!("{}#agent/{name}", path.display());
                e.name = name.clone();
                entries.push(e);
            }
        }
        Ok(())
    }
    fn disabled_detail(&self) -> &'static str {
        "原生 disable: true；启用会保留其他字段并关闭此开关。 "
    }
    fn native_disabled(&self, format: &str, content: &str) -> bool {
        format == "markdown" && markdown_disabled(content)
    }
    fn enable_content(&self, content: &str) -> Result<String, String> {
        if markdown_disabled(content) {
            enable_markdown(content)
        } else {
            Ok(content.into())
        }
    }
    fn config_edit(&self, entry: &AgentEntry, request: &AgentRequest) -> Result<String, String> {
        let target = &request.target;
        let path = PathBuf::from(&entry.path);
        let old = read(&path)?;
        let kind = FileKind::for_name(&entry.path)?;
        let value = match request.action.as_str() {
            "save" => {
                crate::adapters::agents::validate(
                    &target.tool_id,
                    "json",
                    &request.content,
                    &entry.name,
                )?;
                Some(format::parse(FileKind::Json, &request.content)?)
            }
            "delete" => None,
            "enable" | "disable" => {
                let mut v = format::parse(FileKind::Json, &entry.content)?;
                v["disable"] = Value::Bool(request.action == "disable");
                Some(v)
            }
            _ => return Err("未知 agent 操作".into()),
        };
        let output = format::set_path(
            kind,
            &old,
            &["agent".into(), entry.name.clone()],
            value.as_ref(),
        )?;
        Ok(output)
    }
}

fn validate_permission(value: &Value) -> Result<(), String> {
    if value
        .as_str()
        .is_some_and(|s| ["allow", "deny", "ask"].contains(&s))
    {
        return Ok(());
    }
    if let Some(map) = value.as_object() {
        for value in map.values() {
            validate_permission(value)?;
        }
        return Ok(());
    }
    Err("permission 值必须是 allow、deny、ask 或规则对象".into())
}

fn markdown_disabled(text: &str) -> bool {
    crate::adapters::opencode::agents::markdown_disabled(text)
}

fn enable_markdown(text: &str) -> Result<String, String> {
    crate::adapters::opencode::agents::enable_markdown(text)
}
