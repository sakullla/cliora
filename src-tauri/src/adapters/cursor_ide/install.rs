//! Cursor IDE identity comes from the installed desktop product, never `agent`.
use crate::native::adapter::Installation;
use std::path::{Path, PathBuf};

pub(super) fn marker(executable: &Path) -> Result<String, String> {
    if !executable.is_file()
        || !executable
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("Cursor.exe"))
    {
        return Err("不是 Cursor IDE 桌面程序".into());
    }
    let root = executable
        .parent()
        .ok_or("Cursor 安装目录无效")?
        .join("resources/app");
    let read = |name: &str| -> Result<serde_json::Value, String> {
        let file = root.join(name);
        if std::fs::metadata(&file)
            .map_err(|_| "Cursor IDE 安装标记不可读")?
            .len()
            > 1024 * 1024
        {
            return Err("Cursor IDE 安装标记过大".into());
        }
        serde_json::from_slice(&std::fs::read(file).map_err(|_| "Cursor IDE 安装标记不可读")?)
            .map_err(|_| "Cursor IDE 安装标记无效".into())
    };
    let product = read("product.json")?;
    let package = read("package.json")?;
    if product["applicationName"] != "cursor"
        || product["dataFolderName"] != ".cursor"
        || product["nameShort"] != "Cursor"
        || package["name"] != "Cursor"
    {
        return Err("安装标记不属于 Cursor IDE".into());
    }
    let version = package["version"]
        .as_str()
        .filter(|value| semver::Version::parse(value).is_ok())
        .ok_or("Cursor IDE 版本标记无效")?;
    if product["version"].as_str() != Some(version) {
        return Err("Cursor IDE 安装标记版本不一致，请完成更新后重新检测".into());
    }
    Ok(version.into())
}

pub(super) fn installations(home: &Path) -> Vec<Installation> {
    // Windows is the installed and inspected platform. Other platforms stay
    // undiscovered rather than guessing another product's executable or root.
    if !cfg!(windows) {
        return Vec::new();
    }
    let local = if dirs::home_dir().as_deref() == Some(home) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        None
    }
    .unwrap_or_else(|| home.join("AppData/Local"));
    let mut paths = vec![local.join("Programs/cursor/Cursor.exe")];
    if dirs::home_dir().as_deref() == Some(home) {
        for key in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(path) = std::env::var_os(key) {
                paths.push(PathBuf::from(path).join("cursor/Cursor.exe"));
            }
        }
        if let Some(record) = crate::windows_registry::application(|name| {
            matches!(name.trim(), "Cursor" | "Cursor (User)")
        }) {
            if let Some(command) = record.uninstall {
                if let Some(path) = command
                    .split('"')
                    .nth(1)
                    .map(PathBuf::from)
                    .and_then(|p| p.parent().map(Path::to_path_buf))
                {
                    paths.push(path.join("Cursor.exe"));
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| path.is_file())
        .filter(|path| seen.insert(path.canonicalize().unwrap_or_else(|_| path.clone())))
        .map(|path| {
            let result = marker(&path);
            Installation {
                path: path.display().to_string(),
                version: result.as_ref().ok().cloned(),
                source: "native",
                status: if result.is_ok() {
                    "available"
                } else {
                    "probe_failed"
                },
                detail: result.err(),
            }
        })
        .collect()
}
