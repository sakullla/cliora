use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapter::{self, NativeFile, Scope};
use super::auth;
use super::format;
use super::profile::{self, NativeProfile, RegisteredCommon, RegisteredProfile};
use super::transaction::{self, ApplyOutcome, FieldChange, FilePatch};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::domain::CliId;

type Managed = BTreeMap<String, BTreeMap<String, Value>>;

const SECRET_HASH: &str = "__cliora_secret_sha256";
const REMOVED_FIELD: &str = "__cliora_removed_field";

#[derive(Debug, Default)]
pub struct NativeSecrets {
    values: BTreeMap<String, BTreeMap<String, String>>,
    removals: BTreeMap<String, BTreeSet<String>>,
}

impl NativeSecrets {
    pub(crate) fn put(&mut self, role: &str, path: &[&str], value: String) {
        let pointer = pointer(
            &path
                .iter()
                .map(|part| (*part).to_owned())
                .collect::<Vec<_>>(),
        );
        if let Some(removals) = self.removals.get_mut(role) {
            removals.remove(&pointer);
        }
        self.values
            .entry(role.into())
            .or_default()
            .insert(pointer, value);
    }

    pub(crate) fn remove(&mut self, role: &str, path: &[&str]) {
        let pointer = pointer(
            &path
                .iter()
                .map(|part| (*part).to_owned())
                .collect::<Vec<_>>(),
        );
        if let Some(values) = self.values.get_mut(role) {
            values.remove(&pointer);
        }
        self.removals
            .entry(role.into())
            .or_default()
            .insert(pointer);
    }
}

pub(crate) fn read_secret(id: &str, credentials: &dyn CredentialStore) -> Result<String, String> {
    if !profile::valid_connection_secret_ref(id) {
        return Err("原生密钥引用无效，请重新安全接入".into());
    }
    let secret = credentials
        .get(id)
        .map_err(|_| "系统凭据库中找不到原生密钥，请重新安全接入")?;
    if secret.is_empty() {
        return Err("原生密钥为空，请重新安全接入".into());
    }
    Ok(secret)
}

#[cfg(test)]
fn native_secrets(
    registry: &crate::adapters::Registry,
    profile: &RegisteredProfile,
    scope: Scope,
    credentials: &dyn CredentialStore,
) -> Result<NativeSecrets, String> {
    let documents = desired_registered_documents(registry,profile,None,scope)?;
    native_secrets_for_documents(registry,profile,scope,credentials,&documents)
}
fn native_secrets_for_documents(registry: &crate::adapters::Registry, profile: &RegisteredProfile, scope: Scope, credentials: &dyn CredentialStore, documents: &BTreeMap<String, Value>) -> Result<NativeSecrets, String> {
    let adapter = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能应用")?;
    for (role, entries) in &profile.native_credentials {
        for (name, id) in entries {
            if !adapter.accepts_native_credential(role, name)
                || !profile::valid_connection_secret_ref(id)
            {
                return Err("原生凭据标识无效，请重新安全接入".into());
            }
        }
    }
    let mut result = NativeSecrets::default();
    if matches!(profile.authentication, profile::ProfileAuthentication::OAuth { .. }) {
        if profile.connection.is_some() || !profile.native_credentials.is_empty() { return Err("OAuth 配置不能包含 API Key".into()); }
        if profile.tool == "claude_code" {
            for role in ["settings", "local_settings"].into_iter().filter(|role| *role == "settings" || scope == Scope::Project) {
                for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] { result.remove(role, &["env",name]); }
                result.remove(role, &["apiKeyHelper"]);
            }
        }
        return Ok(result);
    }
    adapter.restore_imported_secrets(profile, scope, credentials, &mut result)?;
    adapter.write_connection_secret_for_documents(profile, scope, credentials, &mut result, documents)?;
    Ok(result)
}

fn managed_value(value: Option<&Value>, marker: Option<&Value>, integrity: &[u8; 32]) -> bool {
    match marker {
        Some(Value::Object(map)) if map.get(REMOVED_FIELD) == Some(&Value::Bool(true)) => {
            value.is_none()
        }
        Some(Value::Object(map))
            if map.len() == 1 && map.get(SECRET_HASH).and_then(Value::as_str).is_some() =>
        {
            value.and_then(Value::as_str).is_some_and(|secret| {
                map.get(SECRET_HASH).and_then(Value::as_str)
                    == Some(transaction::keyed_fingerprint(integrity, secret.as_bytes()).as_str())
            })
        }
        _ => value == marker,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedBinding {
    pub scope_key: String,
    pub context_id: Option<String>,
    pub tool: String,
    pub profile_id: String,
    pub profile_version: u64,
    pub managed: Managed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreview {
    pub documents: BTreeMap<String, Value>,
    pub rendered: BTreeMap<String, String>,
    pub sources: BTreeMap<String, BTreeMap<String, String>>,
}

fn pointer(path: &[String]) -> String {
    path.iter()
        .map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1")))
        .collect()
}

fn path_from_pointer(pointer: &str) -> Vec<String> {
    pointer
        .split('/')
        .skip(1)
        .map(|segment| segment.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn flatten(value: &Value, path: &mut Vec<String>, output: &mut BTreeMap<String, Value>) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, value) in map {
                path.push(key.clone());
                flatten(value, path, output);
                path.pop();
            }
        }
        _ if !path.is_empty() => {
            output.insert(pointer(path), value.clone());
        }
        _ => {}
    }
}

pub(crate) fn set_json(root: &mut Value, path: &[&str], value: Value) {
    let mut cursor = root;
    for segment in &path[..path.len() - 1] {
        if !cursor.get(*segment).is_some_and(Value::is_object) {
            cursor
                .as_object_mut()
                .unwrap()
                .insert((*segment).into(), json!({}));
        }
        cursor = cursor.get_mut(*segment).unwrap();
    }
    cursor
        .as_object_mut()
        .unwrap()
        .insert(path.last().unwrap().to_string(), value);
}

fn prune_empty_entries(root: &mut Value, collections: &[&str]) -> Vec<Vec<String>> {
    let mut removed = Vec::new();
    for collection in collections {
        if let Some(entries) = root.get_mut(*collection).and_then(Value::as_object_mut) {
            entries.retain(|name, entry| {
                if entry.as_object().is_some_and(serde_json::Map::is_empty) {
                    removed.push(vec![(*collection).into(), name.clone()]);
                    false
                } else {
                    true
                }
            });
        }
    }
    removed
}

#[cfg(test)]
fn connection_documents(
    tool: CliId,
    connection: &profile::Connection,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    crate::adapters::known(tool).connection_documents(connection, scope)
}

pub(crate) fn scope_key(scope: Scope, project: Option<&Path>) -> Result<String, String> {
    match scope {
        Scope::Global => Ok("global".into()),
        Scope::Project => {
            let path = project
                .ok_or("请选择项目目录")?
                .canonicalize()
                .map_err(|_| "项目目录不存在或无法访问")?;
            if !path.is_dir() {
                return Err("项目路径不是目录".into());
            }
            Ok(format!("project:{}", path.display()))
        }
    }
}

pub fn get_binding(
    db: &Database,
    tool: CliId,
    key: &str,
) -> Result<Option<AppliedBinding>, String> {
    get_registered_binding(db, tool.stable_id(), key)
}

pub fn get_registered_binding(
    db: &Database,
    tool: &str,
    key: &str,
) -> Result<Option<AppliedBinding>, String> {
    db.with_connection(|conn| {
        let row: Option<(String, i64, String, Option<String>)> = conn.query_row("SELECT profile_id, profile_version, managed, context_id FROM applied_bindings WHERE scope_key = ?1 AND tool = ?2", params![key, tool], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional().map_err(|e| e.to_string())?;
        row.map(|(profile_id, profile_version, managed, context_id)| {
            Ok(AppliedBinding { context_id, scope_key: key.into(), tool: tool.into(), profile_id, profile_version: profile_version.max(0) as u64, managed: serde_json::from_str(&managed).map_err(|_| "活动配置记录损坏")? })
        }).transpose()
    })
}

pub fn desired_documents(
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    let registered = RegisteredProfile::from(profile.clone());
    let common = common.cloned().map(RegisteredCommon::from);
    desired_registered_documents(
        &crate::adapters::Registry::builtins(),
        &registered,
        common.as_ref(),
        scope,
    )
}

pub fn desired_registered_documents(
    registry: &crate::adapters::Registry,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    let adapter = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能应用")?;
    let mut roles: BTreeSet<String> = profile.files.keys().cloned().collect();
    if profile.inherit_common {
        if let Some(common) = common {
            roles.extend(common.files.keys().cloned());
        }
    }
    if profile.connection.is_some() {
        for role in adapter.connection_roles() {
            roles.insert((*role).into());
        }
    }
    let mut result = BTreeMap::new();
    for role in roles {
        adapter.validate_role_scope(&role, scope)?;
        let effective = profile::resolve_registered_file(registry, profile, common, &role)?;
        result.insert(role, effective.contents);
    }
    if let Some(connection) = &profile.connection {
        for (role, overlay) in adapter.connection_documents_for_existing(connection, scope, &result)? {
            let existing = result.entry(role).or_insert_with(|| json!({}));
            let (merged, _) = format::resolve(existing, &overlay, &[])?;
            *existing = merged;
        }
    }
    if matches!(profile.authentication, profile::ProfileAuthentication::OAuth { .. }) {
        adapter.accounts().ok_or("此 CLI 未提供账号适配")?.prepare_documents(&mut result)?;

    }
    for (role, document) in &mut result {
        adapter.normalize_applied_document(role, document);
        prune_empty_entries(document, adapter.empty_entry_collections(role));
    }
    adapter.validate_documents(scope, &result)?;
    Ok(result)
}

pub fn preview(
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    scope: Scope,
) -> Result<NativePreview, String> {
    let registered = RegisteredProfile::from(profile.clone());
    let common = common.cloned().map(RegisteredCommon::from);
    preview_registered(
        &crate::adapters::Registry::builtins(),
        &registered,
        common.as_ref(),
        scope,
    )
}

pub fn preview_registered(
    registry: &crate::adapters::Registry,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
    scope: Scope,
) -> Result<NativePreview, String> {
    profile::validate_registered_files(registry, &profile.tool, &profile.files)?;
    profile::validate_registered_native_credentials(registry, profile)?;
    let documents = desired_registered_documents(registry, profile, common, scope)?;
    let mut sources = BTreeMap::new();
    for role in documents.keys() {
        sources.insert(
            role.clone(),
            profile::resolve_registered_file(registry, profile, common, role)?.source_by_path,
        );
    }
    if let Some(connection) = &profile.connection {
        for (role, root) in registry
            .get(&profile.tool)
            .ok_or("未注册的 CLI 适配器")?
            .connection_documents(connection, scope)?
        {
            let mut fields = BTreeMap::new();
            flatten(&root, &mut Vec::new(), &mut fields);
            let entry = sources.entry(role).or_default();
            for path in fields.keys() {
                entry.insert(path.clone(), "连接设置".into());
            }
        }
    }
    let adapter = registry.get(&profile.tool).ok_or("未注册的 CLI 适配器")?;
    let mut rendered = BTreeMap::new();
    for (role, document) in &documents {
        let kind = adapter.file_kind(role).unwrap_or(format::FileKind::Json);
        rendered.insert(role.clone(), format::render(kind, document)?);
    }
    Ok(NativePreview { documents, rendered, sources })
}

pub fn apply_validated(
    db: &Database,
    credentials: &dyn CredentialStore,
    profile: &NativeProfile,
    common: Option<&profile::CommonConfig>,
    native_files: &[NativeFile],
    key: &str,
    scope: Scope,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    let registered = RegisteredProfile::from(profile.clone());
    let common = common.cloned().map(RegisteredCommon::from);
    apply_registered_validated(
        &crate::adapters::Registry::builtins(),
        db,
        credentials,
        &registered,
        common.as_ref(),
        native_files,
        key,
        scope,
        allow_takeover,
    )
}

pub fn apply_registered_validated(
    registry: &crate::adapters::Registry,
    db: &Database,
    credentials: &dyn CredentialStore,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
    native_files: &[NativeFile],
    key: &str,
    scope: Scope,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    apply_registered_validated_compared(registry,db,credentials,profile,common,native_files,key,scope,allow_takeover,None)
}

fn apply_registered_validated_compared(
    registry: &crate::adapters::Registry, db: &Database, credentials: &dyn CredentialStore,
    profile: &RegisteredProfile, common: Option<&RegisteredCommon>, native_files: &[NativeFile],
    key: &str, scope: Scope, allow_takeover: bool, comparison: Option<&BTreeMap<String,String>>,
) -> Result<ApplyOutcome,String> {
    let adapter = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能应用")?;
    adapter.reject_new_secret(profile, scope)?;
    let desired = desired_registered_documents(registry, profile, common, scope)?;
    let secrets = native_secrets_for_documents(registry, profile, scope, credentials, &desired)?;
    let integrity = transaction::integrity_key(db, credentials)?;
    let context=crate::accounts::selection::current(&profile.tool);
    let context_key = if key.starts_with("project:") { key.to_owned() } else { format!("context:{}:{key}",context.as_ref().map(|ctx|ctx.id.as_str()).unwrap_or("default")) };
    let old = get_registered_binding(db, &profile.tool, &context_key)?;
    let old = if old.is_none() && context.is_none() { get_registered_binding(db,&profile.tool,key)?.filter(|binding|binding.context_id.is_none()) } else { old };
    let mut new_managed = Managed::new();
    for (role, root) in desired {
        let mut fields = BTreeMap::new();
        flatten(&root, &mut Vec::new(), &mut fields);
        new_managed.insert(role, fields);
    }
    for (role, fields) in &secrets.values {
        for (pointer, secret) in fields {
            new_managed.entry(role.clone()).or_default().insert(
                pointer.clone(),
                json!({SECRET_HASH: transaction::keyed_fingerprint(&integrity, secret.as_bytes())}),
            );
        }
    }
    for (role, pointers) in &secrets.removals {
        for pointer in pointers {
            new_managed
                .entry(role.clone())
                .or_default()
                .insert(pointer.clone(), json!({REMOVED_FIELD: true}));
        }
    }
    let old_managed = old.as_ref().map(|value| &value.managed);
    let roles: BTreeSet<_> = new_managed
        .keys()
        .chain(old_managed.into_iter().flat_map(|managed| managed.keys()))
        .cloned()
        .collect();
    let mut patches = Vec::new();
    let mut matching_baselines = Vec::new();
    for role in roles {
        let native = native_files
            .iter()
            .find(|file| file.role == role)
            .ok_or_else(|| format!("当前范围没有 {role} 文件"))?;
        if !native.writable || native.sensitive {
            return Err(native.reason.unwrap_or("原生文件不可安全写入").into());
        }
        let kind = match native.format {
            "toml" => format::FileKind::Toml,
            "json" => format::FileKind::Json,
            "jsonc" => format::FileKind::Jsonc,
            "yaml" => format::FileKind::Yaml,
            _ => return Err("原生文件格式不受支持".into()),
        };
        let file_path = Path::new(&native.path);
        let baseline = transaction::read_native(file_path)?;
        if comparison.is_some_and(|files|files.get(&role)!=Some(&baseline)) {
            return Err("原生文件在比较后又发生变化，请重新比较；未覆盖任何文件".into());
        }
        matching_baselines.push((file_path.to_path_buf(), baseline.clone()));
        let original = format::parse(kind, &baseline)?;
        if let Some(fields) = new_managed.get_mut(&role) { adapter.preserve_native_fields(&role, &original, fields, profile)?; }
        let next_fields = new_managed.get(&role);
        let previous_fields = old_managed.and_then(|managed| managed.get(&role));
        let pointers: BTreeSet<_> = next_fields
            .into_iter()
            .flat_map(|map| map.keys())
            .chain(previous_fields.into_iter().flat_map(|map| map.keys()))
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for pointer in pointers {
            let path = path_from_pointer(&pointer);
            let current = path
                .iter()
                .try_fold(&original, |value, part| value.get(part));
            let old_value = previous_fields.and_then(|fields| fields.get(&pointer));
            let new_value = next_fields.and_then(|fields| fields.get(&pointer));
            let native_new = secrets
                .values
                .get(&role)
                .and_then(|fields| fields.get(&pointer))
                .map(|value| Value::String(value.clone()));
            let removed = secrets
                .removals
                .get(&role)
                .is_some_and(|pointers| pointers.contains(&pointer));
            let expected_new = if removed {
                None
            } else {
                native_new.as_ref().or(new_value)
            };
            if let Some(old_value) = old_value {
                if comparison.is_none() && !managed_value(current, Some(old_value), &integrity) && current != expected_new {
                    return Err(format!("上次管理的字段已被外部修改：{role}{pointer}"));
                }
            } else if current.is_some() && current != expected_new && !allow_takeover {
                return Err(format!(
                    "原生文件已有不同的字段值：{role}{pointer}；请确认接管"
                ));
            }
            if current != expected_new {
                changes.push(FieldChange {
                    path,
                    value: expected_new.cloned(),
                });
            }
        }
        let collections = adapter.empty_entry_collections(&role);
        if !collections.is_empty() {
            // Inspect the final candidate after all field edits. Removing an entry
            // earlier could discard native fields or a provider being repopulated.
            let candidate = changes.iter().try_fold(baseline.clone(), |text, change| {
                format::set_path(kind, &text, &change.path, change.value.as_ref())
            })?;
            let mut candidate = format::parse(kind, &candidate)?;
            for path in prune_empty_entries(&mut candidate, collections) {
                changes.push(FieldChange { path, value: None });
            }
        }
        let sensitive = secrets
            .values
            .get(&role)
            .is_some_and(|fields| !fields.is_empty())
            || previous_fields.is_some_and(|fields| {
                fields
                    .values()
                    .any(|value| value.get(SECRET_HASH).is_some())
            })
            || adapter.has_native_secret(&role, &original);
        if !changes.is_empty() || (sensitive && file_path.is_file()) {
            patches.push(FilePatch {
                path: file_path.to_path_buf(),
                kind,
                baseline,
                changes,
                sensitive,
                force_restrict: sensitive,
            });
        }
    }
    if patches.is_empty() {
        return transaction::commit_matching(db, &matching_baselines, |tx| {
            check_apply_snapshot(tx, profile, common)?;
            let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
            let context = crate::accounts::selection::current(&profile.tool);
            for target_key in [&context_key, &key.to_owned()] {
                tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed, context_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id=excluded.profile_id, profile_version=excluded.profile_version, managed=excluded.managed, context_id=excluded.context_id", params![target_key, profile.tool, profile.id, profile.version as i64, json, context.as_ref().map(|ctx|&ctx.id)]).map_err(|e|e.to_string())?;
            }
            Ok(())
        });
    }
    crate::adapters::commit_registered_patches(
        registry,
        &profile.tool,
        native_files,
        db,
        credentials,
        &patches,
        |tx| {
            check_apply_snapshot(tx, profile, common)?;
            let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
            let context = crate::accounts::selection::current(&profile.tool);
            for target_key in [&context_key, &key.to_owned()] {
                tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed, context_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id=excluded.profile_id, profile_version=excluded.profile_version, managed=excluded.managed, context_id=excluded.context_id", params![target_key, profile.tool, profile.id, profile.version as i64, json, context.as_ref().map(|ctx|&ctx.id)]).map_err(|e|e.to_string())?;
            }
            Ok(())
        },
    )
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ApplyComparisonFile { pub role:String, pub format:String, pub current:String, pub proposed:Value, pub proposed_text:String }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ApplyComparison { #[serde(default)] pub context_id: Option<String>, pub profile:RegisteredProfile, pub common:Option<RegisteredCommon>, pub files:Vec<ApplyComparisonFile> }

fn comparison_files(native:&[NativeFile],documents:&BTreeMap<String,Value>,required:&BTreeSet<String>)->Result<Vec<ApplyComparisonFile>,String> {
    // Authentication cleanup may touch another declared config file even when it
    // has no document overlay. Capture its actual bytes, including missing files.
    // Dedicated native identity/credential files stay outside this editor.
    let roles:BTreeSet<_>=required.iter().cloned().chain(native.iter().filter(|file|file.writable && !file.sensitive).map(|file|file.role.to_owned())).collect();
    let mut files=Vec::new();
    for role in roles {
        let file=native.iter().find(|file|file.role==role && !file.sensitive).ok_or("当前范围的原生文件不可编辑")?;
        let proposed = documents.get(&role).cloned().unwrap_or_else(|| json!({}));
        let kind = match file.format {
            "toml" => format::FileKind::Toml,
            "jsonc" => format::FileKind::Jsonc,
            "yaml" => format::FileKind::Yaml,
            _ => format::FileKind::Json,
        };
        let proposed_text = format::render(kind, &proposed)?;
        files.push(ApplyComparisonFile { role: role.clone(), format: file.format.into(), current: transaction::read_native(Path::new(&file.path))?, proposed, proposed_text });
    }
    Ok(files)
}

pub fn compare_registered_application(registry:&crate::adapters::Registry,db:&Database,home:&Path,scope:Scope,project:Option<&Path>,profile_id:&str)->Result<ApplyComparison,String> {
    let profile=profile::get_registered_profile(db,profile_id)?;
    let _context = crate::accounts::selection::enter(crate::accounts::selection::for_profile(db, home, &profile)?);
    let common=profile::get_registered_common(db,&profile.tool)?;
    let adapter=registry.get(&profile.tool).ok_or("未注册的 CLI")?;
    let documents=desired_registered_documents(registry,&profile,common.as_ref(),scope)?;
    let previous=get_registered_binding(db,&profile.tool,&crate::accounts::selection::key(&scope_key(scope,project)?))?;
    let roles:BTreeSet<_>=documents.keys().chain(previous.iter().flat_map(|binding|binding.managed.keys())).cloned().collect();
    let native=adapter.native_files(scope,home,project,true);
    let files=comparison_files(&native,&documents,&roles)?;
    Ok(ApplyComparison{context_id:crate::accounts::selection::current(&profile.tool).map(|ctx|ctx.id),profile,common,files})
}

pub fn apply_compared_application(registry:&crate::adapters::Registry,db:&Database,credentials:&dyn CredentialStore,comparison:&ApplyComparison,home:&Path,scope:Scope,project:Option<&Path>,custom:Option<&Path>)->Result<ApplyOutcome,String> {
    let profile=profile::get_registered_profile(db,&comparison.profile.id)?;
    let _context = crate::accounts::selection::enter(crate::accounts::selection::for_profile(db, home, &profile)?);
    if crate::accounts::selection::current(&profile.tool).map(|ctx|ctx.id)!=comparison.context_id {return Err("账号上下文已变化，请重新比较".into());}
    let common=profile::get_registered_common(db,&profile.tool)?;
    if serde_json::to_value(&profile).unwrap()!=serde_json::to_value(&comparison.profile).unwrap() || profile.inherit_common && serde_json::to_value(&common).unwrap()!=serde_json::to_value(&comparison.common).unwrap() {return Err("配置资料在比较后变化，请重新比较".into());}
    if let Some(connection)=&profile.connection {auth::verify_stored_credential(connection,credentials)?;}
    let probe=adapter::probe_registered(registry,&profile.tool,custom,home,project,scope)?;
    if probe.native_writes.state!="supported" {return Err(probe.native_writes.reason.into());}
    let mut baselines=BTreeMap::new();
    for file in &comparison.files {if file.current.len()>1024*1024 || baselines.insert(file.role.clone(),file.current.clone()).is_some(){return Err("比较文件无效".into());}}
    apply_registered_validated_compared(registry,db,credentials,&profile,common.as_ref(),&probe.native_files,&scope_key(scope,project)?,scope,true,Some(&baselines))
}

/// The snapshot can become stale during probe, credential reads or file preparation.
/// Check it in the same transaction that commits the binding so imports cannot erase
/// pending state between this check and the commit. A rejected file write rolls back.
fn check_apply_snapshot(
    tx: &rusqlite::Transaction<'_>,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
) -> Result<(), String> {
    if let profile::ProfileAuthentication::OAuth { account_id } = &profile.authentication {
        let context = crate::accounts::selection::current(&profile.tool).ok_or("OAuth 应用缺少上下文")?;
        let data: String = tx.query_row("SELECT data FROM auth_accounts WHERE id=?1", [account_id], |row|row.get(0)).map_err(|_|"账号已被移除")?;
        let account: crate::accounts::AuthAccount=serde_json::from_str(&data).map_err(|_|"账号格式异常")?;
        if account.state != crate::accounts::AccountState::SignedIn || account.pending_login.is_some() || account.context.as_ref().map(|ctx|&ctx.id)!=Some(&context.id) {return Err("账号在应用期间变化，请重新应用".into());}
    }
    let current: Option<String> = tx.query_row(
        "SELECT data FROM native_profiles WHERE id=?1", [&profile.id], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    let current: Option<RegisteredProfile> = current.as_deref().map(serde_json::from_str)
        .transpose().map_err(|_| "命名配置格式无法识别")?;
    let unchanged = current.as_ref().map(serde_json::to_value).transpose().map_err(|error| error.to_string())?
        == Some(serde_json::to_value(profile).map_err(|error| error.to_string())?);
    if !unchanged {
        return Err("配置资料在应用期间已变化，请重新读取后应用".into());
    }
    if profile.inherit_common {
        let current: Option<String> = tx.query_row(
            "SELECT data FROM common_configs WHERE tool=?1", [&profile.tool], |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?;
        let current: Option<RegisteredCommon> = current.as_deref().map(serde_json::from_str)
            .transpose().map_err(|_| "通用配置格式无法识别")?;
        if current.as_ref().map(serde_json::to_value).transpose().map_err(|error| error.to_string())?
            != common.map(serde_json::to_value).transpose().map_err(|error| error.to_string())? {
            return Err("配置资料在应用期间已变化，请重新读取后应用".into());
        }
    }
    Ok(())
}

pub fn apply_profile(
    db: &Database,
    credentials: &dyn CredentialStore,
    tool: CliId,
    profile_id: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    custom_path: Option<&Path>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    apply_registered_profile(
        &crate::adapters::Registry::builtins(),
        db,
        credentials,
        tool.stable_id(),
        profile_id,
        scope,
        home,
        project,
        custom_path,
        allow_takeover,
    )
}

pub fn apply_registered_profile(
    registry: &crate::adapters::Registry,
    db: &Database,
    credentials: &dyn CredentialStore,
    tool: &str,
    profile_id: &str,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    custom_path: Option<&Path>,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    let profile = profile::get_registered_profile(db, profile_id)?;
    let _context = crate::accounts::selection::enter(crate::accounts::selection::for_profile(db, home, &profile)?);
    if profile.tool != tool {
        return Err("配置属于另一个 CLI".into());
    }
    if let Some(connection) = &profile.connection {
        auth::verify_stored_credential(connection, credentials)?;
    }
    let common = profile::get_registered_common(db, tool)?;
    let key = scope_key(scope, project)?;
    let probe = adapter::probe_registered(registry, tool, custom_path, home, project, scope)?;
    if probe.native_writes.state != "supported" {
        return Err(probe.native_writes.reason.into());
    }
    apply_registered_validated(
        registry,
        db,
        credentials,
        &profile,
        common.as_ref(),
        &probe.native_files,
        &key,
        scope,
        allow_takeover,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::profile::Connection;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, id: &str, secret: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), secret.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or("missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    fn profile(name: &str, model: &str) -> NativeProfile {
        NativeProfile {
            revision: String::new(),
            id: name.into(),
            tool: CliId::Codex,
            name: name.into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::from([("settings".into(), format!("model = \"{model}\"\n"))]),
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: None,
        }
    }
    fn native(path: &Path) -> NativeFile {
        NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        }
    }

    // File/credential fixtures now also represent the persisted application snapshot.
    fn apply_fixture(
        db: &Database, store: &dyn CredentialStore, snapshot: &NativeProfile,
        common: Option<&profile::CommonConfig>, files: &[NativeFile], key: &str,
        scope: Scope, allow_takeover: bool,
    ) -> Result<ApplyOutcome, String> {
        db.with_connection(|conn| {
            conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,?3,?4)
                ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version",
                params![snapshot.id,snapshot.tool.stable_id(),snapshot.version as i64,serde_json::to_string(snapshot).unwrap()]).unwrap();
            if let Some(common) = common {
                conn.execute("INSERT INTO common_configs (tool,version,data) VALUES (?1,?2,?3)
                    ON CONFLICT(tool) DO UPDATE SET data=excluded.data,version=excluded.version",
                    params![common.tool.stable_id(),common.version as i64,serde_json::to_string(common).unwrap()]).unwrap();
            }
            Ok(())
        })?;
        super::apply_validated(db, store, snapshot, common, files, key, scope, allow_takeover)
    }

    fn probe_import_interleave(common_only: bool, writes: bool) {
        use crate::adapters::Registry;
        use crate::portable::{self, PortablePayload};
        use std::thread;
        use std::time::{Duration, Instant};

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        let executable = temp.path().join(if cfg!(windows) { "codex.ps1" } else { "codex" });
        fs::write(&executable, if cfg!(windows) { "Write-Output 'codex-cli 0.114.0'\n" } else { "#!/bin/sh\necho 'codex-cli 0.114.0'\n" }).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let registry = Registry::builtins();
        let mut named = profile("", "initial");
        named.name = "Work".into();
        named.inherit_common = true;
        named.files.clear();
        let mut named = profile::save_profile(&db, named, None).unwrap();
        let mut common = profile::save_common(&db, profile::CommonConfig {
            tool: CliId::Codex, version: 0, revision: String::new(),
            files: BTreeMap::from([("settings".into(), "model = \"initial\"\n".into())]),
        }, None).unwrap();
        apply_profile(&db, &store, CliId::Codex, &named.id, Scope::Project, &home, Some(&project), Some(&executable), false).unwrap();
        let native = project.join(".codex/config.toml");
        let before = fs::read(&native).unwrap();
        if writes {
            if common_only {
                common.files.insert("settings".into(), "model = \"captured\"\n".into());
                common = profile::save_common(&db, common.clone(), Some(common.version)).unwrap();
            } else {
                named.files.insert("settings".into(), "model = \"captured\"\n".into());
                named = profile::save_profile(&db, named.clone(), Some(named.version)).unwrap();
            }
        }
        let captured_profile_revision = named.revision.clone();
        let captured_common_revision = common.revision.clone();
        let captured_version = named.version;
        let mut incoming = portable::collect_snapshot(&db, &store, &registry).unwrap();
        incoming.entities.retain(|entity| entity.kind() == if common_only { "common" } else { "profile" });
        match &mut incoming.entities[0].payload {
            PortablePayload::Common(value) => { value.files.insert("settings".into(), "model = \"incoming\"\n".into()); },
            PortablePayload::Profile(value) => { value.profile.files.insert("settings".into(), "model = \"incoming\"\n".into()); },
            _ => panic!("unexpected payload"),
        }
        let import = portable::preview_import(&db, &store, &registry, incoming).unwrap();
        let selected = import.items.iter().map(|item| item.key.clone()).collect();
        let ready = temp.path().join("probe-ready");
        let release = temp.path().join("probe-release");
        let quote = |path: &Path| format!("'{}'", path.display().to_string().replace('\'', if cfg!(windows) { "''" } else { "'\\''" }));
        let script = if cfg!(windows) {
            format!("Set-Content -LiteralPath {} -Value ready\nwhile (!(Test-Path -LiteralPath {})) {{ Start-Sleep -Milliseconds 5 }}\nWrite-Output 'codex-cli 0.114.0'\n", quote(&ready), quote(&release))
        } else {
            format!("#!/bin/sh\nprintf ready > {}\nwhile [ ! -f {} ]; do sleep 0.01; done\necho 'codex-cli 0.114.0'\n", quote(&ready), quote(&release))
        };
        fs::write(&executable, script).unwrap();
        let result = thread::scope(|scope| {
            let applying = scope.spawn(|| apply_profile(&db, &store, CliId::Codex, &named.id, Scope::Project, &home, Some(&project), Some(&executable), false));
            let deadline = Instant::now() + Duration::from_secs(3);
            while !ready.exists() && Instant::now() < deadline { thread::sleep(Duration::from_millis(5)); }
            let reached_probe = ready.exists();
            if reached_probe { portable::apply_import(&db, &store, &registry, &import, &selected).unwrap(); }
            fs::write(&release, "release").unwrap();
            let result = applying.join().unwrap();
            assert!(reached_probe, "application did not reach the controlled CLI probe");
            result
        });
        assert!(result.unwrap_err().contains("配置资料在应用期间已变化"));
        assert_eq!(fs::read(&native).unwrap(), before);
        let current_profile = profile::get_profile(&db, &named.id).unwrap();
        assert_eq!(current_profile.version, captured_version);
        if common_only {
            assert_eq!(current_profile.revision, captured_profile_revision);
            assert_ne!(profile::get_common(&db, CliId::Codex).unwrap().unwrap().revision, captured_common_revision);
        } else { assert_ne!(current_profile.revision, captured_profile_revision); }
        db.with_connection(|conn| {
            let binding: i64 = conn.query_row("SELECT profile_version FROM applied_bindings WHERE profile_id=?1", [&named.id], |row| row.get(0)).unwrap();
            assert_eq!(binding, -1, "old apply must preserve the incoming pending marker");
            let rolled_back: i64 = conn.query_row("SELECT count(*) FROM native_transactions WHERE status='rolled_back'", [], |row| row.get(0)).unwrap();
            assert_eq!(rolled_back, i64::from(writes), "writing branch must restore its native transaction");
            Ok(())
        }).unwrap();
        // Explicit application of the newly read snapshot succeeds after the rejected old one.
        apply_profile(&db, &store, CliId::Codex, &named.id, Scope::Project, &home, Some(&project), Some(&executable), false).unwrap();
        assert!(fs::read_to_string(&native).unwrap().contains("incoming"));
        assert_eq!(get_binding(&db, CliId::Codex, &scope_key(Scope::Project, Some(&project)).unwrap()).unwrap().unwrap().profile_version, current_profile.version);
    }

    #[test]
    fn common_import_during_probe_rejects_already_matching_binding() { probe_import_interleave(true, false); }
    #[test]
    fn common_import_during_probe_rolls_back_written_files() { probe_import_interleave(true, true); }
    #[test]
    fn same_version_profile_import_during_probe_rejects_already_matching_binding() { probe_import_interleave(false, false); }
    #[test]
    fn same_version_profile_import_during_probe_rolls_back_written_files() { probe_import_interleave(false, true); }

    #[test]
    fn snapshot_guard_checks_content_and_existence_and_ignores_uninherited_common() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let named = profile("snapshot", "base");
        apply_fixture(&db, &store, &named, None, &[native(&temp.path().join("config.toml"))], "global", Scope::Global, false).unwrap();
        let captured = RegisteredProfile::from(named);
        let check = |profile: &RegisteredProfile, common: Option<&RegisteredCommon>| db.with_connection(|conn| {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            check_apply_snapshot(&tx, profile, common)
        });
        db.with_connection(|conn| { conn.execute("INSERT INTO common_configs (tool,version,data) VALUES ('codex',1,?1)", [serde_json::to_string(&RegisteredCommon { tool: "codex".into(), version: 1, revision: "one".into(), files: BTreeMap::new() }).unwrap()]).unwrap(); Ok(()) }).unwrap();
        assert!(check(&captured, None).is_ok(), "uninherited Common cannot invalidate the snapshot");
        let mut changed = captured.clone();
        changed.files.insert("settings".into(), "model = \"changed-without-revision\"\n".into());
        db.with_connection(|conn| { conn.execute("UPDATE native_profiles SET data=?1 WHERE id=?2", params![serde_json::to_string(&changed).unwrap(), captured.id]).unwrap(); Ok(()) }).unwrap();
        assert!(check(&captured, None).is_err());
        db.with_connection(|conn| { conn.execute("DELETE FROM native_profiles WHERE id=?1", [&captured.id]).unwrap(); Ok(()) }).unwrap();
        assert!(check(&captured, None).is_err());
        changed = captured.clone(); changed.inherit_common = true;
        db.with_connection(|conn| { conn.execute("INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,'codex',1,?2)", params![changed.id, serde_json::to_string(&changed).unwrap()]).unwrap(); Ok(()) }).unwrap();
        assert!(check(&changed, None).is_err(), "a newly created Common is a change from absence");
        let common = profile::get_registered_common(&db, "codex").unwrap().unwrap();
        assert!(check(&changed, Some(&common)).is_ok());
        let mut changed_common = common.clone(); changed_common.files.insert("settings".into(), "model = \"changed-without-revision\"\n".into());
        db.with_connection(|conn| { conn.execute("UPDATE common_configs SET data=?1 WHERE tool='codex'", [serde_json::to_string(&changed_common).unwrap()]).unwrap(); Ok(()) }).unwrap();
        assert!(check(&changed, Some(&common)).is_err());
        db.with_connection(|conn| { conn.execute("DELETE FROM common_configs WHERE tool='codex'", []).unwrap(); Ok(()) }).unwrap();
        assert!(check(&changed, Some(&common)).is_err(), "deleted Common is a change in existence");
        assert!(check(&changed, None).is_ok());
    }

    #[test]
    fn switching_named_profiles_removes_only_old_managed_keys() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "# external\nunrelated = 7\n").unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let first = profile("first", "a");
        apply_fixture(
            &db,
            &store,
            &first,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let second = profile("second", "b");
        apply_fixture(
            &db,
            &store,
            &second,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# external"));
        assert!(text.contains("unrelated = 7"));
        assert!(text.contains("model = \"b\""));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
        fs::write(&path, text.replace("model = \"b\"", "model = \"external\"")).unwrap();
        assert!(apply_fixture(
            &db,
            &store,
            &first,
            None,
            &[native(&path)],
            "global",
            Scope::Global,
            false
        )
        .unwrap_err()
        .contains("外部修改"));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
        let registry=crate::adapters::Registry::builtins();
        let registered=RegisteredProfile::from(first.clone());
        let compared=fs::read_to_string(&path).unwrap();
        let baselines=BTreeMap::from([("settings".into(),compared.clone())]);
        fs::write(&path,compared.replace("external","changed again")).unwrap();
        assert!(apply_registered_validated_compared(&registry,&db,&store,&registered,None,&[native(&path)],"global",Scope::Global,true,Some(&baselines)).unwrap_err().contains("比较后"));
        assert!(fs::read_to_string(&path).unwrap().contains("changed again"));
        fs::write(&path,&compared).unwrap();
        apply_registered_validated_compared(&registry,&db,&store,&registered,None,&[native(&path)],"global",Scope::Global,true,Some(&baselines)).unwrap();
        let chosen=fs::read_to_string(&path).unwrap();
        assert!(chosen.contains("model = \"a\""));assert!(chosen.contains("unrelated = 7"));
    }

    #[test]
    fn native_format_mapping_is_tool_specific() {
        let connection = Connection {
            provider_id: "demo".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://example.test/v1".into(),
            model: "m1".into(),
            secret_ref: None,
            auth_env_var: Some("DEMO_KEY".into()),
            model_records: Vec::new(),
        };
        let codex = connection_documents(CliId::Codex, &connection, Scope::Global).unwrap();
        assert_eq!(
            codex["settings"]["model_providers"]["demo"]["wire_api"],
            "responses"
        );
        let grok = connection_documents(CliId::Grok, &connection, Scope::Global).unwrap();
        assert_eq!(grok["settings"]["model"]["m1"]["api_backend"], "responses");
        let pi = connection_documents(CliId::Pi, &connection, Scope::Global).unwrap();
        assert_eq!(pi["models"]["providers"]["demo"]["api"], "openai-responses");
        assert_eq!(pi["models"]["providers"]["demo"]["apiKey"], "${DEMO_KEY}");
        assert_eq!(pi["settings"]["defaultProvider"], "demo");
        assert_eq!(pi["settings"]["defaultModel"], "m1");
        let opencode = connection_documents(CliId::OpenCode, &connection, Scope::Global).unwrap();
        assert_eq!(
            opencode["settings"]["provider"]["demo"]["npm"],
            "@ai-sdk/openai"
        );
        assert!(connection_documents(CliId::Codex, &connection, Scope::Project).is_err());
        let mut reserved = connection.clone();
        reserved.provider_id = "openai".into();
        let codex = connection_documents(CliId::Codex, &reserved, Scope::Global).unwrap();
        assert!(codex["settings"].get("model_providers").unwrap().get("openai").is_none());
        assert_eq!(codex["settings"]["model_provider"], "openai-custom");
        assert_eq!(codex["settings"]["model_providers"]["openai-custom"]["base_url"], "https://example.test/v1");
        assert_eq!(codex["settings"]["model_providers"]["openai-custom"]["wire_api"], "responses");
        let registry=crate::adapters::Registry::builtins();
        let existing=BTreeMap::from([("models".into(),json!({"providers":{"demo":{"models":[{"id":"m1","contextWindow":123,"cost":{"input":2}},{"id":"other","name":"Keep"}]}}}))]);
        let preserved=registry.get("pi").unwrap().connection_documents_for_existing(&connection,Scope::Global,&existing).unwrap();
        assert_eq!(preserved["models"]["providers"]["demo"]["models"],existing["models"]["providers"]["demo"]["models"]);
        let mut grok_connection=connection.clone();grok_connection.model="request-id".into();
        let existing=BTreeMap::from([("settings".into(),json!({"models":{"default":"friendly-alias"},"model":{"friendly-alias":{"model":"request-id","name":"Visible name","api_backend":"chat"}}}))]);
        let mapped=registry.get("grok").unwrap().connection_documents_for_existing(&grok_connection,Scope::Global,&existing).unwrap();
        assert_eq!(mapped["settings"]["models"]["default"],"friendly-alias");
        assert_eq!(mapped["settings"]["model"]["friendly-alias"]["model"],"request-id");
        assert_eq!(mapped["settings"]["model"]["friendly-alias"]["name"],"Visible name");
    }

    #[test]
    fn codex_reserved_provider_is_renamed_and_the_old_table_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let path = temp.path().join("config.toml");
        let mut named = secret_profile(CliId::Codex, "openai-provider", "openai", "");
        named.connection.as_mut().unwrap().secret_ref = None;
        named.files.insert(
            "settings".into(),
            "unrelated = 7\nmodel_provider = \"openai\"\n[model_providers.openai]\nname = \"openai\"\nbase_url = \"https://example.test/v1\"\nwire_api = \"responses\"\n".into(),
        );
        let previous = json!({
            "settings": {
                "/model": "model-a",
                "/model_provider": "openai",
                "/model_providers/openai/name": "openai",
                "/model_providers/openai/base_url": "https://example.test/v1",
                "/model_providers/openai/wire_api": "responses"
            }
        });
        fs::write(
            &path,
            "unrelated = 7\nmodel = \"model-a\"\nmodel_provider = \"openai\"\n\n[model_providers.openai]\nname = \"openai\"\nbase_url = \"https://example.test/v1\"\nwire_api = \"responses\"\n",
        )
        .unwrap();
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,?3,?4)",
                params![named.id, named.tool.stable_id(), named.version as i64, serde_json::to_string(&named).unwrap()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1,?2,?3,?4,?5)",
                params!["global", "codex", named.id, named.version as i64, previous.to_string()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        apply_fixture(&db, &store, &named, None, &[native(&path)], "global", Scope::Global, false).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let parsed = format::parse(format::FileKind::Toml, &text).unwrap();
        assert_eq!(parsed["model_provider"], "openai-custom");
        assert!(parsed["model_providers"].get("openai").is_none());
        assert_eq!(parsed["model_providers"]["openai-custom"]["base_url"], "https://example.test/v1");
        assert_eq!(parsed["unrelated"], 7);
        assert!(!text.contains("model_providers.openai]") && !text.contains("[model_providers.openai]"));
    }

    #[test]
    fn claude_default_model_context_change_survives_save_apply_and_native_read() {
        let temp=tempfile::tempdir().unwrap(); let db=Database::open(&temp.path().join("app.db")).unwrap();
        let store=MemoryStore::default(); let path=temp.path().join("settings.json");
        let mut named=secret_profile(CliId::ClaudeCode,"context-change","anthropic","");
        named.connection.as_mut().unwrap().secret_ref=None;
        named.connection.as_mut().unwrap().model="request-model[1m]".into();
        named.files.insert("settings".into(),json!({"env":{"ANTHROPIC_MODEL":"request-model[1M]","ANTHROPIC_DEFAULT_SONNET_MODEL":"sonnet-id[1m]","ANTHROPIC_DEFAULT_SONNET_MODEL_NAME":"Sonnet display","CLAUDE_CODE_SUBAGENT_MODEL":"subagent-id","UNRELATED":"keep"},"extra":{"keep":true}}).to_string());
        apply_fixture(&db,&store,&named,None,&[native_role("settings",&path,"json")],"global",Scope::Global,false).unwrap();
        let first:Value=serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(first["env"]["ANTHROPIC_MODEL"],"request-model[1m]");
        named.connection.as_mut().unwrap().model="request-model".into();
        let mut draft:Value=serde_json::from_str(&named.files["settings"]).unwrap();
        draft["env"]["ANTHROPIC_MODEL"]=json!("request-model");named.files.insert("settings".into(),draft.to_string());
        named=profile::save_profile(&db,named.clone(),Some(named.version)).unwrap();
        apply_fixture(&db,&store,&named,None,&[native_role("settings",&path,"json")],"global",Scope::Global,false).unwrap();
        let second:Value=serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(second["env"]["ANTHROPIC_MODEL"],"request-model");
        assert_eq!(second["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],"sonnet-id[1m]");
        assert_eq!(second["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"],"Sonnet display");
        assert_eq!(second["env"]["CLAUDE_CODE_SUBAGENT_MODEL"],"subagent-id");
        assert_eq!(second["env"]["UNRELATED"],"keep");assert_eq!(second["extra"]["keep"],true);

        let registry=crate::adapters::Registry::builtins();
        let project=temp.path().join("项目 O'Neil;目录");fs::create_dir_all(project.join(".claude")).unwrap();
        let project_settings=project.join(".claude/settings.json");let local=project.join(".claude/settings.local.json");
        fs::write(&project_settings,json!({"env":{"ANTHROPIC_MODEL":"different[1M]"},"unrelated":7}).to_string()).unwrap();
        let native=registry.get("claude_code").unwrap().native_files(Scope::Project,temp.path(),Some(&project),true);
        let key=scope_key(Scope::Project,Some(&project)).unwrap();
        for has_local in [false,true] {
            if has_local {fs::write(&local,json!({"env":{"ANTHROPIC_API_KEY":"test-only-old-key"},"permissions":{"defaultMode":"default"}}).to_string()).unwrap();}
            let comparison=compare_registered_application(&registry,&db,temp.path(),Scope::Project,Some(&project),&named.id).unwrap();
            let registered=RegisteredProfile::from(named.clone());
            let baselines:BTreeMap<_,_>=comparison.files.iter().map(|file|(file.role.clone(),file.current.clone())).collect();
            assert_eq!(baselines.get("local_settings").unwrap(),&transaction::read_native(&local).unwrap());
            let mut incomplete=baselines.clone();incomplete.remove("local_settings");
            assert!(apply_registered_validated_compared(&registry,&db,&store,&registered,None,&native,&key,Scope::Project,true,Some(&incomplete)).unwrap_err().contains("比较后"));
            fs::write(&local,"{\"external\":true}").unwrap();
            assert!(apply_registered_validated_compared(&registry,&db,&store,&registered,None,&native,&key,Scope::Project,true,Some(&baselines)).unwrap_err().contains("比较后"));
            assert_eq!(fs::read_to_string(&local).unwrap(),"{\"external\":true}");
            if has_local {fs::write(&local,&baselines["local_settings"]).unwrap();} else {fs::remove_file(&local).unwrap();}
            apply_registered_validated_compared(&registry,&db,&store,&registered,None,&native,&key,Scope::Project,true,Some(&baselines)).unwrap();
            let result:Value=serde_json::from_str(&fs::read_to_string(&project_settings).unwrap()).unwrap();
            assert_eq!(result["env"]["ANTHROPIC_MODEL"],"request-model");assert_eq!(result["unrelated"],7);
            if has_local {let result:Value=serde_json::from_str(&fs::read_to_string(&local).unwrap()).unwrap();assert!(result["env"].get("ANTHROPIC_API_KEY").is_none());assert_eq!(result["permissions"]["defaultMode"],"default");}
        }
    }

    fn secret_profile(tool: CliId, name: &str, provider: &str, id: &str) -> NativeProfile {
        NativeProfile {
            revision: String::new(),
            id: name.into(),
            tool,
            name: name.into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: Some(Connection {
                provider_id: provider.into(),
                interface_format: if tool == CliId::ClaudeCode {
                    "anthropic_messages"
                } else {
                    "openai_responses"
                }
                .into(),
                base_url: "https://example.test/v1".into(),
                model: "model-a".into(),
                secret_ref: Some(id.into()),
                auth_env_var: None,
                model_records: Vec::new(),
            }),
        }
    }

    fn native_role(role: &'static str, path: &Path, format: &'static str) -> NativeFile {
        NativeFile {
            role,
            path: path.display().to_string(),
            format,
            writable: true,
            reason: None,
            sensitive: false,
        }
    }

    #[test]
    fn all_five_cli_credentials_are_native_and_never_enter_bindings_or_journal_plaintext() {
        let id = "connection-00000000-0000-4000-8000-000000000001";
        let cases = [
            (CliId::Codex, "toml", "experimental_bearer_token"),
            (CliId::ClaudeCode, "json", "ANTHROPIC_API_KEY"),
            (CliId::Grok, "toml", "api_key"),
            (CliId::Pi, "json", "apiKey"),
            (CliId::OpenCode, "json", "apiKey"),
        ];
        for (tool, format, field) in cases {
            let temp = tempfile::tempdir().unwrap();
            let db = Database::open(&temp.path().join("app.db")).unwrap();
            let store = MemoryStore::default();
            let secret = format!("test-only-{tool:?}-private-key");
            store.put(id, &secret).unwrap();
            let settings = temp.path().join(if format == "toml" {
                "settings.toml"
            } else {
                "settings.json"
            });
            let models = temp.path().join("models.json");
            let mut files = vec![native_role("settings", &settings, format)];
            if tool == CliId::Pi {
                files.push(native_role("models", &models, "jsonc"));
            }
            let profile = secret_profile(tool, "first", "demo", id);
            apply_fixture(
                &db,
                &store,
                &profile,
                None,
                &files,
                "global",
                Scope::Global,
                false,
            )
            .unwrap();
            let registry=crate::adapters::Registry::builtins();
            let registered=RegisteredProfile::from(profile.clone());
            let documents=desired_registered_documents(&registry,&registered,None,Scope::Global).unwrap();
            let mut declared=files.clone();let mut identity=native_role("auth",&temp.path().join("identity.json"),"json");identity.sensitive=true;declared.push(identity);
            let comparison=comparison_files(&declared,&documents,&documents.keys().cloned().collect()).unwrap();
            assert!(!comparison.iter().any(|file|file.role=="auth"));
            let baselines=comparison.into_iter().map(|file|(file.role,file.current)).collect();
            let native_text = fs::read_to_string(if tool == CliId::Pi {
                &models
            } else {
                &settings
            })
            .unwrap();
            let matching = apply_registered_validated_compared(&registry,&db,&store,&registered,None,&files,"global",Scope::Global,true,Some(&baselines)).unwrap();
            assert_eq!(matching.status, "written_for_next_session", "{tool:?}");
            assert!(
                matching.changed_files.iter().any(|path| path
                    == &if tool == CliId::Pi {
                        models.display().to_string()
                    } else {
                        settings.display().to_string()
                    }),
                "{tool:?}"
            );
            assert!(native_text.contains(field), "{tool:?}");
            assert!(native_text.contains(&secret), "{tool:?}");
            let binding =
                serde_json::to_string(&get_binding(&db, tool, "global").unwrap()).unwrap();
            assert!(!binding.contains(&secret), "{tool:?}");
            assert!(
                !binding.contains(&transaction::fingerprint(secret.as_bytes())),
                "{tool:?}"
            );
            db.with_connection(|conn| {
                let mut statement = conn
                    .prepare("SELECT data FROM native_transactions")
                    .map_err(|e| e.to_string())?;
                let data: Vec<String> = statement
                    .query_map([], |row| row.get(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                for journal in data {
                    assert!(!journal.contains(&secret), "{tool:?}");
                    assert!(
                        !journal.contains(&transaction::fingerprint(native_text.as_bytes())),
                        "{tool:?}"
                    );
                    assert!(journal.contains("h1:"), "{tool:?}");
                }
                Ok(())
            })
            .unwrap();
        }
    }

    #[test]
    fn replacing_claude_connection_key_ignores_stale_imported_reference_and_removes_old_token() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        fs::write(&file, r#"{"env":{"ANTHROPIC_API_KEY":"old-native","ANTHROPIC_AUTH_TOKEN":"old-token"},"permissions":{"defaultMode":"default"}}"#).unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let new_id = "connection-00000000-0000-4000-8000-000000000002";
        store.put(new_id, "new-native-key").unwrap();
        let mut profile = secret_profile(CliId::ClaudeCode, "replacement", "anthropic", new_id);
        profile.native_credentials.insert(
            "settings".into(),
            BTreeMap::from([(
                "ANTHROPIC_API_KEY".into(),
                "connection-00000000-0000-4000-8000-000000000001".into(),
            )]),
        );
        apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &[native_role("settings", &file, "json")],
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
        let native = fs::read_to_string(&file).unwrap();
        assert!(native.contains("new-native-key"));
        assert!(!native.contains("old-native"));
        assert!(!native.contains("old-token"));
        assert!(native.contains("defaultMode"));
    }

    #[test]
    fn pi_switch_removes_empty_providers_and_repairs_previous_switch_residue() {
        for keep_override in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let db = Database::open(&temp.path().join("app.db")).unwrap();
            let store = MemoryStore::default();
            let id = "connection-00000000-0000-4000-8000-000000000001";
            store.put(id, "test-pi-key").unwrap();
            let settings = temp.path().join("settings.json");
            let models = temp.path().join("models.json");
            let files = [native_role("settings", &settings, "json"), native_role("models", &models, "jsonc")];
            let first = secret_profile(CliId::Pi, "first", "anthropic", id);
            let second = secret_profile(CliId::Pi, "second", "new/provider~name", id);
            apply_fixture(&db, &store, &first, None, &files, "global", Scope::Global, false).unwrap();
            let mut native = format::parse(format::FileKind::Jsonc, &fs::read_to_string(&models).unwrap()).unwrap();
            native["providers"]["stale/provider~name"] = json!({});
            native["providers"]["user-provider"] = json!({"baseUrl":"https://user.example.test", "headers":{"x-custom":"keep"}});
            native["unrelated"] = json!({});
            if keep_override {
                native["providers"]["anthropic"]["headers"] = json!({"x-custom":"keep"});
            }
            fs::write(&models, format!("// keep this comment\n{}", serde_json::to_string_pretty(&native).unwrap())).unwrap();
            apply_fixture(&db, &store, &second, None, &files, "global", Scope::Global, false).unwrap();
            let text = fs::read_to_string(&models).unwrap();
            let result = format::parse(format::FileKind::Jsonc, &text).unwrap();
            assert!(text.contains("// keep this comment"));
            assert!(result["providers"].get("stale/provider~name").is_none());
            if keep_override {
                assert_eq!(result["providers"]["anthropic"], json!({"headers":{"x-custom":"keep"}}));
            } else {
                assert!(result["providers"].get("anthropic").is_none(), "empty old provider breaks Pi: {result}");
            }
            assert_eq!(result["providers"]["user-provider"], native["providers"]["user-provider"]);
            assert_eq!(result["unrelated"], json!({}));
            assert_eq!(result["providers"]["new/provider~name"]["apiKey"], "test-pi-key");
            apply_fixture(&db, &store, &first, None, &files, "global", Scope::Global, false).unwrap();
            let switched_back = format::parse(format::FileKind::Jsonc, &fs::read_to_string(&models).unwrap()).unwrap();
            assert!(switched_back["providers"].get("new/provider~name").is_none());
            assert_eq!(switched_back["providers"]["anthropic"]["apiKey"], "test-pi-key");
        }
    }

    #[test]
    fn switching_profiles_removes_old_native_key_and_external_edit_is_a_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.toml");
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let first_id = "connection-00000000-0000-4000-8000-000000000001";
        let second_id = "connection-00000000-0000-4000-8000-000000000002";
        store.put(first_id, "old-test-key").unwrap();
        store.put(second_id, "new-test-key").unwrap();
        let first = secret_profile(CliId::Codex, "first", "old_provider", first_id);
        let second = secret_profile(CliId::Codex, "second", "new_provider", second_id);
        let target = [native_role("settings", &file, "toml")];
        apply_fixture(
            &db,
            &store,
            &first,
            None,
            &target,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let first_text = fs::read_to_string(&file).unwrap();
        assert!(first_text.contains("old-test-key"));
        apply_fixture(
            &db,
            &store,
            &second,
            None,
            &target,
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let second_text = fs::read_to_string(&file).unwrap();
        assert!(!second_text.contains("old-test-key"));
        assert!(second_text.contains("new-test-key"));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
        fs::write(
            &file,
            second_text.replace("new-test-key", "external-test-key"),
        )
        .unwrap();
        assert!(apply_fixture(
            &db,
            &store,
            &first,
            None,
            &target,
            "global",
            Scope::Global,
            false
        )
        .unwrap_err()
        .contains("外部修改"));
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("external-test-key"));
        assert_eq!(
            get_binding(&db, CliId::Codex, "global")
                .unwrap()
                .unwrap()
                .profile_id,
            "second"
        );
    }

    #[test]
    fn imported_claude_project_key_moves_to_local_file_without_inventing_model_or_url() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join(".claude/settings.json");
        let local = temp.path().join(".claude/settings.local.json");
        fs::create_dir_all(shared.parent().unwrap()).unwrap();
        let source = include_str!("../../../tests/fixtures/native/claude-key-only-settings.json");
        fs::write(&shared, source).unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let imported = super::super::intake::prepare_import(
            CliId::ClaudeCode,
            BTreeMap::from([("settings".into(), source.into())]),
            &store,
        )
        .unwrap();
        let profile = NativeProfile {
            revision: String::new(),
            id: "imported".into(),
            tool: CliId::ClaudeCode,
            name: "imported".into(),
            version: 1,
            inherit_common: false,
            files: imported.files,
            suppressed: BTreeMap::new(),
            connection: imported.inspection.connection,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: imported.native_credentials,
        };
        let native_files = [
            native_role("settings", &shared, "json"),
            native_role("local_settings", &local, "json"),
        ];
        assert!(apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &native_files,
            "project:test",
            Scope::Project,
            false
        )
        .unwrap_err()
        .contains("接管"));
        assert_eq!(fs::read_to_string(&shared).unwrap(), source);
        apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &native_files,
            "project:test",
            Scope::Project,
            true,
        )
        .unwrap();
        let shared_after = fs::read_to_string(&shared).unwrap();
        let local_after = fs::read_to_string(&local).unwrap();
        assert!(!shared_after.contains("test-only-global-secret"));
        assert!(local_after.contains("test-only-global-secret"));
        assert!(!local_after.contains("ANTHROPIC_BASE_URL"));
        assert!(!local_after.contains("\"model\""));
        assert!(shared_after.contains("defaultMode"));
    }

    #[test]
    fn claude_auth_token_connection_uses_selected_native_field_and_preview_rejects_raw_secret() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let id = "connection-00000000-0000-4000-8000-000000000001";
        store.put(id, "token-test-value").unwrap();
        let mut profile = secret_profile(CliId::ClaudeCode, "token", "anthropic", id);
        profile.connection.as_mut().unwrap().auth_env_var = Some("ANTHROPIC_AUTH_TOKEN".into());
        apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &[native_role("settings", &path, "json")],
            "global",
            Scope::Global,
            false,
        )
        .unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(written.contains("token-test-value"));
        assert!(!written.contains("ANTHROPIC_API_KEY"));
        profile.connection.as_mut().unwrap().auth_env_var = Some("CUSTOM_TOKEN".into());
        assert!(native_secrets(
            &crate::adapters::Registry::builtins(),
            &RegisteredProfile::from(profile.clone()),
            Scope::Global,
            &store
        )
        .unwrap_err()
        .contains("只支持"));
        let mut raw = profile.clone();
        raw.files.insert(
            "settings".into(),
            r#"{"env":{"ANTHROPIC_API_KEY":"raw-preview-key"}}"#.into(),
        );
        assert!(preview(&raw, None, Scope::Global).is_err());
    }

    #[test]
    fn unmanaged_claude_keys_require_takeover_and_no_key_profile_clears_both_project_files() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("settings.json");
        let local = temp.path().join("settings.local.json");
        fs::write(
            &shared,
            r#"{"env":{"ANTHROPIC_API_KEY":"shared-key"},"permissions":{"defaultMode":"default"}}"#,
        )
        .unwrap();
        fs::write(
            &local,
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"local-token"},"other":true}"#,
        )
        .unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let profile = NativeProfile {
            revision: String::new(),
            id: "native-login".into(),
            tool: CliId::ClaudeCode,
            name: "native login".into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: None,
        };
        let targets = [
            native_role("settings", &shared, "json"),
            native_role("local_settings", &local, "json"),
        ];
        let before_shared = fs::read_to_string(&shared).unwrap();
        let before_local = fs::read_to_string(&local).unwrap();
        assert!(apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &targets,
            "project:test",
            Scope::Project,
            false
        )
        .unwrap_err()
        .contains("接管"));
        assert_eq!(fs::read_to_string(&shared).unwrap(), before_shared);
        assert_eq!(fs::read_to_string(&local).unwrap(), before_local);
        let outcome = apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &targets,
            "project:test",
            Scope::Project,
            true,
        )
        .unwrap();
        assert_eq!(outcome.changed_files.len(), 2);
        let shared_after = fs::read_to_string(&shared).unwrap();
        let local_after = fs::read_to_string(&local).unwrap();
        assert!(!shared_after.contains("shared-key"));
        assert!(!local_after.contains("local-token"));
        assert!(shared_after.contains("defaultMode"));
        assert!(local_after.contains("other"));
        apply_fixture(
            &db,
            &store,
            &profile,
            None,
            &targets,
            "project:test",
            Scope::Project,
            false,
        )
        .unwrap();
    }

    #[test]
    fn project_key_cleanup_can_inherit_global_fixture_without_touching_it() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        let global = home.join(".claude/settings.json");
        let global_fixture =
            include_str!("../../../tests/fixtures/native/claude-key-only-settings.json");
        let project_fixture =
            include_str!("../../../tests/fixtures/native/claude-key-only-local.json");
        fs::write(&global, global_fixture).unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".claude")).unwrap();
        let shared = project.join(".claude/settings.json");
        let local = project.join(".claude/settings.local.json");
        fs::write(&shared, "{}").unwrap();
        fs::write(&local, project_fixture).unwrap();
        let executable = temp.path().join(if cfg!(windows) {
            "claude.ps1"
        } else {
            "claude"
        });
        fs::write(
            &executable,
            if cfg!(windows) {
                "Write-Output 'claude 2.1.0'\n"
            } else {
                "#!/bin/sh\nprintf 'claude 2.1.0\\n'\n"
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let profile = NativeProfile {
            revision: String::new(),
            id: String::new(),
            tool: CliId::ClaudeCode,
            name: "inherit user login".into(),
            version: 1,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: None,
        };
        let saved = profile::save_profile(&db, profile, None).unwrap();
        assert!(apply_profile(
            &db,
            &store,
            CliId::ClaudeCode,
            &saved.id,
            Scope::Project,
            &home,
            Some(&project),
            Some(&executable),
            false
        )
        .unwrap_err()
        .contains("接管"));
        assert_eq!(fs::read_to_string(&global).unwrap(), global_fixture);
        assert_eq!(fs::read_to_string(&local).unwrap(), project_fixture);
        apply_profile(
            &db,
            &store,
            CliId::ClaudeCode,
            &saved.id,
            Scope::Project,
            &home,
            Some(&project),
            Some(&executable),
            true,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&global).unwrap(), global_fixture);
        let local_after = fs::read_to_string(&local).unwrap();
        assert!(!local_after.contains("test-only-project-secret"));
        assert!(local_after.contains("enabledPlugins"));
    }

    fn record(id: &str, fields: Value) -> profile::ModelRecord {
        profile::ModelRecord { id: id.into(), fields: fields.as_object().cloned().unwrap_or_default() }
    }

    fn save_registered(db: &Database, profile: &RegisteredProfile) {
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO native_profiles (id,tool,version,data) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,tool=excluded.tool",
                params![profile.id, profile.tool, profile.version as i64, serde_json::to_string(profile).unwrap()],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    }

    fn registered(tool: &str, provider: &str, model: &str, secret: Option<&str>, records: Vec<profile::ModelRecord>) -> RegisteredProfile {
        RegisteredProfile {
            id: format!("{tool}-save"),
            tool: tool.into(),
            name: tool.into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
            connection: Some(Connection {
                provider_id: provider.into(),
                interface_format: "openai_responses".into(),
                base_url: "https://example.test/v1".into(),
                model: model.into(),
                secret_ref: secret.map(str::to_owned),
                auth_env_var: None,
                model_records: records,
            }),
        }
    }

    #[test]
    fn opencode_save_edits_existing_model_fields_and_keeps_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let path = temp.path().join("opencode.json");
        let original = r#"{
            "model": "existing/one",
            "provider": {
                "existing": {"npm": "@ai-sdk/openai-compatible", "name": "existing", "models": {"one": {"name": "Kept One"}}},
                "demo": {
                    "npm": "@ai-sdk/openai",
                    "name": "demo",
                    "options": {"baseURL": "https://old.example/v1"},
                    "models": {
                        "m1": {"name": "Custom M1", "extra": true},
                        "m2": {"name": "Custom M2"}
                    }
                }
            }
        }"#;
        fs::write(&path, original).unwrap();
        let mut profile = registered("open_code", "demo", "m1", None, vec![record("m1", json!({"extra": false, "contextWindow": 999}))]);
        save_registered(&db, &profile);
        let files = [native_role("settings", &path, "json")];
        apply_registered_validated(&crate::adapters::Registry::builtins(), &db, &store, &profile, None, &files, "global", Scope::Global, true).unwrap();
        let first = format::parse(format::FileKind::Json, &fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(first["model"], "demo/m1");
        assert_eq!(first["provider"]["demo"]["models"]["m1"]["name"], "Custom M1");
        assert_eq!(first["provider"]["demo"]["models"]["m1"]["extra"], false);
        assert!(first["provider"]["demo"]["models"]["m1"].get("contextWindow").is_none());
        assert_eq!(first["provider"]["demo"]["models"]["m2"]["name"], "Custom M2");
        assert_eq!(first["provider"]["existing"]["models"]["one"]["name"], "Kept One");
        profile.connection.as_mut().unwrap().model = "m2".into();
        profile.connection.as_mut().unwrap().model_records.clear();
        save_registered(&db, &profile);
        apply_registered_validated(&crate::adapters::Registry::builtins(), &db, &store, &profile, None, &files, "global", Scope::Global, false).unwrap();
        let second = format::parse(format::FileKind::Json, &fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(second["model"], "demo/m2");
        assert_eq!(second["provider"]["demo"]["models"]["m1"]["name"], "Custom M1");
        assert_eq!(second["provider"]["demo"]["models"]["m1"]["extra"], false);
        assert!(second["provider"]["demo"]["models"]["m1"].get("contextWindow").is_none());
        assert_eq!(second["provider"]["demo"]["models"]["m2"]["name"], "Custom M2");
        assert_eq!(second["provider"]["existing"]["models"]["one"]["name"], "Kept One");
    }

    #[test]
    fn pi_save_edits_existing_nested_fields_without_adding_keys_or_models() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let settings = temp.path().join("settings.json");
        let models = temp.path().join("models.json");
        fs::write(&settings, r#"{"theme":"kept"}"#).unwrap();
        fs::write(&models, r#"{
            "providers": {
                "demo": {"baseUrl":"https://old.example/v1","api":"openai-responses","models":[{"id":"model-a","contextWindow":100,"cost":{"input":1,"output":2}},{"id":"sibling","name":"Keep","contextWindow":50}]},
                "other": {"baseUrl":"https://other.example/v1","models":[{"id":"x","name":"Other"}]}
            }
        }"#).unwrap();
        let profile = registered("pi", "demo", "model-a", None, vec![record("model-a", json!({"contextWindow": 200, "cost": {"input": 9}, "missingField": true}))]);
        save_registered(&db, &profile);
        let files = [native_role("settings", &settings, "json"), native_role("models", &models, "jsonc")];
        apply_registered_validated(&crate::adapters::Registry::builtins(), &db, &store, &profile, None, &files, "global", Scope::Global, true).unwrap();
        let settings_text = fs::read_to_string(&settings).unwrap();
        let models_value = format::parse(format::FileKind::Jsonc, &fs::read_to_string(&models).unwrap()).unwrap();
        assert!(settings_text.contains("kept"));
        assert_eq!(models_value["providers"]["demo"]["models"][0]["contextWindow"], 200);
        assert_eq!(models_value["providers"]["demo"]["models"][0]["cost"]["input"], 9);
        assert_eq!(models_value["providers"]["demo"]["models"][0]["cost"]["output"], 2);
        assert!(models_value["providers"]["demo"]["models"][0].get("missingField").is_none());
        assert_eq!(models_value["providers"]["demo"]["models"][1]["name"], "Keep");
        assert_eq!(models_value["providers"]["demo"]["models"][1]["contextWindow"], 50);
        assert_eq!(models_value["providers"]["other"]["models"][0]["name"], "Other");
        assert_eq!(models_value["providers"]["demo"]["models"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn codex_save_changes_provider_model_and_reasoning_only() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let path = temp.path().join("config.toml");
        fs::write(&path, "model = \"old-model\"\nmodel_provider = \"other\"\nmodel_reasoning_effort = \"low\"\nunrelated = 1\n\n[model_providers.other]\nname = \"other\"\nbase_url = \"https://other.example/v1\"\nwire_api = \"responses\"\n\n[model_providers.demo]\nname = \"demo\"\nbase_url = \"https://old.example/v1\"\nwire_api = \"responses\"\ncontext_note = \"keep-me\"\n").unwrap();
        let mut profile = registered("codex", "demo", "gpt-new", None, vec![record("gpt-new", json!({"contextWindow": 4096}))]);
        profile.files.insert("settings".into(), "model_reasoning_effort = \"high\"\n".into());
        save_registered(&db, &profile);
        apply_registered_validated(&crate::adapters::Registry::builtins(), &db, &store, &profile, None, &[native(&path)], "global", Scope::Global, true).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let parsed = format::parse(format::FileKind::Toml, &text).unwrap();
        assert_eq!(parsed["model"], "gpt-new");
        assert_eq!(parsed["model_provider"], "demo");
        assert_eq!(parsed["model_reasoning_effort"], "high");
        assert_eq!(parsed["unrelated"], 1);
        assert_eq!(parsed["model_providers"]["other"]["base_url"], "https://other.example/v1");
        assert_eq!(parsed["model_providers"]["demo"]["context_note"], "keep-me");
        assert!(!text.contains("contextWindow"));
    }

    #[test]
    fn new_secrets_are_rejected_before_files_change_and_stored_keys_stay() {
        let registry = crate::adapters::Registry::builtins();
        let cases = [
            ("codex", Scope::Project, "Codex 项目层不能写入供应商密钥；请使用全局配置"),
            ("open_code", Scope::Project, "OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录"),
            ("pi", Scope::Project, "Pi 项目层不能写入供应商密钥；请使用全局配置"),
            ("grok", Scope::Project, "Grok 项目层不能写入供应商密钥；请使用全局配置"),
            ("kimi_code", Scope::Project, "Kimi Code 密钥只在用户级 config.toml 管理"),
            ("zcode", Scope::Global, "ZCode 凭据由产品加密保管（credentials.json），不提供凭据管理"),
            ("zcode", Scope::Project, "ZCode 凭据由产品加密保管（credentials.json），不提供凭据管理"),
            ("qoder_cn", Scope::Global, "Qoder CN 凭据由产品登录态管理，Cliora 不读取或复制账号令牌"),
            ("deepseek", Scope::Project, "DeepSeek Harness 凭据管理不交付：.credentials.yaml 由官方 dsh-credentials-local 插件管理，适配器不读取也不改写"),
        ];
        for (tool, scope, reason) in cases {
            let temp = tempfile::tempdir().unwrap();
            let db = Database::open(&temp.path().join("app.db")).unwrap();
            let store = MemoryStore::default();
            let secret_id = "connection-00000000-0000-4000-8000-000000000099";
            let secret = format!("stored-{tool}-key");
            store.put(secret_id, &secret).unwrap();
            let path = temp.path().join("target.txt");
            let sentinel = format!("sentinel-{tool}-unchanged\n");
            fs::write(&path, &sentinel).unwrap();
            let profile = registered(tool, "demo", "model-a", Some(secret_id), Vec::new());
            let error = apply_registered_validated(&registry, &db, &store, &profile, None, &[native_role("settings", &path, "json")], "project:rejected", scope, true).unwrap_err();
            assert!(error.contains(reason), "{tool}: {error}");
            assert_eq!(fs::read_to_string(&path).unwrap(), sentinel, "{tool}");
            assert_eq!(store.get(secret_id).unwrap(), secret, "{tool}");
        }
        let mut without_key = registered("codex", "demo", "model-a", None, Vec::new());
        registry.get("codex").unwrap().reject_new_secret(&without_key, Scope::Project).unwrap();
        without_key.connection.as_mut().unwrap().secret_ref = Some(String::new());
        registry.get("codex").unwrap().reject_new_secret(&without_key, Scope::Project).unwrap();
        let claude = registered("claude_code", "anthropic", "model-a", Some("connection-00000000-0000-4000-8000-000000000099"), Vec::new());
        registry.get("claude_code").unwrap().reject_new_secret(&claude, Scope::Project).unwrap();
    }

    #[test]
    fn codebuddy_writes_official_env_key_without_a_provider_address() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let secret_id = "connection-00000000-0000-4000-8000-0000000000cb";
        store.put(secret_id, "cb-test-key").unwrap();
        let path = temp.path().join("settings.json");
        fs::write(&path, r#"{"model":"keep-model","env":{"CODEBUDDY_BASE_URL":"https://gateway.example"}}"#).unwrap();
        let mut profile = registered("codebuddy", "third-party", "should-not-matter", Some(secret_id), Vec::new());
        profile.connection.as_mut().unwrap().base_url = "https://third-party.example/v1".into();
        profile.connection.as_mut().unwrap().interface_format = "openai_completions".into();
        save_registered(&db, &profile);
        apply_registered_validated(&crate::adapters::Registry::builtins(), &db, &store, &profile, None, &[native_role("settings", &path, "json")], "global", Scope::Global, false).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let parsed = format::parse(format::FileKind::Json, &text).unwrap();
        assert_eq!(parsed["model"], "keep-model");
        assert_eq!(parsed["env"]["CODEBUDDY_BASE_URL"], "https://gateway.example");
        assert_eq!(parsed["env"]["CODEBUDDY_API_KEY"], "cb-test-key");
        assert!(!text.contains("third-party"));
        assert!(!text.contains("should-not-matter"));
        assert_eq!(store.get(secret_id).unwrap(), "cb-test-key");
    }
}
