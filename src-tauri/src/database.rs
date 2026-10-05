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
    read_path: Option<std::path::PathBuf>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, OpenError> {
        let mut connection = Connection::open(path)?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 20 {
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
        if version < 7 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS history_sessions (
                   id TEXT PRIMARY KEY NOT NULL,
                   tool TEXT NOT NULL,
                   source_key TEXT NOT NULL UNIQUE,
                   source_path TEXT NOT NULL,
                   source_fingerprint TEXT NOT NULL,
                   native_id TEXT,
                   title TEXT NOT NULL,
                   cwd TEXT,
                   model TEXT,
                   started_at INTEGER,
                   updated_at INTEGER,
                   messages_json TEXT NOT NULL,
                   usage_json TEXT NOT NULL,
                   message_count INTEGER NOT NULL,
                   usage_count INTEGER NOT NULL,
                   partial INTEGER NOT NULL,
                   stale INTEGER NOT NULL DEFAULT 0,
                   favorite INTEGER NOT NULL DEFAULT 0,
                   project_id TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_history_tool_time ON history_sessions(tool, updated_at);
                 CREATE TABLE IF NOT EXISTS history_prices (
                   tool TEXT NOT NULL,
                   model TEXT NOT NULL,
                   currency TEXT NOT NULL,
                   input_per_million REAL NOT NULL,
                   output_per_million REAL NOT NULL,
                   cache_read_per_million REAL NOT NULL,
                   cache_write_per_million REAL NOT NULL,
                   source TEXT NOT NULL,
                   updated_at INTEGER NOT NULL,
                   PRIMARY KEY(tool, model)
                 );
                 CREATE TABLE IF NOT EXISTS history_scan_state (
                   tool TEXT PRIMARY KEY NOT NULL,
                   scanned_at INTEGER NOT NULL,
                   source_count INTEGER NOT NULL,
                   failed_count INTEGER NOT NULL,
                   incomplete INTEGER NOT NULL,
                   detail TEXT NOT NULL
                 );
                 PRAGMA user_version = 7;",
            )?;
            tx.commit()?;
        }
        if version < 8 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS sync_config (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   endpoint TEXT NOT NULL,
                   username TEXT NOT NULL,
                   auth_secret_id TEXT NOT NULL,
                   space_secret_id TEXT NOT NULL,
                   space_id TEXT NOT NULL,
                   epoch INTEGER NOT NULL,
                   enabled INTEGER NOT NULL,
                   last_success INTEGER,
                   last_error TEXT,
                   retry_after INTEGER NOT NULL DEFAULT 0,
                   failure_count INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS sync_entity_state (
                   entity_key TEXT PRIMARY KEY NOT NULL,
                   local_digest TEXT NOT NULL,
                   heads_json TEXT NOT NULL,
                   deleted INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE TABLE IF NOT EXISTS sync_outbox (
                   id TEXT PRIMARY KEY NOT NULL,
                   entity_key TEXT NOT NULL,
                   object_json TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS sync_seen (
                   id TEXT PRIMARY KEY NOT NULL
                 );
                 PRAGMA user_version = 8;",
            )?;
            tx.commit()?;
        }
        if version < 9 {
            let tx = connection.transaction()?;
            for (table, prefix, id_column) in [
                ("native_profiles", "profile", "id"),
                ("common_configs", "common", "tool"),
                ("projects", "project", "id"),
                ("project_tool_models", "project", "project_id"),
                ("library_items", "library", "id"),
                ("mcp_definitions", "mcp", "id"),
                ("skill_packages", "skill", "id"),
            ] {
                for (event, row) in [("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")] {
                    let trigger = format!("CREATE TRIGGER IF NOT EXISTS sync_{table}_{event} AFTER {event} ON {table} BEGIN
                        INSERT INTO sync_outbox (id,entity_key,object_json,created_at)
                        VALUES ('{prefix}:' || {row}.{id_column},'{prefix}:' || {row}.{id_column},hex(randomblob(16)),strftime('%s','now'))
                        ON CONFLICT(id) DO UPDATE SET object_json=excluded.object_json,created_at=excluded.created_at; END;");
                    tx.execute_batch(&trigger)?;
                }
            }
            for (event,row) in [("INSERT","NEW"),("UPDATE","NEW"),("DELETE","OLD")] {
                let trigger = format!("CREATE TRIGGER IF NOT EXISTS sync_preferences_{event} AFTER {event} ON app_settings
                    WHEN {row}.key='preferences' BEGIN
                    INSERT INTO sync_outbox (id,entity_key,object_json,created_at)
                    VALUES ('preferences:managed','preferences:managed',hex(randomblob(16)),strftime('%s','now'))
                    ON CONFLICT(id) DO UPDATE SET object_json=excluded.object_json,created_at=excluded.created_at; END;");
                tx.execute_batch(&trigger)?;
            }
            tx.execute_batch("PRAGMA user_version = 9;")?;
            tx.commit()?;
        }
        if version < 10 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "ALTER TABLE skill_packages ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1;
                 PRAGMA user_version = 10;",
            )?;
            tx.commit()?;
        }
        if version < 11 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS rule_placements (
                   rule_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   position INTEGER NOT NULL,
                   PRIMARY KEY(rule_id, tool, scope_key),
                   FOREIGN KEY(rule_id) REFERENCES library_items(id) ON DELETE CASCADE
                 );
                 CREATE TABLE IF NOT EXISTS rule_files (
                   tool TEXT NOT NULL,
                   scope_key TEXT NOT NULL,
                   managed_hash TEXT NOT NULL,
                   PRIMARY KEY(tool, scope_key)
                 );
                 PRAGMA user_version = 11;",
            )?;
            tx.commit()?;
        }
        if version < 12 {
            // Usage moves into one row per model call so date ranges and groupings are
            // indexed queries. Existing caches are copied over, then every source is
            // re-read once because older scans stopped at 30k rows / 16 MiB.
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS history_usage (
                   session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
                   event_id TEXT NOT NULL,
                   tool TEXT NOT NULL,
                   model TEXT,
                   timestamp INTEGER,
                   input INTEGER,
                   output INTEGER,
                   cache_read INTEGER,
                   cache_write INTEGER,
                   input_includes_cache INTEGER NOT NULL,
                   PRIMARY KEY(session_id, event_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_history_usage_time ON history_usage(timestamp);
                 CREATE INDEX IF NOT EXISTS idx_history_usage_tool_model ON history_usage(tool, model);
                 INSERT OR IGNORE INTO history_usage (session_id,event_id,tool,model,timestamp,input,output,cache_read,cache_write,input_includes_cache)
                   SELECT s.id, json_extract(e.value,'$.id'), s.tool, COALESCE(json_extract(e.value,'$.model'), s.model),
                     json_extract(e.value,'$.timestamp'), json_extract(e.value,'$.input'), json_extract(e.value,'$.output'),
                     json_extract(e.value,'$.cacheRead'), json_extract(e.value,'$.cacheWrite'),
                     COALESCE(json_extract(e.value,'$.inputIncludesCache'), 0)
                   FROM history_sessions s, json_each(s.usage_json) e
                   WHERE json_valid(s.usage_json) AND json_extract(e.value,'$.id') IS NOT NULL
                     AND COALESCE(json_extract(e.value,'$.model'), s.model, '') <> '<synthetic>';
                 UPDATE history_sessions SET source_fingerprint = '';
                 PRAGMA user_version = 12;",
            )?;
            tx.commit()?;
        }
        if version < 13 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_history_list ON history_sessions
                   (favorite DESC, updated_at DESC, id, tool, native_id, title, cwd, model, project_id, started_at, partial, stale, message_count, usage_count);
                 CREATE INDEX IF NOT EXISTS idx_history_fingerprints ON history_sessions
                   (tool, source_key, source_fingerprint, stale);
                 PRAGMA user_version = 13;",
            )?;
            tx.commit()?;
        }
        if version < 14 {
            let tx = connection.transaction()?;
            tx.execute_batch(
                "CREATE TABLE usage_queries (
                   id TEXT PRIMARY KEY NOT NULL,
                   version INTEGER NOT NULL CHECK(version > 0),
                   generation INTEGER NOT NULL CHECK(generation > 0),
                   data TEXT NOT NULL
                 );
                 CREATE TABLE usage_credential_gc (
                   secret_ref TEXT PRIMARY KEY NOT NULL
                 );
                 PRAGMA user_version = 14;",
            )?;
            tx.commit()?;
        }
        if version < 15 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE usage_cache (query_id TEXT PRIMARY KEY NOT NULL REFERENCES usage_queries(id) ON DELETE CASCADE, generation INTEGER NOT NULL, data TEXT NOT NULL); PRAGMA user_version = 15;")?;
            tx.commit()?;
        }
        if version < 16 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE auth_accounts (id TEXT PRIMARY KEY NOT NULL, tool TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX idx_auth_accounts_tool ON auth_accounts(tool); CREATE UNIQUE INDEX idx_auth_accounts_context ON auth_accounts(json_extract(data, '$.context.id')) WHERE json_extract(data, '$.context.id') IS NOT NULL; PRAGMA user_version = 16;")?;
            tx.commit()?;
        }
        if version < 17 {
            let tx = connection.transaction()?;
            tx.execute_batch("ALTER TABLE applied_bindings ADD COLUMN context_id TEXT; PRAGMA user_version = 17;")?;
            tx.commit()?;
        }

        if version < 18 {
            let tx = connection.transaction()?;
            // Legacy aggregates have no proven call count. Reparse unchanged sources
            // on their next scan without dropping favorites or project associations.
            tx.execute_batch("ALTER TABLE history_usage ADD COLUMN request_count INTEGER;
                UPDATE history_sessions SET source_fingerprint = '';
                PRAGMA user_version = 18;")?;
            tx.commit()?;
        }

        if version < 19 {
            let tx = connection.transaction()?;
            // Native profile JSON now carries versioned editing intents. Legacy
            // values normalize at adapter-aware editing/import boundaries only.
            tx.execute_batch("PRAGMA user_version = 19;")?;
            tx.commit()?;
        }

        if version < 20 {
            let tx = connection.transaction()?;
            let columns = { let mut statement=tx.prepare("PRAGMA table_info(applied_bindings)")?;
                let rows=statement.query_map([],|row| row.get::<_,String>(1))?; rows.collect::<Result<Vec<_>,_>>()? };
            for (name,kind) in [("common_version","INTEGER"),("common_revision","TEXT"),("applied_profile","TEXT")] {
                if !columns.iter().any(|column|column==name) { tx.execute_batch(&format!("ALTER TABLE applied_bindings ADD COLUMN {name} {kind};"))?; }
            }
            tx.execute_batch("PRAGMA user_version = 20;")?;
            tx.commit()?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
            read_path: (path != Path::new(":memory:") && !path.as_os_str().is_empty()).then(|| path.to_owned()),
        })
    }

    /// An independent WAL snapshot lets history reports and session browsing
    /// run while the scanner commits batches on the shared writer connection.
    pub fn with_read_connection<T>(&self, action: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let Some(path) = &self.read_path else { return self.with_connection(|conn| action(conn)); };
        let mut conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| error.to_string())?;
        let snapshot = conn.transaction().map_err(|error| error.to_string())?;
        action(&snapshot)
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
    #[test]
    fn history_snapshot_does_not_block_writer_and_remains_consistent() {
        let temp = tempfile::tempdir().unwrap();
        let db = super::Database::open(&temp.path().join("snapshot.db")).unwrap();
        db.with_read_connection(|reader| {
            let count: i64 = reader.query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0)).unwrap();
            db.with_connection(|writer| {
                writer.execute("INSERT INTO app_settings VALUES ('snapshot-test', 'new')", []).unwrap();
                Ok(())
            })?;
            let unchanged: i64 = reader.query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0)).unwrap();
            assert_eq!(count, unchanged);
            assert!(reader.execute("DELETE FROM app_settings", []).is_err());
            Ok(())
        }).unwrap();
        db.with_read_connection(|reader| {
            assert_eq!(reader.query_row("SELECT value FROM app_settings WHERE key='snapshot-test'", [], |row| row.get::<_, String>(0)).unwrap(), "new");
            Ok(())
        }).unwrap();
    }
    use super::*;
    use crate::domain::{CliId, Theme};

    #[test]
    fn portable_tool_icons_survive_restart_theme_management_and_reset() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("icons.db");
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=";
        let db = Database::open(&path).unwrap();
        assert!(db.preferences().unwrap().tool_icons.is_empty());
        db.update_preferences(|p| { p.tool_icons.insert("future_cli".into(), image.into()); }).unwrap();
        db.update_preferences(|p| p.theme = Theme::Dark).unwrap();
        db.update_preferences(|p| p.set_managed(&[CliId::Pi])).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        let saved = db.preferences().unwrap();
        assert_eq!(saved.tool_icons["future_cli"], image);
        assert_eq!(saved.theme, Theme::Dark);
        assert_eq!(saved.managed_tools, [CliId::Pi]);
        db.update_preferences(|p| { p.tool_icons.remove("future_cli"); }).unwrap();
        assert!(db.preferences().unwrap().tool_icons.is_empty());
        assert_eq!(db.preferences().unwrap().theme, Theme::Dark);
    }

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
            assert_eq!(version, 20);
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM native_profiles", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            assert_eq!(count, 0);
            let history_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM history_sessions", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            assert_eq!(history_count, 0);
            let sync_count: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            assert_eq!(sync_count, 0);
            Ok(())
        })
        .unwrap();
    }
}
