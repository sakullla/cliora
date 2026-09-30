use std::path::Path;

use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::library::{self, LibraryKind};
use crate::native::adapter::Scope;
use crate::native::adapters::Registry;
use crate::native::transaction::{self, TextPatch};
use crate::projects;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleTarget {
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
    registry: &Registry,
    home: &Path,
    target: &RuleTarget,
) -> Result<std::path::PathBuf, String> {
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
pub struct NativeRule { pub path: String, pub text: String, pub fingerprint: String }

pub fn read_current(registry: &Registry, home: &Path, target: &RuleTarget) -> Result<NativeRule, String> {
    let path = path_for(registry, home, target)?;
    let text = transaction::read_native(&path)?;
    Ok(NativeRule {path:path.display().to_string(), fingerprint:transaction::fingerprint(text.as_bytes()), text})
}

pub fn save_current(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, target: &RuleTarget, original: &str, edited: &str) -> Result<transaction::ApplyOutcome, String> {
    if edited.len() > 1024 * 1024 { return Err("规则内容超过 1 MiB".into()); }
    let path = path_for(registry, home, target)?;
    transaction::apply_text(db, credentials, &[TextPatch {path, baseline:original.into(),contents:edited.into(),sensitive:false}], |_| Ok(()))
}

pub fn enabled(_db: &Database, registry: &Registry, home: &Path, target: &RuleTarget) -> Result<bool,String> {
    let file=read_current(registry,home,target)?;
    Ok(!file.text.is_empty())
}
pub fn set_enabled(db: &Database, credentials: &dyn CredentialStore, registry: &Registry, home: &Path, target: &RuleTarget, enabled: bool) -> Result<(),String> {
    let path=path_for(registry,home,target)?; let current=transaction::read_native(&path)?;
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
                let path = path_for(registry, home, &result.target)?;
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
                let path = path_for(registry, home, &result.target)?;
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

#[cfg(test)]
#[path = "../../../tests/resources/rules.rs"]
mod tests;
