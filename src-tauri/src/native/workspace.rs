//! Workspace sessions own baselines, temporary credentials and revision checks.
//! Adapter ports own native fields; IO and credential adoption remain shared.
use super::{
    adapter::{NativeFile, Scope},
    configuration::{self, ConfigurationDraft},
    format,
    profile::{self, Connection, ProfileAuthentication, RegisteredCommon, RegisteredProfile},
    transaction,
};
use crate::adapters::{
    configuration::{ConfigurationAction, ConfigurationSubject},
    Registry,
};
use crate::credentials::CredentialStore;
use crate::database::Database;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConfigurationCredential {
    Native,
    Account {
        account_id: String,
    },
    ApiKey {
        secret_ref: Option<String>,
        #[serde(default)]
        remove: bool,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationBeginRequest {
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    pub session_id: String,
    pub subject: ConfigurationSubject,
    pub profile: Option<RegisteredProfile>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationSaveResult {
    pub draft: ConfigurationDraft,
    pub profile: Option<RegisteredProfile>,
    pub common: Option<RegisteredCommon>,
    pub application: Option<transaction::ApplyOutcome>,
}

pub struct SavedWorkspace {
    pub profiles: Vec<RegisteredProfile>,
    pub common: Option<RegisteredCommon>,
    pub binding: Option<super::apply::AppliedBinding>,
    pub profile_model_summaries: BTreeMap<String, Option<configuration::ModelSummary>>,
}
/// Recovery must remain reachable through DB records when a legacy binding
/// cannot prove its native account directory. This operation performs no IO.
pub fn saved_workspace(registry: &Registry, db: &Database, tool: &str, key: &str) -> Result<SavedWorkspace, String> {
    let profiles = profile::list_registered_profiles(db, tool)?;
    let common = profile::get_registered_common(db, tool)?;
    let binding = super::apply::get_registered_binding(db, tool, key)?.map(|mut binding| {
        binding.managed.clear();
        binding
    });
    let profile_model_summaries = profiles.iter().map(|profile| {
        (profile.id.clone(), configuration::model_summary(registry, profile, common.as_ref()).ok().flatten())
    }).collect();
    Ok(SavedWorkspace { profiles, common, binding, profile_model_summaries })
}
#[derive(Clone)]
struct Lease {
    secret: String,
    target: LeaseTarget,
}
#[derive(Clone)]
enum LeaseTarget {
    Connection(Connection),
    Native(crate::adapters::NativeCredentialTarget),
}
impl LeaseTarget {
    fn matches_connection(&self, connection: &Connection) -> bool {
        matches!(self, Self::Connection(owned) if same_connection(owned, connection))
    }
    fn matches(&self, target: &Self) -> bool {
        match (self, target) {
            (Self::Connection(a), Self::Connection(b)) => same_connection(a, b),
            (Self::Native(a), Self::Native(b)) => a == b,
            _ => false,
        }
    }
    fn from_draft(draft: &ConfigurationDraft) -> Result<Self, String> {
        if let Some(target) = &draft.native_credential_target { return Ok(Self::Native(target.clone())); }
        draft.draft_connection.clone().map(Self::Connection).ok_or_else(|| "请先完成连接，再提供 API 密钥".into())
    }
}
struct Record {
    draft: ConfigurationDraft,
    trusted_profile: Option<RegisteredProfile>,
    original_texts: BTreeMap<String, String>,
    current_files: Vec<NativeFile>,
    protected: BTreeMap<String, Vec<(Vec<String>, Value)>>,
    leases: BTreeMap<String, Lease>,
    comparison: Option<PrivateComparison>,
}
#[derive(Default)]
pub struct DraftSessions {
    records: Mutex<BTreeMap<String, Record>>,
}
fn same_connection(a: &Connection, b: &Connection) -> bool {
    a.provider_id == b.provider_id
        && a.interface_format == b.interface_format
        && a.base_url == b.base_url
}
fn draft_equal(a: &ConfigurationDraft, b: &ConfigurationDraft) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}
fn profile_from_files(tool: &str, files: BTreeMap<String, String>) -> RegisteredProfile {
    serde_json::from_value(
        json!({"id":"","tool":tool,"name":"配置草稿","version":0,"inheritCommon":false,
        "files":files,"connection":null,"nativeCredentials":{}}),
    )
    .expect("constant profile shape")
}
fn refresh(registry: &Registry, mut draft: ConfigurationDraft) -> ConfigurationDraft {
    draft.native_credential_target = if draft.subject == Some(ConfigurationSubject::Current) && draft.context_id.is_none() {
        registry.get(&draft.profile.tool).and_then(|adapter| adapter.native_credential_target(draft.scope))
    } else { None };
    draft.source_capabilities = source_capabilities(registry, &draft);
    if registry
        .get(&draft.profile.tool)
        .and_then(|adapter| adapter.configuration())
        .is_some()
    {
        return configuration::refresh(registry, draft);
    }
    let result = (|| {
        let adapter = registry.get(&draft.profile.tool).ok_or("适配器未注册")?;
        profile::validate_registered_files(registry, &draft.profile.tool, &draft.profile.files)?;
        let documents = configuration::documents(registry, &draft.profile)?;
        adapter.validate_documents(draft.scope, &documents)?;
        if let Some(mut inspected) =
            super::intake::inspect_registered(registry, &draft.profile.tool, &draft.profile.files)?
                .connection
        {
            inspected.secret_ref = draft
                .profile
                .connection
                .as_ref()
                .filter(|previous| same_connection(previous, &inspected))
                .and_then(|previous| previous.secret_ref.clone());
            draft.profile.connection = Some(inspected);
        }
        draft.draft_connection = draft.profile.connection.clone();
        draft.view = json!({"opaque":true});
        draft.descriptor = None;
        draft.catalog_support = Some(crate::adapters::configuration::CatalogSupport {
            available: !adapter.interface_formats().is_empty(),
            multiple: false,
            reason: Some("此 CLI 使用配置级模型选择；原生映射由其适配器处理".into()),
        });
        if draft.subject == Some(ConfigurationSubject::Common) {
            return Err("此 CLI 尚未声明通用字段作用域，旧通用配置只读保留".into());
        }
        Ok::<(), String>(())
    })();
    draft.issues = match result {
        Ok(()) => Vec::new(),
        Err(message) => vec![crate::adapters::configuration::ConfigurationIssue {
            target: Value::Null,
            field: None,
            code: "invalid_document".into(),
            message,
        }],
    };
    draft
}
fn redacted(
    registry: &Registry,
    tool: &str,
    raw: &BTreeMap<String, String>,
) -> Result<
    (
        BTreeMap<String, String>,
        BTreeMap<String, Vec<(Vec<String>, Value)>>,
    ),
    String,
> {
    let adapter = registry.get(tool).ok_or("适配器未注册")?;
    if adapter.configuration().is_none() {
        // The existing adapter intake is pure: discard its pending values and
        // opaque IDs instead of adopting or writing any native login credential.
        let mut files = raw.clone();
        let mut inspection = super::intake::inspect_registered(registry, tool, &files)?;
        let mut pending = Vec::new();
        let mut references = BTreeMap::new();
        adapter.import_literal_secrets(
            &mut files,
            &mut inspection,
            &mut pending,
            &mut references,
        )?;
        profile::validate_registered_files(registry, tool, &files)?;
        // Intake owns which values are removed. Preserve their coordinates in
        // memory so public parent edits cannot erase a hidden private value.
        fn protected_delta(original: &Value, public: Option<&Value>, path: &mut Vec<String>, out: &mut Vec<(Vec<String>, Value)>) {
            match (original, public) {
                (Value::Object(before), Some(Value::Object(after))) => {
                    for (key, value) in before {
                        path.push(key.clone());
                        protected_delta(value, after.get(key), path, out);
                        path.pop();
                    }
                }
                (_, Some(public)) if original == public => {},
                _ => out.push((path.clone(), original.clone())),
            }
        }
        let mut protected = BTreeMap::new();
        for (role, text) in raw {
            let kind = adapter.file_kind(role)?;
            let original = format::parse(kind, text)?;
            let public = files.get(role).map(|text| format::parse(kind, text)).transpose()?;
            let mut paths = Vec::new();
            protected_delta(&original, public.as_ref(), &mut Vec::new(), &mut paths);
            protected.insert(role.clone(), paths);
        }
        return Ok((files, protected));
    }
    let port = adapter.configuration().unwrap();
    fn scrub(
        port: &dyn crate::adapters::configuration::ConfigurationAdapter,
        value: &mut Value,
        path: &mut Vec<String>,
        protected: &mut Vec<(Vec<String>, Value)>,
    ) {
        if let Some(map) = value.as_object_mut() {
            let keys = map.keys().cloned().collect::<Vec<_>>();
            for key in keys {
                path.push(key.clone());
                if matches!(
                    port.portable_field_kind(path),
                    crate::adapters::configuration::PortableFieldKind::Credential
                ) || (matches!(
                    port.portable_field_kind(path),
                    crate::adapters::configuration::PortableFieldKind::CredentialReference
                ) && !port.portable_reference_valid(path, &map[&key]))
                {
                    protected.push((path.clone(), map.remove(&key).unwrap()));
                } else {
                    scrub(port, map.get_mut(&key).unwrap(), path, protected);
                }
                path.pop();
            }
        }
        // Arrays are preserved by stable identities by the adapter. Secret-bearing
        // arrays are rejected by ordinary draft validation instead of indexing credentials.
    }
    let mut files = BTreeMap::new();
    let mut protected = BTreeMap::new();
    for (role, text) in raw {
        let mut value = format::parse(adapter.file_kind(role)?, text)?;
        let mut paths = vec![];
        scrub(port, &mut value, &mut vec![], &mut paths);
        files.insert(
            role.clone(),
            format::render(adapter.file_kind(role)?, &value)?,
        );
        protected.insert(role.clone(), paths);
    }
    profile::validate_registered_files(registry, tool, &files)?;
    Ok((files, protected))
}
impl DraftSessions {
    /// Saved subjects need only DB state. Resolve a native identity exclusively
    /// for current-file access, retaining the unknown-binding refusal there.
    pub fn begin_registered(
        &self,
        registry: &Registry,
        db: &Database,
        request: ConfigurationBeginRequest,
        home: &std::path::Path,
        project: Option<&std::path::Path>,
    ) -> Result<ConfigurationDraft, String> {
        let _context = if request.subject == ConfigurationSubject::Current {
            Some(crate::accounts::selection::enter_bound(db, home, &request.tool_id, request.scope, project)?)
        } else { None };
        let (context_id, files) = if request.subject == ConfigurationSubject::Current {
            (crate::accounts::selection::current(&request.tool_id).map(|context| context.id),
             registry.get(&request.tool_id).ok_or("适配器未注册")?.native_files(request.scope, home, project, true))
        } else { (None, Vec::new()) };
        self.begin(registry, db, request, context_id, files)
    }
    pub fn begin(
        &self,
        registry: &Registry,
        db: &Database,
        request: ConfigurationBeginRequest,
        context_id: Option<String>,
        native_files: Vec<NativeFile>,
    ) -> Result<ConfigurationDraft, String> {
        if request.session_id.is_empty() || request.session_id.len() > 200 {
            return Err("草稿会话标识无效".into());
        }
        registry.get(&request.tool_id).ok_or("适配器未注册")?;

        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        if records.contains_key(&request.session_id) {
            return Err("草稿会话已存在，请创建新的会话标识".into());
        }
        if records.len() >= 128 {
            return Err("打开的草稿过多，请先关闭旧草稿".into());
        }
        let common = profile::get_registered_common(db, &request.tool_id)?;
        let mut originals = BTreeMap::new();
        let mut protected = BTreeMap::new();
        let mut trusted = None;
        let mut source = match request.subject {
            ConfigurationSubject::Profile => {
                let source = request.profile.ok_or("命名配置草稿缺少配置对象")?;
                if source.tool != request.tool_id {
                    return Err("草稿所属工具不匹配".into());
                }
                if !source.id.is_empty() {
                    let saved = profile::get_registered_profile(db, &source.id)?;
                    if saved.tool != source.tool
                        || saved.version != source.version
                        || saved.revision != source.revision
                    {
                        return Err("配置已变化，请重新打开草稿".into());
                    }
                    trusted = Some(saved);
                }
                source
            }
            ConfigurationSubject::Common => {
                let mut source = profile_from_files(
                    &request.tool_id,
                    common
                        .as_ref()
                        .map(|common| common.files.clone())
                        .unwrap_or_default(),
                );
                source.version = common.as_ref().map(|common| common.version).unwrap_or(0);
                source.revision = common
                    .as_ref()
                    .map(|common| common.revision.clone())
                    .unwrap_or_default();
                source
            }
            ConfigurationSubject::Current => {
                for file in &native_files {
                    if !file.sensitive {
                        originals.insert(
                            file.role.into(),
                            transaction::read_native(std::path::Path::new(&file.path))?,
                        );
                    }
                }
                let (files, hidden) = redacted(registry, &request.tool_id, &originals)?;
                protected = hidden;
                profile_from_files(&request.tool_id, files)
            }
        };
        let credential = match (&source.authentication, &source.connection) {
            (ProfileAuthentication::OAuth { account_id }, _) => ConfigurationCredential::Account {
                account_id: account_id.clone(),
            },
            (_, Some(connection)) if connection.secret_ref.is_some() => {
                ConfigurationCredential::ApiKey {
                    secret_ref: connection.secret_ref.clone(),
                    remove: false,
                }
            }
            (ProfileAuthentication::ApiKey, _) => ConfigurationCredential::ApiKey {
                secret_ref: None,
                remove: false,
            },
            _ => ConfigurationCredential::Native,
        };
        if request.subject != ConfigurationSubject::Profile {
            source.authentication = ProfileAuthentication::Native;
            source.connection = None;
            source.native_credentials.clear();
        }
        if request.subject == ConfigurationSubject::Profile {
            let adapter = registry.get(&request.tool_id).ok_or("适配器未注册")?;
            if adapter.configuration().is_none() {
                if let Some(connection) = &source.connection {
                    let mut documents = configuration::documents(registry, &source)?;
                    for (role, overlay) in adapter.connection_documents_for_existing(connection, request.scope, &documents)? {
                        let own = documents.entry(role).or_insert_with(|| json!({}));
                        *own = format::resolve(own, &overlay, &[])?.0;
                    }
                    source.files = documents.iter().map(|(role, value)| Ok((role.clone(), format::render(adapter.file_kind(role)?, value)?))).collect::<Result<_, String>>()?;
                }
            }
        }
        configuration::normalize_legacy(registry, &mut source, request.scope)?;
        let baseline_files = source.files.clone();
        let mut draft = ConfigurationDraft {
            session_id: request.session_id.clone(),
            revision: 0,
            request_generation: 0,
            native_credential_target: None,
            scope: if request.subject == ConfigurationSubject::Common {
                Scope::Global
            } else {
                request.scope
            },
            profile: source,
            baseline_files,
            common: if request.subject == ConfigurationSubject::Profile {
                common
            } else {
                None
            },
            view: Value::Null,
            issues: vec![],
            subject: Some(request.subject),
            context_id,
            project_path: request.project_path,
            descriptor: None,
            draft_connection: None,
            credential: Some(if request.subject == ConfigurationSubject::Profile {
                credential
            } else {
                ConfigurationCredential::Native
            }),
            catalog_support: None,
            credential_status: None,
            source_capabilities: Vec::new(),
        };
        draft = refresh(registry, draft);
        let mut record = Record {
            draft: draft.clone(),
            trusted_profile: trusted,
            original_texts: originals,
            current_files: native_files,
            protected,
            leases: BTreeMap::new(),
            comparison: None,
        };
        record.decorate(&mut draft);
        record.publish(&draft);
        records.insert(request.session_id, record);
        Ok(draft)
    }
    fn checked<'a>(
        records: &'a mut BTreeMap<String, Record>,
        draft: &ConfigurationDraft,
    ) -> Result<&'a mut Record, String> {
        let record = records
            .get_mut(&draft.session_id)
            .ok_or("草稿会话已关闭或失效")?;
        if !draft_equal(&record.draft, draft) {
            return Err("草稿会话或版本已变化，请等待当前操作完成".into());
        }
        Ok(record)
    }
    pub fn is_current(&self, draft: &ConfigurationDraft) -> bool {
        self.records
            .lock()
            .ok()
            .and_then(|records| {
                records
                    .get(&draft.session_id)
                    .map(|record| draft_equal(&record.draft, draft))
            })
            .unwrap_or(false)
    }
    pub fn edit(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        action: ConfigurationAction,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        let mut next = configuration::edit(registry, draft, action)?;
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn raw(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        files: BTreeMap<String, String>,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        let mut next = if registry
            .get(&draft.profile.tool)
            .and_then(|adapter| adapter.configuration())
            .is_some()
        {
            configuration::replace_text(registry, draft, files)
        } else {
            let mut next = draft;
            next.profile.files = files;
            next.revision += 1;
            refresh(registry, next)
        };
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn update(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        profile: RegisteredProfile,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if profile.id != draft.profile.id
            || profile.tool != draft.profile.tool
            || profile.version != draft.profile.version
            || profile.revision != draft.profile.revision
            || profile.files != draft.profile.files
            || profile.native_credentials != draft.profile.native_credentials
            || profile.authentication != draft.profile.authentication
            || (registry
                .get(&profile.tool)
                .and_then(|adapter| adapter.configuration())
                .is_some()
                && serde_json::to_value(&profile.connection).ok()
                    != serde_json::to_value(&draft.profile.connection).ok())
            || profile.suppressed != draft.profile.suppressed
            || profile.editing != draft.profile.editing
        {
            return Err("连接、模型、来源和原文须通过草稿专属入口修改".into());
        }
        let mut next = draft;
        next.profile.name = profile.name;
        next.profile.inherit_common = profile.inherit_common;
        next.revision += 1;
        if registry
            .get(&profile.tool)
            .and_then(|adapter| adapter.configuration())
            .is_none()
        {
            if let Some(connection) = &profile.connection {
                if connection.secret_ref
                    != next
                        .profile
                        .connection
                        .as_ref()
                        .and_then(|connection| connection.secret_ref.clone())
                {
                    return Err("密钥须通过专属临时凭据入口修改".into());
                }
                let adapter = registry.get(&profile.tool).ok_or("适配器未注册")?;
                let mut documents = configuration::documents(registry, &next.profile)?;
                for (role, overlay) in
                    adapter.connection_documents_for_existing(connection, next.scope, &documents)?
                {
                    let own = documents.entry(role).or_insert_with(|| json!({}));
                    *own = format::resolve(own, &overlay, &[])?.0;
                }
                next.profile.files = documents
                    .iter()
                    .map(|(role, value)| {
                        Ok((
                            role.clone(),
                            format::render(adapter.file_kind(role)?, value)?,
                        ))
                    })
                    .collect::<Result<_, String>>()?;
            }
            next.profile.connection = profile.connection;
        }
        if next.subject != Some(ConfigurationSubject::Profile) && next.profile.inherit_common {
            return Err("当前文件及通用配置不能继承命名配置".into());
        }
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn select_credential(
        &self,
        registry: &Registry,
        db: &Database,
        draft: ConfigurationDraft,
        credential: ConfigurationCredential,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if draft.subject == Some(ConfigurationSubject::Common)
            && credential != ConfigurationCredential::Native
        {
            return Err("通用配置不能选择认证来源".into());
        }
        let requested = match credential {
            ConfigurationCredential::Native => "native",
            ConfigurationCredential::Account { .. } => "account",
            ConfigurationCredential::ApiKey { .. } => "api_key",
        };
        if let Some(cap) = source_capabilities(registry, &draft)
            .into_iter()
            .find(|cap| cap.source == requested && !cap.available)
        {
            return Err(cap.reason.unwrap_or_else(|| "此范围不支持该来源".into()));
        }
        match &credential {
            ConfigurationCredential::Account { account_id } => {
                if draft.subject == Some(ConfigurationSubject::Current) {
                    return Err("当前文件不能通过编辑草稿纳入账号；请使用已保存命名配置".into());
                }
                let account = crate::accounts::get(db, account_id)?;
                if account.tool_id != draft.profile.tool
                    || account.state != crate::accounts::AccountState::SignedIn
                    || account.pending_login.is_some()
                    || account.context.is_none()
                    || registry
                        .get(&draft.profile.tool)
                        .and_then(|adapter| adapter.accounts())
                        .is_none()
                {
                    return Err("此账号当前不可用于该 CLI，请先完成有效登录".into());
                }
            }
            ConfigurationCredential::ApiKey {
                secret_ref: Some(id),
                ..
            } => {
                let target = LeaseTarget::from_draft(&draft)?;
                let own = record
                    .leases
                    .get(id)
                    .is_some_and(|lease| lease.target.matches(&target));
                let saved = record
                    .trusted_profile
                    .as_ref()
                    .and_then(|profile| profile.connection.as_ref())
                    .is_some_and(|saved| {
                        saved.secret_ref.as_ref() == Some(id) && target.matches_connection(saved)
                    });
                if !own && !saved {
                    return Err("此密钥引用不属于当前连接，请重新提供密钥".into());
                }
            }
            _ => (),
        }
        // Removing temporary memory leases does not touch persistent keyring IDs.

        let mut next = draft;
        next.profile.authentication = match &credential {
            ConfigurationCredential::Native => ProfileAuthentication::Native,
            ConfigurationCredential::Account { account_id } => ProfileAuthentication::OAuth {
                account_id: account_id.clone(),
            },
            ConfigurationCredential::ApiKey { .. } => ProfileAuthentication::ApiKey,
        };
        if matches!(credential, ConfigurationCredential::Account { .. }) {
            next.profile.connection = None;
            next.profile.native_credentials.clear();
        }
        next.credential = Some(credential);
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn set_secret(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        secret: String,
    ) -> Result<ConfigurationDraft, String> {
        if secret.len() > 16_384 {
            return Err("API 密钥超过长度限制".into());
        }
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if draft.subject == Some(ConfigurationSubject::Common) {
            return Err("通用配置不能包含凭据".into());
        }
        if !matches!(
            draft.credential,
            Some(ConfigurationCredential::ApiKey { .. })
        ) {
            return Err("请先明确选择 API 密钥来源".into());
        }
        let mut next = draft;
        if !secret.is_empty() {
            let target = LeaseTarget::from_draft(&next)?;
            let id = format!("connection-{}", uuid::Uuid::new_v4());
            record
                .leases
                .retain(|_, lease| !lease.target.matches(&target));
            record
                .leases
                .insert(id.clone(), Lease { secret, target });
            next.credential = Some(ConfigurationCredential::ApiKey {
                secret_ref: Some(id),
                remove: false,
            });
        }
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.records
            .lock()
            .map_err(|_| "草稿会话暂不可用")?
            .remove(session_id);
        Ok(())
    }
    pub fn cancel_requests(&self, draft: ConfigurationDraft) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        let mut next = draft;
        next.request_generation = next.request_generation.checked_add(1).ok_or("请求代次已耗尽，请重新打开草稿")?;
        // No document change, source switch, or lease cleanup occurs here.
        record.publish(&next);
        Ok(next)
    }
    pub fn add_models(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        ids: Vec<String>,
    ) -> Result<ConfigurationDraft, String> {
        if ids.is_empty()
            || ids.len() > 100
            || ids.iter().any(|id| {
                id.trim().is_empty() || id.len() > 200 || id.chars().any(char::is_control)
            })
        {
            return Err("模型目录选择无效或超过100项".into());
        }
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if draft.subject == Some(ConfigurationSubject::Common) {
            return Err("通用配置不设置模型引用".into());
        }
        let adapter = registry.get(&draft.profile.tool).ok_or("适配器未注册")?;
        if adapter.configuration().is_none() {
            if ids.len() != 1 {
                return Err("此 CLI 使用单个配置级模型，请选择一项".into());
            }
            let mut next = draft;
            let connection = next.profile.connection.as_mut().ok_or("请先完成连接")?;
            connection.model = ids[0].clone();
            let mut documents = configuration::documents(registry, &next.profile)?;
            for (role, overlay) in adapter.connection_documents_for_existing(
                next.profile.connection.as_ref().unwrap(),
                next.scope,
                &documents,
            )? {
                let own = documents.entry(role).or_insert_with(|| json!({}));
                *own = format::resolve(own, &overlay, &[])?.0;
            }
            next.profile.files = documents
                .iter()
                .map(|(role, value)| {
                    Ok((
                        role.clone(),
                        format::render(adapter.file_kind(role)?, value)?,
                    ))
                })
                .collect::<Result<_, String>>()?;
            next.revision += 1;
            let mut next = refresh(registry, next);
            record.decorate(&mut next);
            record.publish(&next);
            return Ok(next);
        }
        let port = adapter.configuration().unwrap();
        let effective =
            configuration::effective_documents(registry, &draft.profile, draft.common.as_ref())?;
        let mut ids = ids;
        ids.sort();
        ids.dedup();
        let actions = port.catalog_actions(
            &effective,
            draft.profile.editing.as_ref().ok_or("无编辑状态")?,
            &ids,
        )?;
        let mut next = draft;
        for action in actions {
            next = configuration::edit(registry, next, action)?;
        }
        // Even a selection containing only preexisting models advances the session.
        if next.revision == record.draft.revision {
            next.revision += 1;
            next = refresh(registry, next);
        }
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    /// Resolve only the explicitly selected API source. Native/OAuth credentials
    /// are never copied into HTTP requests or silently replaced by another source.
    pub fn request(
        &self,
        draft: &ConfigurationDraft,
        store: &dyn CredentialStore,
    ) -> Result<(Connection, RequestCredential), String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, draft)?;
        if draft.native_credential_target.is_some() {
            return Err("此来源仅写入原生密钥，不授权 HTTP 模型目录或诊断，请使用 CLI 原生能力".into());
        }
        let mut connection = draft
            .draft_connection
            .clone()
            .ok_or("请先完成当前草稿连接")?;
        let id=match &draft.credential {
            Some(ConfigurationCredential::ApiKey{secret_ref:Some(id),..})=>id,
            Some(ConfigurationCredential::ApiKey{secret_ref:None,..})=>return Err("请为当前连接提供 API 密钥，不会回退到原生登录或其它供应商凭据".into()),
            _=>return Err("当前原生/账号来源不提供 HTTP 模型目录凭据；不会复制登录凭据，请使用该来源的原生能力或明确选择 API 密钥".into()),
        };
        let secret = if let Some(lease) = record.leases.get(id) {
            if !lease.target.matches_connection(&connection) {
                return Err("连接已变化，请重新提供对应密钥".into());
            }
            lease.secret.clone()
        } else {
            let saved = record
                .trusted_profile
                .as_ref()
                .and_then(|profile| profile.connection.as_ref())
                .ok_or("此密钥引用未由已保存对象拥有")?;
            if saved.secret_ref.as_ref() != Some(id) || !same_connection(saved, &connection) {
                return Err("此密钥引用不属于当前连接".into());
            }
            store.get(id)?
        };
        connection.secret_ref = Some(id.clone());
        connection.auth_env_var = None;
        Ok((
            connection,
            RequestCredential {
                id: id.clone(),
                secret,
            },
        ))
    }
    pub fn finish_request(&self, draft: &ConfigurationDraft) -> Result<(), String> {
        if self.is_current(draft) {
            Ok(())
        } else {
            Err("请求所属草稿已变化或取消，旧结果已丢弃".into())
        }
    }
}
/// Request-scoped access grants exactly one selected credential; no mutation or fallback.
pub struct RequestCredential {
    id: String,
    secret: String,
}
impl CredentialStore for RequestCredential {
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        Err("请求凭据只读".into())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        if id == self.id {
            Ok(self.secret.clone())
        } else {
            Err("请求未授权此凭据".into())
        }
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("请求凭据只读".into())
    }
}

pub fn validate_common(registry: &Registry, common: &RegisteredCommon) -> Result<(), String> {
    profile::validate_registered_files(registry, &common.tool, &common.files)?;
    let adapter = registry.get(&common.tool).ok_or("适配器未注册")?;
    if let Some(port) = adapter.configuration() {
        let documents = common
            .files
            .iter()
            .map(|(role, text)| Ok((role.clone(), format::parse(adapter.file_kind(role)?, text)?)))
            .collect::<Result<_, String>>()?;
        let issues = port.validate_subject(
            &documents,
            &Default::default(),
            Scope::Global,
            ConfigurationSubject::Common,
        );
        if !issues.is_empty() {
            return Err(serde_json::to_string(&issues).map_err(|error| error.to_string())?);
        }
    }
    Ok(())
}
fn apply_credential(
    record: &Record,
    draft: &mut ConfigurationDraft,
) -> Result<Option<(String, String)>, String> {
    draft.profile.native_credentials.clear();
    match draft
        .credential
        .as_ref()
        .unwrap_or(&ConfigurationCredential::Native)
    {
        ConfigurationCredential::Native => {
            draft.profile.authentication = ProfileAuthentication::Native;
            if let Some(connection) = &mut draft.profile.connection {
                connection.secret_ref = None;
            }
            Ok(None)
        }
        ConfigurationCredential::Account { account_id } => {
            draft.profile.authentication = ProfileAuthentication::OAuth {
                account_id: account_id.clone(),
            };
            draft.profile.connection = None;
            Ok(None)
        }
        ConfigurationCredential::ApiKey { secret_ref, remove } => {
            if let Some(target) = &draft.native_credential_target {
                if draft.subject != Some(ConfigurationSubject::Current) || draft.context_id.is_some() {
                    return Err("此原生密钥目标不适用于当前范围".into());
                }
                if *remove { return Ok(None); }
                let id = secret_ref.as_ref().ok_or("请明确提供此原生目标的新密钥；不会沿用隐藏的原生密钥")?;
                let lease = record.leases.get(id).ok_or("原生密钥临时引用已失效")?;
                if !lease.target.matches(&LeaseTarget::Native(target.clone())) {
                    return Err("原生密钥目标已变化，请重新提供".into());
                }
                return Ok(Some((id.clone(), lease.secret.clone())));
            }
            let connection = draft
                .profile
                .connection
                .as_mut()
                .ok_or("请先明确选择有效默认模型，才能保存 API 连接")?;
            if *remove {
                connection.secret_ref = None;
                connection.auth_env_var = None;
                draft.profile.authentication = ProfileAuthentication::ApiKey;
                return Ok(None);
            }
            let id = secret_ref
                .as_ref()
                .ok_or("请为此连接提供 API 密钥；空引用不会回退到旧密钥")?;
            let lease = record.leases.get(id);
            if let Some(lease) = lease {
                if !lease.target.matches_connection(connection) {
                    return Err("当前默认连接与新密钥目标不一致，请先设置对应默认模型".into());
                }
            } else {
                let saved = record
                    .trusted_profile
                    .as_ref()
                    .and_then(|profile| profile.connection.as_ref())
                    .ok_or("此密钥未由原配置持有")?;
                if saved.secret_ref.as_ref() != Some(id) || !same_connection(saved, connection) {
                    return Err("连接身份变化，请提供新目标凭据".into());
                }
            }
            connection.secret_ref = Some(id.clone());
            connection.auth_env_var = None;
            draft.profile.authentication = ProfileAuthentication::ApiKey;
            Ok(lease.map(|lease| (id.clone(), lease.secret.clone())))
        }
    }
}
/// Keep adoption failure cleanup in the same DB exclusion boundary as reference checks.
fn cleanup_failed_adoption(
    db: &Database,
    store: &dyn CredentialStore,
    id: &str,
) -> Result<(), String> {
    db.with_connection(|conn| {
        fn contains(value: &Value, id: &str) -> bool {
            match value {
                Value::String(value) => value == id,
                Value::Array(values) => values.iter().any(|value| contains(value, id)),
                Value::Object(values) => values.values().any(|value| contains(value, id)),
                _ => false,
            }
        }
        for table in [
            "native_profiles",
            "common_configs",
            "usage_queries",
            "auth_accounts",
        ] {
            let mut statement = conn
                .prepare(&format!("SELECT data FROM {table}"))
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            for row in rows {
                if serde_json::from_str::<Value>(&row.map_err(|error| error.to_string())?)
                    .is_ok_and(|value| contains(&value, id))
                {
                    return Ok(());
                }
            }
        }
        store.delete(id)
    })
}
impl DraftSessions {
    pub fn save_database(
        &self,
        registry: &Registry,
        db: &Database,
        store: &dyn CredentialStore,
        draft: ConfigurationDraft,
    ) -> Result<ConfigurationSaveResult, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if !draft.issues.is_empty() {
            return Err("草稿存在字段问题，请修正后保存".into());
        }
        let mut next = draft;
        let (saved_profile, saved_common) = match next.subject.unwrap_or_default() {
            ConfigurationSubject::Current => {
                return Err("当前文件需通过显式文件保存入口提交".into())
            }
            ConfigurationSubject::Common => {
                let common = RegisteredCommon {
                    tool: next.profile.tool.clone(),
                    version: next.profile.version,
                    revision: next.profile.revision.clone(),
                    files: next.profile.files.clone(),
                };
                validate_common(registry, &common)?;
                let saved = profile::save_registered_common(
                    db,
                    registry,
                    common,
                    (next.profile.version > 0).then_some(next.profile.version),
                )?;
                next.profile.version = saved.version;
                next.profile.revision = saved.revision.clone();
                next.profile.files = saved.files.clone();
                (None, Some(saved))
            }
            ConfigurationSubject::Profile => {
                let adopted = apply_credential(record, &mut next)?;
                if matches!(
                    next.credential,
                    Some(ConfigurationCredential::ApiKey { remove: true, .. })
                ) {
                    clear_credential_references(registry, &mut next.profile)?;
                }
                // Validate before publishing the fresh opaque lease to the system store.
                let current_common = profile::get_registered_common(db, &next.profile.tool)?;
                if next.profile.inherit_common
                    && serde_json::to_value(&current_common).ok()
                        != serde_json::to_value(&next.common).ok()
                {
                    return Err("通用配置已变化，请重开或合并后再保存".into());
                }
                let effective = configuration::effective_documents(
                    registry,
                    &next.profile,
                    current_common.as_ref(),
                )?;
                configuration::validate_documents(
                    registry,
                    &mut next.profile,
                    &effective,
                    next.scope,
                )?;
                if let Some((id, secret)) = &adopted {
                    store.put(id, secret)?;
                }
                let expected = (!next.profile.id.is_empty()).then_some(next.profile.version);
                let saved = match profile::save_registered_profile(
                    db,
                    registry,
                    next.profile.clone(),
                    expected,
                ) {
                    Ok(saved) => saved,
                    Err(error) => {
                        if let Some((id, _)) = &adopted {
                            if cleanup_failed_adoption(db, store, id).is_err() {
                                return Err(format!(
                                    "{error}；本次新密钥清理失败，请检查凭据服务后重试"
                                ));
                            }
                        }
                        return Err(error);
                    }
                };
                if let Some((id, _)) = &adopted {
                    record.leases.remove(id);
                }
                record.trusted_profile = Some(saved.clone());
                next.profile = saved.clone();
                (Some(saved), None)
            }
        };
        next.baseline_files = next.profile.files.clone();
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(ConfigurationSaveResult {
            draft: next,
            profile: saved_profile,
            common: saved_common,
            application: None,
        })
    }
    pub fn save_current(
        &self,
        registry: &Registry,
        db: &Database,
        store: &dyn CredentialStore,
        draft: ConfigurationDraft,
        fresh_files: &[NativeFile],
    ) -> Result<ConfigurationSaveResult, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if draft.subject != Some(ConfigurationSubject::Current) || !draft.issues.is_empty() {
            return Err("当前文件草稿无效，请修正后再保存".into());
        }
        crate::accounts::selection::validate_expected(
            &draft.profile.tool,
            draft.context_id.as_deref(),
        )?;
        let adapter = registry.get(&draft.profile.tool).ok_or("适配器未注册")?;
        let mut credential_profile = draft.clone();
        if draft.context_id.is_some()
            && matches!(
                draft.credential,
                Some(ConfigurationCredential::ApiKey { .. })
            )
        {
            return Err("受管账号上下文不能植入API密钥；请使用独立命名配置".into());
        }
        let lease = apply_credential(record, &mut credential_profile)?;
        let credentials = CurrentCredentialStore {
            lease: lease.as_ref(),
            persistent: store,
        };
        let mut secret_plan = super::apply::NativeSecrets::default();
        if matches!(
            draft.credential,
            Some(ConfigurationCredential::ApiKey { .. })
        ) {
            if let Some(target) = &draft.native_credential_target {
                for path in &target.remove_paths {
                    secret_plan.remove(&target.role, &path.iter().map(String::as_str).collect::<Vec<_>>());
                }
                if let Some((_, secret)) = &lease {
                    secret_plan.put(&target.role, &target.path.iter().map(String::as_str).collect::<Vec<_>>(), secret.clone());
                }
            } else {
                adapter.reject_new_secret(&credential_profile.profile, draft.scope)?;
                if matches!(
                    draft.credential,
                    Some(ConfigurationCredential::ApiKey { remove: true, .. })
                ) {
                    clear_credential_references(registry, &mut credential_profile.profile)?;
                }
                let documents = configuration::documents(registry, &credential_profile.profile)?;
                adapter.write_connection_secret_for_documents(
                    &credential_profile.profile,
                    draft.scope,
                    &credentials,
                    &mut secret_plan,
                    &documents,
                )?;
            }
        }
        let mut patches = vec![];
        for (role, original) in &record.original_texts {
            let initial = record
                .current_files
                .iter()
                .find(|file| file.role == role)
                .ok_or("初始文件角色不匹配")?;
            let fresh = fresh_files
                .iter()
                .find(|file| {
                    file.role == role
                        && file.path == initial.path
                        && file.writable
                        && !file.sensitive
                })
                .ok_or("当前 CLI 文件角色或写入能力已变化")?;
            let kind = adapter.file_kind(role)?;
            let edited = draft
                .profile
                .files
                .get(role)
                .ok_or("不能通过普通草稿删除整个原生文件角色")?;
            let baseline_public = draft.baseline_files.get(role).ok_or("缺少原文基线")?;
            let current = transaction::read_native(std::path::Path::new(&fresh.path))?;
            if &current != original {
                return Err("原生文件已被外部修改，请先比较并合并后再保存".into());
            }
            // Apply public field deltas to the private baseline; untouched credential
            // nodes and unrelated formatting never leave the Rust session.
            let mut contents = secret_plan.apply_text(
                role,
                kind,
                patch_public_native(
                    kind,
                    baseline_public,
                    edited,
                    original,
                    record.protected.get(role).map(Vec::as_slice).unwrap_or(&[]),
                )?,
            )?;
            if matches!(
                draft.credential,
                Some(ConfigurationCredential::ApiKey { remove: true, .. })
            ) {
                if let (Some(port), Some(connection)) = (
                    adapter.configuration(),
                    &credential_profile.profile.connection,
                ) {
                    for (target, path) in port.credential_paths(connection) {
                        if target == role {
                            contents = format::set_path(kind, &contents, &path, None)?;
                        }
                    }
                } else {
                    contents = redacted(
                        registry,
                        &draft.profile.tool,
                        &BTreeMap::from([(role.clone(), contents)]),
                    )?
                    .0
                    .remove(role)
                    .ok_or("此凭据节点不能安全移除")?;
                }
            }
            format::parse(kind, &contents)?;
            patches.push(transaction::TextPatch {
                path: std::path::PathBuf::from(&fresh.path),
                baseline: current,
                contents,
                sensitive: true,
            });
        }
        let candidate = patches
            .iter()
            .zip(record.original_texts.keys())
            .map(|(patch, role)| (role.clone(), patch.contents.clone()))
            .collect::<BTreeMap<_, _>>();
        let (public, _) = redacted(registry, &draft.profile.tool, &candidate)?;
        let documents: BTreeMap<String, Value> = public
            .iter()
            .map(|(role, text)| Ok((role.clone(), format::parse(adapter.file_kind(role)?, text)?)))
            .collect::<Result<_, String>>()?;
        for (role, value) in &documents {
            adapter.validate_draft(role, value)?;
        }
        adapter.validate_documents(draft.scope, &documents)?;
        let key = super::apply::scope_key(
            draft.scope,
            draft.project_path.as_deref().map(std::path::Path::new),
        )?;
        let outcome = transaction::apply_text(db, store, &patches, |tx| {
            invalidate_current_binding(tx, &draft.profile.tool, &key, draft.context_id.as_deref())
        })?;
        record.original_texts = patches
            .iter()
            .zip(record.original_texts.keys())
            .map(|(patch, role)| (role.clone(), patch.contents.clone()))
            .collect();
        let (public, protected) = redacted(registry, &draft.profile.tool, &record.original_texts)?;
        record.protected = protected;
        let mut next = draft;
        next.profile.files = public;
        next.baseline_files = next.profile.files.clone();
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(ConfigurationSaveResult {
            draft: next,
            profile: None,
            common: None,
            application: Some(outcome),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonInfluenceTarget {
    pub scope_key: String,
    pub profile_id: String,
    pub profile_name: String,
    pub profile_version: u64,
    pub profile_revision: String,
    pub applied_version: i64,
    pub context_id: Option<String>,
    pub scope: Scope,
    pub project_path: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonInfluence {
    pub tool_id: String,
    pub common_version: Option<u64>,
    pub common_revision: Option<String>,
    pub targets: Vec<CommonInfluenceTarget>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonApplicationResult {
    pub scope_key: String,
    pub profile_id: String,
    pub status: String,
    pub detail: Option<String>,
}
pub fn common_influence(db: &Database, tool: &str) -> Result<CommonInfluence, String> {
    let common = profile::get_registered_common(db, tool)?;
    let rows:Vec<(String,String,i64,Option<String>)>=db.with_connection(|conn|{
        let mut statement=conn.prepare("SELECT scope_key,profile_id,profile_version,context_id FROM applied_bindings WHERE tool=?1 ORDER BY scope_key").map_err(|error|error.to_string())?;
        let rows=statement.query_map([tool],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|error|error.to_string())?;
        rows.map(|row|row.map_err(|error|error.to_string())).collect()
    })?;
    let mut targets = vec![];
    for (scope_key, id, applied_version, context_id) in rows {
        let profile = profile::get_registered_profile(db, &id)?;
        if profile.tool != tool || !profile.inherit_common {
            continue;
        }
        let (_, logical) = crate::accounts::selection::split_key(&scope_key);
        if logical != scope_key {
            let active = super::apply::get_registered_binding(db, tool, logical)?;
            if active
                .as_ref()
                .is_some_and(|binding| binding.context_id == context_id && binding.profile_id == id)
            {
                continue;
            }
            // A retained namespace is not the presently selected scope.
            if active.is_some() {
                continue;
            }
        }
        let (scope, project_path) = if logical == "global" {
            (Scope::Global, None)
        } else if let Some(path) = logical.strip_prefix("project:") {
            (Scope::Project, Some(path.into()))
        } else {
            continue;
        };
        targets.push(CommonInfluenceTarget {
            scope_key,
            profile_id: id,
            profile_name: profile.name,
            profile_version: profile.version,
            profile_revision: profile.revision,
            applied_version,
            context_id,
            scope,
            project_path,
        });
    }
    Ok(CommonInfluence {
        tool_id: tool.into(),
        common_version: common.as_ref().map(|common| common.version),
        common_revision: common.map(|common| common.revision),
        targets,
    })
}
/// The real, selected binding and both DB revisions are rechecked before every
/// individual application. Success in one scope does not claim global atomicity.
pub fn apply_common<F>(
    registry: &Registry,
    db: &Database,
    common: &RegisteredCommon,
    targets: &[CommonInfluenceTarget],
    mut apply: F,
) -> Result<Vec<CommonApplicationResult>, String>
where
    F: FnMut(
        &CommonInfluenceTarget,
        &RegisteredProfile,
        &super::apply::AppliedBinding,
    ) -> Result<transaction::ApplyOutcome, String>,
{
    validate_common(registry, common)?;
    let mut results = vec![];
    let mut seen = std::collections::BTreeSet::new();
    for target in targets {
        if !seen.insert(target.scope_key.clone()) {
            return Err("应用范围有重复目标".into());
        }
        let checked = (|| {
            let current =
                profile::get_registered_common(db, &common.tool)?.ok_or("通用配置不存在")?;
            if serde_json::to_value(current).ok() != serde_json::to_value(common).ok() {
                return Err("通用配置已变化，请重新查看影响范围后应用".into());
            }
            let influence = common_influence(db, &common.tool)?;
            let present = influence
                .targets
                .iter()
                .find(|current| current.scope_key == target.scope_key)
                .ok_or("此范围不再继承通用配置")?;
            if serde_json::to_value(present).ok() != serde_json::to_value(target).ok() {
                return Err("此范围的配置、版本或账号上下文已变化，请重新查看影响范围".into());
            }
            let binding =
                super::apply::get_registered_binding(db, &common.tool, &target.scope_key)?
                    .ok_or("范围绑定已不存在")?;
            let snapshot = binding
                .applied_profile
                .as_ref()
                .ok_or("旧绑定的应用身份未知，请明确使用已保存配置后重试")?;
            let profile = profile::get_registered_profile(db, &target.profile_id)?;
            if target.applied_version < 0
                || profile.version != binding.profile_version
                || profile.revision != snapshot.source_profile.revision
            {
                return Err("此范围有未应用的命名配置或当前文件修改，请先明确使用目标配置；不会借通用应用激活新连接或账号".into());
            }
            apply(target, &profile, &binding)
        })();
        results.push(match checked {
            Ok(outcome) => CommonApplicationResult {
                scope_key: target.scope_key.clone(),
                profile_id: target.profile_id.clone(),
                status: outcome.status.into(),
                detail: None,
            },
            Err(error) => CommonApplicationResult {
                scope_key: target.scope_key.clone(),
                profile_id: target.profile_id.clone(),
                status: "failed".into(),
                detail: Some(error),
            },
        });
    }
    Ok(results)
}

impl Record {
    fn decorate(&self, draft: &mut ConfigurationDraft) {
        draft.credential_status = Some(
            match &draft.credential {
                Some(ConfigurationCredential::ApiKey { remove: true, .. }) => "removed",
                Some(ConfigurationCredential::ApiKey {
                    secret_ref: Some(id),
                    ..
                }) if self.leases.contains_key(id) => "draft",
                Some(ConfigurationCredential::ApiKey {
                    secret_ref: Some(id),
                    ..
                }) if self
                    .trusted_profile
                    .as_ref()
                    .and_then(|profile| profile.connection.as_ref())
                    .is_some_and(|connection| connection.secret_ref.as_ref() == Some(id)) =>
                {
                    "stored"
                }
                _ => "none",
            }
            .into(),
        );
    }
    fn publish(&mut self, draft: &ConfigurationDraft) {
        self.draft = draft.clone();
    }
}
impl DraftSessions {
    pub fn remove_secret(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if !matches!(
            draft.credential,
            Some(ConfigurationCredential::ApiKey { .. })
        ) {
            return Err("请先选择 API 来源再明确移除密钥".into());
        }
        if let Some(ConfigurationCredential::ApiKey {
            secret_ref: Some(id),
            ..
        }) = &draft.credential
        {
            record.leases.remove(id);
        }
        let mut next = draft;
        next.credential = Some(ConfigurationCredential::ApiKey {
            secret_ref: None,
            remove: true,
        });
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn reveal_secret(
        &self,
        draft: &ConfigurationDraft,
        store: &dyn CredentialStore,
    ) -> Result<String, String> {
        if let Some(target) = &draft.native_credential_target {
            let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
            let record = Self::checked(&mut records, draft)?;
            let Some(ConfigurationCredential::ApiKey { secret_ref: Some(id), remove: false }) = &draft.credential else {
                return Err("当前来源没有可显示的草稿密钥".into());
            };
            let lease = record.leases.get(id).ok_or("原生草稿密钥已失效")?;
            if !lease.target.matches(&LeaseTarget::Native(target.clone())) { return Err("原生密钥目标已变化".into()); }
            return Ok(lease.secret.clone());
        }
        let (connection, credential) = self.request(draft, store)?;
        credential.get(
            connection
                .secret_ref
                .as_deref()
                .ok_or("当前来源没有可显示的密钥")?,
        )
    }
}

struct PrivateComparison {
    id: String,
    revision: u64,
    current: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationCurrentComparison {
    pub comparison_id: String,
    pub session_id: String,
    pub revision: u64,
    pub context_id: Option<String>,
    pub files: Vec<CurrentComparisonFile>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentComparisonFile {
    pub role: String,
    pub original: String,
    pub current: String,
    pub edited: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationBackupPreview {
    pub session_id: String,
    pub revision: u64,
    pub role: String,
    pub transaction_id: String,
    pub current: String,
    pub original: String,
}
impl DraftSessions {
    pub fn compare_current(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
    ) -> Result<ConfigurationCurrentComparison, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        if draft.subject != Some(ConfigurationSubject::Current) {
            return Err("此草稿不是当前文件".into());
        }
        crate::accounts::selection::validate_expected(
            &draft.profile.tool,
            draft.context_id.as_deref(),
        )?;
        let current = record
            .current_files
            .iter()
            .filter(|file| !file.sensitive)
            .map(|file| {
                Ok((
                    file.role.into(),
                    transaction::read_native(std::path::Path::new(&file.path))?,
                ))
            })
            .collect::<Result<BTreeMap<String, String>, String>>()?;
        let (public, _) = redacted(registry, &draft.profile.tool, &current)?;
        let files = public
            .iter()
            .map(|(role, current)| CurrentComparisonFile {
                role: role.clone(),
                current: current.clone(),
                original: draft.baseline_files.get(role).cloned().unwrap_or_default(),
                edited: draft.profile.files.get(role).cloned().unwrap_or_default(),
            })
            .collect();
        let id = uuid::Uuid::new_v4().to_string();
        record.comparison = Some(PrivateComparison {
            id: id.clone(),
            revision: draft.revision,
            current,
        });
        Ok(ConfigurationCurrentComparison {
            comparison_id: id,
            session_id: draft.session_id,
            revision: draft.revision,
            context_id: draft.context_id,
            files,
        })
    }
    pub fn rebase_current(
        &self,
        registry: &Registry,
        draft: ConfigurationDraft,
        comparison_id: String,
        files: BTreeMap<String, String>,
    ) -> Result<ConfigurationDraft, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        let comparison = record
            .comparison
            .as_ref()
            .filter(|comparison| {
                comparison.id == comparison_id && comparison.revision == draft.revision
            })
            .ok_or("比较已失效，请重新比较当前文件")?;
        crate::accounts::selection::validate_expected(
            &draft.profile.tool,
            draft.context_id.as_deref(),
        )?;
        for file in record.current_files.iter().filter(|file| !file.sensitive) {
            if comparison.current.get(file.role)
                != Some(&transaction::read_native(std::path::Path::new(&file.path))?)
            {
                return Err("比较后原生文件又被修改，请重新比较".into());
            }
        }
        if files.keys().ne(comparison.current.keys()) {
            return Err("合并文件角色与比较范围不一致".into());
        }
        let (current_public, protected) =
            redacted(registry, &draft.profile.tool, &comparison.current)?;
        profile::validate_registered_files(registry, &draft.profile.tool, &files)?;
        let mut next = draft;
        next.baseline_files = current_public;
        next.profile.files = files;
        next.revision += 1;
        let mut next = refresh(registry, next);
        if !next.issues.is_empty() {
            return Err("合并结果有原生字段问题，请继续修正后再采用".into());
        }
        record.original_texts = comparison.current.clone();
        record.protected = protected;
        record.comparison = None;
        record.decorate(&mut next);
        record.publish(&next);
        Ok(next)
    }
    pub fn preview_backup(
        &self,
        registry: &Registry,
        db: &Database,
        store: &dyn CredentialStore,
        draft: ConfigurationDraft,
        role: String,
        transaction_id: String,
    ) -> Result<ConfigurationBackupPreview, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        crate::accounts::selection::validate_expected(
            &draft.profile.tool,
            draft.context_id.as_deref(),
        )?;
        let file = record
            .current_files
            .iter()
            .find(|file| file.role == role && !file.sensitive)
            .ok_or("此草稿没有该原生文件角色")?;
        let preview = transaction::preview_backup(
            db,
            store,
            std::path::Path::new(&file.path),
            &transaction_id,
        )?;
        let current = redacted(
            registry,
            &draft.profile.tool,
            &BTreeMap::from([(role.clone(), preview.current)]),
        )?
        .0
        .remove(&role)
        .ok_or("当前文件不可安全展示")?;
        let original = redacted(
            registry,
            &draft.profile.tool,
            &BTreeMap::from([(role.clone(), preview.original)]),
        )?
        .0
        .remove(&role)
        .ok_or("备份不可安全展示")?;
        Ok(ConfigurationBackupPreview {
            session_id: draft.session_id,
            revision: draft.revision,
            role,
            transaction_id,
            current,
            original,
        })
    }
    pub fn restore_backup(
        &self,
        registry: &Registry,
        db: &Database,
        store: &dyn CredentialStore,
        draft: ConfigurationDraft,
        role: String,
        transaction_id: String,
    ) -> Result<ConfigurationSaveResult, String> {
        let mut records = self.records.lock().map_err(|_| "草稿会话暂不可用")?;
        let record = Self::checked(&mut records, &draft)?;
        crate::accounts::selection::validate_expected(
            &draft.profile.tool,
            draft.context_id.as_deref(),
        )?;
        let file = record
            .current_files
            .iter()
            .find(|file| file.role == role && !file.sensitive)
            .ok_or("此草稿没有该原生文件角色")?;
        let original = record.original_texts.get(&role).ok_or("缺少恢复基线")?;
        let key = super::apply::scope_key(
            draft.scope,
            draft.project_path.as_deref().map(std::path::Path::new),
        )?;
        let outcome = transaction::restore_backup(
            db,
            store,
            std::path::Path::new(&file.path),
            &transaction_id,
            original,
            |tx| {
                invalidate_current_binding(
                    tx,
                    &draft.profile.tool,
                    &key,
                    draft.context_id.as_deref(),
                )
            },
        )?;
        record.original_texts.insert(
            role.clone(),
            transaction::read_native(std::path::Path::new(&file.path))?,
        );
        let (public, protected) = redacted(registry, &draft.profile.tool, &record.original_texts)?;
        record.protected = protected;
        let mut next = draft;
        next.profile
            .files
            .insert(role.clone(), public[&role].clone());
        next.baseline_files = public;
        next.revision += 1;
        let mut next = refresh(registry, next);
        record.decorate(&mut next);
        record.publish(&next);
        Ok(ConfigurationSaveResult {
            draft: next,
            profile: None,
            common: None,
            application: Some(outcome),
        })
    }
}
fn invalidate_current_binding(
    tx: &rusqlite::Transaction<'_>,
    tool: &str,
    key: &str,
    context_id: Option<&str>,
) -> Result<(), String> {
    crate::accounts::selection::validate_expected(tool, context_id)?;
    use rusqlite::OptionalExtension;
    let own: Option<Option<String>> = tx
        .query_row(
            "SELECT context_id FROM applied_bindings WHERE tool=?1 AND scope_key=?2",
            rusqlite::params![tool, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let effective = if own.is_none() && key.starts_with("project:") {
        tx.query_row(
            "SELECT context_id FROM applied_bindings WHERE tool=?1 AND scope_key='global'",
            [tool],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
    } else {
        own.flatten()
    };
    if effective.as_deref() != context_id {
        return Err("文件写入期间账号上下文已变化，修改已回滚".into());
    }
    if context_id.is_some() {
        let changed=tx.execute("UPDATE applied_bindings SET profile_version=-1,managed='{}' WHERE scope_key=?1 AND tool=?2",rusqlite::params![key,tool]).map_err(|error|error.to_string())?;
        if changed == 0 && key.starts_with("project:") {
            // Preserve a project that previously inherited the global account context.
            tx.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed,context_id,common_version,common_revision,applied_profile) SELECT ?1,tool,profile_id,-1,'{}',context_id,common_version,common_revision,applied_profile FROM applied_bindings WHERE scope_key='global' AND tool=?2 AND context_id=?3",rusqlite::params![key,tool,context_id]).map_err(|error|error.to_string())?;
        }
    } else {
        tx.execute(
            "DELETE FROM applied_bindings WHERE tool=?1 AND (scope_key=?2 OR scope_key=?3)",
            rusqlite::params![tool, key, format!("context:default:{key}")],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn clear_credential_references(
    registry: &Registry,
    profile: &mut RegisteredProfile,
) -> Result<(), String> {
    let adapter = registry.get(&profile.tool).ok_or("适配器未注册")?;
    if let (Some(port), Some(connection)) = (adapter.configuration(), &profile.connection) {
        for (role, path) in port.credential_paths(connection) {
            if let Some(text) = profile.files.get_mut(role) {
                *text = format::set_path(adapter.file_kind(role)?, text, &path, None)?;
            }
        }
    }
    Ok(())
}
struct CurrentCredentialStore<'a> {
    lease: Option<&'a (String, String)>,
    persistent: &'a dyn CredentialStore,
}
impl CredentialStore for CurrentCredentialStore<'_> {
    fn get(&self, id: &str) -> Result<String, String> {
        if let Some((key, value)) = self.lease.filter(|(key, _)| key == id) {
            let _ = key;
            Ok(value.clone())
        } else {
            self.persistent.get(id)
        }
    }
    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        self.persistent.put(id, value)
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.persistent.delete(id)
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;

/// Pure public deltas are applied with the existing native formatter. This is
/// not an external merge: the private baseline has already passed exact CAS.
fn patch_public_native(
    kind: format::FileKind,
    before: &str,
    edited: &str,
    private: &str,
    protected: &[(Vec<String>, Value)],
) -> Result<String, String> {
    let before = format::parse(kind, before)?;
    let edited = format::parse(kind, edited)?;
    fn changes(
        before: Option<&Value>,
        after: Option<&Value>,
        path: &mut Vec<String>,
        result: &mut Vec<(Vec<String>, Option<Value>)>,
    ) {
        if before == after {
            return;
        }
        if let (Some(Value::Object(before)), Some(Value::Object(after))) = (before, after) {
            for key in before
                .keys()
                .chain(after.keys())
                .collect::<std::collections::BTreeSet<_>>()
            {
                path.push(key.clone());
                changes(before.get(key), after.get(key), path, result);
                path.pop();
            }
        } else {
            result.push((path.clone(), after.cloned()));
        }
    }
    let mut edits = vec![];
    changes(Some(&before), Some(&edited), &mut vec![], &mut edits);
    let mut text = private.to_owned();
    for (path, value) in edits {
        if path.is_empty() {
            return Err("当前文件不能覆盖整个受保护文档".into());
        }
        if protected
            .iter()
            .any(|(credential, _)| credential.starts_with(&path))
        {
            return Err(
                "该实体含受保护的原生凭据，不能通过普通字段删除或覆盖；请明确处理凭据后重读".into(),
            );
        }
        text = format::set_path(kind, &text, &path, value.as_ref())?;
    }
    Ok(text)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapability {
    pub source: String,
    pub available: bool,
    pub reason: Option<String>,
}
fn source_capabilities(registry: &Registry, draft: &ConfigurationDraft) -> Vec<SourceCapability> {
    let Some(adapter) = registry.get(&draft.profile.tool) else {
        return Vec::new();
    };
    let common = draft.subject == Some(ConfigurationSubject::Common);
    let account = adapter.accounts().map(|port| port.capability());
    let managed = account
        .as_ref()
        .is_some_and(|capability| capability.managed_login)
        && draft.subject != Some(ConfigurationSubject::Current)
        && !common;
    let policy = adapter.connection_policy(draft.scope);
    let api = !common
        && policy.api_key.state == "writable"
        && !(draft.subject == Some(ConfigurationSubject::Current) && draft.context_id.is_some());
    vec![
        SourceCapability {
            source: "native".into(),
            available: !common,
            reason: Some(
                if common {
                    "通用配置不选择认证来源"
                } else {
                    "只沿用此CLI原生上下文；不自动复制或纳入登录凭据"
                }
                .into(),
            ),
        },
        SourceCapability {
            source: "account".into(),
            available: managed,
            reason: if managed {
                None
            } else {
                Some(if common {
                    "通用配置不选择账号".into()
                } else if draft.subject == Some(ConfigurationSubject::Current) {
                    "当前文件不能通过草稿绑定账号，请使用命名配置".into()
                } else {
                    account
                        .map(|capability| capability.reason.to_owned())
                        .unwrap_or_else(|| "此CLI未声明受管账号来源".into())
                })
            },
        },
        SourceCapability {
            source: "api_key".into(),
            available: api,
            reason: if api {
                None
            } else {
                Some(if common {
                    "通用配置不能传播密钥".into()
                } else if draft.subject == Some(ConfigurationSubject::Current)
                    && draft.context_id.is_some()
                {
                    "受管账号上下文不能植入API密钥，请使用独立命名配置".into()
                } else {
                    policy.api_key.reason.to_owned()
                })
            },
        },
    ]
}
