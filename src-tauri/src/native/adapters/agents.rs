//! Definition contracts, distinct from running agent sessions and AGENTS.md.
use crate::{accounts::selection, native::adapter::Scope};
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
    let (version, supported, format, detail, template) = match tool {
        "codex" => ("0.160.0", true, "toml", "原生 agents/**/*.toml；developer_instructions 为提示词，sandbox_mode 与 tools 控制能力。重启会话加载；显式 config_file 引用单独显示为只读。", "name = \"reviewer\"\ndescription = \"Review code\"\ndeveloper_instructions = \"Review code and report findings.\"\nsandbox_mode = \"read-only\"\n"),
        "claude_code" => ("2.1.287", true, "markdown", "原生 agents/**/*.md，YAML 字段保留；model、tools、disallowedTools、permissionMode 可编辑。下次委派加载；首次创建 agents 目录需重启。", "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep, Glob\nmodel: inherit\n---\nReview code and report findings.\n"),
        "grok" => ("1.0.46", true, "markdown", "原生 agents/*.md YAML 定义；model、tools、disallowedTools、permissionMode 可编辑。重启会话加载；移出扫描目录只禁用此定义，同名内置或其他作用域可能重新生效。", "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep, Glob\n---\nReview code and report findings.\n"),
        "open_code" => ("1.18.34", true, "markdown", "原生 agent/agents/**/*.md 与配置中的 agent 对象；model、permission、tools 可编辑。重启会话加载。文件名决定默认名称。", "---\ndescription: Review code\nmode: subagent\npermission:\n  edit: deny\n  bash: ask\n---\nReview code and report findings.\n"),
        "pi" => ("0.99.2", false, "text", "此版本未证实统一的原生 agent 定义格式。扩展自定义的 subagent 由对应 package 管理；AGENTS.md 属于规则。", ""),
        _ => return Err("未知 CLI".into()),
    };
    Ok(AgentCapability {
        version,
        supported,
        format,
        detail,
        template,
    })
}
pub fn root(
    tool: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Result<PathBuf, String> {
    let folder = match tool {
        "codex" => ".codex",
        "claude_code" => ".claude",
        "grok" => ".grok",
        "open_code" => ".opencode",
        _ => return Err("此 CLI 没有已核验的 agent 定义".into()),
    };
    if scope == Scope::Project {
        return Ok(project.ok_or("请选择项目")?.join(folder));
    }
    Ok(selection::config_root(tool, || {
        let variable = match tool {
            "codex" => "CODEX_HOME",
            "claude_code" => "CLAUDE_CONFIG_DIR",
            "grok" => "GROK_HOME",
            _ => "OPENCODE_CONFIG_DIR",
        };
        std::env::var_os(variable)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if tool == "open_code" {
                    std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"))
                        .join("opencode")
                } else {
                    home.join(folder)
                }
            })
    }))
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn string(value: &Value, key: &str, required: bool) -> Result<(), String> {
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
    let required_name = tool != "open_code";
    string(&value, "name", required_name)?;
    string(&value, "description", tool != "open_code")?;
    string(&value, "model", false)?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .trim();
    if !valid_name(name) && !(tool == "open_code" && name.split('/').all(valid_name)) {
        return Err("名称只能包含字母、数字、连字符和下划线".into());
    }
    if tool == "codex" {
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
    } else if tool == "open_code" {
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
        string(&value, "prompt", false)?;
        for key in ["steps", "maxSteps"] {
            if value
                .get(key)
                .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0))
            {
                return Err(format!("{key} 必须为正整数"));
            }
        }
    } else {
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
    }
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

// Validate the pinned native schema without rewriting source text or dropping keys.
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

/// Claude reserves colons for plugin-scoped identifiers; local frontmatter stays unchanged.
pub fn plugin_identity(
    tool: &str,
    plugin_id: &str,
    agents_root: &Path,
    path: &Path,
    native_name: &str,
) -> String {
    if tool != "claude_code" {
        return native_name.into();
    }
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
