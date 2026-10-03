use super::Qoder;
use crate::adapters::plugins::PluginAdapter;
use crate::{native::adapter::Scope, resources::plugins::PluginTarget};
use serde_json::Value;

impl PluginAdapter for Qoder {
    fn capability(&self) -> crate::adapters::plugins::PluginCapability {
        crate::adapters::plugins::PluginCapability {
            version: "1.1.63",
            sources: "插件 ID name@marketplace、name@local 或本地路径（qoder plugins install）",
            actions: vec!["install", "update", "enable", "disable", "uninstall"],
            project: true,
            detail: "经 qoder plugins 子命令管理（install 支持 -s user|project）；启停状态存于 settings.json enabledPlugins。重启会话后加载。",
        }
    }
    fn command_args(
        &self,
        action: &str,
        source: &str,
        project: bool,
    ) -> Result<Vec<String>, String> {
        // Only install documents the -s scope flag; the remaining actions address
        // an installed plugin id directly.
        let mut args = vec!["plugins".to_owned(), action.to_owned(), source.to_owned()];
        if action == "install" {
            args.push("-s".into());
            args.push(if project { "project" } else { "user" }.into());
        }
        Ok(args)
    }
    fn list_command_args(&self) -> Vec<String> {
        // Qoder's native subcommand is plural; the shared snapshot consumes this
        // hook instead of the historical singular default.
        vec!["plugins".into(), "list".into(), "--json".into()]
    }
    fn includes_row(&self, row: &Value, target: &PluginTarget) -> bool {
        let scope = row
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if target.scope == Scope::Global {
            return scope == "user";
        }
        if scope != "project" && scope != "local" {
            return false;
        }
        // Rows that name another project's installation stay invisible for
        // mutation; rows without a path belong to the selected project.
        let Some(actual) = row.get("projectPath").and_then(Value::as_str) else {
            return true;
        };
        target
            .project_path
            .as_deref()
            .is_some_and(|expected| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LIST_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/plugins/qoder-1.1.63-list.json");

    fn target(scope: Scope, project_path: Option<&str>) -> PluginTarget {
        PluginTarget {
            tool_id: "qoder".into(),
            scope,
            project_path: project_path.map(str::to_owned),
            context_id: None,
        }
    }

    #[test]
    fn plugin_commands_drive_the_qoder_plugins_subcommand() {
        assert_eq!(
            Qoder
                .command_args("install", "fixture@market", false)
                .unwrap(),
            ["plugins", "install", "fixture@market", "-s", "user"]
        );
        assert_eq!(
            Qoder.command_args("install", "fixture@market", true).unwrap(),
            ["plugins", "install", "fixture@market", "-s", "project"]
        );
        assert_eq!(
            Qoder.command_args("disable", "fixture@market", false).unwrap(),
            ["plugins", "disable", "fixture@market"]
        );
        assert_eq!(
            Qoder
                .command_args("uninstall", "fixture@local", false)
                .unwrap(),
            ["plugins", "uninstall", "fixture@local"]
        );
        // The shared entry point still validates the action vocabulary and
        // refuses unlisted verbs or invalid sources.
        assert!(crate::adapters::plugins::command_args("qoder", "validate", "x", false).is_err());
        assert!(crate::adapters::plugins::command_args("qoder", "install", "--yes", false).is_err());
    }

    #[test]
    fn snapshot_list_command_uses_the_plural_qoder_subcommand() {
        assert_eq!(
            Qoder.list_command_args(),
            ["plugins", "list", "--json"]
        );
        // The trait default keeps the historical singular shape so existing
        // command-driven adapters stay unchanged; the shared snapshot consumes
        // the hook, never a CLI-specific branch.
        assert_eq!(
            crate::adapters::CLAUDE.list_command_args(),
            ["plugin", "list", "--json"]
        );
        assert_eq!(
            crate::adapters::GROK.list_command_args(),
            ["plugin", "list", "--json"]
        );
    }

    #[test]
    fn list_fixture_parses_and_scopes_entries() {
        let value: Value = serde_json::from_str(LIST_FIXTURE).unwrap();
        let entries = Qoder.parse_list(&value, &target(Scope::Global, None)).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "fixture-plugin@fixture-market");
        assert_eq!(entries[0].version.as_deref(), Some("1.0.0"));
        assert_eq!(entries[0].enabled, Some(true));
        assert!(!entries[0].read_only, "{}", entries[0].policy);
        let project = target(Scope::Project, Some("/fixture/proj"));
        assert!(Qoder
            .parse_list(
                &json!([{"id": "other@local", "scope": "local", "projectPath": "/fixture/other", "enabled": false}]),
                &project
            )
            .unwrap()
            .is_empty());
    }
}
