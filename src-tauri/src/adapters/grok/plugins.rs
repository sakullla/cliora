use super::Grok;
use crate::adapters::plugins::{owned_resources, PluginAdapter, PluginCapability};
use crate::{
    accounts::selection,
    native::{
        adapter::Scope,
        format::{self, FileKind},
        transaction::{self},
    },
    resources::plugins::{PluginEntry, PluginResource, PluginTarget},
};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

impl PluginAdapter for Grok {
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("1.0.46", "Git URL、user/repo@ref#subdir 或绝对本地路径", vec!["install", "update", "enable", "disable", "uninstall"], false, "原生命令管理已登记插件。用户目录 ~/.grok/plugins 里的插件也会列出；plugin list 没有登记时，启停和卸载仍在 Grok 终端的插件面板完成。项目插件操作的作用域尚未核验。安装明确授权 --trust；重启会话后加载。");
        PluginCapability {
            version,
            sources,
            actions,
            project,
            detail,
        }
    }
    fn preview(&self, home: &Path, target: &PluginTarget) -> Result<Option<Vec<PluginEntry>>, String> {
        if target.scope != Scope::Global {
            return Ok(None);
        }
        let mut entries = Vec::new();
        self.supplement(home, target, &mut entries)?;
        if entries.is_empty() {
            return Ok(None);
        }
        Ok(Some(entries))
    }
    fn supplement(
        &self,
        home: &Path,
        target: &PluginTarget,
        entries: &mut Vec<PluginEntry>,
    ) -> Result<(), String> {
        if target.scope != Scope::Global {
            return Ok(());
        }
        let root = grok_root(home);
        let (forced, disabled, paths) = plugin_config(&root);
        let mut seen = Vec::new();
        let user_dir = root.join("plugins");
        for directory in child_plugins(&user_dir) {
            push_directory(entries, &directory, true, &forced, &disabled, &mut seen);
        }
        for raw in paths {
            let Some(path) = expand_path(home, &raw) else {
                continue;
            };
            if same_dir(&path, &user_dir) {
                continue;
            }
            if is_plugin_dir(&path) {
                push_directory(entries, &path, false, &forced, &disabled, &mut seen);
            } else {
                for directory in child_plugins(&path) {
                    push_directory(entries, &directory, false, &forced, &disabled, &mut seen);
                }
            }
        }
        Ok(())
    }
    fn resources(&self, entry: &mut PluginEntry, _manifest: Option<&Value>) -> Result<(), String> {
        owned_resources(entry);
        let Some(root) = entry.root.as_deref().map(PathBuf::from) else {
            return Ok(());
        };
        let Some(manifest) = read_manifest(&root) else {
            return Ok(());
        };
        if entry.version.is_none() {
            entry.version = manifest
                .get("version")
                .and_then(Value::as_str)
                .filter(|version| safe_token(version))
                .map(str::to_owned);
        }
        for (key, kind) in [("agents", "agents"), ("skills", "skills")] {
            for directory in component_dirs(&root, &manifest, key) {
                if entry.resources.iter().any(|resource| {
                    resource.kind == kind && same_dir(Path::new(&resource.path), &directory)
                }) {
                    continue;
                }
                entry.resources.push(PluginResource {
                    kind: kind.into(),
                    path: directory.display().to_string(),
                    owner_id: entry.id.clone(),
                });
            }
        }
        Ok(())
    }
    fn command_args(
        &self,
        action: &str,
        source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = {
            let mut args = vec!["plugin", action, source];
            if action == "install" {
                args.push("--trust");
            }
            args
        };
        Ok(args.into_iter().map(str::to_owned).collect())
    }
    fn decorate(&self, entry: &mut PluginEntry, path: &Path) -> Result<(), String> {
        let text = transaction::read_native(path)?;
        if text.trim().is_empty() {
            return Ok(());
        }
        let value = format::parse(FileKind::Toml, &text)?;
        let has = |field: &str| listed(&value, field, &entry.id) || listed(&value, field, &entry.name);
        if has("disabled") {
            entry.enabled = Some(false);
        } else if has("enabled") {
            entry.enabled = Some(true);
        } else if entry.enabled.is_none() {
            entry.enabled = Some(false);
        }
        Ok(())
    }
}

fn grok_root(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(value) = std::env::var_os("GROK_HOME") {
            let path = PathBuf::from(value);
            if path.is_absolute() && !path.components().any(|part| matches!(part, Component::ParentDir)) {
                return path;
            }
        }
    }
    selection::config_root("grok", || home.join(".grok"))
}

fn plugin_config(root: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
    let Ok(text) = transaction::read_native(&root.join("config.toml")) else {
        return (Vec::new(), Vec::new(), Vec::new());
    };
    let Ok(value) = format::parse(FileKind::Toml, &text) else {
        return (Vec::new(), Vec::new(), Vec::new());
    };
    (
        string_list(&value, "enabled"),
        string_list(&value, "disabled"),
        string_list(&value, "paths"),
    )
}

fn string_list(value: &Value, field: &str) -> Vec<String> {
    value
        .get("plugins")
        .and_then(|plugins| plugins.get(field))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| safe_token(item))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn listed(value: &Value, field: &str, name: &str) -> bool {
    string_list(value, field).iter().any(|item| item == name)
}

fn child_plugins(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    for entry in entries.flatten() {
        if plugins.len() >= 256 {
            break;
        }
        let path = entry.path();
        match entry.file_name().to_str() {
            Some(name) if safe_token(name) => {}
            _ => continue,
        }
        if !is_plugin_dir(&path) {
            continue;
        }
        plugins.push(path);
    }
    plugins.sort();
    plugins
}

fn is_plugin_dir(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let directory = if meta.file_type().is_symlink() {
        path.canonicalize().ok().filter(|target| target.is_dir())
    } else if meta.is_dir() {
        Some(path.to_path_buf())
    } else {
        None
    };
    let Some(directory) = directory else {
        return false;
    };
    read_manifest(&directory).is_some()
        || ["skills", "agents", "commands", "hooks"]
            .iter()
            .any(|name| directory.join(name).is_dir())
        || directory.join(".mcp.json").is_file()
}

fn push_directory(
    entries: &mut Vec<PluginEntry>,
    directory: &Path,
    user_dir: bool,
    forced: &[String],
    disabled: &[String],
    seen: &mut Vec<String>,
) {
    let directory = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
    let manifest = read_manifest(&directory);
    let folder = directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| safe_token(name));
    let name = manifest
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .filter(|name| safe_token(name))
        .or(folder);
    let Some(name) = name else {
        return;
    };
    if seen.iter().any(|id| id == name) || entries.iter().any(|entry| entry.id == name) {
        return;
    }
    seen.push(name.to_owned());
    let enabled = if disabled.iter().any(|item| item == name) {
        false
    } else {
        user_dir || forced.iter().any(|item| item == name)
    };
    entries.push(PluginEntry {
        id: name.into(),
        name: name.into(),
        source: directory.display().to_string(),
        version: manifest
            .as_ref()
            .and_then(|value| value.get("version"))
            .and_then(Value::as_str)
            .filter(|version| safe_token(version))
            .map(str::to_owned),
        scope: "user".into(),
        enabled: Some(enabled),
        state: "installed_load_unknown".into(),
        policy: "这个插件在 Grok 用户插件目录或 plugins.paths 中。grok plugin list 没有登记时，这里不能启停或卸载。".into(),
        read_only: true,
        root: Some(directory.display().to_string()),
        resources: Vec::new(),
    });
}

fn read_manifest(root: &Path) -> Option<Value> {
    for relative in [".grok-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"] {
        let path = root.join(relative);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if value.is_object() {
                return Some(value);
            }
        }
    }
    None
}

fn component_dirs(root: &Path, manifest: &Value, key: &str) -> Vec<PathBuf> {
    let mut raws = Vec::new();
    match manifest.get(key) {
        Some(Value::String(text)) => raws.push(text.as_str()),
        Some(Value::Array(items)) => raws.extend(items.iter().filter_map(Value::as_str)),
        _ => {}
    }
    let mut dirs = Vec::new();
    for raw in raws {
        let trimmed = raw.trim().trim_start_matches("./").trim_start_matches(".\\");
        if trimmed.is_empty() || trimmed.len() > 512 {
            continue;
        }
        let relative = Path::new(trimmed);
        if relative.is_absolute() || relative.components().any(|part| matches!(part, Component::ParentDir)) {
            continue;
        }
        let path = root.join(relative);
        let candidate = if path.is_dir() {
            path
        } else if path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
            let Some(parent) = path.parent() else {
                continue;
            };
            parent.to_path_buf()
        } else {
            continue;
        };
        if !candidate.starts_with(root) || dirs.iter().any(|dir| dir == &candidate) {
            continue;
        }
        dirs.push(candidate);
    }
    dirs
}

fn expand_path(home: &Path, raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 1024 {
        return None;
    }
    let path = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        None
    } else {
        Some(path)
    }
}

fn same_dir(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|char| char.is_control() || char.is_whitespace())
        && !value.contains(['/', '\\'])
        && value != "."
        && value != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> PluginTarget {
        PluginTarget {
            tool_id: "grok".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        }
    }

    fn write_plugin(root: &Path) {
        let agents = root.join("generated").join("agents").join("grok-build");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::create_dir_all(root.join(".grok-plugin")).unwrap();
        std::fs::write(
            root.join(".grok-plugin").join("plugin.json"),
            r#"{"name":"sakullla-dev","version":"2.2.73","agents":["./generated/agents/grok-build","../outside"],"skills":"./skills/"}"#,
        )
        .unwrap();
        std::fs::write(
            agents.join("sakullla-explorer.md"),
            "---\nname: sakullla-explorer\ndescription: Explore\n---\nLook.\n",
        )
        .unwrap();
    }

    #[test]
    fn user_directory_plugin_is_listed_with_manifest_agents_when_plugin_list_is_empty() {
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join(".grok").join("plugins").join("sakullla-dev");
        write_plugin(&plugin);
        let outside = temp.path().join(".grok").join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let mut entries = Vec::new();
        Grok.supplement(temp.path(), &target(), &mut entries).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "sakullla-dev");
        assert_eq!(entries[0].version.as_deref(), Some("2.2.73"));
        assert_eq!(entries[0].enabled, Some(true));
        assert!(entries[0].read_only);
        Grok.resources(&mut entries[0], None).unwrap();
        let agents: Vec<_> = entries[0]
            .resources
            .iter()
            .filter(|resource| resource.kind == "agents")
            .map(|resource| resource.path.clone())
            .collect();
        assert_eq!(agents.len(), 1);
        assert!(agents[0].ends_with("grok-build"));
        assert!(!agents[0].contains("outside"));
        let mut definitions = Vec::new();
        crate::resources::agents::scan_directory(
            "grok",
            Path::new(&agents[0]),
            "md",
            true,
            "插件：sakullla-dev",
            &mut definitions,
        )
        .unwrap();
        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "sakullla-explorer");
        assert_eq!(definitions[0].owner, "插件：sakullla-dev");
        Grok.supplement(temp.path(), &target(), &mut entries).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn disabled_config_keeps_the_user_plugin_visible_and_off() {
        let temp = tempfile::tempdir().unwrap();
        let plugin = temp.path().join(".grok").join("plugins").join("sakullla-dev");
        write_plugin(&plugin);
        std::fs::write(
            temp.path().join(".grok").join("config.toml"),
            "[plugins]\ndisabled = [\"sakullla-dev\"]\n",
        )
        .unwrap();
        let mut entries = Vec::new();
        Grok.supplement(temp.path(), &target(), &mut entries).unwrap();
        assert_eq!(entries[0].enabled, Some(false));
        Grok.decorate(&mut entries[0], &temp.path().join(".grok").join("config.toml")).unwrap();
        assert_eq!(entries[0].enabled, Some(false));
    }

    #[test]
    fn decorate_keeps_an_enabled_user_plugin_when_config_has_no_plugin_table() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join(".grok")).unwrap();
        let config = temp.path().join(".grok").join("config.toml");
        std::fs::write(&config, "[cli]\ninstaller = \"npm\"\n").unwrap();
        let mut entry = PluginEntry {
            id: "sakullla-dev".into(),
            name: "sakullla-dev".into(),
            source: "directory".into(),
            version: None,
            scope: "user".into(),
            enabled: Some(true),
            state: "installed_load_unknown".into(),
            policy: String::new(),
            read_only: true,
            root: None,
            resources: Vec::new(),
        };
        Grok.decorate(&mut entry, &config).unwrap();
        assert_eq!(entry.enabled, Some(true));
    }
}
