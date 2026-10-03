use super::{AccountState, NativeContext, Observation};
use crate::adapters::Registry;
use crate::{
    database::Database,
    native::adapter::{self, Scope},
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub(crate) const OUTPUT_LIMIT: u64 = 64 * 1024;
static ACTIVE_PROBES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
pub(crate) struct ProbePermit;
impl ProbePermit {
    pub(crate) fn acquire() -> Result<Self, String> {
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
    let account_adapter = crate::adapters::accounts::get(tool)?;
    let expected = account_adapter.capability();
    let policy = account_adapter.version_policy();
    let version = probe
        .installations
        .iter()
        .find(|item| item.path == selected)
        .and_then(|item| item.version.as_deref())
        .ok_or("无法核验 CLI 版本")?;
    if !policy.accepts(version) {
        return Err(format!(
            "当前账号适配参考 {} {}；安装版本 {} 不满足原生契约范围",
            tool, expected.version, version
        ) + &format!("（{}）；请使用兼容版本或更新适配器", policy.requirement));
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
        let relative = crate::adapters::accounts::get(&context.tool_id)?
            .npm_entry()
            .ok_or("此 CLI 未提供后台协议入口")?;
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

pub(crate) struct Process(pub(crate) Child);
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

pub(crate) fn run(
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

pub(crate) fn output(
    executable: &Path,
    context: &NativeContext,
    args: &[&str],
) -> Result<(bool, Value), String> {
    let (success, bytes) = run(executable, context, args)?;
    let value = serde_json::from_slice(&bytes).map_err(|_| "原生身份检查返回格式不兼容")?;
    Ok((success, value))
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

pub fn observe(executable: &Path, context: &NativeContext) -> Result<Observation, String> {
    crate::adapters::accounts::get(&context.tool_id)?.observe(executable, context)
}

pub fn login_args(tool: &str, method: &str) -> Result<Vec<String>, String> {
    let adapter = crate::adapters::accounts::get(tool)?;
    let cap = adapter.capability();
    if !cap.managed_login || !cap.methods.contains(&method) {
        return Err(cap.reason.into());
    }
    adapter.login_args(method)
}

pub fn logout_args(tool: &str) -> Vec<String> {
    crate::adapters::accounts::get(tool)
        .map(|a| a.logout_args())
        .unwrap_or_default()
}

pub(crate) fn validated_login_url(tool: &str, value: &str) -> Result<String, String> {
    let endpoint = crate::adapters::accounts::get(tool)?.browser_login_endpoint().ok_or("此 CLI 不支持授权页面重试")?;
    let value = value.trim().trim_start_matches('\u{feff}');
    let parsed = url::Url::parse(&crate::external::validated_url(value)?).map_err(|_| "授权链接格式无效")?;
    let expected = url::Url::parse(endpoint).map_err(|_| "授权适配器无效")?;
    if parsed.origin() != expected.origin() || parsed.path() != expected.path() || parsed.fragment().is_some() {
        return Err("授权链接不属于当前 CLI 登录流程".into());
    }
    Ok(parsed.into())
}

pub fn login_url(db: &Database, id: &str, attempt: &str) -> Result<String, String> {
    let account = super::get(db, id)?;
    let pending = account.pending_login.as_ref().filter(|pending| pending.id == attempt && pending.operation == "login" && pending.expires_at > super::now())
        .ok_or("此登录尝试已结束，请重新登录")?;
    let path = pending.context.root.join(".cliora-auth-url");
    super::context::check_path(&path)?;
    let mut value = String::new();
    fs::File::open(path).map_err(|_| "授权链接尚未生成，请等待终端显示 Go to 链接后重试")?
        .take(8193).read_to_string(&mut value).map_err(|_| "无法读取授权链接")?;
    validated_login_url(&account.tool_id, &value)
}

pub fn perform_logout(executable: &Path, context: &NativeContext) -> Result<Observation, String> {
    crate::adapters::accounts::get(&context.tool_id)?.logout(executable, context)?;
    let observation = observe(executable, context)?;
    if observation.state != AccountState::SignedOut {
        return Err("原生退出后仍检测到认证材料，请重新检查状态".into());
    }
    Ok(observation)
}
