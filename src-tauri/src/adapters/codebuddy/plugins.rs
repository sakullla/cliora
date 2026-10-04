use super::CodeBuddy;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{
    native::{
        adapter::Scope,
        transaction::FieldChange,
    },
    resources::plugins::{PluginEntry, PluginRequest, PluginTarget},
};
use serde_json::{json, Value};
use std::path::Path;

impl PluginAdapter for CodeBuddy {
    fn discovery_only(&self) -> bool { true }
    fn discover(&self, home: &Path, target: &PluginTarget, _path: &Path) -> Result<Vec<PluginEntry>, String> {
        let root = super::config_root(home);
        let text = crate::native::transaction::read_native(&root.join("plugins/installed_plugins.json"))?;
        if text.trim().is_empty() { return Ok(Vec::new()); }
        let ledger: Value = serde_json::from_str(&text).map_err(|_| "CodeBuddy 插件索引不是有效 JSON")?;
        if ledger.get("version").and_then(Value::as_u64) != Some(2) {
            return Err("CodeBuddy 插件索引版本无法识别，请更新适配器".into());
        }
        let records = ledger.get("plugins").and_then(Value::as_object).ok_or("CodeBuddy 插件索引缺少 plugins")?;
        let mut enabled = serde_json::Map::new();
        let mut configs = vec![root.join("settings.json")];
        if target.scope == Scope::Project {
            let project = target.project_path.as_deref().ok_or("请选择项目")?;
            configs.extend([Path::new(project).join(".codebuddy/settings.json"), Path::new(project).join(".codebuddy/settings.local.json")]);
        }
        for path in configs {
            let text = crate::native::transaction::read_native(&path)?;
            let parsed = crate::native::format::parse(crate::native::format::FileKind::Json, &text)?;
            if let Some(values) = parsed.get("enabledPlugins").and_then(Value::as_object) { enabled.extend(values.clone()); }
        }
        let mut rows = Vec::new();
        for (id, installations) in records {
            for record in installations.as_array().ok_or("CodeBuddy 插件安装记录不是数组")? {
                let mut row = record.as_object().cloned().ok_or("CodeBuddy 插件安装记录无效")?;
                let scope = row.get("scope").and_then(Value::as_str).unwrap_or("unknown");
                if scope != "user" && (target.scope != Scope::Project || row.get("projectPath").and_then(Value::as_str) != target.project_path.as_deref()) { continue; }
                row.insert("id".into(), json!(id));
                row.insert("enabled".into(), enabled.get(id).cloned().unwrap_or(json!(true)));
                rows.push(Value::Object(row));
            }
        }
        self.parse_list(&Value::Array(rows), target)
    }
    fn capability(&self) -> PluginCapability {
        // Install/uninstall verbs live in the native `/plugin` manager (TUI);
        // they are not delivered here. Discovery reads the versioned native ledger
        // and enabledPlugins settings without launching the CLI.
        PluginCapability {
            version: "2.161.1",
            sources: "已安装插件 ID（plugin@marketplace）",
            actions: vec!["enable", "disable"],
            project: true,
            detail: "列举读取本机插件索引与启停配置；启停写入项目 .codebuddy/settings.json 的 enabledPlugins 开关。安装与卸载请在原生 /plugin 界面执行；重启会话后生效。",
        }
    }
    fn command_args(
        &self,
        _action: &str,
        _source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        Err("此操作使用配置事务".into())
    }
    fn list_rows<'a>(&self, value: &'a Value) -> Option<&'a Vec<Value>> {
        value.as_array()
    }
    fn config_only(&self, action: &str, _entry: Option<&PluginEntry>) -> bool {
        matches!(action, "enable" | "disable")
    }
    fn validate_operation(
        &self,
        request: &PluginRequest,
        _entry: Option<&PluginEntry>,
    ) -> Result<(), String> {
        // Verified on 2.161.1: `codebuddy plugin disable <id> -s project` (cwd
        // = project root) writes enabledPlugins in `<project>/.codebuddy/settings.json`.
        // Only that project-level declaration plane is delivered; user-level
        // toggles stay in the native /plugin manager.
        if request.target.scope != Scope::Project {
            return Err(
                "CodeBuddy 插件启停仅交付项目级（.codebuddy/settings.json 的 enabledPlugins）；用户级请在原生 /plugin 界面管理"
                    .into(),
            );
        }
        Ok(())
    }
    fn config_changes(
        &self,
        _parsed: &Value,
        _saved: &mut serde_json::Map<String, Value>,
        request: &PluginRequest,
    ) -> Result<Vec<FieldChange>, String> {
        if !matches!(request.action.as_str(), "enable" | "disable") {
            return Err("不支持的配置操作".into());
        }
        // The native representation is a map entry (`"plugin@marketplace":
        // true|false`), so both directions are plain field writes and the
        // opposite action restores the previous value without recovery records.
        Ok(vec![FieldChange {
            path: vec!["enabledPlugins".into(), request.source.clone()],
            value: Some(json!(request.action == "enable")),
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::plugins::PluginTarget;
    use serde_json::Value;

    fn target(scope: Scope) -> PluginTarget {
        PluginTarget {
            tool_id: "codebuddy".into(),
            scope,
            project_path: Some(r"C:\work\demo".into()),
            context_id: None,
        }
    }

    fn fixture_list() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/fixtures/plugins/codebuddy-2.161.1-list.json"
        ))
        .unwrap()
    }

    #[test]
    fn ledger_discovery_reads_native_enablement_without_running_a_cli() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codebuddy");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(root.join("plugins/installed_plugins.json"), r#"{"version":2,"plugins":{"fixture@market":[{"scope":"user","installPath":"fixture-plugin","version":"1.0.0"}]}}"#).unwrap();
        std::fs::write(root.join("settings.json"), r#"{"enabledPlugins":{"fixture@market":false}}"#).unwrap();
        let global = target(Scope::Global);
        let entries = CodeBuddy.discover(home.path(), &global, &root.join("settings.json")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].enabled, Some(false));
        std::fs::write(root.join("plugins/installed_plugins.json"), "{invalid").unwrap();
        assert!(CodeBuddy.discover(home.path(), &global, &root.join("settings.json")).is_err());
    }

    #[test]
    fn native_list_fixture_parses_installed_entries() {
        let entries = CodeBuddy.parse_list(&fixture_list(), &target(Scope::Global)).unwrap();
        assert_eq!(entries.len(), 3);
        let pdf = entries.iter().find(|e| e.id == "pdf@codebuddy-plugins-official").unwrap();
        assert_eq!(pdf.version.as_deref(), Some("1.0.0"));
        assert_eq!(pdf.enabled, Some(true));
        assert!(pdf.root.as_deref().unwrap().contains("plugins"));
        assert!(!pdf.read_only);
        let pptx = entries.iter().find(|e| e.id == "pptx@codebuddy-plugins-official").unwrap();
        assert_eq!(pptx.enabled, Some(false));
    }

    #[test]
    fn enable_disable_write_the_project_enabled_plugins_switch() {
        let cap = CodeBuddy.capability();
        assert_eq!(cap.actions, vec!["enable", "disable"]);
        assert!(cap.project);
        assert!(!cap.actions.contains(&"install"));
        let request = |action: &str| PluginRequest {
            target: target(Scope::Project),
            action: action.into(),
            source: "pdf@codebuddy-plugins-official".into(),
            baseline: String::new(),
            trusted: false,
        };
        let mut saved = serde_json::Map::new();
        let disable = CodeBuddy
            .config_changes(&json!({}), &mut saved, &request("disable"))
            .unwrap();
        assert_eq!(disable.len(), 1);
        assert_eq!(
            disable[0].path,
            vec!["enabledPlugins".to_string(), "pdf@codebuddy-plugins-official".to_string()]
        );
        assert_eq!(disable[0].value, Some(json!(false)));
        let enable = CodeBuddy
            .config_changes(&json!({}), &mut saved, &request("enable"))
            .unwrap();
        assert_eq!(enable[0].value, Some(json!(true)));
        assert!(saved.is_empty());
        assert!(CodeBuddy.config_only("disable", None));
        assert!(CodeBuddy.config_only("enable", None));
        assert!(!CodeBuddy.config_only("install", None));
    }

    #[test]
    fn user_scope_toggle_is_rejected_with_native_guidance() {
        let request = PluginRequest {
            target: target(Scope::Global),
            action: "disable".into(),
            source: "pdf@codebuddy-plugins-official".into(),
            baseline: String::new(),
            trusted: false,
        };
        assert!(CodeBuddy.validate_operation(&request, None).is_err());
        let project_request = PluginRequest { target: target(Scope::Project), ..request };
        CodeBuddy.validate_operation(&project_request, None).unwrap();
    }
}
