use super::*;
use std::io::Write as _;
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;

#[derive(Default)]
struct MemoryCredentials(Mutex<BTreeMap<String, String>>);
impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing secret".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

#[derive(Default)]
struct ServerState {
    files: BTreeMap<String, (Vec<u8>, u32)>,
    fail_manifest_write: bool,
    fail_space_write: bool,
    fail_space_finalization: bool,
    fail_auth: bool,
}

struct Server {
    endpoint: String,
    state: Arc<Mutex<ServerState>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://127.0.0.1:{}/dav/",
            listener.local_addr().unwrap().port()
        );
        let state = Arc::new(Mutex::new(ServerState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let state_copy = state.clone();
        let stop_copy = stop.clone();
        let thread = thread::spawn(move || {
            while !stop_copy.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = state_copy.clone();
                        thread::spawn(move || serve(stream, &state));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            endpoint,
            state,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

fn serve(mut stream: TcpStream, shared: &Arc<Mutex<ServerState>>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let count = match stream.read(&mut chunk) {
            Ok(count) if count > 0 => count,
            _ => return,
        };
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > 64_000 {
            return;
        }
    };
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = header.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length = headers
        .get("content-length")
        .and_then(|text| text.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = bytes[header_end..].to_vec();
    while body.len() < length {
        let count = match stream.read(&mut chunk) {
            Ok(count) if count > 0 => count,
            _ => return,
        };
        body.extend_from_slice(&chunk[..count]);
    }
    let mut state = shared.lock().unwrap();
    let (status, response, etag) = if state.fail_auth {
        (401, Vec::new(), None)
    } else if method == "MKCOL" {
        (201, Vec::new(), None)
    } else if method == "PROPFIND" {
        (207, b"<multistatus/>".to_vec(), None)
    } else if method == "GET" {
        state
            .files
            .get(path)
            .map(|(bytes, version)| (200, bytes.clone(), Some(format!("\"{version}\""))))
            .unwrap_or((404, Vec::new(), None))
    } else if method == "PUT" {
        if state.fail_manifest_write && path.ends_with("manifest.cliora")
            || state.fail_space_write
                && path.ends_with("space.cliora")
                && headers.contains_key("if-match")
            || state.fail_space_finalization
                && path.ends_with("space.cliora")
                && headers.contains_key("if-match")
                && serde_json::from_slice::<serde_json::Value>(&body)
                    .ok()
                    .is_some_and(|space| space["previous"].as_array().is_some_and(Vec::is_empty))
        {
            (503, Vec::new(), None)
        } else {
            let existing = state.files.get(path).map(|(_, version)| *version);
            let if_match = headers.get("if-match");
            let if_none = headers.get("if-none-match");
            if if_none.is_some_and(|value| value == "*") && existing.is_some()
                || if_match.is_some_and(|value| {
                    existing.map(|version| format!("\"{version}\"")).as_ref() != Some(value)
                })
            {
                (412, Vec::new(), None)
            } else {
                let version = existing.unwrap_or(0) + 1;
                state
                    .files
                    .insert(path.into(), (body[..length].to_vec(), version));
                (201, Vec::new(), Some(format!("\"{version}\"")))
            }
        }
    } else if method == "DELETE" {
        let existing = state.files.get(path).map(|(_, version)| *version);
        if existing.is_none() {
            (404, Vec::new(), None)
        } else if headers.get("if-match")
            != existing.map(|version| format!("\"{version}\"")).as_ref()
        {
            (412, Vec::new(), None)
        } else {
            state.files.remove(path);
            (204, Vec::new(), None)
        }
    } else {
        (405, Vec::new(), None)
    };
    drop(state);
    let text = format!(
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n",
        response.len(),
        etag.map(|value| format!("ETag: {value}\r\n"))
            .unwrap_or_default()
    );
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.write_all(&response);
}

fn database(path: &std::path::Path) -> Database {
    std::fs::create_dir_all(path).unwrap();
    Database::open(&path.join("cliora.db")).unwrap()
}
fn put_library(db: &Database, body: &str) {
    db.with_connection(|conn| {
        conn.execute("INSERT INTO library_items (id,kind,title,body,category,project_id,version,updated_at) VALUES ('library-1','prompt','Example',?1,'',NULL,1,1)
            ON CONFLICT(id) DO UPDATE SET body=excluded.body,version=version+1,updated_at=updated_at+1",[body]).unwrap();
        Ok(())
    }).unwrap();
}
fn body(db: &Database) -> Option<String> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT body FROM library_items WHERE id='library-1'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
    .unwrap()
}
fn setup(server: &Server) -> SyncSetup {
    SyncSetup {
        endpoint: server.endpoint.clone(),
        username: "user".into(),
        auth_password: "secret-passphrase".into(),
        encryption_password: String::new(),
        previous_encryption_password: String::new(),
        enabled: true,
    }
}

static SYNC_TESTS: Mutex<()> = Mutex::new(());

#[test]
fn fresh_device_receives_non_default_preferences_and_common_changes_without_sync_churn() {
    use crate::native::profile::{self, RegisteredCommon, RegisteredProfile};
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    a.update_preferences(|value| { value.theme = crate::domain::Theme::Dark; value.set_managed(&[crate::domain::CliId::Pi]); }).unwrap();
    let common = profile::save_registered_common(&a, &registry, RegisteredCommon {
        tool: "codex".into(), version: 0, revision: String::new(), files: BTreeMap::from([("settings".into(), "model = \"first\"".into())]),
    }, None).unwrap();
    let named = profile::save_registered_profile(&a, &registry, RegisteredProfile {
        id: String::new(), tool: "codex".into(), name: "Work".into(), version: 0, revision: String::new(),
        inherit_common: true, files: BTreeMap::new(), suppressed: BTreeMap::new(), connection: None, native_credentials: BTreeMap::new(),
    }, None).unwrap();
    configure(&a, &credentials, setup(&server)).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    configure(&b, &credentials, setup(&server)).unwrap();
    let received = run(&b, &credentials, &registry, false).unwrap();
    assert!(received.conflicts.is_empty());
    assert!(received.last_success.is_some());
    assert_eq!(b.preferences().unwrap().theme, crate::domain::Theme::Dark);
    assert_eq!(b.preferences().unwrap().managed_tools, vec![crate::domain::CliId::Pi]);
    let stale_common = profile::get_registered_common(&b, "codex").unwrap().unwrap();
    b.with_connection(|conn| {
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex',?1,1,'{}')", [&named.id]).unwrap();
        Ok(())
    }).unwrap();
    let mut updated = common.clone();
    updated.files.insert("settings".into(), "model = \"second\"".into());
    profile::save_registered_common(&a, &registry, updated, Some(common.version)).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    run(&b, &credentials, &registry, false).unwrap();
    assert_eq!(crate::native::apply::get_registered_binding(&b, "codex", "global").unwrap().unwrap().profile_version, 0);
    assert!(profile::save_registered_common(&b, &registry, stale_common.clone(), Some(stale_common.version)).is_err());
    let remote_before = server.state.lock().unwrap().files["/dav/manifest.cliora"].clone();
    run(&b, &credentials, &registry, false).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    assert_eq!(server.state.lock().unwrap().files["/dav/manifest.cliora"], remote_before);
    a.with_connection(|conn| { conn.execute("DELETE FROM common_configs WHERE tool='codex'", []).unwrap(); Ok(()) }).unwrap();
    b.with_connection(|conn| { conn.execute("UPDATE applied_bindings SET profile_version=1", []).unwrap(); Ok(()) }).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    assert!(run(&b, &credentials, &registry, false).unwrap().conflicts.is_empty());
    assert!(profile::get_registered_common(&b, "codex").unwrap().is_none());
    assert_eq!(crate::native::apply::get_registered_binding(&b, "codex", "global").unwrap().unwrap().profile_version, 0);
    assert!(profile::save_registered_common(&b, &registry, stale_common.clone(), Some(stale_common.version)).is_err());
}

#[test]
fn sync_only_acknowledges_the_change_it_observed() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    put_library(&db, "first");
    let observed = outbox_tokens(&db).unwrap();
    put_library(&db, "second");
    let newer = outbox_tokens(&db).unwrap();
    assert_ne!(observed, newer);
    let key = BTreeSet::from(["library:library-1".to_owned()]);
    clear_outbox(&db, &key, &observed).unwrap();
    assert_eq!(status(&db).unwrap().pending_changes, 1);
    clear_outbox(&db, &key, &newer).unwrap();
    assert_eq!(status(&db).unwrap().pending_changes, 0);
}

#[test]
fn offline_device_receives_multiple_consecutive_remote_versions() {
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&a, "v1");
    configure(&a, &credentials, setup(&server)).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    configure(&b, &credentials, setup(&server)).unwrap();
    run(&b, &credentials, &registry, false).unwrap();
    assert_eq!(body(&b).as_deref(), Some("v1"));
    put_library(&a, "v2");
    run(&a, &credentials, &registry, false).unwrap();
    put_library(&a, "v3");
    run(&a, &credentials, &registry, false).unwrap();
    let status = run(&b, &credentials, &registry, false).unwrap();
    assert!(status.conflicts.is_empty());
    assert_eq!(body(&b).as_deref(), Some("v3"));
}

#[test]
fn connection_password_rotation_rewraps_space_for_a_fresh_device() {
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&a, "before-rotation");
    configure(&a, &credentials, setup(&server)).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    let mut rotated = setup(&server);
    rotated.auth_password = "new-connection-password".into();
    configure(&a, &credentials, rotated.clone()).unwrap();
    let bytes = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    assert!(crypto::open_sync_space("secret-passphrase", &bytes).is_err());
    assert!(crypto::open_sync_space("new-connection-password", &bytes).is_ok());
    configure(&b, &credentials, rotated.clone()).unwrap();
    run(&b, &credentials, &registry, false).unwrap();
    assert_eq!(body(&b).as_deref(), Some("before-rotation"));
    server.state.lock().unwrap().fail_space_write = true;
    let before_failed_rotation = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    let mut failed = rotated.clone();
    failed.auth_password = "another-connection-password".into();
    assert!(configure(&a, &credentials, failed.clone()).is_err());
    assert_eq!(
        server.state.lock().unwrap().files["/dav/space.cliora"].0,
        before_failed_rotation
    );
    server.state.lock().unwrap().fail_space_write = false;
    server.state.lock().unwrap().fail_auth = true;
    assert!(configure(&a, &credentials, failed).is_err());
    assert_eq!(
        read_config(&a).unwrap().unwrap().space_id,
        read_config(&b).unwrap().unwrap().space_id
    );
    server.state.lock().unwrap().fail_auth = false;
    assert!(run(&a, &credentials, &registry, false).is_ok());
}

#[test]
fn interrupted_password_rotation_keeps_the_old_device_usable() {
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&db, "saved");
    configure(&db, &credentials, setup(&server)).unwrap();
    run(&db, &credentials, &registry, false).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch("CREATE TABLE rotation_commit_parent (id INTEGER PRIMARY KEY);
            CREATE TABLE rotation_commit_guard (parent_id INTEGER REFERENCES rotation_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER block_rotation AFTER UPDATE ON sync_config BEGIN INSERT INTO rotation_commit_guard VALUES (1); END;")
            .map_err(|error| error.to_string())
    }).unwrap();
    let mut changed = setup(&server);
    changed.auth_password = "rotated-password-123".into();
    let before = read_config(&db).unwrap().unwrap();
    let secrets_before = credentials.0.lock().unwrap().clone();
    assert!(configure(&db, &credentials, changed.clone())
        .unwrap_err()
        .contains("FOREIGN KEY constraint failed"));
    let after = read_config(&db).unwrap().unwrap();
    assert_eq!(after.auth_secret_id, before.auth_secret_id);
    assert_eq!(after.space_secret_id, before.space_secret_id);
    assert_eq!(*credentials.0.lock().unwrap(), secrets_before);
    db.with_connection(|conn| {
        let count: i64 = conn
            .query_row("SELECT count(*) FROM rotation_commit_guard", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
    let staged = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    assert!(crypto::open_sync_space("secret-passphrase", &staged).is_ok());
    assert!(crypto::open_sync_space("rotated-password-123", &staged).is_ok());
    db.with_connection(|conn| {
        conn.execute_batch("DROP TRIGGER block_rotation;")
            .map_err(|error| error.to_string())
    })
    .unwrap();
    assert!(run(&db, &credentials, &registry, false).is_ok());
    configure(&db, &credentials, changed).unwrap();
    let final_bytes = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    assert!(crypto::open_sync_space("secret-passphrase", &final_bytes).is_err());
    assert!(crypto::open_sync_space("rotated-password-123", &final_bytes).is_ok());
}

#[test]
fn rotation_finalize_failure_keeps_current_credentials_and_allows_safe_retry() {
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&db, "preserved");
    configure(&db, &credentials, setup(&server)).unwrap();
    run(&db, &credentials, &registry, false).unwrap();
    server.state.lock().unwrap().fail_space_finalization = true;
    let mut changed = setup(&server);
    changed.auth_password = "rotated-password-123".into();
    let failure = configure(&db, &credentials, changed.clone()).unwrap_err();
    assert!(failure.starts_with("口令轮换待完成"), "{failure}");
    assert_eq!(
        status(&db).unwrap().last_error.as_deref(),
        Some(failure.as_str())
    );
    let current = read_config(&db).unwrap().unwrap();
    assert_eq!(
        credentials.get(&current.space_secret_id).unwrap(),
        changed.auth_password
    );
    assert_eq!(credentials.0.lock().unwrap().len(), 2);
    let staged = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    assert!(crypto::open_sync_space("secret-passphrase", &staged).is_ok());
    assert!(crypto::open_sync_space("rotated-password-123", &staged).is_ok());
    let synced = run(&db, &credentials, &registry, false).unwrap();
    assert_eq!(synced.last_error.as_deref(), Some(failure.as_str()));
    assert_eq!(body(&db).as_deref(), Some("preserved"));
    assert_eq!(
        status(&db).unwrap().last_error.as_deref(),
        Some(failure.as_str())
    );
    server.state.lock().unwrap().fail_space_finalization = false;
    // Retrying with the old wrapper must not strip the only wrapper this device can use.
    configure(&db, &credentials, setup(&server)).unwrap();
    assert!(status(&db).unwrap().last_error.is_none());
    let recovered = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    assert!(crypto::open_sync_space("secret-passphrase", &recovered).is_ok());
    assert!(crypto::open_sync_space("rotated-password-123", &recovered).is_err());
    configure(&db, &credentials, changed).unwrap();
    assert!(run(&db, &credentials, &registry, false).is_ok());
    assert_eq!(body(&db).as_deref(), Some("preserved"));
}

#[test]
fn inbound_snapshot_cannot_replace_an_edit_made_while_remote_was_read() {
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&db, "before-network-read");
    let mut remote = collect_snapshot(&db, &credentials, &registry)
        .unwrap()
        .entities
        .into_iter()
        .find(|entity| entity.key() == "library:library-1")
        .unwrap();
    let expected = remote.digest().unwrap();
    let PortablePayload::Library(item) = &mut remote.payload else {
        panic!("library expected")
    };
    item.body = "remote".into();
    put_library(&db, "edited-during-network-read");
    assert!(apply_entity(
        &db,
        &credentials,
        &registry,
        "library:library-1",
        Some(remote),
        &expected
    )
    .unwrap_err()
    .contains("本机资料已变化"));
    assert_eq!(body(&db).as_deref(), Some("edited-during-network-read"));
}

#[test]
fn two_devices_merge_independent_changes_preserve_conflicts_and_fail_closed() {
    let _serial = SYNC_TESTS.lock().unwrap();
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let store = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&a, "original");
    assert_eq!(status(&a).unwrap().pending_changes, 1);
    configure(&a, &store, setup(&server)).unwrap();
    assert!(run(&a, &store, &registry, false).unwrap().uploaded >= 1);
    assert_eq!(status(&a).unwrap().pending_changes, 0);
    configure(&b, &store, setup(&server)).unwrap();
    assert!(run(&b, &store, &registry, false).unwrap().downloaded >= 1);
    assert_eq!(body(&b).as_deref(), Some("original"));
    b.with_connection(|conn| { conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('project-2','Second',NULL,NULL,0)",[]).unwrap(); Ok(()) }).unwrap();
    run(&b, &store, &registry, false).unwrap();
    run(&a, &store, &registry, false).unwrap();
    let projects: i64 = a
        .with_connection(|conn| {
            conn.query_row(
                "SELECT count(*) FROM projects WHERE id='project-2'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(projects, 1);

    put_library(&a, "from-a");
    put_library(&b, "from-b");
    run(&a, &store, &registry, false).unwrap();
    let conflicts = run(&b, &store, &registry, false).unwrap().conflicts;
    assert!(conflicts
        .iter()
        .any(|item| item.key == "library:library-1" && item.remote_versions == 2));
    assert_eq!(body(&b).as_deref(), Some("from-b"));
    resolve(&b, &store, &registry, "library:library-1", None).unwrap();
    run(&a, &store, &registry, false).unwrap();
    assert_eq!(body(&a).as_deref(), Some("from-b"));

    a.with_connection(|conn| {
        conn.execute("DELETE FROM library_items WHERE id='library-1'", [])
            .unwrap();
        Ok(())
    })
    .unwrap();
    put_library(&b, "changed-while-deleted");
    run(&a, &store, &registry, false).unwrap();
    let deletion_conflicts = run(&b, &store, &registry, false).unwrap().conflicts;
    assert!(deletion_conflicts
        .iter()
        .any(|item| item.key == "library:library-1" && item.remote_deleted));
    assert_eq!(body(&b).as_deref(), Some("changed-while-deleted"));
    resolve(&b, &store, &registry, "library:library-1", None).unwrap();
    run(&a, &store, &registry, false).unwrap();
    assert_eq!(body(&a).as_deref(), Some("changed-while-deleted"));

    server.state.lock().unwrap().fail_manifest_write = true;
    put_library(&a, "offline-change");
    assert!(run(&a, &store, &registry, false).is_err());
    assert_eq!(body(&a).as_deref(), Some("offline-change"));
    assert_eq!(status(&a).unwrap().pending_changes, 1);
    server.state.lock().unwrap().fail_manifest_write = false;
    run(&a, &store, &registry, false).unwrap();
    assert_eq!(status(&a).unwrap().pending_changes, 0);

    let before = read_config(&a).unwrap().unwrap();
    server.state.lock().unwrap().fail_auth = true;
    let mut rotated = setup(&server);
    rotated.auth_password = "rotated-secret-2026".into();
    assert!(configure(&a, &store, rotated).is_err());
    let after = read_config(&a).unwrap().unwrap();
    assert_eq!(after.auth_secret_id, before.auth_secret_id);
    assert_eq!(
        store.get(&before.auth_secret_id).unwrap(),
        "secret-passphrase"
    );
    assert_eq!(body(&a).as_deref(), Some("offline-change"));
    server.state.lock().unwrap().fail_auth = false;

    let c = database(&temp.path().join("c"));
    let mut bad_password = setup(&server);
    bad_password.auth_password = "new-account-password".into();
    assert!(configure(&c, &store, bad_password.clone()).is_err());
    assert!(!status(&c).unwrap().configured);
    bad_password.encryption_password = "secret-passphrase".into();
    configure(&c, &store, bad_password).unwrap();
    run(&c, &store, &registry, false).unwrap();
    assert_eq!(body(&c).as_deref(), Some("offline-change"));

    let config = read_config(&a).unwrap().unwrap();
    let space_bytes = server.state.lock().unwrap().files["/dav/space.cliora"]
        .0
        .clone();
    let (_, key) = crypto::open_sync_space("secret-passphrase", &space_bytes).unwrap();
    let manifest_bytes = server.state.lock().unwrap().files["/dav/manifest.cliora"]
        .0
        .clone();
    let manifest: Manifest = serde_json::from_slice(
        &crypto::open_sync(&key, &config.space_id, &manifest_bytes).unwrap(),
    )
    .unwrap();
    let project_head = &manifest.heads["project:project-2"][0];
    let d = database(&temp.path().join("d"));
    let mut setup_d = setup(&server);
    setup_d.encryption_password = "secret-passphrase".into();
    configure(&d, &store, setup_d).unwrap();
    server
        .state
        .lock()
        .unwrap()
        .files
        .remove(&format!("/dav/versions/{}.cliora", project_head.id));
    assert!(run(&d, &store, &registry, false)
        .unwrap_err()
        .contains("远端版本文件缺失"));
    assert!(body(&d).is_none());
    let truncated = Manifest {
        schema_version: 1,
        space_id: config.space_id.clone(),
        heads: BTreeMap::new(),
        history: BTreeMap::new(),
    };
    let bytes = crypto::seal_sync(
        &key,
        &config.space_id,
        &serde_json::to_vec(&truncated).unwrap(),
    )
    .unwrap();
    let mut remote = server.state.lock().unwrap();
    let manifest = remote.files.get_mut("/dav/manifest.cliora").unwrap();
    manifest.0 = bytes;
    manifest.1 += 1;
    drop(remote);
    assert!(run(&a, &store, &registry, false)
        .unwrap_err()
        .contains("缺少已知版本"));
    assert_eq!(body(&a).as_deref(), Some("offline-change"));
    let old_secret = read_config(&c).unwrap().unwrap().space_secret_id;
    server
        .state
        .lock()
        .unwrap()
        .files
        .remove("/dav/space.cliora");
    assert!(configure(&c, &store, setup(&server))
        .unwrap_err()
        .contains("空间密钥文件缺失"));
    assert_eq!(
        read_config(&c).unwrap().unwrap().space_secret_id,
        old_secret
    );
}

#[test]
fn merge_keeps_concurrent_heads_and_replaces_only_known_parent() {
    let first = Version {
        id: Uuid::new_v4().to_string(),
        parents: vec![],
        digest: "a".repeat(64),
        deleted: false,
    };
    let other = Version {
        id: Uuid::new_v4().to_string(),
        parents: vec![],
        digest: "b".repeat(64),
        deleted: false,
    };
    let next = Version {
        id: Uuid::new_v4().to_string(),
        parents: vec![first.id.clone()],
        digest: "c".repeat(64),
        deleted: false,
    };
    let mut heads = vec![first, other.clone()];
    merge_head(&mut heads, next).unwrap();
    assert_eq!(heads.len(), 2);
    assert!(heads.iter().any(|head| head.id == other.id));
}

#[test]
fn sync_space_and_object_authentication_reject_wrong_password_and_tampering() {
    let (space_id, key, space_bytes) = crypto::make_sync_space("correct-password").unwrap();
    assert!(crypto::open_sync_space("wrong-password", &space_bytes).is_err());
    assert_eq!(
        crypto::open_sync_space("correct-password", &space_bytes)
            .unwrap()
            .1,
        key
    );
    let bytes = crypto::seal_sync(&key, &space_id, b"private profile key").unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("private profile key"));
    assert_eq!(
        crypto::open_sync(&key, &space_id, &bytes).unwrap(),
        b"private profile key"
    );
    let mut envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    envelope["spaceId"] = serde_json::json!(Uuid::new_v4().to_string());
    assert!(crypto::open_sync(&key, &space_id, &serde_json::to_vec(&envelope).unwrap()).is_err());
    let mut envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    envelope["wrappedKey"] = serde_json::json!("corrupted");
    assert!(crypto::open_sync(&key, &space_id, &serde_json::to_vec(&envelope).unwrap()).is_err());
}
