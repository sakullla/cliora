//! CodeBuddy memory integration, verified on the local machine (2026-10-19,
//! `@tencent-ai/codebuddy-code` 2.169.0 npm channel).
//!
//! Storage (bundle `PathUtils` + shipped docs `cn/cli/memory.md` + on-disk
//! samples): project memory under `~/.codebuddy/projects/<slug>/memory/`
//! with the legacy `~/.codebuddy/memories/<slug>` fallback, global memory
//! under `~/.codebuddy/memories/global/`. The slug compresses the project's
//! realpath (`/`, `\`, `:` → `-`, runs collapsed; Node's realpathSync
//! lowercases the Windows drive letter, which is why samples show
//! `c-Users-...`; over 255 bytes it is cut at 180 bytes and suffixed with a
//! djb2 base36 digest). Each directory is a `MEMORY.md` index plus typed
//! topic files (`name`/`description`/`type` frontmatter); index lines read
//! `- [name](file.md) — description` and `MEMORY.md` is never an entry.
//!
//! Switch: `~/.codebuddy/settings.json` `memory.autoMemoryEnabled`
//! (default enabled, `!== false` in the bundle); the
//! `CODEBUDDY_DISABLE_AUTO_MEMORY` env kill switch is honored read-only.
//! There is no per-entry native enable, so item enable is not declared.

use std::fs;
use std::path::{Path, PathBuf};

use super::CodeBuddy;
use crate::adapters::memory::{
    MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout, MemoryLayoutEntry,
    MemoryOperation, MemoryScope, MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;

const INDEX_FILE: &str = "MEMORY.md";
const INDEX_HEADER: &str = "# Memory Index";
const SWITCH_ENV: &str = "CODEBUDDY_DISABLE_AUTO_MEMORY";
const OPERATIONS: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Create,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
    MemoryOperation::MasterSwitch,
];

impl MemoryAdapter for CodeBuddy {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: true,
                project: true,
            },
            targets: &[MemoryTargetDimension::Project],
            operations: OPERATIONS,
            unverified_reason: "",
            limitation:
                "CodeBuddy 无单条记忆启停；总开关映射 settings.json 的 memory.autoMemoryEnabled，单条管理即编辑或删除主题文件",
            binds_account: false,
        }
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        let root = super::config_root(home);
        match scope {
            Scope::Global => Ok(root.join("memories").join("global")),
            Scope::Project => {
                let project = project.ok_or("请选择项目目录")?;
                let slug = project_slug(project);
                let primary = root.join("projects").join(&slug).join("memory");
                // Bundle getProjectMemoryDir keeps the legacy memories layout
                // alive when only it exists for the project.
                let legacy = root.join("memories").join(&slug);
                if !primary.exists() && legacy.exists() {
                    Ok(legacy)
                } else {
                    Ok(primary)
                }
            }
        }
    }

    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }
}

impl MemoryLayout for CodeBuddy {
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
        let baseline = current_if_exists(&path)?;
        Ok(Some(MemoryFileChange {
            path,
            baseline,
            contents: Some(updated),
        }))
    }

    fn index_after_delete(&self, directory: &Path, id: &str) -> Result<Option<MemoryFileChange>, String> {
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

    fn switch_state(&self, home: &Path, _directory: &Path) -> Result<MemorySwitchState, String> {
        if let Some(value) = std::env::var_os(SWITCH_ENV) {
            let value = value.to_string_lossy().trim().to_ascii_lowercase();
            if value == "1" || value == "true" {
                return Ok(MemorySwitchState {
                    enabled: false,
                    detail: format!("{SWITCH_ENV} 环境变量已停用 CodeBuddy 记忆"),
                });
            }
        }
        let path = super::config_root(home).join("settings.json");
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
            .get("memory")
            .and_then(|memory| memory.get("autoMemoryEnabled"))
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
        let path = super::config_root(home).join("settings.json");
        let current = transaction::read_native(&path)
            .map_err(|error| format!("无法读取记忆总开关，请重试：{error}"))?;
        let updated = if current.trim().is_empty() {
            serde_json::to_string_pretty(&serde_json::json!({
                "memory": { "autoMemoryEnabled": enabled }
            }))
            .map_err(|_| "无法保存记忆总开关，请重试".to_owned())?
        } else {
            format::set_path(
                FileKind::Json,
                &current,
                &[
                    "memory".to_owned(),
                    "autoMemoryEnabled".to_owned(),
                ],
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

fn current_if_exists(path: &Path) -> Result<Option<String>, String> {
    if path.exists() {
        transaction::read_native(path)
            .map_err(|error| format!("无法读取记忆索引，请重试：{error}"))
            .map(Some)
    } else {
        Ok(None)
    }
}

/// `- [name](id.md) — description`, one line, from the topic file's
/// frontmatter (the native typed-memory fields) with the id as fallback.
fn index_line(id: &str, text: &str) -> String {
    let (name, description) = frontmatter(text);
    let name = name.unwrap_or_else(|| id.to_owned());
    let single = |value: &str| value.replace(['\r', '\n'], " ").trim().to_owned();
    let name = single(&name);
    let description = single(&description.unwrap_or_default());
    if description.is_empty() {
        format!("- [{name}]({id}.md)")
    } else {
        format!("- [{name}]({id}.md) — {description}")
    }
}

/// Minimal `name`/`description` frontmatter reader for the native typed
/// memory format; `None` when the file carries no frontmatter.
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
            description = Some(value.trim().to_owned());
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

/// Node `fs.realpathSync` keeps a non-verbatim Windows path and lowercases
/// the drive letter; Rust `canonicalize` returns the verbatim form, so the
/// native slug is derived after mirroring that normalization.
fn native_realpath(project: &Path) -> PathBuf {
    let canonical = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let owned = canonical.to_string_lossy().into_owned();
    let stripped = owned.strip_prefix(r"\\?\").unwrap_or(owned.as_str());
    let mut characters = stripped.chars();
    match (characters.next(), characters.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => {
            PathBuf::from(format!("{}{}", drive.to_ascii_lowercase(), &stripped[1..]))
        }
        _ => PathBuf::from(stripped),
    }
}

fn project_slug(project: &Path) -> String {
    compress_workspace_path(&native_realpath(project).to_string_lossy())
}

/// Bundle `compressWorkspacePathName`: separators collapse to `-`, at most
/// 255 UTF-8 bytes, longer names are cut at 180 bytes on a char boundary and
/// suffixed with the djb2 base36 digest of the full normalized path.
fn compress_workspace_path(text: &str) -> String {
    let normalized: String = text
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    let trimmed = normalized.trim_matches('-');
    let collapsed = trim_runs(trimmed);
    if collapsed.len() <= 255 {
        return collapsed;
    }
    let mut bytes = 0;
    let mut cut = String::new();
    for character in collapsed.chars() {
        let size = character.len_utf8();
        if bytes + size > 180 {
            break;
        }
        bytes += size;
        cut.push(character);
    }
    format!("{cut}-{}", djb2_base36(collapsed.as_bytes()))
}

fn trim_runs(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut previous_dash = false;
    for character in text.chars() {
        if character == '-' {
            if !previous_dash {
                result.push(character);
            }
            previous_dash = true;
        } else {
            result.push(character);
            previous_dash = false;
        }
    }
    result
}

fn djb2_base36(bytes: &[u8]) -> String {
    let mut hash: u32 = 5381;
    for byte in bytes {
        hash = hash.wrapping_mul(33) ^ u32::from(*byte);
    }
    let mut digits = Vec::new();
    let mut value = hash;
    loop {
        digits.push(std::char::from_digit(value % 36, 36).unwrap_or('0'));
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.into_iter().rev().collect()
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
        // All ten directories under ~/.codebuddy/projects on this machine
        // (2026-10-19) match the bundle rule; the lowercase drive letter is
        // the Node realpathSync normalization.
        let samples = [
            ("C:\\Users\\12976\\IdeaProjects\\Rillight", "c-Users-12976-IdeaProjects-Rillight"),
            (
                "C:\\Users\\12976\\IdeaProjects\\nginx-reverse-emby",
                "c-Users-12976-IdeaProjects-nginx-reverse-emby",
            ),
            (
                "C:\\Users\\12976\\IdeaProjects\\sakullla-plugins",
                "c-Users-12976-IdeaProjects-sakullla-plugins",
            ),
            ("C:\\Users\\12976\\cursor\\LightInk", "c-Users-12976-cursor-LightInk"),
            ("C:\\Users\\12976\\project\\LightInk", "c-Users-12976-project-LightInk"),
            ("C:\\Users\\12976\\project\\Rillight", "c-Users-12976-project-Rillight"),
            ("C:\\Users\\12976\\project\\cliora", "c-Users-12976-project-cliora"),
            ("C:\\Users\\12976\\project\\cropmark", "c-Users-12976-project-cropmark"),
            (
                "C:\\Users\\12976\\project\\self-workflow",
                "c-Users-12976-project-self-workflow",
            ),
        ];
        for (path, slug) in samples {
            assert_eq!(compress_workspace_path(&native_realpath(Path::new(path)).to_string_lossy()), slug);
        }
        // Separator collapsing and trimming come from the bundle regex; the
        // drive letter follows the observed native lowercase form.
        assert_eq!(
            compress_workspace_path(
                &native_realpath(Path::new("C:\\--a//b\\\\c:--")).to_string_lossy()
            ),
            "c-a-b-c"
        );
    }

    #[test]
    fn long_slugs_use_the_180_byte_cut_and_djb2_suffix() {
        let long = format!("c-{}", "x".repeat(300));
        let slug = compress_workspace_path(&long);
        assert!(slug.len() <= 255, "{}", slug.len());
        let (cut, digest) = slug.rsplit_once('-').unwrap();
        assert_eq!(cut.len(), 180, "{}", cut.len());
        assert_eq!(digest, djb2_base36(long.as_bytes()));
        assert!(slug.starts_with(&format!("c-{}", "x".repeat(178))));
    }

    #[test]
    fn directory_resolves_project_global_and_legacy_locations() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let adapter = CodeBuddy;
        let global = adapter
            .directory(Scope::Global, &home, None)
            .unwrap();
        assert_eq!(global, home.join(".codebuddy").join("memories").join("global"));
        let primary = adapter
            .directory(Scope::Project, &home, Some(&project))
            .unwrap();
        let slug = project_slug(&project);
        assert_eq!(
            primary,
            home.join(".codebuddy")
                .join("projects")
                .join(&slug)
                .join("memory")
        );
        // Only the legacy layout existing keeps the legacy location alive.
        let legacy = home.join(".codebuddy").join("memories").join(&slug);
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(
            adapter.directory(Scope::Project, &home, Some(&project)).unwrap(),
            legacy
        );
        fs::create_dir_all(&primary).unwrap();
        assert_eq!(
            adapter.directory(Scope::Project, &home, Some(&project)).unwrap(),
            primary
        );
        assert!(adapter
            .directory(Scope::Project, &home, None)
            .unwrap_err()
            .contains("请选择项目目录"));
    }

    #[test]
    fn declaration_publishes_without_item_enable() {
        let declaration = CodeBuddy.declaration();
        assert!(declaration.unverified_reason.is_empty());
        assert!(declaration.scope.global && declaration.scope.project);
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
        fs::write(directory.join("feedback_testing.md"), "body").unwrap();
        fs::write(directory.join("notes.txt"), "ignored").unwrap();
        fs::create_dir_all(directory.join("agents")).unwrap();
        let entries = CodeBuddy.entries(&directory).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "feedback_testing");
        assert_eq!(
            CodeBuddy.entry_path(&directory, "feedback_testing").unwrap(),
            directory.join("feedback_testing.md")
        );
        assert!(CodeBuddy.entries(&temp.path().join("missing")).unwrap().is_empty());
    }

    #[test]
    fn index_save_creates_replaces_and_appends_native_lines() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memory");
        fs::create_dir_all(&directory).unwrap();
        let index = directory.join(INDEX_FILE);
        let topic = "---\nname: 测试偏好\ndescription: 保存验证用偏好\ntype: feedback\n---\n正文";
        let created = CodeBuddy
            .index_after_save(&directory, "feedback_testing", topic)
            .unwrap()
            .unwrap();
        assert_eq!(
            created,
            change_of(
                &index,
                None,
                Some("# Memory Index\n\n- [测试偏好](feedback_testing.md) — 保存验证用偏好\n"),
            )
        );
        fs::write(&index, &created.contents.unwrap()).unwrap();
        let second = CodeBuddy
            .index_after_save(&directory, "project_shape", "---\nname: 结构\ndescription: A\n---\nx")
            .unwrap()
            .unwrap();
        assert_eq!(
            second.contents.unwrap(),
            "# Memory Index\n\n- [测试偏好](feedback_testing.md) — 保存验证用偏好\n- [结构](project_shape.md) — A\n"
        );
        let renamed = CodeBuddy
            .index_after_save(&directory, "feedback_testing", "---\nname: 新名称\ndescription: B\n---\ny")
            .unwrap()
            .unwrap();
        let renamed_text = renamed.contents.unwrap();
        assert!(renamed_text.contains("- [新名称](feedback_testing.md) — B"));
        assert_eq!(renamed_text.matches("feedback_testing.md").count(), 1);
        fs::write(&index, &renamed_text).unwrap();
        // A save that changes nothing but the topic body keeps the index line.
        let unchanged = CodeBuddy
            .index_after_save(&directory, "feedback_testing", "---\nname: 新名称\ndescription: B\n---\nother body")
            .unwrap();
        assert!(unchanged.is_none());
        // Without frontmatter the id becomes the title.
        let bare = CodeBuddy
            .index_after_save(&directory, "plain_note", "# plain")
            .unwrap()
            .unwrap();
        assert!(bare.contents.unwrap().contains("- [plain_note](plain_note.md)\n"));
    }

    #[test]
    fn index_delete_removes_only_the_matching_line() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("memory");
        fs::create_dir_all(&directory).unwrap();
        let index = directory.join(INDEX_FILE);
        fs::write(
            &index,
            "# Memory Index\n\n- [保留](keep.md) — 保留说明\n- [删除](drop_me.md) — 删除说明\n",
        )
        .unwrap();
        let removed = CodeBuddy
            .index_after_delete(&directory, "drop_me")
            .unwrap()
            .unwrap();
        assert_eq!(
            removed,
            change_of(
                &index,
                Some("# Memory Index\n\n- [保留](keep.md) — 保留说明\n- [删除](drop_me.md) — 删除说明\n"),
                Some("# Memory Index\n\n- [保留](keep.md) — 保留说明\n"),
            )
        );
        fs::write(&index, removed.contents.unwrap()).unwrap();
        let missing = CodeBuddy.index_after_delete(&directory, "absent").unwrap();
        assert!(missing.is_none());
        let last = CodeBuddy.index_after_delete(&directory, "keep").unwrap().unwrap();
        // Removing the final entry leaves the native header line alone.
        let last_text = last.contents.unwrap();
        assert_eq!(last_text.trim(), "# Memory Index");
        assert!(last_text.ends_with('\n'));
    }

    #[test]
    fn switch_maps_the_verified_settings_key() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let settings = home.join(".codebuddy").join("settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        // Missing settings keep the verified default (enabled) and a switch
        // write creates the nested key.
        let state = CodeBuddy.switch_state(&home, Path::new("/unused")).unwrap();
        assert!(state.enabled);
        let patch = CodeBuddy
            .switch_patch(&home, Path::new("/unused"), false)
            .unwrap()
            .unwrap();
        assert_eq!(patch.baseline, None);
        let disabled_text = patch.contents.unwrap();
        fs::write(&settings, &disabled_text).unwrap();
        assert!(disabled_text.contains("\"autoMemoryEnabled\": false"));
        assert!(!CodeBuddy.switch_state(&home, Path::new("/unused")).unwrap().enabled);
        // Existing settings are preserved and the same state is a no-op.
        fs::write(
            &settings,
            "{\n  \"model\": \"kimi-k3-2\",\n  \"memory\": {\n    \"autoMemoryEnabled\": false\n  }\n}\n",
        )
        .unwrap();
        let enable = CodeBuddy
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .unwrap();
        let enabled_text = enable.contents.unwrap();
        assert!(enabled_text.contains("\"model\": \"kimi-k3-2\""));
        assert!(enabled_text.contains("\"autoMemoryEnabled\": true"));
        fs::write(&settings, enabled_text).unwrap();
        assert!(CodeBuddy.switch_state(&home, Path::new("/unused")).unwrap().enabled);
        assert!(CodeBuddy
            .switch_patch(&home, Path::new("/unused"), true)
            .unwrap()
            .is_none());
    }
}
