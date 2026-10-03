use super::Codex;
use crate::accounts::native::*;
use crate::accounts::NativeLogin;
use crate::accounts::{
    AccountCapability, AccountIdentity, AccountState, NativeContext, Observation,
};
use crate::adapters::accounts::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::Stdio,
    sync::mpsc,
    time::{Duration, Instant},
};

impl AccountAdapter for Codex {
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &["CODEX_HOME"]
    }
    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        let mut context = self.context(
            native_path(home, environment, "CODEX_HOME", ".codex")?,
            "native-default".into(),
        )?;
        // Read the actual native store (including keyring), not the managed file-store override.
        context.cli_args.clear();
        Ok(Some(context))
    }
    fn discover(
        &self,
        executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        let value = codex_read(
            executable.ok_or("未找到可核验的 CLI 安装")?,
            context,
            "account/read",
        )?;
        let observation = parse_codex(&value);
        let api_key = value.pointer("/account/type").and_then(Value::as_str) == Some("apiKey");
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
                Some("已配置原生 API Key；不是 ChatGPT OAuth 订阅账号，未在线核验。".into())
            } else {
                observation.detail
            },
            managed_account_id: None,
        }])
    }
    fn remove_environment(&self) -> &'static [&'static str] {
        &[
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "CODEX_API_KEY",
            "CODEX_HOME",
            "CODEX_AUTH_JSON",
            "CODEX_CI_API_KEY",
        ]
    }
    fn capability(&self) -> AccountCapability {
        let (provider, version, supported, reason, identity) = ("chatgpt", "0.160.0", true,
            "CODEX_HOME 独立目录；强制 file 认证存储；account/read 核验 ChatGPT 身份。明确纳入默认目录时不复制令牌，退出会影响使用该目录的普通终端。", "Codex App Server account/read");
        AccountCapability {
            browser_link: false,
            tool_id: "codex",
            provider,
            version,
            managed_login: supported,
            import_native: supported,
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

        let config_root = root.clone();
        environment.insert("CODEX_HOME".into(), root.to_string_lossy().into_owned());
        let cli_args = vec!["-c".into(), "cli_auth_credentials_store=\"file\"".into()];
        let auth_files = vec![root.join("auth.json")];
        let history_roots = vec![root.join("sessions"), root.join("archived_sessions")];

        Ok(NativeContext {
            id,
            tool_id: "codex".into(),
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
        Some("node_modules/@openai/codex/bin/codex.js")
    }
    fn observe(&self, executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        Ok(parse_codex(&codex_read(
            executable,
            context,
            "account/read",
        )?))
    }
    fn login_args(&self, method: &str) -> Result<Vec<String>, String> {
        Ok(({
            if method == "device" {
                vec!["login", "--device-auth"]
            } else {
                vec!["login"]
            }
        })
        .into_iter()
        .map(str::to_owned)
        .collect())
    }
    fn logout_args(&self) -> Vec<String> {
        (vec!["logout"]).into_iter().map(str::to_owned).collect()
    }
    fn validate_documents(&self, documents: &[Value]) -> Result<(), String> {
        for value in documents {
            if value
                .get("model_provider")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|provider| provider != "openai")
                || value
                    .get("forced_login_method")
                    .and_then(serde_json::Value::as_str)
                    == Some("api")
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
        settings["model_provider"] = json!("openai");
        settings["cli_auth_credentials_store"] = json!("file");
        Ok(())
    }
    fn logout(&self, executable: &Path, context: &NativeContext) -> Result<(), String> {
        codex_read(executable, context, "account/logout")?;
        Ok(())
    }
    fn native_root(&self, home: &Path) -> Result<PathBuf, String> {
        Ok(std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex")))
    }
}

pub fn codex_read(
    executable: &Path,
    context: &NativeContext,
    method: &str,
) -> Result<Value, String> {
    codex_exchange(executable, context, method, None, None)
}

pub fn codex_quota(
    executable: &Path,
    context: &NativeContext,
    subject: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Value, String> {
    codex_exchange(
        executable,
        context,
        "account/rateLimits/read",
        Some(subject),
        Some(cancel),
    )
}

fn codex_exchange(
    executable: &Path,
    context: &NativeContext,
    method: &str,
    quota_subject: Option<&str>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Value, String> {
    let _permit = ProbePermit::acquire()?;
    if !matches!(
        method,
        "account/read" | "account/rateLimits/read" | "account/logout"
    ) {
        return Err("不允许的账号协议方法".into());
    }
    let mut process = Process(
        command(executable, context, &["app-server"])?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "无法启动 Codex 账号服务")?,
    );
    let stdout = process.0.stdout.take().ok_or("无法读取账号服务")?;
    let (tx, rx) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0;
        loop {
            let mut line = vec![];
            let read = (&mut reader)
                .take(OUTPUT_LIMIT + 1)
                .read_until(b'\n', &mut line);
            total += line.len();
            if read.is_err() || line.len() as u64 > OUTPUT_LIMIT || total > 1024 * 1024 {
                let _ = tx.try_send(Err("账号服务输出超限或中断".to_owned()));
                break;
            }
            if line.is_empty() {
                break;
            }
            if tx
                .try_send(
                    serde_json::from_slice::<Value>(&line)
                        .map_err(|_| "账号协议输出不兼容".to_owned()),
                )
                .is_err()
            {
                break;
            }
        }
    });
    let stdin = process.0.stdin.as_mut().ok_or("无法写入账号服务")?;
    writeln!(stdin, "{}", json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"cliora","version":"1"}}})).map_err(|_| "账号服务中断")?;
    stdin.flush().map_err(|_| "账号服务中断")?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut quota = None;
    loop {
        if cancel.is_some_and(|value| value.load(std::sync::atomic::Ordering::SeqCst)) {
            return Err("官方额度查询已取消".into());
        }
        if Instant::now() >= deadline {
            return Err("账号服务超时或中断".into());
        }
        let result = match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(value) => value?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => return Err("账号服务超时或中断".into()),
        };
        if result["id"] == 1 {
            if result.get("error").is_some() {
                return Err("Codex 初始化失败".into());
            }
            let stdin = process.0.stdin.as_mut().ok_or("账号服务中断")?;
            writeln!(stdin, "{}", json!({"method":"initialized"})).map_err(|_| "账号服务中断")?;
            let first_method = if quota_subject.is_some() {
                "account/read"
            } else {
                method
            };
            let params = if first_method == "account/read" {
                json!({"refreshToken":false})
            } else {
                Value::Null
            };
            writeln!(
                stdin,
                "{}",
                json!({"id":2,"method":first_method,"params":params})
            )
            .map_err(|_| "账号服务中断")?;
            stdin.flush().map_err(|_| "账号服务中断")?;
        }
        if result["id"] == 2 {
            if result.get("error").is_some() {
                return Err("Codex 账号接口拒绝请求，请检查登录状态".into());
            }
            if let Some(subject) = quota_subject {
                let identity = parse_codex(&result["result"]);
                if identity.state != AccountState::SignedIn
                    || identity
                        .identity
                        .as_ref()
                        .is_none_or(|id| id.subject != subject)
                {
                    return Err("官方额度账号身份已改变或未登录，请重新认证".into());
                }
                let stdin = process.0.stdin.as_mut().ok_or("账号服务中断")?;
                writeln!(stdin, "{}", json!({"id":3,"method":method}))
                    .map_err(|_| "账号服务中断")?;
                stdin.flush().map_err(|_| "账号服务中断")?;
                continue;
            }
            return result
                .get("result")
                .cloned()
                .ok_or_else(|| "账号服务缺少结果".into());
        }
        if quota_subject.is_some() && result["id"] == 3 {
            if let Some(error) = result.get("error") {
                // Inspect native errors only for classification; never expose raw data.
                let message = error["message"].as_str().unwrap_or("").to_ascii_lowercase();
                let code = error["code"].as_i64();
                return Err(if matches!(code, Some(401 | 403))
                    || message.contains("401")
                    || message.contains("403")
                    || message.contains("unauthorized")
                    || message.contains("not authenticated")
                {
                    "官方额度认证失效，请在原生 CLI 重新认证"
                } else if code == Some(429) || message.contains("429") {
                    "官方额度请求受限，请稍后刷新"
                } else {
                    "Codex 原生额度接口请求失败，未取得新数据"
                }
                .into());
            }
            quota = Some(result.get("result").cloned().ok_or("账号服务缺少结果")?);
            let stdin = process.0.stdin.as_mut().ok_or("账号服务中断")?;
            writeln!(
                stdin,
                "{}",
                json!({"id":4,"method":"account/read","params":{"refreshToken":false}})
            )
            .map_err(|_| "账号服务中断")?;
            stdin.flush().map_err(|_| "账号服务中断")?;
        }
        if let Some(subject) = quota_subject.filter(|_| result["id"] == 4) {
            let identity = parse_codex(&result["result"]);
            if result.get("error").is_some()
                || identity.state != AccountState::SignedIn
                || identity
                    .identity
                    .as_ref()
                    .is_none_or(|id| id.subject != subject)
            {
                return Err("官方额度账号身份已改变或未登录，请重新认证".into());
            }
            return quota.ok_or("账号服务缺少结果".into());
        }
    }
}

pub fn parse_codex(value: &Value) -> Observation {
    if value.get("account").is_none() {
        return missing(AccountState::Unknown, "原生状态缺少 account 字段");
    }
    let account = &value["account"];
    if account.is_null() {
        return missing(AccountState::SignedOut, "原生上下文未登录");
    }
    if account["type"] != "chatgpt" {
        return missing(AccountState::Unknown, "当前原生认证不是 ChatGPT OAuth");
    }
    let Some(email) = email(&account["email"]) else {
        return missing(AccountState::Unknown, "原生账号缺少可核验身份");
    };
    Observation {
        state: AccountState::SignedIn,
        identity: Some(AccountIdentity {
            subject: email.clone(),
            email: Some(email),
            plan: safe_plan(&account["planType"]),
            source: "codex_account_read".into(),
        }),
        detail: Some("原生本地账号状态；未发起推理或独立刷新令牌".into()),
    }
}
