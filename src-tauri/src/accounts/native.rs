use super::{AccountIdentity, AccountState, NativeContext, Observation};
use crate::{
    database::Database,
    native::{
        adapter::{self, Scope},
        adapters::Registry,
    },
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 64 * 1024;
static ACTIVE_PROBES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct ProbePermit;
impl ProbePermit {
    fn acquire() -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        ACTIVE_PROBES
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 4).then_some(n + 1)
            })
            .map(|_| Self)
            .map_err(|_| "原生身份检查正在进行，请稍后重试".into())
    }
}
impl Drop for ProbePermit {
    fn drop(&mut self) {
        ACTIVE_PROBES.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub fn executable(db: &Database, home: &Path, tool: &str) -> Result<PathBuf, String> {
    use rusqlite::OptionalExtension;
    let custom: Option<String> = db.with_connection(|conn| {
        conn.query_row(
            "SELECT path FROM installation_choices WHERE tool=?1",
            [tool],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "无法读取 CLI 安装选择".to_owned())
    })?;
    let probe = adapter::probe_registered(
        &Registry::builtins(),
        tool,
        custom.as_deref().map(Path::new),
        home,
        None,
        Scope::Global,
    )?;
    let selected = probe.selected_path.ok_or("未找到可核验的 CLI 安装")?;
    let expected = crate::native::adapters::accounts::capability(tool).ok_or("未知 CLI")?;
    let version = probe
        .installations
        .iter()
        .find(|item| item.path == selected)
        .and_then(|item| item.version.as_deref())
        .ok_or("无法核验 CLI 版本")?;
    if version != expected.version {
        return Err(format!(
            "当前账号适配已核对 {} {}；安装版本 {} 尚未核验",
            tool, expected.version, version
        ));
    }
    Ok(PathBuf::from(selected))
}

pub fn command(
    executable: &Path,
    context: &NativeContext,
    args: &[&str],
) -> Result<Command, String> {
    let mut executable = executable.to_path_buf();
    #[cfg(windows)]
    if executable
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
    {
        let script = executable.with_extension("ps1");
        if !script.is_file() {
            return Err("后台身份检查需要原生可执行文件或 PowerShell 入口".into());
        }
        executable = script;
    }
    let mut command = if executable
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ps1"))
    {
        // npm's PowerShell pipeline buffers stdin and cannot carry a duplex JSON
        // protocol. Resolve only the known, version-probed npm entry adjacent to
        // that exact shim; never shell-evaluate or guess a different installation.
        let relative = match context.tool_id.as_str() {
            "codex" => "node_modules/@openai/codex/bin/codex.js",
            "claude_code" => "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
            "pi" => "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            "open_code" => "node_modules/opencode-ai/bin/opencode.exe",
            _ => return Err("此 CLI 未提供后台协议入口".into()),
        };
        let directory = executable.parent().ok_or("CLI 入口缺少目录")?;
        let target = directory.join(relative);
        let mut sample = String::new();
        fs::File::open(&executable)
            .map_err(|_| "无法检查 CLI 入口")?
            .take(16384)
            .read_to_string(&mut sample)
            .map_err(|_| "无法检查 CLI 入口")?;
        if !sample.replace('\\', "/").contains(relative) || !target.is_file() {
            return Err(
                "此 PowerShell 入口不是已核验的 npm 原生入口；请为后台账号协议选择原生可执行文件"
                    .into(),
            );
        }
        if target.extension().is_some_and(|e| e == "js") {
            let node = std::iter::once(directory.to_path_buf())
                .chain(crate::process_environment::directories())
                .map(|dir| dir.join("node.exe"))
                .find(|path| path.is_file())
                .ok_or("npm 原生入口缺少 Node.js")?;
            let mut result = crate::background_process::command(node);
            result.arg(target);
            result
        } else {
            crate::background_process::command(target)
        }
    } else {
        crate::background_process::command(&executable)
    };
    context.apply_to_command(&mut command)?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .args(&context.cli_args)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    Ok(command)
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = crate::background_process::command("/bin/kill")
                .args(["-KILL", &format!("-{}", self.0.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(windows)]
        {
            if self.0.try_wait().ok().flatten().is_none() {
                if let Some(system) = std::env::var_os("SystemRoot") {
                    let _ = crate::background_process::command(
                        PathBuf::from(system).join("System32/taskkill.exe"),
                    )
                    .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                }
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run(
    executable: &Path,
    context: &NativeContext,
    args: &[&str],
) -> Result<(bool, Vec<u8>), String> {
    let _permit = ProbePermit::acquire()?;
    let mut process = Process(
        command(executable, context, args)?
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "无法启动原生身份检查")?,
    );
    let stdout = process.0.stdout.take().ok_or("无法读取身份检查输出")?;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = vec![];
        let result = stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes);
        let _ = tx.send((result, bytes));
    });
    let (read, bytes) = rx
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "原生身份检查超时")?;
    read.map_err(|_| "原生身份检查输出中断")?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("原生身份检查输出超限".into());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = process.0.try_wait().map_err(|_| "原生身份检查中断")? {
            break status;
        }
        if Instant::now() > deadline {
            return Err("原生身份检查未退出".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    Ok((status.success(), bytes))
}

fn output(executable: &Path, context: &NativeContext, args: &[&str]) -> Result<Value, String> {
    let (success, bytes) = run(executable, context, args)?;
    // Native signed-out checks may intentionally return a nonzero exit status.
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "原生身份检查返回格式不兼容")?;
    if !success
        && value["loggedIn"] != false
        && value["status"] != "not_ready"
        && value["status"] != "invalid"
    {
        return Err("原生身份检查执行失败".into());
    }
    Ok(value)
}

/// Native account/read explicitly avoids refresh. Other methods retain native ownership.
pub fn codex_read(
    executable: &Path,
    context: &NativeContext,
    method: &str,
) -> Result<Value, String> {
    codex_exchange(executable, context, method, None, None)
}

/// Query and bracket the result with identity checks in the same native process.
/// No OAuth token is copied into Cliora or independently refreshed.
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

fn email(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() <= 254
        && text.contains('@')
        && !text.chars().any(char::is_control)
        && !text.contains(' '))
    .then(|| text.to_owned())
}
fn account_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.len() <= 128
        && !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| text.to_owned())
}
fn safe_plan(value: &Value) -> Option<String> {
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
fn missing(state: AccountState, detail: &str) -> Observation {
    Observation {
        state,
        identity: None,
        detail: Some(detail.into()),
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

pub fn read_auth_file(context: &NativeContext) -> Result<Value, String> {
    let path = context.auth_files.first().ok_or("认证文件未定义")?;
    super::context::check_path(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("无法读取原生认证文件".into()),
    };
    let mut bytes = vec![];
    file.take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取原生认证文件")?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err("原生认证文件过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "原生认证文件格式不兼容".into())
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

pub fn observe(executable: &Path, context: &NativeContext) -> Result<Observation, String> {
    match context.tool_id.as_str() {
        "codex" => Ok(parse_codex(&codex_read(
            executable,
            context,
            "account/read",
        )?)),
        "claude_code" => Ok(parse_claude(&output(
            executable,
            context,
            &["auth", "status", "--json"],
        )?)),
        "pi" => {
            let observation =
                parse_oauth_record(&read_auth_file(context)?, "openai-codex", super::now());
            if observation.state != AccountState::SignedIn {
                return Ok(observation);
            }
            let value = output(
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
        "open_code" => Ok(parse_oauth_record(
            &read_auth_file(context)?,
            "openai",
            super::now(),
        )),
        _ => Err("此 CLI 未提供可核验身份检查".into()),
    }
}

pub fn login_args(tool: &str, method: &str) -> Result<Vec<String>, String> {
    let capability = crate::native::adapters::accounts::capability(tool).ok_or("未知 CLI")?;
    if !capability.managed_login || !capability.methods.contains(&method) {
        return Err(capability.reason.into());
    }
    Ok(match tool {
        "codex" => {
            if method == "device" {
                vec!["login", "--device-auth"]
            } else {
                vec!["login"]
            }
        }
        "claude_code" => vec!["auth", "login", "--claudeai"],
        "pi" => vec![
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ],
        "open_code" => vec![
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
        ],
        _ => return Err("此 CLI 尚未提供受管登录".into()),
    }
    .into_iter()
    .map(str::to_owned)
    .collect())
}

pub fn logout_args(tool: &str) -> Vec<String> {
    match tool {
        "codex" => vec!["logout"],
        "claude_code" => vec!["auth", "logout"],
        "open_code" => vec!["auth", "logout", "openai", "--pure"],
        "pi" => vec![
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
        ],
        _ => vec![],
    }
    .into_iter()
    .map(str::to_owned)
    .collect()
}

pub fn perform_logout(executable: &Path, context: &NativeContext) -> Result<Observation, String> {
    if context.tool_id == "codex" {
        codex_read(executable, context, "account/logout")?;
    } else if context.tool_id == "claude_code" || context.tool_id == "open_code" {
        let args = logout_args(&context.tool_id);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if !run(executable, context, &args)?.0 {
            return Err("原生退出命令失败，请重新检查账号状态".into());
        }
    } else {
        return Err("此 CLI 需要在原生终端完成退出".into());
    }
    let observation = observe(executable, context)?;
    if observation.state != AccountState::SignedOut {
        return Err("原生退出后仍检测到认证材料，请重新检查状态".into());
    }
    Ok(observation)
}
