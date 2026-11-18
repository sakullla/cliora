//! OMP accounts: read-only `agent.db` discovery and evidence-gated managed login.
//!
//! `agent.db` mixes authentication material with unrelated OMP state. This
//! module only opens it read-only, maps a small set of recognisable
//! provider/auth tables to sanitized identity/status, and never adopts a login,
//! copies credentials or rotates tokens. Until a provider has real evidence for
//! identity, isolation, login, cancel, refresh ownership and single-account
//! logout, every provider stays read-only (`managed_login = false`) with a
//! reason. Whole-file export is also closed: portable collection reports a
//! blocker instead of treating the database as an auth file.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::accounts::sqlite::{self, OpenFailure, ReadFailure, Sidecars};
use crate::accounts::{
    AccountCapability, AccountIdentity, AccountState, NativeContext, NativeLogin,
};
use crate::adapters::accounts::{
    account_id, email, safe_plan, valid_provider, AccountAdapter, AuthExportPolicy,
};
use crate::adapters::{Facet, LoginCapability, NativeCredentialTarget};
use crate::native::adapter::Scope;

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 账号发现与托管尚未交付；agent.db 含认证之外的状态，未核实前不观察、不采纳、不复制凭据";
pub(crate) const AVAILABLE_REASON: &str =
    "可只读展示 agent.db 中可解析的 provider、脱敏身份与状态；托管登录未开放（无 provider 真实证据）";

const DATABASE_FILE: &str = "agent.db";
const ROW_LIMIT: usize = 200;
const TABLE_LIMIT: usize = 32;
const ENVIRONMENT_KEYS: &[&str] = &[
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "XDG_DATA_HOME",
];

pub(crate) fn port() -> Option<&'static dyn AccountAdapter> {
    Some(&super::Omp)
}

pub(crate) fn native_credential_target(_scope: Scope) -> Option<NativeCredentialTarget> {
    None
}

/// Account publication follows the port: a verified read-only discovery port
/// makes the accounts tab appear without editing the composition root, while
/// managed login stays governed by the port's own capability flags.
pub(crate) fn management_visible(port: Option<&dyn AccountAdapter>) -> bool {
    port.is_some()
}

/// Accounts facet for the descriptor. The accounts task owns this state by
/// publishing its port and reasons here.
pub(crate) fn facet() -> Facet {
    match port() {
        Some(_) => Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

/// One provider-scoped managed-login capability is not evidence for all OMP
/// OAuth providers. No provider passed the gate, so login is published as
/// absent and the accounts tab is read-only.
pub(crate) fn capability() -> AccountCapability {
    AccountCapability {
        browser_link: false,
        tool_id: super::ID,
        provider: "omp-native",
        version: "1.0.0",
        managed_login: false,
        import_native: false,
        methods: Vec::new(),
        reason: "OMP 的登录由 OMP 自己管理：Cliora 只读取已有登录，不代为登录、刷新或退出。要换账号请在 OMP 里操作；配置里可用「本机登录」或 API 密钥。",
        identity_source: "agent.db 原生 provider 与脱敏账号元数据",
        identity_required: true,
        refresh_owner: "native_cli",
        acceptance: "仅以脱敏 SQLite fixture 覆盖解析、WAL/SHM、活动进程、损坏行与只读边界；真实 OAuth 账号、broker 与跨平台证据未完成",
    }
}

/// Interactive login entry. OMP's login is a native `/login` TUI command and is
/// not a launched CLI flag; no provider is verified, so no entry is published.
pub(crate) fn login_args() -> Option<Vec<String>> {
    None
}

pub(crate) fn login_hint() -> &'static str {
    ""
}

pub(crate) fn login_capability() -> Option<LoginCapability> {
    login_args().map(|_| LoginCapability { hint: login_hint() })
}

impl AccountAdapter for super::Omp {
    fn auth_export_policy(&self) -> AuthExportPolicy {
        AuthExportPolicy::SharedDatabase
    }

    fn native_environment_keys(&self) -> &'static [&'static str] {
        ENVIRONMENT_KEYS
    }

    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        native_context(home, environment).map(Some)
    }

    fn discovery_needs_executable(&self) -> bool {
        false
    }

    fn discover(
        &self,
        _executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        discover(context)
    }

    fn remove_environment(&self) -> &'static [&'static str] {
        ENVIRONMENT_KEYS
    }

    fn capability(&self) -> AccountCapability {
        capability()
    }
}

fn resolve_native_root(
    home: &Path,
    environment: &BTreeMap<String, String>,
    config_dir: Option<&Path>,
    coding_agent_dir: Option<&Path>,
) -> Result<super::configuration::ResolvedRoot, String> {
    super::configuration::resolve_agent_root(
        home,
        environment.get("OMP_PROFILE").map(String::as_str),
        environment.get("PI_PROFILE").map(String::as_str),
        config_dir,
        coding_agent_dir,
    )
}

pub(crate) fn native_context(
    home: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<NativeContext, String> {
    let config_dir = environment
        .get("PI_CONFIG_DIR")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let coding_agent_dir = environment
        .get("PI_CODING_AGENT_DIR")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let resolved = resolve_native_root(
        home,
        environment,
        config_dir.as_deref(),
        coding_agent_dir.as_deref(),
    )?;
    let root = resolved.root;
    let raw_profile = super::configuration::select_profile(
        environment.get("OMP_PROFILE").map(String::as_str),
        environment.get("PI_PROFILE").map(String::as_str),
    );
    let profile = raw_profile
        .map(super::configuration::normalize_profile_name)
        .transpose()?
        .flatten();
    // A custom coding-agent directory pins only the default profile; a named
    // profile never uses the default XDG data directory.
    let overridden = profile.is_none() && coding_agent_dir.is_some();
    let xdg_data = environment
        .get("XDG_DATA_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(Path::new);
    Ok(NativeContext {
        id: "native-default".into(),
        tool_id: super::ID.into(),
        config_root: root.clone(),
        resource_root: root.clone(),
        auth_files: vec![database_path(
            &root,
            !cfg!(windows),
            xdg_data,
            profile,
            overridden,
        )],
        history_roots: vec![root.join("sessions")],
        environment: environment.clone(),
        remove_environment: ENVIRONMENT_KEYS.iter().map(|key| (*key).into()).collect(),
        cli_args: Vec::new(),
        root,
    })
}

/// OMP 18.20.2 DirResolver: the initialised XDG data directory is used only
/// when the agent directory is not pinned by `PI_CODING_AGENT_DIR`. A named
/// Profile uses `$XDG_DATA_HOME/omp/profiles/<name>` when that directory exists,
/// otherwise its normal Profile agent directory; the default Profile uses
/// `$XDG_DATA_HOME/omp/agent.db`. Windows has no XDG path.
fn database_path(
    root: &Path,
    platform_unix: bool,
    xdg_data: Option<&Path>,
    profile: Option<&str>,
    overridden: bool,
) -> PathBuf {
    if !platform_unix || overridden {
        return root.join(DATABASE_FILE);
    }
    let Some(base) = xdg_data.filter(|base| base.is_absolute()) else {
        return root.join(DATABASE_FILE);
    };
    let app = base.join("omp");
    if !app.is_dir() {
        return root.join(DATABASE_FILE);
    }
    match profile {
        Some(name) => {
            let profile_root = app.join("profiles").join(name);
            if profile_root.is_dir() {
                profile_root.join(DATABASE_FILE)
            } else {
                root.join(DATABASE_FILE)
            }
        }
        None => app.join(DATABASE_FILE),
    }
}

/// Only an official `OMP_AUTH_BROKER_URL` or `auth.broker.url` in the first
/// existing config file is evidence of a broker. A token alone does not replace
/// local SQLite credentials, and unrelated `OMP_*BROKER*` variables are ignored.
fn broker_configured(context: &NativeContext) -> bool {
    let url = std::env::var_os("OMP_AUTH_BROKER_URL");
    broker_values_configured(url.as_deref().and_then(std::ffi::OsStr::to_str))
        || config_broker_configured(&context.root)
}

fn broker_values_configured(url: Option<&str>) -> bool {
    url.is_some_and(|value| {
        let value = value.trim();
        !value.is_empty() && !value.starts_with('!')
    })
}

fn config_broker_configured(root: &Path) -> bool {
    let preferred = root.join("config.yml");
    let legacy = root.join("config.yaml");
    let path = if preferred.exists() {
        preferred
    } else if legacy.exists() {
        legacy
    } else {
        return false;
    };
    // A directory/unreadable/invalid preferred file means no broker config; it
    // does not fall back to config.yaml, matching OMP's single-file read.
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    let Ok(value) = serde_yaml::from_slice::<serde_yaml::Value>(&bytes) else {
        return false;
    };
    value
        .get("auth")
        .and_then(|auth| auth.get("broker"))
        .and_then(|broker| broker.get("url"))
        .and_then(serde_yaml::Value::as_str)
        .is_some_and(|url| {
            let url = url.trim();
            !url.is_empty() && !url.starts_with('!')
        })
}

fn sidecar_note(sidecars: Sidecars) -> &'static str {
    if sidecars.present() {
        "读取时存在 agent.db-wal/-shm（可能是活动 WAL，也可能是残留 sidecar）；本次按只读快照读取，未据此判定 OMP 进程状态，其他 OMP 状态未被读取或导出。"
    } else {
        ""
    }
}

fn open_error(failure: OpenFailure) -> String {
    match failure {
        OpenFailure::Busy(sidecars) if sidecars.present() => {
            "只读打开被拒绝；检测到 agent.db-wal/-shm，但 sidecar 存在不能证明 OMP 正在运行。请关闭所有 OMP 实例后重试；若仍失败，在 OMP 原生终端执行一次登录或退出/重启后再试。Cliora 不会删除或修改 agent.db、-wal 或 -shm。".into()
        }
        OpenFailure::Busy(_) => {
            "无法只读打开 OMP agent.db（可能被其他进程占用或权限不足）；请关闭占用进程后重试，仍失败时在 OMP 原生终端检查登录状态。未修改或删除任何原生文件。".into()
        }
        OpenFailure::NotADatabase => "agent.db 不是有效的 SQLite 数据库；未读取内容".into(),
        OpenFailure::Unavailable => {
            "无法只读打开 OMP agent.db；请关闭其他 OMP 进程后重试。未修改或删除任何原生文件。".into()
        }
    }
}

fn read_error(error: &rusqlite::Error) -> String {
    match sqlite::classify(error) {
        ReadFailure::NotADatabase => "agent.db 不是有效的 SQLite 数据库；未读取内容".into(),
        ReadFailure::Corrupt => "agent.db 已损坏；未读取其他状态表".into(),
        ReadFailure::Unavailable => "无法读取 OMP agent.db 结构；未读取其他状态表".into(),
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn normalize(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

#[derive(Clone, Debug)]
struct Column {
    name: String,
    normalized: String,
}

const PROVIDER_NAMES: &[&str] = &["provider", "providerid", "providername", "service"];
const KIND_NAMES: &[&str] = &[
    "type",
    "authtype",
    "authkind",
    "kind",
    "method",
    "mode",
    "credentialtype",
];
const ACCESS_NAMES: &[&str] = &[
    "accesstoken",
    "accesstokenvalue",
    "oauthaccesstoken",
    "token",
];
const REFRESH_NAMES: &[&str] = &[
    "refreshtoken",
    "refreshtokenvalue",
    "oauthrefreshtoken",
    "refresh",
];
const API_KEY_NAMES: &[&str] = &["apikey", "apikeyvalue", "key", "secret"];
const DATA_NAMES: &[&str] = &["data", "value", "json", "credential", "credentials"];
const EXPIRES_NAMES: &[&str] = &[
    "expiresat",
    "expires",
    "expiry",
    "expireson",
    "expiresin",
    "expiresms",
];
const ACCOUNT_NAMES: &[&str] = &["accountid", "account", "userid", "uid", "subject"];
const EMAIL_NAMES: &[&str] = &["email", "emailaddress", "useremail", "login", "username"];
const PLAN_NAMES: &[&str] = &["plan", "tier", "subscription"];
const DISABLED_NAMES: &[&str] = &["disabledcause", "disabled"];

#[derive(Clone, Debug)]
struct Candidate {
    table: String,
    provider: String,
    kind: Option<String>,
    access: Option<String>,
    refresh: Option<String>,
    api_key: Option<String>,
    data: Option<String>,
    expires: Option<String>,
    account: Option<String>,
    email: Option<String>,
    plan: Option<String>,
    disabled: Option<String>,
    disabled_legacy: bool,
}

/// Strong auth-store markers. A runtime table that merely has a `provider` and
/// a generic `token` column (for example token usage) must not become a login.
fn strong_auth_table(name: &str) -> bool {
    let name = normalize(name);
    ["auth", "credential", "oauth", "login", "secret"]
        .iter()
        .any(|needle| name.contains(needle))
}

fn looks_auth_table(name: &str) -> bool {
    strong_auth_table(name)
}

fn pick(columns: &[Column], names: &[&str], used: &mut Vec<String>) -> Option<String> {
    columns
        .iter()
        .find(|column| names.contains(&column.normalized.as_str()) && !used.contains(&column.name))
        .map(|column| {
            used.push(column.name.clone());
            column.name.clone()
        })
}

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<Column>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
        .map_err(|error| read_error(&error))?;
    let rows = statement
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let normalized = normalize(&name);
            Ok(Column { name, normalized })
        })
        .map_err(|error| read_error(&error))?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row.map_err(|error| read_error(&error))?);
    }
    Ok(columns)
}

fn candidate(table: &str, columns: &[Column]) -> Option<Candidate> {
    let mut used = Vec::new();
    let provider = pick(columns, PROVIDER_NAMES, &mut used)?;
    let kind = pick(columns, KIND_NAMES, &mut used);
    let access = pick(columns, ACCESS_NAMES, &mut used);
    let refresh = pick(columns, REFRESH_NAMES, &mut used);
    let api_key = pick(columns, API_KEY_NAMES, &mut used);
    let data = pick(columns, DATA_NAMES, &mut used);
    // A single generic token column is not an authentication store on its own.
    // Require a paired OAuth structure, a typed credential, an API key or a
    // strongly auth-named JSON credential column.
    let structured = (access.is_some() && refresh.is_some())
        || (kind.is_some() && (access.is_some() || refresh.is_some() || api_key.is_some()))
        || api_key.is_some()
        || (data.is_some() && strong_auth_table(table));
    if !structured {
        return None;
    }
    Some(Candidate {
        table: table.to_owned(),
        provider,
        kind,
        access,
        refresh,
        api_key,
        data,
        expires: pick(columns, EXPIRES_NAMES, &mut used),
        account: pick(columns, ACCOUNT_NAMES, &mut used),
        email: pick(columns, EMAIL_NAMES, &mut used),
        plan: pick(columns, PLAN_NAMES, &mut used),
        disabled: pick(columns, DISABLED_NAMES, &mut used),
        disabled_legacy: used
            .last()
            .is_some_and(|name| normalize(name) == "disabled"),
    })
}

#[derive(Debug, Default)]
struct JsonRecord {
    kind: Option<String>,
    access: Option<String>,
    refresh: Option<String>,
    api_key: Option<String>,
    expires: Option<String>,
    account: Option<String>,
    email: Option<String>,
    plan: Option<String>,
}

fn json_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(|value| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
}

fn json_record(text: &str) -> Option<JsonRecord> {
    let value: Value = serde_json::from_str(text).ok()?;
    if !value.is_object() {
        return None;
    }
    let record = JsonRecord {
        kind: json_text(&value, &["type", "authType", "auth_type", "kind"]),
        access: json_text(&value, &["access", "access_token", "accessToken", "token"]),
        refresh: json_text(&value, &["refresh", "refresh_token", "refreshToken"]),
        api_key: json_text(&value, &["apiKey", "api_key", "key"]),
        expires: json_text(&value, &["expires", "expiresAt", "expires_at", "expiry"]),
        account: json_text(&value, &["accountId", "account_id", "subject"]),
        email: json_text(&value, &["email"]),
        plan: json_text(&value, &["plan"]),
    };
    if record.access.is_none()
        && record.refresh.is_none()
        && record.api_key.is_none()
        && record.kind.is_none()
    {
        return None;
    }
    Some(record)
}

fn expiry_seconds(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(number) = text.parse::<i64>() {
        let seconds = if number > 100_000_000_000 {
            number / 1000
        } else {
            number
        };
        return Some(seconds);
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp())
}

fn read_text(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Null => None,
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Integer(number) => Some(number.to_string()),
        ValueRef::Real(number) => Some(number.to_string()),
        ValueRef::Blob(_) => None,
    }
}

fn diagnostic_cause(value: &str) -> Option<String> {
    let text: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[derive(Clone)]
struct Tombstone {
    provider: String,
    auth_kind: &'static str,
    cause: Option<String>,
}

struct ReadRows {
    logins: Vec<NativeLogin>,
    skipped: usize,
    total: usize,
    tombstones: Vec<Tombstone>,
}

fn read_candidate(
    connection: &Connection,
    candidate: &Candidate,
    now: i64,
    sidecars: Sidecars,
    broker: bool,
) -> Result<ReadRows, String> {
    let fields = [
        Some(candidate.provider.as_str()),
        candidate.kind.as_deref(),
        candidate.access.as_deref(),
        candidate.refresh.as_deref(),
        candidate.api_key.as_deref(),
        candidate.data.as_deref(),
        candidate.expires.as_deref(),
        candidate.account.as_deref(),
        candidate.email.as_deref(),
        candidate.plan.as_deref(),
        candidate.disabled.as_deref(),
    ];
    let select = fields
        .iter()
        .map(|field| {
            field
                .as_deref()
                .map(quote_ident)
                .unwrap_or_else(|| "NULL".into())
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {select} FROM {} LIMIT {}",
        quote_ident(&candidate.table),
        ROW_LIMIT + 1
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| read_error(&error))?;
    let mut rows = statement.query([]).map_err(|error| read_error(&error))?;
    let mut logins = Vec::new();
    let mut tombstones = Vec::new();
    let mut skipped = 0usize;
    let mut total = 0usize;
    while let Some(row) = rows.next().map_err(|error| read_error(&error))? {
        total += 1;
        if total > ROW_LIMIT {
            break;
        }
        let mut values: [Option<String>; 11] = Default::default();
        let mut unusable = false;
        for (index, slot) in values.iter_mut().enumerate() {
            match row.get_ref(index) {
                Ok(ValueRef::Blob(_)) if (2..=5).contains(&index) || index == 10 => {
                    // Encrypted or binary material cannot be verified safely.
                    unusable = true;
                    break;
                }
                Ok(value) => *slot = read_text(value),
                Err(_) => {
                    unusable = true;
                    break;
                }
            }
        }
        if unusable {
            skipped += 1;
            continue;
        }
        let [provider, kind, access, refresh, api_key, data, expires, account, address, plan, disabled_raw] = values;
        let Some(provider) = provider.as_deref().filter(|value| valid_provider(value)) else {
            skipped += 1;
            continue;
        };
        let clean = |value: Option<String>| value.filter(|text| !text.trim().is_empty());
        let mut kind = clean(kind);
        let mut access = clean(access);
        let mut refresh = clean(refresh);
        let mut api_key = clean(api_key);
        let mut expires = clean(expires);
        let mut account = clean(account);
        let mut address = clean(address);
        let mut plan = clean(plan);
        // OMP 18.20.2 tombstones rows left by /logout, deduplication or a
        // failed refresh with a non-NULL disabled_cause. A legacy `disabled`
        // integer flag is only a tombstone when truthy (0 means active).
        let disabled = match disabled_raw.as_deref() {
            Some(raw) if candidate.disabled_legacy => {
                let raw = raw.trim().to_ascii_lowercase();
                raw == "1"
                    || raw == "true"
                    || raw.parse::<i64>().is_ok_and(|value| value != 0)
            }
            Some(_) => true,
            None => false,
        };
        if disabled {
            let kind_text = kind.as_deref().map(normalize).unwrap_or_default();
            let auth_kind = if kind_text.contains("api")
                || (api_key.is_some() && access.is_none() && refresh.is_none())
            {
                "api_key"
            } else {
                "oauth"
            };
            tombstones.push(Tombstone {
                provider: provider.to_owned(),
                auth_kind,
                cause: diagnostic_cause(disabled_raw.as_deref().unwrap_or("")),
            });
            continue;
        }
        let missing_credentials = access.is_none() && refresh.is_none() && api_key.is_none();
        if missing_credentials || (account.is_none() && address.is_none()) {
            if let Some(record) = data.as_deref().and_then(json_record) {
                if missing_credentials {
                    kind = kind.or(record.kind);
                    access = record.access;
                    refresh = record.refresh;
                    api_key = record.api_key;
                    expires = expires.or(record.expires);
                }
                account = account.or(record.account);
                address = address.or(record.email);
                plan = plan.or(record.plan);
            }
        }
        let kind_text = kind.as_deref().map(normalize).unwrap_or_default();
        let kind_oauth = kind_text.contains("oauth");
        let kind_api = kind_text.contains("api") || kind_text == "key";
        let paired_oauth = access.is_some() && refresh.is_some();
        let api = api_key.is_some();
        let auth_kind = match () {
            _ if kind_oauth && (access.is_some() || refresh.is_some()) => "oauth",
            _ if kind_api && api => "api_key",
            _ if paired_oauth => "oauth",
            _ if api => "api_key",
            _ => {
                skipped += 1;
                continue;
            }
        };
        let expires = expires.as_deref().and_then(expiry_seconds);
        let state = if auth_kind == "oauth" {
            if expires.is_some_and(|expires| expires <= now) {
                AccountState::Expired
            } else if access.is_some() && refresh.is_some() {
                AccountState::SignedIn
            } else {
                AccountState::Unknown
            }
        } else {
            AccountState::SignedIn
        };
        let address = address
            .as_deref()
            .and_then(|value| email(&Value::String(value.to_owned())));
        let subject = account
            .as_deref()
            .and_then(|value| account_id(&Value::String(value.to_owned())))
            .or_else(|| address.clone());
        let identity = subject.map(|subject| AccountIdentity {
            subject,
            email: address,
            plan: plan
                .as_deref()
                .and_then(|value| safe_plan(&Value::String(value.to_owned()))),
            source: "native_agent_db".into(),
        });
        let mut detail = match (auth_kind, state.clone()) {
            ("oauth", AccountState::Expired) => {
                "发现 OMP 原生 OAuth 记录，本地有效期已过；由 OMP 原生 CLI 刷新或重新登录，Cliora 不轮换令牌。"
            }
            ("oauth", AccountState::SignedIn) => {
                "发现 OMP 原生 OAuth 记录；仅本地只读观察，未在线核验服务端状态，未复制凭据。"
            }
            ("oauth", _) => "发现 OMP 原生 OAuth 记录但认证字段不完整；请在 OMP 原生终端中检查。",
            _ => "发现 OMP 原生 API Key 记录；仅只读展示，不是 OAuth 账号，也未在线核验。",
        }
        .to_owned();
        if identity.is_none() {
            detail.push_str("记录未提供可核验的账号标识。");
        }
        if sidecars.present() {
            detail.push_str(sidecar_note(sidecars));
        }
        if broker {
            detail.push_str("检测到 OMP broker URL（OMP_AUTH_BROKER_URL 或 config.yml auth.broker.url）；本地记录可能已被 broker 取代，仅作来源提示，不视为本地托管账号。");
        }
        logins.push(NativeLogin {
            provider: provider.to_owned(),
            auth_kind: auth_kind.into(),
            state,
            identity,
            detail: Some(detail),
            managed_account_id: None,
        });
    }
    Ok(ReadRows {
        logins,
        skipped,
        total,
        tombstones,
    })
}

fn read_logins(path: &Path, now: i64, broker: bool) -> Result<Vec<NativeLogin>, String> {
    let opened = sqlite::open_read_only(path).map_err(open_error)?;
    let sqlite::Opened {
        connection,
        sidecars,
    } = opened;
    let mut tables = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| read_error(&error))?;
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| read_error(&error))?;
    let mut candidates = Vec::new();
    let mut any_table = false;
    for name in names {
        let table = name.map_err(|error| read_error(&error))?;
        any_table = true;
        if !looks_auth_table(&table) {
            continue;
        }
        let columns = table_columns(&connection, &table)?;
        if let Some(candidate) = candidate(&table, &columns) {
            candidates.push(candidate);
            if candidates.len() >= TABLE_LIMIT {
                break;
            }
        }
    }
    if !any_table {
        return Err("OMP agent.db 尚无用户表；请在 OMP 中完成原生登录后重试".into());
    }
    if candidates.is_empty() {
        return Err("OMP agent.db 中未找到可识别的认证表；未猜测性读取其他 OMP 状态".into());
    }
    let mut logins = Vec::new();
    let mut tombstones: BTreeMap<String, (usize, &'static str, Option<String>)> = BTreeMap::new();
    let mut skipped = 0usize;
    let mut total = 0usize;
    for candidate in &candidates {
        let rows = read_candidate(&connection, candidate, now, sidecars, broker)?;
        logins.extend(rows.logins);
        skipped += rows.skipped;
        total += rows.total;
        for tombstone in rows.tombstones {
            let entry =
                tombstones
                    .entry(tombstone.provider)
                    .or_insert((0, tombstone.auth_kind, None));
            entry.0 += 1;
            entry.1 = tombstone.auth_kind;
            if entry.2.is_none() {
                entry.2 = tombstone.cause;
            }
        }
    }
    if logins.is_empty() && tombstones.is_empty() && total > 0 {
        return Ok(vec![NativeLogin {
            provider: "omp-unparsed".into(),
            auth_kind: "oauth".into(),
            state: AccountState::Unknown,
            identity: None,
            detail: Some(format!(
                "agent.db 中发现 {total} 行候选认证记录，但均无法安全解析；未读取其他 OMP 状态表。{}",
                sidecar_note(sidecars)
            )),
            managed_account_id: None,
        }]);
    }
    if !tombstones.is_empty() {
        let active: std::collections::BTreeSet<String> =
            logins.iter().map(|login| login.provider.clone()).collect();
        for (provider, (count, auth_kind, cause)) in tombstones {
            let cause_note = cause
                .as_deref()
                .map(|cause| format!("（disabled_cause: {cause}）"))
                .unwrap_or_default();
            if active.contains(&provider) {
                for login in logins.iter_mut().filter(|login| login.provider == provider) {
                    if let Some(detail) = &mut login.detail {
                        detail.push_str(&format!(
                            "另有 {count} 条已停用/墓碑认证记录已忽略{cause_note}，未展示为登录。"
                        ));
                    }
                }
            } else {
                logins.push(NativeLogin {
                    provider,
                    auth_kind: auth_kind.into(),
                    state: AccountState::SignedOut,
                    identity: None,
                    detail: Some(format!(
                        "发现 {count} 条已停用/墓碑认证记录{cause_note}；未展示为登录。{}",
                        sidecar_note(sidecars)
                    )),
                    managed_account_id: None,
                });
            }
        }
    }
    if skipped > 0 {
        for login in &mut logins {
            if let Some(detail) = &mut login.detail {
                detail.push_str(&format!(
                    "另有 {skipped} 行损坏、字段不完整或二进制材料已跳过。"
                ));
            }
        }
    }
    Ok(logins)
}

fn discover(context: &NativeContext) -> Result<Vec<NativeLogin>, String> {
    discover_with_broker(context, broker_configured(context))
}

fn discover_with_broker(context: &NativeContext, broker: bool) -> Result<Vec<NativeLogin>, String> {
    let path = context
        .auth_files
        .first()
        .ok_or("OMP 认证数据库未定义；未读取其他状态")?;
    if !path.is_file() {
        if broker {
            return Ok(vec![NativeLogin {
                provider: "omp-broker".into(),
                auth_kind: "oauth".into(),
                state: AccountState::Unknown,
                identity: None,
                detail: Some(
                    "检测到 OMP broker URL（OMP_AUTH_BROKER_URL 或 config.yml auth.broker.url）；本地 agent.db 不存在，凭据可能由 broker 持有。本机未读取远端身份，也未采纳本地账号。"
                        .into(),
                ),
                managed_account_id: None,
            }]);
        }
        return Ok(Vec::new());
    }
    read_logins(path, crate::accounts::now(), broker)
}

pub(crate) fn verify_case(
    case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    let kind = case
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| super::verify::CaseError::Failed("accounts 用例缺少 kind".into()))?;
    match kind {
        "read-only-policy" => {
            let capability = capability();
            let port = port();
            let entries = vec![
                (
                    "account port published".to_string(),
                    port.is_some(),
                    "只读发现端口存在".to_string(),
                ),
                (
                    "managed login closed".to_string(),
                    !capability.managed_login,
                    "没有 provider 通过真实证据门槛".to_string(),
                ),
                (
                    "no login methods".to_string(),
                    capability.methods.is_empty(),
                    format!("methods={:?}", capability.methods),
                ),
                (
                    "no login entry".to_string(),
                    login_capability().is_none(),
                    "不发布原生登录入口".to_string(),
                ),
                (
                    "explicit reason".to_string(),
                    !capability.reason.trim().is_empty(),
                    capability.reason.to_string(),
                ),
                (
                    "shared database export closed".to_string(),
                    port.map(|adapter| adapter.auth_export_policy())
                        == Some(AuthExportPolicy::SharedDatabase),
                    "整库不得作为账号 auth file 导出".to_string(),
                ),
            ];
            let failed = entries.iter().any(|(_, passed, _)| !passed);
            Ok(json!({
                "kind": kind,
                "result": {
                    "passed": !failed,
                    "checks": entries
                        .into_iter()
                        .map(|(name, passed, detail)| json!({ "name": name, "passed": passed, "detail": detail }))
                        .collect::<Vec<_>>(),
                },
            }))
        }
        other => Err(super::verify::CaseError::Failed(format!(
            "未知的 accounts 用例类型：{other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const FIXTURE: &str =
        include_str!("../../../../tests/fixtures/omp/accounts/sanitized-agent.db.sql");
    const NON_AUTH_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/omp/accounts/non-auth-usage.db.sql");
    const TOMBSTONE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/omp/accounts/real-agent-db-tombstones.db.sql");

    fn fixture_database(root: &Path) -> PathBuf {
        fs::create_dir_all(root).unwrap();
        let path = root.join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(FIXTURE).unwrap();
        path
    }

    fn fixture_context(root: &Path) -> NativeContext {
        NativeContext {
            id: "fixture".into(),
            tool_id: "omp".into(),
            root: root.to_path_buf(),
            config_root: root.to_path_buf(),
            auth_files: vec![root.join("agent.db")],
            history_roots: vec![],
            resource_root: root.to_path_buf(),
            environment: BTreeMap::new(),
            remove_environment: vec![],
            cli_args: vec![],
        }
    }

    #[test]
    fn fixture_agent_db_discovers_each_provider_without_credentials() {
        let temp = tempfile::tempdir().unwrap();
        fixture_database(temp.path());
        let logins = discover_with_broker(&fixture_context(temp.path()), false).unwrap();
        assert_eq!(logins.len(), 4);
        let codex_rows: Vec<_> = logins
            .iter()
            .filter(|login| login.provider == "openai-codex")
            .collect();
        assert_eq!(codex_rows.len(), 1, "墓碑行不得产生同 provider 幽灵重复");
        let codex = codex_rows[0];
        assert_eq!(codex.auth_kind, "oauth");
        assert_eq!(codex.state, AccountState::SignedIn);
        let identity = codex.identity.as_ref().unwrap();
        assert_eq!(identity.email.as_deref(), Some("ops@example.test"));
        assert_eq!(identity.plan.as_deref(), Some("plus"));
        assert_eq!(identity.source, "native_agent_db");
        assert!(codex.managed_account_id.is_none());
        assert!(codex.detail.as_deref().is_some_and(|detail| {
            detail.contains("已停用") && detail.contains("logged out by user")
        }));
        let anthropic = logins
            .iter()
            .find(|login| login.provider == "anthropic")
            .unwrap();
        assert_eq!(anthropic.state, AccountState::Expired);
        let qwen = logins
            .iter()
            .find(|login| login.provider == "qwen")
            .unwrap();
        assert_eq!(qwen.auth_kind, "api_key");
        assert_eq!(qwen.state, AccountState::SignedIn);
        let devin = logins
            .iter()
            .find(|login| login.provider == "devin")
            .unwrap();
        assert_eq!(devin.state, AccountState::SignedOut);
        assert!(devin
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("deduplicated duplicate credential")));
        let rendered = serde_json::to_string(&logins).unwrap();
        for secret in [
            "fixture-access-token",
            "fixture-refresh-token",
            "fixture-api-key",
        ] {
            assert!(!rendered.contains(secret), "{secret} 不得离开适配器");
        }
        assert!(!rendered.contains("session-body-must-not-be-read"));
        assert!(codex
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("已跳过")));
    }

    #[test]
    fn omp_tombstones_are_filtered_from_active_logins_and_keep_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(TOMBSTONE_FIXTURE).unwrap();
        drop(connection);
        let logins = discover_with_broker(&fixture_context(temp.path()), false).unwrap();
        assert_eq!(logins.len(), 2);
        let codex: Vec<_> = logins
            .iter()
            .filter(|login| login.provider == "openai-codex")
            .collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].state, AccountState::SignedIn);
        assert_eq!(
            codex[0]
                .identity
                .as_ref()
                .and_then(|identity| identity.email.as_deref()),
            Some("ops@example.test")
        );
        assert!(codex[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("logged out by user")));
        let devin = logins
            .iter()
            .find(|login| login.provider == "devin")
            .unwrap();
        assert_eq!(devin.state, AccountState::SignedOut);
        assert!(devin
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("refresh failed")));
        let rendered = serde_json::to_string(&logins).unwrap();
        for secret in ["fixture-old-access", "fixture-old-refresh"] {
            assert!(!rendered.contains(secret), "{secret} 不得离开适配器");
        }
    }

    #[test]
    fn usage_and_bare_token_tables_are_not_rendered_as_oauth_logins() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(NON_AUTH_FIXTURE).unwrap();
        drop(connection);
        let error = discover_with_broker(&fixture_context(temp.path()), false).unwrap_err();
        assert!(
            error.contains("未找到可识别的认证表"),
            "非认证表必须降级为不可解析提示，而不是 OAuth 登录: {error}"
        );
        assert!(!error.contains("openai-codex"));
        assert!(!error.contains("anthropic"));
    }

    #[test]
    fn unknown_schema_and_corrupt_file_are_reported_without_reading_other_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session_state (id TEXT, body TEXT);
                 INSERT INTO session_state VALUES ('s1','unrelated-state-must-stay');",
            )
            .unwrap();
        drop(connection);
        let error = discover_with_broker(&fixture_context(temp.path()), false).unwrap_err();
        assert!(error.contains("未找到可识别的认证表"));
        assert!(!error.contains("unrelated-state-must-stay"));

        let corrupt = tempfile::tempdir().unwrap();
        fs::write(corrupt.path().join("agent.db"), "not a sqlite database").unwrap();
        let error = discover_with_broker(&fixture_context(corrupt.path()), false).unwrap_err();
        assert!(error.contains("不是有效的 SQLite"));
        assert!(!error.contains(&corrupt.path().display().to_string().replace('\\', "/")));
    }

    #[test]
    fn missing_database_is_no_login_and_broker_is_not_a_local_account() {
        let temp = tempfile::tempdir().unwrap();
        let logins = discover_with_broker(&fixture_context(temp.path()), false).unwrap();
        assert!(logins.is_empty());
        let broker = discover_with_broker(&fixture_context(temp.path()), true).unwrap();
        assert_eq!(broker.len(), 1);
        assert_eq!(broker[0].state, AccountState::Unknown);
        assert!(broker[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("broker")));
        assert!(broker[0].managed_account_id.is_none());
    }

    #[test]
    fn capability_is_read_only_until_a_provider_has_real_evidence() {
        assert!(port().is_some());
        assert_eq!(facet().state, "available");
        let capability = capability();
        assert!(!capability.managed_login);
        assert!(capability.methods.is_empty());
        assert!(login_capability().is_none());
        assert_eq!(
            port().unwrap().auth_export_policy(),
            AuthExportPolicy::SharedDatabase
        );
        assert!(!capability.acceptance.contains("真实账号已验证"));
    }

    #[test]
    fn relative_config_dir_matches_omp_and_account_discovery_stays_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let relative = BTreeMap::from([
            ("PI_CONFIG_DIR".to_string(), "custom-config".to_string()),
            ("OMP_PROFILE".to_string(), "work".to_string()),
        ]);
        let context = native_context(temp.path(), &relative).unwrap();
        assert_eq!(
            context.root,
            temp.path()
                .join("custom-config")
                .join("profiles")
                .join("work")
                .join("agent")
        );
        assert_eq!(context.auth_files, vec![context.root.join("agent.db")]);

        let default_env =
            BTreeMap::from([("PI_CONFIG_DIR".to_string(), "custom-config".to_string())]);
        let default = native_context(temp.path(), &default_env).unwrap();
        assert_eq!(
            default.root,
            temp.path().join("custom-config").join("agent")
        );
        assert_eq!(
            native_context(temp.path(), &BTreeMap::new()).unwrap().root,
            temp.path().join(".omp").join("agent")
        );

        // OMP 18.20.2 trims profile values; empty/whitespace/`default` mean the
        // default profile, and an explicitly present empty OMP_PROFILE must not
        // fall back to PI_PROFILE.
        for value in ["", "   ", "default", " default "] {
            let environment = BTreeMap::from([
                ("OMP_PROFILE".to_string(), value.to_string()),
                ("PI_PROFILE".to_string(), "work".to_string()),
            ]);
            let context = native_context(temp.path(), &environment).unwrap();
            assert_eq!(
                context.root,
                temp.path().join(".omp").join("agent"),
                "{value:?}"
            );
        }
        let trimmed = BTreeMap::from([("OMP_PROFILE".to_string(), " work ".to_string())]);
        assert_eq!(
            native_context(temp.path(), &trimmed).unwrap().root,
            temp.path()
                .join(".omp")
                .join("profiles")
                .join("work")
                .join("agent")
        );
        for invalid in ["Work", "work.", "con", "CON.txt", "com1"] {
            let environment = BTreeMap::from([("OMP_PROFILE".to_string(), invalid.to_string())]);
            assert!(
                native_context(temp.path(), &environment).is_err(),
                "{invalid:?} 必须被拒绝"
            );
        }
        let too_long = "a".repeat(65);
        let environment = BTreeMap::from([("OMP_PROFILE".to_string(), too_long)]);
        assert!(native_context(temp.path(), &environment).is_err());

        let absolute = BTreeMap::from([(
            "PI_CONFIG_DIR".to_string(),
            temp.path().join("absolute-config").display().to_string(),
        )]);
        let error = native_context(temp.path(), &absolute).unwrap_err();
        assert!(
            error.contains("PI_CONFIG_DIR 必须是 home 下的相对目录"),
            "{error}"
        );
        let traversal = BTreeMap::from([("PI_CONFIG_DIR".to_string(), "../escape".to_string())]);
        assert!(native_context(temp.path(), &traversal).is_err());
        let invalid_profile =
            BTreeMap::from([("OMP_PROFILE".to_string(), "../escape".to_string())]);
        assert!(native_context(temp.path(), &invalid_profile).is_err());

        // PI_CODING_AGENT_DIR relocates only the default profile, as in the
        // configuration resolver.
        let relocated = temp.path().join("relocated-agent");
        let coding = BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            relocated.display().to_string(),
        )]);
        assert_eq!(
            native_context(temp.path(), &coding).unwrap().root,
            relocated
        );

        // A legal relative root must show the read-only empty state, not an
        // adapter error.
        let database = crate::database::Database::open(&temp.path().join("cliora.db")).unwrap();
        let snapshot = crate::accounts::discovery::discover_with(
            &database,
            temp.path(),
            "omp",
            port().unwrap(),
            &default_env,
        )
        .unwrap();
        assert_eq!(snapshot.logins.len(), 1);
        assert_eq!(snapshot.logins[0].state, AccountState::SignedOut);
        assert!(snapshot.logins[0].managed_account_id.is_none());
    }

    #[test]
    fn relative_coding_agent_dir_is_rejected_with_an_explicit_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let environment = BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            "relative-agent".to_string(),
        )]);
        let error = native_context(temp.path(), &environment).unwrap_err();
        assert!(error.contains("无法安全定位"), "{error}");
        assert!(error.contains("绝对路径"), "{error}");

        let named = BTreeMap::from([
            ("OMP_PROFILE".to_string(), "work".to_string()),
            (
                "PI_CODING_AGENT_DIR".to_string(),
                "relative-agent".to_string(),
            ),
        ]);
        assert_eq!(
            native_context(temp.path(), &named).unwrap().root,
            temp.path()
                .join(".omp")
                .join("profiles")
                .join("work")
                .join("agent")
        );
    }

    #[test]
    fn broker_detection_uses_official_url_only_and_first_config_file() {
        assert!(broker_values_configured(Some("https://broker.test")));
        assert!(!broker_values_configured(Some("   ")));
        assert!(!broker_values_configured(Some("!ENV")));
        assert!(!broker_values_configured(None));

        let temp = tempfile::tempdir().unwrap();
        assert!(!config_broker_configured(temp.path()));
        fs::write(
            temp.path().join("config.yml"),
            "auth:\n  broker:\n    token: fixture-token\n",
        )
        .unwrap();
        assert!(!config_broker_configured(temp.path()));
        fs::write(
            temp.path().join("config.yml"),
            "auth:\n  broker:\n    url: https://broker.test\n",
        )
        .unwrap();
        assert!(config_broker_configured(temp.path()));
        fs::write(
            temp.path().join("config.yml"),
            "auth:\n  broker:\n    url: '!ENV'\n    token: fixture-token\n",
        )
        .unwrap();
        assert!(!config_broker_configured(temp.path()));
        let padded = format!(
            "auth:\n  broker:\n    url: https://broker.test\n# {}\n",
            "x".repeat(70 * 1024)
        );
        fs::write(temp.path().join("config.yml"), padded).unwrap();
        assert!(config_broker_configured(temp.path()));
        // config.yml is the only file OMP reads when it exists; config.yaml is
        // not a fallback for an invalid preferred file.
        fs::write(
            temp.path().join("config.yaml"),
            "auth:\n  broker:\n    url: https://yaml-broker.test\n",
        )
        .unwrap();
        fs::write(temp.path().join("config.yml"), "not: [valid").unwrap();
        assert!(!config_broker_configured(temp.path()));
        fs::remove_file(temp.path().join("config.yml")).unwrap();
        assert!(config_broker_configured(temp.path()));
        fs::remove_file(temp.path().join("config.yaml")).unwrap();
        fs::create_dir(temp.path().join("config.yml")).unwrap();
        fs::write(
            temp.path().join("config.yaml"),
            "auth:\n  broker:\n    url: https://yaml-broker.test\n",
        )
        .unwrap();
        assert!(!config_broker_configured(temp.path()));
    }

    #[test]
    fn xdg_database_path_follows_profile_and_override() {
        let temp = tempfile::tempdir().unwrap();
        let xdg = temp.path().join("xdg");
        let root = temp.path().join("root-agent");
        fs::create_dir_all(xdg.join("omp").join("profiles").join("work")).unwrap();
        assert_eq!(
            database_path(&root, true, Some(&xdg), None, false),
            xdg.join("omp").join("agent.db")
        );
        assert_eq!(
            database_path(&root, true, Some(&xdg), Some("work"), false),
            xdg
                .join("omp")
                .join("profiles")
                .join("work")
                .join("agent.db")
        );
        // A default-profile PI_CODING_AGENT_DIR override pins the legacy path.
        assert_eq!(
            database_path(&root, true, Some(&xdg), None, true),
            root.join("agent.db")
        );
        // A named Profile without its XDG profile directory uses its agent dir.
        assert_eq!(
            database_path(&root, true, Some(&xdg), Some("missing"), false),
            root.join("agent.db")
        );
        fs::remove_dir_all(xdg.join("omp")).unwrap();
        assert_eq!(
            database_path(&root, true, Some(&xdg), None, false),
            root.join("agent.db")
        );
        assert_eq!(
            database_path(&root, false, Some(&xdg), None, false),
            root.join("agent.db")
        );
        assert_eq!(
            database_path(&root, true, Some(Path::new("relative")), None, false),
            root.join("agent.db")
        );
    }

    #[test]
    fn blank_config_dir_and_legacy_disabled_flag_follow_omp() {
        let temp = tempfile::tempdir().unwrap();
        let blank = BTreeMap::from([
            ("PI_CONFIG_DIR".to_string(), "   ".to_string()),
            ("PI_CODING_AGENT_DIR".to_string(), " ".to_string()),
        ]);
        assert_eq!(
            native_context(temp.path(), &blank).unwrap().root,
            temp.path().join(".omp").join("agent")
        );
        let legacy = tempfile::tempdir().unwrap();
        let path = legacy.path().join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled INTEGER);
                 INSERT INTO auth_credentials VALUES ('openai-codex','oauth','{\"type\":\"oauth\",\"access\":\"a\",\"refresh\":\"r\",\"expires\":4102444800,\"accountId\":\"active\"}','0');
                 INSERT INTO auth_credentials VALUES ('openai-codex','oauth','{\"type\":\"oauth\",\"access\":\"old\",\"refresh\":\"old\",\"expires\":4102444800,\"accountId\":\"old\"}','1');",
            )
            .unwrap();
        drop(connection);
        let logins = discover_with_broker(&fixture_context(legacy.path()), false).unwrap();
        assert_eq!(logins.len(), 1);
        assert_eq!(logins[0].state, AccountState::SignedIn);
        assert!(logins[0]
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("已停用")));
        assert!(!serde_json::to_string(&logins).unwrap().contains("\"old\""));
    }

    #[test]
    fn wal_sidecar_presence_is_named_in_the_read_only_detail() {
        let sidecars = Sidecars {
            wal: true,
            shm: true,
        };
        assert!(sidecar_note(sidecars).contains("agent.db-wal/-shm"));
        assert!(sidecar_note(sidecars).contains("只读"));
        assert!(sidecar_note(Sidecars::default()).is_empty());
    }

    #[test]
    fn live_writer_in_wal_mode_is_read_as_a_read_only_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = fixture_database(temp.path());
        let writer = Connection::open(&path).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer
            .execute(
                "INSERT INTO session_state (id,body) VALUES ('wal-writer','stay')",
                [],
            )
            .unwrap();
        assert!(Sidecars::detect(&path).present());
        let logins = discover_with_broker(&fixture_context(temp.path()), false)
            .expect("active WAL writer should be readable as a read-only snapshot; a busy rejection must be investigated, not accepted silently");
        assert!(logins.iter().any(|login| login.provider == "openai-codex"));
        assert!(logins.iter().any(|login| {
            login
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("只读快照"))
        }));
        drop(writer);
    }

    #[test]
    fn busy_open_failure_offers_retry_without_deleting_sidecars() {
        let with_sidecars = open_error(OpenFailure::Busy(Sidecars {
            wal: true,
            shm: true,
        }));
        assert!(with_sidecars.contains("重试"));
        assert!(with_sidecars.contains("不能证明"));
        assert!(with_sidecars.contains("不会删除或修改"));
        assert!(!with_sidecars.contains("可能有 OMP 正在运行"));
        let without_sidecars = open_error(OpenFailure::Busy(Sidecars::default()));
        assert!(without_sidecars.contains("重试"));
        assert!(without_sidecars.contains("未修改或删除"));
    }

    #[test]
    fn read_only_policy_case_passes_and_unknown_kinds_stay_explicit() {
        let context = super::super::verify::CaseContext {
            home: PathBuf::from("/tmp/omp-home"),
            project: PathBuf::from("/tmp/omp-project"),
            executable: None,
            environment: Vec::new(),
        };
        let outcome = verify_case(&json!({ "kind": "read-only-policy" }), &context).unwrap();
        assert_eq!(outcome["result"]["passed"], true);
        assert!(matches!(
            verify_case(&json!({ "kind": "other" }), &context),
            Err(super::super::verify::CaseError::Failed(_))
        ));
    }
}
