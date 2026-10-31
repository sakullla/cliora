//! Adapter package codecs for remote MCP documents. Shared services transport
//! normalized data and do not know any concrete CLI paths or schemas.
fn valid_text(value: &str, max: usize) -> bool { !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control) }
fn format_error(message: String) -> String { message }
pub(crate) fn render_toml_mcp_table(config_text: &str, value: &serde_json::Value, table: &str) -> Result<Vec<u8>, String> {
    let mut document: toml_edit::DocumentMut = if config_text.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        config_text.parse().map_err(|error| format_error(format!("远程配置不是 TOML 表：{error}")))?
    };
    let mut servers = toml_edit::Table::new();
    let mut count = 0usize;
    for item in value.get("entries").and_then(serde_json::Value::as_array).into_iter().flatten() {
        let Some(name) = item.get("name").and_then(serde_json::Value::as_str).filter(|name| valid_text(name, 160)) else { continue; };
        let mut server = toml_edit::Table::new();
        let transport = item.get("transport").and_then(serde_json::Value::as_str).unwrap_or("stdio");
        if transport == "http" {
            if let Some(url) = item.get("url").and_then(serde_json::Value::as_str).filter(|url| !url.trim().is_empty()) {
                server.insert("url", toml_edit::value(url));
            }
        } else if let Some(command) = item.get("command").and_then(serde_json::Value::as_str).filter(|command| !command.trim().is_empty()) {
            server.insert("command", toml_edit::value(command));
        }
        if transport != "http" {
            if let Some(args) = item.get("args").and_then(serde_json::Value::as_array) {
                let mut array = toml_edit::Array::new();
                for arg in args.iter().filter_map(serde_json::Value::as_str) { array.push(arg); }
                if !array.is_empty() { server.insert("args", toml_edit::Item::Value(toml_edit::Value::Array(array))); }
            }
            if let Some(env) = toml_string_table(item.get("env")) { server.insert("env", toml_edit::Item::Table(env)); }
        } else if let Some(headers) = toml_string_table(item.get("headers")) {
            server.insert("headers", toml_edit::Item::Table(headers));
        }
        if item.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) { server.insert("enabled", toml_edit::value(false)); }
        servers.insert(name, toml_edit::Item::Table(server));
        count += 1;
    }
    if count == 0 { document.remove(table); } else { document.insert(table, toml_edit::Item::Table(servers)); }
    Ok(document.to_string().into_bytes())
}

pub(crate) fn toml_string_table(value: Option<&serde_json::Value>) -> Option<toml_edit::Table> {
    let object = value?.as_object()?;
    let mut table = toml_edit::Table::new();
    for (key, item) in object {
        let Some(text) = item.as_str().filter(|_| valid_text(key, 160)) else { continue; };
        table.insert(key, toml_edit::value(text));
    }
    (!table.is_empty()).then_some(table)
}

pub(crate) fn mcp_entries_from_toml(document: &toml::Value, table: &str) -> Vec<serde_json::Value> {
    let Some(servers) = document.get(table).and_then(toml::Value::as_table) else { return Vec::new(); };
    servers.iter().map(|(name, value)| {
        let table = value.as_table();
        let command = table.and_then(|item| item.get("command")).and_then(toml::Value::as_str).unwrap_or_default();
        let args = table.and_then(|item| item.get("args")).and_then(toml::Value::as_array).map(|items| items.iter().filter_map(toml::Value::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
        let url = table.and_then(|item| item.get("url")).and_then(toml::Value::as_str).unwrap_or_default();
        let transport = if url.is_empty() { "stdio" } else { "http" };
        let enabled = table.and_then(|item| item.get("enabled")).and_then(toml::Value::as_bool).unwrap_or(true);
        let env = toml_string_map(table.and_then(|item| item.get("env")));
        let headers = toml_string_map(table.and_then(|item| item.get("headers")));
        serde_json::json!({"name": name, "transport": transport, "command": command, "args": args, "url": url, "env": env, "headers": headers, "inLibrary": false, "enabled": enabled, "protectedValues": false})
    }).collect()
}

pub(crate) fn mcp_entries_from_json(document: &serde_json::Value, root: &str, nested: bool) -> Vec<serde_json::Value> {
    let servers = if nested { document.get("mcp").and_then(|value| value.get(root)) } else { document.get(root) };
    servers.and_then(serde_json::Value::as_object).into_iter().flatten().map(|(name, server)| {
        let transport = if server.get("url").and_then(serde_json::Value::as_str).is_some() { "http" } else { "stdio" };
        serde_json::json!({
            "name": name,
            "transport": transport,
            "command": server.get("command").and_then(serde_json::Value::as_str).unwrap_or_default(),
            "args": server.get("args").cloned().unwrap_or_else(|| serde_json::json!([])),
            "url": server.get("url").and_then(serde_json::Value::as_str).unwrap_or_default(),
            "env": server.get("env").cloned().unwrap_or_else(|| serde_json::json!({})),
            "headers": server.get("headers").cloned().unwrap_or_else(|| serde_json::json!({})),
            "inLibrary": false,
            "enabled": server.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true),
            "protectedValues": false
        })
    }).collect()
}

pub(crate) fn toml_string_map(value: Option<&toml::Value>) -> serde_json::Value {
    let Some(table) = value.and_then(toml::Value::as_table) else { return serde_json::json!({}); };
    let mut map = serde_json::Map::new();
    for (key, item) in table {
        if let Some(text) = item.as_str() { map.insert(key.clone(), serde_json::Value::String(text.to_owned())); }
    }
    serde_json::Value::Object(map)
}

pub(crate) fn render_json_mcp(config_text: &str, value: &serde_json::Value, root: &str, nested: bool) -> Result<Vec<u8>, String> {
    let mut document = if config_text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str::<serde_json::Value>(&config_text).map_err(|error| format_error(format!("远程配置不是 JSON 对象：{error}")))?
    };
    let entries = value.get("entries").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let mut servers = serde_json::Map::new();
    for item in entries {
        let Some(name) = item.get("name").and_then(serde_json::Value::as_str).filter(|name| valid_text(name, 160)) else { continue; };
        let mut server = serde_json::Map::new();
        if item.get("transport").and_then(serde_json::Value::as_str) == Some("http") {
            if let Some(url) = item.get("url").and_then(serde_json::Value::as_str) { server.insert("url".into(), serde_json::Value::String(url.into())); }
            if let Some(headers) = item.get("headers").and_then(serde_json::Value::as_object) { server.insert("headers".into(), serde_json::Value::Object(headers.clone())); }
        } else {
            if let Some(command) = item.get("command").and_then(serde_json::Value::as_str) { server.insert("command".into(), serde_json::Value::String(command.into())); }
            if let Some(args) = item.get("args").and_then(serde_json::Value::as_array) { server.insert("args".into(), serde_json::Value::Array(args.clone())); }
            if let Some(env) = item.get("env").and_then(serde_json::Value::as_object) { server.insert("env".into(), serde_json::Value::Object(env.clone())); }
        }
        if item.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) { server.insert("enabled".into(), serde_json::Value::Bool(false)); }
        servers.insert(name.into(), serde_json::Value::Object(server));
    }
    let target_value = if nested {
        let object = document.as_object_mut().ok_or_else(|| format_error("远程配置不是 JSON 对象".into()))?;
        let child = object.entry("mcp").or_insert_with(|| serde_json::json!({}));
        child.as_object_mut().ok_or_else(|| format_error("远程 MCP 配置格式无效".into()))?.insert(root.into(), serde_json::Value::Object(servers));
        document
    } else {
        let object = document.as_object_mut().ok_or_else(|| format_error("远程配置不是 JSON 对象".into()))?;
        object.insert(root.into(), serde_json::Value::Object(servers));
        document
    };
    serde_json::to_vec_pretty(&target_value).map_err(|error| error.to_string())

}

pub fn parse(layout: super::RemoteMcpLayout, text: &str) -> Result<serde_json::Value, String> {
    let entries = if layout.format == "toml" {
        let document = toml::from_str(text).map_err(|e| format!("远程 MCP TOML 无效：{e}"))?;
        mcp_entries_from_toml(&document, layout.table)
    } else if layout.format == "json" {
        let document = serde_json::from_str(text).map_err(|e| format!("远程 MCP JSON 无效：{e}"))?;
        mcp_entries_from_json(&document, layout.table, layout.nested)
    } else { return Err("适配器未声明此 MCP 文档格式".into()); };
    Ok(serde_json::json!({ "entries": entries, "definitions": [] }))
}
pub fn render(layout: super::RemoteMcpLayout, text: &str, value: &serde_json::Value) -> Result<Vec<u8>, String> {
    match layout.format {
        "toml" => render_toml_mcp_table(text, value, layout.table),
        "json" => render_json_mcp(text, value, layout.table, layout.nested),
        _ => Err("适配器未声明此 MCP 文档格式".into()),
    }
}
