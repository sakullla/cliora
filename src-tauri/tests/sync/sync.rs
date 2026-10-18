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



#[test]
fn fresh_device_receives_non_default_preferences_and_common_changes_without_sync_churn() {
    use crate::native::profile::{self, RegisteredCommon, RegisteredProfile};
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    a.update_preferences(|value| { value.theme = crate::domain::Theme::Dark; value.set_managed(&[crate::domain::CliId::Pi]); }).unwrap();
    let common = profile::save_registered_common(&a, &registry, RegisteredCommon {
        tool: "codex".into(), version: 0, revision: String::new(), files: BTreeMap::from([("settings".into(), "model_reasoning_effort = \"low\"".into())]),
    }, None).unwrap();
    let named = profile::save_registered_profile(&a, &registry, RegisteredProfile { editing: None, authentication: crate::native::profile::ProfileAuthentication::Native,
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
    // Active bindings are portable. Publish this one before checking that a later
    // profile_version invalidation does not upload another manifest revision.
    run(&b, &credentials, &registry, false).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    let mut updated = common.clone();
    updated.files.insert("settings".into(), "model_reasoning_effort = \"high\"".into());
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
    let lock = fixture_sync_lock(&db).unwrap();
    let guard = lock.lock().unwrap();
    assert!(run(&db, &MemoryCredentials::default(), &Registry::builtins(), false).unwrap_err().contains("同步正在进行"));
    let other = database(&temp.path().join("independent-device"));
    assert!(!run(&other, &MemoryCredentials::default(), &Registry::builtins(), false).unwrap_err().contains("同步正在进行"));
    drop(guard);
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

#[test]
fn versioned_editing_intents_survive_webdav_roundtrip_without_native_application() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("editing-a"));
    let b = database(&temp.path().join("editing-b"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    // Transport must preserve versioned metadata even while a receiving adapter
    // has no editor installed. Applying that profile is a separate capability check.
    let source: crate::native::profile::RegisteredProfile = serde_json::from_value(serde_json::json!({
        "id":"editing-profile", "tool":"codex", "name":"Editing transport", "version":1,
        "revision":"source", "inheritCommon":false, "files":{"settings":"model = \"manual\""},
        "connection":null, "nativeCredentials":{},
        "editing":{"version":1,"selectedProvider":null,"intents":[{"version":1,"target":{"configuration":true},"operation":"reset","field":"model_reasoning_effort","value":null}]}
    })).unwrap();
    a.with_connection(|conn| {
        conn.execute("INSERT INTO native_profiles(id,tool,version,data) VALUES (?1,?2,?3,?4)", rusqlite::params![source.id, source.tool, source.version as i64, serde_json::to_string(&source).unwrap()]).unwrap();
        Ok(())
    }).unwrap();
    configure(&a, &credentials, setup(&server)).unwrap();
    run(&a, &credentials, &registry, false).unwrap();
    configure(&b, &credentials, setup(&server)).unwrap();
    run(&b, &credentials, &registry, false).unwrap();
    let incoming = crate::native::profile::get_registered_profile(&b, &source.id).unwrap();
    assert_eq!(incoming.editing, source.editing);
    assert_eq!(crate::native::format::parse(crate::native::format::FileKind::Toml, &incoming.files["settings"]).unwrap(), crate::native::format::parse(crate::native::format::FileKind::Toml, &source.files["settings"]).unwrap());
    assert!(crate::native::apply::get_registered_binding(&b, &source.tool, "global").unwrap().is_none());
    let before = server.state.lock().unwrap().files["/dav/manifest.cliora"].clone();
    run(&b, &credentials, &registry, false).unwrap();
    assert_eq!(server.state.lock().unwrap().files["/dav/manifest.cliora"], before);
}

#[test]
fn model_token_limits_and_editing_values_survive_webdav_semantic_scrubbing() {
    let server=Server::new();
    let temp=tempfile::tempdir().unwrap();
    let a=database(&temp.path().join("model-limit-a"));
    let b=database(&temp.path().join("model-limit-b"));
    let credentials=MemoryCredentials::default();
    let registry=Registry::builtins();
    let model=serde_json::json!({"id":"a","contextWindow":100,"maxTokens":32,"unknown":true,"cachePath":"/device/only","customAuthToken":"must-not-sync"});
    let source:crate::native::profile::RegisteredProfile=serde_json::from_value(serde_json::json!({
        "id":"model-limit-profile","tool":"pi","name":"Model limits","version":1,"revision":"source","inheritCommon":false,
        "files":{"settings":serde_json::json!({"defaultProvider":"mine","defaultModel":"a"}).to_string(),"models":serde_json::json!({"providers":{"mine":{"models":[model.clone()]}}}).to_string()},
        "connection":null,"nativeCredentials":{},"editing":{"version":1,"selectedProvider":"mine","intents":[{"version":1,"target":{"provider":"mine","model":"a"},"operation":"create","field":null,"value":model}]}
    })).unwrap();
    a.with_connection(|conn|{conn.execute("INSERT INTO native_profiles(id,tool,version,data) VALUES(?1,?2,?3,?4)",rusqlite::params![source.id,source.tool,source.version as i64,serde_json::to_string(&source).unwrap()]).unwrap();Ok(())}).unwrap();
    configure(&a,&credentials,setup(&server)).unwrap();run(&a,&credentials,&registry,false).unwrap();
    configure(&b,&credentials,setup(&server)).unwrap();run(&b,&credentials,&registry,false).unwrap();
    let incoming=crate::native::profile::get_registered_profile(&b,&source.id).unwrap();
    let document:serde_json::Value=serde_json::from_str(&incoming.files["models"]).unwrap();
    assert_eq!(document["providers"]["mine"]["models"][0]["maxTokens"],32);
    assert_eq!(document["providers"]["mine"]["models"][0]["unknown"],true);
    assert_eq!(incoming.editing.as_ref().unwrap().intents[0].value.as_ref().unwrap()["maxTokens"],32);
    let transported=serde_json::to_string(&incoming).unwrap();
    assert!(!transported.contains("must-not-sync"));assert!(!transported.contains("/device/only"));
}

#[test]
fn empty_remote_uploads_and_connection_failure_keeps_local_data() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let store = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&db, "local-only");
    configure(&db, &store, setup(&server)).unwrap();
    let status = run(&db, &store, &registry, false).unwrap();
    assert!(status.uploaded >= 1);
    assert_eq!(body(&db).as_deref(), Some("local-only"));
    server.state.lock().unwrap().fail_auth = true;
    assert!(run(&db, &store, &registry, false).is_err());
    assert_eq!(body(&db).as_deref(), Some("local-only"));
}

#[test]
fn remote_delete_of_unchanged_items_applies_and_a_later_local_edit_waits() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let a = database(&temp.path().join("a"));
    let b = database(&temp.path().join("b"));
    let store = MemoryCredentials::default();
    let registry = Registry::builtins();
    let dir = temp.path().join("project-disk");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("keep.txt"), "disk-stays").unwrap();
    let profile = crate::native::profile::RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-del".into(),
        tool: "codex".into(),
        name: "Original".into(),
        version: 1,
        inherit_common: false,
        files: BTreeMap::new(),
        suppressed: BTreeMap::new(),
        connection: None,
        native_credentials: BTreeMap::new(),
    };
    a.with_connection(|conn| {
        conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-del','codex',1,?1)", [serde_json::to_string(&profile).unwrap()]).unwrap();
        conn.execute("INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES ('global','codex','profile-del',1,'{}')", []).unwrap();
        conn.execute("INSERT INTO projects (id,name,path,preferred_tool,last_opened) VALUES ('project-disk','Disk',?1,NULL,0)", [dir.to_str().unwrap()]).unwrap();
        Ok(())
    }).unwrap();
    put_library(&a, "stable");
    configure(&a, &store, setup(&server)).unwrap();
    run(&a, &store, &registry, false).unwrap();
    configure(&b, &store, setup(&server)).unwrap();
    run(&b, &store, &registry, false).unwrap();
    assert!(crate::native::profile::get_registered_profile(&b, "profile-del").is_ok());
    a.with_connection(|conn| {
        conn.execute("DELETE FROM applied_bindings WHERE profile_id='profile-del'", []).unwrap();
        conn.execute("DELETE FROM native_profiles WHERE id='profile-del'", []).unwrap();
        Ok(())
    }).unwrap();
    run(&a, &store, &registry, false).unwrap();
    let received = run(&b, &store, &registry, false).unwrap();
    assert!(received.conflicts.is_empty());
    assert!(crate::native::profile::get_registered_profile(&b, "profile-del").is_err());
    let bindings: i64 = b.with_connection(|conn| conn.query_row("SELECT count(*) FROM applied_bindings", [], |row| row.get(0)).map_err(|error| error.to_string())).unwrap();
    assert_eq!(bindings, 0);
    assert_eq!(body(&b).as_deref(), Some("stable"));
    assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "disk-stays");
    a.with_connection(|conn| {
        conn.execute("DELETE FROM projects WHERE id='project-disk'", []).unwrap();
        Ok(())
    }).unwrap();
    run(&a, &store, &registry, false).unwrap();
    assert!(run(&b, &store, &registry, false).unwrap().conflicts.is_empty());
    let projects: i64 = b.with_connection(|conn| conn.query_row("SELECT count(*) FROM projects WHERE id='project-disk'", [], |row| row.get(0)).map_err(|error| error.to_string())).unwrap();
    assert_eq!(projects, 0);
    assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "disk-stays");
    let mut edited = profile.clone();
    edited.id = "profile-edit".into();
    edited.name = "Synced".into();
    a.with_connection(|conn| {
        conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-edit','codex',1,?1)", [serde_json::to_string(&edited).unwrap()]).unwrap();
        Ok(())
    }).unwrap();
    run(&a, &store, &registry, false).unwrap();
    run(&b, &store, &registry, false).unwrap();
    edited.name = "local-edit".into();
    b.with_connection(|conn| {
        conn.execute("UPDATE native_profiles SET data=?1 WHERE id='profile-edit'", [serde_json::to_string(&edited).unwrap()]).unwrap();
        Ok(())
    }).unwrap();
    a.with_connection(|conn| {
        conn.execute("DELETE FROM native_profiles WHERE id='profile-edit'", []).unwrap();
        conn.execute("DELETE FROM library_items WHERE id='library-1'", []).unwrap();
        Ok(())
    }).unwrap();
    run(&a, &store, &registry, false).unwrap();
    let conflicts = run(&b, &store, &registry, false).unwrap().conflicts;
    assert!(conflicts.iter().any(|item| item.key == "profile:profile-edit" && item.remote_deleted));
    assert_eq!(crate::native::profile::get_registered_profile(&b, "profile-edit").unwrap().name, "local-edit");
    assert!(body(&b).is_none());
}

#[test]
fn bundle_conflict_survives_webdav_run_and_can_still_be_applied() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    credentials.put("local-secret", "sk-local-plain").unwrap();
    let profile = crate::native::profile::RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-1".into(),
        tool: "codex".into(),
        name: "Local".into(),
        version: 1,
        inherit_common: false,
        files: BTreeMap::new(),
        suppressed: BTreeMap::new(),
        connection: Some(crate::native::profile::Connection {
            provider_id: "openai".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://api.example.test/v1".into(),
            model: "gpt-6".into(),
            secret_ref: Some("local-secret".into()),
            auth_env_var: None,
            model_records: Vec::new(),
        }),
        native_credentials: BTreeMap::new(),
    };
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-1','codex',1,?1)",
            [serde_json::to_string(&profile).unwrap()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    let entity = snapshot.entities.iter_mut().find(|entity| entity.key() == "profile:profile-1").unwrap();
    let PortablePayload::Profile(value) = &mut entity.payload else { panic!("profile") };
    value.profile.name = "Remote".into();
    value.connection_secret = Some("sk-remote-plain".into());
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    super::super::restore_preview(&db, &credentials, &registry, &draft).unwrap();
    let version_id = status(&db)
        .unwrap()
        .conflicts
        .iter()
        .find(|item| item.key == "profile:profile-1")
        .unwrap()
        .versions[0]
        .id
        .clone();
    assert!(version_id.starts_with("bundle:"));
    configure(&db, &credentials, setup(&server)).unwrap();
    let synced = run(&db, &credentials, &registry, false).unwrap();
    assert!(synced.conflicts.iter().any(|item| {
        item.key == "profile:profile-1" && item.versions.iter().any(|version| version.id == version_id)
    }));
    let during: String = db
        .with_connection(|conn| {
            conn.query_row("SELECT data FROM native_profiles WHERE id='profile-1'", [], |row| row.get(0))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(during.contains("Local") && !during.contains("Remote"), "{during}");
    resolve(&db, &credentials, &registry, "profile:profile-1", Some(&version_id)).unwrap();
    let saved = collect_snapshot(&db, &credentials, &registry).unwrap();
    let PortablePayload::Profile(applied) = &saved.entities.iter().find(|entity| entity.key() == "profile:profile-1").unwrap().payload else {
        panic!("profile")
    };
    assert_eq!(applied.profile.name, "Remote");
    assert_eq!(applied.connection_secret.as_deref(), Some("sk-remote-plain"));
}

#[test]
fn configured_webdav_can_keep_local_bundle_hold_without_sync_conflicts() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    credentials.put("keep-secret", "sk-keep-plain").unwrap();
    credentials.put("take-secret", "sk-take-plain").unwrap();
    let insert = |id: &str, name: &str, secret: &str| {
        let profile = crate::native::profile::RegisteredProfile {
            editing: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            revision: String::new(),
            id: id.into(),
            tool: "codex".into(),
            name: name.into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: Some(crate::native::profile::Connection {
                provider_id: "openai".into(),
                interface_format: "openai_responses".into(),
                base_url: "https://api.example.test/v1".into(),
                model: "gpt-6".into(),
                secret_ref: Some(secret.into()),
                auth_env_var: None,
                model_records: Vec::new(),
            }),
            native_credentials: BTreeMap::new(),
        };
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,'codex',1,?2)",
                rusqlite::params![id, serde_json::to_string(&profile).unwrap()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    };
    insert("profile-keep", "Local Keep", "keep-secret");
    insert("profile-take", "Local Take", "take-secret");
    let mut snapshot = collect_snapshot(&db, &credentials, &registry).unwrap();
    for entity in &mut snapshot.entities {
        let PortablePayload::Profile(value) = &mut entity.payload else { continue };
        value.profile.name = if entity.id == "profile-keep" { "Remote Keep" } else { "Remote Take" }.into();
    }
    let draft = preview_import(&db, &credentials, &registry, snapshot).unwrap();
    assert!(draft.items.iter().any(|item| item.key == "profile:profile-keep" && item.status == "conflict"));
    assert!(draft.items.iter().any(|item| item.key == "profile:profile-take" && item.status == "conflict"));
    super::super::restore_preview(&db, &credentials, &registry, &draft).unwrap();
    configure(&db, &credentials, setup(&server)).unwrap();
    let synced = run(&db, &credentials, &registry, false).unwrap();
    assert!(synced.conflicts.iter().any(|item| item.key == "profile:profile-keep"));
    let recorded = read_conflicts(&db).unwrap();
    assert!(recorded.iter().all(|item| item.key != "profile:profile-keep" && item.key != "profile:profile-take"));
    let kept = resolve(&db, &credentials, &registry, "profile:profile-keep", None);
    assert!(kept.as_ref().map(|status| status.conflicts.iter().all(|item| item.key != "profile:profile-keep")).unwrap_or(false), "{kept:?}");
    let keep_row: String = db.with_connection(|conn| {
        conn.query_row("SELECT data FROM native_profiles WHERE id='profile-keep'", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }).unwrap();
    assert!(keep_row.contains("Local Keep") && !keep_row.contains("Remote Keep"), "{keep_row}");
    let holds: Vec<BundleHold> = read_bundle_holds(&db).unwrap();
    assert!(holds.iter().all(|item| item.key != "profile:profile-keep"));
    assert!(holds.iter().any(|item| item.key == "profile:profile-take"));
    let version_id = holds.iter().find(|item| item.key == "profile:profile-take").unwrap().version_id.clone();
    assert!(version_id.starts_with("bundle:"));
    resolve(&db, &credentials, &registry, "profile:profile-take", Some(&version_id)).unwrap();
    let saved = collect_snapshot(&db, &credentials, &registry).unwrap();
    let PortablePayload::Profile(applied) = &saved.entities.iter().find(|entity| entity.key() == "profile:profile-take").unwrap().payload else {
        panic!("profile")
    };
    assert_eq!(applied.profile.name, "Remote Take");
    let keep_after: String = db.with_connection(|conn| {
        conn.query_row("SELECT data FROM native_profiles WHERE id='profile-keep'", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }).unwrap();
    assert!(keep_after.contains("Local Keep"), "{keep_after}");
    assert!(read_bundle_holds(&db).unwrap().iter().all(|item| item.key != "profile:profile-take"));
}

#[test]
fn unreadable_auth_file_does_not_block_webdav_sync() {
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let db = database(temp.path());
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins();
    put_library(&db, "kept-body");
    let root = temp.path().join("missing-auth");
    std::fs::create_dir_all(&root).unwrap();
    let account = crate::accounts::AuthAccount {
        id: "acct".into(),
        tool_id: "codex".into(),
        provider: "test".into(),
        label: "Work".into(),
        version: 1,
        state: crate::accounts::AccountState::SignedIn,
        identity: None,
        context: Some(crate::accounts::NativeContext {
            id: "ctx".into(),
            tool_id: "codex".into(),
            root: root.clone(),
            config_root: root.clone(),
            auth_files: vec![root.join("missing.json")],
            history_roots: vec![root.clone()],
            resource_root: root,
            environment: BTreeMap::new(),
            remove_environment: Vec::new(),
            cli_args: Vec::new(),
        }),
        retired_contexts: Vec::new(),
        pending_login: None,
        checked_at: None,
        detail: None,
    };
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO auth_accounts (id,tool,version,data) VALUES ('acct','codex',1,?1)",
            [serde_json::to_string(&account).unwrap()],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    configure(&db, &credentials, setup(&server)).unwrap();
    let synced = run(&db, &credentials, &registry, false).unwrap();
    assert!(synced.last_error.is_none(), "{synced:?}");
    assert_eq!(body(&db).as_deref(), Some("kept-body"));
    let still_there: bool = db
        .with_connection(|conn| {
            conn.query_row("SELECT EXISTS(SELECT 1 FROM auth_accounts WHERE id='acct')", [], |row| row.get(0))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert!(still_there);
    assert!(synced.blockers.iter().any(|item| item.key == "account:acct" && item.detail.contains("无法读取")));
}

#[test]
fn unchanged_digest_still_finishes_a_pending_native_write() {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            super::super::set_restore_roots_for_test(None);
        }
    }
    let _guard = Guard;
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let source = database(&temp.path().join("source"));
    let fresh = database(&temp.path().join("fresh"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let scope = crate::native::apply::scope_key(crate::native::adapter::Scope::Project, Some(&project)).unwrap();
    let key = format!("binding:{}", super::super::binding_id("codex", &scope));
    let profile = crate::native::profile::RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-write".into(),
        tool: "codex".into(),
        name: "Synced".into(),
        version: 1,
        inherit_common: false,
        files: BTreeMap::from([("settings".into(), "model = \"gpt-6\"\n".into())]),
        suppressed: BTreeMap::new(),
        connection: None,
        native_credentials: BTreeMap::new(),
    };
    source
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-write','codex',1,?1)",
                [serde_json::to_string(&profile).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex','profile-write',-1,'{}')",
                [&scope],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    configure(&source, &credentials, setup(&server)).unwrap();
    run(&source, &credentials, &registry, false).unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    super::super::set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = std::path::Path::new(canonical).join(".codex").join("config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "model = \"old\"\n").unwrap();
    let mut blocked = std::fs::metadata(&config).unwrap().permissions();
    blocked.set_readonly(true);
    std::fs::set_permissions(&config, blocked).unwrap();
    configure(&fresh, &credentials, setup(&server)).unwrap();
    let received = run(&fresh, &credentials, &registry, false).unwrap();
    let failed = received
        .blockers
        .iter()
        .find(|item| item.key == key)
        .unwrap_or_else(|| panic!("{:?}", received.blockers));
    assert!(failed.action == "retry" || failed.action == "install", "{failed:?}");
    assert!(!failed.detail.contains("写入已选目录"), "{}", failed.detail);
    let before = super::super::collect_snapshot(&fresh, &credentials, &registry).unwrap();
    let before_digest = before.entities.iter().find(|entity| entity.key() == key).unwrap().digest().unwrap();
    let saved: String = fresh
        .with_connection(|conn| {
            conn.query_row(
                "SELECT local_digest FROM sync_entity_state WHERE entity_key=?1",
                [&key],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(saved, before_digest);
    let mut open = std::fs::metadata(&config).unwrap().permissions();
    open.set_readonly(false);
    std::fs::set_permissions(&config, open).unwrap();
    let again = run(&fresh, &credentials, &registry, false).unwrap();
    assert!(again.blockers.iter().all(|item| item.key != key), "{:?}", again.blockers);
    let written = std::fs::read_to_string(&config).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    let after = super::super::collect_snapshot(&fresh, &credentials, &registry).unwrap();
    let after_digest = after.entities.iter().find(|entity| entity.key() == key).unwrap().digest().unwrap();
    assert_eq!(after_digest, before_digest);
}

#[test]
fn unchanged_digest_applies_a_restored_binding_ahead_of_a_pending_release() {
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            super::super::set_restore_roots_for_test(None);
        }
    }
    let _guard = Guard;
    let server = Server::new();
    let temp = tempfile::tempdir().unwrap();
    let source = database(&temp.path().join("source"));
    let fresh = database(&temp.path().join("fresh"));
    let credentials = MemoryCredentials::default();
    let registry = Registry::builtins().with_fixture_installation("codex", "0.160.0");
    put_library(&source, "kept-body");
    let project = temp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let scope = crate::native::apply::scope_key(crate::native::adapter::Scope::Project, Some(&project)).unwrap();
    let key = format!("binding:{}", super::super::binding_id("codex", &scope));
    let profile = crate::native::profile::RegisteredProfile {
        editing: None,
        authentication: crate::native::profile::ProfileAuthentication::Native,
        revision: String::new(),
        id: "profile-write".into(),
        tool: "codex".into(),
        name: "Synced".into(),
        version: 1,
        inherit_common: false,
        files: BTreeMap::from([("settings".into(), "model = \"gpt-6\"\n".into())]),
        suppressed: BTreeMap::new(),
        connection: None,
        native_credentials: BTreeMap::new(),
    };
    source
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES ('profile-write','codex',1,?1)",
                [serde_json::to_string(&profile).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex','profile-write',-1,'{}')",
                [&scope],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    configure(&source, &credentials, setup(&server)).unwrap();
    run(&source, &credentials, &registry, false).unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    super::super::set_restore_roots_for_test(Some((home, temp.path().to_path_buf())));
    configure(&fresh, &credentials, setup(&server)).unwrap();
    let received = run(&fresh, &credentials, &registry, false).unwrap();
    assert!(received.blockers.iter().all(|item| item.key != key), "{:?}", received.blockers);
    let canonical = scope.strip_prefix("project:").unwrap();
    let config = std::path::Path::new(canonical).join(".codex").join("config.toml");
    std::fs::write(&config, ":::not toml").unwrap();
    fresh
        .with_connection(|conn| {
            conn.execute("DELETE FROM applied_bindings WHERE tool='codex'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let release_managed = r#"{"settings":{"/model":"gpt-6","/sandbox_mode":"workspace-write"}}"#;
    let error = super::super::note_failed_release(&fresh, &registry, &key, "codex", &scope, release_managed).unwrap_err();
    assert!(!error.contains("请先配置 WebDAV"), "{error}");
    fresh
        .with_connection(|conn| {
            conn.execute(
                "INSERT INTO applied_bindings (scope_key,tool,profile_id,profile_version,managed) VALUES (?1,'codex','profile-write',-1,?2)",
                rusqlite::params![scope, r#"{"settings":{"/model":"gpt-6"}}"#],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    std::fs::write(
        &config,
        "model = \"external\"\nsandbox_mode = \"workspace-write\"\nkeep = \"yes\"\n",
    )
    .unwrap();
    let before = super::super::collect_snapshot(&fresh, &credentials, &registry).unwrap();
    let before_digest = before.entities.iter().find(|entity| entity.key() == key).unwrap().digest().unwrap();
    let saved: String = fresh
        .with_connection(|conn| {
            conn.query_row(
                "SELECT local_digest FROM sync_entity_state WHERE entity_key=?1",
                [&key],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(saved, before_digest);
    let failed = run(&fresh, &credentials, &registry, false).unwrap();
    let blocker = failed
        .blockers
        .iter()
        .find(|item| item.key == key)
        .unwrap_or_else(|| panic!("{:?}", failed.blockers));
    assert_eq!(blocker.action, "retry", "{blocker:?}");
    assert!(
        blocker.detail.contains("外部修改") || blocker.detail.contains("上次管理的字段"),
        "{blocker:?}"
    );
    let during = std::fs::read_to_string(&config).unwrap();
    assert!(during.contains("external"), "{during}");
    assert!(during.contains("sandbox_mode"), "{during}");
    assert!(during.contains("keep"), "{during}");
    assert!(
        super::super::load_pending_releases(&fresh).unwrap().iter().any(|item| item.key == key),
        "a failed write must keep the old release"
    );
    assert_eq!(body(&fresh).as_deref(), Some("kept-body"));
    let deleted_during: i64 = fresh
        .with_connection(|conn| {
            conn.query_row("SELECT count(*) FROM sync_entity_state WHERE deleted!=0", [], |row| row.get(0))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted_during, 0);
    fresh
        .with_connection(|conn| {
            conn.execute("UPDATE applied_bindings SET managed='{}' WHERE tool='codex'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let again = run(&fresh, &credentials, &registry, false).unwrap();
    assert!(again.blockers.iter().all(|item| item.key != key), "{:?}", again.blockers);
    let written = std::fs::read_to_string(&config).unwrap();
    assert!(written.contains("gpt-6"), "{written}");
    assert!(written.contains("sandbox_mode"), "{written}");
    assert!(written.contains("keep"), "{written}");
    assert!(!written.contains("external"), "{written}");
    assert!(
        super::super::load_pending_releases(&fresh).unwrap().iter().all(|item| item.key != key),
        "{:?}",
        super::super::load_pending_releases(&fresh).unwrap()
    );
    assert_eq!(body(&fresh).as_deref(), Some("kept-body"));
    let after = super::super::collect_snapshot(&fresh, &credentials, &registry).unwrap();
    let after_digest = after.entities.iter().find(|entity| entity.key() == key).unwrap().digest().unwrap();
    assert_eq!(after_digest, before_digest);
    let deleted_after: i64 = fresh
        .with_connection(|conn| {
            conn.query_row("SELECT count(*) FROM sync_entity_state WHERE deleted!=0", [], |row| row.get(0))
                .map_err(|error| error.to_string())
        })
        .unwrap();
    assert_eq!(deleted_after, 0);
}
