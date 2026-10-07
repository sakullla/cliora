use std::process::Command;

use super::profile::{self, auth_env_name, Connection, NativeProfile};
use crate::adapters::Registry;
use crate::credentials::CredentialStore;

/// Resolve a launch credential value from the system credential store at
/// injection time. The value exists only in the child process environment.
pub fn stored_launch_credential(
    secret_ref: &str,
    credentials: &dyn CredentialStore,
) -> Result<String, String> {
    if !profile::valid_connection_secret_ref(secret_ref) {
        return Err("连接密钥标识无效".into());
    }
    let secret = credentials
        .get(secret_ref)
        .map_err(|_| "系统凭据库中找不到此连接的密钥；请重新保存密钥")?;
    if secret.is_empty() {
        return Err("连接密钥为空；请重新保存".into());
    }
    Ok(secret)
}

/// The launcher calls this in Rust before spawning a child. The tool is a
/// registry string ID, so every registered adapter — including the open
/// string-ID clients — resolves its environment name through
/// `CliAdapter::auth_env_name`; the five legacy enum tools resolve to the
/// same statics `adapters::known` maps, keeping their names byte-identical.
/// The value is never serialized or returned to the frontend.
pub fn inject_child_credential(
    command: &mut Command,
    tool_id: &str,
    connection: &Connection,
    credentials: &dyn CredentialStore,
) -> Result<bool, String> {
    let Some(secret_ref) = &connection.secret_ref else {
        return Ok(false);
    };
    if !profile::valid_connection_secret_ref(secret_ref) {
        return Err("连接密钥标识无效".into());
    }
    let adapter = Registry::builtins()
        .get(tool_id)
        .ok_or("未注册的 CLI 不能注入启动凭据")?;
    let name = adapter
        .auth_env_name(connection)
        .ok_or("无法确定 CLI 认证环境变量")?;
    let secret = stored_launch_credential(secret_ref, credentials)?;
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
    use crate::domain::CliId;
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
        assert!(inject_child_credential(&mut child, "codex", &connection, &store).unwrap());
        let output = child.output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("test-secret-827"));
        assert!(!serde_json::to_string(&connection)
            .unwrap()
            .contains("test-secret-827"));
        let missing = MemoryStore(HashMap::new());
        assert!(inject_child_credential(
            &mut Command::new("cmd"),
            "codex",
            &connection,
            &missing
        )
        .unwrap_err()
        .contains("重新保存"));
        assert!(inject_child_credential(
            &mut Command::new("cmd"),
            "unregistered",
            &connection,
            &store
        )
        .unwrap_err()
        .contains("未注册"));
    }

    #[test]
    fn string_id_adapter_receives_its_frozen_env_key_from_the_registry_port() {
        // command_code/antigravity/kiro have no CliId enum entry; the registry
        // string-ID port still resolves their frozen environment names.
        let reference = "connection-00000000-0000-4000-8000-000000000003";
        let store = MemoryStore(HashMap::from([(
            reference.into(),
            "ksk-test-917".into(),
        )]));
        for (tool, env_name) in [
            ("command_code", "COMMAND_CODE_API_KEY"),
            ("antigravity", "GEMINI_API_KEY"),
            ("kiro", "KIRO_API_KEY"),
        ] {
            let connection = Connection {
                provider_id: "official".into(),
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
                c.args(["/C", &format!("echo %{env_name}%")]);
                c
            };
            #[cfg(not(windows))]
            let mut child = {
                let mut c = Command::new("sh");
                c.args(["-c", &format!("printf %s \"${env_name}\"")]);
                c
            };
            assert!(inject_child_credential(&mut child, tool, &connection, &store).unwrap());
            let output = child.output().unwrap();
            assert!(output.status.success());
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains("ksk-test-917"), "{tool}: {stdout}");
            assert!(!stdout.contains(reference));
        }
    }

    #[test]
    fn launch_credential_value_resolves_only_from_a_valid_store_reference() {
        let reference = "connection-00000000-0000-4000-8000-000000000004";
        let store = MemoryStore(HashMap::from([(reference.into(), "value-1".into())]));
        assert_eq!(stored_launch_credential(reference, &store).unwrap(), "value-1");
        let missing = MemoryStore(HashMap::new());
        assert!(stored_launch_credential(reference, &missing)
            .unwrap_err()
            .contains("重新保存"));
        let empty = MemoryStore(HashMap::from([(reference.into(), String::new())]));
        assert!(stored_launch_credential(reference, &empty)
            .unwrap_err()
            .contains("为空"));
        assert!(stored_launch_credential("not-a-reference", &store)
            .unwrap_err()
            .contains("无效"));
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
