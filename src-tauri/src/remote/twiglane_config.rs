//! Freeze the configuration OpenSSH resolved (including Host/Match/Include and jump hosts).
//! An SSH operation consumes this snapshot, never the mutable input file a second time.
use super::{
    connection_args, hide_console_window, operations, twiglane_peer,
    twiglane_trust::{DefaultTrust, Profile, Trust},
    validate_target, RemoteTarget,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::process::Command;

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
    trust: Trust,
    pub count: usize,
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn jump_host(destination: &str) -> Option<&str> {
    // The destination has already been accepted by ssh -G as an SSH URI.
    let authority = destination.strip_prefix("ssh://")?;
    let address = authority.rsplit('@').next()?;
    if let Some(bracketed) = address.strip_prefix('[') {
        return bracketed.split_once(']').map(|(host, _)| host);
    }
    address.split(':').next()
}

fn option(key: &str, value: &str) -> Result<String, &'static str> {
    // ssh -G prints these single operands without source quotes. Restore their token boundary.
    let value = match key {
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

impl Snapshot {
    pub(super) fn resolve(target: &RemoteTarget) -> Result<Self, &'static str> {
        Self::resolve_with_defaults(target, &DefaultTrust::new())
    }

    pub(super) fn resolve_with_defaults(
        target: &RemoteTarget,
        defaults: &DefaultTrust,
    ) -> Result<Self, &'static str> {
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
        let mut profiles = vec![(None, Profile::read(&ssh)?)];
        let mut trust = Trust::default();
        let mut seen = HashMap::new();
        let mut index = 0;
        let mut config = String::new();
        let mut hostname = None;
        while index < profiles.len() {
            let (jump_destination, profile) = &profiles[index];
            index += 1;
            let mut alias = None;
            let mut host = None;
            let mut body = String::new();
            let mut jumps = Vec::new();
            for line in profile.text.lines() {
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
                    "userknownhostsfile" | "globalknownhostsfile" | "revokedhostkeys" => {
                        body.push_str(&trust.directive(profile, key, value, defaults)?);
                        continue;
                    }
                    "proxyjump" if value != "none" => {
                        jumps.extend(value.split(',').map(str::to_owned))
                    }
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
            // OpenSSH 8.9 prints the effective hostname but omits the requested host.
            // Frozen Host sections still need to match the original alias on reconnect.
            let alias = match (alias, jump_destination.as_deref()) {
                (Some(alias), _) => alias,
                (None, Some(destination)) => {
                    jump_host(destination).ok_or("ssh_configuration_unavailable")?
                }
                (None, None) => target.host.as_str(),
            };
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
                args.arg("--").arg(&dest);
                profiles.push((Some(dest), Profile::read(&args)?));
            }
        }
        let mut digest = Sha256::new();
        digest.update(operations::target_identity(target));
        digest.update(config.as_bytes());
        trust.bind(&mut digest);
        Ok(Self {
            revision: format!("{:x}", digest.finalize()),
            hostname: hostname.ok_or("ssh_configuration_unavailable")?,
            config,
            trust,
            count: seen.len(),
        })
    }

    pub(super) fn command(
        &self,
        expected: Option<&str>,
    ) -> Result<(Command, tempfile::TempDir), &'static str> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("cliora-ssh-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let folder = builder
            .tempdir()
            .map_err(|_| "ssh_configuration_unavailable")?;
        self.trust.write(folder.path())?;
        let executable = std::env::current_exe().map_err(|_| "ssh_configuration_unavailable")?;
        let exe = executable
            .to_str()
            .ok_or("ssh_configuration_unavailable")?
            .replace('%', "%%");
        let mut output = String::new();
        for (index, section) in self
            .config
            .strip_prefix("Host ")
            .ok_or("ssh_configuration_unavailable")?
            .split("\nHost ")
            .enumerate()
        {
            let (host, body) = section
                .split_once('\n')
                .ok_or("ssh_configuration_unavailable")?;
            output.push_str(&format!("Host {host}\nControlMaster no\nControlPath none\nStrictHostKeyChecking yes\nUpdateHostKeys no\nNoHostAuthenticationForLocalhost no\n"));
            let original = body
                .lines()
                .find_map(|line| line.strip_prefix("knownhostscommand "))
                .filter(|value| *value != "none");
            output.push_str(&format!(
                "KnownHostsCommand {} {} {index} %I %K",
                quoted(&exe),
                twiglane_peer::FLAG
            ));
            if let Some(chain) = original {
                std::fs::File::create(folder.path().join(format!("configured-lookup-{index}")))
                    .map_err(|_| "ssh_configuration_unavailable")?;
                output.push(' ');
                output.push_str(chain);
            }
            output.push('\n');
            for line in body.lines() {
                let (key, value) = line
                    .split_once(' ')
                    .ok_or("ssh_configuration_unavailable")?;
                if key == "knownhostscommand" {
                    continue;
                }
                if matches!(
                    key,
                    "userknownhostsfile" | "globalknownhostsfile" | "revokedhostkeys"
                ) && value != "none"
                {
                    output.push_str(key);
                    for name in value.split_whitespace() {
                        output.push(' ');
                        let path = folder.path().join(name);
                        output.push_str(&quoted(
                            &path
                                .to_str()
                                .ok_or("ssh_configuration_unavailable")?
                                .replace('%', "%%"),
                        ));
                    }
                } else {
                    output.push_str(line);
                }
                output.push('\n');
            }
        }
        let config = folder.path().join("config");
        std::fs::File::create(&config)
            .and_then(|mut file| file.write_all(output.as_bytes()))
            .map_err(|_| "ssh_configuration_unavailable")?;
        let mut command = Command::new("ssh");
        hide_console_window(&mut command);
        command.arg("-F").arg(config).args(PRIVATE_SSH);
        twiglane_peer::setup(
            &mut command,
            folder.path(),
            &self.revision,
            expected,
            self.count,
        )?;
        Ok((command, folder))
    }
}
