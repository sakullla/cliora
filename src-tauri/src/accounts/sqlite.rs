//! Read-only access to native credential databases that also hold unrelated
//! state. Adapters own schema knowledge; this module owns the safe open policy.

use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Sidecars {
    pub wal: bool,
    pub shm: bool,
}

impl Sidecars {
    pub(crate) fn detect(path: &Path) -> Self {
        Self {
            wal: sidecar(path, "-wal").is_file(),
            shm: sidecar(path, "-shm").is_file(),
        }
    }

    pub(crate) fn present(&self) -> bool {
        self.wal || self.shm
    }
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut text = path.as_os_str().to_owned();
    text.push(suffix);
    PathBuf::from(text)
}

pub(crate) struct Opened {
    pub connection: Connection,
    pub sidecars: Sidecars,
}

#[derive(Debug)]
pub(crate) enum OpenFailure {
    /// The database is locked, or a WAL/SHM sidecar needs write access.
    Busy(Sidecars),
    NotADatabase,
    Unavailable,
}

#[derive(Debug)]
pub(crate) enum ReadFailure {
    NotADatabase,
    Corrupt,
    Unavailable,
}

pub(crate) fn open_read_only(path: &Path) -> Result<Opened, OpenFailure> {
    let sidecars = Sidecars::detect(path);
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| match error {
        rusqlite::Error::SqliteFailure(code, _) => match code.code {
            rusqlite::ErrorCode::CannotOpen
            | rusqlite::ErrorCode::DatabaseBusy
            | rusqlite::ErrorCode::DatabaseLocked => OpenFailure::Busy(sidecars),
            rusqlite::ErrorCode::NotADatabase => OpenFailure::NotADatabase,
            _ => OpenFailure::Unavailable,
        },
        _ => OpenFailure::Unavailable,
    })?;
    let _ = connection.busy_timeout(Duration::from_millis(1500));
    connection
        .execute_batch("PRAGMA query_only = ON;")
        .map_err(|_| OpenFailure::Unavailable)?;
    Ok(Opened {
        connection,
        sidecars,
    })
}

pub(crate) fn classify(error: &rusqlite::Error) -> ReadFailure {
    if let rusqlite::Error::SqliteFailure(code, _) = error {
        match code.code {
            rusqlite::ErrorCode::NotADatabase => return ReadFailure::NotADatabase,
            rusqlite::ErrorCode::DatabaseCorrupt => return ReadFailure::Corrupt,
            _ => {}
        }
    }
    ReadFailure::Unavailable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_database_files_are_classified_and_sidecars_are_detected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.db");
        std::fs::write(&path, "not a sqlite database").unwrap();
        let opened = open_read_only(&path).unwrap();
        let error = opened
            .connection
            .prepare("SELECT name FROM sqlite_master")
            .unwrap_err();
        assert!(matches!(classify(&error), ReadFailure::NotADatabase));
        let _ = std::fs::write(temp.path().join("agent.db-wal"), "").unwrap();
        assert!(Sidecars::detect(&path).present());
        assert!(!Sidecars::detect(&temp.path().join("other.db")).present());
    }
}
