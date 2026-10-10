//! Bounded, sequential coordination over the existing CAS/transaction services.
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use rusqlite::{params, OptionalExtension};
use crate::{adapters::Registry, credentials::CredentialStore, database::Database};
use super::{mcp::{self, McpTargetRequest}, skills};

const LIMIT: usize = 50;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Operation {
    McpApply { definition_id: String, target: McpTargetRequest },
    SkillInstall { package_id: String, target: McpTargetRequest, preview_token: Option<String>, allow_takeover: bool },
    SkillRemove { package_id: String, target: McpTargetRequest },
    SkillEnable { package_id: String, target: McpTargetRequest },
}

impl Operation {
    fn target(&self) -> &McpTargetRequest {
        match self { Self::McpApply { target, .. } | Self::SkillInstall { target, .. } | Self::SkillRemove { target, .. } | Self::SkillEnable { target, .. } => target }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult { pub index: usize, pub status: String, pub detail: String, pub value: Option<Value> }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult { pub operation_id: String, pub cancelled: bool, pub items: Vec<ItemResult> }

fn active() -> &'static Mutex<HashMap<String, bool>> { static ACTIVE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new(); ACTIVE.get_or_init(Default::default) }
struct Active(String);
impl Drop for Active { fn drop(&mut self) { if let Ok(mut active) = active().lock() { active.remove(&self.0); } } }
pub fn cancel(id: &str) -> Result<bool, String> {
    let mut active = active().lock().map_err(|_| "批量服务暂时不可用")?;
    if let Some(cancelled) = active.get_mut(id) { *cancelled = true; Ok(true) } else { Ok(false) }
}

fn physical(path: &Path) -> Result<PathBuf, String> {
    if path.exists() { return path.canonicalize().map_err(|e| e.to_string()); }
    let parent = path.parent().ok_or("资源路径没有父目录")?;
    Ok(physical(parent)?.join(path.file_name().ok_or("资源路径无效")?))
}

fn key(db: &Database, registry: &Registry, home: &Path, op: &Operation) -> Result<(PathBuf, String), String> {
    let target = op.target();
    let _context = crate::accounts::selection::enter_bound(db, home, &target.tool_id, target.scope, target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    match op {
        Operation::McpApply { definition_id, .. } => {
            let definition = mcp::get_definition(db, definition_id)?;
            let (location, _) = mcp::target_location(db, registry, target, home)?;
            Ok((physical(&location.path)?, definition.name))
        },
        Operation::SkillInstall { package_id, .. } | Operation::SkillRemove { package_id, .. } | Operation::SkillEnable { package_id, .. } => {
            let document = skills::read_package_document(db, package_id)?;
            let (path, _) = skills::target(registry, home, &target.tool_id, target.scope, target.project_path.as_deref(), &document.name)?;
            Ok((physical(&path)?, String::new()))
        }
    }
}

pub fn run(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, id: &str, operations: Vec<Operation>) -> Result<BatchResult, String> {
    if operations.len() > LIMIT || uuid::Uuid::parse_str(id).is_err() { return Err("批量操作需要 UUID，每批最多 50 项".into()); }
    {
        let mut active = active().lock().map_err(|_| "批量服务暂时不可用")?;
        if active.contains_key(id) { return Err("此批次正在运行".into()); }
        active.insert(id.into(), false);
    }
    let _guard = Active(id.into());
    let keys: Vec<_> = operations.iter().map(|op| key(db, registry, home, op)).collect();
    let mut seen = HashSet::new();
    let mut conflicts = HashSet::new();
    for key in keys.iter().filter_map(|k| k.as_ref().ok()) { if !seen.insert(key.clone()) { conflicts.insert(key.clone()); } }
    let mut items = Vec::new();
    let mut cancelled = false;
    for (index, (op, key)) in operations.into_iter().zip(keys).enumerate() {
        cancelled |= active().lock().map_err(|_| "批量服务暂时不可用")?.get(id).copied().unwrap_or(true);
        let result = if cancelled { Ok(("not_executed".into(), "已取消后续操作；已提交结果保留".into(), None)) }
        else if key.as_ref().is_ok_and(|key| conflicts.contains(key)) { Ok(("conflict".into(), "同批次重复物理目标，请保留一个操作后重试".into(), None)) }
        else { key.and_then(|_| execute(db, credentials, registry, home, op)) };
        items.push(match result {
            Ok((status, detail, value)) => ItemResult { index, status, detail, value },
            Err(detail) => ItemResult { index, status: "failed".into(), detail, value: None },
        });
    }
    Ok(BatchResult { operation_id: id.into(), cancelled, items })
}

fn execute(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, op: Operation) -> Result<(String, String, Option<Value>), String> {
    let target = op.target();
    let _context = crate::accounts::selection::enter_bound(db, home, &target.tool_id, target.scope, target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
    match op {
        Operation::McpApply { definition_id, target } => {
            let result = mcp::distribute(db, credentials, registry, home, &definition_id, vec![target]).remove(0);
            Ok((result.status.into(), result.detail.clone(), Some(serde_json::to_value(result).map_err(|e| e.to_string())?)))
        },
        Operation::SkillInstall { package_id, target, preview_token, allow_takeover } => {
            let result = skills::install_confirmed(db, registry, home, &package_id, &target.tool_id, target.scope, target.project_path.as_deref(), preview_token.as_deref(), allow_takeover);
            Ok((result.status.into(), result.detail.clone(), Some(serde_json::to_value(result).map_err(|e| e.to_string())?)))
        },
        Operation::SkillRemove { package_id, target } => {
            let result = skills::remove(db, registry, home, &package_id, &target.tool_id, target.scope, target.project_path.as_deref());
            Ok((result.status.into(), result.detail.clone(), Some(serde_json::to_value(result).map_err(|e| e.to_string())?)))
        },
        Operation::SkillEnable { package_id, target } => {
            skills::set_enabled(db, credentials, registry, home, &package_id, &target.tool_id, target.scope, target.project_path.as_deref(), target.enabled)?;
            Ok(("written".into(), String::new(), None))
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StateRequest {
    Skill { package_id: String },
    NativeSkill { target: McpTargetRequest, name: String, #[serde(default)] directory: Option<String> },
    Mcp { definition_id: String, target: McpTargetRequest },
}

pub fn states(db: &Database, registry: &Registry, home: &Path, requests: Vec<StateRequest>) -> Result<Vec<ItemResult>, String> {
    if requests.len() > LIMIT { return Err("状态请求每批最多 50 项".into()); }
    let recovery = skills::recover_report(db);
    let mut cached = HashMap::<String, Result<Value, String>>::new();
    Ok(requests.into_iter().enumerate().map(|(index, request)| {
        let result = match request {
            StateRequest::NativeSkill { target, name, directory } => {
                let cache_key = serde_json::to_string(&(&target, &name, &directory)).unwrap_or_default();
                cached.entry(format!("native:{cache_key}")).or_insert_with(|| skills::native_state(db, registry, home, &target, &name, directory.as_deref()).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))).clone()
            },
            StateRequest::Skill { package_id } => cached.entry(format!("package:{package_id}")).or_insert_with(|| recovery.as_ref().map_err(Clone::clone).and_then(|_| skills::installations_ready(db, registry, home, &package_id)).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))).clone(),
            StateRequest::Mcp { definition_id, target } => (|| {
                let _context = crate::accounts::selection::enter_bound(db, home, &target.tool_id, target.scope, target.project_path.as_deref().map(Path::new))?;
                crate::accounts::selection::validate_expected(&target.tool_id, target.context_id.as_deref())?;
                mcp::managed_enabled(db, &definition_id, &target).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })(),
        };
        match result { Ok(value) => ItemResult { index, status: "ready".into(), detail: String::new(), value: Some(value) }, Err(detail) => ItemResult { index, status: "failed".into(), detail, value: None } }
    }).collect())
}

pub fn sort_preference(db: &Database, context: &str, value: Option<&str>) -> Result<String, String> {
    if context.is_empty() || context.len() > 256 { return Err("资源排序上下文无效".into()); }
    db.with_connection(|conn| {
        if let Some(value) = value {
            if !["added", "name"].contains(&value) { return Err("排序无效".into()); }
            conn.execute("INSERT INTO resource_preferences(context,sort) VALUES (?1,?2) ON CONFLICT(context) DO UPDATE SET sort=excluded.sort", params![context,value]).map_err(|e| e.to_string())?;
        }
        Ok(conn.query_row("SELECT sort FROM resource_preferences WHERE context=?1", [context], |r| r.get(0)).optional().map_err(|e| e.to_string())?.unwrap_or_else(|| "added".into()))
    })
}
