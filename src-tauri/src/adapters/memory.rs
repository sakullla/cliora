//! Memory port. Absent unless an adapter declares verified storage.
//!
//! A descriptor entry exists only when the adapter declares a scope and at
//! least one operation. The adapter resolves the storage directory per
//! target; the shared engine runs every list, read, save, delete, and switch
//! on that directory and keeps its transaction, exclusion, and symlink
//! protections. A verified native family also owns its storage semantics
//! through [`MemoryLayout`]; without one the engine manages the flat
//! fixture family with engine-owned switch records. An unverified reason
//! stays on the declaration and never becomes a management entry.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::native::adapter::Scope;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    pub global: bool,
    pub project: bool,
}

impl MemoryScope {
    pub const fn declared(self) -> bool {
        self.global || self.project
    }
}

/// Dimensions a caller may select inside the declared scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryTargetDimension {
    Project,
    Account,
}

/// Verified memory operations. Read-only storage declares list and open only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryOperation {
    List,
    Open,
    Create,
    Edit,
    Delete,
    MasterSwitch,
    ItemEnable,
}

impl MemoryOperation {
    pub const fn is_write(self) -> bool {
        matches!(
            self,
            Self::Create | Self::Edit | Self::Delete | Self::MasterSwitch | Self::ItemEnable
        )
    }
}

/// Adapter-owned declaration. This is not a management entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryDeclaration {
    pub scope: MemoryScope,
    pub targets: &'static [MemoryTargetDimension],
    pub operations: &'static [MemoryOperation],
    /// Recorded when storage is not verified. Never rendered as an entry.
    pub unverified_reason: &'static str,
    /// Restriction shown when write controls are absent.
    pub limitation: &'static str,
    /// Account context participates in target matching only when this is set.
    pub binds_account: bool,
}

impl MemoryDeclaration {
    pub const fn unverified(reason: &'static str) -> Self {
        Self {
            scope: MemoryScope {
                global: false,
                project: false,
            },
            targets: &[],
            operations: &[],
            unverified_reason: reason,
            limitation: "",
            binds_account: false,
        }
    }
}

/// Management entry copied from a verified declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryManagement {
    pub scope: MemoryScope,
    pub targets: Vec<MemoryTargetDimension>,
    pub operations: Vec<MemoryOperation>,
    #[serde(default, skip_serializing_if = "str::is_empty")]
    pub limitation: &'static str,
}

/// One file change a native layout plans. The engine re-reads the target
/// inside the shared transaction and rejects it when the file no longer
/// matches the recorded baseline, so the layout only carries the disk state
/// it derived its contents from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryFileChange {
    pub path: PathBuf,
    /// `None` when the file must not exist yet.
    pub baseline: Option<String>,
    /// `None` removes the file.
    pub contents: Option<String>,
}

/// A file a native storage family lists as one memory entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryLayoutEntry {
    pub id: String,
    pub path: PathBuf,
}

/// Observed native master-switch state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemorySwitchState {
    pub enabled: bool,
    /// Usage detail when disabled; empty keeps the shared default text.
    pub detail: String,
}

/// Adapter-owned storage semantics for a verified native family: entry
/// mapping, native index upkeep, and the native master switch. The shared
/// engine keeps its transaction, baseline, exclusion, and symlink protections
/// on every path the layout returns and never writes engine-private records
/// into a native store.
pub trait MemoryLayout: Sync {
    /// Entries currently present in the resolved directory. Index and other
    /// non-entry files are not returned.
    fn entries(&self, directory: &Path) -> Result<Vec<MemoryLayoutEntry>, String>;
    /// Absolute path of one entry id inside the resolved directory.
    fn entry_path(&self, directory: &Path, id: &str) -> Result<PathBuf, String>;
    /// Index upkeep applied in the same transaction as an entry save.
    fn index_after_save(
        &self,
        directory: &Path,
        id: &str,
        text: &str,
    ) -> Result<Option<MemoryFileChange>, String>;
    /// Index upkeep applied in the same transaction as an entry delete.
    fn index_after_delete(&self, directory: &Path, id: &str)
        -> Result<Option<MemoryFileChange>, String>;
    /// Native master-switch state for usage display.
    fn switch_state(&self, home: &Path, directory: &Path) -> Result<MemorySwitchState, String>;
    /// Native master-switch write plan; `None` when the state already holds.
    fn switch_patch(
        &self,
        home: &Path,
        directory: &Path,
        enabled: bool,
    ) -> Result<Option<MemoryFileChange>, String>;
}

pub trait MemoryAdapter: Sync {
    fn declaration(&self) -> MemoryDeclaration;
    /// Resolves the storage directory for the target, or returns the reason
    /// storage is unavailable. The result must be absolute; the shared engine
    /// rejects parent-directory components, excluded paths, and reparse
    /// points before any read or write.
    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String>;
    /// Verified native storage semantics. `None` (the default) keeps the
    /// engine-managed flat family with engine-owned switch and enable
    /// records; a native layout owns the family's own semantics.
    fn layout(&self) -> Option<&dyn MemoryLayout> {
        None
    }
}

/// Publishes scope, target dimensions, and operations only for a complete
/// declaration: a declared scope and at least one operation with no
/// unverified reason. Directory availability is resolved per operation by the
/// adapter and is not part of this publication. A non-empty unverified reason
/// suppresses the entry.
pub(crate) fn publish(declaration: &MemoryDeclaration) -> Option<MemoryManagement> {
    if !declaration.unverified_reason.trim().is_empty() {
        return None;
    }
    if !declaration.scope.declared() || declaration.operations.is_empty() {
        return None;
    }
    Some(MemoryManagement {
        scope: declaration.scope,
        targets: declaration.targets.to_vec(),
        operations: declaration.operations.to_vec(),
        limitation: declaration.limitation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ: &[MemoryOperation] = &[MemoryOperation::List, MemoryOperation::Open];
    const WRITES: &[MemoryOperation] = &[
        MemoryOperation::Create,
        MemoryOperation::Edit,
        MemoryOperation::Delete,
        MemoryOperation::MasterSwitch,
        MemoryOperation::ItemEnable,
    ];
    const ACCOUNT: &[MemoryTargetDimension] = &[MemoryTargetDimension::Account];

    fn verified(operations: &'static [MemoryOperation]) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: true,
                project: false,
            },
            targets: ACCOUNT,
            operations,
            unverified_reason: "",
            limitation: "",
            binds_account: true,
        }
    }

    #[test]
    fn publish_requires_a_declared_scope_and_an_operation() {
        assert!(publish(&verified(READ)).is_some());
        let mut missing_scope = verified(READ);
        missing_scope.scope = MemoryScope {
            global: false,
            project: false,
        };
        assert!(publish(&missing_scope).is_none());
        assert!(publish(&verified(&[])).is_none());
    }

    #[test]
    fn unverified_reason_keeps_the_declaration_and_publishes_nothing() {
        let reason_only = MemoryDeclaration::unverified("尚未核实独立记忆存储");
        assert_eq!(reason_only.unverified_reason, "尚未核实独立记忆存储");
        assert!(publish(&reason_only).is_none());
        let mut complete = verified(READ);
        complete.unverified_reason = "位置尚未核实";
        assert!(publish(&complete).is_none());
        assert_eq!(complete.unverified_reason, "位置尚未核实");
    }

    #[test]
    fn read_only_publication_has_no_write_operation() {
        let published = publish(&MemoryDeclaration {
            limitation: "只读存储，不能新建、编辑、删除或启停",
            ..verified(READ)
        })
        .unwrap();
        assert_eq!(published.operations, READ);
        assert!(published.operations.iter().all(|operation| !operation.is_write()));
        for operation in WRITES {
            assert!(!published.operations.contains(operation), "{operation:?}");
        }
        assert!(published.scope.global);
        assert!(!published.scope.project);
        assert_eq!(published.targets, vec![MemoryTargetDimension::Account]);
        assert!(!published.limitation.is_empty());
    }

    #[test]
    fn directory_resolution_is_adapter_owned_per_target() {
        struct Resolved;
        impl MemoryAdapter for Resolved {
            fn declaration(&self) -> MemoryDeclaration {
                verified(READ)
            }
            fn directory(
                &self,
                scope: Scope,
                home: &Path,
                project: Option<&Path>,
            ) -> Result<PathBuf, String> {
                match (scope, project) {
                    (Scope::Project, Some(project)) => Ok(project.join("memory")),
                    (Scope::Global, _) => Ok(home.join("memory")),
                    _ => Err("该项目没有记忆目录".into()),
                }
            }
        }
        let port = Resolved;
        let home = Path::new("/home");
        assert_eq!(
            port.directory(Scope::Global, home, None).unwrap(),
            home.join("memory")
        );
        let project = Path::new("/work/app");
        assert_eq!(
            port.directory(Scope::Project, home, Some(project)).unwrap(),
            project.join("memory")
        );
        assert_eq!(
            port.directory(Scope::Project, home, None).unwrap_err(),
            "该项目没有记忆目录"
        );
    }
}
