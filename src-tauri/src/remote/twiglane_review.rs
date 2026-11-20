//! Session review reads use a confirmed SSH connection even before Twiglane installs its agent.
use super::{twiglane::configure_ssh, twiglane_config::Snapshot, twiglane_peer, RemoteTarget};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{Read, Write},
    process::Stdio,
    sync::OnceLock,
};

const SCRIPT: &[u8] = include_bytes!("twiglane_review_metadata.py");

fn program() -> &'static str {
    static CODE: OnceLock<String> = OnceLock::new();
    CODE.get_or_init(|| {
        let mut compressed = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        compressed.write_all(SCRIPT).expect("in-memory compression");
        let packed = base64::engine::general_purpose::STANDARD.encode(compressed.finish().expect("in-memory compression"));
        format!("python3 -I -c \"import base64,zlib;exec(zlib.decompress(base64.b64decode('{packed}')))\"")
    })
}

pub(crate) fn record_command(session: &str) -> String {
    // The actual pane captures its own checkout immediately before starting the CLI.
    format!(
        "{} record '{}' >/dev/null 2>&1 || true",
        program(),
        session.replace('\'', "'\\''")
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
    pub target_id: String,
    pub target_revision: String,
    pub peer_revision: String,
    pub peer_identity: String,
    pub remote_session: String,
    pub project_id: String,
    pub directory: String,
    pub worktree_key: String,
    pub worktree_identity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    root: String,
    key: String,
    worktree_identity: String,
    head_oid: Option<String>,
    branch: Option<String>,
    uncommitted: u64,
    baseline: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ReadReply {
    Metadata(Metadata),
    Error { error: String },
}

pub(crate) fn read(
    target: &RemoteTarget,
    origin: &crate::launch::RemoteSessionIndexEntry,
    local_session: &str,
    expected: Option<&Binding>,
) -> Result<(Binding, crate::twiglane::CodeStatus), &'static str> {
    if !target.enabled || target.id != origin.target_id {
        return Err("target_changed");
    }
    let snapshot = Snapshot::resolve(target)?;
    if expected.is_some_and(|source| {
        source.target_id != target.id
            || source.target_revision != snapshot.revision
            || source.remote_session != origin.remote_session_id
            || source.project_id != origin.project_id
            || source.directory != origin.directory
    }) {
        return Err("target_changed");
    }
    let (mut command, context) = snapshot.command(expected.map(|b| b.peer_revision.as_str()))?;
    configure_ssh(&mut command, target)?;
    command
        .arg(format!("exec {} inspect", program()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| "read_failed")?;
    let result = (|| {
        let mut stdout = child.stdout.take().ok_or("read_failed")?;
        let mut ready = [0; b"cliora-review/1\n".len()];
        stdout.read_exact(&mut ready).map_err(|_| "read_failed")?;
        if ready != *b"cliora-review/1\n" {
            return Err("read_failed");
        }
        let peer_revision =
            twiglane_peer::token(context.path(), &snapshot.revision, snapshot.count)?;
        let peer_identity = twiglane_peer::host_identity(context.path())?;
        if expected
            .is_some_and(|b| b.peer_revision != peer_revision || b.peer_identity != peer_identity)
        {
            return Err("target_changed");
        }
        let request = json!({"session":origin.remote_session_id, "directory":origin.directory});
        writeln!(child.stdin.take().ok_or("read_failed")?, "{request}")
            .map_err(|_| "read_failed")?;
        let mut bytes = Vec::new();
        stdout
            .take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| "read_failed")?;
        if bytes.len() > 16384 {
            return Err("read_failed");
        }
        let data = match serde_json::from_slice::<ReadReply>(&bytes).map_err(|_| "read_failed")? {
            ReadReply::Metadata(data) => data,
            ReadReply::Error { error } => {
                return Err(match error.as_str() {
                    "remote_review_restart" => "remote_review_restart",
                    "worktree_changed" => "target_changed",
                    "not_a_worktree" => "not_a_worktree",
                    _ => "read_failed",
                })
            }
        };
        if expected.is_some_and(|b| {
            b.worktree_key != data.key || b.worktree_identity != data.worktree_identity
        }) {
            return Err("target_changed");
        }
        let binding = Binding {
            target_id: target.id.clone(),
            target_revision: snapshot.revision,
            peer_revision,
            peer_identity,
            remote_session: origin.remote_session_id.clone(),
            project_id: origin.project_id.clone(),
            directory: origin.directory.clone(),
            worktree_key: data.key,
            worktree_identity: data.worktree_identity,
        };
        let status = crate::twiglane::CodeStatus {
            session_id: local_session.into(),
            worktree_path: Some(data.root),
            branch: data.branch,
            head_oid: data.head_oid,
            uncommitted_files: Some(data.uncommitted),
            session_files: None,
            session_base: data.baseline,
            state: "ready",
            reason: None,
        };
        Ok((binding, status))
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| "read_failed")?;
    if status.success() {
        result
    } else {
        Err(result.err().unwrap_or("read_failed"))
    }
}
