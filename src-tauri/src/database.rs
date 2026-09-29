use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::Preferences;

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("database version {0} is newer than this application supports")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Single owner for local application data. Future modules add tables through numbered migrations.
pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, OpenError> {
        let mut connection = Connection::open(path)?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 2 {
            return Err(OpenError::UnsupportedVersion(version));
        }
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        if version == 0 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS app_settings (
                   key TEXT PRIMARY KEY NOT NULL,
                   value TEXT NOT NULL
                 );
                 PRAGMA user_version = 1;",
            )?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS native_profiles (
                   id TEXT PRIMARY KEY NOT NULL,
                   tool TEXT NOT NULL,
                   version INTEGER NOT NULL,
                   data TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_native_profiles_tool ON native_profiles(tool);
                 CREATE TABLE IF NOT EXISTS common_configs (
                   tool TEXT PRIMARY KEY NOT NULL,
                   version INTEGER NOT NULL,
                   data TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS installation_choices (
                   tool TEXT PRIMARY KEY NOT NULL,
                   path TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS applied_bindings (
                   scope_key TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   profile_id TEXT NOT NULL,
                   profile_version INTEGER NOT NULL,
                   managed TEXT NOT NULL,
                   PRIMARY KEY(scope_key, tool)
                 );
                 CREATE TABLE IF NOT EXISTS model_cache (
                   cache_key TEXT PRIMARY KEY NOT NULL,
                   fetched_at INTEGER NOT NULL,
                   data TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS native_transactions (
                   id TEXT PRIMARY KEY NOT NULL,
                   status TEXT NOT NULL,
                   data TEXT NOT NULL
                 );
                 PRAGMA user_version = 2;",
            )?;
            tx.commit()?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn with_connection<T>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut connection = self.connection.lock().map_err(|_| "数据库暂时不可用")?;
        action(&mut connection)
    }

    pub fn preferences(&self) -> Result<Preferences, String> {
        let conn = self.connection.lock().map_err(|_| "数据库暂时不可用")?;
        Self::read_preferences(&conn)
    }

    fn read_preferences(conn: &Connection) -> Result<Preferences, String> {
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "无法读取本机设置")?;
        match value {
            Some(json) => {
                let preferences: Preferences =
                    serde_json::from_str(&json).map_err(|_| "本机设置格式无法识别")?;
                if preferences.schema_version != 1 {
                    return Err("本机设置版本暂不支持".to_string());
                }
                Ok(preferences)
            }
            None => Ok(Preferences::default()),
        }
    }

    pub fn update_preferences(
        &self,
        update: impl FnOnce(&mut Preferences),
    ) -> Result<Preferences, String> {
        let mut conn = self.connection.lock().map_err(|_| "数据库暂时不可用")?;
        let mut preferences = Self::read_preferences(&conn)?;
        update(&mut preferences);
        let json = serde_json::to_string(&preferences).map_err(|_| "无法整理设置")?;
        let tx = conn.transaction().map_err(|_| "无法保存本机设置")?;
        tx.execute(
            "INSERT INTO app_settings (key, value) VALUES ('preferences', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![json],
        )
        .map_err(|_| "无法保存本机设置")?;
        tx.commit().map_err(|_| "无法完成本机设置保存")?;
        Ok(preferences)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CliId, Theme};

    #[test]
    fn settings_survive_reopening_database_including_empty_selection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cliora.db");
        {
            let db = Database::open(&path).unwrap();
            let mut preferences = db.preferences().unwrap();
            assert_eq!(preferences.managed_tools.len(), 5);
            preferences.set_managed(&[]);
            preferences.theme = Theme::Dark;
            db.update_preferences(|p| *p = preferences).unwrap();
        }
        let db = Database::open(&path).unwrap();
        let preferences = db.preferences().unwrap();
        assert_eq!(preferences.theme, Theme::Dark);
        assert!(preferences.managed_tools.is_empty());
        let mut restored = preferences;
        restored.set_managed(&[CliId::Pi, CliId::Codex]);
        db.update_preferences(|p| *p = restored).unwrap();
        assert_eq!(
            db.preferences().unwrap().managed_tools,
            vec![CliId::Codex, CliId::Pi]
        );
    }

    #[test]
    fn future_database_version_is_not_rewritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cliora.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        drop(conn);
        let original = std::fs::read(&path).unwrap();
        assert!(matches!(
            Database::open(&path),
            Err(OpenError::UnsupportedVersion(99))
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let conn = Connection::open(path).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn existing_v1_database_gains_profile_tables_without_losing_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cliora.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); PRAGMA user_version = 1;").unwrap();
        connection
            .execute(
                "INSERT INTO app_settings (key, value) VALUES ('preferences', ?1)",
                [serde_json::to_string(&Preferences::default()).unwrap()],
            )
            .unwrap();
        drop(connection);
        let db = Database::open(&path).unwrap();
        assert_eq!(db.preferences().unwrap(), Preferences::default());
        db.with_connection(|conn| {
            let version: u32 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(version, 2);
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM native_profiles", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
    }
}
