//! Shared native configuration IO, planning and transactions through registered ports.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::domain::CliId;
use crate::native::adapter::{NativeFile, Scope};
#[cfg(test)]
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
#[cfg(test)]
use crate::native::profile::{Connection, RegisteredProfile};
use crate::native::transaction::{self, ApplyOutcome, FieldChange, FilePatch};

use crate::adapters::*;
pub fn legacy_id(id: CliId) -> &'static str {
    id.stable_id()
}

pub fn known(id: CliId) -> &'static dyn CliAdapter {
    Registry::builtins()
        .get(legacy_id(id))
        .expect("built-in adapter registered")
}

pub fn file(
    role: &'static str,
    path: PathBuf,
    kind: FileKind,
    known: bool,
    reason: Option<&'static str>,
    sensitive: bool,
) -> NativeFile {
    NativeFile {
        role,
        path: path.display().to_string(),
        format: match kind {
            FileKind::Toml => "toml",
            FileKind::Json => "json",
            FileKind::Jsonc => "jsonc",
            FileKind::Yaml => "yaml",
        },
        writable: known && !sensitive,
        reason: if known {
            reason
        } else {
            Some("此版本的原生写入能力尚未验证")
        },
        sensitive,
    }
}

pub fn project_root(scope: Scope, project: Option<&Path>) -> Option<Option<&Path>> {
    match scope {
        Scope::Global => Some(None),
        Scope::Project => project.map(Some),
    }
}

pub fn import_toml_key(
    collection: &str,
    field: &str,
    active: Option<&str>,
    files: &mut BTreeMap<String, String>,
    found: &mut NativeInspection,
    pending: &mut PendingSecrets,
) -> Result<(), String> {
    let mut text = files.get("settings").cloned().unwrap_or_default();
    let parsed = crate::native::format::parse(FileKind::Toml, &text)?;
    if let Some(entries) = parsed.get(collection).and_then(Value::as_object) {
        for (name, entry) in entries {
            let Some(key) = entry.get(field).and_then(Value::as_str) else {
                continue;
            };
            if Some(name.as_str()) != active || found.connection.is_none() {
                return Err(format!("{collection}.{name}.{field} 含原生密钥，但不是完整的当前连接；请先在 CLI 中选定模型与供应商，原文件未更改"));
            }
            if key.is_empty() || key.len() > 16_384 {
                return Err("原生 API 密钥为空或过长；原文件未更改".into());
            }
            let id = format!("connection-{}", uuid::Uuid::new_v4());
            text = crate::native::format::set_path(
                FileKind::Toml,
                &text,
                &[collection.into(), name.clone(), field.into()],
                None,
            )?;
            files.insert("settings".into(), text.clone());
            found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
            pending.push((id, key.to_owned()));
        }
    }
    Ok(())
}

pub fn plan_launch(
    registry: &Registry,
    id: &str,
    version: &str,
    session: Option<&str>,
    mode: LaunchMode,
) -> Result<Vec<String>, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能生成启动参数")?;
    if version.trim().is_empty() {
        return Err("CLI 版本不可识别，无法生成启动参数".into());
    }
    if adapter.explicitly_incompatible_launch_version(version) {
        return Err("此 CLI 版本不支持所请求的启动参数".into());
    }
    if session.is_some_and(|value| value.is_empty() || value.contains(['\r', '\n', '\0'])) {
        return Err("会话 ID 无效".into());
    }
    adapter.launch_args(session, mode)
}

pub fn registered_file(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known: bool,
) -> Result<NativeFile, String> {
    registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，只能只读保留原资料")?
        .native_files(scope, home, project, known)
        .into_iter()
        .find(|file| file.role == role)
        .ok_or("此 CLI 没有指定的原生文件角色".into())
}

pub fn read_registered_file(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known: bool,
) -> Result<String, String> {
    let file = registered_file(registry, id, role, scope, home, project, known)?;
    if file.sensitive {
        return Err("受保护的原生凭据文件不能作为普通配置读取".into());
    }
    transaction::read_native(Path::new(&file.path))
}

pub fn commit_registered_patches<F>(
    registry: &Registry,
    id: &str,
    files: &[NativeFile],
    db: &Database,
    credentials: &dyn CredentialStore,
    patches: &[FilePatch],
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能写入原生配置")?;
    for patch in patches {
        let allowed = files.iter().any(|file| {
            file.writable
                && !file.sensitive
                && Path::new(&file.path) == patch.path
                && adapter.file_kind(file.role).is_ok()
                && matches!(
                    (file.format, patch.kind),
                    ("toml", FileKind::Toml)
                        | ("json", FileKind::Json)
                        | ("jsonc", FileKind::Jsonc)
                        | ("yaml", FileKind::Yaml)
                )
        });
        if !allowed {
            return Err("原生目标不在此适配器可写文件角色内".into());
        }
    }
    transaction::apply(db, credentials, patches, commit)
}

pub fn apply_registered_fields<F>(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    version: &str,
    db: &Database,
    credentials: &dyn CredentialStore,
    baseline: String,
    changes: Vec<FieldChange>,
    commit: F,
) -> Result<ApplyOutcome, String>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), String>,
{
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能写入原生配置")?;
    if version.trim().is_empty() || adapter.explicitly_incompatible_native_version(version) {
        return Err("此 CLI 版本尚未确认身份或明确不兼容原生写入".into());
    }
    let files = adapter.native_files(scope, home, project, true);
    let file = files
        .iter()
        .find(|file| file.role == role)
        .ok_or("此 CLI 没有指定的原生文件角色")?;
    let patch = FilePatch {
        path: PathBuf::from(&file.path),
        kind: match file.format {
            "toml" => FileKind::Toml,
            "json" => FileKind::Json,
            "jsonc" => FileKind::Jsonc,
            "yaml" => FileKind::Yaml,
            _ => return Err("原生文件格式不受支持".into()),
        },
        baseline,
        changes,
        sensitive: false,
        force_restrict: false,
    };
    commit_registered_patches(registry, id, &files, db, credentials, &[patch], commit)
}

/// Edit a declared native file without creating a named profile. Preserve its
/// complete text and use the same journal/CAS/recovery boundary as other writes.
pub fn save_registered_text(
    registry: &Registry,
    id: &str,
    role: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    version: &str,
    db: &Database,
    credentials: &dyn CredentialStore,
    original: &str,
    edited: &str,
) -> Result<ApplyOutcome, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能写入原生配置")?;
    if version.trim().is_empty() || adapter.explicitly_incompatible_native_version(version) {
        return Err("此 CLI 版本尚未确认身份或明确不兼容原生写入".into());
    }
    adapter.validate_role_scope(role, scope)?;
    let files = adapter.native_files(scope, home, project, true);
    let file = files
        .iter()
        .find(|file| file.role == role)
        .ok_or("此范围没有指定的原生文件")?;
    if !file.writable || file.sensitive {
        return Err("此原生文件不可编辑".into());
    }
    let path = PathBuf::from(&file.path);
    let current = transaction::read_native(&path)?;
    let kind = adapter.file_kind(role)?;
    let contents = if current == original {
        edited.to_owned()
    } else {
        crate::native::format::merge_edits(kind, original, edited, &current)?
    };
    let parsed = crate::native::format::parse(kind, &contents)?;
    adapter.validate_draft(role, &parsed)?;
    let documents = BTreeMap::from([(role.to_owned(), parsed)]);
    adapter.validate_documents(scope, &documents)?;
    if let Some(port) = adapter.configuration() {
        let issues = port.validate(&documents, &Default::default(), scope);
        if !issues.is_empty() { return Err(serde_json::to_string(&issues).map_err(|error| error.to_string())?); }
    }
    // Direct edits retain native text; no profile owns credential references.
    // Never invoke the credential-writing import pipeline here. The transaction
    // encrypts backups and restricts the replacement file's permissions instead.
    let scope_key = crate::native::apply::scope_key(scope, project)?;
    transaction::apply_text(
        db,
        credentials,
        &[transaction::TextPatch {
            path,
            baseline: current,
            contents,
            sensitive: true,
        }],
        |tx| {
            // Manual text edits invalidate profile ownership but must retain the OAuth
            // launch identity; deleting it would silently return to the default account.
            if crate::accounts::selection::current(id).is_some() {
                tx.execute("UPDATE applied_bindings SET profile_version=-1,managed='{}' WHERE scope_key=?1 AND tool=?2", rusqlite::params![scope_key,id]).map_err(|_|"无法保存账号绑定状态")?;
            } else {
                tx.execute(
                    "DELETE FROM applied_bindings WHERE scope_key = ?1 AND tool = ?2",
                    rusqlite::params![scope_key, id],
                )
                .map_err(|_| "无法保存当前配置状态")?;
            }
            Ok(())
        },
    )
}

#[cfg(test)]
#[path = "../../../tests/adapter/sixth.rs"]
mod adapter_contract_tests;
