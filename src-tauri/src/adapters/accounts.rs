//! Object-safe native account port. Lifecycle and process policy stay in accounts services.
use crate::accounts::{
    AccountCapability, AccountIdentity, AccountState, NativeContext, NativeLogin, Observation,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub trait AccountAdapter: Sync {
    /// CLI prints a URL but does not launch a browser. Streaming bridge is Windows-only.
    fn browser_login_endpoint(&self) -> Option<&'static str> { None }
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &[]
    }
    fn native_context(
        &self,
        _home: &Path,
        _environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        Ok(None)
    }
    fn discovery_needs_executable(&self) -> bool {
        true
    }
    fn discover(
        &self,
        executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        let observation = self.observe(executable.ok_or("未找到可核验的 CLI 安装")?, context)?;
        Ok(vec![NativeLogin {
            provider: self.capability().provider.into(),
            auth_kind: "oauth".into(),
            state: observation.state,
            identity: observation.identity,
            detail: observation.detail,
            managed_account_id: None,
        }])
    }
    fn version_policy(&self) -> super::version::VersionPolicy {
        super::version::VersionPolicy::same_major(self.capability().version)
    }
    fn remove_environment(&self) -> &'static [&'static str] {
        &[]
    }
    fn private_directories(&self, _context: &NativeContext) -> Vec<PathBuf> {
        vec![]
    }
    fn capability(&self) -> AccountCapability;
    fn context(&self, _root: PathBuf, _id: String) -> Result<NativeContext, String> {
        Err(self.capability().reason.into())
    }
    fn npm_entry(&self) -> Option<&'static str> {
        None
    }
    fn observe(&self, _executable: &Path, _context: &NativeContext) -> Result<Observation, String> {
        Err(self.capability().reason.into())
    }
    fn login_args(&self, _method: &str) -> Result<Vec<String>, String> {
        Err(self.capability().reason.into())
    }
    fn logout_args(&self) -> Vec<String> {
        vec![]
    }
    fn logout(&self, executable: &Path, context: &NativeContext) -> Result<(), String> {
        let args = self.logout_args();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if self.terminal_logout() {
            return Err("此 CLI 需要在原生终端完成退出".into());
        }
        if !crate::accounts::native::run(executable, context, &args)?.0 {
            return Err("原生退出命令失败，请重新检查账号状态".into());
        }
        Ok(())
    }
    fn terminal_logout(&self) -> bool {
        false
    }
    fn login_detail(&self) -> &'static str {
        "请在隔离终端完成原生登录。取消只停止接纳结果，终端仍由用户控制。"
    }
    fn logout_detail(&self) -> &'static str {
        "正在所选上下文执行原生退出；本地核验前账号不可启动。未撤销服务端其他设备。"
    }
    fn prepare_documents(&self, _documents: &mut BTreeMap<String, Value>) -> Result<(), String> {
        Ok(())
    }
    fn validate_documents(&self, _documents: &[Value]) -> Result<(), String> {
        Ok(())
    }
    fn native_root(&self, _home: &Path) -> Result<PathBuf, String> {
        Err("此 CLI 不支持纳入默认原生账号".into())
    }
}

pub(crate) fn native_path(
    home: &Path,
    environment: &BTreeMap<String, String>,
    key: &str,
    fallback: &str,
) -> Result<PathBuf, String> {
    let path = environment
        .get(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(fallback));
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("原生登录目录必须是绝对路径且不能包含上级目录".into());
    }
    Ok(path)
}

/// Local credential presence is not a verified managed identity. Never emit raw records.
pub(crate) fn discover_records(value: &Value, now: i64) -> Vec<NativeLogin> {
    let Some(records) = value.as_object() else {
        return vec![];
    };
    records
        .iter()
        .filter_map(|(provider, auth)| {
            if provider.is_empty()
                || provider.len() > 80
                || !provider
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_./:".contains(&b))
            {
                return None;
            }
            let kind = auth["type"].as_str()?;
            let (state, detail, identity) = match kind {
                "oauth" => {
                    let complete = auth["access"].as_str().is_some_and(|v| !v.is_empty())
                        && auth["refresh"].as_str().is_some_and(|v| !v.is_empty());
                    let expires = auth["expires"].as_i64();
                    let state = if expires.is_some_and(|v| v <= now.saturating_mul(1000)) {
                        AccountState::Expired
                    } else if complete && expires.is_some() {
                        AccountState::SignedIn
                    } else {
                        AccountState::Unknown
                    };
                    let identity = account_id(&auth["accountId"]).map(|subject| AccountIdentity {
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
                    (state, detail, identity)
                }
                "api" | "api_key" if auth["key"].as_str().is_some_and(|v| !v.is_empty()) => (
                    AccountState::SignedIn,
                    "已配置原生 API Key；不是 OAuth 订阅账号，未在线核验。",
                    None,
                ),
                _ => return None,
            };
            Some(NativeLogin {
                provider: provider.clone(),
                auth_kind: if kind == "oauth" { "oauth" } else { "api_key" }.into(),
                state,
                identity,
                detail: Some(detail.into()),
                managed_account_id: None,
            })
        })
        .collect()
}

pub fn get(tool: &str) -> Result<&'static dyn AccountAdapter, String> {
    get_registered(&super::Registry::builtins(), tool)
}
pub fn get_registered(
    registry: &super::Registry,
    tool: &str,
) -> Result<&'static dyn AccountAdapter, String> {
    registry
        .get(tool)
        .and_then(|a| a.accounts())
        .ok_or_else(|| "此 CLI 未提供此能力适配".into())
}
pub fn capability(tool: &str) -> Option<AccountCapability> {
    get(tool).ok().map(|a| a.capability())
}
pub fn capabilities() -> Vec<AccountCapability> {
    capabilities_registered(&super::Registry::builtins())
}
pub fn capabilities_registered(registry: &super::Registry) -> Vec<AccountCapability> {
    registry
        .iter()
        .filter_map(|a| a.accounts())
        .map(|a| a.capability())
        .collect()
}
pub(crate) fn email(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() <= 254
        && text.contains('@')
        && !text.chars().any(char::is_control)
        && !text.contains(' '))
    .then(|| text.to_owned())
}

pub(crate) fn account_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() <= 128
        && !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| text.to_owned())
}

pub(crate) fn safe_plan(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    [
        "free",
        "plus",
        "pro",
        "team",
        "business",
        "enterprise",
        "edu",
        "max",
        "claude_pro",
        "claude_max",
    ]
    .contains(&text)
    .then(|| text.to_owned())
}

pub(crate) fn missing(state: AccountState, detail: &str) -> Observation {
    Observation {
        state,
        identity: None,
        detail: Some(detail.into()),
    }
}

pub fn parse_oauth_record(value: &Value, provider: &str, now: i64) -> Observation {
    let Some(auth) = value.get(provider) else {
        return missing(AccountState::SignedOut, "原生上下文未登录所选提供方");
    };
    if auth["type"] != "oauth" {
        return missing(AccountState::Unknown, "当前原生认证不是 OAuth");
    }
    let Some(subject) = account_id(&auth["accountId"]) else {
        return missing(
            AccountState::Unknown,
            "该原生 OAuth 记录未提供 accountId，不能猜测身份",
        );
    };
    let Some(expires) = auth["expires"].as_i64() else {
        return missing(AccountState::Unknown, "原生 OAuth 记录缺少有效期");
    };
    if expires <= now.saturating_mul(1000) {
        return missing(
            AccountState::Expired,
            "原生令牌已过期；由原生 CLI 刷新或重新认证，Cliora 不轮换令牌",
        );
    }
    if !auth["access"].as_str().is_some_and(|v| !v.is_empty())
        || !auth["refresh"].as_str().is_some_and(|v| !v.is_empty())
    {
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
