use super::Codex;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{
    native::transaction::FieldChange,
    resources::plugins::{PluginEntry, PluginRequest},
};
use serde_json::{json, Value};
use std::path::Path;

impl PluginAdapter for Codex {
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("0.160.0", "已配置市场中的 plugin@marketplace", vec!["install", "enable", "disable", "uninstall"], false, "原生安装/移除及已核验 plugins.<id>.enabled 配置；此版没有独立插件更新命令。重启会话后加载。");
        PluginCapability {
            version,
            sources,
            actions,
            project,
            detail,
        }
    }
    fn command_args(
        &self,
        action: &str,
        source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = vec![
            "plugin",
            match action {
                "install" => "add",
                "uninstall" => "remove",
                _ => return Err("此操作使用配置事务".into()),
            },
            source,
            "--json",
        ];
        Ok(args.into_iter().map(str::to_owned).collect())
    }
    fn list_rows<'a>(&self, value: &'a Value) -> Option<&'a Vec<Value>> {
        value.get("installed").and_then(Value::as_array)
    }
    fn policy_read_only(&self, install: &str, auth: Option<&str>) -> bool {
        !matches!(
            install,
            "AVAILABLE" | "REQUIRED" | "NOT_AVAILABLE" | "FORBIDDEN"
        ) || auth.is_some_and(|p| !matches!(p, "ON_INSTALL" | "NONE"))
    }
    fn config_only(&self, action: &str, _entry: Option<&PluginEntry>) -> bool {
        matches!(action, "enable" | "disable")
    }
    fn config_changes(
        &self,
        _parsed: &Value,
        _saved: &mut serde_json::Map<String, Value>,
        request: &PluginRequest,
    ) -> Result<Vec<FieldChange>, String> {
        Ok(vec![FieldChange {
            path: vec!["plugins".into(), request.source.clone(), "enabled".into()],
            value: Some(json!(request.action == "enable")),
        }])
    }
    fn decorate(&self, entry: &mut PluginEntry, path: &Path) -> Result<(), String> {
        if entry.root.is_none() {
            if let (Some((name, market)), Some(version)) =
                (entry.id.split_once('@'), entry.version.as_deref())
            {
                if [name, market, version]
                    .iter()
                    .all(|s| !s.is_empty() && !s.contains(['/', '\\']) && *s != "." && *s != "..")
                {
                    let root = path
                        .parent()
                        .ok_or("配置目录缺失")?
                        .join("plugins/cache")
                        .join(market)
                        .join(name)
                        .join(version);
                    if root.is_dir() {
                        entry.root = Some(root.display().to_string());
                    }
                }
            }
        }
        Ok(())
    }
}
