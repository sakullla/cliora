use std::process::Command;

use super::profile::{self, auth_env_name, Connection, NativeProfile};
use crate::credentials::CredentialStore;
use crate::domain::CliId;

/// T3's launcher calls this in Rust before spawning a child. The value is
/// never serialized or returned to the frontend.
pub fn inject_child_credential(
    command: &mut Command,
    tool: CliId,
    connection: &Connection,
    credentials: &dyn CredentialStore,
) -> Result<bool, String> {
    let Some(secret_ref) = &connection.secret_ref else {
        return Ok(false);
    };
    if !profile::valid_connection_secret_ref(secret_ref) {
        return Err("连接密钥标识无效".into());
    }
    let name = auth_env_name(tool, connection).ok_or("无法确定 CLI 认证环境变量")?;
    let secret = credentials
        .get(secret_ref)
        .map_err(|_| "系统凭据库中找不到此连接的密钥；请重新保存密钥")?;
    if secret.is_empty() {
        return Err("连接密钥为空；请重新保存".into());
    }
    command.env(name, secret);
    Ok(true)
}

pub fn verify_stored_credential(
    connection: &Connection,
    credentials: &dyn CredentialStore,
) -> Result<(), String> {
    if let Some(id) = &connection.secret_ref {
        if !profile::valid_connection_secret_ref(id) {
            return Err("连接密钥标识无效".into());
        }
        if credentials
            .get(id)
            .map_err(|_| "系统凭据库中找不到此连接的密钥；请重新保存密钥")?
            .is_empty()
        {
            return Err("连接密钥为空；请重新保存".into());
        }
    }
    Ok(())
}

/// Resolve every imported native credential before changing the child command.
/// Claude's project-local settings take precedence over project settings.
pub fn inject_profile_credentials(
    command: &mut Command,
    native_profile: &NativeProfile,
    credentials: &dyn CredentialStore,
) -> Result<usize, String> {
    profile::validate_native_credentials(native_profile)?;
    let mut values = Vec::new();
    for role in ["settings", "local_settings"] {
        if let Some(entries) = native_profile.native_credentials.get(role) {
            for (name, id) in entries {
                if crate::adapters::known(native_profile.tool)
                    .imported_connection_overrides_native()
                    && native_profile
                        .connection
                        .as_ref()
                        .is_some_and(|connection| connection.secret_ref.is_some())
                {
                    continue;
                }
                values.push((name.clone(), read_secret(id, credentials)?));
            }
        }
    }
    // A newly saved connection key must take precedence over credentials
    // imported from an older native file for the same environment name.
    if let Some(connection) = &native_profile.connection {
        profile::validate_connection(connection)?;
        if let Some(id) = &connection.secret_ref {
            let name = auth_env_name(native_profile.tool, connection)
                .ok_or("无法确定 CLI 认证环境变量")?;
            let value = read_secret(id, credentials)?;
            values.push((name, value));
        }
    }
    let count = values.len();
    for (name, value) in values {
        command.env(name, value);
    }
    Ok(count)
}

fn read_secret(id: &str, credentials: &dyn CredentialStore) -> Result<String, String> {
    if !profile::valid_connection_secret_ref(id) {
        return Err("连接密钥标识无效".into());
    }
    let value = credentials
        .get(id)
        .map_err(|_| "系统凭据库中找不到此连接的密钥；请重新安全接入")?;
    if value.is_empty() {
        return Err("连接密钥为空；请重新安全接入".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::collections::HashMap;

    struct MemoryStore(HashMap<String, String>);
    impl CredentialStore for MemoryStore {
        fn put(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!()
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0.get(id).cloned().ok_or("missing".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            unreachable!()
        }
    }

    #[test]
    fn child_receives_keyring_secret_through_native_env_without_serializing_it() {
        let reference = "connection-00000000-0000-4000-8000-000000000001";
        let store = MemoryStore(HashMap::from([(
            reference.into(),
            "test-secret-827".into(),
        )]));
        let connection = Connection {
            provider_id: "example".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://example.test/v1".into(),
            model: "model".into(),
            secret_ref: Some(reference.into()),
            auth_env_var: None,
            model_records: Vec::new(),
        };
        #[cfg(windows)]
        let mut child = {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "echo %CLIORA_CODEX_EXAMPLE_API_KEY%"]);
            c
        };
        #[cfg(not(windows))]
        let mut child = {
            let mut c = Command::new("sh");
            c.args(["-c", "printf %s \"$CLIORA_CODEX_EXAMPLE_API_KEY\""]);
            c
        };
        assert!(inject_child_credential(&mut child, CliId::Codex, &connection, &store).unwrap());
        let output = child.output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("test-secret-827"));
        assert!(!serde_json::to_string(&connection)
            .unwrap()
            .contains("test-secret-827"));
        let missing = MemoryStore(HashMap::new());
        assert!(inject_child_credential(
            &mut Command::new("cmd"),
            CliId::Codex,
            &connection,
            &missing
        )
        .unwrap_err()
        .contains("重新保存"));
    }

    #[test]
    fn claude_local_credential_overrides_project_credential_without_explicit_model() {
        let first = "connection-00000000-0000-4000-8000-000000000001";
        let local = "connection-00000000-0000-4000-8000-000000000002";
        let store = MemoryStore(HashMap::from([
            (first.into(), "project-key".into()),
            (local.into(), "local-key".into()),
        ]));
        let item = NativeProfile {
            editing: None,
            revision: String::new(),
            id: String::new(),
            tool: CliId::ClaudeCode,
            name: "本机".into(),
            version: 0,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::from([
                (
                    "settings".into(),
                    BTreeMap::from([("ANTHROPIC_API_KEY".into(), first.into())]),
                ),
                (
                    "local_settings".into(),
                    BTreeMap::from([("ANTHROPIC_API_KEY".into(), local.into())]),
                ),
            ]),
        };
        let mut child = Command::new("never-spawned");
        assert_eq!(
            inject_profile_credentials(&mut child, &item, &store).unwrap(),
            2
        );
        let env_value = child
            .get_envs()
            .find(|(name, _)| *name == "ANTHROPIC_API_KEY")
            .and_then(|(_, value)| value)
            .unwrap();
        assert_eq!(env_value, "local-key");
        assert!(serde_json::to_string(&item).unwrap().contains(first));
        assert!(!serde_json::to_string(&item).unwrap().contains("local-key"));

        let mut missing = Command::new("never-spawned");
        let unavailable = MemoryStore(HashMap::from([(first.into(), "project-key".into())]));
        assert!(inject_profile_credentials(&mut missing, &item, &unavailable).is_err());
        assert!(missing.get_envs().next().is_none());
    }
}
