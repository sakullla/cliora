//! Codex memory integration, verified on the local machine (2026-10-19,
//! codex-cli 0.163.0).
//!
//! Storage (isolated-home probes + the workspace codex itself maintains):
//! a single global git-managed markdown workspace at
//! `<CODEX_HOME>/memories/` with no project dimension. Its files are the
//! memory itself, not an index over separate topic files: `MEMORY.md` is the
//! `v1` searchable registry injected into sessions, `memory_summary.md` the
//! `v1` compact summary, and `raw_memories.md` the consolidation ingestion
//! queue; `extensions/ad_hoc/notes/*.md` hold authoritative ad-hoc notes.
//! `phase2_workspace_diff.md` is a transient pipeline artifact the native
//! docs forbid editing, so it is never an entry. The consolidation pipeline
//! regenerates the registry from raw inputs, so entries are read and edited
//! as the real file set and there is no index upkeep to mirror.
//!
//! Switch: `config.toml` `[features] memories` (verified default off in a
//! fresh home; `codex features enable/disable memories` writes exactly this
//! key, and an absent key means off). There is no per-entry native enable,
//! so item enable is not declared.

use std::fs;
use std::path::{Path, PathBuf};

use super::Codex;
use crate::adapters::memory::{
    MemoryAdapter, MemoryDeclaration, MemoryLayout, MemoryLayoutEntry, MemoryOperation,
    MemoryScope, MemoryStoreRef, MemorySwitchState,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;

const INDEXLESS_TRANSIENT: &str = "phase2_workspace_diff.md";
const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
    MemoryOperation::MasterSwitch,
];

fn codex_home(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("codex", || {
        std::env::var_os("CODEX_HOME")
            .map(Into::into)
            .unwrap_or_else(|| home.join(".codex"))
    })
}

fn settings_path(home: &Path) -> PathBuf {
    codex_home(home).join("config.toml")
}

impl MemoryAdapter for Codex {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: true,
                project: false,
            },
            targets: &[],
            operations: OPERATIONS,
            unverified_reason: "",
            limitation: "Codex 记忆为全局单目录（无项目维度、无单条启停、新建根级文件不进入原生读取，新增记忆即编辑 MEMORY.md/memory_summary.md）；总开关映射 config.toml 的 features.memories，默认关闭",
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        match scope {
            Scope::Global => Ok(codex_home(home).join("memories")),
            Scope::Project => Err("Codex 记忆是全局固定目录，没有项目维度".into()),
        }
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }

    /// Read-only: the single global workspace, reported only when present.
    fn existing_stores(&self, home: &Path) -> Vec<MemoryStoreRef> {
        let directory = codex_home(home).join("memories");
        if crate::adapters::memory::store_present(&directory) {
            vec![MemoryStoreRef {
                scope: Scope::Global,
                project_path: None,
                label: "全局".to_owned(),
                directory,
            }]
        } else {
            Vec::new()
        }
    }
}

impl MemoryLayout for Codex {
    /// The real markdown family at the workspace root. This store has no
    /// index over topic files — `MEMORY.md` is itself the memory registry
    /// and is therefore a manageable entry, while the pipeline's transient
    /// diff file is not.
    fn entries(&self, directory: &Path) -> Result<Vec<MemoryLayoutEntry>, String> {
        let read = match fs::read_dir(directory) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Vec::new());
            }
            Err(_) => return Err("无法列出记忆，请重试".into()),
        };
        let mut entries = Vec::new();
        for item in read {
            let item = item.map_err(|_| "无法列出记忆，请重试".to_owned())?;
            if !item
                .file_type()
                .map_err(|_| "无法列出记忆，请重试".to_owned())?
                .is_file()
            {
                continue;
            }
            let name = item.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name == INDEXLESS_TRANSIENT {
                continue;
            }
            let Some(id) = name.strip_suffix(".md") else {
                continue;
            };
            entries.push(MemoryLayoutEntry {
                id: id.to_owned(),
                path: item.path(),
            });
        }
        // Filesystem enumeration order differs across platforms.
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(entries)
    }

    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String> {
        Ok(directory.join(format!("{id}.md")))
    }

    /// No index over topic files exists in this family; saves only touch the
    /// entry file itself.
    fn index_after_save(
        &self,
        _directory: &Path,
        _id: &str,
        _text: &str,
    ) -> Result<Option<crate::adapters::memory::MemoryFileChange>, String> {
        Ok(None)
    }

    fn index_after_delete(
        &self,
        _directory: &Path,
        _id: &str,
    ) -> Result<Option<crate::adapters::memory::MemoryFileChange>, String> {
        Ok(None)
    }

    /// One user-level setting governs every store of this CLI.
    fn switch_shared(&self) -> bool {
        true
    }

    /// Verified default: the feature is off unless `[features] memories` is
    /// explicitly true (`codex features list` reports false in a fresh home
    /// and an absent key behaves as disabled).
    fn switch_state(&self, home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        let path = settings_path(home);
        let text = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
        if text.trim().is_empty() {
            return Ok(MemorySwitchState {
                enabled: false,
                detail: String::new(),
            });
        }
        let parsed = format::parse(FileKind::Toml, &text)
            .map_err(|_| "无法读取记忆总开关，请重试".to_owned())?;
        let enabled = parsed
            .get("features")
            .and_then(|features| features.get("memories"))
            == Some(&serde_json::Value::Bool(true));
        Ok(MemorySwitchState {
            enabled,
            detail: String::new(),
        })
    }

    /// Mirrors `codex features enable/disable memories`: enable writes
    /// `memories = true` under `[features]`; disable removes the key (the
    /// native command leaves an empty table, removal is TOML-equivalent and
    /// keeps the verified default off).
    fn switch_patch(
        &self,
        home: &Path,
        _directory: &Path,
        enabled: bool,
    ) -> Result<Option<crate::adapters::memory::MemoryFileChange>, String> {
        let path = settings_path(home);
        let current = transaction::read_native(&path)
            .map_err(|error| format!("无法保存记忆总开关，请重试：{error}"))?;
        let updated = format::set_path(
            FileKind::Toml,
            &current,
            &["features".to_owned(), "memories".to_owned()],
            enabled.then(|| &serde_json::Value::Bool(true)),
        )
        .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?;
        if updated == current {
            return Ok(None);
        }
        let baseline = if path.exists() { Some(current) } else { None };
        Ok(Some(crate::adapters::memory::MemoryFileChange {
            path,
            baseline,
            contents: Some(updated),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::memory::MemoryFileChange;
    use crate::adapters::Registry;
    use crate::credentials::CredentialStore;
    use crate::resources::memory::{
        list_memories, save_memory, set_memory_enabled, MemoryEnable, MemorySave, MemoryTarget,
    };

    struct MapStore(std::sync::Mutex<std::collections::HashMap<String, String>>);
    impl CredentialStore for MapStore {
        fn put(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn get(&self, key: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn engine_roundtrip_on_the_verified_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let workspace = home.join(".codex").join("memories");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            home.join(".codex").join("config.toml"),
            "[features]\nmemories = true\n",
        )
        .unwrap();
        fs::write(
            workspace.join("MEMORY.md"),
            "v1\n\n## User preferences\n- old\n",
        )
        .unwrap();
        fs::write(
            workspace.join("memory_summary.md"),
            "v1\n\n## What.s in Memory\n- old\n",
        )
        .unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = Registry::builtins();
        let store = MapStore(std::sync::Mutex::new(std::collections::HashMap::new()));
        let target = MemoryTarget {
            tool_id: "codex".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
            store_directory: None,
        };
        // The engine lists the real family with the native switch already on.
        let list = list_memories(&db, &registry, &home, &target).unwrap();
        assert!(list.in_use);
        let ids: Vec<&str> = list.entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["MEMORY", "memory_summary"]);
        // An edit through the shared engine rewrites the real file and never
        // leaves engine-private records in the native workspace.
        let saved = save_memory(
            &db,
            &store,
            &registry,
            &home,
            &MemorySave {
                target: target.clone(),
                id: "MEMORY".into(),
                text: "v1\n\n## User preferences\n- new\n".into(),
                baseline: "v1\n\n## User preferences\n- old\n".into(),
                confirm_external: false,
            },
        )
        .unwrap();
        assert!(saved.path.ends_with(
            workspace
                .join("MEMORY.md")
                .file_name()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        ));
        assert_eq!(
            fs::read_to_string(workspace.join("MEMORY.md")).unwrap(),
            "v1\n\n## User preferences\n- new\n"
        );
        // The master switch maps to the verified config key, not a marker file.
        set_memory_enabled(
            &db,
            &store,
            &registry,
            &home,
            &MemoryEnable {
                target: target.clone(),
                id: None,
                enabled: false,
            },
        )
        .unwrap();
        let config = fs::read_to_string(home.join(".codex").join("config.toml")).unwrap();
        assert!(!config.contains("memories"));
        assert!(
            !list_memories(&db, &registry, &home, &target)
                .unwrap()
                .in_use
        );
        set_memory_enabled(
            &db,
            &store,
            &registry,
            &home,
            &MemoryEnable {
                target: target.clone(),
                id: None,
                enabled: true,
            },
        )
        .unwrap();
        assert!(fs::read_to_string(home.join(".codex").join("config.toml"))
            .unwrap()
            .contains("memories = true"));
        for name in fs::read_dir(&workspace).unwrap().flatten() {
            let name = name.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(".cliora-"),
                "{name} leaked into the native store"
            );
        }
    }

    #[test]
    fn declaration_publishes_the_verified_surface() {
        let declaration = Codex.declaration();
        assert!(declaration.unverified_reason.is_empty());
        assert!(declaration.scope.global);
        assert!(!declaration.scope.project);
        assert!(!declaration.binds_account);
        assert_eq!(declaration.operations, OPERATIONS);
        assert!(!declaration
            .operations
            .contains(&MemoryOperation::ItemEnable));
        assert!(!declaration.operations.contains(&MemoryOperation::Create));
        assert!(!declaration.limitation.is_empty());
        assert!(crate::adapters::memory::publish(&declaration).is_some());
    }

    #[test]
    fn directory_resolves_the_global_workspace_only() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        assert_eq!(
            Codex.directory(Scope::Global, &home, None).unwrap(),
            home.join(".codex").join("memories")
        );
        let project = temp.path().join("project");
        assert_eq!(
            Codex
                .directory(Scope::Global, &home, Some(&project))
                .unwrap(),
            home.join(".codex").join("memories")
        );
        assert!(Codex
            .directory(Scope::Project, &home, Some(&project))
            .unwrap_err()
            .contains("没有项目维度"));
    }

    #[test]
    fn layout_lists_the_real_family_without_the_transient_diff() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memories");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("MEMORY.md"), "v1\n").unwrap();
        fs::write(directory.join("memory_summary.md"), "v1\n").unwrap();
        fs::write(directory.join("raw_memories.md"), "# Raw Memories\n").unwrap();
        fs::write(directory.join("phase2_workspace_diff.md"), "do not edit").unwrap();
        fs::write(directory.join("notes.txt"), "ignored").unwrap();
        fs::create_dir_all(directory.join("rollout_summaries")).unwrap();
        let entries = Codex.entries(&directory).unwrap();
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, ["MEMORY", "memory_summary", "raw_memories"]);
        assert_eq!(
            Codex.entry_path(&directory, "MEMORY").unwrap(),
            directory.join("MEMORY.md")
        );
        assert!(Codex
            .entries(&temp.path().join("missing"))
            .unwrap()
            .is_empty());
        // No index upkeep in this family.
        assert!(Codex
            .index_after_save(&directory, "MEMORY", "text")
            .unwrap()
            .is_none());
        assert!(Codex
            .index_after_delete(&directory, "MEMORY")
            .unwrap()
            .is_none());
    }

    #[test]
    fn switch_maps_the_verified_config_key() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings = home.join(".codex").join("config.toml");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        // Verified default off: a fresh home has no key and stays disabled.
        let state = Codex.switch_state(&home, Path::new("/unused")).unwrap();
        assert!(!state.enabled);
        // Enabling creates `[features] memories = true`.
        let enable = Codex
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .unwrap();
        assert_eq!(enable.baseline, None);
        let contents = enable.contents.unwrap();
        assert!(contents.contains("[features]"));
        assert!(contents.contains("memories = true"));
        fs::write(&settings, &contents).unwrap();
        assert!(
            Codex
                .switch_state(&home, Path::new("/unused"))
                .unwrap()
                .enabled
        );
        assert!(Codex
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .is_none());
        // Disabling removes the key (native `codex features disable`) and an
        // unrelated config survives both directions.
        fs::write(
            &settings,
            "model = \"gpt-6-astra\"\n\n[features]\nmemories = true\nimage_generation = true\n",
        )
        .unwrap();
        let disable = Codex
            .switch_patch(&home, Path::new("/unused"), false)
            .unwrap()
            .unwrap();
        let disabled_text = disable.contents.unwrap();
        assert!(disabled_text.contains("model = \"gpt-6-astra\""));
        assert!(disabled_text.contains("image_generation = true"));
        assert!(!disabled_text.contains("memories = true"));
        fs::write(&settings, disabled_text).unwrap();
        assert!(
            !Codex
                .switch_state(&home, Path::new("/unused"))
                .unwrap()
                .enabled
        );
        // An unrelated `[features]` value that is not true still means off.
        fs::write(&settings, "[features]\nmemories = false\n").unwrap();
        assert!(
            !Codex
                .switch_state(&home, Path::new("/unused"))
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn switch_change_shape_matches_the_shared_transaction() {
        let path = Path::new("/x/config.toml");
        let change = MemoryFileChange {
            path: path.to_path_buf(),
            baseline: Some("old".into()),
            contents: Some("[features]\nmemories = true\n".into()),
        };
        assert_eq!(change.path, path);
        assert_eq!(change.baseline.as_deref(), Some("old"));
    }
}
