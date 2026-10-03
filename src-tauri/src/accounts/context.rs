use super::NativeContext;
use std::{fs, path::Path, process::Command};

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
    context_at_registered(&crate::adapters::Registry::builtins(), root, tool, id)
}
pub fn context_at_registered(
    registry: &crate::adapters::Registry,
    root: std::path::PathBuf,
    tool: &str,
    id: String,
) -> Result<NativeContext, String> {
    if !root.is_absolute() {
        return Err("账号根目录必须为绝对路径".into());
    }
    check_path(&root)?;
    let adapter = crate::adapters::accounts::get_registered(registry, tool)?;
    let mut context = adapter.context(root.clone(), id)?;
    // Clear conflicting authentication sources from all registered families,
    // including a previous CLI's environment. Definitions stay in adapters.
    let mut remove_environment = std::mem::take(&mut context.remove_environment)
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    for cli in registry.iter().filter_map(|cli| cli.accounts()) {
        remove_environment.extend(cli.remove_environment().iter().map(|key| (*key).to_owned()));
    }
    for path in adapter.private_directories(&context) {
        if !path.is_absolute()
            || !path.starts_with(&root)
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("适配器私有目录不属于账号根目录".into());
        }
        private_directory(&path)?;
    }
    context.remove_environment = remove_environment.into_iter().collect();
    Ok(context)
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
