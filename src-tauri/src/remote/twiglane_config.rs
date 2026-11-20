//! Freeze the configuration OpenSSH resolved (including Host/Match/Include and jump hosts).
//! An SSH operation consumes this snapshot, never the mutable input file a second time.
use super::{connection_args, hide_console_window, operations, validate_target, RemoteTarget};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::process::Command;
use std::time::Duration;

const PRIVATE_SSH: &[&str] = &[
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
];

pub(super) struct Snapshot {
    pub revision: String,
    pub hostname: String,
    config: String,
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn known_hosts_paths(value: &str) -> Result<String, &'static str> {
    // ssh -G joins this multi-operand setting without source quotes. Keep a complete home
    // prefix together (including spaces on macOS/Windows), and avoid guessing at a boundary.
    let home = dirs::home_dir().and_then(|path| path.to_str().map(str::to_string));
    let shortened = home
        .as_deref()
        .filter(|path| path.contains(' '))
        .map(|path| value.replace(&format!("{path}/"), "~/"));
    let text = shortened.as_deref().unwrap_or(value);
    let parts: Vec<_> = text.split_whitespace().collect();
    if parts.len() > 1
        && parts
            .iter()
            .any(|path| !(std::path::Path::new(path).is_absolute() || path.starts_with("~/")))
    {
        return Err("ambiguous_known_hosts_paths");
    }
    Ok(parts.into_iter().map(quoted).collect::<Vec<_>>().join(" "))
}

fn option(key: &str, value: &str) -> Result<String, &'static str> {
    // ssh -G prints these single operands without source quotes. Restore their token boundary.
    let value = match key {
        "userknownhostsfile" | "globalknownhostsfile" => known_hosts_paths(value)?,
        "identityfile"
        | "certificatefile"
        | "identityagent"
        | "pkcs11provider"
        | "securitykeyprovider"
        | "revokedhostkeys"
        | "xauthlocation"
        | "controlpath"
        | "user"
        | "hostname"
        | "hostkeyalias"
        | "bindaddress"
        | "bindinterface"
        | "setenv" => quoted(value),
        _ => value.to_string(),
    };
    Ok(format!("{key} {value}\n"))
}

fn resolution(command: &mut Command) -> Result<String, &'static str> {
    let data = super::proxy::bounded_output(command, Duration::from_secs(8))
        .ok_or("ssh_configuration_unavailable")?;
    if data.len() >= 256 * 1024 {
        return Err("ssh_configuration_unavailable");
    }
    String::from_utf8(data).map_err(|_| "ssh_configuration_unavailable")
}

impl Snapshot {
    pub(super) fn resolve(target: &RemoteTarget) -> Result<Self, &'static str> {
        validate_target(target).map_err(|_| "invalid_target")?;
        if target.user.starts_with('-') {
            return Err("invalid_target");
        }
        let mut ssh = Command::new("ssh");
        let mut args = connection_args(target);
        let dst = args.pop().ok_or("invalid_target")?;
        ssh.arg("-G")
            .args(PRIVATE_SSH)
            .args(args)
            .arg("--")
            .arg(dst);
        let mut profiles = vec![resolution(&mut ssh)?];
        let mut seen = HashMap::new();
        let mut index = 0;
        let mut config = String::new();
        let mut hostname = None;
        while index < profiles.len() {
            let profile = profiles[index].clone();
            index += 1;
            let mut alias = None;
            let mut host = None;
            let mut body = String::new();
            let mut jumps = Vec::new();
            for line in profile.lines() {
                let (key, value) = line
                    .split_once(' ')
                    .ok_or("ssh_configuration_unavailable")?;
                if value.chars().any(char::is_control) {
                    return Err("ssh_configuration_unavailable");
                }
                match key {
                    "host" => {
                        alias = Some(value);
                        continue;
                    }
                    "hostname" => host = Some(value),
                    "proxyjump" if value != "none" => jumps.extend(value.split(',')),
                    // ssh -G has already performed canonicalization. Repeating it can retarget a
                    // hostname if DNS or the consulted configuration changed after selection.
                    "canonicalizehostname" => {
                        body.push_str("canonicalizehostname no\n");
                        continue;
                    }
                    _ => {}
                }
                body.push_str(&option(key, value)?);
            }
            let alias = alias.ok_or("ssh_configuration_unavailable")?;
            let host = host.ok_or("ssh_configuration_unavailable")?;
            if alias.is_empty()
                || alias.contains(['*', '?', '!', '\\', '"'])
                || alias.chars().any(char::is_whitespace)
            {
                return Err("ssh_configuration_unavailable");
            }
            if let Some(previous) = seen.insert(alias.to_owned(), body.clone()) {
                if previous != body {
                    return Err("conflicting_jump_configuration");
                }
                continue;
            }
            if seen.len() > 16 {
                return Err("ssh_configuration_unavailable");
            }
            hostname.get_or_insert_with(|| host.to_owned());
            config.push_str(&format!("Host {}\n{body}", quoted(alias)));
            if profiles.len() + jumps.len() > 32 {
                return Err("ssh_configuration_unavailable");
            }
            for jump in jumps {
                let mut args = Command::new("ssh");
                args.arg("-G");
                if let Some(path) = &target.ssh_config {
                    args.args(["-F", path]);
                }
                let dest = if jump.starts_with("ssh://") {
                    jump.to_owned()
                } else {
                    format!("ssh://{jump}")
                };
                args.arg("--").arg(dest);
                profiles.push(resolution(&mut args)?);
            }
        }
        let mut digest = Sha256::new();
        digest.update(operations::target_identity(target));
        digest.update(config.as_bytes());
        Ok(Self {
            revision: format!("{:x}", digest.finalize()),
            hostname: hostname.ok_or("ssh_configuration_unavailable")?,
            config,
        })
    }

    pub(super) fn command(&self) -> Result<(Command, tempfile::NamedTempFile), &'static str> {
        let mut file = tempfile::Builder::new()
            .prefix("cliora-ssh-")
            .tempfile()
            .map_err(|_| "ssh_configuration_unavailable")?;
        file.write_all(self.config.as_bytes())
            .map_err(|_| "ssh_configuration_unavailable")?;
        let mut command = Command::new("ssh");
        hide_console_window(&mut command);
        command.arg("-F").arg(file.path()).args(PRIVATE_SSH);
        // Keep the input alias for OpenSSH %n expansion. Only the frozen config resolves it.
        Ok((command, file))
    }
}
