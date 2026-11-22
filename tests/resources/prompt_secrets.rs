//! Prompt secret contracts: the value stays behind the credential boundary while
//! prompt text, DTOs, search previews, portable collection and WebDAV collection
//! keep only the canonical reference.
use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;

const CANARY: &str = "canary-synthetic-9f3a1b";

#[derive(Default)]
struct MemoryCredentials {
    values: Mutex<BTreeMap<String, String>>,
    fail_put: Mutex<bool>,
    fail_read: Mutex<bool>,
    reads: std::sync::atomic::AtomicUsize,
}

impl MemoryCredentials {
    fn put_text(&self, id: &str, value: &str) {
        self.values.lock().unwrap().insert(id.into(), value.into());
    }
    fn stash(&self) -> BTreeMap<String, String> {
        self.values.lock().unwrap().clone()
    }
}

impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        if *self.fail_put.lock().unwrap() {
            return Err("synthetic write failure".into());
        }
        self.put_text(id, secret);
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if *self.fail_read.lock().unwrap() {
            return Err("synthetic read failure".into());
        }
        self.values
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "missing".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}

fn db() -> Database {
    Database::open(std::path::Path::new(":memory:")).unwrap()
}

fn secret(database: &Database, store: &MemoryCredentials, alias: &str, value: &str) -> PromptSecret {
    create(database, store, alias, value).unwrap()
}

fn prompt(database: &Database, title: &str, body: &str) -> crate::prompts::PromptDocument {
    crate::prompts::save(
        database,
        &crate::prompts::PromptDraft {
            id: None,
            title: title.into(),
            body: body.into(),
            scope: crate::prompts::PromptScope::Global,
            tags: vec![],
            expected_version: None,
        },
    )
    .unwrap()
}

#[test]
fn references_only_match_the_canonical_form() {
    let id = uuid::Uuid::new_v4();
    let body = format!(
        "before {{{{cliora-secret:{id}}}}} middle {{{{cliora-secret:{}}}}} after",
        id.to_string().to_uppercase()
    );
    assert_eq!(reference::references(&body), vec![id.to_string()]);
    assert_eq!(
        reference::format(&id.to_string()),
        format!("{{{{cliora-secret:{id}}}}}")
    );
    for text in [
        "{{cliora-secret:not-a-uuid}}",
        "{{ cliora-secret:550e8400-e29b-41d4-a716-446655440000 }}",
        "${cliora-secret:550e8400-e29b-41d4-a716-446655440000}",
        "{{cliora-secret:550e8400-e29b-41d4-a716-446655440000",
        "{{secret:550e8400-e29b-41d4-a716-446655440000}}",
        "cliora-secret:550e8400-e29b-41d4-a716-446655440000",
    ] {
        assert!(reference::references(text).is_empty(), "must stay plain text: {text}");
    }
    // A truncated trailing token does not hide the complete one before it.
    let complete = uuid::Uuid::new_v4();
    let mixed = format!("{{{{cliora-secret:{complete}}}}} {{{{cliora-secret:broken");
    assert_eq!(reference::references(&mixed), vec![complete.to_string()]);
    // Repeated references resolve once, in body order.
    let second = uuid::Uuid::new_v4();
    let repeated = format!(
        "{{{{cliora-secret:{complete}}}}}{{{{cliora-secret:{second}}}}}{{{{cliora-secret:{complete}}}}}"
    );
    assert_eq!(
        reference::references(&repeated),
        vec![complete.to_string(), second.to_string()]
    );
    assert!(reference::credential_id(&complete.to_string()).unwrap().starts_with("prompt-secret-"));
    assert!(reference::credential_id("not-a-uuid").is_err());
}

#[test]
fn create_keeps_the_value_out_of_sqlite_and_prompt_consumers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cliora.db");
    let database = Database::open(&path).unwrap();
    let store = MemoryCredentials::default();
    let created = secret(&database, &store, "生产密码", CANARY);
    assert_eq!(created.status, SecretStatus::Available);
    assert_eq!(created.reference, format!("{{{{cliora-secret:{}}}}}", created.id));
    assert_eq!(store.stash().len(), 1);
    assert_eq!(
        store.get(&format!("prompt-secret-{}", created.id)).unwrap(),
        CANARY
    );

    let document = prompt(
        &database,
        "部署步骤",
        &format!("使用 {} 登录部署机", created.reference),
    );
    assert!(document.body.contains(&created.reference));
    assert!(!document.body.contains(CANARY));

    // Detail, page preview, search and the full collection portable/WebDAV uses.
    let detail = crate::prompts::get(&database, &document.id, None).unwrap();
    assert!(!serde_json::to_string(&detail).unwrap().contains(CANARY));
    let by_canary = crate::prompts::query(
        &database,
        &crate::prompts::PromptQuery { search: CANARY.into(), include_other_scopes: true, ..Default::default() },
    )
    .unwrap();
    assert_eq!(by_canary.total, 0, "the value is not prompt search content");
    let by_reference = crate::prompts::query(
        &database,
        &crate::prompts::PromptQuery { search: created.id.clone(), include_other_scopes: true, ..Default::default() },
    )
    .unwrap();
    assert_eq!(by_reference.total, 1);
    assert!(!by_reference.items[0].preview.contains(CANARY));
    let collected = crate::prompts::all_documents(&database).unwrap();
    let bytes = serde_json::to_string(&collected).unwrap();
    assert!(bytes.contains(&created.reference));
    assert!(!bytes.contains(CANARY));

    // The serialized metadata DTO exposes the alias and reference, never the value.
    let listed = list(&database, &store).unwrap();
    let json = serde_json::to_string(&listed).unwrap();
    assert!(json.contains("生产密码") && json.contains(&created.reference));
    assert!(!json.contains(CANARY));
    let resolved = resolve(&database, &store, &document.body).unwrap();
    assert_eq!(resolved[0].status, SecretStatus::Available);
    assert!(!serde_json::to_string(&resolved).unwrap().contains(CANARY));

    // Neither the database file nor its WAL may hold the value.
    database
        .with_connection(|conn| {
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| error.to_string())
        })
        .unwrap();
    for candidate in [path.clone(), path.with_extension("db-wal")] {
        if let Ok(bytes) = std::fs::read(&candidate) {
            assert!(
                !bytes.windows(CANARY.len()).any(|window| window == CANARY.as_bytes()),
                "{} must not contain the secret value",
                candidate.display()
            );
        }
    }
}

#[test]
fn alias_and_value_updates_keep_the_same_reference_and_reject_stale_versions() {
    let database = db();
    let store = MemoryCredentials::default();
    let created = secret(&database, &store, "旧别名", "first-value");
    let document = prompt(&database, "引用", &format!("token {}", created.reference));

    let renamed = rename(&database, &store, &created.id, created.version, "新别名").unwrap();
    assert_eq!(renamed.id, created.id);
    assert_eq!(renamed.alias, "新别名");
    assert_eq!(renamed.reference, created.reference);
    assert_eq!(renamed.version, created.version + 1);
    // The prompt body is untouched; the same reference now shows the new alias.
    assert_eq!(crate::prompts::get(&database, &document.id, None).unwrap().body, document.body);
    let resolved = resolve(&database, &store, &document.body).unwrap();
    assert_eq!(resolved[0].alias.as_deref(), Some("新别名"));
    // A stale rename does not silently point another secret at this alias.
    assert!(rename(&database, &store, &created.id, created.version, "过期").is_err());
    assert_eq!(list(&database, &store).unwrap()[0].alias, "新别名");

    let updated = update_value(&database, &store, &created.id, renamed.version, "second-value").unwrap();
    assert_eq!(updated.version, renamed.version + 1);
    assert_eq!(updated.reference, created.reference);
    assert_eq!(store.get(&format!("prompt-secret-{}", created.id)).unwrap(), "second-value");
    assert_eq!(crate::prompts::get(&database, &document.id, None).unwrap().body, document.body);

    // A stale value update keeps the current value.
    assert!(update_value(&database, &store, &created.id, renamed.version, "stale-value").is_err());
    assert_eq!(store.get(&format!("prompt-secret-{}", created.id)).unwrap(), "second-value");

    // Duplicate aliases are refused before touching the credential store.
    let other = secret(&database, &store, "另一个", CANARY);
    let before = store.stash();
    assert!(create(&database, &store, "新别名", "blocked").is_err());
    assert_eq!(store.stash(), before, "a rejected alias leaves no orphan value");
    assert_eq!(list(&database, &store).unwrap().len(), 2);
    assert_eq!(other.status, SecretStatus::Available);
}

#[test]
fn a_failed_secret_save_never_looks_available() {
    let database = db();
    let store = MemoryCredentials::default();
    *store.fail_put.lock().unwrap() = true;
    assert!(create(&database, &store, "保存失败", CANARY).is_err());
    assert!(list(&database, &store).unwrap().is_empty());
    assert!(store.stash().is_empty());

    *store.fail_put.lock().unwrap() = false;
    let created = secret(&database, &store, "先成功", CANARY);
    // A credential that cannot be read is reported as unreadable, not as absence or
    // as a different usable secret.
    *store.fail_read.lock().unwrap() = true;
    let listed = list(&database, &store).unwrap();
    assert_eq!(listed[0].status, SecretStatus::Unreadable);
    let resolved = resolve(&database, &store, &reference::format(&created.id)).unwrap();
    assert_eq!(resolved[0].status, SecretStatus::Unreadable);
    *store.fail_read.lock().unwrap() = false;
    assert_eq!(list(&database, &store).unwrap()[0].status, SecretStatus::Available);
}

#[test]
fn deleting_a_secret_invalidates_old_references_even_after_same_alias_recreation() {
    let database = db();
    let store = MemoryCredentials::default();
    let created = secret(&database, &store, "数据库口令", CANARY);
    let document = prompt(&database, "运维", &format!("连接 {}", created.reference));

    delete(&database, &store, &created.id, created.version).unwrap();
    assert!(store.stash().is_empty(), "the credential is removed with the metadata");
    assert!(list(&database, &store).unwrap().is_empty());
    let resolved = resolve(&database, &store, &document.body).unwrap();
    assert_eq!(resolved[0].status, SecretStatus::Unknown);
    assert_eq!(resolved[0].alias, None);
    // The prompt keeps its body and reference so it stays editable.
    assert_eq!(crate::prompts::get(&database, &document.id, None).unwrap().body, document.body);
    // Deleting again with the old version fails instead of claiming success.
    assert!(delete(&database, &store, &created.id, created.version).is_err());

    let recreated = secret(&database, &store, "数据库口令", "replacement-value");
    assert_ne!(recreated.id, created.id);
    assert_ne!(recreated.reference, created.reference);
    let still_unknown = resolve(&database, &store, &document.body).unwrap();
    assert_eq!(still_unknown[0].status, SecretStatus::Unknown);
    assert_eq!(still_unknown[0].alias, None);
    // Only the new reference resolves, and only to the new value.
    let fresh = resolve(&database, &store, &format!("二次 {}", recreated.reference)).unwrap();
    assert_eq!(fresh[0].status, SecretStatus::Available);
    assert_eq!(fresh[0].alias.as_deref(), Some("数据库口令"));
    assert_eq!(
        store.get(&format!("prompt-secret-{}", recreated.id)).unwrap(),
        "replacement-value"
    );
}

#[test]
fn resolving_a_body_without_references_reads_no_credential() {
    let database = db();
    let store = MemoryCredentials::default();
    *store.fail_read.lock().unwrap() = true;
    assert!(resolve(&database, &store, "普通正文，没有秘密引用。").unwrap().is_empty());
    let unknown = uuid::Uuid::new_v4();
    let resolved = resolve(&database, &store, &format!("{{{{cliora-secret:{unknown}}}}}")).unwrap();
    assert_eq!(resolved[0].status, SecretStatus::Unknown);
}

#[test]
fn invalid_aliases_and_values_are_refused_before_saving() {
    let database = db();
    let store = MemoryCredentials::default();
    assert!(create(&database, &store, "", CANARY).is_err());
    assert!(create(&database, &store, &"长".repeat(81), CANARY).is_err());
    assert!(create(&database, &store, "控制\n字符", CANARY).is_err());
    assert!(create(&database, &store, "空值", "").is_err());
    assert!(create(&database, &store, "太长", &"x".repeat(16_385)).is_err());
    assert!(list(&database, &store).unwrap().is_empty());
    assert!(store.stash().is_empty());
    let created = secret(&database, &store, "  正常别名  ", CANARY);
    assert_eq!(created.alias, "正常别名");
}

#[test]
fn paging_reads_only_visible_values_and_orders_references_first() {
    use std::sync::atomic::Ordering;
    let db = db();
    let store = MemoryCredentials::default();
    for n in 0..69 { secret(&db, &store, &format!("entry-{n:02}"), CANARY); }
    let last = secret(&db, &store, "last", CANARY);
    store.reads.store(0, Ordering::Relaxed);
    let first = page(&db, &store, "", 0, &last.reference).unwrap();
    assert_eq!((first.total, first.matched, first.items.len()), (70, 70, 30));
    assert_eq!(first.items[0].id, last.id);
    assert_eq!(store.reads.load(Ordering::Relaxed), 30);
    let end = page(&db, &store, "", 999, &last.reference).unwrap();
    assert_eq!((end.offset, end.items.len()), (60, 10));
    let match_one = page(&db, &store, "LAST", 30, "").unwrap();
    assert_eq!((match_one.offset,match_one.matched), (0,1));
    let none = page(&db, &store, "unmatched", 120, "").unwrap();
    assert!(none.items.is_empty());
    assert_eq!(store.reads.load(Ordering::Relaxed), 41);
}

#[test]
fn imported_prompt_reference_can_be_bound_on_the_receiving_device_without_changing_its_body() {
    let registry = crate::adapters::Registry::builtins();
    let source = db();
    let source_store = MemoryCredentials::default();
    let created = secret(&source, &source_store, "部署", CANARY);
    let expected = format!("使用 {} 执行已授权的部署操作。", created.reference);
    let document = prompt(&source, "部署", &expected);
    let snapshot = crate::portable::collect_snapshot(&source, &source_store, &registry).unwrap();
    let target = db();
    let target_store = MemoryCredentials::default();
    let preview = crate::portable::preview_import(&target, &target_store, &registry, snapshot).unwrap();
    crate::portable::apply_import(&target, &target_store, &registry, &preview,
        &std::collections::BTreeSet::from([format!("library:{}", document.id)])).unwrap();
    let received = crate::prompts::get(&target, &document.id, None).unwrap();
    assert_eq!(received.body, expected);
    assert_eq!(resolve(&target, &target_store, &expected).unwrap()[0].status, SecretStatus::Unknown);
    let bound = create_local(&target, &target_store, "本机部署", "second-device", Some(&created.id)).unwrap();
    assert_eq!(bound.reference, created.reference);
    assert!(create_local(&target, &target_store, "重复绑定", "overwrite", Some(&created.id)).is_err());
    assert_eq!(target_store.get(&reference::credential_id(&created.id).unwrap()).unwrap(), "second-device");
    let grants = target.with_read_connection(|conn| conn.query_row("SELECT count(*) FROM secret_grants", [],
        |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())).unwrap();
    assert_eq!(grants, 0);
}
