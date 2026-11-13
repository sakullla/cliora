//! Durable launch metadata only. Credentials, environment and terminal output
//! never enter the checkpoint. Native conversation identity is adapter-owned.
use crate::history::SessionIdentity;
use crate::{adapters::{LaunchMode, Registry}, database::Database, launch::{self, LaunchPlan, TerminalId}};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, path::Path, sync::{Mutex, atomic::{AtomicU64, AtomicUsize, Ordering}}, time::{SystemTime, UNIX_EPOCH}};

const PREFIX: &str = "workbench_session_v1:";
/// Bounds how many CLI/account contexts discover and start at the same time.
const MAX_PARALLEL_CONTEXTS: usize = 4;
static RESTORING: Mutex<()> = Mutex::new(());
/// One CLI and account context, and the native conversation a tab claims in it.
type ContextKey = (String, Option<String>, Option<String>);
type ClaimKey = (ContextKey, String);
static RESTORE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreCandidate {
    pub native_id: String,
    pub title: String,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure { pub session: SavedSession, pub detail: String, pub candidates: Vec<RestoreCandidate> }
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
    let baseline = serde_json::to_string(&crate::session_baseline::get(&session.id).as_deref()).map_err(|error| error.to_string())?;
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let key = format!("{PREFIX}{}", session.id);
        tx.execute("INSERT INTO app_settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, text]).map_err(|error| error.to_string())?;
        // Never replace the original start point on later checkpoint updates.
        tx.execute("INSERT INTO workbench_baselines(session_key,data) VALUES(?1,?2) ON CONFLICT(session_key) DO NOTHING",
            rusqlite::params![key, baseline]).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    })
}

fn saved_baseline(db: &Database, id: &str) -> Result<Option<crate::session_baseline::SessionBaseline>, String> {
    use rusqlite::OptionalExtension;
    db.with_read_connection(|conn| {
        let text: Option<String> = conn.query_row("SELECT data FROM workbench_baselines WHERE session_key=?1",
            [format!("{PREFIX}{id}")], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        text.map(|text| serde_json::from_str(&text).map_err(|_| "会话起点记录无法读取；原记录已保留".to_owned())).transpose().map(Option::flatten)
    })
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

fn candidate(saved: &SavedSession, parsed: &SessionIdentity, until: u64) -> bool {
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

/// Time-window matching for a tab without a native id. Conversations already
/// named by another tab belong to that tab and are never ambiguous here.
fn matches(session: &SavedSession, parsed: &SessionIdentity, saved: &[SavedSession], known: &[SavedSession], now: u64) -> bool {
    if session.native_id.is_none() && parsed.native_id.is_some() && known.iter().any(|other| other.id != session.id
        && other.tool_id == session.tool_id && other.context_id == session.context_id && other.native_id == parsed.native_id) {
        return false;
    }
    candidate(session, parsed, matching_until(session, saved, now))
}

fn choose_candidate<'a>(session_id: &str, candidates: &'a [&SessionIdentity], selection: Option<(&str, &str)>) -> Result<&'a SessionIdentity, String> {
    if let Some((_, native_id)) = selection.filter(|(id, _)| *id == session_id) {
        return candidates.iter().copied().find(|parsed| parsed.native_id.as_deref() == Some(native_id))
            .ok_or_else(|| "所选会话已不在此终端的可恢复范围内，请重新选择".into());
    }
    match candidates {
        [] => Err("尚未找到原生会话记录；可重试恢复，或从新会话启动".into()),
        [parsed] => Ok(*parsed),
        _ => Err("发现多条可能的会话，请选择要恢复的原会话".into()),
    }
}

fn restore_candidate(parsed: &SessionIdentity) -> RestoreCandidate {
    RestoreCandidate {
        native_id: parsed.native_id.clone().unwrap_or_default(), title: parsed.title.clone(),
        started_at: parsed.started_at, updated_at: parsed.updated_at,
    }
}

/// Per-item recovery progress. The whole-batch report stays the compatibility
/// contract; these events let a view show each saved tab the moment it is real.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreStage { Discovering, Starting, Restored, Failed }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreEvent {
    /// Identifies one automatic or manual restore call.
    pub restore_id: String,
    /// The saved tab this item replaces.
    pub saved_session_id: String,
    pub stage: RestoreStage,
    pub detail: Option<String>,
    pub candidates: Vec<RestoreCandidate>,
    /// The live session, published once the restore succeeded.
    pub session: Option<crate::session_host::SessionSnapshot>,
}

/// An event sink. Every worker reports through the same sink, so it must be
/// callable from several threads.
pub type RestoreReporter<'a> = &'a (dyn Fn(RestoreEvent) + Send + Sync);

enum ItemOutcome {
    Restored(String),
    Failed { detail: String, candidates: Vec<RestoreCandidate> },
}

struct RestoreScope<'a> {
    db: &'a Database,
    registry: &'a Registry,
    home: &'a Path,
    targets: &'a [SavedSession],
    all: &'a [SavedSession],
    live: &'a HashMap<String, crate::session_host::SessionSnapshot>,
    until: u64,
    claimed: &'a Mutex<HashSet<ClaimKey>>,
    restore_id: &'a str,
    reporter: RestoreReporter<'a>,
    selection: Option<(&'a str, Option<&'a str>)>,
}

fn progress(scope: &RestoreScope<'_>, session: &SavedSession, stage: RestoreStage, detail: Option<String>, candidates: Vec<RestoreCandidate>, id: Option<&str>) {
    (scope.reporter)(RestoreEvent {
        restore_id: scope.restore_id.to_owned(),
        saved_session_id: session.id.clone(),
        stage,
        detail,
        candidates,
        session: id.and_then(snapshot),
    });
}

fn snapshot(id: &str) -> Option<crate::session_host::SessionSnapshot> {
    crate::session_host::list().into_iter().find(|session| session.id == id)
}

fn fail_group(scope: &RestoreScope<'_>, indices: &[usize], detail: &str) -> Vec<(usize, ItemOutcome)> {
    indices.iter().map(|&index| {
        let session = &scope.targets[index];
        progress(scope, session, RestoreStage::Failed, Some(detail.to_owned()), Vec::new(), None);
        (index, ItemOutcome::Failed { detail: detail.to_owned(), candidates: Vec::new() })
    }).collect()
}

pub fn restore(db: &Database, registry: &Registry, home: &Path) -> Result<RestoreReport, String> {
    restore_with(db, registry, home, &|_| {})
}

pub fn restore_with(db: &Database, registry: &Registry, home: &Path, reporter: RestoreReporter<'_>) -> Result<RestoreReport, String> {
    restore_inner(db, registry, home, None, reporter)
}

pub fn restore_selected(db: &Database, registry: &Registry, home: &Path, session_id: &str, native_id: Option<&str>) -> Result<RestoreReport, String> {
    restore_selected_with(db, registry, home, session_id, native_id, &|_| {})
}

pub fn restore_selected_with(db: &Database, registry: &Registry, home: &Path, session_id: &str, native_id: Option<&str>, reporter: RestoreReporter<'_>) -> Result<RestoreReport, String> {
    restore_inner(db, registry, home, Some((session_id, native_id)), reporter)
}

fn restore_inner(db: &Database, registry: &Registry, home: &Path, selection: Option<(&str, Option<&str>)>, reporter: RestoreReporter<'_>) -> Result<RestoreReport, String> {
    let _guard = RESTORING.lock().map_err(|_| "工作台恢复正在结束，请重试")?;
    let live: HashMap<_, _> = crate::session_host::list().into_iter().map(|session| (session.id.clone(), session)).collect();
    let all = list(db)?;
    // Automatic startup restoration skips every existing tab. An explicit
    // reconnect may replace an exited local tab, never a running transport.
    let saved: Vec<_> = all.iter().filter(|session| !live.contains_key(&session.id)
        || (selection.is_some_and(|(id, _)| id == session.id)
            && live.get(&session.id).is_some_and(|item| !item.running && !item.project_id.as_deref().is_some_and(|id| id.starts_with("remote:")))))
        .cloned().collect();
    if selection.is_some_and(|(id, _)| !saved.iter().any(|session| session.id == id)) {
        return Err("恢复记录不存在或已处理".into());
    }
    let targets: Vec<_> = saved.into_iter().filter(|session| selection.is_none_or(|(id, _)| id == session.id)).collect();
    let restore_id = format!("restore-{}", RESTORE_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let until = now();
    // One worker per CLI and account context: discovery and launching of a slow
    // context delay only that context's own tabs, and each worker enters that
    // account's thread-local guard on its own thread.
    let mut groups: Vec<(ContextKey, Vec<usize>)> = Vec::new();
    for (index, session) in targets.iter().enumerate() {
        let key = (session.tool_id.clone(), session.account_id.clone(), session.context_id.clone());
        match groups.iter_mut().find(|(existing, _)| existing == &key) {
            Some((_, items)) => items.push(index),
            None => groups.push((key, vec![index])),
        }
    }
    let claimed = Mutex::new(HashSet::new());
    let scope = RestoreScope {
        db, registry, home, targets: &targets, all: &all, live: &live, until,
        claimed: &claimed, restore_id: &restore_id, reporter, selection,
    };
    let mut outcomes: Vec<Option<ItemOutcome>> = targets.iter().map(|_| None).collect();
    // Bounded concurrency over a shared queue: a worker that finishes its
    // context takes the next one immediately, so a slow context never holds
    // back a context that has not started yet.
    let next = AtomicUsize::new(0);
    let workers = groups.len().min(MAX_PARALLEL_CONTEXTS);
    std::thread::scope(|threads| {
        let handles: Vec<_> = (0..workers)
            .map(|_| threads.spawn(|| {
                let mut done = Vec::new();
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some((_, indices)) = groups.get(index) else { break };
                    done.extend(restore_context(&scope, indices));
                }
                done
            }))
            .collect();
        for handle in handles {
            for (index, outcome) in handle.join().unwrap_or_default() {
                outcomes[index] = Some(outcome);
            }
        }
    });
    for (_, indices) in &groups {
        for &index in indices.iter() {
            outcomes[index].get_or_insert_with(|| ItemOutcome::Failed {
                detail: "恢复工作线程中断，请重试".into(), candidates: Vec::new(),
            });
        }
    }
    let mut report = RestoreReport::default();
    for (index, session) in targets.iter().enumerate() {
        match outcomes[index].take() {
            Some(ItemOutcome::Restored(id)) => { report.restored.insert(session.id.clone(), id); }
            Some(ItemOutcome::Failed { detail, candidates }) => report.failures.push(RestoreFailure { session: session.clone(), detail, candidates }),
            None => report.failures.push(RestoreFailure { session: session.clone(), detail: "恢复中断，请重试".into(), candidates: Vec::new() }),
        }
    }
    Ok(report)
}

/// One CLI/account context: discover its native identities once, then match and
/// start its saved tabs in order. Tabs of other contexts run on their own
/// worker, so one slow or failing item never blocks them.
fn restore_context(scope: &RestoreScope<'_>, indices: &[usize]) -> Vec<(usize, ItemOutcome)> {
    let session = &scope.targets[indices[0]];
    let Some(adapter) = scope.registry.get(&session.tool_id) else {
        return fail_group(scope, indices, "此 CLI 已不可用，恢复记录已保留");
    };
    if !adapter.history_supported() {
        return fail_group(scope, indices, "此 CLI 尚不支持精确恢复；请从新会话重新启动");
    }
    let context = match (&session.account_id, &session.context_id) {
        (Some(account), Some(context)) => {
            match crate::accounts::resolve_retained(scope.db, scope.home, account, &session.tool_id, context) {
                Ok(context) => Some((account.clone(), context)),
                Err(detail) => return fail_group(scope, indices, &detail),
            }
        }
        (None, None) => None,
        _ => return fail_group(scope, indices, "原账号上下文不完整，不能恢复到其他账号"),
    };
    restore_items(scope, indices, adapter, context.as_ref())
}

/// Discovery and launching for one resolved context. The account context is
/// thread-local and it selects the native history root, so this worker thread
/// enters it before discovery. The same guard then covers the launches below.
fn restore_items(
    scope: &RestoreScope<'_>,
    indices: &[usize],
    adapter: &dyn crate::adapters::CliAdapter,
    context: Option<&(String, crate::accounts::NativeContext)>,
) -> Vec<(usize, ItemOutcome)> {
    let RestoreScope { db, registry, home, targets, all, live, until, claimed, selection, .. } = *scope;
    let _context = crate::accounts::selection::enter(context.as_ref().map(|(_, context)| context.clone()));
    for &index in indices {
        progress(scope, &targets[index], RestoreStage::Discovering, None, Vec::new(), None);
    }
    let history = adapter.history_sources(home)
        .and_then(|sources| crate::history::restore_identities(db, adapter, &sources));
    let history = match history {
        Ok(history) => history,
        Err(detail) => return fail_group(scope, indices, &detail),
    };
    let explicit_native = selection.and_then(|(id, native)| native.map(|native| (id, native)));
    let mut outcomes = Vec::with_capacity(indices.len());
    for &index in indices {
        let session = &targets[index];
        let candidates: Vec<_> = history.iter().filter(|parsed| matches(session, parsed, all, all, until)).collect();
        let parsed = match choose_candidate(&session.id, &candidates, explicit_native) {
            Ok(parsed) => parsed,
            Err(detail) => {
                let choices: Vec<RestoreCandidate> = candidates.iter().map(|parsed| restore_candidate(parsed)).collect();
                progress(scope, session, RestoreStage::Failed, Some(detail.clone()), choices.clone(), None);
                outcomes.push((index, ItemOutcome::Failed { detail, candidates: choices }));
                continue;
            }
        };
        let Some(native) = parsed.native_id.clone() else {
            let detail = "原会话缺少恢复 ID".to_owned();
            progress(scope, session, RestoreStage::Failed, Some(detail.clone()), Vec::new(), None);
            outcomes.push((index, ItemOutcome::Failed { detail, candidates: Vec::new() }));
            continue;
        };
        // Automatic restoration never guesses which simultaneously opened tab owns a
        // conversation. An explicit user choice resolves only the selected saved tab.
        if explicit_native.is_none() && all.iter().filter(|other| other.tool_id == session.tool_id && other.context_id == session.context_id && matches(other, parsed, all, all, until)).count() != 1 {
            let detail = "多个终端对应同一条可能的会话；请明确选择后恢复".to_owned();
            let choices = vec![restore_candidate(parsed)];
            progress(scope, session, RestoreStage::Failed, Some(detail.clone()), choices.clone(), None);
            outcomes.push((index, ItemOutcome::Failed { detail, candidates: choices }));
            continue;
        }
        // Claims are shared by the workers, so two tabs can never resume one
        // conversation at the same time.
        let claim = ((session.tool_id.clone(), session.account_id.clone(), session.context_id.clone()), native.clone());
        let duplicate = !claimed.lock().unwrap_or_else(|error| error.into_inner()).insert(claim);
        if duplicate {
            let detail = "此会话已经恢复".to_owned();
            progress(scope, session, RestoreStage::Failed, Some(detail.clone()), Vec::new(), None);
            outcomes.push((index, ItemOutcome::Failed { detail, candidates: Vec::new() }));
            continue;
        }
        progress(scope, session, RestoreStage::Starting, None, Vec::new(), None);
        let attempt = (|| -> Result<String, String> {
            let mut plan = launch::plan_history_context(db, registry, home, launch::LaunchRequest {
                tool_id: session.tool_id.clone(), project_id: session.project_id.clone(), session_id: Some(native),
                directory: None, initial_prompt: None, mode: session.mode, resume_latest: false, remote_intent: None,
            }, Path::new(&session.directory), context.cloned()).map_err(|error| error.message)?;
            plan.terminal = TerminalId::Workbench;
            let baseline = saved_baseline(db, &session.id)?;
            let result = launch::spawn_with_baseline(db, plan, Some(baseline))?;
            let id = result.session_id.ok_or("未创建恢复终端")?;
            let cleanup = if live.contains_key(&session.id) { crate::session_host::close(&session.id) } else { Ok(()) };
            if let Err(error) = cleanup.and_then(|()| forget(db, &session.id)) {
                let _ = crate::session_host::close(&id);
                let _ = forget(db, &id);
                return Err(error);
            }
            Ok(id)
        })();
        match attempt {
            Ok(id) => {
                progress(scope, session, RestoreStage::Restored, None, Vec::new(), Some(&id));
                outcomes.push((index, ItemOutcome::Restored(id)));
            }
            Err(detail) => {
                progress(scope, session, RestoreStage::Failed, Some(detail.clone()), Vec::new(), None);
                outcomes.push((index, ItemOutcome::Failed { detail, candidates: Vec::new() }));
            }
        }
    }
    outcomes
}

#[cfg(test)]#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_baseline_survives_database_reopen_and_repeated_session_id_changes() {
        use crate::session_baseline as baseline;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let git = |args: &[&str]| {
            let result = std::process::Command::new("git").arg("-C").arg(&root)
                .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
                .env("GIT_CONFIG_SYSTEM", if cfg!(windows) { "NUL" } else { "/dev/null" })
                .args(args).output().unwrap();
            assert!(result.status.success(), "git failed: {}", String::from_utf8_lossy(&result.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "fixture@example.com"]);
        git(&["config", "user.name", "Fixture"]);
        std::fs::write(root.join("before.txt"), "base\n").unwrap();
        std::fs::write(root.join("session.txt"), "base\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "base"]);
        std::fs::write(root.join("before.txt"), "pre-existing\n").unwrap();
        let mut saved = SavedSession { id: uuid::Uuid::new_v4().to_string(), tool_id: "codex".into(),
            project_id: None, directory: root.display().to_string(), mode: LaunchMode::Normal,
            started_at: 0, stopped_at: None, native_id: None, account_id: None, context_id: None };
        let path = temp.path().join("restore.db");
        baseline::capture(&saved.id, &root);
        let original = baseline::get(&saved.id).unwrap();
        {
            let db = Database::open(&path).unwrap();
            save(&db, &saved).unwrap();
        }
        std::fs::write(root.join("session.txt"), "committed during session\n").unwrap();
        git(&["add", "session.txt"]);
        git(&["commit", "-qm", "session"]);
        // Simulate process loss, then repeat restart/id remapping three times.
        baseline::forget(&saved.id);
        for _ in 0..3 {
            let db = Database::open(&path).unwrap();
            let restored = saved_baseline(&db, &saved.id).unwrap().unwrap();
            assert_eq!(&restored, original.as_ref());
            assert_eq!(baseline::session_changes(&restored, &root).unwrap(), 1);
            assert_eq!(baseline::review_base(&restored, &root), original.head);
            let old = saved.id.clone();
            saved.id = uuid::Uuid::new_v4().to_string();
            baseline::restore(&saved.id, Some(restored));
            save(&db, &saved).unwrap();
            forget(&db, &old).unwrap();
            assert!(saved_baseline(&db, &old).unwrap().is_none());
            baseline::forget(&saved.id);
        }
        // Old versions did not save this evidence. Never manufacture a new start.
        let db = Database::open(&path).unwrap();
        assert!(saved_baseline(&db, "legacy-tab").unwrap().is_none());
    }

    #[test]
    fn codebuddy_empty_logs_do_not_block_restore_but_read_errors_do() {
        use crate::adapters::CliAdapter;
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("restore.db")).unwrap();
        let logs = temp.path().join(".codebuddy/projects/fixture");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("11111111-1111-4111-8111-111111111111.jsonl"), "").unwrap();
        std::fs::write(logs.join("22222222-2222-4222-8222-222222222222.jsonl"), "{\"type\":\"file-history-snapshot\",\"snapshot\":{}}\n").unwrap();
        std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history/codebuddy-2.161.1-session.jsonl"), logs.join("01a0c8f7-ef95-76a2-9503-6dbc8341a38f.jsonl")).unwrap();
        let adapter = &crate::adapters::CODEBUDDY;
        let sources = adapter.history_sources(temp.path()).unwrap();
        assert_eq!(sources.len(), 3);
        // No adapter port override here: this is the default path, which keeps
        // a full parse and trims it to the recovery fields.
        let identities = crate::history::restore_identities(&db, adapter, &sources).unwrap();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].native_id.as_deref(), Some("01a0c8f7-ef95-76a2-9503-6dbc8341a38f"));
        assert!(!identities[0].title.is_empty());
        let saved = SavedSession { id: "tab".into(), tool_id: "codebuddy".into(), project_id: None,
            directory: identities[0].cwd.clone().unwrap(), mode: LaunchMode::Normal,
            started_at: 0, stopped_at: None, native_id: identities[0].native_id.clone(), account_id: None, context_id: None };
        assert!(candidate(&saved, &identities[0], now()));
        std::fs::remove_file(&sources[0].path).unwrap();
        let error = crate::history::restore_identities(&db, adapter, &sources).unwrap_err();
        assert_ne!(error, crate::history::EMPTY_SESSION);
    }
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
        let mut parsed = SessionIdentity {
            cwd: Some("/work".into()), native_id: Some("one".into()), started_at: Some(10_000), ..Default::default()
        };
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
    #[test]
    fn explicit_candidate_choice_disambiguates_without_guessing() {
        let session = |id: &str| SessionIdentity { native_id: Some(id.into()), ..Default::default() };
        let (one, two) = (session("one"), session("two"));
        let candidates = [&one, &two];
        assert!(choose_candidate("tab", &candidates, None).is_err());
        assert_eq!(choose_candidate("tab", &candidates, Some(("tab", "two"))).unwrap().native_id.as_deref(), Some("two"));
        assert!(choose_candidate("tab", &candidates, Some(("tab", "missing"))).is_err());
        assert_eq!(choose_candidate("tab", &[&one], None).unwrap().native_id.as_deref(), Some("one"));
    }
    #[test]
    fn conversation_named_by_another_tab_is_not_ambiguous() {
        // Claude writes a transcript only after the first message, so a tab
        // opened earlier can see a sibling's conversation inside its window.
        let legacy = SavedSession { id: "legacy".into(), tool_id: "claude".into(), project_id: None, directory: "/work".into(), mode: LaunchMode::Normal, started_at: 10_000, stopped_at: Some(20_000), native_id: None, account_id: None, context_id: None };
        let named = SavedSession { id: "named".into(), native_id: Some("two".into()), started_at: 9_000, ..legacy.clone() };
        let all = [named.clone(), legacy.clone()];
        let session = |id: &str, at: i64| SessionIdentity {
            cwd: Some("/work".into()), native_id: Some(id.into()), started_at: Some(at), ..Default::default()
        };
        let (one, two) = (session("one", 12_000), session("two", 13_000));
        assert!(matches(&legacy, &one, &all, &all, 20_000));
        assert!(!matches(&legacy, &two, &all, &all, 20_000));
        assert!(matches(&named, &two, &all, &all, 20_000));
        assert!(!matches(&named, &one, &all, &all, 20_000));
        // Without the sibling's name both conversations stay ambiguous.
        let unnamed = [SavedSession { native_id: None, ..named }, legacy.clone()];
        assert!(matches(&legacy, &two, &unnamed, &unnamed, 20_000));
    }

    #[test]
    fn restore_events_publish_camel_case_fields_and_stage_names() {
        let event = RestoreEvent {
            restore_id: "restore-7".into(), saved_session_id: "tab".into(), stage: RestoreStage::Restored,
            detail: None, candidates: Vec::new(), session: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["restoreId"], "restore-7");
        assert_eq!(json["savedSessionId"], "tab");
        assert_eq!(json["stage"], "restored");
        assert!(json["candidates"].is_array());
        assert_eq!(serde_json::to_value(RestoreStage::Discovering).unwrap(), "discovering");
        assert_eq!(serde_json::to_value(RestoreStage::Starting).unwrap(), "starting");
        assert_eq!(serde_json::to_value(RestoreStage::Failed).unwrap(), "failed");
        // The saved-record list IPC keeps the same field spelling.
        let saved = SavedSession { id: "tab".into(), tool_id: "codex".into(), project_id: None, directory: "/work".into(),
            mode: LaunchMode::Normal, started_at: 1, stopped_at: None, native_id: None, account_id: None, context_id: None };
        let json = serde_json::to_value(&saved).unwrap();
        assert_eq!(json["toolId"], "codex");
        assert_eq!(json["startedAt"], 1);
        assert!(json.get("nativeId").is_some());
    }

    /// The account context selects the native history root and it is
    /// thread-local, so a restore worker must enter it before discovery.
    /// Otherwise an account-scoped conversation, which the default root never
    /// holds, is invisible and the tab fails to restore.
    #[cfg(windows)]
    #[test]
    fn an_account_scoped_history_root_is_discovered_inside_the_account_context() {
        let _guard = crate::session_host::lock_for_tests();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let account_root = home.join("account");
        let account_history = account_root.join("sessions");
        std::fs::create_dir_all(&account_history).unwrap();
        // The default native root exists but never holds this conversation.
        std::fs::create_dir_all(home.join(".codex/sessions")).unwrap();
        std::fs::write(account_root.join("config.toml"), "model = \"gpt-6-astra\"\n").unwrap();
        let native = "33333333-3333-4333-8333-333333333333";
        let started_at = now();
        let meta = serde_json::json!({"timestamp": started_at, "type": "session_meta", "payload": {"id": native, "cwd": home.display().to_string(), "cli_version": "0.165.0"}});
        let user = serde_json::json!({"timestamp": started_at, "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "账号上下文内的会话"}]}});
        std::fs::write(account_history.join("rollout-account.jsonl"), format!("{meta}\n{user}\n")).unwrap();
        let program = home.join("fixture.ps1");
        std::fs::write(&program, "[Console]::WriteLine('restored-args:' + ($args -join '|')); $null = [Console]::ReadLine(); [Console]::WriteLine('RESTORE_EXIT_TAIL')").unwrap();
        let context = crate::accounts::NativeContext {
            id: "ctx-fixture".into(), tool_id: "codex".into(),
            root: account_root.clone(), config_root: account_root.clone(),
            auth_files: Vec::new(), history_roots: vec![account_history.clone()],
            resource_root: account_root.clone(),
            environment: std::collections::BTreeMap::new(), remove_environment: Vec::new(), cli_args: Vec::new(),
        };
        let db = Database::open(&home.join("restore.db")).unwrap();
        // The launch path revalidates the stored account binding, so the record
        // exists; what this test drives is the discovery/guard ordering.
        let account = crate::accounts::AuthAccount {
            id: "account-fixture".into(), tool_id: "codex".into(), provider: "chatgpt".into(), label: "fixture".into(), version: 1,
            state: crate::accounts::AccountState::SignedIn,
            identity: Some(crate::accounts::AccountIdentity {
                subject: "fixture@example.com".into(), email: Some("fixture@example.com".into()), plan: None, source: "test".into(),
            }),
            context: Some(context.clone()), retired_contexts: Vec::new(), pending_login: None,
            checked_at: Some(started_at as i64), detail: None,
        };
        let data = serde_json::to_string(&account).unwrap();
        db.with_connection(|conn| conn.execute("INSERT INTO auth_accounts(id,tool,version,data) VALUES(?1,?2,?3,?4)",
            rusqlite::params![account.id, account.tool_id, account.version, data]).map(|_| ()).map_err(|error| error.to_string())).unwrap();
        let saved = SavedSession { id: "account-tab".into(), tool_id: "codex".into(), project_id: None,
            directory: home.display().to_string(), mode: LaunchMode::Normal, started_at, stopped_at: Some(now()),
            native_id: Some(native.into()), account_id: Some(account.id.clone()), context_id: Some(context.id.clone()) };
        save(&db, &saved).unwrap();
        let mut registry = Registry::builtins();
        registry.fixture_installations.insert("codex".into(), vec![crate::native::adapter::Installation {
            path: program.display().to_string(), version: Some("0.165.0".into()), source: "test", status: "available", detail: None,
        }]);
        let adapter = registry.get("codex").unwrap();
        let targets = [saved.clone()];
        let all = targets.clone();
        let live = HashMap::new();
        let claimed = Mutex::new(HashSet::new());
        let scope = RestoreScope {
            db: &db, registry: &registry, home, targets: &targets, all: &all, live: &live,
            until: now(), claimed: &claimed, restore_id: "restore-account", reporter: &|_| {}, selection: None,
        };
        // The conversation exists only under the account's history root, and
        // only that root answers while the account context is entered.
        {
            let _entered = crate::accounts::selection::enter(Some(context.clone()));
            let sources = adapter.history_sources(home).unwrap();
            assert_eq!(sources.len(), 1);
            assert!(sources[0].path.starts_with(&account_history), "{:?}", sources[0].path);
        }
        assert!(adapter.history_sources(home).unwrap().is_empty(), "the default root never holds it");
        let binding = (account.id.clone(), context.clone());
        // Each run starts a fresh worker thread, so the account context has to
        // be entered there; it is never inherited from this thread.
        let run = |context: Option<&(String, crate::accounts::NativeContext)>| std::thread::scope(|threads| {
            threads.spawn(|| restore_items(&scope, &[0], adapter, context)).join().unwrap()
        });
        let missed = run(None);
        assert!(matches!(&missed[0].1,
            ItemOutcome::Failed { detail, .. } if detail.contains("尚未找到原生会话记录")), "{:?}", missed.len());
        let found = run(Some(&binding));
        let id = match &found[0].1 {
            ItemOutcome::Restored(id) => id.clone(),
            ItemOutcome::Failed { detail, .. } => panic!("{detail}"),
        };
        crate::session_host::wait_for_replay(&id, &format!("resume|{native}")).unwrap();
        let record = list(&db).unwrap();
        assert_eq!(record.len(), 1);
        assert_eq!(record[0].native_id.as_deref(), Some(native));
        assert_eq!(record[0].account_id.as_deref(), Some("account-fixture"));
        assert_eq!(record[0].context_id.as_deref(), Some("ctx-fixture"));
        assert!(same_directory(&record[0].directory, &saved.directory));
        crate::session_host::close(&id).unwrap();
    }

    /// A context that cannot produce an identity must not keep another context
    /// from restoring, and every item reports its own terminal state.
    #[cfg(windows)]
    #[test]
    fn a_failing_context_does_not_block_another_and_reports_each_item() {
        let _guard = crate::session_host::lock_for_tests();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let native = "11111111-1111-4111-8111-111111111111";
        let logs = home.join(".codex/sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let started_at = now();
        let line = serde_json::json!({"timestamp": started_at, "type": "session_meta", "payload": {"id": native, "cwd": home.display().to_string(), "cli_version": "0.165.0"}});
        std::fs::write(logs.join("rollout-fixture.jsonl"), format!("{line}\n")).unwrap();
        let program = home.join("fixture.ps1");
        std::fs::write(&program, "[Console]::WriteLine('restored-args:' + ($args -join '|')); $null = [Console]::ReadLine(); [Console]::WriteLine('RESTORE_EXIT_TAIL')").unwrap();
        let directory = home.display().to_string();
        let restorable = SavedSession { id: "codex-tab".into(), tool_id: "codex".into(), project_id: None, directory: directory.clone(),
            mode: LaunchMode::Normal, started_at, stopped_at: Some(now()), native_id: None, account_id: None, context_id: None };
        // This tab names a conversation its own native history never held.
        let missing = SavedSession { id: "claude-tab".into(), tool_id: "claude_code".into(), project_id: None, directory,
            mode: LaunchMode::Normal, started_at, stopped_at: Some(now()), native_id: Some("22222222-2222-4222-8222-222222222222".into()),
            account_id: None, context_id: None };
        let db = Database::open(&home.join("restore.db")).unwrap();
        save(&db, &missing).unwrap();
        save(&db, &restorable).unwrap();
        let mut registry = Registry::builtins();
        for (tool, version) in [("codex", "0.165.0"), ("claude_code", "2.1.0")] {
            registry.fixture_installations.insert(tool.into(), vec![crate::native::adapter::Installation {
                path: program.display().to_string(), version: Some(version.into()), source: "test", status: "available", detail: None,
            }]);
        }
        let events = Mutex::new(Vec::new());
        let report = restore_with(&db, &registry, home, &|event| events.lock().unwrap().push(event)).unwrap();
        assert_eq!(report.restored.len(), 1, "{:?}", report.failures.iter().map(|failure| &failure.detail).collect::<Vec<_>>());
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].session.id, "claude-tab");
        let id = report.restored.get("codex-tab").unwrap();
        crate::session_host::wait_for_replay(id, &format!("resume|{native}")).unwrap();

        let events = events.lock().unwrap();
        for saved in [&restorable, &missing] {
            let stages: Vec<_> = events.iter().filter(|event| event.saved_session_id == saved.id).map(|event| event.stage).collect();
            assert!(matches!(stages.as_slice(), [RestoreStage::Discovering, RestoreStage::Starting, RestoreStage::Restored] | [RestoreStage::Discovering, RestoreStage::Failed]), "{:?}", stages);
        }
        let restored = events.iter().find(|event| event.stage == RestoreStage::Restored).unwrap();
        let live = restored.session.as_ref().expect("a restored item carries its live session");
        assert_eq!(live.id, *id);
        assert_eq!(live.tool_id, "codex");
        assert!(same_directory(&live.directory, &restorable.directory));
        assert!(events.iter().filter(|event| event.restore_id == restored.restore_id).count() == events.len());
        crate::session_host::close(id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn reopening_database_restores_exact_native_session_into_real_pty_once() {
        // This test keeps a live session in the global session_host registry;
        // session_host tests (e.g. the shutdown path) clear that registry, so
        // they must never run concurrently with it.
        let _guard = crate::session_host::lock_for_tests();
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
        std::fs::write(&program, "[Console]::WriteLine('restored-args:' + ($args -join '|')); $null = [Console]::ReadLine(); [Console]::WriteLine('RESTORE_EXIT_TAIL')").unwrap();
        let saved = SavedSession { id: "previous-process".into(), tool_id: "codex".into(), project_id: None, directory: home.display().to_string(), mode: LaunchMode::Normal, started_at, stopped_at: Some(now()), native_id: None, account_id: None, context_id: None };
        let original: crate::session_baseline::SessionBaseline = serde_json::from_value(serde_json::json!({
            "root": home, "head": "a".repeat(40), "dirty": {"old.txt": null}
        })).unwrap();
        crate::session_baseline::restore(&saved.id, Some(original.clone()));
        {
            let db = Database::open(&database).unwrap();
            save(&db, &saved).unwrap();
        }
        crate::session_baseline::forget(&saved.id);
        let db = Database::open(&database).unwrap();
        let mut registry = Registry::builtins();
        registry.fixture_installations.insert("codex".into(), vec![crate::native::adapter::Installation { path: program.display().to_string(), version: Some("0.165.0".into()), source: "test", status: "available", detail: None }]);
        let report = restore(&db, &registry, home).unwrap();
        assert!(report.failures.is_empty(), "{:?}", report.failures.iter().map(|failure| &failure.detail).collect::<Vec<_>>());
        let id = report.restored.get(&saved.id).unwrap();
        assert_eq!(crate::session_baseline::get(id).as_deref(), Some(&original));
        let output = crate::session_host::wait_for_replay(id, &format!("resume|{native}"));
        assert!(restore_selected(&db, &registry, home, id, None).is_err(), "a running tab must not be duplicated");
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
        output.unwrap();
        use base64::Engine;
        crate::session_host::write(id, &base64::engine::general_purpose::STANDARD.encode(b"\r")).unwrap();
        crate::session_host::wait_for_replay(id, "RESTORE_EXIT_TAIL").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while crate::session_host::list().iter().any(|session| session.id == *id && session.running) {
            assert!(std::time::Instant::now() < deadline, "local exit was not observed");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(restore(&db, &registry, home).unwrap().restored.is_empty(), "ended tabs must not auto-resume");
        assert!(restore_selected(&db, &registry, home, id, Some("not-this-conversation")).unwrap().restored.is_empty());
        assert!(crate::session_host::list().iter().any(|session| session.id == *id), "failed recovery must retain the old terminal");
        let resumed = restore_selected(&db, &registry, home, id, None).unwrap();
        let resumed_id = resumed.restored.get(id).expect("ended tab resumes its exact conversation");
        assert_eq!(crate::session_baseline::get(resumed_id).as_deref(), Some(&original));
        assert!(!crate::session_host::list().iter().any(|session| session.id == *id));
        crate::session_host::wait_for_replay(resumed_id, &format!("resume|{native}")).unwrap();
        crate::session_host::close(resumed_id).unwrap();
        // A later restart uses the now-known native identity, regardless of
        // the original conversation's creation time.
        let next = restore(&db, &registry, home).unwrap();
        let next_id = next.restored.get(resumed_id).unwrap();
        assert_eq!(crate::session_baseline::get(next_id).as_deref(), Some(&original));
        let output = crate::session_host::wait_for_replay(next_id, &format!("resume|{native}"));
        crate::session_host::close(next_id).unwrap();
        forget(&db, next_id).unwrap();
        output.unwrap();
        assert!(list(&db).unwrap().is_empty());
    }
}
/// Restore performance benchmark fixture. The same transcripts and the same
/// measurement run before and after the recovery changes, so the two numbers
/// are comparable: the first readable SessionSnapshot and the end of the whole
/// batch. It is a measurement, not a pass/fail threshold, and it needs a real
/// PTY, so it stays ignored and single-threaded.
#[cfg(all(test, windows))]
mod restore_fixture {
    use super::*;
    /// Message pairs per synthetic transcript: enough for parsing to dominate
    /// the measurement without turning the benchmark into a bulk data test.
    const MESSAGE_PAIRS: usize = 1_500;
    const BODY_CHARS: usize = 400;
    const STAMP: &str = "2026-09-29T08:00:00Z";

    fn body() -> String {
        "会话正文".repeat(BODY_CHARS / 4)
    }

    fn write_codex_transcript(home: &Path, native: &str) {
        let root = home.join(".codex").join("sessions").join("2026").join("09");
        std::fs::create_dir_all(&root).unwrap();
        let cwd = home.display().to_string();
        let mut text = String::new();
        text.push_str(&serde_json::json!({"timestamp": STAMP, "type": "session_meta", "payload": {"id": native, "cwd": cwd, "cli_version": "0.165.0"}}).to_string());
        text.push('\n');
        text.push_str(&serde_json::json!({"timestamp": STAMP, "type": "turn_context", "payload": {"model": "gpt-6-astra"}}).to_string());
        text.push('\n');
        for index in 0..MESSAGE_PAIRS {
            let body = body();
            text.push_str(&serde_json::json!({"timestamp": STAMP, "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": format!("{index} {body}")}]}}).to_string());
            text.push('\n');
            text.push_str(&serde_json::json!({"timestamp": STAMP, "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": format!("{index} {body}")}]}}).to_string());
            text.push('\n');
        }
        std::fs::write(root.join(format!("rollout-{native}.jsonl")), text).unwrap();
    }

    fn write_claude_transcript(home: &Path, name: &str, native: &str) {
        let root = home.join(".claude").join("projects").join("fixture-project");
        std::fs::create_dir_all(&root).unwrap();
        let cwd = home.display().to_string();
        let mut text = String::new();
        for index in 0..MESSAGE_PAIRS {
            let body = body();
            text.push_str(&serde_json::json!({"type": "user", "uuid": format!("user-{name}-{index}"), "sessionId": native, "cwd": cwd, "timestamp": STAMP, "message": {"role": "user", "content": format!("{index} {body}")}}).to_string());
            text.push('\n');
            text.push_str(&serde_json::json!({"type": "assistant", "uuid": format!("assistant-{name}-{index}"), "sessionId": native, "cwd": cwd, "timestamp": STAMP, "message": {"id": format!("msg-{name}-{index}"), "role": "assistant", "model": "claude-opus-4-1", "content": [{"type": "text", "text": format!("{index} {body}")}], "usage": {"input_tokens": 5, "output_tokens": 1, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 10}}}).to_string());
            text.push('\n');
        }
        std::fs::write(root.join(format!("{name}.jsonl")), text).unwrap();
    }

    pub(super) fn fixture_program(home: &Path) -> std::path::PathBuf {
        let program = home.join("fixture-cli.ps1");
        std::fs::write(&program, "[Console]::WriteLine('restored-args:' + ($args -join '|')); $null = [Console]::ReadLine(); [Console]::WriteLine('RESTORE_EXIT_TAIL')").unwrap();
        program
    }

    /// Four saved tabs in two CLI/account contexts, with isolated native
    /// history of the same shape in both runs.
    pub(super) fn seed(home: &Path) -> Vec<SavedSession> {
        let directory = home.display().to_string();
        let codex = ["11111111-1111-4111-8111-111111111101", "11111111-1111-4111-8111-111111111102"];
        let claude = ["22222222-2222-4222-8222-222222222201", "22222222-2222-4222-8222-222222222202"];
        let mut saved = Vec::new();
        for (index, native) in codex.iter().enumerate() {
            write_codex_transcript(home, native);
            saved.push(SavedSession { id: format!("codex-tab-{index}"), tool_id: "codex".into(), project_id: None,
                directory: directory.clone(), mode: LaunchMode::Normal, started_at: 10_000 + index as u64 * 1_000,
                stopped_at: Some(20_000), native_id: Some((*native).into()), account_id: None, context_id: None });
        }
        for (index, native) in claude.iter().enumerate() {
            write_claude_transcript(home, &format!("claude-{index}"), native);
            saved.push(SavedSession { id: format!("claude-tab-{index}"), tool_id: "claude_code".into(), project_id: None,
                directory: directory.clone(), mode: LaunchMode::Normal, started_at: 10_000 + index as u64 * 1_000,
                stopped_at: Some(20_000), native_id: Some((*native).into()), account_id: None, context_id: None });
        }
        saved
    }
}

#[cfg(all(test, windows))]
#[test]
#[ignore = "restore performance benchmark: needs a real PTY, run with --ignored --test-threads=1"]
fn performance_restore_first_and_all() {
    use restore_fixture::{fixture_program, seed};
    let _sessions = crate::session_host::lock_for_tests();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let saved = seed(home);
    let program = fixture_program(home);
    let db = Database::open(&home.join("restore.db")).unwrap();
    for session in &saved {
        save(&db, session).unwrap();
    }
    let mut registry = Registry::builtins();
    for (tool, version) in [("codex", "0.165.0"), ("claude_code", "2.1.0")] {
        registry.fixture_installations.insert(tool.into(), vec![crate::native::adapter::Installation {
            path: program.display().to_string(), version: Some(version.into()), source: "test", status: "available", detail: None,
        }]);
    }
    // Identical indexed history in both runs. The unoptimized restore does not
    // consult the index, so this does not tilt the comparison.
    crate::history::refresh(&db, &registry, home).unwrap();
    let existing: HashSet<String> = crate::session_host::list().into_iter().map(|session| session.id).collect();

    let started = std::time::Instant::now();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let first = std::sync::Arc::new(std::sync::Mutex::new(None::<(std::time::Duration, String)>));
    let watch = {
        let done = done.clone();
        let first = first.clone();
        std::thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::Relaxed) {
                let found = crate::session_host::list().into_iter().find(|session| !existing.contains(&session.id));
                if let Some(snapshot) = found {
                    first.lock().unwrap().get_or_insert((started.elapsed(), snapshot.id));
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        })
    };
    let report = restore(&db, &registry, home).unwrap();
    let all = started.elapsed();
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    watch.join().unwrap();
    let first = first.lock().unwrap().clone();

    assert!(report.failures.is_empty(), "{:?}", report.failures.iter().map(|failure| &failure.detail).collect::<Vec<_>>());
    assert_eq!(report.restored.len(), saved.len());
    println!(
        "restore_performance: sessions={} first_snapshot={:?} all_end={:?}",
        saved.len(),
        first.as_ref().map(|item| item.0),
        all
    );

    // Recovery content must not change: same directories, same native ids,
    // same account context, and the CLI resumed that exact conversation.
    let remaining = list(&db).unwrap();
    assert_eq!(remaining.len(), saved.len());
    let mut expected: Vec<_> = saved.iter().map(|session| session.native_id.clone().unwrap()).collect();
    let mut actual: Vec<_> = remaining.iter().map(|session| session.native_id.clone().unwrap()).collect();
    expected.sort();
    actual.sort();
    assert_eq!(expected, actual);
    assert!(remaining.iter().all(|session| same_directory(&session.directory, &saved[0].directory)));
    assert!(remaining.iter().all(|session| session.account_id.is_none()));
    for (old, new) in report.restored.iter() {
        let session = saved.iter().find(|session| &session.id == old).unwrap();
        let flag = if session.tool_id == "claude_code" { "--resume" } else { "resume" };
        crate::session_host::wait_for_replay(new, &format!("{flag}|{}", session.native_id.as_deref().unwrap())).unwrap();
    }
    for id in report.restored.values() {
        let _ = crate::session_host::close(id);
    }
}
