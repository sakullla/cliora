//! Shared remote target and transport primitives.
//!
//! Remote support deliberately uses the user's OpenSSH installation instead of
//! embedding an SSH implementation. The adapter layer can build on these
//! target/project records without creating per-CLI SSH branches.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::database::Database;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub ssh_config: Option<String>,
    pub default_path: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub id: String,
    pub target_id: String,
    pub name: String,
    pub path: String,
    pub preferred_tool: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    pub target_id: String,
    pub stage: String,
    pub reachable: bool,
    pub identity: Option<String>,
    pub system: Option<String>,
    pub home: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandResult {
    pub target_id: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("远程目标名称不能为空")]
    InvalidName,
    #[error("远程主机地址无效")]
    InvalidHost,
    #[error("远程用户无效")]
    InvalidUser,
    #[error("远程路径无效")]
    InvalidPath,
    #[error("远程目标不存在")]
    NotFound,
    #[error("远程 SSH 功能尚未启用，请在设置中开启")]
    Disabled,
    #[error("远程连接阶段 {stage} 失败：{detail}")]
    Transport { stage: &'static str, detail: String },
    #[error("{0}")]
    Storage(String),
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.chars().any(|ch| ch == '\0' || ch.is_control())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn classify_ssh_failure(stderr: &str, exit_code: Option<i32>) -> &'static str {
    let detail = stderr.to_ascii_lowercase();
    if detail.contains("remote host identification has changed")
        || detail.contains("host key verification failed")
        || detail.contains("no matching host key")
    {
        "host_key"
    } else if detail.contains("permission denied")
        || detail.contains("could not authenticate")
        || detail.contains("too many authentication failures")
    {
        "authentication"
    } else if exit_code.is_some() && exit_code != Some(255) {
        "remote_command"
    } else {
        "connect"
    }
}

pub fn validate_target(target: &RemoteTarget) -> Result<(), RemoteError> {
    if !valid_text(&target.name, 120) {
        return Err(RemoteError::InvalidName);
    }
    if !valid_text(&target.host, 253)
        || target
            .host
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\'))
    {
        return Err(RemoteError::InvalidHost);
    }
    if !valid_text(&target.user, 64)
        || target
            .user
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\' | '@'))
    {
        return Err(RemoteError::InvalidUser);
    }
    for path in [target.ssh_config.as_deref(), target.default_path.as_deref()]
        .into_iter()
        .flatten()
    {
        if !valid_text(path, 4096) {
            return Err(RemoteError::InvalidPath);
        }
    }
    Ok(())
}

pub fn list_targets(db: &Database) -> Result<Vec<RemoteTarget>, RemoteError> {
    db.with_connection(|conn| {
        let mut statement = conn
            .prepare("SELECT id,name,host,port,user_name,ssh_config,default_path,enabled,created_at,updated_at FROM remote_targets ORDER BY name COLLATE NOCASE, id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(RemoteTarget {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)?.try_into().unwrap_or(22),
                    user: row.get(4)?,
                    ssh_config: row.get(5)?,
                    default_path: row.get(6)?,
                    enabled: row.get::<_, i64>(7)? != 0,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    })
    .map_err(RemoteError::Storage)
}

pub fn save_target(db: &Database, mut target: RemoteTarget) -> Result<RemoteTarget, RemoteError> {
    validate_target(&target)?;
    if target.id.trim().is_empty() {
        target.id = Uuid::new_v4().to_string();
    }
    let timestamp = now();
    db.with_connection(|conn| {
        let existing: Option<i64> = conn
            .query_row("SELECT created_at FROM remote_targets WHERE id=?1", [&target.id], |row| row.get(0))
            .optional()
            .map_err(|error| error.to_string())?;
        target.created_at = existing.unwrap_or(timestamp);
        target.updated_at = timestamp;
        conn.execute(
            "INSERT INTO remote_targets (id,name,host,port,user_name,ssh_config,default_path,enabled,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,user_name=excluded.user_name,
             ssh_config=excluded.ssh_config,default_path=excluded.default_path,enabled=excluded.enabled,updated_at=excluded.updated_at",
            params![target.id, target.name, target.host, target.port, target.user, target.ssh_config, target.default_path, target.enabled as i64, target.created_at, target.updated_at],
        )
        .map_err(|error| error.to_string())?;
        Ok(target)
    })
    .map_err(RemoteError::Storage)
}

pub fn delete_target(db: &Database, id: &str) -> Result<(), RemoteError> {
    if id.trim().is_empty() {
        return Err(RemoteError::NotFound);
    }
    db.with_connection(|conn| {
        let changed = conn
            .execute("DELETE FROM remote_targets WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(RemoteError::NotFound.to_string());
        }
        Ok(())
    })
    .map_err(RemoteError::Storage)
}

pub fn list_projects(
    db: &Database,
    target_id: Option<&str>,
) -> Result<Vec<RemoteProject>, RemoteError> {
    db.with_connection(|conn| {
        let mut statement = if target_id.is_some() {
            conn.prepare("SELECT id,target_id,name,path,preferred_tool,updated_at FROM remote_projects WHERE target_id=?1 ORDER BY name COLLATE NOCASE,id").map_err(|error| error.to_string())?
        } else {
            conn.prepare("SELECT id,target_id,name,path,preferred_tool,updated_at FROM remote_projects ORDER BY updated_at DESC,id").map_err(|error| error.to_string())?
        };
        let rows = match target_id {
            Some(target_id) => statement.query_map([target_id], project_row),
            None => statement.query_map([], project_row),
        }.map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }).map_err(RemoteError::Storage)
}

fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteProject> {
    Ok(RemoteProject {
        id: row.get(0)?,
        target_id: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        preferred_tool: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn save_project(
    db: &Database,
    mut project: RemoteProject,
) -> Result<RemoteProject, RemoteError> {
    if !valid_text(&project.name, 120)
        || !valid_text(&project.path, 4096)
        || project.path.starts_with('~')
    {
        return Err(RemoteError::InvalidPath);
    }
    if project.id.trim().is_empty() {
        project.id = Uuid::new_v4().to_string();
    }
    project.updated_at = now();
    db.with_connection(|conn| {
        let target_exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM remote_targets WHERE id=?1)", [&project.target_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if !target_exists { return Err(RemoteError::NotFound.to_string()); }
        conn.execute("INSERT INTO remote_projects (id,target_id,name,path,preferred_tool,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,name=excluded.name,path=excluded.path,preferred_tool=excluded.preferred_tool,updated_at=excluded.updated_at", params![project.id, project.target_id, project.name, project.path, project.preferred_tool, project.updated_at]).map_err(|error| error.to_string())?;
        Ok(project)
    }).map_err(RemoteError::Storage)
}

pub fn delete_project(db: &Database, id: &str) -> Result<(), RemoteError> {
    let changed = db
        .with_connection(|conn| {
            conn.execute("DELETE FROM remote_projects WHERE id=?1", [id])
                .map_err(|error| error.to_string())
        })
        .map_err(RemoteError::Storage)?;
    if changed == 0 {
        return Err(RemoteError::NotFound);
    }
    Ok(())
}

/// Perform a read-only, PTY-free OpenSSH probe. Host key checking stays strict;
/// callers must explicitly maintain `known_hosts` when a host key changes.
pub fn probe_target(target: &RemoteTarget) -> Result<RemoteProbe, RemoteError> {
    validate_target(target)?;
    let mut command =
        Command::new(std::env::var_os("CLIORA_SSH_BINARY").unwrap_or_else(|| "ssh".into()));
    command
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
        ])
        .arg(target.port.to_string());
    if let Some(config) = target.ssh_config.as_deref() {
        command.args(["-F", config]);
    }
    command.arg(format!("{}@{}", target.user, target.host));
    let mut remote_script =
        "printf '%s\\n' \"$(id -u)\"; uname -srm; printf '%s\\n' \"$HOME\"".to_owned();
    if let Some(path) = target.default_path.as_deref() {
        remote_script.push_str("; test -d -- ");
        remote_script.push_str(&shell_quote(path));
        remote_script.push_str(" || { printf '%s\\n' 'cliora:remote-path-failed' >&2; exit 42; }");
    }
    command
        .arg(remote_script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output().map_err(|error| RemoteError::Transport {
        stage: "launch",
        detail: error.to_string(),
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(500)
            .collect();
        let stage = if String::from_utf8_lossy(&output.stderr).contains("cliora:remote-path-failed")
        {
            "remote_path"
        } else {
            classify_ssh_failure(
                &String::from_utf8_lossy(&output.stderr),
                output.status.code(),
            )
        };
        return Err(RemoteError::Transport { stage, detail });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    Ok(RemoteProbe {
        target_id: target.id.clone(),
        stage: "ready".into(),
        reachable: true,
        identity: lines
            .first()
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        system: lines
            .get(1)
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        home: lines
            .get(2)
            .filter(|line| !line.is_empty())
            .map(|line| (*line).into()),
        detail: None,
    })
}

fn ssh_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
        ])
        .arg(target.port.to_string());
    if let Some(config) = target.ssh_config.as_deref() {
        command.args(["-F", config]);
    }
    command.arg(format!("{}@{}", target.user, target.host));
    command
}

fn sftp_command(target: &RemoteTarget, binary: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args([
            "-q",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=yes",
            "-p",
        ])
        .arg(target.port.to_string());
    if let Some(config) = target.ssh_config.as_deref() {
        command.args(["-F", config]);
    }
    command
        .arg("-b")
        .arg("-")
        .arg(format!("{}@{}", target.user, target.host));
    command
}

pub fn run_command(
    target: &RemoteTarget,
    command_line: &str,
) -> Result<RemoteCommandResult, RemoteError> {
    validate_target(target)?;
    if !valid_text(command_line, 32_000) {
        return Err(RemoteError::InvalidPath);
    }
    let mut command = ssh_command(
        target,
        &std::env::var("CLIORA_SSH_BINARY").unwrap_or_else(|_| "ssh".into()),
    );
    let output = command
        .arg(command_line)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| RemoteError::Transport {
            stage: "launch",
            detail: error.to_string(),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let exit_code = output.status.code().unwrap_or(255);
    if !output.status.success() {
        return Err(RemoteError::Transport {
            stage: classify_ssh_failure(&stderr, output.status.code()),
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    Ok(RemoteCommandResult {
        target_id: target.id.clone(),
        exit_code,
        stdout,
        stderr,
    })
}

/// Read one remote file through OpenSSH SFTP. The file contents are returned
/// directly; credentials and host-key material never cross the IPC boundary.
pub fn read_file(target: &RemoteTarget, remote_path: &str) -> Result<Vec<u8>, RemoteError> {
    validate_target(target)?;
    if !valid_text(remote_path, 4096) {
        return Err(RemoteError::InvalidPath);
    }
    let binary = std::env::var("CLIORA_SFTP_BINARY").unwrap_or_else(|_| "sftp".into());
    let mut command = sftp_command(target, &binary);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| RemoteError::Transport {
            stage: "launch",
            detail: error.to_string(),
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        writeln!(stdin, "get {} -", remote_path.replace('\n', " ")).map_err(|error| {
            RemoteError::Transport {
                stage: "sftp",
                detail: error.to_string(),
            }
        })?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| RemoteError::Transport {
            stage: "sftp",
            detail: error.to_string(),
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stage = classify_ssh_failure(&stderr, output.status.code());
        return Err(RemoteError::Transport {
            stage: if matches!(stage, "connect" | "remote_command") {
                "sftp"
            } else {
                stage
            },
            detail: stderr.trim().chars().take(500).collect(),
        });
    }
    Ok(output.stdout)
}

pub fn ensure_enabled(db: &Database) -> Result<(), RemoteError> {
    db.preferences()
        .map_err(RemoteError::Storage)?
        .remote_ssh_enabled
        .then_some(())
        .ok_or(RemoteError::Disabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_sensitive_target_fields() {
        let target = RemoteTarget {
            id: String::new(),
            name: "test".into(),
            host: "host name".into(),
            port: 22,
            user: "root".into(),
            ssh_config: None,
            default_path: None,
            enabled: true,
            created_at: 0,
            updated_at: 0,
        };
        assert!(matches!(
            validate_target(&target),
            Err(RemoteError::InvalidHost)
        ));
    }

    #[test]
    fn saves_and_lists_target_and_project() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("remote.db")).unwrap();
        let target = save_target(
            &db,
            RemoteTarget {
                id: String::new(),
                name: "Test host".into(),
                host: "127.0.0.1".into(),
                port: 22,
                user: "root".into(),
                ssh_config: None,
                default_path: Some("/root".into()),
                enabled: true,
                created_at: 0,
                updated_at: 0,
            },
        )
        .unwrap();
        assert_eq!(list_targets(&db).unwrap(), vec![target.clone()]);
        let project = save_project(
            &db,
            RemoteProject {
                id: String::new(),
                target_id: target.id.clone(),
                name: "demo".into(),
                path: "/root/demo".into(),
                preferred_tool: None,
                updated_at: 0,
            },
        )
        .unwrap();
        assert_eq!(list_projects(&db, Some(&target.id)).unwrap(), vec![project]);
    }
}
