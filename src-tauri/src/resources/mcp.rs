use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::native::adapter::{self, Scope};
use crate::native::adapters::{McpLocation, Registry};
use crate::native::{format, transaction};
use crate::projects;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDefinition {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    #[serde(default = "default_in_library")]
    pub in_library: bool,
    pub version: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDraft {
    pub id: Option<String>,
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    #[serde(default = "default_in_library")]
    pub in_library: bool,
    pub expected_version: Option<u64>,
}

fn default_in_library() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetRequest {
    #[serde(default)]
    pub context_id: Option<String>,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub baseline_hash: Option<String>,
    #[serde(default)]
    pub allow_replace: bool,
    #[serde(default)]
    pub preview_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTargetResult {
    pub context_id: Option<String>,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub path: Option<String>,
    pub status: &'static str,
    pub detail: String,
    pub baseline_hash: Option<String>,
    pub preview_token: Option<String>,
    pub existing: Option<Value>,
    pub proposed: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMcpEntry {
    pub name: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub env: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub enabled: bool,
    pub protected_values: bool,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_reference(value: &str) -> bool {
    let value = value.strip_prefix("Bearer ").unwrap_or(value);
    let reference = value
        .strip_prefix("${")
        .or_else(|| value.strip_prefix("{env:"));
    reference.is_some_and(|tail| {
        tail.ends_with('}')
            && tail[..tail.len() - 1]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            && tail.len() > 1
    })
}

fn sensitive_key(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["key", "token", "secret", "authorization", "password"]
        .iter()
        .any(|word| name.contains(word))
}

fn validate(draft: &McpDraft) -> Result<(), String> {
    if !valid_name(&draft.name) {
        return Err("MCP 名称只可用 1–80 个字母、数字、连字符或下划线".into());
    }
    match draft.transport {
        McpTransport::Stdio if draft.command.trim().is_empty() => {
            return Err("stdio MCP 需要命令".into())
        }
        McpTransport::Http => {
            let url = url::Url::parse(&draft.url).map_err(|_| "MCP 地址无效")?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err("MCP 地址只支持 HTTP 或 HTTPS".into());
            }
        }
        _ => {}
    }
    for (name, value) in draft.env.iter().chain(draft.headers.iter()) {
        if name.trim().is_empty()
            || name.chars().any(char::is_control)
            || value.chars().any(char::is_control)
        {
            return Err("MCP 环境变量或请求头包含无效字符".into());
        }
        if sensitive_key(name) && !is_reference(value) {
            return Err(format!("{name} 请使用环境变量引用，不在资料库保存明文密钥"));
        }
    }
    Ok(())
}

pub fn list_definitions(db: &Database) -> Result<Vec<McpDefinition>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT data_json FROM mcp_definitions ORDER BY name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .map(|row| {
                serde_json::from_str(&row.map_err(|error| error.to_string())?)
                    .map_err(|_| "MCP 资料格式无法识别".into())
            })
            .collect();
        rows
    })
}

pub fn get_definition(db: &Database, id: &str) -> Result<McpDefinition, String> {
    db.with_connection(|conn| {
        let text: Option<String> = conn
            .query_row(
                "SELECT data_json FROM mcp_definitions WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&text.ok_or("MCP 定义不存在")?)
            .map_err(|_| "MCP 资料格式无法识别".into())
    })
}

pub fn save_definition(db: &Database, draft: McpDraft) -> Result<McpDefinition, String> {
    validate(&draft)?;
    if let Some(id) = draft.id.as_deref() {
        let previous = get_definition(db, id)?;
        if previous.name != draft.name.trim() {
            let installed: bool = db.with_connection(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mcp_targets WHERE definition_id = ?1)",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })?;
            if installed {
                return Err("已分发的 MCP 暂不能更名；请新建定义，避免留下旧原生条目".into());
            }
        }
    }
    let id = draft.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let version = draft.expected_version.map_or(1, |old| old + 1);
    let (command, args) = match draft.transport {
        McpTransport::Stdio => stdio_command(&draft.command, &draft.args),
        McpTransport::Http => (draft.command.trim().into(), draft.args.clone()),
    };
    let definition = McpDefinition {
        id: id.clone(),
        name: draft.name.trim().into(),
        transport: draft.transport,
        command,
        args,
        url: draft.url.trim().into(),
        env: draft.env,
        headers: draft.headers,
        in_library: draft.in_library,
        version,
    };
    let data = serde_json::to_string(&definition).map_err(|error| error.to_string())?;
    db.with_connection(|conn| {
        let changed = match draft.expected_version {
            Some(old) => conn.execute("UPDATE mcp_definitions SET name = ?2, transport = ?3, data_json = ?4, version = ?5 WHERE id = ?1 AND version = ?6",
                params![id, definition.name, format!("{:?}", definition.transport), data, version as i64, old as i64]),
            None => conn.execute("INSERT INTO mcp_definitions (id, name, transport, data_json, version) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, definition.name, format!("{:?}", definition.transport), data, version as i64]),
        }.map_err(|error| format!("无法保存 MCP 定义；名称可能已被使用：{error}"))?;
        if changed != 1 { return Err("MCP 定义已被修改，请重新读取".into()); }
        Ok(())
    })?;
    Ok(definition)
}

pub fn delete_definition(db: &Database, id: &str, expected_version: u64) -> Result<(), String> {
    db.with_connection(|conn| {
        let changed = conn.execute(
            "DELETE FROM mcp_definitions WHERE id = ?1 AND version = ?2",
            params![id, expected_version as i64],
        ).map_err(|error| error.to_string())?;
        if changed != 1 { return Err("MCP 定义已被修改或不存在，请重新读取".into()); }
        Ok(())
    })
}

pub fn remove_native(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    target: &McpTargetRequest,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() { return Err("请选择要删除的 MCP".into()); }
    let (location, scope_key) = target_location(db, registry, target, home)?;
    let (baseline, parsed) = parse_native(&location)?;
    if entry_root(&parsed, &location).and_then(|root| root.get(name)).is_none() {
        return Err("当前工具上已没有这个 MCP".into());
    }
    let field = entry_path(&location, name);
    let name_owned = name.to_owned();
    let tool = target.tool_id.clone();
    transaction::apply(db, credentials, &[transaction::FilePatch {
        path: location.path.clone(), kind: location.kind, baseline,
        changes: vec![transaction::FieldChange { path: field, value: None }],
        sensitive: false, force_restrict: false,
    }], move |tx: &rusqlite::Transaction<'_>| {
        tx.execute("DELETE FROM mcp_targets WHERE tool = ?1 AND scope_key = ?2 AND definition_id IN (SELECT id FROM mcp_definitions WHERE name = ?3)",
            params![tool, scope_key, name_owned]).map(|_| ()).map_err(|error| error.to_string())
    })?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPlacement {
    pub context_id: Option<String>,
    pub definition_id: String,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub enabled: bool,
}

pub fn list_placements(db: &Database) -> Result<Vec<McpPlacement>, String> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT definition_id, tool, scope_key, enabled FROM mcp_targets ORDER BY tool, scope_key").map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| {
            let scope_key: String = row.get(2)?;
            let (scope, project_path) = if let Some(path) = scope_key.strip_prefix("project:") {
                (Scope::Project, Some(path.to_string()))
            } else {
                (Scope::Global, None)
            };
            Ok(McpPlacement { context_id:crate::accounts::selection::split_key(&scope_key).0.map(str::to_owned), definition_id: row.get(0)?, tool_id: row.get(1)?, scope, project_path, enabled: row.get::<_, i64>(3)? != 0 })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}

pub fn managed_enabled(db: &Database, definition_id: &str, target: &McpTargetRequest) -> Result<Option<bool>,String> {
    let key=match target.scope { Scope::Global=>"global".into(), Scope::Project=>format!("project:{}",projects::checked_directory(target.project_path.as_deref().ok_or("请选择项目目录")?)?.display()) };
    let binding = crate::native::apply::get_registered_binding(db,&target.tool_id,&key)?;
    let key=if target.scope==Scope::Global { binding.and_then(|binding|binding.context_id).map(|id|format!("context:{id}:{key}")).unwrap_or(key) } else {key};
    db.with_connection(|conn|conn.query_row("SELECT enabled FROM mcp_targets WHERE definition_id=?1 AND tool=?2 AND scope_key=?3",params![definition_id,target.tool_id,key],|row|row.get(0)).optional().map_err(|e|e.to_string()))
}

fn target_location(
    db: &Database,
    registry: &Registry,
    target: &McpTargetRequest,
    home: &Path,
) -> Result<(McpLocation, String), String> {
    let _context = crate::accounts::selection::enter_bound(db, home, &target.tool_id, target.scope, target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id,target.context_id.as_deref())?;
    let cli = registry
        .get(&target.tool_id)
        .ok_or("此 CLI 尚无注册适配器")?;
    let project = match target.scope {
        Scope::Global => None,
        Scope::Project => Some(projects::checked_directory(
            target.project_path.as_deref().ok_or("请选择项目目录")?,
        )?),
    };
    let version = if cli.mcp_requires_version() {
        let custom: Option<String> = db.with_connection(|conn| {
            conn.query_row(
                "SELECT path FROM installation_choices WHERE tool = ?1",
                [&target.tool_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
        })?;
        let probe = adapter::probe_registered(
            registry,
            &target.tool_id,
            custom.as_deref().map(Path::new),
            home,
            project.as_deref(),
            target.scope,
        )?;
        probe
            .selected_path
            .as_ref()
            .and_then(|selected| {
                probe
                    .installations
                    .iter()
                    .find(|item| &item.path == selected)
            })
            .and_then(|item| item.version.clone())
    } else {
        None
    };
    let location = cli
        .mcp_location_for_version(target.scope, home, project.as_deref(), version.as_deref())
        .ok_or("此 CLI 的 MCP 配置版本尚未确认；请先确认安装或保留可识别的原生配置")?;
    let key = project.as_ref().map_or_else(
        || "global".to_owned(),
        |path| format!("project:{}", path.display()),
    );
    Ok((location, crate::accounts::selection::key(&key)))
}

fn parse_native(location: &McpLocation) -> Result<(String, Value), String> {
    let text = transaction::read_native(&location.path)?;
    let parsed = format::parse(location.kind, &text)?;
    Ok((text, parsed))
}

fn entry_root<'a>(parsed: &'a Value, location: &McpLocation) -> Option<&'a Value> {
    let root = parsed.get(location.root)?;
    location.child.map_or(Some(root), |child| root.get(child))
}

fn entry_path(location: &McpLocation, name: &str) -> Vec<String> {
    let mut path = vec![location.root.to_owned()];
    if let Some(child) = location.child {
        path.push(child.to_owned());
    }
    path.push(name.to_owned());
    path
}

fn entry_hash(value: Option<&Value>) -> Result<String, String> {
    Ok(transaction::fingerprint(
        &serde_json::to_vec(&value).map_err(|error| error.to_string())?,
    ))
}

fn preview_token(
    definition: &McpDefinition,
    target: &McpTargetRequest,
    location: &McpLocation,
    scope_key: &str,
    actual: &str,
) -> Result<String, String> {
    let bound = serde_json::to_vec(&(
        definition.id.as_str(),
        definition.version,
        target.tool_id.as_str(),
        scope_key,
        location.path.to_string_lossy(),
        target.enabled,
        actual,
    ))
    .map_err(|error| error.to_string())?;
    Ok(transaction::fingerprint(&bound))
}

fn visible_entry(value: Option<&Value>) -> Option<Value> {
    let mut visible = value.cloned()?;
    if let Some(fields) = visible.as_object_mut() {
        for field in ["env", "environment", "headers", "http_headers"] {
            if let Some(map) = fields.get_mut(field).and_then(Value::as_object_mut) {
                for (key, content) in map.iter_mut() {
                    if sensitive_key(key)
                        && content.as_str().is_some_and(|text| !is_reference(text))
                    {
                        *content = Value::String("[已隐藏的原生凭据]".into());
                    }
                }
            }
        }
    }
    Some(visible)
}

fn managed_hash(
    db: &Database,
    id: &str,
    tool: &str,
    scope_key: &str,
) -> Result<Option<String>, String> {
    db.with_connection(|conn| conn.query_row(
        "SELECT managed_hash FROM mcp_targets WHERE definition_id = ?1 AND tool = ?2 AND scope_key = ?3",
        params![id, tool, scope_key], |row| row.get(0)).optional().map_err(|error| error.to_string()))
}

fn visible_map(value: Option<&Value>) -> (BTreeMap<String, String>, bool) {
    let mut protected = false;
    let map = value
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    let value = value.as_str()?;
                    if sensitive_key(key) && !is_reference(value) {
                        protected = true;
                        None
                    } else {
                        Some((key.clone(), value.to_owned()))
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    (map, protected)
}

pub fn list_native(
    db: &Database,
    registry: &Registry,
    home: &Path,
    target: &McpTargetRequest,
) -> Result<Vec<NativeMcpEntry>, String> {
    let (location, _) = target_location(db, registry, target, home)?;
    let (_, parsed) = parse_native(&location)?;
    let Some(entries) = entry_root(&parsed, &location).and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .iter()
        .filter_map(|(name, raw)| {
            let raw = raw.as_object()?;
            let command = raw.get("command");
            let (command, args) = match command {
                Some(Value::String(command)) => (
                    command.clone(),
                    raw.get("args")
                        .and_then(Value::as_array)
                        .map(|args| {
                            args.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
                Some(Value::Array(command)) => {
                    let mut parts = command.iter().filter_map(Value::as_str);
                    (
                        parts.next().unwrap_or("").to_owned(),
                        parts.map(str::to_owned).collect(),
                    )
                }
                _ => (String::new(), Vec::new()),
            };
            let url = raw
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let (env, env_protected) =
                visible_map(raw.get("env").or_else(|| raw.get("environment")));
            let (headers, header_protected) =
                visible_map(raw.get("headers").or_else(|| raw.get("http_headers")));
            Some(NativeMcpEntry {
                name: name.clone(),
                transport: if url.is_empty() {
                    McpTransport::Stdio
                } else {
                    McpTransport::Http
                },
                command,
                args,
                url,
                env,
                headers,
                enabled: raw
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .or_else(|| {
                        raw.get("disabled")
                            .and_then(Value::as_bool)
                            .map(|value| !value)
                    })
                    .unwrap_or(true),
                protected_values: env_protected || header_protected,
            })
        })
        .collect())
}

pub fn preview_targets(
    db: &Database,
    registry: &Registry,
    home: &Path,
    definition_id: &str,
    targets: Vec<McpTargetRequest>,
) -> Vec<McpTargetResult> {
    let definition = get_definition(db, definition_id);
    targets.into_iter().map(|mut target| {
        if target.context_id.is_none() {
            if let Ok(Some((_,context)))=crate::accounts::selection::bound(db,home,&target.tool_id,target.scope,target.project_path.as_deref().map(Path::new),false) {target.context_id=Some(context.id);}
        }
        let mut result = McpTargetResult { context_id:target.context_id.clone(), tool_id: target.tool_id.clone(), scope: target.scope,
            project_path: target.project_path.clone(), path: None, status: "unsupported", detail: String::new(), baseline_hash: None, preview_token: None, existing: None, proposed: None };
        match target_location(db, registry, &target, home) {
            Ok((location, scope_key)) => {
                result.path = Some(location.path.display().to_string());
                let inspected = (|| {
                    let definition = definition.as_ref().map_err(Clone::clone)?;
                    let (_, parsed) = parse_native(&location)?;
                    let existing = entry_root(&parsed, &location).and_then(|root| root.get(&definition.name));
                    let actual = entry_hash(existing)?;
                    let owned = managed_hash(db, definition_id, &target.tool_id, &scope_key)?;
                    let adapter = registry.get(&target.tool_id).ok_or("此 CLI 尚无注册适配器")?;
                    let proposal = adapter.mcp_document_at(definition, target.enabled, existing, &location)?;
                    Ok::<_, String>((existing.is_some(), actual, owned, visible_entry(existing), visible_entry(proposal.as_ref()), preview_token(definition, &target, &location, &scope_key, &entry_hash(existing)?)?))
                })();
                match inspected {
                    Ok((exists, actual, owned, before, after, token)) => {
                        result.baseline_hash = Some(actual.clone());
                        result.preview_token = Some(token);
                        result.existing = before;
                        result.proposed = after;
                        result.status = if exists && owned.as_deref() != Some(&actual) { "conflict" } else { "ready" };
                        result.detail = if result.status == "conflict" { "同名原生条目未由当前定义管理，或已被外部修改；确认替换前请检查原生内容".into() }
                            else if exists { "将更新当前受管理的原生条目".into() } else { "将创建 CLI 原生条目".into() };
                        if !target.enabled {
                            if let Some(description) = registry.get(&target.tool_id).and_then(|adapter| adapter.mcp_disabled_description()) {
                                result.detail.push_str("；");
                                result.detail.push_str(description);
                            }
                        }
                    }
                    Err(error) => { result.status = "failed"; result.detail = error; }
                }
            }
            Err(error) => result.detail = error,
        }
        result
    }).collect()
}

pub fn distribute(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    definition_id: &str,
    targets: Vec<McpTargetRequest>,
) -> Vec<McpTargetResult> {
    let definition = get_definition(db, definition_id);
    targets.into_iter().map(|target| {
        let mut result = McpTargetResult { context_id:target.context_id.clone(), tool_id: target.tool_id.clone(), scope: target.scope,
            project_path: target.project_path.clone(), path: None, status: "failed", detail: String::new(), baseline_hash: None, preview_token: None, existing: None, proposed: None };
        let attempt = (|| {
            let definition = definition.as_ref().map_err(Clone::clone)?;
            let (location, scope_key) = target_location(db, registry, &target, home)?;
            result.path = Some(location.path.display().to_string());
            let adapter = registry.get(&target.tool_id).ok_or("此 CLI 尚无注册适配器")?;
            let (baseline, parsed) = parse_native(&location)?;
            let existing = entry_root(&parsed, &location).and_then(|root| root.get(&definition.name));
            let actual_hash = entry_hash(existing)?;
            result.baseline_hash = Some(actual_hash.clone());
            let token = preview_token(definition, &target, &location, &scope_key, &actual_hash)?;
            if target.preview_token.as_deref() != Some(token.as_str()) || target.baseline_hash.as_deref() != Some(actual_hash.as_str()) {
                return Err("MCP 定义、目标范围或原生条目在预览后变化；请重新预览".into());
            }
            let owned = managed_hash(db, definition_id, &target.tool_id, &scope_key)?;
            if existing.is_some() && owned.as_deref() != Some(&actual_hash) {
                if !target.allow_replace {
                    return Err("同名原生条目未受当前定义管理或已被外部修改；请预览后确认替换".into());
                }
            }
            let document = adapter.mcp_document_at(definition, target.enabled, existing, &location)?;
            let written_hash = entry_hash(document.as_ref())?;
            let change = transaction::FieldChange { path: entry_path(&location, &definition.name), value: document };
            let commit = |tx: &rusqlite::Transaction<'_>| {
                let current: i64 = tx.query_row("SELECT version FROM mcp_definitions WHERE id = ?1", [&definition.id], |row| row.get(0)).map_err(|error| error.to_string())?;
                if current != definition.version as i64 { return Err("MCP 定义在预览后变化；请重新预览".into()); }
                tx.execute("INSERT INTO mcp_targets (definition_id, tool, scope_key, enabled, managed_hash) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(definition_id, tool, scope_key) DO UPDATE SET enabled = excluded.enabled, managed_hash = excluded.managed_hash",
                    params![definition.id, target.tool_id, scope_key, target.enabled as i64, written_hash])
                    .map_err(|error| error.to_string())?;
                Ok(())
            };
            let outcome = if existing == change.value.as_ref() {
                transaction::commit_matching(db, &[(location.path.clone(), baseline)], commit)?
            } else {
                transaction::apply(db, credentials, &[transaction::FilePatch {
                    path: location.path, kind: location.kind, baseline,
                    changes: vec![change], sensitive: false, force_restrict: false,
                }], commit)?
            };
            Ok(outcome.status.to_owned())
        })();
        match attempt { Ok(status) => { result.status = "written"; result.detail = status; }, Err(error) => result.detail = error }
        result
    }).collect()
}

pub fn stdio_doc(
    definition: &McpDefinition,
    existing: Option<&Value>,
) -> serde_json::Map<String, Value> {
    stdio_doc_with_env(definition, existing, "env")
}

fn protected_values(existing: Option<&Value>, field: &str) -> serde_json::Map<String, Value> {
    existing
        .and_then(Value::as_object)
        .and_then(|map| map.get(field))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter(|(key, value)| {
                    sensitive_key(key) && value.as_str().is_some_and(|text| !is_reference(text))
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Grok and Codex execute `command` and pass `args` separately. A pasted line such as
/// `npx -y chrome-devtools-mcp@latest` is one token to them and the process never starts.
pub fn stdio_command(command: &str, args: &[String]) -> (String, Vec<String>) {
    let args: Vec<String> = args
        .iter()
        .map(|arg| arg.trim().to_owned())
        .filter(|arg| !arg.is_empty())
        .collect();
    if !args.is_empty() {
        return (command.trim().to_owned(), args);
    }
    let (program, rest) = split_command_line(command.trim());
    if program.is_empty() {
        (command.trim().to_owned(), Vec::new())
    } else {
        (program, rest)
    }
}

fn split_command_line(input: &str) -> (String, Vec<String>) {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for ch in input.chars() {
        match quote {
            Some(mark) if ch == mark => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    let mut tokens = tokens.into_iter();
    (
        tokens.next().unwrap_or_default(),
        tokens.collect(),
    )
}

pub fn stdio_doc_with_env(
    definition: &McpDefinition,
    existing: Option<&Value>,
    field: &str,
) -> serde_json::Map<String, Value> {
    let mut map = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    map.remove("url");
    map.remove("headers");
    map.remove("http_headers");
    map.remove("env");
    map.remove("environment");
    let (command, args) = stdio_command(&definition.command, &definition.args);
    map.insert("command".into(), Value::String(command));
    map.insert("args".into(), serde_json::json!(args));
    let mut env = protected_values(existing, field);
    for (key, value) in &definition.env {
        env.insert(key.clone(), Value::String(value.clone()));
    }
    if !env.is_empty() {
        map.insert(field.into(), Value::Object(env));
    }
    map
}

pub fn http_doc(
    definition: &McpDefinition,
    existing: Option<&Value>,
    header_field: &str,
) -> serde_json::Map<String, Value> {
    let mut map = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    map.remove("command");
    map.remove("args");
    map.remove("env");
    map.remove("environment");
    map.remove("headers");
    map.remove("http_headers");
    map.insert("url".into(), Value::String(definition.url.clone()));
    let mut headers = protected_values(existing, header_field);
    for (key, value) in &definition.headers {
        headers.insert(key.clone(), Value::String(value.clone()));
    }
    if !headers.is_empty() {
        map.insert(header_field.into(), Value::Object(headers));
    }
    map
}

#[cfg(test)]
#[path = "../../../tests/resources/mcp.rs"]
mod tests;
