//! Capture OpenSSH's actual trust operands before any operation receives its revision.
use super::proxy::bounded_output;
use sha2::{Digest, Sha256};
use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub(super) type Result<T> = std::result::Result<T, &'static str>;
pub(super) type DefaultTrust = OnceCell<Result<String>>;
const MARK: &str = "__CLIORA_SSH_OPERAND_v1__";

pub(super) struct Profile {
    pub text: String,
    args: Vec<OsString>,
    trust_directives: BTreeMap<String, BTreeSet<String>>,
}

fn evaluate(command: &mut Command) -> Result<String> {
    let data =
        bounded_output(command, Duration::from_secs(8)).ok_or("ssh_configuration_unavailable")?;
    if data.len() >= 256 * 1024 {
        return Err("ssh_configuration_unavailable");
    }
    String::from_utf8(data).map_err(|_| "ssh_configuration_unavailable")
}

impl Profile {
    pub fn read(command: &Command) -> Result<Self> {
        let trace = tempfile::NamedTempFile::new().map_err(|_| "ssh_configuration_unavailable")?;
        let args: Vec<_> = command.get_args().map(OsString::from).collect();
        let mut traced = Command::new("ssh");
        traced
            .args(["-G", "-v", "-E"])
            .arg(trace.path())
            .args(&args);
        let text = evaluate(&mut traced)?;
        let logs = fs::read_to_string(trace.path()).map_err(|_| "ssh_configuration_unavailable")?;
        let mut trust_directives: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for source in logs
            .lines()
            .filter_map(|line| line.strip_prefix("debug1: Reading configuration data "))
        {
            let Ok(source) = fs::read(source.trim_end()) else {
                continue;
            };
            for line in String::from_utf8_lossy(&source).lines() {
                let Some((key, raw)) = line
                    .trim_start()
                    .split_once(|c: char| c.is_ascii_whitespace() || c == '=')
                else {
                    continue;
                };
                let key = key.to_ascii_lowercase();
                if matches!(key.as_str(), "userknownhostsfile" | "globalknownhostsfile") {
                    trust_directives.entry(key).or_default().insert(
                        raw.trim_start()
                            .trim_start_matches('=')
                            .trim_start()
                            .to_owned(),
                    );
                }
            }
        }
        Ok(Self {
            text,
            args,
            trust_directives,
        })
    }

    fn paths(&self, key: &str, value: &str, defaults: &DefaultTrust) -> Result<Vec<PathBuf>> {
        if value == "none" {
            return Ok(Vec::new());
        }
        if !value.contains(char::is_whitespace) {
            return Ok(vec![value.into()]);
        }
        let mut candidates = BTreeSet::new();
        for raw in self.trust_directives.get(key).into_iter().flatten() {
            // Retain source quoting. OpenSSH itself expands the path operands, with the
            // same host, user and config; inserted marker operands recover the boundaries
            // that ssh -G otherwise drops. Inactive Match/Host clauses must agree exactly.
            let mut cmd = Command::new("ssh");
            let Ok(marked) = marked_operands(raw) else {
                continue;
            };
            cmd.arg("-G")
                .args(["-o", &format!("{key} {marked}")])
                .args(&self.args);
            let Ok(output) = evaluate(&mut cmd) else {
                continue;
            };
            let prefix = format!("{key} ");
            let Some(expanded) = output.lines().find_map(|line| line.strip_prefix(&prefix)) else {
                continue;
            };
            let parts: Vec<_> = expanded
                .split(&format!(" {MARK} "))
                .map(PathBuf::from)
                .collect();
            if parts
                .iter()
                .map(|p| p.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
                == value
            {
                candidates.insert(parts);
            }
        }
        if candidates.len() > 1 {
            return Err("ambiguous_known_hosts_paths");
        }
        if let Some(parts) = candidates.into_iter().next() {
            return Ok(parts);
        }
        let defaults = defaults
            .get_or_init(|| {
                let mut command = Command::new("ssh");
                command.args(["-G", "-F", "none", "--", "cliora-default.invalid"]);
                evaluate(&mut command)
            })
            .as_ref()
            .map_err(|error| *error)?;
        if !defaults
            .lines()
            .any(|line| line.strip_prefix(&format!("{key} ")) == Some(value))
        {
            return Err("ambiguous_known_hosts_paths");
        }
        // Built-in OpenSSH defaults have absolute paths and no source directive. Preserve
        // an absolute home prefix as one token on platforms with spaces in usernames.
        let home = dirs::home_dir().ok_or("ssh_configuration_unavailable")?;
        let prefix = format!("{}/", home.display());
        let text = value.replace(&prefix, "~/");
        let mut paths = Vec::new();
        for part in text.split_whitespace() {
            let path = if let Some(suffix) = part.strip_prefix("~/") {
                home.join(suffix)
            } else {
                PathBuf::from(part)
            };
            if !path.is_absolute() {
                return Err("ambiguous_known_hosts_paths");
            }
            paths.push(path);
        }
        Ok(paths)
    }
}

fn marked_operands(raw: &str) -> Result<String> {
    let mut tokens = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut start = None;
    for (i, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            start.get_or_insert(i);
            continue;
        }
        if let Some(q) = quote {
            if q == ch {
                quote = None;
            }
            continue;
        }
        if ch == '#' && start.is_none() {
            break;
        }
        if ch.is_ascii_whitespace() {
            if let Some(first) = start.take() {
                tokens.push(&raw[first..i]);
            }
        } else {
            start.get_or_insert(i);
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
            }
        }
    }
    if let Some(first) = start {
        tokens.push(&raw[first..]);
    }
    if quote.is_some() || escaped || tokens.is_empty() || raw.contains(MARK) {
        return Err("ssh_configuration_unavailable");
    }
    Ok(tokens.join(&format!(" {MARK} ")))
}

#[derive(Default)]
pub(super) struct Trust {
    files: BTreeMap<PathBuf, (String, Option<Vec<u8>>)>,
}

impl Trust {
    pub fn directive(&mut self, profile: &Profile, key: &str, value: &str, defaults: &DefaultTrust) -> Result<String> {
        let paths = if key == "revokedhostkeys" {
            if value == "none" {
                Vec::new()
            } else {
                vec![PathBuf::from(value)]
            }
        } else {
            profile.paths(key, value, defaults)?
        };
        let mut names = Vec::new();
        for path in paths {
            let next = self.files.len();
            if !self.files.contains_key(&path) {
                let data = match fs::metadata(&path) {
                    Ok(info) if info.is_file() => {
                        Some(fs::read(&path).map_err(|_| "ssh_trust_unavailable")?)
                    }
                    Ok(_) if path == Path::new("/dev/null") => Some(Vec::new()),
                    Ok(_) => return Err("ssh_trust_unavailable"),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(_) => return Err("ssh_trust_unavailable"),
                };
                self.files
                    .insert(path.clone(), (format!("trust-{next}"), data));
            }
            names.push(self.files[&path].0.clone());
        }
        let paths = if names.is_empty() {
            "none".into()
        } else {
            names.join(" ")
        };
        Ok(format!("{key} {paths}\n"))
    }

    pub fn bind(&self, hash: &mut Sha256) {
        for (path, (name, bytes)) in &self.files {
            hash.update(name.as_bytes());
            hash.update([0]);
            hash.update(path.as_os_str().as_encoded_bytes());
            hash.update([0]);
            if let Some(data) = bytes {
                hash.update([1]);
                hash.update(Sha256::digest(data));
            } else {
                hash.update([0]);
            }
        }
    }

    pub fn write(&self, dir: &Path) -> Result<()> {
        for (name, bytes) in self.files.values() {
            if let Some(bytes) = bytes {
                fs::write(dir.join(name), bytes).map_err(|_| "ssh_trust_unavailable")?;
            }
        }
        Ok(())
    }
}
