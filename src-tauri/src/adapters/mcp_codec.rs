//! Default codec for the common MCP vocabulary. Adapters with other schemas
//! override mcp_decode / mcp_entry_view; services never select by concrete ID.
use std::collections::BTreeMap;
use serde::Serialize;
use serde_json::Value;
use crate::resources::mcp::{McpDraft, McpTransport};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedMcp {
    pub draft: McpDraft,
    pub unmapped_fields: Vec<String>,
}

pub fn decode(name: &str, entry: &Value) -> Result<DecodedMcp, String> {
    let object = entry.as_object().ok_or("MCP 条目必须是对象")?;
    let strings = |value: Option<&Value>| -> Result<Vec<String>, String> {
        value.map_or(Ok(Vec::new()), |v| v.as_array().ok_or("MCP 参数必须是数组".into()).and_then(|a| a.iter().map(|v| v.as_str().map(str::to_owned).ok_or("MCP 参数必须是字符串".into())).collect()))
    };
    let map = |value: Option<&Value>| -> Result<BTreeMap<String, String>, String> {
        value.map_or(Ok(BTreeMap::new()), |v| v.as_object().ok_or("MCP 变量必须是对象".into()).and_then(|m| m.iter().map(|(k,v)| v.as_str().map(|v|(k.clone(),v.into())).ok_or("MCP 变量值必须是字符串".into())).collect()))
    };
    let (command, args) = match object.get("command") {
        Some(Value::String(c)) => (c.clone(), strings(object.get("args"))?),
        Some(v @ Value::Array(_)) => { let mut parts = strings(Some(v))?.into_iter(); (parts.next().unwrap_or_default(), parts.collect()) },
        None => (String::new(), Vec::new()),
        _ => return Err("MCP 命令必须是字符串或字符串数组".into()),
    };
    let url = object.get("url").map_or(Ok(""), |v| v.as_str().ok_or("MCP URL 必须是字符串"))?.to_owned();
    let mut unmapped_fields: Vec<String> = object.keys().filter(|key| !["command","args","url","env","environment","headers","http_headers","type","transport","enabled","disabled"].contains(&key.as_str())).cloned().collect();
    for key in ["type", "transport"] {
        if let Some(value) = object.get(key) {
            if !matches!(value.as_str(), Some("stdio" | "http" | "streamable-http" | "local" | "remote")) { unmapped_fields.push(key.into()); }
            else if matches!(value.as_str(), Some("http" | "streamable-http" | "remote")) == url.is_empty() { unmapped_fields.push(format!("{key}/transport mismatch")); }
        }
    }
    if object.get("enabled") == Some(&Value::Bool(false)) || object.get("disabled") == Some(&Value::Bool(true)) { unmapped_fields.push("disabled state".into()); }
    for key in ["enabled", "disabled"] { if object.get(key).is_some_and(|v| !v.is_boolean()) { unmapped_fields.push(key.into()); } }
    if object.get("command").is_some_and(Value::is_array) && object.contains_key("args") { unmapped_fields.push("args beside command array".into()); }
    if !url.is_empty() && (object.contains_key("command") || object.contains_key("args") || object.contains_key("env") || object.contains_key("environment")) { unmapped_fields.push("mixed transport fields".into()); }
    if url.is_empty() && (object.contains_key("headers") || object.contains_key("http_headers")) { unmapped_fields.push("HTTP headers on stdio".into()); }
    if object.contains_key("env") && object.contains_key("environment") { unmapped_fields.push("duplicate environment mappings".into()); }
    if object.contains_key("headers") && object.contains_key("http_headers") { unmapped_fields.push("duplicate header mappings".into()); }
    Ok(DecodedMcp { draft: McpDraft { id: None, name: name.into(), transport: if url.is_empty() { McpTransport::Stdio } else { McpTransport::Http }, command, args, url, env: map(object.get("env").or_else(|| object.get("environment")))?, headers: map(object.get("headers").or_else(|| object.get("http_headers")))?, in_library: true, expected_version: None }, unmapped_fields })
}
