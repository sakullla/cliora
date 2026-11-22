//! Headless bridge used by Twiglane. The desktop owns the SSH target and credentials.
use super::{
    ensure_enabled, list_targets, password, twiglane_config::Snapshot,
    twiglane_trust::DefaultTrust, RemoteTarget,
};
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
const V2_POSIX: &str = include_str!("twiglane_agent_v2.sh");
const V2_WINDOWS: &str = include_str!("twiglane_agent_v2.ps1");
const MAX_V2_UPLOAD: u64 = 32 * 1024 * 1024 + 1;

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

fn identity(target: &RemoteTarget, defaults: &DefaultTrust) -> Result<Value> {
    let snapshot = Snapshot::resolve_with_defaults(target, defaults)?;
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

fn signed_digest(publisher: &str, agent: &str, digest: &str, signature: &str) -> Result<()> {
    if !valid_digest(digest) || signature.len() > 4096 {
        return Err("invalid_artifact");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|_| "invalid_artifact")?;
    let signature = Signature::decode(std::str::from_utf8(&bytes).map_err(|_| "invalid_artifact")?)
        .map_err(|_| "invalid_artifact")?;
    let key = PublicKey::from_base64(publisher).map_err(|_| "invalid_artifact")?;
    let manifest = format!("{agent} sha256:{digest}\n");
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
    signed_digest(PUBLISHER, "twiglane-agent-v1", digest, signature)
}

fn verify_v2_artifact(digest: &str, signature: &str) -> Result<()> {
    #[cfg(debug_assertions)]
    if std::env::var_os("CLIORA_TWIGLANE_TEST_DB").is_some() {
        if let Ok(publisher) = std::env::var("CLIORA_TWIGLANE_TEST_V2_PUBLISHER") {
            return signed_digest(&publisher, "twiglane-agent-v2", digest, signature);
        }
    }
    signed_digest(PUBLISHER, "twiglane-agent-v2", digest, signature)
}

pub(super) fn configure_ssh(command: &mut Command, target: &RemoteTarget) -> Result<()> {
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
    Ok(())
}

fn configure_transport(
    command: &mut Command,
    target: &RemoteTarget,
    op: &str,
    artifact: Option<(&str, &str)>,
) -> Result<()> {
    configure_ssh(command, target)?;
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
    input_limit: Option<u64>,
) -> Result<(std::process::ExitStatus, bool)> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "ssh_unavailable")?;
    let mut remote_input = child.stdin.take().ok_or("ssh_unavailable")?;
    let mut remote_output = child.stdout.take().ok_or("ssh_unavailable")?;
    let mut ready = [0; b"twiglane-peer/1\n".len()];
    let read = remote_output.read_exact(&mut ready);
    if read.is_err() || ready != *b"twiglane-peer/1\n" {
        drop(remote_input);
        if read.as_ref().is_err_and(|error| error.kind() == std::io::ErrorKind::UnexpectedEof) {
            // SSH can deliver stdout EOF just before its process reports the
            // remote exit code. Preserve 127 for the absent-shell fallback.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
            loop {
                if let Some(status) = child.try_wait().map_err(|_| "ssh_unavailable")? {
                    if !status.success() {
                        return Ok((status, false));
                    }
                    return Err("peer_unverified");
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        return Err("peer_unverified");
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
        let mut input = std::io::stdin().lock();
        if let Some(limit) = input_limit {
            let _ = std::io::copy(&mut input.take(limit), &mut remote_input);
        } else {
            let _ = std::io::copy(&mut input, &mut remote_input);
        }
    });
    if std::io::copy(&mut remote_output, &mut std::io::stdout().lock()).is_err() {
        let _ = child.kill();
    }
    child.wait().map(|status| (status, true)).map_err(|_| "ssh_unavailable")
}

fn windows_v2_command(op: &str, digest: &str) -> Result<String> {
    let script = V2_WINDOWS.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).collect::<Vec<_>>().join("\n");
    let mut compressed = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    compressed.write_all(script.as_bytes()).map_err(|_| "bootstrap_unavailable")?;
    let packed = base64::engine::general_purpose::STANDARD
        .encode(compressed.finish().map_err(|_| "bootstrap_unavailable")?);
    // The small loader keeps OpenSSH's complete cmd.exe command below 8191 chars.
    let loader = format!("$op='{op}';$digest='{digest}';$bytes=[Convert]::FromBase64String('{packed}');$stream=[IO.MemoryStream]::new($bytes);$inflate=[IO.Compression.DeflateStream]::new($stream,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($inflate);& ([ScriptBlock]::Create($reader.ReadToEnd()))");
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        loader.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>(),
    );
    let command = format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}");
    if command.len() > 7800 {
        return Err("bootstrap_unavailable");
    }
    Ok(command)
}

fn v2_probe_output(output: &[u8]) -> Result<Value> {
    let output = std::str::from_utf8(output).map_err(|_| "invalid_probe")?;
    let mut value = serde_json::Map::new();
    for line in output.lines() {
        let Some((key, field)) = line.split_once('=') else { continue; };
        let key = match key {
            "system" if matches!(field, "Linux" | "Darwin" | "Windows") => "system",
            "architecture" if !field.is_empty() => "architecture",
            "git" if !field.is_empty() => "gitVersion",
            "digest" if valid_digest(field) => "agentSha256",
            _ => continue,
        };
        if value.insert(key.into(), Value::String(field.into())).is_some() {
            return Err("invalid_probe");
        }
    }
    if !value.contains_key("system") || !value.contains_key("architecture") {
        return Err("invalid_probe");
    }
    Ok(Value::Object(value))
}

fn run_v2(op: &str, target: &RemoteTarget, snapshot: &Snapshot, revision: &str, digest: &str) -> Result<()> {
    let windows = windows_v2_command(op, digest)?;
    let posix = format!("exec sh -c {}", super::shell_quote(&format!("op={op}\ndigest={digest}\n{V2_POSIX}")));
    for (remote, fallback) in [(&windows, true), (&posix, false)] {
        let (mut command, config) = snapshot.command((op != "probe").then_some(revision))?;
        configure_ssh(&mut command, target)?;
        command.arg(remote);
        let mut output = Vec::new();
        let (status, authorized) = if op == "probe" {
            let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).spawn().map_err(|_| "ssh_unavailable")?;
            let read = child.stdout.take().ok_or("ssh_unavailable")?.take(65537).read_to_end(&mut output);
            if read.is_err() || output.len() > 65536 {
                let _ = child.kill();
                let _ = child.wait();
                return Err("invalid_probe");
            }
            (child.wait().map_err(|_| "ssh_unavailable")?, false)
        } else {
            verified_transport(
                &mut command, snapshot, config.path(), revision, (op == "install").then_some(MAX_V2_UPLOAD),
            )?
        };
        if config.path().join("mismatch").is_file() {
            return Err("target_changed");
        }
        if fallback && !authorized && status.code() == Some(127) {
            continue;
        }
        if !status.success() {
            return Err("remote_bootstrap_failed");
        }
        if op == "probe" {
            let mut value = v2_probe_output(&output)?;
            value["peerRevision"] = json!(super::twiglane_peer::token(config.path(), &snapshot.revision, snapshot.count)?);
            value["peerIdentity"] = json!(super::twiglane_peer::host_identity(config.path())?);
            println!("{value}");
        }
        return Ok(());
    }
    Err("remote_bootstrap_failed")
}

fn run(args: &[String], database: impl FnOnce() -> Result<PathBuf>) -> Result<()> {
    if args == ["version"] {
        println!(
            "{}",
            json!({"protocol":1,"kind":"cliora-twiglane-connector-v1","capabilities":["reviewReceipt","agentV2"]})
        );
        return Ok(());
    }
    let (op, target, revision, digest) = match args {
        [op] if op == "list" => {
            let targets = registered_targets(&database()?)?;
            let mut available = Vec::new();
            let mut unavailable = Vec::new();
            let defaults = DefaultTrust::new();
            for target in targets {
                match identity(&target, &defaults) {
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
        [op, review, session, revision] if op == "review-receipt" => {
            use crate::twiglane::remote_review;
            if !remote_review::id(review) || !remote_review::id(session) {
                return Err("invalid_arguments");
            }
            let revision = remote_review::receipt_revision(revision).ok_or("invalid_arguments")?;
            let db = Database::open_read_only(&database()?).map_err(|_| "database_unavailable")?;
            let stored = remote_review::stored_result(&db, review, session, revision)
                .map_err(|_| "database_unavailable")?;
            println!("{}", json!({"stored":stored}));
            return Ok(());
        }
        [op, id, revision] if op == "probe-v2" => {
            let targets = registered_targets(&database()?)?;
            let (target, snapshot) = resolve(&targets, id, Some(revision))?;
            return run_v2("probe", target, &snapshot, revision, "");
        }
        [op, id, revision, digest, signature] if op == "install-v2" || op == "connect-v2" => {
            verify_v2_artifact(digest, signature)?;
            let targets = registered_targets(&database()?)?;
            let (target, snapshot) = resolve(&targets, id, None)?;
            if !valid_digest(revision) || revision == &snapshot.revision {
                return Err("probe_required");
            }
            let action = if op == "install-v2" { "install" } else { "connect" };
            return run_v2(action, target, &snapshot, revision, digest);
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
        verified_transport(&mut command, &snapshot, private_config.path(), revision, None)?.0
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
        assert!(signed_digest(key, "twiglane-agent-v1", digest, signature).is_ok());
        assert_eq!(
            signed_digest(key, "twiglane-agent-v2", digest, signature),
            Err("invalid_artifact")
        );
        assert_eq!(
            signed_digest(PUBLISHER, "twiglane-agent-v1", digest, signature),
            Err("invalid_artifact")
        );
        assert_eq!(
            signed_digest(key, "twiglane-agent-v1", &"f".repeat(64), signature),
            Err("invalid_artifact")
        );
    }

    #[test]
    fn agent_v2_probe_fields_and_encoded_command_are_bounded() {
        let digest = "a".repeat(64);
        let output = format!("system=Windows\r\narchitecture=AMD64\r\ngit=git version fixture\r\ndigest={digest}\r\n");
        assert_eq!(
            v2_probe_output(output.as_bytes()).unwrap(),
            json!({"system":"Windows","architecture":"AMD64","gitVersion":"git version fixture","agentSha256":digest}),
        );
        assert_eq!(v2_probe_output(b"system=Windows\narchitecture=AMD64\narchitecture=test\n"), Err("invalid_probe"));
        assert_eq!(v2_probe_output(b"architecture=AMD64\n"), Err("invalid_probe"));
        let command = windows_v2_command("connect", &digest).unwrap();
        let (launcher, payload) = command.rsplit_once(' ').unwrap();
        assert_eq!(launcher, "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand");
        assert!(command.len() < 7800 && payload.len() > 300);
    }

    #[cfg(windows)]
    #[test]
    fn windows_v2_waits_for_trust_before_upload_and_preserves_binary_stdin() {
        use sha2::{Digest, Sha256};
        let directory = tempfile::tempdir().unwrap();
        let privacy = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", r"
                $acl = [Security.AccessControl.DirectorySecurity]::new()
                $acl.SetAccessRuleProtection($true, $false)
                $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
                [IO.Directory]::SetAccessControl($env:CLIORA_V2_TEST_PROFILE, $acl)
            "])
            .env("CLIORA_V2_TEST_PROFILE", directory.path())
            .output()
            .unwrap();
        assert!(privacy.status.success(), "{}", String::from_utf8_lossy(&privacy.stderr));
        let bytes = b"binary\x00\xff\x0a\x0d\x1a";
        let digest = format!("{:x}", Sha256::digest(bytes));
        let run = |op: &str, input: &[u8]| {
            let command = windows_v2_command(op, &digest).unwrap();
            let mut words = command.split_ascii_whitespace();
            let mut child = Command::new(words.next().unwrap())
                .args(words)
                .env("LOCALAPPDATA", directory.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(input).unwrap();
            child.wait_with_output().unwrap()
        };
        let blocked = run("install", b"X");
        assert!(!blocked.status.success());
        assert_eq!(blocked.stdout, b"twiglane-peer/1\n");
        assert!(!directory.path().join("Twiglane").exists());
        let mut upload = vec![b'G'];
        upload.extend_from_slice(bytes);
        let installed = run("install", &upload);
        assert!(installed.status.success(), "{}", String::from_utf8_lossy(&installed.stderr));
        let directory = directory.path().join("Twiglane").join("agent").join("v2");
        assert_eq!(std::fs::read(directory.join(format!("twiglane-agent-v2-{digest}.exe"))).unwrap(), bytes);
        assert_eq!(std::fs::read_to_string(directory.join("current.sha256")).unwrap(), digest);
        let probe = run("probe", b"");
        assert!(probe.status.success(), "{}", String::from_utf8_lossy(&probe.stderr));
        assert_eq!(v2_probe_output(&probe.stdout).unwrap()["agentSha256"], digest);
    }
}
