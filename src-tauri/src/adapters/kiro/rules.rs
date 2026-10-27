//! Kiro steering rules (kiro.dev docs/steering and docs/cli/v3, cross-checked
//! with the local 2.34.2 V3 install in 01-exploration.md §2/§3).
//!
//! Native layout: global `~/.kiro/steering/` and project
//! `<project>/.kiro/steering/` hold the steering documents (base files
//! `product.md`/`tech.md`/`structure.md`). The four frontmatter modes
//! (always — the default —/fileMatch/manual/auto, all supported by V3) are
//! file content the CLI interprets; Cliora lists and edits the files without
//! parsing mode semantics. The AGENTS.md standard (workspace root,
//! subdirectories, `~/.kiro/steering/`) is always included and mode-less, and
//! that is the single-document surface the shared rules service manages:
//! `~/.kiro/steering/AGENTS.md` globally and `<project>/AGENTS.md` per
//! project. No directory catalog is declared (`catalog=false`): the steering
//! directory stays a native location described by the descriptor instead of a
//! parallel Cliora-specific mechanism.

use std::path::{Path, PathBuf};

use crate::native::adapter::Scope;

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
/// stay native and are not managed here).
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
        // The shared service treats rule_path as one composed document; the
        // steering directory stays outside it (no catalog), so writes never
        // touch product.md/tech.md/structure.md.
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
}
