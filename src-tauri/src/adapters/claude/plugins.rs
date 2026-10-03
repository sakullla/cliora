use super::Claude;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{native::adapter::Scope, resources::plugins::PluginTarget};
use serde_json::Value;

impl PluginAdapter for Claude {
    fn capability(&self) -> PluginCapability {
        let (version, sources, actions, project, detail) = (
            "2.1.287",
            "已配置市场中的 plugin@marketplace 或 package@npm",
            vec!["install", "update", "enable", "disable", "uninstall"],
            true,
            "原生命令管理插件；命令型市场需要额外原生确认，Cliora 不自动同意。重启会话后加载。",
        );
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
        project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = vec![
            "plugin",
            action,
            source,
            "--scope",
            if project { "project" } else { "user" },
            "--json",
        ];
        Ok(args.into_iter().map(str::to_owned).collect())
    }
    fn includes_row(&self, row: &Value, target: &PluginTarget) -> bool {
        let scope = row
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if target.scope == Scope::Global {
            scope == "user" || scope == "managed"
        } else {
            (scope == "project" || scope == "local")
                && row
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .zip(target.project_path.as_deref())
                    .is_some_and(|(actual, expected)| {
                        let normalize = |p: &str| {
                            let p = p.replace('\\', "/").trim_end_matches('/').to_owned();
                            if cfg!(windows) {
                                p.to_lowercase()
                            } else {
                                p
                            }
                        };
                        normalize(actual) == normalize(expected)
                    })
        }
    }
}
