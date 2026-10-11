//! User-local Cursor plugins. Only `~/.cursor/plugins/local` with a manifest is writable.
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::super::plugins::{PluginAdapter, PluginCapability};
use super::Cursor;
use crate::native::format::FileKind;
use crate::native::transaction::FileMutation;
use crate::resources::plugins::{PluginEntry, PluginRequest, PluginResource, PluginTarget};

const MAX_FILES: usize = 2000;
const MAX_BYTES: usize = 32 * 1024 * 1024;

impl PluginAdapter for Cursor {
    fn discovery_only(&self) -> bool {
        true
    }

    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "local-manifest",
            sources: "directory",
            actions: vec!["install", "enable", "disable", "uninstall"],
            project: false,
            detail: "只管理 ~/.cursor/plugins/local 中带 .cursor-plugin/plugin.json 的目录。不执行钩子。",
        }
    }

    fn command_args(&self, _action: &str, _source: &str, _project: bool) -> Result<Vec<String>, String> {
        Err("Cursor 本地插件不通过命令行变更".into())
    }

    fn config_location(
        &self,
        home: &Path,
        target: &PluginTarget,
    ) -> Result<Option<(PathBuf, FileKind)>, String> {
        if target.scope != crate::native::adapter::Scope::Global {
            return Err("Cursor 只管理用户目录下的本地插件".into());
        }
        Ok(Some((
            home.join(".cursor").join("plugins").join("local").join(".cliora-scope"),
            FileKind::Json,
        )))
    }

    fn snapshot_files(&self, home: &Path, target: &PluginTarget) -> Vec<PathBuf> {
        if target.scope != crate::native::adapter::Scope::Global {
            return Vec::new();
        }
        let mut files = Vec::new();
        for root in [local_dir(home), disabled_dir(home)] {
            collect_manifests(&root, &mut files);
        }
        files
    }

    fn discover(
        &self,
        home: &Path,
        target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        if target.scope != crate::native::adapter::Scope::Global {
            return Err("Cursor 只管理用户目录下的本地插件".into());
        }
        let mut entries = Vec::new();
        push_dir(&local_dir(home), true, &mut entries)?;
        push_dir(&disabled_dir(home), false, &mut entries)?;
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(entries)
    }

    fn resources(&self, entry: &mut PluginEntry, manifest: Option<&Value>) -> Result<(), String> {
        let Some(root) = entry.root.as_deref().map(PathBuf::from) else {
            return Ok(());
        };
        for (kind, relative) in [
            ("rules", "rules"),
            ("skills", "skills"),
            ("agents", "agents"),
            ("commands", "commands"),
            ("hooks", "hooks"),
        ] {
            let path = root.join(relative);
            if path.exists() {
                entry.resources.push(PluginResource {
                    kind: kind.into(),
                    path: path.display().to_string(),
                    owner_id: entry.id.clone(),
                });
            }
        }
        let manifest = manifest.cloned().or_else(|| read_manifest(&root.join(".cursor-plugin/plugin.json")).ok());
        if let Some(relative) = manifest
            .as_ref()
            .and_then(|value| value.get("mcpServers"))
            .and_then(Value::as_str)
        {
            if let Some(path) = contained_join(&root, relative) {
                if path.is_file() {
                    entry.resources.push(PluginResource {
                        kind: "mcp".into(),
                        path: path.display().to_string(),
                        owner_id: entry.id.clone(),
                    });
                }
            }
        } else if root.join("mcp.json").is_file() {
            entry.resources.push(PluginResource {
                kind: "mcp".into(),
                path: root.join("mcp.json").display().to_string(),
                owner_id: entry.id.clone(),
            });
        }
        Ok(())
    }

    fn local_mutation(&self, action: &str) -> bool {
        matches!(action, "install" | "enable" | "disable" | "uninstall")
    }

    fn plan_local_mutation(
        &self,
        home: &Path,
        request: &PluginRequest,
        entry: Option<&PluginEntry>,
    ) -> Result<Vec<FileMutation>, String> {
        match request.action.as_str() {
            "install" => plan_install(home, &request.source),
            "enable" => plan_move(home, entry, true),
            "disable" => plan_move(home, entry, false),
            "uninstall" => plan_remove(home, entry),
            _ => Err("不支持的本地插件操作".into()),
        }
    }

    fn cleanup_local_mutation(&self, home: &Path, _request: &PluginRequest) -> Result<(), String> {
        for root in [local_dir(home), disabled_dir(home)] {
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    remove_empty(&path);
                }
            }
        }
        Ok(())
    }
}

fn local_dir(home: &Path) -> PathBuf {
    home.join(".cursor").join("plugins").join("local")
}

fn disabled_dir(home: &Path) -> PathBuf {
    home.join(".cursor").join("plugins").join(".cliora-disabled-plugins")
}

fn push_dir(dir: &Path, enabled: bool, entries: &mut Vec<PluginEntry>) -> Result<(), String> {
    let Ok(read) = fs::read_dir(dir) else {
        return Ok(());
    };
    for item in read {
        let item = item.map_err(|error| error.to_string())?;
        let file_type = item.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || safe_segment(&name).is_err() {
            continue;
        }
        let root = dir.join(&name);
        let manifest_path = root.join(".cursor-plugin").join("plugin.json");
        let manifest = read_manifest(&manifest_path).ok();
        let readable = manifest.is_some();
        let (display, version) = manifest
            .as_ref()
            .map(|value| {
                (
                    value
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&name)
                        .to_owned(),
                    value.get("version").and_then(Value::as_str).map(str::to_owned),
                )
            })
            .unwrap_or_else(|| (name.clone(), None));
        let mut entry = PluginEntry {
            name: display,
            id: name,
            source: root.display().to_string(),
            version,
            scope: "user".into(),
            enabled: readable.then_some(enabled),
            state: if readable {
                "installed".into()
            } else if manifest_path.exists() {
                "manifest_unreadable".into()
            } else {
                "cursor_managed".into()
            },
            policy: if readable {
                "本机目录插件".into()
            } else if manifest_path.exists() {
                "清单无法读取".into()
            } else {
                "Cursor 内管理，没有本机清单".into()
            },
            read_only: !readable,
            root: Some(root.display().to_string()),
            resources: Vec::new(),
        };
        Cursor.resources(&mut entry, manifest.as_ref())?;
        entries.push(entry);
    }
    Ok(())
}

fn read_manifest(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|_| "无法读取插件清单")?;
    if text.len() > 256 * 1024 {
        return Err("插件清单超过 256 KiB".into());
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| "插件清单不是 JSON 对象")?;
    if !value.is_object() {
        return Err("插件清单不是 JSON 对象".into());
    }
    Ok(value)
}

fn collect_manifests(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path().join(".cursor-plugin").join("plugin.json");
        if path.is_file() {
            files.push(path);
        }
    }
}

fn plan_install(home: &Path, source: &str) -> Result<Vec<FileMutation>, String> {
    let meta = fs::symlink_metadata(source).map_err(|_| "插件来源目录不存在")?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("请选择包含清单的本地目录".into());
    }
    let source = PathBuf::from(source);
    let manifest = source.join(".cursor-plugin").join("plugin.json");
    if !manifest.is_file() {
        return Err("来源目录没有 .cursor-plugin/plugin.json".into());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("插件目录名无效")?;
    safe_segment(name)?;
    let dest = local_dir(home).join(name);
    if dest.exists() || disabled_dir(home).join(name).exists() {
        return Err("同名本地插件已存在".into());
    }
    if dest.starts_with(&source) {
        return Err("不能把插件目录复制到自身里面".into());
    }
    copy_tree(&source, &dest)
}

fn plan_move(home: &Path, entry: Option<&PluginEntry>, enable: bool) -> Result<Vec<FileMutation>, String> {
    let entry = entry.ok_or("插件已不存在，请重新扫描")?;
    safe_segment(&entry.id)?;
    let from = if enable { disabled_dir(home) } else { local_dir(home) }.join(&entry.id);
    let dest = if enable { local_dir(home) } else { disabled_dir(home) }.join(&entry.id);
    if !from.is_dir() {
        return Err("插件目录已变化，请重新扫描".into());
    }
    if dest.exists() {
        return Err("启停目标已存在".into());
    }
    if !from.join(".cursor-plugin").join("plugin.json").is_file() {
        return Err("没有本机清单的插件保持只读".into());
    }
    let mut changes = copy_tree(&from, &dest)?;
    changes.extend(delete_tree(&from)?);
    Ok(changes)
}

fn plan_remove(home: &Path, entry: Option<&PluginEntry>) -> Result<Vec<FileMutation>, String> {
    let entry = entry.ok_or("插件已不存在，请重新扫描")?;
    safe_segment(&entry.id)?;
    let local = local_dir(home).join(&entry.id);
    let disabled = disabled_dir(home).join(&entry.id);
    let root = if local.is_dir() {
        local
    } else if disabled.is_dir() {
        disabled
    } else {
        return Err("插件目录已变化，请重新扫描".into());
    };
    if !root.join(".cursor-plugin").join("plugin.json").is_file() {
        return Err("没有本机清单的插件保持只读".into());
    }
    delete_tree(&root)
}

fn copy_tree(source: &Path, dest: &Path) -> Result<Vec<FileMutation>, String> {
    let files = collect_files(source)?;
    files
        .into_iter()
        .map(|(relative, contents)| {
            Ok(FileMutation {
                path: dest.join(relative),
                baseline: None,
                contents: Some(contents),
            })
        })
        .collect()
}

fn delete_tree(source: &Path) -> Result<Vec<FileMutation>, String> {
    collect_files(source)?
        .into_iter()
        .map(|(relative, contents)| {
            Ok(FileMutation {
                path: source.join(relative),
                baseline: Some(contents),
                contents: None,
            })
        })
        .collect()
}

fn collect_files(root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = Vec::new();
    let mut bytes = 0usize;
    walk_files(root, root, &mut files, &mut bytes)?;
    if files.is_empty() {
        return Err("插件目录没有可写入的文件".into());
    }
    Ok(files)
}

fn walk_files(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(PathBuf, String)>,
    bytes: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|error| format!("无法读取插件目录：{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(format!("插件包含符号链接：{}", path.display()));
        }
        if meta.is_dir() {
            walk_files(root, &path, files, bytes)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if files.len() >= MAX_FILES {
            return Err("插件文件超过 2000 个".into());
        }
        let text = fs::read_to_string(&path).map_err(|_| {
            format!("插件包含非 UTF-8 文件，现有文本事务不能复制：{}", path.display())
        })?;
        *bytes += text.len();
        if *bytes > MAX_BYTES {
            return Err("插件文件超过 32 MiB".into());
        }
        let relative = path.strip_prefix(root).map_err(|_| "插件路径无效")?.to_path_buf();
        if relative.components().any(|component| matches!(component, Component::ParentDir)) {
            return Err("插件路径无效".into());
        }
        files.push((relative, text));
    }
    Ok(())
}

fn safe_segment(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 80
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'.')
    {
        return Err("插件目录名无效".into());
    }
    Ok(())
}

fn contained_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    Some(root.join(relative))
}

fn remove_empty(dir: &Path) -> bool {
    let mut empty = true;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if !remove_empty(&path) {
                    empty = false;
                }
            } else {
                empty = false;
            }
        }
    } else {
        return false;
    }
    empty && fs::remove_dir(dir).is_ok()
}
