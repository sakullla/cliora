//! `cliora --cliora-internal-secret-cli-v1 --installation <uuid> list|use|read`
//!
//! The helper is a thin client: it parses arguments, connects to the running
//! broker over the per-user IPC address and prints one JSON document. It never
//! opens the database or the credential store, so a helper without a running
//! Cliora fails closed instead of reading a value on its own.
use crate::secrets::ipc::{self, Operation, Response};
use serde_json::{json, Value};

pub const CLI_ARGUMENT: &str = "--cliora-internal-secret-cli-v1";
/// Usage mistakes are separate from broker refusals so a caller can tell them
/// apart without parsing text.
pub const CODE_USAGE: &str = "usage_invalid";

const USAGE: &str = "\
用法：cliora --cliora-internal-secret-cli-v1 --installation <uuid> <命令> [参数]

命令：
  list                                       列出该安装标识可用的秘密和执行入口
  use --secret <uuid> --executor <uuid>      通过已登记的执行入口受控使用秘密
  read --secret <uuid>                       读取原值（每次都需要在栖点确认）

read 会把原值写入本次 stdout，原值可能进入模型上下文与 CLI 会话记录。";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub installation: String,
    pub operation: Operation,
    pub secret_id: Option<String>,
    pub executor_id: Option<String>,
}

/// Parses the arguments that follow the entry argument. Unknown flags, repeated
/// flags and missing requirements are refused before any IPC request is made.
pub fn parse(args: &[String]) -> Result<Invocation, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Err(String::new());
    }
    let mut installation: Option<String> = None;
    let mut secret_id: Option<String> = None;
    let mut executor_id: Option<String> = None;
    let mut operation: Option<String> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--installation" => installation = Some(take(&mut rest, "--installation")?),
            "--secret" => secret_id = Some(take(&mut rest, "--secret")?),
            "--executor" => executor_id = Some(take(&mut rest, "--executor")?),
            "list" | "use" | "read" if operation.is_none() => operation = Some(arg.clone()),
            other if other.starts_with('-') => return Err(format!("未知参数：{other}")),
            other => return Err(format!("未知命令：{other}")),
        }
    }
    let installation = installation.ok_or_else(|| "缺少 --installation".to_string())?;
    if uuid::Uuid::parse_str(&installation).is_err() {
        return Err("--installation 需要安装标识".into());
    }
    let operation = match operation.as_deref() {
        Some("list") => Operation::List,
        Some("use") => Operation::Use,
        Some("read") => Operation::Read,
        _ => return Err("缺少命令：list、use 或 read".into()),
    };
    let validate = |value: &Option<String>, name: &str| -> Result<Option<String>, String> {
        match value {
            Some(value) if uuid::Uuid::parse_str(value).is_err() => Err(format!("--{name} 需要秘密标识")),
            _ => Ok(value.clone()),
        }
    };
    let secret_id = validate(&secret_id, "secret")?;
    let executor_id = validate(&executor_id, "executor")?;
    match operation {
        Operation::List if secret_id.is_some() || executor_id.is_some() => {
            return Err("list 不接受 --secret 或 --executor".into())
        }
        Operation::Use if secret_id.is_none() || executor_id.is_none() => {
            return Err("use 需要 --secret 和 --executor".into())
        }
        Operation::Read if secret_id.is_none() => return Err("read 需要 --secret".into()),
        Operation::Read if executor_id.is_some() => return Err("read 不接受 --executor".into()),
        _ => {}
    }
    Ok(Invocation { installation, operation, secret_id, executor_id })
}

fn take<'a>(rest: &mut std::slice::Iter<'a, String>, flag: &str) -> Result<String, String> {
    rest.next().cloned().ok_or_else(|| format!("{flag} 缺少取值"))
}

/// The document printed for one operation. A read is the only command whose
/// output contains a value, and only after its own approval.
pub fn document(operation: Operation, response: &Response) -> Value {
    match (response.ok, operation) {
        (true, _) => json!({ "ok": true, "code": response.code, "data": response.data }),
        (false, _) => json!({ "ok": false, "code": response.code, "message": response.message }),
    }
}

fn execute(invocation: &Invocation) -> i32 {
    let response = ipc::call(
        &invocation.installation,
        invocation.operation,
        invocation.secret_id.as_deref(),
        invocation.executor_id.as_deref(),
    )
    .unwrap_or_else(|message| Response::failure(ipc::CODE_OFFLINE, message));
    let ok = response.ok;
    let document = document(invocation.operation, &response);
    println!("{}", serde_json::to_string(&document).unwrap_or_else(|_| "{\"ok\":false}".into()));
    if ok { 0 } else { 1 }
}

/// Dispatches before Tauri starts. Returns false for a normal application start.
pub fn helper_entry() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some(CLI_ARGUMENT) {
        return false;
    }
    let code = match parse(&args[1..]) {
        Ok(invocation) => execute(&invocation),
        Err(message) => {
            if message.is_empty() {
                eprintln!("{USAGE}");
                0
            } else {
                eprintln!("{message}\n\n{USAGE}");
                let document = json!({ "ok": false, "code": CODE_USAGE, "message": message });
                println!("{}", serde_json::to_string(&document).unwrap_or_default());
                2
            }
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
#[path = "../../tests/secrets/cli.rs"]
mod tests;
