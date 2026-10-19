//! MiMo Code memory integration, verified on the local machine (2026-10-19,
//! @mimo-ai/cli 0.1.15): markdown-backed cross-session memory under the data
//! root's `memory/` tree.
//!
//! Storage (embedded config.md, binary strings, and the live store under
//! `~/.local/share/mimocode/memory/`): the global scope keeps cross-project
//! user preferences in `memory/global/MEMORY.md` and each project keeps
//! `memory/projects/<id>/MEMORY.md` with `MEMORY-<topic>.md` spillover
//! siblings — topic extracts moved out of `MEMORY.md` to meet the token
//! budget. `<id>` is the UUID in `mimocode-project-id` inside the project's
//! git directory (a `.git` *file* resolves its gitdir two levels up, so
//! linked worktrees share the main repository's id); a project without git
//! keeps `.mimocode-project-id` at its root. The id file is only read here:
//! a project never opened by mimo has no memory identity and none is
//! invented for it. `MEMORY.md` is itself the memory (the session rebuild
//! reads it in full), not an index over topic files, so there is no index
//! upkeep to mirror; `memory/sessions/<sid>/` holds session checkpoints and
//! stays outside the resolved directories.
//!
//! Native reads back external writes (2026-10-19 probe: a marker line
//! written into `MEMORY.md` outside the CLI was quoted back by a native
//! `mimo run` agent reading the memory directory; the session-rebuild dump
//! also reads `MEMORY.md` straight from disk). The FTS search channel is
//! broken on this Windows machine for every file — the layout parser only
//! matches forward-slash paths, so the start-of-session reconcile skips all
//! backslash paths and `memory_fts` stays empty — which is why newly
//! created standalone files are not declared: nothing would point a native
//! session at them. There is no master switch and no per-item enable — the
//! only native switch `memory.disable_write` stops new native writes while
//! reads continue, which is not a usage toggle — so no switch operation is
//! published.

use std::fs;
use std::path::{Path, PathBuf};

use super::MiMoCode;
use crate::adapters::memory::{
    MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout, MemoryLayoutEntry,
    MemoryOperation, MemoryScope, MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;

const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
];
const PROJECT_TARGETS: &[MemoryTargetDimension] = &[MemoryTargetDimension::Project];

impl MemoryAdapter for MiMoCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: true,
                project: true,
            },
            targets: PROJECT_TARGETS,
            operations: OPERATIONS,
            unverified_reason: "",
            limitation: "MiMo Code 记忆无总开关与单条启停（memory.disable_write 仅停止原生新写入，读取不受影响），不提供启停；新建独立文件不在原生读取路径上（Windows 下 FTS 索引对反斜杠路径全部跳过），管理既有记忆文件即编辑或删除",
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        let root = super::data_root(home).join("memory");
        match scope {
            Scope::Global => Ok(root.join("global")),
            Scope::Project => {
                let project = project.ok_or("请选择项目目录")?;
                let id = project_id(project)?;
                Ok(root.join("projects").join(id))
            }
        }
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }
}

impl MemoryLayout for MiMoCode {
    /// The real markdown family in the resolved directory: `MEMORY.md` and
    /// its `MEMORY-<topic>.md` spillovers are all memory content.
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

    /// This family keeps no index over topic files; a save only touches the
    /// entry file itself and the native FTS indexer picks the change up by
    /// fingerprint on its next scan.
    fn index_after_save(
        &self,
        _directory: &Path,
        _id: &str,
        _text: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    fn index_after_delete(&self, _directory: &Path, _id: &str) -> Result<Option<MemoryFileChange>, String> {
        Ok(None)
    }

    /// Memory is always active: `MEMORY.md` is read on every session start
    /// and only `memory.disable_write` exists, which stops new native writes
    /// while reads continue — never a disabled store.
    fn switch_state(&self, _home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        Ok(MemorySwitchState {
            enabled: true,
            detail: String::new(),
        })
    }

    /// No native master switch exists; the declaration publishes none, so
    /// the engine never reaches this.
    fn switch_patch(
        &self,
        _home: &Path,
        _directory: &Path,
        _enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        Err("MiMo Code 记忆无总开关".into())
    }
}

/// Reads the native project memory id without ever writing one: a project
/// that has not been opened by mimo has no memory identity and no memory to
/// manage yet.
fn project_id(project: &Path) -> Result<String, String> {
    let file = identity_file(project);
    let text = fs::read_to_string(&file)
        .map_err(|_| "该项目还没有 MiMo 记忆标识，先用 mimo 打开该项目后再管理".to_owned())?;
    let id = text.trim();
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("该项目的 MiMo 记忆标识无效，请重试".into());
    }
    Ok(id.to_owned())
}

/// Native identity location (`mimocode-project-id` in the nearest git
/// directory; a worktree `.git` file points back at the main `.git`; without
/// git the id lives in `<project>/.mimocode-project-id`).
fn identity_file(project: &Path) -> PathBuf {
    if let Some(git) = git_directory(project) {
        return git.join("mimocode-project-id");
    }
    project.join(".mimocode-project-id")
}

fn git_directory(project: &Path) -> Option<PathBuf> {
    let mut current = Some(project);
    while let Some(directory) = current {
        let candidate = directory.join(".git");
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_dir() => return Some(candidate),
            // A `.git` file carries `gitdir: <path>`; native resolves it two
            // levels up, so linked worktrees share the main repository id.
            Ok(metadata) if metadata.is_file() => {
                let gitdir = fs::read_to_string(&candidate).ok().and_then(|text| {
                    text.trim()
                        .lines()
                        .find_map(|line| line.strip_prefix("gitdir:"))
                        .map(str::trim)
                        .filter(|dir| !dir.is_empty())
                        .map(str::to_owned)
                });
                return gitdir.and_then(|dir| {
                    Path::new(&dir)
                        .ancestors()
                        .nth(2)
                        .map(Path::to_path_buf)
                });
            }
            _ => {}
        }
        current = directory.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::memory::publish;

    #[test]
    fn declaration_publishes_file_management_without_create_or_switches() {
        let declaration = MiMoCode.declaration();
        assert_eq!(declaration.unverified_reason, "");
        let published = publish(&declaration).unwrap();
        assert!(published.scope.global && published.scope.project);
        assert_eq!(
            published.targets,
            vec![MemoryTargetDimension::Project],
            "范围内用项目维度选择目标"
        );
        for operation in [
            MemoryOperation::List,
            MemoryOperation::Open,
            MemoryOperation::Edit,
            MemoryOperation::Delete,
        ] {
            assert!(published.operations.contains(&operation), "{operation:?}");
        }
        assert!(
            !published.operations.contains(&MemoryOperation::Create),
            "新建独立文件不在原生读取路径上"
        );
        assert!(
            !published
                .operations
                .contains(&MemoryOperation::MasterSwitch),
            "无原生总开关"
        );
        assert!(!published.operations.contains(&MemoryOperation::ItemEnable));
        assert!(!published.limitation.is_empty());
        assert!(!declaration.binds_account);
    }

    #[test]
    fn directories_follow_the_official_global_and_project_layout() {
        let temp = tempfile::tempdir().unwrap();
        let root = super::super::data_root(temp.path()).join("memory");
        assert_eq!(
            MiMoCode.directory(Scope::Global, temp.path(), None).unwrap(),
            root.join("global")
        );
        let project = temp.path().join("repo");
        let git = project.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(
            git.join("mimocode-project-id"),
            "242f1d80-4457-460b-916f-799d3d3adb75",
        )
        .unwrap();
        assert_eq!(
            MiMoCode
                .directory(Scope::Project, temp.path(), Some(&project))
                .unwrap(),
            root.join("projects")
                .join("242f1d80-4457-460b-916f-799d3d3adb75")
        );
        // A nested directory inside the repository resolves through the
        // ancestor git chain to the same identity.
        let nested = project.join("src");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            MiMoCode
                .directory(Scope::Project, temp.path(), Some(&nested))
                .unwrap(),
            root.join("projects")
                .join("242f1d80-4457-460b-916f-799d3d3adb75")
        );
    }

    #[test]
    fn worktree_git_files_share_the_main_repository_identity() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let worktree = temp.path().join("wt");
        let git = main.join(".git");
        fs::create_dir_all(git.join("worktrees").join("wt")).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            git.join("mimocode-project-id"),
            "2aad88ae-3487-44ff-9994-ffbaabe3ce64",
        )
        .unwrap();
        fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                git.join("worktrees").join("wt").display()
            ),
        )
        .unwrap();
        let resolved = MiMoCode
            .directory(Scope::Project, temp.path(), Some(&worktree))
            .unwrap();
        assert!(resolved.ends_with("2aad88ae-3487-44ff-9994-ffbaabe3ce64"));
        assert!(!resolved.to_string_lossy().contains("worktrees"));
    }

    #[test]
    fn gitless_projects_fall_back_to_the_root_identity_file() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("plain");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join(".mimocode-project-id"), "local-id-1\n").unwrap();
        let resolved = MiMoCode
            .directory(Scope::Project, temp.path(), Some(&project))
            .unwrap();
        assert!(resolved.ends_with("local-id-1"));
    }

    #[test]
    fn projects_without_identity_or_with_invalid_identity_stay_unresolved() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("fresh");
        fs::create_dir_all(&project).unwrap();
        let error = MiMoCode
            .directory(Scope::Project, temp.path(), Some(&project))
            .unwrap_err();
        assert!(error.contains("先用 mimo"), "{error}");
        let git = project.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("mimocode-project-id"), "../escape\n").unwrap();
        assert!(MiMoCode
            .directory(Scope::Project, temp.path(), Some(&project))
            .is_err());
        assert!(MiMoCode
            .directory(Scope::Project, temp.path(), None)
            .is_err());
    }

    #[test]
    fn layout_lists_the_markdown_family_and_stays_index_and_switch_free() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("projects").join("id-1");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("MEMORY.md"), "# Project memory\n").unwrap();
        fs::write(
            directory.join("MEMORY-usage-report.md"),
            "# Spillover topic\n",
        )
        .unwrap();
        fs::write(directory.join("notes.txt"), "not markdown\n").unwrap();
        fs::create_dir_all(directory.join("tasks")).unwrap();
        let entries = MiMoCode.entries(&directory).unwrap();
        let mut ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["MEMORY", "MEMORY-usage-report"]);
        assert_eq!(
            MiMoCode.entry_path(&directory, "MEMORY-usage-report").unwrap(),
            directory.join("MEMORY-usage-report.md")
        );
        assert_eq!(MiMoCode.index_after_save(&directory, "MEMORY", "x").unwrap(), None);
        assert_eq!(
            MiMoCode.index_after_delete(&directory, "MEMORY").unwrap(),
            None
        );
        let state = MiMoCode.switch_state(temp.path(), &directory).unwrap();
        assert!(state.enabled);
        assert!(state.detail.is_empty());
        assert!(MiMoCode
            .switch_patch(temp.path(), &directory, false)
            .is_err());
        // An absent directory is an empty family, not an error.
        assert!(MiMoCode
            .entries(&temp.path().join("missing"))
            .unwrap()
            .is_empty());
    }
}
