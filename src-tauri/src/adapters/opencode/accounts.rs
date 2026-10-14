use super::OpenCode;
use crate::accounts::native::*;
use crate::accounts::{
    AccountCapability, AccountIdentity, AccountState, NativeContext, NativeLogin, Observation,
};
use crate::adapters::accounts::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Verified against a real `@opencode/cli` 2.0.29 install: provider
/// credentials live in a SQLite store (`credential` table) below the XDG data
/// root, while 1.x keeps the `auth.json` file. The store is only observed
/// read-only and tokens never leave the parsing helpers below.
const CREDENTIAL_DB: &str = "opencode.db";

/// `OPENCODE_DB` redirects the 2.x credential/session store; observation
/// follows it, and it is stripped from isolated contexts so a login cannot
/// escape its account directory.
fn storage_override(environment: &BTreeMap<String, String>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = environment
        .get("OPENCODE_DB")
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("原生凭据库覆盖路径必须是绝对路径且不能包含上级目录".into());
    }
    Ok(Some(path))
}

fn credential_db_path(context: &NativeContext) -> Result<PathBuf, String> {
    if let Some(path) = storage_override(&context.environment)? {
        return Ok(path);
    }
    if let Some(path) = context.auth_files.iter().find(|path| {
        path.file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case(CREDENTIAL_DB))
    }) {
        return Ok(path.clone());
    }
    Ok(match context
        .environment
        .get("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
    {
        Some(root) => Path::new(root).join("opencode").join(CREDENTIAL_DB),
        None => context.root.join(CREDENTIAL_DB),
    })
}

/// Sanitized view of one 2.x credential row. Secret material is reduced to
/// presence flags before anything is returned to callers.
struct NativeCredential {
    id: String,
    provider: String,
    oauth: Option<NativeOAuth>,
    api_key: bool,
}
struct NativeOAuth {
    access: bool,
    refresh: bool,
    expires: Option<i64>,
    account_id: Option<String>,
}

fn valid_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_provider(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 80
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./:".contains(&b))
}

fn parse_credential_row(id: &str, provider: &str, value: &str) -> Option<NativeCredential> {
    if !valid_token(id) || !valid_provider(provider) || value.len() > OUTPUT_LIMIT as usize {
        return None;
    }
    let value: Value = serde_json::from_str(value).ok()?;
    let credential = match value.get("type").and_then(Value::as_str) {
        Some("oauth") => NativeCredential {
            id: id.into(),
            provider: provider.into(),
            oauth: Some(NativeOAuth {
                access: value["access"].as_str().is_some_and(|v| !v.is_empty()),
                refresh: value["refresh"].as_str().is_some_and(|v| !v.is_empty()),
                expires: value["expires"].as_i64(),
                account_id: account_id(&value["metadata"]["accountID"]),
            }),
            api_key: false,
        },
        Some("api") | Some("wellknown") => NativeCredential {
            id: id.into(),
            provider: provider.into(),
            oauth: None,
            api_key: value["key"].as_str().is_some_and(|v| !v.is_empty())
                || value["token"].as_str().is_some_and(|v| !v.is_empty()),
        },
        _ => return None,
    };
    Some(credential)
}

/// Read the 2.x credential rows, or `None` when the verified 2.x store is
/// absent so callers fall back to the 1.x file.
fn read_credentials(context: &NativeContext) -> Result<Option<Vec<NativeCredential>>, String> {
    let path = credential_db_path(context)?;
    if !path.is_file() {
        return Ok(None);
    }
    crate::accounts::context::check_path(&path)?;
    let connection = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "无法读取原生凭据存储".to_owned())?;
    let table_exists = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credential'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "无法读取原生凭据存储".to_owned())?;
    if table_exists == 0 {
        return Ok(Some(vec![]));
    }
    let mut statement = connection
        .prepare("SELECT id, integration_id, value FROM credential")
        .map_err(|_| "无法读取原生凭据存储".to_owned())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "无法读取原生凭据存储".to_owned())?
        .filter_map(|row| row.ok())
        .filter_map(|(id, provider, value)| parse_credential_row(&id, &provider, &value))
        .collect();
    Ok(Some(rows))
}

fn oauth_login(oauth: &NativeOAuth, now: i64) -> NativeLogin {
    let complete = oauth.access && oauth.refresh;
    let state = if oauth.expires.is_some_and(|value| value <= now.saturating_mul(1000)) {
        AccountState::Expired
    } else if complete && oauth.expires.is_some() {
        AccountState::SignedIn
    } else {
        AccountState::Unknown
    };
    let identity = oauth.account_id.clone().map(|subject| AccountIdentity {
        subject,
        email: None,
        plan: None,
        source: "native_oauth_account_id".into(),
    });
    let detail = if state == AccountState::Expired {
        "本地认证已到期，可在 CLI 中刷新或重新登录。"
    } else if state == AccountState::Unknown {
        "发现 OAuth 记录，但认证字段不完整；请在 CLI 中检查。"
    } else if identity.is_none() {
        "已发现本地 OAuth 登录，CLI 未提供账号身份；未在线核验。"
    } else {
        "已发现本地 OAuth 登录；未在线核验服务端状态。"
    };
    NativeLogin {
        provider: String::new(),
        auth_kind: "oauth".into(),
        state,
        identity,
        detail: Some(detail.into()),
        managed_account_id: None,
    }
}

fn native_logins(credentials: &[NativeCredential], now: i64) -> Vec<NativeLogin> {
    credentials
        .iter()
        .filter_map(|credential| {
            let mut login = match &credential.oauth {
                Some(oauth) => oauth_login(oauth, now),
                None if credential.api_key => NativeLogin {
                    provider: String::new(),
                    auth_kind: "api_key".into(),
                    state: AccountState::SignedIn,
                    identity: None,
                    detail: Some("已配置原生 API Key；不是 OAuth 订阅账号，未在线核验。".into()),
                    managed_account_id: None,
                },
                None => return None,
            };
            login.provider = credential.provider.clone();
            Some(login)
        })
        .collect()
}

/// Sanitized OpenAI observation from the 2.x store. Without a verifiable
/// identity the result stays `Unknown` with the reason; identity is never
/// fabricated and no other credential kind is substituted.
fn observe_openai(context: &NativeContext, now: i64) -> Result<Observation, String> {
    let credentials = read_credentials(context)?.unwrap_or_default();
    Ok(observe_openai_credentials(&credentials, now))
}

fn observe_openai_credentials(credentials: &[NativeCredential], now: i64) -> Observation {
    let openai: Vec<&NativeCredential> = credentials
        .iter()
        .filter(|credential| credential.provider == "openai")
        .collect();
    if openai.is_empty() {
        return missing(AccountState::SignedOut, "原生上下文未登录所选提供方");
    }
    if openai.len() > 1 {
        // The native CLI picks between saved accounts interactively; Cliora
        // cannot guess which one is current without fabricating identity.
        return missing(
            AccountState::Unknown,
            "该集成保存了多个原生凭据，无法确定当前身份；请在原生 CLI 中切换或退出多余凭据。",
        );
    }
    let Some(oauth) = openai[0].oauth.as_ref() else {
        return missing(AccountState::Unknown, "当前原生认证不是 OAuth");
    };
    let Some(subject) = oauth.account_id.clone() else {
        return missing(
            AccountState::Unknown,
            "该原生 OAuth 凭据未提供账号身份，不能猜测身份",
        );
    };
    let Some(expires) = oauth.expires else {
        return missing(AccountState::Unknown, "原生 OAuth 记录缺少有效期");
    };
    if expires <= now.saturating_mul(1000) {
        return missing(
            AccountState::Expired,
            "原生令牌已过期；由原生 CLI 刷新或重新认证，Cliora 不轮换令牌",
        );
    }
    if !oauth.access || !oauth.refresh {
        return missing(AccountState::Unknown, "原生 OAuth 记录不完整");
    }
    Observation {
        state: AccountState::SignedIn,
        identity: Some(AccountIdentity {
            subject,
            email: None,
            plan: None,
            source: "native_oauth_account_id".into(),
        }),
        detail: Some("原生 OAuth 完成记录与本地有效期；未在线验证服务端撤销状态".into()),
    }
}

impl AccountAdapter for OpenCode {
    fn login_detail(&self) -> &'static str {
        "请在 OpenCode 原生登录中完成认证（1.x 在原生菜单选择提供方和登录方式，2.x 已指定 OpenAI ChatGPT OAuth）。目前独立账号核验支持 OpenAI ChatGPT OAuth；其他提供方请通过原生 CLI 管理。取消后请自行关闭终端。"
    }
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &[
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_AUTH_CONTENT",
            "OPENCODE_DB",
        ]
    }
    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        let data = native_path(home, environment, "XDG_DATA_HOME", ".local/share")?;
        let config = native_path(home, environment, "XDG_CONFIG_HOME", ".config")?;
        let root = data.join("opencode");
        let config_root = native_path(&config, environment, "OPENCODE_CONFIG_DIR", "opencode")?;
        let database = storage_override(environment)?
            .unwrap_or_else(|| root.join(CREDENTIAL_DB));
        let override_active = environment
            .get("OPENCODE_AUTH_CONTENT")
            .is_some_and(|content| {
                !content.is_empty()
                    && content.len() <= OUTPUT_LIMIT as usize
                    && serde_json::from_str::<Value>(content).is_ok()
            });
        Ok(Some(NativeContext {
            id: "native-default".into(),
            tool_id: "open_code".into(),
            auth_files: if override_active {
                vec![]
            } else {
                vec![root.join("auth.json"), database]
            },
            history_roots: vec![root.clone()],
            resource_root: config_root.clone(),
            config_root,
            root,
            environment: environment.clone(),
            remove_environment: vec![],
            cli_args: vec![],
        }))
    }
    fn discovery_needs_executable(&self) -> bool {
        false
    }
    fn discover(
        &self,
        _executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        // The verified 2.x store is authoritative once it exists; the 1.x file
        // and the 1.x environment override keep serving the 1.x line.
        if let Some(credentials) = read_credentials(context)? {
            return Ok(native_logins(&credentials, crate::accounts::now()));
        }
        if let Some(content) = context
            .environment
            .get("OPENCODE_AUTH_CONTENT")
            .filter(|value| !value.is_empty())
        {
            if content.len() > OUTPUT_LIMIT as usize {
                return Err("原生认证内容过大".into());
            }
            // Native CLI also falls back to the file when this override is invalid JSON.
            if let Ok(value) = serde_json::from_str(content) {
                return Ok(discover_records(&value, crate::accounts::now()));
            }
        }
        Ok(discover_records(
            &read_auth_file(context)?,
            crate::accounts::now(),
        ))
    }
    fn remove_environment(&self) -> &'static [&'static str] {
        &[
            "OPENCODE_AUTH_CONTENT",
            "OPENCODE_CONFIG",
            "OPENCODE_CONFIG_CONTENT",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_DB",
            "OPENCODE_TEST_HOME",
        ]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = ("openai", "1.18.34 / 2.0.29", true,
            "仅内置 OpenAI ChatGPT OAuth：同时隔离 XDG data/config/state/cache；1.x 以原生 auth.json、2.x 以原生 SQLite 凭据库的 accountId 核验本地身份。其他提供方未核验。", "OpenCode native OpenAI OAuth accountId");
        AccountCapability {
            browser_link: false,
            tool_id: "open_code",
            provider,
            version,
            managed_login: supported,
            import_native: false,
            methods: if !supported {
                vec![]
            } else {
                vec!["browser"]
            },
            reason,
            identity_source: identity,
            identity_required: true,
            refresh_owner: "native_cli",
            acceptance: "源码/协议与隔离合成回归；真实授权账号及跨平台尚未验收",
        }
    }
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        // Two verified install lines; the shared account gate accepts either family.
        crate::adapters::version::VersionPolicy::same_majors(&["1.18.34", "2.0.29"])
    }
    fn context(&self, root: PathBuf, id: String) -> Result<NativeContext, String> {
        let mut environment = BTreeMap::new();
        let cli_args = vec![];

        for (key, directory) in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
        ] {
            environment.insert(
                key.into(),
                root.join(directory).to_string_lossy().into_owned(),
            );
        }
        let config_root = root.join("config/opencode");
        environment.insert(
            "OPENCODE_CONFIG_DIR".into(),
            config_root.to_string_lossy().into_owned(),
        );
        let auth_files = vec![
            root.join("data/opencode/auth.json"),
            root.join("data/opencode").join(CREDENTIAL_DB),
        ];
        let history_roots = vec![root.join("data/opencode")];

        Ok(NativeContext {
            id,
            tool_id: "open_code".into(),
            root,
            resource_root: config_root.clone(),
            config_root,
            auth_files,
            history_roots,
            environment,
            remove_environment: vec![],
            cli_args,
        })
    }
    fn private_directories(&self, context: &NativeContext) -> Vec<PathBuf> {
        ["config", "data", "state", "cache"]
            .into_iter()
            .map(|d| context.root.join(d))
            .collect()
    }
    fn npm_entry(&self) -> Option<&'static str> {
        Some("node_modules/opencode-ai/bin/opencode.exe")
    }
    fn npm_entry_for_version(&self, version: Option<&str>) -> Option<&'static str> {
        // The shim entry follows the installed line; an unidentified version
        // resolves no entry instead of guessing the 1.x layout.
        super::install_line(version).and_then(|line| line.npm_entry)
    }
    fn observe(&self, _executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        self.observe_for_version(Path::new(""), context, None)
    }
    fn observe_for_version(
        &self,
        _executable: &Path,
        context: &NativeContext,
        version: Option<&str>,
    ) -> Result<Observation, String> {
        match super::install_line(version).map(|line| line.major) {
            Some(1) => Ok(parse_oauth_record(
                &read_auth_file(context)?,
                "openai",
                crate::accounts::now(),
            )),
            Some(2) => observe_openai(context, crate::accounts::now()),
            // Unknown version: the verified 2.x store is authoritative when
            // present, otherwise the 1.x file keeps its current meaning.
            _ => match read_credentials(context)? {
                Some(credentials) => Ok(observe_openai_credentials(
                    &credentials,
                    crate::accounts::now(),
                )),
                None => Ok(parse_oauth_record(
                    &read_auth_file(context)?,
                    "openai",
                    crate::accounts::now(),
                )),
            },
        }
    }
    fn login_args(&self, _method: &str) -> Result<Vec<String>, String> {
        // Keep the terminal interactive: OpenCode owns provider/method selection.
        Ok((vec!["auth", "login", "--pure"])
        .into_iter()
        .map(str::to_owned)
        .collect())
    }
    fn login_args_for_version(
        &self,
        version: Option<&str>,
        method: &str,
    ) -> Result<Vec<String>, String> {
        if super::install_line(version).is_some_and(|line| line.major == 2) {
            // Verified 2.x surface: the target and method pin the OpenAI
            // ChatGPT OAuth flow, and --standalone keeps the isolated context
            // off the shared background-service port. The 1.x menu flow stays
            // on login_args.
            return Ok(["auth", "login", "openai", "--method", "chatgpt-browser", "--standalone"]
                .into_iter()
                .map(str::to_owned)
                .collect());
        }
        self.login_args(method)
    }
    fn logout_args(&self) -> Vec<String> {
        (vec!["auth", "logout", "openai", "--pure"])
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
    fn logout_for_version(
        &self,
        executable: &Path,
        context: &NativeContext,
        version: Option<&str>,
    ) -> Result<(), String> {
        if super::install_line(version).is_some_and(|line| line.major == 2) {
            // Verified 2.x surface: non-interactive logout must name the saved
            // credential; without one the context is already signed out and
            // the following observation confirms it.
            let credentials = read_credentials(context)?.unwrap_or_default();
            for credential in credentials
                .iter()
                .filter(|credential| credential.provider == "openai")
            {
                let args = ["auth", "logout", "openai", &credential.id, "--standalone"];
                if !crate::accounts::native::run(executable, context, &args)?.0 {
                    return Err("原生退出命令失败，请重新检查账号状态".into());
                }
            }
            return Ok(());
        }
        self.logout(executable, context)
    }
    fn validate_documents(&self, documents: &[Value]) -> Result<(), String> {
        for value in documents {
            if value
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| !model.starts_with("openai/"))
                || value.pointer("/provider/openai/options/apiKey").is_some()
                || value.pointer("/provider/openai/options/baseURL").is_some()
            {
                return Err("原生配置含与所选 OAuth 账号冲突的供应商或认证设置，请修改后重新应用；未回退到 API Key".into());
            }
        }
        if !documents.iter().any(|v| {
            v.get("model")
                .and_then(Value::as_str)
                .is_some_and(|m| m.starts_with("openai/"))
        }) {
            return Err("OpenCode OAuth 需要显式配置 openai/ 模型，未回退到其他提供方".into());
        }
        Ok(())
    }
    fn prepare_documents(&self, documents: &mut BTreeMap<String, Value>) -> Result<(), String> {
        let settings = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        if !settings
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|m| m.starts_with("openai/"))
        {
            return Err(
                "此账号仅支持 OpenCode 的 OpenAI 模型，请在配置中设置 model 为 openai/模型名称"
                    .into(),
            );
        }
        Ok(())
    }
}
