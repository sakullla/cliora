//! Cache expensive read-only database discovery only while both DB and WAL
//! revisions match. Change-time catches same-size edits with restored mtime.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{check_cancelled, source_fingerprint_controlled};

pub fn optional_stamp(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    check_cancelled(cancelled)?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => source_fingerprint_controlled(path, cancelled),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn database_stamp(path: &Path, cancelled: &dyn Fn() -> bool) -> Result<String, String> {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    Ok(format!("{}|{}", source_fingerprint_controlled(path, cancelled)?, optional_stamp(Path::new(&wal), cancelled)?))
}

pub struct RevisionCache<T> { entries: Mutex<HashMap<PathBuf, (String, T)>> }
impl<T: Clone> RevisionCache<T> {
    pub fn new() -> Self { Self { entries: Mutex::new(HashMap::new()) } }
    pub fn read(&self, path: &Path, cancelled: &dyn Fn() -> bool, load: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let before = database_stamp(path, cancelled)?;
        if let Some((stamp, value)) = self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
            if stamp == &before { return Ok(value.clone()); }
        }
        let value = load()?;
        check_cancelled(cancelled)?;
        if database_stamp(path, cancelled)? == before {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            if entries.len() >= 32 { entries.clear(); }
            entries.insert(path.to_owned(), (before, value.clone()));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn cache_tracks_wal_commits_checkpoint_and_same_size_edits() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('old')").unwrap();
        let cache = RevisionCache::new();
        let reads = Cell::new(0);
        let read = || cache.read(&path, &|| false, || {
            reads.set(reads.get() + 1);
            db.query_row("SELECT value FROM sample", [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
        });
        assert_eq!(read().unwrap(), "old");
        assert_eq!(read().unwrap(), "old");
        assert_eq!(reads.get(), 1);
        db.execute("UPDATE sample SET value='new'", []).unwrap();
        assert_eq!(read().unwrap(), "new");
        assert_eq!(reads.get(), 2);
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        assert_eq!(read().unwrap(), "new");
        assert_eq!(reads.get(), 3);
        assert!(cache.read(&path, &|| true, || Ok("cancelled".into())).is_err());
    }
    #[test]
    fn failed_loads_are_not_cached() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.db");
        std::fs::write(&path, "fixture").unwrap();
        let cache = RevisionCache::<String>::new();
        assert!(cache.read(&path, &|| false, || Err("busy".into())).is_err());
        assert_eq!(cache.read(&path, &|| false, || Ok("retried".into())).unwrap(), "retried");
    }
}
