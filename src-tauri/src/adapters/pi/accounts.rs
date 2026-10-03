use super::Pi;
use crate::accounts::native::*;
use crate::accounts::{AccountCapability, AccountState, NativeContext, NativeLogin, Observation};
use crate::adapters::accounts::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

impl AccountAdapter for Pi {
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        super::version_policy()
    }
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &["PI_CODING_AGENT_DIR"]
    }
    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        self.context(
            native_path(home, environment, "PI_CODING_AGENT_DIR", ".pi/agent")?,
            "native-default".into(),
        )
        .map(Some)
    }
    fn discovery_needs_executable(&self) -> bool {
        false
    }
    fn discover(
        &self,
        _executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        Ok(discover_records(
            &read_auth_file(context)?,
            crate::accounts::now(),
        ))
    }
    fn remove_environment(&self) -> &'static [&'static str] {
        &["PI_CODING_AGENT_DIR"]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = ("openai-codex", "1.0.0", true,
            "仅 openai-codex OAuth：PI_CODING_AGENT_DIR/auth.json 的原生 accountId 与无刷新 auth check；在终端执行 /login。其他提供方身份格式尚未核验。", "Pi native OAuth accountId + auth check --no-refresh");
        AccountCapability {
            browser_link: false,
            tool_id: "pi",
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
            "PI_CODING_AGENT_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        let auth_files = vec![root.join("auth.json")];
        let history_roots = vec![root.join("sessions")];

        Ok(NativeContext {
            id,
            tool_id: "pi".into(),
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
        Some("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
    }
    fn observe(&self, executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        {
            let observation = parse_oauth_record(
                &read_auth_file(context)?,
                "openai-codex",
                crate::accounts::now(),
            );
            if observation.state != AccountState::SignedIn {
                return Ok(observation);
            }
            let (success, value) = output(
                executable,
                context,
                &[
                    "auth",
                    "check",
                    "--provider",
                    "openai-codex",
                    "--json",
                    "--no-refresh",
                ],
            )?;
            if !success && value["status"] != "not_ready" && value["status"] != "invalid" {
                return Err("原生身份检查执行失败".into());
            }
            if value["status"] == "ready"
                && value["authType"] == "oauth"
                && value["provider"] == "openai-codex"
            {
                Ok(observation)
            } else {
                Ok(missing(
                    AccountState::Unknown,
                    "Pi 原生无刷新检查未确认 OAuth 可用",
                ))
            }
        }
    }
    fn login_args(&self, _method: &str) -> Result<Vec<String>, String> {
        Ok((vec![
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ])
        .into_iter()
        .map(str::to_owned)
        .collect())
    }
    fn logout_args(&self) -> Vec<String> {
        (vec![
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ])
        .into_iter()
        .map(str::to_owned)
        .collect()
    }
    fn validate_documents(&self, documents: &[Value]) -> Result<(), String> {
        for value in documents {
            if value
                .get("defaultProvider")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|provider| provider != "openai-codex")
            {
                return Err("原生配置含与所选 OAuth 账号冲突的供应商或认证设置，请修改后重新应用；未回退到 API Key".into());
            }
        }
        Ok(())
    }
    fn prepare_documents(&self, documents: &mut BTreeMap<String, Value>) -> Result<(), String> {
        let settings = documents
            .entry("settings".into())
            .or_insert_with(|| json!({}));
        settings["defaultProvider"] = json!("openai-codex");
        Ok(())
    }
    fn terminal_logout(&self) -> bool {
        true
    }
    fn login_detail(&self) -> &'static str {
        "请在隔离终端执行 /login 并选择 openai-codex。取消只停止接纳结果，终端仍由用户控制。"
    }
    fn logout_detail(&self) -> &'static str {
        "请在此账号终端执行 /logout 并选择 openai-codex；完成前账号不可启动。只影响所选上下文。"
    }
}
