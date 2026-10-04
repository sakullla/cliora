//! Cordis profile patches are a sequence. `insert` appends an entry list;
//! entry `name` is the module name, not `package` (dsh-app-boot 0.2.0-rc.2).
use serde_json::{Map, Value};
use crate::native::transaction::FieldChange;

const MODULE: &str = "@deepseek-ai/dsh-mcp-client";

pub(super) fn rows(parsed: &Value) -> Result<&[Value], String> {
    if parsed.as_object().is_some_and(Map::is_empty) { return Ok(&[]); }
    let rows = parsed.as_array().ok_or("dsh 配置应为 YAML 补丁列表，请检查原生配置")?;
    if rows.iter().any(|row| !row.is_object() || row.get("insert").is_some_and(|v| !v.is_array())) {
        return Err("dsh 补丁或 insert 列表格式无法识别".into());
    }
    Ok(rows)
}

pub(super) fn entries(parsed: &Value) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    for row in rows(parsed)? {
        if let Some(insert) = row.get("insert").and_then(Value::as_array) {
            for entry in insert {
                if entry.get("name").and_then(Value::as_str) != Some(MODULE) { continue; }
                let name = entry.pointer("/config/serverName").and_then(Value::as_str)
                    .ok_or("dsh MCP 缺少 serverName")?;
                if result.insert(name.into(), entry.clone()).is_some() {
                    return Err("dsh MCP 名称重复，请先在原生配置中处理".into());
                }
            }
        }
    }
    // Applying an unknown override requires the composition graph. Fail
    // explicitly instead of displaying or editing a misleading partial entry.
    for row in rows(parsed)? {
        if row.get("insert").is_none() && result.values().any(|entry| {
            row.get("id").is_some() && row.get("id") == entry.get("id")
        }) { return Err("此 MCP 存在额外的原生覆盖补丁，请在原生配置中管理".into()); }
    }
    Ok(result)
}

pub(super) fn change(parsed: &Value, name: &str, value: Option<Value>) -> Result<FieldChange, String> {
    let _ = entries(parsed)?;
    let rows = rows(parsed)?;
    for (index, row) in rows.iter().enumerate() {
        let Some(insert) = row.get("insert").and_then(Value::as_array) else { continue; };
        if let Some(position) = insert.iter().position(|entry| entry.get("name").and_then(Value::as_str) == Some(MODULE)
            && entry.pointer("/config/serverName").and_then(Value::as_str) == Some(name)) {
            let mut updated = row.clone();
            let items = updated.get_mut("insert").and_then(Value::as_array_mut).unwrap();
            if let Some(value) = value { items[position] = value; } else { items.remove(position); }
            return Ok(FieldChange { path: vec![index.to_string()], value: Some(updated) });
        }
    }
    Ok(FieldChange { path: vec![rows.len().to_string()], value: value.map(|entry| serde_json::json!({"insert": [entry]})) })
}
