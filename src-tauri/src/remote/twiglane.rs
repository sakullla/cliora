//! Headless bridge used by Twiglane. The desktop owns the SSH target and credentials.
use super::{ensure_enabled, list_targets, password, twiglane_config::Snapshot, RemoteTarget};
use crate::database::Database;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const FLAG: &str = "--twiglane-remote-v1";
// Public key from Twiglane's updater configuration. The signed message identifies this artifact type.
const PUBLISHER: &str = "RWRszYkDnNMoJChLey0c/B04Xm7njuX4kQ93rjER35q05fHWA3ziVNIG";
const SETUP: &str = include_str!("twiglane_agent_setup.py");

type Result<T> = std::result::Result<T, &'static str>;

fn registered_targets(path: &Path) -> Result<Vec<RemoteTarget>> {
    let db = Database::open_read_only(path).map_err(|_| "database_unavailable")?;
    ensure_enabled(&db).map_err(|error| match error {
        super::RemoteError::Disabled => "remote_disabled",
        _ => "database_unavailable",
    })?;
    Ok(list_targets(&db)
        .map_err(|_| "database_unavailable")?
        .into_iter()
        .filter(|target| target.enabled)
        .collect())
}

fn identity(target: &RemoteTarget) -> Result<Value> {
    let snapshot = Snapshot::resolve(target)?;
    Ok(json!({
        "targetId": target.id,
        "targetRevision": snapshot.revision, "effectiveHost":snapshot.hostname,
        "name": target.name, "host": target.host, "user": target.user, "port": target.port,
        "authMethod": target.auth_method, "defaultPath": target.default_path,
    }))
}

fn resolve<'a>(
    targets: &'a [RemoteTarget],
    id: &str,
    revision: Option<&str>,
) -> Result<(&'a RemoteTarget, Snapshot)> {
    let target = targets
        .iter()
        .find(|target| target.enabled && target.id == id)
        .ok_or("target_unavailable")?;
    let snapshot = Snapshot::resolve(target)?;
    if revision.is_some_and(|revision| snapshot.revision != revision) {
        return Err("target_changed");
    }
    Ok((target, snapshot))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn signed_digest(publisher: &str, digest: &str, signature: &str) -> Result<()> {
    if !valid_digest(digest) || signature.len() > 4096 {
        return Err("invalid_artifact");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| "invalid_artifact")?;
    let signature = Signature::decode(std::str::from_utf8(&bytes).map_err(|_| "invalid_artifact")?)
        .map_err(|_| "invalid_artifact")?;
    let key = PublicKey::from_base64(publisher).map_err(|_| "invalid_artifact")?;
    let manifest = format!("twiglane-agent-v1 sha256:{digest}\n");
    key.verify(manifest.as_bytes(), &signature, false)
        .map_err(|_| "invalid_artifact")
}

fn verify_artifact(digest: &str, signature: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    if signature == "development" && valid_digest(digest) {
        use sha2::{Digest, Sha256};
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Twiglane/remote-agent/agent");
        let bytes = std::fs::read(path).map_err(|_| "development_artifact_unavailable")?;
        if format!("{:x}", Sha256::digest(bytes)) == digest {
            return Ok(());
        }
        return Err("invalid_artifact");
    }
    signed_digest(PUBLISHER, digest, signature)
}

fn configure_transport(
    command: &mut Command,
    target: &RemoteTarget,
    op: &str,
    artifact: Option<(&str, &str)>,
) -> Result<()> {
    let saved_auth = password::askpass_environment(target);
    let ephemeral = std::env::var_os("SSH_ASKPASS")
        .map(PathBuf::from)
        .is_some_and(|path| path.is_absolute() && path.is_file())
        && std::env::var("SSH_ASKPASS_REQUIRE").as_deref() == Ok("force");
    if target.auth_method == "password" && saved_auth.is_empty() && !ephemeral {
        return Err("password_required");
    }
    if saved_auth.is_empty() && !ephemeral {
        command.args(["-o", "BatchMode=yes"]);
    }
    command
        .env_remove(password::ASKPASS_ID_ENV)
        .envs(saved_auth);
    command
        .arg("--")
        .arg(format!("{}@{}", target.user, target.host));
    // The action comes from the exact match below; the optional digest is lowercase hex only.
    let mut packed = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    packed
        .write_all(SETUP.as_bytes())
        .map_err(|_| "bootstrap_unavailable")?;
    let source = base64::engine::general_purpose::STANDARD
        .encode(packed.finish().map_err(|_| "bootstrap_unavailable")?);
    let mut remote = format!("exec python3 -I -c \"import base64,zlib;exec(zlib.decompress(base64.b64decode('{source}')))\" {op}");
    if let Some((digest, signature)) = artifact {
        remote.push(' ');
        remote.push_str(digest);
        if op == "install" {
            remote.push(' ');
            remote.push_str(signature);
        }
    }
    command.arg(remote);
    Ok(())
}

fn verified_transport(
    command: &mut Command,
    snapshot: &Snapshot,
    folder: &Path,
    expected: &str,
) -> Result<std::process::ExitStatus> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "ssh_unavailable")?;
    let mut remote_input = child.stdin.take().ok_or("ssh_unavailable")?;
    let mut remote_output = child.stdout.take().ok_or("ssh_unavailable")?;
    let mut ready = [0; b"twiglane-peer/1\n".len()];
    if remote_output.read_exact(&mut ready).is_err() || ready != *b"twiglane-peer/1\n" {
        drop(remote_input);
        let _ = child.kill();
        let status = child.wait().map_err(|_| "ssh_unavailable")?;
        return if status.success() {
            Err("peer_unverified")
        } else {
            Ok(status)
        };
    }
    // Some OpenSSH configurations may skip KnownHostsCommand. Require the complete
    // observation before the bootstrap can create its directory or read any upload.
    let authorized = super::twiglane_peer::token(folder, &snapshot.revision, snapshot.count);
    if authorized.as_deref() != Ok(expected) || remote_input.write_all(b"G").is_err() {
        drop(remote_input);
        let _ = child.kill();
        let _ = child.wait();
        return Err("target_changed");
    }
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut remote_input);
    });
    if std::io::copy(&mut remote_output, &mut std::io::stdout().lock()).is_err() {
        let _ = child.kill();
    }
    child.wait().map_err(|_| "ssh_unavailable")
}

fn run(args: &[String], database: impl FnOnce() -> Result<PathBuf>) -> Result<()> {
    if args == ["version"] {
        println!(
            "{}",
            json!({"protocol":1,"kind":"cliora-twiglane-connector-v1"})
        );
        return Ok(());
    }
    let (op, target, revision, digest) = match args {
        [op] if op == "list" => {
            let targets = registered_targets(&database()?)?;
            let mut available = Vec::new();
            let mut unavailable = Vec::new();
            for target in targets {
                match identity(&target) {
                    Ok(value) => available.push(value),
                    Err(reason) => unavailable
                        .push(json!({"targetId":target.id, "name":target.name, "error":reason})),
                }
            }
            println!(
                "{}",
                json!({"protocol":1, "targets":available, "unavailable":unavailable})
            );
            return Ok(());
        }
        [op, id, rev] if op == "probe" => (op, id, rev, None),
        [op, id, rev, digest, signature] if op == "install" || op == "connect" => {
            verify_artifact(digest, signature)?;
            (op, id, rev, Some((digest.as_str(), signature.as_str())))
        }
        _ => return Err("unsupported_action"),
    };
    let targets = registered_targets(&database()?)?;
    let (target, snapshot) = resolve(&targets, target, (op == "probe").then_some(revision))?;
    if op != "probe" && revision == &snapshot.revision {
        return Err("probe_required");
    }
    if !valid_digest(revision) {
        return Err("target_changed");
    }
    let (mut command, private_config) = snapshot.command((op != "probe").then_some(revision))?;
    configure_transport(&mut command, target, op, digest)?;
    let mut response = Vec::new();
    let status = if op == "probe" {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|_| "ssh_unavailable")?;
        let read = child
            .stdout
            .take()
            .ok_or("ssh_unavailable")?
            .take(65537)
            .read_to_end(&mut response);
        if read.is_err() || response.len() > 65536 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("invalid_probe");
        }
        child.wait().map_err(|_| "ssh_unavailable")?
    } else {
        verified_transport(&mut command, &snapshot, private_config.path(), revision)?
    };
    if private_config.path().join("mismatch").is_file() {
        return Err("target_changed");
    }
    if status.success() && op == "probe" {
        let peer =
            super::twiglane_peer::token(private_config.path(), &snapshot.revision, snapshot.count)?;
        let mut value: Value = serde_json::from_slice(&response).map_err(|_| "invalid_probe")?;
        let probe = value.as_object_mut().ok_or("invalid_probe")?;
        probe.insert("peerRevision".into(), Value::String(peer));
        let identity = super::twiglane_peer::host_identity(private_config.path())?;
        probe.insert("peerIdentity".into(), Value::String(identity));
        println!("{value}");
    }
    drop(private_config);
    std::process::exit(status.code().unwrap_or(1));
}

/// Called before initializing the single-instance plugin, webview, or background work.
pub fn helper_entry() -> bool {
    let mut args = std::env::args_os().skip(1);
    let Some(flag) = args.next() else {
        return false;
    };
    if flag == super::twiglane_peer::FLAG {
        let args: std::result::Result<Vec<_>, _> = args.map(|arg| arg.into_string()).collect();
        if let Err(error) = args
            .map_err(|_| "peer_unverified")
            .and_then(|args| super::twiglane_peer::callback(&args))
        {
            eprintln!("{}", json!({"error":error}));
            std::process::exit(2);
        }
        return true;
    }
    if !flag.to_string_lossy().starts_with("--twiglane-remote-") {
        return false;
    }
    let result = if flag == FLAG {
        let args: std::result::Result<Vec<_>, _> = args.map(|arg| arg.into_string()).collect();
        args.map_err(|_| "invalid_arguments").and_then(|args| {
            run(&args, || {
                #[cfg(debug_assertions)]
                if let Some(path) = std::env::var_os("CLIORA_TWIGLANE_TEST_DB") {
                    let path = PathBuf::from(path);
                    return path
                        .is_absolute()
                        .then_some(path)
                        .ok_or("database_unavailable");
                }
                dirs::data_dir()
                    .map(|path| path.join("com.cliora.desktop").join("cliora.db"))
                    .ok_or("database_unavailable")
            })
        })
    } else {
        Err("unsupported_version")
    };
    if let Err(error) = result {
        eprintln!("{}", json!({"error":error}));
        std::process::exit(2);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_tauri_signer_proof_bound_to_the_specific_agent_manifest() {
        let key = "RWQ4EFJJiiZceqZ6tfqPJpcN307zXD0f8IapB/YL21p+3wYymkraQsvK";
        let digest = "68e89f8b2074e2627d62bee3a2b694e281432ef909eb7a5505f07bbffd917cbf";
        let signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRNEVGSkppaVpjZWhvR0JMUXdVa0ZhWWJlQ3F0MmhWUlo1WHJhWStrQnliUVBXaUJtZ3BxSTZ3aFVMdDVlZFVTSWs0UnB4ZkU5MmZIaWtJMWdhRkNGM1JUeXd6V0pOamdVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1MjEyMzAxCWZpbGU6YWdlbnQtbWFuaWZlc3QKTjVKakJSZGkySnkzRHlVem9YSGJ0M2NqZUd4YUdlc1Q0cXlCNnBUdCtqcXVManAvcnkvek1HeFF4Y2xFOXMyK0FlWE9PaWd2VVZNbXIzWUFGWGNHQ2c9PQo=";
        assert!(signed_digest(key, digest, signature).is_ok());
        assert_eq!(
            signed_digest(PUBLISHER, digest, signature),
            Err("invalid_artifact")
        );
        assert_eq!(
            signed_digest(key, &"f".repeat(64), signature),
            Err("invalid_artifact")
        );
    }
}
