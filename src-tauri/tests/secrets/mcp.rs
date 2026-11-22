//! The secret MCP helper: its entry argument and command line, the four tools it
//! publishes, and the fact that every call is answered by the running broker over
//! the same per-user IPC surface the CLI helper uses.
//!
//! The protocol tests speak MCP in process: the server half wraps a duplex stream
//! exactly as the stdio transport does, and a real broker is served beside it, so
//! grants, approval, masking and audit are the production code paths. A helper
//! without a broker fails closed and no tool result carries a value unless an
//! approved `read_secret` returned one.
use super::*;
#[cfg(unix)]
use crate::secrets::approval::{Host, Prompt};
#[cfg(unix)]
use crate::secrets::audit;
#[cfg(unix)]
use crate::secrets::executor::{self, Channel, NewExecutor};
use serde_json::json;
#[cfg(unix)]
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
#[cfg(unix)]
use std::sync::Arc;
use std::sync::Mutex;

const CANARY: &str = "canary-synthetic-mcp-51fa7c";
#[cfg(unix)]
const OTHER: &str = "canary-other-mcp-b3d2";

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn identifier() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Default)]
struct MemoryCredentials {
    values: Mutex<BTreeMap<String, String>>,
}

impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.values.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.lookup(id)?.ok_or_else(|| "missing".into())
    }
    fn lookup(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.values.lock().unwrap().get(id).cloned())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}

#[cfg(unix)]
struct Uses {
    database: Arc<Database>,
    credentials: Arc<MemoryCredentials>,
    installation: Installation,
    secret: crate::secrets::PromptSecret,
    executor: executor::SecretExecutor,
}

#[cfg(unix)]
fn uses() -> Uses {
    let database = Arc::new(Database::open(std::path::Path::new(":memory:")).unwrap());
    let credentials = Arc::new(MemoryCredentials::default());
    let secret = crate::secrets::create(&database, &*credentials, "部署口令", CANARY).unwrap();
    let executor = executor::register(
        &database,
        NewExecutor {
            label: "env 读取".into(),
            description: String::new(),
            executable: "/usr/bin/env".into(),
            args: Vec::new(),
            cwd: None,
            channel: Channel::Env,
            env_name: Some("CLIORAMCP".into()),
        },
    )
    .unwrap();
    let installation = broker::create_installation(&database, "测试 MCP", Kind::Mcp, Some("fixture")).unwrap();
    Uses { database, credentials, installation, secret, executor }
}

// ---------------------------------------------------------------------------
// Entry argument and command line
// ---------------------------------------------------------------------------

#[test]
fn the_entry_takes_one_installation_id_and_refuses_anything_else() {
    let id = identifier();
    assert_eq!(parse(&args(&["--installation", &id])), Ok(id.clone()));
    assert!(parse(&args(&[])).is_err());
    assert!(parse(&args(&["--installation"])).is_err());
    assert!(parse(&args(&["--installation", "not-a-uuid"])).is_err());
    // A model never passes a value, a target or a scope through this entry.
    assert!(parse(&args(&["--installation", &id, "--secret", "x"])).is_err());
    assert!(parse(&args(&["--installation", &id, "list"])).is_err());
}

#[test]
fn the_command_line_names_the_helper_and_one_installation() {
    let id = identifier();
    let line = command_line("/opt/cliora", &id);
    assert_eq!(line, vec!["/opt/cliora".to_string(), MCP_ARGUMENT.to_string(), "--installation".to_string(), id.clone()]);
    // The arguments after the entry round-trip through the parser the helper runs,
    // so a distributed entry is the entry the helper accepts.
    assert_eq!(parse(&line[2..]).unwrap(), id);
    // No value, environment variable or header can ride along.
    let printed = line.join(" ");
    assert!(!printed.contains(CANARY));
    assert!(!printed.contains('='));
}

#[test]
fn the_entry_name_is_per_target_and_never_escapes_the_config() {
    assert_eq!(entry_name("codex").unwrap(), "cliora-secrets-codex");
    assert_eq!(entry_name("kimi_code").unwrap(), "cliora-secrets-kimi_code");
    assert!(entry_name("a/b").is_err());
    assert!(entry_name("a b").is_err());
    assert!(entry_name(&"x".repeat(90)).is_err());
}

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

#[test]
fn the_server_publishes_the_four_tools_without_a_value_in_their_metadata() {
    let tools = SecretMcp::new(identifier()).tools();
    let mut names: Vec<String> = tools.iter().map(|tool| tool.name.to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["list_secret_executors", "list_secrets", "read_secret", "use_secret"]);

    let printed = serde_json::to_string(&tools).unwrap();
    assert!(!printed.contains(CANARY), "tool metadata must not carry a value");
    assert!(!printed.contains("canary"), "tool metadata must not carry a canary");
    for tool in &tools {
        assert!(!tool.description.as_deref().unwrap_or_default().is_empty(), "{} needs a description", tool.name);
    }
    let by_name = |name: &str| tools.iter().find(|tool| tool.name == name).cloned().unwrap();

    // A reference in the text identifies the secret id, so a model can go from the
    // prompt to a call without inventing an argument.
    let list = by_name("list_secrets");
    assert!(list.description.as_deref().unwrap().contains("{{cliora-secret:<secret-id>}}"));
    // The read tool states the two facts a caller has to know before using it.
    let read = by_name("read_secret");
    let read_text = read.description.as_deref().unwrap();
    assert!(read_text.contains("approval"), "{read_text}");
    assert!(read_text.contains("model context"), "{read_text}");
    assert!(read_text.contains("use_secret"), "{read_text}");
    // The read schema carries the secret id only; the executor is not a read input.
    let read_properties = read.input_schema.get("properties").unwrap().as_object().unwrap();
    assert_eq!(read_properties.keys().map(String::as_str).collect::<Vec<_>>(), vec!["secretId"]);
    assert_eq!(read.input_schema.get("required").unwrap(), &json!(["secretId"]));

    let use_secret = by_name("use_secret");
    let use_properties = use_secret.input_schema.get("properties").unwrap().as_object().unwrap();
    let mut keys: Vec<&str> = use_properties.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, vec!["executorId", "secretId"]);
    assert_eq!(use_secret.input_schema.get("required").unwrap(), &json!(["secretId", "executorId"]));
    // No schema has a value-shaped input: a caller cannot hand a value back in.
    assert!(!printed.contains("\"value\""));
}

#[test]
fn an_unknown_executor_field_is_refused_by_the_schema() {
    // `deny_unknown_fields` keeps a model from smuggling an unexpected argument.
    let refused = serde_json::from_value::<UseSecretArgs>(json!({ "secretId": "a", "executorId": "b", "value": "x" }));
    assert!(refused.is_err());
    let accepted = serde_json::from_value::<UseSecretArgs>(json!({ "secretId": "a", "executorId": "b" })).unwrap();
    assert_eq!(accepted.secret_id, "a");
    assert_eq!(accepted.executor_id, "b");
    let read = serde_json::from_value::<ReadSecretArgs>(json!({ "secretId": "a", "executorId": "b" }));
    assert!(read.is_err());
}

#[test]
fn executor_metadata_is_derived_from_the_authorized_list() {
    let view = executor_view(&json!({
        "secrets": [
            { "id": "s1", "alias": "第一", "executors": [{ "id": "e1", "label": "部署", "digestOk": true }] },
            { "id": "s2", "alias": "第二", "executors": [{ "id": "e1", "label": "部署", "digestOk": true }] },
            { "id": "s3", "alias": "第三", "executors": [{ "id": "e2", "label": "只读", "digestOk": false }] }
        ]
    }));
    let rows = view["executors"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "e1");
    assert_eq!(rows[0]["secretIds"], json!(["s1", "s2"]));
    assert_eq!(rows[0]["digestOk"], true);
    assert_eq!(rows[1]["id"], "e2");
    assert_eq!(rows[1]["digestOk"], false);
    // An empty or malformed payload cannot conjure an executor.
    assert_eq!(executor_view(&json!({}))["executors"], json!([]));
}

// ---------------------------------------------------------------------------
// Protocol, over a real broker
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn isolated() -> (tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
    let guard = ipc::test_lock();
    let directory = tempfile::tempdir().unwrap();
    ipc::set_test_root(Some(directory.path().to_path_buf()));
    (directory, guard)
}

/// Stands in for the confirmation window at the public answer entry point.
#[cfg(unix)]
struct Window {
    accept: bool,
}

#[cfg(unix)]
impl Host for Window {
    fn ask(&self, prompt: &Prompt) -> Result<(), String> {
        let id = prompt.approval_id.clone();
        let accept = self.accept;
        std::thread::spawn(move || {
            let _ = crate::secrets::approval::answer(&id, accept);
        });
        Ok(())
    }
}

/// The broker's request handling, unchanged from the application: an installation
/// check, the grants, the executor run, the approval and the audit row.
#[cfg(unix)]
struct Proxy {
    database: Arc<Database>,
    credentials: Arc<MemoryCredentials>,
    accept_reads: bool,
}

#[cfg(unix)]
impl ipc::Handler for Proxy {
    fn handle(&self, request: ipc::Request, cancel: &AtomicBool) -> ipc::Response {
        match request.operation {
            Operation::List => broker::list(&self.database, &*self.credentials, &request.installation),
            Operation::Use => match (request.secret_id.as_deref(), request.executor_id.as_deref()) {
                (Some(secret_id), Some(executor_id)) => broker::use_secret(
                    &self.database,
                    &*self.credentials,
                    &request.installation,
                    secret_id,
                    executor_id,
                    cancel,
                ),
                _ => ipc::Response::failure(audit::code::INVALID_REQUEST, "use 需要 secretId 和 executorId"),
            },
            Operation::Read => match request.secret_id.as_deref() {
                Some(secret_id) => broker::read_secret(
                    &self.database,
                    &*self.credentials,
                    &Window { accept: self.accept_reads },
                    &request.installation,
                    secret_id,
                ),
                None => ipc::Response::failure(audit::code::INVALID_REQUEST, "read 需要 secretId"),
            },
        }
    }
}

#[cfg(unix)]
fn broker_for(uses: &Uses, accept_reads: bool) -> ipc::Broker {
    ipc::serve(Arc::new(Proxy {
        database: uses.database.clone(),
        credentials: uses.credentials.clone(),
        accept_reads,
    }))
    .unwrap()
}

/// Runs the server and a client over one duplex stream, exactly as the stdio
/// transport connects them, and returns `(isError, text)` per call.
#[cfg(unix)]
fn exchange(installation: &str, calls: Vec<(&'static str, Value)>) -> Vec<(bool, String)> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(async move {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let id = installation.to_owned();
        let server = tokio::spawn(async move {
            if let Ok(service) = SecretMcp::new(id).serve(server_io).await {
                let _ = service.waiting().await;
            }
        });
        let run = async {
            let client = ().serve(client_io).await.expect("the helper must complete the handshake");
            let mut results = Vec::new();
            for (tool, arguments) in calls {
                let params = rmcp::model::CallToolRequestParams::new(tool)
                    .with_arguments(arguments.as_object().cloned().unwrap_or_default());
                let result = client.call_tool(params).await.expect("the tool must answer");
                let text = result
                    .structured_content
                    .map(|value| value.to_string())
                    .or_else(|| result.content.first().and_then(|content| content.as_text().map(|text| text.text.clone())))
                    .unwrap_or_default();
                results.push((result.is_error.unwrap_or(false), text));
            }
            let _ = client.cancel().await;
            results
        };
        let results = tokio::time::timeout(PROTO_TIMEOUT, run).await.expect("the protocol must not hang");
        server.abort();
        results
    })
}

#[cfg(unix)]
const PROTO_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(unix)]
#[test]
fn a_list_over_the_protocol_returns_metadata_only() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, false);
    let results = exchange(&uses.installation.id, vec![("list_secrets", json!({})), ("list_secret_executors", json!({}))]);
    assert_eq!(results.len(), 2);
    let (list_error, list) = &results[0];
    assert!(!list_error, "{list}");
    assert!(list.contains(&uses.secret.alias), "{list}");
    assert!(list.contains(&uses.secret.id), "{list}");
    assert!(!list.contains(CANARY), "a list must not return a value");
    let (executor_error, executors) = &results[1];
    assert!(!executor_error, "{executors}");
    assert!(executors.contains(&uses.executor.id), "{executors}");
    assert!(executors.contains(&uses.secret.id), "{executors}");
    assert!(!executors.contains(CANARY), "executor metadata must not carry a value");
    drop(broker);
}

#[cfg(unix)]
#[test]
fn a_use_without_a_grant_is_refused_without_a_value() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    let broker = broker_for(&uses, false);
    let results = exchange(
        &uses.installation.id,
        vec![("use_secret", json!({ "secretId": uses.secret.reference, "executorId": uses.executor.id }))],
    );
    let (is_error, text) = &results[0];
    assert!(is_error, "{text}");
    assert!(text.contains(audit::code::GRANT_MISSING), "{text}");
    assert!(!text.contains(CANARY));
    drop(broker);
}

#[cfg(unix)]
#[test]
fn an_approved_use_runs_the_executor_and_masks_the_output() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    let other = crate::secrets::create(&uses.database, &*uses.credentials, "另一个", OTHER).unwrap();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, false);
    let results = exchange(
        &uses.installation.id,
        vec![("use_secret", json!({ "secretId": uses.secret.reference, "executorId": uses.executor.id }))],
    );
    let (is_error, text) = &results[0];
    assert!(!is_error, "{text}");
    // The executor printed its environment, so the masked line proves it received
    // the value on its registered channel and nothing was returned in the clear.
    assert!(text.contains("CLIORAMCP=[redacted]"), "{text}");
    assert!(!text.contains(CANARY));
    assert!(!text.contains(OTHER));
    assert!(!other.id.is_empty());
    let rows = audit::list(&uses.database, 20).unwrap();
    assert!(rows.iter().any(|row| row.operation == "use" && row.code == audit::code::OK));
    drop(broker);
}

#[cfg(unix)]
#[test]
fn a_declined_read_returns_no_value_at_the_protocol_level() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, false);
    let results = exchange(&uses.installation.id, vec![("read_secret", json!({ "secretId": uses.secret.id }))]);
    let (is_error, text) = &results[0];
    assert!(is_error, "{text}");
    assert!(!text.contains(CANARY), "a refusal must not leak the value");
    let rows = audit::list(&uses.database, 20).unwrap();
    assert!(rows.iter().any(|row| row.operation == "read" && row.decision == "denied"));
    drop(broker);
}

#[cfg(unix)]
#[test]
fn an_accepted_read_returns_the_value_only_after_the_native_approval() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, true);
    // Two reads: each one created its own approval, so each one is answered again.
    let results = exchange(
        &uses.installation.id,
        vec![("read_secret", json!({ "secretId": uses.secret.id })), ("read_secret", json!({ "secretId": uses.secret.id }))],
    );
    for (is_error, text) in &results {
        assert!(!is_error, "{text}");
        assert!(text.contains(CANARY), "the approved read returns the value: {text}");
    }
    let rows = audit::list(&uses.database, 20).unwrap();
    assert_eq!(rows.iter().filter(|row| row.operation == "read" && row.decision == "allowed").count(), 2);
    drop(broker);
}

#[cfg(unix)]
#[test]
fn an_offline_broker_fails_closed_and_returns_no_value() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    // No broker is served on this test root: the helper has nothing to ask.
    let results = exchange(
        &uses.installation.id,
        vec![("list_secrets", json!({})), ("read_secret", json!({ "secretId": uses.secret.id }))],
    );
    for (is_error, text) in &results {
        assert!(is_error, "a helper without a broker must fail closed: {text}");
        assert!(!text.contains(CANARY));
        assert!(text.contains(ipc::CODE_OFFLINE) || text.contains("秘密代理"), "{text}");
    }
}

#[cfg(unix)]
#[test]
fn an_installation_without_identity_is_refused_before_any_value() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, true);
    // The helper holds another installation: the grant of the first one is not it.
    let results = exchange(&identifier(), vec![("list_secrets", json!({})), ("read_secret", json!({ "secretId": uses.secret.id }))]);
    for (is_error, text) in &results {
        assert!(is_error, "{text}");
        assert!(text.contains(audit::code::INSTALLATION_UNKNOWN), "{text}");
        assert!(!text.contains(CANARY));
    }
    drop(broker);
}

#[cfg(unix)]
#[test]
fn a_revoked_installation_loses_access_without_being_replaced() {
    let (_directory, _guard) = isolated();
    let uses = uses();
    broker::grant(&uses.database, &uses.installation.id, &uses.secret.id, &uses.executor.id).unwrap();
    let broker = broker_for(&uses, false);
    broker::revoke_installation(&uses.database, &uses.installation.id).unwrap();
    let results = exchange(&uses.installation.id, vec![("list_secrets", json!({}))]);
    let (is_error, text) = &results[0];
    assert!(is_error, "{text}");
    assert!(!text.contains(CANARY));
    drop(broker);
}

// ---------------------------------------------------------------------------
// Placement, capability and protocol health
// ---------------------------------------------------------------------------

#[test]
fn an_unsupported_adapter_reports_a_reason_and_no_written_entry() {
    let database = Database::open(std::path::Path::new(":memory:")).unwrap();
    let registry = Registry::builtins();
    let Some(unsupported) = registry.iter().find(|adapter| !adapter.supports_mcp()) else { return };
    let target = SecretMcpTarget { tool_id: unsupported.id().to_string(), scope: Scope::Global, project_path: None, context_id: None };
    let state = status(&database, &registry, &target).unwrap();
    assert_eq!(state.state, STATE_UNSUPPORTED);
    assert_eq!(state.capability, "unsupported");
    assert!(!state.capability_reason.is_empty());
    // Without a written definition the placement is never inspected, so the state
    // needs no native file and cannot claim one.
    assert_eq!(state.placement, PLACEMENT_ABSENT);
    assert_eq!(state.health, HEALTH_UNKNOWN);
    assert!(!state.available);
    assert!(state.cli_fallback);
    // Writing is refused instead of writing an entry this CLI cannot read.
    let error = set_enabled(&database, &MemoryCredentials::default(), &registry, std::path::Path::new("/"), &target, true).unwrap_err();
    assert!(!error.is_empty());
}

#[test]
fn a_supported_mapping_stays_unverified_and_claims_nothing_before_a_write() {
    let database = Database::open(std::path::Path::new(":memory:")).unwrap();
    let registry = Registry::builtins();
    // A mapping without a complete acceptance record is the unverified case.
    let Some(adapter) = registry.iter().find(|adapter| adapter.supports_mcp() && !adapter.secret_mcp_capability().is_supported()) else { return };
    let target = SecretMcpTarget { tool_id: adapter.id().to_string(), scope: Scope::Global, project_path: None, context_id: None };
    let state = status(&database, &registry, &target).unwrap();
    // T3 publishes the mapping only: real model acceptance is separate evidence.
    assert_eq!(state.capability, "unverified");
    assert_eq!(state.state, STATE_UNVERIFIED);
    assert!(!state.available);
    assert_eq!(state.placement, PLACEMENT_ABSENT);
    assert_eq!(state.health, HEALTH_UNKNOWN);
    assert!(state.command.is_empty());
    assert!(state.installation_id.is_none());
    // No installation exists until a write needs one.
    assert!(installation_for(&database, adapter.id()).unwrap().is_none());
}

#[test]
fn a_project_scope_without_a_directory_is_refused_before_writing() {
    let database = Database::open(std::path::Path::new(":memory:")).unwrap();
    let registry = Registry::builtins();
    let Some(adapter) = registry.iter().find(|adapter| adapter.supports_mcp()) else { return };
    let target = SecretMcpTarget { tool_id: adapter.id().to_string(), scope: Scope::Project, project_path: None, context_id: None };
    let error = set_enabled(&database, &MemoryCredentials::default(), &registry, std::path::Path::new("/"), &target, true).unwrap_err();
    assert!(error.contains("项目"), "{error}");
    assert!(installation_for(&database, adapter.id()).unwrap().is_none());
}

#[test]
fn health_is_recorded_per_target_and_forgotten_on_request() {
    let tool = "fixture-tool";
    let installation = identifier();
    record_health(tool, &installation, Health { state: HEALTH_HEALTHY, detail: "已通过".into() });
    assert_eq!(health_of(tool, Some(&installation)).unwrap().state, HEALTH_HEALTHY);
    // Another installation of the same tool has no evidence of its own.
    assert!(health_of(tool, Some(&identifier())).is_none());
    forget_health(tool, None);
    assert!(health_of(tool, Some(&installation)).is_none());
}

#[test]
fn a_helper_that_cannot_negotiate_is_reported_as_failed() {
    // The probe spawns this test executable, which is not an MCP server: the
    // failure path is real, bounded and records no value.
    let tool = "fixture-probe";
    let installation = identifier();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let health = runtime.block_on(verify(tool, &installation));
    assert_ne!(health.state, HEALTH_HEALTHY, "{}", health.detail);
    assert!(!health.detail.is_empty());
    assert!(!health.detail.contains(CANARY));
    assert_eq!(health_of(tool, Some(&installation)).unwrap().state, health.state);
}

// ---------------------------------------------------------------------------
// Distribution through the shared preview/commit/CAS flow
// ---------------------------------------------------------------------------

/// One target whose global MCP mapping is a plain JSON file: the write is the
/// shared flow, not a second implementation of it.
fn distribution_target() -> SecretMcpTarget {
    SecretMcpTarget { tool_id: "pi".into(), scope: Scope::Global, project_path: None, context_id: None }
}

#[test]
fn enabling_writes_the_helper_entry_and_disabling_removes_it() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let native = temp.path().join(".pi/agent/mcp.json");
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    std::fs::write(&native, "{\"mcpServers\":{}}").unwrap();
    let target = distribution_target();
    // One store for every call: the native digest key it holds is part of the flow.
    let credentials = MemoryCredentials::default();

    let state = set_enabled(&db, &credentials, &registry, temp.path(), &target, true).unwrap();
    // The entry names the helper and one installation, and nothing else.
    let execution = std::env::current_exe().unwrap().to_string_lossy().into_owned();
    let installation = installation_for(&db, &target.tool_id).unwrap().expect("enabling creates the installation");
    assert_eq!(installation.kind, Kind::Mcp);
    assert_eq!(installation.target_id.as_deref(), Some(target.tool_id.as_str()));
    assert_eq!(state.installation_id.as_deref(), Some(installation.id.as_str()));
    assert_eq!(state.command, execution);
    assert_eq!(state.args, vec![MCP_ARGUMENT.to_string(), "--installation".to_string(), installation.id.clone()]);
    // A written entry is placement. The protocol has not run, so nothing is claimed.
    assert_eq!(state.placement, PLACEMENT_ENABLED);
    assert_eq!(state.health, HEALTH_UNKNOWN);
    assert!(!state.available);
    assert!(state.cli_fallback);
    assert_ne!(state.state, STATE_ENABLED);

    let written = std::fs::read_to_string(&native).unwrap();
    assert!(written.contains("cliora-secrets-pi"), "{written}");
    assert!(written.contains(&installation.id), "{written}");
    assert!(written.contains(MCP_ARGUMENT), "{written}");
    assert!(!written.contains(CANARY));
    // The managed entry stays out of the library: it is one per target, not an
    // editable copy of a prompt-library definition.
    let definitions = resources::list_definitions(&db).unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name, "cliora-secrets-pi");
    assert!(!definitions[0].in_library);

    let disabled = set_enabled(&db, &credentials, &registry, temp.path(), &target, false).unwrap();
    assert_eq!(disabled.placement, PLACEMENT_DISABLED);
    assert_eq!(disabled.state, STATE_UNVERIFIED);
    assert!(!disabled.available);
    // Disabling keeps the entry this definition owns and marks it off in the
    // native file; the shared flow decides the form, not this module.
    let after_disable = std::fs::read_to_string(&native).unwrap();
    assert!(after_disable.contains("cliora-secrets-pi"), "{after_disable}");
    assert!(after_disable.contains("false"), "{after_disable}");
    assert!(disabled.reason.contains("停用"), "{}", disabled.reason);
    // Disabling keeps the identity, so a later enable reuses the same grants.
    assert_eq!(installation_for(&db, &target.tool_id).unwrap().unwrap().id, installation.id);

    let enabled_again = set_enabled(&db, &credentials, &registry, temp.path(), &target, true).unwrap();
    assert_eq!(enabled_again.placement, PLACEMENT_ENABLED);
    assert_eq!(enabled_again.installation_id.as_deref(), Some(installation.id.as_str()));
    assert_eq!(installation_for(&db, &target.tool_id).unwrap().unwrap().id, installation.id);
}

#[test]
fn a_foreign_entry_with_the_same_name_is_reported_instead_of_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let native = temp.path().join(".pi/agent/mcp.json");
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    // A same-name entry nobody manages here: the write must stop, not take it over.
    std::fs::write(&native, "{\"mcpServers\":{\"cliora-secrets-pi\":{\"command\":\"other\",\"args\":[]}}}").unwrap();
    let error = set_enabled(&db, &MemoryCredentials::default(), &registry, temp.path(), &distribution_target(), true).unwrap_err();
    assert!(!error.is_empty());
    let after = std::fs::read_to_string(&native).unwrap();
    assert!(after.contains("\"command\":\"other\""), "{after}");
    assert!(resources::list_definitions(&db).unwrap().is_empty());
}

#[test]
fn revoking_the_installation_leaves_the_native_entry_alone() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let registry = Registry::builtins();
    let native = temp.path().join(".pi/agent/mcp.json");
    std::fs::create_dir_all(native.parent().unwrap()).unwrap();
    std::fs::write(&native, "{\"mcpServers\":{}}").unwrap();
    let target = distribution_target();
    let state = set_enabled(&db, &MemoryCredentials::default(), &registry, temp.path(), &target, true).unwrap();
    let installation = state.installation_id.clone().unwrap();

    let revoked = revoke(&db, &registry, &target).unwrap();
    // A revoked identity starts over: the panel reports no installation until the
    // next write creates one, and the written entry is not silently claimed again.
    assert!(revoked.installation_id.is_none());
    assert!(installation_for(&db, &target.tool_id).unwrap().is_none());
    let installations = broker::list_installations(&db).unwrap();
    assert!(installations.iter().any(|item| item.id == installation && item.revoked));
}
