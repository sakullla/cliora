//! Local plugins live under `<data-dir>/plugins/<name>/.minimax-plugin/plugin.json`.
//! `plugin list --json --available` also returns official marketplace rows that
//! are not installed. Plugin skills stay on the plugin entry.
use super::{data_dir, DataDir, MiniMaxCode};
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::native::adapter::Scope;
use crate::native::format::FileKind;
use crate::resources::plugins::{PluginEntry, PluginResource, PluginTarget};
use serde_json::Value;
use std::path::{Path, PathBuf};

impl PluginAdapter for MiniMaxCode {
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "0.6.8",
            sources: "name@official 或 name@local",
            actions: vec!["install", "enable", "disable", "uninstall"],
            project: false,
            detail: "通过 mcode plugin 管理用户数据目录中的本地插件。官方市场条目标为未安装，不记成已安装。",
        }
    }
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        crate::adapters::version::VersionPolicy::same_major("0.6.8")
    }
    fn config_location(
        &self,
        home: &Path,
        target: &PluginTarget,
    ) -> Result<Option<(PathBuf, FileKind)>, String> {
        if target.scope != Scope::Global {
            return Err("MiniMax Code 插件只在用户数据目录管理".into());
        }
        let DataDir::Directory(dir) = data_dir(home) else {
            return Err("MiniMax Code 数据目录无效，插件管理不可用".into());
        };
        if !dir.is_dir() {
            return Err("MiniMax Code 数据目录不存在，插件管理不可用".into());
        }
        Ok(Some((dir.join("config.yaml"), FileKind::Yaml)))
    }
    fn snapshot_files(&self, home: &Path, target: &PluginTarget) -> Vec<PathBuf> {
        if target.scope != Scope::Global {
            return Vec::new();
        }
        let DataDir::Directory(dir) = data_dir(home) else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(dir.join("plugins")) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path().join(".minimax-plugin").join("plugin.json"))
            .filter(|path| path.is_file())
            .collect()
    }
    fn command_args(&self, action: &str, source: &str, project: bool) -> Result<Vec<String>, String> {
        if project {
            return Err("MiniMax Code 插件只在用户数据目录管理".into());
        }
        let verb = match action {
            "install" | "add" => "add",
            "enable" => "enable",
            "disable" => "disable",
            "uninstall" | "remove" => "remove",
            _ => return Err("MiniMax Code 插件操作未支持".into()),
        };
        Ok(vec!["plugin".into(), verb.into(), source.into()])
    }
    fn list_command_args(&self) -> Vec<String> {
        vec!["plugin".into(), "list".into(), "--json".into(), "--available".into()]
    }
    fn parse_list(&self, value: &Value, _target: &PluginTarget) -> Result<Vec<PluginEntry>, String> {
        let object = value.as_object().ok_or("MiniMax Code 插件列表不是已核对的对象")?;
        let mut entries = Vec::new();
        for row in object.get("installed").and_then(Value::as_array).into_iter().flatten() {
            entries.push(row_entry(row, true)?);
        }
        for row in object.get("available").and_then(Value::as_array).into_iter().flatten() {
            let entry = row_entry(row, false)?;
            if entries.iter().any(|existing| existing.id == entry.id) {
                continue;
            }
            entries.push(entry);
        }
        Ok(entries)
    }
    fn resources(&self, entry: &mut PluginEntry, _manifest: Option<&Value>) -> Result<(), String> {
        let Some(root) = entry.root.as_deref().map(Path::new) else {
            return Ok(());
        };
        let manifest_path = root.join(".minimax-plugin").join("plugin.json");
        let Ok(text) = std::fs::read_to_string(&manifest_path) else {
            return Ok(());
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
            return Ok(());
        };
        let Some(skills) = manifest.get("skills").and_then(Value::as_array) else {
            return Ok(());
        };
        for skill in skills {
            let Some(name) = skill.as_str() else {
                continue;
            };
            if !safe_segment(name) {
                continue;
            }
            entry.resources.push(PluginResource {
                kind: "skills".into(),
                path: root.join("skills").join(name).join("SKILL.md").display().to_string(),
                owner_id: entry.id.clone(),
            });
        }
        Ok(())
    }
    fn decorate(&self, entry: &mut PluginEntry, path: &Path) -> Result<(), String> {
        if entry.root.is_some() {
            return Ok(());
        }
        let Some(name) = entry.id.split('@').next().filter(|name| safe_segment(name)) else {
            return Ok(());
        };
        let Some(parent) = path.parent() else {
            return Ok(());
        };
        let candidate = parent.join("plugins").join(name);
        if candidate.join(".minimax-plugin").join("plugin.json").is_file() {
            entry.root = Some(candidate.display().to_string());
        }
        Ok(())
    }
}

fn row_entry(row: &Value, from_installed: bool) -> Result<PluginEntry, String> {
    let id = selector(row)?;
    let installed = row.get("installed").and_then(Value::as_bool).unwrap_or(from_installed);
    let enabled = row.get("enabled").and_then(Value::as_bool);
    let name = row
        .get("displayName")
        .and_then(Value::as_str)
        .or_else(|| row.get("name").and_then(Value::as_str))
        .unwrap_or(&id)
        .to_owned();
    Ok(PluginEntry {
        name,
        id: id.clone(),
        source: id,
        version: row.get("version").and_then(Value::as_str).map(str::to_owned),
        scope: "user".into(),
        enabled: if installed { enabled } else { None },
        state: if !installed {
            "未安装".into()
        } else if enabled == Some(false) {
            "disabled".into()
        } else {
            "installed_load_unknown".into()
        },
        policy: if installed {
            "本地插件可由 mcode plugin 启停".into()
        } else {
            "官方市场条目未安装".into()
        },
        read_only: !installed,
        root: row.get("installPath").and_then(Value::as_str).map(str::to_owned),
        resources: Vec::new(),
    })
}

fn selector(row: &Value) -> Result<String, String> {
    if let Some(id) = row.get("pluginId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
        return Ok(id.to_owned());
    }
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or("插件条目缺少身份；请使用原生 CLI 检查")?;
    let market = row.get("marketplaceName").and_then(Value::as_str).unwrap_or("local");
    Ok(format!("{name}@{market}"))
}

fn safe_segment(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', '.'])
        && name.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}
