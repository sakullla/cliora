use super::Grok;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{
    native::{
        format::{self, FileKind},
        transaction::{self},
    },
    resources::plugins::PluginEntry,
};
use serde_json::Value;
use std::path::Path;

impl PluginAdapter for Grok {
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("1.0.46", "Git URL、user/repo@ref#subdir 或绝对本地路径", vec!["install", "update", "enable", "disable", "uninstall"], false, "原生命令管理用户插件；项目插件操作的作用域尚未核验。安装明确授权 --trust；重启会话后加载。");
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
        let args: Vec<&str> = {
            let mut args = vec!["plugin", action, source];
            if action == "install" {
                args.push("--trust");
            }
            args
        };
        Ok(args.into_iter().map(str::to_owned).collect())
    }
    fn decorate(&self, entry: &mut PluginEntry, path: &Path) -> Result<(), String> {
        let value = format::parse(FileKind::Toml, &transaction::read_native(&path)?)?;
        let has = |field: &str| {
            value
                .get("plugins")
                .and_then(|p| p.get(field))
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(&entry.id)))
        };
        entry.enabled = Some(has("enabled") && !has("disabled"));
        Ok(())
    }
}
