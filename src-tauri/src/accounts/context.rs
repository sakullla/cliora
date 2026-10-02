use super::NativeContext;
use std::{collections::BTreeMap, fs, path::Path, process::Command};

/// Reject links/junctions before accessing native authentication material.
pub fn check_path(path: &Path) -> Result<(), String> {
    for component in path.ancestors() {
        match fs::symlink_metadata(component) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("账号目录不可包含符号链接".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("账号目录不可包含重解析点".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("无法检查账号目录".into()),
        }
    }
    Ok(())
}

fn private_directory(path: &Path) -> Result<(), String> {
    check_path(path)?;
    fs::create_dir_all(path).map_err(|_| "无法创建账号目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法限制账号目录权限")?;
    }
    #[cfg(windows)]
    {
        let system =
            std::path::PathBuf::from(std::env::var_os("SystemRoot").ok_or("无法定位系统目录")?)
                .join("System32");
        let who = crate::background_process::command(system.join("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .map_err(|_| "无法检查用户 SID")?;
        if !who.status.success() {
            return Err("无法检查用户 SID".into());
        }
        let text = String::from_utf8(who.stdout).map_err(|_| "用户 SID 格式异常")?;
        let sid = text
            .trim()
            .rsplit(',')
            .next()
            .unwrap_or("")
            .trim_matches('"');
        if !sid.starts_with("S-1-") || !sid[4..].bytes().all(|b| b.is_ascii_digit() || b == b'-') {
            return Err("用户 SID 格式异常".into());
        }
        let status = crate::background_process::command(system.join("icacls.exe"))
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("*{sid}:(OI)(CI)F"))
            .args(["/grant:r", "*S-1-5-18:(OI)(CI)F"])
            .output()
            .map_err(|_| "无法限制账号目录权限")?;
        if !status.status.success() {
            return Err("无法限制账号目录权限".into());
        }
    }
    Ok(())
}

pub fn create_context(base: &Path, tool: &str) -> Result<NativeContext, String> {
    if !base.is_absolute() {
        return Err("账号根目录必须为绝对路径".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let accounts = base.join("accounts");
    private_directory(&accounts)?;
    let root = accounts.join(&id);
    private_directory(&root)?;
    context_at(root, tool, id)
}

pub fn context_at(
    root: std::path::PathBuf,
    tool: &str,
    id: String,
) -> Result<NativeContext, String> {
    check_path(&root)?;
    let mut environment = BTreeMap::new();
    let mut cli_args = vec![];
    let config_root;
    let auth_files;
    let history_roots;
    match tool {
        "codex" => {
            config_root = root.clone();
            environment.insert("CODEX_HOME".into(), root.to_string_lossy().into_owned());
            cli_args = vec!["-c".into(), "cli_auth_credentials_store=\"file\"".into()];
            auth_files = vec![root.join("auth.json")];
            history_roots = vec![root.join("sessions"), root.join("archived_sessions")];
        }
        "claude_code" => {
            config_root = root.clone();
            environment.insert(
                "CLAUDE_CONFIG_DIR".into(),
                root.to_string_lossy().into_owned(),
            );
            auth_files = vec![root.join(".credentials.json")];
            history_roots = vec![root.join("projects")];
        }
        "pi" => {
            config_root = root.clone();
            environment.insert(
                "PI_CODING_AGENT_DIR".into(),
                root.to_string_lossy().into_owned(),
            );
            auth_files = vec![root.join("auth.json")];
            history_roots = vec![root.join("sessions")];
        }
        "open_code" => {
            for (key, directory) in [
                ("XDG_CONFIG_HOME", "config"),
                ("XDG_DATA_HOME", "data"),
                ("XDG_STATE_HOME", "state"),
                ("XDG_CACHE_HOME", "cache"),
            ] {
                private_directory(&root.join(directory))?;
                environment.insert(
                    key.into(),
                    root.join(directory).to_string_lossy().into_owned(),
                );
            }
            config_root = root.join("config/opencode");
            environment.insert(
                "OPENCODE_CONFIG_DIR".into(),
                config_root.to_string_lossy().into_owned(),
            );
            auth_files = vec![root.join("data/opencode/auth.json")];
            history_roots = vec![root.join("data/opencode")];
        }
        _ => return Err("此 CLI 尚未提供可隔离的认证上下文".into()),
    }
    let remove_environment = [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_HOME",
        "CODEX_AUTH_JSON",
        "CODEX_CI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
        "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "PI_CODING_AGENT_DIR",
        "OPENCODE_AUTH_CONTENT",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_TEST_HOME",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    Ok(NativeContext {
        id,
        tool_id: tool.into(),
        root,
        resource_root: config_root.clone(),
        config_root,
        auth_files,
        history_roots,
        environment,
        remove_environment,
        cli_args,
    })
}

impl NativeContext {
    pub fn apply_to_command(&self, command: &mut Command) -> Result<(), String> {
        check_path(&self.root)?;
        for key in &self.remove_environment {
            command.env_remove(key);
        }
        command.envs(&self.environment).current_dir(&self.root);
        Ok(())
    }
}
