//! Shared remote target and transport primitives.
//!
//! Remote support deliberately uses the user's OpenSSH installation instead of
//! embedding an SSH implementation. The adapter layer can build on these
//! target/project records without creating per-CLI SSH branches.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::collections::BTreeMap;
use std::collections::HashSet;

use base64::Engine;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::database::Database;
use crate::native::profile::{RegisteredCommon, RegisteredProfile};

pub mod password;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteToolStore {
    #[serde(default)]
    pub profiles: Vec<RegisteredProfile>,
    pub common: Option<RegisteredCommon>,
    #[serde(default)]
    pub current_files: BTreeMap<String, String>,
}

/// Remote resource data is kept on the target host.  The value is deliberately
/// opaque here: each adapter/resource UI owns its schema, while the SSH layer
/// only provides atomic JSON read/write and never falls back to the local DB.
pub fn load_resource_store(target: &RemoteTarget, tool_id: &str, kind: &str) -> Result<serde_json::Value, RemoteError> {
    if !valid_text(tool_id, 120) || !valid_text(kind, 80) || !tool_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) || !kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        return Err(RemoteError::InvalidPath);
    }
    // MCP shown as "当前生效" is whatever the CLI config contains. The Cliora
    // JSON file can remember library membership, but a stale copy must not
    // invent servers the native file does not have.
    if kind == "mcp" {
        let bundle = load_resource_stores(target, &[tool_id.to_owned()], "mcp")?;
        return bundle
            .get("stores")
            .and_then(|stores| stores.get(tool_id))
            .cloned()
            .ok_or_else(|| RemoteError::Storage("远程 MCP 读取结果无效".into()));
    }
    let path = format!("$HOME/.cliora/resources/{tool_id}/{kind}.json");
    let result = run_command(target, &format!("if [ -f {path} ]; then cat {path}; else printf '%s' '{{}}'; fi"))?;
    let stored: serde_json::Value = serde_json::from_str(&result.stdout).map_err(|error| RemoteError::Storage(format!("远程资源格式无效：{error}")))?;
    if stored != serde_json::json!({}) { return Ok(stored); }
    if kind == "skills" {
        return seed_remote_skills(target, tool_id);
    }
    if kind == "agents" {
        return seed_remote_agents(target, tool_id);
    }
    if kind == "plugins" {
        return seed_remote_plugins(target, tool_id);
    }
    Ok(stored)
}

/// Read every managed CLI's resource file in one SSH command.
///
/// The library page used to open one connection per CLI. On Windows those
/// connections share a gate of two, so the rest waited out and the page
/// failed with "远程连接正忙". MCP entries come from the native config in
/// that same command. Skills still keep a saved store, and an empty `{}`
/// is seeded from SKILL.md files.
pub fn load_resource_stores(target: &RemoteTarget, tool_ids: &[String], kind: &str) -> Result<serde_json::Value, RemoteError> {
    if !valid_resource_token(kind, 80) || !matches!(kind, "mcp" | "skills") {
        return Err(RemoteError::InvalidPath);
    }
    let mut accepted = Vec::new();
    for tool_id in tool_ids {
        if !valid_resource_token(tool_id, 120) {
            return Err(RemoteError::InvalidPath);
        }
        if !accepted.iter().any(|existing: &String| existing == tool_id) {
            accepted.push(tool_id.clone());
        }
    }
    if accepted.len() > 64 {
        return Err(RemoteError::Storage("一次最多读取 64 个 CLI 的远程资料".into()));
    }
    let mut stores = serde_json::Map::new();
    for group in bundle_groups(&accepted, kind) {
        let script = resource_bundle_script(&group, kind);
        let output = run_command(target, &script)?;
        if output.stdout.len() > 16 * 1024 * 1024 {
            return Err(RemoteError::Transport { stage: "remote_command", detail: "远程资源超出读取上限".into() });
        }
        let parsed = parse_resource_bundle(kind, &group, &output.stdout);
        if let Some(object) = parsed.get("stores").and_then(serde_json::Value::as_object) {
            for (tool_id, value) in object {
                stores.insert(tool_id.clone(), value.clone());
            }
        }
    }
    Ok(serde_json::json!({ "stores": stores }))
}

struct SkillScanRoot {
    relative: String,
    read_only: bool,
    detail: String,
}

fn safe_home_relative(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.starts_with('/')
        && !relative.contains("..")
        && relative.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-'))
}

fn remote_skill_roots(tool_id: &str) -> Vec<SkillScanRoot> {
    if let Some(cli) = crate::adapters::Registry::builtins().get(tool_id) {
        let declared = cli.remote_skill_directories();
        if !declared.is_empty() {
            return declared
                .iter()
                .filter(|item| safe_home_relative(item.relative))
                .map(|item| SkillScanRoot { relative: item.relative.to_owned(), read_only: item.read_only, detail: item.detail.to_owned() })
                .collect();
        }
    }
    let relative = if tool_id == "grok" { ".grok/skills" } else { ".codex/skills" };
    vec![SkillScanRoot { relative: relative.into(), read_only: true, detail: "远程主机目录".into() }]
}

/// The longest declared root wins, so `.codex/skills/.system` stays bundled
/// instead of being treated as a writable skill under `.codex/skills`.
fn skill_root_index(path: &str, roots: &[SkillScanRoot]) -> usize {
    roots
        .iter()
        .enumerate()
        .filter(|(_, root)| path.contains(&format!("/{}/", root.relative)))
        .max_by_key(|(_, root)| root.relative.len())
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn skill_description(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return String::new(); };
    let Some(end) = rest.find("\n---") else { return String::new(); };
    rest[..end]
        .lines()
        .find_map(|line| line.strip_prefix("description:"))
        .map(|value| value.trim().trim_matches(['"', '\'']).to_owned())
        .unwrap_or_default()
}

fn seed_remote_skills(target: &RemoteTarget, tool_id: &str) -> Result<serde_json::Value, RemoteError> {
    let roots = remote_skill_roots(tool_id);
    if roots.is_empty() {
        return Ok(serde_json::json!({"entries": [], "documents": {}}));
    }
    let mut script = String::new();
    for (index, root) in roots.iter().enumerate() {
        let dir = format!("$HOME/{}", root.relative);
        script.push_str(&format!("if [ -d {dir} ]; then find {dir} -mindepth 2 -maxdepth 2 -type f -name SKILL.md -print | while IFS= read -r file; do printf '%s\\n' '__CLIORA_ROOT_{index}' \"$file\"; done; fi; "));
    }
    let found = if script.is_empty() { String::new() } else { run_command(target, &script)?.stdout };
    let mut located = Vec::new();
    let mut lines = found.lines().map(str::trim).filter(|line| !line.is_empty());
    while let Some(marker) = lines.next() {
        let Some(path) = lines.next() else { break; };
        if !path.starts_with('/') || path.contains("..") || !path.ends_with("/SKILL.md") { continue; }
        let index = marker.strip_prefix("__CLIORA_ROOT_").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
        located.push((index, path.to_owned()));
        if located.len() >= 128 { break; }
    }
    let mut read_script = String::new();
    for (index, (_, path)) in located.iter().enumerate() {
        read_script.push_str("printf '%s\\n' ");
        read_script.push_str(&shell_quote(&format!("__CLIORA_SKILL__{index}")));
        read_script.push_str("; base64 < ");
        read_script.push_str(&shell_quote(path));
        read_script.push_str(" | tr -d '\\n'; printf '\\n'; ");
    }
    let encoded = if read_script.is_empty() { String::new() } else { run_command(target, &read_script)?.stdout };
    let mut encoded_lines = encoded.lines();
    let mut contents = BTreeMap::new();
    for index in 0..located.len() {
        let marker = format!("__CLIORA_SKILL__{index}");
        if encoded_lines.next() != Some(marker.as_str()) { continue; }
        if let Some(value) = encoded_lines.next() {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(value.trim()) {
                if let Ok(text) = String::from_utf8(bytes) { contents.insert(located[index].1.clone(), text); }
            }
        }
    }
    Ok(assemble_skill_store(tool_id, &located, &contents))
}

fn assemble_skill_store(tool_id: &str, located: &[(usize, String)], contents: &BTreeMap<String, String>) -> serde_json::Value {
    let roots = remote_skill_roots(tool_id);
    if roots.is_empty() {
        return serde_json::json!({"entries": [], "documents": {}});
    }
    let mut documents = serde_json::Map::new();
    let entries = located.iter().take(128).map(|(index, path)| {
        let name = path.strip_suffix("/SKILL.md").and_then(|value| value.rsplit('/').next()).unwrap_or(path.as_str());
        let index = if roots.get(*index).is_some() { *index } else { skill_root_index(path, &roots) };
        let root = roots.get(index).unwrap_or(&roots[0]);
        let text = contents.get(path);
        if let Some(text) = text { documents.insert(path.clone(), serde_json::Value::String(text.clone())); }
        let description = text.map(|value| skill_description(value)).unwrap_or_default();
        let detail = if root.read_only {
            if description.is_empty() { root.detail.clone() } else { format!("{} · {description}", root.detail) }
        } else if description.is_empty() { root.detail.clone() } else { description };
        let source = if root.read_only { "read_only" } else { "writable" };
        let state = if root.read_only { "read_only" } else { "external" };
        serde_json::json!({"name": name, "path": path, "digest": null, "state": state, "detail": detail, "packageId": null, "source": source, "pluginName": null, "pluginEnabled": null})
    }).collect::<Vec<_>>();
    serde_json::json!({"entries": entries, "documents": documents})
}

fn seed_remote_agents(target: &RemoteTarget, tool_id: &str) -> Result<serde_json::Value, RemoteError> {
    let capability = match crate::adapters::agents::capability(tool_id) {
        Ok(capability) => capability,
        Err(_) => return Ok(serde_json::json!({})),
    };
    let extension = if capability.format == "toml" { "toml" } else { "md" };
    let mut detail = "来自当前主机的原生定义".to_owned();
    let mut files = Vec::new();
    if let Some(enabled) = remote_agent_root(tool_id, "global", None) {
        let parent = enabled.trim_end_matches('/').trim_end_matches("/agents");
        let disabled = format!("{parent}/.cliora-disabled-agents/agents");
        let enabled_expr = remote_path_expr(&enabled);
        let disabled_expr = remote_path_expr(&disabled);
        let script = format!("for dir in {enabled_expr} {disabled_expr}; do if [ -d \"$dir\" ]; then find \"$dir\" -type f -name '*.{extension}' -print; fi; done");
        match run_command(target, &script) {
            Ok(found) => {
                for path in found.stdout.lines().map(str::trim).filter(|path| !path.is_empty() && path.starts_with('/') && !path.contains("..")) {
                    files.push(path.to_owned());
                    if files.len() >= 80 { break; }
                }
            }
            Err(error) => detail = error.to_string(),
        }
    }
    let mut read_script = String::new();
    for (index, path) in files.iter().enumerate() {
        read_script.push_str("printf '%s\\n' ");
        read_script.push_str(&shell_quote(&format!("__CLIORA_AGENT__{index}")));
        read_script.push_str("; size=$(wc -c < ");
        read_script.push_str(&shell_quote(path));
        read_script.push_str(" | tr -d '[:space:]'); if [ \"$size\" -le 262144 ]; then base64 < ");
        read_script.push_str(&shell_quote(path));
        read_script.push_str(" | tr -d '\\n'; fi; printf '\\n'; ");
    }
    let encoded = if read_script.is_empty() { String::new() } else { run_command(target, &read_script)?.stdout };
    let mut lines = encoded.lines();
    let mut entries = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let marker = format!("__CLIORA_AGENT__{index}");
        if lines.next() != Some(marker.as_str()) { continue; }
        let Some(value) = lines.next() else { continue; };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(value.trim()) else { continue; };
        let Ok(content) = String::from_utf8(bytes) else { continue; };
        let stem = Path::new(path).file_stem().and_then(|stem| stem.to_str()).unwrap_or("agent");
        let enabled = !path.contains("/.cliora-disabled-agents/");
        let format = if extension == "toml" { "toml" } else { "markdown" };
        entries.push(crate::resources::agents::entry(tool_id, Path::new(path), format, content, stem, enabled, "独立定义"));
    }
    let snapshot = crate::resources::agents::AgentSnapshot {
        target: crate::resources::plugins::PluginTarget { tool_id: tool_id.to_owned(), scope: crate::native::adapter::Scope::Global, project_path: None, context_id: None },
        capability,
        entries,
        baseline: "remote".into(),
        detail,
    };
    Ok(serde_json::json!({ "snapshot": snapshot }))
}

fn seed_remote_plugins(target: &RemoteTarget, tool_id: &str) -> Result<serde_json::Value, RemoteError> {
    let registry = crate::adapters::Registry::builtins();
    let Some(cli) = registry.get(tool_id) else { return Ok(serde_json::json!({})) };
    let Some(plugins) = cli.plugins() else { return Ok(serde_json::json!({})) };
    let mut capability = serde_json::to_value(plugins.capability()).map_err(|error| RemoteError::Storage(error.to_string()))?;
    // Remote inventory stays read-only. The page shows the native list, and
    // install/enable still go through the host's own CLI.
    if let Some(object) = capability.as_object_mut() {
        object.insert("actions".into(), serde_json::json!([]));
    }
    let program = cli.command();
    let args = plugins.list_command_args();
    let command_ok = valid_text(program, 80) && args.iter().all(|arg| valid_text(arg, 80) && !arg.contains(' '));
    let mut detail = "来自当前主机的原生插件列表".to_owned();
    let mut entries = Vec::new();
    if command_ok {
        let mut command = program.to_owned();
        for arg in &args {
            command.push(' ');
            command.push_str(arg);
        }
        match command_output(target, &command) {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                if output.status.success() {
                    match serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                        Ok(value) => {
                            let listed = plugins.parse_list(&value, &crate::resources::plugins::PluginTarget {
                                tool_id: tool_id.to_owned(),
                                scope: crate::native::adapter::Scope::Global,
                                project_path: None,
                                context_id: None,
                            });
                            match listed {
                                Ok(parsed) => entries = parsed,
                                Err(error) => detail = error,
                            }
                        }
                        Err(_) => detail = if stderr.trim().is_empty() { "原生插件输出格式不兼容".into() } else { stderr.trim().chars().take(500).collect() },
                    }
                } else {
                    detail = stderr.trim().chars().take(500).collect();
                    if detail.is_empty() { detail = stdout.trim().chars().take(500).collect(); }
                    if entries.is_empty() { entries = configured_plugin_entries(target, tool_id); }
                }
            }
            Err(error) => detail = error.to_string(),
        }
    }
    let entries = serde_json::to_value(entries).map_err(|error| RemoteError::Storage(error.to_string()))?;
    Ok(serde_json::json!({
        "snapshot": {
            "target": { "toolId": tool_id, "scope": "global", "projectPath": null, "contextId": null },
            "capability": capability,
            "entries": entries,
            "baseline": "remote",
            "detail": detail
        }
    }))
}

fn configured_plugin_entries(target: &RemoteTarget, tool_id: &str) -> Vec<crate::resources::plugins::PluginEntry> {
    let Some(path) = native_config_path(tool_id) else { return Vec::new(); };
    let Ok(raw) = run_command(target, &format!("if [ -f {path} ]; then cat {path}; fi")) else { return Vec::new(); };
    let Ok(document) = raw.stdout.parse::<toml::Value>() else { return Vec::new(); };
    plugin_entries_from_document(&document)
}

fn plugin_entries_from_document(document: &toml::Value) -> Vec<crate::resources::plugins::PluginEntry> {
    let Some(table) = document.get("plugins").and_then(toml::Value::as_table) else { return Vec::new(); };
    table
        .iter()
        .filter(|(_, value)| value.is_table())
        .map(|(name, value)| {
            let enabled = value.as_table().and_then(|item| item.get("enabled")).and_then(toml::Value::as_bool);
            crate::resources::plugins::PluginEntry {
                id: name.clone(),
                name: name.clone(),
                source: name.clone(),
                version: None,
                scope: "user".into(),
                enabled,
                state: "installed_load_unknown".into(),
                policy: "config.toml".into(),
                read_only: true,
                root: None,
                resources: Vec::new(),
            }
        })
        .collect()
}

pub fn save_resource_store(target: &RemoteTarget, tool_id: &str, kind: &str, value: &serde_json::Value) -> Result<(), RemoteError> {
    if !valid_text(tool_id, 120) || !valid_text(kind, 80) || !tool_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) || !kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        return Err(RemoteError::InvalidPath);
    }
    let previous = if matches!(kind, "agents" | "skills") { load_resource_store(target, tool_id, kind).ok() } else { None };
    let json = serde_json::to_vec_pretty(value).map_err(|error| RemoteError::Storage(error.to_string()))?;
    if json.len() > 8_000_000 { return Err(RemoteError::Storage("远程资源过大".into())); }
    let path = format!("$HOME/.cliora/resources/{tool_id}/{kind}.json");
    apply_upload(target, &prepare_upload(&[], &[(path, json)])?)?;

    // The resource cache is also the transport for the remote UI, but the
    // selected CLI must see the same changes on its next launch. Materialize
    // the two formats we can safely map without depending on a local CLI
    // installation: Codex/Grok MCP TOML and Codex/Grok SKILL.md files.
    if kind == "mcp" {
        materialize_remote_mcp(target, tool_id, value)?;
    } else if kind == "skills" {
        materialize_remote_skills(target, tool_id, previous.as_ref(), value)?;
    } else if kind == "agents" {
        materialize_remote_agents(target, tool_id, previous.as_ref(), value)?;
    }
    Ok(())
}

/// Upload one local Skills directory to the selected host. The local path is
/// read once by the desktop process, then the same resource-store path used by
/// the Connections and Library views materializes it under the remote CLI's
/// native skills directory.
pub fn import_skill_directory(target: &RemoteTarget, tool_id: &str, source: &str) -> Result<(), RemoteError> {
    let (name, description, documents) = crate::resources::skills::local_documents(source).map_err(RemoteError::Storage)?;
    let mut value = load_resource_store(target, tool_id, "skills")?;
    let mut entries = value.get("entries").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let mut stored = value.get("documents").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
    let root = if tool_id == "grok" { "$HOME/.grok/skills" } else { "$HOME/.codex/skills" };
    entries.retain(|entry| entry.get("name").and_then(serde_json::Value::as_str) != Some(name.as_str()));
    for (path, text) in documents {
        stored.insert(format!("{root}/{name}/{path}"), serde_json::Value::String(text));
    }
    entries.push(serde_json::json!({"name": name, "path": format!("{root}/{name}/SKILL.md"), "digest": null, "state": "external", "detail": description, "packageId": null, "source": "writable", "pluginName": null, "pluginEnabled": null}));
    value = serde_json::json!({"entries": entries, "documents": stored});
    save_resource_store(target, tool_id, "skills", &value)
}

fn materialize_remote_mcp(target: &RemoteTarget, tool_id: &str, value: &serde_json::Value) -> Result<(), RemoteError> {
    if let Some((config_path, root, nested)) = json_mcp_path(tool_id) {
        return materialize_remote_json_mcp(target, value, config_path, root, nested);
    }
    let Some(config_path) = native_config_path(tool_id) else { return Ok(()); };
    let raw = run_command(target, &format!("if [ -f {config_path} ]; then cat {config_path}; fi"))?;
    let text = render_toml_mcp(&raw.stdout, value)?;
    apply_upload(target, &prepare_upload(&[], &[(config_path.to_owned(), text)])?)
}

/// Merge MCP servers into an existing TOML document.
///
/// `str::parse::<toml::Value>()` reads one value, not a document. A failed
/// parse used to be replaced with an empty table, so saving MCP could erase
/// the model and the API key. `toml_edit` replaces only `mcp_servers`.
fn render_toml_mcp(config_text: &str, value: &serde_json::Value) -> Result<Vec<u8>, RemoteError> {
    let mut document: toml_edit::DocumentMut = if config_text.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        config_text.parse().map_err(|error| RemoteError::Storage(format!("远程配置不是 TOML 表：{error}")))?
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
    if count == 0 { document.remove("mcp_servers"); } else { document.insert("mcp_servers", toml_edit::Item::Table(servers)); }
    Ok(document.to_string().into_bytes())
}

fn toml_string_table(value: Option<&serde_json::Value>) -> Option<toml_edit::Table> {
    let object = value?.as_object()?;
    let mut table = toml_edit::Table::new();
    for (key, item) in object {
        let Some(text) = item.as_str().filter(|_| valid_text(key, 160)) else { continue; };
        table.insert(key, toml_edit::value(text));
    }
    (!table.is_empty()).then_some(table)
}

fn valid_resource_token(value: &str, max: usize) -> bool {
    valid_text(value, max) && value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

fn empty_resource_store(kind: &str) -> serde_json::Value {
    match kind {
        "mcp" => serde_json::json!({"entries": [], "definitions": []}),
        "skills" => serde_json::json!({"entries": [], "documents": {}}),
        _ => serde_json::json!({}),
    }
}

fn mcp_seed_path(tool_id: &str) -> Option<&'static str> {
    native_config_path(tool_id).or_else(|| json_mcp_path(tool_id).map(|(path, _, _)| path))
}

fn mcp_entries_from_toml(document: &toml::Value) -> Vec<serde_json::Value> {
    let Some(servers) = document.get("mcp_servers").and_then(toml::Value::as_table) else { return Vec::new(); };
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

fn mcp_entries_from_json(document: &serde_json::Value, root: &str, nested: bool) -> Vec<serde_json::Value> {
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

fn toml_string_map(value: Option<&toml::Value>) -> serde_json::Value {
    let Some(table) = value.and_then(toml::Value::as_table) else { return serde_json::json!({}); };
    let mut map = serde_json::Map::new();
    for (key, item) in table {
        if let Some(text) = item.as_str() { map.insert(key.clone(), serde_json::Value::String(text.to_owned())); }
    }
    serde_json::Value::Object(map)
}

/// Native config decides which MCP servers are effective. Library metadata in
/// the Cliora store is kept only for names the CLI file still contains.
fn reconcile_mcp_store(tool_id: &str, stored: &serde_json::Value, config_text: &str) -> serde_json::Value {
    if mcp_seed_path(tool_id).is_none() {
        return if stored == &serde_json::json!({}) { empty_resource_store("mcp") } else { stored.clone() };
    }
    let native = mcp_store_from_config_text(tool_id, config_text).unwrap_or_else(|| empty_resource_store("mcp"));
    let native_entries = native.get("entries").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let names: HashSet<String> = native_entries.iter().filter_map(|entry| entry.get("name").and_then(serde_json::Value::as_str).map(str::to_owned)).collect();
    let definitions: Vec<serde_json::Value> = stored
        .get("definitions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("name").and_then(serde_json::Value::as_str).is_some_and(|name| names.contains(name)))
        .cloned()
        .collect();
    let stored_entries = stored.get("entries").and_then(serde_json::Value::as_array);
    let entries: Vec<serde_json::Value> = native_entries.into_iter().map(|mut entry| {
        let name = entry.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_owned();
        let marked = stored_entries.and_then(|items| items.iter().find(|item| item.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str())));
        let in_library = marked.and_then(|item| item.get("inLibrary")).and_then(serde_json::Value::as_bool) == Some(true)
            || definitions.iter().any(|item| item.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str()) && item.get("inLibrary").and_then(serde_json::Value::as_bool) != Some(false));
        if let Some(object) = entry.as_object_mut() { object.insert("inLibrary".into(), serde_json::json!(in_library)); }
        entry
    }).collect();
    serde_json::json!({ "entries": entries, "definitions": definitions })
}

fn mcp_store_from_config_text(tool_id: &str, config_text: &str) -> Option<serde_json::Value> {
    if config_text.trim().is_empty() { return None; }
    if matches!(tool_id, "codex" | "grok") {
        // toml::Value's FromStr parses one value, not a config document.
        // Dotted tables such as [mcp_servers.demo] only survive the document parser.
        let document: toml::Value = toml::from_str(config_text).ok()?;
        return Some(serde_json::json!({"entries": mcp_entries_from_toml(&document), "definitions": []}));
    }
    let (_, root, nested) = json_mcp_path(tool_id)?;
    let document = serde_json::from_str::<serde_json::Value>(config_text).ok()?;
    Some(serde_json::json!({"entries": mcp_entries_from_json(&document, root, nested), "definitions": []}))
}

fn bundle_groups(tool_ids: &[String], kind: &str) -> Vec<Vec<String>> {
    let mut groups = Vec::new();
    let mut current = Vec::new();
    for tool_id in tool_ids {
        let mut trial = current.clone();
        trial.push(tool_id.clone());
        if !current.is_empty() && resource_bundle_script(&trial, kind).len() > 24_000 {
            groups.push(std::mem::take(&mut current));
        }
        current.push(tool_id.clone());
    }
    if !current.is_empty() { groups.push(current); }
    groups
}

/// One remote shell command. File bodies are base64 on stdout, never on the
/// command line, and the command itself stays a single line so the transport
/// length check accepts it.
fn resource_bundle_script(tool_ids: &[String], kind: &str) -> String {
    let mut script = String::new();
    for tool_id in tool_ids {
        let store = format!("$HOME/.cliora/resources/{tool_id}/{kind}.json");
        script.push_str("printf '%s\\n' __CLIORA_TOOL__; printf '%s\\n' ");
        script.push_str(&shell_quote(tool_id));
        script.push_str("; printf '%s\\n' __CLIORA_STORE__; if [ -f ");
        script.push_str(&store);
        script.push_str(" ]; then base64 < ");
        script.push_str(&store);
        script.push_str(" | tr -d '\\n'; fi; printf '\\n'; ");
        if kind == "mcp" {
            script.push_str("printf '%s\\n' __CLIORA_CONFIG__; ");
            if let Some(path) = mcp_seed_path(tool_id) {
                script.push_str("if [ -f ");
                script.push_str(path);
                script.push_str(" ]; then base64 < ");
                script.push_str(path);
                script.push_str(" | tr -d '\\n'; fi; ");
            }
            script.push_str("printf '\\n'; ");
        } else if kind == "skills" {
            script.push_str("printf '%s\\n' __CLIORA_SKILLS__; scan=1; if [ -f ");
            script.push_str(&store);
            script.push_str(" ]; then stripped=$(tr -d '[:space:]' < ");
            script.push_str(&store);
            script.push_str("); if [ \"$stripped\" != '{}' ]; then scan=0; fi; fi; if [ \"$scan\" = 1 ]; then ");
            for (index, root) in remote_skill_roots(tool_id).iter().enumerate() {
                let dir = format!("$HOME/{}", root.relative);
                script.push_str("if [ -d ");
                script.push_str(&dir);
                script.push_str(" ]; then find ");
                script.push_str(&dir);
                script.push_str(" -mindepth 2 -maxdepth 2 -type f -name SKILL.md -print | while IFS= read -r file; do printf '%s\\n' __CLIORA_FILE__ ");
                script.push_str(&index.to_string());
                script.push_str(" \"$file\"; base64 < \"$file\" | tr -d '\\n'; printf '\\n'; done; fi; ");
            }
            script.push_str("fi; printf '%s\\n' __CLIORA_SKILLS_END__; ");
        }
    }
    script
}

fn decode_b64_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(trimmed).ok()?;
    String::from_utf8(bytes).ok()
}

fn skill_store_from_files(tool_id: &str, files: &[(usize, String, String)]) -> serde_json::Value {
    let mut located = Vec::new();
    let mut contents = BTreeMap::new();
    for (index, path, text) in files.iter().take(128) {
        located.push((*index, path.clone()));
        contents.insert(path.clone(), text.clone());
    }
    assemble_skill_store(tool_id, &located, &contents)
}

fn skip_marked_line<'a>(lines: &mut impl Iterator<Item = &'a str>, marker: &str) -> Option<String> {
    if lines.next().map(|value| value.trim() == marker).unwrap_or(false) {
        Some(lines.next().unwrap_or("").to_owned())
    } else {
        None
    }
}

fn read_skill_section<'a>(lines: &mut impl Iterator<Item = &'a str>) -> Vec<(usize, String, String)> {
    if lines.next().map(|value| value.trim() != "__CLIORA_SKILLS__").unwrap_or(true) {
        return Vec::new();
    }
    let mut files = Vec::new();
    while let Some(marker) = lines.next() {
        if marker.trim() == "__CLIORA_SKILLS_END__" { break; }
        if marker.trim() != "__CLIORA_FILE__" { continue; }
        let index = lines.next().and_then(|value| value.trim().parse::<usize>().ok()).unwrap_or(0);
        let path = lines.next().unwrap_or("").trim().to_owned();
        let encoded = lines.next().unwrap_or("");
        if files.len() >= 128 { continue; }
        if !path.starts_with('/') || path.contains("..") || !path.ends_with("/SKILL.md") { continue; }
        if let Some(text) = decode_b64_text(encoded) {
            files.push((index, path, text));
        }
    }
    files
}

fn parse_resource_bundle(kind: &str, tool_ids: &[String], stdout: &str) -> serde_json::Value {
    let mut lines = stdout.lines();
    let mut stores = serde_json::Map::new();
    while let Some(line) = lines.next() {
        if line.trim() != "__CLIORA_TOOL__" { continue; }
        let Some(tool_line) = lines.next() else { break; };
        let tool_id = tool_line.trim();
        if !tool_ids.iter().any(|id| id == tool_id) { continue; }
        let store_b64 = skip_marked_line(&mut lines, "__CLIORA_STORE__").unwrap_or_default();
        let stored = decode_b64_text(&store_b64).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        let value = if kind == "mcp" {
            let config = skip_marked_line(&mut lines, "__CLIORA_CONFIG__").unwrap_or_default();
            let config_text = decode_b64_text(&config).unwrap_or_default();
            reconcile_mcp_store(tool_id, stored.as_ref().unwrap_or(&serde_json::json!({})), &config_text)
        } else if let Some(stored) = stored.filter(|item| item != &serde_json::json!({})) {
            if kind == "skills" { let _ = read_skill_section(&mut lines); }
            stored
        } else if kind == "skills" {
            skill_store_from_files(tool_id, &read_skill_section(&mut lines))
        } else {
            empty_resource_store(kind)
        };
        stores.insert(tool_id.to_owned(), value);
    }
    for tool_id in tool_ids {
        stores.entry(tool_id.clone()).or_insert_with(|| empty_resource_store(kind));
    }
    serde_json::json!({ "stores": stores })
}

struct PreparedUpload {
    command: String,
    stdin: Vec<u8>,
}

/// Remote writes send file bytes on stdin. Putting a seeded SKILL.md on the
/// SSH argument list crosses the command limit and used to surface as
/// "远程路径无效".
fn prepare_upload(removes: &[String], files: &[(String, Vec<u8>)]) -> Result<PreparedUpload, RemoteError> {
    if removes.is_empty() && files.is_empty() {
        return Ok(PreparedUpload { command: String::new(), stdin: Vec::new() });
    }
    let mut command = String::from("umask 077; ");
    for path in removes {
        command.push_str("rm -f ");
        command.push_str(&remote_path_expr(path));
        command.push_str("; ");
    }
    if !files.is_empty() {
        command.push_str("write_blob() { IFS= read -r size || exit 43; mkdir -p \"$(dirname \"$1\")\"; head -c \"$size\" | base64 -d > \"$1\" || exit 44; IFS= read -r _; }; ");
    }
    let mut stdin = Vec::new();
    for (path, bytes) in files {
        command.push_str("write_blob ");
        command.push_str(&remote_path_expr(path));
        command.push_str("; ");
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        stdin.extend(encoded.len().to_string().into_bytes());
        stdin.push(b'\n');
        stdin.extend(encoded.into_bytes());
        stdin.push(b'\n');
    }
    ensure_remote_command(&command)?;
    Ok(PreparedUpload { command, stdin })
}

fn apply_upload(target: &RemoteTarget, upload: &PreparedUpload) -> Result<(), RemoteError> {
    if upload.command.is_empty() { return Ok(()); }
    if upload.stdin.is_empty() {
        run_command(target, &upload.command).map(|_| ())
    } else {
        run_command_with_stdin(target, &upload.command, &upload.stdin).map(|_| ())
    }
}

fn json_mcp_path(tool_id: &str) -> Option<(&'static str, &'static str, bool)> {
    match tool_id {
        "claude_code" => Some(("$HOME/.claude.json", "mcpServers", false)),
        "cursor" => Some(("$HOME/.cursor/mcp.json", "mcpServers", false)),
        "codebuddy" => Some(("$HOME/.codebuddy/mcp.json", "mcpServers", false)),
        "command_code" => Some(("$HOME/.commandcode/mcp.json", "mcpServers", false)),
        "devin" => Some(("$HOME/.devin/mcp_config.json", "mcpServers", false)),
        "kiro" => Some(("$HOME/.kiro/settings/mcp.json", "mcpServers", false)),
        "qoder_cn" => Some(("$HOME/.qoder/settings.json", "mcpServers", false)),
        "pi" => Some(("$HOME/.pi/agent/mcp.json", "mcpServers", false)),
        "minimax_code" => Some(("$HOME/.minimax-code/mcp.json", "mcpServers", false)),
        "zcode" => Some(("$HOME/.zcode/cli/config.json", "servers", true)),
        "opencode" => Some(("$HOME/.config/opencode/opencode.json", "mcp", false)),
        _ => None,
    }
}

fn materialize_remote_json_mcp(
    target: &RemoteTarget,
    value: &serde_json::Value,
    path: &str,
    root: &str,
    nested: bool,
) -> Result<(), RemoteError> {
    let raw = run_command(target, &format!("if [ -f {path} ]; then cat {path}; fi"))?;
    let mut document = if raw.stdout.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str::<serde_json::Value>(&raw.stdout).map_err(|error| RemoteError::Storage(format!("远程配置不是 JSON 对象：{error}")))?
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
        let object = document.as_object_mut().ok_or_else(|| RemoteError::Storage("远程配置不是 JSON 对象".into()))?;
        let child = object.entry("mcp").or_insert_with(|| serde_json::json!({}));
        child.as_object_mut().ok_or_else(|| RemoteError::Storage("远程 MCP 配置格式无效".into()))?.insert(root.into(), serde_json::Value::Object(servers));
        document
    } else {
        let object = document.as_object_mut().ok_or_else(|| RemoteError::Storage("远程配置不是 JSON 对象".into()))?;
        object.insert(root.into(), serde_json::Value::Object(servers));
        document
    };
    let text = serde_json::to_vec_pretty(&target_value).map_err(|error| RemoteError::Storage(error.to_string()))?;
    apply_upload(target, &prepare_upload(&[], &[(path.to_owned(), text)])?)
}

fn materialize_remote_skills(target: &RemoteTarget, tool_id: &str, previous: Option<&serde_json::Value>, value: &serde_json::Value) -> Result<(), RemoteError> {
    let root = if tool_id == "grok" { "$HOME/.grok/skills" } else { "$HOME/.codex/skills" };
    let Some(documents) = value.get("documents").and_then(serde_json::Value::as_object) else { return Ok(()); };
    let mut removes = Vec::new();
    if let Some(old) = previous.and_then(|item| item.get("documents")).and_then(serde_json::Value::as_object) {
        for path in old.keys() {
            let relative = path.split("/skills/").nth(1).unwrap_or(path.trim_start_matches('/'));
            if relative.is_empty() || relative.contains("..") || relative.starts_with('/') { continue; }
            if !documents.contains_key(path) { removes.push(format!("{root}/{relative}")); }
        }
    }
    let mut files = Vec::new();
    for (path, body) in documents {
        let Some(text) = body.as_str() else { continue; };
        let relative = path.split("/skills/").nth(1).unwrap_or(path.trim_start_matches('/'));
        if relative.is_empty() || relative.contains("..") || relative.contains('\0') || relative.starts_with('/') { continue; }
        files.push((format!("{root}/{relative}"), text.as_bytes().to_vec()));
    }
    apply_upload(target, &prepare_upload(&removes, &files)?)
}

/// Write remote agent definitions into the selected CLI's native directory.
/// The JSON resource file is only the transport/cache; keeping the native file
/// in place is what makes a newly started remote CLI actually load the agent.
fn materialize_remote_agents(
    target: &RemoteTarget,
    tool_id: &str,
    previous: Option<&serde_json::Value>,
    value: &serde_json::Value,
) -> Result<(), RemoteError> {
    let snapshot = value.get("snapshot").unwrap_or(value);
    let entries = snapshot.get("entries").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let previous_entries = previous
        .and_then(|item| item.get("snapshot").or(Some(item)))
        .and_then(|item| item.get("entries"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scope = snapshot.pointer("/target/scope").and_then(serde_json::Value::as_str).unwrap_or("global");
    let project = snapshot.pointer("/target/projectPath").and_then(serde_json::Value::as_str);
    let root = remote_agent_root(tool_id, scope, project).ok_or(RemoteError::InvalidPath)?;
    let mut removes = Vec::new();
    for old in previous_entries {
        if let Some(path) = old.get("path").and_then(serde_json::Value::as_str).filter(|path| remote_agent_path_allowed(path, &root)) {
            removes.push(path.to_owned());
        }
    }
    let mut files = Vec::new();
    for entry in entries {
        let Some(content) = entry.get("content").and_then(serde_json::Value::as_str) else { continue; };
        if content.len() > 256 * 1024 { return Err(RemoteError::InvalidPath); }
        let name = entry.get("name").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !valid_agent_name(name) { return Err(RemoteError::InvalidPath); }
        let extension = if tool_id == "codex" { "toml" } else { "md" };
        let generated = format!("{root}/{name}.{extension}");
        let path = entry.get("path").and_then(serde_json::Value::as_str).filter(|path| remote_agent_path_allowed(path, &root)).unwrap_or(&generated);
        files.push((path.to_owned(), content.as_bytes().to_vec()));
    }
    apply_upload(target, &prepare_upload(&removes, &files)?)
}

fn valid_agent_name(name: &str) -> bool {
    valid_text(name, 120) && name != "." && name != ".." && name.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn remote_agent_root(tool_id: &str, scope: &str, project: Option<&str>) -> Option<String> {
    let dir = match tool_id {
        "codex" => ".codex",
        "grok" => ".grok",
        "claude_code" => ".claude",
        "cursor" => ".cursor",
        "kimi_code" => ".kimi-code",
        "codebuddy" => ".codebuddy",
        "devin" => ".devin",
        "minimax_code" => ".minimax",
        "mimo_code" => ".mimo",
        "opencode" => ".config/opencode",
        _ => return None,
    };
    if scope == "project" {
        let project = project?.trim();
        if !valid_text(project, 4096) || project.starts_with('~') || project.contains('\0') { return None; }
        Some(format!("{project}/{dir}/agents"))
    } else {
        Some(format!("$HOME/{dir}/agents"))
    }
}

fn remote_agent_path_allowed(path: &str, root: &str) -> bool {
    valid_text(path, 4096) && (path == root || path.starts_with(&format!("{root}/"))) && !path.contains("..") && !path.contains('\0')
}

fn remote_path_expr(path: &str) -> String {
    if path.starts_with("$HOME/") && path.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '$' | '/' | '.' | '-' | '_' )) {
        path.to_owned()
    } else {
        shell_quote(path)
    }
}

fn native_config_path(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "codex" => Some("$HOME/.codex/config.toml"),
        "grok" => Some("$HOME/.grok/config.toml"),
        _ => None,
    }
}

fn load_native_file(target: &RemoteTarget, tool_id: &str) -> Result<BTreeMap<String, String>, RemoteError> {
    let Some(path) = native_config_path(tool_id) else { return Ok(BTreeMap::new()); };
    let result = run_command(target, &format!("if [ -f {path} ]; then base64 -w0 -- {path}; fi"))?;
    let text = result.stdout.trim();
    if text.is_empty() { return Ok(BTreeMap::new()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(text).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程原生配置编码无效".into() })?;
    let value = String::from_utf8(bytes).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程原生配置不是 UTF-8".into() })?;
    Ok(BTreeMap::from([(String::from("settings"), value)]))
}

fn remote_store_path(tool_id: &str) -> Result<String, RemoteError> {
    if !valid_text(tool_id, 120) || tool_id.chars().any(|ch| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!("$HOME/.cliora/registered-tools/{tool_id}.json"))
}

pub fn load_tool_store(target: &RemoteTarget, tool_id: &str) -> Result<RemoteToolStore, RemoteError> {
    let path = remote_store_path(tool_id)?;
    let result = run_command(target, &format!("if [ -f {path} ]; then base64 -w0 -- {path}; fi"))?;
    let text = result.stdout.trim();
    let mut store = if text.is_empty() { RemoteToolStore::default() } else {
        let bytes = base64::engine::general_purpose::STANDARD.decode(text).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程配置文件编码无效".into() })?;
        serde_json::from_slice(&bytes).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程配置文件格式无效".into() })?
    };
    if store.current_files.is_empty() { store.current_files = load_native_file(target, tool_id)?; }
    if store.common.is_none() && !store.current_files.is_empty() {
        store.common = Some(RegisteredCommon { tool: tool_id.to_owned(), version: 0, revision: String::new(), files: store.current_files.clone() });
    }
    Ok(store)
}

pub fn save_tool_store(target: &RemoteTarget, tool_id: &str, store: &RemoteToolStore) -> Result<(), RemoteError> {
    write_tool_store(target, tool_id, store, true)
}

fn write_tool_store(target: &RemoteTarget, tool_id: &str, store: &RemoteToolStore, write_native: bool) -> Result<(), RemoteError> {
    let path = remote_store_path(tool_id)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|error| RemoteError::Transport { stage: "remote_config", detail: error.to_string() })?;
    apply_upload(target, &prepare_upload(&[], &[(path, bytes)])?)?;
    if write_native {
        if let Some(path) = native_config_path(tool_id) {
            if let Some(text) = store.current_files.get("settings") {
                apply_upload(target, &prepare_upload(&[], &[(path.to_owned(), text.as_bytes().to_vec())])?)?;
            }
        }
    }
    Ok(())
}

pub fn delete_tool_profile(target: &RemoteTarget, tool_id: &str, profile_id: &str) -> Result<(), RemoteError> {
    let mut store = load_tool_store(target, tool_id)?;
    let before = store.profiles.len();
    store.profiles.retain(|profile| profile.id != profile_id);
    if store.profiles.len() == before {
        return Ok(());
    }
    // Dropping a saved profile does not rewrite the file the running CLI reads.
    write_tool_store(target, tool_id, &store, false)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_method: String,
    pub identity_file: Option<String>,
    pub ssh_config: Option<String>,
    pub default_path: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub target_id: String,
    pub name: String,
    pub path: String,
    pub preferred_tool: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    pub target_id: String,
    pub stage: String,
    pub reachable: bool,
    pub identity: Option<String>,
    pub system: Option<String>,
    pub home: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCliProbe {
    pub target_id: String,
    pub tool_id: String,
    pub executable: String,
    pub installed: bool,
    pub version: Option<String>,
    pub detail: Option<String>,
}

/// Probe a set of executables through one SSH invocation. Remote UI pages can
/// refresh a whole tool list without opening one TCP handshake per CLI.
pub fn probe_clis(target: &RemoteTarget, tools: &[(String, String)]) -> Result<Vec<RemoteCliProbe>, RemoteError> {
    validate_target(target)?;
    if tools.is_empty() { return Ok(Vec::new()); }
    let mut script = String::from("set +e; ");
    for (tool_id, executable) in tools {
        if !valid_text(tool_id, 120) || !valid_text(executable, 256) { return Err(RemoteError::InvalidPath); }
        script.push_str("printf '%s\\n' ");
        script.push_str(&shell_quote(&format!("__CLIORA_CLI__{}", tool_id)));
        script.push_str("; if command -v ");
        script.push_str(&shell_quote(executable));
        script.push_str(" >/dev/null 2>&1; then printf '%s\\n' 'installed'; ");
        script.push_str(&shell_quote(executable));
        script.push_str(" --version 2>&1 | { IFS= read -r line; printf '%s\\n' \"$line\"; }; else printf '%s\\n' 'missing'; printf '\\n'; fi; ");
    }
    let result = run_command(target, &script)?;
    let mut probes = Vec::with_capacity(tools.len());
    let mut lines = result.stdout.lines();
    for (tool_id, executable) in tools {
        let marker = lines.next().unwrap_or_default();
        if marker != format!("__CLIORA_CLI__{}", tool_id) { continue; }
        let installed = lines.next().unwrap_or_default() == "installed";
        let raw_version = lines.next().map(str::trim).filter(|value| !value.is_empty());
        let version = raw_version
            .and_then(|value| {
                crate::adapters::Registry::builtins()
                    .get(tool_id)
                    .and_then(|adapter| crate::native::adapter::version_from_output(adapter, Path::new(executable), value))
                    .or_else(|| Some(value.to_owned()))
            });
        probes.push(RemoteCliProbe { target_id: target.id.clone(), tool_id: tool_id.clone(), executable: executable.clone(), installed, version, detail: None });
    }
    let present: std::collections::HashSet<String> = probes.iter().map(|item| item.tool_id.clone()).collect();
    for (tool_id, executable) in tools {
        if !present.contains(tool_id) {
            probes.push(RemoteCliProbe { target_id: target.id.clone(), tool_id: tool_id.clone(), executable: executable.clone(), installed: false, version: None, detail: Some("远程探测响应无法解析".into()) });
        }
    }
    Ok(probes)
}

/// Check persistent terminal names in one SSH round-trip. The workbench uses
/// this before auto-reattaching durable index rows so a stale local record does
/// not become a visible running tab before SSH reports the remote process has
/// exited.
pub fn active_session_ids(target: &RemoteTarget, session_ids: &[String]) -> Result<HashSet<String>, RemoteError> {
    validate_target(target)?;
    if session_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let mut script = String::from("set +e; ");
    for id in session_ids {
        if !valid_text(id, 256) || id.chars().any(|ch| ch.is_control()) {
            return Err(RemoteError::InvalidPath);
        }
        script.push_str("printf '%s\\n' ");
        script.push_str(&shell_quote(&format!("__CLIORA_SESSION__{id}")));
        script.push_str("; if (command -v tmux >/dev/null 2>&1 && tmux has-session -t ");
        script.push_str(&shell_quote(id));
        script.push_str(" 2>/dev/null) || (command -v screen >/dev/null 2>&1 && screen -list | grep -Fq ");
        script.push_str(&shell_quote(&format!(".{id}")));
        script.push_str(" ); then printf '%s\\n' active; else printf '%s\\n' inactive; fi; ");
    }
    let result = run_command(target, &script)?;
    let mut active = HashSet::new();
    let mut lines = result.stdout.lines();
    for id in session_ids {
        let marker = lines.next().unwrap_or_default();
        let state = lines.next().unwrap_or_default();
        if marker == format!("__CLIORA_SESSION__{id}") && state == "active" {
            active.insert(id.clone());
        }
    }
    Ok(active)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandResult {
    pub target_id: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("远程目标名称不能为空")]
    InvalidName,
    #[error("远程主机地址无效")]
    InvalidHost,
    #[error("远程用户无效")]
    InvalidUser,
    #[error("远程路径无效")]
    InvalidPath,
    #[error("远程目标不存在")]
    NotFound,
    #[error("远程 SSH 功能尚未启用，请在设置中开启")]
    Disabled,
    #[error("远程连接阶段 {stage} 失败：{detail}")]
    Transport { stage: &'static str, detail: String },
    #[error("{0}")]
    Storage(String),
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|ch| ch == '\0' || ch.is_control())
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

fn probe_script(default_path: Option<&str>) -> String {
    let mut script = "printf '%s\\n' \"$(id -u)\"; uname -srm; printf '%s\\n' \"$HOME\"".to_owned();
    if let Some(path) = default_path {
        script.push_str("; test -d ");
        script.push_str(&shell_quote(path));
        script.push_str(" || { printf '%s\\n' 'cliora:remote-path-failed' >&2; exit 42; }");
    }
    script
}

/// Quote one argument for the remote POSIX shell command assembled by an
/// adapter port. Adapter command names and arguments remain data, never shell
/// syntax supplied by the caller.
pub fn quote_command_arg(value: &str) -> String {
    shell_quote(value)
}

/// Build the shared OpenSSH connection arguments. Password mode answers from
/// the system credential store through askpass when a password is saved (see
/// `password`); otherwise the terminal asks. The secret never enters args.
pub fn connection_args(target: &RemoteTarget) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=2".into(),
        "-p".into(),
        target.port.to_string(),
    ];
    if target.auth_method == "password" {
        args.extend([
            "-o".into(),
            "BatchMode=no".into(),
            "-o".into(),
            "PreferredAuthentications=password".into(),
            "-o".into(),
            "PubkeyAuthentication=no".into(),
        ]);
    } else if let Some(identity_file) = target
        .identity_file
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        args.extend(["-i".into(), identity_file.into()]);
    }
    if let Some(config) = target.ssh_config.as_deref() {
        args.extend(["-F".into(), config.into()]);
    }
    // OpenSSH multiplexes sessions through a per-target control socket on
    // Unix. Windows has no equivalent socket, so each command is its own
    // connection; `run_ssh` keeps that burst inside sshd's unauthenticated
    // connection limit and retries a handshake the server closes.
    if let Some(path) = control_path(target) {
        args.extend([
            "-o".into(),
            "ControlMaster=auto".into(),
            "-o".into(),
            "ControlPersist=60".into(),
            "-o".into(),
            format!("ControlPath={path}"),
        ]);
    }
    args.push(format!("{}@{}", target.user, target.host));
    args
}

// OpenSSH's Windows port does not expose Unix-domain control sockets. Passing
// ControlPath there creates a regular file and fails every command with
// `getsockname failed: Not a socket`; use ordinary SSH on Windows instead.
#[cfg(windows)]
fn control_path(_target: &RemoteTarget) -> Option<String> { None }

#[cfg(not(windows))]
fn control_path(target: &RemoteTarget) -> Option<String> {
    let root = dirs::cache_dir().or_else(|| Some(std::env::temp_dir()))?.join("cliora").join("ssh");
    if std::fs::create_dir_all(&root).is_err() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
    }
    let identity = format!("{}@{}:{}|{}|{}", target.user, target.host, target.port, target.ssh_config.as_deref().unwrap_or_default(), target.identity_file.as_deref().unwrap_or_default());
    let digest = Sha256::digest(identity.as_bytes());
    Some(root.join(format!("ctl-{:x}", digest)).to_string_lossy().into_owned())
}

fn classify_ssh_failure(stderr: &str, exit_code: Option<i32>) -> &'static str {
    let detail = stderr.to_ascii_lowercase();
    if detail.contains("remote host identification has changed")
        || detail.contains("host key verification failed")
        || detail.contains("no matching host key")
    {
        "host_key"
    } else if detail.contains("permission denied")
        || detail.contains("could not authenticate")
        || detail.contains("too many authentication failures")
    {
        "authentication"
    } else if exit_code.is_some() && exit_code != Some(255) {
        "remote_command"
    } else {
        "connect"
    }
}

pub fn validate_target(target: &RemoteTarget) -> Result<(), RemoteError> {
    if !valid_text(&target.name, 120) {
        return Err(RemoteError::InvalidName);
    }
    if !valid_text(&target.host, 253)
        || target
            .host
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\'))
    {
        return Err(RemoteError::InvalidHost);
    }
    if !valid_text(&target.user, 64)
        || target
            .user
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\' | '@'))
    {
        return Err(RemoteError::InvalidUser);
    }
    if !matches!(target.auth_method.as_str(), "key" | "password") {
        return Err(RemoteError::InvalidPath);
    }
    for path in [
        target.identity_file.as_deref(),
        target.ssh_config.as_deref(),
        target.default_path.as_deref(),
    ]
        .into_iter()
        .flatten()
    {
        if !valid_text(path, 4096) {
            return Err(RemoteError::InvalidPath);
        }
    }
    Ok(())
}

pub fn list_targets(db: &Database) -> Result<Vec<RemoteTarget>, RemoteError> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id,name,host,port,user_name,auth_method,identity_file,ssh_config,default_path,enabled,created_at,updated_at FROM remote_targets ORDER BY name COLLATE NOCASE, id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(RemoteTarget {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)?.try_into().unwrap_or(22),
                    user: row.get(4)?,
                    auth_method: row.get(5)?,
                    identity_file: row.get(6)?,
                    ssh_config: row.get(7)?,
                    default_path: row.get(8)?,
                    enabled: row.get::<_, i64>(9)? != 0,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
    .map_err(RemoteError::Storage)
}

pub fn target(db: &Database, id: &str) -> Result<RemoteTarget, RemoteError> {
    list_targets(db)?.into_iter().find(|item| item.id == id).ok_or(RemoteError::NotFound)
}

fn library_json(target: &RemoteTarget) -> Result<Vec<crate::library::LibraryItem>, RemoteError> {
    let result = run_command(target, "if [ -f \"$HOME/.cliora/library.json\" ]; then cat \"$HOME/.cliora/library.json\"; else printf '%s' '[]'; fi")?;
    serde_json::from_str(&result.stdout).map_err(|error| RemoteError::Storage(format!("远程资料库格式无效：{error}")))
}

fn write_library_json(target: &RemoteTarget, items: &[crate::library::LibraryItem]) -> Result<(), RemoteError> {
    let json = serde_json::to_string(items).map_err(|error| RemoteError::Storage(error.to_string()))?;
    apply_upload(target, &prepare_upload(&[], &[("$HOME/.cliora/library.json".into(), json.into_bytes())])?)
}

pub fn list_library(
    target: &RemoteTarget,
    kind: crate::library::LibraryKind,
    search: &str,
) -> Result<Vec<crate::library::LibraryItem>, RemoteError> {
    let needle = search.trim().to_lowercase();
    Ok(library_json(target)?.into_iter().filter(|item| item.kind == kind && (needle.is_empty() || item.title.to_lowercase().contains(&needle) || item.body.to_lowercase().contains(&needle) || item.category.to_lowercase().contains(&needle))).collect())
}

pub fn save_library(
    target: &RemoteTarget,
    draft: crate::library::LibraryDraft,
) -> Result<crate::library::LibraryItem, RemoteError> {
    if !valid_text(&draft.title, 240) || draft.body.len() > 1_000_000 || draft.category.len() > 400 {
        return Err(RemoteError::InvalidPath);
    }
    let mut items = library_json(target)?;
    let now = now() as u64;
    if let Some(id) = draft.id.as_deref() {
        let item = items.iter_mut().find(|item| item.id == id).ok_or(RemoteError::NotFound)?;
        if draft.expected_version != Some(item.version) { return Err(RemoteError::Storage("远程资料库版本已变化，请刷新后重试".into())); }
        item.title = draft.title; item.body = draft.body; item.category = draft.category; item.project_id = draft.project_id; item.version = item.version.saturating_add(1); item.updated_at = now;
        let saved = item.clone(); write_library_json(target, &items)?; return Ok(saved);
    }
    let item = crate::library::LibraryItem { id: uuid::Uuid::new_v4().to_string(), kind: draft.kind, title: draft.title, body: draft.body, category: draft.category, project_id: draft.project_id, version: 1, updated_at: now };
    items.push(item.clone()); write_library_json(target, &items)?; Ok(item)
}

pub fn delete_library(target: &RemoteTarget, id: &str, expected_version: u64) -> Result<(), RemoteError> {
    let mut snapshot = read_rule_snapshot(target, &[])?;
    let index = snapshot.items.iter().position(|item| item.id == id).ok_or(RemoteError::NotFound)?;
    if snapshot.items[index].version != expected_version { return Err(RemoteError::Storage("远程资料库版本已变化，请刷新后重试".into())); }
    let removed = snapshot.items.remove(index);
    if removed.kind != crate::library::LibraryKind::Rule {
        return write_library_json(target, &snapshot.items);
    }
    let pairs = placed_rule_pairs(&snapshot.state, &removed.id);
    let located = locate_rule_files(&pairs)?;
    if !located.is_empty() {
        snapshot.files = read_rule_files(target, &located)?;
    }
    let outcome = crate::resources::rules::plan_host_rule_release(&snapshot.items, &snapshot.state, &snapshot.files, &removed.id);
    write_rule_materials(target, Some(&snapshot.items), &snapshot.state, &outcome)
}

pub fn list_rule_placements(target: &RemoteTarget) -> Result<Vec<crate::resources::rules::RulePlacement>, RemoteError> {
    let snapshot = read_rule_snapshot(target, &[])?;
    let pairs = snapshot.state.placements.iter().map(|item| (item.tool_id.clone(), item.scope_key.clone())).collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let pairs = pairs.into_iter().filter(|item| seen.insert(item.clone())).collect::<Vec<_>>();
    let located = locate_rule_files(&pairs)?;
    let files = if located.is_empty() { Vec::new() } else { read_rule_files(target, &located)? };
    Ok(crate::resources::rules::host_placement_view(&snapshot.items, &snapshot.state, &files))
}

pub fn sync_rules(
    target: &RemoteTarget,
    rule_id: &str,
    expected_version: u64,
    selection: crate::resources::rules::RuleClientSelection,
) -> Result<Vec<crate::resources::rules::RuleSyncResult>, RemoteError> {
    let key = crate::resources::rules::host_scope_key(selection.scope, selection.project_path.as_deref()).map_err(RemoteError::Storage)?;
    let mut tools: Vec<String> = selection.tool_ids.iter().filter(|id| !id.is_empty()).cloned().collect();
    tools.sort();
    tools.dedup();
    let mut requests = Vec::new();
    let mut unresolved = Vec::new();
    for tool in &tools {
        match remote_rule_target(tool, selection.scope, selection.project_path.as_deref()) {
            Ok(path) => requests.push((tool.clone(), key.clone(), path)),
            Err(error) => unresolved.push(failed_rule(tool, error)),
        }
    }
    let mut snapshot = read_rule_snapshot(target, &requests)?;
    let mut extra = Vec::new();
    for place in &snapshot.state.placements {
        if place.rule_id != rule_id || requests.iter().any(|item| item.0 == place.tool_id && item.1 == place.scope_key) {
            continue;
        }
        extra.push((place.tool_id.clone(), place.scope_key.clone()));
    }
    let located = locate_rule_files(&extra)?;
    if !located.is_empty() {
        snapshot.files.extend(read_rule_files(target, &located)?);
    }
    let outcome = crate::resources::rules::plan_host_rule_sync(&snapshot.items, &snapshot.state, &snapshot.files, &unresolved, rule_id, expected_version, &selection).map_err(RemoteError::Storage)?;
    if outcome.commit {
        write_rule_materials(target, None, &snapshot.state, &outcome)?;
    }
    Ok(outcome.results)
}

fn failed_rule(tool: &str, detail: String) -> crate::resources::rules::RuleSyncResult {
    crate::resources::rules::RuleSyncResult { tool_id: tool.to_owned(), path: None, status: "failed", detail, existing: String::new(), proposed: String::new() }
}

fn placed_rule_pairs(state: &crate::resources::rules::RuleHostState, rule_id: &str) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = state.placements.iter().filter(|item| item.rule_id == rule_id).map(|item| (item.tool_id.clone(), item.scope_key.clone())).collect();
    pairs.sort();
    pairs.dedup();
    pairs
}

fn locate_rule_files(pairs: &[(String, String)]) -> Result<Vec<(String, String, String)>, RemoteError> {
    let mut located = Vec::new();
    for (tool, scope_key) in pairs {
        let (scope, project) = if let Some(path) = scope_key.strip_prefix("project:") {
            (crate::native::adapter::Scope::Project, Some(path.to_owned()))
        } else {
            (crate::native::adapter::Scope::Global, None)
        };
        match remote_rule_target(tool, scope, project.as_deref()) {
            Ok(path) => located.push((tool.clone(), scope_key.clone(), path)),
            Err(_) => continue,
        }
    }
    Ok(located)
}

fn remote_rule_target(tool_id: &str, scope: crate::native::adapter::Scope, project_path: Option<&str>) -> Result<String, String> {
    use crate::native::adapter::Scope;
    let registry = crate::adapters::Registry::builtins();
    let adapter = registry.get(tool_id).ok_or("此 CLI 尚无注册适配器")?;
    let relative = adapter.remote_rule_relative(scope).ok_or_else(|| adapter.rule_unavailable_reason(scope).unwrap_or("此 CLI 在当前范围没有已确认的原生规则文件").to_owned())?;
    if !crate::adapters::safe_rule_relative(&relative) {
        return Err("此 CLI 在当前范围没有已确认的原生规则文件".into());
    }
    match scope {
        Scope::Global => Ok(format!("$HOME/{relative}")),
        Scope::Project => {
            let key = crate::resources::rules::host_scope_key(scope, project_path)?;
            let project = key.strip_prefix("project:").unwrap_or("");
            Ok(format!("{project}/{relative}"))
        }
    }
}

struct RuleTexts {
    items: Vec<crate::library::LibraryItem>,
    state: crate::resources::rules::RuleHostState,
    texts: BTreeMap<String, String>,
}

fn rule_path_allowed(path: &str) -> bool {
    if let Some(relative) = path.strip_prefix("$HOME/") {
        return crate::adapters::safe_rule_relative(relative);
    }
    path.starts_with('/') && !path.contains('\\') && !path.contains("..") && !path.chars().any(|ch| ch.is_control())
}

fn rule_read_script(paths: &[String], include_library: bool) -> Result<String, RemoteError> {
    let mut script = String::new();
    if include_library {
        script.push_str("printf '%s\\n' __CLIORA_LIBRARY__; if [ -f \"$HOME/.cliora/library.json\" ]; then base64 < \"$HOME/.cliora/library.json\" | tr -d '\\n'; fi; printf '\\n'; printf '%s\\n' __CLIORA_RULE_STATE__; if [ -f \"$HOME/.cliora/rule-state.json\" ]; then base64 < \"$HOME/.cliora/rule-state.json\" | tr -d '\\n'; fi; printf '\\n'; ");
    }
    for path in paths {
        if !rule_path_allowed(path) {
            return Err(RemoteError::InvalidPath);
        }
        let expr = remote_path_expr(path);
        script.push_str("printf '%s\\n' __CLIORA_RULE_FILE__; printf '%s\\n' ");
        script.push_str(&shell_quote(path));
        script.push_str("; if [ -f ");
        script.push_str(&expr);
        script.push_str(" ]; then base64 < ");
        script.push_str(&expr);
        script.push_str(" | tr -d '\\n'; fi; printf '\\n'; ");
    }
    ensure_remote_command(&script)?;
    Ok(script)
}

fn parse_rule_texts(stdout: &str, expect_library: bool) -> Result<RuleTexts, RemoteError> {
    let mut lines = stdout.lines();
    let (items, state) = if expect_library {
        if lines.next().map(|line| line.trim() != "__CLIORA_LIBRARY__").unwrap_or(true) {
            return Err(RemoteError::Storage("远程资料库格式无效".into()));
        }
        let library_text = decode_b64_text(lines.next().unwrap_or("")).unwrap_or_else(|| "[]".into());
        let items = serde_json::from_str(&library_text).map_err(|error| RemoteError::Storage(format!("远程资料库格式无效：{error}")))?;
        if lines.next().map(|line| line.trim() != "__CLIORA_RULE_STATE__").unwrap_or(true) {
            return Err(RemoteError::Storage("远程规则记录格式无效".into()));
        }
        let state = match decode_b64_text(lines.next().unwrap_or("")) {
            None => crate::resources::rules::RuleHostState::default(),
            Some(text) => serde_json::from_str(&text).map_err(|error| RemoteError::Storage(format!("远程规则记录格式无效：{error}")))?,
        };
        (items, state)
    } else {
        (Vec::new(), crate::resources::rules::RuleHostState::default())
    };
    let mut texts = BTreeMap::new();
    while let Some(marker) = lines.next() {
        if marker.trim().is_empty() { continue; }
        if marker.trim() != "__CLIORA_RULE_FILE__" { continue; }
        let path = lines.next().unwrap_or("").trim().to_owned();
        let existing = decode_b64_text(lines.next().unwrap_or("")).unwrap_or_default();
        if rule_path_allowed(&path) {
            texts.insert(path, existing);
        }
    }
    Ok(RuleTexts { items, state, texts })
}

struct RuleSnapshot {
    items: Vec<crate::library::LibraryItem>,
    state: crate::resources::rules::RuleHostState,
    files: Vec<crate::resources::rules::HostRuleFile>,
}

fn files_from_texts(requests: &[(String, String, String)], texts: &BTreeMap<String, String>) -> Vec<crate::resources::rules::HostRuleFile> {
    requests.iter().map(|(tool, scope_key, path)| crate::resources::rules::HostRuleFile {
        tool_id: tool.clone(),
        scope_key: scope_key.clone(),
        path: path.clone(),
        existing: texts.get(path).cloned().unwrap_or_default(),
    }).collect()
}

fn read_rule_snapshot(target: &RemoteTarget, requests: &[(String, String, String)]) -> Result<RuleSnapshot, RemoteError> {
    let paths = requests.iter().map(|item| item.2.clone()).collect::<Vec<_>>();
    let result = run_command(target, &rule_read_script(&paths, true)?)?;
    let parsed = parse_rule_texts(&result.stdout, true)?;
    Ok(RuleSnapshot { items: parsed.items, state: parsed.state, files: files_from_texts(requests, &parsed.texts) })
}

fn read_rule_files(target: &RemoteTarget, requests: &[(String, String, String)]) -> Result<Vec<crate::resources::rules::HostRuleFile>, RemoteError> {
    let paths = requests.iter().map(|item| item.2.clone()).collect::<Vec<_>>();
    let result = run_command(target, &rule_read_script(&paths, false)?)?;
    let parsed = parse_rule_texts(&result.stdout, false)?;
    Ok(files_from_texts(requests, &parsed.texts))
}

fn write_rule_materials(
    target: &RemoteTarget,
    items: Option<&[crate::library::LibraryItem]>,
    original: &crate::resources::rules::RuleHostState,
    outcome: &crate::resources::rules::HostRuleSync,
) -> Result<(), RemoteError> {
    let mut files = Vec::new();
    for write in &outcome.writes {
        if !rule_path_allowed(&write.path) {
            return Err(RemoteError::InvalidPath);
        }
        files.push((write.path.clone(), write.contents.clone().into_bytes()));
    }
    if outcome.state != *original {
        let json = serde_json::to_vec(&outcome.state).map_err(|error| RemoteError::Storage(error.to_string()))?;
        files.push(("$HOME/.cliora/rule-state.json".into(), json));
    }
    if let Some(items) = items {
        let json = serde_json::to_vec(items).map_err(|error| RemoteError::Storage(error.to_string()))?;
        files.push(("$HOME/.cliora/library.json".into(), json));
    }
    apply_upload(target, &prepare_upload(&[], &files)?)
}

pub fn save_target(db: &Database, mut target: RemoteTarget) -> Result<RemoteTarget, RemoteError> {
    validate_target(&target)?;
    if target.id.trim().is_empty() {
        target.id = Uuid::new_v4().to_string();
    }
    let timestamp = now();
    db.with_connection(|conn| {
        let existing: Option<i64> = conn
            .query_row("SELECT created_at FROM remote_targets WHERE id=?1", [&target.id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        target.created_at = existing.unwrap_or(timestamp);
        target.updated_at = timestamp;
        conn.execute(
            "INSERT INTO remote_targets (id,name,host,port,user_name,auth_method,identity_file,ssh_config,default_path,enabled,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,user_name=excluded.user_name,
             auth_method=excluded.auth_method,identity_file=excluded.identity_file,ssh_config=excluded.ssh_config,default_path=excluded.default_path,enabled=excluded.enabled,updated_at=excluded.updated_at",
            params![target.id, target.name, target.host, target.port, target.user, target.auth_method, target.identity_file, target.ssh_config, target.default_path, target.enabled as i64, target.created_at, target.updated_at],
        )
        .map_err(|error| error.to_string())?;
        Ok(target)
    })
    .map_err(RemoteError::Storage)
}

pub fn delete_target(db: &Database, id: &str) -> Result<(), RemoteError> {
    if id.trim().is_empty() {
        return Err(RemoteError::NotFound);
    }
    db.with_connection(|conn| {
        let changed = conn
            .execute("DELETE FROM remote_targets WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(RemoteError::NotFound.to_string());
        }
        Ok(())
    })
    .map_err(RemoteError::Storage)
}

pub fn list_projects(
    db: &Database,
    target_id: Option<&str>,
) -> Result<Vec<RemoteProject>, RemoteError> {
    db.with_connection(|conn| {
        let mut statement = if target_id.is_some() {
            conn.prepare("SELECT id,target_id,name,path,preferred_tool,updated_at FROM remote_projects WHERE target_id=?1 ORDER BY name COLLATE NOCASE,id").map_err(|error| error.to_string())?
        } else {
            conn.prepare("SELECT id,target_id,name,path,preferred_tool,updated_at FROM remote_projects ORDER BY updated_at DESC,id").map_err(|error| error.to_string())?
        };
        let rows = match target_id {
            Some(target_id) => statement.query_map([target_id], project_row),
            None => statement.query_map([], project_row),
        }.map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }).map_err(RemoteError::Storage)
}

fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteProject> {
    Ok(RemoteProject {
        id: row.get(0)?,
        target_id: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        preferred_tool: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn save_project(
    db: &Database,
    mut project: RemoteProject,
) -> Result<RemoteProject, RemoteError> {
    if !valid_text(&project.name, 120)
        || !valid_text(&project.path, 4096)
        || project.path.starts_with('~')
    {
        return Err(RemoteError::InvalidPath);
    }
    if project.id.trim().is_empty() {
        project.id = Uuid::new_v4().to_string();
    }
    project.updated_at = now();
    db.with_connection(|conn| {
        let target_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM remote_targets WHERE id=?1)", [&project.target_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !target_exists { return Err(RemoteError::NotFound.to_string()); }
        conn.execute("INSERT INTO remote_projects (id,target_id,name,path,preferred_tool,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,name=excluded.name,path=excluded.path,preferred_tool=excluded.preferred_tool,updated_at=excluded.updated_at", params![project.id, project.target_id, project.name, project.path, project.preferred_tool, project.updated_at]).map_err(|error| error.to_string())?;
        Ok(project)
    }).map_err(RemoteError::Storage)
}

pub fn delete_project(db: &Database, id: &str) -> Result<(), RemoteError> {
    let changed = db
        .with_connection(|conn| {
            conn.execute("DELETE FROM remote_projects WHERE id=?1", [id])
                .map_err(|error| error.to_string())
        })
        .map_err(RemoteError::Storage)?;
    if changed == 0 {
        return Err(RemoteError::NotFound);
    }
    Ok(())
}

/// Perform a read-only, PTY-free OpenSSH probe. Host key checking stays strict;
/// callers must explicitly maintain `known_hosts` when a host key changes.
pub fn probe_target(target: &RemoteTarget) -> Result<RemoteProbe, RemoteError> {
    validate_target(target)?;
    let remote_script = probe_script(target.default_path.as_deref());
    let output = run_ssh(target, || {
        let mut command =
            Command::new(std::env::var_os("CLIORA_SSH_BINARY").unwrap_or_else(|| "ssh".into()));
        hide_console_window(&mut command);
        // BatchMode would also disable the saved-password askpass answer, and the
        // first `-o` value wins, so password targets rely on askpass instead.
        if target.auth_method != "password" {
            command.args(["-o", "BatchMode=yes"]);
        }
        ssh_session_limits(&mut command);
        command.args(connection_args(target));
        password::apply(target, &mut command);
        command.arg(&remote_script);
        wait_for_output(&mut command, SSH_COMMAND_DEADLINE)
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(500)
            .collect();
        let stage = if String::from_utf8_lossy(&output.stderr).contains("cliora:remote-path-failed")
        {
            "remote_path"
        } else {
            classify_ssh_failure(
                &String::from_utf8_lossy(&output.stderr),
                output.status.code(),
            )
        };
        return Err(RemoteError::Transport { stage, detail });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    Ok(RemoteProbe {
        target_id: target.id.clone(),
        stage: "ready".into(),
        reachable: true,
        identity: lines
            .first()
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        system: lines
            .get(1)
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        home: lines
            .get(2)
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        detail: None,
    })
}

fn ssh_session_limits(command: &mut Command) {
    command.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
    ]);
}

fn ssh_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    hide_console_window(&mut command);
    ssh_session_limits(&mut command);
    command.args(connection_args(target));
    password::apply(target, &mut command);
    command
}

fn sftp_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    hide_console_window(&mut command);
    command.args(["-q"]);
    ssh_session_limits(&mut command);
    password::apply(target, &mut command);
    let mut args = connection_args(target);
    let destination = args
        .pop()
        .expect("connection args always include destination");
    command.args(args);
    command.args(["-b", "-"]).arg(destination);
    command
}

fn ensure_remote_command(command_line: &str) -> Result<(), RemoteError> {
    if valid_text(command_line, 32_000) {
        Ok(())
    } else {
        Err(RemoteError::Transport { stage: "command", detail: "远程命令过长".into() })
    }
}

fn command_output(target: &RemoteTarget, command_line: &str) -> Result<std::process::Output, RemoteError> {
    command_output_with_stdin(target, command_line, None)
}

fn run_command_with_stdin(target: &RemoteTarget, command_line: &str, stdin_payload: &[u8]) -> Result<RemoteCommandResult, RemoteError> {
    let output = command_output_with_stdin(target, command_line, Some(stdin_payload))?;
    command_result(target, output)
}

fn command_output_with_stdin(target: &RemoteTarget, command_line: &str, stdin_payload: Option<&[u8]>) -> Result<std::process::Output, RemoteError> {
    validate_target(target)?;
    ensure_remote_command(command_line)?;
    let command_line = command_line.to_owned();
    run_ssh(target, || {
        let mut command = ssh_command(
            target,
            &std::env::var("CLIORA_SSH_BINARY").unwrap_or_else(|_| "ssh".into()),
        );
        command.arg(&command_line);
        let payload = stdin_payload.map(|bytes| bytes.to_vec());
        wait_for_output_with_stdin(&mut command, SSH_COMMAND_DEADLINE, payload)
    })
}

fn command_result(target: &RemoteTarget, output: std::process::Output) -> Result<RemoteCommandResult, RemoteError> {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(255);
    if !output.status.success() {
        return Err(RemoteError::Transport {
            stage: classify_ssh_failure(&stderr, output.status.code()),
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    Ok(RemoteCommandResult { target_id: target.id.clone(), exit_code, stdout, stderr })
}

const SSH_COMMAND_DEADLINE: Duration = Duration::from_secs(25);
const SSH_SLOT_WAIT: Duration = Duration::from_secs(20);

fn wait_for_output(command: &mut Command, deadline: Duration) -> Result<std::process::Output, RemoteError> {
    wait_for_output_with_stdin(command, deadline, None)
}

fn wait_for_output_with_stdin(command: &mut Command, deadline: Duration, stdin_payload: Option<Vec<u8>>) -> Result<std::process::Output, RemoteError> {
    if stdin_payload.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| RemoteError::Transport {
        stage: "launch",
        detail: error.to_string(),
    })?;
    let stdin_pipe = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_task = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    // Write stdin on another thread. A full pipe plus an unread stdout would
    // deadlock if the parent both wrote and read on this thread.
    let mut stdin_task = match stdin_payload {
        Some(payload) => Some(std::thread::spawn(move || {
            if let Some(mut pipe) = stdin_pipe {
                let _ = pipe.write_all(&payload);
                let _ = pipe.flush();
            }
        })),
        None => {
            drop(stdin_pipe);
            None
        }
    };
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(task) = stdin_task.take() { let _ = task.join(); }
                let _ = stdout_task.join();
                let _ = stderr_task.join();
                return Err(RemoteError::Transport {
                    stage: "timeout",
                    detail: "远程连接超时，请稍后再试".into(),
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                if let Some(task) = stdin_task.take() { let _ = task.join(); }
                let _ = stdout_task.join();
                let _ = stderr_task.join();
                return Err(RemoteError::Transport {
                    stage: "launch",
                    detail: error.to_string(),
                });
            }
        }
    };
    if let Some(task) = stdin_task.take() { let _ = task.join(); }
    Ok(std::process::Output {
        status,
        stdout: stdout_task.join().unwrap_or_default(),
        stderr: stderr_task.join().unwrap_or_default(),
    })
}

/// sshd closes extra unauthenticated handshakes (`MaxStartups`, default
/// 10:30:60) with "Connection closed by <host> port 22". Windows OpenSSH
/// cannot share a ControlMaster socket, and one library page opens a command
/// per CLI, so those handshakes used to arrive together. Two at a time stays
/// under that limit; a closed handshake is tried again after the slot is free.
const SSH_PARALLEL: usize = 2;
const SSH_ATTEMPTS: u32 = 3;

struct SshGate {
    inflight: Mutex<BTreeMap<String, usize>>,
    ready: Condvar,
}

fn ssh_gate() -> &'static SshGate {
    static GATE: OnceLock<SshGate> = OnceLock::new();
    GATE.get_or_init(|| SshGate {
        inflight: Mutex::new(BTreeMap::new()),
        ready: Condvar::new(),
    })
}

fn ssh_destination(target: &RemoteTarget) -> String {
    format!("{}@{}:{}", target.user, target.host, target.port)
}

struct SshSlot {
    key: String,
}

impl Drop for SshSlot {
    fn drop(&mut self) {
        let gate = ssh_gate();
        let mut inflight = gate.inflight.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(count) = inflight.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                inflight.remove(&self.key);
            }
        }
        gate.ready.notify_all();
    }
}

fn acquire_ssh_slot(target: &RemoteTarget) -> Result<SshSlot, RemoteError> {
    acquire_ssh_slot_within(target, SSH_SLOT_WAIT)
}

fn acquire_ssh_slot_within(target: &RemoteTarget, wait: Duration) -> Result<SshSlot, RemoteError> {
    let key = ssh_destination(target);
    let gate = ssh_gate();
    let mut inflight = gate.inflight.lock().unwrap_or_else(|error| error.into_inner());
    let deadline = Instant::now() + wait;
    loop {
        let count = inflight.get(&key).copied().unwrap_or(0);
        if count < SSH_PARALLEL {
            inflight.insert(key.clone(), count + 1);
            return Ok(SshSlot { key });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(RemoteError::Transport {
                stage: "connect",
                detail: "远程连接正忙，请稍后再试".into(),
            });
        }
        let (guard, timeout) = gate
            .ready
            .wait_timeout(inflight, remaining)
            .unwrap_or_else(|error| error.into_inner());
        inflight = guard;
        if timeout.timed_out() && inflight.get(&key).copied().unwrap_or(0) >= SSH_PARALLEL {
            return Err(RemoteError::Transport {
                stage: "connect",
                detail: "远程连接正忙，请稍后再试".into(),
            });
        }
    }
}

fn retryable_ssh_failure(stderr: &str, exit_code: Option<i32>) -> bool {
    if matches!(exit_code, Some(code) if code != 255) {
        return false;
    }
    let detail = stderr.to_ascii_lowercase();
    if detail.contains("permission denied")
        || detail.contains("could not authenticate")
        || detail.contains("too many authentication failures")
        || detail.contains("host key")
        || detail.contains("remote host identification has changed")
    {
        return false;
    }
    detail.contains("connection closed")
        || detail.contains("connection reset")
        || detail.contains("connection refused")
        || detail.contains("connection timed out")
        || detail.contains("timed out")
        || detail.contains("kex_exchange_identification")
        || detail.contains("banner exchange")
        || detail.contains("broken pipe")
        || detail.contains("connection abort")
}

fn ssh_retry_delay(attempt: u32) -> Duration {
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::from(elapsed.subsec_millis() % 80))
        .unwrap_or(0);
    Duration::from_millis(200 * u64::from(attempt + 1) + jitter)
}

fn run_ssh(
    target: &RemoteTarget,
    mut spawn: impl FnMut() -> Result<std::process::Output, RemoteError>,
) -> Result<std::process::Output, RemoteError> {
    for attempt in 0..SSH_ATTEMPTS {
        let slot = acquire_ssh_slot(target)?;
        let output = spawn()?;
        if output.status.success() {
            return Ok(output);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if attempt + 1 == SSH_ATTEMPTS || !retryable_ssh_failure(&stderr, output.status.code()) {
            return Ok(output);
        }
        drop(slot);
        std::thread::sleep(ssh_retry_delay(attempt));
    }
    unreachable!("ssh attempts always return")
}

pub fn run_command(
    target: &RemoteTarget,
    command_line: &str,
) -> Result<RemoteCommandResult, RemoteError> {
    let output = command_output(target, command_line)?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(255);
    if !output.status.success() {
        return Err(RemoteError::Transport {
            stage: classify_ssh_failure(&stderr, output.status.code()),
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    Ok(RemoteCommandResult {
        target_id: target.id.clone(),
        exit_code,
        stdout,
        stderr,
    })
}

/// Binary stdout from one remote command. History archives are not UTF-8 text.
pub fn run_command_bytes(target: &RemoteTarget, command_line: &str) -> Result<Vec<u8>, RemoteError> {
    let output = command_output(target, command_line)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(RemoteError::Transport {
            stage: classify_ssh_failure(&stderr, output.status.code()),
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    if output.stdout.len() > 52 * 1024 * 1024 {
        return Err(RemoteError::Transport {
            stage: "remote_command",
            detail: "远程历史超出读取上限".into(),
        });
    }
    Ok(output.stdout)
}

/// List immediate child directories below a remote POSIX path. The shell
/// loop avoids depending on a particular `find` implementation while keeping
/// the caller's path quoted as data.
pub fn list_directories(target: &RemoteTarget, parent: &str) -> Result<Vec<String>, RemoteError> {
    if !valid_text(parent, 4096) || parent.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    let command = format!(
        "for entry in {}/*; do if [ -d \"$entry\" ]; then printf '%s\\n' \"$entry\"; fi; done",
        shell_quote(parent)
    );
    let result = run_command(target, &command)?;
    Ok(result
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(200)
        .map(ToOwned::to_owned)
        .collect())
}

/// Create a remote directory tree after the user explicitly requests it.
pub fn create_directory(target: &RemoteTarget, path: &str) -> Result<(), RemoteError> {
    if !valid_text(path, 4096) || path.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    let command = format!("mkdir -p -- {}", shell_quote(path));
    run_command(target, &command).map(|_| ())
}

/// Read one remote file through OpenSSH SFTP. The file contents are returned
/// directly; credentials and host-key material never cross the IPC boundary.
pub fn read_file(target: &RemoteTarget, remote_path: &str) -> Result<Vec<u8>, RemoteError> {
    validate_target(target)?;
    if !valid_text(remote_path, 4096) {
        return Err(RemoteError::InvalidPath);
    }
    let binary = std::env::var("CLIORA_SFTP_BINARY").unwrap_or_else(|_| "sftp".into());
    let output = run_ssh(target, || {
        let mut command = sftp_command(target, &binary);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| RemoteError::Transport {
                stage: "launch",
                detail: error.to_string(),
            })?;
        if let Some(mut stdin) = child.stdin.take() {
            writeln!(stdin, "get {} -", remote_path.replace('\n', " ")).map_err(|error| {
                RemoteError::Transport {
                    stage: "sftp",
                    detail: error.to_string(),
                }
            })?;
        }
        child.wait_with_output().map_err(|error| RemoteError::Transport {
            stage: "sftp",
            detail: error.to_string(),
        })
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stage = classify_ssh_failure(&stderr, output.status.code());
        return Err(RemoteError::Transport {
            stage: if matches!(stage, "connect" | "remote_command") {
                "sftp"
            } else {
                stage
            },
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    Ok(output.stdout)
}

pub fn ensure_enabled(db: &Database) -> Result<(), RemoteError> {
    db.preferences()
        .map_err(RemoteError::Storage)?
        .remote_ssh_enabled
        .then_some(())
        .ok_or(RemoteError::Disabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    }

    #[test]
    fn one_ssh_bundle_reads_mcp_from_the_native_config() {
        let saved = r#"{"entries":[{"name":"saved-server","transport":"stdio","command":"npx","inLibrary":true}],"definitions":[{"name":"saved-server","inLibrary":true}]}"#;
        let toml = "[mcp_servers.demo]\ncommand = \"node\"\nargs = [\"server.js\"]\n";
        let stdout = format!(
            "__CLIORA_TOOL__\ncodex\n__CLIORA_STORE__\n{}\n__CLIORA_CONFIG__\n{}\n__CLIORA_TOOL__\ngrok\n__CLIORA_STORE__\n\n__CLIORA_CONFIG__\n{}\n",
            b64(saved),
            b64("model = \"x\"\nexperimental_bearer_token = \"synthetic-remote-key\"\n"),
            b64(toml),
        );
        let parsed = parse_resource_bundle("mcp", &["codex".into(), "grok".into(), "cursor".into()], &stdout);
        let stores = parsed.get("stores").unwrap();
        assert!(stores["codex"]["entries"].as_array().unwrap().is_empty());
        assert!(stores["codex"]["definitions"].as_array().unwrap().is_empty());
        assert_eq!(stores["grok"]["entries"][0]["name"], "demo");
        assert_eq!(stores["grok"]["entries"][0]["command"], "node");
        assert_eq!(stores["grok"]["entries"][0]["args"][0], "server.js");
        assert!(stores["cursor"]["entries"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_library_mcp_copy_does_not_count_when_the_cli_config_lacks_it() {
        let saved = r#"{"entries":[{"name":"chrome-devtools-mcp","transport":"stdio","command":"npx","args":["-y","chrome-devtools-mcp@latest","--isolated"],"inLibrary":true},{"name":"node_repl","transport":"stdio","command":"stale","inLibrary":true}],"definitions":[{"name":"chrome-devtools-mcp","inLibrary":true},{"name":"node_repl","inLibrary":true}]}"#;
        let toml = "model = \"gpt-6-astra\"\nexperimental_bearer_token = \"synthetic-remote-key\"\n\n[mcp_servers.node_repl]\ncommand = \"node\"\nargs = [\"repl.js\"]\n\n[mcp_servers.node_repl.env]\nTOKEN = \"synthetic-remote-key\"\n";
        let stdout = format!("__CLIORA_TOOL__\ncodex\n__CLIORA_STORE__\n{}\n__CLIORA_CONFIG__\n{}\n", b64(saved), b64(toml));
        let parsed = parse_resource_bundle("mcp", &["codex".into()], &stdout);
        let store = &parsed["stores"]["codex"];
        let entries = store["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "node_repl");
        assert_eq!(entries[0]["command"], "node");
        assert_eq!(entries[0]["args"][0], "repl.js");
        assert_eq!(entries[0]["env"]["TOKEN"], "synthetic-remote-key");
        assert_eq!(entries[0]["inLibrary"], true);
        assert_eq!(store["definitions"].as_array().unwrap().len(), 1);
        assert_eq!(store["definitions"][0]["name"], "node_repl");
        assert!(!parsed.to_string().contains("chrome-devtools"));
    }

    #[test]
    fn saving_mcp_replaces_only_the_server_table() {
        let original = "model = \"gpt-6-astra\"\nexperimental_bearer_token = \"synthetic-remote-key\"\n\n[mcp_servers.chrome-devtools-mcp]\ncommand = \"npx\"\n";
        let cleared = String::from_utf8(render_toml_mcp(original, &serde_json::json!({"entries": []})).unwrap()).unwrap();
        assert!(cleared.contains("model = \"gpt-6-astra\""));
        assert!(cleared.contains("synthetic-remote-key"));
        assert!(!cleared.contains("chrome-devtools"));
        assert!(!cleared.contains("mcp_servers"));
        let written = String::from_utf8(render_toml_mcp(original, &serde_json::json!({"entries":[{"name":"node_repl","transport":"stdio","command":"node","args":["repl.js"],"enabled":true}]})).unwrap()).unwrap();
        assert!(written.contains("model = \"gpt-6-astra\""));
        assert!(written.contains("synthetic-remote-key"));
        assert!(written.contains("node_repl"));
        assert!(written.contains("repl.js"));
        assert!(!written.contains("chrome-devtools"));
    }

    #[test]
    fn one_ssh_skill_bundle_keeps_the_bundled_root_read_only() {
        let skill = "---\ndescription: Draw pictures\n---\nbody";
        let stdout = format!(
            "__CLIORA_TOOL__\ncodex\n__CLIORA_STORE__\n\n__CLIORA_SKILLS__\n__CLIORA_FILE__\n1\n/root/.codex/skills/.system/imagegen/SKILL.md\n{}\n__CLIORA_SKILLS_END__\n",
            b64(skill),
        );
        let parsed = parse_resource_bundle("skills", &["codex".into()], &stdout);
        let entry = &parsed["stores"]["codex"]["entries"][0];
        assert_eq!(entry["name"], "imagegen");
        assert_eq!(entry["source"], "read_only");
        assert!(parsed["stores"]["codex"]["documents"]["/root/.codex/skills/.system/imagegen/SKILL.md"].as_str().unwrap().contains("Draw pictures"));
    }

    #[test]
    fn resource_bundle_script_is_one_short_command() {
        let ids = ["codex", "claude_code", "grok", "cursor", "opencode"].map(str::to_owned).to_vec();
        for kind in ["mcp", "skills"] {
            let script = resource_bundle_script(&ids, kind);
            assert!(!script.contains('\n'), "{kind} script contains a real newline");
            assert!(script.len() < 24_000, "{kind} {}", script.len());
            assert!(ensure_remote_command(&script).is_ok(), "{kind}");
            assert!(script.contains("__CLIORA_TOOL__"));
            assert!(!script.contains("synthetic-skill-body"));
        }
    }

    #[test]
    fn skill_upload_keeps_the_document_on_stdin() {
        let marker = "synthetic-skill-body-not-a-secret";
        let body = marker.repeat(1500);
        assert!(body.len() > 32_000);
        let upload = prepare_upload(&[], &[("$HOME/.codex/skills/demo/SKILL.md".into(), body.as_bytes().to_vec())]).unwrap();
        assert!(!upload.command.contains(marker), "{}", upload.command);
        assert!(upload.command.len() < 4_000, "{}", upload.command.len());
        assert!(upload.command.contains("base64 -d"));
        let text = String::from_utf8(upload.stdin).unwrap();
        let mut lines = text.lines();
        let size: usize = lines.next().unwrap().parse().unwrap();
        let payload = lines.next().unwrap();
        assert_eq!(payload.len(), size);
        let decoded = base64::engine::general_purpose::STANDARD.decode(payload).unwrap();
        assert_eq!(decoded, body.as_bytes());
        assert!(lines.next().is_none());
    }

    #[test]
    fn an_overlong_remote_command_is_not_an_invalid_path() {
        let error = ensure_remote_command(&"x".repeat(32_001)).unwrap_err();
        match error {
            RemoteError::Transport { stage, detail } => {
                assert_eq!(stage, "command");
                assert_eq!(detail, "远程命令过长");
            }
            RemoteError::InvalidPath => panic!("a long command was reported as an invalid path"),
            other => panic!("unexpected {other}"),
        }
    }

    #[test]
    fn bundled_skill_root_wins_over_the_parent_directory() {
        let roots = vec![
            super::SkillScanRoot { relative: ".codex/skills".into(), read_only: false, detail: "远程主机目录".into() },
            super::SkillScanRoot { relative: ".codex/skills/.system".into(), read_only: true, detail: "Codex 捆绑 Skill，只读".into() },
        ];
        let path = "/root/.codex/skills/.system/imagegen/SKILL.md";
        let index = super::skill_root_index(path, &roots);
        assert!(roots[index].read_only);
        assert_eq!(super::skill_description("---\ndescription: Draw pictures\n---\nbody"), "Draw pictures");
    }

    #[test]
    fn configured_plugins_stay_visible_when_the_list_command_fails() {
        let document = toml::from_str("enabled = true\n\n[plugins]\n\n[plugins.\"code-review@openai-bundled\"]\nenabled = true\n").unwrap();
        let entries = super::plugin_entries_from_document(&document);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "code-review@openai-bundled");
        assert_eq!(entries[0].enabled, Some(true));
        assert!(entries[0].read_only);
    }

    #[test]
    fn rejects_shell_sensitive_target_fields() {
        let target = RemoteTarget {
            id: String::new(),
            name: "test".into(),
            host: "host name".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        assert!(matches!(
            validate_target(&target),
            Err(RemoteError::InvalidHost)
        ));
    }

    #[test]
    fn saves_and_lists_target_and_project() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("remote.db")).unwrap();
        let target = save_target(
            &db,
            RemoteTarget {
                id: String::new(),
                name: "Test host".into(),
                host: "127.0.0.1".into(),
                port: 22,
                user: "root".into(),
                auth_method: "key".into(),
                identity_file: None,
                ssh_config: None,
                default_path: Some("/root".into()),
                enabled: true,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        assert_eq!(list_targets(&db).unwrap(), vec![target.clone()]);
        let project = save_project(
            &db,
            RemoteProject {
                id: String::new(),
                target_id: target.id.clone(),
                name: "demo".into(),
                path: "/root/demo".into(),
                preferred_tool: None,
                updated_at: 0,
            },
        )
        .unwrap();
        assert_eq!(list_projects(&db, Some(&target.id)).unwrap(), vec![project]);
    }

    #[test]
    fn probe_script_checks_default_path_without_invalid_test_separator() {
        let script = probe_script(Some("/srv/project"));
        assert!(script.contains("test -d '/srv/project'"));
        assert!(!script.contains("test -d --"));
    }

    #[test]
    fn connection_args_keep_key_mode_simple_and_password_mode_interactive() {
        let mut target = RemoteTarget {
            id: "fixture".into(),
            name: "fixture".into(),
            host: "example.test".into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: Some("C:/keys/id_ed25519".into()),
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        let key_args = connection_args(&target);
        assert!(key_args
            .windows(2)
            .any(|pair| pair[0] == "-i" && pair[1] == "C:/keys/id_ed25519"));
        // Unix OpenSSH can use a per-target Unix-domain control socket. The
        // Windows port does not support that socket type, so connection_args
        // intentionally omits multiplexing options there.
        #[cfg(not(windows))]
        {
            assert!(key_args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "ControlMaster=auto"));
            assert!(key_args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "ControlPersist=60"));
        }
        #[cfg(windows)]
        {
            assert!(!key_args.iter().any(|arg| arg.starts_with("Control")));
        }
        target.auth_method = "password".into();
        let password_args = connection_args(&target);
        assert!(password_args.contains(&"PreferredAuthentications=password".into()));
        assert!(password_args.contains(&"BatchMode=no".into()));
    }

    fn gate_target(host: &str) -> RemoteTarget {
        RemoteTarget {
            id: host.into(),
            name: host.into(),
            host: host.into(),
            port: 22,
            user: "root".into(),
            auth_method: "key".into(),
            identity_file: None,
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn exit_status(code: u32) -> std::process::ExitStatus {
        // Unix packs the exit code in the high byte of a wait status (`i32`).
        // Windows `from_raw` takes the process exit code itself (`u32`).
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw((code << 8) as i32)
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(code)
        }
    }

    #[test]
    fn a_server_closed_handshake_is_retried_and_authentication_is_not() {
        assert!(retryable_ssh_failure("Connection closed by 212.60.153.19 port 22", Some(255)));
        assert!(!retryable_ssh_failure("Permission denied (publickey).", Some(255)));
        assert!(!retryable_ssh_failure("REMOTE HOST IDENTIFICATION HAS CHANGED!", Some(255)));
        assert!(!retryable_ssh_failure("bash: no such file", Some(1)));

        let target = gate_target("retry-closed.invalid");
        let hits = std::sync::atomic::AtomicUsize::new(0);
        let output = run_ssh(&target, || {
            let attempt = hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(std::process::Output {
                status: exit_status(if attempt == 0 { 255 } else { 0 }),
                stdout: b"ok".to_vec(),
                stderr: if attempt == 0 { b"Connection closed by 203.0.113.10 port 22\n".to_vec() } else { Vec::new() },
            })
        })
        .unwrap();
        assert!(output.status.success());
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);

        let denied = gate_target("retry-denied.invalid");
        let denied_hits = std::sync::atomic::AtomicUsize::new(0);
        let output = run_ssh(&denied, || {
            denied_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(std::process::Output {
                status: exit_status(255),
                stdout: Vec::new(),
                stderr: b"Permission denied (publickey).\n".to_vec(),
            })
        })
        .unwrap();
        assert!(!output.status.success());
        assert_eq!(denied_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn ssh_slots_keep_a_third_connection_waiting() {
        let target = gate_target("gate-limit.invalid");
        let first = acquire_ssh_slot(&target).unwrap();
        let second = acquire_ssh_slot(&target).unwrap();
        let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = entered.clone();
        let host = target.host.clone();
        let handle = std::thread::spawn(move || {
            let waiting = gate_target(&host);
            let _third = acquire_ssh_slot(&waiting).unwrap();
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(80));
        assert!(!entered.load(std::sync::atomic::Ordering::SeqCst));
        drop(first);
        handle.join().unwrap();
        assert!(entered.load(std::sync::atomic::Ordering::SeqCst));
        drop(second);
    }

    #[test]
    fn a_full_ssh_gate_stops_waiting_instead_of_hanging() {
        let target = gate_target("gate-timeout.invalid");
        let first = acquire_ssh_slot(&target).unwrap();
        let second = acquire_ssh_slot(&target).unwrap();
        let error = match acquire_ssh_slot_within(&target, Duration::from_millis(40)) {
            Err(error) => error,
            Ok(_) => panic!("a full gate returned a slot"),
        };
        let message = error.to_string();
        assert!(message.contains("远程连接正忙"), "{message}");
        drop(first);
        drop(second);
    }

    #[test]
    fn a_command_that_does_not_exit_is_stopped() {
        const CHILD_MARKER: &str = "CLIORA_TEST_REMOTE_TIMEOUT_CHILD";
        if std::env::var_os(CHILD_MARKER).is_some() {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        // Run only this test in a child that waits beyond the deadline. Unlike
        // ping, the fixture needs no network permissions or platform-specific flags.
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "remote::tests::a_command_that_does_not_exit_is_stopped"])
            .env(CHILD_MARKER, "1");
        let error = wait_for_output(&mut command, Duration::from_millis(200)).unwrap_err();
        assert!(matches!(&error, RemoteError::Transport { stage: "timeout", .. }), "{error}");
        let message = error.to_string();
        assert!(message.contains("远程连接超时"), "{message}");
    }

    #[test]
    fn remote_rule_paths_come_from_the_adapter_and_stay_posix() {
        let codex = remote_rule_target("codex", crate::native::adapter::Scope::Global, None).unwrap();
        assert_eq!(codex, "$HOME/.codex/AGENTS.md");
        assert_eq!(remote_rule_target("codex", crate::native::adapter::Scope::Project, Some("/srv/project")).unwrap(), "/srv/project/AGENTS.md");
        let devin = remote_rule_target("devin", crate::native::adapter::Scope::Global, None).unwrap();
        assert_eq!(devin, "$HOME/.config/devin/AGENTS.md");
        assert!(!devin.contains("AppData"));
        assert!(remote_rule_target("grok", crate::native::adapter::Scope::Global, None).is_err());
        assert_eq!(remote_rule_target("grok", crate::native::adapter::Scope::Project, Some("/srv/project")).unwrap(), "/srv/project/AGENTS.md");
        assert!(remote_rule_target("codex", crate::native::adapter::Scope::Project, Some("C:\\Users\\work")).is_err());
    }

    #[test]
    fn remote_rule_read_and_upload_keep_the_body_off_the_command() {
        let marker = "synthetic-rule-body-not-a-secret";
        let script = rule_read_script(&["$HOME/.codex/AGENTS.md".into()], true).unwrap();
        assert!(!script.contains('\n'), "{script}");
        assert!(script.contains("__CLIORA_LIBRARY__"));
        assert!(script.contains("__CLIORA_RULE_STATE__"));
        assert!(script.contains("$HOME/.codex/AGENTS.md"));
        assert!(!script.contains(marker));
        let body = format!("# Keep\n\n{marker}\n");
        let upload = prepare_upload(&[], &[("$HOME/.codex/AGENTS.md".into(), body.as_bytes().to_vec()), ("$HOME/.cliora/rule-state.json".into(), b"{}".to_vec())]).unwrap();
        assert!(!upload.command.contains(marker), "{}", upload.command);
        let text = String::from_utf8(upload.stdin).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(text.lines().nth(1).unwrap()).unwrap();
        assert_eq!(decoded, body.as_bytes());
        let library = r#"[{"id":"rule-1","kind":"rule","title":"Keep","body":"stay remote","category":"","projectId":null,"version":1,"updatedAt":1}]"#;
        let state = r#"{"placements":[{"ruleId":"rule-1","toolId":"codex","scopeKey":"global","position":1}],"files":[]}"#;
        let stdout = format!("__CLIORA_LIBRARY__\n{}\n__CLIORA_RULE_STATE__\n{}\n__CLIORA_RULE_FILE__\n$HOME/.codex/AGENTS.md\n{}\n", b64(library), b64(state), b64(&body));
        let parsed = parse_rule_texts(&stdout, true).unwrap();
        assert_eq!(parsed.items[0].id, "rule-1");
        assert_eq!(parsed.items[0].body, "stay remote");
        assert_eq!(parsed.state.placements[0].tool_id, "codex");
        assert_eq!(parsed.texts["$HOME/.codex/AGENTS.md"], body);
    }
}
