//! OpenSSH calls KnownHostsCommand in the authenticated transport for the host key
//! actually offered. We contribute no keys and retain the user's own lookup command.
use super::twiglane_trust::Result;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) const FLAG: &str = "--cliora-twiglane-peer-key";
const CTX: &str = "CLIORA_TWIGLANE_PEER_CONTEXT";
const CATALOG: &str = "CLIORA_TWIGLANE_CATALOG";
const EXPECT: &str = "CLIORA_TWIGLANE_EXPECTED_PEER";
const COUNT: &str = "CLIORA_TWIGLANE_PROFILE_COUNT";
const NONCE: &str = "CLIORA_TWIGLANE_PEER_NONCE";

pub(super) fn setup(
    cmd: &mut Command,
    folder: &Path,
    catalog: &str,
    expected: Option<&str>,
    count: usize,
) -> Result<()> {
    let nonce = uuid::Uuid::new_v4().to_string();
    fs::write(folder.join("invocation"), &nonce).map_err(|_| "peer_unverified")?;
    cmd.env(NONCE, nonce)
        .env(CTX, folder)
        .env(CATALOG, catalog)
        .env(COUNT, count.to_string())
        .env_remove(EXPECT);
    if let Some(expected) = expected {
        cmd.env(EXPECT, expected);
    }
    Ok(())
}

fn file_for(folder: &Path, index: usize) -> PathBuf {
    folder.join(format!("peer-{index}"))
}

/// Stable identity of the authenticated final host, independent of its route or trust policy.
pub(super) fn host_identity(folder: &Path) -> Result<String> {
    let key = fs::read(file_for(folder, 0)).map_err(|_| "peer_unverified")?;
    if key.len() != 32 {
        return Err("peer_unverified");
    }
    let mut hash = Sha256::new();
    hash.update(b"cliora-twiglane-host-key-v1\0");
    hash.update(key);
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn token(folder: &Path, catalog: &str, count: usize) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(b"cliora-twiglane-authenticated-peers-v1\0");
    hash.update(catalog.as_bytes());
    for i in 0..count {
        let key = fs::read(file_for(folder, i)).map_err(|_| "peer_unverified")?;
        if key.len() != 32 {
            return Err("peer_unverified");
        }
        hash.update(key);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn callback(args: &[String]) -> Result<()> {
    let [index, phase, server_key, original @ ..] = args else {
        return Err("peer_unverified");
    };
    let folder = PathBuf::from(std::env::var_os(CTX).ok_or("peer_unverified")?);
    let nonce = std::env::var(NONCE).map_err(|_| "peer_unverified")?;
    if folder.parent() != Some(std::env::temp_dir().as_path())
        || !folder
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("cliora-ssh-"))
        || !matches!(phase.as_str(), "ORDER" | "HOSTNAME" | "ADDRESS")
        || uuid::Uuid::parse_str(&nonce).is_err()
        || fs::read_to_string(folder.join("invocation"))
            .ok()
            .as_deref()
            != Some(&nonce)
    {
        return Err("peer_unverified");
    }
    let count = std::env::var(COUNT)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| (1..=16).contains(n))
        .ok_or("peer_unverified")?;
    let i = index
        .parse::<usize>()
        .ok()
        .filter(|v| *v < count)
        .ok_or("peer_unverified")?;
    if phase == "HOSTNAME" {
        if server_key == "NONE" || server_key.is_empty() {
            return Err("peer_unverified");
        }
        let key = Sha256::digest(server_key.as_bytes());
        let path = file_for(&folder, i);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file.write_all(&key).map_err(|_| "peer_unverified")?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if fs::read(path).ok().as_deref() != Some(key.as_slice()) {
                    return Err("target_changed");
                }
            }
            Err(_) => return Err("peer_unverified"),
        }
        if i == 0 {
            if let Ok(expected) = std::env::var(EXPECT) {
                let catalog = std::env::var(CATALOG).map_err(|_| "peer_unverified")?;
                if token(&folder, &catalog, count)? != expected {
                    let _ = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(folder.join("mismatch"));
                    return Err("target_changed");
                }
            }
        }
    }
    if let Some((program, args)) = original.split_first() {
        if !folder.join(format!("configured-lookup-{i}")).is_file() {
            return Err("peer_unverified");
        }
        if !Command::new(program)
            .args(args)
            .status()
            .is_ok_and(|status| status.success())
        {
            return Err("ssh_trust_unavailable");
        }
    }
    Ok(())
}
