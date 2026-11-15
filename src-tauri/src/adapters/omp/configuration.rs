//! OMP native configuration: default/named Profile and project `.omp` YAML
//! (`config.yml`/`config.yaml`, `models.yml`/`models.yaml`), model roles,
//! providers and secret references.
//!
//! Delivered by the configuration task. Until then the capability is absent:
//! no native file is registered, no draft is offered and no write is possible,
//! so an unsupported OMP version can never be edited through a guessed schema.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::super::configuration::{ConfigurationAdapter, PortableFieldKind};
use crate::adapters::InspectionFields;
use crate::credentials::CredentialStore;
use crate::native::adapter::{ConnectionPolicy, NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, RegisteredProfile};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 的 YAML 配置、Profile 隔离与模型角色编辑尚未交付；启用偏好不会读取或写入 ~/.omp 文件";

pub(crate) fn port() -> Option<&'static dyn ConfigurationAdapter> {
    None
}

pub(crate) fn interface_formats() -> &'static [&'static str] {
    &[]
}

pub(crate) fn file_kind(_role: &str) -> Result<FileKind, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn portable_root_fields(_role: &str) -> &'static [&'static str] {
    &[]
}

pub(crate) fn portable_field_kind(_path: &[String]) -> PortableFieldKind {
    PortableFieldKind::Unknown
}

pub(crate) fn native_files(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
    _known: bool,
) -> Vec<NativeFile> {
    Vec::new()
}

pub(crate) fn connection_policy(_scope: Scope) -> ConnectionPolicy {
    ConnectionPolicy {
        api_key: crate::native::adapter::api_key_unsupported(UNAVAILABLE_REASON),
        provider_address: crate::native::adapter::address_unsupported(UNAVAILABLE_REASON),
        projection: "single_connection",
    }
}

pub(crate) fn connection_documents(
    _connection: &Connection,
    _scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn connection_documents_for_existing(
    _connection: &Connection,
    _scope: Scope,
    _existing: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn preserve_native_fields(
    _role: &str,
    _original: &Value,
    _fields: &mut BTreeMap<String, Value>,
    _profile: &RegisteredProfile,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn write_connection_secret(
    _profile: &RegisteredProfile,
    _scope: Scope,
    _credentials: &dyn CredentialStore,
    _secrets: &mut NativeSecrets,
) -> Result<(), String> {
    Err(UNAVAILABLE_REASON.into())
}

pub(crate) fn has_native_secret(_role: &str, _root: &Value) -> bool {
    false
}

pub(crate) fn inspect_values(
    _settings: &Value,
    _local_settings: &Value,
    _models: &Value,
) -> InspectionFields {
    InspectionFields::default()
}

pub(crate) fn import_literal_secrets(
    _files: &mut BTreeMap<String, String>,
    _found: &mut NativeInspection,
    _pending: &mut super::super::PendingSecrets,
    _native_refs: &mut super::super::NativeCredentialRefs,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn validate_draft(_role: &str, _parsed: &Value) -> Result<(), String> {
    Ok(())
}

pub(crate) fn connection_roles() -> &'static [&'static str] {
    &[]
}

pub(crate) fn empty_entry_collections(_role: &str) -> &'static [&'static str] {
    &[]
}

pub(crate) fn validate_role_scope(_role: &str, _scope: Scope) -> Result<(), String> {
    Ok(())
}
// Appended verification hook: the owning task replaces the body with real cases.
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNAVAILABLE_REASON.into()))
}
