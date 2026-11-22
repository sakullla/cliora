//! The secret MCP stdio helper and its per-target installation.
//!
//! `cliora --cliora-internal-secret-mcp-v1 --installation <uuid>` speaks the MCP
//! protocol over stdio. It is the same executable as the application and the CLI
//! helper, dispatched before Tauri starts. Like the CLI helper it is a thin
//! client: it holds one installation id, forwards `list`/`use`/`read` to the
//! running broker over the per-user IPC address and never opens the database or
//! the credential store. Without a running broker every tool fails closed.
//!
//! Tool metadata carries identifiers, aliases and executor descriptions only. The
//! single result that can hold a value is an approved `read_secret`, whose
//! approval is created by the same broker the CLI helper uses; an MCP client that
//! auto-approves its own tool calls therefore authorizes nothing.
//!
//! The service half of this module prepares the per-target installation and the
//! native MCP entry, distributes it through the shared preview/commit/CAS flow and
//! records protocol health separately from placement.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::schemars::JsonSchema;
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};
use rmcp::{tool, tool_handler, tool_router, ServerHandler, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::adapters::{Registry, SecretMcpCapability};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::native::adapter::Scope;
use crate::resources::mcp::{self as resources, McpDraft, McpDraftTargetRequest, McpTargetOperation, McpTargetRequest};
use crate::secrets::broker::{self, Installation, Kind};
use crate::secrets::ipc::{self, Operation};

/// The internal entry argument. A model never passes it: the generated MCP
/// configuration carries the executable, this argument and the installation id.
pub const MCP_ARGUMENT: &str = "--cliora-internal-secret-mcp-v1";
/// The native MCP entry name is per target, so two CLIs never share one
/// definition (each definition holds one installation id).
const NAME_PREFIX: &str = "cliora-secrets-";
/// A protocol check spawns the real helper; a hung child must not hold the caller.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Placement states. `written` only means the native entry exists.
pub const PLACEMENT_ABSENT: &str = "absent";
pub const PLACEMENT_ENABLED: &str = "enabled";
pub const PLACEMENT_DISABLED: &str = "disabled";

/// The combined availability the library shows. `unverified` keeps a written
/// entry visible while stating that real model acceptance is still missing.
pub const STATE_UNSUPPORTED: &str = "unsupported";
pub const STATE_UNVERIFIED: &str = "unverified";
pub const STATE_DISABLED: &str = "disabled";
pub const STATE_ENABLED: &str = "enabled";

/// Protocol health, verified with the official client against the real helper.
pub const HEALTH_UNKNOWN: &str = "unknown";
pub const HEALTH_HEALTHY: &str = "healthy";
pub const HEALTH_FAILED: &str = "failed";

const TOOLS: [&str; 4] = ["list_secrets", "list_secret_executors", "use_secret", "read_secret"];

// ---------------------------------------------------------------------------
// Entry argument
// ---------------------------------------------------------------------------

/// Parses the arguments that follow the entry argument. Only the installation id
/// is accepted: an unknown flag is a usage error instead of an ignored request.
pub fn parse(args: &[String]) -> Result<String, String> {
    let mut installation: Option<String> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--installation" => {
                installation = Some(rest.next().cloned().ok_or_else(|| "--installation 缺少取值".to_string())?)
            }
            other => return Err(format!("未知参数：{other}")),
        }
    }
    let installation = installation.ok_or_else(|| "缺少 --installation".to_string())?;
    if uuid::Uuid::parse_str(&installation).is_err() {
        return Err("--installation 需要安装标识".into());
    }
    Ok(installation)
}

/// The non-secret command line one target receives: the current executable, the
/// internal entry and this target's installation id. No environment variable and
/// no header can carry a value here.
pub fn command_line(executable: &str, installation_id: &str) -> Vec<String> {
    vec![executable.to_owned(), MCP_ARGUMENT.to_owned(), "--installation".to_owned(), installation_id.to_owned()]
}

/// Dispatches before Tauri starts. Returns false for a normal application start.
pub fn helper_entry() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some(MCP_ARGUMENT) {
        return false;
    }
    let code = match parse(&args[1..]) {
        Ok(installation) => serve_stdio(installation),
        Err(message) => {
            // Diagnostics go to stderr; stdout carries protocol frames only.
            eprintln!("{message}");
            2
        }
    };
    std::process::exit(code);
}

fn serve_stdio(installation: String) -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => {
            eprintln!("无法启动秘密 MCP 服务");
            return 2;
        }
    };
    runtime.block_on(async move {
        let service = match SecretMcp::new(installation).serve(rmcp::transport::stdio()).await {
            Ok(service) => service,
            Err(error) => {
                eprintln!("秘密 MCP 服务未能完成协议协商：{error}");
                return 1;
            }
        };
        match service.waiting().await {
            Ok(_) => 0,
            Err(_) => 1,
        }
    })
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const LIST_SECRETS_DESCRIPTION: &str = "List the local secret metadata this Cliora installation may use. \
Returns each secret's stable id, alias, `{{cliora-secret:<secret-id>}}` reference, status and the executor \
entries it is granted. No secret value is returned; a status other than `available` means this device lacks \
the value. To reference a secret, reuse its reference field verbatim. To perform a task, pass it to use_secret.";

const LIST_EXECUTORS_DESCRIPTION: &str = "List the registered executor entries this Cliora installation may \
run, with their id, label, the secret ids each is granted and whether the registered script still matches its \
digest. An executor whose digest changed can be listed but not used. No secret value is returned.";

const USE_SECRET_DESCRIPTION: &str = "Run one registered executor with the value of one secret. The value is \
passed to that executor only (environment variable or stdin, never argv) and is masked out of the returned \
stdout, stderr and messages. Both ids must come from list_secrets/list_secret_executors and be granted to this \
installation; an unregistered pair is refused. A prompt reference `{{cliora-secret:<secret-id>}}` identifies the \
secret id. Prefer this tool over reading a value.";

const READ_SECRET_DESCRIPTION: &str = "Read one raw value with secretId, or request several together with secretIds. \
Cliora asks for approval of the requested references. The person can allow one read or allow those references for \
this MCP connection. A batch returns secrets in request order with id, alias and value. A failed batch returns no values. \
Returned values enter the model context and the CLI session history. Prefer use_secret unless the task needs the text.";

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UseSecretArgs {
    /// Secret id or complete `{{cliora-secret:<secret-id>}}` reference from list_secrets.
    pub secret_id: String,
    /// Executor id granted for that secret in list_secret_executors.
    pub executor_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSecretArgs {
    /// Single id or complete prompt reference. Supply exactly one of secretId and secretIds.
    pub secret_id: Option<String>,
    /// A nonempty list of ids or prompt references to read together.
    pub secret_ids: Option<Vec<String>>,
}

impl ReadSecretArgs {
    fn into_ids(self) -> Result<(Vec<String>, bool), String> {
        let (ids, batch) = match (self.secret_id, self.secret_ids) {
            (Some(id), None) => (vec![id], false),
            (None, Some(ids)) if !ids.is_empty() => (ids, true),
            _ => return Err("read_secret 需要 secretId 或非空的 secretIds，请只选一项".into()),
        };
        let ids = ids.iter().map(|id| super::reference::argument_id(id)).collect::<Result<_, _>>()?;
        Ok((ids, batch))
    }
}

/// One stdio server for one installation. Every tool forwards to the broker, so
/// the MCP path shares grants, execution, approval, masking and audit with the CLI.
#[derive(Clone)]
pub struct SecretMcp {
    installation: Arc<String>,
    // The control connection closes with this stdio server. Tool arguments
    // never carry the broker-issued token.
    session: Arc<Mutex<Option<ipc::McpSession>>>,
    tool_router: ToolRouter<Self>,
}

impl SecretMcp {
    pub fn new(installation: impl Into<String>) -> Self {
        Self { installation: Arc::new(installation.into()), session: Arc::default(), tool_router: Self::tool_router() }
    }

    /// The tools this server publishes. A test asserts their names and that no
    /// description or schema can carry a value.
    pub fn tools(&self) -> Vec<rmcp::model::Tool> {
        self.tool_router.list_all()
    }

    async fn forward(
        &self,
        operation: Operation,
        secret_id: Option<String>,
        executor_id: Option<String>,
    ) -> Result<Json<Value>, String> {
        let installation = self.installation.clone();
        let secret_id = secret_id.as_deref().map(super::reference::argument_id).transpose()
            .map_err(|message| failure_document(super::audit::code::INVALID_REQUEST, message))?;
        // The IPC call blocks on the broker (a read waits for its approval), so it
        // runs off the protocol task.
        Self::broker_result(tokio::task::spawn_blocking(move || {
            ipc::call(&installation, operation, secret_id.as_deref(), executor_id.as_deref())
        }).await)
    }

    fn broker_result(attempt: Result<Result<ipc::Response, String>, tokio::task::JoinError>) -> Result<Json<Value>, String> {
        match attempt {
            Ok(Ok(response)) if response.ok => Ok(Json(response.data.unwrap_or(Value::Null))),
            Ok(Ok(response)) => Err(failure_document(&response.code, &response.message)),
            Ok(Err(message)) => Err(failure_document(ipc::CODE_OFFLINE, &message)),
            Err(_) => Err(failure_document(ipc::CODE_PROTOCOL, "秘密代理请求未完成")),
        }
    }
}

/// One failure document. It holds a code and a short diagnostic; neither can
/// contain a value because the broker never returns one on failure.
fn failure_document(code: &str, message: &str) -> String {
    serde_json::to_string(&json!({ "ok": false, "code": code, "message": message }))
        .unwrap_or_else(|_| "{\"ok\":false}".to_owned())
}

#[tool_router(router = tool_router)]
impl SecretMcp {
    #[tool(name = "list_secrets", description = LIST_SECRETS_DESCRIPTION)]
    async fn list_secrets(&self) -> Result<Json<Value>, String> {
        self.forward(Operation::List, None, None).await
    }

    #[tool(name = "list_secret_executors", description = LIST_EXECUTORS_DESCRIPTION)]
    async fn list_secret_executors(&self) -> Result<Json<Value>, String> {
        let data = self.forward(Operation::List, None, None).await?;
        Ok(Json(executor_view(&data.0)))
    }

    #[tool(name = "use_secret", description = USE_SECRET_DESCRIPTION)]
    async fn use_secret(&self, args: Parameters<UseSecretArgs>) -> Result<Json<Value>, String> {
        let Parameters(UseSecretArgs { secret_id, executor_id }) = args;
        self.forward(Operation::Use, Some(secret_id), Some(executor_id)).await
    }

    #[tool(name = "read_secret", description = READ_SECRET_DESCRIPTION)]
    async fn read_secret(&self, args: Parameters<ReadSecretArgs>) -> Result<Json<Value>, String> {
        let (ids, batch) = args.0.into_ids()
            .map_err(|message| failure_document(super::audit::code::INVALID_REQUEST, &message))?;
        let installation = self.installation.clone();
        let sessions = Arc::downgrade(&self.session);
        Self::broker_result(tokio::task::spawn_blocking(move || {
            let token = {
                let owner = sessions.upgrade().ok_or("MCP 会话已结束")?;
                let mut session = owner.lock().map_err(|_| "MCP 会话不可用")?;
                if session.is_none() {
                    *session = Some(ipc::open_mcp_session(&installation)?);
                }
                session.as_ref().ok_or("MCP 会话不可用")?.token().to_owned()
            };
            let response = ipc::read(&installation, &ids, batch, Some(&token))?;
            // After a broker restart the old connection no longer owns a
            // session. A subsequent call can establish a new one and ask again.
            if response.code == ipc::CODE_SESSION_ENDED {
                if let Some(owner) = sessions.upgrade() {
                    let mut session = owner.lock().map_err(|_| "MCP 会话不可用")?;
                    if session.as_ref().is_some_and(|current| current.token() == token) {
                        *session = None;
                    }
                }
            }
            Ok(response)
        }).await)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SecretMcp {}

/// Executor metadata derived from the same authorized list the broker returns, so
/// this tool cannot widen what `list_secrets` already shows. `digestOk` is the
/// binding state: a changed script may be listed but not run.
fn executor_view(data: &Value) -> Value {
    let mut executors: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(secrets) = data.get("secrets").and_then(Value::as_array) {
        for secret in secrets {
            let secret_id = secret.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(entries) = secret.get("executors").and_then(Value::as_array) else { continue };
            for entry in entries {
                let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
                let slot = executors.entry(id.to_owned()).or_insert_with(|| {
                    json!({
                        "id": id,
                        "label": entry.get("label").cloned().unwrap_or(Value::String(String::new())),
                        "digestOk": entry.get("digestOk").cloned().unwrap_or(Value::Bool(false)),
                        "secretIds": Vec::<String>::new(),
                    })
                });
                if let Some(ids) = slot.get_mut("secretIds").and_then(Value::as_array_mut) {
                    ids.push(Value::String(secret_id.to_owned()));
                }
            }
        }
    }
    json!({ "executors": executors.into_values().collect::<Vec<_>>() })
}

// ---------------------------------------------------------------------------
// Per-target installation and distribution
// ---------------------------------------------------------------------------

/// The target one status/distribution call acts on. It mirrors the shared MCP
/// target so the same preview/commit path resolves the native location.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMcpTarget {
    pub tool_id: String,
    pub scope: Scope,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub context_id: Option<String>,
}

impl SecretMcpTarget {
    fn request(&self, enabled: bool) -> McpTargetRequest {
        McpTargetRequest {
            context_id: self.context_id.clone(),
            tool_id: self.tool_id.clone(),
            scope: self.scope,
            project_path: if self.scope == Scope::Project { self.project_path.clone() } else { None },
            enabled,
            baseline_hash: None,
            allow_replace: false,
            preview_token: None,
        }
    }
}

/// What the library and the tool workspace show. Placement, protocol health and
/// registry capability stay separate fields so a written native entry can never
/// be reported as a verified connection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMcpState {
    pub tool_id: String,
    pub scope: Scope,
    pub project_path: Option<String>,
    /// Registry capability: `supported`, `unverified` or `unsupported`.
    pub capability: &'static str,
    pub capability_reason: &'static str,
    /// Combined state: `unsupported`, `unverified`, `disabled` or `enabled`.
    pub state: &'static str,
    pub reason: String,
    pub installation_id: Option<String>,
    pub installation_label: Option<String>,
    /// The distributed command line, or the one that would be written.
    pub command: String,
    pub args: Vec<String>,
    /// `absent`, `enabled` or `disabled`: the native entry, not the protocol.
    pub placement: &'static str,
    /// `unknown`, `healthy` or `failed`, verified with the real helper.
    pub health: &'static str,
    pub health_detail: String,
    /// Only a supported adapter with a written entry and a verified protocol.
    pub available: bool,
    /// The CLI fallback is always offered; the value never travels in it.
    pub cli_fallback: bool,
}

fn executable() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "无法定位栖点可执行文件".to_string())
}

/// The native entry name for one target. Keeping it per tool means each CLI gets
/// its own installation id instead of sharing one definition.
pub fn entry_name(tool_id: &str) -> Result<String, String> {
    let name = format!("{NAME_PREFIX}{tool_id}");
    if name.len() > 80 || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return Err("此 CLI 标识不能作为 MCP 名称".into());
    }
    Ok(name)
}

fn capability(registry: &Registry, tool_id: &str) -> SecretMcpCapability {
    match registry.get(tool_id) {
        Some(adapter) => adapter.secret_mcp_capability(),
        // An unregistered target cannot be written or verified, and it never
        // borrows another CLI's mapping.
        None => SecretMcpCapability::unsupported("此 CLI 尚无注册适配器，秘密使用只提供 CLI 回退"),
    }
}

fn find_definition(db: &Database, name: &str) -> Result<Option<resources::McpDefinition>, String> {
    Ok(resources::list_definitions(db)?.into_iter().find(|definition| definition.name == name))
}

/// One live installation per target CLI. Reusing it keeps grants stable across
/// enable/disable; revoking it starts over without the old grants.
pub fn installation_for(db: &Database, tool_id: &str) -> Result<Option<Installation>, String> {
    Ok(broker::installations_for(db, Kind::Mcp, tool_id)?.into_iter().next())
}

fn ensure_installation(db: &Database, tool_id: &str) -> Result<Installation, String> {
    if let Some(installation) = installation_for(db, tool_id)? {
        return Ok(installation);
    }
    let label = format!("秘密 MCP · {tool_id}");
    broker::create_installation(db, &label, Kind::Mcp, Some(tool_id))
}

fn draft(entry: &str, command: &str, args: &[String], version: Option<u64>) -> McpDraft {
    McpDraft {
        id: None,
        name: entry.to_owned(),
        transport: resources::McpTransport::Stdio,
        command: command.to_owned(),
        args: args.to_vec(),
        cwd: String::new(),
        url: String::new(),
        env: Default::default(),
        headers: Default::default(),
        // A managed entry is not a library item: the library shows the secret MCP
        // state instead of a second editable copy of the same definition.
        in_library: false,
        expected_version: version,
    }
}

/// Placement of the managed entry in this target scope. `None` means the entry
/// was never written here; `Some(false)` means the native entry is disabled.
fn placement(db: &Database, entry: &str, target: &SecretMcpTarget) -> Result<Option<bool>, String> {
    let Some(definition) = find_definition(db, entry)? else { return Ok(None) };
    resources::managed_enabled(db, &definition.id, &target.request(true))
}

/// One state document. Placement and health are read, never assumed.
pub fn status(db: &Database, registry: &Registry, target: &SecretMcpTarget) -> Result<SecretMcpState, String> {
    let capability = capability(registry, &target.tool_id);
    let entry = entry_name(&target.tool_id).ok();
    let installation = installation_for(db, &target.tool_id)?;
    let definition = match entry.as_deref() {
        Some(entry) => find_definition(db, entry)?,
        None => None,
    };
    let mut state = SecretMcpState {
        tool_id: target.tool_id.clone(),
        scope: target.scope,
        project_path: target.request(true).project_path,
        capability: capability.state,
        capability_reason: capability.reason,
        state: STATE_UNSUPPORTED,
        reason: capability.reason.to_owned(),
        installation_id: installation.as_ref().map(|installation| installation.id.clone()),
        installation_label: installation.as_ref().map(|installation| installation.label.clone()),
        command: definition.as_ref().map(|definition| definition.command.clone()).unwrap_or_default(),
        args: definition.as_ref().map(|definition| definition.args.clone()).unwrap_or_default(),
        placement: PLACEMENT_ABSENT,
        health: HEALTH_UNKNOWN,
        health_detail: String::new(),
        available: false,
        cli_fallback: true,
    };
    if let Some(profile) = health_of(&target.tool_id, installation.as_ref().map(|installation| installation.id.as_str())) {
        state.health = profile.state;
        state.health_detail = profile.detail;
    }
    // The placement asks the shared MCP service which entry this definition owns
    // in this scope; a project scope without a directory cannot be inspected.
    let placed = match entry.as_deref() {
        Some(entry) => placement(db, entry, target),
        None => Ok(None),
    };
    let placed = match placed {
        Ok(placed) => placed,
        Err(error) => {
            state.state = capability_state(capability);
            state.reason = error;
            return Ok(state);
        }
    };
    state.placement = match placed {
        None => PLACEMENT_ABSENT,
        Some(false) => PLACEMENT_DISABLED,
        Some(true) => PLACEMENT_ENABLED,
    };
    if !capability.is_supported() {
        state.state = capability_state(capability);
        state.reason = match state.placement {
            PLACEMENT_ENABLED => format!("{}；原生条目已写入，也可继续使用 CLI 回退", capability.reason),
            PLACEMENT_DISABLED => format!("{}；原生条目已写入但已停用，也可继续使用 CLI 回退", capability.reason),
            _ => capability.reason.to_owned(),
        };
        return Ok(state);
    }
    match placed {
        None => {
            state.state = STATE_DISABLED;
            state.reason = "尚未为当前 CLI 和作用域写入秘密 MCP 配置".into();
        }
        Some(false) => {
            state.state = STATE_DISABLED;
            state.reason = "原生配置已写入，但当前为停用状态".into();
        }
        Some(true) => {
            state.state = STATE_ENABLED;
            state.reason = match state.health {
                HEALTH_HEALTHY => "原生配置已写入，协议握手与工具发现已通过".into(),
                HEALTH_FAILED => "原生配置已写入，但协议检查未通过".to_string(),
                _ => "原生配置已写入；协议尚未在本机检查".into(),
            };
        }
    }
    state.available = state.state == STATE_ENABLED && state.health == HEALTH_HEALTHY;
    Ok(state)
}

fn capability_state(capability: SecretMcpCapability) -> &'static str {
    if capability.state == "unverified" { STATE_UNVERIFIED } else { STATE_UNSUPPORTED }
}

/// Writes or disables this target's native entry through the shared preview,
/// commit and compare-and-swap flow. The definition is saved by that same flow;
/// a conflicting foreign entry stays a conflict instead of being replaced.
pub fn set_enabled(
    db: &Database,
    credentials: &dyn CredentialStore,
    registry: &Registry,
    home: &Path,
    target: &SecretMcpTarget,
    enabled: bool,
) -> Result<SecretMcpState, String> {
    let capability = capability(registry, &target.tool_id);
    if !capability.is_supported() && capability.state == "unsupported" {
        return Err(capability.reason.into());
    }
    if target.scope == Scope::Project && target.project_path.as_deref().map(str::trim).unwrap_or_default().is_empty() {
        return Err("项目作用域需要项目目录".into());
    }
    // A written entry needs an installation to name: enabling creates one, and
    // disabling keeps it so a later enable reuses the same grants.
    let installation = match installation_for(db, &target.tool_id)? {
        Some(installation) => Some(installation),
        None if enabled => Some(ensure_installation(db, &target.tool_id)?),
        None => None,
    };
    let entry = entry_name(&target.tool_id)?;
    let executable = executable()?;
    let existing = find_definition(db, &entry)?;
    let args = match &installation {
        Some(installation) => command_line(&executable, &installation.id).into_iter().skip(1).collect::<Vec<_>>(),
        None => vec![MCP_ARGUMENT.to_owned()],
    };
    let mut candidate = draft(&entry, &executable, &args, existing.as_ref().map(|definition| definition.version));
    if let Some(existing) = &existing {
        candidate.id = Some(existing.id.clone());
    }
    let request = McpTargetRequest {
        context_id: target.context_id.clone(),
        tool_id: target.tool_id.clone(),
        scope: target.scope,
        project_path: target.request(enabled).project_path,
        enabled,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    };
    let preview = resources::preview_draft(
        db,
        registry,
        home,
        candidate,
        vec![McpDraftTargetRequest { target: request.clone(), operation: McpTargetOperation::Write }],
    )?;
    let Some(inspected) = preview.targets.first().cloned() else {
        return Err("MCP 目标预览为空".into());
    };
    if inspected.status == "conflict" {
        // A foreign or externally edited entry is reported, never replaced here:
        // the user resolves it in the MCP workspace first.
        return Err(format!("同名原生条目未由当前定义管理或已被外部修改：{}", inspected.detail));
    }
    if inspected.status == "failed" || inspected.status == "unsupported" {
        return Err(if inspected.detail.is_empty() { "MCP 目标不可用".into() } else { inspected.detail });
    }
    let committed = resources::commit_draft(
        db,
        credentials,
        registry,
        home,
        preview.draft,
        vec![McpDraftTargetRequest {
            target: McpTargetRequest {
                context_id: request.context_id,
                tool_id: request.tool_id,
                scope: request.scope,
                project_path: request.project_path,
                enabled,
                baseline_hash: inspected.baseline_hash,
                allow_replace: false,
                preview_token: inspected.preview_token,
            },
            operation: McpTargetOperation::Write,
        }],
    )?;
    if let Some(result) = committed.targets.first() {
        if !matches!(result.status, "written" | "removed") {
            return Err(if result.detail.is_empty() { "MCP 配置未能写入".into() } else { result.detail.clone() });
        }
    }
    // A write invalidates earlier protocol evidence for this target.
    let installation = installation_for(db, &target.tool_id)?;
    forget_health(&target.tool_id, installation.as_ref().map(|installation| installation.id.as_str()));
    status(db, registry, target)
}

/// Replaces any current installation so a reconnect starts without the grants of
/// the old one. Only reachable by an explicit user action.
pub fn revoke(db: &Database, registry: &Registry, target: &SecretMcpTarget) -> Result<SecretMcpState, String> {
    if let Some(installation) = installation_for(db, &target.tool_id)? {
        broker::revoke_installation(db, &installation.id)?;
    }
    forget_health(&target.tool_id, None);
    status(db, registry, target)
}

// ---------------------------------------------------------------------------
// Protocol health
// ---------------------------------------------------------------------------

/// The recorded protocol result for one target installation.
#[derive(Clone, Debug)]
pub struct Health {
    pub state: &'static str,
    pub detail: String,
}

fn health_store() -> &'static Mutex<BTreeMap<String, Health>> {
    static HEALTH: OnceLock<Mutex<BTreeMap<String, Health>>> = OnceLock::new();
    HEALTH.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn health_key(tool_id: &str, installation_id: &str) -> String {
    format!("{tool_id}|{installation_id}")
}

fn health_of(tool_id: &str, installation_id: Option<&str>) -> Option<Health> {
    let installation_id = installation_id?;
    health_store().lock().ok()?.get(&health_key(tool_id, installation_id)).cloned()
}

pub fn forget_health(tool_id: &str, installation_id: Option<&str>) {
    let Ok(mut store) = health_store().lock() else { return };
    match installation_id {
        Some(installation_id) => {
            store.remove(&health_key(tool_id, installation_id));
        }
        None => store.retain(|key, _| !key.starts_with(&format!("{tool_id}|"))),
    }
}

fn record_health(tool_id: &str, installation_id: &str, health: Health) {
    if let Ok(mut store) = health_store().lock() {
        store.insert(health_key(tool_id, installation_id), health);
    }
}

/// Runs the real helper and asks it to negotiate the protocol and list its tools.
/// Only a completed `initialize` plus the four expected tool names counts as
/// healthy; a spawn failure, a protocol error or a timeout is `failed`.
pub async fn verify(tool_id: &str, installation_id: &str) -> Health {
    let outcome = probe(installation_id).await;
    let health = match outcome {
        Ok(()) => Health { state: HEALTH_HEALTHY, detail: "initialize 与 tools/list 已通过".into() },
        Err(detail) => Health { state: HEALTH_FAILED, detail },
    };
    record_health(tool_id, installation_id, health.clone());
    health
}

async fn probe(installation_id: &str) -> Result<(), String> {
    let executable = executable()?;
    let transport = TokioChildProcess::new(tokio::process::Command::new(&executable).configure(|command| {
        command
            .arg(MCP_ARGUMENT)
            .arg("--installation")
            .arg(installation_id)
            .kill_on_drop(true);
    }))
    .map_err(|_| "无法启动秘密 MCP 服务用于检查".to_string())?;
    let run = async {
        let client = ().serve(transport).await.map_err(|_| "秘密 MCP 协议协商失败".to_string())?;
        let tools = client.list_all_tools().await.map_err(|_| "秘密 MCP 工具发现失败".to_string())?;
        let names: Vec<String> = tools.iter().map(|tool| tool.name.to_string()).collect();
        let missing: Vec<&str> = TOOLS.iter().copied().filter(|name| !names.iter().any(|found| found == name)).collect();
        let _ = client.cancel().await;
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!("秘密 MCP 未公开必需工具：{}", missing.join("、")))
        }
    };
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok(result) => result,
        Err(_) => Err("秘密 MCP 协议检查超时".into()),
    }
}

#[cfg(test)]
#[path = "../../tests/secrets/mcp.rs"]
mod tests;
