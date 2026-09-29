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
        if version > 6 {
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
        if version < 3 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS projects (
                   id TEXT PRIMARY KEY NOT NULL,
                   name TEXT NOT NULL,
                   path TEXT UNIQUE,
                   preferred_tool TEXT,
                   last_opened INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS project_tool_models (
                   project_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   model TEXT NOT NULL,
                   PRIMARY KEY(project_id, tool),
                   FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 3;",
            )?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS project_tool_selections (
                   project_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   profile_id TEXT NOT NULL,
                   PRIMARY KEY(project_id, tool),
                   FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 4;",
            )?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS library_items (
                   id TEXT PRIMARY KEY NOT NULL,
                   kind TEXT NOT NULL CHECK(kind IN ('prompt', 'rule')),
                   title TEXT NOT NULL,
                   body TEXT NOT NULL,
                   category TEXT NOT NULL DEFAULT '',
                   project_id TEXT,
                   version INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_library_kind_project ON library_items(kind, project_id);
                 CREATE TABLE IF NOT EXISTS skill_packages (
                   id TEXT PRIMARY KEY NOT NULL,
                   name TEXT NOT NULL UNIQUE,
                   description TEXT NOT NULL,
                   source TEXT NOT NULL,
                   digest TEXT NOT NULL,
                   files_json TEXT NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS skill_installations (
                   package_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   target_path TEXT NOT NULL,
                   digest TEXT NOT NULL,
                   PRIMARY KEY(package_id, tool, scope_key),
                   FOREIGN KEY(package_id) REFERENCES skill_packages(id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS mcp_definitions (
                   id TEXT PRIMARY KEY NOT NULL,
                   name TEXT NOT NULL,
                   transport TEXT NOT NULL,
                   data_json TEXT NOT NULL,
                   version INTEGER NOT NULL,
                   UNIQUE(name)
                 );
                 CREATE TABLE IF NOT EXISTS mcp_targets (
                   definition_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   enabled INTEGER NOT NULL,
                   managed_hash TEXT NOT NULL,
                   PRIMARY KEY(definition_id, tool, scope_key),
                   FOREIGN KEY(definition_id) REFERENCES mcp_definitions(id) ON DELETE CASCADE
                 );
                 PRAGMA user_version = 5;",
            )?;
            tx.commit()?;
        }
        if version < 6 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS skill_operations (
                   id TEXT PRIMARY KEY NOT NULL,
                   package_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   target_path TEXT NOT NULL,
                   stage_path TEXT NOT NULL,
                   backup_path TEXT NOT NULL,
                   old_digest TEXT,
                   old_managed_digest TEXT,
                   new_digest TEXT,
                   removing INTEGER NOT NULL,
                   status TEXT NOT NULL
                 );
                 PRAGMA user_version = 6;",
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
    fn unknown_managed_id_survives_bootstrap_and_settings_update() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("prefs.db")).unwrap();
        db.with_connection(|conn| {
            conn.execute("INSERT INTO app_settings (key, value) VALUES ('preferences', ?1)",
                [r#"{"schema_version":1,"managed_tools":["codex","future_cli"],"theme":"system"}"#])
                .map_err(|error| error.to_string())?;
            conn.execute("INSERT INTO native_profiles (id, tool, version, data) VALUES ('future-profile', 'future_cli', 1, ?1)",
                [r#"{"id":"future-profile","tool":"future_cli","name":"Future","version":1}"#])
                .map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let saved = db
            .update_preferences(|preferences| preferences.theme = Theme::Dark)
            .unwrap();
        assert_eq!(saved.managed_tools, vec![CliId::Codex]);
        assert_eq!(saved.unknown_managed_tools(), &["future_cli"]);
        let updated = db
            .update_preferences(|preferences| preferences.set_managed(&[CliId::Pi]))
            .unwrap();
        assert_eq!(updated.managed_tools, vec![CliId::Pi]);
        assert_eq!(updated.unknown_managed_tools(), &["future_cli"]);
        let raw: String = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT value FROM app_settings WHERE key = 'preferences'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(raw.contains("future_cli"));
        let bootstrap = crate::domain::Bootstrap::new(db.preferences().unwrap());
        let ipc = serde_json::to_string(&bootstrap).unwrap();
        assert!(!ipc.contains("future_cli"));
        let profile_count: i64 = db
            .with_connection(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM native_profiles WHERE tool = 'future_cli'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(profile_count, 1);
    }

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
            assert_eq!(version, 6);
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM native_profiles", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        })
        .unwrap();
    }
}
