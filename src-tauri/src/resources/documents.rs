//! Resource text IPC: callers identify resources, never filesystem paths.
use std::path::Path;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{adapters::{McpLocation, Registry}, credentials::CredentialStore, database::Database, native::{format, transaction}};
use super::mcp::{self, McpDefinition, McpDraft, McpTargetRequest};

const MASK: &str = "__CLIORA_REDACTED__";
const MAX_TEXT: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDocumentRequest {
    pub target: McpTargetRequest,
    pub definition_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub reveal: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDocument {
    pub source: &'static str,
    pub format: &'static str,
    pub name: String,
    pub enabled: Option<bool>,
    pub text: String,
    /// Actual source file text, with only protected values replaced in-place.
    /// Read-only: saving this document still accepts only the selected entry.
    pub raw_text: Option<String>,
    pub raw_scope: Option<&'static str>,
    pub source_path: Option<String>,
    pub baseline: String,
    pub target_tool_id: String,
    pub protected_values: bool,
    pub unmapped_fields: Vec<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPasteItem {
    pub name: String,
    pub enabled: Option<bool>,
    pub draft: Option<McpDraft>,
    pub unmapped_fields: Vec<String>,
    pub diagnostics: Vec<String>,
}

fn sensitive(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["key", "token", "secret", "password", "authorization", "credential"].iter().any(|part| key.contains(part))
}

fn redact(adapter: &dyn crate::adapters::CliAdapter, value: &mut Value) -> bool {
    let mut changed = false;
    match value {
        Value::Object(map) => for (key, value) in map {
            if sensitive(key) && value.is_string() && !value.as_str().is_some_and(|text| adapter.mcp_is_reference(text)) {
                *value = Value::String(MASK.into()); changed = true;
            } else { changed |= redact(adapter, value); }
        },
        Value::Array(items) => for item in items { changed |= redact(adapter, item); },
        _ => (),
    }
    changed
}

fn raw_text(adapter: &dyn crate::adapters::CliAdapter, location: &McpLocation, text: &str, parsed: &Value, reveal: bool) -> Result<(String, bool), String> {
    if reveal { return Ok((text.into(), false)); }
    fn collect(adapter: &dyn crate::adapters::CliAdapter, value: &Value, path: &mut Vec<String>, output: &mut Vec<Vec<String>>) {
        match value {
            Value::Object(map) => for (key, child) in map {
                path.push(key.clone());
                if sensitive(key) && child.is_string() && !child.as_str().is_some_and(|text| adapter.mcp_is_reference(text)) { output.push(path.clone()); }
                else { collect(adapter, child, path, output); }
                path.pop();
            },
            // Formats with arrays cannot all patch indexed nested keys without
            // rewriting. Redact the parent array as a unit while retaining all
            // document text outside that field.
            Value::Array(_) => { let mut copy = value.clone(); if redact(adapter, &mut copy) { output.push(path.clone()); } },
            _ => (),
        }
    }
    let mut paths = Vec::new();
    collect(adapter, parsed, &mut Vec::new(), &mut paths);
    let mut output = text.to_owned();
    for path in &paths {
        let mut value = path.iter().try_fold(parsed, |v,k| v.get(k)).ok_or("原文保护字段定位失败")?.clone();
        if value.is_string() { value = Value::String(MASK.into()); } else { redact(adapter, &mut value); }
        if path.is_empty() { output = format::render(location.kind, &value)?; }
        else { output = format::set_path(location.kind, &output, path, Some(&value))?; }
    }
    Ok((output, !paths.is_empty()))
}

fn restore_masks(value: &mut Value, baseline: Option<&Value>) -> Result<(), String> {
    match value {
        Value::String(text) if text.contains(MASK) => {
            if text != MASK { return Err("遮罩不可作为配置值保存".into()); }
            *value = baseline.cloned().filter(Value::is_string).ok_or("新增条目不能保存遮罩值，请填写实际配置或环境变量引用")?;
        },
        Value::Object(map) => for (key, child) in map { restore_masks(child, baseline.and_then(|b| b.get(key)))?; },
        Value::Array(items) => for (index, child) in items.iter_mut().enumerate() { restore_masks(child, baseline.and_then(|b| b.get(index)))?; },
        _ => (),
    }
    Ok(())
}

fn leaf_changes(old: Option<&Value>, new: Option<&Value>, path: Vec<String>, output: &mut Vec<transaction::FieldChange>) {
    if old == new { return; }
    if let (Some(Value::Object(old)), Some(Value::Object(new))) = (old, new) {
        let keys: std::collections::BTreeSet<_> = old.keys().chain(new.keys()).collect();
        for key in keys { let mut path = path.clone(); path.push(key.clone()); leaf_changes(old.get(key), new.get(key), path, output); }
    } else { output.push(transaction::FieldChange { path, value: new.cloned() }); }
}

fn kind(location: &McpLocation) -> &'static str {
    match location.kind { format::FileKind::Json => "json", format::FileKind::Jsonc => "jsonc", format::FileKind::Toml => "toml", format::FileKind::Yaml => "yaml" }
}

fn baseline(target: &McpTargetRequest, location: &McpLocation, name: &str, text: &str) -> String {
    transaction::fingerprint(format!("{}\0{:?}\0{:?}\0{:?}\0{}\0{}\0{}", target.tool_id, target.scope, target.context_id, target.project_path, location.path.display(), name, text).as_bytes())
}

fn entry_text(adapter: &dyn crate::adapters::CliAdapter, location: &McpLocation, name: &str, entry: Value) -> Result<String, String> {
    adapter.mcp_render_entry(location, name, entry)
}

fn verify_equivalent(adapter: &dyn crate::adapters::CliAdapter, definition: &McpDefinition, entry: &Value) -> Result<(), String> {
    let decoded = adapter.mcp_decode(&definition.name, entry)?.draft;
    if decoded.transport != definition.transport || decoded.command != definition.command || decoded.args != definition.args || decoded.url != definition.url || decoded.env != definition.env || decoded.headers != definition.headers {
        return Err("目标格式不能无损表达命令、参数或变量；请保留原始配置".into());
    }
    Ok(())
}

pub fn read(db: &Database, registry: &Registry, home: &Path, request: &McpDocumentRequest) -> Result<McpDocument, String> {
    let (location, _) = mcp::target_location(db, registry, &request.target, home)?;
    let adapter = registry.get(&request.target.tool_id).ok_or("工具未注册")?;
    let (native_text, parsed) = if request.definition_id.is_some() { (String::new(), Value::Null) }
        else { mcp::parse_native(&location).map_err(|_| "无法解析原生 MCP 文件，请检查文件格式或访问权限")? };
    let (mut entry, source, name) = if let Some(id) = &request.definition_id {
        let definition = mcp::get_definition(db, id)?;
        let entry = mcp::render_target(registry, adapter, &definition, request.target.enabled, None, &location)?.ok_or("目标不能表达此 MCP 配置的启停状态")?;
        verify_equivalent(adapter, &definition, &entry)?;
        if adapter.mcp_decode(&definition.name, &entry)?.enabled != request.target.enabled { return Err("目标格式不能表达此启停状态".into()); }
        (entry, "equivalent", definition.name)
    } else {
        (adapter.mcp_entries(&parsed, &location)?.get(&request.name).cloned().ok_or("MCP 条目不存在")?, "native_entry", request.name.clone())
    };
    let decoded = adapter.mcp_decode(&name, &entry);
    let enabled = decoded.as_ref().ok().map(|d| d.enabled);
    let unmapped_fields = decoded.map_or_else(|_| vec!["unrecognized native schema".into()], |d| d.unmapped_fields);
    let mut protected_values = if request.reveal { false } else { redact(adapter, &mut entry) };
    let (raw_text, raw_scope, source_path) = if source == "native_entry" {
        let (text, protected) = raw_text(adapter, &location, &native_text, &parsed, request.reveal)?;
        protected_values |= protected;
        (Some(text), Some("native_file"), Some(location.path.display().to_string()))
    } else { (None, None, None) };
    Ok(McpDocument { enabled, source, format: kind(&location), name: name.clone(), text: entry_text(adapter, &location, &name, entry)?, raw_text, raw_scope, source_path, baseline: baseline(&request.target, &location, &name, &native_text), target_tool_id: request.target.tool_id.clone(), protected_values, unmapped_fields, diagnostics: if source == "native_entry" { vec!["配置编辑仅修改当前条目。原文件全文只供查看，包含其他配置，敏感内容可能已脱敏。".into()] } else { Vec::new() } })
}

/// Render only caller-owned draft fields. This does not read a native document,
/// persist a definition, resolve credential references, or write a target.
pub fn render_draft(db: &Database, registry: &Registry, home: &Path, target: &McpTargetRequest, draft: McpDraft) -> Result<McpDocument, String> {
    mcp::validate(&draft)?;
    let mut value = serde_json::to_value(&draft).map_err(|e| e.to_string())?;
    if value.to_string().len() > MAX_TEXT { return Err("配置超过 1 MiB".into()); }
    restore_masks(&mut value, None)?;
    let definition = McpDefinition { id: String::new(), name: draft.name, transport: draft.transport, command: draft.command, args: draft.args, url: draft.url, env: draft.env, headers: draft.headers, reference_source: draft.reference_source, in_library: false, version: 0 };
    let (location, _) = mcp::target_location(db, registry, target, home)?;
    let adapter = registry.get(&target.tool_id).ok_or("工具未注册")?;
    let entry = mcp::render_target(registry, adapter, &definition, target.enabled, None, &location)?.ok_or("目标不能表达此 MCP 配置")?;
    verify_equivalent(adapter, &definition, &entry)?;
    if adapter.mcp_decode(&definition.name, &entry)?.enabled != target.enabled { return Err("目标格式不能表达此启停状态".into()); }
    Ok(McpDocument { enabled: Some(target.enabled), source: "equivalent", format: kind(&location), name: definition.name.clone(), text: entry_text(adapter, &location, &definition.name, entry)?, raw_text: None, raw_scope: None, source_path: None, baseline: String::new(), target_tool_id: target.tool_id.clone(), protected_values: false, unmapped_fields: vec![], diagnostics: vec![] })
}

pub fn parse_paste(db: &Database, registry: &Registry, home: &Path, target: &McpTargetRequest, name: Option<&str>, text: &str) -> Result<Vec<McpPasteItem>, String> {
    if text.len() > MAX_TEXT { return Err("配置超过 1 MiB".into()); }
    let (location, _) = mcp::target_location(db, registry, target, home)?;
    let adapter = registry.get(&target.tool_id).ok_or("工具未注册")?;
    let parsed = adapter.mcp_parse_text(&location, text)?;
    let mut entries = adapter.mcp_entries(&parsed, &location)?;
    if entries.is_empty() {
        let name = name.filter(|n| !n.is_empty()).ok_or("请粘贴完整 MCP 配置，单条配置需提供名称")?;
        entries.insert(name.into(), parsed);
    }
    if entries.len() > 100 { return Err("每批最多 100 个 MCP，请分批添加".into()); }
    Ok(entries.into_iter().map(|(name, mut entry)| {
        let result = restore_masks(&mut entry, None).and_then(|_| adapter.mcp_decode(&name, &entry)).and_then(|mut decoded| {
            decoded.draft.reference_source = Some(target.tool_id.clone());
            mcp::validate(&decoded.draft)?;
            if decoded.draft.transport == mcp::McpTransport::Stdio && mcp::stdio_command(&decoded.draft.command, &decoded.draft.args) != (decoded.draft.command.clone(), decoded.draft.args.clone()) {
                decoded.unmapped_fields.push("command/args normalization".into());
            }
            for (key, value) in decoded.draft.env.iter().chain(&decoded.draft.headers) {
                if value.is_empty() { decoded.unmapped_fields.push(format!("empty variable: {key}")); }
            }
            Ok(decoded)
        });
        match result {
            Ok(decoded) => { let lossless = decoded.unmapped_fields.is_empty(); McpPasteItem { name, enabled: Some(decoded.enabled), draft: lossless.then_some(decoded.draft), unmapped_fields: decoded.unmapped_fields, diagnostics: if lossless { vec![] } else { vec!["这些字段无法无损转为资料库定义；请使用原生配置编辑。".into()] } } },
            Err(error) => McpPasteItem { name, enabled: None, draft: None, unmapped_fields: vec![], diagnostics: vec![error] },
        }
    }).collect())
}

pub fn save(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, target: &McpTargetRequest, name: &str, expected: &str, text: &str) -> Result<McpDocument, String> {
    if text.len() > MAX_TEXT { return Err("配置超过 1 MiB".into()); }
    let _context = crate::accounts::selection::enter_bound(db, home, &target.tool_id, target.scope, target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    let (location, _) = mcp::target_location(db, registry, target, home)?;
    let adapter = registry.get(&target.tool_id).ok_or("工具未注册")?;
    let (native_text, parsed) = mcp::parse_native(&location).map_err(|_| "无法解析原生 MCP 文件，请检查文件格式或访问权限")?;
    if baseline(target, &location, name, &native_text) != expected { return Err("配置或上下文已变化，请重新读取后合并草稿".into()); }
    let original = adapter.mcp_entries(&parsed, &location)?;
    let original_entry = original.get(name).ok_or("原条目已不存在")?;
    let edited = adapter.mcp_parse_text(&location, text)?;
    let entries = adapter.mcp_entries(&edited, &location)?;
    if entries.len() != 1 || !entries.contains_key(name) { return Err("编辑只能包含当前同名 MCP 条目；复制新建请使用添加入口".into()); }
    let mut entry = entries[name].clone();
    restore_masks(&mut entry, Some(original_entry))?;
    let decoded = adapter.mcp_decode(name, &entry)?;
    mcp::validate(&decoded.draft)?;
    // Reject pasted unrelated document fields instead of silently dropping them.
    let projection = entry_text(adapter, &location, name, entries[name].clone())?;
    if adapter.mcp_parse_text(&location, &projection)? != edited { return Err("编辑包含当前 MCP 之外的字段，请仅提交此条目的配置".into()); }
    let change = adapter.mcp_change(&parsed, &location, name, Some(entry))?;
    let original_value = change.path.iter().try_fold(&parsed, |value,key| value.get(key).or_else(|| key.parse::<usize>().ok().and_then(|i| value.get(i))));
    let mut changes = Vec::new();
    if parsed.is_array() { changes.push(change); }
    else { leaf_changes(original_value, change.value.as_ref(), change.path, &mut changes); }
    transaction::apply(db, credentials, &[transaction::FilePatch { path: location.path, kind: location.kind, baseline: native_text, changes, sensitive: true, force_restrict: false }], |_| Ok(()))?;
    read(db, registry, home, &McpDocumentRequest { target: target.clone(), definition_id: None, name: name.into(), reveal: false })
}

pub fn equivalent(db: &Database, registry: &Registry, home: &Path, source: &McpTargetRequest, name: &str, target: &McpTargetRequest) -> Result<McpDocument, String> {
    let (source_location, _) = mcp::target_location(db, registry, source, home)?;
    let (_, parsed) = mcp::parse_native(&source_location).map_err(|_| "无法解析原生 MCP 文件，请检查文件格式或访问权限")?;
    let source_adapter = registry.get(&source.tool_id).ok_or("来源工具未注册")?;
    let entries = source_adapter.mcp_entries(&parsed, &source_location)?;
    let decoded = source_adapter.mcp_decode(name, entries.get(name).ok_or("MCP 条目不存在")?)?;
    if !decoded.unmapped_fields.is_empty() { return Err(format!("无法无损转换字段：{}", decoded.unmapped_fields.join(", "))); }
    mcp::validate(&decoded.draft)?;
    let enabled = decoded.enabled;
    let d = decoded.draft;
    let definition = McpDefinition { id: String::new(), name: d.name, transport: d.transport, command: d.command, args: d.args, url: d.url, env: d.env, headers: d.headers, reference_source: Some(source.tool_id.clone()), in_library: false, version: 0 };
    let (location, _) = mcp::target_location(db, registry, target, home)?;
    let adapter = registry.get(&target.tool_id).ok_or("目标工具未注册")?;
    let mut entry = mcp::render_target(registry, adapter, &definition, enabled, None, &location)?.ok_or("目标不支持此配置的启停状态")?;
    verify_equivalent(adapter, &definition, &entry)?;
    if adapter.mcp_decode(name, &entry)?.enabled != enabled { return Err("目标格式不能表达此启停状态".into()); }
    let protected_values = redact(adapter, &mut entry);
    Ok(McpDocument { enabled: Some(enabled), source: "equivalent", format: kind(&location), name: name.into(), text: entry_text(adapter, &location, name, entry)?, raw_text: None, raw_scope: None, source_path: None, baseline: String::new(), target_tool_id: target.tool_id.clone(), protected_values, unmapped_fields: vec![], diagnostics: vec![] })
}
