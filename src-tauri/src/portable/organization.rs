//! Logical project organization in encrypted bundles. Locations remain provenance-scoped hints;
//! no manifest link, session, native profile application or credential is restored here.
use super::{read_rows, PortableEntity, PortablePayload, PortableSnapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableRepository {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableLocation {
    pub id: String,
    pub host_id: String,
    pub path: Option<String>,
    pub native_project_id: Option<String>,
    pub target_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMember {
    pub repository_id: String,
    pub favorite: bool,
    pub locations: Vec<PortableLocation>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableLegacyMap {
    pub project_id: String,
    pub repository_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableWorkspace {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub members: Vec<PortableMember>,
    pub legacy_mappings: Vec<PortableLegacyMap>,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 160 && !name.chars().any(char::is_control)
}
pub(super) fn validate_repository(value: &PortableRepository) -> bool {
    valid_id(&value.id) && valid_name(&value.name)
}
pub(super) fn validate_workspace(value: &PortableWorkspace) -> bool {
    if !valid_id(&value.id)
        || !valid_name(&value.name)
        || value.revision == 0
        || value.revision > 9_007_199_254_740_991
        || value.members.len() > 10_000
    {
        return false;
    }
    let mut members = BTreeSet::new();
    let mut locations = BTreeSet::new();
    let mut paths = BTreeSet::new();
    let mut maps = BTreeSet::new();
    for member in &value.members {
        if !valid_id(&member.repository_id) || !members.insert(&member.repository_id) {
            return false;
        }
        for location in &member.locations {
            if !valid_id(&location.id)
                || !locations.insert(&location.id)
                || uuid::Uuid::parse_str(&location.host_id).is_err()
                || location
                    .native_project_id
                    .as_deref()
                    .is_some_and(|id| !valid_id(id))
                || location
                    .target_id
                    .as_deref()
                    .is_some_and(|id| !valid_id(id))
            {
                return false;
            }
            if let Some(path) = &location.path {
                if path.is_empty()
                    || path.len() > 16_384
                    || path.chars().any(char::is_control)
                    || !crate::workspaces::absolute_location_path(path)
                    || !paths.insert((&location.host_id, path))
                {
                    return false;
                }
            }
        }
    }
    value.legacy_mappings.iter().all(|map| {
        valid_id(&map.project_id) && valid_id(&map.repository_id) && maps.insert(&map.project_id)
    })
}
pub(super) fn collect(conn: &Connection) -> Result<Vec<PortableEntity>, String> {
    let mut entities = Vec::new();
    for (id, name) in read_rows(
        conn,
        "SELECT id,name FROM workspace_repositories ORDER BY id",
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )? {
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Repository(PortableRepository { id, name }),
        });
    }
    for (id, name, revision) in read_rows(
        conn,
        "SELECT id,name,revision FROM workspace_projects ORDER BY id",
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )? {
        let mut query = conn.prepare("SELECT repository_id,favorite FROM workspace_members WHERE workspace_id=?1 ORDER BY repository_id").map_err(|e|e.to_string())?;
        let members = query
            .query_map([&id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        for (repository_id, favorite) in members {
            let mut query = conn.prepare("SELECT l.id,l.host_id,l.path,l.native_project_id,l.target_id FROM workspace_locations l JOIN workspace_member_locations m ON m.location_id=l.id WHERE m.workspace_id=?1 AND m.repository_id=?2 ORDER BY l.id").map_err(|e|e.to_string())?;
            let locations = query
                .query_map(params![id, repository_id], |row| {
                    Ok(PortableLocation {
                        id: row.get(0)?,
                        host_id: row.get(1)?,
                        path: row.get(2)?,
                        native_project_id: row.get(3)?,
                        target_id: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            output.push(PortableMember {
                repository_id,
                favorite,
                locations,
            });
        }
        let mut query = conn.prepare("SELECT project_id,repository_id FROM workspace_legacy_map WHERE workspace_id=?1 ORDER BY project_id").map_err(|e|e.to_string())?;
        let legacy_mappings = query
            .query_map([&id], |row| {
                Ok(PortableLegacyMap {
                    project_id: row.get(0)?,
                    repository_id: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        entities.push(PortableEntity {
            id: id.clone(),
            payload: PortablePayload::Workspace(PortableWorkspace {
                id,
                name,
                revision: revision.max(1) as u64,
                members: output,
                legacy_mappings,
            }),
        });
    }
    Ok(entities)
}
#[cfg(not(test))]
fn local_host() -> Result<String, String> {
    crate::workspaces::local_host_id()
}
#[cfg(test)]
fn local_host() -> Result<String, String> {
    Ok("11111111-1111-4111-8111-111111111111".into())
}
fn common(host: &str, current: &str, path: Option<&str>) -> Option<std::path::PathBuf> {
    if host != current {
        return None;
    }
    let path = std::path::Path::new(path?);
    path.is_absolute()
        .then(|| crate::git_context::repository_identity(path))
        .flatten()
        .map(|(_, common)| common)
}
/// Predictable association conflicts are presented before any row in the bundle is restored.
pub(super) fn conflict(
    conn: &Connection,
    value: &PortableWorkspace,
) -> Result<Option<String>, String> {
    let host = local_host()?;
    let mut commons = BTreeMap::new();
    let existing = read_rows(conn,"SELECT DISTINCT l.repository_id,l.host_id,l.path FROM workspace_locations l JOIN workspace_member_locations m ON m.location_id=l.id WHERE m.workspace_id<>''",|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?)))?;
    for (repo, source, path) in existing {
        if let Some(identity) = common(&source, &host, path.as_deref()) {
            commons.insert(identity, repo);
        }
    }
    for member in &value.members {
        for location in &member.locations {
            let mut query=conn.prepare("SELECT id,repository_id,host_id,path,EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=workspace_locations.id AND m.workspace_id<>?4) FROM workspace_locations WHERE id=?1 OR (host_id=?2 AND path=?3 AND EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=workspace_locations.id))").map_err(|e|e.to_string())?;
            let existing = query
                .query_map(
                    params![location.id, location.host_id, location.path, value.id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, bool>(4)?,
                        ))
                    },
                )
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for (id, repo, source, path, other_member) in existing {
                if repo != member.repository_id
                    || id != location.id
                    || (other_member && (source != location.host_id || path != location.path))
                {
                    return Ok(Some(format!(
                        "工作位置已有不同的本机关联，原关联保留：{}",
                        location.path.as_deref().unwrap_or(&location.id)
                    )));
                }
            }
            if let Some(identity) = common(&location.host_id, &host, location.path.as_deref()) {
                if commons
                    .get(&identity)
                    .is_some_and(|repo| repo != &member.repository_id)
                {
                    return Ok(Some(
                        "工作位置的 Git 身份已关联另一仓库，请先修复本机关联".into(),
                    ));
                }
                commons.insert(identity, member.repository_id.clone());
            }
        }
    }
    for mapping in &value.legacy_mappings {
        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT workspace_id,repository_id FROM workspace_legacy_map WHERE project_id=?1",
                [&mapping.project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if existing
            .is_some_and(|(workspace, repo)| workspace != value.id || repo != mapping.repository_id)
        {
            return Ok(Some(format!(
                "旧目录 {} 已有不同的精确映射，原映射保留",
                mapping.project_id
            )));
        }
    }
    Ok(None)
}
pub(super) fn restore_repository(
    conn: &Connection,
    value: &PortableRepository,
) -> Result<(), String> {
    conn.execute("INSERT INTO workspace_repositories(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![value.id,value.name]).map_err(|e|e.to_string())?;
    Ok(())
}
pub(super) fn restore_workspace(
    conn: &Connection,
    value: &PortableWorkspace,
) -> Result<(), String> {
    if let Some(reason) = conflict(conn, value)? {
        return Err(reason);
    }
    let mut unresolved = Vec::new();
    for member in &value.members {
        if !conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM workspace_repositories WHERE id=?1)",
                [&member.repository_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        {
            conn.execute(
                "INSERT INTO workspace_repositories(id,name) VALUES(?1,?2)",
                params![
                    member.repository_id,
                    format!("待关联仓库 {}", member.repository_id)
                ],
            )
            .map_err(|e| e.to_string())?;
            unresolved.push(member.repository_id.clone());
        }
    }
    for mapping in &value.legacy_mappings {
        if !conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                [&mapping.project_id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|e| e.to_string())?
        {
            unresolved.push(format!("旧目录 {}", mapping.project_id));
        }
    }
    conn.execute("INSERT INTO workspace_projects(id,name,revision,last_error) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,manifest_path=NULL,manifest_revision=NULL,manifest_digest=NULL,manifest_json=NULL,last_error=excluded.last_error",params![value.id,value.name,value.revision as i64,(!unresolved.is_empty()).then(||format!("迁移包部分引用尚未关联，原标识已保留：{}",unresolved.join("、")))]).map_err(|e|e.to_string())?;
    conn.execute(
        "DELETE FROM workspace_member_locations WHERE workspace_id=?1",
        [&value.id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM workspace_members WHERE workspace_id=?1",
        [&value.id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("UPDATE workspace_locations SET path=NULL WHERE path IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_member_locations m WHERE m.location_id=workspace_locations.id)",[]).map_err(|e|e.to_string())?;
    for member in &value.members {
        conn.execute(
            "INSERT INTO workspace_members(workspace_id,repository_id,favorite) VALUES(?1,?2,?3)",
            params![value.id, member.repository_id, member.favorite],
        )
        .map_err(|e| e.to_string())?;
        for location in &member.locations {
            conn.execute("INSERT INTO workspace_locations(id,repository_id,host_id,path,native_project_id,target_id,kind) VALUES(?1,?2,?3,?4,?5,?6,'hint') ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id,path=excluded.path,native_project_id=excluded.native_project_id,target_id=excluded.target_id,kind='hint'",params![location.id,member.repository_id,location.host_id,location.path,location.native_project_id,location.target_id]).map_err(|e|e.to_string())?;
            conn.execute("INSERT INTO workspace_member_locations(workspace_id,repository_id,location_id) VALUES(?1,?2,?3)",params![value.id,member.repository_id,location.id]).map_err(|e|e.to_string())?;
        }
    }
    for map in &value.legacy_mappings {
        conn.execute("INSERT INTO workspace_legacy_map(project_id,workspace_id,repository_id) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET workspace_id=excluded.workspace_id,repository_id=excluded.repository_id",params![map.project_id,value.id,map.repository_id]).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub(super) fn include_dependencies(snapshot: &PortableSnapshot, keys: &mut BTreeSet<String>) {
    loop {
        let before = keys.len();
        for entity in &snapshot.entities {
            if !keys.contains(&entity.key()) {
                continue;
            }
            match &entity.payload {
                PortablePayload::Workspace(value) => {
                    for member in &value.members {
                        keys.insert(format!("repository:{}", member.repository_id));
                    }
                }
                PortablePayload::Prompt(value) => match &value.metadata.scope {
                    crate::prompts::PromptScope::Workspace { workspace_id } => {
                        keys.insert(format!("workspace:{workspace_id}"));
                    }
                    crate::prompts::PromptScope::Repository { repository_id } => {
                        keys.insert(format!("repository:{repository_id}"));
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        if keys.len() == before {
            break;
        }
    }
}
