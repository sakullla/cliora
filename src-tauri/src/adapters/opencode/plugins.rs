use super::OpenCode;
use crate::adapters::plugins::{declaration_changes, PluginAdapter, PluginCapability};
use crate::{
    native::{adapter::Scope, transaction::FieldChange},
    resources::plugins::{self, PluginEntry, PluginRequest, PluginTarget},
};
use plugins::project;
use serde_json::Value;
use std::{fs, path::Path};

/// Install line from a probed version. A missing or non-numeric major is
/// unknown here; the service refuses declaration writes in that case.
fn major(version: Option<&str>) -> Option<u64> {
    version?
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

impl PluginAdapter for OpenCode {
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("1.18.34 / 2.0.29", "npm 包@版本、file:///绝对路径或 {package, options} 对象", vec!["install", "enable", "disable", "uninstall"], true, "维护 plugin（1.x）与 plugins（2.x）声明数组；对象条目的 options 在启停后保留。依赖由 OpenCode 启动安装，安装及加载尚未验证；V1 实现插件在 2.x 原生不加载，不承诺可用。更新请卸载声明后添加新版本。自动发现的 plugin 与 plugins 目录项只读。");
        PluginCapability {
            version,
            sources,
            actions,
            project,
            detail,
        }
    }
    fn config_requires_version(&self) -> bool {
        true
    }
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        // Two verified install lines; the shared plugin gate accepts either family.
        crate::adapters::version::VersionPolicy::same_majors(&["1.18.34", "2.0.29"])
    }
    fn command_args(
        &self,
        _action: &str,
        _source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        Err("此操作使用配置事务".into())
    }
    fn package_metadata(&self, root: Option<&Path>) -> crate::adapters::plugins::PluginPackage {
        crate::adapters::plugins::npm_metadata(root)
    }
    fn config_field(&self) -> Option<&'static str> {
        Some("plugin")
    }
    fn config_field_for_version(&self, version: Option<&str>) -> Option<&'static str> {
        match major(version) {
            Some(2) => Some("plugins"),
            Some(1) => Some("plugin"),
            _ => None,
        }
    }
    fn config_field_for_document(
        &self,
        document: &Value,
        version: Option<&str>,
    ) -> Option<&'static str> {
        match self.config_field_for_version(version) {
            Some(field) => Some(field),
            // Unverified or future lines stay read-only: present whichever
            // native shape the document already carries instead of guessing.
            None => Some(if document.get("plugins").is_some() {
                "plugins"
            } else {
                "plugin"
            }),
        }
    }
    fn config_changes_for_version(
        &self,
        parsed: &Value,
        saved: &mut serde_json::Map<String, Value>,
        request: &PluginRequest,
        version: Option<&str>,
    ) -> Result<Vec<FieldChange>, String> {
        let field = self
            .config_field_for_version(version)
            .ok_or("OpenCode 安装版本尚未验证，插件声明形态不可写入")?;
        declaration_changes(self, field, parsed, saved, request)
    }
    fn config_only(&self, _action: &str, _entry: Option<&PluginEntry>) -> bool {
        true
    }
    fn discover(
        &self,
        _home: &Path,
        target: &PluginTarget,
        path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        let mut result = vec![];
        let base = if target.scope == Scope::Project {
            project(target)?.ok_or("请选择项目")?.join(".opencode")
        } else {
            path.parent().ok_or("配置缺少父目录")?.to_path_buf()
        };
        // Both native auto-discovery directories are read-only inventory.
        for directory in ["plugin", "plugins"] {
            let dir = base.join(directory);
            if !dir.is_dir() {
                continue;
            }
            for file in fs::read_dir(dir).map_err(|_| "无法读取自动发现插件目录")? {
                let file = file.map_err(|_| "读取插件失败")?;
                let path = file.path();
                if path.extension().is_some_and(|e| e == "ts" || e == "js") {
                    let source = path.display().to_string();
                    result.push(PluginEntry {
                        id: format!("auto:{source}"),
                        name: file.file_name().to_string_lossy().into(),
                        source: source.clone(),
                        version: None,
                        scope: "auto".into(),
                        enabled: Some(true),
                        state: "discovered_load_unknown".into(),
                        policy: "自动扫描文件，需在原生目录管理".into(),
                        read_only: true,
                        root: Some(source),
                        resources: vec![],
                    });
                }
            }
        }
        Ok(result)
    }
}
