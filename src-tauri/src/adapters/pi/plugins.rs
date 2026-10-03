use super::Pi;
use crate::adapters::plugins::{local_root, owned_resources};
use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::resources::plugins::{self, PluginEntry, PluginRequest};
use plugins::PluginResource;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

impl PluginAdapter for Pi {
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        super::version_policy()
    }
    fn capability(&self) -> PluginCapability {
        let (version,sources,actions,project,detail) = ("1.0.0", "npm:包@版本、git:仓库或绝对本地路径", vec!["install", "update", "enable", "disable", "uninstall"], true, "Pi packages/extensions；禁用保留完整资源过滤，恢复时还原。项目包需要原生信任；重启或原生 /reload 后加载。");
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
        project: bool,
    ) -> Result<Vec<String>, String> {
        let args: Vec<&str> = {
            if action == "update" && project {
                return Err(
                    "Pi update 可能合并全局与项目同源包；项目更新请在原生 CLI 中执行".into(),
                );
            }
            let mut args = match action {
                "install" => vec!["install", source],
                "uninstall" => vec!["remove", source],
                "update" => vec!["update", "--extension", source],
                _ => return Err("此操作使用配置事务".into()),
            };
            if project {
                args.extend(["--local", "--approve"]);
            } else {
                args.push("--no-approve");
            }
            args
        };
        Ok(args.into_iter().map(str::to_owned).collect())
    }
    fn fill_missing_resources(&self, _entry: &mut PluginEntry) -> Result<(), String> {
        Ok(())
    }
    fn package_metadata(&self, root: Option<&Path>) -> crate::adapters::plugins::PluginPackage {
        crate::adapters::plugins::npm_metadata(root)
    }
    fn config_field(&self) -> Option<&'static str> {
        Some("packages")
    }
    fn project_trust(&self) -> bool {
        true
    }
    fn disabled_declaration(&self, original: &Value, source: &str) -> Option<Value> {
        Some(pi_disabled(original, source))
    }
    fn resolve_root(
        &self,
        source: &str,
        base: &Path,
        home: &Path,
    ) -> Result<Option<PathBuf>, String> {
        pi_installed_root(source, base, home).map(Some)
    }
    fn resources(&self, entry: &mut PluginEntry, manifest: Option<&Value>) -> Result<(), String> {
        pi_manifest_resources(entry, manifest)
    }
    fn config_only(&self, action: &str, entry: Option<&PluginEntry>) -> bool {
        matches!(action, "enable" | "disable")
            || (action == "uninstall" && entry.is_some_and(|e| e.enabled == Some(false)))
    }
    fn validate_operation(
        &self,
        request: &PluginRequest,
        entry: Option<&PluginEntry>,
    ) -> Result<(), String> {
        if request.action == "update" && entry.is_some_and(|e| e.enabled == Some(false)) {
            return Err("先恢复包声明再执行原生更新".into());
        }
        Ok(())
    }
    fn operation_source(&self, request: &PluginRequest, path: &Path) -> Result<String, String> {
        Ok(if request.action != "install" {
            local_root(&request.source, path.parent().ok_or("配置目录缺失")?)
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| request.source.clone())
        } else {
            request.source.clone()
        })
    }
}
pub(crate) fn pi_disabled(item: &Value, source: &str) -> Value {
    let mut value = item
        .as_object()
        .cloned()
        .unwrap_or_else(|| serde_json::Map::from_iter([("source".into(), json!(source))]));
    // Project autoload:false is a delta over the global package. Empty delta
    // arrays remove exclusions, so disabling MUST replace inherited resources.
    value.insert("autoload".into(), json!(true));
    for kind in ["extensions", "skills", "prompts", "themes"] {
        value.insert(kind.into(), json!([]));
    }
    Value::Object(value)
}

pub(crate) fn pi_installed_root(source: &str, base: &Path, home: &Path) -> Result<PathBuf, String> {
    let root = if let Some(spec) = source.strip_prefix("npm:") {
        let spec = spec.trim();
        let name = spec
            .rfind('@')
            .filter(|index| *index > 0)
            .map(|index| &spec[..index])
            .unwrap_or(spec);
        let parts: Vec<_> = name.split('/').collect();
        if name.is_empty()
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"@._-/".contains(&c))
            || parts.iter().any(|part| matches!(*part, "" | "." | ".."))
            || (name.starts_with('@') && parts.len() != 2)
            || (!name.starts_with('@') && parts.len() != 1)
        {
            return Err("Pi npm 来源无法安全解析，请用原生 CLI 管理".into());
        }
        base.join("npm/node_modules").join(name)
    } else if source.starts_with("git:")
        || source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("ssh://")
    {
        let source = if source.starts_with("git://") {
            source
        } else {
            source.strip_prefix("git:").unwrap_or(source)
        }
        .trim();
        let (host, path) = if let Some(scp) = source.strip_prefix("git@") {
            let (host, path) = scp.split_once(':').ok_or("Pi Git SSH 来源格式未识别")?;
            (host.to_owned(), path.to_owned())
        } else if source.contains("://") {
            let value = url::Url::parse(source).map_err(|_| "Pi Git URL 格式未识别")?;
            (
                value.host_str().ok_or("Pi Git URL 缺少主机")?.to_owned(),
                value.path().trim_start_matches('/').to_owned(),
            )
        } else {
            let expanded = source
                .strip_prefix("github:")
                .map(|path| format!("github.com/{path}"))
                .or_else(|| {
                    source
                        .strip_prefix("gitlab:")
                        .map(|path| format!("gitlab.com/{path}"))
                })
                .or_else(|| {
                    source
                        .strip_prefix("bitbucket:")
                        .map(|path| format!("bitbucket.org/{path}"))
                })
                .unwrap_or_else(|| source.into());
            let (host, path) = expanded.split_once('/').ok_or("Pi Git 简写格式未识别")?;
            if !host.contains('.') && host != "localhost" {
                return Err("Pi Git 简写的原生安装路径尚未核验".into());
            }
            (host.to_owned(), path.to_owned())
        };
        let path = path
            .split(['@', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches(".git");
        if host.is_empty()
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            || path.split('/').count() < 2
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            || path
                .bytes()
                .any(|c| c.is_ascii_control() || b"\\:%?#".contains(&c))
        {
            return Err("Pi Git 来源安装路径无法安全解析".into());
        }
        base.join("git").join(host).join(path)
    } else if let Some(rest) = source
        .strip_prefix("~/")
        .or_else(|| source.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        local_root(source, base).unwrap_or_else(|| base.join(source))
    };
    if !root.exists() {
        return Err("Pi 安装目录未找到；旧全局 npm/custom package-manager 路径须先由原生 CLI 迁移，当前条目只读".into());
    }
    Ok(root)
}

pub(crate) fn pi_manifest_resources(
    entry: &mut PluginEntry,
    manifest: Option<&Value>,
) -> Result<(), String> {
    let Some(root) = entry.root.as_ref().map(PathBuf::from) else {
        return Err("没有可核验的 Pi 包目录".into());
    };
    let Some(manifest) = manifest.and_then(|value| value.get("pi")) else {
        owned_resources(entry);
        return Ok(());
    };
    let canonical_root = root.canonicalize().map_err(|_| "Pi 包目录不可读取")?;
    for kind in ["extensions", "skills", "prompts", "themes"] {
        let Some(patterns) = manifest.get(kind) else {
            continue;
        };
        for pattern in patterns.as_array().ok_or("Pi manifest 资源字段不是数组")? {
            let pattern = pattern.as_str().ok_or("Pi manifest 资源路径不是字符串")?;
            if pattern.starts_with(['!', '+', '-']) {
                continue;
            } // filters do not introduce owned files
            if Path::new(pattern).is_absolute()
                || pattern.split(['/', '\\']).any(|part| part == "..")
                || pattern.contains(['{', '}', '(', ')'])
            {
                return Err("Pi manifest 含包外路径或未核验的 glob 语法，已限制管理".into());
            }
            let expression = format!(
                "{}/{}",
                glob::Pattern::escape(&root.to_string_lossy().replace('\\', "/")),
                pattern.replace('\\', "/")
            );
            for path in glob::glob(&expression)
                .map_err(|_| "Pi manifest glob 无法解析")?
                .take(20001)
            {
                let path = path.map_err(|_| "Pi manifest 资源不可读取")?;
                let canonical = path
                    .canonicalize()
                    .map_err(|_| "Pi manifest 资源不可读取")?;
                if !canonical.starts_with(&canonical_root) {
                    return Err("Pi manifest 资源链接到包外，已限制管理".into());
                }
                if entry.resources.len() >= 20000 {
                    return Err("Pi manifest 资源超过检查上限".into());
                }
                if !entry.resources.iter().any(|resource| {
                    resource.kind == kind && resource.path == path.display().to_string()
                }) {
                    entry.resources.push(PluginResource {
                        kind: kind.into(),
                        path: path.display().to_string(),
                        owner_id: entry.id.clone(),
                    });
                }
            }
        }
    }
    Ok(())
}
