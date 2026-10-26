//! Shared draft lifecycle. Adapter calls are pure; credentials and disk writes
//! stay in intake/profile/apply services.
use super::{
    adapter::Scope,
    format,
    profile::{self, RegisteredCommon, RegisteredProfile},
};
use crate::adapters::{
    configuration::{
        ConfigurationAction, ConfigurationDescriptor, ConfigurationIssue, Documents, EditingState,
        EDITING_VERSION,
    },
    Registry,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationDraft {
    pub session_id: String,
    pub revision: u64,
    /// Request invalidation is independent from document edits.
    #[serde(default)]
    pub request_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_credential_target: Option<crate::adapters::NativeCredentialTarget>,
    pub scope: Scope,
    pub profile: RegisteredProfile,
    pub baseline_files: BTreeMap<String, String>,
    #[serde(default)]
    pub common: Option<RegisteredCommon>,
    pub view: Value,
    pub issues: Vec<ConfigurationIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<crate::adapters::configuration::ConfigurationSubject>,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<ConfigurationDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_connection: Option<profile::Connection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<super::workspace::ConfigurationCredential>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_support: Option<crate::adapters::configuration::CatalogSupport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_status: Option<String>,
    #[serde(default)]
    pub source_capabilities: Vec<super::workspace::SourceCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_target_id: Option<String>,
}

pub fn validate_state(state: &EditingState) -> Result<(), String> {
    if state.version != EDITING_VERSION
        || state
            .intents
            .iter()
            .any(|action| action.version != EDITING_VERSION)
    {
        return Err("配置编辑版本不受支持".into());
    }
    let text = serde_json::to_string(state).map_err(|error| error.to_string())?;
    if text.len() > 512_000 || state.intents.len() > 2_000 {
        return Err("配置编辑意图超过安全限制".into());
    }
    for action in &state.intents {
        profile::reject_plaintext_secrets(&action.target)?;
        if let Some(value) = &action.value {
            profile::reject_plaintext_secrets(value)?;
        }
        if let (Some(field), Some(value)) = (&action.field, &action.value) {
            let keyed = serde_json::Map::from_iter([(field.clone(), value.clone())]);
            profile::reject_plaintext_secrets(&Value::Object(keyed))?;
        }
    }
    Ok(())
}

pub fn describe(
    registry: &Registry,
    id: &str,
    scope: Scope,
) -> Result<Option<ConfigurationDescriptor>, String> {
    Ok(registry
        .get(id)
        .ok_or("未注册的 CLI 适配器")?
        .configuration()
        .map(|port| port.describe(scope)))
}

pub fn documents(registry: &Registry, profile: &RegisteredProfile) -> Result<Documents, String> {
    let adapter = registry.get(&profile.tool).ok_or("未注册的 CLI 适配器")?;
    profile
        .files
        .iter()
        .map(|(role, text)| Ok((role.clone(), format::parse(adapter.file_kind(role)?, text)?)))
        .collect()
}

/// Project each descriptor field's baseline origin for the current draft.
/// Common fields classify from the shared common-parameter locations
/// (explicit/unset only); profile and current subjects additionally classify
/// inherited values through the adapter's field location mapping. Fields the
/// adapter cannot locate keep their descriptor untouched, so editors fall
/// back to their conservative restore affordance.
fn annotate_field_origins(
    port: &dyn crate::adapters::configuration::ConfigurationAdapter,
    descriptor: &mut ConfigurationDescriptor,
    own: &Documents,
    effective: &Documents,
    scope: Scope,
    subject: crate::adapters::configuration::ConfigurationSubject,
) {
    use crate::adapters::configuration::{classify_origin, ConfigurationSubject};
    let inheritable = subject != ConfigurationSubject::Common;
    for field in &mut descriptor.fields {
        let locations: Vec<(String, Vec<String>)> = if subject == ConfigurationSubject::Common {
            port.common_parameters(scope)
                .into_iter()
                .filter(|parameter| parameter.field.id == field.id)
                .map(|parameter| (parameter.role.into(), parameter.path))
                .collect()
        } else {
            port.field_locations(&field.id, effective)
        };
        field.origin = classify_origin(own, effective, &locations, inheritable);
    }
}

/// Resolve the adapter-owned native form token for the selected installation.
/// Returns `Ok(None)` when the adapter does not gate configuration on the
/// installed version; an unresolved required form is returned as the adapter's
/// explicit unverified token so drafts can keep viewing but refuse writes.
pub fn resolve_native_form(
    registry: &Registry,
    db: &crate::database::Database,
    tool: &str,
    scope: Scope,
    home: &std::path::Path,
    project: Option<&std::path::Path>,
) -> Result<Option<String>, String> {
    let Some(port) = registry.get(tool).and_then(|adapter| adapter.configuration()) else {
        return Ok(None);
    };
    if !port.configuration_requires_version() {
        return Ok(None);
    }
    let custom: Option<String> = db.with_connection(|conn| {
        use rusqlite::OptionalExtension;
        conn.query_row(
            "SELECT path FROM installation_choices WHERE tool = ?1",
            [tool],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })?;
    let probe = super::adapter::probe_registered(
        registry,
        tool,
        custom.as_deref().map(std::path::Path::new),
        home,
        project,
        scope,
    )?;
    Ok(Some(
        port.native_form_for_version(probe_version(&probe).as_deref())
            .unwrap_or_else(|| "unverified".into()),
    ))
}

/// Version of the installation the probe actually selected.
pub fn probe_version(probe: &super::adapter::ToolProbe) -> Option<String> {
    probe
        .selected_path
        .as_ref()
        .and_then(|selected| {
            probe
                .installations
                .iter()
                .find(|item| &item.path == selected)
        })
        .and_then(|item| item.version.clone())
}

/// Upgrade at the editing/import boundary once. Connection is no longer an
/// editable source after this function; its secret reference is retained.
/// `native_form` records the resolved native form token for version-gated
/// adapters; `None` leaves persisted states untouched.
pub fn normalize_legacy(
    registry: &Registry,
    profile: &mut RegisteredProfile,
    scope: Scope,
    native_form: Option<&str>,
) -> Result<(), String> {
    let adapter = registry.get(&profile.tool).ok_or("未注册的 CLI 适配器")?;
    let port = adapter.configuration();
    let requires_version = port.is_some_and(|port| port.configuration_requires_version());
    if let Some(state) = &mut profile.editing {
        validate_state(state)?;
        if requires_version {
            if let Some(form) = native_form {
                state.native_form = Some(form.to_owned());
            }
        }
        return Ok(());
    }
    if port.is_none() {
        return Ok(());
    }
    let mut parsed = documents(registry, profile)?;
    if let Some(connection) = &profile.connection {
        for (role, overlay) in adapter.connection_documents_for_existing_for_version(
            connection,
            scope,
            &parsed,
            if requires_version { native_form } else { None },
        )? {
            let base = parsed.entry(role).or_insert_with(|| serde_json::json!({}));
            *base = format::resolve(base, &overlay, &[])?.0;
        }
    }
    profile.files = parsed
        .iter()
        .map(|(role, value)| {
            Ok((
                role.clone(),
                format::render(adapter.file_kind(role)?, value)?,
            ))
        })
        .collect::<Result<_, String>>()?;
    let mut state = EditingState {
        selected_provider: profile
            .connection
            .as_ref()
            .map(|connection| connection.provider_id.clone()),
        ..EditingState::default()
    };
    if requires_version {
        state.native_form = native_form.map(str::to_owned);
    }
    profile.editing = Some(state);
    // Keep the old opaque references until the complete effective identity is
    // available. Own files alone may omit an inherited provider/address.
    Ok(())
}

pub fn derive_connection(
    registry: &Registry,
    profile: &mut RegisteredProfile,
    parsed: &Documents,
) -> Result<(), String> {
    let port = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器")?
        .configuration()
        .ok_or("此 CLI 尚无专属配置编辑能力")?;
    let state = profile.editing.as_ref().ok_or("缺少配置编辑版本")?;
    if matches!(
        profile.authentication,
        profile::ProfileAuthentication::OAuth { .. }
            | profile::ProfileAuthentication::RebindRequired
    ) {
        profile.connection = None;
        return Ok(());
    }
    let old = profile.connection.as_ref();
    let mut connection = port.connection(parsed, state)?;
    if let Some(connection) = &mut connection {
        let same_identity = old.filter(|value| {
            value.provider_id == connection.provider_id
                && value.interface_format == connection.interface_format
                && value.base_url == connection.base_url
        });
        connection.secret_ref = same_identity.and_then(|value| value.secret_ref.clone());
        if connection.auth_env_var.is_none() {
            connection.auth_env_var = same_identity.and_then(|value| value.auth_env_var.clone());
        }
    }
    profile.connection = connection;
    Ok(())
}

fn issue(message: String) -> ConfigurationIssue {
    ConfigurationIssue {
        target: Value::Null,
        field: None,
        code: "invalid_document".into(),
        message,
    }
}

pub fn effective_documents(
    registry: &Registry,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
) -> Result<Documents, String> {
    if !profile.inherit_common {
        return documents(registry, profile);
    }
    let common = common.ok_or("此配置继承通用配置，但通用配置不存在")?;
    let roles: std::collections::BTreeSet<_> = profile
        .files
        .keys()
        .chain(common.files.keys())
        .cloned()
        .collect();
    roles
        .into_iter()
        .map(|role| {
            Ok((
                role.clone(),
                profile::resolve_registered_file(registry, profile, Some(common), &role)?.contents,
            ))
        })
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub provider_id: Option<String>,
    pub model: String,
}

/// The adapter's native inspection owns model identity, even without an HTTP
/// connection (for example, an OAuth or builtin provider configuration).
pub fn model_summary(
    registry: &Registry,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
) -> Result<Option<ModelSummary>, String> {
    let adapter = registry.get(&profile.tool).ok_or("适配器未注册")?;
    let documents = effective_documents(registry, profile, common)?;
    let inspection = super::intake::inspect_document_fields(adapter, &documents);
    // Legacy unnormalized records still apply their declared connection overlay.
    let legacy = if profile.editing.is_none() { profile.connection.as_ref() } else { None };
    let model = legacy.map(|connection| connection.model.clone()).or(inspection.model)
        .or_else(|| profile.connection.as_ref().map(|connection| connection.model.clone()));
    Ok(model.filter(|model| !model.trim().is_empty() && !model.chars().any(char::is_control)).map(|model| ModelSummary {
        provider_id: legacy.map(|connection| connection.provider_id.clone()).or(inspection.provider)
            .or_else(|| profile.connection.as_ref().map(|connection| connection.provider_id.clone())),
        model,
    }))
}

pub fn refresh(registry: &Registry, mut draft: ConfigurationDraft) -> ConfigurationDraft {
    let result = (|| {
        let adapter = registry
            .get(&draft.profile.tool)
            .ok_or("未注册的 CLI 适配器")?;
        let port = adapter
            .configuration()
            .ok_or("此 CLI 尚无专属配置编辑能力")?;
        let state = draft.profile.editing.as_ref().ok_or("缺少配置编辑版本")?;
        validate_state(state)?;
        // Prevent ordinary draft IPC from returning plaintext secrets.
        profile::validate_registered_files(registry, &draft.profile.tool, &draft.profile.files)?;
        let parsed = effective_documents(registry, &draft.profile, draft.common.as_ref())?;
        let subject = draft.subject.unwrap_or_default();
        let view = port.read_subject(&parsed, state, draft.scope, subject)?;
        let mut issues = port.validate_subject(&parsed, state, draft.scope, subject);
        let mut baseline = draft.profile.clone();
        baseline.files = draft.baseline_files.clone();
        let baseline = effective_documents(registry, &baseline, draft.common.as_ref())?;
        issues.extend(port.validate_changes(Some(&baseline), &parsed, state, draft.scope));
        if subject != crate::adapters::configuration::ConfigurationSubject::Common {
            draft.draft_connection = port.draft_connection(&parsed, state)?;
            derive_connection(registry, &mut draft.profile, &parsed)?;
        }
        if draft.subject.is_some() {
            let mut descriptor = port.describe_subject(draft.scope, subject);
            let own = documents(registry, &draft.profile)?;
            annotate_field_origins(port, &mut descriptor, &own, &parsed, draft.scope, subject);
            draft.descriptor = Some(descriptor);
            draft.catalog_support = Some(if subject == crate::adapters::configuration::ConfigurationSubject::Common {
                crate::adapters::configuration::CatalogSupport { available: false, multiple: false, reason: Some("通用配置不创建模型引用".into()) }
            } else { port.catalog_support() });
        }
        draft.view = view;
        draft.issues = issues;
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        draft.issues = vec![issue(error)];
        // A dedicated editor can still show the document and this issue.
        // Adapters with no configuration port stay without a descriptor, so
        // the workspace keeps the "no dedicated editor" state.
        if draft.descriptor.is_none() {
            if let Some(subject) = draft.subject {
                if let Some(port) = registry
                    .get(&draft.profile.tool)
                    .and_then(|adapter| adapter.configuration())
                {
                    draft.descriptor = Some(port.describe_subject(draft.scope, subject));
                    if draft.catalog_support.is_none() {
                        draft.catalog_support = Some(
                            if subject == crate::adapters::configuration::ConfigurationSubject::Common {
                                crate::adapters::configuration::CatalogSupport {
                                    available: false,
                                    multiple: false,
                                    reason: Some("通用配置不创建模型引用".into()),
                                }
                            } else {
                                port.catalog_support()
                            },
                        );
                    }
                }
            }
        }
    }
    draft
}

pub fn open(
    registry: &Registry,
    profile: RegisteredProfile,
    scope: Scope,
    session_id: String,
) -> Result<ConfigurationDraft, String> {
    open_with_common(registry, profile, None, scope, session_id)
}

pub fn open_with_common(
    registry: &Registry,
    mut profile: RegisteredProfile,
    common: Option<RegisteredCommon>,
    scope: Scope,
    session_id: String,
) -> Result<ConfigurationDraft, String> {
    if session_id.is_empty() {
        return Err("缺少配置编辑会话标识".into());
    }
    normalize_legacy(registry, &mut profile, scope, None)?;
    if profile.editing.is_none() {
        return Err("此 CLI 尚无专属配置编辑能力，请使用原有原文编辑入口".into());
    }
    let baseline_files = profile.files.clone();
    Ok(refresh(
        registry,
        ConfigurationDraft {
            session_id,
            revision: 0,
            request_generation: 0,
            native_credential_target: None,
            scope,
            profile,
            baseline_files,
            common,
            view: Value::Null,
            issues: Vec::new(),
            subject: None, context_id: None, project_path: None, descriptor: None,
            draft_connection: None, credential: None, catalog_support: None, credential_status: None, source_capabilities: Vec::new(), remote_target_id: None,
        },
    ))
}

pub fn replace_text(
    registry: &Registry,
    mut draft: ConfigurationDraft,
    files: BTreeMap<String, String>,
) -> ConfigurationDraft {
    let previous = documents(registry, &draft.profile).ok();
    draft.profile.files = files;
    draft.revision += 1;
    let coordination = (|| {
        profile::validate_registered_files(registry, &draft.profile.tool, &draft.profile.files)?;
        let next = documents(registry, &draft.profile)?;
        let effective = effective_documents(registry, &draft.profile, draft.common.as_ref())?;
        let port = registry
            .get(&draft.profile.tool)
            .ok_or("未注册的 CLI 适配器")?
            .configuration()
            .ok_or("此 CLI 尚无专属配置编辑能力")?;
        let mut state = draft.profile.editing.clone().ok_or("缺少配置编辑版本")?;
        port.reconcile_text(previous.as_ref(), &next, &effective, &mut state)?;
        port.reconcile_suppressions(previous.as_ref(), &next, &mut draft.profile.suppressed)?;
        // Raw removals use the same inheritance exclusions as form deletion.
        for action in &state.intents {
            if matches!(action.operation.as_str(), "delete" | "rename") {
                for change in port.suppression_changes(action, &state)? {
                    let paths = draft.profile.suppressed.entry(change.role).or_default();
                    if change.suppressed && !paths.contains(&change.path) {
                        paths.push(change.path);
                    }
                }
            }
        }
        validate_state(&state)?;
        draft.profile.editing = Some(state);
        Ok(())
    })();
    if let Err(error) = coordination {
        draft.issues = vec![issue(error)];
        return draft;
    }
    refresh(registry, draft)
}

pub fn edit(
    registry: &Registry,
    draft: ConfigurationDraft,
    action: ConfigurationAction,
) -> Result<ConfigurationDraft, String> {
    if action.version != EDITING_VERSION {
        return Err("配置编辑动作版本不受支持".into());
    }
    let adapter = registry
        .get(&draft.profile.tool)
        .ok_or("未注册的 CLI 适配器")?;
    let port = adapter
        .configuration()
        .ok_or("此 CLI 尚无专属配置编辑能力")?;
    let subject = draft.subject.unwrap_or_default();
    let descriptor = port.describe_subject(draft.scope, subject);
    if descriptor.version != action.version || !descriptor.operations.contains(&action.operation) {
        return Err("配置适配器未声明此编辑动作或版本".into());
    }
    let effective = effective_documents(registry, &draft.profile, draft.common.as_ref())?;
    let mut parsed = documents(registry, &draft.profile)?;
    let mut next = draft;
    let state = next.profile.editing.as_mut().ok_or("缺少配置编辑版本")?;
    port.edit_subject(&mut parsed, &effective, state, &action, next.scope, subject)?;
    // Compact obsolete values for the same logical field, stopping at entity
    // lifecycle actions because they can change the meaning of its identity.
    if matches!(action.operation.as_str(), "set" | "reset") {
        let boundary = state
            .intents
            .iter()
            .rposition(|prior| {
                prior.target == action.target
                    && !matches!(prior.operation.as_str(), "set" | "reset")
            })
            .map_or(0, |index| index + 1);
        let mut index = 0;
        state.intents.retain(|prior| {
            let keep = index < boundary
                || prior.target != action.target
                || prior.field != action.field
                || !matches!(prior.operation.as_str(), "set" | "reset");
            index += 1;
            keep
        });
    }
    state.intents.push(action);
    validate_state(state)?;
    let suppression_changes = if subject == crate::adapters::configuration::ConfigurationSubject::Common { Vec::new() }
        else { port.suppression_changes(state.intents.last().unwrap(), state)? };
    for change in suppression_changes {
        let entries = next.profile.suppressed.entry(change.role).or_default();
        if change.suppressed {
            if !entries.contains(&change.path) {
                entries.push(change.path);
            }
        } else {
            entries.retain(|path| path != &change.path);
        }
    }
    next.profile.suppressed.retain(|_, paths| !paths.is_empty());
    next.profile.files = parsed
        .iter()
        .map(|(role, value)| {
            Ok((
                role.clone(),
                format::render(adapter.file_kind(role)?, value)?,
            ))
        })
        .collect::<Result<_, String>>()?;
    next.revision += 1;
    Ok(refresh(registry, next))
}

pub fn validate_profile(
    registry: &Registry,
    profile: &mut RegisteredProfile,
    scope: Scope,
) -> Result<(), String> {
    normalize_legacy(registry, profile, scope, None)?;
    let parsed = documents(registry, profile)?;
    validate_documents(registry, profile, &parsed, scope)
}

pub fn validate_documents(
    registry: &Registry,
    profile: &mut RegisteredProfile,
    parsed: &Documents,
    scope: Scope,
) -> Result<(), String> {
    if profile.editing.is_none() {
        if registry
            .get(&profile.tool)
            .is_some_and(|adapter| adapter.configuration().is_some())
        {
            profile.editing = Some(EditingState::default());
        } else {
            return Ok(());
        }
    }
    let state = profile.editing.as_ref().unwrap();
    validate_state(state)?;
    let port = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器")?
        .configuration()
        .ok_or("配置编辑能力暂不可用；已保留原配置")?;
    let descriptor = port.describe(scope);
    if descriptor.version != state.version
        || state
            .intents
            .iter()
            .any(|action| !descriptor.operations.contains(&action.operation))
    {
        return Err("配置适配器未声明此编辑动作或版本".into());
    }
    let issues = port.validate(parsed, state, scope);
    if !issues.is_empty() {
        return Err(serde_json::to_string(&issues).map_err(|error| error.to_string())?);
    }
    derive_connection(registry, profile, parsed)
}
