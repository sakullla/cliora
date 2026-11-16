//! OMP native configuration: default/named Profile and project `.omp` YAML
//! (`config.yml`/`config.yaml`, `models.yml`/`models.yaml`), model roles,
//! providers and secret references.
//!
//! OMP is a Pi fork, but its configuration evidence is independent: YAML files,
//! `modelRoles`, named profiles below `~/.omp/profiles/<name>/agent` and native
//! API keys that are environment variable names. This module therefore owns its
//! own schema instead of reusing Pi's JSON shape.
//!
//! Safety rules:
//! - A document written by Cliora never contains a literal supplier key. It
//!   contains only an environment reference (`${NAME}` or the native bare name
//!   already on disk). The actual value stays in the shared credential store.
//! - Project scope may carry environment references but never a managed secret.
//! - Unknown fields, unedited roles, other providers and the old document are
//!   preserved; the shared YAML transaction owns backup/recovery and CAS.
//! - A damaged file is never used as a blank starting point: parsing fails
//!   before any write.

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::super::configuration::{
    ConfigurationAction, ConfigurationAdapter, ConfigurationDescriptor, ConfigurationField,
    ConfigurationIssue, Documents, EditingState, ManagedConfiguration, PortableFieldKind,
    SuppressionChange, EDITING_VERSION,
};
use crate::adapters::{InspectionFields, NativeCredentialRefs, PendingSecrets};
use crate::credentials::CredentialStore;
use crate::native::adapter::{ConnectionPolicy, NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::{self, FileKind};
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, ModelRecord, RegisteredProfile};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 的 YAML 配置、Profile 隔离与模型角色编辑尚未交付；启用偏好不会读取或写入 ~/.omp 文件";
pub(crate) const AVAILABLE_REASON: &str =
    "可编辑 OMP 自有的 config.yml/config.yaml 与 models.yml/models.yaml；未编辑字段与角色原样保留";

const SETTINGS_ROLE: &str = "settings";
const MODELS_ROLE: &str = "models";
const ROLES: [(&str, &str); 4] = [
    ("default", "默认模型"),
    ("smol", "轻量模型"),
    ("slow", "复杂模型"),
    ("plan", "计划模型"),
];
const MODEL_FIELDS: &[&str] = &[
    "name",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "thinkingLevelMap",
    "cost",
];
/// Protocols OMP 18.20.2 accepts in `providers.<id>.api`. The list comes from
/// the real validation error of an isolated CLI. Only `PRACTICAL` has a Cliora
/// connection projection; the others stay readable and are never rewritten by
/// the form.
const KNOWN_APIS: [&str; 16] = [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-gemini-cli",
    "google-vertex",
    "openrouter-decisions",
    "openai-decisions",
    "google-decisions",
    "workers-ai-systemone",
    "liquid-systemone",
    "nace-systemone",
    "typesafe",
];
/// Protocols this adapter can express. Unknown native spellings stay readable
/// and are preserved; they are simply not offered as a new write target.
const PRACTICAL: [(&str, &str); 3] = [
    ("openai_completions", "openai-completions"),
    ("openai_responses", "openai-responses"),
    ("anthropic_messages", "anthropic-messages"),
];

static CONFIGURATION: OmpConfiguration = OmpConfiguration;

pub(crate) fn port() -> Option<&'static dyn ConfigurationAdapter> {
    Some(&CONFIGURATION)
}

/// Native configuration facet. The configuration task publishes its port; the
/// descriptor only reads this function.
pub(crate) fn facet() -> crate::adapters::Facet {
    match port() {
        Some(_) => crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        None => crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

/// Project-level model override policy. OMP reads only the current project's
/// `.omp` directory and does not walk up to a parent project.
pub(crate) fn project_model_override() -> bool {
    true
}

pub(crate) fn interface_formats() -> &'static [&'static str] {
    &[
        "openai_completions",
        "openai_responses",
        "anthropic_messages",
    ]
}

pub(crate) fn file_kind(role: &str) -> Result<FileKind, String> {
    match role {
        SETTINGS_ROLE | MODELS_ROLE => Ok(FileKind::Yaml),
        _ => Err("OMP 没有此原生文件角色".into()),
    }
}

pub(crate) fn portable_root_fields(role: &str) -> &'static [&'static str] {
    match role {
        SETTINGS_ROLE => &["modelRoles", "retry"],
        MODELS_ROLE => &["providers"],
        _ => &[],
    }
}

pub(crate) fn portable_field_kind(path: &[String]) -> PortableFieldKind {
    if path
        .first()
        .is_some_and(|field| field == "modelRoles" || field == "retry" || field.starts_with("retry."))
    {
        return PortableFieldKind::Parameter;
    }
    match path.last().map(String::as_str) {
        Some("apiKey") => PortableFieldKind::CredentialReference,
        Some(
            "auth" | "api" | "baseUrl" | "name" | "contextWindow" | "maxTokens" | "reasoning"
            | "input" | "thinkingLevelMap" | "cost",
        ) => PortableFieldKind::Parameter,
        _ => PortableFieldKind::Unknown,
    }
}

/// Inputs are explicit so the same rules can be verified without mutating the
/// process environment. `None` means "read the environment" for a real probe.
#[derive(Clone, Debug)]
pub(crate) struct ResolutionInput<'a> {
    pub home: &'a Path,
    pub profile: Option<&'a str>,
    pub config_dir: Option<&'a Path>,
    pub coding_agent_dir: Option<&'a Path>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedRoot {
    /// `default` or `profile`.
    pub kind: &'static str,
    pub root: PathBuf,
}

fn valid_config_relative(path: &Path) -> bool {
    !path.is_absolute()
        && !path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
}

pub(crate) fn resolve_root(input: &ResolutionInput<'_>) -> Result<ResolvedRoot, String> {
    if input
        .coding_agent_dir
        .is_some_and(|path| !path.has_root())
    {
        return Err(
            "PI_CODING_AGENT_DIR 必须是绝对路径；OMP 会按进程工作目录解析，Cliora 无法安全定位。请使用绝对路径，或从目标项目目录启动 OMP。"
                .into(),
        );
    }
    // OMP joins `PI_CONFIG_DIR` under the home directory (`path.join(home,
    // PI_CONFIG_DIR)`); it is not an absolute root. Cliora rejects an absolute
    // or parent-traversing value instead of reproducing OMP's concatenated,
    // invalid path, and never writes outside the home directory.
    let relative = input
        .config_dir
        .filter(|path| !path.as_os_str().to_string_lossy().trim().is_empty())
        .unwrap_or_else(|| Path::new(".omp"));
    if !valid_config_relative(relative) {
        return Err("PI_CONFIG_DIR 必须是 home 下的相对目录".into());
    }
    let config = input.home.join(relative);
    match input.profile {
        Some(name) => match normalize_profile_name(name)? {
            Some(name) => Ok(ResolvedRoot {
                kind: "profile",
                root: config.join("profiles").join(name).join("agent"),
            }),
            None => Ok(default_root(config, input.coding_agent_dir)),
        },
        None => Ok(default_root(config, input.coding_agent_dir)),
    }
}

fn default_root(config: PathBuf, coding_agent_dir: Option<&Path>) -> ResolvedRoot {
    ResolvedRoot {
        kind: "default",
        // PI_CODING_AGENT_DIR relocates only the default profile. A named
        // profile above deliberately ignores it. OMP resolves a relative value
        // against its process cwd; account discovery records that boundary
        // explicitly instead of guessing the desktop app's cwd.
        root: coding_agent_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(|| config.join("agent")),
    }
}

/// OMP 18.20.2 trims profile values and treats empty/whitespace and the literal
/// `default` as the default profile. Names must match
/// `^[a-z0-9][a-z0-9._-]{0,63}$`, must not end in `.` and must not be a Windows
/// reserved device name.
pub(crate) fn normalize_profile_name(name: &str) -> Result<Option<&str>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "default" {
        return Ok(None);
    }
    let valid = trimmed.len() <= 64
        && !trimmed.ends_with('.')
        && trimmed.as_bytes().first().is_some_and(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit()
        })
        && trimmed.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-')
        })
        && !windows_reserved_name(trimmed);
    if !valid {
        return Err(
            "OMP Profile 名称无效；须匹配 [a-z0-9][a-z0-9._-]{0,63} 且不能是 Windows 保留名".into(),
        );
    }
    Ok(Some(trimmed))
}

/// OMP_PROFILE presence wins even when it is empty; only an absent OMP_PROFILE
/// allows the Pi-compatible PI_PROFILE fallback.
pub(crate) fn select_profile<'a>(omp: Option<&'a str>, pi: Option<&'a str>) -> Option<&'a str> {
    omp.or(pi)
}

/// Shared root resolution for configuration, accounts, MCP, Skills and Agents.
/// Callers pass the raw `OMP_PROFILE`/`PI_PROFILE` values so an explicitly
/// present but empty `OMP_PROFILE` resolves to the default profile without
/// falling back to `PI_PROFILE`.
pub(crate) fn resolve_agent_root(
    home: &Path,
    omp_profile: Option<&str>,
    pi_profile: Option<&str>,
    config_dir: Option<&Path>,
    coding_agent_dir: Option<&Path>,
) -> Result<ResolvedRoot, String> {
    resolve_root(&ResolutionInput {
        home,
        profile: select_profile(omp_profile, pi_profile),
        config_dir,
        coding_agent_dir,
    })
}

fn windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM0" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT0" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

fn valid_profile_name(name: &str) -> bool {
    normalize_profile_name(name).is_ok()
}

fn env_value(name: &str) -> Option<String> {
    env::var_os(name)
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
}

fn environment_profile() -> Option<String> {
    // OMP_PROFILE presence wins over the Pi-compatible fallback even when the
    // value is empty/whitespace (which resolves to the default profile).
    match env::var_os("OMP_PROFILE") {
        Some(value) => Some(value.to_string_lossy().into_owned()),
        None => env::var_os("PI_PROFILE").map(|value| value.to_string_lossy().into_owned()),
    }
}

fn environment_root(home: &Path) -> Option<ResolvedRoot> {
    let config = env_value("PI_CONFIG_DIR").map(PathBuf::from);
    let coding_agent = env_value("PI_CODING_AGENT_DIR").map(PathBuf::from);
    let profile = environment_profile();
    resolve_root(&ResolutionInput {
        home,
        profile: profile.as_deref(),
        config_dir: config.as_deref(),
        coding_agent_dir: coding_agent.as_deref(),
    })
    .ok()
}

/// OMP loads `config.yml` before `config.yaml`, and the same for models. A
/// present `.yml` therefore owns the role; an existing `.yaml` is used when it
/// is the only spelling. A missing file keeps the preferred `.yml` name.
fn pick(directory: &Path, stem: &str) -> PathBuf {
    let preferred = directory.join(format!("{stem}.yml"));
    if preferred.is_file() {
        return preferred;
    }
    let fallback = directory.join(format!("{stem}.yaml"));
    if fallback.is_file() {
        fallback
    } else {
        preferred
    }
}

pub(crate) fn native_files(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known: bool,
) -> Vec<NativeFile> {
    let directory = match scope {
        Scope::Global => {
            if environment_profile().is_some_and(|name| !valid_profile_name(&name)) {
                // Never edit another profile's files because OMP_PROFILE was
                // malformed; the workspace shows no target until it is fixed.
                return Vec::new();
            }
            if env_value("PI_CONFIG_DIR")
                .map(PathBuf::from)
                .is_some_and(|path| !valid_config_relative(&path))
            {
                return Vec::new();
            }
            let fallback = environment_root(home)
                .map(|root| root.root)
                .unwrap_or_else(|| home.join(".omp/agent"));
            // An active OAuth/account context keeps configuration inside its
            // own root; without one the environment/default profile applies.
            crate::accounts::selection::config_root(super::ID, || fallback)
        }
        Scope::Project => match project {
            Some(project) => project.join(".omp"),
            None => return Vec::new(),
        },
    };
    let settings_path = if scope == Scope::Project {
        // OMP 18.20.2 project scope reads only `.omp/config.yml`; a project
        // `config.yaml` is ignored, so Cliora must not present it as editable.
        directory.join("config.yml")
    } else {
        pick(&directory, "config")
    };
    let mut files = vec![crate::adapters::file(
        SETTINGS_ROLE,
        settings_path,
        FileKind::Yaml,
        known,
        None,
        false,
    )];
    // OMP 18.20.2 reads custom providers/models only from the global agent
    // directory; a project `.omp/models.yml` is ignored. Publishing it would
    // let Cliora edit a file the CLI never loads, so project scope exposes only
    // config.yml/config.yaml.
    if scope == Scope::Global {
        files.push(crate::adapters::file(
            MODELS_ROLE,
            pick(&directory, "models"),
            FileKind::Yaml,
            known,
            None,
            false,
        ));
    }
    files
}

pub(crate) fn connection_roles() -> &'static [&'static str] {
    &[SETTINGS_ROLE, MODELS_ROLE]
}

pub(crate) fn empty_entry_collections(role: &str) -> &'static [&'static str] {
    if role == MODELS_ROLE {
        &["providers"]
    } else {
        &[]
    }
}

pub(crate) fn connection_policy(scope: Scope) -> ConnectionPolicy {
    ConnectionPolicy {
        api_key: if scope == Scope::Project {
            crate::native::adapter::api_key_scope_denied(
                "OMP 项目层只保存环境变量引用，不写入供应商密钥；请使用全局配置",
            )
        } else {
            crate::native::adapter::api_key_writable()
        },
        provider_address: if scope == Scope::Project {
            crate::native::adapter::address_unsupported(
                "OMP 项目层不读取 models.yml，供应商连接只在全局配置",
            )
        } else {
            crate::native::adapter::address_configurable()
        },
        projection: "provider_models",
    }
}

/// Accepts every native environment spelling OMP documents: a bare variable
/// name, `${NAME}`, `$NAME` and `{env:NAME}`. A bare name is required for
/// reading real OMP files, while Cliora writes `${NAME}` so the shared
/// plaintext-secret gate can identify the reference.
pub(crate) fn omp_env_name(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    for pattern in ["${", "{env:"] {
        if let Some(name) = value.strip_prefix(pattern).and_then(|tail| tail.strip_suffix('}')) {
            return crate::native::profile::valid_env_name(name).then_some(name);
        }
    }
    if let Some(name) = value.strip_prefix('$') {
        return crate::native::profile::valid_env_name(name).then_some(name);
    }
    crate::native::profile::valid_env_name(value).then_some(value)
}

fn env_reference(name: &str) -> String {
    format!("${{{name}}}")
}

fn generated_env(connection: &Connection) -> Option<String> {    if let Some(name) = connection.auth_env_var.as_deref() {
        return crate::native::profile::valid_env_name(name).then(|| name.to_owned());
    }
    connection.secret_ref.as_ref()?;
    let provider = connection
        .provider_id
        .to_ascii_uppercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    Some(format!("CLIORA_OMP_{provider}_API_KEY"))
}

/// Environment name a managed connection key is injected under at launch.
/// The config file stores only this reference, so launch and apply must agree.
pub(crate) fn launch_env_name(connection: &Connection) -> Option<String> {
    generated_env(connection)
}

fn api_name(format: &str) -> Result<&'static str, String> {
    PRACTICAL
        .iter()
        .find(|(internal, _)| *internal == format)
        .map(|(_, native)| *native)
        .ok_or_else(|| "OMP 不支持所选接口格式".into())
}

fn internal_format(api: &str) -> Option<&'static str> {
    PRACTICAL
        .iter()
        .find(|(_, native)| *native == api)
        .map(|(internal, _)| *internal)
}

fn is_known_api(api: &str) -> bool {
    KNOWN_APIS.contains(&api)
}

fn model_reference(provider: &str, id: &str) -> String {
    format!("{provider}/{id}")
}

fn split_reference(reference: &str) -> Option<(&str, &str)> {
    let (provider, id) = reference.split_once('/')?;
    (!provider.is_empty() && !id.is_empty()).then_some((provider, id))
}

fn root(documents: &Documents, role: &str) -> Value {
    documents.get(role).cloned().unwrap_or_else(|| json!({}))
}

fn issue(target: Value, field: &str, message: &str) -> ConfigurationIssue {
    ConfigurationIssue {
        target,
        field: Some(field.into()),
        code: "invalid_native_value".into(),
        message: message.into(),
    }
}

fn model_target(provider: &str, id: &str) -> Value {
    json!({"kind":"model","provider":provider,"id":id})
}

fn role_field(role: &str) -> String {
    format!("modelRoles.{role}")
}

fn settings_model_roles(settings: &Value) -> Map<String, Value> {
    settings
        .get("modelRoles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn role_value(documents: &Documents, role: &str) -> Option<String> {
    root(documents, SETTINGS_ROLE)
        .get("modelRoles")
        .and_then(|roles| roles.get(role))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn selected_provider(documents: &Documents, state: &EditingState) -> Option<String> {
    if let Some(provider) = state
        .selected_provider
        .as_deref()
        .filter(|provider| !provider.is_empty())
    {
        return Some(provider.to_owned());
    }
    if let Some((provider, _)) = role_value(documents, "default")
        .as_deref()
        .and_then(split_reference)
    {
        return Some(provider.to_owned());
    }
    root(documents, MODELS_ROLE)
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.keys().next().cloned())
}

fn provider_entry<'a>(models: &'a Value, provider: &str) -> Option<&'a Value> {
    models.get("providers").and_then(|value| value.get(provider))
}

fn provider_models(models: &Value, provider: &str) -> Vec<Value> {
    provider_entry(models, provider)
        .and_then(|entry| entry.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn first_model_id(models: &Value, provider: &str) -> Option<String> {
    provider_models(models, provider)
        .first()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Pi stores custom models in a native array; YAML round-trips can therefore
/// reorder or reformat it. The adapter edits an id-keyed view and always writes
/// the documented native array, preserving entries it did not edit.
fn models_as_map(mut models: Value) -> Result<Value, String> {
    if let Some(providers) = models.get_mut("providers") {
        let providers = providers.as_object_mut().ok_or("providers 须为对象")?;
        for (provider, entry) in providers {
            let Some(list) = entry.get_mut("models") else {
                continue;
            };
            let list = list.as_array().ok_or("models 须为原生数组")?;
            let mut map = Map::new();
            for model in list {
                let id = model
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| format!("供应商 {provider} 的模型缺少 id"))?;
                if map.insert(id.into(), model.clone()).is_some() {
                    return Err(format!("供应商 {provider} 有重复模型 ID"));
                }
            }
            *entry.get_mut("models").unwrap() = Value::Object(map);
        }
    }
    Ok(models)
}

fn models_from_map(mut models: Value, ordering: &[Value]) -> Value {
    if let Some(providers) = models.get_mut("providers").and_then(Value::as_object_mut) {
        for (provider, entry) in providers {
            if let Some(map) = entry.get_mut("models").and_then(|value| value.as_object()) {
                let mut ids = Vec::new();
                for document in ordering {
                    if let Some(list) = document
                        .get("providers")
                        .and_then(|providers| providers.get(provider))
                        .and_then(|provider| provider.get("models"))
                        .and_then(Value::as_array)
                    {
                        for model in list {
                            if let Some(id) = model.get("id").and_then(Value::as_str) {
                                if !ids.iter().any(|known| known == id) {
                                    ids.push(id.to_owned());
                                }
                            }
                        }
                    }
                }
                for id in map.keys() {
                    if !ids.iter().any(|known| known == id) {
                        ids.push(id.clone());
                    }
                }
                let list = ids
                    .iter()
                    .filter_map(|id| map.get(id).cloned())
                    .collect::<Vec<_>>();
                *entry.get_mut("models").unwrap() = Value::Array(list);
            }
        }
    }
    models
}

fn set_value(node: &mut Value, path: &[String], value: Option<Value>) -> Result<(), String> {
    let mut cursor = node;
    for key in &path[..path.len() - 1] {
        if cursor.get(key).is_none() {
            if value.is_none() {
                return Ok(());
            }
            cursor[key] = json!({});
        }
        cursor = cursor.get_mut(key).ok_or("缺少字段父级")?;
        if !cursor.is_object() {
            return Err("字段父级不是对象；请先修正原文".into());
        }
    }
    let map = cursor.as_object_mut().ok_or("字段目标不是对象")?;
    if let Some(value) = value {
        map.insert(path.last().unwrap().clone(), value);
    } else {
        map.remove(path.last().unwrap());
    }
    Ok(())
}

fn pointer(path: &[String]) -> String {
    format!(
        "/{}",
        path.iter()
            .map(|part| crate::adapters::pointer_token(part))
            .collect::<Vec<_>>()
            .join("/")
    )
}

fn model_path(provider: &str, id: &str, field: Option<&str>) -> Vec<String> {
    let mut path = vec![
        "providers".into(),
        provider.into(),
        "models".into(),
        id.into(),
    ];
    if let Some(field) = field {
        path.push(field.into());
    }
    path
}

fn role_path(role: &str) -> Vec<String> {
    vec!["modelRoles".into(), role.into()]
}

fn literal_api_key(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty() && omp_env_name(text).is_none())
}

fn provider_uses_no_auth(entry: &Value) -> bool {
    entry.get("auth").and_then(Value::as_str) == Some("none")
}

fn has_literal_model_secret(models: &Value) -> bool {
    models
        .get("providers")
        .and_then(Value::as_object)
        .is_some_and(|providers| {
            providers.values().any(|entry| {
                literal_api_key(entry.get("apiKey"))
                    || entry
                        .get("models")
                        .and_then(Value::as_array)
                        .is_some_and(|models| {
                            models.iter().any(|model| literal_api_key(model.get("apiKey")))
                        })
            })
        })
}

pub(crate) fn has_native_secret(role: &str, root: &Value) -> bool {
    role == MODELS_ROLE && has_literal_model_secret(root)
}

pub(crate) fn validate_draft(role: &str, parsed: &Value) -> Result<(), String> {
    if !parsed.is_object() {
        return Err("OMP 配置文件顶层必须是对象".into());
    }
    match role {
        SETTINGS_ROLE => {
            if let Some(roles) = parsed.get("modelRoles") {
                let roles = roles.as_object().ok_or("modelRoles 必须是对象")?;
                if roles.values().any(|value| !value.is_string()) {
                    return Err("modelRoles 的每个角色必须是 provider/model 字符串".into());
                }
                if roles.keys().any(|role| role.trim().is_empty() || role.contains('/')) {
                    return Err("modelRoles 的角色名无效".into());
                }
            }
            if parsed.get("retry").is_some_and(|value| !value.is_object()) {
                return Err("retry 设置必须是对象".into());
            }
        }
        MODELS_ROLE => {
            if let Some(providers) = parsed.get("providers") {
                let providers = providers.as_object().ok_or("providers 必须是对象")?;
                for (provider, entry) in providers {
                    if provider.trim().is_empty() {
                        return Err("供应商 ID 不能为空".into());
                    }
                    let entry = entry.as_object().ok_or("供应商条目必须是对象")?;
                    if literal_api_key(entry.get("apiKey")) {
                        return Err(format!(
                            "供应商 {provider} 的 apiKey 是明文；OMP 配置只接受环境变量引用"
                        ));
                    }
                    if let Some(api) = entry.get("api").and_then(Value::as_str) {
                        if !is_known_api(api) && (api.trim().is_empty() || api.chars().any(char::is_control)) {
                            return Err("供应商接口协议无效".into());
                        }
                    }
                    if let Some(models) = entry.get("models") {
                        let models = models.as_array().ok_or("供应商 models 必须是数组")?;
                        let mut ids = std::collections::BTreeSet::new();
                        for model in models {
                            let model = model.as_object().ok_or("模型条目必须是对象")?;
                            let id = model
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.trim().is_empty())
                                .ok_or("每个模型都需要非空 id")?;
                            if !ids.insert(id.to_owned()) {
                                return Err(format!("供应商 {provider} 有重复模型 ID"));
                            }
                            if literal_api_key(model.get("apiKey")) {
                                return Err("模型 apiKey 是明文；OMP 配置只接受环境变量引用".into());
                            }
                        }
                    }
                }
            }
            if parsed.get("modelRoles").is_some() {
                return Err("modelRoles 属于 config.yml，不能写入 models.yml".into());
            }
        }
        _ => return Err("OMP 没有此原生文件角色".into()),
    }
    reject_omp_plaintext(parsed)
}

/// OMP treats a bare `apiKey` value as an environment variable name. The
/// shared gate only knows `$NAME` spellings, so this adapter accepts both for
/// apiKey while still rejecting every other plaintext credential field.
fn reject_omp_plaintext(value: &Value) -> Result<(), String> {
    fn visit(value: &Value, path: &mut Vec<String>) -> Result<(), String> {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    path.push(key.clone());
                    visit(value, path)?;
                    path.pop();
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, path)?;
                }
            }
            Value::String(text) => {
                let key = path
                    .last()
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                if key == "apikey" {
                    if !text.is_empty() && omp_env_name(text).is_none() {
                        return Err(format!(
                            "原生字段 {} 是明文密钥；请使用环境变量引用",
                            path.join(".")
                        ));
                    }
                    return Ok(());
                }
                let sensitive = matches!(
                    key.as_str(),
                    "api_key"
                        | "anthropic_api_key"
                        | "anthropic_auth_token"
                        | "authorization"
                        | "password"
                        | "secret"
                        | "token"
                        | "experimental_bearer_token"
                );
                if sensitive && crate::native::profile::env_ref_name(text).is_none() {
                    return Err(format!(
                        "原生字段 {} 可能包含明文密钥；请使用环境变量引用",
                        path.join(".")
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, &mut Vec::new())
}

pub(crate) fn validate_role_scope(role: &str, scope: Scope) -> Result<(), String> {
    if scope == Scope::Project && role == MODELS_ROLE {
        return Err("OMP 项目层不读取 models.yml；自定义供应商与模型请写入全局配置".into());
    }
    match role {
        SETTINGS_ROLE | MODELS_ROLE => Ok(()),
        _ => Err("OMP 没有此原生文件角色".into()),
    }
}

pub(crate) fn connection_documents(
    connection: &Connection,
    scope: Scope,
) -> Result<BTreeMap<String, Value>, String> {
    connection_documents_for_existing(connection, scope, &BTreeMap::new())
}

pub(crate) fn connection_documents_for_existing(
    connection: &Connection,
    scope: Scope,
    existing: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    if scope == Scope::Project {
        return Err(
            "OMP 项目层不读取 models.yml，不能在项目里定义供应商连接；请使用全局配置"
                .into(),
        );
    }
    let api = api_name(&connection.interface_format)?;
    let provider = connection.provider_id.as_str();
    let model = connection.model.as_str();

    let mut models = existing
        .get(MODELS_ROLE)
        .cloned()
        .unwrap_or_else(|| json!({}));
    set_value(
        &mut models,
        &["providers".into(), provider.into(), "api".into()],
        Some(json!(api)),
    )?;
    set_value(
        &mut models,
        &["providers".into(), provider.into(), "baseUrl".into()],
        Some(json!(connection.base_url)),
    )?;
    let entry = models
        .get("providers")
        .and_then(|providers| providers.get(provider))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut records = entry
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !records
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(model))
    {
        records.push(json!({"id":model}));
    }
    for record in &connection.model_records {
        if let Some(item) = records
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(record.id.as_str()))
        {
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            object.extend(record.fields.clone());
        }
    }
    set_value(
        &mut models,
        &["providers".into(), provider.into(), "models".into()],
        Some(Value::Array(records)),
    )?;
    match generated_env(connection) {
        Some(name) => {
            set_value(
                &mut models,
                &["providers".into(), provider.into(), "apiKey".into()],
                Some(json!(env_reference(&name))),
            )?;
        }
        None if provider_uses_no_auth(&entry) => {
            set_value(
                &mut models,
                &["providers".into(), provider.into(), "apiKey".into()],
                None,
            )?;
        }
        None => {}
    }

    let mut settings = existing
        .get(SETTINGS_ROLE)
        .cloned()
        .unwrap_or_else(|| json!({}));
    set_value(
        &mut settings,
        &role_path("default"),
        Some(json!(model_reference(provider, model))),
    )?;
    Ok(BTreeMap::from([
        (SETTINGS_ROLE.into(), settings),
        (MODELS_ROLE.into(), models),
    ]))
}

/// The managed key stays in the shared credential store. OMP reads the value
/// from its process environment, so no secret is ever rendered into YAML.
///
/// Cliora's draft and profile keep `${NAME}` so the shared plaintext gate can
/// identify a reference. Real OMP resolves a **bare** variable name only (18.20.2
/// returns `${NAME}` literally), so apply rewrites every reference to the bare
/// name through `NativeSecrets`. The value written here is the variable name,
/// not the credential.
pub(crate) fn write_connection_secret(
    profile: &RegisteredProfile,
    _scope: Scope,
    _credentials: &dyn CredentialStore,
    secrets: &mut NativeSecrets,
) -> Result<(), String> {
    if let Some(connection) = &profile.connection {
        if let Some(name) = generated_env(connection) {
            secrets.put(
                MODELS_ROLE,
                &["providers", connection.provider_id.as_str(), "apiKey"],
                name,
            );
        }
    }
    let Some(text) = profile.files.get(MODELS_ROLE).filter(|text| !text.trim().is_empty()) else {
        return Ok(());
    };
    let parsed = format::parse(FileKind::Yaml, text)?;
    if let Some(providers) = parsed.get("providers").and_then(Value::as_object) {
        for (provider, entry) in providers {
            if literal_api_key(entry.get("apiKey")) {
                return Err(format!(
                    "供应商 {provider} 含明文 apiKey；请先迁移为环境变量引用，原文件未修改"
                ));
            }
            if let Some(name) = entry.get("apiKey").and_then(Value::as_str).and_then(omp_env_name) {
                secrets.put(
                    MODELS_ROLE,
                    &["providers", provider.as_str(), "apiKey"],
                    name.to_owned(),
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn preserve_native_fields(
    role: &str,
    original: &Value,
    fields: &mut BTreeMap<String, Value>,
    profile: &RegisteredProfile,
) -> Result<(), String> {
    if role != MODELS_ROLE {
        return Ok(());
    }
    let Some(connection) = &profile.connection else {
        return Ok(());
    };
    let pointer = format!(
        "/providers/{}/models",
        crate::adapters::pointer_token(&connection.provider_id)
    );
    let Some(next) = fields.get_mut(&pointer).and_then(Value::as_array_mut) else {
        return Ok(());
    };
    if let Some(old) = original.pointer(&pointer).and_then(Value::as_array) {
        for item in old {
            if let Some(found) = next
                .iter_mut()
                .find(|value| value.get("id") == item.get("id"))
            {
                if let (Some(current), Some(changes)) = (item.as_object(), found.as_object()) {
                    let mut merged = current.clone();
                    merged.extend(changes.clone());
                    *found = Value::Object(merged);
                }
            } else {
                next.push(item.clone());
            }
        }
    }
    for record in &connection.model_records {
        if let Some(item) = next
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(record.id.as_str()))
        {
            if let Some(object) = item.as_object_mut() {
                object.extend(record.fields.clone());
            }
        }
    }
    Ok(())
}

pub(crate) fn inspect_values(
    settings: &Value,
    _local_settings: &Value,
    models: &Value,
) -> InspectionFields {
    let roles = settings_model_roles(settings);
    let default = roles
        .get("default")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let (provider, model) = default
        .and_then(split_reference)
        .map(|(provider, model)| (provider.to_owned(), model.to_owned()))
        .or_else(|| {
            let provider = models
                .get("providers")
                .and_then(Value::as_object)
                .and_then(|providers| providers.keys().next().cloned())?;
            let model = first_model_id(models, &provider)?;
            Some((provider, model))
        })
        .map_or((None, None), |(provider, model)| (Some(provider), Some(model)));
    let entry = provider
        .as_ref()
        .and_then(|provider| provider_entry(models, provider));
    InspectionFields {
        provider,
        model,
        base: entry
            .and_then(|entry| entry.get("baseUrl"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        wire: entry
            .and_then(|entry| entry.get("api"))
            .and_then(Value::as_str)
            .and_then(internal_format),
        env: entry
            .and_then(|entry| entry.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(omp_env_name)
            .map(str::to_owned),
        reasoning_effort: None,
    }
}

pub(crate) fn import_literal_secrets(
    files: &mut BTreeMap<String, String>,
    found: &mut NativeInspection,
    pending: &mut PendingSecrets,
    native_refs: &mut NativeCredentialRefs,
) -> Result<(), String> {
    let Some(text) = files.get(MODELS_ROLE).cloned() else {
        return Ok(());
    };
    let mut parsed = format::parse(FileKind::Yaml, &text)?;
    let mut replaced = false;
    let providers: Vec<String> = parsed
        .get("providers")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default();
    for provider in providers {
        if provider_uses_no_auth(
            parsed
                .get("providers")
                .and_then(|providers| providers.get(&provider))
                .unwrap_or(&Value::Null),
        ) {
            continue;
        }
        let pointer = format!(
            "/providers/{}/apiKey",
            crate::adapters::pointer_token(&provider)
        );
        let Some(current) = parsed.pointer(&pointer).and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        if let Some(name) = omp_env_name(&current) {
            // OMP reads the bare name; a named profile stores the canonical
            // ${NAME} reference so the shared plaintext gate accepts it. Apply
            // rewrites it back to the bare native name.
            let canonical = env_reference(name);
            if current != canonical {
                if let Some(slot) = parsed.pointer_mut(&pointer) {
                    *slot = json!(canonical);
                }
                replaced = true;
            }
            continue;
        }
        let Some(secret) = parsed.pointer_mut(&pointer).and_then(|value| {
            let text = value.as_str()?.to_owned();
            (!text.is_empty()).then_some((text, value))
        }) else {
            continue;
        };
        let (secret, slot) = secret;
        if secret.len() > 16_384 {
            return Err("OMP 原生 apiKey 超过系统凭据库限制；原文件未更改".into());
        }
        let name = format!(
            "OMP_{}_API_KEY",
            provider
                .to_ascii_uppercase()
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        );
        *slot = json!(env_reference(&name));
        let id = format!("connection-{}", uuid::Uuid::new_v4());
        native_refs
            .entry(MODELS_ROLE.into())
            .or_default()
            .insert(name.clone(), id.clone());
        pending.push((id.clone(), secret));
        if found
            .connection
            .as_ref()
            .is_some_and(|connection| connection.provider_id == provider)
        {
            let connection = found.connection.as_mut().unwrap();
            connection.secret_ref = Some(id);
            connection.auth_env_var = Some(name);
        }
        replaced = true;
    }
    if replaced {
        files.insert(MODELS_ROLE.into(), format::render(FileKind::Yaml, &parsed)?);
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct OmpConfiguration;

impl ConfigurationAdapter for OmpConfiguration {
    fn credential_paths(&self, connection: &Connection) -> Vec<(&'static str, Vec<String>)> {
        vec![(
            MODELS_ROLE,
            vec![
                "providers".into(),
                connection.provider_id.clone(),
                "apiKey".into(),
            ],
        )]
    }

    fn native_verification_module(&self) -> Option<&'static str> {
        Some("src-tauri/src/adapters/omp/verify.rs")
    }

    fn describe(&self, scope: Scope) -> ConfigurationDescriptor {
        let mut fields = if scope == Scope::Global {
            vec![
                field("name", "显示名称", "string", false, scope),
                field("contextWindow", "上下文上限", "number", false, scope),
                field("maxTokens", "输出上限", "number", false, scope),
                field("reasoning", "支持思考", "boolean", false, scope),
                field("input", "输入类型", "json", true, scope),
                field("thinkingLevelMap", "模型思考档位映射", "json", true, scope),
                field("cost", "费用", "json", true, scope),
                field("retry", "重试设置", "json", true, scope),
            ]
        } else {
            vec![field("retry", "重试设置", "json", true, scope)]
        };
        for (role, label) in ROLES {
            fields.push(field(
                &role_field(role),
                label,
                "string",
                role != "default",
                scope,
            ));
        }
        ConfigurationDescriptor {
            version: EDITING_VERSION,
            operations: if scope == Scope::Project {
                ["set", "reset", "default", "small_default"]
                    .iter()
                    .map(|value| (*value).into())
                    .collect()
            } else {
                [
                    "configure_provider",
                    "select_provider",
                    "create",
                    "copy",
                    "rename",
                    "delete",
                    "default",
                    "small_default",
                    "set",
                    "reset",
                ]
                .iter()
                .map(|value| (*value).into())
                .collect()
            },
            fields,
        }
    }

    fn field_locations(&self, field: &str, documents: &Documents) -> Vec<(String, Vec<String>)> {
        match field {
            "retry" => vec![(SETTINGS_ROLE.into(), vec!["retry".into()])],
            value if value.starts_with("modelRoles.") => {
                let role = value.trim_start_matches("modelRoles.");
                vec![(SETTINGS_ROLE.into(), role_path(role))]
            }
            value if MODEL_FIELDS.contains(&value) => selected_provider(documents, &Default::default())
                .map(|provider| {
                    let reference = role_value(documents, "default");
                    let id = reference
                        .as_deref()
                        .and_then(split_reference)
                        .filter(|(selected, _)| *selected == provider)
                        .map(|(_, id)| id.to_owned())
                        .or_else(|| first_model_id(&root(documents, MODELS_ROLE), &provider));
                    match id {
                        Some(id) => vec![(MODELS_ROLE.into(), model_path(&provider, &id, Some(value)))],
                        None => Vec::new(),
                    }
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    fn read(&self, documents: &Documents, state: &EditingState) -> Result<Value, String> {
        let settings = root(documents, SETTINGS_ROLE);
        let models = root(documents, MODELS_ROLE);
        let provider = selected_provider(documents, state);
        let role_map = settings_model_roles(&settings);
        let mut role_names: Vec<String> = role_map.keys().cloned().collect();
        for (role, _) in ROLES {
            if !role_names.iter().any(|known| known == role) {
                role_names.push(role.to_owned());
            }
        }
        let list = provider
            .as_deref()
            .map(|provider| {
                provider_models(&models, provider)
                    .into_iter()
                    .filter_map(|model| {
                        Some(json!({
                            "id": model.get("id")?.as_str()?,
                            "kind": "model",
                            "fields": model,
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default_reference = role_map
            .get("default")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let default_model = default_reference
            .as_deref()
            .and_then(split_reference)
            .filter(|(selected, _)| Some(*selected) == provider.as_deref())
            .map(|(_, id)| id.to_owned());
        let small_model = role_value(documents, "smol")
            .as_deref()
            .and_then(split_reference)
            .filter(|(selected, _)| Some(*selected) == provider.as_deref())
            .map(|(_, id)| id.to_owned());
        let entry = provider
            .as_deref()
            .and_then(|provider| provider_entry(&models, provider));
        let retry = settings.get("retry").cloned().unwrap_or(Value::Null);
        Ok(json!({
            "providerId": provider,
            "providers": models.get("providers").and_then(Value::as_object).map(|providers| providers.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "models": list,
            "roles": role_map,
            "roleNames": role_names,
            "defaultModel": default_model,
            "smallModel": small_model,
            "settings": {
                "retry": retry,
                "modelRoles.default": settings.get("modelRoles").and_then(|roles| roles.get("default")),
                "modelRoles.smol": settings.get("modelRoles").and_then(|roles| roles.get("smol")),
                "modelRoles.slow": settings.get("modelRoles").and_then(|roles| roles.get("slow")),
                "modelRoles.plan": settings.get("modelRoles").and_then(|roles| roles.get("plan")),
            },
            "connection": {
                "baseUrl": entry.and_then(|entry| entry.get("baseUrl")),
                "protocol": entry.and_then(|entry| entry.get("api")),
            },
            "capabilityReason": "OMP 模型角色引用 provider/model；未编辑的角色与其他供应商保持原生值。API Key 只保存环境变量引用。",
        }))
    }

    fn edit(
        &self,
        documents: &mut Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let effective = documents.clone();
        self.edit_inherited(documents, &effective, state, action)
    }

    fn edit_inherited(
        &self,
        documents: &mut Documents,
        effective: &Documents,
        state: &mut EditingState,
        action: &ConfigurationAction,
    ) -> Result<(), String> {
        let kind = action
            .target
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("缺少目标类型")?;
        let provider = action
            .target
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let id = action
            .target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if kind == "settings" || kind == "role" {
            if state.selected_provider.is_none() {
                state.selected_provider = selected_provider(effective, state);
            }
            let field = action.field.as_deref().ok_or("缺少设置字段")?;
            if !matches!(action.operation.as_str(), "set" | "reset") {
                return Err("未声明此原生设置或动作".into());
            }
            let root = documents
                .entry(SETTINGS_ROLE.into())
                .or_insert_with(|| json!({}));
            if field == "retry" {
                set_value(
                    root,
                    &["retry".into()],
                    if action.operation == "reset" {
                        None
                    } else {
                        let value = action
                            .value
                            .clone()
                            .ok_or("重试设置必须是对象")?;
                        value.as_object().ok_or("重试设置必须是对象")?;
                        Some(value)
                    },
                )?;
                return Ok(());
            }
            let role = field
                .strip_prefix("modelRoles.")
                .or_else(|| (kind == "role").then_some(id.as_str()))
                .ok_or("未声明此模型角色")?;
            if role.trim().is_empty() || role.contains('/') {
                return Err("模型角色名无效".into());
            }
            let value = if action.operation == "reset" {
                None
            } else {
                let reference = action
                    .value
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("请填写 provider/model 引用")?;
                let (provider, id) = split_reference(reference)
                    .ok_or("模型角色必须使用 provider/model 形式")?;
                if provider_trim(provider).is_empty() || id.trim().is_empty() {
                    return Err("模型角色引用无效".into());
                }
                Some(json!(reference))
            };
            set_value(root, &role_path(role), value)?;
            let empty = root
                .get("modelRoles")
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty);
            if empty {
                if let Some(object) = root.as_object_mut() {
                    object.remove("modelRoles");
                }
            }
            return Ok(());
        }
        if kind == "provider" {
            if action.operation == "select_provider" {
                if provider.is_empty()
                    || provider_entry(&root(effective, MODELS_ROLE), &provider).is_none()
                {
                    return Err("供应商不存在".into());
                }
                state.selected_provider = Some(provider);
                return Ok(());
            }
            if action.operation == "configure_provider" {
                let value = action
                    .value
                    .as_ref()
                    .and_then(Value::as_object)
                    .ok_or("缺少连接字段")?;
                let base = value
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .filter(|base| !base.is_empty())
                    .ok_or("连接地址必填")?;
                let api = api_name(
                    value
                        .get("interfaceFormat")
                        .and_then(Value::as_str)
                        .ok_or("请选择接口格式")?,
                )?;
                let models = documents
                    .entry(MODELS_ROLE.into())
                    .or_insert_with(|| json!({}));
                set_value(
                    models,
                    &["providers".into(), provider.clone(), "api".into()],
                    Some(json!(api)),
                )?;
                set_value(
                    models,
                    &["providers".into(), provider.clone(), "baseUrl".into()],
                    Some(json!(base)),
                )?;
                state.selected_provider = Some(provider);
                return Ok(());
            }
        }
        if kind != "model" {
            return Err("未声明此编辑目标".into());
        }
        if provider.trim().is_empty() || id.trim().is_empty() {
            return Err("供应商或模型 ID 无效".into());
        }
        let models = root(effective, MODELS_ROLE);
        let mut view = models_as_map(models.clone())?;
        let existing = view.pointer(&pointer(&model_path(&provider, &id, None)));
        match action.operation.as_str() {
            "create" => {
                if existing.is_some() {
                    return Err("该模型 ID 已存在于供应商".into());
                }
                let mut model = action.value.clone().unwrap_or_else(|| json!({}));
                let fields = model.as_object_mut().ok_or("模型字段必须是对象")?;
                if fields
                    .keys()
                    .any(|field| !MODEL_FIELDS.contains(&field.as_str()))
                {
                    return Err("新增模型含未声明字段；扩展字段请使用原生文本".into());
                }
                fields.insert("id".into(), json!(id));
                set_value(
                    &mut view,
                    &model_path(&provider, &id, None),
                    Some(model),
                )?;
                retire_entity(state, &provider, &id);
            }
            "copy" | "rename" => {
                let next = action
                    .value
                    .as_ref()
                    .and_then(Value::as_str)
                    .filter(|id| {
                        !id.trim().is_empty()
                            && id.len() <= 200
                            && !id.chars().any(char::is_control)
                    })
                    .ok_or("新模型 ID 无效")?;
                if view
                    .pointer(&pointer(&model_path(&provider, next, None)))
                    .is_some()
                {
                    return Err("新模型 ID 已存在".into());
                }
                let mut model = existing.ok_or("模型不存在")?.clone();
                model["id"] = json!(next);
                set_value(
                    &mut view,
                    &model_path(&provider, next, None),
                    Some(model),
                )?;
                retire_entity(state, &provider, next);
                if action.operation == "rename" {
                    set_value(&mut view, &model_path(&provider, &id, None), None)?;
                    update_role(documents, &provider, &id, next)?;
                }
            }
            "delete" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                if role_is(effective, "default", &provider, &id)
                    || referenced_by_any_role(effective, &provider, &id)
                {
                    return Err("此模型仍被模型角色引用，请先选择替代模型再删除".into());
                }
                set_value(&mut view, &model_path(&provider, &id, None), None)?;
            }
            "default" | "small_default" => {
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                let role = if action.operation == "default" {
                    "default"
                } else {
                    "smol"
                };
                let settings = documents
                    .entry(SETTINGS_ROLE.into())
                    .or_insert_with(|| json!({}));
                set_value(
                    settings,
                    &role_path(role),
                    Some(json!(model_reference(&provider, &id))),
                )?;
            }
            "set" | "reset" => {
                let field = action.field.as_deref().ok_or("缺少模型字段")?;
                if !MODEL_FIELDS.contains(&field) {
                    return Err("未声明此模型字段".into());
                }
                if existing.is_none() {
                    return Err("模型不存在".into());
                }
                set_value(
                    &mut view,
                    &model_path(&provider, &id, Some(field)),
                    if action.operation == "reset" {
                        None
                    } else {
                        action.value.clone()
                    },
                )?;
            }
            _ => return Err("未声明此模型动作".into()),
        }
        let native = root(documents, MODELS_ROLE);
        documents.insert(
            MODELS_ROLE.into(),
            models_from_map(view, &[native]),
        );
        state.selected_provider = Some(provider);
        Ok(())
    }

    fn validate(
        &self,
        documents: &Documents,
        state: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let mut issues = vec![];
        let settings = root(documents, SETTINGS_ROLE);
        let models = root(documents, MODELS_ROLE);
        if let Some(roles) = settings.get("modelRoles") {
            match roles.as_object() {
                Some(roles) => {
                    for (role, value) in roles {
                        let Some(reference) = value.as_str() else {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                &role_field(role),
                                "模型角色必须是 provider/model 字符串",
                            ));
                            continue;
                        };
                        let Some((provider, id)) = split_reference(reference) else {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                &role_field(role),
                                "模型角色必须使用 provider/model 形式",
                            ));
                            continue;
                        };
                        // A project role may reference a provider defined in the
                        // global models.yml; only the global layer can prove it.
                        if scope == Scope::Project {
                            continue;
                        }
                        let Some(entry) = provider_entry(&models, provider) else {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                &role_field(role),
                                "模型角色引用的供应商不存在",
                            ));
                            continue;
                        };
                        if !entry
                            .get("models")
                            .and_then(Value::as_array)
                            .is_some_and(|list| {
                                list.iter()
                                    .any(|model| model.get("id").and_then(Value::as_str) == Some(id))
                            })
                        {
                            issues.push(issue(
                                json!({"kind":"settings"}),
                                &role_field(role),
                                "模型角色引用的模型不存在",
                            ));
                        }
                    }
                }
                None => issues.push(issue(
                    json!({"kind":"settings"}),
                    "modelRoles",
                    "modelRoles 必须是对象",
                )),
            }
        }
        if settings.get("retry").is_some_and(|value| !value.is_object()) {
            issues.push(issue(
                json!({"kind":"settings"}),
                "retry",
                "重试设置必须是对象",
            ));
        }
        if scope == Scope::Project
            && models.as_object().is_some_and(|object| !object.is_empty())
        {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "OMP 项目层不读取 models.yml；自定义供应商与模型请写入全局配置",
            ));
        }
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            let managed = self.connection(documents, state).ok().flatten()
                .map(|connection| connection.provider_id);
            for (provider, entry) in providers {
                let selected = selected_provider(documents, state);
                if selected.as_deref().is_some_and(|selected| selected != provider)
                    && managed.as_deref() != Some(provider.as_str())
                {
                    continue;
                }
                let Some(entry) = entry.as_object() else {
                    issues.push(issue(
                        json!({"kind":"provider","provider":provider}),
                        "provider",
                        "供应商条目必须是对象",
                    ));
                    continue;
                };
                if let Some(api) = entry.get("api").and_then(Value::as_str) {
                    if !is_known_api(api) {
                        issues.push(issue(
                            json!({"kind":"provider","provider":provider}),
                            "api",
                            "此接口协议尚未核对；原文会被保留，但不会作为新的写入目标",
                        ));
                    }
                }
                if literal_api_key(entry.get("apiKey")) {
                    issues.push(issue(
                        json!({"kind":"provider","provider":provider}),
                        "apiKey",
                        "OMP 配置只保存环境变量引用，不能包含明文密钥",
                    ));
                }
                let Some(list) = entry.get("models").and_then(Value::as_array) else {
                    continue;
                };
                for model in list {
                    let Some(id) = model.get("id").and_then(Value::as_str) else {
                        issues.push(issue(
                            model_target(provider, ""),
                            "model",
                            "模型缺少 id",
                        ));
                        continue;
                    };
                    if !model.is_object() {
                        issues.push(issue(
                            model_target(provider, id),
                            "model",
                            "模型字段须为对象",
                        ));
                        continue;
                    }
                    for field in ["contextWindow", "maxTokens"] {
                        if model.get(field).is_some_and(|value| {
                            !value
                                .as_f64()
                                .is_some_and(|value| value.is_finite() && value > 0.0)
                        }) {
                            issues.push(issue(model_target(provider, id), field, "上限须为正数"));
                        }
                    }
                    if model
                        .get("reasoning")
                        .is_some_and(|value| !value.is_boolean())
                    {
                        issues.push(issue(
                            model_target(provider, id),
                            "reasoning",
                            "思考声明须为布尔值",
                        ));
                    }
                    if model.get("input").is_some_and(|value| {
                        !value.as_array().is_some_and(|items| {
                            items
                                .iter()
                                .all(|value| matches!(value.as_str(), Some("text" | "image")))
                        })
                    }) {
                        issues.push(issue(
                            model_target(provider, id),
                            "input",
                            "OMP 输入类型只支持 text/image",
                        ));
                    }
                    if model
                        .get("thinkingLevelMap")
                        .is_some_and(|value| !value.is_object())
                    {
                        issues.push(issue(
                            model_target(provider, id),
                            "thinkingLevelMap",
                            "思考映射须为对象",
                        ));
                    }
                    if model.get("cost").is_some_and(|value| !value.is_object()) {
                        issues.push(issue(
                            model_target(provider, id),
                            "cost",
                            "费用须为对象",
                        ));
                    }
                }
            }
        }
        if scope == Scope::Project && has_literal_model_secret(&models) {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "OMP 项目层不能保存明文供应商密钥",
            ));
        }
        for action in &state.intents {
            if matches!(action.operation.as_str(), "delete" | "rename") {
                if let (Some(provider), Some(id)) = (
                    action.target.get("provider").and_then(Value::as_str),
                    action.target.get("id").and_then(Value::as_str),
                ) {
                    if role_is(&settings_documents(documents), "default", provider, id)
                        || role_is(&settings_documents(documents), "smol", provider, id)
                    {
                        issues.push(issue(
                            json!({"kind":"settings"}),
                            "modelRoles.default",
                            "已删除的模型仍被模型角色引用，请选择替代模型",
                        ));
                    }
                }
            }
        }
        issues
    }

    fn validate_changes(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        _state: &EditingState,
        scope: Scope,
    ) -> Vec<ConfigurationIssue> {
        let mut issues = vec![];
        let empty = BTreeMap::new();
        let previous = previous.unwrap_or(&empty);
        let previous_models = root(previous, MODELS_ROLE);
        let next_models = root(next, MODELS_ROLE);
        if let Some(providers) = next_models.get("providers").and_then(Value::as_object) {
            for (provider, entry) in providers {
                let api = entry.get("api").and_then(Value::as_str);
                if let Some(api) = api.filter(|api| !is_known_api(api)) {
                    let existed = previous_models
                        .get("providers")
                        .and_then(|providers| providers.get(provider))
                        .and_then(|entry| entry.get("api"))
                        .and_then(Value::as_str)
                        == Some(api);
                    if !existed {
                        issues.push(issue(
                            json!({"kind":"provider","provider":provider}),
                            "api",
                            "新增的接口协议尚未核对；请保留原有协议或使用原生文本",
                        ));
                    }
                }
            }
        }
        if scope == Scope::Project
            && next_models.as_object().is_some_and(|object| !object.is_empty())
        {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "OMP 项目层不读取 models.yml；自定义供应商与模型请写入全局配置",
            ));
        }
        if scope == Scope::Project && has_literal_model_secret(&next_models) {
            issues.push(issue(
                json!({"kind":"settings"}),
                "scope",
                "OMP 项目层不能保存明文供应商密钥",
            ));
        }
        issues
    }

    fn connection(
        &self,
        documents: &Documents,
        _state: &EditingState,
    ) -> Result<Option<Connection>, String> {
        let settings = root(documents, SETTINGS_ROLE);
        let models = root(documents, MODELS_ROLE);
        let reference = settings_model_roles(&settings)
            .get("default")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (provider, id) = match reference.as_deref().and_then(split_reference) {
            Some((provider, id)) => (provider.to_owned(), id.to_owned()),
            None => {
                let Some(provider) = models
                    .get("providers")
                    .and_then(Value::as_object)
                    .and_then(|providers| providers.keys().next().cloned())
                else {
                    return Ok(None);
                };
                let Some(id) = first_model_id(&models, &provider) else {
                    return Ok(None);
                };
                (provider, id)
            }
        };
        let entry = provider_entry(&models, &provider).cloned().unwrap_or_else(|| json!({}));
        let model = provider_models(&models, &provider)
            .into_iter()
            .find(|model| model.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .unwrap_or_else(|| json!({}));
        let Some(base) = model
            .get("baseUrl")
            .or_else(|| entry.get("baseUrl"))
            .and_then(Value::as_str)
        else {
            return Ok(None);
        };
        let Some(api) = model
            .get("api")
            .or_else(|| entry.get("api"))
            .and_then(Value::as_str)
            .and_then(internal_format)
        else {
            return Ok(None);
        };
        let records = provider_models(&models, &provider)
            .into_iter()
            .filter_map(|model| {
                let mut fields = model.as_object()?.clone();
                let id = fields.remove("id")?.as_str()?.to_owned();
                Some(ModelRecord { id, fields })
            })
            .collect();
        Ok(Some(Connection {
            provider_id: provider,
            model: id,
            base_url: base.into(),
            interface_format: api.into(),
            secret_ref: None,
            auth_env_var: entry
                .get("apiKey")
                .and_then(Value::as_str)
                .and_then(omp_env_name)
                .map(str::to_owned),
            model_records: records,
        }))
    }

    fn managed_documents(
        &self,
        documents: Documents,
        profile: &RegisteredProfile,
        _scope: Scope,
    ) -> Result<Documents, String> {
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let selected = self
            .connection(&documents, state)?
            .map(|connection| connection.provider_id)
            .or_else(|| selected_provider(&documents, state));
        let settings = root(&documents, SETTINGS_ROLE);
        let mut managed_settings = Map::new();
        if let Some(provider) = selected.as_deref() {
            let roles = settings_model_roles(&settings);
            let mut managed_roles = Map::new();
            for (role, value) in roles {
                if value
                    .as_str()
                    .and_then(split_reference)
                    .is_some_and(|(selected, _)| selected == provider)
                {
                    managed_roles.insert(role, value);
                }
            }
            if !managed_roles.is_empty() {
                managed_settings.insert("modelRoles".into(), Value::Object(managed_roles));
            }
        }
        if let Some(retry) = settings.get("retry") {
            managed_settings.insert("retry".into(), retry.clone());
        }
        let mut managed = BTreeMap::from([(
            SETTINGS_ROLE.into(),
            Value::Object(managed_settings),
        )]);
        if let Some(provider) = selected {
            if let Some(mut entry) = root(&documents, MODELS_ROLE)
                .get("providers")
                .and_then(|providers| providers.get(&provider))
                .cloned()
            {
                if let Some(fields) = entry.as_object_mut() {
                    for key in ["headers", "oauth"] {
                        fields.remove(key);
                    }
                    if fields.get("apiKey").is_some_and(|value| {
                        !self.portable_reference_valid(&["apiKey".into()], value)
                    }) {
                        fields.remove("apiKey");
                    }
                }
                let mut providers = Map::new();
                providers.insert(provider, entry);
                managed.insert(
                    MODELS_ROLE.into(),
                    json!({"providers": Value::Object(providers)}),
                );
            }
        }
        Ok(managed)
    }

    fn unmanaged_paths(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<Vec<String>, String> {
        if role != MODELS_ROLE {
            return Ok(vec![]);
        }
        let selected = desired
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|providers| providers.keys().next());
        let mut paths = vec![];
        if let Some(providers) = current.get("providers").and_then(Value::as_object) {
            for provider in providers.keys() {
                if Some(provider) != selected {
                    paths.push(format!(
                        "/providers/{}",
                        crate::adapters::pointer_token(provider)
                    ));
                } else if matches!(
                    profile.authentication,
                    crate::native::profile::ProfileAuthentication::Native
                ) && profile
                    .connection
                    .as_ref()
                    .is_none_or(|connection| connection.secret_ref.is_none())
                    && desired["providers"][provider].get("apiKey").is_none()
                {
                    paths.push(format!(
                        "/providers/{}/apiKey",
                        crate::adapters::pointer_token(provider)
                    ));
                }
            }
        }
        Ok(paths)
    }

    fn empty_deleted_entities(
        &self,
        _role: &str,
        _profile: &RegisteredProfile,
    ) -> Result<Vec<Vec<String>>, String> {
        Ok(vec![])
    }

    fn managed_fields(
        &self,
        role: &str,
        current: &Value,
        desired: &Value,
        profile: &RegisteredProfile,
    ) -> Result<ManagedConfiguration, String> {
        let state = profile.editing.as_ref().ok_or("缺少编辑版本")?;
        let mut candidate = desired.clone();
        let mut reset_paths = vec![];
        let mut deletes = vec![];
        for action in &state.intents {
            let kind = action
                .target
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("");
            if action.operation == "reset"
                && (kind == "settings" || kind == "role")
                && role == SETTINGS_ROLE
            {
                if let Some(field) = action.field.as_deref() {
                    if field == "retry" {
                        reset_paths.push("/retry".into());
                    } else if let Some(role) = field.strip_prefix("modelRoles.") {
                        reset_paths.push(format!("/modelRoles/{role}"));
                    } else {
                        reset_paths.push(format!(
                            "/{}",
                            crate::adapters::pointer_token(field)
                        ));
                    }
                }
            }
            if role == MODELS_ROLE
                && kind == "model"
                && matches!(action.operation.as_str(), "delete" | "rename")
            {
                if let (Some(provider), Some(id)) = (
                    action.target.get("provider").and_then(Value::as_str),
                    action.target.get("id").and_then(Value::as_str),
                ) {
                    if desired
                        .pointer(&pointer(&model_path(provider, id, None)))
                        .is_none()
                    {
                        deletes.push(model_path(provider, id, None));
                    }
                }
            }
        }
        if role == MODELS_ROLE {
            if let Some(providers) = candidate
                .get_mut("providers")
                .and_then(Value::as_object_mut)
            {
                for (provider, entry) in providers {
                    if let Some(target_models) = entry.get_mut("models").and_then(Value::as_array_mut) {
                        let original = current
                            .get("providers")
                            .and_then(|providers| providers.get(provider))
                            .and_then(|provider| provider.get("models"))
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let removed = state
                            .intents
                            .iter()
                            .filter_map(|action| {
                                let kind = action.target.get("kind").and_then(Value::as_str)?;
                                let p = action.target.get("provider").and_then(Value::as_str)?;
                                let id = action.target.get("id").and_then(Value::as_str)?;
                                (kind == "model"
                                    && p == provider
                                    && matches!(action.operation.as_str(), "delete" | "rename")
                                    && !target_models.iter().any(|model| {
                                        model.get("id").and_then(Value::as_str) == Some(id)
                                    }))
                                .then(|| id.to_owned())
                            })
                            .collect::<Vec<_>>();
                        let mut next = vec![];
                        for model in original {
                            if literal_api_key(model.get("apiKey")) {
                                return Err("原生模型数组含未受管理的字面凭据；请先改为环境引用，文件未修改".into());
                            }
                            let Some(id) = model.get("id").and_then(Value::as_str) else {
                                return Err("原生模型缺少 ID，不能安全合并".into());
                            };
                            if removed.iter().any(|removed| removed == id) {
                                continue;
                            }
                            if let Some(own) = target_models
                                .iter()
                                .find(|own| own.get("id").and_then(Value::as_str) == Some(id))
                            {
                                let mut merged =
                                    crate::native::format::resolve(&model, own, &[])?.0;
                                for action in &state.intents {
                                    if let (Some(field), Some(kind), Some(p), Some(model_id)) = (
                                        action.field.as_deref(),
                                        action.target.get("kind").and_then(Value::as_str),
                                        action.target.get("provider").and_then(Value::as_str),
                                        action.target.get("id").and_then(Value::as_str),
                                    ) {
                                        if kind == "model"
                                            && p == provider
                                            && model_id == id
                                            && action.operation == "reset"
                                            && own.get(field).is_none()
                                        {
                                            merged.as_object_mut().unwrap().remove(field);
                                        }
                                    }
                                }
                                next.push(merged);
                            } else {
                                next.push(model);
                            }
                        }
                        for model in target_models.iter() {
                            if !next
                                .iter()
                                .any(|existing| existing.get("id") == model.get("id"))
                            {
                                next.push(model.clone());
                            }
                        }
                        *target_models = next;
                    }
                }
            }
        }
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(&candidate, &mut vec![], &mut fields);
        let mut managed = ManagedConfiguration {
            fields: fields
                .into_iter()
                .map(|(path, value)| (path, Some(value)))
                .collect(),
            released: reset_paths,
        };
        for path in deletes {
            if let Some(model) = current.pointer(&pointer(&path)) {
                let mut old = BTreeMap::new();
                crate::native::apply::flatten(model, &mut path.clone(), &mut old);
                for pointer in old.keys() {
                    managed.fields.insert(pointer.clone(), None);
                }
            }
        }
        Ok(managed)
    }

    fn resolve_file(
        &self,
        role: &str,
        base: &Value,
        own: &Value,
        suppressed: &[String],
    ) -> Result<(Value, BTreeMap<String, String>), String> {
        if role != MODELS_ROLE {
            return crate::native::format::resolve(base, own, suppressed);
        }
        let (merged, sources) = crate::native::format::resolve(
            &models_as_map(base.clone())?,
            &models_as_map(own.clone())?,
            suppressed,
        )?;
        let native = models_from_map(merged, &[base.clone(), own.clone()]);
        let mut native_sources = BTreeMap::new();
        for (path, label) in sources {
            let parts = path
                .split('/')
                .skip(1)
                .map(|part| part.replace("~1", "/").replace("~0", "~"))
                .collect::<Vec<_>>();
            if parts.len() >= 4 && parts[0] == "providers" && parts[2] == "models" {
                if let Some(index) = native
                    .get("providers")
                    .and_then(|providers| providers.get(&parts[1]))
                    .and_then(|provider| provider.get("models"))
                    .and_then(Value::as_array)
                    .and_then(|models| {
                        models.iter().position(|model| {
                            model.get("id").and_then(Value::as_str) == Some(parts[3].as_str())
                        })
                    })
                {
                    let mut actual = parts.clone();
                    actual[3] = index.to_string();
                    native_sources.insert(pointer(&actual), label);
                }
            } else {
                native_sources.insert(path, label);
            }
        }
        Ok((native, native_sources))
    }

    fn cleanup_removed_parents(&self) -> bool {
        true
    }

    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        portable_field_kind(path)
    }

    fn portable_reference_valid(&self, path: &[String], value: &Value) -> bool {
        path.last().is_some_and(|field| field == "apiKey")
            && value.as_str().and_then(omp_env_name).is_some()
    }

    fn suppression_changes(
        &self,
        action: &ConfigurationAction,
        _state: &EditingState,
    ) -> Result<Vec<SuppressionChange>, String> {
        let kind = action
            .target
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("缺少目标类型")?;
        if kind == "settings" || kind == "role" {
            let field = action.field.as_deref().unwrap_or("");
            if field == "retry" {
                // OMP's retry object is a native setting, not a common
                // parameter; suppress the whole native object.
                let path = "/retry".to_owned();
                return Ok(match action.operation.as_str() {
                    "set" => vec![SuppressionChange {
                        role: SETTINGS_ROLE.into(),
                        path,
                        suppressed: false,
                    }],
                    "reset" | "delete" => vec![SuppressionChange {
                        role: SETTINGS_ROLE.into(),
                        path,
                        suppressed: true,
                    }],
                    _ => vec![],
                });
            }
            let path = pointer(&role_path(
                field
                    .strip_prefix("modelRoles.")
                    .unwrap_or(field),
            ));
            return Ok(match action.operation.as_str() {
                "set" => vec![SuppressionChange {
                    role: SETTINGS_ROLE.into(),
                    path,
                    suppressed: false,
                }],
                "reset" | "delete" => vec![SuppressionChange {
                    role: SETTINGS_ROLE.into(),
                    path,
                    suppressed: true,
                }],
                _ => vec![],
            });
        }
        if kind != "model" {
            return Ok(vec![]);
        }
        let provider = action
            .target
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("");
        let id = action
            .target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = pointer(&model_path(provider, id, None));
        let mut changes = match action.operation.as_str() {
            "delete" | "rename" => vec![SuppressionChange {
                role: MODELS_ROLE.into(),
                path,
                suppressed: true,
            }],
            "create" | "reset" => vec![SuppressionChange {
                role: MODELS_ROLE.into(),
                path,
                suppressed: false,
            }],
            _ => vec![],
        };
        if matches!(action.operation.as_str(), "copy" | "rename") {
            if let Some(next) = action.value.as_ref().and_then(Value::as_str) {
                changes.push(SuppressionChange {
                    role: MODELS_ROLE.into(),
                    path: pointer(&model_path(provider, next, None)),
                    suppressed: false,
                });
            }
        }
        Ok(changes)
    }

    fn reconcile_suppressions(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        suppressed: &mut BTreeMap<String, Vec<String>>,
    ) -> Result<(), String> {
        let next = models_as_map(root(next, MODELS_ROLE))?;
        let previous = previous.and_then(|docs| models_as_map(root(docs, MODELS_ROLE)).ok());
        if let Some(paths) = suppressed.get_mut(MODELS_ROLE) {
            paths.retain(|path| {
                !(next.pointer(path).is_some()
                    && previous
                        .as_ref()
                        .is_none_or(|previous| previous.pointer(path).is_none()))
            });
        }
        suppressed.retain(|_, paths| !paths.is_empty());
        Ok(())
    }

    fn reconcile_text(
        &self,
        previous: Option<&Documents>,
        next: &Documents,
        _: &Documents,
        state: &mut EditingState,
    ) -> Result<(), String> {
        let models = models_as_map(root(next, MODELS_ROLE))?;
        let settings = root(next, SETTINGS_ROLE);
        state.intents.retain(|action| {
            let kind = action
                .target
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("");
            match action.operation.as_str() {
                "delete" | "rename" if kind == "model" => {
                    let provider = action
                        .target
                        .get("provider")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let id = action.target.get("id").and_then(Value::as_str).unwrap_or("");
                    models
                        .pointer(&pointer(&model_path(provider, id, None)))
                        .is_none()
                }
                "reset" if kind == "settings" || kind == "role" => {
                    let field = action.field.as_deref().unwrap_or("");
                    if field == "retry" {
                        settings.get("retry").is_none()
                    } else {
                        settings
                            .get("modelRoles")
                            .and_then(|roles| roles.get(field.trim_start_matches("modelRoles.")))
                            .is_none()
                    }
                }
                _ => false,
            }
        });
        let next_entities = entities(next)?;
        if let Some(previous) = previous {
            for (provider, id) in entities(previous)? {
                if !next_entities.iter().any(|(p, i)| p == &provider && i == &id)
                    && !state.intents.iter().any(|action| {
                        action
                            .target
                            .get("kind")
                            .and_then(Value::as_str)
                            == Some("model")
                            && action
                                .target
                                .get("provider")
                                .and_then(Value::as_str)
                                == Some(provider.as_str())
                            && action.target.get("id").and_then(Value::as_str)
                                == Some(id.as_str())
                            && matches!(action.operation.as_str(), "delete" | "rename")
                    })
                {
                    state.intents.push(ConfigurationAction {
                        version: EDITING_VERSION,
                        target: model_target(&provider, &id),
                        operation: "delete".into(),
                        field: None,
                        value: None,
                    });
                }
            }
        }
        Ok(())
    }
}

fn provider_trim(provider: &str) -> &str {
    provider.trim()
}

fn field(id: &str, label: &str, kind: &str, advanced: bool, _scope: Scope) -> ConfigurationField {
    ConfigurationField {
        id: id.into(),
        label: label.into(),
        kind: kind.into(),
        required: false,
        advanced,
        choices: vec![],
        minimum: matches!(kind, "number").then_some(1.0),
        default_source: Some(
            match id {
                "contextWindow" => "OMP 原生缺省（由模型声明决定）",
                "maxTokens" => "OMP 原生缺省（由模型声明决定）",
                "retry" => "跟随 OMP 原生重试默认值",
                _ if id.starts_with("modelRoles.") => "未设置时由 OMP 原生默认角色决定",
                _ => "跟随原生默认",
            }
            .into(),
        ),
        unavailable_reason: None,
        origin: None,
    }
}

fn settings_documents(documents: &Documents) -> Documents {
    let mut result = Documents::new();
    if let Some(settings) = documents.get(SETTINGS_ROLE) {
        result.insert(SETTINGS_ROLE.into(), settings.clone());
    }
    result
}

fn role_is(documents: &Documents, role: &str, provider: &str, id: &str) -> bool {
    role_value(documents, role)
        .as_deref()
        .and_then(split_reference)
        .is_some_and(|(selected, model)| selected == provider && model == id)
}

fn referenced_by_any_role(documents: &Documents, provider: &str, id: &str) -> bool {
    settings_model_roles(&root(documents, SETTINGS_ROLE))
        .values()
        .filter_map(Value::as_str)
        .filter_map(split_reference)
        .any(|(selected, model)| selected == provider && model == id)
}

fn update_role(
    documents: &mut Documents,
    provider: &str,
    old: &str,
    next: &str,
) -> Result<(), String> {
    let Some(settings) = documents.get_mut(SETTINGS_ROLE) else {
        return Ok(());
    };
    let Some(roles) = settings.get_mut("modelRoles").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    for value in roles.values_mut() {
        if value
            .as_str()
            .and_then(split_reference)
            .is_some_and(|(selected, model)| selected == provider && model == old)
        {
            *value = json!(model_reference(provider, next));
        }
    }
    Ok(())
}

fn retire_entity(state: &mut EditingState, provider: &str, id: &str) {
    state.intents.retain(|action| {
        let kind = action
            .target
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let p = action
            .target
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("");
        let old_id = action
            .target
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("");
        !(matches!(action.operation.as_str(), "delete" | "rename" | "reset")
            && p == provider
            && kind == "model"
            && old_id == id)
    });
}

fn entities(documents: &Documents) -> Result<Vec<(String, String)>, String> {
    let models = models_as_map(root(documents, MODELS_ROLE))?;
    let mut result = vec![];
    if let Some(providers) = models.get("providers").and_then(Value::as_object) {
        for (provider, entry) in providers {
            if let Some(models) = entry.get("models").and_then(Value::as_object) {
                result.extend(models.keys().map(|id| (provider.clone(), id.clone())));
            }
        }
    }
    Ok(result)
}

/// Product-level verification cases consumed by `scripts/verify-omp-native.mjs`.
/// These cases never launch OMP; the script pairs them with real observations
/// and reports the absence of a real CLI as unverified.
fn verify(
    case: &Value,
    context: &super::verify::CaseContext,
) -> Result<Value, super::verify::CaseError> {
    use super::verify::CaseError;
    let kind = case
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| CaseError::Failed("configuration 用例缺少 kind".into()))?;
    let mut checks: Vec<(String, bool, String)> = Vec::new();
    match kind {
        "paths" => {
            let config_dir = case
                .get("configDir")
                .and_then(Value::as_str)
                .map(|value| placeholder(value, context));
            let coding = case
                .get("codingAgentDir")
                .and_then(Value::as_str)
                .map(|value| placeholder(value, context));
            let profile = case.get("profile").and_then(Value::as_str);
            let expected_profile = case
                .get("expectedProfile")
                .and_then(Value::as_str)
                .unwrap_or(if profile.is_some() { "profile" } else { "default" });
            let expected_root = case
                .get("expectedRoot")
                .and_then(Value::as_str)
                .map(|value| placeholder(value, context));
            let outcome = resolve_root(&ResolutionInput {
                home: &context.home,
                profile,
                config_dir: config_dir.as_deref(),
                coding_agent_dir: coding.as_deref(),
            });
            if let Some(expected) = case.get("expectedError").and_then(Value::as_str) {
                checks.push((
                    "无效 Profile 被拒绝".into(),
                    outcome.is_err(),
                    expected.into(),
                ));
            } else {
                match outcome {
                    Ok(root) => {
                        checks.push((
                            "Profile 根目录".into(),
                            root.kind == expected_profile,
                            format!("实际 {}，期望 {expected_profile}", root.kind),
                        ));
                        if let Some(expected) = expected_root {
                            checks.push((
                                "Profile 路径".into(),
                                root.root == expected,
                                format!("实际 {}，期望 {}", root.root.display(), expected.display()),
                            ));
                        }
                        let expected_config = case
                            .get("expectedConfig")
                            .and_then(Value::as_str)
                            .map(|value| placeholder(value, context))
                            .unwrap_or_else(|| pick(&root.root, "config"));
                        let expected_models = case
                            .get("expectedModels")
                            .and_then(Value::as_str)
                            .map(|value| placeholder(value, context))
                            .unwrap_or_else(|| pick(&root.root, "models"));
                        checks.push((
                            "config.yml 路径".into(),
                            expected_config == pick(&root.root, "config"),
                            format!("实际 {}", pick(&root.root, "config").display()),
                        ));
                        checks.push((
                            "models.yml 路径".into(),
                            expected_models == pick(&root.root, "models"),
                            format!("实际 {}", pick(&root.root, "models").display()),
                        ));
                        // Project scope must publish only config.yml because
                        // 18.20.2 ignores project models/config.yaml.
                        let project_files = native_files(
                            Scope::Project,
                            &context.home,
                            Some(&context.project),
                            true,
                        );
                        checks.push((
                            "项目只发布 config.yml".into(),
                            project_files.len() == 1
                                && project_files[0].role == SETTINGS_ROLE
                                && Path::new(&project_files[0].path)
                                    .file_name()
                                    .is_some_and(|name| name == "config.yml"),
                            format!(
                                "实际 {}",
                                project_files
                                    .iter()
                                    .map(|file| file.path.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        ));
                    }
                    Err(error) => checks.push(("Profile 解析".into(), false, error)),
                }
            }
        }
        "draft" => {
            let role = case
                .get("role")
                .and_then(Value::as_str)
                .ok_or_else(|| CaseError::Failed("draft 用例缺少 role".into()))?;
            for item in case
                .get("valid")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let parsed = format::parse(FileKind::Yaml, item).map_err(|error| {
                    CaseError::Failed(format!("有效用例无法解析：{error}"))
                })?;
                let outcome = validate_draft(role, &parsed);
                checks.push((
                    format!("接受：{}", first_line(item)),
                    outcome.is_ok(),
                    outcome.err().unwrap_or_default(),
                ));
            }
            for item in case
                .get("invalid")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let parsed = format::parse(FileKind::Yaml, item).map_err(|error| {
                    CaseError::Failed(format!("无效用例无法解析：{error}"))
                })?;
                let outcome = validate_draft(role, &parsed);
                checks.push((
                    format!("拒绝：{}", first_line(item)),
                    outcome.is_err(),
                    outcome.err().unwrap_or_else(|| "错误地接受".to_owned()),
                ));
            }
        }
        "roundtrip" => {
            let config = case
                .get("config")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let models = case
                .get("models")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut documents = Documents::from([
                (
                    SETTINGS_ROLE.into(),
                    format::parse(FileKind::Yaml, config)
                        .map_err(|error| CaseError::Failed(format!("config 解析失败：{error}")))?,
                ),
                (
                    MODELS_ROLE.into(),
                    format::parse(FileKind::Yaml, models)
                        .map_err(|error| CaseError::Failed(format!("models 解析失败：{error}")))?,
                ),
            ]);
            let mut state = EditingState::default();
            if let Some(actions) = case.get("actions").and_then(Value::as_array) {
                for action in actions {
                    let value: ConfigurationAction = serde_json::from_value(action.clone())
                        .map_err(|error| CaseError::Failed(format!("action 无效：{error}")))?;
                    CONFIGURATION
                        .edit(&mut documents, &mut state, &value)
                        .map_err(CaseError::Failed)?;
                }
            }
            let mut rendered = BTreeMap::new();
            for (role, document) in &documents {
                rendered.insert(
                    role.clone(),
                    format::render(FileKind::Yaml, document).map_err(CaseError::Failed)?,
                );
            }
            for (role, text) in &rendered {
                let reparsed = format::parse(FileKind::Yaml, text)
                    .map_err(|error| CaseError::Failed(format!("{role} 渲染结果无法解析：{error}")))?;
                for expected in case
                    .get("expect")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|expect| expect.iter())
                    .filter_map(|(pointer, value)| {
                        pointer
                            .starts_with(&format!("/{role}/"))
                            .then_some((pointer.as_str(), value))
                    })
                {
                    let actual = reparsed.pointer(expected.0.trim_start_matches(&format!("/{role}")));
                    checks.push((
                        format!("{role}{}", expected.0),
                        actual == Some(expected.1),
                        format!("实际 {actual:?}"),
                    ));
                }
                for pointer in case
                    .get("preserve")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|pointer| pointer.starts_with(&format!("/{role}/")))
                {
                    checks.push((
                        format!("保留 {role}{pointer}"),
                        reparsed.pointer(pointer.trim_start_matches(&format!("/{role}"))).is_some(),
                        "原始未编辑字段丢失".into(),
                    ));
                }
                for pointer in case
                    .get("absent")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|pointer| pointer.starts_with(&format!("/{role}/")))
                {
                    checks.push((
                        format!("移除 {role}{pointer}"),
                        reparsed.pointer(pointer.trim_start_matches(&format!("/{role}"))).is_none(),
                        "仍然存在".into(),
                    ));
                }
                checks.push((
                    format!("{role} 无明文密钥"),
                    !has_literal_model_secret(&reparsed) || role == SETTINGS_ROLE,
                    "渲染结果含字面 apiKey".into(),
                ));
            }
        }
        "connection" => {
            let connection = Connection {
                provider_id: case
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("alpha")
                    .into(),
                interface_format: case
                    .get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("openai_completions")
                    .into(),
                base_url: case
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("https://alpha.example.test/v1")
                    .into(),
                model: case
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("one")
                    .into(),
                secret_ref: case
                    .get("secretRef")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                auth_env_var: case
                    .get("authEnvVar")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                model_records: Vec::new(),
            };
            let scope = if case.get("scope").and_then(Value::as_str) == Some("project") {
                Scope::Project
            } else {
                Scope::Global
            };
            let outcome = connection_documents(&connection, scope);
            if let Some(expected) = case.get("expectApiKey").and_then(Value::as_str) {
                match outcome.as_ref() {
                    Ok(documents) => {
                        let pointer = format!(
                            "/providers/{}/apiKey",
                            crate::adapters::pointer_token(&connection.provider_id)
                        );
                        let actual = documents
                            .get(MODELS_ROLE)
                            .and_then(|document| document.pointer(&pointer))
                            .and_then(Value::as_str);
                        checks.push((
                            "apiKey 是环境引用".into(),
                            actual == Some(expected)
                                && actual.and_then(omp_env_name).is_some(),
                            format!("实际 {actual:?}"),
                        ));
                    }
                    Err(error) => checks.push(("连接写入".into(), false, error.clone())),
                }
            }
            if case
                .get("expectError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                checks.push((
                    "拒绝机密连接".into(),
                    outcome.is_err(),
                    "错误地写入项目连接".into(),
                ));
            }
        }
        other => {
            return Err(CaseError::Failed(format!(
                "未知的 configuration 用例 kind：{other}"
            )))
        }
    }
    let failed = checks.iter().any(|(_, passed, _)| !passed);
    Ok(json!({
        "kind": kind,
        "result": {
            "passed": !failed,
            "checks": checks.into_iter().map(|(name, passed, detail)| {
                json!({"name": name, "passed": passed, "detail": detail})
            }).collect::<Vec<_>>(),
        },
    }))
}

fn placeholder(template: &str, context: &super::verify::CaseContext) -> PathBuf {
    PathBuf::from(
        template
            .replace("{home}", &context.home.display().to_string().replace('\\', "/"))
            .replace(
                "{project}",
                &context.project.display().to_string().replace('\\', "/"),
            ),
    )
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().trim().to_owned()
}

// Appended verification hook: the owning task replaces the body with real cases.
pub(crate) fn verify_case(
    case: &serde_json::Value,
    context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    verify(case, context)
}

#[cfg(test)]
#[path = "configuration_tests.rs"]
mod tests;
