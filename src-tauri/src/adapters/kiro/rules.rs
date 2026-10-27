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
//!
//! The same project catalog also lists the V3 workspace permissions file
//! `~/.kiro/workspace-roots/<hash>/permissions.yaml` (a `rules` array plus
//! `workspaceTrusted`, both read off the real local install) when the hash
//! directory maps to the selected project: the mapping is probed read-only
//! from `sessions/*/sess_*/session.json` `workspacePaths` (verified reversible
//! on both local hashes). The YAML file is listed and edited whole-file, so a
//! `rules` edit never drops `workspaceTrusted` or sibling fields; hash
//! directories without a session mapping to the selected project are never
//! shown.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::RuleFileSpec;
use crate::native::adapter::Scope;

/// Scan budget for one steering directory, mirroring the cursor catalog.
const MAX_STEERING_FILES: usize = 128;

/// Read budget for the hash→workspace mapping probe (session.json reads).
const MAX_SESSION_PROBES: usize = 64;

/// Detail line for the workspace permissions entries.
const PERMISSIONS_DETAIL: &str =
    "V3 能力权限文件（rules + workspaceTrusted），整文件编辑保存；只列已映射到所选项目的哈希目录";

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

/// Normalized workspace text for the mapping probe: forward slashes become
/// separators, the Windows verbatim prefixes from `canonicalize`
/// (`\\?\C:\…`, `\\?\UNC\server\share\…`) collapse back to the plain drive
/// and UNC forms native session records carry, and trailing separators drop.
fn workspace_text(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\")
            .map(str::to_owned)
            .unwrap_or(text)
    };
    text.trim_end_matches('\\').to_owned()
}

/// Same-workspace comparison for the mapping probe. `session.json` records
/// Windows paths whose letter case is not stable, so the normalized texts
/// compare case-insensitively on Windows and exactly elsewhere.
fn same_workspace(left: &Path, right: &Path) -> bool {
    let left = workspace_text(left);
    let right = workspace_text(right);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

/// Workspace permissions entries mapped to the selected project. The
/// hash→workspace mapping is probed read-only from
/// `~/.kiro/sessions/<hash>/sess_*/session.json` `workspacePaths`; only hash
/// directories whose `workspace-roots/<hash>/permissions.yaml` exists and
/// whose sessions map to `project` produce an entry. Nothing is created or
/// cached here, and unmapped hashes are never exposed.
pub(crate) fn workspace_permissions_specs(home: &Path, project: &Path) -> Vec<RuleFileSpec> {
    let root = super::kiro_root(home);
    let mut specs = Vec::new();
    let Ok(hashes) = fs::read_dir(root.join("sessions")) else {
        return specs;
    };
    let mut probes = 0usize;
    for hash in hashes.flatten() {
        if specs.len() >= MAX_STEERING_FILES || probes >= MAX_SESSION_PROBES {
            break;
        }
        // The legacy `sessions/cli` layout has no workspace mapping.
        if !hash.file_type().is_ok_and(|kind| kind.is_dir()) || hash.file_name() == "cli" {
            continue;
        }
        let hash_name = hash.file_name().to_string_lossy().into_owned();
        let Ok(sessions) = fs::read_dir(hash.path()) else {
            continue;
        };
        let mut mapped = false;
        for session in sessions.flatten() {
            if probes >= MAX_SESSION_PROBES {
                break;
            }
            let session_json = session.path().join("session.json");
            if !session_json.is_file() {
                continue;
            }
            probes += 1;
            let Ok(text) = fs::read_to_string(&session_json) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(paths) = value.get("workspacePaths").and_then(Value::as_array) else {
                continue;
            };
            if paths
                .iter()
                .filter_map(Value::as_str)
                .any(|path| same_workspace(Path::new(path), project))
            {
                mapped = true;
                break;
            }
        }
        if !mapped {
            continue;
        }
        let permissions = root
            .join("workspace-roots")
            .join(&hash_name)
            .join("permissions.yaml");
        if !permissions.is_file() {
            continue;
        }
        specs.push(RuleFileSpec {
            id: format!("permissions:{hash_name}"),
            path: permissions,
            name: "permissions.yaml".into(),
            kind: "permissions",
            enabled: true,
            writable: true,
            detail: PERMISSIONS_DETAIL,
        });
    }
    specs
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

    #[test]
    fn workspace_permissions_list_only_for_mapped_hashes_and_save_whole_file() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let project = temp.path().join("work").join("demo");
        std::fs::create_dir_all(&project).unwrap();
        let kiro = home.join(".kiro");
        // Two hash directories: one maps to the selected project, the other
        // belongs to a different workspace; the legacy `cli` layout carries
        // no mapping at all.
        let mapped = kiro.join("sessions/6156ed8f99646ea5/sess_demo-1");
        let other = kiro.join("sessions/0000000000000000/sess_demo-2");
        let legacy = kiro.join("sessions/cli");
        for (dir, workspace) in [
            (&mapped, project.display().to_string()),
            (&other, r"C:\Elsewhere\other".to_owned()),
        ] {
            fs::create_dir_all(dir).unwrap();
            fs::write(
                dir.join("session.json"),
                serde_json::json!({"workspacePaths": [workspace]}).to_string(),
            )
            .unwrap();
        }
        fs::create_dir_all(&legacy).unwrap();
        for hash in ["6156ed8f99646ea5", "0000000000000000"] {
            let roots = kiro.join("workspace-roots").join(hash);
            fs::create_dir_all(&roots).unwrap();
            fs::write(
                roots.join("permissions.yaml"),
                "rules: []\nworkspaceTrusted: true\n",
            )
            .unwrap();
        }
        // The selected project is not yet selected through the shared service
        // target: the probe maps only the hash whose sessions name it.
        let specs = workspace_permissions_specs(home, &project);
        assert_eq!(specs.len(), 1, "{specs:?}");
        let spec = &specs[0];
        assert_eq!(spec.kind, "permissions");
        assert!(spec.writable);
        assert!(spec
            .path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("workspace-roots/6156ed8f99646ea5/permissions.yaml"));
        // An unrelated project sees nothing: unmapped hashes stay hidden.
        assert!(workspace_permissions_specs(home, Path::new(r"C:\Elsewhere\other"))
            .len() == 1);
        assert!(workspace_permissions_specs(home, Path::new(r"C:\Nowhere")).is_empty());
        // A hash without workspace-roots content produces no entry even when
        // the sessions map.
        let unmapped_roots = kiro.join("workspace-roots/1111111111111111");
        fs::create_dir_all(&unmapped_roots).unwrap();
        let extra = kiro.join("sessions/1111111111111111/sess_demo-3");
        fs::create_dir_all(&extra).unwrap();
        fs::write(
            extra.join("session.json"),
            serde_json::json!({"workspacePaths": [project.display().to_string()]}).to_string(),
        )
        .unwrap();
        assert_eq!(workspace_permissions_specs(home, &project).len(), 1);
        // Windows path case is not stable across native records.
        let case_variant = project.display().to_string().to_uppercase();
        assert_eq!(
            workspace_permissions_specs(home, Path::new(&case_variant)).len(),
            1
        );
        // Whole-file save through the shared catalog keeps workspaceTrusted.
        let db = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let registry = crate::adapters::Registry::builtins();
        let target = crate::resources::rules::RuleTarget {
            context_id: None,
            tool_id: "kiro".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            baseline_hash: None,
        };
        let mut files =
            crate::resources::rules::list_files(&db, &registry, home, &target).unwrap();
        let names: Vec<_> = files.iter().map(|file| file.name.as_str()).collect();
        assert!(names.contains(&"permissions.yaml"), "{names:?}");
        let permissions = files
            .iter_mut()
            .find(|file| file.name == "permissions.yaml")
            .unwrap();
        assert_eq!(permissions.text, "rules: []\nworkspaceTrusted: true\n");
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
        crate::resources::rules::save_file(
            &db,
            &TestKeys,
            &registry,
            home,
            &target,
            &permissions.path,
            &permissions.text,
            "rules:\n- sandboxes: []\nworkspaceTrusted: true\n",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&permissions.path).unwrap(),
            "rules:\n- sandboxes: []\nworkspaceTrusted: true\n",
            "整文件保存保留 workspaceTrusted"
        );
    }
}
