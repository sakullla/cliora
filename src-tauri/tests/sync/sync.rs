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
        if state.fail_manifest_write && path.ends_with("manifest.cliora") {
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
        enabled: true,
    }
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
