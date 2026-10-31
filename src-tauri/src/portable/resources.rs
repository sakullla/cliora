//! Portable resource placement intent. Actual writes use the existing adapter,
//! preview, transaction, and skill backup services after profiles are ready.
use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{paths, PortableEntity, PortablePayload};
use crate::{adapters::Registry, credentials::CredentialStore, database::Database};
use crate::native::adapter::Scope;
use crate::resources::{mcp, skills};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableDeployment {
    pub resource_kind: String,
    pub resource_id: String,
    pub tool: String,
    pub scope_key: String,
    pub enabled: bool,
}

impl PortableDeployment {
    pub(super) fn id(&self) -> String {
        let scope = paths::encode_scope(&self.scope_key);
        format!("{:x}", Sha256::digest(format!("{}\0{}\0{}\0{scope}", self.resource_kind, self.resource_id, self.tool)))
    }
    pub(super) fn valid(&self) -> bool {
        let (_, scope) = crate::accounts::selection::split_key(&self.scope_key);
        matches!(self.resource_kind.as_str(), "mcp" | "skill")
            && !self.resource_id.is_empty() && self.resource_id.len() <= 256
            && !self.tool.is_empty() && self.tool.len() <= 128
            && self.scope_key.len() <= 4096
            && (scope == "global" || scope.strip_prefix("project:").is_some_and(|path| !path.is_empty()))
    }
    fn entity(&self) -> PortableEntity {
        PortableEntity { id: self.id(), payload: PortablePayload::Deployment(self.clone()) }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Pending {
    deployment: PortableDeployment,
    remove: bool,
}

fn pending(conn: &Connection) -> Result<BTreeMap<String, Pending>, String> {
    let json: Option<String> = conn.query_row("SELECT value FROM app_settings WHERE key='sync_resource_targets_v1'", [], |row| row.get(0))
        .optional().map_err(|error| error.to_string())?;
    json.map(|text| serde_json::from_str(&text).map_err(|_| "资源同步恢复记录损坏".into()))
        .transpose().map(|items| items.unwrap_or_default())
}

fn save(conn: &Connection, items: &BTreeMap<String, Pending>) -> Result<(), String> {
    conn.execute("INSERT INTO app_settings(key,value) VALUES ('sync_resource_targets_v1',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(items).map_err(|_| "无法记录资源同步状态")?]).map(|_| ()).map_err(|error| error.to_string())
}

pub(super) fn queue(conn: &Connection, value: &PortableDeployment, remove: bool) -> Result<(), String> {
    let mut items = pending(conn)?;
    items.insert(value.id(), Pending { deployment: value.clone(), remove });
    save(conn, &items)
}

pub(super) fn collect(conn: &Connection) -> Result<Vec<PortableEntity>, String> {
    let rows = super::read_rows(conn,
        "SELECT 'mcp',definition_id,tool,scope_key,enabled FROM mcp_targets
         UNION ALL SELECT 'skill',package_id,tool,scope_key,NOT EXISTS(SELECT 1 FROM app_settings WHERE key='native_skill_switch:'||tool||':'||scope_key||':'||package_id) FROM skill_installations
         UNION ALL SELECT 'skill',o.package_id,o.tool,o.scope_key,0 FROM skill_operations o JOIN skill_packages p ON p.id=o.package_id WHERE o.status='disabled'",
        |row| Ok(PortableDeployment { resource_kind: row.get(0)?, resource_id: row.get(1)?, tool: row.get(2)?, scope_key: row.get(3)?, enabled: row.get(4)? }))?;
    let mut entities = BTreeMap::new();
    for mut value in rows {
        value.scope_key = paths::encode_scope(&value.scope_key);
        entities.insert(value.id(), value.entity());
    }
    for (id, item) in pending(conn)? {
        if item.remove { entities.remove(&id); } else { entities.insert(id, item.deployment.entity()); }
    }
    Ok(entities.into_values().collect())
}

pub(super) fn require_released(conn: &Connection, kind: &str, id: &str) -> Result<(), String> {
    if pending(conn)?.values().any(|item| item.remove && item.deployment.resource_kind == kind && item.deployment.resource_id == id) {
        return Err("资源仍有待完成的原生移除；资料已保留，下次同步自动重试".into());
    }
    Ok(())
}

pub(super) fn refresh_changed(conn: &Connection, changed: &[PortableEntity]) -> Result<(), String> {
    let targets = collect(conn)?;
    for entity in targets {
        let PortablePayload::Deployment(value) = entity.payload else { continue };
        if changed.iter().any(|item| item.kind() == value.resource_kind && item.id == value.resource_id) {
            queue(conn, &value, false)?;
        }
    }
    Ok(())
}

pub(super) fn apply_pending(db: &Database, store: &dyn CredentialStore, registry: &Registry, home: &Path) -> Result<(), String> {
    let items = db.with_connection(|conn| pending(conn))?;
    for (id, item) in items {
        let key = format!("deployment:{id}");
        match apply(db, store, registry, home, &item) {
            Ok(()) => {
                db.with_connection(|conn| {
                    let mut latest = pending(conn)?;
                    latest.remove(&id);
                    save(conn, &latest)
                })?;
                super::clear_blocker(db, &key)?;
            }
            Err(error) => super::replace_blocker(db, &key,
                &format!("{} · {}", item.deployment.tool, item.deployment.resource_kind), "retry", &error),
        }
    }
    Ok(())
}

fn apply(db: &Database, store: &dyn CredentialStore, registry: &Registry, home: &Path, item: &Pending) -> Result<(), String> {
    let value = &item.deployment;
    let scope_key = paths::decode_scope(&value.scope_key)?;
    let (context_id, scope) = crate::accounts::selection::split_key(&scope_key);
    let context = context_id.filter(|id| *id != "default")
        .map(|id| crate::accounts::selection::by_id(db, &value.tool, id)).transpose()?;
    let _context = crate::accounts::selection::enter(context);
    let project = scope.strip_prefix("project:");
    let scope = if project.is_some() { Scope::Project } else { Scope::Global };
    if let Some(path) = project {
        if !Path::new(path).is_dir() { return Err(format!("目录不存在：{path}")) }
    }
    let custom = super::tool_choice(db, &value.tool);
    let probe = crate::native::adapter::probe_registered(registry, &value.tool, custom.as_deref(), home, project.map(Path::new), scope)?;
    if !probe.installations.iter().any(|installation| installation.status == "available" && probe.selected_path.as_deref() == Some(installation.path.as_str())) {
        return Err("目标 CLI 尚未安装或不可用；资料已保存，安装后同步会自动应用".into());
    }
    if value.resource_kind == "mcp" {
        let mut target = mcp::McpTargetRequest {
            context_id: context_id.filter(|id| *id != "default").map(str::to_owned),
            tool_id: value.tool.clone(), scope, project_path: project.map(str::to_owned),
            enabled: value.enabled, baseline_hash: None, allow_replace: true, preview_token: None,
        };
        if item.remove {
            let definition = mcp::get_definition(db, &value.resource_id)?;
            return mcp::remove_native(db, store, registry, home, &target, &definition.name);
        }
        let preview = mcp::preview_targets(db, registry, home, &value.resource_id, vec![target.clone()])
            .into_iter().next().ok_or("无法预览 MCP 恢复")?;
        target.context_id = preview.context_id;
        target.baseline_hash = preview.baseline_hash;
        target.preview_token = preview.preview_token;
        let result = mcp::distribute(db, store, registry, home, &value.resource_id, vec![target])
            .into_iter().next().ok_or("无法恢复 MCP")?;
        if matches!(result.status, "written" | "unchanged") { Ok(()) } else { Err(result.detail) }
    } else if item.remove {
        if !skills::enabled(db, registry, home, &value.resource_id, &value.tool, scope, project)? {
            skills::set_enabled(db, store, registry, home, &value.resource_id, &value.tool, scope, project, true)?;
        }
        let result = skills::remove(db, registry, home, &value.resource_id, &value.tool, scope, project);
        if result.status == "failed" { Err(result.detail) } else { Ok(()) }
    } else {
        let preview = skills::preview_target(db, registry, home, &value.resource_id, &value.tool, scope, project)?;
        let result = skills::install_confirmed(db, registry, home, &value.resource_id, &value.tool, scope, project, preview.preview_token.as_deref(), true);
        if result.status == "failed" { return Err(result.detail) }
        if skills::enabled(db, registry, home, &value.resource_id, &value.tool, scope, project)? == value.enabled {
            Ok(())
        } else {
            skills::set_enabled(db, store, registry, home, &value.resource_id, &value.tool, scope, project, value.enabled)
        }
    }
}
