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
use std::path::{Component, Path, PathBuf};

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
        reason: "OMP 账号仅只读发现：agent.db 混存认证与其他状态，且没有任何 provider 完成真实身份、隔离、登录、取消、refresh 归属与单账号退出验证；不提供托管登录、刷新或退出，也不把发现当作采纳。",
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

fn absolute_path(value: &str, key: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!("{key} 必须是绝对路径且不能包含上级目录"));
    }
    Ok(path)
}

fn validate_profile(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || value == "."
        || value == ".."
        || value.contains("..")
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err("OMP Profile 名称无效；未读取任何原生账号目录".into());
    }
    Ok(())
}

/// Default or named Profile agent directory. `PI_CONFIG_DIR` moves the config
/// root, `OMP_PROFILE`/`PI_PROFILE` select a named Profile and
/// `PI_CODING_AGENT_DIR` only relocates the default Profile.
fn native_root(home: &Path, environment: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    let config_root = match environment
        .get("PI_CONFIG_DIR")
        .filter(|value| !value.is_empty())
    {
        Some(value) => absolute_path(value, "PI_CONFIG_DIR")?,
        None => home.join(".omp"),
    };
    let profile = environment
        .get("OMP_PROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            environment
                .get("PI_PROFILE")
                .filter(|value| !value.is_empty())
        });
    if let Some(profile) = profile {
        validate_profile(profile)?;
        return Ok(config_root.join("profiles").join(profile).join("agent"));
    }
    match environment
        .get("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
    {
        Some(value) => absolute_path(value, "PI_CODING_AGENT_DIR"),
        None => Ok(config_root.join("agent")),
    }
}

pub(crate) fn native_context(
    home: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<NativeContext, String> {
    let root = native_root(home, environment)?;
    Ok(NativeContext {
        id: "native-default".into(),
        tool_id: super::ID.into(),
        config_root: root.clone(),
        resource_root: root.clone(),
        auth_files: vec![root.join(DATABASE_FILE)],
        history_roots: vec![root.join("sessions")],
        environment: environment.clone(),
        remove_environment: ENVIRONMENT_KEYS.iter().map(|key| (*key).into()).collect(),
        cli_args: Vec::new(),
        root,
    })
}

/// Broker-backed credentials replace the local store and are not local
/// accounts. Only key names/emptiness are inspected; values never leave the
/// process and no remote broker is contacted.
fn broker_configured() -> bool {
    std::env::vars_os().any(|(key, value)| {
        let key = key.to_string_lossy().to_ascii_uppercase();
        (key.starts_with("OMP_") || key.starts_with("PI_"))
            && key.contains("BROKER")
            && !value.is_empty()
    })
}

fn sidecar_note(sidecars: Sidecars) -> &'static str {
    if sidecars.present() {
        "读取时存在 agent.db-wal/-shm，可能有 OMP 正在运行；本次仅只读快照，其他 OMP 状态未被读取或导出。"
    } else {
        ""
    }
}

fn open_error(failure: OpenFailure) -> String {
    match failure {
        OpenFailure::Busy(sidecars) if sidecars.present() => {
            "检测到 agent.db-wal/-shm 且只读打开被拒绝，可能有 OMP 正在运行；请关闭 OMP 后重试，未读取或复制数据库".into()
        }
        OpenFailure::Busy(_) => {
            "无法只读打开 OMP agent.db（可能被占用或权限不足）；未读取其他状态数据".into()
        }
        OpenFailure::NotADatabase => "agent.db 不是有效的 SQLite 数据库；未读取内容".into(),
        OpenFailure::Unavailable => "无法只读打开 OMP agent.db；未修改原生文件".into(),
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
}

fn looks_auth_table(name: &str) -> bool {
    let name = normalize(name);
    [
        "auth",
        "credential",
        "oauth",
        "login",
        "token",
        "account",
        "secret",
    ]
    .iter()
    .any(|needle| name.contains(needle))
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
    if access.is_none() && refresh.is_none() && api_key.is_none() && data.is_none() {
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

struct ReadRows {
    logins: Vec<NativeLogin>,
    skipped: usize,
    total: usize,
}

fn read_candidate(
    connection: &Connection,
    candidate: &Candidate,
    now: i64,
    sidecars: Sidecars,
    broker: bool,
) -> Result<ReadRows, String> {
    let fields = [
        Some(candidate.provider.clone()),
        candidate.kind.clone(),
        candidate.access.clone(),
        candidate.refresh.clone(),
        candidate.api_key.clone(),
        candidate.data.clone(),
        candidate.expires.clone(),
        candidate.account.clone(),
        candidate.email.clone(),
        candidate.plan.clone(),
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
    let mut skipped = 0usize;
    let mut total = 0usize;
    while let Some(row) = rows.next().map_err(|error| read_error(&error))? {
        total += 1;
        if total > ROW_LIMIT {
            break;
        }
        let mut values = Vec::with_capacity(10);
        let mut unusable = false;
        for index in 0..10 {
            match row.get_ref(index) {
                Ok(ValueRef::Blob(_)) if (2..=5).contains(&index) => {
                    // Encrypted or binary material cannot be verified safely.
                    unusable = true;
                    break;
                }
                Ok(value) => values.push(read_text(value)),
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
        let Some(provider) = values[0].as_deref().filter(|value| valid_provider(value)) else {
            skipped += 1;
            continue;
        };
        let clean = |value: Option<String>| value.filter(|text| !text.trim().is_empty());
        let mut kind = clean(values[1].clone());
        let mut access = clean(values[2].clone());
        let mut refresh = clean(values[3].clone());
        let mut api_key = clean(values[4].clone());
        let mut expires = clean(values[6].clone());
        let mut account = clean(values[7].clone());
        let mut address = clean(values[8].clone());
        let mut plan = clean(values[9].clone());
        if access.is_none() && refresh.is_none() && api_key.is_none() {
            if let Some(record) = values[5].as_deref().and_then(json_record) {
                kind = kind.or(record.kind);
                access = record.access;
                refresh = record.refresh;
                api_key = record.api_key;
                expires = expires.or(record.expires);
                account = account.or(record.account);
                address = address.or(record.email);
                plan = plan.or(record.plan);
            }
        }
        if account.is_none() && address.is_none() {
            if let Some(record) = values[5].as_deref().and_then(json_record) {
                account = record.account;
                address = record.email;
                plan = plan.or(record.plan);
            }
        }
        let kind_text = kind.as_deref().map(normalize).unwrap_or_default();
        let oauth = access.is_some() || refresh.is_some();
        let api = api_key.is_some();
        let auth_kind = match () {
            _ if kind_text.contains("oauth") && oauth => "oauth",
            _ if (kind_text.contains("api") || kind_text == "key") && api => "api_key",
            _ if oauth => "oauth",
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
            detail.push_str("检测到 OMP/PI broker 环境变量；本地记录可能已被 broker 取代，仅作来源提示，不视为本地托管账号。");
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
    let mut skipped = 0usize;
    let mut total = 0usize;
    for candidate in &candidates {
        let rows = read_candidate(&connection, candidate, now, sidecars, broker)?;
        logins.extend(rows.logins);
        skipped += rows.skipped;
        total += rows.total;
    }
    if logins.is_empty() && total > 0 {
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
    discover_with_broker(context, broker_configured())
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
                    "检测到 OMP/PI broker 环境变量；本地 agent.db 不存在，凭据可能由 broker 持有。本机未读取远端身份，也未采纳本地账号。"
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
        assert_eq!(logins.len(), 3);
        let codex = logins
            .iter()
            .find(|login| login.provider == "openai-codex")
            .unwrap();
        assert_eq!(codex.auth_kind, "oauth");
        assert_eq!(codex.state, AccountState::SignedIn);
        let identity = codex.identity.as_ref().unwrap();
        assert_eq!(identity.email.as_deref(), Some("ops@example.test"));
        assert_eq!(identity.plan.as_deref(), Some("plus"));
        assert_eq!(identity.source, "native_agent_db");
        assert!(codex.managed_account_id.is_none());
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
        let rendered = serde_json::to_string(&logins).unwrap();
        for secret in [
            "fixture-access-token",
            "fixture-refresh-token",
            "fixture-api-key",
        ] {
            assert!(!rendered.contains(secret), "{secret} 不得离开适配器");
        }
        assert!(!rendered.contains("session-body-must-not-be-read"));
        assert!(logins.iter().all(|login| login
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("已跳过"))));
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
    fn named_profile_and_environment_roots_stay_inside_their_declared_paths() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let environment = BTreeMap::from([
            ("PI_CONFIG_DIR".to_string(), config.display().to_string()),
            ("OMP_PROFILE".to_string(), "work".to_string()),
        ]);
        let context = native_context(temp.path(), &environment).unwrap();
        assert_eq!(
            context.root,
            config.join("profiles").join("work").join("agent")
        );
        assert_eq!(context.auth_files, vec![context.root.join("agent.db")]);

        let default = native_context(temp.path(), &BTreeMap::new()).unwrap();
        assert_eq!(default.root, temp.path().join(".omp").join("agent"));

        let traversal = BTreeMap::from([("OMP_PROFILE".to_string(), "../escape".to_string())]);
        assert!(native_context(temp.path(), &traversal).is_err());
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
    fn live_writer_in_wal_mode_is_read_as_a_snapshot_or_reported_as_busy() {
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
        match discover_with_broker(&fixture_context(temp.path()), false) {
            Ok(logins) => {
                assert!(logins.iter().any(|login| login.provider == "openai-codex"));
                assert!(logins.iter().any(|login| {
                    login
                        .detail
                        .as_deref()
                        .is_some_and(|detail| detail.contains("agent.db-wal/-shm"))
                }));
            }
            Err(error) => {
                assert!(
                    error.contains("只读打开被拒绝") || error.contains("无法只读打开"),
                    "{error}"
                );
                assert!(!error.contains("session-body-must-not-be-read"));
            }
        }
        drop(writer);
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
