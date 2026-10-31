//! Shared remote CAS, protected staging/backup and durable per-file receipts.
//! No credentials or file contents leave the remote backup directory in a receipt.
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{operations, remote_path_expr, run_command, run_command_with_stdin, shell_quote, RemoteError, RemoteTarget};

pub type Versions = BTreeMap<String, String>;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub state: String,
    pub before: String,
    pub after: String,
    pub observed: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub target_id: String,
    pub target_revision: i64,
    pub identity: String,
    pub outcome: String,
    pub items: Vec<Item>,
}

fn snapshots() -> &'static Mutex<BTreeMap<String, Versions>> {
    static VALUES: OnceLock<Mutex<BTreeMap<String, Versions>>> = OnceLock::new();
    VALUES.get_or_init(Default::default)
}
pub fn retain_snapshot(context: &operations::Context) {
    let Some(id) = context.request_id() else { return; };
    let values = context.file_versions();
    if values.is_empty() { return; }
    let mut all = snapshots().lock().unwrap_or_else(|e| e.into_inner());
    if all.len() >= 512 { all.clear(); }
    all.insert(id, values);
}
pub fn snapshot(id: &str) -> Versions {
    snapshots().lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned().unwrap_or_default()
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn observe(path: &str, bytes: Option<&[u8]>) {
    if let Some(context) = operations::current() {
        context.record_file(path, bytes.map(digest).unwrap_or_else(|| "missing".into()));
    }
}
pub(crate) fn valid_path(path: &str) -> bool {
    (path.starts_with('/') || path.starts_with("$HOME/")) && path.len() <= 4096
        && !path.contains(['\n', '\r', '\0', '\t']) && !path.split('/').any(|p| p == "..")
}
pub(crate) fn valid_hash(value: &str) -> bool { value == "missing" || (value.len() == 64 && value.bytes().all(|v| v.is_ascii_hexdigit())) }
fn valid_id(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok() }
const HELPERS: &str = r#"
umask 077
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
fingerprint() {
  if [ -L "$1" ]; then printf '%s' unsafe; return; fi
  if [ -f "$1" ]; then sha256sum -- "$1" | cut -d ' ' -f 1
  elif [ -e "$1" ]; then printf '%s' unsafe
  else printf '%s' missing; fi
}
protect() {
  command -v sha256sum >/dev/null && command -v flock >/dev/null || exit 70
  [ ! -L "$HOME/.cliora" ] && [ ! -L "$HOME/.cliora/transactions" ] || exit 71
  mkdir -p "$HOME/.cliora/transactions" || exit 72
  chmod 700 "$HOME/.cliora" "$HOME/.cliora/transactions" || exit 73
  [ ! -L "$HOME/.cliora/transactions/lock" ] || exit 74
  exec 9>"$HOME/.cliora/transactions/lock" || exit 75
  flock -w 15 9 || exit 76
}
"#;

fn paths_script(paths: &[String]) -> Result<String, RemoteError> {
    let mut script = String::from(HELPERS);
    for path in paths {
        if !valid_path(path) { return Err(RemoteError::InvalidPath); }
        script.push_str(&format!("fingerprint {}; printf '\\n'\n", remote_path_expr(path)));
    }
    Ok(script)
}

pub fn versions(target: &RemoteTarget, paths: &[String]) -> Result<Versions, RemoteError> {
    let script = paths_script(paths)?;
    let output = run_command_with_stdin(target, "sh -s", script.as_bytes())?;
    let hashes: Vec<_> = output.stdout.lines().collect();
    if hashes.len() != paths.len() || hashes.iter().any(|v| !valid_hash(v)) {
        return Err(RemoteError::Storage("远程目标不是可安全替换的普通文件，或无法核查版本".into()));
    }
    Ok(paths.iter().cloned().zip(hashes.into_iter().map(str::to_owned)).collect())
}

fn journal(receipt: &Receipt) -> String {
    let mut script = format!("journal() {{ {{ printf '%s\\n' cliora-tx-v1 {} {} {} \"$outcome\";\n",
        shell_quote(&receipt.id), shell_quote(&receipt.identity), receipt.target_revision);
    for (n, item) in receipt.items.iter().enumerate() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(&item.path);
        script.push_str(&format!("printf '%s\\t%s\\t%s\\t%s\\n' {} {} {} \"$s{n}\"\n", shell_quote(&encoded), shell_quote(&item.before), shell_quote(&item.after)));
    }
    script.push_str("} > \"$tx/receipt.next\" && chmod 600 \"$tx/receipt.next\" && mv -f \"$tx/receipt.next\" \"$tx/receipt\"; }\n");
    script
}
fn rollback_script(receipt: &Receipt) -> String {
    let mut script = String::from("rollback() { outcome=rolled_back\n");
    for (n, item) in receipt.items.iter().enumerate().rev() {
        script.push_str(&format!(r#"
case "$s{n}" in committed|applying|rollback_failed|conflict)
  p={path}; current=$(fingerprint "$p")
  if [ "$current" = {before} ]; then s{n}=rolled_back
  elif [ "$current" != {after} ]; then s{n}=conflict; outcome=recovery_required
  else
    if [ {before} = missing ]; then rm -f -- "$p" && s{n}=rolled_back || {{ s{n}=rollback_failed; outcome=recovery_required; }}
    elif [ "$(fingerprint "$tx/{n}.backup")" = {before} ] && cp -- "$tx/{n}.backup" "$tx/{n}.restore" && chmod 600 "$tx/{n}.restore" && (set -C; cat "$tx/{n}.restore" > "$p.cliora-$id-restore") && chmod 600 "$p.cliora-$id-restore" && mv -f -- "$p.cliora-$id-restore" "$p"; then s{n}=rolled_back
    else s{n}=rollback_failed; outcome=recovery_required; fi
  fi
  journal || exit 79;;
esac
"#, path=remote_path_expr(&item.path), before=shell_quote(&item.before), after=shell_quote(&item.after)));
    }
    for (n, item) in receipt.items.iter().enumerate() {
        script.push_str(&format!("rm -f -- {}\n", remote_path_expr(&format!("{}.cliora-{}-{n}.tmp", item.path, receipt.id))));
    }
    script.push_str("journal || exit 79\ncat \"$tx/receipt\"\n}\n");
    script
}

fn parse(target: &RemoteTarget, text: &str) -> Result<Receipt, RemoteError> {
    parse_receipt(target, text, true)
}
fn parse_receipt(target: &RemoteTarget, text: &str, check_identity: bool) -> Result<Receipt, RemoteError> {
    let mut lines = text.lines();
    if lines.next() != Some("cliora-tx-v1") { return Err(RemoteError::Storage("远程写入回执无效；请保留备份并核查".into())); }
    let id = lines.next().unwrap_or_default().to_owned();
    let identity = lines.next().unwrap_or_default().to_owned();
    let target_revision = lines.next().unwrap_or_default().parse().unwrap_or(-1);
    let outcome = lines.next().unwrap_or_default().to_owned();
    if !valid_id(&id) || (check_identity && (identity != operations::target_identity(target) || target_revision != target.updated_at)) {
        return Err(RemoteError::Storage("写入回执属于另一主机修订，禁止对当前主机执行恢复".into()));
    }
    let mut items = Vec::new();
    for line in lines {
        let values: Vec<_> = line.split('\t').collect();
        if values.len() != 4 || !valid_hash(values[1]) || !valid_hash(values[2]) { return Err(RemoteError::InvalidPath); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(values[0]).map_err(|_| RemoteError::InvalidPath)?;
        let path = String::from_utf8(bytes).map_err(|_| RemoteError::InvalidPath)?;
        if !valid_path(&path) || items.len() >= 512 { return Err(RemoteError::InvalidPath); }
        items.push(Item { path, before: values[1].into(), after: values[2].into(), state: values[3].into(), observed: None });
    }
    Ok(Receipt { id, target_id: target.id.clone(), target_revision, identity, outcome, items })
}

pub fn commit(target: &RemoteTarget, removes: &[String], files: &[(String, Vec<u8>)]) -> Result<(), RemoteError> {
    let mut changes: BTreeMap<String, Option<&[u8]>> = removes.iter().map(|p| (p.clone(), None)).collect();
    for (path, bytes) in files { changes.insert(path.clone(), Some(bytes)); }
    if changes.is_empty() { return Ok(()); }
    if changes.len() > 512 || files.iter().map(|(_, bytes)| bytes.len()).sum::<usize>() > 16 * 1024 * 1024 { return Err(RemoteError::Storage("远程写入超过事务上限".into())); }
    let paths: Vec<_> = changes.keys().cloned().collect();
    let current = versions(target, &paths)?;
    let expected = operations::current().map(|c| c.expected_files()).unwrap_or_default();
    for path in &paths {
        if expected.get(path).map(String::as_str).unwrap_or("missing") != current[path] { return Err(RemoteError::Storage("远程文件版本已变化，请保留草稿并刷新后比较".into())); }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let receipt = Receipt { id: id.clone(), target_id: target.id.clone(), target_revision: target.updated_at, identity: operations::target_identity(target), outcome: "preparing".into(),
        items: changes.iter().map(|(path, bytes)| Item { path: path.clone(), state: "untouched".into(), before: expected.get(path).cloned().unwrap_or_else(|| "missing".into()), after: bytes.map(digest).unwrap_or_else(|| "missing".into()), observed: None }).collect() };
    let script = commit_script(&receipt, &changes)?;
    let result = run_command_with_stdin(target, "sh -s", script.as_bytes());
    match result.and_then(|output| parse(target, &output.stdout)) {
        Ok(result) if result.outcome == "committed" => {
            super::read_cache::invalidate(&target.id);
            if let Some(context) = operations::current() {
                for item in &result.items { context.record_file(&item.path, item.after.clone()); }
                context.accept_persistent_launch();
            }
            Ok(())
        }
        Ok(result) => Err(failure(&result, false)),
        Err(_) => Err(failure(&receipt, true)),
    }
}

fn failure(receipt: &Receipt, unknown: bool) -> RemoteError {
    let context = operations::current().unwrap_or_else(|| operations::Context::local(operations::Kind::Write, std::time::Duration::from_secs(40)));
    let RemoteError::Operation(mut failure) = context.failure(if unknown { "unknown" } else { "remote_commit" }, "远程写入未确认完成；请核查持久回执，保留草稿，不要直接重试") else { unreachable!() };
    failure.receipt = Some(receipt.clone());
    RemoteError::Operation(failure)
}

fn commit_script(receipt: &Receipt, changes: &BTreeMap<String, Option<&[u8]>>) -> Result<String, RemoteError> {
    let mut script = String::from(HELPERS);
    script.push_str(&format!("protect\nid={}\ntx=\"$HOME/.cliora/transactions/$id\"\n", shell_quote(&receipt.id)));
    // Block unresolved older transactions, including receipts discovered after an app restart.
    script.push_str("for r in \"$HOME/.cliora/transactions/\"*/receipt; do [ -f \"$r\" ] || continue; state=$(sed -n '5p' \"$r\"); case \"$state\" in committed|rolled_back|conflict_before_commit|prepare_failed) ;; *) printf '%s' '存在未核查写入，请先打开写入恢复' >&2; exit 78;; esac; done\nmkdir \"$tx\" || exit 77\nchmod 700 \"$tx\" || exit 77\noutcome=preparing\n");
    for n in 0..receipt.items.len() { script.push_str(&format!("s{n}=untouched\n")); }
    script.push_str(&journal(receipt));
    script.push_str("cleanup_staging() { case \"$outcome\" in committed|rolled_back|prepare_failed|conflict_before_commit)\n");
    for (n, item) in receipt.items.iter().enumerate() { script.push_str(&format!("rm -f -- {}\n", remote_path_expr(&format!("{}.cliora-{}-{n}.tmp", item.path, receipt.id)))); }
    script.push_str(";; esac; }\ntrap cleanup_staging EXIT\n");
    script.push_str(&rollback_script(receipt));
    script.push_str("journal || exit 79\n");
    for (n, item) in receipt.items.iter().enumerate() {
        if !valid_path(&item.path) { return Err(RemoteError::InvalidPath); }
        script.push_str(&format!("p={}\nif [ \"$(fingerprint \"$p\")\" != {} ]; then outcome=conflict_before_commit; journal; cat \"$tx/receipt\"; exit; fi\n", remote_path_expr(&item.path), shell_quote(&item.before)));
        script.push_str(&format!("if [ {before} != missing ]; then cp -- \"$p\" \"$tx/{n}.backup\" && chmod 600 \"$tx/{n}.backup\" && [ \"$(fingerprint \"$tx/{n}.backup\")\" = {before} ] || {{ outcome=prepare_failed; journal; cat \"$tx/receipt\"; exit; }}; fi\n", before=shell_quote(&item.before)));
        if let Some(bytes) = changes[&item.path] {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            script.push_str(&format!("mkdir -p -- \"$(dirname \"$p\")\" && (set -C; base64 -d > \"$p.cliora-$id-{n}.tmp\" <<'CLIORA_BLOB'\n{encoded}\nCLIORA_BLOB\n) && chmod 600 \"$p.cliora-$id-{n}.tmp\" && [ \"$(fingerprint \"$p.cliora-$id-{n}.tmp\")\" = {} ] || {{ outcome=prepare_failed; journal; cat \"$tx/receipt\"; exit; }}\n", shell_quote(&item.after)));
        }
        script.push_str(&format!("s{n}=prepared\njournal || exit 79\n"));
    }
    script.push_str("outcome=committing\njournal || exit 79\n");
    // Recheck every item after all staging, before the first mutation.
    for item in &receipt.items { script.push_str(&format!("[ \"$(fingerprint {})\" = {} ] || {{ outcome=conflict_before_commit; journal; cat \"$tx/receipt\"; exit; }}\n", remote_path_expr(&item.path), shell_quote(&item.before))); }
    for (n, item) in receipt.items.iter().enumerate() {
        script.push_str(&format!("p={}\n[ \"$(fingerprint \"$p\")\" = {} ] || {{ s{n}=conflict; rollback; exit; }}\ns{n}=applying\njournal || exit 79\n", remote_path_expr(&item.path), shell_quote(&item.before)));
        let operation = if item.after == "missing" { "rm -f -- \"$p\"".into() } else { format!("mv -f -- \"$p.cliora-$id-{n}.tmp\" \"$p\"") };
        script.push_str(&format!("if {operation}; then s{n}=committed; journal || exit 79; else rollback; exit; fi\n"));
    }
    script.push_str("outcome=committed\njournal || exit 79\ncat \"$tx/receipt\"\n");
    Ok(script)
}

pub fn list(target: &RemoteTarget) -> Result<Vec<Receipt>, RemoteError> {
    let output = run_command(target, "for r in \"$HOME/.cliora/transactions/\"*/receipt; do [ -f \"$r\" ] || continue; printf '%s\\n' __CLIORA_TX__; cat \"$r\"; done")?;
    if output.stdout.len() > 4 * 1024 * 1024 { return Err(RemoteError::Storage("远程写入回执超出读取上限".into())); }
    output.stdout.split("__CLIORA_TX__\n").filter(|s| !s.trim().is_empty()).map(|s| parse_receipt(target, s, false)).collect()
}

pub fn inspect(target: &RemoteTarget, id: &str, rollback: bool, fallback: Option<Receipt>) -> Result<Receipt, RemoteError> {
    if !valid_id(id) { return Err(RemoteError::InvalidPath); }
    let output = run_command(target, &format!("if [ -f \"$HOME/.cliora/transactions/{id}/receipt\" ]; then cat \"$HOME/.cliora/transactions/{id}/receipt\"; else printf missing; fi"))?;
    let absent = output.stdout == "missing";
    let mut receipt = if absent {
        let value = fallback.ok_or_else(|| RemoteError::Storage("Remote journal missing; inspect using the original local receipt".into()))?;
        if value.id != id || value.target_id != target.id || value.target_revision != target.updated_at || value.identity != operations::target_identity(target)
            || value.items.is_empty() || value.items.len() > 512 || value.items.iter().any(|item| !valid_path(&item.path) || !valid_hash(&item.before) || !valid_hash(&item.after)) { return Err(RemoteError::InvalidPath); }
        Receipt { outcome: "preparing".into(), items: value.items.into_iter().map(|item| Item { state: "untouched".into(), observed: None, ..item }).collect(), ..value }
    } else { parse(target, &output.stdout)? };
    let expected = if absent { "missing".to_owned() } else { digest(output.stdout.as_bytes()) };
    let script = inspection_script(&receipt, &expected, rollback);
    let result = run_command_with_stdin(target, "sh -s", script.as_bytes())?;
    let (journal_text, hashes) = result.stdout.split_once("__CLIORA_OBSERVED__\n").ok_or_else(|| RemoteError::Storage("远程核查结果不完整，请保留回执与备份".into()))?;
    receipt = parse(target, journal_text)?;
    let hashes = hashes.lines().collect::<Vec<_>>();
    if hashes.len() != receipt.items.len() { return Err(RemoteError::Storage("远程逐项核查结果不完整".into())); }
    for (item, value) in receipt.items.iter_mut().zip(hashes) {
        item.observed = Some(if value == item.after { "after" } else if value == item.before { "before" } else { "conflict" }.into());
    }
    super::read_cache::invalidate(&target.id);
    if let Some(context) = operations::current() { context.accept_persistent_launch(); }
    Ok(receipt)
}

fn inspection_script(receipt: &Receipt, expected: &str, rollback: bool) -> String {
    let mut script = String::from(HELPERS);
    script.push_str(&format!("protect\nid={}\ntx=\"$HOME/.cliora/transactions/$id\"\n[ ! -L \"$tx\" ] || exit 80\n[ \"$(fingerprint \"$tx/receipt\")\" = {} ] || exit 80\nmkdir -p \"$tx\" && chmod 700 \"$tx\" || exit 80\noutcome={}\n", shell_quote(&receipt.id), shell_quote(expected), shell_quote(&receipt.outcome)));
    for (n, item) in receipt.items.iter().enumerate() { script.push_str(&format!("s{n}={}\n", shell_quote(&item.state))); }
    script.push_str(&journal(&receipt));
    if rollback {
        script.push_str(&rollback_script(&receipt)); script.push_str("rollback > /dev/null\n");
    }
    script.push_str("all_before=1; all_after=1\n");
    for (n, item) in receipt.items.iter().enumerate() {
        script.push_str(&format!("v{n}=$(fingerprint {})\n[ \"$v{n}\" = {} ] || all_before=0\n[ \"$v{n}\" = {} ] || all_after=0\n", remote_path_expr(&item.path), shell_quote(&item.before), shell_quote(&item.after)));
    }
    script.push_str("if [ \"$all_after\" = 1 ]; then outcome=committed; elif [ \"$all_before\" = 1 ]; then outcome=rolled_back; else outcome=recovery_required; fi\njournal || exit 79\ncat \"$tx/receipt\"\nprintf '%s\\n' __CLIORA_OBSERVED__\n");
    script.push_str("case \"$outcome\" in committed|rolled_back)\n");
    for (n, item) in receipt.items.iter().enumerate() { script.push_str(&format!("rm -f -- {}\n", remote_path_expr(&format!("{}.cliora-{}-{n}.tmp", item.path, receipt.id)))); }
    script.push_str(";; esac\n");
    for n in 0..receipt.items.len() { script.push_str(&format!("printf '%s\\n' \"$v{n}\"\n")); }
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn fixture() -> RemoteTarget {
        RemoteTarget { id: "transaction-fixture".into(), name: "synthetic".into(), host: "fixture.invalid".into(), port: 22, user: "fixture".into(), auth_method: "key".into(), identity_file: None, ssh_config: None, default_path: None, enabled: true, created_at: 1, updated_at: 7 }
    }
    fn shell(script: &str) -> Option<String> {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("wsl.exe"); command.args(["--exec", "sh", "-s"]); command
        } else { let mut command = Command::new("sh"); command.arg("-s"); command };
        let Ok(mut child) = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else {
            eprintln!("SKIP remote shell integration: no POSIX shell/WSL; native acceptance remains required"); return None;
        };
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        Some(String::from_utf8(result.stdout).unwrap())
    }
    #[test]
    fn remote_transaction_faults_preserve_versions_backups_and_actual_per_file_results() {
        let target = fixture();
        for scenario in ["success", "conflict", "prepare_failure", "prepare_second_failure", "before_second_conflict", "replace_failure", "rollback_failure", "external_conflict", "interrupted"] {
            let id = uuid::Uuid::new_v4().to_string();
            let mut receipt = Receipt { id: id.clone(), target_id: target.id.clone(), target_revision: target.updated_at, identity: operations::target_identity(&target), outcome: "preparing".into(), items: vec![
                Item { path: "$HOME/a".into(), state: "untouched".into(), before: digest(b"old-a"), after: digest(b"new-a"), observed: None },
                Item { path: "$HOME/b".into(), state: "untouched".into(), before: digest(b"old-b"), after: digest(b"new-b"), observed: None },
            ] };
            let changes = BTreeMap::from([("$HOME/a".into(), Some(b"new-a".as_slice())), ("$HOME/b".into(), Some(b"new-b".as_slice()))]);
            let mut script = format!(r#"
set -eu
task_root=$(mktemp -d /tmp/cliora-transactions-XXXXXX)
case "$task_root" in /tmp/cliora-transactions-*) ;; *) exit 90;; esac
trap 'rm -rf -- "$task_root"' EXIT
export HOME="$task_root"
printf old-a > "$HOME/a"; printf old-b > "$HOME/b"
scenario={scenario}
replacements=0
cp() {{ if [ "$scenario" = prepare_failure ]; then return 1; fi; if [ "$scenario" = prepare_second_failure ]; then for argument in "$@"; do case "$argument" in */1.backup) return 1;; esac; done; fi; command cp "$@"; }}
mv() {{
  source=''
  for argument in "$@"; do case "$argument" in *.tmp|*-restore) source="$argument"; break;; esac; done
  case "$source" in
    *.tmp)
      replacements=$((replacements + 1))
      if [ "$replacements" = 2 ]; then
        case "$scenario" in
          replace_failure|rollback_failure) return 1;;
          external_conflict) printf external > "$HOME/a"; return 1;;
          interrupted) exit 99;;
        esac
      fi;;
    *-restore) [ "$scenario" != rollback_failure ] || return 1;;
  esac
  command mv "$@" || return $?
  if [ "$scenario" = before_second_conflict ] && [ "$replacements" = 1 ] && [ -n "$source" ]; then printf external > "$HOME/b"; fi
}}
[ "$scenario" != conflict ] || printf external > "$HOME/a"
set +e
(
"#);
            script.push_str(&commit_script(&receipt, &changes).unwrap());
            script.push_str(&format!("\n)\nstatus=$?\n[ \"$status\" = 0 ] || [ \"$status\" = 99 ] || exit 91\n"));
            if scenario == "interrupted" {
                // A new invocation reads the durable state and explicitly restores;
                // it never repeats the original write command.
                receipt.items[0].state = "committed".into(); receipt.items[1].state = "applying".into();
                script.push_str(&format!("id='{id}'; tx=\"$HOME/.cliora/transactions/$id\"; s0=committed; s1=applying\n"));
                script.push_str(HELPERS); script.push_str(&journal(&receipt)); script.push_str(&rollback_script(&receipt)); script.push_str("rollback\n");
            }
            if !["rollback_failure", "external_conflict", "before_second_conflict"].contains(&scenario) { script.push_str("[ \"$(find \"$HOME\" -name '*.tmp' -type f | wc -l)\" = 0 ] || exit 92\n"); }
            script.push_str("printf '%s\\n' __CHECK__; cat \"$HOME/a\"; printf '\\n'; cat \"$HOME/b\"; printf '\\n'; stat -c '%a' \"$HOME/.cliora/transactions\"; stat -c '%a' \"$HOME/.cliora/transactions/\"*/receipt\n");
            let Some(output) = shell(&script) else { return; };
            let (journal_text, check) = output.split_once("__CHECK__\n").expect("shell checks");
            let parsed = parse(&target, journal_text).unwrap();
            let expected = match scenario { "success" => ("committed", "new-a\nnew-b\n"), "conflict" => ("conflict_before_commit", "external\nold-b\n"), "prepare_failure" | "prepare_second_failure" => ("prepare_failed", "old-a\nold-b\n"), "before_second_conflict" => ("recovery_required", "old-a\nexternal\n"), "rollback_failure" => ("recovery_required", "new-a\nold-b\n"), "external_conflict" => ("recovery_required", "external\nold-b\n"), _ => ("rolled_back", "old-a\nold-b\n") };
            assert_eq!(parsed.outcome, expected.0, "{scenario}");
            assert!(check.starts_with(expected.1), "{scenario}: {check}");
            assert!(check.ends_with("700\n600\n"), "{scenario}: {check}");
            assert!(!journal_text.contains("old-a") && !journal_text.contains("new-a"));
            if scenario == "rollback_failure" { assert_eq!(parsed.items[0].state, "rollback_failed"); }
            if scenario == "external_conflict" { assert_eq!(parsed.items[0].state, "conflict"); }
        }
    }

    #[test]
    fn missing_journal_is_resolved_only_under_lock_against_the_original_versions() {
        let target = fixture();
        for (contents, expected) in [("old", "rolled_back"), ("new", "committed"), ("external", "recovery_required")] {
            let receipt = Receipt { id: uuid::Uuid::new_v4().to_string(), target_id: target.id.clone(), target_revision: target.updated_at,
                identity: operations::target_identity(&target), outcome: "preparing".into(), items: vec![
                    Item { path: "$HOME/a".into(), state: "untouched".into(), before: digest(b"old"), after: digest(b"new"), observed: None }
                ] };
            let mut script = format!("set -eu\ntask_root=$(mktemp -d /tmp/cliora-transactions-XXXXXX)\ncase \"$task_root\" in /tmp/cliora-transactions-*) ;; *) exit 90;; esac\ntrap 'rm -rf -- \"$task_root\"' EXIT\nexport HOME=\"$task_root\"\nprintf %s {contents} > \"$HOME/a\"\n");
            script.push_str(&inspection_script(&receipt, "missing", false));
            let Some(output) = shell(&script) else { return; };
            let (text, _) = output.split_once("__CLIORA_OBSERVED__\n").unwrap();
            assert_eq!(parse(&target, text).unwrap().outcome, expected);
        }
    }

    #[test]
    fn receipt_identity_and_schema_reject_cross_host_recovery() {
        let target = fixture();
        let text = format!("cliora-tx-v1\n{}\n{}\n7\ncommitted\n", uuid::Uuid::new_v4(), operations::target_identity(&target));
        assert!(parse(&target, &text).is_ok());
        let mut changed = target; changed.host = "other.invalid".into();
        assert!(parse(&changed, &text).is_err());
        assert!(!valid_path("$HOME/../credentials"));
        assert!(!valid_path("/tmp/a\nb"));
    }
}
