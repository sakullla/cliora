use super::{paths, MiniMaxCode};
use crate::{
    adapters::{CliAdapter, McpLocation},
    native::{adapter::Scope, format::FileKind, transaction::FieldChange},
    resources::mcp::{self, McpDefinition, McpTransport},
};
use serde_json::{json, Value};
use std::path::Path;
pub(super) fn location(scope: Scope, home: &Path, project: Option<&Path>) -> Option<McpLocation> {
    Some(McpLocation {
        path: match scope {
            Scope::Global => paths::root(home).ok()?.join("mcp.json"),
            Scope::Project => project?.join(".mcp.json"),
        },
        kind: FileKind::Json,
        root: "mcpServers",
        child: None,
    })
}
pub(super) fn entries(root: &Value) -> Result<serde_json::Map<String, Value>, String> {
    if !root.is_object() {
        return Err("MiniMax MCP 根必须是对象".into());
    }
    root.get("mcpServers").map_or_else(
        || Ok(serde_json::Map::new()),
        |v| {
            v.as_object()
                .cloned()
                .ok_or("MiniMax mcpServers 必须是对象".into())
        },
    )
}
fn reserved(name: &str) -> bool {
    [
        "matrix",
        "nd",
        "cu",
        "__proto__",
        "constructor",
        "prototype",
    ]
    .contains(&name)
}
pub(super) fn decode(
    name: &str,
    entry: &Value,
) -> Result<crate::adapters::mcp_codec::DecodedMcp, String> {
    let map = entry.as_object().ok_or("MiniMax MCP 条目必须是对象")?;
    if map.get("command").is_some_and(|v| !v.is_string()) {
        return Err("MiniMax MCP command 必须是字符串".into());
    }
    if map.get("type").is_some_and(|v| {
        !matches!(
            v.as_str(),
            Some("stdio" | "http" | "streamable-http" | "sse")
        )
    }) {
        return Err("MiniMax MCP type 无效".into());
    }
    for field in ["disabled", "environment", "http_headers", "transport"] {
        if map.contains_key(field) {
            return Err(format!("MiniMax 不读取 MCP 字段 {field}，请使用原生字段"));
        }
    }
    for field in ["configured", "builtin"] {
        if map.get(field).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("MiniMax {field} 必须是布尔值"));
        }
    }
    if map
        .get("timeout")
        .is_some_and(|v| !v.as_u64().is_some_and(|n| n > 0))
    {
        return Err("MiniMax MCP timeout 必须是正整数".into());
    }
    let mut normalized = entry.clone();
    let mut product_fields = Vec::new();
    for (field, benign) in [
        ("configured", Value::Bool(true)),
        ("builtin", Value::Bool(false)),
    ] {
        if normalized.get(field) == Some(&benign) {
            normalized.as_object_mut().unwrap().remove(field);
        } else if normalized.get(field).is_some() {
            product_fields.push(field.into());
        }
    }
    let mut result = crate::adapters::mcp_codec::decode(name, &normalized)?;
    if entry["configured"] == false {
        result.enabled = false;
    }
    result.unmapped_fields.extend(product_fields);
    if reserved(name) {
        result.unmapped_fields.push("product-owned server".into());
    }
    Ok(result)
}
pub(super) fn is_reference(value: &str) -> bool {
    let value = value.strip_prefix("Bearer ").unwrap_or(value);
    let Some(inner) = value.strip_prefix("${").and_then(|s| s.strip_suffix('}')) else {
        return false;
    };
    let (name, fallback) = inner
        .split_once(":-")
        .map_or((inner, None), |(name, v)| (name, Some(v)));
    let mut chars = name.bytes();
    chars
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && chars.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && fallback.is_none_or(|v| !v.contains('}'))
}
pub(super) fn document(
    adapter: &MiniMaxCode,
    definition: &McpDefinition,
    enabled: bool,
    existing: Option<&Value>,
    location: &McpLocation,
) -> Result<Option<Value>, String> {
    if reserved(&definition.name) || existing.is_some_and(|v| v["builtin"] == true) {
        return Err("MiniMax 内置 MCP 由客户端管理，不能覆盖或停用".into());
    }
    let project = location.path.file_name().is_some_and(|v| v == ".mcp.json");
    let reference = |value: &str| project && adapter.mcp_is_reference(value);
    let mut map = match definition.transport {
        McpTransport::Stdio => {
            mcp::stdio_doc_with_reference(definition, existing, "env", &reference)
        }
        McpTransport::Http => {
            mcp::http_doc_with_reference(definition, existing, "headers", &reference)
        }
    };
    map.insert("enabled".into(), json!(enabled));
    if !project {
        map.insert("configured".into(), json!(true));
        map.insert("builtin".into(), json!(false));
    }
    map.insert(
        "type".into(),
        json!(if definition.transport == McpTransport::Stdio {
            "stdio"
        } else {
            "http"
        }),
    );
    Ok(Some(Value::Object(map)))
}
pub(super) fn change(
    root: &Value,
    name: &str,
    value: Option<Value>,
) -> Result<FieldChange, String> {
    let original = root.get("mcpServers").and_then(|v| v.get(name));
    if reserved(name)
        || original.is_some_and(|v| v["builtin"] == true)
        || value.as_ref().is_some_and(|v| v["builtin"] == true)
    {
        return Err("MiniMax 内置 MCP 为产品自管，只读浏览".into());
    }
    if value
        .as_ref()
        .is_some_and(|v| v.get("auth") != original.and_then(|v| v.get("auth")))
    {
        return Err("MiniMax MCP OAuth/auth 状态由原生客户端管理，不能通过配置文本写入".into());
    }
    Ok(FieldChange {
        path: vec!["mcpServers".into(), name.into()],
        value,
    })
}
