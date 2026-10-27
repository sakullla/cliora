//! Kiro steering rules (kiro.dev docs/steering and docs/cli/v3, cross-checked
//! with the local 2.34.2 V3 install in 01-exploration.md §2/§3).
//!
//! Native layout: global `~/.kiro/steering/` and project
//! `<project>/.kiro/steering/` hold the steering documents (base files
//! `product.md`/`tech.md/`structure.md`). The four frontmatter modes (always —
//! the default —/fileMatch/manual/auto, all supported by V3) are file content
//! the CLI interprets; Cliora lists and edits the files without parsing mode
//! semantics.
//!
//! Delivery follows the shared rules service ports: the project steering
//! directory is a project-scope catalog (`uses_rule_catalog(Project)`, the
//! shared `list_files`/`save_file` surface — every `.md` under
//! `<project>/.kiro/steering/` is listed and editable), and the single-file
//! port manages the always-included, mode-less AGENTS.md standard:
//! `~/.kiro/steering/AGENTS.md` globally and `<project>/AGENTS.md` per
//! project. The global steering directory is not cataloged because the shared
//! catalog port is project-scope only (a shared-service boundary this adapter
//! does not change); that absence stays recorded in `GLOBAL_CATALOG_REASON`
//! and in the descriptor instead of silently defaulting.

use std::fs;
use std::path::{Path, PathBuf};

use crate::adapters::RuleFileSpec;
use crate::native::adapter::Scope;

/// Scan budget for one steering directory, mirroring the cursor catalog.
const MAX_STEERING_FILES: usize = 128;

/// Recorded reason for the global-scope catalog absence (shared port limit).
pub(crate) const GLOBAL_CATALOG_REASON: &str =
    "全局 steering 目录（~/.kiro/steering/*.md）不目录化：共享目录型规则端口仅项目范围；全局可编辑 ~/.kiro/steering/AGENTS.md 单文件";

/// Native steering directory for one scope.
pub(crate) fn steering_directory(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Option<PathBuf> {
    Some(match scope {
        Scope::Global => super::kiro_root(home).join("steering"),
        Scope::Project => project?.join(".kiro").join("steering"),
    })
}

/// Single managed rule document per scope: the AGENTS.md standard file the
/// CLI always includes. Global lives under the steering directory per the
/// official layout; project lives at the workspace root (subdirectory copies
/// stay native and are not managed here — the project steering directory is
/// managed separately through the catalog specs below).
pub(crate) fn rule_path(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Option<PathBuf> {
    Some(match scope {
        Scope::Global => steering_directory(Scope::Global, home, None)?.join("AGENTS.md"),
        Scope::Project => project?.join("AGENTS.md"),
    })
}

/// Catalog specs for the project steering directory: every `.md` directly
/// under `<project>/.kiro/steering/` (base files product.md/tech.md/
/// structure.md, an AGENTS.md copy, any additions), each listed and editable
/// whole-file. Frontmatter modes stay file content; nothing is parsed,
/// disabled or relocated here.
pub(crate) fn list_steering_specs(project: &Path) -> Result<Vec<RuleFileSpec>, String> {
    let dir = project.join(".kiro").join("steering");
    let mut specs = Vec::new();
    if !dir.exists() {
        return Ok(specs);
    }
    let entries =
        fs::read_dir(&dir).map_err(|error| format!("无法读取规则目录：{error}"))?;
    for entry in entries {
        if specs.len() >= MAX_STEERING_FILES {
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
        let relative = path
            .strip_prefix(project)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.display().to_string());
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative.clone());
        specs.push(RuleFileSpec {
            id: format!("steering:{relative}"),
            path,
            name,
            kind: "md",
            enabled: true,
            writable: true,
            detail: "",
        });
    }
    specs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(specs)
}

/// New steering documents land as `<project>/.kiro/steering/<name>.md`.
pub(crate) fn steering_create_path(project: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("规则名称只能包含字母、数字、连字符和下划线".into());
    }
    let dest = project
        .join(".kiro")
        .join("steering")
        .join(format!("{name}.md"));
    if dest.exists() {
        return Err("同名规则已存在".into());
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_paths_follow_the_steering_layout() {
        let home = Path::new("/home/example");
        let global = rule_path(Scope::Global, home, None).unwrap();
        assert!(
            global
                .to_string_lossy()
                .replace('\\', "/")
                .ends_with(".kiro/steering/AGENTS.md"),
            "{global:?}"
        );
        let project = rule_path(Scope::Project, home, Some(Path::new("/work/p"))).unwrap();
        assert!(project
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/AGENTS.md"));
        assert!(rule_path(Scope::Project, home, None).is_none());
        let global_steering = steering_directory(Scope::Global, home, None).unwrap();
        assert!(global_steering
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".kiro/steering"));
        let project_steering =
            steering_directory(Scope::Project, home, Some(Path::new("/work/p"))).unwrap();
        assert!(project_steering
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/.kiro/steering"));
    }

    #[test]
    fn managed_rule_document_round_trips_through_the_shared_rules_service() {
        // The shared service treats rule_path as one composed document, so a
        // global write only ever touches the AGENTS.md file itself.
        let temp = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let target = crate::resources::rules::RuleTarget {
            context_id: None,
            tool_id: "kiro".into(),
            scope: Scope::Global,
            project_path: None,
            baseline_hash: None,
        };
        let registry = crate::adapters::Registry::builtins();
        let current =
            crate::resources::rules::read_current(&db, &registry, temp.path(), &target).unwrap();
        assert!(
            current
                .path
                .replace('\\', "/")
                .ends_with(".kiro/steering/AGENTS.md"),
            "{}",
            current.path
        );
        assert!(current.text.is_empty(), "未创建时为空态，不落盘");
    }

    #[test]
    fn project_steering_catalog_lists_and_saves_through_the_shared_service() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("demo");
        let steering = project.join(".kiro/steering");
        fs::create_dir_all(&steering).unwrap();
        fs::write(steering.join("product.md"), "# Product\n目标说明\n").unwrap();
        fs::write(steering.join("tech.md"), "---\nmode: fileMatch\n---\n技术栈\n").unwrap();
        fs::write(steering.join("notes.txt"), "非规则文件不入清单\n").unwrap();
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = crate::adapters::Registry::builtins();
        let target = crate::resources::rules::RuleTarget {
            context_id: None,
            tool_id: "kiro".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            baseline_hash: None,
        };
        let files =
            crate::resources::rules::list_files(&db, &registry, temp.path(), &target).unwrap();
        let names: Vec<_> = files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["product.md", "tech.md"], "{names:?}");
        assert!(files.iter().all(|file| file.writable && file.enabled));
        // Saving edits the file whole; frontmatter modes stay file content.
        let tech = files.iter().find(|file| file.name == "tech.md").unwrap();
        struct TestKeys;
        impl crate::credentials::CredentialStore for TestKeys {
            fn put(&self, _: &str, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn get(&self, _: &str) -> Result<String, String> {
                Err("missing".into())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }
        let edited = "---\nmode: manual\n---\n技术栈（更新）\n";
        crate::resources::rules::save_file(
            &db,
            &TestKeys,
            &registry,
            temp.path(),
            &target,
            &tech.path,
            &tech.text,
            edited,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(steering.join("tech.md")).unwrap(),
            edited
        );
        // The catalog port is project-scope only.
        let adapter = registry.get("kiro").unwrap();
        assert!(adapter.uses_rule_catalog(Scope::Project));
        assert!(!adapter.uses_rule_catalog(Scope::Global));
        let support = adapter.rule_support();
        assert!(support.global && support.project);
        assert!(support.catalog);
        assert!(support.global_reason.contains("仅项目范围"));
        let global_target = crate::resources::rules::RuleTarget {
            scope: Scope::Global,
            project_path: None,
            ..target
        };
        let error =
            crate::resources::rules::list_files(&db, &registry, temp.path(), &global_target)
                .unwrap_err();
        assert!(error.contains("仅项目范围"), "{error}");
        // New steering documents land in the project steering directory.
        let created =
            steering_create_path(&project, "security").unwrap();
        assert!(created
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with(".kiro/steering/security.md"));
        assert!(steering_create_path(&project, "bad/name").is_err());
    }
}
