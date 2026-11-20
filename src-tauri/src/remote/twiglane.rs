//! Headless bridge used by Twiglane. The desktop owns the SSH target and credentials.
use super::{
    connection_args, ensure_enabled, hide_console_window, list_targets, operations, password,
    validate_target, RemoteTarget,
};
use crate::database::Database;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn identity(target: &RemoteTarget) -> Value {
    json!({
        "targetId": target.id,
        "targetRevision": operations::target_identity(target),
        "name": target.name, "host": target.host, "user": target.user, "port": target.port,
        "authMethod": target.auth_method, "defaultPath": target.default_path,
    })
}

fn resolve(targets: &[RemoteTarget], id: &str, revision: &str) -> Result<RemoteTarget> {
    let target = targets
        .iter()
        .find(|target| target.enabled && target.id == id)
        .ok_or("target_unavailable")?;
    if operations::target_identity(target) != revision {
        return Err("target_changed");
    }
    validate_target(target).map_err(|_| "invalid_target")?;
    if target.user.starts_with('-') {
        return Err("invalid_target");
    }
    Ok(target.clone())
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

fn ssh(target: &RemoteTarget, op: &str, artifact: Option<(&str, &str)>) -> Result<Command> {
    let mut command = Command::new("ssh");
    hide_console_window(&mut command);
    // This SSH process is the long-lived agent transport. Reconnecting must recheck
    // the host key and credentials even when Cliora has an older ControlMaster.
    command.args([
        "-T",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "NumberOfPasswordPrompts=1",
    ]);
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
    let mut args = connection_args(target);
    let destination = args.pop().ok_or("invalid_target")?;
    command.args(args).arg("--").arg(destination);
    // The action comes from the exact match below; the optional digest is lowercase hex only.
    let source = SETUP.replace('\'', "'\\''");
    let mut remote = format!("exec python3 -I -c '{source}' {op}");
    if let Some((digest, signature)) = artifact {
        remote.push(' ');
        remote.push_str(digest);
        if op == "install" {
            remote.push(' ');
            remote.push_str(signature);
        }
    }
    command.arg(remote);
    Ok(command)
}

fn run(args: &[String], database: impl FnOnce() -> Result<PathBuf>) -> Result<()> {
    if args == ["version"] {
        println!("{}", json!({"protocol":1}));
        return Ok(());
    }
    let (op, target, revision, digest) = match args {
        [op] if op == "list" => {
            let targets = registered_targets(&database()?)?;
            println!(
                "{}",
                json!({"protocol":1, "targets":targets.iter().map(identity).collect::<Vec<_>>()})
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
    let target = resolve(&registered_targets(&database()?)?, target, revision)?;
    let mut command = ssh(&target, op, digest)?;
    #[cfg(unix)]
    {
        // SSH inherits the caller's three pipes and process ID, including cancellation.
        use std::os::unix::process::CommandExt;
        let _error = command.exec();
        Err("ssh_unavailable")
    }
    #[cfg(not(unix))]
    {
        let status = command.status().map_err(|_| "ssh_unavailable")?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// Called before initializing the single-instance plugin, webview, or background work.
pub fn helper_entry() -> bool {
    let mut args = std::env::args_os().skip(1);
    let Some(flag) = args.next() else {
        return false;
    };
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
