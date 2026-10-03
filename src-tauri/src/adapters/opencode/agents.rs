use super::OpenCode;
use crate::adapters::agents::{string, AgentAdapter, AgentCapability};
use crate::{
    accounts::selection,
    native::{
        adapter::Scope,
        format::{self, FileKind},
    },
    resources::{
        agents::{self, AgentEntry, AgentRequest},
        plugins::PluginTarget,
    },
};
use agents::{entry, project, read};
use serde_json::Value;
use std::path::{Path, PathBuf};

impl AgentAdapter for OpenCode {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("1.18.34", true, "markdown", "原生 agent/agents/**/*.md 与配置中的 agent 对象；model、permission、tools 可编辑。重启会话加载。文件名决定默认名称。", "---\ndescription: Review code\nmode: subagent\npermission:\n  edit: deny\n  bash: ask\n---\nReview code and report findings.\n");
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
            return Ok(project.ok_or("请选择项目")?.join(".opencode"));
        }
        Ok(selection::config_root("open_code", || {
            std::env::var_os("OPENCODE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"))
                        .join("opencode")
                })
        }))
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
        if let Some(permission) = value.get("permission") {
            validate_permission(permission)?;
        }
        string(value, "prompt", false)?;
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
        let project = project(target)?;
        {
            // Native loads both files; inventory both rather than silently selecting one.
            if let Some(path) = paths.first() {
                let parent = path.parent().ok_or("配置目录缺失")?;
                paths = vec![parent.join("opencode.json"), parent.join("opencode.jsonc")];
            }
        }
        if target.scope == Scope::Project {
            let root = self.root(target.scope, home, project.as_deref())?;
            paths.extend([root.join("opencode.json"), root.join("opencode.jsonc")]);
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
pub(crate) fn markdown_disabled(text: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    normalized
        .strip_prefix("---\n")
        .and_then(|tail| tail.split_once("\n---\n"))
        .and_then(|(yaml, _)| serde_yaml::from_str::<Value>(yaml).ok())
        .and_then(|v| v.get("disable").and_then(Value::as_bool))
        .unwrap_or(false)
}

pub(crate) fn enable_markdown(text: &str) -> Result<String, String> {
    let mut header = false;
    let mut delimiters = 0;
    let mut changed = false;
    let mut result = String::new();
    for line in text.split_inclusive('\n') {
        if line.trim() == "---" {
            delimiters += 1;
            header = delimiters == 1;
        }
        if header && !line.starts_with(char::is_whitespace) {
            if let Some((key, tail)) = line.split_once(':') {
                if key.trim().trim_matches(['\'', '"']) == "disable" {
                    let value = tail.trim_start();
                    if let Some(rest) = value.strip_prefix("true") {
                        if rest.trim().is_empty() || rest.trim_start().starts_with('#') {
                            let offset = line.len() - value.len();
                            result.push_str(&line[..offset]);
                            result.push_str("false");
                            result.push_str(rest);
                            changed = true;
                            continue;
                        }
                    }
                }
            }
        }
        result.push_str(line);
    }
    if !changed {
        return Err("此 disable 字段使用复杂 YAML 写法，请在编辑器中改为 false 后保存".into());
    }
    Ok(result)
}
