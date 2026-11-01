//! Resource names are unique locally; UUIDs are not shared when two devices
//! independently create the same resource. Coalesce equal resources using the
//! smaller ID, and retain aliases for incoming deployment references.
use super::{paths, PortableEntity, PortableMcp, PortablePayload, PortableSkill};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};

const ALIASES: &str = "sync_resource_aliases_v1";
pub(super) const CONFLICT: &str = "同步资源同名冲突：";

fn aliases(conn: &Connection) -> Result<BTreeMap<String, String>, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key=?1",
            [ALIASES],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    json.map(|text| serde_json::from_str(&text).map_err(|_| "资源合并记录损坏".into()))
        .transpose()
        .map(|items| items.unwrap_or_default())
}

pub(super) fn canonical(conn: &Connection, kind: &str, id: &str) -> Result<String, String> {
    let aliases = aliases(conn)?;
    let mut current = id.to_owned();
    let mut seen = BTreeSet::new();
    while let Some(next) = aliases.get(&format!("{kind}:{current}")) {
        if !seen.insert(current.clone()) {
            return Err("资源合并记录包含循环".into());
        }
        current = next.clone();
    }
    Ok(current)
}

pub(super) fn name(entity: &PortableEntity) -> Option<&str> {
    match &entity.payload {
        PortablePayload::Mcp(value) => Some(&value.definition.name),
        PortablePayload::Skill(value) => Some(&value.name),
        _ => None,
    }
}

pub(super) fn equivalent(left: &PortableEntity, right: &PortableEntity) -> bool {
    let normalize = |entity: &PortableEntity| {
        let mut entity = entity.clone();
        entity.id.clear();
        match &mut entity.payload {
            PortablePayload::Mcp(value) => {
                let def = &mut value.definition;
                def.id.clear();
                def.version = 0;
                def.updated_at = None;
                def.in_library = false;
                def.command = paths::command(&def.command);
                for arg in &mut def.args {
                    *arg = paths::encode(arg);
                }
                for value in def.env.values_mut() {
                    *value = paths::encode(value);
                }
                value.pending_fields.clear();
            }
            PortablePayload::Skill(value) => {
                value.id.clear();
                value.pending_fields.clear();
            }
            PortablePayload::Deployment(value) => value.resource_id.clear(),
            _ => return None,
        }
        serde_json::to_value(entity).ok()
    };
    let left = normalize(left);
    left.is_some() && left == normalize(right)
}

pub(super) fn matching<'a>(
    conn: &Connection,
    incoming: &PortableEntity,
    local: &'a BTreeMap<String, PortableEntity>,
) -> Result<Option<&'a PortableEntity>, String> {
    if let Some(existing) = local.get(&incoming.key()) {
        return Ok(Some(existing));
    }
    if let Some(name) = name(incoming) {
        let id = canonical(conn, incoming.kind(), &incoming.id)?;
        if let Some(existing) = local.get(&format!("{}:{id}", incoming.kind())) {
            return Ok(Some(existing));
        }
        return Ok(local
            .values()
            .find(|item| item.kind() == incoming.kind() && self::name(item) == Some(name)));
    }
    if let PortablePayload::Deployment(value) = &incoming.payload {
        let mut value = value.clone();
        value.resource_id = canonical(conn, &value.resource_kind, &value.resource_id)?;
        return Ok(local.get(&format!("deployment:{}", value.id())));
    }
    Ok(None)
}

pub(super) fn obsolete(conn: &Connection, entity: &PortableEntity) -> Result<bool, String> {
    match &entity.payload {
        PortablePayload::Mcp(_) | PortablePayload::Skill(_) => {
            Ok(canonical(conn, entity.kind(), &entity.id)? != entity.id)
        }
        PortablePayload::Deployment(value) => {
            Ok(canonical(conn, &value.resource_kind, &value.resource_id)? != value.resource_id)
        }
        _ => Ok(false),
    }
}

pub(super) fn with_identity(
    mut value: PortableEntity,
    template: &PortableEntity,
) -> PortableEntity {
    value.id = template.id.clone();
    match (&mut value.payload, &template.payload) {
        (PortablePayload::Mcp(value), _) => value.definition.id = template.id.clone(),
        (PortablePayload::Skill(value), _) => value.id = template.id.clone(),
        (PortablePayload::Deployment(value), PortablePayload::Deployment(template)) => {
            value.resource_id = template.resource_id.clone()
        }
        _ => {}
    }
    value
}

fn existing_named(
    conn: &Connection,
    entity: &PortableEntity,
) -> Result<Option<PortableEntity>, String> {
    match &entity.payload {
        PortablePayload::Mcp(value) => {
            let text: Option<String> = conn
                .query_row(
                    "SELECT data_json FROM mcp_definitions WHERE name=?1",
                    [&value.definition.name],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            text.map(|text| {
                let definition: crate::resources::mcp::McpDefinition =
                    serde_json::from_str(&text).map_err(|_| "MCP 资料损坏")?;
                Ok(PortableEntity {
                    id: definition.id.clone(),
                    payload: PortablePayload::Mcp(PortableMcp {
                        definition,
                        pending_fields: vec![],
                    }),
                })
            })
            .transpose()
        }
        PortablePayload::Skill(value) => {
            let row: Option<(String,String,String,String,String)> = conn.query_row("SELECT id,name,description,digest,files_json FROM skill_packages WHERE name=?1", [&value.name], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))
                .optional().map_err(|error| error.to_string())?;
            row.map(|(id, name, description, digest, files)| {
                Ok(PortableEntity {
                    id: id.clone(),
                    payload: PortablePayload::Skill(PortableSkill {
                        id,
                        name,
                        description,
                        digest,
                        files: serde_json::from_str(&files).map_err(|_| "Skill 资料损坏")?,
                        pending_fields: vec![],
                    }),
                })
            })
            .transpose()
        }
        _ => Ok(None),
    }
}

pub(super) fn prepare(
    conn: &Connection,
    entity: &mut PortableEntity,
    allow_replace: bool,
) -> Result<(), String> {
    if let PortablePayload::Deployment(value) = &mut entity.payload {
        value.resource_id = canonical(conn, &value.resource_kind, &value.resource_id)?;
        return Ok(());
    }
    if name(entity).is_none() {
        return Ok(());
    }
    let original = entity.id.clone();
    let kind = entity.kind();
    let resolved = canonical(conn, kind, &original)?;
    let mut template = entity.clone();
    template.id = resolved;
    *entity = with_identity(entity.clone(), &template);
    let Some(existing) = existing_named(conn, entity)? else {
        return Ok(());
    };
    if existing.id == entity.id {
        return Ok(());
    }
    // A rename into another occupied name is not a duplicate import. Preserve
    // both existing resources (and their native names) until that edit is resolved.
    let sql = if kind == "mcp" {
        "SELECT EXISTS(SELECT 1 FROM mcp_definitions WHERE id=?1)"
    } else {
        "SELECT EXISTS(SELECT 1 FROM skill_packages WHERE id=?1)"
    };
    if conn
        .query_row(sql, [&entity.id], |row| row.get::<_, bool>(0))
        .map_err(|error| error.to_string())?
    {
        return Err(format!("{CONFLICT}{}", entity.key()));
    }
    let equal = equivalent(&existing, entity);
    if !equal && !allow_replace {
        return Err(format!("{CONFLICT}{}", existing.key()));
    }
    let winner = existing.id.clone().min(entity.id.clone());
    let loser = if winner == entity.id {
        existing.id.clone()
    } else {
        entity.id.clone()
    };
    // Deferred FK checks let the ID and all ownership references move in the
    // same transaction, without deleting/recreating the resource or its files.
    conn.execute_batch("PRAGMA defer_foreign_keys = ON")
        .map_err(|error| error.to_string())?;
    if existing.id != winner {
        match &existing.payload {
            PortablePayload::Mcp(value) => {
                let mut def = value.definition.clone();
                def.id = winner.clone();
                conn.execute(
                    "UPDATE mcp_definitions SET id=?1,data_json=?2 WHERE id=?3",
                    params![
                        winner,
                        serde_json::to_string(&def).map_err(|error| error.to_string())?,
                        existing.id
                    ],
                )
                .map_err(|error| error.to_string())?;
                conn.execute(
                    "UPDATE mcp_targets SET definition_id=?1 WHERE definition_id=?2",
                    params![winner, existing.id],
                )
                .map_err(|error| error.to_string())?;
            }
            PortablePayload::Skill(_) => {
                conn.execute(
                    "UPDATE skill_packages SET id=?1 WHERE id=?2",
                    params![winner, existing.id],
                )
                .map_err(|error| error.to_string())?;
                conn.execute(
                    "UPDATE skill_installations SET package_id=?1 WHERE package_id=?2",
                    params![winner, existing.id],
                )
                .map_err(|error| error.to_string())?;
                conn.execute(
                    "UPDATE skill_operations SET package_id=?1 WHERE package_id=?2",
                    params![winner, existing.id],
                )
                .map_err(|error| error.to_string())?;
                let mut statement = conn.prepare("SELECT tool,scope_key FROM skill_installations WHERE package_id=?1 UNION SELECT tool,scope_key FROM skill_operations WHERE package_id=?1")
                    .map_err(|error| error.to_string())?;
                let scopes = statement
                    .query_map([&winner], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                drop(statement);
                for (tool, scope) in scopes {
                    let old_key = format!("native_skill_switch:{tool}:{scope}:{}", existing.id);
                    let value: Option<String> = conn
                        .query_row(
                            "SELECT value FROM app_settings WHERE key=?1",
                            [&old_key],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| error.to_string())?;
                    if let Some(value) = value {
                        conn.execute("INSERT INTO app_settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![format!("native_skill_switch:{tool}:{scope}:{winner}"),value]).map_err(|error| error.to_string())?;
                        conn.execute("DELETE FROM app_settings WHERE key=?1", [&old_key])
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    let mut items = aliases(conn)?;
    items.insert(format!("{kind}:{loser}"), winner.clone());
    conn.execute("INSERT INTO app_settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![ALIASES,serde_json::to_string(&items).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
    super::resources::remap_resource(conn, kind, &loser, &winner)?;
    if equal {
        let in_library = match &entity.payload {
            PortablePayload::Mcp(value) => value.definition.in_library,
            _ => false,
        };
        *entity = existing;
        if let PortablePayload::Mcp(value) = &mut entity.payload {
            value.definition.in_library |= in_library;
        }
    }
    template.id = winner;
    *entity = with_identity(entity.clone(), &template);
    Ok(())
}
