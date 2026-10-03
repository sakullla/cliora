//! Definition contracts, distinct from running agent sessions and AGENTS.md.
use crate::native::adapter::Scope;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapability {
    pub version: &'static str,
    pub supported: bool,
    pub format: &'static str,
    pub detail: &'static str,
    pub template: &'static str,
}
pub fn capability(tool: &str) -> Result<AgentCapability, String> {
    Ok(get(tool)?.capability())
}
pub fn root(
    tool: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Result<PathBuf, String> {
    get(tool)?.root(scope, home, project)
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub(crate) fn string(value: &Value, key: &str, required: bool) -> Result<(), String> {
    match value.get(key) {
        Some(Value::String(s)) if !required || !s.trim().is_empty() => Ok(()),
        None if !required => Ok(()),
        _ => Err(format!(
            "{key} 必须是{}字符串",
            if required { "非空" } else { "" }
        )),
    }
}
pub fn validate(
    tool: &str,
    format: &str,
    source: &str,
    fallback: &str,
) -> Result<(String, String), String> {
    validate_registered(&super::Registry::builtins(), tool, format, source, fallback)
}
pub fn validate_registered(
    registry: &super::Registry,
    tool: &str,
    format: &str,
    source: &str,
    fallback: &str,
) -> Result<(String, String), String> {
    if source.len() > 256 * 1024 {
        return Err("定义超过 256 KiB".into());
    }
    let (value, prompt) = if format == "toml" {
        (
            crate::native::format::parse(crate::native::format::FileKind::Toml, source)?,
            None,
        )
    } else if format == "json" {
        (
            crate::native::format::parse(crate::native::format::FileKind::Json, source)?,
            None,
        )
    } else {
        let normalized = source.replace("\r\n", "\n");
        let tail = normalized
            .strip_prefix("---\n")
            .ok_or("缺少 YAML frontmatter（---）")?;
        let (yaml, body) = tail
            .split_once("\n---\n")
            .ok_or("YAML frontmatter 缺少结束分隔符")?;
        let value: Value = serde_yaml::from_str(yaml).map_err(|e| format!("YAML 无效：{e}"))?;
        (value, Some(body.to_owned()))
    };
    if !value.is_object() {
        return Err("定义字段必须是对象".into());
    }
    let adapter = get_registered(registry, tool)?;
    let required_name = adapter.required_name();
    string(&value, "name", required_name)?;
    string(&value, "description", adapter.required_name())?;
    string(&value, "model", false)?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !valid_name(name) && !(adapter.namespaced_names() && name.split('/').all(valid_name)) {
        return Err("名称只能包含字母、数字、连字符和下划线".into());
    }
    adapter.validate_fields(&value)?;

    if prompt.is_some_and(|p| p.trim().is_empty()) {
        return Err("提示词不能为空".into());
    }
    Ok((
        name.into(),
        value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
    ))
}

// Validate the pinned native schema without rewriting source text or dropping keys.

/// Claude reserves colons for plugin-scoped identifiers; local frontmatter stays unchanged.
pub fn plugin_identity(
    tool: &str,
    plugin_id: &str,
    agents_root: &Path,
    path: &Path,
    native_name: &str,
) -> String {
    get(tool)
        .map(|a| a.plugin_identity(plugin_id, agents_root, path, native_name))
        .unwrap_or_else(|_| native_name.into())
}

pub(crate) fn validate_markdown_fields(value: &Value) -> Result<(), String> {
    for key in ["tools", "disallowedTools"] {
        if let Some(v) = value.get(key) {
            if !v.is_string() && !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)) {
                return Err(format!("{key} 必须是字符串或字符串数组"));
            }
        }
    }
    if let Some(v) = value.get("permissionMode") {
        if ![
            "default",
            "acceptEdits",
            "auto",
            "dontAsk",
            "bypassPermissions",
            "plan",
            "manual",
        ]
        .contains(&v.as_str().unwrap_or(""))
        {
            return Err("permissionMode 无效".into());
        }
    }
    if value
        .get("maxTurns")
        .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0))
    {
        return Err("maxTurns 必须为正整数".into());
    }

    Ok(())
}

pub trait AgentAdapter: Sync {
    fn capability(&self) -> AgentCapability;
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String>;
    fn extension(&self) -> &'static str {
        "md"
    }
    fn recursive(&self) -> bool {
        true
    }
    fn required_name(&self) -> bool {
        true
    }
    fn namespaced_names(&self) -> bool {
        false
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        validate_markdown_fields(value)
    }
    fn plugin_identity(&self, _plugin: &str, _root: &Path, _path: &Path, name: &str) -> String {
        name.into()
    }
    fn config_paths(
        &self,
        _home: &Path,
        _target: &crate::resources::plugins::PluginTarget,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<PathBuf>, String> {
        Ok(paths)
    }
    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents"]
    }
    fn config_entries(
        &self,
        _target: &crate::resources::plugins::PluginTarget,
        _root: &Path,
        _path: &Path,
        _value: &Value,
        _entries: &mut Vec<crate::resources::agents::AgentEntry>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn additional_sources(
        &self,
        _home: &Path,
        _target: &crate::resources::plugins::PluginTarget,
        _root: &Path,
        _entries: &mut Vec<crate::resources::agents::AgentEntry>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn disabled_detail(&self) -> &'static str {
        "原生定义已停用。"
    }
    fn native_disabled(&self, _format: &str, _content: &str) -> bool {
        false
    }
    fn enable_content(&self, content: &str) -> Result<String, String> {
        Ok(content.into())
    }
    fn config_edit(
        &self,
        _entry: &crate::resources::agents::AgentEntry,
        _request: &crate::resources::agents::AgentRequest,
    ) -> Result<String, String> {
        Err("此 CLI 未提供内联定义编辑".into())
    }
}
pub fn get(tool: &str) -> Result<&'static dyn AgentAdapter, String> {
    get_registered(&super::Registry::builtins(), tool)
}
pub fn get_registered(
    registry: &super::Registry,
    tool: &str,
) -> Result<&'static dyn AgentAdapter, String> {
    registry
        .get(tool)
        .and_then(|a| a.agents())
        .ok_or_else(|| "此 CLI 未提供此能力适配".into())
}
