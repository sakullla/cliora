//! agy rules (1.5.9 evidence run:
//! `docs/verification/remote-workflow/agy-1.5.9/evidence/rules.json`).
//!
//! Everything is plain markdown — no cross-format conversion:
//!
//! * **Hierarchical** `AGENTS.md`/`GEMINI.md` live in any directory, walked
//!   from cwd to the repository root, and are always active for their scope.
//!   The single-file port manages the canonical documents — global
//!   `~/.gemini/config/AGENTS.md` (a changelog-verified readable global
//!   customization file) and `<project>/AGENTS.md` per project — which are
//!   also the long-term-rule distribution targets. The catalog lists every
//!   hierarchical file in the tree following the cursor AGENTS.md precedent:
//!   editable, never removable or toggleable (deleting a scope document the
//!   CLI always reads is not a rule operation).
//! * **Directory rules** are `<workspace>/.agents/rules/*.md` with `trigger:`
//!   frontmatter (`always_on` | `glob`+`globs` | `model_decision`+
//!   `description` | `manual`) plus the global `~/.gemini/config/rules/`
//!   folder. Listed and edited whole-file; the frontmatter stays file
//!   content Cliora does not interpret. They are removable (a missing file is
//!   simply not loaded) and toggleable through the cursor relocation
//!   convention: disabled files move to a `.cliora-disabled-rules` sibling
//!   that sits outside every auto-loaded path (`.agents/rules/`,
//!   `.agents/skills/`, `.agents/agents/`, `.agents/hooks.json` and, at the
//!   config root, `rules/` + `AGENTS.md`/`GEMINI.md`), so agy does not load
//!   them while the file content stays intact for re-enabling.
//! * **Plugin rules** `plugins/<name>/rules/` stay plugin-detail read-only
//!   resources (see [`super::plugins`]); they follow the plugin lifecycle
//!   and never appear in this catalog, so disabling a plugin can never be
//!   mistaken for a deleted rule.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::adapters::{RuleFileSpec, RuleKindPolicy};
use crate::native::adapter::Scope;

use super::gemini_root;

/// Scan budget for one catalog listing, mirroring the cursor catalog.
const MAX_FILES: usize = 128;
/// Walk depth for hierarchical files, mirroring the cursor catalog.
const MAX_DEPTH: u8 = 8;
/// Native scan directory for trigger-frontmatter rules.
const RULES_DIR: &str = "rules";
/// Cliora-owned relocation slot outside every agy-scanned path.
const DISABLED_DIR: &str = ".cliora-disabled-rules";

const MD_DETAIL: &str = "触发式目录规则，按 trigger frontmatter 生效";
const DISABLED_DETAIL: &str = "已移出扫描目录，agy 不会加载";
const AGENTS_DETAIL: &str = "层级 AGENTS.md，对其目录及子目录生效；可编辑，不删除、不停用";
const GEMINI_DETAIL: &str = "层级 GEMINI.md，对其目录及子目录生效；可编辑，不删除、不停用";

/// Single managed rule document per scope: the hierarchical AGENTS.md
/// standard the CLI always reads (also the long-term-rule distribution
/// target through the shared single-file port).
pub(crate) fn rule_path(scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
    Some(match scope {
        Scope::Global => gemini_root(home).join("config").join("AGENTS.md"),
        Scope::Project => project?.join("AGENTS.md"),
    })
}

/// Catalog specs for one scope: trigger-frontmarkdown `.md` directory rules
/// (enabled in the scan directory, disabled in the relocation slot) plus the
/// hierarchical `AGENTS.md`/`GEMINI.md` files. The project scope walks the
/// whole tree (any directory between the project root and its subtrees); the
/// global scope lists the config-root `rules/` folder and the two config-root
/// hierarchical documents.
pub(crate) fn list_specs(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Result<Vec<RuleFileSpec>, String> {
    let mut specs = Vec::new();
    match scope {
        Scope::Global => {
            let config = gemini_root(home).join("config");
            collect_directory(&config.join(RULES_DIR), &config, true, &mut specs)?;
            collect_directory(&config.join(DISABLED_DIR), &config, false, &mut specs)?;
            // The config-root hierarchical documents appear only when they
            // exist (the walk equivalent only lists files it found).
            for (name, kind, detail) in [
                ("AGENTS.md", "agents", AGENTS_DETAIL),
                ("GEMINI.md", "gemini", GEMINI_DETAIL),
            ] {
                let path = config.join(name);
                if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
                    push(&config, &path, kind, true, true, detail, &mut specs);
                }
            }
        }
        Scope::Project => {
            let project = project.ok_or("请选择项目目录")?;
            walk(project, project, 0, &mut specs)?;
        }
    }
    specs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(specs)
}

/// Catalog operation policy: the evidence-verified `.md` directory rules are
/// removable and toggleable (relocation); hierarchical documents are managed
/// content, never structurally removed or toggled.
pub(crate) fn kind_policy(kind: &str) -> RuleKindPolicy {
    if kind == "md" {
        RuleKindPolicy { removable: true, toggleable: true }
    } else {
        RuleKindPolicy { removable: false, toggleable: false }
    }
}

/// New rules land as `<name>.md` in the scope's native scan directory, so
/// the CLI picks them up without any registration step.
pub(crate) fn create_path(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    name: &str,
) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("规则名称只能包含字母、数字、连字符和下划线".into());
    }
    let dest = match scope {
        Scope::Global => gemini_root(home).join("config").join(RULES_DIR).join(format!("{name}.md")),
        Scope::Project => project
            .ok_or("请选择项目目录")?
            .join(".agents")
            .join(RULES_DIR)
            .join(format!("{name}.md")),
    };
    if dest.exists() {
        return Err("同名规则已存在".into());
    }
    Ok(dest)
}

/// Enable/disable moves a directory rule between the native scan directory
/// and the Cliora relocation slot; the file content never changes.
pub(crate) fn relocate(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    path: &Path,
    enabled: bool,
) -> Result<PathBuf, String> {
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("规则路径无效".into());
    }
    let base = match scope {
        Scope::Global => gemini_root(home).join("config"),
        Scope::Project => {
            let _ = home;
            project.ok_or("请选择项目目录")?.to_path_buf()
        }
    };
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    if !absolute.starts_with(&base) {
        return Err("规则不在扫描目录内".into());
    }
    let relative = absolute.strip_prefix(&base).map_err(|_| "规则不在扫描目录内")?;
    let mut parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_os_string()),
            _ => None,
        })
        .collect();
    // The relocatable shape is `<…>/rules/<file>.md` (or the disabled slot):
    // the scan directory must be the file's direct parent.
    let slot = parts
        .iter()
        .position(|part| {
            let text = part.to_string_lossy();
            text == RULES_DIR || text == DISABLED_DIR
        })
        .ok_or("规则不在可启停的目录")?;
    if slot + 2 != parts.len() {
        return Err("规则不在可启停的目录".into());
    }
    let (from, to) = if enabled {
        (DISABLED_DIR, RULES_DIR)
    } else {
        (RULES_DIR, DISABLED_DIR)
    };
    if parts[slot].to_string_lossy() != from {
        return Err("规则不在可启停的目录".into());
    }
    parts[slot] = to.into();
    let dest = parts.iter().fold(base, |base, part| base.join(part));
    if dest.exists() {
        return Err("启停目标已存在".into());
    }
    Ok(dest)
}

/// Template for created rules: the verified `always_on` trigger frontmatter
/// plus a visible heading, so the new file is actually loaded by agy.
pub(crate) fn create_template(_path: &Path, name: &str) -> String {
    format!("---\ntrigger: always_on\n---\n# {name}\n")
}

/// Walk one project subtree collecting hierarchical documents and every
/// `.agents` rules directory, mirroring the cursor project walk.
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
        if name == ".agents" && file_type.is_dir() {
            collect_directory(&path.join(RULES_DIR), project, true, specs)?;
            collect_directory(&path.join(DISABLED_DIR), project, false, specs)?;
            continue;
        }
        if file_type.is_file() && name == "AGENTS.md" {
            push(project, &path, "agents", true, true, AGENTS_DETAIL, specs);
            continue;
        }
        if file_type.is_file() && name == "GEMINI.md" {
            push(project, &path, "gemini", true, true, GEMINI_DETAIL, specs);
            continue;
        }
        if file_type.is_dir() && depth < MAX_DEPTH && !name.starts_with('.') {
            walk(project, &path, depth + 1, specs)?;
        }
    }
    Ok(())
}

/// List the `.md` files directly inside one rules directory (the native
/// contract is the flat `<dir>/*.md` glob; subdirectories and other
/// extensions are not evidenced as loaded and stay unlisted).
fn collect_directory(
    dir: &Path,
    base: &Path,
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
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("无法读取规则文件：{error}"))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        push(
            base,
            &path,
            "md",
            enabled,
            true,
            if enabled { MD_DETAIL } else { DISABLED_DETAIL },
            specs,
        );
    }
    Ok(())
}

fn push(
    base: &Path,
    path: &Path,
    kind: &'static str,
    enabled: bool,
    writable: bool,
    detail: &'static str,
    specs: &mut Vec<RuleFileSpec>,
) {
    let relative = path
        .strip_prefix(base)
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
