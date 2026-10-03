use std::path::Path;

use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::library::{self, LibraryKind};
use crate::native::adapter::Scope;
use crate::adapters::Registry;
use crate::native::transaction::{self, TextPatch};
use crate::projects;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleTarget {
    #[serde(default)]
    pub context_id: Option<String>,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub baseline_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePreview {
    pub target: RuleTarget,
    pub path: Option<String>,
    pub status: &'static str,
    pub detail: String,
    pub existing: String,
    pub proposed: String,
    pub changed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleApplyResult {
    pub target: RuleTarget,
    pub path: Option<String>,
    pub status: &'static str,
    pub detail: String,
}

fn path_for(
    db: &Database,
    registry: &Registry,
    home: &Path,
    target: &RuleTarget,
) -> Result<std::path::PathBuf, String> {
    let _context=if let Some(id)=&target.context_id {crate::accounts::selection::enter(if id.is_empty() {None} else {Some(crate::accounts::selection::by_id(db,&target.tool_id,id)?)})} else {crate::accounts::selection::enter_bound(db,home,&target.tool_id,target.scope,target.project_path.as_deref().map(Path::new))?};
    let adapter = registry
        .get(&target.tool_id)
        .ok_or("此 CLI 尚无注册适配器")?;
    let project = match target.scope {
        Scope::Global => None,
        Scope::Project => Some(projects::checked_directory(
            target.project_path.as_deref().ok_or("请选择项目目录")?,
        )?),
    };
    adapter
        .rule_path(target.scope, home, project.as_deref())
        .ok_or_else(|| "此 CLI 在当前范围没有已确认的原生规则文件".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRule { pub context_id: Option<String>, pub path: String, pub text: String, pub fingerprint: String }

pub fn read_current(db: &Database, registry: &Registry, home: &Path, target: &RuleTarget) -> Result<NativeRule, String> {
    let _context=crate::accounts::selection::enter_bound(db,home,&target.tool_id,target.scope,target.project_path.as_deref().map(Path::new))?;
    let path = path_for(db,registry, home, target)?;
    let text = transaction::read_native(&path)?;
    Ok(NativeRule {context_id:crate::accounts::selection::current(&target.tool_id).map(|ctx|ctx.id),path:path.display().to_string(), fingerprint:transaction::fingerprint(text.as_bytes()), text})
}

pub fn save_current(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, target: &RuleTarget, original: &str, edited: &str) -> Result<transaction::ApplyOutcome, String> {
    let _context=crate::accounts::selection::enter_bound(db,home,&target.tool_id,target.scope,target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id,target.context_id.as_deref())?;
    if edited.len() > 1024 * 1024 { return Err("规则内容超过 1 MiB".into()); }
    let path = path_for(db,registry, home, target)?;
    transaction::apply_text(db, credentials, &[TextPatch {path, baseline:original.into(),contents:edited.into(),sensitive:false}], |_| Ok(()))
}

pub fn enabled(db: &Database, registry: &Registry, home: &Path, target: &RuleTarget) -> Result<bool,String> {
    let file=read_current(db,registry,home,target)?;
    Ok(!file.text.is_empty())
}
pub fn set_enabled(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, target: &RuleTarget, enabled: bool) -> Result<(),String> {
    let _context=crate::accounts::selection::enter_bound(db,home,&target.tool_id,target.scope,target.project_path.as_deref().map(Path::new))?;
    crate::accounts::selection::validate_expected(&target.tool_id,target.context_id.as_deref())?;
    let path=path_for(db,registry,home,target)?; let current=transaction::read_native(&path)?;
    let key=format!("native_rule_switch:{}:{}",target.tool_id,path.display());
    let record:Option<String>=db.with_connection(|conn| conn.query_row("SELECT value FROM app_settings WHERE key=?1",[&key],|row| row.get(0)).optional().map_err(|e| e.to_string()))?;
    if enabled {
        let id=record.ok_or("没有由本应用停用的规则备份，请编辑当前规则")?;
        if !current.is_empty() { return Err("规则已被外部修改，请在编辑器比较后选择，未覆盖当前内容".into()); }
        transaction::restore_backup(db,credentials,&path,&id,&current,|tx| tx.execute("DELETE FROM app_settings WHERE key=?1",[&key]).map(|_|()).map_err(|e| e.to_string()))?;
    } else {
        if current.is_empty() {return Ok(());}
        transaction::apply_text_with_id(db,credentials,&[TextPatch{path,baseline:current,contents:String::new(),sensitive:true}],|tx,id| {
            tx.execute("INSERT INTO app_settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,id]).map(|_|()).map_err(|e| e.to_string())
        })?;
    }
    Ok(())
}

pub fn preview(
    db: &Database,
    registry: &Registry,
    home: &Path,
    rule_id: &str,
    targets: Vec<RuleTarget>,
) -> Vec<RulePreview> {
    let rule = library::get(db, rule_id).and_then(|item| {
        if item.kind == LibraryKind::Rule {
            Ok(item)
        } else {
            Err("所选资料不是长期规则".into())
        }
    });
    targets
        .into_iter()
        .map(|target| {
            let mut result = RulePreview {
                target,
                path: None,
                status: "unsupported",
                detail: String::new(),
                existing: String::new(),
                proposed: String::new(),
                changed: false,
            };
            let found = (|| {
                let rule = rule.as_ref().map_err(Clone::clone)?;
                let _context=crate::accounts::selection::enter_bound(db,home,&result.target.tool_id,result.target.scope,result.target.project_path.as_deref().map(Path::new))?;
                result.target.context_id=Some(crate::accounts::selection::current(&result.target.tool_id).map(|ctx|ctx.id).unwrap_or_default());
                let path = path_for(db,registry, home, &result.target)?;
                let existing = transaction::read_native(&path)?;
                Ok((path, existing, rule.body.clone()))
            })();
            match found {
                Ok((path, existing, proposed)) => {
                    result.target.baseline_hash =
                        Some(transaction::fingerprint(existing.as_bytes()));
                    result.path = Some(path.display().to_string());
                    result.changed = existing != proposed;
                    result.existing = existing;
                    result.proposed = proposed;
                    result.status = "ready";
                    result.detail = if result.changed {
                        "将替换此原生规则文件；请先比较完整正文".into()
                    } else {
                        "与当前原生规则文件一致".into()
                    };
                }
                Err(error) => result.detail = error,
            }
            result
        })
        .collect()
}

pub fn apply(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    rule_id: &str,
    expected_version: u64,
    targets: Vec<RuleTarget>,
) -> Vec<RuleApplyResult> {
    let rule = library::get(db, rule_id).and_then(|item| {
        if item.kind != LibraryKind::Rule {
            Err("所选资料不是长期规则".into())
        } else if item.version != expected_version {
            Err("规则正文已变化，请重新预览".into())
        } else {
            Ok(item)
        }
    });
    targets
        .into_iter()
        .map(|target| {
            let mut result = RuleApplyResult {
                target,
                path: None,
                status: "failed",
                detail: String::new(),
            };
            let attempt = (|| {
                let rule = rule.as_ref().map_err(Clone::clone)?;
                let expected = result
                    .target
                    .baseline_hash
                    .as_deref()
                    .ok_or("请先预览原生差异")?;
                let _context=crate::accounts::selection::enter_bound(db,home,&result.target.tool_id,result.target.scope,result.target.project_path.as_deref().map(Path::new))?;
                crate::accounts::selection::validate_expected(&result.target.tool_id,result.target.context_id.as_deref())?;
                let path = path_for(db,registry, home, &result.target)?;
                result.path = Some(path.display().to_string());
                let existing = transaction::read_native(&path)?;
                if existing == rule.body {
                    return Ok("already_matching".to_owned());
                }
                if transaction::fingerprint(existing.as_bytes()) != expected {
                    return Err("原生规则文件在预览后发生变化，请重新预览".into());
                }
                let outcome = transaction::apply_text(
                    db,
                    credentials,
                    &[TextPatch {
                        path,
                        baseline: existing,
                        contents: rule.body.clone(),
                        sensitive: false,
                    }],
                    |_| Ok(()),
                )?;
                Ok(outcome.status.to_owned())
            })();
            match attempt {
                Ok(status) => {
                    result.status = "written";
                    result.detail = status;
                }
                Err(error) => result.detail = error,
            }
            result
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePlacement {
    pub context_id: Option<String>,
    pub rule_id: String,
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub state: &'static str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleClientSelection {
    pub tool_ids: Vec<String>,
    pub scope: Scope,
    pub project_path: Option<String>,
    #[serde(default)]
    pub allow_replace: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSyncResult {
    pub tool_id: String,
    pub path: Option<String>,
    pub status: &'static str,
    pub detail: String,
    pub existing: String,
    pub proposed: String,
}

struct Member {
    rule_id: String,
    position: i64,
}

fn display_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

fn scope_key(scope: Scope, project_path: Option<&str>) -> Result<String, String> {
    match scope {
        Scope::Global => Ok("global".into()),
        Scope::Project => {
            let path = projects::checked_directory(project_path.ok_or("请选择项目目录")?)?;
            Ok(format!("project:{}", display_path(&path)))
        }
    }
}

fn split_scope(scope_key: &str) -> (Scope, Option<String>) {
    crate::accounts::selection::split_key(scope_key).1
        .strip_prefix("project:")
        .map(|path| (Scope::Project, Some(path.to_owned())))
        .unwrap_or((Scope::Global, None))
}

fn section(title: &str, body: &str) -> String {
    let heading = format!("# {}", title.trim());
    let body = body.trim();
    if body.is_empty() {
        heading
    } else if body.starts_with("# ") {
        body.to_owned()
    } else {
        format!("{heading}\n\n{body}")
    }
}

fn compose(parts: &[(String, String)]) -> String {
    let text = parts
        .iter()
        .map(|(title, body)| section(title, body))
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        String::new()
    } else {
        format!("{text}\n")
    }
}

fn members(db: &Database, tool: &str, scope_key: &str) -> Result<Vec<Member>, String> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT rule_id, position FROM rule_placements WHERE tool = ?1 AND scope_key = ?2 ORDER BY position, rule_id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![tool, scope_key], |row| {
                Ok(Member { rule_id: row.get(0)?, position: row.get(1)? })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
}

fn composed(db: &Database, group: &[Member]) -> Result<String, String> {
    let mut parts = Vec::new();
    for member in group {
        let item = library::get(db, &member.rule_id)?;
        if item.kind == LibraryKind::Rule {
            parts.push((item.title, item.body));
        }
    }
    Ok(compose(&parts))
}

fn owned_hash(db: &Database, tool: &str, scope_key: &str) -> Result<Option<String>, String> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT managed_hash FROM rule_files WHERE tool = ?1 AND scope_key = ?2",
            params![tool, scope_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

fn store_hash(db: &Database, tool: &str, scope_key: &str, hash: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO rule_files (tool, scope_key, managed_hash) VALUES (?1, ?2, ?3)
             ON CONFLICT(tool, scope_key) DO UPDATE SET managed_hash = excluded.managed_hash",
            params![tool, scope_key, hash],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}

fn remember(db: &Database, rule_id: &str, tool: &str, scope_key: &str, position: i64) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO rule_placements (rule_id, tool, scope_key, position) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(rule_id, tool, scope_key) DO UPDATE SET position = excluded.position",
            params![rule_id, tool, scope_key, position],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}

fn forget(db: &Database, rule_id: &str, tool: &str, scope_key: &str) -> Result<(), String> {
    db.with_connection(|conn| {
        conn.execute(
            "DELETE FROM rule_placements WHERE rule_id = ?1 AND tool = ?2 AND scope_key = ?3",
            params![rule_id, tool, scope_key],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}

struct PlannedWrite {
    tool_id: String,
    scope_key: String,
    path: std::path::PathBuf,
    existing: String,
    proposed: String,
    members: Vec<Member>,
    included: bool,
}

pub fn list_placements(db: &Database, registry: &Registry, home: &Path) -> Result<Vec<RulePlacement>, String> {
    let mut rows = db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT rule_id, tool, scope_key FROM rule_placements ORDER BY tool, scope_key, position, rule_id")
            .map_err(|error| error.to_string())?;
        let listed = statement
            .query_map([], |row| {
                let scope_key: String = row.get(2)?;
                let (scope, project_path) = split_scope(&scope_key);
                Ok((RulePlacement { context_id:crate::accounts::selection::split_key(&scope_key).0.map(str::to_owned), rule_id: row.get(0)?, tool_id: row.get(1)?, scope, project_path, state: "drifted" }, scope_key))
            })
            .map_err(|error| error.to_string())?;
        listed.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })?;
    let mut seen = std::collections::HashMap::<(String, String), &'static str>::new();
    for (place, scope_key) in &mut rows {
        let cache_key = (place.tool_id.clone(), scope_key.clone());
        let state = if let Some(state) = seen.get(&cache_key) {
            *state
        } else {
            let state = target_state(db, registry, home, &place.tool_id, scope_key, place.scope, place.project_path.as_deref());
            seen.insert(cache_key, state);
            state
        };
        place.state = state;
    }
    Ok(rows.into_iter().map(|(place, _)| place).collect())
}

fn target_state(db: &Database, registry: &Registry, home: &Path, tool: &str, scope_key: &str, scope: Scope, project_path: Option<&str>) -> &'static str {
    let target = RuleTarget { context_id: Some(crate::accounts::selection::split_key(scope_key).0.unwrap_or("").to_owned()), tool_id: tool.to_owned(), scope, project_path: project_path.map(str::to_owned), baseline_hash: None };
    let Ok(path) = path_for(db,registry, home, &target) else { return "unavailable"; };
    let Ok(existing) = transaction::read_native(&path) else { return "unavailable"; };
    let owned = match owned_hash(db, tool, scope_key) {
        Ok(hash) => hash,
        Err(_) => return "unavailable",
    };
    if owned.as_deref() == Some(transaction::fingerprint(existing.as_bytes()).as_str()) {
        return "current";
    }
    match members(db, tool, scope_key).and_then(|group| composed(db, &group)) {
        Ok(proposed) if proposed == existing => "current",
        Ok(_) => "drifted",
        Err(_) => "unavailable",
    }
}

pub fn sync_clients(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    rule_id: &str,
    expected_version: u64,
    selection: RuleClientSelection,
) -> Result<Vec<RuleSyncResult>, String> {
    let rule = library::get(db, rule_id)?;
    if rule.kind != LibraryKind::Rule {
        return Err("所选资料不是长期规则".into());
    }
    if rule.version != expected_version {
        return Err("规则正文已变化，请重新保存".into());
    }
    let key = scope_key(selection.scope, selection.project_path.as_deref())?;
    let mut tools: Vec<String> = selection.tool_ids.into_iter().filter(|id| !id.is_empty()).collect();
    tools.sort();
    tools.dedup();
    let mut affected: Vec<(String, String)> = tools.iter().map(|tool| {
        let _context=crate::accounts::selection::enter_bound(db,home,tool,selection.scope,selection.project_path.as_deref().map(Path::new))?;
        Ok((tool.clone(),crate::accounts::selection::key(&key)))
    }).collect::<Result<_,String>>()?;
    let current = list_placements(db, registry, home)?;
    for place in &current {
        if place.rule_id != rule_id {
            continue;
        }
        let base_key = scope_key(place.scope, place.project_path.as_deref())?;
        let place_key=place.context_id.as_ref().map(|id|format!("context:{id}:{base_key}")).unwrap_or(base_key);
        if place_key == key && !tools.iter().any(|tool| tool == &place.tool_id) {
            affected.push((place.tool_id.clone(), place_key));
        } else if place_key != key {
            affected.push((place.tool_id.clone(), place_key));
        }
    }
    affected.sort();
    affected.dedup();
    let mut planned = Vec::new();
    let mut results_early = Vec::new();
    for (tool, scope_key) in affected {
        let target = RuleTarget { context_id: Some(crate::accounts::selection::split_key(&scope_key).0.unwrap_or("").to_owned()),
            tool_id: tool.clone(),
            scope: split_scope(&scope_key).0,
            project_path: split_scope(&scope_key).1,
            baseline_hash: None,
        };
        let path = match path_for(db,registry, home, &target) {
            Ok(path) => path,
            Err(error) => {
                results_early.push(RuleSyncResult {
                    tool_id: tool,
                    path: None,
                    status: "failed",
                    detail: error,
                    existing: String::new(),
                    proposed: String::new(),
                });
                continue;
            }
        };
        let mut group = members(db, &tool, &scope_key)?;
        let selected_here={
            let _context=crate::accounts::selection::enter_bound(db,home,&tool,selection.scope,selection.project_path.as_deref().map(Path::new))?;
            scope_key==crate::accounts::selection::key(&key)
        };
        let included = if selected_here {
            tools.iter().any(|id| id == &tool)
        } else {
            group.iter().any(|member| member.rule_id == rule_id)
        };
        if selected_here {
            if included {
                if !group.iter().any(|member| member.rule_id == rule_id) {
                    let position = group.iter().map(|member| member.position).max().unwrap_or(0) + 1;
                    group.push(Member { rule_id: rule_id.to_owned(), position });
                }
            } else {
                group.retain(|member| member.rule_id != rule_id);
            }
        }
        let existing = transaction::read_native(&path)?;
        let proposed = composed(db, &group)?;
        planned.push(PlannedWrite { tool_id: tool, scope_key, path, existing, proposed, members: group, included });
    }
    if !selection.allow_replace {
        let conflicts: Vec<RuleSyncResult> = planned
            .iter()
            .filter(|item| item.existing != item.proposed && !writable(db, &item.tool_id, &item.scope_key, &item.existing).unwrap_or(false))
            .map(|item| RuleSyncResult {
                tool_id: item.tool_id.clone(),
                path: Some(item.path.display().to_string()),
                status: "conflict",
                detail: "这个规则文件有资料库之外的修改。确认后才会用拼接结果替换。".into(),
                existing: item.existing.clone(),
                proposed: item.proposed.clone(),
            })
            .collect();
        if !conflicts.is_empty() {
            return Ok(conflicts);
        }
    }
    if !results_early.is_empty() && planned.is_empty() {
        return Ok(results_early);
    }
    let mut results = results_early;
    for item in planned {
        if item.existing == item.proposed {
            persist_members(db, rule_id, &item)?;
            results.push(RuleSyncResult {
                tool_id: item.tool_id,
                path: Some(item.path.display().to_string()),
                status: "unchanged",
                detail: "拼接结果与当前文件一致".into(),
                existing: item.existing,
                proposed: item.proposed,
            });
            continue;
        }
        let outcome = transaction::apply_text(
            db,
            credentials,
            &[TextPatch { path: item.path.clone(), baseline: item.existing.clone(), contents: item.proposed.clone(), sensitive: false }],
            |_| Ok(()),
        );
        match outcome {
            Ok(_) => {
                persist_members(db, rule_id, &item)?;
                store_hash(db, &item.tool_id, &item.scope_key, &transaction::fingerprint(item.proposed.as_bytes()))?;
                results.push(RuleSyncResult {
                    tool_id: item.tool_id,
                    path: Some(item.path.display().to_string()),
                    status: "written",
                    detail: "已写入拼接后的规则".into(),
                    existing: item.existing,
                    proposed: item.proposed,
                });
            }
            Err(error) => results.push(RuleSyncResult {
                tool_id: item.tool_id,
                path: Some(item.path.display().to_string()),
                status: "failed",
                detail: error,
                existing: item.existing,
                proposed: item.proposed,
            }),
        }
    }
    Ok(results)
}

fn writable(db: &Database, tool: &str, scope_key: &str, existing: &str) -> Result<bool, String> {
    if existing.is_empty() {
        return Ok(true);
    }
    Ok(owned_hash(db, tool, scope_key)?.as_deref() == Some(transaction::fingerprint(existing.as_bytes()).as_str()))
}

fn persist_members(db: &Database, rule_id: &str, item: &PlannedWrite) -> Result<(), String> {
    if item.included {
        let position = item.members.iter().find(|member| member.rule_id == rule_id).map(|member| member.position).unwrap_or(1);
        remember(db, rule_id, &item.tool_id, &item.scope_key, position)
    } else {
        forget(db, rule_id, &item.tool_id, &item.scope_key)
    }
}

pub fn release_rule(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    id: &str,
    expected_version: u64,
) -> Result<(), String> {
    let item = match library::get(db, id) {
        Ok(item) => item,
        Err(_) => return Ok(()),
    };
    if item.kind != LibraryKind::Rule || item.version != expected_version {
        return Ok(());
    }
    let placed = list_placements(db, registry, home)?.into_iter().filter(|place| place.rule_id == id).collect::<Vec<_>>();
    for place in placed {
        let base_key = scope_key(place.scope, place.project_path.as_deref())?;
        let key=place.context_id.as_ref().map(|id|format!("context:{id}:{base_key}")).unwrap_or(base_key);
        let mut group = members(db, &place.tool_id, &key)?;
        group.retain(|member| member.rule_id != id);
        let target = RuleTarget { context_id: Some(place.context_id.clone().unwrap_or_default()), tool_id: place.tool_id.clone(), scope: place.scope, project_path: place.project_path.clone(), baseline_hash: None };
        let path = match path_for(db,registry, home, &target) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let existing = transaction::read_native(&path)?;
        let proposed = composed(db, &group)?;
        if existing == proposed {
            continue;
        }
        if !writable(db, &place.tool_id, &key, &existing)? {
            continue;
        }
        transaction::apply_text(
            db,
            credentials,
            &[TextPatch { path, baseline: existing, contents: proposed.clone(), sensitive: false }],
            |_| Ok(()),
        )?;
        store_hash(db, &place.tool_id, &key, &transaction::fingerprint(proposed.as_bytes()))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../tests/resources/rules.rs"]
mod tests;
