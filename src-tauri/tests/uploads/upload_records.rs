use super::*;
use std::path::Path;

use super::super::uploads::LandedUpload;

fn landed(remote_path: &str, local_name: &str) -> LandedUpload {
    LandedUpload {
        remote_path: remote_path.into(),
        local_name: local_name.into(),
    }
}

#[test]
fn upload_records_are_session_scoped_idempotent_and_validated() {
    let database = Database::open(Path::new(":memory:")).unwrap();
    // Recording nothing is a no-op, never an empty-rows error.
    record(&database, "target", "session", &[]).unwrap();
    assert!(list_for_session(&database, "target", "session").unwrap().is_empty());

    record(&database, "target", "session-a", &[
        landed("/srv/demo/.cliora/uploads/report.pdf", "report.pdf"),
        landed("/srv/demo/.cliora/uploads/.cliora-upload-abc", "report.pdf"),
    ])
    .unwrap();
    record(&database, "target", "session-b", &[landed("/srv/demo/.cliora/uploads/data.bin", "data.bin")])
        .unwrap();
    record(&database, "other-target", "session-a", &[landed("/srv/demo/.cliora/uploads/other.txt", "other.txt")])
        .unwrap();

    let session = list_for_session(&database, "target", "session-a").unwrap();
    assert_eq!(session.len(), 2);
    assert_eq!(session[0].remote_path, "/srv/demo/.cliora/uploads/.cliora-upload-abc");
    assert_eq!(session[0].local_name, "report.pdf");
    assert_eq!(session[0].target_id, "target");
    assert_eq!(session[0].remote_session_id, "session-a");
    assert_eq!(session[1].remote_path, "/srv/demo/.cliora/uploads/report.pdf");
    // Target-wide listing sees every pending session of that target.
    assert_eq!(list_for_target(&database, "target").unwrap().len(), 3);
    assert_eq!(list_for_target(&database, "other-target").unwrap().len(), 1);

    // The same landing twice is the same file, not a conflict.
    record(&database, "target", "session-a", &[landed("/srv/demo/.cliora/uploads/report.pdf", "report.pdf")])
        .unwrap();
    assert_eq!(list_for_session(&database, "target", "session-a").unwrap().len(), 2);

    // Deleting one session leaves every other session untouched.
    assert_eq!(delete_for_session(&database, "target", "session-a").unwrap(), 2);
    assert!(list_for_session(&database, "target", "session-a").unwrap().is_empty());
    assert_eq!(list_for_target(&database, "target").unwrap().len(), 1);
    assert_eq!(delete_for_session(&database, "target", "session-a").unwrap(), 0);

    // Invalid ownership or paths never enter the table.
    assert!(record(&database, "", "session", &[landed("/srv/a", "a")]).is_err());
    assert!(record(&database, "target", "", &[landed("/srv/a", "a")]).is_err());
    assert!(record(&database, "target", "session", &[landed("", "a")]).is_err());
    assert!(record(&database, "target", "session", &[landed("/srv/a", "sub/name")]).is_err());
    assert!(record(&database, "target", "session", &[landed("/srv/a\nhidden", "a")]).is_err());
    assert!(record(&database, "target", "session", &[landed("/srv/a", "")]).is_err());
    assert!(list_for_session(&database, "target", "session").unwrap().is_empty());
}

#[test]
fn upload_records_migration_v30_recreates_the_table_and_preserves_neighbors() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("uploads.db");
    {
        let database = Database::open(&path).unwrap();
        database.with_connection(|connection| {
            // A pre-v30 database has no upload table yet.
            connection.execute_batch("DROP TABLE remote_session_uploads; PRAGMA user_version = 29;").unwrap();
            connection.execute("INSERT INTO app_settings(key,value) VALUES ('uploads-fixture','keep')", []).unwrap();
            Ok(())
        })
        .unwrap();
    }
    let database = Database::open(&path).unwrap();
    database.with_connection(|connection| {
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, 31);
        let value: String = connection
            .query_row("SELECT value FROM app_settings WHERE key='uploads-fixture'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "keep");
        Ok(())
    })
    .unwrap();
    record(&database, "target", "session", &[landed("/srv/demo/.cliora/uploads/report.pdf", "report.pdf")])
        .unwrap();
    drop(database);
    // Rows survive a reopen; recovery after a restart reads the same records.
    let database = Database::open(&path).unwrap();
    let restored = list_for_session(&database, "target", "session").unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].remote_path, "/srv/demo/.cliora/uploads/report.pdf");
    assert_eq!(restored[0].local_name, "report.pdf");
}
