//! Shared remote target and transport primitives.
//!
//! Remote support deliberately uses the user's OpenSSH installation instead of
//! embedding an SSH implementation. The adapter layer can build on these
//! target/project records without creating per-CLI SSH branches.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
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
pub mod operations;
pub mod read_cache;
pub mod transactions;

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
    let key = format!("load_resource_store:{:?}", (tool_id, kind,));
    let owned = target.clone();
    let tool_id = tool_id.to_owned();
    let kind = kind.to_owned();
    read_cache::read(target, &key, false, move || load_resource_store_uncached(&owned, &tool_id, &kind))
}

fn load_resource_store_uncached(target: &RemoteTarget, tool_id: &str, kind: &str) -> Result<serde_json::Value, RemoteError> {
    if !valid_text(tool_id, 120) || !valid_text(kind, 80) || !tool_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) || !kind.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        return Err(RemoteError::InvalidPath);
    }
    // MCP shown as "当前生效" is whatever the CLI config contains. The Cliora
    // JSON file can remember library membership, but a stale copy must not
    // invent servers the native file does not have.
    if matches!(kind, "mcp" | "skills") {
        let bundle = load_resource_stores(target, &[tool_id.to_owned()], kind)?;
        return bundle
            .get("stores")
            .and_then(|stores| stores.get(tool_id))
            .cloned()
            .ok_or_else(|| RemoteError::Storage("远程 MCP 读取结果无效".into()));
    }
    let path = format!("$HOME/.cliora/resources/{tool_id}/{kind}.json");
    let result = run_command(target, &format!("if [ -f {path} ]; then base64 -w0 -- {path}; else printf %s __MISSING__; fi"))?;
    observe_encoded(&path, result.stdout.trim());
    let raw = decode_b64_text(result.stdout.trim()).unwrap_or_else(|| "{}".into());
    let stored: serde_json::Value = serde_json::from_str(&raw).map_err(|error| RemoteError::Storage(format!("远程资源格式无效：{error}")))?;
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
    let key = format!("load_resource_stores:{:?}", (tool_ids, kind,));
    let owned = target.clone();
    let tool_ids = tool_ids.to_vec();
    let kind = kind.to_owned();
    read_cache::read(target, &key, false, move || load_resource_stores_uncached(&owned, &tool_ids, &kind))
}

fn load_resource_stores_uncached(target: &RemoteTarget, tool_ids: &[String], kind: &str) -> Result<serde_json::Value, RemoteError> {
    if !valid_resource_token(kind, 80) || !matches!(kind, "mcp" | "skills") {
        return Err(RemoteError::InvalidPath);
    }
    let mut accepted = Vec::new();
    for tool_id in tool_ids {
        if !valid_resource_token(tool_id, 120) {
            return Err(RemoteError::InvalidPath);
        }
        if kind == "skills" { validate_remote_skills(skill_adapter(tool_id)?)?; }
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

fn skill_adapter(tool_id: &str) -> Result<&'static dyn crate::adapters::CliAdapter, RemoteError> {
    crate::adapters::Registry::builtins().get(tool_id)
        .ok_or_else(|| RemoteError::Storage("适配器未注册".into()))
}

fn validate_remote_skills(adapter: &dyn crate::adapters::CliAdapter) -> Result<(), RemoteError> {
    let roots = adapter.remote_skill_directories();
    if roots.is_empty() { return Err(RemoteError::Storage("此适配器不支持远程 Skills 读取".into())); }
    if roots.iter().any(|root| !safe_home_relative(root.relative)) { return Err(RemoteError::InvalidPath); }
    if let Some(write) = adapter.remote_resource_layout().skill_root {
        if !safe_home_relative(write) || !roots.iter().any(|root| root.relative == write && !root.read_only) {
            return Err(RemoteError::Storage("远程 Skills 写入目录未声明为可写读取目录".into()));
        }
    }
    Ok(())
}

fn adapter_skill_roots(adapter: &dyn crate::adapters::CliAdapter) -> Vec<SkillScanRoot> {
    adapter.remote_skill_directories().iter().filter(|root| safe_home_relative(root.relative))
        .map(|root| SkillScanRoot { relative: root.relative.into(), read_only: root.read_only, detail: root.detail.into() }).collect()
}

fn remote_skill_roots(tool_id: &str) -> Vec<SkillScanRoot> {
    skill_adapter(tool_id).map(adapter_skill_roots).unwrap_or_default()
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

fn assemble_skill_store(tool_id: &str, located: &[(usize, String)], contents: &BTreeMap<String, String>) -> serde_json::Value {
    let Ok(adapter) = skill_adapter(tool_id) else { return empty_resource_store("skills"); };
    assemble_adapter_skill_store(adapter, located, contents)
}

fn assemble_adapter_skill_store(adapter: &dyn crate::adapters::CliAdapter, located: &[(usize, String)], contents: &BTreeMap<String, String>) -> serde_json::Value {
    let roots = adapter_skill_roots(adapter);
    if roots.is_empty() { return empty_resource_store("skills"); }
    let mut documents = serde_json::Map::new();
    let entries = located.iter().take(128).map(|(index, path)| {
        let name = path.strip_suffix("/SKILL.md").and_then(|value| value.rsplit('/').next()).unwrap_or(path.as_str());
        let index = if roots.get(*index).is_some() { *index } else { skill_root_index(path, &roots) };
        let root = roots.get(index).unwrap_or(&roots[0]);
        let text = contents.get(path);
        if let Some(text) = text {
            // Materialization uses this canonical key too. An absolute scan
            // path and its HOME alias must not consume two baseline entries.
            if let Ok((canonical, _)) = adapter_skill_document_path(adapter, path) {
                transactions::observe(&canonical, Some(text.as_bytes()));
            }
            documents.insert(path.clone(), serde_json::Value::String(text.clone()));
        }
        let manifest = text.map(|value| crate::resources::skill_manifest::analyze(value, name));
        let issues = manifest.as_ref().map(|manifest| manifest.issue_codes()).unwrap_or_default();
        let description = manifest.map(|manifest| manifest.description).unwrap_or_default();
        let detail = if root.read_only {
            if description.is_empty() { root.detail.clone() } else { format!("{} · {description}", root.detail) }
        } else if description.is_empty() { root.detail.clone() } else { description };
        let source = if root.read_only { "read_only" } else { "writable" };
        let state = if root.read_only { "read_only" } else { "external" };
        serde_json::json!({"name": name, "path": path, "digest": null, "state": state, "detail": detail, "packageId": null, "source": source, "pluginName": null, "pluginEnabled": null, "issues": issues})
    }).collect::<Vec<_>>();
    serde_json::json!({"entries": entries, "documents": documents})
}

fn seed_remote_agents(target: &RemoteTarget, tool_id: &str) -> Result<serde_json::Value, RemoteError> {
    let mut capability = match crate::adapters::agents::capability(tool_id) {
        Ok(capability) => capability,
        Err(_) => return Ok(serde_json::json!({})),
    };
    if resource_layout(tool_id).agent_root.is_none() { capability.supported = false; capability.detail = "此适配器未声明远程 Agent 目录和格式"; }
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
        read_script.push_str(" | tr -d '\\n'; else printf %s __MISSING__; fi; printf '\\n'; ");
    }
    let encoded = if read_script.is_empty() { String::new() } else { run_command(target, &read_script)?.stdout };
    Ok(assemble_remote_agents(tool_id, &files, &encoded, capability, detail))
}

fn assemble_remote_agents(tool_id: &str, files: &[String], encoded: &str, capability: crate::adapters::agents::AgentCapability, detail: String) -> serde_json::Value {
    let extension = resource_layout(tool_id).agent_extension.unwrap_or("md");
    let mut lines = encoded.lines();
    let mut entries = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let marker = format!("__CLIORA_AGENT__{index}");
        if lines.next() != Some(marker.as_str()) { continue; }
        let Some(value) = lines.next() else { continue; };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(value.trim()) else { continue; };
        let Ok(content) = String::from_utf8(bytes) else { continue; };
        if let Some(root) = remote_agent_root(tool_id, "global", None) {
            let disabled = format!("{}/.cliora-disabled-agents/agents", root.trim_end_matches("/agents"));
            if let Some(canonical) = canonical_agent_path(path, &root).or_else(|| canonical_agent_path(path, &disabled)) { transactions::observe(&canonical, Some(content.as_bytes())); }
        }
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
    serde_json::json!({ "snapshot": snapshot })
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
    let previous = if matches!(kind, "agents" | "skills") { Some(load_resource_store(target, tool_id, kind)?) } else { None };
    let json = serde_json::to_vec_pretty(value).map_err(|error| RemoteError::Storage(error.to_string()))?;
    if json.len() > 8_000_000 { return Err(RemoteError::Storage("远程资源过大".into())); }
    let path = format!("$HOME/.cliora/resources/{tool_id}/{kind}.json");
    let mut upload = if kind == "mcp" {
        materialize_remote_mcp(target, tool_id, value)?
    } else if kind == "skills" {
        materialize_remote_skills(target, tool_id, previous.as_ref(), value)?
    } else if kind == "agents" {
        materialize_remote_agents(target, tool_id, previous.as_ref(), value)?
    } else { prepare_upload(&[], &[])? };
    upload.files.push((path, json));
    apply_upload(target, &upload)
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
    let root = skill_write_root(tool_id)?;
    entries.retain(|entry| entry.get("name").and_then(serde_json::Value::as_str) != Some(name.as_str()));
    let issues = documents.get("SKILL.md").map(|text| crate::resources::skill_manifest::analyze(text, &name).issue_codes()).unwrap_or_default();
    for (path, text) in documents {
        stored.insert(format!("{root}/{name}/{path}"), serde_json::Value::String(text));
    }
    entries.push(serde_json::json!({"name": name, "path": format!("{root}/{name}/SKILL.md"), "digest": null, "state": "external", "detail": description, "packageId": null, "source": "writable", "pluginName": null, "pluginEnabled": null, "issues": issues}));
    value = serde_json::json!({"entries": entries, "documents": stored});
    save_resource_store(target, tool_id, "skills", &value)
}

fn materialize_remote_mcp(target: &RemoteTarget, tool_id: &str, value: &serde_json::Value) -> Result<PreparedUpload, RemoteError> {
    let registry = crate::adapters::Registry::builtins();
    let adapter = registry.get(tool_id).ok_or_else(|| RemoteError::Storage("适配器未注册".into()))?;
    let path = mcp_seed_path(tool_id).ok_or_else(|| RemoteError::Storage("适配器未声明远程 MCP 能力".into()))?;
    let expr = remote_path_expr(&path);
    let raw = run_command(target, &format!("if [ -f {expr} ]; then cat {expr}; fi"))?;
    let text = adapter.render_remote_mcp(&raw.stdout, value).map_err(RemoteError::Storage)?;
    prepare_upload(&[], &[(path, text)])
}

/// Merge MCP servers into an existing TOML document.
///
/// `str::parse::<toml::Value>()` reads one value, not a document. A failed
/// parse used to be replaced with an empty table, so saving MCP could erase
/// the model and the API key. `toml_edit` replaces only `mcp_servers`.
#[cfg(test)]
fn render_toml_mcp(config_text: &str, value: &serde_json::Value) -> Result<Vec<u8>, RemoteError> { crate::adapters::remote_resources::render_toml_mcp_table(config_text, value, "mcp_servers").map_err(RemoteError::Storage) }





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

fn mcp_seed_path(tool_id: &str) -> Option<String> {
    resource_layout(tool_id).mcp.filter(|layout| safe_home_relative(layout.relative)).map(|layout| format!("$HOME/{}", layout.relative))
}







/// Native config decides which MCP servers are effective. Library metadata in
/// the Cliora store is kept only for names the CLI file still contains.
fn reconcile_mcp_store(tool_id: &str, stored: &serde_json::Value, config_text: &str) -> serde_json::Value {
    if mcp_seed_path(tool_id).is_none() {
        return empty_resource_store("mcp");
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
    crate::adapters::Registry::builtins().get(tool_id)?.parse_remote_mcp(config_text).ok()
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
        script.push_str(" | tr -d '\\n'; else printf %s __MISSING__; fi; printf '\\n'; ");
        if kind == "mcp" {
            script.push_str("printf '%s\\n' __CLIORA_CONFIG__; ");
            if let Some(path) = mcp_seed_path(tool_id) {
                script.push_str("if [ -f ");
                script.push_str(&path);
                script.push_str(" ]; then base64 < ");
                script.push_str(&path);
                script.push_str(" | tr -d '\\n'; else printf %s __MISSING__; fi; ");
            }
            script.push_str("printf '\\n'; ");
        } else if kind == "skills" {
            script.push_str("printf '%s\\n' __CLIORA_SKILLS__; ");
            for (index, root) in remote_skill_roots(tool_id).iter().enumerate() {
                append_skill_scan(&mut script, root, index);
            }
            script.push_str("printf '%s\\n' __CLIORA_SKILLS_END__; ");
        }
    }
    script
}

fn append_skill_scan(script: &mut String, root: &SkillScanRoot, index: usize) {
    let dir = format!("$HOME/{}", root.relative);
    // Check traversed parents too: an inaccessible parent must not look missing.
    script.push_str("parent=\"$HOME\"; ");
    for part in root.relative.split('/') {
        script.push_str(&format!("if [ -e \"$parent\" ] || [ -L \"$parent\" ]; then [ -d \"$parent\" ] && [ -r \"$parent\" ] && [ -x \"$parent\" ] || {{ printf '%s\\n' 'cliora:directory-access: Skills 父路径不是可读取和访问的目录，请检查文件类型、链接目标和权限。' >&2; exit 46; }}; fi; parent=\"$parent/{part}\"; "));
    }
    // find does not follow a command-line directory symlink by default. Reject
    // that root explicitly instead of reporting an empty successful inventory.
    script.push_str(&format!("if [ -e \"{dir}\" ] || [ -L \"{dir}\" ]; then if [ -L \"{dir}\" ]; then printf '%s\\n' 'cliora:directory-access: Skills 扫描根目录是符号链接，暂不支持读取。' >&2; exit 46; fi; [ -d \"{dir}\" ] && [ -r \"{dir}\" ] && [ -x \"{dir}\" ] || {{ printf '%s\\n' 'cliora:directory-access: Skills 根路径不是可读取和访问的目录，请检查文件类型和权限。' >&2; exit 46; }}; find \"{dir}\" -mindepth 2 -maxdepth 2 -type f -name SKILL.md -exec sh -c "));
    let body = format!("for file do encoded=$(base64 < \"$file\") || exit 46; printf '%s\\n' __CLIORA_FILE__ {index} \"$file\"; printf %s \"$encoded\" | tr -d '\\n'; printf '\\n'; done");
    script.push_str(&shell_quote(&body));
    script.push_str(" sh {} + || exit 46; fi; ");
}

fn observe_encoded(path: &str, encoded: &str) {
    if encoded == "__MISSING__" { transactions::observe(path, None); }
    else if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) { transactions::observe(path, Some(&bytes)); }
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
        observe_encoded(&format!("$HOME/.cliora/resources/{tool_id}/{kind}.json"), &store_b64);
        let stored = decode_b64_text(&store_b64).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        let value = if kind == "mcp" {
            let config = skip_marked_line(&mut lines, "__CLIORA_CONFIG__").unwrap_or_default();
            if let Some(path) = mcp_seed_path(tool_id) { observe_encoded(&path, &config); }
            let config_text = decode_b64_text(&config).unwrap_or_default();
            reconcile_mcp_store(tool_id, stored.as_ref().unwrap_or(&serde_json::json!({})), &config_text)
        } else if kind == "skills" {
            let live = skill_store_from_files(tool_id, &read_skill_section(&mut lines));
            reconcile_skill_metadata(tool_id, stored.as_ref(), live)
        } else { stored.unwrap_or_else(|| empty_resource_store(kind)) };
        stores.insert(tool_id.to_owned(), value);
    }
    for tool_id in tool_ids {
        stores.entry(tool_id.clone()).or_insert_with(|| empty_resource_store(kind));
    }
    serde_json::json!({ "stores": stores })
}

struct PreparedUpload {
    removes: Vec<String>,
    files: Vec<(String, Vec<u8>)>,
}

fn prepare_upload(removes: &[String], files: &[(String, Vec<u8>)]) -> Result<PreparedUpload, RemoteError> {
    Ok(PreparedUpload { removes: removes.to_vec(), files: files.to_vec() })
}

fn apply_upload(target: &RemoteTarget, upload: &PreparedUpload) -> Result<(), RemoteError> {
    transactions::commit(target, &upload.removes, &upload.files)
}

fn resource_layout(tool_id: &str) -> crate::adapters::RemoteResourceLayout {
    crate::adapters::Registry::builtins().get(tool_id).map(|a| a.remote_resource_layout()).unwrap_or_default()
}

fn adapter_skill_write_root(adapter: &dyn crate::adapters::CliAdapter) -> Result<String, RemoteError> {
    validate_remote_skills(adapter)?;
    let relative = adapter.remote_resource_layout().skill_root.ok_or_else(|| RemoteError::Storage("此适配器未声明远程 Skills 写入能力".into()))?;
    Ok(format!("$HOME/{relative}"))
}

fn skill_write_root(tool_id: &str) -> Result<String, RemoteError> {
    adapter_skill_write_root(skill_adapter(tool_id)?)
}

// Native documents and their hashes always come from the same actual scan.
// Management JSON contributes membership only; it cannot replace current bytes.
fn reconcile_skill_metadata(tool_id: &str, stored: Option<&serde_json::Value>, mut live: serde_json::Value) -> serde_json::Value {
    let previous = stored.and_then(|value| value.get("entries")).and_then(serde_json::Value::as_array);
    if let Some(entries) = live.get_mut("entries").and_then(serde_json::Value::as_array_mut) {
        for entry in entries {
            let path = entry.get("path").and_then(serde_json::Value::as_str).and_then(|path| skill_document_path(tool_id, path).ok()).map(|value| value.0);
            let prior = previous.into_iter().flatten().find(|old| old.get("path").and_then(serde_json::Value::as_str).and_then(|path| skill_document_path(tool_id, path).ok()).map(|value| value.0) == path);
            if let (Some(prior), Some(object)) = (prior, entry.as_object_mut()) {
                for key in ["packageId", "inLibrary", "digest"] {
                    if let Some(value) = prior.get(key) { object.insert(key.into(), value.clone()); }
                }
            }
        }
    }
    live
}

fn skill_document_path(tool_id: &str, path: &str) -> Result<(String, bool), RemoteError> {
    adapter_skill_document_path(skill_adapter(tool_id)?, path)
}

fn adapter_skill_document_path(adapter: &dyn crate::adapters::CliAdapter, path: &str) -> Result<(String, bool), RemoteError> {
    validate_remote_skills(adapter)?;
    let roots = adapter_skill_roots(adapter);
    let found = roots.iter().filter_map(|root| {
        let marker = format!("/{}/", root.relative);
        let relative = if path.starts_with('/') || path.starts_with("$HOME/") {
            path.split_once(&marker).map(|(_, relative)| relative)
        } else { path.strip_prefix(&format!("{}/", root.relative)) };
        relative.map(|relative| (root, relative))
    }).max_by_key(|(root, _)| root.relative.len());
    let (root, relative) = if let Some((root, relative)) = found {
        (format!("$HOME/{}", root.relative), relative)
    } else {
        if path.starts_with('/') || path.starts_with('$') { return Err(RemoteError::InvalidPath); }
        (adapter_skill_write_root(adapter)?, path)
    };
    if !relative_allowed(relative) { return Err(RemoteError::InvalidPath); }
    let destination = format!("{root}/{relative}");
    // Permissions belong to the final destination, including short aliases
    // relative to a writable root that contains a nested readonly directory.
    let read_only = roots.iter().filter(|root| destination.starts_with(&format!("$HOME/{}/", root.relative)))
        .max_by_key(|root| root.relative.len()).map(|root| root.read_only).ok_or(RemoteError::InvalidPath)?;
    Ok((destination, read_only))
}

fn canonical_skill_documents<'a>(adapter: &dyn crate::adapters::CliAdapter, value: &'a serde_json::Value) -> Result<BTreeMap<String, (bool, &'a str)>, RemoteError> {
    let documents = value.get("documents").and_then(serde_json::Value::as_object).ok_or_else(|| RemoteError::Storage("Skills 文档格式无效".into()))?;
    let mut canonical = BTreeMap::new();
    for (path, body) in documents {
        let text = body.as_str().ok_or(RemoteError::InvalidPath)?;
        if text.len() > 1_000_000 { return Err(RemoteError::InvalidPath); }
        let (destination, read_only) = adapter_skill_document_path(adapter, path)?;
        if let Some(previous) = canonical.insert(destination, (read_only, text)) {
            if previous != (read_only, text) { return Err(RemoteError::Storage("同一 Skills 文件的路径别名内容冲突".into())); }
        }
    }
    Ok(canonical)
}

fn materialize_remote_skills(_target: &RemoteTarget, tool_id: &str, previous: Option<&serde_json::Value>, value: &serde_json::Value) -> Result<PreparedUpload, RemoteError> {
    materialize_adapter_skills(skill_adapter(tool_id)?, previous, value)
}

fn materialize_adapter_skills(adapter: &dyn crate::adapters::CliAdapter, previous: Option<&serde_json::Value>, value: &serde_json::Value) -> Result<PreparedUpload, RemoteError> {
    validate_remote_skills(adapter)?;
    let documents = canonical_skill_documents(adapter, value)?;
    let old = previous.map(|value| canonical_skill_documents(adapter, value)).transpose()?.unwrap_or_default();
    let mut upload = prepare_upload(&[], &[])?;
    for (path, (read_only, _)) in &old {
        if !documents.contains_key(path) {
            if *read_only { return Err(RemoteError::Storage("只读 Skills 目录不能删除".into())); }
            upload.removes.push(path.clone());
        }
    }
    for (destination, (read_only, text)) in documents {
        if read_only {
            if old.get(&destination) != Some(&(true, text)) { return Err(RemoteError::Storage("只读 Skills 目录不能修改".into())); }
        } else {
            upload.files.push((destination, text.as_bytes().to_vec()));
        }
    }
    Ok(upload)
}

/// Write remote agent definitions into the selected CLI's native directory.
/// The JSON resource file is only the transport/cache; keeping the native file
/// in place is what makes a newly started remote CLI actually load the agent.
fn materialize_remote_agents(
    _target: &RemoteTarget,
    tool_id: &str,
    previous: Option<&serde_json::Value>,
    value: &serde_json::Value,
) -> Result<PreparedUpload, RemoteError> {
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
    let disabled = format!("{}/.cliora-disabled-agents/agents", root.trim_end_matches("/agents"));
    let mut removes = Vec::new();
    for old in &previous_entries {
        if old.get("readOnly").and_then(serde_json::Value::as_bool) == Some(true) { continue; }
        if let Some(path) = old.get("path").and_then(serde_json::Value::as_str).and_then(|path| canonical_agent_path(path, &root).or_else(|| canonical_agent_path(path, &disabled))) {
            removes.push(path);
        }
    }
    let mut files = Vec::new();
    for entry in entries {
        if entry.get("readOnly").and_then(serde_json::Value::as_bool) == Some(true) {
            if !previous_entries.contains(&entry) { return Err(RemoteError::Storage("只读 Agent 定义不能修改".into())); }
            continue;
        }
        let Some(content) = entry.get("content").and_then(serde_json::Value::as_str) else { continue; };
        if content.len() > 256 * 1024 { return Err(RemoteError::InvalidPath); }
        let name = entry.get("name").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !valid_agent_name(name) { return Err(RemoteError::InvalidPath); }
        let extension = resource_layout(tool_id).agent_extension.ok_or_else(|| RemoteError::Storage("此适配器未声明远程 Agent 格式".into()))?;
        let enabled = entry.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
        let destination = if enabled { &root } else { &disabled };
        let generated = format!("{destination}/{name}.{extension}");
        let path = entry.get("path").and_then(serde_json::Value::as_str).and_then(|path| canonical_agent_path(path, destination)).unwrap_or(generated);
        files.push((path, content.as_bytes().to_vec()));
    }
    prepare_upload(&removes, &files)
}

fn valid_agent_name(name: &str) -> bool {
    valid_text(name, 120) && name != "." && name != ".." && name.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn remote_agent_root(tool_id: &str, scope: &str, project: Option<&str>) -> Option<String> {
    let dir = resource_layout(tool_id).agent_root?;
    if !safe_home_relative(dir) { return None; }
    if scope == "project" {
        let project = project?.trim();
        if !valid_text(project, 4096) || project.starts_with('~') || project.contains('\0') { return None; }
        Some(format!("{project}/{dir}"))
    } else {
        Some(format!("$HOME/{dir}"))
    }
}

fn canonical_agent_path(path: &str, root: &str) -> Option<String> {
    if remote_agent_path_allowed(path, root) { return Some(path.to_owned()); }
    let relative_root = root.strip_prefix("$HOME/")?;
    let (_, suffix) = path.split_once(&format!("/{relative_root}/"))?;
    let normalized = format!("{root}/{suffix}");
    remote_agent_path_allowed(&normalized, root).then_some(normalized)
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

struct ResolvedNativeDocument {
    role: &'static str,
    path: String,
    format: &'static str,
}

fn relative_allowed(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.starts_with('/')
        && !relative.ends_with('/')
        && !relative.contains("//")
        && !relative.contains("..")
        && relative.split('/').all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
}

fn project_allowed(project: &str) -> bool {
    valid_text(project, 4096)
        && project.starts_with('/')
        && !project.contains("..")
        && !project.contains('~')
        && !project.contains('$')
}

fn resolved_native_documents(tool_id: &str, scope: &str, project: Option<&str>) -> Result<Vec<ResolvedNativeDocument>, RemoteError> {
    let Some(adapter) = crate::adapters::Registry::builtins().get(tool_id) else { return Ok(Vec::new()); };
    let mut documents = Vec::new();
    let mut seen = HashSet::new();
    for document in adapter.remote_native_documents() {
        if document.scope != scope { continue; }
        if !matches!(document.format, "json" | "jsonc" | "toml" | "yaml") || !relative_allowed(document.relative) || !document.role.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return Err(RemoteError::InvalidPath);
        }
        if !seen.insert(document.role) { return Err(RemoteError::InvalidPath); }
        let path = if scope == "global" {
            format!("$HOME/{}", document.relative)
        } else if scope == "project" {
            let project = project.unwrap_or("").trim();
            if !project_allowed(project) { return Err(RemoteError::InvalidPath); }
            format!("{}/{}", project.trim_end_matches('/'), document.relative)
        } else {
            return Err(RemoteError::InvalidPath);
        };
        documents.push(ResolvedNativeDocument { role: document.role, path, format: document.format });
    }
    Ok(documents)
}

/// TOML settings documents stay the seed for remote MCP and plugin readers.
/// A JSON settings file, such as Claude's, is not that document.
fn native_config_path(tool_id: &str) -> Option<String> {
    resolved_native_documents(tool_id, "global", None).ok()?.into_iter().find(|document| document.role == "settings" && document.format == "toml").map(|document| document.path)
}

fn native_read_script(documents: &[ResolvedNativeDocument]) -> Result<String, RemoteError> {
    let mut script = String::from("set +e; ");
    for document in documents {
        script.push_str("printf '%s\\n' ");
        script.push_str(&shell_quote(&format!("__CLIORA_NATIVE__{}", document.role)));
        script.push_str("; if [ -f ");
        script.push_str(&remote_path_expr(&document.path));
        script.push_str(" ]; then printf '%s\\n' present; base64 -w0 -- ");
        script.push_str(&remote_path_expr(&document.path));
        script.push_str("; printf '\\n'; else printf '%s\\n' missing; fi; ");
    }
    ensure_remote_command(&script)?;
    Ok(script)
}

fn parse_native_read(roles: &[&str], stdout: &str) -> Result<BTreeMap<String, String>, RemoteError> {
    let mut lines = stdout.lines();
    let mut files = BTreeMap::new();
    for role in roles {
        let marker = lines.next().unwrap_or("");
        if marker != format!("__CLIORA_NATIVE__{role}") {
            return Err(RemoteError::Transport { stage: "remote_config", detail: "远程原生配置响应无法解析".into() });
        }
        match lines.next().unwrap_or("") {
            "missing" => {}
            "present" => {
                let encoded = lines.next().unwrap_or("");
                let text = if encoded.is_empty() {
                    String::new()
                } else {
                    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程原生配置编码无效".into() })?;
                    String::from_utf8(bytes).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程原生配置不是 UTF-8".into() })?
                };
                files.insert((*role).to_owned(), text);
            }
            _ => return Err(RemoteError::Transport { stage: "remote_config", detail: "远程原生配置响应无法解析".into() }),
        }
    }
    Ok(files)
}

pub fn read_scope_native(target: &RemoteTarget, tool_id: &str, scope: &str, project: Option<&str>) -> Result<BTreeMap<String, String>, RemoteError> {
    let key = format!("read_scope_native:{:?}", (tool_id, scope, project,));
    let owned = target.clone();
    let tool_id = tool_id.to_owned();
    let scope = scope.to_owned();
    let project = project.map(str::to_owned);
    read_cache::read(target, &key, false, move || read_scope_native_uncached(&owned, &tool_id, &scope, project.as_deref()))
}

fn read_scope_native_uncached(target: &RemoteTarget, tool_id: &str, scope: &str, project: Option<&str>) -> Result<BTreeMap<String, String>, RemoteError> {
    let documents = resolved_native_documents(tool_id, scope, project)?;
    if documents.is_empty() { return Ok(BTreeMap::new()); }
    let script = native_read_script(&documents)?;
    let result = run_command(target, &script)?;
    let roles: Vec<&str> = documents.iter().map(|document| document.role).collect();
    let mut files = parse_native_read(&roles, &result.stdout)?;
    for document in &documents { transactions::observe(&document.path, files.get(document.role).map(|v| v.as_bytes())); }
    for document in &documents {
        if let Some(text) = files.get_mut(document.role) {
            if text.is_empty() && matches!(document.format, "json" | "jsonc") {
                *text = "{}".into();
            }
        }
    }
    Ok(files)
}

fn prepare_scope_native(tool_id: &str, scope: &str, project: Option<&str>, files: &BTreeMap<String, String>) -> Result<PreparedUpload, RemoteError> {
    let documents = resolved_native_documents(tool_id, scope, project)?;
    let mut payload = Vec::new();
    if files.keys().any(|role| !documents.iter().any(|document| document.role == role)) { return Err(RemoteError::Storage("适配器未声明此远程原生文档；没有写入任何文件".into())); }
    for document in documents {
        let Some(text) = files.get(document.role) else { continue; };
        if text.len() > 1_000_000 { return Err(RemoteError::Storage("远程原生配置过大".into())); }
        payload.push((document.path, text.as_bytes().to_vec()));
    }
    prepare_upload(&[], &payload)
}

pub fn write_scope_native(target: &RemoteTarget, tool_id: &str, scope: &str, project: Option<&str>, files: &BTreeMap<String, String>) -> Result<(), RemoteError> {
    apply_upload(target, &prepare_scope_native(tool_id, scope, project, files)?)
}

fn remote_store_path(tool_id: &str) -> Result<String, RemoteError> {
    if !valid_text(tool_id, 120) || tool_id.chars().any(|ch| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!("$HOME/.cliora/registered-tools/{tool_id}.json"))
}

pub fn load_tool_store(target: &RemoteTarget, tool_id: &str) -> Result<RemoteToolStore, RemoteError> {
    let key = format!("load_tool_store:{:?}", (tool_id,));
    let owned = target.clone();
    let tool_id = tool_id.to_owned();
    read_cache::read(target, &key, false, move || load_tool_store_uncached(&owned, &tool_id))
}

fn load_tool_store_uncached(target: &RemoteTarget, tool_id: &str) -> Result<RemoteToolStore, RemoteError> {
    let path = remote_store_path(tool_id)?;
    let result = run_command(target, &format!("if [ -f {path} ]; then base64 -w0 -- {path}; else printf %s __MISSING__; fi"))?;
    let text = result.stdout.trim();
    observe_encoded(&path, text);
    let mut store = if text == "__MISSING__" || text.is_empty() { RemoteToolStore::default() } else {
        let bytes = base64::engine::general_purpose::STANDARD.decode(text).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程配置文件编码无效".into() })?;
        serde_json::from_slice(&bytes).map_err(|_| RemoteError::Transport { stage: "remote_config", detail: "远程配置文件格式无效".into() })?
    };
    let native = read_scope_native(target, tool_id, "global", None)?;
    if !native.is_empty() { store.current_files = native; }
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
    let mut upload = if write_native { prepare_scope_native(tool_id, "global", None, &store.current_files)? } else { prepare_upload(&[], &[])? };
    upload.files.push((path, bytes));
    apply_upload(target, &upload)
}

pub fn load_scoped_tool_store(target: &RemoteTarget, tool_id: &str, scope: &str, project: Option<&str>) -> Result<RemoteToolStore, RemoteError> {
    let key = format!("load_scoped_tool_store:{:?}", (tool_id, scope, project,));
    let owned = target.clone();
    let tool_id = tool_id.to_owned();
    let scope = scope.to_owned();
    let project = project.map(str::to_owned);
    read_cache::read(target, &key, false, move || load_scoped_tool_store_uncached(&owned, &tool_id, &scope, project.as_deref()))
}

fn load_scoped_tool_store_uncached(target: &RemoteTarget, tool_id: &str, scope: &str, project: Option<&str>) -> Result<RemoteToolStore, RemoteError> {
    let mut store = load_tool_store(target, tool_id)?;
    if scope == "project" {
        store.current_files = read_scope_native(target, tool_id, "project", project)?;
    }
    Ok(store)
}

/// Project application writes the project files and keeps the global file in use.
pub fn save_scoped_tool_store(target: &RemoteTarget, tool_id: &str, store: &RemoteToolStore, scope: &str, project: Option<&str>) -> Result<(), RemoteError> {
    if scope == "project" {
        let mut upload = prepare_scope_native(tool_id, "project", project, &store.current_files)?;
        let mut persisted = load_tool_store(target, tool_id)?;
        persisted.profiles = store.profiles.clone();
        persisted.common = store.common.clone();
        let bytes = serde_json::to_vec_pretty(&persisted).map_err(|e| RemoteError::Storage(e.to_string()))?;
        upload.files.push((remote_store_path(tool_id)?, bytes));
        return apply_upload(target, &upload);
    }
    save_tool_store(target, tool_id, store)
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
    let key = format!("probe_clis:{:?}", (tools,));
    let owned = target.clone();
    let tools = tools.to_vec();
    read_cache::read(target, &key, false, move || probe_clis_uncached(&owned, &tools))
}

fn probe_clis_uncached(target: &RemoteTarget, tools: &[(String, String)]) -> Result<Vec<RemoteCliProbe>, RemoteError> {
    validate_target(target)?;
    if tools.is_empty() { return Ok(Vec::new()); }
    let mut script = format!("set +e; {REMOTE_USER_PATH}; ");
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

#[derive(Clone, Debug)]
pub enum RemoteError {
    Operation(operations::Failure),
    InvalidName,
    InvalidHost,
    InvalidUser,
    InvalidPath,
    NotFound,
    Disabled,
    Transport { stage: &'static str, detail: String },
    Storage(String),
}

impl std::error::Error for RemoteError {}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Operation(failure) => failure.fmt(formatter),
            Self::Transport { stage, detail } => {
                let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Write, Duration::from_secs(40)));
                context.failure(stage, detail).fmt(formatter)
            }
            Self::InvalidName => write!(formatter, "远程目标名称不能为空"),
            Self::InvalidHost => write!(formatter, "远程主机地址无效"),
            Self::InvalidUser => write!(formatter, "远程用户无效"),
            Self::InvalidPath => write!(formatter, "远程路径无效"),
            Self::NotFound => write!(formatter, "远程目标不存在"),
            Self::Disabled => write!(formatter, "远程 SSH 功能尚未启用，请在设置中开启"),
            Self::Storage(detail) => write!(formatter, "{detail}"),
        }
    }
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

/// Native installers record `~/.local/bin` in bashrc. Remote commands run
/// through a non-interactive login shell, and Debian dash does not read bashrc.
pub(crate) const REMOTE_USER_PATH: &str = "export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\"";

/// One-line Linux package install used before a persistent session or a remote
/// CLI install. Existing tmux or screen skips it. `sudo -n` never waits for a
/// password; a failed install leaves the caller to report the missing tool.
pub(crate) const LINUX_TMUX_INSTALL: &str = "if ! command -v tmux >/dev/null 2>&1 && ! command -v screen >/dev/null 2>&1 && [ \"$(uname -s)\" = Linux ]; then if [ \"$(id -u)\" -eq 0 ]; then CLIORA_PRIV=; elif command -v sudo >/dev/null 2>&1; then CLIORA_PRIV='sudo -n'; else CLIORA_PRIV=:; fi; if command -v apt-get >/dev/null 2>&1; then $CLIORA_PRIV env DEBIAN_FRONTEND=noninteractive apt-get update -qq && $CLIORA_PRIV env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux; elif command -v dnf >/dev/null 2>&1; then $CLIORA_PRIV dnf install -y tmux; elif command -v yum >/dev/null 2>&1; then $CLIORA_PRIV yum install -y tmux; elif command -v pacman >/dev/null 2>&1; then $CLIORA_PRIV pacman -Sy --noconfirm tmux; elif command -v apk >/dev/null 2>&1; then $CLIORA_PRIV apk add --no-cache tmux; elif command -v zypper >/dev/null 2>&1; then $CLIORA_PRIV zypper --non-interactive install tmux; fi; hash -r 2>/dev/null || true; fi";

pub(crate) fn with_remote_user_path(command: &str) -> String {
    format!("{REMOTE_USER_PATH}; {command}")
}

pub(crate) fn with_linux_session_prep(command: &str) -> String {
    format!("{LINUX_TMUX_INSTALL}; {REMOTE_USER_PATH}; {command}")
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
///
/// Callers must not prepend another `ConnectTimeout` or `ServerAlive*` value:
/// OpenSSH keeps the first `-o` for each option. Key mode also skips GSSAPI and
/// password negotiation, which otherwise add a round trip — or a multi-second
/// Kerberos timeout — on every new connection.
pub fn connection_args(target: &RemoteTarget) -> Vec<String> {
    let mut args = vec![
        "-o".into(),
        "StrictHostKeyChecking=yes".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
        // A dead route should fail the TCP connect. A jittery one should survive
        // several missed keepalives (15s × 4) before the session is dropped.
        "-o".into(),
        "ConnectTimeout=12".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=4".into(),
        // Some long-haul networks drop the interactive DSCP mark and then stall.
        "-o".into(),
        "IPQoS=none".into(),
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
            "-o".into(),
            "GSSAPIAuthentication=no".into(),
        ]);
    } else {
        args.extend([
            "-o".into(),
            "GSSAPIAuthentication=no".into(),
            "-o".into(),
            "PreferredAuthentications=publickey".into(),
        ]);
        if let Some(identity_file) = target
            .identity_file
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            // One chosen key. Trying every agent key is another round trip each,
            // and too many of them make sshd close the handshake.
            args.extend([
                "-o".into(),
                "IdentitiesOnly=yes".into(),
                "-i".into(),
                identity_file.into(),
            ]);
        }
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
    } else if exit_code == Some(255) && !detail.contains("__cliora_remote_started__") && (detail.contains("permission denied")
        || detail.contains("could not authenticate")
        || detail.contains("too many authentication failures"))
    {
        "authentication"
    } else if detail.contains("cliora:directory-missing") {
        "directory_missing"
    } else if detail.contains("cliora:directory-type") {
        "directory_type"
    } else if detail.contains("cliora:directory-access") {
        "directory_access"
    } else if detail.contains("cliora:remote-path-failed") {
        "remote_path"
    } else if detail.contains("permission denied") || detail.contains("operation not permitted") {
        "permission"
    } else if exit_code == Some(127) || detail.contains("cliora:missing-") {
        "dependency"
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
    let key = "library_json".to_owned();
    let owned = target.clone();

    read_cache::read(target, &key, false, move || library_json_uncached(&owned))
}

fn library_json_uncached(target: &RemoteTarget) -> Result<Vec<crate::library::LibraryItem>, RemoteError> {
    let result = run_command(target, "if [ -f \"$HOME/.cliora/library.json\" ]; then base64 -w0 -- \"$HOME/.cliora/library.json\"; else printf %s __MISSING__; fi")?;
    observe_encoded("$HOME/.cliora/library.json", result.stdout.trim());
    let text = decode_b64_text(result.stdout.trim()).unwrap_or_else(|| "[]".into());
    serde_json::from_str(&text).map_err(|error| RemoteError::Storage(format!("远程资料库格式无效：{error}")))
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
    let key = "list_rule_placements".to_owned();
    let owned = target.clone();

    read_cache::read(target, &key, false, move || list_rule_placements_uncached(&owned))
}

fn list_rule_placements_uncached(target: &RemoteTarget) -> Result<Vec<crate::resources::rules::RulePlacement>, RemoteError> {
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
        script.push_str("printf '%s\\n' __CLIORA_LIBRARY__; if [ -f \"$HOME/.cliora/library.json\" ]; then base64 < \"$HOME/.cliora/library.json\" | tr -d '\\n'; else printf %s __MISSING__; fi; printf '\\n'; printf '%s\\n' __CLIORA_RULE_STATE__; if [ -f \"$HOME/.cliora/rule-state.json\" ]; then base64 < \"$HOME/.cliora/rule-state.json\" | tr -d '\\n'; else printf %s __MISSING__; fi; printf '\\n'; ");
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
        script.push_str(" | tr -d '\\n'; else printf %s __MISSING__; fi; printf '\\n'; ");
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
        let library_encoded = lines.next().unwrap_or("");
        observe_encoded("$HOME/.cliora/library.json", library_encoded);
        let library_text = decode_b64_text(library_encoded).unwrap_or_else(|| "[]".into());
        let items = serde_json::from_str(&library_text).map_err(|error| RemoteError::Storage(format!("远程资料库格式无效：{error}")))?;
        if lines.next().map(|line| line.trim() != "__CLIORA_RULE_STATE__").unwrap_or(true) {
            return Err(RemoteError::Storage("远程规则记录格式无效".into()));
        }
        let state_encoded = lines.next().unwrap_or("");
        observe_encoded("$HOME/.cliora/rule-state.json", state_encoded);
        let state = match decode_b64_text(state_encoded) {
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
        let encoded = lines.next().unwrap_or("");
        observe_encoded(&path, encoded);
        let existing = decode_b64_text(encoded).unwrap_or_default();
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

pub fn save_target(db: &Database, target: RemoteTarget) -> Result<RemoteTarget, RemoteError> {
    save_target_with_auth_change(db, target, false)
}

pub fn save_target_with_auth_change(db: &Database, mut target: RemoteTarget, auth_changed: bool) -> Result<RemoteTarget, RemoteError> {
    validate_target(&target)?;
    if target.id.trim().is_empty() {
        target.id = Uuid::new_v4().to_string();
    }
    let timestamp = now();
    let previous = list_targets(db)?.into_iter().find(|value| value.id == target.id);
    let rename_revision = previous.filter(|value| {
        let mut comparison = target.clone(); comparison.name = value.name.clone(); comparison.created_at = value.created_at; comparison.updated_at = value.updated_at;
        !auth_changed && value.name != target.name && comparison == *value
    }).map(|value| value.updated_at);
    db.with_connection(|conn| {
        let existing: Option<i64> = conn
            .query_row("SELECT MAX(created_at,updated_at) FROM remote_targets WHERE id=?1", [&target.id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        target.created_at = if let Some(_) = existing { conn.query_row("SELECT created_at FROM remote_targets WHERE id=?1", [&target.id], |row| row.get(0)).map_err(|error| error.to_string())? } else { timestamp };
        target.updated_at = rename_revision.filter(|revision| Some(*revision) == existing).unwrap_or_else(|| existing.map(|previous| timestamp.max(previous.saturating_add(1))).unwrap_or(timestamp));
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
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Read, SSH_COMMAND_DEADLINE));
    operations::scoped(context, || probe_target_inner(target, target))
}

pub fn probe_target_using_credentials(target: &RemoteTarget, credentials: &RemoteTarget) -> Result<RemoteProbe, RemoteError> {
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Read, SSH_COMMAND_DEADLINE));
    operations::scoped(context, || probe_target_inner(target, credentials))
}

fn probe_target_inner(target: &RemoteTarget, credentials: &RemoteTarget) -> Result<RemoteProbe, RemoteError> {
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
        command.args(connection_args(target));
        password::apply(credentials, &mut command);
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

fn ssh_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    hide_console_window(&mut command);
    command.args(connection_args(target));
    password::apply(target, &mut command);
    command
}

fn sftp_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    hide_console_window(&mut command);
    command.args(["-q"]);
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
    #[cfg(test)]
    if let Some(output) = tests::local_transport(target, command_line, stdin_payload) { return Ok(output); }
    let command_line = format!("printf '%s\\n' '__CLIORA_REMOTE_STARTED__' >&2; {command_line}");
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

const SSH_COMMAND_DEADLINE: Duration = Duration::from_secs(40);

fn wait_for_output(command: &mut Command, deadline: Duration) -> Result<std::process::Output, RemoteError> {
    wait_for_output_with_stdin(command, deadline, None)
}

/// One bounded control attempt: a destructive session operation is never retried
/// automatically after a transport error, because it may already have executed.
pub(crate) fn run_session_control(binary: &Path, args: &[String], environment: &[(String, String)]) -> Result<std::process::Output, RemoteError> {
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Write, SSH_COMMAND_DEADLINE));
    let _slot = operations::acquire_bound(&context)?;
    let mut command = Command::new(binary);
    command.args(args).envs(environment.iter().map(|(key, value)| (key, value)));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    operations::scoped(context.clone(), || {
        let output = wait_for_output(&mut command, SSH_COMMAND_DEADLINE)?;
        if output.status.code() == Some(255) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(context.failure_with_exit(classify_ssh_failure(&stderr, output.status.code()), &format!("远程结束连接失败（退出码 255）：{}", stderr.trim()), output.status.code()));
        }
        Ok(output)
    })
}

fn wait_for_output_with_stdin(command: &mut Command, deadline: Duration, stdin_payload: Option<Vec<u8>>) -> Result<std::process::Output, RemoteError> {
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Write, deadline));
    context.check()?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if stdin_payload.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
    }
    let mut child = command.spawn().map_err(|_| context.failure("launch", "无法启动远程连接进程"))?;
    #[cfg(windows)]
    let mut process_job = {
        match crate::session_host::process_tree::Job::resume_child(&mut child) {
            Ok(job) => Some(job),
            Err(detail) => {
                let _ = child.kill(); let _ = child.wait();
                return Err(context.failure("launch", detail));
            }
        }
    };
    context.dispatched();
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
    let status = loop {
        let failure = context.check().err();
        if let Some(error) = failure {
            #[cfg(windows)]
            let cleaned = process_job.take().is_none_or(|job| job.terminate_and_wait());
            #[cfg(unix)]
            { let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status(); }
            let _ = child.kill(); let _ = child.wait();
            if let Some(task) = stdin_task.take() { let _ = task.join(); }
            let _ = stdout_task.join(); let _ = stderr_task.join();
            #[cfg(windows)]
            if !cleaned { return Err(context.failure("cleanup", "远程等待已停止，但无法确认本地子进程已全部回收")); }
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(10).min(context.remaining())),
            Err(_) => {
                #[cfg(windows)]
                let cleaned = process_job.take().is_none_or(|job| job.terminate_and_wait());
                #[cfg(unix)]
                { let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status(); }
                let _ = child.kill(); let _ = child.wait();
                if let Some(task) = stdin_task.take() { let _ = task.join(); }
                let _ = stdout_task.join(); let _ = stderr_task.join();
                #[cfg(windows)]
                if !cleaned { return Err(context.failure("cleanup", "进程等待失败，无法确认本地子进程已全部回收")); }
                return Err(context.failure("launch", "无法等待远程进程退出"));
            }
        }
    };
    // Close descendant handles before joining pipe readers. A child inherited
    // stdout must not keep an abandoned request alive after ssh itself exits.
    #[cfg(windows)]
    let cleaned = process_job.take().is_none_or(|job| job.terminate_and_wait());
    #[cfg(unix)]
    { let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).status(); }
    if let Some(task) = stdin_task.take() { let _ = task.join(); }
    let output = std::process::Output {
        status,
        stdout: stdout_task.join().unwrap_or_default(),
        stderr: stderr_task.join().unwrap_or_default(),
    };
    #[cfg(windows)]
    if !cleaned { return Err(context.failure("cleanup", "远程命令已返回，但无法确认本地子进程已全部回收；请核查结果")); }
    Ok(output)
}

const SSH_ATTEMPTS: u32 = 3;

#[cfg(test)]
fn acquire_ssh_slot(target: &RemoteTarget) -> Result<operations::Slot<'static>, RemoteError> {
    acquire_ssh_slot_within(target, SSH_COMMAND_DEADLINE)
}

#[cfg(test)]
fn acquire_ssh_slot_within(target: &RemoteTarget, wait: Duration) -> Result<operations::Slot<'static>, RemoteError> {
    operations::acquire(target, &operations::Context::local(operations::Kind::Read, wait))
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
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Write, SSH_COMMAND_DEADLINE));
    context.bind(target)?;
    operations::scoped(context.clone(), || {
        for attempt in 0..SSH_ATTEMPTS {
            let slot = operations::acquire(target, &context)?;
            context.check()?;
            let mut output = spawn()?;
            context.check()?;
            if output.status.success() {
                output.stderr = String::from_utf8_lossy(&output.stderr).replace("__CLIORA_REMOTE_STARTED__\n", "").into_bytes();
                return Ok(output);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stage = classify_ssh_failure(&stderr, output.status.code());
            if context.kind != operations::Kind::Read || attempt + 1 == SSH_ATTEMPTS
                || !retryable_ssh_failure(&stderr, output.status.code()) {
                return Err(context.failure_with_exit(stage, stderr.replace("__CLIORA_REMOTE_STARTED__\n", "").trim(), output.status.code()));
            }
            drop(slot);
            context.pause(ssh_retry_delay(attempt))?;
        }
        unreachable!("ssh attempts always return")
    })
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
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Read, SSH_COMMAND_DEADLINE));
    operations::scoped(context, || run_command_bytes_inner(target, command_line))
}

fn run_command_bytes_inner(target: &RemoteTarget, command_line: &str) -> Result<Vec<u8>, RemoteError> {
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub parent: String,
    pub items: Vec<String>,
    pub truncated: bool,
}

pub fn list_directories(target: &RemoteTarget, parent: &str) -> Result<DirectoryListing, RemoteError> {
    let key = format!("list_directories:{:?}", (parent,));
    let owned = target.clone();
    let parent = parent.to_owned();
    read_cache::read(target, &key, false, move || list_directories_uncached(&owned, &parent))
}

// A false `test -e` also means an ancestor cannot be searched. Preserve stat's
// actual failure rather than reporting an inaccessible existing path missing.
fn directory_parent_probe() -> &'static str {
    "if metadata=$(LC_ALL=C ls -Ldn -- \"$parent\" 2>&1); then \
     case \"$metadata\" in d*) ;; *) printf '%s\\n' 'cliora:directory-type: Path is not a directory' >&2; exit 45;; esac; \
     else case \"$metadata\" in \
     *'Permission denied') printf '%s\\n' 'Permission denied: cannot access directory or ancestor' >&2; exit 43;; \
     *'No such file or directory') printf '%s\\n' 'cliora:directory-missing: Directory does not exist' >&2; exit 44;; \
     *'Not a directory') printf '%s\\n' 'cliora:directory-type: Path is not a directory' >&2; exit 45;; \
     *) printf '%s\\n' 'cliora:directory-access: Cannot determine directory state' >&2; exit 46;; esac; fi;"
}

fn directory_list_command(parent: &str) -> Result<String, RemoteError> {
    if !valid_text(parent, 4096) || parent.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!(
        "parent={}; {} \
         if [ ! -r \"$parent\" ] || [ ! -x \"$parent\" ]; then printf '%s\\n' 'Permission denied: directory requires read and search access' >&2; exit 43; fi; \
         count=0; for entry in \"${{parent%/}}\"/* \"${{parent%/}}\"/.[!.]* \"${{parent%/}}\"/..?*; do \
         if [ -d \"$entry\" ]; then count=$((count + 1)); if [ \"$count\" -gt 200 ]; then printf '%s\\n' 'cliora:directory-truncated'; break; fi; printf '%s\\n' \"$entry\"; fi; done",
        shell_quote(parent), directory_parent_probe()))
}

fn list_directories_uncached(target: &RemoteTarget, parent: &str) -> Result<DirectoryListing, RemoteError> {
    let command = directory_list_command(parent)?;
    let result = run_command(target, &command)?;
    Ok(parse_directory_listing(parent, &result.stdout))
}

fn parse_directory_listing(parent: &str, stdout: &str) -> DirectoryListing {
    let mut items: Vec<String> = stdout.lines().map(ToOwned::to_owned).collect();
    let truncated = items.last().is_some_and(|line| line == "cliora:directory-truncated");
    if truncated { items.pop(); }
    DirectoryListing { parent: parent.into(), items, truncated }
}

fn directory_create_command(path: &str) -> Result<String, RemoteError> {
    if !valid_text(path, 4096) || path.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!(
        "path={}; parent=$(dirname -- \"$path\") || exit 45; {} \
         if [ ! -w \"$parent\" ] || [ ! -x \"$parent\" ]; then printf '%s\\n' 'Permission denied: parent requires write and search access' >&2; exit 43; fi; \
         mkdir -- \"$path\"", shell_quote(path), directory_parent_probe()))
}

/// Create one direct child of an existing writable directory. Do not silently
/// create a missing parent tree or treat an already existing path as a new one.
pub fn create_directory(target: &RemoteTarget, path: &str) -> Result<(), RemoteError> {
    let command = directory_create_command(path)?;
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
        let batch = format!("get {} -\n", remote_path.replace('\n', " "));
        wait_for_output_with_stdin(&mut command, SSH_COMMAND_DEADLINE, Some(batch.into_bytes()))
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
    use std::io::Write;

    // A target-bound local POSIX transport also follows shared-read workers.
    // It exercises public entry points without SSH, app state or global env.
    fn local_homes() -> &'static std::sync::Mutex<BTreeMap<String, String>> {
        static HOMES: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, String>>> = std::sync::OnceLock::new();
        HOMES.get_or_init(Default::default)
    }
    fn posix_output(script: &str) -> std::process::Output {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("wsl.exe"); command.args(["--exec", "sh", "-s"]); command
        } else { let mut command = Command::new("sh"); command.arg("-s"); command };
        hide_console_window(&mut command);
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("local POSIX transport");
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }
    pub(super) fn local_transport(target: &RemoteTarget, command: &str, stdin: Option<&[u8]>) -> Option<std::process::Output> {
        let home = local_homes().lock().unwrap().get(&operations::target_identity(target)).cloned();
        home.map(|home| {
            let script = if let Some(bytes) = stdin {
                assert_eq!(command, "sh -s");
                String::from_utf8(bytes.to_vec()).unwrap()
            } else { command.to_owned() };
            posix_output(&format!("export HOME={}\n{script}", shell_quote(&home)))
        })
    }
    pub(super) fn with_local_transport(target: &RemoteTarget, run: impl FnOnce(&str)) {
        let result = posix_output("mktemp -d /tmp/cliora-local-transport-XXXXXX");
        assert!(result.status.success());
        let home = String::from_utf8(result.stdout).unwrap().trim().to_owned();
        assert!(home.starts_with("/tmp/cliora-local-transport-") && home.rsplit('/').next().unwrap().chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        struct Cleanup(String, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                local_homes().lock().unwrap().remove(&self.1);
                assert!(posix_output(&format!("rm -rf -- {}", shell_quote(&self.0))).status.success());
            }
        }
        let identity = operations::target_identity(target);
        let _cleanup = Cleanup(home.clone(), identity.clone());
        assert!(local_homes().lock().unwrap().insert(identity, home.clone()).is_none());
        run(&home);
    }
    pub(super) fn write_with_versions(target: &RemoteTarget, versions: transactions::Versions, run: impl FnOnce()) {
        let request = operations::Request {
            request_id: Uuid::new_v4().to_string(), cancel_token: Uuid::new_v4().to_string(), target_id: target.id.clone(),
            target_revision: Some(target.updated_at), kind: operations::Kind::Write, priority: operations::Priority::Interactive,
            deadline_unix_ms: (SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() + 120_000) as u64,
            refresh: true, expected_files: versions,
        };
        let lease = operations::register("local-transport-test", request, operations::Kind::Write).unwrap();
        operations::scoped(lease.context.clone(), run);
    }

    #[test]
    fn missing_and_empty_resource_management_files_read_then_save_with_matching_versions() {
        let target = gate_target("first-resource.invalid");
        with_local_transport(&target, |_| {
            for kind in ["mcp", "skills"] {
                let path = format!("$HOME/.cliora/resources/codex/{kind}.json");
                for empty in [false, true] {
                    run_command(&target, &format!("rm -rf -- \"$HOME/.cliora\" \"$HOME/.codex\"; mkdir -p \"$HOME/.cliora/resources/codex\"; {}", if empty { format!(": > {}", remote_path_expr(&path)) } else { String::new() })).unwrap();
                    read_cache::invalidate(&target.id);
                    let context = operations::Context::local(operations::Kind::Read, Duration::from_secs(40));
                    let mut store = operations::scoped(context.clone(), || load_resource_store(&target, "codex", kind)).unwrap();
                    let versions = context.file_versions();
                    assert_eq!(versions[&path], if empty { transactions::digest(b"") } else { "missing".into() });
                    if kind == "skills" {
                        store["documents"] = serde_json::json!({"$HOME/.codex/skills/first/SKILL.md": "---\nname: first\ndescription: first skill\n---\nbody"});
                    } else {
                        store = serde_json::json!({"entries": [{"name": "first", "transport": "stdio", "command": "node", "args": []}]});
                    }
                    write_with_versions(&target, versions, || save_resource_store(&target, "codex", kind, &store).unwrap());
                    let saved = load_resource_store(&target, "codex", kind).unwrap();
                    assert_eq!(saved["entries"].as_array().unwrap().len(), 1, "{kind}, empty={empty}");
                }
            }
        });
    }

    #[test]
    fn two_full_skill_inventories_use_canonical_versions_and_allow_single_cli_save() {
        let target = gate_target("large-skills.invalid");
        with_local_transport(&target, |_| {
            run_command(&target, "for cli in codex grok; do i=0; while [ \"$i\" -lt 128 ]; do dir=\"$HOME/.$cli/skills/skill-$i\"; mkdir -p \"$dir\"; printf '%s\\n' '---' \"name: skill-$i\" 'description: fixture' '---' body > \"$dir/SKILL.md\"; i=$((i+1)); done; done").unwrap();
            let context = operations::Context::local(operations::Kind::Read, Duration::from_secs(40));
            let inventory = operations::scoped(context.clone(), || load_resource_stores(&target, &["codex".into(), "grok".into()], "skills")).unwrap();
            let versions = context.file_versions();
            assert_eq!(versions.len(), 258);
            assert!(versions.keys().all(|path| path.starts_with("$HOME/")));
            let mut store = inventory["stores"]["codex"].clone();
            assert_eq!(store["entries"].as_array().unwrap().len(), 128);
            let key = store["documents"].as_object().unwrap().keys().next().unwrap().clone();
            store["documents"][&key] = serde_json::json!("---\nname: changed\ndescription: changed\n---\nchanged body");
            write_with_versions(&target, versions, || save_resource_store(&target, "codex", "skills", &store).unwrap());
            assert!(run_command(&target, &format!("cat {}", remote_path_expr(&key))).unwrap().stdout.ends_with("changed body"));
        });
    }

    #[test]
    fn directory_errors_preserve_path_type_permission_and_authentication() {
        for (detail, code, stage) in [
            ("cliora:directory-missing: Directory does not exist", 44, "directory_missing"),
            ("cliora:directory-type: Path is not a directory", 45, "directory_type"),
            ("cliora:directory-access: Cannot determine directory state", 46, "directory_access"),
            ("Permission denied: directory requires read and search access", 43, "permission"),
            ("Permission denied (publickey,password)", 255, "authentication"),
        ] {
            assert_eq!(classify_ssh_failure(detail, Some(code)), stage);
        }
        assert!(directory_list_command("~/private").is_err());
        assert!(directory_create_command("/path\nother").is_err());
        let empty = parse_directory_listing("/empty", "");
        assert!(empty.items.is_empty() && !empty.truncated);
        let listing = parse_directory_listing("/parent", "/parent/ spaced name \ncliora:directory-truncated\n");
        assert_eq!(listing.items, ["/parent/ spaced name "]);
        assert!(listing.truncated);
    }

    #[test]
    fn directory_permissions_include_unsearchable_ancestors() {
        #[cfg(windows)]
        let mut command = {
            let Ok(distro) = std::env::var("CLIORA_TEST_WSL_DISTRO") else {
                eprintln!("Set CLIORA_TEST_WSL_DISTRO for the unprivileged POSIX permission fixture on Windows");
                return;
            };
            let mut command = Command::new("wsl.exe");
            command.args(["--distribution", &distro, "--user", "root", "--exec", "/bin/sh", "-s"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("/bin/sh");
            command.arg("-s");
            command
        };
        let root = format!("/tmp/cliora-directory-{}", Uuid::new_v4());
        let checks = [
            (directory_list_command(&format!("{root}/missing")).unwrap(), 44),
            (directory_list_command(&format!("{root}/file")).unwrap(), 45),
            (directory_list_command(&format!("{root}/denied")).unwrap(), 43),
            (directory_list_command(&format!("{root}/blocked/child")).unwrap(), 43),
            (directory_create_command(&format!("{root}/missing/new")).unwrap(), 44),
            (directory_create_command(&format!("{root}/file/new")).unwrap(), 45),
            (directory_create_command(&format!("{root}/denied/new")).unwrap(), 43),
            (directory_create_command(&format!("{root}/blocked/child/new")).unwrap(), 43),
        ];
        let mut script = format!(
            "root={}; mkdir -- \"$root\" || exit 80; chmod 755 \"$root\"; \
             cleanup() {{ chmod 755 \"$root/blocked\" \"$root/denied\"; rm -f -- \"$root/file\"; rmdir -- \"$root/blocked/child\" \"$root/blocked\" \"$root/denied\" \"$root\"; }}; trap cleanup EXIT; \
             mkdir -- \"$root/blocked\" \"$root/blocked/child\" \"$root/denied\"; : > \"$root/file\"; chmod 000 \"$root/blocked\" \"$root/denied\"; \
             if [ \"$(id -u)\" -eq 0 ]; then runner='runuser -u nobody --'; else runner=''; fi;\n", shell_quote(&root));
        for (index, (check, expected)) in checks.into_iter().enumerate() {
            script.push_str(&format!("$runner /bin/sh -c {} >/dev/null 2>\"$root/error\"; actual=$?; rm -f -- \"$root/error\"; if [ \"$actual\" -ne {expected} ]; then printf 'directory check {index}: expected {expected}, got %s\\n' \"$actual\" >&2; exit 81; fi;\n", shell_quote(&check)));
        }
        // Restore traversal and prove the child existed during both failures.
        script.push_str("chmod 755 \"$root/blocked\"; [ -d \"$root/blocked/child\" ] || exit 82; printf '8 directory permission cases passed\\n';\n");
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        hide_console_window(&mut command);
        let mut child = command.spawn().unwrap();
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    }

    #[test]
    fn directory_shell_distinguishes_empty_missing_file_and_bounded_children() {
        #[cfg(windows)]
        let shell = std::env::var("CLIORA_TEST_POSIX_SHELL").unwrap_or_else(|_| "C:/Program Files/Git/bin/bash.exe".into());
        #[cfg(not(windows))]
        let shell = "/bin/sh".to_owned();
        if !Path::new(&shell).exists() { eprintln!("POSIX shell unavailable; native directory checks still required"); return; }
        let fixture = tempfile::tempdir().unwrap();
        let parent = fixture.path().to_string_lossy().replace('\\', "/");
        let run = |script: &str| {
            let mut command = Command::new(&shell);
            command.args(["-c", script]);
            hide_console_window(&mut command);
            command.output().unwrap()
        };
        let empty = run(&directory_list_command(&parent).unwrap());
        assert!(empty.status.success(), "{}", String::from_utf8_lossy(&empty.stderr));
        assert!(empty.stdout.is_empty());
        let missing = run(&directory_list_command(&format!("{parent}/missing")).unwrap());
        assert_eq!(missing.status.code(), Some(44));
        std::fs::write(fixture.path().join("file"), b"fixture").unwrap();
        assert_eq!(run(&directory_list_command(&format!("{parent}/file")).unwrap()).status.code(), Some(45));
        let child = format!("{parent}/quoted ' space");
        assert!(run(&directory_create_command(&child).unwrap()).status.success());
        assert!(fixture.path().join("quoted ' space").is_dir());
        assert!(!run(&directory_create_command(&child).unwrap()).status.success(), "existing directory is not a new creation");
        assert_eq!(run(&directory_create_command(&format!("{parent}/missing/child")).unwrap()).status.code(), Some(44));
        assert_eq!(run(&directory_create_command(&format!("{parent}/file/child")).unwrap()).status.code(), Some(45));
        std::fs::create_dir(fixture.path().join(".hidden")).unwrap();
        let listed = run(&directory_list_command(&parent).unwrap());
        let listing = parse_directory_listing(&parent, &String::from_utf8(listed.stdout).unwrap());
        assert_eq!(listing.items.len(), 2);
        assert!(listing.items.iter().any(|item| item.ends_with("/.hidden")));
        for index in 0..201 { std::fs::create_dir(fixture.path().join(format!("child-{index}"))).unwrap(); }
        let bounded = run(&directory_list_command(&parent).unwrap());
        let listing = parse_directory_listing(&parent, &String::from_utf8(bounded.stdout).unwrap());
        assert_eq!(listing.items.len(), 200);
        assert!(listing.truncated);
    }

    #[test]
    fn controlled_operation_child() {
        let Ok(mode) = std::env::var("CLIORA_OPERATION_CHILD_MODE") else { return };
        let counter = std::env::var("CLIORA_OPERATION_COUNTER").unwrap();
        let mut file = std::fs::OpenOptions::new().append(true).create(true).open(&counter).unwrap();
        writeln!(file, "{}", std::process::id()).unwrap();
        drop(file);
        match mode.as_str() {
            "closed" | "write_drop" => { eprintln!("Connection closed by fixture"); std::process::exit(255); }
            "permission" => { eprintln!("cat: fixture: Permission denied"); std::process::exit(1); }
            "authentication" => { eprintln!("Permission denied (publickey)."); std::process::exit(255); }
            "tree" => {
                let mut command = operation_child("hang", Path::new(&counter));
                let _child = command.spawn().unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            _ => std::thread::sleep(Duration::from_secs(30)),
        }
    }

    fn operation_child(mode: &str, counter: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "remote::tests::controlled_operation_child", "--nocapture"])
            .env("CLIORA_OPERATION_CHILD_MODE", mode).env("CLIORA_OPERATION_COUNTER", counter);
        hide_console_window(&mut command);
        command
    }

    fn child_count(counter: &Path) -> usize {
        std::fs::read_to_string(counter).unwrap_or_default().lines().count()
    }

    #[test]
    fn process_faults_keep_permission_and_authentication_distinct_and_never_replay_writes() {
        let directory = tempfile::tempdir().unwrap();
        for (mode, expected, outcome) in [("write_drop", "connect", "unknown"), ("permission", "permission", "failed"), ("authentication", "authentication", "failed")] {
            let counter = directory.path().join(mode);
            let context = operations::Context::local(operations::Kind::Write, Duration::from_secs(3));
            let target = gate_target(&format!("{mode}.invalid"));
            let error = operations::scoped(context, || run_ssh(&target, || {
                wait_for_output(&mut operation_child(mode, &counter), SSH_COMMAND_DEADLINE)
            })).unwrap_err();
            let RemoteError::Operation(failure) = error else { panic!("missing typed failure") };
            assert_eq!(failure.stage, expected);
            assert_eq!(failure.outcome, outcome);
            assert_eq!(child_count(&counter), 1, "a mutation must never replay");
        }
    }

    #[test]
    fn read_retries_share_one_deadline_including_backoff() {
        let directory = tempfile::tempdir().unwrap();
        let counter = directory.path().join("attempts");
        let context = operations::Context::local(operations::Kind::Read, Duration::from_millis(350));
        let target = gate_target("read-deadline.invalid");
        let started = std::time::Instant::now();
        let error = operations::scoped(context, || run_ssh(&target, || {
            wait_for_output(&mut operation_child("closed", &counter), SSH_COMMAND_DEADLINE)
        })).unwrap_err();
        let RemoteError::Operation(failure) = error else { panic!("missing typed failure") };
        assert_eq!(failure.reason, "timeout");
        assert!(matches!(failure.stage.as_str(), "retry_wait" | "process_wait"));
        assert!((1..=2).contains(&child_count(&counter)));
        assert!(started.elapsed() < Duration::from_millis(1000));
        eprintln!("REMOTE_OPERATION_METRIC read_retry_deadline attempts={} elapsed_ms={}", child_count(&counter), started.elapsed().as_millis());
    }

    #[cfg(windows)]
    type ProcessObservation = std::os::windows::io::OwnedHandle;
    #[cfg(unix)]
    type ProcessObservation = u32;

    #[cfg(windows)]
    fn observe_process(pid: u32) -> ProcessObservation {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null(), "fixture process must still be running before cancellation");
        unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) }
    }
    #[cfg(unix)]
    fn observe_process(pid: u32) -> ProcessObservation { pid }

    #[cfg(windows)]
    fn process_alive(process: &ProcessObservation) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::WAIT_TIMEOUT, System::Threading::WaitForSingleObject};
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_TIMEOUT }
    }

    #[cfg(unix)]
    fn process_alive(process: &ProcessObservation) -> bool {
        Command::new("kill").args(["-0", &process.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
    }

    #[test]
    fn inflight_cancel_reclaims_the_child_tree_and_pipe_readers() {
        let directory = tempfile::tempdir().unwrap();
        let counter = directory.path().join("pids");
        let request = operations::Request {
            expected_files: BTreeMap::new(),
            refresh: false,
            request_id: Uuid::new_v4().to_string(), cancel_token: Uuid::new_v4().to_string(),
            target_id: "cancel-tree.invalid".into(), target_revision: None, kind: operations::Kind::Read,
            priority: operations::Priority::Interactive,
            deadline_unix_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 5000,
        };
        let lease = operations::register("process-test", request.clone(), operations::Kind::Read).unwrap();
        let cancellation_counter = counter.clone();
        let cancelling = std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while child_count(&cancellation_counter) < 2 && start.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(child_count(&cancellation_counter), 2, "fixture child and grandchild started");
            // Hold handles before termination. Reopening a PID afterwards can
            // observe an unrelated fixture that reused the released PID.
            let processes: Vec<_> = std::fs::read_to_string(&cancellation_counter).unwrap().lines()
                .map(|line| observe_process(line.parse().unwrap())).collect();
            let start = std::time::Instant::now();
            assert!(operations::cancel("process-test", &request.request_id, &request.cancel_token));
            (start, processes)
        });
        let context = lease.context.clone();
        let error = operations::scoped(context, || run_ssh(&gate_target("cancel-tree.invalid"), || {
            wait_for_output(&mut operation_child("tree", &counter), SSH_COMMAND_DEADLINE)
        })).unwrap_err();
        let (cancellation_at, processes) = cancelling.join().unwrap();
        let RemoteError::Operation(failure) = error else { panic!("missing typed failure") };
        assert_eq!(failure.reason, "cancelled");
        assert_eq!(failure.stage, "process_wait");
        assert!(cancellation_at.elapsed() < Duration::from_millis(1000));
        for process in &processes {
            assert!(!process_alive(process), "abandoned fixture process survived cancellation");
        }
        eprintln!("REMOTE_OPERATION_METRIC inflight_cancel descendants=2 elapsed_ms={}", cancellation_at.elapsed().as_millis());
    }

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
    fn linux_session_prep_is_a_single_remote_command() {
        let script = with_linux_session_prep("claude --version");
        assert!(!script.contains('\n'));
        assert!(script.contains("apt-get install -y tmux"));
        assert!(script.contains("dnf install -y tmux"));
        assert!(script.contains("pacman -Sy --noconfirm tmux"));
        assert!(script.contains("export PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\""));
        assert!(script.ends_with("claude --version"));
        assert!(ensure_remote_command(&script).is_ok());
        let probe = with_remote_user_path("'claude' '--version'");
        assert!(probe.starts_with("export PATH="));
        assert!(!probe.contains("apt-get"));
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
        assert_eq!(upload.files[0].1, body.as_bytes());
        assert!(upload.removes.is_empty());
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
    fn managed_skill_metadata_never_replaces_actual_document_bytes_or_versions() {
        use base64::Engine;
        let path = "/root/.codex/skills/owned/SKILL.md";
        let old = "---\nname: owned\ndescription: old\n---\nold body";
        let fresh = "---\nname: owned\ndescription: external\n---\nexternal body";
        let stored = serde_json::json!({"entries":[{"path":path,"packageId":"managed-package","inLibrary":true}],"documents":{path:old}});
        let stdout = format!("__CLIORA_TOOL__\ncodex\n__CLIORA_STORE__\n{}\n__CLIORA_SKILLS__\n__CLIORA_FILE__\n0\n{path}\n{}\n__CLIORA_SKILLS_END__\n", base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&stored).unwrap()), base64::engine::general_purpose::STANDARD.encode(fresh));
        let context = operations::Context::local(operations::Kind::Read, Duration::from_secs(3));
        let actual = operations::scoped(context.clone(), || parse_resource_bundle("skills", &["codex".into()], &stdout));
        assert_eq!(actual["stores"]["codex"]["documents"][path], fresh);
        assert_eq!(actual["stores"]["codex"]["entries"][0]["packageId"], "managed-package");
        assert_eq!(context.file_versions()["$HOME/.codex/skills/owned/SKILL.md"], transactions::digest(fresh.as_bytes()));
        assert!(!resource_bundle_script(&["codex".into()], "skills").contains("scan=0"));
    }

    #[test]
    fn actual_agent_paths_share_one_canonical_destination_for_save_disable_and_delete() {
        let target = RemoteTarget { id: "fixture".into(), name: "fixture".into(), host: "fixture.invalid".into(), port: 22, user: "root".into(), auth_method: "key".into(), identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 1 };
        let entry = serde_json::json!({"id":"owned","name":"owned","path":"/root/.codex/agents/owned.toml","content":"name = \"owned\"","enabled":true});
        let previous = serde_json::json!({"snapshot":{"entries":[entry],"target":{"scope":"global"}}});
        let saved = materialize_remote_agents(&target, "codex", Some(&previous), &previous).unwrap();
        assert_eq!(saved.removes, vec!["$HOME/.codex/agents/owned.toml"]);
        assert_eq!(saved.files[0].0, saved.removes[0]);
        let deleted = materialize_remote_agents(&target, "codex", Some(&previous), &serde_json::json!({"snapshot":{"entries":[]}})).unwrap();
        assert_eq!(deleted.removes, saved.removes);
        let mut disabled = previous.clone(); disabled["snapshot"]["entries"][0]["enabled"] = false.into();
        let disabled = materialize_remote_agents(&target, "codex", Some(&previous), &disabled).unwrap();
        assert_eq!(disabled.files[0].0, "$HOME/.codex/.cliora-disabled-agents/agents/owned.toml");
        assert_ne!(disabled.files[0].0, disabled.removes[0]);
    }

    #[test]
    fn agent_reload_uses_actual_native_content_and_matching_version() {
        use base64::Engine;
        let path = "/root/.codex/agents/owned.toml".to_owned();
        let fresh = "name = \"owned\"\ndescription = \"external\"\ndeveloper_instructions = \"external body\"\n";
        let encoded = format!("__CLIORA_AGENT__0\n{}\n", base64::engine::general_purpose::STANDARD.encode(fresh));
        let context = operations::Context::local(operations::Kind::Read, Duration::from_secs(3));
        let actual = operations::scoped(context.clone(), || assemble_remote_agents("codex", &[path.clone()], &encoded, crate::adapters::agents::capability("codex").unwrap(), "actual native reload".into()));
        assert_eq!(actual["snapshot"]["entries"][0]["content"], fresh);
        assert!(!context.file_versions().contains_key(&path), "absolute alias is not a second prerequisite");
        assert_eq!(context.file_versions()["$HOME/.codex/agents/owned.toml"], transactions::digest(fresh.as_bytes()));
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
        let located = vec![(index, path.to_owned())];
        let contents = BTreeMap::from([(path.to_owned(), "---\nname: imagegen\ndescription: >\n  Draw\n  pictures\n---\nbody".to_owned())]);
        let entry = super::assemble_skill_store("codex", &located, &contents)["entries"][0].clone();
        assert!(entry["detail"].as_str().unwrap().ends_with("Draw pictures"), "{entry}");
        assert_eq!(entry["issues"], serde_json::json!([]));
        let loose = BTreeMap::from([(path.to_owned(), "# no header".to_owned())]);
        assert_eq!(super::assemble_skill_store("codex", &located, &loose)["entries"][0]["issues"], serde_json::json!(["frontmatter_missing"]));
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
    fn claude_remote_native_settings_are_json_and_codex_stays_toml() {
        let global = resolved_native_documents("claude_code", "global", None).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].path, "$HOME/.claude/settings.json");
        assert_eq!(global[0].format, "json");
        let project = resolved_native_documents("claude_code", "project", Some("/src/project")).unwrap();
        assert_eq!(project.iter().map(|document| document.path.as_str()).collect::<Vec<_>>(), vec!["/src/project/.claude/settings.json", "/src/project/.claude/settings.local.json"]);
        assert!(resolved_native_documents("claude_code", "project", Some("/src/../etc")).is_err());
        assert!(native_config_path("claude_code").is_none());
        assert_eq!(native_config_path("codex").as_deref(), Some("$HOME/.codex/config.toml"));
        assert_eq!(native_config_path("grok").as_deref(), Some("$HOME/.grok/config.toml"));
        let script = native_read_script(&global).unwrap();
        assert!(!script.contains('\n'));
        assert!(script.contains("$HOME/.claude/settings.json"));
        assert!(ensure_remote_command(&script).is_ok());
        let body = b64("{\"theme\":\"dark\"}");
        let parsed = parse_native_read(&["settings"], &format!("__CLIORA_NATIVE__settings\npresent\n{body}\n")).unwrap();
        assert_eq!(parsed.get("settings").map(String::as_str), Some("{\"theme\":\"dark\"}"));
        let missing = parse_native_read(&["settings"], "__CLIORA_NATIVE__settings\nmissing\n").unwrap();
        assert!(missing.is_empty());
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
        let mut renamed = target.clone(); renamed.name = "renamed only".into();
        let renamed = save_target(&db, renamed).unwrap();
        assert_eq!(renamed.updated_at, target.updated_at);
        assert_eq!(operations::target_identity(&renamed), operations::target_identity(&target));
        let changed_auth = save_target_with_auth_change(&db, renamed.clone(), true).unwrap();
        assert!(changed_auth.updated_at > renamed.updated_at);
        let saved_again = save_target(&db, target.clone()).unwrap();
        assert_eq!(saved_again.created_at, target.created_at);
        assert!(saved_again.updated_at > target.updated_at, "authentication/configuration saves must advance identity even within one second");
    }

    #[test]
    fn probe_script_checks_default_path_without_invalid_test_separator() {
        let script = probe_script(Some("/srv/project"));
        assert!(script.contains("test -d '/srv/project'"));
        assert!(!script.contains("test -d --"));
    }

    fn has_option(args: &[String], option: &str) -> bool {
        args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == option)
    }

    #[test]
    fn connection_args_use_one_auth_method_and_tolerate_a_slow_path() {
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
        assert!(has_option(&key_args, "PreferredAuthentications=publickey"));
        assert!(has_option(&key_args, "GSSAPIAuthentication=no"));
        assert!(has_option(&key_args, "IdentitiesOnly=yes"));
        assert!(has_option(&key_args, "ConnectTimeout=12"));
        assert!(has_option(&key_args, "ServerAliveInterval=15"));
        assert!(has_option(&key_args, "ServerAliveCountMax=4"));
        assert!(has_option(&key_args, "IPQoS=none"));
        assert!(!has_option(&key_args, "PreferredAuthentications=password"));
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
        target.identity_file = None;
        let agent_args = connection_args(&target);
        assert!(has_option(&agent_args, "PreferredAuthentications=publickey"));
        assert!(!has_option(&agent_args, "IdentitiesOnly=yes"));
        assert!(!agent_args.windows(2).any(|pair| pair[0] == "-i"));
        target.auth_method = "password".into();
        target.identity_file = Some("C:/keys/id_ed25519".into());
        let password_args = connection_args(&target);
        assert!(password_args.contains(&"PreferredAuthentications=password".into()));
        assert!(password_args.contains(&"BatchMode=no".into()));
        assert!(has_option(&password_args, "GSSAPIAuthentication=no"));
        assert!(!has_option(&password_args, "PreferredAuthentications=publickey"));
        assert!(!has_option(&password_args, "IdentitiesOnly=yes"));
        assert!(!password_args.windows(2).any(|pair| pair[0] == "-i"));
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
        assert_eq!(classify_ssh_failure("__CLIORA_REMOTE_STARTED__\ncat: fixture: Permission denied", Some(255)), "permission");

        let target = gate_target("retry-closed.invalid");
        let hits = std::sync::atomic::AtomicUsize::new(0);
        let output = operations::scoped(operations::Context::local(operations::Kind::Read, SSH_COMMAND_DEADLINE), || run_ssh(&target, || {
            let attempt = hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(std::process::Output {
                status: exit_status(if attempt == 0 { 255 } else { 0 }),
                stdout: b"ok".to_vec(),
                stderr: if attempt == 0 { b"Connection closed by 203.0.113.10 port 22\n".to_vec() } else { Vec::new() },
            })
        }))
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
        .unwrap_err();
        assert!(matches!(output, RemoteError::Operation(failure) if failure.stage == "authentication"));
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
        assert!(message.contains("timeout"), "{message}");
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
        assert!(matches!(&error, RemoteError::Operation(failure) if failure.reason == "timeout"), "{error}");
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
        assert_eq!(upload.files[0].1, body.as_bytes());
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

#[cfg(test)]
#[path = "../../../tests/remote-skills.rs"]
mod remote_skill_tests;
