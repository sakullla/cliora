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
        if transport == "sse" {
            return Err(format!("MCP「{name}」是旧版 HTTP+SSE，此远程文档没有已确认的映射，未写入"));
        }
        if transport == "http" {
            if let Some(url) = item.get("url").and_then(serde_json::Value::as_str).filter(|url| !url.trim().is_empty()) {
                server.insert("url", toml_edit::value(url));
            }
        } else if let Some(command) = item.get("command").and_then(serde_json::Value::as_str).filter(|command| !command.trim().is_empty()) {
            server.insert("command", toml_edit::value(command));
        }
        if transport != "http" {
            if let Some(cwd) = item.get("cwd").and_then(serde_json::Value::as_str).filter(|cwd| !cwd.is_empty()) {
                server.insert("cwd", toml_edit::value(cwd));
            }
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
        let transport = if url.is_empty() { "stdio" } else if declares_sse(table.and_then(|item| item.get("type")).and_then(toml::Value::as_str).or_else(|| table.and_then(|item| item.get("transport")).and_then(toml::Value::as_str))) { "sse" } else { "http" };
        let cwd = table.and_then(|item| item.get("cwd")).and_then(toml::Value::as_str).unwrap_or_default();
        let enabled = table.and_then(|item| item.get("enabled")).and_then(toml::Value::as_bool).unwrap_or(true);
        let env = toml_string_map(table.and_then(|item| item.get("env")));
        let headers = toml_string_map(table.and_then(|item| item.get("headers")));
        serde_json::json!({"name": name, "transport": transport, "cwd": cwd, "command": command, "args": args, "url": url, "env": env, "headers": headers, "inLibrary": false, "enabled": enabled, "protectedValues": false})
    }).collect()
}

pub(crate) fn mcp_entries_from_json(document: &serde_json::Value, root: &str, nested: bool) -> Vec<serde_json::Value> {
    let servers = if nested { document.get("mcp").and_then(|value| value.get(root)) } else { document.get(root) };
    servers.and_then(serde_json::Value::as_object).into_iter().flatten().map(|(name, server)| {
        let declared = server.get("type").or_else(|| server.get("transport")).and_then(serde_json::Value::as_str);
        let transport = if server.get("url").and_then(serde_json::Value::as_str).is_none() { "stdio" } else if declares_sse(declared) { "sse" } else { "http" };
        serde_json::json!({
            "name": name,
            "transport": transport,
            "cwd": server.get("cwd").and_then(serde_json::Value::as_str).unwrap_or_default(),
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

/// A remote `type`/`transport` spelling that names legacy HTTP+SSE.
fn declares_sse(kind: Option<&str>) -> bool { kind.is_some_and(|kind| kind.eq_ignore_ascii_case("sse")) }

/// Refuse to rebuild a remote document that would silently lose a field the
/// adapter has not verified: a non-empty `cwd`, or legacy SSE rewritten as
/// Streamable HTTP. Callers pass the adapter's declared capabilities.
pub(crate) fn reject_unsupported_fields(value: &serde_json::Value, supports_cwd: bool, supports_sse: bool) -> Result<(), String> {
    for item in value.get("entries").and_then(serde_json::Value::as_array).into_iter().flatten() {
        let name = item.get("name").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !supports_cwd && item.get("cwd").and_then(serde_json::Value::as_str).is_some_and(|cwd| !cwd.is_empty()) {
            return Err(format!("MCP「{name}」含工作目录（cwd），此 CLI 没有已确认的映射，未写入"));
        }
        if !supports_sse && item.get("transport").and_then(serde_json::Value::as_str) == Some("sse") {
            return Err(format!("MCP「{name}」是旧版 HTTP+SSE，此 CLI 没有已确认的映射，未改写为 Streamable HTTP，未写入"));
        }
    }
    Ok(())
}

pub(crate) fn render_json_mcp(config_text: &str, value: &serde_json::Value, root: &str, nested: bool) -> Result<Vec<u8>, String> {
    render_json_mcp_styled(config_text, value, root, nested, false)
}

/// `typed` adapters spell the transport in a `type` field (`stdio`, `sse`, and
/// `streamable-http`, keeping an `http` spelling already on disk). Untyped
/// documents have no sse spelling, so an sse entry is an error, not an http one.
pub(crate) fn render_json_mcp_styled(config_text: &str, value: &serde_json::Value, root: &str, nested: bool, typed: bool) -> Result<Vec<u8>, String> {
    let mut document = if config_text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str::<serde_json::Value>(config_text).map_err(|error| format_error(format!("远程配置不是 JSON 对象：{error}")))?
    };
    let entries = value.get("entries").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let on_disk = if nested { document.get("mcp").and_then(|child| child.get(root)) } else { document.get(root) }.cloned();
    let mut servers = serde_json::Map::new();
    for item in entries {
        let Some(name) = item.get("name").and_then(serde_json::Value::as_str).filter(|name| valid_text(name, 160)) else { continue; };
        let mut server = serde_json::Map::new();
        let transport = item.get("transport").and_then(serde_json::Value::as_str);
        if transport == Some("sse") && !typed {
            return Err(format!("MCP「{name}」是旧版 HTTP+SSE，此远程文档没有已确认的映射，未写入"));
        }
        if matches!(transport, Some("http" | "sse")) {
            if typed {
                let kind = if transport == Some("sse") { "sse" } else {
                    on_disk.as_ref().and_then(|servers| servers.get(name)).and_then(|entry| entry.get("type")).and_then(serde_json::Value::as_str)
                        .filter(|kind| matches!(*kind, "http" | "streamable-http")).unwrap_or("streamable-http")
                };
                server.insert("type".into(), serde_json::Value::String(kind.into()));
            }
            if let Some(url) = item.get("url").and_then(serde_json::Value::as_str) { server.insert("url".into(), serde_json::Value::String(url.into())); }
            if let Some(headers) = item.get("headers").and_then(serde_json::Value::as_object) { server.insert("headers".into(), serde_json::Value::Object(headers.clone())); }
        } else {
            if typed { server.insert("type".into(), serde_json::Value::String("stdio".into())); }
            if let Some(cwd) = item.get("cwd").and_then(serde_json::Value::as_str).filter(|cwd| !cwd.is_empty()) { server.insert("cwd".into(), serde_json::Value::String(cwd.into())); }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn layout(format: &'static str, table: &'static str) -> super::super::RemoteMcpLayout {
        super::super::RemoteMcpLayout { relative: "x", format, table, nested: false }
    }

    #[test]
    fn parse_reads_cwd_and_distinguishes_sse_from_streamable_http() {
        let text = r#"{"mcpServers":{
            "a":{"command":"node","cwd":"/srv/app"},
            "b":{"type":"sse","url":"https://example.test/sse"},
            "c":{"type":"streamable-http","url":"https://example.test/mcp"},
            "d":{"url":"https://example.test/mcp"}}}"#;
        let parsed = parse(layout("json", "mcpServers"), text).unwrap();
        let entries = parsed["entries"].as_array().unwrap();
        assert_eq!(entries[0]["cwd"], "/srv/app");
        assert_eq!(entries[1]["transport"], "sse");
        assert_eq!(entries[2]["transport"], "http");
        assert_eq!(entries[3]["transport"], "http");
        let toml = parse(layout("toml", "mcp_servers"), "[mcp_servers.a]\ncommand=\"x\"\ncwd=\"/w\"\n[mcp_servers.b]\nurl=\"https://e.test\"\ntype=\"sse\"\n").unwrap();
        assert_eq!(toml["entries"][0]["cwd"], "/w");
        assert_eq!(toml["entries"][1]["transport"], "sse");
    }

    #[test]
    fn render_keeps_cwd_and_refuses_to_flatten_sse_into_http() {
        let value = json!({"entries":[{"name":"a","transport":"stdio","command":"node","cwd":"/srv/app"}]});
        let json_out = String::from_utf8(render_json_mcp("{}", &value, "mcpServers", false).unwrap()).unwrap();
        assert!(json_out.contains("\"cwd\": \"/srv/app\""));
        let toml_out = String::from_utf8(render_toml_mcp_table("", &value, "mcp_servers").unwrap()).unwrap();
        assert!(toml_out.contains("cwd = \"/srv/app\""));
        let sse = json!({"entries":[{"name":"b","transport":"sse","url":"https://example.test/sse"}]});
        assert!(render_json_mcp("{}", &sse, "mcpServers", false).unwrap_err().contains("HTTP+SSE"));
        assert!(render_toml_mcp_table("", &sse, "mcp_servers").is_err());
    }

    #[test]
    fn typed_rendering_maps_sse_and_keeps_an_http_spelling_on_disk() {
        let existing = r#"{"mcpServers":{"h":{"type":"http","url":"https://old.test"}}}"#;
        let value = json!({"entries":[
            {"name":"h","transport":"http","url":"https://example.test/mcp"},
            {"name":"n","transport":"http","url":"https://example.test/new"},
            {"name":"s","transport":"sse","url":"https://example.test/sse"},
            {"name":"c","transport":"stdio","command":"node","cwd":"/w"}]});
        let out: serde_json::Value = serde_json::from_slice(&render_json_mcp_styled(existing, &value, "mcpServers", false, true).unwrap()).unwrap();
        assert_eq!(out["mcpServers"]["h"]["type"], "http");
        assert_eq!(out["mcpServers"]["n"]["type"], "streamable-http");
        assert_eq!(out["mcpServers"]["s"]["type"], "sse");
        assert_eq!(out["mcpServers"]["c"]["type"], "stdio");
        assert_eq!(out["mcpServers"]["c"]["cwd"], "/w");
    }

    #[test]
    fn unsupported_cwd_or_sse_is_rejected_by_name_and_clearing_cwd_passes() {
        let cwd = json!({"entries":[{"name":"a","transport":"stdio","command":"node","cwd":"/w"}]});
        assert!(reject_unsupported_fields(&cwd, false, false).unwrap_err().contains("「a」"));
        assert!(reject_unsupported_fields(&cwd, true, false).is_ok());
        let sse = json!({"entries":[{"name":"b","transport":"sse","url":"https://e.test"}]});
        assert!(reject_unsupported_fields(&sse, true, false).unwrap_err().contains("「b」"));
        assert!(reject_unsupported_fields(&sse, false, true).is_ok());
        let cleared = json!({"entries":[{"name":"a","transport":"stdio","command":"node","cwd":""}]});
        assert!(reject_unsupported_fields(&cleared, false, false).is_ok());
    }

    #[test]
    fn minimax_remote_adapter_uses_the_typed_mapping_and_others_refuse_sse() {
        let registry = crate::adapters::Registry::builtins();
        let sse = json!({"entries":[{"name":"s","transport":"sse","url":"https://example.test/sse"}]});
        let out = registry.get("minimax_code").unwrap().render_remote_mcp("{}", &sse).unwrap();
        assert!(String::from_utf8(out).unwrap().contains("\"type\": \"sse\""));
        assert!(registry.get("claude_code").unwrap().render_remote_mcp("{}", &sse).is_err());
        assert!(registry.get("cursor").unwrap().render_remote_mcp("{}", &sse).is_err());
    }
}
