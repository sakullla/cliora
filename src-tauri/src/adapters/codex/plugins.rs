use super::Codex;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{
    native::transaction::FieldChange,
    resources::plugins::{PluginEntry, PluginRequest, PluginTarget},
};
use serde_json::{json, Value};
use std::path::Path;

impl PluginAdapter for Codex {
    fn preview(&self, home: &Path, _target: &PluginTarget) -> Result<Option<Vec<PluginEntry>>, String> {
        use crate::adapters::CliAdapter;
        use crate::native::{adapter::Scope, format, transaction};
        // Resolve through the adapter so CODEX_HOME and managed account roots
        // use exactly the same location as the authoritative native command.
        let files = self.native_files(Scope::Global, home, None, false);
        let Some(file) = files.iter().find(|file| file.role == "settings") else { return Ok(None) };
        let path = Path::new(&file.path);
        let document = format::parse(format::FileKind::Toml, &transaction::read_native(path)?)?;
        let mut ids = std::collections::BTreeSet::new();
        if let Some(plugins) = document.get("plugins").and_then(Value::as_object) {
            ids.extend(plugins.keys().cloned());
        }
        // Cache membership is only a preview, never proof that a package is
        // installed or enabled. Do not read package trees or follow links.
        let cache = path.parent().ok_or("配置目录缺失")?.join("plugins/cache");
        let directories = |root: &Path| -> Vec<std::fs::DirEntry> {
            std::fs::read_dir(root).into_iter().flatten().filter_map(Result::ok)
                .take(512).filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir() && !kind.is_symlink()))
                .filter(|entry| {
                    #[cfg(windows)] {
                        use std::os::windows::fs::MetadataExt;
                        entry.metadata().is_ok_and(|meta| meta.file_attributes() & 0x400 == 0)
                    }
                    #[cfg(not(windows))] { let _ = entry; true }
                }).collect()
        };
        for market in directories(&cache) {
            for package in directories(&market.path()) {
                ids.insert(format!("{}@{}", package.file_name().to_string_lossy(), market.file_name().to_string_lossy()));
            }
        }
        Ok(Some(ids.into_iter().map(|id| PluginEntry {
            name: id.split('@').next().unwrap_or(&id).to_owned(), source: id.clone(), id,
            version: None, scope: "user".into(), enabled: None, state: "inventory_pending".into(),
            policy: "等待原生插件列表核对".into(), read_only: true, root: None, resources: vec![],
        }).collect()))
    }
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("0.160.0", "已配置市场中的 plugin@marketplace", vec!["install", "update", "enable", "disable", "uninstall"], false, "原生安装/移除及已核验 plugins.<id>.enabled 配置。Codex 没有单独的 plugin update 子命令，更新会再次执行 plugin add，从已配置市场安装当前版本。重启会话后加载。");
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
                "install" | "update" => "add",
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

#[cfg(test)]
mod tests {
    use super::super::Codex;
    use crate::adapters::plugins::PluginAdapter;

    #[test]
    fn preview_reads_declarations_and_cache_without_running_cli() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".codex");
        std::fs::create_dir_all(root.join("plugins/cache/market/cached/1.0.0")).unwrap();
        std::fs::write(root.join("config.toml"), "[plugins.\"declared@market\"]\nenabled = true\n").unwrap();
        let context = crate::accounts::NativeContext {
            id: "fixture".into(), tool_id: "codex".into(), root: root.clone(), config_root: root.clone(),
            auth_files: vec![], history_roots: vec![], resource_root: root, environment: Default::default(),
            remove_environment: vec![], cli_args: vec![],
        };
        let _context = crate::accounts::selection::enter(Some(context));
        let target = crate::resources::plugins::PluginTarget { tool_id: "codex".into(), scope: crate::native::adapter::Scope::Global, project_path: None, context_id: Some("fixture".into()) };
        let entries = Codex.preview(temp.path(), &target).unwrap().unwrap();
        assert_eq!(entries.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), ["cached@market", "declared@market"]);
        assert!(entries.iter().all(|entry| entry.read_only && entry.enabled.is_none()));
    }

    #[test]
    fn update_reinstalls_from_the_configured_marketplace() {
        assert!(Codex.capability().actions.contains(&"update"));
        assert_eq!(
            Codex.command_args("update", "demo@market", false).unwrap(),
            ["plugin", "add", "demo@market", "--json"]
        );
    }
}
