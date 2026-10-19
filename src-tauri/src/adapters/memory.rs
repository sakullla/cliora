//! Memory port. Absent unless an adapter declares verified storage.
//!
//! A descriptor entry exists only when that declaration has a location, a
//! scope, and at least one operation. An unverified reason stays on the
//! declaration and never becomes a management entry. Production CLIs do not
//! declare native memory paths here.

use serde::Serialize;

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
    /// Verified storage identity owned by the adapter. Empty is not a location.
    pub location: Option<&'static str>,
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
            location: None,
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

pub trait MemoryAdapter: Sync {
    fn declaration(&self) -> MemoryDeclaration;
}

/// Publishes scope, target dimensions, and operations only for a complete
/// declaration. A non-empty unverified reason suppresses the entry.
pub(crate) fn publish(declaration: &MemoryDeclaration) -> Option<MemoryManagement> {
    if !declaration.unverified_reason.trim().is_empty() {
        return None;
    }
    if declaration.location.is_none_or(|location| location.trim().is_empty()) {
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
            location: Some("fixture:memory"),
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
    fn publish_requires_location_scope_and_an_operation() {
        assert!(publish(&verified(READ)).is_some());
        let mut missing_location = verified(READ);
        missing_location.location = None;
        assert!(publish(&missing_location).is_none());
        let mut blank_location = verified(READ);
        blank_location.location = Some("  ");
        assert!(publish(&blank_location).is_none());
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
}
