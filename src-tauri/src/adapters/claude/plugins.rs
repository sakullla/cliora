use super::Claude;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{native::adapter::Scope, resources::plugins::PluginTarget};
use serde_json::Value;
use std::path::{Path, PathBuf};
use crate::adapters::CliAdapter;

fn root(home: &Path) -> PathBuf {
    PathBuf::from(Claude.native_files(Scope::Global, home, None, false)[0].path.clone()).parent().unwrap().to_path_buf()
}

impl PluginAdapter for Claude {
    fn discovery_only(&self) -> bool { true }
    fn snapshot_files(&self, home: &Path, target: &PluginTarget) -> Vec<PathBuf> {
        let mut paths = vec![root(home).join("plugins/installed_plugins.json"), root(home).join("settings.json")];
        if target.scope == Scope::Project {
            if let Some(project) = target.project_path.as_deref() {
                paths.extend([Path::new(project).join(".claude/settings.json"), Path::new(project).join(".claude/settings.local.json")]);
            }
        }
        paths
    }
    fn discover(&self, home: &Path, target: &PluginTarget, _path: &Path) -> Result<Vec<crate::resources::plugins::PluginEntry>, String> {
        let paths = self.snapshot_files(home, target);
        let contents = crate::native::transaction::read_native(&paths[0])?;
        if contents.trim().is_empty() { return Ok(vec![]); }
        let ledger: Value = serde_json::from_str(&contents).map_err(|_| "Claude Code 插件索引不是有效 JSON")?;
        if ledger.get("version").and_then(Value::as_u64) != Some(2) { return Err("Claude Code 插件索引版本无法识别，请更新适配器".into()); }
        let records = ledger.get("plugins").and_then(Value::as_object).ok_or("Claude Code 插件索引缺少 plugins")?;
        let mut enabled = serde_json::Map::new();
        for path in &paths[1..] {
            let text = crate::native::transaction::read_native(path)?;
            let parsed = crate::native::format::parse(crate::native::format::FileKind::Json, &text)?;
            if let Some(value) = parsed.get("enabledPlugins") {
                enabled.extend(value.as_object().ok_or("Claude Code enabledPlugins 不是对象")?.clone());
            }
        }
        let mut rows = vec![];
        for (id, records) in records {
            for record in records.as_array().ok_or("Claude Code 插件安装记录不是数组")? {
                let mut row = record.as_object().cloned().ok_or("Claude Code 插件安装记录无效")?;
                row.insert("id".into(), serde_json::json!(id));
                let state = enabled.get(id).cloned().unwrap_or(Value::Bool(true));
                if !state.is_boolean() { return Err("Claude Code 插件启停值不是布尔值".into()); }
                row.insert("enabled".into(), state);
                rows.push(Value::Object(row));
            }
        }
        self.parse_list(&Value::Array(rows), target)
    }
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
