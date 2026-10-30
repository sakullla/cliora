//! Durable launch metadata only. Credentials, environment and terminal output
//! never enter the checkpoint. Native conversation identity is adapter-owned.
use crate::{adapters::{LaunchMode, Registry}, database::Database, launch::{self, LaunchPlan, TerminalId}};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, path::Path, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

const PREFIX: &str = "workbench_session_v1:";
static RESTORING: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub tool_id: String,
    pub project_id: Option<String>,
    pub directory: String,
    pub mode: LaunchMode,
    pub started_at: u64,
    pub stopped_at: Option<u64>,
    pub native_id: Option<String>,
    pub account_id: Option<String>,
    pub context_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure { pub session: SavedSession, pub detail: String }
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: HashMap<String, String>,
    pub failures: Vec<RestoreFailure>,
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis() as u64).unwrap_or(0) }

pub fn from_plan(plan: &LaunchPlan) -> Option<SavedSession> {
    if plan.terminal != TerminalId::Workbench || plan.project_id.as_deref().is_some_and(|id| id.starts_with("remote:")) { return None; }
    Some(SavedSession {
        id: String::new(), tool_id: plan.tool_id.clone(), project_id: plan.project_id.clone(),
        directory: plan.directory.display().to_string(), mode: plan.mode, started_at: now(), stopped_at: None,
        native_id: plan.resume_native_id.clone(),
        account_id: plan.account_context.as_ref().map(|(id, _)| id.clone()),
        context_id: plan.account_context.as_ref().map(|(_, context)| context.id.clone()),
    })
}

pub fn save(db: &Database, session: &SavedSession) -> Result<(), String> {
    let text = serde_json::to_string(session).map_err(|error| error.to_string())?;
    db.with_connection(|conn| conn.execute("INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![format!("{PREFIX}{}", session.id), text]).map(|_| ()).map_err(|error| error.to_string()))
}

pub fn forget(db: &Database, id: &str) -> Result<(), String> {
    db.with_connection(|conn| conn.execute("DELETE FROM app_settings WHERE key=?1", [format!("{PREFIX}{id}")]).map(|_| ()).map_err(|error| error.to_string()))
}

pub fn list(db: &Database) -> Result<Vec<SavedSession>, String> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("SELECT value FROM app_settings WHERE substr(key,1,?1)=?2 ORDER BY key").map_err(|error| error.to_string())?;
        let rows = statement.query_map(rusqlite::params![PREFIX.len() as i64, PREFIX], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
        let mut sessions = Vec::new();
        for text in rows { sessions.push(serde_json::from_str(&text.map_err(|error| error.to_string())?).map_err(|_| "工作台恢复记录无法读取；原记录已保留")?); }
        sessions.sort_by_key(|session: &SavedSession| session.started_at);
        Ok(sessions)
    })
}

/// Save the stop boundary before update/relaunch tears down
/// processes. Explicitly ended tabs are removed by close_workbench_session.
pub fn checkpoint(db: &Database) -> Result<(), String> {
    let live: HashMap<_, _> = crate::session_host::list().into_iter().map(|session| (session.id.clone(), session)).collect();
    for mut saved in list(db)? {
        if live.contains_key(&saved.id) {
            saved.stopped_at = Some(now());
            // Keep the launch directory: native history records that directory,
            // while OSC 7 may have moved the live terminal elsewhere since then.
            let text = serde_json::to_string(&saved).map_err(|error| error.to_string())?;
            // Closing a tab concurrently must not be undone by a checkpoint
            // that read its old record before the close completed.
            db.with_connection(|conn| conn.execute("UPDATE app_settings SET value=?1 WHERE key=?2", rusqlite::params![text, format!("{PREFIX}{}", saved.id)]).map(|_| ()).map_err(|error| error.to_string()))?;
        }
    }
    Ok(())
}

fn same_directory(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let value = value.strip_prefix("\\\\?\\").unwrap_or(value).replace('\\', "/");
        let value = value.trim_end_matches('/');
        if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
    };
    normalize(a) == normalize(b)
}

fn candidate(saved: &SavedSession, parsed: &crate::history::ParsedSession, until: u64) -> bool {
    if parsed.native_id.is_none() || !parsed.cwd.as_deref().is_some_and(|cwd| same_directory(cwd, &saved.directory)) { return false; }
    if let Some(id) = &saved.native_id { return parsed.native_id.as_ref() == Some(id); }
    parsed.started_at.is_some_and(|at| at >= saved.started_at.saturating_sub(2000) as i64 && at <= until as i64)
}

fn matching_until(session: &SavedSession, sessions: &[SavedSession], now: u64) -> u64 {
    // A later launch in the same directory starts a separate candidate window.
    // Preserve the timestamp precision margin on both sides; launches inside
    // that margin remain ambiguous rather than attaching to the wrong thread.
    sessions.iter().filter(|other| other.started_at > session.started_at
        && other.tool_id == session.tool_id && other.context_id == session.context_id
        && same_directory(&other.directory, &session.directory))
        .map(|other| other.started_at.saturating_sub(2001))
        .min().unwrap_or(now).min(session.stopped_at.unwrap_or(now))
}

pub fn restore(db: &Database, registry: &Registry, home: &Path) -> Result<RestoreReport, String> {
    let _guard = RESTORING.lock().map_err(|_| "工作台恢复正在结束，请重试")?;
    let live: HashSet<_> = crate::session_host::list().into_iter().map(|session| session.id).collect();
    let saved: Vec<_> = list(db)?.into_iter().filter(|session| !live.contains(&session.id)).collect();
    let mut report = RestoreReport::default();
    // Discovery is shared by tabs with the same adapter and account context.
    let mut histories: HashMap<(String, Option<String>), Result<Vec<crate::history::ParsedSession>, String>> = HashMap::new();
    let until = now();
    let mut claimed = HashSet::new();
    for session in &saved {
        let attempt = (|| -> Result<String, String> {
            let adapter = registry.get(&session.tool_id).ok_or("此 CLI 已不可用，恢复记录已保留")?;
            if !adapter.history_supported() { return Err("此 CLI 尚不支持精确恢复；请从新会话重新启动".into()); }
            let context = match (&session.account_id, &session.context_id) {
                (Some(account), Some(context)) => Some((account.clone(), crate::accounts::resolve_retained(db, home, account, &session.tool_id, context)?)),
                (None, None) => None,
                _ => return Err("原账号上下文不完整，不能恢复到其他账号".into()),
            };
            let _context = crate::accounts::selection::enter(context.as_ref().map(|(_, context)| context.clone()));
            let key = (session.tool_id.clone(), session.context_id.clone());
            let history = histories.entry(key.clone()).or_insert_with(|| {
                let sources = adapter.history_sources(home)?;
                sources.iter().map(|source| {
                    let parsed = adapter.parse_history(source)?;
                    // Matching needs identity only. Release transcripts after
                    // each parse instead of retaining every conversation.
                    Ok(crate::history::ParsedSession {
                        native_id: parsed.native_id, cwd: parsed.cwd, started_at: parsed.started_at,
                        ..Default::default()
                    })
                }).collect()
            }).as_ref().map_err(Clone::clone)?;
            let candidates: Vec<_> = history.iter().filter(|parsed| candidate(session, parsed, matching_until(session, &saved, until))).collect();
            if candidates.len() != 1 { return Err(if candidates.is_empty() { "尚未找到原生会话记录；可重试恢复，或从新会话启动" } else { "发现多条可能的会话，未自动选择；请到记录页选择原会话" }.into()); }
            let parsed = candidates[0];
            let native = parsed.native_id.clone().ok_or("原会话缺少恢复 ID")?;
            // Two tabs launched together must never both attach to the same
            // ambiguous history record, even if only one has written a file.
            if saved.iter().filter(|other| other.tool_id == session.tool_id && other.context_id == session.context_id && candidate(other, parsed, matching_until(other, &saved, until))).count() != 1 {
                return Err("多个终端对应同一条可能的会话；请到记录页明确选择".into());
            }
            if !claimed.insert((key, native.clone())) { return Err("此会话已经恢复".into()); }
            let mut plan = launch::plan_history_context(db, registry, home, launch::LaunchRequest {
                tool_id: session.tool_id.clone(), project_id: session.project_id.clone(), session_id: Some(native),
                directory: None, initial_prompt: None, mode: session.mode, resume_latest: false,
            }, Path::new(&session.directory), context).map_err(|error| error.message)?;
            plan.terminal = TerminalId::Workbench;
            let result = launch::spawn(db, plan)?;
            let id = result.session_id.ok_or("未创建恢复终端")?;
            if let Err(error) = forget(db, &session.id) {
                let _ = crate::session_host::close(&id);
                let _ = forget(db, &id);
                return Err(error);
            }
            Ok(id)
        })();
        match attempt {
            Ok(id) => { report.restored.insert(session.id.clone(), id); }
            Err(detail) => report.failures.push(RestoreFailure { session: session.clone(), detail }),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_metadata_round_trips_without_launch_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("restore.db")).unwrap();
        let session = SavedSession { id: "tab".into(), tool_id: "codex".into(), project_id: None, directory: "/work".into(), mode: LaunchMode::Normal, started_at: 10_000, stopped_at: Some(20_000), native_id: None, account_id: None, context_id: None };
        save(&db, &session).unwrap();
        assert_eq!(list(&db).unwrap()[0].id, "tab");
        forget(&db, "tab").unwrap();
        assert!(list(&db).unwrap().is_empty());
    }
    #[test]
    fn matching_requires_directory_time_and_native_identity() {
        let saved = SavedSession { id: "tab".into(), tool_id: "codex".into(), project_id: None, directory: "/work".into(), mode: LaunchMode::Normal, started_at: 10_000, stopped_at: Some(20_000), native_id: None, account_id: None, context_id: None };
        let mut parsed = crate::history::ParsedSession::new();
        parsed.cwd = Some("/work".into()); parsed.native_id = Some("one".into()); parsed.started_at = Some(10_000);
        assert!(candidate(&saved, &parsed, 20_000));
        parsed.started_at = Some(30_000); assert!(!candidate(&saved, &parsed, 20_000));
        let later = SavedSession { id: "later".into(), started_at: 15_000, ..saved.clone() };
        let pair = [saved.clone(), later.clone()];
        parsed.started_at = Some(10_000);
        assert!(candidate(&saved, &parsed, matching_until(&saved, &pair, 20_000)));
        assert!(!candidate(&later, &parsed, matching_until(&later, &pair, 20_000)));
        parsed.started_at = Some(15_000);
        assert!(!candidate(&saved, &parsed, matching_until(&saved, &pair, 20_000)));
        assert!(candidate(&later, &parsed, matching_until(&later, &pair, 20_000)));
        let exact = SavedSession { native_id: Some("one".into()), ..saved };
        assert!(candidate(&exact, &parsed, 20_000));
        parsed.cwd = Some("/other".into()); assert!(!candidate(&exact, &parsed, 20_000));
    }

    #[cfg(windows)]
    #[test]
    fn reopening_database_restores_exact_native_session_into_real_pty_once() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let database = home.join("restore.db");
        let native = "11111111-1111-4111-8111-111111111111";
        let started_at = now();
        let logs = home.join(".codex/sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let line = serde_json::json!({"timestamp": started_at, "type": "session_meta", "payload": {"id": native, "cwd": home.display().to_string(), "cli_version": "0.165.0"}});
        std::fs::write(logs.join("rollout-fixture.jsonl"), format!("{line}\n")).unwrap();
        let program = home.join("fixture.ps1");
        std::fs::write(&program, "Write-Output ('restored-args:' + ($args -join '|')); Start-Sleep -Seconds 10").unwrap();
        let saved = SavedSession { id: "previous-process".into(), tool_id: "codex".into(), project_id: None, directory: home.display().to_string(), mode: LaunchMode::Normal, started_at, stopped_at: Some(now()), native_id: None, account_id: None, context_id: None };
        {
            let db = Database::open(&database).unwrap();
            save(&db, &saved).unwrap();
        }
        let db = Database::open(&database).unwrap();
        let mut registry = Registry::builtins();
        registry.fixture_installations.insert("codex".into(), vec![crate::native::adapter::Installation { path: program.display().to_string(), version: Some("0.165.0".into()), source: "test", status: "available", detail: None }]);
        let report = restore(&db, &registry, home).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures.iter().map(|failure| &failure.detail).collect::<Vec<_>>());
        let id = report.restored.get(&saved.id).unwrap();
        let output = crate::session_host::wait_for_replay(id, &format!("resume|{native}"));
        let again = restore(&db, &registry, home).unwrap();
        assert!(again.restored.is_empty());
        assert!(again.failures.is_empty());
        assert_eq!(list(&db).unwrap().len(), 1);
        assert_eq!(list(&db).unwrap()[0].native_id.as_deref(), Some(native));
        let changed_directory = home.join("nested");
        std::fs::create_dir(&changed_directory).unwrap();
        crate::session_host::set_directory(id, &changed_directory.display().to_string()).unwrap();
        checkpoint(&db).unwrap();
        assert!(list(&db).unwrap()[0].stopped_at.is_some());
        assert!(same_directory(&list(&db).unwrap()[0].directory, &saved.directory));
        crate::session_host::close(id).unwrap();
        output.unwrap();
        // A later restart uses the now-known native identity, regardless of
        // the original conversation's creation time.
        let next = restore(&db, &registry, home).unwrap();
        let next_id = next.restored.get(id).unwrap();
        let output = crate::session_host::wait_for_replay(next_id, &format!("resume|{native}"));
        crate::session_host::close(next_id).unwrap();
        forget(&db, next_id).unwrap();
        output.unwrap();
        assert!(list(&db).unwrap().is_empty());
    }
}
