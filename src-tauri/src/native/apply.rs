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

fn native_secrets(
    registry: &super::adapters::Registry,
    profile: &RegisteredProfile,
    scope: Scope,
    credentials: &dyn CredentialStore,
) -> Result<NativeSecrets, String> {
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
    adapter.restore_imported_secrets(profile, scope, credentials, &mut result)?;
    adapter.write_connection_secret(profile, scope, credentials, &mut result)?;
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
    pub tool: String,
    pub profile_id: String,
    pub profile_version: u64,
    pub managed: Managed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreview {
    pub documents: BTreeMap<String, Value>,
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

#[cfg(test)]
fn connection_documents(
    tool: CliId,
    connection: &profile::Connection,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    super::adapters::known(tool).connection_documents(connection, scope)
}

fn scope_key(scope: Scope, project: Option<&Path>) -> Result<String, String> {
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
        let row: Option<(String, i64, String)> = conn.query_row("SELECT profile_id, profile_version, managed FROM applied_bindings WHERE scope_key = ?1 AND tool = ?2", params![key, tool], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().map_err(|e| e.to_string())?;
        row.map(|(profile_id, profile_version, managed)| {
            Ok(AppliedBinding { scope_key: key.into(), tool: tool.into(), profile_id, profile_version: profile_version.max(0) as u64, managed: serde_json::from_str(&managed).map_err(|_| "活动配置记录损坏")? })
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
        &super::adapters::Registry::builtins(),
        &registered,
        common.as_ref(),
        scope,
    )
}

pub fn desired_registered_documents(
    registry: &super::adapters::Registry,
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
        for (role, overlay) in adapter.connection_documents(connection, scope)? {
            let existing = result.entry(role).or_insert_with(|| json!({}));
            let (merged, _) = format::resolve(existing, &overlay, &[])?;
            *existing = merged;
        }
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
        &super::adapters::Registry::builtins(),
        &registered,
        common.as_ref(),
        scope,
    )
}

pub fn preview_registered(
    registry: &super::adapters::Registry,
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
    Ok(NativePreview { documents, sources })
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
        &super::adapters::Registry::builtins(),
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
    registry: &super::adapters::Registry,
    db: &Database,
    credentials: &dyn CredentialStore,
    profile: &RegisteredProfile,
    common: Option<&RegisteredCommon>,
    native_files: &[NativeFile],
    key: &str,
    scope: Scope,
    allow_takeover: bool,
) -> Result<ApplyOutcome, String> {
    let adapter = registry
        .get(&profile.tool)
        .ok_or("未注册的 CLI 适配器，不能应用")?;
    let desired = desired_registered_documents(registry, profile, common, scope)?;
    let secrets = native_secrets(registry, profile, scope, credentials)?;
    let integrity = transaction::integrity_key(db, credentials)?;
    let old = get_registered_binding(db, &profile.tool, key)?;
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
            _ => return Err("原生文件格式不受支持".into()),
        };
        let file_path = Path::new(&native.path);
        let baseline = transaction::read_native(file_path)?;
        matching_baselines.push((file_path.to_path_buf(), baseline.clone()));
        let original = format::parse(kind, &baseline)?;
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
                if !managed_value(current, Some(old_value), &integrity) && current != expected_new {
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
            let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id = excluded.profile_id, profile_version = excluded.profile_version, managed = excluded.managed", params![key, profile.tool, profile.id, profile.version as i64, json]).map_err(|e| e.to_string())?;
            Ok(())
        });
    }
    super::adapters::commit_registered_patches(
        registry,
        &profile.tool,
        native_files,
        db,
        credentials,
        &patches,
        |tx| {
            let json = serde_json::to_string(&new_managed).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO applied_bindings (scope_key, tool, profile_id, profile_version, managed) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(scope_key, tool) DO UPDATE SET profile_id = excluded.profile_id, profile_version = excluded.profile_version, managed = excluded.managed", params![key, profile.tool, profile.id, profile.version as i64, json]).map_err(|e| e.to_string())?;
            Ok(())
        },
    )
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
        &super::adapters::Registry::builtins(),
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
    registry: &super::adapters::Registry,
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

    #[test]
    fn switching_named_profiles_removes_only_old_managed_keys() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        fs::write(&path, "# external\nunrelated = 7\n").unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let store = MemoryStore::default();
        let first = profile("first", "a");
        apply_validated(
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
        apply_validated(
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
        assert!(apply_validated(
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
            apply_validated(
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
            let native_text = fs::read_to_string(if tool == CliId::Pi {
                &models
            } else {
                &settings
            })
            .unwrap();
            let matching = apply_validated(
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
        apply_validated(
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
        apply_validated(
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
        apply_validated(
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
        assert!(apply_validated(
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
            native_credentials: imported.native_credentials,
        };
        let native_files = [
            native_role("settings", &shared, "json"),
            native_role("local_settings", &local, "json"),
        ];
        assert!(apply_validated(
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
        apply_validated(
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
        apply_validated(
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
            &super::super::adapters::Registry::builtins(),
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
            native_credentials: BTreeMap::new(),
            connection: None,
        };
        let targets = [
            native_role("settings", &shared, "json"),
            native_role("local_settings", &local, "json"),
        ];
        let before_shared = fs::read_to_string(&shared).unwrap();
        let before_local = fs::read_to_string(&local).unwrap();
        assert!(apply_validated(
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
        let outcome = apply_validated(
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
        apply_validated(
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
}
