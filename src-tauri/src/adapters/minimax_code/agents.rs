//! User agents are `<data-dir>/agents/<name>/agent.md`. Built-ins live in
//! `agents/.builtin/<name>/agent.md` and stay read-only. `mcode` 0.6.8 does not
//! load `agents/<name>.md`, cron files, or `memory/MEMORY.md` as agents.
use super::{data_dir, DataDir, MiniMaxCode};
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use crate::resources::agents::{self, AgentEntry};
use crate::resources::plugins::PluginTarget;
use agents::push_file;
use serde_json::Value;
use std::path::{Path, PathBuf};

const ALLOWED_FIELDS: &[&str] = &[
    "name",
    "description",
    "model",
    "effort",
    "tools",
    "disallowedTools",
    "mcpServers",
    "skills",
    "x-mavis",
    "features",
];
const FEATURE_FIELDS: &[&str] = &["mavis", "delegation", "webSearch"];
const MAVIS_FIELDS: &[&str] = &[
    "displayName",
    "avatar",
    "contextWindow",
    "maxOutputTokens",
    "defaultWorkspaceDir",
    "extensionSkills",
];
const STRING_LISTS: &[&str] = &["tools", "disallowedTools", "mcpServers", "skills"];
const BUILTIN_OWNER: &str = "MiniMax Code 内置 Agent，只读";
const NAME_ERROR: &str = "名称必须以小写字母开头，只能包含小写字母、数字、连字符和下划线，且不超过 64 个字符";

impl AgentAdapter for MiniMaxCode {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "0.6.8",
            supported: true,
            format: "markdown",
            detail: "用户数据目录 agents/<name>/agent.md。frontmatter 的 name 必须与目录名一致；内置 Agent 只读。项目作用域没有独立目录。重启会话后加载。",
            template: "---\nname: reviewer\ndescription: Review code\n---\nReview the change and report findings.\n",
        }
    }
    fn root(&self, scope: Scope, home: &Path, _project: Option<&Path>) -> Result<PathBuf, String> {
        if scope == Scope::Project {
            return Err("MiniMax Code 的 Agent 只在用户数据目录中，项目作用域没有独立目录".into());
        }
        match data_dir(home) {
            DataDir::Directory(dir) if dir.is_dir() => Ok(dir),
            DataDir::Directory(_) => Err("MiniMax Code 数据目录不存在，Agent 管理不可用".into()),
            DataDir::Unavailable => Err("MiniMax Code 数据目录不可用，Agent 管理不可用".into()),
        }
    }
    fn scans_definition_directories(&self) -> bool {
        false
    }
    fn directory_name_matches_definition(&self) -> bool {
        true
    }
    fn writable_definition(&self, root: &Path, name: &str) -> Result<PathBuf, String> {
        agent_directory_name(name)?;
        if name == "mavis" || name == "main" {
            return Err("mavis 和 main 是 MiniMax Code 保留目录，不能作为自定义 Agent".into());
        }
        Ok(root.join("agents").join(name).join("agent.md"))
    }
    fn definition_fallback(&self, path: &Path) -> Option<String> {
        if path.file_name().is_some_and(|name| name == "agent.md") {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        } else {
            None
        }
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        let object = value.as_object().ok_or("定义字段必须是对象")?;
        reject_unknown(object.keys(), ALLOWED_FIELDS, "")?;
        if let Some(name) = value.get("name").and_then(Value::as_str) {
            agent_directory_name(name)?;
        }
        if let Some(model) = optional_text(value, "model")? {
            if !model.split_once('/').is_some_and(|(provider, id)| {
                !provider.is_empty()
                    && !id.is_empty()
                    && !provider.contains(char::is_whitespace)
                    && !id.contains('/')
                    && !id.contains(char::is_whitespace)
            }) {
                return Err("model 必须是 provider/model".into());
            }
        }
        optional_text(value, "effort")?;
        for key in STRING_LISTS {
            string_list(value, key)?;
        }
        if let Some(features) = value.get("features") {
            let features = features.as_object().ok_or("features 必须是对象")?;
            reject_unknown(features.keys(), FEATURE_FIELDS, "features.")?;
            for key in FEATURE_FIELDS {
                if !features.get(*key).and_then(Value::as_bool).is_some() {
                    return Err(format!("features.{key} 必须是布尔值"));
                }
            }
        }
        if let Some(mavis) = value.get("x-mavis") {
            let mavis = mavis.as_object().ok_or("x-mavis 必须是对象")?;
            reject_unknown(mavis.keys(), MAVIS_FIELDS, "x-mavis.")?;
            for key in ["displayName", "avatar"] {
                match mavis.get(key) {
                    None => {}
                    Some(Value::String(text)) if !text.trim().is_empty() => {}
                    _ => return Err(format!("x-mavis.{key} 必须是非空字符串")),
                }
            }
            for key in ["contextWindow", "maxOutputTokens"] {
                if let Some(number) = mavis.get(key) {
                    let ok = number
                        .as_u64()
                        .is_some_and(|value| value > 0 && value <= 9_007_199_254_740_991);
                    if !ok {
                        return Err(format!("x-mavis.{key} 必须是正整数"));
                    }
                }
            }
            if let Some(workspace) = mavis.get("defaultWorkspaceDir") {
                let workspace = workspace
                    .as_str()
                    .ok_or("x-mavis.defaultWorkspaceDir 必须是字符串")?;
                if !workspace.trim().is_empty() && !Path::new(workspace.trim()).is_absolute() {
                    return Err("x-mavis.defaultWorkspaceDir 必须是绝对路径或空字符串".into());
                }
            }
            match mavis.get("extensionSkills") {
                None => {}
                Some(Value::Array(items))
                    if items
                        .iter()
                        .all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())) => {}
                _ => return Err("x-mavis.extensionSkills 必须是非空字符串数组".into()),
            }
        }
        Ok(())
    }
    fn additional_sources(
        &self,
        _home: &Path,
        target: &PluginTarget,
        root: &Path,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        list_definitions(
            &root.join("agents"),
            true,
            &target.tool_id,
            true,
            "独立定义",
            entries,
        )?;
        list_definitions(
            &root.join("agents").join(".builtin"),
            false,
            &target.tool_id,
            true,
            BUILTIN_OWNER,
            entries,
        )?;
        list_definitions(
            &root.join(".cliora-disabled-agents").join("agents"),
            true,
            &target.tool_id,
            false,
            "独立定义",
            entries,
        )?;
        Ok(())
    }
}

fn agent_directory_name(name: &str) -> Result<(), String> {
    let allowed = name.len() <= 64
        && name.starts_with(|character: char| character.is_ascii_lowercase())
        && name
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' || character == '-')
        && !is_device_name(name);
    if allowed {
        Ok(())
    } else {
        Err(NAME_ERROR.into())
    }
}

fn is_device_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.as_bytes()[3].is_ascii_digit()
            && lower.as_bytes()[3] != b'0')
}

fn reject_unknown<'a>(
    keys: impl Iterator<Item = &'a String>,
    allowed: &[&str],
    prefix: &str,
) -> Result<(), String> {
    let mut unknown: Vec<_> = keys
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect();
    unknown.sort();
    if let Some(key) = unknown.first() {
        return Err(format!("不支持的字段 {prefix}{key}"));
    }
    Ok(())
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text)),
        _ => Err(format!("{key} 必须是非空字符串")),
    }
}

fn string_list(value: &Value, key: &str) -> Result<(), String> {
    match value.get(key) {
        None => Ok(()),
        Some(Value::Array(items))
            if items.iter().all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty())) =>
        {
            Ok(())
        }
        _ => Err(format!("{key} 必须是非空字符串数组")),
    }
}

fn list_definitions(
    dir: &Path,
    skip_reserved: bool,
    tool: &str,
    enabled: bool,
    owner: &str,
    entries: &mut Vec<AgentEntry>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    let mut files = Vec::new();
    for item in std::fs::read_dir(dir).map_err(|_| "无法读取 MiniMax Code Agent 目录")? {
        let item = item.map_err(|_| "无法读取 MiniMax Code Agent 目录")?;
        let path = item.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') || (skip_reserved && (name == "mavis" || name == "main")) {
            continue;
        }
        let file = path.join("agent.md");
        let Ok(file_meta) = std::fs::symlink_metadata(&file) else {
            continue;
        };
        if !file_meta.is_file() || file_meta.file_type().is_symlink() {
            continue;
        }
        files.push(file);
    }
    files.sort();
    for file in files {
        push_file(tool, &file, enabled, owner, entries)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents::validate;

    #[test]
    fn agents_stay_in_an_existing_data_directory() {
        let temp = tempfile::tempdir().unwrap();
        let missing = MiniMaxCode
            .root(Scope::Global, temp.path(), None)
            .unwrap_err();
        assert!(missing.contains("数据目录不存在"));
        assert!(!temp.path().join(".minimax").exists());
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let scoped = MiniMaxCode
            .root(Scope::Project, temp.path(), Some(&project))
            .unwrap_err();
        assert!(scoped.contains("项目作用域没有独立目录"));
        std::fs::create_dir(temp.path().join(".minimax")).unwrap();
        assert_eq!(
            MiniMaxCode.root(Scope::Global, temp.path(), None).unwrap(),
            temp.path().join(".minimax")
        );
        let capability = MiniMaxCode.capability();
        assert_eq!(capability.version, "0.6.8");
        assert!(validate("minimax_code", capability.format, capability.template, "reviewer").is_ok());
    }

    #[test]
    fn agent_fields_follow_the_canonical_document() {
        let builtin = "---\nname: explore\ndescription: Explore\ntools:\n  - Read\nskills:\n  - review\nfeatures:\n  mavis: false\n  delegation: false\n  webSearch: true\nx-mavis:\n  displayName: Explore\n---\nExplore.\n";
        assert!(validate("minimax_code", "markdown", builtin, "explore").is_ok());
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: reviewer\ndescription: Review\npermissionMode: bypassPermissions\n---\nReview.\n",
            "reviewer"
        )
        .unwrap_err()
        .contains("permissionMode"));
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: Reviewer\ndescription: Review\n---\nReview.\n",
            "Reviewer"
        )
        .is_err());
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: con\ndescription: Review\n---\nReview.\n",
            "con"
        )
        .is_err());
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: mavis\ndescription: Built-in\nfeatures:\n  mavis: true\n  delegation: true\n  webSearch: true\n---\nMavis.\n",
            "mavis"
        )
        .is_ok());
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: reviewer\ndescription: Review\ntools: Read\n---\nReview.\n",
            "reviewer"
        )
        .is_err());
        assert!(validate(
            "minimax_code",
            "markdown",
            "---\nname: reviewer\ndescription: Review\nmodel: bare\n---\nReview.\n",
            "reviewer"
        )
        .unwrap_err()
        .contains("provider/model"));
    }
}
