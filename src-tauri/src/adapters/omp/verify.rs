//! Native verification case runner shared by `scripts/verify-omp-native.mjs`.
//!
//! The script owns isolation, temporary homes and the real `omp` acquisition.
//! Product behaviour is asserted here through the same registry and adapter code
//! the application uses. Each capability module supplies its own checks, so the
//! script and this dispatcher never need editing when a capability lands.
//!
//! Fixture cases are declarations, never evidence: a case only becomes native
//! evidence when the script pairs it with a real, isolated CLI observation.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::adapters::LaunchMode;

/// A check failed: the product contradicts the declared behaviour.
pub enum CaseError {
    Failed(String),
    /// The capability is not delivered yet, or the real CLI was unavailable.
    Unverified(String),
}

impl CaseError {
    pub fn message(&self) -> &str {
        match self {
            Self::Failed(message) | Self::Unverified(message) => message,
        }
    }
}

/// Isolated environment one case may inspect and run against.
#[derive(Clone, Debug)]
pub struct CaseContext {
    pub home: PathBuf,
    pub project: PathBuf,
    pub executable: Option<PathBuf>,
    pub environment: Vec<(String, String)>,
}

pub struct CommandOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CaseContext {
    /// Run the isolated executable with a bounded wait. Nothing here writes the
    /// user's home: the caller sets `home`/`project` and the environment.
    pub fn run(&self, args: &[&str], timeout: Duration) -> Result<CommandOutput, String> {
        let executable = self
            .executable
            .as_ref()
            .ok_or("隔离环境没有可运行的 omp 可执行文件")?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(&self.project)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in &self.environment {
            command.env(name, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 {}：{error}", executable.display()))?;
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut stdout = String::new();
                    let mut stderr = String::new();
                    if let Some(mut stream) = child.stdout.take() {
                        let _ = stream.read_to_string(&mut stdout);
                    }
                    if let Some(mut stream) = child.stderr.take() {
                        let _ = stream.read_to_string(&mut stderr);
                    }
                    return Ok(CommandOutput {
                        status: status.code(),
                        stdout: stdout.chars().take(64 * 1024).collect(),
                        stderr: stderr.chars().take(64 * 1024).collect(),
                    });
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("隔离命令超时并已停止".into());
                }
                Err(error) => {
                    let _ = child.kill();
                    return Err(format!("无法读取隔离命令状态：{error}"));
                }
            }
        }
    }
}

/// Capability states for the script's catalogue. Reasons are the same strings
/// the UI would show, so an unavailable capability is never a silent gap.
pub fn catalog() -> Value {
    json!({
        "adapter": super::ID,
        "command": super::COMMAND,
        "package": super::lifecycle::PACKAGE,
        "baseline": super::lifecycle::BASELINE,
        "baselineNote": super::lifecycle::BASELINE_NOTE,
        "knownBroken": super::lifecycle::KNOWN_BROKEN,
        "minimumBun": [
            super::lifecycle::MINIMUM_BUN.0,
            super::lifecycle::MINIMUM_BUN.1,
            super::lifecycle::MINIMUM_BUN.2,
        ],
        "capabilities": [
            { "capability": "lifecycle", "state": "available", "reason": "" },
            { "capability": "configuration", "state": "unavailable", "reason": super::configuration::UNAVAILABLE_REASON },
            { "capability": "accounts", "state": "unavailable", "reason": super::accounts::UNAVAILABLE_REASON },
            { "capability": "resources-mcp", "state": "unavailable", "reason": super::mcp::UNAVAILABLE_REASON },
            { "capability": "resources-skills", "state": "unavailable", "reason": super::skills::UNAVAILABLE_REASON },
            { "capability": "agents", "state": "unavailable", "reason": super::agents::UNAVAILABLE_REASON },
            { "capability": "plugins", "state": "unavailable", "reason": super::plugins::UNAVAILABLE_REASON },
            { "capability": "memory", "state": "unavailable", "reason": super::memory::UNVERIFIED_REASON },
            { "capability": "history", "state": "unavailable", "reason": super::history::UNAVAILABLE_REASON },
        ],
        "commands": {
            "install": super::lifecycle::install_command(),
            "nativeInstall": super::lifecycle::native_install_command(),
            "npmInstall": super::lifecycle::npm_install_command(),
            "upgrade": super::lifecycle::upgrade_command("native"),
            "upgradeCommandReason": super::lifecycle::COMMAND_UNVERIFIED_REASON,
        },
    })
}

/// Dispatch one fixture case. `capability` selects the owning module.
pub fn run_case(capability: &str, case: &Value, context: &CaseContext) -> Result<Value, CaseError> {
    match capability {
        "lifecycle" => lifecycle_case(case, context),
        "configuration" => super::configuration::verify_case(case, context),
        "accounts" => super::accounts::verify_case(case, context),
        "resources-mcp" => super::mcp::verify_case(case, context),
        "resources-skills" => super::skills::verify_case(case, context),
        "agents" => super::agents::verify_case(case, context),
        "plugins" => super::plugins::verify_case(case, context),
        "memory" => super::memory::verify_case(case, context),
        "history" => super::history::verify_case(case, context),
        other => Err(CaseError::Unverified(format!(
            "未知的 OMP 验证 capability：{other}"
        ))),
    }
}

fn checks(entries: Vec<(String, bool, String)>) -> Value {
    let failed = entries.iter().any(|(_, passed, _)| !passed);
    json!({
        "passed": !failed,
        "checks": entries
            .into_iter()
            .map(|(name, passed, detail)| json!({ "name": name, "passed": passed, "detail": detail }))
            .collect::<Vec<_>>(),
    })
}

fn path_placeholder(template: &str, home: &std::path::Path) -> PathBuf {
    let home_text = home.display().to_string().replace('\\', "/");
    PathBuf::from(template.replace("{home}", &home_text))
}

fn lifecycle_case(case: &Value, context: &CaseContext) -> Result<Value, CaseError> {
    let kind = case
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| CaseError::Failed("lifecycle 用例缺少 kind".into()))?;
    let mut entries = Vec::new();
    match kind {
        "channels" => {
            let items = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("channels 用例缺少 cases".into()))?;
            for item in items {
                let template = item
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CaseError::Failed("channels 用例缺少 path".into()))?;
                let path = path_placeholder(template, &context.home);
                let expected = item
                    .get("channel")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CaseError::Failed("channels 用例缺少 channel".into()))?;
                let actual = super::lifecycle::channel_at(&context.home, None, &path);
                let actual = match actual {
                    super::lifecycle::Channel::Bun => "bun",
                    super::lifecycle::Channel::Package => "package",
                    super::lifecycle::Channel::Standalone => "standalone",
                    super::lifecycle::Channel::Unknown => "unknown",
                };
                entries.push((
                    format!("{template} -> {expected}"),
                    actual == expected,
                    format!("实际 {actual}"),
                ));
                if let Some(native) = item.get("native").and_then(Value::as_bool) {
                    let classified = super::lifecycle::channel_at(&context.home, None, &path)
                        == super::lifecycle::Channel::Standalone;
                    entries.push((
                        format!("{template} 原生分类"),
                        classified == native,
                        format!("期望 {native}"),
                    ));
                }
            }
        }
        "version-policy" => {
            let policy = super::lifecycle::version_policy();
            for (field, expected) in [("accepted", true), ("rejected", false)] {
                for version in case
                    .get(field)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    entries.push((
                        format!("{field}: {version}"),
                        policy.accepts(version) == expected,
                        format!("期望 {} 接受", if expected { "" } else { "不" }),
                    ));
                }
            }
        }
        "launch" => {
            for item in case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("launch 用例缺少 cases".into()))?
            {
                let mode = match item.get("mode").and_then(Value::as_str).unwrap_or("normal") {
                    "yolo" => LaunchMode::Yolo,
                    _ => LaunchMode::Normal,
                };
                let latest = item.get("latest").and_then(Value::as_bool).unwrap_or(false);
                let session = item.get("session").and_then(Value::as_str);
                let actual = if latest {
                    super::lifecycle::resume_latest_args(mode)
                } else {
                    super::lifecycle::launch_args(session, mode)
                };
                let expect_error = item
                    .get("expectError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let name = if latest {
                    "resume latest".to_string()
                } else {
                    format!("launch session={session:?} mode={mode:?}")
                };
                match (actual, expect_error) {
                    (Ok(args), false) => {
                        let expected: Vec<String> = item
                            .get("args")
                            .and_then(Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default();
                        entries.push((name, args == expected, format!("实际 {args:?}")));
                    }
                    (Ok(args), true) => {
                        entries.push((name, false, format!("应拒绝，实际 {args:?}")))
                    }
                    (Err(error), true) => entries.push((name, true, error)),
                    (Err(error), false) => entries.push((name, false, error)),
                }
            }
        }
        "maintenance" => {
            let expect = case.get("expect").and_then(Value::as_object);
            let expected_text = |key: &str| expect.and_then(|map| map.get(key)).and_then(Value::as_str);
            let expected_null = |key: &str| expect.and_then(|map| map.get(key)).and_then(Value::as_bool).unwrap_or(false);
            let compare = |name: &str, actual: Option<String>, expected: &str| {
                if actual.as_deref() == Some(expected) {
                    (name.to_string(), true, expected.to_string())
                } else {
                    (name.to_string(), false, format!("实际 {actual:?}，期望 {expected}"))
                }
            };
            if let Some(expected) = expected_text("install") {
                let item = compare("Bun 安装命令", super::lifecycle::install_command(), expected);
                entries.push(item);
            }
            if let Some(expected) = expected_text("upgradeBun") {
                let item = compare(
                    "Bun 来源升级命令",
                    super::lifecycle::source_upgrade_command("bun", Some("18.20.2")),
                    expected,
                );
                entries.push(item);
            }
            if let Some(expected) = expected_text("upgradeNative") {
                let item = compare(
                    "原生来源升级命令",
                    super::lifecycle::source_upgrade_command("native", Some("18.20.2")),
                    expected,
                );
                entries.push(item);
            }
            if let Some(expected) = expected_text("uninstallBun") {
                let item = compare(
                    "Bun 卸载命令",
                    super::lifecycle::source_uninstall_command("bun", Some("18.20.2")),
                    expected,
                );
                entries.push(item);
            }
            if expected_null("nativeInstallNull") {
                entries.push((
                    "预编译安装命令未声明".into(),
                    super::lifecycle::native_install_command().is_none(),
                    "未核实下载地址，不得猜测".into(),
                ));
            }
            if expected_null("npmInstallNull") {
                entries.push((
                    "npm 安装命令未声明".into(),
                    super::lifecycle::npm_install_command().is_none(),
                    "Bun 安装不得标成 npm".into(),
                ));
            }
            if expected_null("unknownUpgradeNull") {
                entries.push((
                    "未知来源无命令".into(),
                    super::lifecycle::source_upgrade_command("unknown", Some("18.20.2")).is_none(),
                    "未知来源不执行、不切换".into(),
                ));
            }
            if let Some(needle) = case.get("guidanceContains").and_then(Value::as_str) {
                let (url, hint) = super::lifecycle::install_guidance();
                entries.push((
                    "官方指引链接".into(),
                    url.contains(needle) && !hint.trim().is_empty(),
                    url.into(),
                ));
            }
        }
        "bun" => {
            let status = super::lifecycle::bun_status(&context.home);
            let path_reported = status.path.is_some();
            let reason_reported = !status.reason.trim().is_empty();
            entries.push((
                "Bun 状态可观察".into(),
                path_reported != reason_reported,
                format!("path={:?} reason={:?}", status.path, status.reason),
            ));
        }
        other => {
            return Err(CaseError::Failed(format!(
                "未知的 lifecycle 用例类型：{other}"
            )))
        }
    }
    let result = checks(entries);
    Ok(json!({ "kind": kind, "result": result }))
}
