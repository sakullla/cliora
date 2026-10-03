use super::Claude;
use crate::accounts::native::*;
use crate::accounts::{
    AccountCapability, AccountIdentity, AccountState, NativeContext, NativeLogin, Observation,
};
use crate::adapters::accounts::*;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

impl AccountAdapter for Claude {
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &["CLAUDE_CONFIG_DIR"]
    }
    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        self.context(
            native_path(home, environment, "CLAUDE_CONFIG_DIR", ".claude")?,
            "native-default".into(),
        )
        .map(Some)
    }
    fn discover(
        &self,
        executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        let (success, value) = output(
            executable.ok_or("未找到可核验的 CLI 安装")?,
            context,
            &["auth", "status", "--json"],
        )?;
        if !success && value["loggedIn"] != false {
            return Err("原生身份检查执行失败".into());
        }
        let observation = parse_claude(&value);
        let api_key = value["loggedIn"] == true && value["authMethod"] == "api_key";
        Ok(vec![NativeLogin {
            provider: self.capability().provider.into(),
            auth_kind: if api_key { "api_key" } else { "oauth" }.into(),
            state: if api_key {
                AccountState::SignedIn
            } else {
                observation.state
            },
            identity: observation.identity,
            detail: if api_key {
                Some("已配置原生 API Key；不是 claude.ai OAuth 订阅账号，未在线核验。".into())
            } else {
                observation.detail
            },
            managed_account_id: None,
        }])
    }
    fn remove_environment(&self) -> &'static [&'static str] {
        &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
            "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDECODE",
            "CLAUDE_CODE_SESSION_ID",
        ]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = (
            "claudeai",
            "2.1.287",
            !cfg!(target_os = "macos"),
            if cfg!(target_os = "macos") {
                "macOS Keychain 服务名随 CLAUDE_CONFIG_DIR 的隔离尚未验收，不开放受管登录。"
            } else {
                "CLAUDE_CONFIG_DIR 隔离 .credentials.json、配置与历史；auth status --json 核验 claude.ai 身份。"
            },
            "Claude auth status --json",
        );
        AccountCapability {
            browser_link: false,
            tool_id: "claude_code",
            provider,
            version,
            managed_login: supported,
            import_native: false,
            methods: if !supported { vec![] } else { vec!["browser"] },
            reason,
            identity_source: identity,
            refresh_owner: "native_cli",
            acceptance: "源码/协议与隔离合成回归；真实授权账号及跨平台尚未验收",
        }
    }
    fn context(&self, root: PathBuf, id: String) -> Result<NativeContext, String> {
        let mut environment = BTreeMap::new();
        let cli_args = vec![];

        let config_root = root.clone();
        environment.insert(
            "CLAUDE_CONFIG_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        let auth_files = vec![root.join(".credentials.json")];
        let history_roots = vec![root.join("projects")];

        Ok(NativeContext {
            id,
            tool_id: "claude_code".into(),
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
    fn npm_entry(&self) -> Option<&'static str> {
        Some("node_modules/@anthropic-ai/claude-code/bin/claude.exe")
    }
    fn observe(&self, executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        let (success, value) = output(executable, context, &["auth", "status", "--json"])?;
        if !success && value["loggedIn"] != false {
            return Err("原生身份检查执行失败".into());
        }
        Ok(parse_claude(&value))
    }
    fn login_args(&self, _method: &str) -> Result<Vec<String>, String> {
        Ok((vec!["auth", "login", "--claudeai"])
            .into_iter()
            .map(str::to_owned)
            .collect())
    }
    fn logout_args(&self) -> Vec<String> {
        (vec!["auth", "logout"])
            .into_iter()
            .map(str::to_owned)
            .collect()
    }
    fn validate_documents(&self, documents: &[Value]) -> Result<(), String> {
        for value in documents {
            if value.get("apiKeyHelper").is_some()
                || value
                    .get("env")
                    .and_then(serde_json::Value::as_object)
                    .is_some_and(|env| {
                        [
                            "ANTHROPIC_API_KEY",
                            "ANTHROPIC_AUTH_TOKEN",
                            "ANTHROPIC_BASE_URL",
                            "CLAUDE_CODE_OAUTH_TOKEN",
                            "CLAUDE_CODE_USE_BEDROCK",
                            "CLAUDE_CODE_USE_VERTEX",
                            "CLAUDE_CODE_USE_FOUNDRY",
                        ]
                        .iter()
                        .any(|key| env.contains_key(*key))
                    })
            {
                return Err("原生配置含与所选 OAuth 账号冲突的供应商或认证设置，请修改后重新应用；未回退到 API Key".into());
            }
        }
        Ok(())
    }
}

pub fn parse_claude(value: &Value) -> Observation {
    if value["loggedIn"] == false {
        return missing(AccountState::SignedOut, "原生上下文未登录");
    }
    if value["loggedIn"] != true || value["authMethod"] != "claude.ai" {
        return missing(AccountState::Unknown, "当前原生认证不是 claude.ai OAuth");
    }
    let Some(email) = email(&value["email"]) else {
        return missing(AccountState::Unknown, "原生状态未提供可核验身份");
    };
    Observation {
        state: AccountState::SignedIn,
        identity: Some(AccountIdentity {
            subject: email.clone(),
            email: Some(email),
            plan: safe_plan(&value["subscriptionType"]),
            source: "claude_auth_status".into(),
        }),
        detail: Some("原生 auth status 身份；未发起推理".into()),
    }
}
