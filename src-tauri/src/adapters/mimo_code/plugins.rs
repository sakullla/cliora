//! MiMo Code plugin declarations.
//!
//! [src] Evidence: XiaomiMiMo/MiMo-Code 0.1.15 `packages/cli/src/config/plugin.ts`
//! — the config `plugin` key holds `Spec` entries (plain string or
//! `[string, options]` tuple) and each config directory auto-discovers
//! `{plugin,plugins}/*.{ts,js}`; `packages/cli/src/plugin/install.ts` —
//! `mimo plugin <module> [-g]` resolves the npm package and patches that same
//! array (project writes land in `<root>/.mimocode`); `packages/cli/src/plugin/
//! loader.ts` — `resolve` installs npm plugins on demand through
//! `resolvePluginTarget` before import, so a declaration alone is enough for
//! the CLI to fetch dependencies at load. Dependencies live in the config
//! directory `node_modules` (`~/.config/mimocode/package.json`).
use super::{config_dir, settings_file, MiMoCode};
use crate::adapters::plugins::{local_root, npm_metadata, PluginAdapter, PluginCapability};
use crate::native::adapter::Scope;
use crate::native::format::FileKind;
use crate::resources::plugins::{project, PluginEntry, PluginTarget};
use std::path::{Path, PathBuf};

impl PluginAdapter for MiMoCode {
    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: "0.1.15",
            sources: "npm 包@版本或 file:///绝对路径",
            actions: vec!["install", "enable", "disable", "uninstall"],
            project: true,
            detail: "维护配置文件 plugin 数组声明；npm 依赖由 CLI 在加载时按需安装，是否安装成功以原生会话为准。{plugin,plugins}/*.ts|js 自动发现目录只读。更新请卸载后安装新版本。重启会话加载。",
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
        npm_metadata(root)
    }
    fn config_field(&self) -> Option<&'static str> {
        Some("plugin")
    }
    fn config_only(&self, _action: &str, _entry: Option<&PluginEntry>) -> bool {
        true
    }
    fn config_location(
        &self,
        home: &Path,
        target: &PluginTarget,
    ) -> Result<Option<(PathBuf, FileKind)>, String> {
        // Project scope never exposes a managed settings file (native_files
        // stays empty), so the plugin document must resolve directly.
        let dir = match target.scope {
            Scope::Global => config_dir(home),
            Scope::Project => project(target)?.ok_or("请选择项目")?.join(".mimocode"),
        };
        let (path, kind) = settings_file(&dir);
        Ok(Some((path, kind)))
    }
    fn resolve_root(
        &self,
        source: &str,
        base: &Path,
        home: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if let Some(root) = local_root(source, base) {
            return Ok(Some(root));
        }
        let Some(name) = npm_package_name(source) else {
            return Ok(None);
        };
        let root = config_dir(home).join("node_modules").join(name);
        // A declared-but-not-yet-loaded npm plugin simply has no package on
        // disk yet; the loader installs it on demand, so this stays optional.
        Ok(root.is_dir().then_some(root))
    }
    fn discover(
        &self,
        home: &Path,
        target: &PluginTarget,
        _path: &Path,
    ) -> Result<Vec<PluginEntry>, String> {
        let dir = match target.scope {
            Scope::Global => config_dir(home),
            Scope::Project => project(target)?.ok_or("请选择项目")?.join(".mimocode"),
        };
        let mut result = Vec::new();
        for folder in ["plugin", "plugins"] {
            let dir = dir.join(folder);
            if !dir.is_dir() {
                continue;
            }
            for file in std::fs::read_dir(&dir).map_err(|_| "无法读取自动发现插件目录")? {
                let file = file.map_err(|_| "读取插件失败")?;
                let path = file.path();
                if !path.extension().is_some_and(|ext| ext == "ts" || ext == "js") {
                    continue;
                }
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
        Ok(result)
    }
}

/// The npm package name of `pkg`, `pkg@1.2.3`, `@scope/pkg` or
/// `@scope/pkg@1.2.3`. Path-like, URL and otherwise untrusted sources never
/// resolve into `node_modules`.
fn npm_package_name(spec: &str) -> Option<&str> {
    let spec = spec.trim();
    if spec.is_empty()
        || spec.contains(':')
        || spec.starts_with('.')
        || spec.starts_with('/')
        || spec.starts_with('\\')
    {
        return None;
    }
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
        return None;
    }
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::plugins::PluginTarget;

    fn target(scope: Scope, project_path: Option<&str>) -> PluginTarget {
        PluginTarget {
            tool_id: "mimo_code".into(),
            scope,
            project_path: project_path.map(str::to_owned),
            context_id: None,
        }
    }

    #[test]
    fn npm_package_names_strip_versions_and_reject_untrusted_sources() {
        assert_eq!(npm_package_name("pkg"), Some("pkg"));
        assert_eq!(npm_package_name("pkg@1.2.3"), Some("pkg"));
        assert_eq!(npm_package_name("@scope/pkg"), Some("@scope/pkg"));
        assert_eq!(npm_package_name("@scope/pkg@1.2.3"), Some("@scope/pkg"));
        assert_eq!(npm_package_name("chrome-devtools-mcp@latest"), Some("chrome-devtools-mcp"));
        assert_eq!(npm_package_name("@scope"), None);
        assert_eq!(npm_package_name("file:///tmp/x"), None);
        assert_eq!(npm_package_name("./relative"), None);
        assert_eq!(npm_package_name("/abs/path"), None);
        assert_eq!(npm_package_name("C:\\abs\\path"), None);
        assert_eq!(npm_package_name("git+ssh://host/repo"), None);
        assert_eq!(npm_package_name("has space"), None);
    }

    #[test]
    fn capability_declares_config_only_management_for_both_scopes() {
        let capability = MiMoCode.capability();
        assert_eq!(capability.version, "0.1.15");
        assert!(capability.project);
        assert_eq!(
            capability.actions,
            vec!["install", "enable", "disable", "uninstall"]
        );
        assert_eq!(MiMoCode.config_field(), Some("plugin"));
        assert!(MiMoCode.config_only("install", None));
        assert!(MiMoCode.config_only("uninstall", None));
        assert!(MiMoCode.command_args("install", "pkg", false).is_err());
    }

    #[test]
    fn config_location_follows_the_native_settings_document() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let (global, kind) = MiMoCode
            .config_location(home, &target(Scope::Global, None))
            .unwrap()
            .unwrap();
        assert!(global.ends_with("mimocode.jsonc"), "{global:?}");
        assert_eq!(kind, FileKind::Jsonc);
        let work = temp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let (project_file, _) = MiMoCode
            .config_location(
                home,
                &target(Scope::Project, Some(work.to_str().unwrap())),
            )
            .unwrap()
            .unwrap();
        let expected = work.join(".mimocode").join("mimocode.jsonc");
        assert_eq!(project_file, expected);
    }

    #[test]
    fn resolve_root_maps_npm_specs_to_the_config_node_modules() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let base = config_dir(home);
        let local = home.join("local-plugin");
        assert_eq!(
            MiMoCode
                .resolve_root(&local.display().to_string(), &base, home)
                .unwrap(),
            Some(local)
        );
        assert_eq!(MiMoCode.resolve_root("pkg@1.0.0", &base, home).unwrap(), None);
        let installed = base.join("node_modules").join("@scope").join("pkg");
        std::fs::create_dir_all(&installed).unwrap();
        assert_eq!(
            MiMoCode.resolve_root("@scope/pkg@1.0.0", &base, home).unwrap(),
            Some(installed)
        );
        assert_eq!(MiMoCode.resolve_root("git+ssh://x/y", &base, home).unwrap(), None);
    }

    #[test]
    fn discover_lists_auto_plugin_files_and_ignores_other_names() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let root = config_dir(home);
        for path in [
            root.join("plugin/local.ts"),
            root.join("plugins/second.js"),
            root.join("plugins/readme.md"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "// fixture").unwrap();
        }
        let entries = MiMoCode
            .discover(home, &target(Scope::Global, None), &root.join("mimocode.jsonc"))
            .unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries.iter().all(|entry| entry.read_only));
        assert!(entries.iter().all(|entry| entry.scope == "auto"));
        assert!(entries.iter().any(|entry| entry.name == "local.ts"));
        assert!(entries.iter().any(|entry| entry.name == "second.js"));
        assert!(entries.iter().all(|entry| entry.id.starts_with("auto:")));
    }
}
