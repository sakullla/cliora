use std::process::Command;

use super::profile::{self, auth_env_name, Connection};
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
