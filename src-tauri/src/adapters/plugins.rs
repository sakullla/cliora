//! Plugin port: native behavior is selected once through the CLI registry.
use crate::{
    native::transaction::FieldChange,
    resources::plugins::{PluginEntry, PluginRequest, PluginResource, PluginTarget},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapability {
    pub version: &'static str,
    pub sources: &'static str,
    pub actions: Vec<&'static str>,
    pub project: bool,
    pub detail: &'static str,
}

#[derive(Default)]
pub struct PluginPackage {
    pub name: Option<String>,
    pub version: Option<String>,
    pub manifest: Option<Value>,
}
pub(crate) fn npm_metadata(root: Option<&Path>) -> PluginPackage {
    let manifest = root
        .map(|root| root.join("package.json"))
        .filter(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    PluginPackage {
        name: manifest.as_ref().and_then(|v| text(v, &["name"])),
        version: manifest.as_ref().and_then(|v| text(v, &["version"])),
        manifest,
    }
}
pub trait PluginAdapter: Sync {
    fn version_policy(&self) -> super::version::VersionPolicy {
        super::version::VersionPolicy::same_major(self.capability().version)
    }
    fn capability(&self) -> PluginCapability;
    fn command_args(
        &self,
        action: &str,
        source: &str,
        project: bool,
    ) -> Result<Vec<String>, String>;
    fn parse_list(&self, value: &Value, target: &PluginTarget) -> Result<Vec<PluginEntry>, String> {
        parse_native_list(self, value, target)
    }
    fn list_rows<'a>(&self, value: &'a Value) -> Option<&'a Vec<Value>> {
        value.as_array()
    }
    fn includes_row(&self, _row: &Value, _target: &PluginTarget) -> bool {
        true
    }
    fn policy_read_only(&self, _install: &str, _auth: Option<&str>) -> bool {
        false
    }
    fn config_field(&self) -> Option<&'static str> {
        None
    }
    fn disabled_declaration(&self, _original: &Value, _source: &str) -> Option<Value> {
        None
    }
    fn resolve_root(
        &self,
        source: &str,
        base: &Path,
        _home: &Path,
    ) -> Result<Option<PathBuf>, String> {
        Ok(local_root(source, base))
    }
    fn package_metadata(&self, _root: Option<&Path>) -> PluginPackage {
        PluginPackage::default()
    }
    fn resources(&self, entry: &mut PluginEntry, _manifest: Option<&Value>) -> Result<(), String> {
        owned_resources(entry);
        Ok(())
    }
    fn fill_missing_resources(&self, entry: &mut PluginEntry) -> Result<(), String> {
        self.resources(entry, None)
    }
    fn decorate(&self, _entry: &mut PluginEntry, _path: &Path) -> Result<(), String> {
        Ok(())
    }
    fn discover(
        &self,
        _home: &Path,
        _target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        Ok(vec![])
    }
    fn project_trust(&self) -> bool {
        false
    }
    fn config_only(&self, action: &str, _entry: Option<&PluginEntry>) -> bool {
        matches!(action, "enable" | "disable") && self.config_field().is_some()
    }
    fn validate_operation(
        &self,
        _request: &PluginRequest,
        _entry: Option<&PluginEntry>,
    ) -> Result<(), String> {
        Ok(())
    }
    fn operation_source(&self, request: &PluginRequest, _path: &Path) -> Result<String, String> {
        Ok(request.source.clone())
    }
    fn config_changes(
        &self,
        parsed: &Value,
        saved: &mut serde_json::Map<String, Value>,
        request: &PluginRequest,
    ) -> Result<Vec<FieldChange>, String> {
        let field = self.config_field().ok_or("此操作没有配置声明格式")?;
        let mut items = parsed
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let index = items.iter().position(|item| {
            item.as_str() == Some(&request.source)
                || item.get("source").and_then(Value::as_str) == Some(&request.source)
        });
        match request.action.as_str() {
            "disable" => {
                let index = index.ok_or("插件声明已消失")?;
                if saved.contains_key(&request.source) {
                    return Err("此包已禁用，请重新扫描".into());
                }
                let original = items[index].clone();
                if let Some(disabled) = self.disabled_declaration(&original, &request.source) {
                    items[index] = disabled;
                } else {
                    items.remove(index);
                }
                saved.insert(request.source.clone(), original);
            }
            "enable" => {
                let original = saved
                    .remove(&request.source)
                    .ok_or("没有可恢复的插件声明")?;
                if let Some(index) = index {
                    if self
                        .disabled_declaration(&original, &request.source)
                        .as_ref()
                        != Some(&items[index])
                    {
                        return Err("相同来源已被外部修改；重新扫描后处理冲突".into());
                    }
                    items[index] = original;
                } else {
                    items.push(original);
                }
            }
            "install" => {
                if index.is_some() || saved.contains_key(&request.source) {
                    return Err("此来源已配置；请启用或先移除".into());
                }
                items.push(json!(request.source));
            }
            "uninstall" => {
                if let Some(index) = index {
                    items.remove(index);
                }
                saved.remove(&request.source);
            }
            _ => return Err("不支持的配置操作".into()),
        }
        Ok(vec![FieldChange {
            path: vec![field.into()],
            value: Some(json!(items)),
        }])
    }
}
pub fn get(tool: &str) -> Result<&'static dyn PluginAdapter, String> {
    get_registered(&super::Registry::builtins(), tool)
}
pub fn get_registered(
    registry: &super::Registry,
    tool: &str,
) -> Result<&'static dyn PluginAdapter, String> {
    registry
        .get(tool)
        .and_then(|a| a.plugins())
        .ok_or_else(|| "此 CLI 未提供此能力适配".into())
}
pub fn capability(tool: &str) -> Result<PluginCapability, String> {
    Ok(get(tool)?.capability())
}
pub fn command_args(
    tool: &str,
    action: &str,
    source: &str,
    project: bool,
) -> Result<Vec<String>, String> {
    if source.is_empty()
        || source.starts_with('-')
        || source.chars().any(char::is_control)
        || source.len() > 2048
    {
        return Err("插件来源/标识无效".into());
    }
    let adapter = get(tool)?;
    let cap = adapter.capability();
    if !cap.actions.contains(&action) || (project && !cap.project) {
        return Err("此原生操作或作用域未支持".into());
    }
    adapter.command_args(action, source, project)
}

fn parse_native_list(
    adapter: &(impl PluginAdapter + ?Sized),
    value: &Value,
    target: &PluginTarget,
) -> Result<Vec<PluginEntry>, String> {
    let rows = adapter
        .list_rows(value)
        .ok_or("原生插件列表结构不兼容；未解释为无插件")?;
    rows.iter()
        .filter(|row| adapter.includes_row(row, target))
        .map(|row| {
            let id = text(row, &["pluginId", "id", "name"])
                .ok_or("插件条目缺少身份；请使用原生 CLI 检查")?;
            let install_policy =
                text(row, &["installPolicy", "policy"]).unwrap_or_else(|| "原生策略校验".into());
            let auth_policy = text(row, &["authPolicy"]);
            let policy = format!(
                "{}{}",
                install_policy,
                auth_policy
                    .as_ref()
                    .map(|policy| format!(" · 认证 {policy}（原生校验）"))
                    .unwrap_or_default()
            );
            let scope = text(row, &["scope"]).unwrap_or_else(|| "user".into());
            let read_only = scope == "managed"
                || matches!(
                    install_policy.as_str(),
                    "REQUIRED" | "NOT_AVAILABLE" | "FORBIDDEN"
                )
                || scope == "local"
                || adapter.policy_read_only(&install_policy, auth_policy.as_deref());
            Ok(PluginEntry {
                name: text(row, &["name"]).unwrap_or_else(|| id.clone()),
                id: id.clone(),
                source: row
                    .get("source")
                    .map(string_source)
                    .unwrap_or_else(|| id.clone()),
                version: text(row, &["version", "revision", "commit"]),
                scope,
                enabled: row.get("enabled").and_then(Value::as_bool),
                state: "installed_load_unknown".into(),
                policy,
                read_only,
                root: text(row, &["installPath", "installedPath", "path"]),
                resources: vec![],
            })
        })
        .collect()
}
pub(crate) fn text(value: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str).map(str::to_owned))
}

fn string_source(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| text(value, &["url", "path", "source", "repo"]))
        .unwrap_or_else(|| "原生来源未提供".into())
}

pub(crate) fn owned_resources(entry: &mut PluginEntry) {
    let Some(root) = entry.root.as_deref().map(Path::new) else {
        return;
    };
    for (kind, paths) in [
        ("agents", vec!["agents"]),
        ("skills", vec!["skills"]),
        ("hooks", vec!["hooks"]),
        ("mcp", vec![".mcp.json"]),
        ("extensions", vec!["extensions"]),
        ("prompts", vec!["prompts"]),
        ("themes", vec!["themes"]),
    ] {
        for path in paths {
            let path = root.join(path);
            if path.exists() {
                entry.resources.push(PluginResource {
                    kind: kind.into(),
                    path: path.display().to_string(),
                    owner_id: entry.id.clone(),
                });
            }
        }
    }
}

pub(crate) fn local_root(source: &str, base: &Path) -> Option<PathBuf> {
    if source.starts_with("file:") {
        return url::Url::parse(source).ok()?.to_file_path().ok();
    }
    let path = Path::new(source);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else if source.starts_with('.') {
        Some(base.join(path))
    } else {
        None
    }
}
