//! Kimi's Node process port does not execute Windows npm batch shims.
use serde_json::{Map, Value};

pub(super) fn normalize(map: &mut Map<String, Value>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let directories = map.get("env").and_then(Value::as_object)
            .and_then(|env| env.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH")))
            .and_then(|(_, value)| value.as_str())
            .map(|path| std::env::split_paths(path).collect())
            .unwrap_or_else(crate::process_environment::directories);
        normalize_windows(map, &directories)?;
    }
    #[cfg(not(windows))]
    let _ = map;
    Ok(())
}

#[cfg(any(windows, test))]
fn normalize_windows(map: &mut Map<String, Value>, directories: &[std::path::PathBuf]) -> Result<(), String> {
    use std::path::Path;
    let command = map.get("command").and_then(Value::as_str).unwrap_or("");
    let path = Path::new(command);
    let filename = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !["npx", "npx.cmd", "npx.ps1"].iter().any(|name| filename.eq_ignore_ascii_case(name)) {
        return Ok(());
    }
    let roots = if path.is_absolute() {
        vec![path.parent().ok_or("npx 路径无效")?.to_path_buf()]
    } else if command == filename {
        directories.iter().filter(|root| root.is_absolute()).cloned().collect()
    } else {
        return Err("Kimi Code 的 npx 请使用命令名或完整绝对路径".into());
    };
    let root = roots.iter().find(|root| root.join("npx.cmd").is_file() || root.join("npx.ps1").is_file())
        .ok_or("Kimi Code MCP 需要 Node.js/npm；未找到 npx 启动文件，请安装 Node.js 或检查 PATH")?;
    let script = root.join("node_modules/npm/bin/npx-cli.js");
    if !script.is_file() {
        return Err("无法识别此 npx 安装的 npm 入口；请使用完整 node.exe 与 npx-cli.js 路径配置 MCP".into());
    }
    let node = std::iter::once(root.join("node.exe"))
        .chain(directories.iter().filter(|root| root.is_absolute()).map(|root| root.join("node.exe")))
        .find(|path| path.is_file()).ok_or("Kimi Code MCP 未找到 node.exe，请安装 Node.js 或检查 PATH")?;
    let args = map.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut native_args = vec![Value::String(script.to_string_lossy().into_owned())];
    native_args.extend(args);
    map.insert("command".into(), Value::String(node.to_string_lossy().into_owned()));
    map.insert("args".into(), Value::Array(native_args));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_npx_uses_node_without_shell_and_preserves_arguments_and_env() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("node with spaces");
        let script = bin.join("node_modules/npm/bin/npx-cli.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        for path in [bin.join("node.exe"), bin.join("npx.cmd"), script.clone()] { std::fs::write(path, "fixture").unwrap(); }
        let original = serde_json::json!({"command":"npx","args":["-y","fixture-mcp","a & b","%NAME%","a\"b"],"env":{"API_KEY":"${KEY}"},"enabled":false});
        let mut map = original.as_object().unwrap().clone();
        normalize_windows(&mut map, &[std::path::PathBuf::from("."), bin.clone()]).unwrap();
        assert_eq!(map["command"], bin.join("node.exe").to_string_lossy().as_ref());
        assert_eq!(map["args"][0], script.to_string_lossy().as_ref());
        assert_eq!(&map["args"].as_array().unwrap()[1..], original["args"].as_array().unwrap());
        assert_eq!(map["env"], original["env"]);
        assert_eq!(map["enabled"], false);
        let normalized = map.clone();
        normalize_windows(&mut map, &[]).unwrap();
        assert_eq!(map, normalized);
        let mut missing = original.as_object().unwrap().clone();
        assert!(normalize_windows(&mut missing, &[]).is_err());
        assert_eq!(missing, *original.as_object().unwrap());
    }
}
