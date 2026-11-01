//! Upload local regular files into a remote project's `.cliora/uploads/`.
//!
//! One SFTP batch first lands every file under a unique temporary name, then
//! each file is claimed into a non-clashing final name with a single-line
//! POSIX `ln` command: an existing remote file is never overwritten, colliding
//! names grow a `-1`, `-2`, ... suffix, and the temporary name is removed only
//! after a successful claim. A failed transfer therefore never publishes a
//! final name, and claim failures keep already claimed files in place for the
//! session-end cleanup instead of rolling anything back. Failures report every
//! remote path the attempt already landed so callers can record them alongside
//! successful claims.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use uuid::Uuid;

use super::{
    directory_parent_probe, operations, run_command, run_ssh, sftp_command, shell_quote,
    valid_text, validate_target, wait_for_output_with_stdin, RemoteError, RemoteTarget,
};

/// Uploads can be far larger and slower than interactive commands, so the
/// transport waits up to 600 seconds; the operations request carries its own
/// deadline and a write is never replayed automatically.
const UPLOAD_DEADLINE: Duration = Duration::from_secs(600);
/// Final names try the plain name first, then `-1`, `-2`, ... before failing.
const NAME_ATTEMPTS: usize = 64;
const TEMP_PREFIX: &str = ".cliora-upload-";

/// One remote name this application landed in the uploads directory: a claimed
/// final name, or a leftover of a failed attempt (a temporary name that was
/// never claimed, or a final name claimed before a later file in the same
/// request failed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LandedUpload {
    pub remote_path: String,
    pub local_name: String,
}

/// A failed whole-request upload together with every remote path the attempt
/// already landed. Callers record the landed paths like successful ones so
/// session-end cleanup also covers failure residue instead of rolling back.
pub struct UploadFailure {
    pub error: RemoteError,
    pub landed: Vec<LandedUpload>,
}

/// Upload the given local files into `<project_path>/.cliora/uploads/` and
/// return the claimed absolute remote paths in input order. Any failed file
/// fails the whole request; local paths that are directories or unreadable
/// are rejected before any remote connection is opened.
pub fn upload_files(
    target: &RemoteTarget,
    project_path: &str,
    local_paths: &[String],
) -> Result<Vec<String>, RemoteError> {
    upload_files_tracked(target, project_path, local_paths)
        .map(|files| files.into_iter().map(|file| file.remote_path).collect())
        .map_err(|failure| failure.error)
}

/// [`upload_files`] with landing visibility: success returns one entry per
/// claimed final name; failure returns the error plus every remote path this
/// attempt may have already landed.
pub fn upload_files_tracked(
    target: &RemoteTarget,
    project_path: &str,
    local_paths: &[String],
) -> Result<Vec<LandedUpload>, UploadFailure> {
    let context = operations::current()
        .unwrap_or_else(|| operations::Context::local(operations::Kind::Write, UPLOAD_DEADLINE));
    operations::scoped(context, || upload_files_tracked_inner(target, project_path, local_paths))
}

fn upload_files_tracked_inner(
    target: &RemoteTarget,
    project_path: &str,
    local_paths: &[String],
) -> Result<Vec<LandedUpload>, UploadFailure> {
    let none_landed =
        |error: RemoteError| UploadFailure { error, landed: Vec::new() };
    validate_target(target).map_err(none_landed)?;
    if local_paths.is_empty() {
        return Err(none_landed(RemoteError::Storage("请至少选择一个要上传的文件".into())));
    }
    let directory = upload_directory(project_path).map_err(none_landed)?;
    let mut entries = Vec::with_capacity(local_paths.len());
    let mut temporary_names: HashSet<String> = HashSet::new();
    for local_path in local_paths {
        let file_name = precheck_local_file(local_path).map_err(none_landed)?;
        let temporary_name = loop {
            let candidate = format!("{TEMP_PREFIX}{}", Uuid::new_v4().simple());
            if temporary_names.insert(candidate.clone()) {
                break candidate;
            }
        };
        entries.push(UploadEntry {
            local_path: local_path.clone(),
            file_name,
            temporary_path: format!("{directory}/{temporary_name}"),
        });
    }
    // No remote file exists yet while the directory is only being prepared.
    run_command(
        target,
        &upload_directory_prepare_command(project_path, &directory).map_err(none_landed)?,
    )
    .map_err(none_landed)?;
    let batch = upload_batch_script(&entries);
    let binary = std::env::var("CLIORA_SFTP_BINARY").unwrap_or_else(|_| "sftp".into());
    // run_ssh only returns Ok for a successful exit, and batch-mode sftp aborts
    // at the first failing put without saying which puts already succeeded, so
    // a failed batch conservatively reports every temporary name as landed.
    // `rm -f` on a path that never existed stays harmless during cleanup.
    let temporary_landings = |from: usize| -> Vec<LandedUpload> {
        entries[from..]
            .iter()
            .map(|entry| LandedUpload {
                remote_path: entry.temporary_path.clone(),
                local_name: entry.file_name.clone(),
            })
            .collect()
    };
    let batch_landed = || temporary_landings(0);
    run_ssh(target, || {
        let mut command = sftp_command(target, &binary);
        wait_for_output_with_stdin(&mut command, UPLOAD_DEADLINE, Some(batch.clone().into_bytes()))
    })
    .map_err(|error| UploadFailure { error, landed: batch_landed() })?;
    let mut claimed = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        match claim_uploaded_file(target, &directory, entry) {
            Ok(remote_path) => claimed.push(LandedUpload {
                remote_path,
                local_name: entry.file_name.clone(),
            }),
            Err(error) => {
                // Claimed finals stay (their temporary names are already gone);
                // the failing entry and every later one keep their temporary
                // names for the session-end cleanup.
                let mut landed = claimed.clone();
                landed.extend(temporary_landings(index));
                return Err(UploadFailure { error, landed });
            }
        }
    }
    Ok(claimed)
}

struct UploadEntry {
    local_path: String,
    file_name: String,
    temporary_path: String,
}

/// Remote directory receiving session uploads: `<project_path>/.cliora/uploads`.
pub fn upload_directory(project_path: &str) -> Result<String, RemoteError> {
    if !valid_text(project_path, 4096) || project_path.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!(
        "{}/.cliora/uploads",
        project_path.trim_end_matches('/')
    ))
}

/// Reject directories, unreadable files and unusable names locally, before any
/// remote connection is opened, so the UI can report a precise reason.
fn precheck_local_file(local_path: &str) -> Result<String, RemoteError> {
    if !valid_text(local_path, 32_000) {
        return Err(RemoteError::Storage("本地文件路径无效".into()));
    }
    let metadata = match std::fs::metadata(local_path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Err(RemoteError::Storage(format!(
                "无法读取本地文件（不存在或不可访问）：{local_path}"
            )))
        }
    };
    if metadata.is_dir() {
        return Err(RemoteError::Storage(format!(
            "本地路径是目录，仅支持上传文件：{local_path}"
        )));
    }
    if !metadata.is_file() {
        return Err(RemoteError::Storage(format!(
            "本地路径不是普通文件：{local_path}"
        )));
    }
    if std::fs::File::open(local_path).is_err() {
        return Err(RemoteError::Storage(format!("本地文件不可读：{local_path}")));
    }
    match Path::new(local_path).file_name() {
        Some(name) => {
            let name = name.to_string_lossy().into_owned();
            if !valid_text(&name, 255) || name.contains('/') {
                return Err(RemoteError::Storage(format!("本地文件名无效：{local_path}")));
            }
            Ok(name)
        }
        None => Err(RemoteError::Storage(format!(
            "本地文件名无效：{local_path}"
        ))),
    }
}

/// Create `<project>/.cliora/uploads`, reusing the `create_directory` probe
/// pattern: the project directory must exist and be writable, while an already
/// existing `.cliora` or `uploads` counts as success.
fn upload_directory_prepare_command(
    project_path: &str,
    uploads_directory: &str,
) -> Result<String, RemoteError> {
    let project_path = project_path.trim_end_matches('/');
    if !valid_text(project_path, 4096) || project_path.starts_with('~') {
        return Err(RemoteError::InvalidPath);
    }
    if uploads_directory != format!("{project_path}/.cliora/uploads") {
        return Err(RemoteError::InvalidPath);
    }
    Ok(format!(
        "parent={}; {} \
         if [ ! -w \"$parent\" ] || [ ! -x \"$parent\" ]; then printf '%s\\n' 'Permission denied: parent requires write and search access' >&2; exit 43; fi; \
         mkdir -- \"$parent/.cliora\" 2>/dev/null; parent=\"$parent/.cliora\"; {} \
         if [ ! -w \"$parent\" ] || [ ! -x \"$parent\" ]; then printf '%s\\n' 'Permission denied: parent requires write and search access' >&2; exit 43; fi; \
         mkdir -- \"$parent/uploads\" 2>/dev/null; [ -d \"$parent/uploads\" ] || {{ printf '%s\\n' 'cliora:directory-missing: Directory does not exist' >&2; exit 44; }}",
        shell_quote(project_path),
        directory_parent_probe(),
        directory_parent_probe()
    ))
}

fn split_file_name(file_name: &str) -> (&str, Option<&str>) {
    match file_name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (file_name, None),
    }
}

/// The plain name first, then `name-1.ext`, `name-2.ext`, ... so a claim never
/// overwrites an existing remote file.
fn claim_candidates(file_name: &str, limit: usize) -> Vec<String> {
    let (stem, extension) = split_file_name(file_name);
    (0..limit)
        .map(|index| match (index, extension) {
            (0, _) => file_name.to_owned(),
            (_, Some(extension)) => format!("{stem}-{index}.{extension}"),
            (_, None) => format!("{stem}-{index}"),
        })
        .collect()
}

/// One single-line POSIX command that atomically claims the first free name
/// with `ln` (fails when the destination exists), removes the temporary name
/// only after a successful claim, prints the claimed path and stops. Exhausted
/// candidates fail with a distinct marker instead of overwriting anything.
fn claim_command(
    directory: &str,
    temporary_path: &str,
    candidates: &[String],
) -> Result<String, RemoteError> {
    if !valid_text(directory, 4096)
        || directory.starts_with('~')
        || !valid_text(temporary_path, 8192)
        || candidates.is_empty()
    {
        return Err(RemoteError::InvalidPath);
    }
    let mut script = format!(
        "dir={}; tmp={}; ",
        shell_quote(directory),
        shell_quote(temporary_path)
    );
    for candidate in candidates {
        if !valid_text(candidate, 255) || candidate.contains('/') {
            return Err(RemoteError::InvalidPath);
        }
        script.push_str(&format!(
            "name={}; if ln -- \"$tmp\" \"$dir/$name\" 2>/dev/null; then rm -f -- \"$tmp\"; printf '%s\\n' \"$dir/$name\"; exit 0; fi; ",
            shell_quote(candidate)
        ));
    }
    script.push_str(&format!(
        "printf '%s\\n' {} >&2; exit 48",
        shell_quote(&format!("cliora:upload-name-taken: {}", candidates[0]))
    ));
    Ok(script)
}

fn claim_uploaded_file(
    target: &RemoteTarget,
    directory: &str,
    entry: &UploadEntry,
) -> Result<String, RemoteError> {
    let candidates = claim_candidates(&entry.file_name, NAME_ATTEMPTS);
    let command = claim_command(directory, &entry.temporary_path, &candidates)?;
    let result = run_command(target, &command)?;
    let claimed = result.stdout.trim();
    if candidates
        .iter()
        .any(|candidate| claimed == format!("{directory}/{candidate}"))
    {
        return Ok(claimed.to_owned());
    }
    Err(RemoteError::Storage(format!(
        "上传认领结果异常：{}",
        claimed.chars().take(200).collect::<String>()
    )))
}

fn escape_sftp_text(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The local operand of a `put` line. Windows separators become slashes so the
/// remaining backslashes are always data and get sftp-quote escaped.
fn batch_local_path(local_path: &str) -> String {
    let normalized = if cfg!(windows) {
        local_path.replace('\\', "/")
    } else {
        local_path.to_owned()
    };
    escape_sftp_text(&normalized)
}

fn sftp_batch_line(local_path: &str, remote_path: &str) -> String {
    format!(
        "put \"{}\" \"{}\"\n",
        batch_local_path(local_path),
        escape_sftp_text(remote_path)
    )
}

/// The whole upload is one sftp batch; in batch mode sftp aborts on the first
/// failing command, so one failed file stops the transfer without publishing
/// any final name.
fn upload_batch_script(entries: &[UploadEntry]) -> String {
    let mut script = String::new();
    for entry in entries {
        script.push_str(&sftp_batch_line(&entry.local_path, &entry.temporary_path));
    }
    script
}

/// A recovery deletes exactly the paths this application recorded for one
/// session. `rm` without `-r` cannot descend into anything, every operand is
/// quoted data behind `--`, and only recorded paths are ever passed, so an
/// unrecorded file is untouched. The uploads directories are then dropped when
/// they are empty; a non-empty directory (another session's files) is the
/// expected outcome and ignored. `rm -f` also tolerates a path that is already
/// gone, so retrying a partial recovery is safe.
fn validate_recorded_path(path: &str) -> Result<(), RemoteError> {
    if !valid_text(path, 8192) || !path.starts_with('/') {
        return Err(RemoteError::InvalidPath);
    }
    Ok(())
}

fn recorded_parent(path: &str) -> Result<&str, RemoteError> {
    validate_recorded_path(path)?;
    let parent = match path.rsplit_once('/') {
        Some(("", _)) => return Err(RemoteError::InvalidPath),
        Some((parent, _)) => parent,
        None => return Err(RemoteError::InvalidPath),
    };
    if !valid_text(parent, 896) {
        return Err(RemoteError::InvalidPath);
    }
    Ok(parent)
}

/// `rm -f --` exactly the recorded paths; a real removal failure (for example
/// a read-only directory) fails the command so rows stay pending for a retry.
fn recycle_remove_command(paths: &[String]) -> Result<String, RemoteError> {
    let mut script = String::from("rm -f --");
    for path in paths {
        validate_recorded_path(path)?;
        script.push_str(&format!(" {}", shell_quote(path)));
    }
    script.push_str(" || exit 1");
    Ok(script)
}

/// Drop every recorded uploads directory that is now empty; other sessions'
/// files keep theirs. Each failure is ignored on purpose.
fn recycle_rmdir_command(paths: &[String]) -> Result<String, RemoteError> {
    Ok(recycle_rmdir_command_by_parents(&recorded_parents(paths)?))
}

fn recycle_rmdir_command_by_parents(parents: &[String]) -> String {
    let mut script = String::new();
    for parent in parents {
        script.push_str(&format!("rmdir -- {} 2>/dev/null || :; ", shell_quote(parent)));
    }
    script
}

/// Unique immediate parents of the recorded paths, in first-seen order.
fn recorded_parents(paths: &[String]) -> Result<Vec<String>, RemoteError> {
    let mut parents: Vec<String> = Vec::new();
    for path in paths {
        let parent = recorded_parent(path)?;
        if !parents.iter().any(|seen| seen == parent) {
            parents.push(parent.to_owned());
        }
    }
    Ok(parents)
}

/// One single-line POSIX recovery command: remove the recorded files, then try
/// to drop the now-empty uploads directories. Never recursive, never touching
/// a path the session did not record.
pub fn recycle_command(paths: &[String]) -> Result<String, RemoteError> {
    if paths.is_empty() || paths.len() > 512 {
        return Err(RemoteError::InvalidPath);
    }
    let mut script = recycle_remove_command(paths)?;
    script.push_str("; ");
    script.push_str(&recycle_rmdir_command(paths)?);
    Ok(script)
}

/// Keep each transport command comfortably below the 32 KB line limit.
const RECYCLE_CHUNK_BYTES: usize = 24_576;
const RECYCLE_CHUNK_PATHS: usize = 256;

/// The bounded command plan of one recovery: `rm` chunks covering exactly the
/// unique recorded paths, then `rmdir` chunks for their uploads directories.
/// Splitting keeps every line inside the transport's command budget even for a
/// pathological record list.
pub fn recycle_plan(paths: &[String]) -> Result<Vec<String>, RemoteError> {
    let mut unique: Vec<String> = Vec::new();
    for path in paths {
        validate_recorded_path(path)?;
        if !unique.iter().any(|seen| seen == path) {
            unique.push(path.clone());
        }
    }
    let mut plan = Vec::new();
    let mut chunk: Vec<String> = Vec::new();
    let mut chunk_bytes = 0usize;
    for path in unique {
        let quoted = shell_quote(&path).len() + 1;
        if !chunk.is_empty()
            && (chunk_bytes + quoted > RECYCLE_CHUNK_BYTES || chunk.len() >= RECYCLE_CHUNK_PATHS)
        {
            plan.push(recycle_remove_command(&chunk)?);
            chunk.clear();
            chunk_bytes = 0;
        }
        chunk_bytes += quoted;
        chunk.push(path);
    }
    if !chunk.is_empty() {
        plan.push(recycle_remove_command(&chunk)?);
    }
    let mut rmdir_chunk: Vec<String> = Vec::new();
    let mut rmdir_bytes = 0usize;
    for parent in recorded_parents(paths)? {
        let quoted = shell_quote(&parent).len() + 24;
        if !rmdir_chunk.is_empty() && rmdir_bytes + quoted > RECYCLE_CHUNK_BYTES {
            plan.push(recycle_rmdir_command_by_parents(&rmdir_chunk));
            rmdir_chunk.clear();
            rmdir_bytes = 0;
        }
        rmdir_bytes += quoted;
        rmdir_chunk.push(parent);
    }
    if !rmdir_chunk.is_empty() {
        plan.push(recycle_rmdir_command_by_parents(&rmdir_chunk));
    }
    Ok(plan)
}

/// Recover one session's recorded uploads on the remote side. Any command
/// failure aborts before the rows are removed, leaving them pending for the
/// next recovery attempt.
pub fn recycle_session_files(target: &RemoteTarget, paths: &[String]) -> Result<(), RemoteError> {
    validate_target(target)?;
    if paths.is_empty() {
        return Ok(());
    }
    for command in recycle_plan(paths)? {
        run_command(target, &command)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../src-tauri/tests/uploads/uploads.rs"]
mod tests;
