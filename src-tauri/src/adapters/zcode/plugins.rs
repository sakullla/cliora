//! Native plugin management through the desktop-bundled ZCode CLI.
use super::ZCode;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::resources::plugins::{PluginEntry, PluginTarget};
use crate::native::{adapter::Scope, format::FileKind};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::path::{Path, PathBuf};

impl PluginAdapter for ZCode {
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "3.14.4", sources: "已配置市场中的 plugin@marketplace",
            actions: vec!["install", "update", "enable", "disable", "uninstall"], project: false,
            detail: "通过桌面安装包内的 ZCode CLI 管理插件；启停写入 cli/config.json，安装与更新需要 Node.js。现有会话需重启。",
        }
    }
    fn command_program(&self, executable: &Path) -> Result<(PathBuf, Vec<String>), String> {
        let script = executable.parent().ok_or("ZCode 安装目录缺失")?.join("resources/glm/zcode.cjs");
        if !script.is_file() { return Err("此 ZCode 安装包未包含已确认的插件 CLI，请更新 ZCode".into()); }
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = crate::process_environment::directories().into_iter().filter(|path| path.is_absolute())
            .map(|path| path.join(name)).find(|path| path.is_file()).ok_or("ZCode 插件管理需要 Node.js，请安装后重试")?;
        Ok((node, vec![script.display().to_string()]))
    }
    fn config_location(&self, home: &Path, target: &PluginTarget) -> Result<Option<(PathBuf, FileKind)>, String> {
        if target.scope != Scope::Global { return Err("ZCode 插件管理当前支持全局范围".into()); }
        Ok(Some((super::data_root(home).join("cli/config.json"), FileKind::Json)))
    }
    fn snapshot_files(&self, home: &Path, _target: &PluginTarget) -> Vec<PathBuf> {
        vec![super::data_root(home).join("cli/plugins/installed_plugins.json")]
    }
    fn command_args(&self, action: &str, source: &str, _project: bool) -> Result<Vec<String>, String> {
        if !self.capability().actions.contains(&action) { return Err("ZCode 插件操作未支持".into()); }
        let mut args = vec!["plugins".into(), action.into(), source.into(), "--scope".into(), "user".into(), "--json".into()];
        if action == "uninstall" { args.push("--force".into()); }
        Ok(args)
    }
    fn list_command_args(&self) -> Vec<String> { vec!["plugins".into(), "list".into(), "--json".into()] }
    fn list_rows<'a>(&self, value: &'a Value) -> Option<&'a Vec<Value>> { value.as_array() }
    fn parse_list(&self, value: &Value, _target: &PluginTarget) -> Result<Vec<PluginEntry>, String> {
        value.as_array().ok_or("ZCode 原生插件列表不是数组")?.iter().map(|row| {
            let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or("ZCode 插件缺少 id")?;
            let enabled = row.get("enabled").and_then(Value::as_bool).ok_or("ZCode 插件缺少启停状态")?;
            let mut entry = PluginEntry {
                id: id.into(), name: row.get("name").and_then(Value::as_str).unwrap_or(id).into(), source: id.into(),
                version: row.get("version").and_then(Value::as_str).map(str::to_owned), scope: "user".into(), enabled: Some(enabled),
                state: if enabled { "installed_load_unknown" } else { "disabled" }.into(), policy: "由 ZCode 原生插件命令校验来源与安装策略".into(),
                read_only: false, root: row.get("rootPath").and_then(Value::as_str).map(str::to_owned), resources: vec![],
            };
            crate::adapters::plugins::owned_resources(&mut entry); Ok(entry)
        }).collect()
    }
    fn config_only(&self, _action: &str, _entry: Option<&PluginEntry>) -> bool { false }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_list_and_commands_keep_identity_status_and_arguments() {
        let target = PluginTarget { tool_id: "zcode".into(), scope: Scope::Global, project_path: None, context_id: None };
        let rows = json!([{"id":"fixture@custom","name":"fixture","enabled":false,"version":"1.2.0","rootPath":"/fixture/plugin"}]);
        let entries = ZCode.parse_list(&rows, &target).unwrap();
        assert_eq!(entries[0].enabled, Some(false)); assert!(!entries[0].read_only);
        assert_eq!(entries[0].root.as_deref(), Some("/fixture/plugin"));
        assert_eq!(ZCode.list_command_args(), ["plugins", "list", "--json"]);
        assert_eq!(ZCode.command_args("enable", "fixture@custom", false).unwrap(), ["plugins", "enable", "fixture@custom", "--scope", "user", "--json"]);
        assert!(ZCode.parse_list(&json!([{"id":"broken"}]), &target).is_err());
        assert!(ZCode.command_args("invented", "x", false).is_err());
    }
}
