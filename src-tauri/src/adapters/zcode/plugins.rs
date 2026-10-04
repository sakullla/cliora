//! Read-only listing of ZCode's installed plugin records.
//!
//! The install ledger `~/.zcode/cli/plugins/installed_plugins.json` holds
//! `{plugins: [{id, installPath, marketplace}]}` (official
//! packages/services/src/plugins/installedPluginRoots.ts). Installation,
//! removal and enable/disable only exist as in-app protocol verbs handled by
//! the bundled agent process; there is no external command contract, so every
//! entry is read-only and the single capability action is the listing itself.

use super::ZCode;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::resources::plugins::{PluginEntry, PluginTarget};
use serde_json::Value;
use std::path::Path;

const INSTALLED_PLUGINS_FILE: &str = "installed_plugins.json";

impl PluginAdapter for ZCode {
    fn discovery_only(&self) -> bool { true }
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "3.14.4",
            sources: "ZCode 应用内插件市场（只读列举 installed_plugins.json）",
            // "list" keeps the tab visible without offering a native verb; the
            // shared UI renders no install/enable/uninstall button for it.
            actions: vec!["list"],
            project: false,
            detail: "只读列举已安装插件；安装/启停/卸载在 ZCode 应用内完成，无外部命令契约。",
        }
    }
    fn command_args(
        &self,
        _action: &str,
        _source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        Err("ZCode 插件管理动词在应用内提供，没有外部命令契约".into())
    }
    fn list_rows<'a>(&self, value: &'a Value) -> Option<&'a Vec<Value>> {
        value.get("plugins").and_then(Value::as_array)
    }
    fn policy_read_only(&self, _install: &str, _auth: Option<&str>) -> bool {
        true
    }
    fn discover(
        &self,
        home: &Path,
        _target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        let file = super::data_root(home)
            .join("cli")
            .join("plugins")
            .join(INSTALLED_PLUGINS_FILE);
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(_) => return Ok(Vec::new()),
        };
        let value: Value =
            serde_json::from_str(&text).map_err(|_| "installed_plugins.json 不是有效 JSON")?;
        let rows = self
            .list_rows(&value)
            .ok_or("installed_plugins.json 缺少 plugins 数组")?;
        rows.iter()
            .map(|row| {
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or("插件记录缺少 id")?;
                let install_path = row.get("installPath").and_then(Value::as_str);
                let marketplace = row
                    .get("marketplace")
                    .and_then(Value::as_str)
                    .unwrap_or("marketplace");
                let mut entry = PluginEntry {
                    id: id.to_owned(),
                    name: id.to_owned(),
                    source: id.to_owned(),
                    version: None,
                    scope: "user".into(),
                    enabled: None,
                    state: "installed_load_unknown".into(),
                    policy: format!("已安装记录 · 市场 {marketplace}；启停在 ZCode 应用内管理"),
                    read_only: true,
                    root: install_path.map(str::to_owned),
                    resources: vec![],
                };
                crate::adapters::plugins::owned_resources(&mut entry);
                Ok(entry)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::adapter::Scope;

    // Shape captured from the official reader (records appear once plugins are
    // installed from the in-app marketplace; sanitized paths).
    const INSTALLED: &str = r#"{
  "plugins": [
    {
      "id": "browser-use",
      "installPath": "C:\\Users\\user\\.zcode\\cli\\plugins\\data\\browser-use@zcode-plugins-official",
      "marketplace": "zcode-plugins-official"
    },
    {
      "id": "pdf",
      "installPath": "C:\\Users\\user\\.zcode\\cli\\plugins\\data\\pdf@zcode-plugins-official",
      "marketplace": "zcode-plugins-official"
    }
  ]
}"#;

    #[test]
    fn installed_plugins_json_lists_read_only_entries() {
        let value: Value = serde_json::from_str(INSTALLED).unwrap();
        let target = PluginTarget {
            tool_id: "zcode".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let entries = ZCode.parse_list(&value, &target).unwrap();
        assert_eq!(entries.len(), 2);
        let first = &entries[0];
        assert_eq!(first.id, "browser-use");
        assert_eq!(first.source, "browser-use");
        assert_eq!(first.state, "installed_load_unknown");
        assert!(first.read_only, "zcode 插件条目一律只读");
        assert!(first
            .root
            .as_deref()
            .is_some_and(|root| root.contains("browser-use")));
        // The listing verb exists, but no native management command does.
        assert!(ZCode.capability().actions == vec!["list"]);
        assert!(ZCode.command_args("install", "x", false).is_err());
    }

    #[test]
    fn discover_reads_the_ledger_and_reports_nothing_without_it() {
        let temp = tempfile::tempdir().unwrap();
        let target = PluginTarget {
            tool_id: "zcode".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        assert!(ZCode
            .discover(temp.path(), &target, temp.path())
            .unwrap()
            .is_empty());
        let ledger = temp.path().join(".zcode/cli/plugins/installed_plugins.json");
        std::fs::create_dir_all(ledger.parent().unwrap()).unwrap();
        std::fs::write(&ledger, INSTALLED).unwrap();
        let entries = ZCode.discover(temp.path(), &target, temp.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.read_only));
        std::fs::write(&ledger, "{\"plugins\": []}").unwrap();
        assert!(ZCode
            .discover(temp.path(), &target, temp.path())
            .unwrap()
            .is_empty());
        std::fs::write(&ledger, "not json").unwrap();
        assert!(ZCode.discover(temp.path(), &target, temp.path()).is_err());
    }
}
