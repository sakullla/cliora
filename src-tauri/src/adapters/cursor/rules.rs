//! Project rule catalog: `.cursor/rules/*.mdc`, inert `.md`, and AGENTS.md.
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::super::RuleFileSpec;

pub const GLOBAL_REASON: &str =
    "Cursor 没有已核对的独立用户级规则文件，不拉取团队、企业或远程规则";
pub const COMPOSE_REASON: &str =
    "Cursor 项目规则是独立的 .mdc 文件，请在修改当前 CLI 规则里逐份编辑";
const INERT_DETAIL: &str = "不会被 Cursor 加载，不能保存成生效规则";
const AGENTS_DETAIL: &str = "项目及子目录的 AGENTS.md，可编辑；不删除、不停用";
const DISABLED_DETAIL: &str = "已移出扫描目录，Cursor 不会加载";
const MAX_FILES: usize = 128;
const MAX_DEPTH: u8 = 8;

pub fn list_specs(project: &Path) -> Result<Vec<RuleFileSpec>, String> {
    let mut specs = Vec::new();
    walk(project, project, 0, &mut specs)?;
    specs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(specs)
}

pub fn create_path(project: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("规则名称只能包含字母、数字、连字符和下划线".into());
    }
    let dest = project.join(".cursor").join("rules").join(format!("{name}.mdc"));
    if dest.exists() {
        return Err("同名规则已存在".into());
    }
    Ok(dest)
}

pub fn relocate(project: &Path, path: &Path, enabled: bool) -> Result<PathBuf, String> {
    let path = under_project(project, path)?;
    if path.extension().and_then(|ext| ext.to_str()) != Some("mdc") {
        return Err("只有 .mdc 规则可以启停".into());
    }
    let relative = path.strip_prefix(project).map_err(|_| "规则不在项目内")?;
    let mut parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect();
    let cursor = parts
        .iter()
        .position(|part| part == ".cursor")
        .ok_or("规则不在 .cursor 目录")?;
    let slot = parts.get(cursor + 1).ok_or("规则位置无效")?;
    let (from, to) = if enabled {
        (".cliora-disabled-rules", "rules")
    } else {
        ("rules", ".cliora-disabled-rules")
    };
    if slot != from {
        return Err("规则不在可启停的目录".into());
    }
    parts[cursor + 1] = to.into();
    let dest = parts.iter().fold(project.to_path_buf(), |base, part| base.join(part));
    if dest.exists() {
        return Err("启停目标已存在".into());
    }
    Ok(dest)
}

fn walk(project: &Path, dir: &Path, depth: u8, specs: &mut Vec<RuleFileSpec>) -> Result<(), String> {
    if specs.len() >= MAX_FILES {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(format!("无法读取项目目录：{error}")),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        if specs.len() >= MAX_FILES {
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "node_modules" | ".git" | "target" | "dist")
            || name.starts_with(".cliora-disabled")
        {
            continue;
        }
        let path = entry.path();
        if name == ".cursor" && file_type.is_dir() {
            collect_rules(&path.join("rules"), project, true, specs)?;
            collect_rules(&path.join(".cliora-disabled-rules"), project, false, specs)?;
            continue;
        }
        if file_type.is_file() && name == "AGENTS.md" {
            push(project, &path, "agents", true, true, AGENTS_DETAIL, specs);
            continue;
        }
        if file_type.is_dir() && depth < MAX_DEPTH && !name.starts_with('.') {
            walk(project, &path, depth + 1, specs)?;
        }
    }
    Ok(())
}

fn collect_rules(
    dir: &Path,
    project: &Path,
    enabled: bool,
    specs: &mut Vec<RuleFileSpec>,
) -> Result<(), String> {
    if !dir.exists() || specs.len() >= MAX_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|error| format!("无法读取规则目录：{error}"))?;
    for entry in entries {
        if specs.len() >= MAX_FILES {
            break;
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_rules(&path, project, enabled, specs)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("mdc") => push(
                project,
                &path,
                "mdc",
                enabled,
                true,
                if enabled { "" } else { DISABLED_DETAIL },
                specs,
            ),
            Some("md") => push(project, &path, "inert", false, false, INERT_DETAIL, specs),
            _ => {}
        }
    }
    Ok(())
}

fn push(
    project: &Path,
    path: &Path,
    kind: &'static str,
    enabled: bool,
    writable: bool,
    detail: &'static str,
    specs: &mut Vec<RuleFileSpec>,
) {
    let relative = path
        .strip_prefix(project)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.display().to_string());
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| relative.clone());
    specs.push(RuleFileSpec {
        id: format!("{kind}:{relative}"),
        path: path.to_path_buf(),
        name,
        kind,
        enabled,
        writable,
        detail,
    });
}

pub fn under_project(project: &Path, path: &Path) -> Result<PathBuf, String> {
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("规则路径无效".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        project.join(path)
    };
    if !absolute.starts_with(project) {
        return Err("规则不在项目内".into());
    }
    Ok(absolute)
}
