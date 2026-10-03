//! Read-only plugin listing for Kimi Code. Managed plugin copies live under
//! `plugins/managed/<id>/` with a `.kimi-plugin/plugin.json` (or
//! `kimi.plugin.json`) manifest, and `plugins/installed.json` tracks install
//! metadata including the enabled flag (both shapes verified on 0.31.1).
//! Install/enable/disable/remove only exist inside the session UI (`/plugins`),
//! so the capability declares no actions and every entry stays read-only.

use super::KimiCode;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::resources::plugins::{PluginEntry, PluginTarget};
use std::path::Path;

impl PluginAdapter for KimiCode {
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "0.31.1",
            sources: "会话内 /plugins 安装：本地路径、zip/GitHub URL 或官方市场",
            // The only native verb this adapter supports is the read-only
            // listing below; install/enable/disable/uninstall exist solely in
            // the session UI, so the shared surface shows no operation button.
            actions: vec!["list"],
            project: false,
            detail: "只读列举已托管插件（plugins/managed 与 installed.json）；安装、启停与卸载请在 Kimi Code 会话内使用 /plugins。",
        }
    }
    fn command_args(
        &self,
        _action: &str,
        _source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        Err("Kimi Code 插件管理动词在会话内 /plugins；没有外部命令".into())
    }
    /// Kimi Code keeps no plugin declarations in config.toml. Declaring the
    /// field only routes the shared listing through the native config
    /// transaction; the `plugins` table stays absent, so listing comes solely
    /// from discovery and no configuration action is offered (actions empty).
    fn config_field(&self) -> Option<&'static str> {
        Some("plugins")
    }
    fn discover(
        &self,
        _home: &Path,
        target: &PluginTarget,
        path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        if target.scope != crate::native::adapter::Scope::Global {
            return Ok(vec![]);
        }
        let plugins = path
            .parent()
            .ok_or("配置缺少父目录")?
            .join("plugins");
        let installed = read_installed(&plugins.join("installed.json"))?;
        let managed = plugins.join("managed");
        let mut result = Vec::new();
        if !managed.is_dir() {
            return Ok(result);
        }
        let mut directories: Vec<_> = std::fs::read_dir(&managed)
            .map_err(|_| "无法读取托管插件目录")?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.is_dir())
            .collect();
        directories.sort();
        for root in directories {
            let Some(id) = root
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(manifest_path) = ["kimi.plugin.json", ".kimi-plugin/plugin.json"]
                .iter()
                .map(|name| root.join(name))
                .find(|path| path.is_file())
            else {
                continue;
            };
            let Ok(manifest) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&manifest) else {
                continue;
            };
            let text = |field: &str| {
                manifest
                    .get(field)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            };
            let record = installed.as_ref().and_then(|value| {
                value
                    .get("plugins")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|rows| {
                        rows.iter()
                            .find(|row| row.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()))
                    })
            });
            let mut entry = PluginEntry {
                name: text("name").unwrap_or_else(|| id.clone()),
                id: id.clone(),
                source: record
                    .and_then(|row| {
                        row.get("originalSource")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| "Kimi Code 会话内安装".into()),
                version: text("version"),
                scope: "managed".into(),
                enabled: record
                    .and_then(|row| row.get("enabled"))
                    .and_then(serde_json::Value::as_bool),
                state: "installed_load_unknown".into(),
                policy: "Kimi Code 在会话内 /plugins 管理安装与启停".into(),
                read_only: true,
                root: Some(root.display().to_string()),
                resources: vec![],
            };
            crate::adapters::plugins::owned_resources(&mut entry);
            result.push(entry);
        }
        Ok(result)
    }
}

fn read_installed(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|_| "无法读取插件安装记录")?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| "插件安装记录格式无法识别".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::adapter::Scope;

    #[test]
    fn managed_manifests_are_listed_read_only_with_install_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".kimi-code");
        std::fs::create_dir_all(root.join("plugins/managed/demo-plugin/skills")).unwrap();
        std::fs::create_dir_all(root.join("plugins/managed/ignored-no-manifest")).unwrap();
        std::fs::write(
            root.join("plugins/managed/demo-plugin/kimi.plugin.json"),
            r#"{"name":"demo-plugin","version":"1.4.0","skills":"./skills/"}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("plugins/installed.json"),
            r#"{"version":1,"plugins":[{"id":"demo-plugin","enabled":true,"source":"local-path","root":"relocated","installedAt":"2026-08-02T05:41:22.281Z"}]}"#,
        )
        .unwrap();
        let config = root.join("config.toml");
        std::fs::write(&config, "default_model = \"kimi-code/k3\"\n").unwrap();
        let target = PluginTarget {
            tool_id: "kimi_code".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let entries = KimiCode.discover(temp.path(), &target, &config).unwrap();
        assert_eq!(entries.len(), 1, "无 manifest 的目录不列入");
        let entry = &entries[0];
        assert_eq!(entry.id, "demo-plugin");
        assert_eq!(entry.version.as_deref(), Some("1.4.0"));
        assert_eq!(entry.enabled, Some(true));
        assert!(entry.read_only, "托管插件必须只读");
        assert!(entry
            .resources
            .iter()
            .any(|resource| resource.kind == "skills"));
        assert_eq!(KimiCode.capability().actions, vec!["list"]);
        assert!(KimiCode
            .command_args("install", "demo-plugin", false)
            .is_err());
    }
}
