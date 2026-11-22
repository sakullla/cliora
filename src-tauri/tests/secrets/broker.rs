//! Broker contracts: an installation, a grant and a fixed executor are needed
//! before any value moves, returned text is masked, every read needs its own
//! approval, and the audit trail never stores the value.
use super::*;
use crate::secrets::approval::{Host, Prompt, Verdict};
use crate::secrets::executor::{Channel, NewExecutor};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const CANARY: &str = "canary-synthetic-7b2e4d";
const OTHER: &str = "canary-other-value-4f81";

#[derive(Default)]
struct MemoryCredentials {
    values: Mutex<BTreeMap<String, String>>,
    lookups: AtomicUsize,
}

impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.values.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.lookup(id)?.ok_or_else(|| "missing".into())
    }
    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        self.lookups.fetch_add(1, Ordering::Relaxed);
        Ok(self.values.lock().unwrap().get(id).cloned())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}

fn db() -> Database {
    Database::open(std::path::Path::new(":memory:")).unwrap()
}

fn create_secret(database: &Database, store: &MemoryCredentials, alias: &str, value: &str) -> crate::secrets::PromptSecret {
    crate::secrets::create(database, store, alias, value).unwrap()
}

fn installation(database: &Database) -> Installation {
    create_installation(database, "测试 CLI", Kind::Cli, Some("fixture")).unwrap()
}

fn register(
    database: &Database,
    label: &str,
    executable: &str,
    args: &[&str],
    channel: Channel,
    env_name: Option<&str>,
) -> executor::SecretExecutor {
    executor::register(
        database,
        NewExecutor {
            label: label.into(),
            description: String::new(),
            executable: executable.into(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            cwd: None,
            channel,
            env_name: env_name.map(str::to_owned),
        },
    )
    .unwrap()
}

/// Everything the caller received, as one string, for "no value anywhere" checks.
fn body(response: &ipc::Response) -> String {
    format!(
        "{}{}{}",
        response.code,
        response.message,
        response.data.as_ref().map(|data| data.to_string()).unwrap_or_default()
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Answer {
    Accept,
    Decline,
    Twice,
    Unavailable,
    Silence,
}

/// Stands in for the confirmation window: it answers through the same public entry
/// point the Tauri command uses, so a test cannot authorize by shortcut.
struct FakeHost {
    mode: Answer,
    asked: Mutex<Vec<Prompt>>,
    replays: Arc<Mutex<Vec<Result<(), String>>>>,
}

impl FakeHost {
    fn new(mode: Answer) -> Self {
        Self { mode, asked: Mutex::new(Vec::new()), replays: Arc::new(Mutex::new(Vec::new())) }
    }

    fn asked(&self) -> Vec<Prompt> {
        self.asked.lock().unwrap().clone()
    }

    fn replays(&self) -> Vec<Result<(), String>> {
        self.replays.lock().unwrap().clone()
    }
}

impl Host for FakeHost {
    fn ask(&self, prompt: &Prompt) -> Result<(), String> {
        self.asked.lock().unwrap().push(prompt.clone());
        let id = prompt.approval_id.clone();
        let mode = self.mode;
        let replays = self.replays.clone();
        match mode {
            Answer::Unavailable => Err("确认窗口不可用".to_string()),
            Answer::Silence => Ok(()),
            Answer::Accept | Answer::Decline => {
                let accept = mode == Answer::Accept;
                std::thread::spawn(move || {
                    let _ = approval::answer(&id, accept);
                });
                Ok(())
            }
            Answer::Twice => {
                std::thread::spawn(move || {
                    let _ = approval::answer(&id, true);
                    // A replayed answer must find nothing left to authorize.
                    for _ in 0..200 {
                        if let Err(error) = approval::answer(&id, true) {
                            replays.lock().unwrap().push(Err(error));
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                });
                Ok(())
            }
        }
    }
}

fn use_request(
    database: &Database,
    store: &MemoryCredentials,
    installation_id: &str,
    secret_id: &str,
    executor_id: &str,
) -> ipc::Response {
    use_secret(database, store, installation_id, secret_id, executor_id, &AtomicBool::new(false))
}

fn wait_for_replay(host: &FakeHost) -> Vec<Result<(), String>> {
    for _ in 0..200 {
        let replays = host.replays();
        if !replays.is_empty() {
            return replays;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    host.replays()
}

#[test]
fn a_grant_is_required_before_a_value_reaches_an_executor() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "部署口令", CANARY);
    let executor = register(&database, "env 读取", "env", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::GRANT_MISSING);
    assert!(response.data.is_none());
    assert!(!body(&response).contains(CANARY));
}

#[cfg(unix)]
#[test]
fn the_env_channel_delivers_the_value_and_masks_every_returned_byte() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "env 口令", CANARY);
    create_secret(&database, &store, "无关执行口令", OTHER);
    let executor = register(&database, "env 读取", "/usr/bin/env", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    store.lookups.store(0, Ordering::Relaxed);
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(response.ok, "{}", response.message);
    assert_eq!(store.lookups.load(Ordering::Relaxed), 1);
    let data = response.data.unwrap();
    let stdout = data["stdout"].as_str().unwrap();
    // The child printed its environment, so the masked line proves it received the
    // value on the chosen channel.
    assert!(stdout.contains("CLIORATEST=[redacted]"), "{stdout}");
    assert_eq!(data["exitCode"], 0);
    assert!(!data.to_string().contains(CANARY));
    // The audit row records the outcome, not the run.
    let rows = audit::list(&database, 10).unwrap();
    assert!(rows
        .iter()
        .any(|row| row.operation == "use" && row.decision == "allowed" && row.code == audit::code::OK));
    assert!(!format!("{rows:?}").contains(CANARY));
}

#[cfg(unix)]
#[test]
fn the_stdin_channel_carries_the_value_without_putting_it_in_argv() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "stdin 口令", CANARY);
    let executor = register(&database, "stdin 回显", "/bin/cat", &[], Channel::Stdin, None);
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(response.ok, "{}", response.message);
    let data = response.data.unwrap();
    assert_eq!(data["stdout"].as_str().unwrap().trim(), "[redacted]");
    // The registered argv is the whole argv: no value is added at run time.
    assert_eq!(executor.args, Vec::<String>::new());
    assert!(!data.to_string().contains(CANARY));
}

#[cfg(unix)]
#[test]
fn stderr_and_a_failed_run_are_masked_and_never_switch_secrets() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "失败口令", CANARY);
    // A second secret stays granted to nobody: a failed run must not reach for it.
    let ungranted = create_secret(&database, &store, "另一个口令", OTHER);
    let script = "printf '%s' \"$CLIORATEST\" >&2; exit 3";
    let executor = register(&database, "stderr 回显", "/bin/sh", &["-c", script], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(response.ok, "a non-zero exit is a result, not a secret fallback: {}", response.message);
    let data = response.data.unwrap();
    assert_eq!(data["exitCode"], 3);
    assert_eq!(data["stderr"].as_str().unwrap(), "[redacted]");
    let text = data.to_string();
    assert!(!text.contains(CANARY));
    assert!(!text.contains(OTHER));
    let rows = audit::list(&database, 10).unwrap();
    assert!(rows.iter().any(|row| row.code == audit::code::EXIT_FAILURE));
    assert!(!format!("{rows:?}").contains(CANARY));
    assert!(!ungranted.id.is_empty());
    assert_eq!(list_grants(&database).unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn an_edited_script_invalidates_the_registered_digest() {
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("payload.txt");
    std::fs::write(&script, "first").unwrap();
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "digest 口令", CANARY);
    let executor = register(
        &database,
        "带脚本入口",
        "/bin/echo",
        &[script.to_str().unwrap()],
        Channel::Env,
        Some("CLIORATEST"),
    );
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    assert!(use_request(&database, &store, &installation.id, &secret.id, &executor.id).ok);
    std::fs::write(&script, "second").unwrap();
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::SCRIPT_CHANGED);
    assert!(!body(&response).contains(CANARY));
}

#[cfg(unix)]
#[test]
fn an_edited_absolute_executable_invalidates_the_registered_digest() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("deploy script.sh");
    let write = |body: &str| {
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    };
    let initial = "#!/bin/sh\nprintf 'first'\n";
    write(initial);
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "入口脚本口令", CANARY);
    // The script is the executable itself, not an argument: its bytes are the code
    // that receives the value, so they belong to the registered definition.
    let executor = register(&database, "脚本入口", script.to_str().unwrap(), &[], Channel::Env, Some("CLIORATEST"));
    let mut legacy = Sha256::new();
    legacy.update(format!("cliora-secret-executor-v1\0{}\0\0executable\0{}\0", script.display(), script.display()));
    legacy.update((initial.len() as u64).to_le_bytes());
    legacy.update(initial.as_bytes());
    assert_eq!(executor.digest, format!("{:x}", legacy.finalize()));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let first = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(first.ok, "{}", first.message);
    assert_eq!(first.data.unwrap()["stdout"].as_str().unwrap().trim(), "first");

    write("#!/bin/sh\nprintf 'second'\n");
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::SCRIPT_CHANGED);
    assert!(response.data.is_none());
    assert!(!body(&response).contains(CANARY));

    // A run whose digest cannot be recomputed at all fails closed the same way.
    std::fs::remove_file(&script).unwrap();
    let missing = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!missing.ok);
    assert_eq!(missing.code, audit::code::SCRIPT_CHANGED);
    assert!(!body(&missing).contains(CANARY));
}

#[cfg(unix)]
#[test]
fn an_absolute_executable_must_be_a_readable_regular_file() {
    let database = db();
    let directory = tempfile::tempdir().unwrap();
    let attempt = |label: &str, executable: std::path::PathBuf| {
        executor::register(
            &database,
            NewExecutor {
                label: label.into(),
                description: String::new(),
                executable: executable.to_str().unwrap().to_owned(),
                args: vec![],
                cwd: None,
                channel: Channel::Env,
                env_name: Some("CLIORATEST".into()),
            },
        )
    };
    // A directory has no hashable content and cannot be an execution definition.
    let directory_refused = attempt("目录入口", directory.path().to_path_buf());
    assert!(directory_refused.is_err(), "a directory must not register");
    // A missing absolute path cannot be read either.
    assert!(attempt("缺失入口", directory.path().join("absent.sh")).is_err());
    // Above the executable budget the content is refused, never silently excluded.
    let huge = directory.path().join("huge.bin");
    std::fs::File::create(&huge).unwrap().set_len(executor::MAX_EXECUTABLE_BYTES + 1).unwrap();
    let oversized = attempt("超大入口", huge);
    let message = oversized.unwrap_err();
    assert!(message.contains("64 MiB"), "{message}");
    // A refused registration stores nothing a grant could point at.
    assert!(executor::list(&database).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_cancelled_run_stops_without_returning_output() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "取消口令", CANARY);
    let executor = register(&database, "长时间运行", "/bin/sleep", &["5"], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let signalled = cancel.clone();
    let started = std::time::Instant::now();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        signalled.store(true, Ordering::SeqCst);
    });
    let response = use_secret(&database, &store, &installation.id, &secret.id, &executor.id, &cancel);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::CANCELLED);
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(response.data.is_none());
}

#[cfg(unix)]
#[test]
fn a_slow_run_times_out_without_returning_output() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "超时口令", CANARY);
    let executor = register(&database, "超时入口", "/bin/sleep", &["5"], Channel::Env, Some("CLIORATEST"));
    assert!(!secret.id.is_empty());
    let failure = executor::run_with_timeout(&executor, CANARY, &AtomicBool::new(false), Duration::from_millis(120))
        .unwrap_err();
    assert_eq!(failure.code, audit::code::TIMEOUT);
    assert!(!failure.message.contains(CANARY));
}

#[test]
fn every_read_needs_its_own_approval() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "读取口令", CANARY);
    create_secret(&database, &store, "无关口令", OTHER);
    store.lookups.store(0, Ordering::Relaxed);
    let installation = installation(&database);
    let executor = register(&database, "测试传递", "node", &[], Channel::Stdin, None);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let host = FakeHost::new(Answer::Accept);
    for _ in 0..2 {
        let response = read_secret(&database, &store, &host, &installation.id, &secret.id);
        assert!(response.ok, "{}", response.message);
        let data = response.data.unwrap();
        assert_eq!(data["value"], CANARY);
        assert_eq!(data["alias"], "读取口令");
    }
    let asked = host.asked();
    assert_eq!(store.lookups.load(Ordering::Relaxed), 2, "each approval reads only the selected credential once");
    assert_eq!(asked.len(), 2, "each read must create its own request");
    // Each completed read keeps its own access record.
    let rows = audit::list(&database, 20).unwrap();
    assert_eq!(rows.iter().filter(|row| row.operation == "read" && row.code == audit::code::OK).count(), 2);
    assert!(rows.iter().all(|row| row.code.len() < 32));
    assert_ne!(asked[0].approval_id, asked[1].approval_id);
    // The window only ever sees the alias, the source and how long it waits.
    for prompt in &asked {
        assert_eq!(prompt.alias, "读取口令");
        assert!(prompt.source.contains("CLI"), "{}", prompt.source);
        assert!(!prompt.source.contains(CANARY));
        assert_eq!(prompt.expires_in_seconds, 120);
    }
}

#[test]
fn a_reference_without_a_grant_cannot_prompt_for_or_read_a_value() {
    let db = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&db, &store, "未授权口令", CANARY);
    let installation = installation(&db);
    let host = FakeHost::new(Answer::Accept);
    store.lookups.store(0, Ordering::Relaxed);
    let result = read_secret(&db, &store, &host, &installation.id, &secret.id);
    assert_eq!(result.code, audit::code::GRANT_MISSING);
    assert!(host.asked().is_empty());
    assert_eq!(store.lookups.load(Ordering::Relaxed), 0);
}

#[test]
fn a_declined_read_returns_no_value_and_authorizes_nothing_later() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "拒绝口令", CANARY);
    store.lookups.store(0, Ordering::Relaxed);
    let installation = installation(&database);
    let executor = register(&database, "测试传递", "node", &[], Channel::Stdin, None);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let host = FakeHost::new(Answer::Decline);
    let response = read_secret(&database, &store, &host, &installation.id, &secret.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::DECLINED);
    assert!(response.data.is_none());
    assert_eq!(store.lookups.load(Ordering::Relaxed), 0);
    assert!(!body(&response).contains(CANARY));
    let rows = audit::list(&database, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows
        .iter()
        .any(|row| row.operation == "read" && row.decision == "denied" && row.code == audit::code::DECLINED));
    // The refused request is gone: answering it again changes nothing.
    let approval_id = host.asked()[0].approval_id.clone();
    assert!(approval::answer(&approval_id, true).is_err());
}

#[test]
fn a_repeated_answer_cannot_authorize_a_second_read() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "重复口令", CANARY);
    let installation = installation(&database);
    let executor = register(&database, "测试传递", "node", &[], Channel::Stdin, None);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let host = FakeHost::new(Answer::Twice);
    let response = read_secret(&database, &store, &host, &installation.id, &secret.id);
    assert!(response.ok, "{}", response.message);
    let replays = wait_for_replay(&host);
    assert_eq!(replays.len(), 1, "the replay must be refused: {replays:?}");
    assert!(replays[0].is_err());
    assert!(approval::answer("not-a-uuid", true).is_err());
}

#[test]
fn an_unavailable_window_or_an_expired_request_returns_no_value() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "窗口口令", CANARY);
    let installation = installation(&database);
    let executor = register(&database, "测试传递", "node", &[], Channel::Stdin, None);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let hidden = FakeHost::new(Answer::Unavailable);
    let response = read_secret(&database, &store, &hidden, &installation.id, &secret.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::APPROVAL_UNAVAILABLE);
    assert!(response.data.is_none());
    assert!(!body(&response).contains(CANARY));

    let silent = FakeHost::new(Answer::Silence);
    let verdict = approval::request_with_timeout(&silent, "窗口口令", "CLI · 测试 CLI", Duration::from_millis(80));
    assert_eq!(verdict, Verdict::Expired);
    // An expired request accepts no late answer.
    let approval_id = silent.asked()[0].approval_id.clone();
    assert!(approval::answer(&approval_id, true).is_err());
}

#[cfg(unix)]
#[test]
fn an_accepted_controlled_use_does_not_authorize_a_read() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "双重模式口令", CANARY);
    let executor = register(&database, "env 读取", "/usr/bin/env", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    assert!(use_request(&database, &store, &installation.id, &secret.id, &executor.id).ok);
    // A grant covers controlled use only; the read still needs its own approval.
    let refusing = FakeHost::new(Answer::Decline);
    let response = read_secret(&database, &store, &refusing, &installation.id, &secret.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::DECLINED);
    assert_eq!(refusing.asked().len(), 1);
}

#[test]
fn an_unknown_or_revoked_installation_fails_closed() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "安装口令", CANARY);
    let host = FakeHost::new(Answer::Accept);
    let unknown = read_secret(&database, &store, &host, &uuid::Uuid::new_v4().to_string(), &secret.id);
    assert!(!unknown.ok);
    assert_eq!(unknown.code, audit::code::INSTALLATION_UNKNOWN);
    let malformed = read_secret(&database, &store, &host, "not-a-uuid", &secret.id);
    assert!(!malformed.ok);
    assert_eq!(malformed.code, audit::code::INSTALLATION_UNKNOWN);

    let installation = installation(&database);
    revoke_installation(&database, &installation.id).unwrap();
    let revoked = read_secret(&database, &store, &host, &installation.id, &secret.id);
    assert!(!revoked.ok);
    assert_eq!(revoked.code, audit::code::INSTALLATION_REVOKED);
    // Revoking also dropped the grants, so re-enabling starts without authorization.
    assert!(list_grants(&database).unwrap().is_empty());
    assert!(host.asked().is_empty(), "a revoked installation must not open a confirmation");
}

#[cfg(unix)]
#[test]
fn revoking_an_installation_stops_controlled_use() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "撤销口令", CANARY);
    let executor = register(&database, "env 读取", "/usr/bin/env", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    revoke_installation(&database, &installation.id).unwrap();
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::INSTALLATION_REVOKED);
}

#[test]
fn an_audit_row_keeps_only_opaque_identifiers() {
    let database = db();
    let known = uuid::Uuid::new_v4().to_string();
    record(
        &database,
        audit::Event {
            operation: audit::Operation::Use,
            decision: audit::Decision::Denied,
            code: audit::code::GRANT_MISSING,
            secret_id: Some("生产口令"),
            installation_id: Some(&known),
            executor_id: Some("/Users/me/deploy.sh --token abc"),
        },
    );
    let rows = audit::list(&database, 10).unwrap();
    assert_eq!(rows.len(), 1);
    // A caller-supplied string is not an identifier unless it parses as one.
    assert_eq!(rows[0].secret_id, None);
    assert_eq!(rows[0].installation_id.as_deref(), Some(known.as_str()));
    assert_eq!(rows[0].executor_id, None);
    assert!(!format!("{rows:?}").contains("deploy.sh"));
}

#[test]
fn a_reference_from_list_runs_the_granted_action_without_a_raw_read() {
    let db = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&db, &store, "测试口令", CANARY);
    let installation = installation(&db);
    let executor = register(&db, "测试传递", "node", &["-e", "process.stdout.write(require('fs').readFileSync(0).length ? 'OK' : 'EMPTY')"], Channel::Stdin, None);
    grant(&db, &installation.id, &secret.id, &executor.id).unwrap();
    let listed = list(&db, &store, &installation.id);
    assert!(!body(&listed).contains(CANARY));
    let data = listed.data.unwrap();
    let token = data["secrets"][0]["reference"].as_str().unwrap();
    assert_eq!(token, secret.reference);
    let invocation = crate::secrets::cli::parse(&[
        "--installation".into(), installation.id.clone(), "use".into(), "--secret".into(), token.into(),
        "--executor".into(), executor.id.clone(),
    ]).unwrap();
    let used = use_request(&db, &store, &installation.id, invocation.secret_id.as_ref().unwrap(), &executor.id);
    assert!(!body(&used).contains(CANARY));
    assert_eq!(used.data.unwrap()["stdout"], "OK");
    let rows = audit::list(&db, 100).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].operation.as_str(), rows[0].code.as_str()), ("use", "ok"));
}

#[test]
fn recent_access_is_pruned_on_open_write_and_read() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("audit.db");
    let now = crate::prompts::timestamp() as i64;
    let database = Database::open(&path).unwrap();
    database.with_connection(|conn| {
        for _ in 0..105 {
            conn.execute("INSERT INTO secret_audit(at,operation,decision,result_code) VALUES(?1,'read','allowed','ok')", [now]).unwrap();
        }
        conn.execute("INSERT INTO secret_audit(at,operation,decision,result_code) VALUES(?1,'approve','allowed','ok')", [now]).unwrap();
        conn.execute("INSERT INTO secret_audit(at,operation,decision,result_code) VALUES(?1,'decline','denied','declined')", [now]).unwrap();
        Ok(())
    }).unwrap();
    drop(database);
    let database = Database::open(&path).unwrap();
    let stored = || database.with_connection(|conn| conn.query_row("SELECT count(*) FROM secret_audit", [], |r| r.get::<_, u32>(0)).map_err(sql)).unwrap();
    assert_eq!(stored(), 100);
    let result = audit::list(&database, 500).unwrap();
    assert_eq!((result[0].id, result.last().unwrap().id), (105, 6));
    record(&database, audit::Event { operation: audit::Operation::Use, decision: audit::Decision::Allowed, code: audit::code::OK,
        installation_id: None, secret_id: None, executor_id: None });
    assert_eq!(stored(), 100);
    database.with_connection(|conn| {
        conn.execute("UPDATE secret_audit SET at=?1 WHERE operation='read'", [now - 31 * 86400]).unwrap();
        Ok(())
    }).unwrap();
    assert_eq!(audit::list(&database, 100).unwrap().len(), 1);
    assert_eq!(stored(), 1);
}

#[test]
fn installation_rechecks_preserve_the_denial_code_without_logging_a_second_access() {
    let db = db();
    let connection = installation(&db);
    revoke_installation(&db, &connection.id).unwrap();
    assert_eq!(live_installation(&db, &connection.id).unwrap_err().0, audit::code::INSTALLATION_REVOKED);
    assert_eq!(live_installation(&db, &uuid::Uuid::new_v4().to_string()).unwrap_err().0, audit::code::INSTALLATION_UNKNOWN);
    assert!(audit::list(&db, 100).unwrap().is_empty());
}

#[test]
fn a_recreated_alias_never_restores_the_old_grant() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "同名口令", CANARY);
    let executor = register(&database, "env 读取", "node", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    crate::secrets::delete(&database, &store, &secret.id, secret.version).unwrap();
    let recreated = create_secret(&database, &store, "同名口令", CANARY);
    assert_ne!(recreated.id, secret.id);
    assert!(list_grants(&database).unwrap().is_empty());
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::GRANT_MISSING);
    // The new id has no grant either, so the alias alone never authorizes.
    let response = use_request(&database, &store, &installation.id, &recreated.id, &executor.id);
    assert_eq!(response.code, audit::code::GRANT_MISSING);
}

#[test]
fn a_missing_credential_fails_without_running_anything() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "缺少原值", CANARY);
    let executor = register(&database, "env 读取", "node", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &secret.id, &executor.id).unwrap();
    let credential = crate::secrets::reference::credential_id(&secret.id).unwrap();
    store.delete(&credential).unwrap();
    let response = use_request(&database, &store, &installation.id, &secret.id, &executor.id);
    assert!(!response.ok);
    assert_eq!(response.code, audit::code::CREDENTIAL_MISSING);
    assert!(response.data.is_none());
    assert!(!body(&response).contains(CANARY));
}

#[cfg(unix)]
#[test]
fn list_only_shows_granted_secrets_and_their_executors() {
    let database = db();
    let store = MemoryCredentials::default();
    let granted = create_secret(&database, &store, "已绑定", CANARY);
    create_secret(&database, &store, "未绑定", OTHER);
    let executor = register(&database, "env 读取", "/usr/bin/env", &[], Channel::Env, Some("CLIORATEST"));
    let installation = installation(&database);
    grant(&database, &installation.id, &granted.id, &executor.id).unwrap();
    let response = list(&database, &store, &installation.id);
    assert!(response.ok, "{}", response.message);
    let data = response.data.unwrap();
    let secrets = data["secrets"].as_array().unwrap();
    assert_eq!(secrets.len(), 1);
    assert_eq!(secrets[0]["alias"], "已绑定");
    assert_eq!(secrets[0]["status"], "available");
    assert_eq!(secrets[0]["executors"][0]["digestOk"], true);
    let text = data.to_string();
    assert!(!text.contains(CANARY));
    assert!(!text.contains(OTHER));
    assert!(!text.contains("未绑定"));
}

#[test]
fn grant_and_executor_validation_rejects_widening_attempts() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "范围口令", CANARY);
    let installation = installation(&database);
    register(&database, "重复标签", "node", &[], Channel::Env, Some("CLIORATEST"));
    // A duplicate label must not replace the registered definition: grants point at
    // the stored digest, so an overwrite would widen what a grant allows.
    let duplicate = executor::register(
        &database,
        NewExecutor {
            label: "重复标签".into(),
            description: String::new(),
            executable: "node".into(),
            args: vec![],
            cwd: None,
            channel: Channel::Stdin,
            env_name: None,
        },
    );
    assert!(duplicate.is_err());
    // A path with separators must be absolute.
    let relative = executor::register(
        &database,
        NewExecutor {
            label: "相对路径".into(),
            description: String::new(),
            executable: "bin/env".into(),
            args: vec![],
            cwd: None,
            channel: Channel::Env,
            env_name: Some("CLIORATEST".into()),
        },
    );
    assert!(relative.is_err());
    // An environment name is required for the env channel and forbidden otherwise.
    let nameless = executor::register(
        &database,
        NewExecutor {
            label: "缺少变量名".into(),
            description: String::new(),
            executable: "node".into(),
            args: vec![],
            cwd: None,
            channel: Channel::Env,
            env_name: None,
        },
    );
    assert!(nameless.is_err());
    // Granting unknown identifiers stores nothing.
    let unknown_secret = grant(
        &database,
        &installation.id,
        &uuid::Uuid::new_v4().to_string(),
        &uuid::Uuid::new_v4().to_string(),
    );
    assert!(unknown_secret.is_err());
    assert!(list_grants(&database).unwrap().is_empty());
    assert!(!secret.id.is_empty());
}

#[test]
fn status_reports_the_local_transport() {
    let status = status();
    assert!(!status.transport.is_empty());
    // The broker is not started in unit tests, so it reports itself as unavailable
    // instead of pretending to accept requests.
    assert!(!status.running || ipc::start_status().is_ok());
}

#[test]
fn a_local_cli_can_be_restored_without_grants_or_deleted_with_its_audit_intact() {
    let database = db();
    let store = MemoryCredentials::default();
    let secret = create_secret(&database, &store, "部署", CANARY);
    let executor = register(&database, "部署脚本", "env", &[], Channel::Env, Some("CLIORATEST"));
    let cli = create_installation(&database, "local-cli", Kind::Cli, None).unwrap();
    grant(&database, &cli.id, &secret.id, &executor.id).unwrap();
    assert!(delete_cli_installation(&database, &cli.id).is_err());
    revoke_installation(&database, &cli.id).unwrap();
    assert!(!list(&database, &store, &cli.id).ok);
    assert!(grant(&database, &cli.id, &secret.id, &executor.id).is_err());
    restore_cli_installation(&database, &cli.id).unwrap();
    let restored = load_installation(&database, &cli.id).unwrap().unwrap();
    assert!(!restored.revoked);
    assert!(restored.revoked_at.is_none());
    assert!(list(&database, &store, &cli.id).ok);
    assert_eq!(use_request(&database, &store, &cli.id, &secret.id, &executor.id).code, audit::code::GRANT_MISSING);
    revoke_installation(&database, &cli.id).unwrap();
    let audit_before = audit::list(&database, 20).unwrap();
    assert!(audit_before.iter().any(|entry| entry.installation_id.as_ref() == Some(&cli.id)));
    delete_cli_installation(&database, &cli.id).unwrap();
    assert!(load_installation(&database, &cli.id).unwrap().is_none());
    assert_eq!(audit::list(&database, 20).unwrap().len(), audit_before.len());
    assert!(restore_cli_installation(&database, &cli.id).is_err());
    assert!(!list(&database, &store, &cli.id).ok);
    assert!(crate::secrets::store::exists(&database, &secret.id).unwrap());
}

#[test]
fn local_cli_recovery_and_deletion_leave_managed_connections_alone() {
    let database = db();
    for (kind, target) in [(Kind::Mcp, None), (Kind::Mcp, Some("fixture")), (Kind::Cli, Some("fixture"))] {
        let item = create_installation(&database, "fixture", kind, target).unwrap();
        revoke_installation(&database, &item.id).unwrap();
        assert!(restore_cli_installation(&database, &item.id).is_err());
        assert!(delete_cli_installation(&database, &item.id).is_err());
        assert!(load_installation(&database, &item.id).unwrap().unwrap().revoked);
    }
}
