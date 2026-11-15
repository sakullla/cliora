//! OMP Skills and rules: user/project `skills/<name>/SKILL.md`, generated
//! Skills, and OMP-owned context rule files.
//!
//! Delivered by the resources task. External providers, plugin packages and
//! builtin skills stay read-only, and only OMP's own disabled overlays may be
//! written. Until that layout is verified the capability is absent.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::adapters::{RuleFileSpec, RuleSupport, SkillObservation, SkillSwitchLocation};
use crate::native::adapter::Scope;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP Skills 与规则资源（原生根、外部来源只读、禁用覆盖）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 自有 Skills 与规则；扩展、插件与内置来源保持只读";

pub(crate) fn supported() -> bool {
    false
}

pub(crate) fn facet() -> crate::adapters::Facet {
    if supported() {
        crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        }
    } else {
        crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        }
    }
}

pub(crate) fn root(_scope: Scope, _home: &Path, _project: Option<&Path>) -> Option<PathBuf> {
    None
}

pub(crate) fn requires_manifest() -> bool {
    false
}

pub(crate) fn observations(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
) -> Vec<SkillObservation> {
    Vec::new()
}

pub(crate) fn switch_location(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
    _name: &str,
) -> Option<SkillSwitchLocation> {
    None
}

pub(crate) fn switch_requires_version() -> bool {
    false
}

pub(crate) fn switch_value(_current: &Value, _enabled: bool, _skill_path: &Path) -> Value {
    Value::Null
}

pub(crate) fn switch_enabled(_current: &Value, _skill_path: &Path) -> bool {
    true
}

pub(crate) fn switch_snapshot(current: &Value, _skill_path: &Path) -> Option<Value> {
    (!current.is_null()).then(|| current.clone())
}

pub(crate) fn switch_restore(_current: &Value, previous: Option<&Value>, _skill_path: &Path) -> Option<Value> {
    previous.cloned()
}

pub(crate) fn rule_path(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
) -> Option<PathBuf> {
    None
}

pub(crate) fn rule_support() -> RuleSupport {
    let mut support = RuleSupport::bare(false, false);
    support.global_reason = UNAVAILABLE_REASON;
    support.project_reason = UNAVAILABLE_REASON;
    support
}

pub(crate) fn uses_rule_catalog(_scope: Scope) -> bool {
    false
}

pub(crate) fn rule_file_specs(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
) -> Result<Vec<RuleFileSpec>, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn rule_create_path(_project: &Path, _name: &str) -> Result<PathBuf, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn rule_relocate(_project: &Path, _path: &Path, _enabled: bool) -> Result<PathBuf, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn rule_unavailable_reason(_scope: Scope) -> Option<&'static str> {
    Some(UNAVAILABLE_REASON)
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
