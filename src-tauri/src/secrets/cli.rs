//! `cliora --cliora-internal-secret-cli-v1 --installation <uuid> list|use|read`
//!
//! The helper is a thin client: it parses arguments, connects to the running
//! broker over the per-user IPC address and prints one JSON document. It never
//! opens the database or the credential store, so a helper without a running
//! Cliora fails closed instead of reading a value on its own.
use crate::secrets::ipc::{self, Operation, Response};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const CLI_ARGUMENT: &str = "--cliora-internal-secret-cli-v1";
/// Usage mistakes are separate from broker refusals so a caller can tell them
/// apart without parsing text.
pub const CODE_USAGE: &str = "usage_invalid";

const USAGE: &str = "\
用法：cliora --cliora-internal-secret-cli-v1 --installation <uuid> <命令> [参数]

命令：
  list                                       列出该安装标识可用的秘密和执行入口
  use --secret <uuid或引用> --executor <uuid> 通过已登记的执行入口受控使用秘密
  read --secret <uuid或引用> [--secret ...]    一次确认读取多个原值。工作台 CLI 可允许本次会话

read 可加 --format values：成功时 stdout 为按凭据名索引的 JSON 对象，失败时返回非零状态。
read 会把原值写入本次 stdout，原值可能进入模型上下文与 CLI 会话记录。";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub installation: String,
    pub operation: Operation,
    pub secret_ids: Vec<String>,
    pub executor_id: Option<String>,
    pub values_only: bool,
}

/// Validate every requested reference before opening an IPC connection.
pub fn parse(args: &[String]) -> Result<Invocation, String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Err(String::new());
    }
    let mut installation: Option<String> = None;
    let mut secret_ids = Vec::new();
    let mut executor_id: Option<String> = None;
    let mut operation: Option<String> = None;
    let mut values_only = false;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--installation" => installation = Some(take(&mut rest, "--installation")?),
            "--secret" => secret_ids.push(super::reference::argument_id(&take(&mut rest, "--secret")?)?),
            "--executor" => executor_id = Some(take(&mut rest, "--executor")?),
            "--format" => {
                if take(&mut rest, "--format")? != "values" {
                    return Err("--format 仅支持 values".into());
                }
                values_only = true;
            }
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
    if executor_id.as_deref().is_some_and(|id| uuid::Uuid::parse_str(id).is_err()) {
        return Err("--executor 需要执行入口标识".into());
    }
    if values_only && operation != Operation::Read {
        return Err("只有 read 支持 --format values".into());
    }
    match operation {
        Operation::List if !secret_ids.is_empty() || executor_id.is_some() => {
            return Err("list 不接受 --secret 或 --executor".into())
        }
        Operation::Use if secret_ids.len() != 1 || executor_id.is_none() => {
            return Err("use 需要一个 --secret 和一个 --executor".into())
        }
        Operation::Read if secret_ids.is_empty() => return Err("read 需要 --secret".into()),
        Operation::Read if executor_id.is_some() => return Err("read 不接受 --executor".into()),
        _ => {}
    }
    Ok(Invocation { installation, operation, secret_ids, executor_id, values_only })
}

fn take<'a>(rest: &mut std::slice::Iter<'a, String>, flag: &str) -> Result<String, String> {
    rest.next().cloned().ok_or_else(|| format!("{flag} 缺少取值"))
}

/// The document printed for one operation. A read is the only command whose
/// output contains a value, and only with the user's approval.
pub fn document(operation: Operation, response: &Response) -> Value {
    match (response.ok, operation) {
        (true, _) => json!({ "ok": true, "code": response.code, "data": response.data }),
        (false, _) => json!({ "ok": false, "code": response.code, "message": response.message }),
    }
}

/// The compact CLI format requests the broker's ID-bearing batch reply, even for
/// one credential. Validate the full set before publishing the alias-keyed map.
fn read_values(response: Response, requested: &[String]) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct Item { id: String, alias: String, value: String }
    #[derive(Deserialize)]
    struct Batch { secrets: Vec<Item> }

    if !response.ok {
        return Err(format!("{}: {}", response.code, response.message));
    }
    let invalid = "代理未返回完整的凭据结果";
    let batch: Batch = serde_json::from_value(response.data.ok_or(invalid)?).map_err(|_| invalid)?;
    let mut remaining: HashSet<_> = requested.iter().map(String::as_str).collect();
    let mut values = serde_json::Map::new();
    for item in batch.secrets {
        if !remaining.remove(item.id.as_str()) || item.alias.is_empty() || item.value.is_empty()
            || values.insert(item.alias, Value::String(item.value)).is_some() {
            return Err(invalid.into());
        }
    }
    if !remaining.is_empty() || values.is_empty() {
        return Err(invalid.into());
    }
    Ok(Value::Object(values))
}

fn execute(invocation: &Invocation) -> i32 {
    let session = std::env::var(super::session::ENV).ok();
    let response = dispatch(invocation, session.as_deref())
        .unwrap_or_else(|message| Response::failure(ipc::CODE_OFFLINE, message));
    if invocation.values_only {
        return match read_values(response, &invocation.secret_ids) {
            Ok(values) => { println!("{values}"); 0 }
            Err(message) => { eprintln!("{message}"); 1 }
        };
    }
    let ok = response.ok;
    let document = document(invocation.operation, &response);
    println!("{}", serde_json::to_string(&document).unwrap_or_else(|_| "{\"ok\":false}".into()));
    if ok { 0 } else { 1 }
}

fn dispatch(invocation: &Invocation, session: Option<&str>) -> Result<Response, String> {
    if invocation.operation == Operation::Read {
        return ipc::read(&invocation.installation, &invocation.secret_ids, invocation.values_only || invocation.secret_ids.len() > 1, session);
    }
    ipc::call(
        &invocation.installation,
        invocation.operation,
        invocation.secret_ids.first().map(String::as_str),
        invocation.executor_id.as_deref(),
    )
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
