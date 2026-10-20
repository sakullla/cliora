//! Claude Code memory integration, verified on the local machine
//! (2026-10-19, Claude Code 2.1.303 npm channel).
//!
//! Storage (on-disk samples under `~/.claude/projects` plus live probes in a
//! scratch project): project memory under
//! `~/.claude/projects/<slug>/memory/` where the slug replaces every
//! character outside `[a-zA-Z0-9]` of the absolute cwd with `-` (runs are
//! NOT collapsed — `C:\Users` becomes `C--Users`; no case folding; over 200
//! chars it is cut at 200 and suffixed with the djb2 signed-int32 base36
//! digest of the original path, bundle `s0`/`Te`/`Ede`). Each directory is a
//! `MEMORY.md` index plus topic files; index lines read
//! `- [title](file.md) — description` and `MEMORY.md` is never an entry.
//! Probes confirmed Claude reads title-only lines and topic files without
//! frontmatter.
//!
//! Relocation: `autoMemoryDirectory` (bundle `nm`/`Zg`) is honored from
//! `.claude/settings.local.json`, checked-in `.claude/settings.json`, then
//! the user `settings.json` — first defined value wins. Only a `~/…`,
//! POSIX-absolute, or forward-slash Windows-absolute value relocates; a
//! backslash absolute path or a bare folder name is silently ignored and the
//! default slug directory stays in use (probed). The value IS the memory
//! folder (flat `MEMORY.md` + topics, no slug segment).
//!
//! Switch: `autoMemoryEnabled` in the user `settings.json`, default enabled
//! when absent; only an explicit `false` disables. Verified live: user-level
//! write flips new-session behavior both ways, and project-level
//! `.claude/settings*.json` values override the user file for reading
//! (local before checked-in before user); those project files are outside
//! this management switch and stay user-owned. There is no per-entry native
//! enable, so item enable is not declared.

use std::fs;
use std::path::{Path, PathBuf};

use super::Claude;
use crate::adapters::memory::{
    MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout, MemoryLayoutEntry,
    MemoryOperation, MemoryScope, MemoryStoreRef, MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;

const INDEX_FILE: &str = "MEMORY.md";
const INDEX_HEADER: &str = "# Memory Index";
const SWITCH_KEY: &str = "autoMemoryEnabled";
const DIRECTORY_KEY: &str = "autoMemoryDirectory";
const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Create,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
    MemoryOperation::MasterSwitch,
];

fn config_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("claude_code", || home.join(".claude"))
}

impl MemoryAdapter for Claude {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: false,
                project: true,
            },
            targets: &[MemoryTargetDimension::Project],
            operations: OPERATIONS,
            unverified_reason: "",
            limitation: "Claude Code 无单条记忆启停；总开关映射用户级 settings.json 的 \
                         autoMemoryEnabled，项目目录 .claude 下的同名键覆盖不在此处改写",
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        if scope != Scope::Project {
            return Err("Claude Code 记忆按项目存储，请选择项目目录".into());
        }
        let project = project.ok_or("请选择项目目录")?;
        if let Some(relocated) = auto_memory_directory(home, project) {
            return Ok(relocated);
        }
        Ok(config_root(home)
            .join("projects")
            .join(project_slug(project))
            .join("memory"))
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }

    /// Read-only: every `projects/<slug>/memory` on disk plus the relocated
    /// root when the user-level `autoMemoryDirectory` points at a usable
    /// value. Project-local relocations are per-project settings and are not
    /// enumerable without a project, so only the user-level root is listed.
    /// The slug is the only on-disk identity, so `project_path` stays `None`;
    /// the label is the project directory a session transcript beside the
    /// store recorded when its slug matches, else the slug itself.
    fn existing_stores(&self, home: &Path) -> Vec<MemoryStoreRef> {
        let mut stores = Vec::new();
        let root = config_root(home);
        if let Some(value) = directory_setting(&root.join("settings.json")) {
            if let Some(relocated) = accepted_memory_directory(&value, home) {
                if crate::adapters::memory::store_present(&relocated) {
                    stores.push(MemoryStoreRef {
                        scope: Scope::Project,
                        project_path: None,
                        label: "改址根".to_owned(),
                        directory: relocated,
                    });
                }
            }
        }
        if let Ok(read) = fs::read_dir(root.join("projects")) {
            for entry in read.flatten() {
                if !crate::adapters::memory::store_present(&entry.path()) {
                    continue;
                }
                let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let directory = entry.path().join("memory");
                if !crate::adapters::memory::store_present(&directory) {
                    continue;
                }
                let label = recorded_project(&entry.path(), &slug).unwrap_or(slug);
                stores.push(MemoryStoreRef {
                    scope: Scope::Project,
                    project_path: None,
                    label,
                    directory,
                });
            }
        }
        stores
    }
}

impl MemoryLayout for Claude {
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
            if name == INDEX_FILE {
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
        Ok(entries)
    }

    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String> {
        Ok(directory.join(format!("{id}.md")))
    }

    fn index_after_save(
        &self,
        directory: &Path,
        id: &str,
        text: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        let path = directory.join(INDEX_FILE);
        let current = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆索引，请重试：{error}"))?;
        let line = index_line(id, text);
        let updated = if current.trim().is_empty() {
            format!("{INDEX_HEADER}\n\n{line}\n")
        } else {
            replace_index_line(&current, id, Some(&line))?
        };
        if Some(updated.clone()) == current_if_exists(&path)? {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            baseline: current_if_exists(&path)?,
            path,
            contents: Some(updated),
        }))
    }

    fn index_after_delete(
        &self,
        directory: &Path,
        id: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        let path = directory.join(INDEX_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let current = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆索引，请重试：{error}"))?;
        let updated = replace_index_line(&current, id, None)?;
        if updated == current {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            path,
            baseline: Some(current),
            contents: Some(updated),
        }))
    }

    /// One user-level setting governs every store of this CLI.
    fn switch_shared(&self) -> bool {
        true
    }

    fn switch_state(&self, home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        let path = config_root(home).join("settings.json");
        let text = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
        if text.trim().is_empty() {
            return Ok(MemorySwitchState {
                enabled: true,
                detail: String::new(),
            });
        }
        let parsed = format::parse(FileKind::Json, &text)
            .map_err(|_| "无法读取记忆总开关，请重试".to_owned())?;
        let disabled = parsed
            .get(SWITCH_KEY)
            .map(|flag| flag == &serde_json::Value::Bool(false))
            .unwrap_or(false);
        Ok(MemorySwitchState {
            enabled: !disabled,
            detail: String::new(),
        })
    }

    fn switch_patch(
        &self,
        home: &Path,
        _directory: &Path,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        let path = config_root(home).join("settings.json");
        let current = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
        let updated = if current.trim().is_empty() {
            serde_json::to_string_pretty(&serde_json::json!({ SWITCH_KEY: enabled }))
                .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?
        } else {
            format::set_path(
                FileKind::Json,
                &current,
                &[SWITCH_KEY.to_owned()],
                Some(&serde_json::Value::Bool(enabled)),
            )
            .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?
        };
        if updated == current {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            baseline: current_if_exists(&path)?,
            path,
            contents: Some(updated),
        }))
    }
}

/// Session transcripts (`<slug>/*.jsonl`) record the native `cwd` the slug
/// was derived from. Only the first lines of the newest few transcripts are
/// read, and a `cwd` is accepted only when it re-derives the same slug, so a
/// moved or foreign transcript never relabels a store. Display only.
fn recorded_project(project_directory: &Path, slug: &str) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};
    let mut transcripts: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(project_directory)
        .ok()?
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                    entry.path(),
                )
            })
        })
        .collect();
    transcripts.sort_by_key(|transcript| std::cmp::Reverse(transcript.0));
    for (_, path) in transcripts.into_iter().take(3) {
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file.take(512 * 1024)).lines().take(40) {
            let Ok(line) = line else {
                break;
            };
            if !line.contains("\"cwd\"") {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(cwd) = value.get("cwd").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if !cwd.trim().is_empty() && sanitize_slug(cwd) == slug {
                return Some(cwd.to_owned());
            }
        }
    }
    None
}

/// First defined `autoMemoryDirectory` wins (local, checked-in, user). An
/// invalid value also wins and cancels the relocation, mirroring the
/// observed native fallback to the default slug directory.
fn auto_memory_directory(home: &Path, project: &Path) -> Option<PathBuf> {
    let candidates = [
        project.join(".claude").join("settings.local.json"),
        project.join(".claude").join("settings.json"),
        config_root(home).join("settings.json"),
    ];
    for path in candidates {
        let Some(value) = directory_setting(&path) else {
            continue;
        };
        return accepted_memory_directory(&value, home);
    }
    None
}

fn directory_setting(path: &Path) -> Option<String> {
    let text = transaction::read_native(path).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let parsed = format::parse(FileKind::Json, &text).ok()?;
    parsed
        .get(DIRECTORY_KEY)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Only the forms verified live or documented in the settings schema
/// relocate: `~/…`, POSIX-absolute, or a forward-slash Windows drive path.
/// Backslash paths and bare names were probed and silently ignored.
fn accepted_memory_directory(value: &str, home: &Path) -> Option<PathBuf> {
    if value == "~" {
        return Some(home.to_path_buf());
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if rest.contains('\\') {
            return None;
        }
        return Some(home.join(rest));
    }
    let windows_drive = value.as_bytes();
    let forward_absolute = value.starts_with('/')
        || (windows_drive.len() >= 3
            && windows_drive[0].is_ascii_alphabetic()
            && windows_drive[1] == b':'
            && windows_drive[2] == b'/');
    if forward_absolute && !value.contains('\\') {
        return Some(PathBuf::from(value));
    }
    None
}

/// Node `process.cwd()` keeps a non-verbatim Windows path; Rust `canonicalize`
/// returns the verbatim form, so the native slug is derived after stripping
/// the prefix. Case is kept: the native slug does not fold case.
fn native_cwd(project: &Path) -> PathBuf {
    let canonical = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let text = canonical.to_string_lossy();
    let stripped = text.strip_prefix(r"\\?\").unwrap_or(&text);
    PathBuf::from(stripped)
}

fn project_slug(project: &Path) -> String {
    sanitize_slug(&native_cwd(project).to_string_lossy())
}

/// Bundle `k`/`s0`: every character outside `[a-zA-Z0-9]` becomes `-` with
/// no run collapsing; over 200 characters the sanitized name is cut at 200
/// and suffixed with `-{Te(original)}` where `Te` is
/// `Math.abs(Ede(original)).toString(36)` over UTF-16 code units.
fn sanitize_slug(text: &str) -> String {
    let sanitized: String = text
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.chars().count() <= 200 {
        return sanitized;
    }
    let cut: String = sanitized.chars().take(200).collect();
    format!("{cut}-{}", djb2_abs_base36(text))
}

/// Bundle `Ede`: djb2 over UTF-16 code units in signed 32-bit; `Te` takes
/// the absolute value and renders base 36 like JS `Number::toString(36)`.
fn djb2_abs_base36(text: &str) -> String {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
    }
    let mut value = (hash as i64).abs();
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(std::char::from_digit((value % 36) as u32, 36).unwrap_or('0'));
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

fn current_if_exists(path: &Path) -> Result<Option<String>, String> {
    if path.exists() {
        transaction::read_native(path)
            .map_err(|error| format!("无法读取记忆索引，请重试：{error}"))
            .map(Some)
    } else {
        Ok(None)
    }
}

/// `- [title](id.md) — description`, one line, from the topic file's
/// frontmatter with a humanized id as fallback (native samples show
/// `user_profile.md` indexed as `[User profile]`).
fn index_line(id: &str, text: &str) -> String {
    let (name, description) = frontmatter(text);
    let title = name
        .map(|name| humanize(&name))
        .unwrap_or_else(|| humanize(id));
    let single = |value: &str| value.replace(['\r', '\n'], " ").trim().to_owned();
    let title = single(&title);
    let description = single(&description.unwrap_or_default());
    if description.is_empty() {
        format!("- [{title}]({id}.md)")
    } else {
        format!("- [{title}]({id}.md) — {description}")
    }
}

fn humanize(value: &str) -> String {
    let mut spaced: String = value
        .chars()
        .map(|character| {
            matches!(character, '-' | '_')
                .then_some(' ')
                .unwrap_or(character)
        })
        .collect::<String>()
        .trim()
        .to_owned();
    if let Some(first) = spaced.get_mut(0..1) {
        let upper: String = first.to_uppercase();
        spaced.replace_range(0..1, &upper);
    }
    spaced
}

/// Minimal `name`/`description` frontmatter reader for the native memory
/// topic format; `None` when the file carries no frontmatter.
fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            return (name, description);
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            name = Some(value.trim().to_owned());
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            description = Some(value.trim().trim_matches('"').to_owned());
        }
    }
    (None, None)
}

/// Replaces or removes the single index line pointing at `<id>.md`, or
/// appends the new line when no line exists yet. Unknown lines and ordering
/// are preserved; the native index is never rebuilt from scratch.
fn replace_index_line(current: &str, id: &str, next: Option<&str>) -> Result<String, String> {
    let target = format!("]({id}.md)");
    let ends_with_newline = current.ends_with('\n');
    let body = current.strip_suffix('\n').unwrap_or(current);
    let mut lines: Vec<String> = body.split('\n').map(str::to_owned).collect();
    let position = lines.iter().position(|line| line.contains(&target));
    match (position, next) {
        (Some(index), Some(line)) => lines[index] = line.to_owned(),
        (Some(index), None) => {
            lines.remove(index);
        }
        (None, Some(line)) => lines.push(line.to_owned()),
        (None, None) => {}
    }
    let mut updated = lines.join("\n");
    if (ends_with_newline || next.is_some()) && !updated.is_empty() {
        updated.push('\n');
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change_of(path: &Path, baseline: Option<&str>, contents: Option<&str>) -> MemoryFileChange {
        MemoryFileChange {
            path: path.to_path_buf(),
            baseline: baseline.map(str::to_owned),
            contents: contents.map(str::to_owned),
        }
    }

    #[test]
    fn slug_matches_the_locally_observed_project_directories() {
        // Every directory under ~/.claude/projects on this machine
        // (2026-10-19) matches the bundle rule; separator runs are kept
        // (`C:\Users` → `C--Users`) and case is not folded.
        let samples = [
            ("C:\\Users\\example", "C--Users-example"),
            (
                "C:\\Users\\example\\Documents\\Qoder",
                "C--Users-example-Documents-Qoder",
            ),
            (
                "C:\\Users\\example\\IdeaProjects\\sample-proxy",
                "C--Users-example-IdeaProjects-sample-proxy",
            ),
            (
                "C:\\Users\\example\\cursor\\SampleNotes",
                "C--Users-example-cursor-SampleNotes",
            ),
            (
                "C:\\Users\\example\\cursor\\cliora",
                "C--Users-example-cursor-cliora",
            ),
            (
                "C:\\Users\\example\\project\\cliora",
                "C--Users-example-project-cliora",
            ),
            (
                "C:\\Users\\example\\project\\sample-tool",
                "C--Users-example-project-sample-tool",
            ),
            (
                "C:\\Users\\example\\project\\self-workflow",
                "C--Users-example-project-self-workflow",
            ),
            // Live probe (2026-10-19): underscores, dots, spaces and CJK
            // characters each collapse to one `-` per character.
            (
                "C:\\Users\\example\\project\\_probe.dir with space-汉字",
                "C--Users-example-project--probe-dir-with-space---",
            ),
        ];
        for (path, slug) in samples {
            assert_eq!(
                sanitize_slug(Path::new(path).to_string_lossy().as_ref()),
                slug
            );
        }
    }

    #[test]
    fn store_label_uses_a_transcript_cwd_only_when_it_rederives_the_slug() {
        let temp = tempfile::tempdir().unwrap();
        let slug = "C--Users-example-project-cliora";
        let directory = temp.path().join(slug);
        fs::create_dir_all(directory.join("memory")).unwrap();
        assert_eq!(recorded_project(&directory, slug), None);
        fs::write(
            directory.join("a.jsonl"),
            "{\"type\":\"summary\"}\n{\"cwd\":\"C:\\\\Users\\\\example\\\\other\"}\n",
        )
        .unwrap();
        assert_eq!(recorded_project(&directory, slug), None);
        fs::write(
            directory.join("b.jsonl"),
            "not json\n{\"cwd\":\"C:\\\\Users\\\\example\\\\project\\\\cliora\"}\n",
        )
        .unwrap();
        assert_eq!(
            recorded_project(&directory, slug).as_deref(),
            Some("C:\\Users\\example\\project\\cliora")
        );
    }

    #[test]
    fn long_slugs_use_the_200_cut_and_djb2_suffix() {
        // Expected suffix computed with the bundle expression itself:
        // Math.abs(Ede(path)).toString(36) over UTF-16 code units.
        let original = format!("C:\\{}\\project", "x".repeat(300));
        let expected_digest = {
            let mut hash: i64 = 0;
            for unit in original.encode_utf16() {
                hash = (hash * 31 + i64::from(unit)) as i32 as i64;
            }
            let mut value = hash.abs();
            let mut digits = Vec::new();
            if value == 0 {
                digits.push('0');
            }
            while value > 0 {
                digits.push(std::char::from_digit((value % 36) as u32, 36).unwrap());
                value /= 36;
            }
            digits.into_iter().rev().collect::<String>()
        };
        let slug = sanitize_slug(&original);
        let (cut, digest) = slug.rsplit_once('-').unwrap();
        assert_eq!(cut.chars().count(), 200);
        assert_eq!(digest, expected_digest);
        assert!(slug.starts_with("C--xxxx"));
    }

    #[test]
    fn directory_resolves_the_default_slug_location() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let resolved = Claude
            .directory(Scope::Project, &home, Some(&project))
            .unwrap();
        let slug = project_slug(&project);
        assert_eq!(
            resolved,
            home.join(".claude")
                .join("projects")
                .join(slug)
                .join("memory")
        );
        assert!(Claude
            .directory(Scope::Project, &home, None)
            .unwrap_err()
            .contains("请选择项目目录"));
        assert!(Claude
            .directory(Scope::Global, &home, Some(&project))
            .unwrap_err()
            .contains("按项目存储"));
    }

    #[test]
    fn auto_memory_directory_follows_the_verified_precedence_and_forms() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let claude = home.join(".claude");
        let project_claude = project.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        fs::create_dir_all(&project_claude).unwrap();
        let user = claude.join("settings.json");
        let local = project_claude.join("settings.local.json");
        let checked = project_claude.join("settings.json");

        // No value anywhere: default slug directory.
        assert!(auto_memory_directory(&home, &project).is_none());

        // User-level forward-slash absolute path relocates flat (probed).
        fs::write(&user, r#"{"autoMemoryDirectory": "C:/mem/root"}"#).unwrap();
        assert_eq!(
            auto_memory_directory(&home, &project).unwrap(),
            PathBuf::from("C:/mem/root")
        );

        // Checked-in project settings beat user (probed).
        fs::write(&checked, r#"{"autoMemoryDirectory": "/srv/mem"}"#).unwrap();
        assert_eq!(
            auto_memory_directory(&home, &project).unwrap(),
            PathBuf::from("/srv/mem")
        );

        // Local beats checked-in (probed).
        fs::write(&local, r#"{"autoMemoryDirectory": "~/tilde-mem"}"#).unwrap();
        assert_eq!(
            auto_memory_directory(&home, &project).unwrap(),
            home.join("tilde-mem")
        );

        // A backslash absolute path is silently ignored (probed): the
        // highest-precedence value cancels the relocation instead of
        // falling through to a lower-precedence definition.
        fs::write(&local, r#"{"autoMemoryDirectory": "C:\\mem\\root"}"#).unwrap();
        assert!(auto_memory_directory(&home, &project).is_none());

        // A bare folder name is ignored the same way (probed).
        fs::write(&local, r#"{"autoMemoryDirectory": "mem-root"}"#).unwrap();
        assert!(auto_memory_directory(&home, &project).is_none());
        fs::remove_file(&local).unwrap();
        fs::remove_file(&checked).unwrap();

        // Malformed JSON files are skipped, not fatal.
        fs::write(&user, "{ not json").unwrap();
        assert!(auto_memory_directory(&home, &project).is_none());
    }

    #[test]
    fn declaration_publishes_without_item_enable() {
        let declaration = Claude.declaration();
        assert!(declaration.unverified_reason.is_empty());
        assert!(!declaration.scope.global && declaration.scope.project);
        assert!(!declaration.binds_account);
        assert_eq!(declaration.operations, OPERATIONS);
        assert!(!declaration
            .operations
            .contains(&MemoryOperation::ItemEnable));
        assert!(!declaration.limitation.is_empty());
        assert!(crate::adapters::memory::publish(&declaration).is_some());
    }

    #[test]
    fn layout_lists_topic_files_and_never_the_index() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memory");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("MEMORY.md"), "# Memory Index\n").unwrap();
        fs::write(directory.join("user_profile.md"), "body").unwrap();
        fs::write(directory.join("release-ritual.md"), "body").unwrap();
        fs::write(directory.join("notes.txt"), "ignored").unwrap();
        fs::create_dir_all(directory.join("subdir")).unwrap();
        let entries = Claude.entries(&directory).unwrap();
        let mut ids: Vec<_> = entries.iter().map(|entry| entry.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["release-ritual", "user_profile"]);
        assert_eq!(
            Claude.entry_path(&directory, "user_profile").unwrap(),
            directory.join("user_profile.md")
        );
        assert!(Claude
            .entries(&temp.path().join("missing"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn index_save_creates_replaces_and_appends_native_lines() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memory");
        fs::create_dir_all(&directory).unwrap();
        let index = directory.join(INDEX_FILE);
        // A topic without frontmatter indexes under the humanized id; the
        // line keeps working natively (probed with a live session).
        let created = Claude
            .index_after_save(&directory, "linux_build_server", "plain body")
            .unwrap()
            .unwrap();
        assert_eq!(
            created,
            change_of(
                &index,
                None,
                Some("# Memory Index\n\n- [Linux build server](linux_build_server.md)\n"),
            )
        );
        fs::write(&index, created.contents.unwrap()).unwrap();
        // Frontmatter name/description become the native line; the real
        // index on this machine shows the humanized form.
        let second = Claude
            .index_after_save(
                &directory,
                "user_profile",
                "---\nname: user-profile\ndescription: \" terse directives \"\n---\nbody",
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            second.contents.unwrap(),
            "# Memory Index\n\n- [Linux build server](linux_build_server.md)\n- [User profile](user_profile.md) — terse directives\n"
        );
        // The existing real index line for the memory index of this machine
        // is preserved verbatim when another entry is appended.
        let real = "# Memory Index\n\n- [Linux build server](linux-build-server.md) — root@192.168.0.109 Debian 13\n- [User profile](user_profile.md) — Chinese, terse directives\n\n";
        fs::write(
            &index,
            "# Memory Index\n\n- [Linux build server](linux-build-server.md) — root@192.168.0.109 Debian 13\n- [User profile](user_profile.md) — Chinese, terse directives\n\n",
        )
        .unwrap();
        let appended = Claude
            .index_after_save(
                &directory,
                "release_ritual",
                "---\nname: release-ritual\ndescription: 五处版本文件\n---\nbody",
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            appended.contents.unwrap(),
            format!("{real}- [Release ritual](release_ritual.md) — 五处版本文件\n")
        );
    }

    #[test]
    fn index_delete_removes_only_the_matching_line() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memory");
        fs::create_dir_all(&directory).unwrap();
        let index = directory.join(INDEX_FILE);
        fs::write(
            &index,
            "# Memory Index\n\n- [Linux build server](linux-build-server.md) — Debian 13\n- [User profile](user_profile.md) — terse\n\n",
        )
        .unwrap();
        let removed = Claude
            .index_after_delete(&directory, "user_profile")
            .unwrap()
            .unwrap();
        assert_eq!(
            removed,
            change_of(
                &index,
                Some("# Memory Index\n\n- [Linux build server](linux-build-server.md) — Debian 13\n- [User profile](user_profile.md) — terse\n\n"),
                Some("# Memory Index\n\n- [Linux build server](linux-build-server.md) — Debian 13\n\n"),
            )
        );
        fs::write(&index, removed.contents.unwrap()).unwrap();
        let missing = Claude.index_after_delete(&directory, "absent").unwrap();
        assert!(missing.is_none());
        let last = Claude
            .index_after_delete(&directory, "linux-build-server")
            .unwrap()
            .unwrap();
        // Removing the final entry keeps the native header alone.
        let last_text = last.contents.unwrap();
        assert_eq!(last_text.trim(), "# Memory Index");
        assert!(last_text.ends_with('\n'));
    }

    #[test]
    fn switch_maps_the_verified_user_settings_key() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings = home.join(".claude").join("settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        // Missing settings keep the verified default (enabled) and a switch
        // write creates the top-level key.
        let state = Claude.switch_state(&home, Path::new("/unused")).unwrap();
        assert!(state.enabled);
        let patch = Claude
            .switch_patch(&home, Path::new("/unused"), false)
            .unwrap()
            .unwrap();
        assert_eq!(patch.baseline, None);
        assert!(patch
            .contents
            .as_deref()
            .unwrap()
            .contains("\"autoMemoryEnabled\": false"));
        fs::write(&settings, patch.contents.unwrap()).unwrap();
        assert!(
            !Claude
                .switch_state(&home, Path::new("/unused"))
                .unwrap()
                .enabled
        );
        // Existing user settings keep unrelated keys and formatting.
        fs::write(
            &settings,
            "{\n  \"model\": \"glm-5.3\",\n  \"env\": {\n    \"ANTHROPIC_MODEL\": \"glm-5.3\"\n  }\n}\n",
        )
        .unwrap();
        let enable = Claude
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .unwrap();
        let enabled_text = enable.contents.unwrap();
        assert!(enabled_text.contains("\"model\": \"glm-5.3\""));
        assert!(enabled_text.contains("\"autoMemoryEnabled\": true"));
        assert_eq!(enable.baseline.as_deref(), Some("{\n  \"model\": \"glm-5.3\",\n  \"env\": {\n    \"ANTHROPIC_MODEL\": \"glm-5.3\"\n  }\n}\n"));
        fs::write(&settings, enabled_text).unwrap();
        assert!(
            Claude
                .switch_state(&home, Path::new("/unused"))
                .unwrap()
                .enabled
        );
        // The same state is a no-op.
        assert!(Claude
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .is_none());
    }

    /// Local-machine evidence probe. Runs the real shared engine (list, save,
    /// switch, delete) against the real home and the project named by
    /// `CLIORA_CLAUDE_MEMORY_PROBE_PROJECT`, stepping with
    /// `CLIORA_CLAUDE_MEMORY_PROBE_STEP` = `save` | `disable` | `restore`.
    /// The user settings.json is always restored to its original text.
    #[test]
    #[ignore = "本机证据探针：需真实 ~/.claude 与真实项目目录"]
    fn local_evidence_probe_runs_the_shared_engine() {
        let Some(project) = std::env::var_os("CLIORA_CLAUDE_MEMORY_PROBE_PROJECT") else {
            panic!("缺少 CLIORA_CLAUDE_MEMORY_PROBE_PROJECT");
        };
        let step = std::env::var("CLIORA_CLAUDE_MEMORY_PROBE_STEP").unwrap_or_default();
        let home = PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE"))
            .canonicalize()
            .unwrap();
        let project = PathBuf::from(&project).canonicalize().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("probe.db")).unwrap();
        static CLAUDE: Claude = Claude;
        let registry = crate::adapters::Registry::with_adapters(vec![&CLAUDE]).unwrap();
        let store = ProbeCredentials::default();
        let settings = config_root(&home).join("settings.json");
        let original_settings = std::fs::read_to_string(&settings).unwrap_or_default();
        // Cross-step backup: `disable` parks the pristine text here so the
        // later `restore` step puts back the user's real settings instead of
        // the already-mutated text it read at its own start.
        let settings_backup = std::env::temp_dir().join("cliora-claude-memory-probe-settings.bak");
        let target = crate::resources::memory::MemoryTarget {
            tool_id: "claude_code".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            context_id: None,
            store_directory: None,
        };
        let id = "cliora_engine_probe";
        let text = "Cliora engine-written probe marker EVID-31337. Topic body for the \
                    2026-10-19 claude memory integration evidence.";
        let outcome = (|| -> Result<String, String> {
            match step.as_str() {
                "save" => {
                    let document = crate::resources::memory::save_memory(
                        &db,
                        &store,
                        &registry,
                        &home,
                        &crate::resources::memory::MemorySave {
                            target: target.clone(),
                            id: id.into(),
                            text: text.into(),
                            baseline: String::new(),
                            confirm_external: false,
                        },
                    )?;
                    let list =
                        crate::resources::memory::list_memories(&db, &registry, &home, &target)?;
                    Ok(format!(
                        "save path={} fingerprint={}\nlist in_use={} entries={:?}\nindex={:?}",
                        document.path,
                        document.fingerprint,
                        list.in_use,
                        list.entries
                            .iter()
                            .map(|entry| entry.id.as_str())
                            .collect::<Vec<_>>(),
                        std::fs::read_to_string(
                            Path::new(&document.path).parent().unwrap().join(INDEX_FILE)
                        )
                        .unwrap_or_default()
                    ))
                }
                "disable" => {
                    std::fs::write(&settings_backup, &original_settings).unwrap();
                    let list = crate::resources::memory::set_memory_enabled(
                        &db,
                        &store,
                        &registry,
                        &home,
                        &crate::resources::memory::MemoryEnable {
                            target: target.clone(),
                            id: None,
                            enabled: false,
                        },
                    )?;
                    Ok(format!(
                        "disable in_use={} settings_autoMemoryEnabled={:?}",
                        list.in_use,
                        serde_json::from_str::<serde_json::Value>(
                            &std::fs::read_to_string(&settings).unwrap_or_default()
                        )
                        .ok()
                        .and_then(|value| value.get(SWITCH_KEY).cloned())
                    ))
                }
                "restore" => {
                    let on = crate::resources::memory::set_memory_enabled(
                        &db,
                        &store,
                        &registry,
                        &home,
                        &crate::resources::memory::MemoryEnable {
                            target: target.clone(),
                            id: None,
                            enabled: true,
                        },
                    )?;
                    let document =
                        crate::resources::memory::read_memory(&db, &registry, &home, &target, id)?;
                    crate::resources::memory::delete_memory(
                        &db,
                        &store,
                        &registry,
                        &home,
                        &crate::resources::memory::MemoryDelete {
                            target: target.clone(),
                            id: id.into(),
                            baseline: document.text,
                        },
                    )?;
                    let list =
                        crate::resources::memory::list_memories(&db, &registry, &home, &target)?;
                    Ok(format!(
                        "restore in_use={} entries={:?}",
                        on.in_use,
                        list.entries
                            .iter()
                            .map(|entry| entry.id.as_str())
                            .collect::<Vec<_>>()
                    ))
                }
                other => Err(format!("未知步骤 {other:?}")),
            }
        })();
        // The disable step intentionally leaves the switch off so a real
        // native session can observe the changed behavior; every other step
        // restores the user's original settings text, preferring the
        // cross-step backup taken before the disable.
        if step != "disable" {
            let pristine =
                std::fs::read_to_string(&settings_backup).unwrap_or(original_settings.clone());
            std::fs::write(&settings, pristine).unwrap();
            let _ = std::fs::remove_file(&settings_backup);
        }
        println!(
            "PROBE step={step}\n{}",
            outcome
                .clone()
                .unwrap_or_else(|error| format!("ERROR {error}"))
        );
        outcome.unwrap();
    }

    #[derive(Default)]
    struct ProbeCredentials(std::sync::Mutex<std::collections::HashMap<String, String>>);

    impl crate::credentials::CredentialStore for ProbeCredentials {
        fn put(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing synthetic credential".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
}
