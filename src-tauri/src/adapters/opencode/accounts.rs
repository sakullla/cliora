use super::OpenCode;
use crate::accounts::native::*;
use crate::accounts::{AccountCapability, NativeContext, NativeLogin, Observation};
use crate::adapters::accounts::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

impl AccountAdapter for OpenCode {
    fn browser_login_endpoint(&self) -> Option<&'static str> {
        Some("https://auth.openai.com/oauth/authorize")
    }
    fn login_detail(&self) -> &'static str {
        "请在隔离终端完成原生登录。浏览器授权页会尝试自动打开；未打开时，可在账号卡片点击“打开授权页面”，或复制终端中的 Go to 链接。取消后请自行关闭终端。"
    }
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &[
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "OPENCODE_CONFIG_DIR",
            "OPENCODE_AUTH_CONTENT",
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
                vec![root.join("auth.json")]
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
            "OPENCODE_TEST_HOME",
        ]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = ("openai", "1.18.34", true,
            "仅内置 OpenAI ChatGPT OAuth：同时隔离 XDG data/config/state/cache；原生 auth.json 的 accountId 核验本地身份。其他提供方未核验。", "OpenCode native OpenAI OAuth accountId");
        AccountCapability {
            browser_link: cfg!(windows),
            tool_id: "open_code",
            provider,
            version,
            managed_login: supported,
            import_native: false,
            methods: if !supported {
                vec![]
            } else {
                vec!["browser", "device"]
            },
            reason,
            identity_source: identity,
            refresh_owner: "native_cli",
            acceptance: "源码/协议与隔离合成回归；真实授权账号及跨平台尚未验收",
        }
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
        let auth_files = vec![root.join("data/opencode/auth.json")];
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
    fn observe(&self, _executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        Ok(parse_oauth_record(
            &read_auth_file(context)?,
            "openai",
            crate::accounts::now(),
        ))
    }
    fn login_args(&self, method: &str) -> Result<Vec<String>, String> {
        Ok((vec![
            "auth",
            "login",
            "--pure",
            "--provider",
            "openai",
            "--method",
            if method == "device" {
                "ChatGPT Pro/Plus (headless)"
            } else {
                "ChatGPT Pro/Plus (browser)"
            },
        ])
        .into_iter()
        .map(str::to_owned)
        .collect())
    }
    fn logout_args(&self) -> Vec<String> {
        (vec!["auth", "logout", "openai", "--pure"])
            .into_iter()
            .map(str::to_owned)
            .collect()
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
