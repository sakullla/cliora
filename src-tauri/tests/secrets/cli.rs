//! The CLI helper: it parses a closed set of arguments, forwards one request over
//! the per-user IPC address, prints one JSON document and never opens the database
//! or the credential store. These tests also cover the transport itself: an absent
//! broker fails closed, an invalid frame does not break the endpoint, and a caller
//! that stops waiting cancels the run it started.
use super::*;
use crate::secrets::ipc::{self, Handler, Request};
use crate::secrets::ipc::Response;
use serde_json::json;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn installation() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn a_list_invocation_carries_only_the_installation() {
    let id = installation();
    let invocation = parse(&args(&["--installation", &id, "list"])).unwrap();
    assert_eq!(invocation.installation, id);
    assert_eq!(invocation.operation, Operation::List);
    assert!(invocation.secret_ids.is_empty());
    assert!(invocation.executor_id.is_none());
}

#[test]
fn a_use_invocation_requires_both_identifiers() {
    let id = installation();
    let secret = uuid::Uuid::new_v4().to_string();
    let executor = uuid::Uuid::new_v4().to_string();
    let invocation = parse(&args(&["--installation", &id, "use", "--secret", &secret, "--executor", &executor])).unwrap();
    assert_eq!(invocation.operation, Operation::Use);
    // Flags are order-independent, but a list never carries identifiers.
    let reordered = parse(&args(&["use", "--executor", &executor, "--secret", &secret, "--installation", &id])).unwrap();
    assert_eq!(reordered, invocation);
    let reference = crate::secrets::format_reference(&secret);
    assert_eq!(parse(&args(&["use", "--executor", &executor, "--secret", &reference, "--installation", &id])).unwrap(), invocation);
    assert!(parse(&args(&["use", "--executor", &executor, "--secret", &format!("other {reference}"), "--installation", &id])).is_err());
    assert!(parse(&args(&["list", "--installation", &id, "--secret", &secret, "--executor", &executor])).is_err());
    assert_eq!(invocation.secret_ids, vec![secret.clone()]);
    assert_eq!(invocation.executor_id.as_deref(), Some(executor.as_str()));
    assert!(parse(&args(&["--installation", &id, "use", "--secret", &secret])).is_err());
    assert!(parse(&args(&["--installation", &id, "use", "--executor", &executor])).is_err());
}

#[test]
fn a_read_invocation_refuses_a_controlled_use_executor() {
    let id = installation();
    let secret = uuid::Uuid::new_v4().to_string();
    let executor = uuid::Uuid::new_v4().to_string();
    let invocation = parse(&args(&["read", "--installation", &id, "--secret", &secret])).unwrap();
    assert_eq!(invocation.operation, Operation::Read);
    assert_eq!(invocation.secret_ids, vec![secret.clone()]);
    let refused = parse(&args(&["read", "--installation", &id, "--secret", &secret, "--executor", &executor]));
    assert!(refused.is_err());
    // A missing secret is a usage error, not an approval prompt.
    assert!(parse(&args(&["read", "--installation", &id])).is_err());
}

#[test]
fn only_read_accepts_multiple_secret_references() {
    let id = installation();
    let first = installation();
    let second = installation();
    let reference = crate::secrets::format_reference(&second);
    let parsed = parse(&args(&["read", "--installation", &id, "--secret", &first, "--secret", &reference])).unwrap();
    assert_eq!(parsed.secret_ids, vec![first.clone(), second]);
    assert!(parse(&args(&["read", "--installation", &id, "--secret", &first, "--secret", "invalid"])).is_err());
    assert!(parse(&args(&["use", "--installation", &id, "--secret", &first, "--secret", &reference, "--executor", &id])).is_err());
}

#[test]
fn malformed_arguments_are_refused_before_any_request() {
    let id = installation();
    assert!(parse(&args(&["list"])).is_err());
    assert!(parse(&args(&["--installation", "not-a-uuid", "list"])).is_err());
    assert!(parse(&args(&["--installation", &id])).is_err());
    assert!(parse(&args(&["--installation", &id, "delete"])).is_err());
    assert!(parse(&args(&["--installation", &id, "list", "--verbose"])).is_err());
    assert!(parse(&args(&["--installation", &id, "list", "read"])).is_err());
    assert!(parse(&args(&["--installation"])).is_err());
    assert!(parse(&args(&["--installation", &id, "list", "--secret", "x"])).is_err());
    // Repeating a flag keeps the last value instead of guessing which one was meant.
    let second = uuid::Uuid::new_v4().to_string();
    let invocation = parse(&args(&["--installation", &id, "--installation", &second, "list"])).unwrap();
    assert_eq!(invocation.installation, second);
}

#[test]
fn help_prints_usage_without_running_a_command() {
    assert_eq!(parse(&args(&["--help"])), Err(String::new()));
    assert_eq!(parse(&args(&["-h"])), Err(String::new()));
    // The usage text documents every command and the read warning.
    assert!(USAGE.contains("list"));
    assert!(USAGE.contains("use --secret"));
    assert!(USAGE.contains("read --secret"));
    assert!(USAGE.contains("CLIORA") || USAGE.contains("cliora"));
}

#[test]
fn a_document_keeps_the_value_in_data_only() {
    let ok = Response::success("ok", json!({ "alias": "别名", "value": "value-in-data" }));
    let printed = document(Operation::Read, &ok);
    assert_eq!(printed["ok"], true);
    assert_eq!(printed["data"]["value"], "value-in-data");

    let failed = Response::failure("declined", "已拒绝本次原值读取");
    let printed = document(Operation::Read, &failed);
    assert_eq!(printed["ok"], false);
    assert_eq!(printed["code"], "declined");
    assert_eq!(printed["message"], "已拒绝本次原值读取");
    assert!(printed.get("data").is_none());
}

fn isolated() -> (tempfile::TempDir, std::sync::MutexGuard<'static, ()>) {
    let guard = ipc::test_lock();
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    ipc::set_test_root(Some(directory.path().to_path_buf()));
    #[cfg(windows)]
    ipc::set_test_root(Some(format!(r"\\.\pipe\cliora-secret-cli-test-{}", installation())));
    (directory, guard)
}

struct Forward;

impl Handler for Forward {
    fn handle(&self, request: Request, _: &std::sync::atomic::AtomicBool) -> Response {
        Response::success("ok", json!({
            "operation": request.operation, "installation": request.installation,
            "secretId": request.secret_id, "secretIds": request.secret_ids, "hasSession": request.session.is_some(),
        }))
    }
}

#[test]
fn a_workbench_cli_passes_its_lease_and_an_external_batch_has_none() {
    let (_directory, _guard) = isolated();
    let _broker = ipc::serve(std::sync::Arc::new(Forward)).unwrap();
    let id = installation();
    let first = installation();
    let second = installation();
    let external = parse(&args(&["read", "--installation", &id, "--secret", &first, "--secret", &second])).unwrap();
    let data = dispatch(&external, None).unwrap().data.unwrap();
    assert_eq!(data["secretIds"], json!([first, second]));
    assert_eq!(data["hasSession"], false);
    let local = parse(&args(&["read", "--installation", &id, "--secret", &first])).unwrap();
    let lease = crate::secrets::session::LocalSession::new();
    let data = dispatch(&local, Some(lease.token())).unwrap().data.unwrap();
    assert_eq!(data["secretId"], first);
    assert_eq!(data["hasSession"], true);
}

#[cfg(unix)]
#[test]
fn the_helper_reaches_the_served_endpoint_and_gets_one_document() {
    let (_directory, _guard) = isolated();
    let broker = ipc::serve(std::sync::Arc::new(Forward)).unwrap();
    let id = installation();
    let response = ipc::call(&id, Operation::List, None, None).unwrap();
    assert!(response.ok);
    let data = response.data.unwrap();
    assert_eq!(data["operation"], "list");
    assert_eq!(data["installation"], id);
    drop(broker);
    // After shutdown the endpoint is gone, so the same call fails closed.
    assert!(ipc::call(&id, Operation::List, None, None).is_err());
}

#[cfg(unix)]
#[test]
fn an_absent_broker_fails_closed_without_a_value() {
    let (_directory, _guard) = isolated();
    let error = ipc::call(&installation(), Operation::Read, None, None).unwrap_err();
    assert!(error.contains("秘密代理"), "{error}");
    // A second start after a stop works: the address is reused, not leaked.
    let broker = ipc::serve(std::sync::Arc::new(Forward)).unwrap();
    assert!(ipc::call(&installation(), Operation::List, None, None).unwrap().ok);
    drop(broker);
}

#[cfg(unix)]
#[test]
fn an_invalid_frame_does_not_take_the_endpoint_down() {
    let (_directory, _guard) = isolated();
    let broker = ipc::serve(std::sync::Arc::new(Forward)).unwrap();
    ipc::send_and_drop("not a request").unwrap();
    ipc::send_and_drop(&json!({ "version": 99, "installation": installation(), "operation": "list" }).to_string()).unwrap();
    let response = ipc::call(&installation(), Operation::List, None, None).unwrap();
    assert!(response.ok, "{}", response.message);
    drop(broker);
}

#[cfg(unix)]
#[test]
fn a_request_that_arrives_after_the_broker_accepts_is_still_answered() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    // An accepted socket inherits the listener's non-blocking flag on macOS and
    // the BSDs, so the broker's first read can run before the caller's bytes
    // exist. This test holds the connection open without writing, which is only
    // safe if that read blocks instead of failing and closing the connection.
    let (_directory, _guard) = isolated();
    let broker = ipc::serve(std::sync::Arc::new(Forward)).unwrap();
    let address = ipc::test_address().unwrap();
    let mut stream = UnixStream::connect(&address).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let id = installation();
    let request = json!({
        "version": ipc::PROTOCOL_VERSION,
        "installation": id,
        "operation": "list",
    });
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    let written = stream.write_all(&bytes).and_then(|_| stream.flush());
    assert!(written.is_ok(), "the broker closed the connection before the request arrived: {written:?}");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut line = String::new();
    let read = BufReader::new(stream).read_line(&mut line);
    assert!(read.is_ok(), "the broker must answer the late request: {read:?}");
    assert!(!line.trim().is_empty(), "the broker answered nothing: {read:?}");
    let response: Response = serde_json::from_str(line.trim()).unwrap();
    assert!(response.ok, "{}", response.message);
    let data = response.data.unwrap();
    assert_eq!(data["operation"], "list");
    assert_eq!(data["installation"], id);
    drop(broker);
}

#[cfg(unix)]
#[test]
fn a_caller_that_stops_waiting_cancels_the_running_request() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    struct Slow {
        started: Arc<AtomicBool>,
        cancelled: Arc<Mutex<Option<bool>>>,
    }

    impl Handler for Slow {
        fn handle(&self, _: Request, cancel: &AtomicBool) -> Response {
            self.started.store(true, Ordering::SeqCst);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if cancel.load(Ordering::SeqCst) {
                    *self.cancelled.lock().unwrap() = Some(true);
                    return Response::failure("cancelled", "已取消");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            *self.cancelled.lock().unwrap() = Some(false);
            Response::success("ok", json!({}))
        }
    }

    let (_directory, _guard) = isolated();
    let started = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(Mutex::new(None));
    let broker = ipc::serve(Arc::new(Slow { started: started.clone(), cancelled: cancelled.clone() })).unwrap();
    let request = json!({
        "version": ipc::PROTOCOL_VERSION,
        "installation": installation(),
        "operation": "use",
        "secretId": installation(),
        "executorId": installation(),
    });
    ipc::send_and_drop(&request.to_string()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline && cancelled.lock().unwrap().is_none() {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(started.load(Ordering::SeqCst), "the request must reach the broker");
    assert_eq!(*cancelled.lock().unwrap(), Some(true), "the broker must stop a run whose caller left");
    drop(broker);
}
