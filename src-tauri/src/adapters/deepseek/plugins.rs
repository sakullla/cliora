//! User-installed profile bundles; installation and compatibility remain DSH-owned.
use super::DeepSeek;
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::native::{adapter::Scope, format::FileKind, transaction::FieldChange};
use crate::resources::plugins::{PluginEntry, PluginRequest, PluginTarget};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn manifest_path(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("deepseek", || super::dsh_home(home)).join("profiles/desktop/package.json")
}
fn bundles(parsed: &Value) -> Result<Vec<Value>, String> {
    let value = parsed.pointer("/dsh/profile/bundles").ok_or("DSH profile 缺少 dsh.profile.bundles")?;
    let list = value.as_array().ok_or("DSH bundles 不是数组")?;
    if list.iter().any(|value| !value.is_string()) { return Err("DSH bundle 名称不是字符串".into()); }
    Ok(list.clone())
}
impl PluginAdapter for DeepSeek {
    fn discovery_only(&self) -> bool { true }
    fn capability(&self) -> PluginCapability {
        PluginCapability { version: "0.2.0-rc.2", sources: "desktop profile 内已安装的用户 bundle", actions: vec!["enable", "disable"], project: false,
            detail: "识别 desktop profile 的用户依赖与 dsh.bundle；启停修改 dsh.profile.bundles，保留依赖和插件文件。安装、更新和卸载请在 DSH 原生插件页执行，变更后重启 DSH。" }
    }
    fn command_args(&self, _action: &str, _source: &str, _project: bool) -> Result<Vec<String>, String> { Err("此操作使用原生 profile 配置事务".into()) }
    fn config_location(&self, home: &Path, target: &PluginTarget) -> Result<Option<(PathBuf, FileKind)>, String> {
        if target.scope != Scope::Global { return Err("DSH 用户插件属于全局 desktop profile".into()); }
        Ok(Some((manifest_path(home), FileKind::Json)))
    }
    fn discover(&self, home: &Path, _target: &PluginTarget, _path: &Path) -> Result<Vec<PluginEntry>, String> {
        let path = manifest_path(home);
        let contents = crate::native::transaction::read_native(&path)?;
        if contents.trim().is_empty() { return Ok(vec![]); }
        let parsed = crate::native::format::parse(FileKind::Json, &contents)?;
        let active = bundles(&parsed)?;
        let Some(dependencies) = parsed.get("dependencies") else { return Ok(vec![]); };
        let dependencies = dependencies.as_object().ok_or("DSH profile dependencies 不是对象")?;
        let mut entries = vec![];
        for name in dependencies.keys() {
            if name.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\')) { return Err("DSH 用户依赖名称无效".into()); }
            let root = path.parent().ok_or("DSH profile 目录缺失")?.join("node_modules").join(name);
            let text = crate::native::transaction::read_native(&root.join("package.json"))?;
            if text.is_empty() { continue; }
            let metadata: Value = serde_json::from_str(&text).map_err(|_| "DSH 用户插件 package.json 无法读取")?;
            if !metadata.pointer("/dsh/bundle").is_some_and(Value::is_object) { continue; }
            let enabled = active.iter().any(|item| item.as_str() == Some(name));
            let mut entry = PluginEntry { id: name.clone(), name: name.clone(), source: name.clone(), version: metadata.get("version").and_then(Value::as_str).map(str::to_owned),
                scope: "user".into(), enabled: Some(enabled), state: if enabled { "configured_load_unknown" } else { "disabled" }.into(),
                policy: "用户安装的 DSH profile bundle；依赖兼容性由 DSH 启动加载器检查".into(), read_only: false, root: Some(root.display().to_string()), resources: vec![] };
            crate::adapters::plugins::owned_resources(&mut entry); entries.push(entry);
        }
        Ok(entries)
    }
    fn config_only(&self, action: &str, _entry: Option<&PluginEntry>) -> bool { matches!(action, "enable" | "disable") }
    fn config_changes(&self, parsed: &Value, _saved: &mut serde_json::Map<String, Value>, request: &PluginRequest) -> Result<Vec<FieldChange>, String> {
        let mut active = bundles(parsed)?;
        if request.action == "disable" { active.retain(|item| item.as_str() != Some(&request.source)); }
        else if request.action == "enable" { if !active.iter().any(|item| item.as_str() == Some(&request.source)) { active.push(json!(request.source)); } }
        else { return Err("DSH 此插件操作尚未支持".into()); }
        Ok(vec![FieldChange { path: vec!["dsh".into(), "profile".into(), "bundles".into()], value: Some(json!(active)) }])
    }
}
