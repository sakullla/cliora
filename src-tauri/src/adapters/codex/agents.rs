use super::Codex;
use crate::adapters::agents::{string, AgentAdapter, AgentCapability};
use crate::{
    accounts::selection,
    native::adapter::Scope,
    resources::{
        agents::{self, AgentEntry},
        plugins::PluginTarget,
    },
};
use agents::read;
use serde_json::Value;
use std::path::{Path, PathBuf};

impl AgentAdapter for Codex {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("0.160.0", true, "toml", "原生 agents/**/*.toml；developer_instructions 为提示词，sandbox_mode 与 tools 控制能力。重启会话加载；显式 config_file 引用单独显示为只读。", "name = \"reviewer\"\ndescription = \"Review code\"\ndeveloper_instructions = \"Review code and report findings.\"\nsandbox_mode = \"read-only\"\n");
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
            return Ok(project.ok_or("请选择项目")?.join(".codex"));
        }
        Ok(selection::config_root("codex", || {
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
        }))
    }
    fn extension(&self) -> &'static str {
        "toml"
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        string(&value, "developer_instructions", true)?;
        static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let schema = SCHEMA.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../../tests/fixtures/agents/codex-config-schema.json"
            ))
            .expect("pinned schema")
        });
        let mut config = value.clone();
        for key in ["name", "description", "nickname_candidates"] {
            config.as_object_mut().unwrap().remove(key);
        }
        schema_check(&config, schema, schema, "agent", 0)?;
        if let Some(names) = value.get("nickname_candidates") {
            if !names.as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.iter()
                        .all(|n| n.as_str().is_some_and(|s| !s.trim().is_empty()))
            }) {
                return Err("nickname_candidates 必须为非空字符串数组".into());
            }
        }

        for key in ["sandbox_mode", "model_reasoning_effort", "approval_policy"] {
            if value
                .get(key)
                .is_some_and(|v| !v.is_string() && !v.is_object())
            {
                return Err(format!("{key} 类型不正确"));
            }
        }
        if let Some(mode) = value.get("sandbox_mode") {
            if !["read-only", "workspace-write", "danger-full-access"]
                .contains(&mode.as_str().unwrap_or(""))
            {
                return Err("sandbox_mode 无效".into());
            }
        }
        Ok(())
    }
    fn config_entries(
        &self,
        _target: &PluginTarget,
        root: &Path,
        path: &Path,
        value: &Value,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        if let Some(agents) = value.get("agents").and_then(Value::as_object) {
            for (name, value) in agents.iter().filter(|(_, v)| v.is_object()) {
                let file = value
                    .get("config_file")
                    .and_then(Value::as_str)
                    .map(|file| path.parent().unwrap_or(&root).join(file));
                if let Some(file) = &file {
                    for e in entries.iter_mut() {
                        if Path::new(&e.path).canonicalize().ok() == file.canonicalize().ok()
                            && file.exists()
                        {
                            e.read_only = true;
                            e.owner = "config.toml 显式引用".into();
                            e.detail = "显式引用需要同时维护原生配置，请在配置编辑器管理".into();
                        }
                    }
                }
                if !entries.iter().any(|e| e.name == *name) {
                    entries.push(AgentEntry {
                        id: format!("{}#agents/{name}", path.display()),
                        name: name.clone(),
                        description: value
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        path: file.as_deref().unwrap_or(path).display().to_string(),
                        format: "toml".into(),
                        content: file.as_ref().and_then(|p| read(p).ok()).unwrap_or_default(),
                        enabled: true,
                        read_only: true,
                        owner: "config.toml 显式引用".into(),
                        detail: "此兼容格式由配置编辑器管理；新增定义使用原生自动扫描格式".into(),
                    });
                }
            }
        }
        Ok(())
    }
}
fn schema_check(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    depth: usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("定义嵌套过深".into());
    }
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return schema_check(
            value,
            root.pointer(reference.trim_start_matches('#'))
                .ok_or("schema 引用无效")?,
            root,
            path,
            depth + 1,
        );
    }
    if let Some(items) = schema.get("allOf").and_then(Value::as_array) {
        for item in items {
            schema_check(value, item, root, path, depth + 1)?;
        }
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(items) = schema.get(key).and_then(Value::as_array) {
            if !items
                .iter()
                .any(|s| schema_check(value, s, root, path, depth + 1).is_ok())
            {
                return Err(format!("{path} 不符合原生字段格式"));
            }
        }
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let valid = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "null" => value.is_null(),
            _ => true,
        };
        if !valid {
            return Err(format!("{path} 必须为 {kind}"));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            return Err(format!("{path} 不是支持的枚举值"));
        }
    }
    if let Some(number) = value.as_f64() {
        for (key, bad) in [("minimum", false), ("maximum", true)] {
            if let Some(limit) = schema.get(key).and_then(Value::as_f64) {
                if if bad { number > limit } else { number < limit } {
                    return Err(format!("{path} 超出原生数值范围"));
                }
            }
        }
    }
    if let Some(map) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !map.contains_key(key) {
                    return Err(format!("{path}.{key} 缺失"));
                }
            }
        }
        for (key, v) in map {
            let child = format!("{path}.{key}");
            if let Some(s) = schema.get("properties").and_then(|s| s.get(key)) {
                schema_check(v, s, root, &child, depth + 1)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("{child} 不是此版本支持的字段"));
            } else if let Some(s) = schema.get("additionalProperties").filter(|s| s.is_object()) {
                schema_check(v, s, root, &child, depth + 1)?;
            }
        }
    }
    if let (Some(values), Some(items)) = (value.as_array(), schema.get("items")) {
        for v in values {
            schema_check(v, items, root, path, depth + 1)?;
        }
    }
    Ok(())
}
