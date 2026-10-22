//! Local plugins live under `<data-dir>/plugins/<name>/.minimax-plugin/plugin.json`.
//! `plugin list --json` is the installed set, which is what mcode can enable.
//! An `available` array, when a response includes one, stays not installed and
//! is not treated as loaded. `skills` entries are relative paths from the plugin
//! root; an existing `SKILL.md` stays on the plugin entry.
use super::{data_dir, DataDir, MiniMaxCode};
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::native::adapter::Scope;
use crate::native::format::FileKind;
use crate::resources::plugins::{PluginEntry, PluginResource, PluginTarget};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

impl PluginAdapter for MiniMaxCode {
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "0.6.8",
            sources: "name@official 或 name@local",
            actions: vec!["install", "enable", "disable", "uninstall"],
            project: false,
            detail: "列表是 mcode 已安装的插件，可以启用、停用和移除。未安装的官方市场不在这份列表里；添加时填写 name@official 或 name@local。",
        }
    }
    fn owns_agent_definitions(&self) -> bool {
        false
    }
    fn preview(&self, home: &Path, target: &PluginTarget) -> Result<Option<Vec<PluginEntry>>, String> {
        if target.scope != Scope::Global {
            return Ok(None);
        }
        let DataDir::Directory(dir) = data_dir(home) else {
            return Ok(None);
        };
        if !dir.is_dir() {
            return Ok(None);
        }
        let plugins = dir.join("plugins");
        if !plugins.is_dir() {
            return Ok(Some(Vec::new()));
        }
        let mut entries = Vec::new();
        for item in std::fs::read_dir(&plugins).map_err(|_| "无法读取 MiniMax Code 插件目录")? {
            if entries.len() >= 256 {
                break;
            }
            let item = item.map_err(|_| "无法读取 MiniMax Code 插件目录")?;
            let path = item.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_dir() || meta.file_type().is_symlink() {
                continue;
            }
            let file_name = item.file_name();
            let Some(name) = file_name.to_str().filter(|segment| safe_segment(segment)) else {
                continue;
            };
            let manifest_path = path.join(".minimax-plugin").join("plugin.json");
            let Ok(manifest_meta) = std::fs::symlink_metadata(&manifest_path) else {
                continue;
            };
            if !manifest_meta.is_file()
                || manifest_meta.file_type().is_symlink()
                || manifest_meta.len() > 1024 * 1024
            {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let id = format!("{name}@local");
            let display = manifest
                .get("displayName")
                .and_then(Value::as_str)
                .or_else(|| manifest.get("name").and_then(Value::as_str))
                .filter(|value| !value.is_empty())
                .unwrap_or(name);
            entries.push(PluginEntry {
                name: display.to_owned(),
                id: id.clone(),
                source: id,
                version: manifest.get("version").and_then(Value::as_str).map(str::to_owned),
                scope: "user".into(),
                enabled: None,
                state: "inventory_pending".into(),
                policy: "本地插件目录预览；启停以 mcode plugin list 为准".into(),
                read_only: true,
                root: Some(path.display().to_string()),
                resources: Vec::new(),
            });
        }
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(Some(entries))
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
        vec!["plugin".into(), "list".into(), "--json".into()]
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
        let Ok(root_canon) = root.canonicalize() else {
            return Ok(());
        };
        for skill in skills {
            let Some(declared) = skill.as_str() else {
                continue;
            };
            let Some(path) = contained_skill(root, &root_canon, declared) else {
                continue;
            };
            let display = path.display().to_string();
            if entry.resources.iter().any(|item| item.path == display) {
                continue;
            }
            entry.resources.push(PluginResource {
                kind: "skills".into(),
                path: display,
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
            "not_installed".into()
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

/// `plugin.json` `skills` values are paths relative to the plugin root, such as
/// `skills/<name>/SKILL.md`. Absolute paths, `..`, and links that leave the
/// plugin are omitted. The declared path is not rewritten under `skills/`.
fn contained_skill(root: &Path, root_canon: &Path, declared: &str) -> Option<PathBuf> {
    let relative = Path::new(declared.trim());
    if declared.trim().is_empty() || relative.is_absolute() {
        return None;
    }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return None;
    }
    let file_canon = path.canonicalize().ok()?;
    if !file_canon.starts_with(root_canon) || !file_canon.is_file() {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::plugins::PluginAdapter;
    use crate::native::adapter::Scope;
    use crate::resources::plugins::PluginTarget;

    fn entry(root: &Path) -> PluginEntry {
        PluginEntry {
            name: "Review".into(),
            id: "review@local".into(),
            source: "review@local".into(),
            version: None,
            scope: "user".into(),
            enabled: Some(true),
            state: "installed_load_unknown".into(),
            policy: String::new(),
            read_only: false,
            root: Some(root.display().to_string()),
            resources: Vec::new(),
        }
    }

    #[test]
    fn official_relative_skill_paths_stay_inside_the_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("review");
        let skill = root.join("skills").join("literature-review").join("SKILL.md");
        let doubled = root
            .join("skills")
            .join("skills")
            .join("literature-review")
            .join("SKILL.md")
            .join("SKILL.md");
        let outside = temp.path().join("outside").join("SKILL.md");
        let absolute = temp.path().join("absolute").join("SKILL.md");
        for path in [&skill, &doubled, &outside, &absolute] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "# skill\n").unwrap();
        }
        let manifest_dir = root.join(".minimax-plugin");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        let manifest = serde_json::json!({
            "name": "review",
            "skills": [
                "skills/literature-review/SKILL.md",
                "../outside/SKILL.md",
                absolute.display().to_string(),
                "skills/literature-review/SKILL.md/../../../outside/SKILL.md",
                "skills/missing/SKILL.md"
            ]
        });
        std::fs::write(manifest_dir.join("plugin.json"), manifest.to_string()).unwrap();

        let mut listed = entry(&root);
        MiniMaxCode.fill_missing_resources(&mut listed).unwrap();
        assert_eq!(listed.resources.len(), 1);
        assert_eq!(listed.resources[0].kind, "skills");
        assert_eq!(listed.resources[0].owner_id, "review@local");
        assert_eq!(PathBuf::from(&listed.resources[0].path), skill);
        assert_ne!(PathBuf::from(&listed.resources[0].path), doubled);

        let bare_root = temp.path().join("bare");
        let bare_skill = bare_root.join("skills").join("literature-review").join("SKILL.md");
        std::fs::create_dir_all(bare_skill.parent().unwrap()).unwrap();
        std::fs::write(&bare_skill, "# skill\n").unwrap();
        let bare_manifest = bare_root.join(".minimax-plugin");
        std::fs::create_dir_all(&bare_manifest).unwrap();
        std::fs::write(bare_manifest.join("plugin.json"), r#"{"skills":["literature-review"]}"#).unwrap();
        let mut bare = entry(&bare_root);
        MiniMaxCode.fill_missing_resources(&mut bare).unwrap();
        assert!(bare.resources.is_empty());

        let decoy_root = temp.path().join("decoy");
        let decoy_only = decoy_root
            .join("skills")
            .join("skills")
            .join("literature-review")
            .join("SKILL.md")
            .join("SKILL.md");
        std::fs::create_dir_all(decoy_only.parent().unwrap()).unwrap();
        std::fs::write(&decoy_only, "# decoy\n").unwrap();
        let decoy_manifest = decoy_root.join(".minimax-plugin");
        std::fs::create_dir_all(&decoy_manifest).unwrap();
        std::fs::write(
            decoy_manifest.join("plugin.json"),
            r#"{"skills":["skills/literature-review/SKILL.md"]}"#,
        )
        .unwrap();
        let mut missing = entry(&decoy_root);
        MiniMaxCode.fill_missing_resources(&mut missing).unwrap();
        assert!(missing.resources.is_empty());
    }

    #[test]
    fn preview_reads_only_local_plugin_manifests() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let review = home
            .join(".minimax")
            .join("plugins")
            .join("review")
            .join(".minimax-plugin");
        let skipped = home.join(".minimax").join("plugins").join("notes");
        std::fs::create_dir_all(&review).unwrap();
        std::fs::create_dir_all(&skipped).unwrap();
        std::fs::write(
            review.join("plugin.json"),
            r#"{"name":"review","displayName":"Review","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(skipped.join("README.md"), "not a plugin").unwrap();
        let dotted = home.join(".minimax").join("plugins").join("bad.name").join(".minimax-plugin");
        std::fs::create_dir_all(&dotted).unwrap();
        std::fs::write(dotted.join("plugin.json"), r#"{"name":"bad.name"}"#).unwrap();

        let target = PluginTarget {
            tool_id: "minimax_code".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let entries = MiniMaxCode.preview(home, &target).unwrap().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "review@local");
        assert_eq!(entries[0].name, "Review");
        assert_eq!(entries[0].version.as_deref(), Some("1.0.0"));
        assert!(entries[0].root.as_deref().unwrap().contains("plugins"));
        assert_eq!(
            MiniMaxCode.list_command_args(),
            ["plugin", "list", "--json"]
        );
        let project = PluginTarget {
            scope: Scope::Project,
            project_path: Some("/work/demo".into()),
            ..target
        };
        assert!(MiniMaxCode.preview(home, &project).unwrap().is_none());
    }
}
