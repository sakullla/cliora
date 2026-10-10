use crate::native::adapter::Scope;
use std::path::{Path, PathBuf};

/// IDE User/settings.json is separate from CLI cli-config.json. Only inherited
/// environment overrides verified in Cursor's userDataPath.js are honored.
pub(super) fn user_data(
    home: &Path,
    env: &impl Fn(&str) -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    let absolute = |key: &str| -> Result<Option<PathBuf>, String> {
        env(key)
            .filter(|p| !p.as_os_str().is_empty())
            .map(|path| {
                if path.is_absolute() {
                    Ok(path)
                } else {
                    Err(format!("Cursor {key} 必须是绝对路径，已停止写入"))
                }
            })
            .transpose()
    };
    if let Some(path) = absolute("VSCODE_PORTABLE")? {
        return Ok(path.join("user-data"));
    }
    if let Some(path) = absolute("VSCODE_APPDATA")? {
        return Ok(path.join("Cursor"));
    }
    if cfg!(windows) {
        Ok(absolute("APPDATA")?
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor"))
    } else if cfg!(target_os = "macos") {
        Ok(home.join("Library/Application Support/Cursor"))
    } else {
        Ok(absolute("XDG_CONFIG_HOME")?
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor"))
    }
}

pub(super) fn settings(
    home: &Path,
    scope: Scope,
    project: Option<&Path>,
) -> Result<PathBuf, String> {
    if scope == Scope::Project {
        return project
            .map(|p| p.join(".vscode/settings.json"))
            .ok_or("请选择项目目录".into());
    }
    user_data(home, &|key| {
        (dirs::home_dir().as_deref() == Some(home))
            .then(|| std::env::var_os(key).map(PathBuf::from))
            .flatten()
    })
    .map(|root| root.join("User/settings.json"))
}
