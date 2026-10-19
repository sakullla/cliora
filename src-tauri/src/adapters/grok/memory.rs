//! Grok memory integration, verified on the local machine (2026-10-19, grok
//! 1.0.62 plus the bundled official user guide `docs/user-guide/13-memory.md`
//! and on-disk samples). Native cross-session memory lives under
//! `<grok home>/memory-v2` as a global scope and one workspace scope per
//! repository; clones share the workspace. The editable family is the curated
//! `topics/*.md` directory both scopes read at session start, so the storage
//! directory resolves to `topics` and every entry is one topic file. The
//! scope's `MEMORY.md` is a generated index the product owns ("Do not edit
//! this file directly" — Grok regenerates it), so no index upkeep runs here,
//! and the SQLite state files stay untouched.
//!
//! The workspace slug is `<repo>-<hash>` (for example `cliora-490670fe`,
//! `self-workflow-53a3449c`); the hash is not derivable from the repository
//! identity (not a plain hash of the remote URL or `owner/name` under md5/
//! sha/crc/fnv/xxhash/siphash variants), so the project directory is matched
//! by lowercased project name among the workspaces Grok itself created, and a
//! repository Grok never opened reports no directory.
//!
//! Switch: native config.toml `[memory] enabled` (experimental, default
//! off); `[memory_v2] enabled` wins when both are set, so both the read and
//! the write side target whichever table currently governs (writes only
//! create `[memory_v2]` when the config already carries that table). There
//! is no per-topic native enable, so item enable is not declared. Per-run
//! overrides (`--no-memory`, `GROK_MEMORY`) belong to the launched process
//! and are not part of this switch.
use std::fs;
use std::path::{Path, PathBuf};

use super::Grok;
use crate::adapters::memory::{
    MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout, MemoryLayoutEntry,
    MemoryOperation, MemoryScope, MemoryStoreRef, MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;

const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Create,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
    MemoryOperation::MasterSwitch,
];
const TARGETS: &[MemoryTargetDimension] = &[MemoryTargetDimension::Project];

fn grok_home(home: &Path) -> PathBuf {
    std::env::var_os("GROK_HOME")
        .map(Into::into)
        .unwrap_or_else(|| home.join(".grok"))
}

fn config_path(home: &Path) -> PathBuf {
    grok_home(home).join("config.toml")
}

/// The effective switch value plus the table that governs it: `enabled`
/// under `[memory_v2]` when that table carries a boolean, else under
/// `[memory]`; absent or non-boolean keeps memory off (the documented
/// default). Writes must target the same governing table, otherwise grok's
/// precedence would ignore them.
fn memory_enabled(text: &str) -> Result<(Option<bool>, &'static str), String> {
    if text.trim().is_empty() {
        return Ok((None, "memory"));
    }
    let parsed = format::parse(FileKind::Toml, text)
        .map_err(|_| "无法读取记忆总开关，请重试".to_owned())?;
    let flag = |table: &str| {
        parsed
            .get(table)
            .and_then(|memory| memory.get("enabled"))
            .and_then(|value| value.as_bool())
    };
    match flag("memory_v2") {
        Some(value) => Ok((Some(value), "memory_v2")),
        None => Ok((flag("memory"), "memory")),
    }
}

impl MemoryAdapter for Grok {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: true,
                project: true,
            },
            targets: TARGETS,
            operations: OPERATIONS,
            unverified_reason: "",
            limitation: "Grok 无单条记忆启停；总开关映射 config.toml 的 [memory] enabled（实验特性，默认关闭；[memory_v2] enabled 并存时读写均以该键为准），单条管理即编辑或删除主题文件",
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        let root = grok_home(home).join("memory-v2");
        match scope {
            Scope::Global => Ok(root.join("global").join("topics")),
            Scope::Project => workspace_topics(&root, project),
        }
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }

    /// Read-only: the global `topics` and every workspace-shaped
    /// `workspaces/<name>-<hash>/topics`. The workspace slug (including its
    /// hash suffix) is the label; the hash is not derivable from a project
    /// identity, so `project_path` stays `None`.
    fn existing_stores(&self, home: &Path) -> Vec<MemoryStoreRef> {
        let root = grok_home(home).join("memory-v2");
        let mut stores = Vec::new();
        let global = root.join("global").join("topics");
        if crate::adapters::memory::store_present(&global) {
            stores.push(MemoryStoreRef {
                scope: Scope::Global,
                project_path: None,
                label: "全局".to_owned(),
                directory: global,
            });
        }
        if let Ok(read) = fs::read_dir(root.join("workspaces")) {
            for entry in read.flatten() {
                if !crate::adapters::memory::store_present(&entry.path()) {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if slug_prefix(&name).is_none() {
                    continue;
                }
                let directory = entry.path().join("topics");
                if !crate::adapters::memory::store_present(&directory) {
                    continue;
                }
                stores.push(MemoryStoreRef {
                    scope: Scope::Project,
                    project_path: None,
                    label: name,
                    directory,
                });
            }
        }
        stores
    }
}

impl MemoryLayout for Grok {
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
            let Some(id) = name.strip_suffix(".md") else {
                continue;
            };
            entries.push(MemoryLayoutEntry {
                id: id.to_owned(),
                path: item.path(),
            });
        }
        Ok(entries)
    }

    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String> {
        Ok(directory.join(format!("{id}.md")))
    }

    /// Grok regenerates each scope's `MEMORY.md` index itself; the shared
    /// store never edits it.
    fn index_after_save(
        &self,
        _directory: &Path,
        _id: &str,
        _text: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    fn index_after_delete(
        &self,
        _directory: &Path,
        _id: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    fn switch_state(&self, home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        let path = config_path(home);
        let mut governed = "memory";
        let mut flag = None;
        if path.exists() {
            let text = transaction::read_native(&path)
                .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
            let read = memory_enabled(&text)?;
            flag = Some(read.0);
            governed = read.1;
        }
        let enabled = flag.flatten().unwrap_or(false);
        Ok(MemorySwitchState {
            enabled,
            detail: if enabled {
                String::new()
            } else {
                format!("Grok 记忆未开启，在 config.toml [{governed}] enabled 开启")
            },
        })
    }

    fn switch_patch(
        &self,
        home: &Path,
        _directory: &Path,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        let path = config_path(home);
        let current = if path.exists() {
            Some(
                transaction::read_native(&path)
                    .map_err(|error| format!("无法保存记忆总开关，请重试：{error}"))?,
            )
        } else {
            None
        };
        let text = current.as_deref().unwrap_or("");
        let governed = memory_enabled(text)
            .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?
            .1;
        let updated = format::set_path(
            FileKind::Toml,
            text,
            &[governed.to_owned(), "enabled".to_owned()],
            Some(&serde_json::Value::Bool(enabled)),
        )
        .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?;
        if current.as_deref() == Some(updated.as_str()) {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            path,
            baseline: current,
            contents: Some(updated),
        }))
    }
}

/// Matches `<workspaces>/<lowercased project name>-<8 hex>` among the
/// directories Grok created. Clones of one repository share a single
/// workspace; two repositories with the same name stay ambiguous.
fn workspace_topics(root: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
    let Some(project) = project else {
        return Err("Grok 的项目记忆需要项目目录".into());
    };
    let Some(name) = project.file_name().and_then(|name| name.to_str()) else {
        return Err("无法识别项目目录名，请重试".into());
    };
    let name = name.to_lowercase();
    let workspaces = root.join("workspaces");
    let read = std::fs::read_dir(&workspaces)
        .map_err(|_| "Grok 记忆工作区尚不存在，请先在项目中运行 Grok 后重试".to_owned())?;
    let mut matches: Vec<PathBuf> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|_| "无法读取 Grok 记忆工作区，请重试".to_owned())?;
        if !entry
            .file_type()
            .map_err(|_| "无法读取 Grok 记忆工作区，请重试".to_owned())?
            .is_dir()
        {
            continue;
        }
        let file_name = entry.file_name();
        let Some(entry_name) = file_name.to_str() else {
            continue;
        };
        if slug_prefix(entry_name) == Some(name.as_str()) {
            matches.push(entry.path());
        }
    }
    match matches.len() {
        0 => Err(format!(
            "Grok 尚未为 {name} 创建记忆工作区，请先在项目中运行 Grok 后重试"
        )),
        1 => Ok(matches.remove(0).join("topics")),
        _ => Err(format!(
            "Grok 记忆中存在多个名为 {name} 的工作区，无法自动选择，请在 Grok 中确认后重试"
        )),
    }
}

/// The repository part of a Grok workspace slug, when the entry name has the
/// `<name>-<8 lowercase hex>` shape (`self-workflow-53a3449c` keeps the inner
/// hyphen in the name).
fn slug_prefix(entry: &str) -> Option<&str> {
    let (prefix, suffix) = entry.rsplit_once('-')?;
    let prefix_ok = !prefix.is_empty()
        && prefix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let suffix_ok = suffix.len() == 8
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    prefix_ok.then_some(prefix).filter(|_| suffix_ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declaration_publishes_the_topic_family_with_the_native_switch_only() {
        let declaration = Grok.declaration();
        assert!(declaration.unverified_reason.is_empty());
        assert!(declaration.scope.global && declaration.scope.project);
        assert_eq!(declaration.targets, TARGETS);
        assert_eq!(declaration.operations, OPERATIONS);
        assert!(declaration.operations.contains(&MemoryOperation::MasterSwitch));
        assert!(!declaration.operations.contains(&MemoryOperation::ItemEnable));
        assert!(!declaration.binds_account);
        assert!(declaration.limitation.contains("[memory] enabled"));
        let published = crate::adapters::memory::publish(&declaration).unwrap();
        assert_eq!(published.operations, OPERATIONS);
    }

    #[test]
    fn global_scope_resolves_to_the_global_topics_directory() {
        let expected = std::env::var_os("GROK_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/home/example/.grok"))
            .join("memory-v2/global/topics");
        assert_eq!(
            Grok.directory(Scope::Global, Path::new("/home/example"), None).unwrap(),
            expected
        );
    }

    #[test]
    fn project_scope_matches_the_workspace_grok_created() {
        let root = tempfile::tempdir().unwrap();
        let workspaces = root.path().join("workspaces");
        std::fs::create_dir_all(workspaces.join("cliora-490670fe").join("topics")).unwrap();
        std::fs::create_dir_all(workspaces.join("cliora-notes-00000000")).unwrap();
        std::fs::create_dir_all(workspaces.join("other-490670fe")).unwrap();
        std::fs::create_dir_all(workspaces.join("cliora-not-a-hash")).unwrap();
        let resolved = workspace_topics(root.path(), Some(Path::new("/work/CLIORA")));
        assert_eq!(
            resolved.unwrap(),
            workspaces.join("cliora-490670fe").join("topics")
        );
    }

    #[test]
    fn project_scope_reports_missing_and_ambiguous_workspaces() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("workspaces")).unwrap();
        let error = workspace_topics(root.path(), Some(Path::new("/work/new"))).unwrap_err();
        assert!(error.contains("尚未为 new 创建记忆工作区"), "{error}");

        let workspaces = root.path().join("workspaces");
        std::fs::create_dir_all(workspaces.join("api-00000001")).unwrap();
        std::fs::create_dir_all(workspaces.join("api-00000002")).unwrap();
        let error =
            workspace_topics(root.path(), Some(Path::new("/org/api"))).unwrap_err();
        assert!(error.contains("多个名为 api"), "{error}");

        assert_eq!(
            workspace_topics(root.path(), None).unwrap_err(),
            "Grok 的项目记忆需要项目目录"
        );
    }

    #[test]
    fn slug_prefix_accepts_only_lowercase_name_and_hex_hash() {
        assert_eq!(slug_prefix("cliora-490670fe"), Some("cliora"));
        assert_eq!(slug_prefix("self-workflow-53a3449c"), Some("self-workflow"));
        assert_eq!(slug_prefix("rillsql-1f1de9e6"), Some("rillsql"));
        assert_eq!(slug_prefix("cliora-490670FE"), None);
        assert_eq!(slug_prefix("cliora-490670f"), None);
        assert_eq!(slug_prefix("cliora-not-a-hash"), None);
        assert_eq!(slug_prefix("SampleApp-b1bf8dfd"), None);
        assert_eq!(slug_prefix("490670fe"), None);
    }

    #[test]
    fn layout_lists_topic_files_and_keeps_the_generated_index_out() {
        let root = tempfile::tempdir().unwrap();
        let topics = root.path().join("topics");
        std::fs::create_dir_all(&topics).unwrap();
        std::fs::write(topics.join("debugging.md"), "note").unwrap();
        std::fs::write(topics.join("ignore.txt"), "note").unwrap();
        let entries = Grok.entries(&topics).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "debugging");
        assert_eq!(entries[0].path, topics.join("debugging.md"));
        assert_eq!(
            Grok.entry_path(&topics, "debugging").unwrap(),
            topics.join("debugging.md")
        );
        assert_eq!(
            Grok.index_after_save(&topics, "debugging", "note").unwrap(),
            None
        );
        assert_eq!(Grok.index_after_delete(&topics, "debugging").unwrap(), None);
    }

    #[test]
    fn switch_state_follows_memory_v2_over_memory_and_defaults_off() {
        if std::env::var_os("GROK_HOME").is_some() {
            // The resolution path is env-sensitive; the local GROK_HOME would
            // redirect the config lookup outside this temp home.
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".grok")).unwrap();
        std::fs::write(
            home.path().join(".grok/config.toml"),
            "[memory]\nenabled = true\n",
        )
        .unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(state.enabled);
        assert!(state.detail.is_empty());

        std::fs::write(
            home.path().join(".grok/config.toml"),
            "[memory]\nenabled = true\n[memory_v2]\nenabled = false\n",
        )
        .unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(!state.enabled);
        assert!(
            state.detail.contains("[memory_v2] enabled"),
            "{}",
            state.detail
        );

        std::fs::write(
            home.path().join(".grok/config.toml"),
            "[memory]\nenabled = false\n[memory_v2]\nenabled = true\n",
        )
        .unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(state.enabled);
        assert!(state.detail.is_empty());

        std::fs::write(
            home.path().join(".grok/config.toml"),
            "[memory]\nenabled = false\n",
        )
        .unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(!state.enabled);
        assert!(
            state.detail.contains("[memory] enabled"),
            "{}",
            state.detail
        );

        std::fs::remove_file(home.path().join(".grok/config.toml")).unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(!state.enabled);
    }

    #[test]
    fn switch_patch_sets_memory_enabled_and_preserves_other_keys() {
        if std::env::var_os("GROK_HOME").is_some() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".grok")).unwrap();
        let config = home.path().join(".grok/config.toml");
        std::fs::write(&config, "[models]\ndefault = \"grok-4\"\n").unwrap();
        let change = Grok
            .switch_patch(home.path(), Path::new("/unused"), true)
            .unwrap()
            .expect("应产生修改");
        assert_eq!(change.path, config);
        assert_eq!(change.baseline.as_deref(), Some("[models]\ndefault = \"grok-4\"\n"));
        let updated = change.contents.unwrap();
        let parsed = format::parse(FileKind::Toml, &updated).unwrap();
        assert!(parsed.get("memory_v2").is_none());
        assert_eq!(
            parsed.get("memory").unwrap().get("enabled"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            parsed.get("models").unwrap().get("default"),
            Some(&serde_json::Value::String("grok-4".into()))
        );

        std::fs::write(&config, &updated).unwrap();
        assert!(Grok
            .switch_patch(home.path(), Path::new("/unused"), true)
            .unwrap()
            .is_none());
    }

    #[test]
    fn switch_patch_writes_the_memory_v2_key_when_that_table_governs() {
        if std::env::var_os("GROK_HOME").is_some() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".grok")).unwrap();
        let config = home.path().join(".grok/config.toml");
        // memory_v2=false governs: enabling must flip the governing key and
        // not report a no-op just because [memory] is already true.
        std::fs::write(&config, "[memory]\nenabled = true\n[memory_v2]\nenabled = false\n")
            .unwrap();
        let change = Grok
            .switch_patch(home.path(), Path::new("/unused"), true)
            .unwrap()
            .expect("memory_v2 关闭时打开总开关应改写生效键");
        let updated = change.contents.unwrap();
        let parsed = format::parse(FileKind::Toml, &updated).unwrap();
        assert_eq!(
            parsed.get("memory_v2").unwrap().get("enabled"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(
            parsed.get("memory").unwrap().get("enabled"),
            Some(&serde_json::Value::Bool(true))
        );
        std::fs::write(&config, &updated).unwrap();
        assert!(Grok.switch_state(home.path(), Path::new("/unused")).unwrap().enabled);

        // memory_v2=true governs: disabling must flip the governing key, and
        // the stale [memory] flag must not resurrect memory.
        std::fs::write(&config, "[memory]\nenabled = true\n[memory_v2]\nenabled = true\n")
            .unwrap();
        let change = Grok
            .switch_patch(home.path(), Path::new("/unused"), false)
            .unwrap()
            .expect("memory_v2 开启时关闭总开关应改写生效键");
        let updated = change.contents.unwrap();
        let parsed = format::parse(FileKind::Toml, &updated).unwrap();
        assert_eq!(
            parsed.get("memory_v2").unwrap().get("enabled"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            parsed.get("memory").unwrap().get("enabled"),
            Some(&serde_json::Value::Bool(true))
        );
        std::fs::write(&config, &updated).unwrap();
        let state = Grok.switch_state(home.path(), Path::new("/unused")).unwrap();
        assert!(!state.enabled);
        assert!(state.detail.contains("[memory_v2] enabled"));

        std::fs::write(&config, &updated).unwrap();
        assert!(Grok
            .switch_patch(home.path(), Path::new("/unused"), false)
            .unwrap()
            .is_none());
    }
}
