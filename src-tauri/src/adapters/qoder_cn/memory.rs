//! Qoder CN 1.1.74 native layout verified against the installed bundle.
use super::QoderAdapter;
use crate::adapters::memory::{
    store_present, MemoryAdapter, MemoryDeclaration, MemoryFileChange, MemoryLayout,
    MemoryLayoutEntry, MemoryOperation, MemoryScope, MemoryStoreRef, MemorySwitchGroup,
    MemorySwitchState, MemoryTargetDimension,
};
use crate::native::adapter::Scope;
use crate::native::format::{self, FileKind};
use crate::native::transaction;
use std::fs;
use std::path::{Path, PathBuf};
const INDEX_FILE: &str = "MEMORY.md";
const PROJECT_SWITCH: &str = "autoMemoryEnabled";
const USER_SWITCH: &str = "autoMemoryUserScopeEnabled";
const DEFAULT_DETAIL: &str = "跟随原生默认，当前生效状态未知";

impl MemoryAdapter for QoderAdapter {
    fn native_file_names(&self) -> bool {
        true
    }
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope { global: true, project: true },
            targets: &[MemoryTargetDimension::Project],
            operations: &[MemoryOperation::List, MemoryOperation::Open, MemoryOperation::Create,
                MemoryOperation::Edit, MemoryOperation::Delete, MemoryOperation::MasterSwitch],
            unverified_reason: "",
            limitation: "用户和项目记忆分别使用用户设置中的原生开关；项目设置及非交互环境可能覆盖，运行中的会话需重新加载。原生不支持单条启停。",
            binds_account: false,
        }
    }
    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        let root = self.config_root(home)?;
        match scope {
            Scope::Global => Ok(root.join("memory")),
            Scope::Project => {
                let project = project.ok_or("请选择项目目录")?;
                let canonical = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
                let text = canonical.to_string_lossy();
                let native = text.strip_prefix(r"\\?\").unwrap_or(&text);
                Ok(root
                    .join("projects")
                    .join(project_slug(native))
                    .join("memory"))
            }
        }
    }
    fn layout(&self) -> Option<&dyn MemoryLayout> {
        Some(self)
    }
    fn existing_stores(&self, home: &Path) -> Vec<MemoryStoreRef> {
        let Ok(root) = self.config_root(home) else {
            return Vec::new();
        };
        let mut stores = Vec::new();
        let directory = root.join("memory");
        if store_present(&directory) {
            stores.push(MemoryStoreRef {
                scope: Scope::Global,
                project_path: None,
                label: "用户记忆".into(),
                directory,
            });
        }
        if let Ok(read) = fs::read_dir(root.join("projects")) {
            for item in read.flatten() {
                let directory = item.path().join("memory");
                if store_present(&directory) {
                    stores.push(MemoryStoreRef {
                        scope: Scope::Project,
                        project_path: None,
                        label: item.file_name().to_string_lossy().into_owned(),
                        directory,
                    });
                }
            }
        }
        stores.sort_by(|a, b| a.directory.cmp(&b.directory));
        stores
    }
}
impl MemoryLayout for QoderAdapter {
    fn entries(&self, directory: &Path) -> Result<Vec<MemoryLayoutEntry>, String> {
        let read = match fs::read_dir(directory) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        let mut entries = Vec::new();
        for item in read {
            let item = item.map_err(|error| error.to_string())?;
            if !item
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                continue;
            }
            let name = item.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with('.') || name.eq_ignore_ascii_case(INDEX_FILE) {
                continue;
            }
            if let Some(id) = name.strip_suffix(".md") {
                entries.push(MemoryLayoutEntry {
                    id: id.into(),
                    path: item.path(),
                });
            }
        }
        Ok(entries)
    }
    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String> {
        if id.eq_ignore_ascii_case("MEMORY") {
            return Err("MEMORY.md 是原生索引，不能作为记忆条目".into());
        }
        Ok(directory.join(format!("{id}.md")))
    }
    fn index_after_save(
        &self,
        directory: &Path,
        id: &str,
        text: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        index_patch(directory, id, Some(&index_line(id, text)))
    }
    fn index_after_delete(
        &self,
        directory: &Path,
        id: &str,
    ) -> Result<Option<MemoryFileChange>, String> {
        index_patch(directory, id, None)
    }
    fn switch_groups(&self, home: &Path) -> Result<Vec<MemorySwitchGroup>, String> {
        let text = transaction::read_native(&self.config_root(home)?.join("settings.json"))?;
        let value = if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            format::parse(FileKind::Json, &text)?
        };
        for key in [USER_SWITCH, PROJECT_SWITCH] {
            if value.get(key).is_some_and(|flag| !flag.is_boolean()) {
                return Err(format!("记忆开关 {key} 必须是布尔值，请在配置中修复"));
            }
        }
        Ok([
            (USER_SWITCH, Scope::Global),
            (PROJECT_SWITCH, Scope::Project),
        ]
        .into_iter()
        .map(|(id, scope)| {
            let enabled = value.get(id).and_then(serde_json::Value::as_bool);
            MemorySwitchGroup {
                id: id.into(),
                scope,
                enabled,
                detail: if enabled.is_none() {
                    DEFAULT_DETAIL.into()
                } else {
                    String::new()
                },
            }
        })
        .collect())
    }
    fn switch_group_patch(
        &self,
        home: &Path,
        group: &str,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        if group != PROJECT_SWITCH && group != USER_SWITCH {
            return Err("未知记忆开关".into());
        }
        let path = self.config_root(home)?.join("settings.json");
        let baseline = snapshot(&path)?;
        let current = baseline.as_deref().unwrap_or("");
        let contents = if current.trim().is_empty() {
            serde_json::to_string_pretty(&serde_json::json!({group: enabled}))
                .map_err(|error| error.to_string())?
        } else {
            format::set_path(
                FileKind::Json,
                current,
                &[group.into()],
                Some(&serde_json::Value::Bool(enabled)),
            )?
        };
        if current == contents {
            return Ok(None);
        }
        Ok(Some(MemoryFileChange {
            path,
            baseline,
            contents: Some(contents),
        }))
    }
    fn switch_state(&self, home: &Path, directory: &Path) -> Result<MemorySwitchState, String> {
        let scope = if directory == self.config_root(home)?.join("memory") {
            Scope::Global
        } else {
            Scope::Project
        };
        let group = self
            .switch_groups(home)?
            .into_iter()
            .find(|group| group.scope == scope)
            .ok_or("未知记忆范围")?;
        Ok(MemorySwitchState {
            enabled: group.enabled.unwrap_or(false),
            detail: group.detail,
        })
    }
    fn switch_patch(
        &self,
        home: &Path,
        directory: &Path,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String> {
        let key = if directory == self.config_root(home)?.join("memory") {
            USER_SWITCH
        } else {
            PROJECT_SWITCH
        };
        self.switch_group_patch(home, key, enabled)
    }
}
fn snapshot(path: &Path) -> Result<Option<String>, String> {
    let text = transaction::read_native(path)?;
    Ok(path.exists().then_some(text))
}
fn index_patch(
    directory: &Path,
    id: &str,
    next: Option<&str>,
) -> Result<Option<MemoryFileChange>, String> {
    let path = directory.join(INDEX_FILE);
    let baseline = snapshot(&path)?;
    let current = baseline.as_deref().unwrap_or("");
    let contents = if current.trim().is_empty() {
        match next {
            Some(line) => format!("# Memory Index\n\n{line}\n"),
            None => return Ok(None),
        }
    } else {
        replace_index_line(current, id, next)?
    };
    if current == contents {
        return Ok(None);
    }
    Ok(Some(MemoryFileChange {
        path,
        baseline,
        contents: Some(contents),
    }))
}
/// Native Xm/dva: JS regexp replaces UTF-16 units; signed djb2-XOR suffix.
pub(super) fn project_slug(text: &str) -> String {
    let sanitized: String = text
        .encode_utf16()
        .map(|unit| {
            if unit < 128 && (unit as u8).is_ascii_alphanumeric() {
                char::from(unit as u8)
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.len() <= 200 {
        return sanitized;
    }
    let hash = text.encode_utf16().fold(5381i32, |hash, unit| {
        hash.wrapping_mul(33) ^ i32::from(unit)
    });
    let mut value = i64::from(hash).abs();
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((value % 36) as u32, 36).unwrap());
        value /= 36;
        if value == 0 {
            break;
        }
    }
    format!(
        "{}-{}",
        &sanitized[..200],
        digits.into_iter().rev().collect::<String>()
    )
}

fn index_line(id: &str, text: &str) -> String {
    let (name, description) = frontmatter(text);
    let title = name
        .map(|name| humanize(&name))
        .unwrap_or_else(|| humanize(id));
    let single = |value: &str| value.replace(['\r', '\n'], " ").trim().to_owned();
    let title = markdown_text(&single(&title));
    let description = markdown_text(&single(&description.unwrap_or_default()));
    let destination = markdown_destination(&format!("{id}.md"));
    if description.is_empty() {
        format!("- [{title}]({destination})")
    } else {
        format!("- [{title}]({destination}) — {description}")
    }
}

fn markdown_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| {
            ch.is_ascii_punctuation()
                .then_some('\\')
                .into_iter()
                .chain(std::iter::once(ch))
        })
        .collect()
}

fn markdown_destination(value: &str) -> String {
    // Unicode is valid in a Markdown destination. Encode ASCII URL syntax,
    // whitespace and Markdown delimiters, including literal percent signs.
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii() && !ch.is_ascii_alphanumeric() && !matches!(ch, '-' | '_' | '.' | '~')
            {
                format!("%{:02X}", ch as u8)
            } else {
                ch.to_string()
            }
        })
        .collect()
}

/// Read the leading native list link, not an incidental link in its title or
/// description. Accept native raw Unicode/balanced parentheses, angle targets,
/// backslash escapes and older raw spaces; newly written targets are encoded.
fn index_destination(line: &str) -> Option<String> {
    let link = line
        .trim()
        .strip_prefix("- [")
        .or_else(|| line.trim().strip_prefix("* ["))?;
    let mut chars = link.char_indices();
    let mut depth = 0;
    let start = loop {
        let (offset, ch) = chars.next()?;
        match ch {
            '\\' => {
                chars.next()?;
            }
            '[' => depth += 1,
            ']' if depth > 0 => depth -= 1,
            ']' => break offset + 1,
            _ => {}
        }
    };
    let destination = link.get(start..)?.strip_prefix('(')?;
    let angle = destination.starts_with('<');
    let destination = if angle {
        &destination[1..]
    } else {
        destination
    };
    let mut chars = destination.char_indices();
    let mut depth = 0;
    let mut raw = String::new();
    let end = loop {
        let (offset, ch) = chars.next()?;
        match ch {
            '\\' => {
                let (_, escaped) = chars.next()?;
                if !escaped.is_ascii_punctuation() {
                    raw.push('\\');
                }
                raw.push(escaped);
            }
            '>' if angle => break offset + 1,
            '(' if !angle => {
                depth += 1;
                raw.push(ch);
            }
            ')' if !angle && depth > 0 => {
                depth -= 1;
                raw.push(ch);
            }
            ')' if !angle => break offset + 1,
            _ => raw.push(ch),
        }
    };
    let tail = &destination[end..];
    let tail = if angle { tail.strip_prefix(')')? } else { tail };
    // A premature close caused by an unescaped title/destination must never
    // identify a different entry. Leave unrecognized lines untouched.
    if !tail.is_empty()
        && ![" — ", " - ", " – "]
            .iter()
            .any(|prefix| tail.starts_with(prefix))
    {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(a), Some(b)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                decoded.push((a * 16 + b) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).ok()
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
    let target = format!("{id}.md");
    let ends_with_newline = current.ends_with('\n');
    let body = current.strip_suffix('\n').unwrap_or(current);
    let mut lines = Vec::new();
    let mut matched = false;
    for line in body.split('\n') {
        if index_destination(line).as_deref() == Some(target.as_str()) {
            if !matched {
                if let Some(next) = next {
                    lines.push(next.to_owned());
                }
            }
            matched = true;
        } else {
            lines.push(line.to_owned());
        }
    }
    if !matched {
        if let Some(next) = next {
            lines.push(next.to_owned());
        }
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
    #[test]
    fn memory_index_encodes_targets_and_matches_complete_native_links() {
        assert_eq!(
            index_line("note](victim.md)", ""),
            r"- [Note\]\(victim\.md\)](note%5D%28victim.md%29.md)"
        );
        assert_eq!(
            index_line(
                "user preferences",
                "---\nname: [title](victim.md) & <tag>\n---"
            ),
            r"- [\[title\]\(victim\.md\) \& \<tag\>](user%20preferences.md)"
        );
        for (line, target) in [
            ("- [旧标题](用户偏好.md) — 描述", "用户偏好.md"),
            ("- [Title](user preferences.md)", "user preferences.md"),
            ("- [Title](note(a).md)", "note(a).md"),
            ("- [Title](<note).md>)", "note).md"),
            (r"- [Title](note\).md)", "note).md"),
            (r"- [\[bracket\]](topic%5b1%5d.md)", "topic[1].md"),
            ("- [Title](%E7%94%A8%E6%88%B7.md)", "用户.md"),
            ("- [Title](literal%2520.md)", "literal%20.md"),
        ] {
            assert_eq!(index_destination(line).as_deref(), Some(target));
        }
        let malformed = "- [Note](victim.md)](note](victim.md).md)\n";
        let neighbor = "- [Neighbor](neighbor.md) — see [victim](victim.md)\n";
        let current =
            format!("{malformed}{neighbor}- [Victim](victim.md)\n- [Duplicate](victim.md)\n");
        assert_eq!(
            replace_index_line(&current, "victim", None).unwrap(),
            format!("{malformed}{neighbor}")
        );
    }

    #[test]
    fn native_project_slug_matches_utf16_and_long_path_vectors() {
        assert_eq!(project_slug(r"C:\Users\项目😀"), "C--Users-----");
        let long = format!("C:/{}😀", "Ab_".repeat(90));
        // Derived independently with the installed Xm/dva JS algorithm.
        assert_eq!(
            project_slug(&long),
            format!("{}-a7p1im", &format!("C--{}", "Ab-".repeat(90))[..200])
        );
    }
}
