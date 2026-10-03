use super::OpenCode;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::{
    native::adapter::Scope,
    resources::plugins::{self, PluginEntry, PluginTarget},
};
use plugins::project;
use std::{fs, path::Path};

impl PluginAdapter for OpenCode {
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("1.18.34", "npm 包@版本或 file:///绝对路径", vec!["install", "enable", "disable", "uninstall"], true, "维护 plugin 数组声明；依赖由 OpenCode 启动安装，安装及加载尚未验证。更新请卸载声明后添加新版本。自动发现的 plugins 目录项只读。");
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
        let dir = if target.scope == Scope::Project {
            project(target)?
                .ok_or("请选择项目")?
                .join(".opencode/plugins")
        } else {
            path.parent().ok_or("配置缺少父目录")?.join("plugins")
        };
        if dir.is_dir() {
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
