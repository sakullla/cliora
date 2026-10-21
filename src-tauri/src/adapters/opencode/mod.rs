pub mod accounts;
pub(crate) mod memory;
pub(crate) mod configuration;
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use super::{
    assign_existing_fields, file, install_line_for, pointer_token, project_root, CliAdapter, Facet,
    InspectionFields, HISTORY_ASSOCIATION_UNAVAILABLE_REASON, InstallLine, LaunchMode,
    MajorUpgradeAction, McpLocation, NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::intake::string_at;
use crate::native::profile::{self, Connection, ModelRecord, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct OpenCode;

/// Two verified install lines. 1.x publishes `opencode-ai`; 2.x publishes the
/// scoped `@opencode/cli`. Both ship the same command and shim entry layout.
pub(crate) const INSTALL_LINES: [InstallLine; 2] = [
    InstallLine {
        major: 1,
        npm_package: "opencode-ai",
        npm_entry: Some("node_modules/opencode-ai/bin/opencode.exe"),
    },
    InstallLine {
        major: 2,
        npm_package: "@opencode/cli",
        npm_entry: Some("node_modules/@opencode/cli/bin/opencode.exe"),
    },
];

/// The declared line for an identified version; `None` when it cannot be
/// selected (the two lines are never guessed).
pub(crate) fn install_line(version: Option<&str>) -> Option<InstallLine> {
    install_line_for(&INSTALL_LINES, version)
}

/// Both verified lines install their launcher here (the 1.x curl script and
/// the 2.x installer), so the directory is the native channel for either line.
const NATIVE_BIN: &str = ".opencode/bin";

/// `opencode upgrade --major` (the official 1.x → OpenCode 2 path) appeared in
/// 1.19.0; older 1.x installs only get the manual migration guidance.
fn major_upgrade_minimum() -> semver::Version {
    semver::Version::new(1, 19, 0)
}

fn unescape_pointer(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

/// Major version of a probed install for the version-tracked skill switch.
fn switch_major(version: Option<&str>) -> Option<u32> {
    version?
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// A rule of the v2 `permissions` array addressing one skill. Verified on a
/// native 2.0.29 load: rules are `{action, resource, effect}` objects.
fn skill_rule_matches(rule: &Value, name: &str) -> bool {
    rule.get("action").and_then(Value::as_str) == Some("skill")
        && rule.get("resource").and_then(Value::as_str) == Some(name)
}

/// The v2 switch replaces the skill's own rules with one appended rule: the
/// array is ordered and the last match wins, so an in-place edit could be
/// overridden by a later broader rule. Other rules keep their content and
/// relative order.
fn permissions_with_rule(rules: &[Value], name: &str, effect: &str) -> Vec<Value> {
    let mut kept: Vec<Value> = rules
        .iter()
        .filter(|rule| !skill_rule_matches(rule, name))
        .cloned()
        .collect();
    kept.push(json!({ "action": "skill", "resource": name, "effect": effect }));
    kept
}

/// The located v2 rule array (empty when the key is still absent); `None`
/// means the location is not the v2 permissions form.
fn switch_rule_array(
    location: &super::SkillSwitchLocation,
    current: &Value,
    skill_path: &Path,
) -> Option<Vec<Value>> {
    if location.field.first().is_some_and(|key| key == "permissions")
        && skill_path.file_name().is_some()
    {
        Some(current.as_array().cloned().unwrap_or_default())
    } else {
        None
    }
}

fn insert_path(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() || !root.is_object() {
        return;
    }
    let mut cursor = root;
    for segment in &path[..path.len() - 1] {
        if !cursor.get(segment).is_some_and(Value::is_object) {
            cursor
                .as_object_mut()
                .unwrap()
                .insert(segment.clone(), json!({}));
        }
        cursor = cursor.get_mut(segment).unwrap();
    }
    cursor
        .as_object_mut()
        .unwrap()
        .insert(path[path.len() - 1].clone(), value);
}

fn model_from_managed(fields: &BTreeMap<String, Value>, prefix: &str) -> Value {
    let mut model = json!({});
    let needle = format!("{prefix}/");
    for (pointer, value) in fields {
        let Some(rest) = pointer.strip_prefix(&needle) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let path: Vec<String> = rest.split('/').map(unescape_pointer).collect();
        insert_path(&mut model, &path, value.clone());
    }
    model
}

fn merge_missing(target: &mut serde_json::Map<String, Value>, source: &serde_json::Map<String, Value>) {
    for (key, value) in source {
        if !target.contains_key(key) {
            target.insert(key.clone(), value.clone());
            continue;
        }
        let existing = target.get_mut(key).unwrap();
        if let (Some(existing_map), Some(value_map)) = (existing.as_object_mut(), value.as_object()) {
            merge_missing(existing_map, value_map);
        }
    }
}

fn write_leaves(fields: &mut BTreeMap<String, Value>, prefix: &str, value: &Value, path: &mut Vec<String>) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, child) in map {
                path.push(key.clone());
                write_leaves(fields, prefix, child, path);
                path.pop();
            }
        }
        _ if !path.is_empty() => {
            let mut pointer = String::from(prefix);
            for segment in path.iter() {
                pointer.push('/');
                pointer.push_str(&pointer_token(segment));
            }
            fields.insert(pointer, value.clone());
        }
        _ => {}
    }
}

fn replace_model_fields(fields: &mut BTreeMap<String, Value>, prefix: &str, model: &Value) {
    let needle = format!("{prefix}/");
    fields.retain(|key, _| !key.starts_with(&needle));
    write_leaves(fields, prefix, model, &mut Vec::new());
}

fn draft_models(profile: &RegisteredProfile, form: configuration::Form, provider: &str) -> Result<serde_json::Map<String, Value>, String> {
    let Some(text) = profile.files.get("settings") else {
        return Ok(serde_json::Map::new());
    };
    let parsed = crate::native::format::parse(FileKind::Jsonc, text)?;
    Ok(parsed
        .get(form.providers_key())
        .and_then(|root| root.get(provider))
        .and_then(|entry| entry.get("models"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default())
}

/// OpenCode follows `XDG_CONFIG_HOME` for the signed-in user. A caller-supplied
/// home that is not the real user home (tests, isolated profiles) stays under
/// that home so CI cannot redirect writes to the runner's config directory.
fn config_base(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(xdg) = env::var_os("XDG_CONFIG_HOME") {
            let path = PathBuf::from(xdg);
            if path.is_absolute() {
                return path;
            }
        }
    }
    home.join(".config")
}

impl CliAdapter for OpenCode {
    fn configuration(&self) -> Option<&dyn crate::adapters::configuration::ConfigurationAdapter> { Some(self) }
    fn supports_mcp(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn accounts(&self) -> Option<&dyn crate::adapters::accounts::AccountAdapter> {
        Some(self)
    }
    fn memory(&self) -> Option<&dyn super::memory::MemoryAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "open_code"
    }
    fn name(&self) -> &'static str {
        "OpenCode"
    }
    fn command(&self) -> &'static str {
        "opencode"
    }
    fn npm_package(&self) -> &'static str {
        "opencode-ai"
    }
    fn install_lines(&self) -> Vec<InstallLine> {
        INSTALL_LINES.to_vec()
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(NATIVE_BIN)]
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.parent().is_some_and(|parent| parent.ends_with(NATIVE_BIN))
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        output.contains("opencode")
            || (basename == "opencode"
                && (output.starts_with('v')
                    || output.chars().next().is_some_and(|c| c.is_ascii_digit())))
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        let dir = root.map(Path::to_path_buf).unwrap_or_else(|| {
            crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
        });
        let jsonc = dir.join("opencode.jsonc");
        let (path, kind) = if jsonc.exists() {
            (jsonc, FileKind::Jsonc)
        } else {
            (dir.join("opencode.json"), FileKind::Json)
        };
        vec![file("settings", path, kind, known, None, false)]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Jsonc)
        } else {
            Err("OpenCode 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &["model", "small_model", "provider", "agent", "permission", "mcp"]
        } else {
            &[]
        }
    }
    fn skill_switch_requires_version(&self) -> bool {
        true
    }
    fn skill_switch_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
        version: Option<&str>,
    ) -> Option<super::SkillSwitchLocation> {
        let file = self
            .native_files(scope, home, project, true)
            .into_iter()
            .find(|file| file.role == "settings")?;
        let kind = FileKind::for_name(&file.path).ok()?;
        let field = match switch_major(version) {
            Some(1) => vec!["permission".into(), "skill".into(), name.into()],
            // Verified on a native 2.0.29 load: skill switches are rules in the
            // top-level ordered `permissions` array.
            Some(2) => vec!["permissions".into()],
            Some(_) => return None,
            // No verified install version: only the file's own explicit
            // native-form evidence authorizes a write. A v2 `permissions`
            // array or an existing v1 `permission.skill` subtree selects that
            // form; with no signal there is no location, so the shared write
            // path refuses instead of guessing the historical v1 pointer
            // (R1, same unverified-version boundary as the MCP location).
            None => std::fs::read_to_string(Path::new(&file.path))
                .ok()
                .and_then(|text| crate::native::format::parse(kind, &text).ok())
                .and_then(|root| {
                    if root.get("permissions").is_some_and(Value::is_array) {
                        Some(vec!["permissions".into()])
                    } else {
                        root.pointer("/permission/skill")
                            .filter(|value| !value.is_null())
                            .map(|_| vec!["permission".into(), "skill".into(), name.into()])
                    }
                })?,
        };
        Some(super::SkillSwitchLocation {
            path: file.path.into(),
            kind,
            field,
        })
    }
    fn skill_switch_value_at(
        &self,
        location: &super::SkillSwitchLocation,
        current: &Value,
        enabled: bool,
        skill_path: &Path,
    ) -> Value {
        if let Some(rules) = switch_rule_array(location, current, skill_path) {
            let name = skill_path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            let effect = if enabled { "allow" } else { "deny" };
            return Value::Array(permissions_with_rule(&rules, name, effect));
        }
        json!(if enabled { "allow" } else { "deny" })
    }
    fn skill_switch_value(&self, _: &Value, enabled: bool, _: &Path) -> Value {
        json!(if enabled { "allow" } else { "deny" })
    }
    fn skill_switch_enabled(&self, current: &Value, skill_path: &Path) -> bool {
        if let Some(rules) = current.as_array() {
            let name = skill_path.file_name().and_then(|v| v.to_str());
            return rules
                .iter()
                .rfind(|rule| name.is_some_and(|name| skill_rule_matches(rule, name)))
                .and_then(|rule| rule.get("effect"))
                .and_then(Value::as_str)
                != Some("deny");
        }
        current.as_str() != Some("deny")
    }
    fn skill_switch_snapshot_at(
        &self,
        location: &super::SkillSwitchLocation,
        current: &Value,
        skill_path: &Path,
    ) -> Option<Value> {
        if let Some(rules) = switch_rule_array(location, current, skill_path) {
            let name = skill_path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            let matched = rules
                .iter()
                .filter(|rule| skill_rule_matches(rule, name))
                .cloned()
                .collect();
            return Some(Value::Array(matched));
        }
        (!current.is_null()).then(|| current.clone())
    }
    fn skill_switch_restore(
        &self,
        current: &Value,
        previous: Option<&Value>,
        skill_path: &Path,
    ) -> Option<Value> {
        if let Some(rules) = current.as_array() {
            let name = skill_path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            let mut kept: Vec<Value> = rules
                .iter()
                .filter(|rule| !skill_rule_matches(rule, name))
                .cloned()
                .collect();
            if let Some(previous) = previous.and_then(Value::as_array) {
                kept.extend(previous.iter().cloned());
            }
            return Some(Value::Array(kept));
        }
        previous.cloned()
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        self.mcp_location_for_version(scope, home, project, None)
    }
    fn mcp_requires_version(&self) -> bool {
        true
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        version: Option<&str>,
    ) -> Option<McpLocation> {
        let file = self
            .native_files(scope, home, project, true)
            .into_iter()
            .next()?;
        let path: std::path::PathBuf = file.path.into();
        let kind = if file.format == "jsonc" {
            FileKind::Jsonc
        } else {
            FileKind::Json
        };
        let major = version.and_then(|text| {
            text.trim()
                .trim_start_matches('v')
                .split('.')
                .next()?
                .parse::<u32>()
                .ok()
        });
        let child = match major {
            Some(2) => Some("servers"),
            Some(1) => None,
            Some(_) => return None,
            None => {
                let text = crate::native::transaction::read_native(&path).ok()?;
                let parsed = crate::native::format::parse(kind, &text).ok()?;
                let root = parsed.get("mcp")?.as_object()?;
                if root
                    .get("servers")
                    .is_some_and(serde_json::Value::is_object)
                {
                    Some("servers")
                } else if root.keys().any(|key| key != "timeout") {
                    None
                } else {
                    return None;
                }
            }
        };
        Some(McpLocation {
            path,
            kind,
            root: "mcp",
            child,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        let mut map = match definition.transport {
            McpTransport::Stdio => {
                let (command, args) = mcp::stdio_command(&definition.command, &definition.args);
                let mut map = mcp::stdio_doc_with_env(definition, existing, "environment");
                map.remove("args");
                map.insert(
                    "command".into(),
                    json!(std::iter::once(command).chain(args).collect::<Vec<_>>()),
                );
                map.insert("type".into(), json!("local"));
                map
            }
            McpTransport::Http => {
                let mut map = mcp::http_doc(definition, existing, "headers");
                map.insert("type".into(), json!("remote"));
                map
            }
        };
        map.insert("enabled".into(), json!(enabled));
        Ok(Some(Value::Object(map)))
    }
    fn mcp_document_at(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        location: &McpLocation,
    ) -> Result<Option<Value>, String> {
        let mut document = self.mcp_document(definition, enabled, existing)?;
        if location.child == Some("servers") {
            if let Some(map) = document.as_mut().and_then(Value::as_object_mut) {
                map.remove("enabled");
                map.insert("disabled".into(), json!(!enabled));
            }
        }
        Ok(document)
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
            .join("skills"),
            Scope::Project => project?.join(".opencode/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => crate::accounts::selection::config_root("open_code", || {
                config_base(home).join("opencode")
            })
            .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn connection_policy(&self, scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: if scope == Scope::Project {
                crate::native::adapter::api_key_scope_denied(
                    "OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录",
                )
            } else {
                crate::native::adapter::api_key_writable()
            },
            provider_address: crate::native::adapter::address_configurable(),
            projection: "provider_models",
        }
    }
    fn projected_models(
        &self,
        settings: &Value,
        _models: &Value,
        provider: Option<&str>,
    ) -> Option<Vec<ModelRecord>> {
        let Some(provider) = provider.filter(|id| !id.is_empty()) else {
            return Some(Vec::new());
        };
        // Models project from either native form of the provider entry.
        let Some(models) = ["provider", "providers"].iter().find_map(|key| {
            settings
                .get(*key)
                .and_then(|root| root.get(provider))
                .and_then(|entry| entry.get("models"))
                .and_then(Value::as_object)
        }) else {
            return Some(Vec::new());
        };
        Some(
            models
                .iter()
                .map(|(id, fields)| ModelRecord {
                    id: id.clone(),
                    fields: fields.as_object().cloned().unwrap_or_default(),
                })
                .collect(),
        )
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        self.connection_documents_for_version(connection, scope, None)
    }
    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        self.connection_documents_for_existing_for_version(connection, scope, existing, None)
    }
    /// Connection documents in the native form of the selected installation:
    /// v1 `provider.<id>.npm/options` or v2 `providers.<id>.package/settings`
    /// (verified against a native 2.0.29 load).
    fn connection_documents_for_version(
        &self,
        connection: &Connection,
        _scope: Scope,
        form: Option<&str>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let form = if form == Some("v2") {
            configuration::Form::V2
        } else {
            configuration::Form::V1
        };
        let npm = match connection.interface_format.as_str() {
            "openai_completions" => "@ai-sdk/openai-compatible",
            "openai_responses" => "@ai-sdk/openai",
            "anthropic_messages" => "@ai-sdk/anthropic",
            _ => return Err("OpenCode 不支持所选接口格式".into()),
        };
        let package = match form {
            configuration::Form::V1 => npm.to_owned(),
            configuration::Form::V2 => format!("aisdk:{npm}"),
        };
        let provider = connection.provider_id.as_str();
        let model = connection.model.as_str();
        let mut settings = json!({});
        set_json(
            &mut settings,
            &["model"],
            json!(format!("{provider}/{model}")),
        );
        set_json(
            &mut settings,
            &[form.providers_key(), provider, form.package_key()],
            json!(package),
        );
        set_json(
            &mut settings,
            &[form.providers_key(), provider, "name"],
            json!(provider),
        );
        set_json(
            &mut settings,
            &[
                form.providers_key(),
                provider,
                form.provider_settings_key(),
                "baseURL",
            ],
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &[form.providers_key(), provider, "models", model, "name"],
            json!(model),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::OpenCode, connection) {
            set_json(
                &mut settings,
                &[
                    form.providers_key(),
                    provider,
                    form.provider_settings_key(),
                    "apiKey",
                ],
                json!(format!("{{env:{env}}}")),
            );
        }
        Ok(BTreeMap::from([("settings".into(), settings)]))
    }
    fn connection_documents_for_existing_for_version(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
        form: Option<&str>,
    ) -> Result<BTreeMap<String, Value>, String> {
        let target = if form == Some("v2") {
            configuration::Form::V2
        } else {
            configuration::Form::V1
        };
        let mut docs = self.connection_documents_for_version(connection, scope, form)?;
        // Existing models are read from either native form.
        let settings_existing = existing.get("settings");
        let draft = ["provider", "providers"]
            .iter()
            .find_map(|key| {
                settings_existing
                    .and_then(|root| root.get(*key))
                    .and_then(|root| root.get(&connection.provider_id))
                    .and_then(|entry| entry.get("models"))
                    .and_then(Value::as_object)
                    .cloned()
            })
            .unwrap_or_default();
        let Some(models) = docs
            .get_mut("settings")
            .and_then(|root| root.get_mut(target.providers_key()))
            .and_then(|root| root.get_mut(&connection.provider_id))
            .and_then(|entry| entry.get_mut("models"))
            .and_then(Value::as_object_mut)
        else {
            return Ok(docs);
        };
        if let Some(current) = draft.get(&connection.model) {
            models.insert(connection.model.clone(), current.clone());
        }
        for (id, value) in &draft {
            if id != &connection.model {
                models.insert(id.clone(), value.clone());
            }
        }
        for (id, model) in models.iter_mut() {
            if let Some(record) = connection.model_records.iter().find(|record| &record.id == id) {
                // Records keep their source-form spellings; convert them to the
                // target form so one entity keeps a single native shape.
                let converted =
                    configuration::model_in_form(&Value::Object(record.fields.clone()), target);
                if let Some(fields) = converted.as_object() {
                    assign_existing_fields(model, fields);
                }
            }
        }
        Ok(docs)
    }
    fn preserve_native_fields(
        &self,
        role: &str,
        original: &Value,
        fields: &mut BTreeMap<String, Value>,
        profile: &RegisteredProfile,
    ) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let form = profile
            .editing
            .as_ref()
            .map(|state| configuration::form_of(state).unwrap_or(configuration::Form::V1))
            .unwrap_or(configuration::Form::V1);
        let Some(disk_models) = original
            .get(form.providers_key())
            .and_then(|providers| providers.get(&connection.provider_id))
            .and_then(|provider| provider.get("models"))
            .and_then(Value::as_object)
        else {
            return Ok(());
        };
        let draft = draft_models(profile, form, &connection.provider_id)?;
        let provider_token = pointer_token(&connection.provider_id);
        for (model_id, disk_model) in disk_models {
            let Some(disk_object) = disk_model.as_object() else {
                continue;
            };
            let prefix = format!("/provider/{provider_token}/models/{}", pointer_token(model_id));
            let mut model = model_from_managed(fields, &prefix);
            if let Some(target) = model.as_object_mut() {
                merge_missing(target, disk_object);
            }
            let edited = connection
                .model_records
                .iter()
                .find(|record| &record.id == model_id);
            let name_edited = edited.is_some_and(|record| record.fields.contains_key("name"));
            if !draft.contains_key(model_id) && !name_edited {
                let model_map = model.as_object_mut().unwrap();
                match disk_model.get("name") {
                    Some(name) => {
                        model_map.insert("name".into(), name.clone());
                    }
                    None => {
                        model_map.remove("name");
                    }
                }
            }
            if let Some(record) = edited {
                assign_existing_fields(&mut model, &record.fields);
            }
            replace_model_fields(fields, &prefix, &model);
        }
        Ok(())
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        if scope == Scope::Project {
            return Err("OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录".into());
        }
        let form = profile
            .editing
            .as_ref()
            .map(|state| configuration::form_of(state).unwrap_or(configuration::Form::V1))
            .unwrap_or(configuration::Form::V1);
        secrets.put(
            "settings",
            &[
                form.providers_key(),
                &connection.provider_id,
                form.provider_settings_key(),
                "apiKey",
            ],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && ["provider", "providers"].iter().any(|key| {
                root.get(*key)
                    .and_then(Value::as_object)
                    .is_some_and(|providers| {
                        providers.values().any(|item| {
                            item.get("options")
                                .or_else(|| item.get("settings"))
                                .and_then(|options| options.get("apiKey"))
                                .is_some()
                        })
                    })
            })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let mut provider = None;
        let mut model = None;
        if let Some(full) = string_at(settings, &["model"]) {
            if let Some((id, name)) = full.split_once('/') {
                provider = Some(id.into());
                model = Some(name.into());
            }
        }
        if provider.is_none() {
            provider = ["provider", "providers"]
                .iter()
                .find_map(|key| {
                    settings
                        .get(*key)
                        .and_then(Value::as_object)
                        .and_then(|items| items.keys().next().cloned())
                });
        }
        let entry = provider.as_ref().and_then(|id| {
            ["provider", "providers"].iter().find_map(|key| {
                settings
                    .get(*key)
                    .and_then(|value| value.get(id))
            })
        });
        let base = entry
            .and_then(|value| value.get("options").or_else(|| value.get("settings")))
            .and_then(|value| value.get("baseURL"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = entry
            .and_then(|value| value.get("npm").or_else(|| value.get("package")))
            .and_then(Value::as_str)
            .and_then(configuration::interface_from_package);
        let env = entry
            .and_then(|value| value.get("options").or_else(|| value.get("settings")))
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(|value| value.strip_prefix("{env:"))
            .and_then(|value| value.strip_suffix('}'))
            .map(str::to_owned);
        if model.is_none() {
            model = entry
                .and_then(|value| value.get("models"))
                .and_then(Value::as_object)
                .and_then(|items| items.keys().next())
                .cloned();
        }
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env,
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        _: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        let raw = files.get("settings").cloned().unwrap_or_default();
        let settings = crate::native::format::parse(FileKind::Jsonc, &raw)?;
        // Literal keys are discovered in either native form and replaced in the
        // entity's own form so the file keeps its shape.
        for (root_key, settings_key) in [("provider", "options"), ("providers", "settings")] {
            let Some(providers) = settings.get(root_key).and_then(Value::as_object) else {
                continue;
            };
            for (name, provider) in providers {
                let Some(key) = provider
                    .get(settings_key)
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if key
                    .strip_prefix("{env:")
                    .and_then(|tail| tail.strip_suffix('}'))
                    .is_some_and(profile::valid_env_name)
                {
                    continue;
                }
                if found.provider_id.as_deref() != Some(name.as_str()) || found.connection.is_none()
                {
                    return Err(format!("OpenCode 供应商 {name} 含字面 apiKey；请先选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env = self
                    .auth_env_name(connection)
                    .ok_or("无法确定 OpenCode 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = crate::native::format::set_path(
                    FileKind::Jsonc,
                    files
                        .get("settings")
                        .map(String::as_str)
                        .unwrap_or(raw.as_str()),
                    &[
                        root_key.to_owned(),
                        name.clone(),
                        settings_key.to_owned(),
                        "apiKey".into(),
                    ],
                    Some(&json!(format!("{{env:{env}}}"))),
                )?;
                files.insert("settings".into(), replaced);
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        for (root_key, settings_key) in [("provider", "options"), ("providers", "settings")] {
            let Some(providers) = parsed.get(root_key).and_then(Value::as_object) else {
                continue;
            };
            for (name, provider) in providers {
                if let Some(key) = provider
                    .get(settings_key)
                    .and_then(|value| value.get("apiKey"))
                    .and_then(Value::as_str)
                {
                    if !key
                        .strip_prefix("{env:")
                        .and_then(|tail| tail.strip_suffix('}'))
                        .is_some_and(profile::valid_env_name)
                    {
                        return Err(format!("OpenCode 供应商 {name} 的 apiKey 须使用 {{env:NAME}}；请通过安全接入迁移字面密钥"));
                    }
                }
            }
        }
        Ok(())
    }
    fn login_args(&self) -> Option<Vec<String>> {
        Some(vec!["auth".into(), "login".into()])
    }
    fn login_hint(&self) -> &'static str {
        "在终端选择供应商并完成原生登录。"
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--session".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--auto".into());
        }
        Ok(args)
    }
    fn launch_args_for_version(
        &self,
        version: &str,
        session: Option<&str>,
        mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        let mut args = self.launch_args(session, mode)?;
        // OpenCode 2.0.29 starts a managed background service before the TUI.
        // `service.ensure` exits when that port is already taken, including by
        // a leftover server from another install. `--standalone` is the
        // verified flag for a private server that does not use that port.
        if switch_major(Some(version)) == Some(2) {
            args.insert(0, "--standalone".into());
        }
        Ok(args)
    }
    fn history_sources(
        &self,
        home: &std::path::Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse(source)
    }
    fn history_sources_controlled(
        &self,
        home: &std::path::Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources_controlled(home, cancelled)
    }
    fn parse_history_controlled(
        &self,
        source: &crate::history::HistorySource,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse_controlled(source, cancelled)
    }
    fn history_supported(&self) -> bool {
        true
    }
    fn history_association(&self) -> Option<Facet> {
        // Unread fields, including querySource, are not a parent/child link.
        Some(Facet {
            state: "unavailable",
            reason: HISTORY_ASSOCIATION_UNAVAILABLE_REASON,
        })
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        // Both verified lines resume with the same `--session <id>` argument
        // (2.x keeps it on the TUI and `run`, verified on 2.0.29).
        matches!(switch_major(Some(version)), Some(1 | 2))
    }
    fn major_upgrade(&self, source: &str, version: Option<&str>) -> Option<MajorUpgradeAction> {
        // Only a recognized install channel may run the official self-upgrade;
        // unknown sources keep the "no guessed command" policy.
        if !matches!(source, "npm_shim" | "native") {
            return None;
        }
        let parsed = semver::Version::parse(version?.trim().trim_start_matches('v')).ok()?;
        if parsed.major != 1 {
            return None;
        }
        let minimum = major_upgrade_minimum();
        Some(MajorUpgradeAction {
            label: "升级到 OpenCode 2",
            command: (parsed >= minimum).then(|| "opencode upgrade --major".to_owned()),
            guidance: (parsed < minimum).then_some(
                "此安装低于 1.19.0，没有官方 upgrade --major；请按官方迁移指引手动升级到 OpenCode 2，Cliora 不会自动跨大版本。",
            ),
        })
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://opencode.ai/docs/",
            "使用 opencode upgrade 或原安装来源更新。",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::accounts::AccountAdapter;

    #[test]
    fn install_lines_select_packages_and_npm_entries_per_major() {
        assert_eq!(
            OpenCode
                .install_lines()
                .iter()
                .map(|line| (line.major, line.npm_package))
                .collect::<Vec<_>>(),
            vec![(1, "opencode-ai"), (2, "@opencode/cli")]
        );
        assert_eq!(OpenCode.npm_packages(), vec!["opencode-ai", "@opencode/cli"]);
        assert_eq!(install_line(Some("1.19.0")).unwrap().npm_package, "opencode-ai");
        assert_eq!(install_line(Some("v2.0.29")).unwrap().npm_package, "@opencode/cli");
        assert_eq!(install_line(Some("2.0.29+build.1")).unwrap().npm_package, "@opencode/cli");
        assert_eq!(install_line(None), None);
        assert_eq!(install_line(Some("3.0.0")), None);
        assert_eq!(
            OpenCode.npm_entry_for_version(Some("1.19.0")),
            Some("node_modules/opencode-ai/bin/opencode.exe")
        );
        assert_eq!(
            OpenCode.npm_entry_for_version(Some("2.0.29")),
            Some("node_modules/@opencode/cli/bin/opencode.exe")
        );
        assert_eq!(OpenCode.npm_entry_for_version(None), None);
        assert!(OpenCode.recognizes_native_install_path(Path::new("/home/example/.opencode/bin/opencode")));
        assert!(!OpenCode.recognizes_native_install_path(Path::new("/home/example/.local/bin/opencode")));
    }

    #[test]
    fn opencode_v2_launch_uses_a_private_server() {
        let v2 = OpenCode
            .launch_args_for_version("2.0.29", Some("ses_1"), LaunchMode::Yolo)
            .unwrap();
        assert_eq!(v2, vec!["--standalone", "--session", "ses_1", "--auto"]);
        let v1 = OpenCode
            .launch_args_for_version("1.19.0", None, LaunchMode::Normal)
            .unwrap();
        assert!(v1.is_empty());
    }
}
