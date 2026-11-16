//! OMP plugins through the native `omp plugin` contract.
//!
//! `omp plugin` is the only writer. The adapter never fabricates
//! `omp-plugins.lock.json`, package manifests or installed registries. Native
//! operations are not transactional (the lock file has no cross-process lock
//! and uninstall/link roll back best effort), so a scan always reads the
//! current project/user roots, lock files, registries, caches and project
//! overrides, and reports residual or drifted state instead of assuming the
//! last command was atomic.
//!
//! Native shape verified against OMP 18.20.2 in an isolated HOME:
//! `plugin list --json` returns `{ npm: [...], marketplace: [...] }`; npm rows
//! carry `name/version/path/manifest/enabledFeatures/enabled`, marketplace rows
//! carry `id/scope/entries[]/shadowedBy?`; `plugin doctor --json` returns checks
//! including `orphan:<package>` and version drift.
//!
//! Ownership: npm, Git and local `link` installs are user-scope; marketplace
//! installs support `--scope project`. A project page therefore reads user
//! plugins but cannot operate them, and project-only overrides stay read-only.
//! Plugin-owned Skills, Agents and MCP are listed as read-only package
//! resources; uninstall targets one native plugin and never another scope.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::adapters::plugins::{PluginAdapter, PluginCapability};
use crate::native::adapter::Scope;
use crate::resources::plugins::{PluginEntry, PluginResource, PluginTarget};

use super::mcp::{omp_config_root, project_config_directory};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP 插件（npm/git/本地 link/marketplace、启停与部分失败重扫）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可通过 omp plugin 原生契约管理已核实的插件来源、作用域、启停与 doctor 恢复";

/// Native health-check action published to the shared plugin workspace. The
/// action needs a writable entry for the shared service's baseline check; the
/// supplement publishes [`DOCTOR_SOURCE`] only while it detects an inconsistency.
pub(crate) const DOCTOR_ACTION: &str = "doctor";
pub(crate) const DOCTOR_SOURCE: &str = "doctor:omp";

struct OmpPlugins;

static PORT: OmpPlugins = OmpPlugins;

pub(crate) fn port() -> Option<&'static dyn PluginAdapter> {
    Some(&PORT)
}

/// Plugin management follows the port's action set; the composition root never
/// stores a plugin capability literal.
pub(crate) fn management_visible(port: Option<&dyn PluginAdapter>) -> bool {
    port.is_some_and(|adapter| !adapter.capability().actions.is_empty())
}

pub(crate) fn project_visible(port: Option<&dyn PluginAdapter>) -> bool {
    port.is_some_and(|adapter| adapter.capability().project)
}

pub(crate) fn facet() -> crate::adapters::Facet {
    match port() {
        Some(active) if management_visible(Some(active)) => crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

// =============================================================================
// Native paths
// =============================================================================

/// OMP's plugin root is `<PI_CONFIG_DIR or .omp>/plugins`; unlike `agent/` it
/// is not profile-scoped, so every profile shares installed plugins.
pub(crate) fn user_plugins_root(home: &Path) -> PathBuf {
    omp_config_root(home).join("plugins")
}

/// Project runtime root used by marketplace `--scope project` installs and
/// project npm/link installs. OMP never walks to a parent `.omp` for writes.
pub(crate) fn project_plugins_root(project: &Path) -> PathBuf {
    project_config_directory(project).join("plugins")
}

fn project_path(target: &PluginTarget) -> Result<Option<&Path>, String> {
    if target.scope == Scope::Global {
        return Ok(None);
    }
    let project = target.project_path.as_deref().ok_or("请选择项目")?;
    Ok(Some(Path::new(project)))
}

fn lock_path(root: &Path) -> PathBuf {
    root.join("omp-plugins.lock.json")
}

fn installed_registry_path(root: &Path) -> PathBuf {
    root.join("installed_plugins.json")
}

fn project_overrides_path(project: &Path) -> PathBuf {
    project_config_directory(project).join("plugin-overrides.json")
}

// =============================================================================
// Capability and native command surface
// =============================================================================

impl PluginAdapter for OmpPlugins {
    fn version_policy(&self) -> crate::adapters::version::VersionPolicy {
        super::lifecycle::version_policy()
    }

    fn capability(&self) -> PluginCapability {
        PluginCapability {
            version: super::lifecycle::BASELINE,
            sources: "npm 包@版本、GitHub/Git URL、本地目录（link）、marketplace name@marketplace；安装可带 pkg[feature] 功能选择",
            actions: vec![
                "install",
                "update",
                "enable",
                "disable",
                "uninstall",
                DOCTOR_ACTION,
            ],
            project: true,
            detail: "经 omp plugin 原生命令管理。npm/Git/本地 link 是用户级安装；marketplace 支持 --scope project，项目副本会遮蔽同一 ID 的用户副本。命令非事务：失败、取消或部分失败可能留下包、锁文件与缓存；每次操作后重新扫描并显示实际状态，doctor 会检查并修复可识别的残留。重启 OMP 会话后加载。",
        }
    }

    fn command_args(
        &self,
        action: &str,
        source: &str,
        project: bool,
    ) -> Result<Vec<String>, String> {
        if action == DOCTOR_ACTION {
            if project {
                return Err(
                    "omp plugin doctor 只检查用户插件根；项目插件请在项目作用域用原生 install/upgrade/uninstall 处理".into(),
                );
            }
            return Ok(vec![
                "plugin".into(),
                "doctor".into(),
                "--fix".into(),
                "--json".into(),
            ]);
        }
        let scope = if project {
            // Only an install has no scanned entry to prove its scope. Other
            // actions reach here only for writable project rows (user and npm
            // rows are read-only), so the entry itself carries the evidence.
            if action == "install" && !is_marketplace_source(source) {
                return Err(
                    "OMP 项目作用域只支持 marketplace 插件安装（name@marketplace）；npm/Git/本地 link 是用户级安装，请在全局作用域操作"
                        .into(),
                );
            }
            vec!["--scope".to_owned(), "project".to_owned()]
        } else {
            Vec::new()
        };
        let mut args: Vec<String> = match action {
            "install" => vec!["plugin".into(), "install".into(), source.into()],
            "update" => vec!["plugin".into(), "upgrade".into(), source.into()],
            "uninstall" => vec!["plugin".into(), "uninstall".into(), source.into()],
            "enable" => vec!["plugin".into(), "enable".into(), source.into()],
            "disable" => vec!["plugin".into(), "disable".into(), source.into()],
            _ => return Err("不支持的 OMP 插件操作".into()),
        };
        args.push("--json".into());
        args.extend(scope);
        Ok(args)
    }

    fn parse_list(&self, value: &Value, target: &PluginTarget) -> Result<Vec<PluginEntry>, String> {
        let object = value
            .as_object()
            .ok_or("OMP 插件列表不是对象；未解释为无插件")?;
        let npm = object
            .get("npm")
            .and_then(Value::as_array)
            .ok_or("OMP 插件列表缺少 npm 数组；未解释为无插件")?;
        let marketplace = object
            .get("marketplace")
            .and_then(Value::as_array)
            .ok_or("OMP 插件列表缺少 marketplace 数组；未解释为无插件")?;
        let mut entries = Vec::new();
        for row in npm {
            entries.push(npm_entry(row, target)?);
        }
        for row in marketplace {
            let scope = row.get("scope").and_then(Value::as_str).unwrap_or("");
            if target.scope == Scope::Global && scope != "user" {
                // A global run has no project context; a project registry row
                // belongs to that project page only.
                continue;
            }
            if let Some(entry) = marketplace_entry(row, target)? {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn snapshot_files(&self, home: &Path, target: &PluginTarget) -> Vec<PathBuf> {
        let user = user_plugins_root(home);
        let mut paths = vec![
            user.join("package.json"),
            lock_path(&user),
            installed_registry_path(&user),
            omp_config_root(home).join("marketplaces.json"),
        ];
        if let Ok(Some(project)) = project_path(target) {
            let project_root = project_plugins_root(project);
            paths.extend([
                project_root.join("package.json"),
                lock_path(&project_root),
                installed_registry_path(&project_root),
                project_overrides_path(project),
            ]);
        }
        paths
    }

    fn supplement(
        &self,
        home: &Path,
        target: &PluginTarget,
        entries: &mut Vec<PluginEntry>,
    ) -> Result<(), String> {
        let project = project_path(target)?.map(Path::to_path_buf);
        let project_page = project.is_some();
        let user_root = user_plugins_root(home);
        let identities: Vec<Option<String>> = entries.iter().map(package_name_of).collect();
        let had_installed_entries = entries.iter().any(|entry| {
            entry
                .root
                .as_deref()
                .is_some_and(|root| Path::new(root).exists())
        });
        let mut issues: Vec<String> = Vec::new();

        // Lock files are the native runtime state. A lock key without a matching
        // installed row is the residual a deleted link leaves behind; a version
        // mismatch is cache drift. Neither is rewritten here.
        let user_lock_file = lock_path(&user_root);
        let project_lock_file = project
            .as_ref()
            .map(|project| lock_path(&project_plugins_root(project)));
        let user_lock = read_lock(&user_lock_file, &mut issues);
        let project_lock = match &project_lock_file {
            Some(path) => read_lock(path, &mut issues),
            None => Vec::new(),
        };
        let user_lock_present = user_lock_file.exists();
        let project_lock_present = project_lock_file.as_ref().is_some_and(|path| path.exists());

        for row in &user_lock {
            if !lock_has_entry(&identities, entries, "user", &row.name) {
                issues.push(format!("用户锁文件仍记录 {}，磁盘插件不存在", row.name));
                entries.push(orphan_entry(row, "user", false));
            }
        }
        if project.is_some() {
            for row in &project_lock {
                if !lock_has_entry(&identities, entries, "project", &row.name) {
                    issues.push(format!("项目锁文件仍记录 {}，磁盘插件不存在", row.name));
                    entries.push(orphan_entry(row, "project", true));
                }
            }
        }

        for (index, entry) in entries.iter_mut().enumerate() {
            let Some(name) = identities
                .get(index)
                .and_then(|identity| identity.as_deref())
            else {
                continue;
            };
            let (lock, lock_present) = if entry.scope == "project" {
                (&project_lock, project_lock_present)
            } else {
                (&user_lock, user_lock_present)
            };
            let project_scope = entry.scope == "project";
            let Some(record) = lock.iter().find(|row| row.name == name) else {
                if lock_present {
                    entry.policy.push_str(if project_scope {
                        " · 项目锁文件没有记录此安装（残留或缓存漂移）；请在项目作用域用原生 install/upgrade 处理"
                    } else if project_page {
                        " · 原生锁文件没有记录此安装（残留或缓存漂移）；请在全局作用域运行 doctor"
                    } else {
                        " · 原生锁文件没有记录此安装（残留或缓存漂移）；doctor 可检查"
                    });
                    issues.push(format!("{name} 未记录在原生锁文件"));
                }
                continue;
            };
            if let (Some(installed), Some(recorded)) =
                (entry.version.as_deref(), record.version.as_deref())
            {
                if installed != recorded {
                    entry.policy.push_str(&if project_scope {
                        format!(
                            " · 锁记录 v{recorded}，磁盘 v{installed}（版本漂移）；请在项目作用域用原生 install/upgrade 重新同步"
                        )
                    } else if project_page {
                        format!(
                            " · 锁记录 v{recorded}，磁盘 v{installed}（版本漂移）；请在全局作用域运行 doctor 或重新安装"
                        )
                    } else {
                        format!(
                            " · 锁记录 v{recorded}，磁盘 v{installed}（版本漂移）；doctor 可检查或重新安装"
                        )
                    });
                    issues.push(format!(
                        "{name} 锁与磁盘版本不一致（{recorded} → {installed}）"
                    ));
                }
            }
            if let Some(enabled) = record.enabled {
                // Marketplace enablement lives in its installed registry; only
                // npm/link rows resolve enablement from this lock entry.
                if !is_marketplace_id(&entry.id)
                    && entry.enabled != Some(enabled)
                    && entry.state != "not_installed"
                {
                    entry.policy.push_str(&format!(
                        " · 原生锁启用状态为 {}（可能与其他作用域或缓存状态不同）",
                        if enabled { "启用" } else { "禁用" }
                    ));
                }
            }
            if is_marketplace_id(&entry.id) {
                if let Some(features) = record
                    .enabled_features
                    .as_ref()
                    .filter(|features| !features.is_empty())
                {
                    entry
                        .policy
                        .push_str(&format!(" · 原生锁功能：{}", features.join(", ")));
                }
            }
        }

        // A lock-only npm row is a local link: OMP records it in the runtime
        // lock without a package.json dependency, and its native upgrade
        // refuses local paths. Say so instead of offering an update that cannot
        // work, while keeping disable/uninstall available.
        for (index, entry) in entries.iter_mut().enumerate() {
            let Some(name) = identities
                .get(index)
                .and_then(|identity| identity.as_deref())
            else {
                continue;
            };
            if is_marketplace_id(&entry.id) {
                continue;
            }
            let root = if entry.scope == "project" {
                project
                    .as_ref()
                    .map(|project| project_plugins_root(project))
            } else {
                Some(user_root.clone())
            };
            let Some(root) = root else {
                continue;
            };
            if !package_dependencies(&root).contains(name) {
                entry.policy.push_str(
                    " · 包清单无依赖（本地 link 或安装残留）；原生 upgrade 可能拒绝，重新 link 或 install 更新",
                );
            }
        }

        // Project overrides are read by the OMP runtime but never written by the
        // plugin CLI. They therefore remain read-only here.
        if let Some(project) = &project {
            apply_project_overrides(entries, project, &mut issues)?;
        }

        // A package row whose install path disappeared cannot load. Report the
        // cache drift instead of showing it as a healthy installation.
        for entry in entries.iter_mut() {
            let Some(root) = entry.root.as_deref() else {
                continue;
            };
            if !Path::new(root).exists() {
                entry.state = "not_installed".into();
                if is_marketplace_id(&entry.id) {
                    // The native registry still makes `uninstall --scope ...`
                    // available; parse_list already reported the missing cache.
                    continue;
                }
                entry.read_only = true;
                entry.policy.push_str(if entry.scope == "project" {
                    " · 项目安装目录不存在（缓存漂移）；请在项目作用域用原生 install/upgrade 处理"
                } else if project_page {
                    " · 原生安装目录不存在（缓存漂移）；请在全局作用域运行 doctor"
                } else {
                    " · 原生安装目录不存在（缓存漂移）；doctor 可检查"
                });
                issues.push(format!("{} 的安装目录不存在", entry.name));
            }
        }

        // A marketplace registry entry can survive a deleted runtime link. The
        // cache may still exist, so a missing link is the visible partial-link
        // failure; the native uninstall/install commands remain available.
        for entry in entries
            .iter_mut()
            .filter(|entry| is_marketplace_id(&entry.id))
        {
            let Some(root) = entry.root.as_deref() else {
                continue;
            };
            if !Path::new(root).exists() {
                continue;
            }
            let Some(name) = package_name_of(entry) else {
                continue;
            };
            let link_root = if entry.scope == "project" {
                project
                    .as_ref()
                    .map(|project| project_plugins_root(project))
            } else {
                Some(user_root.clone())
            };
            let Some(link_root) = link_root else {
                continue;
            };
            if !link_root.join("node_modules").join(&name).exists() {
                entry.policy.push_str(if entry.scope == "project" {
                    " · 项目运行时链接不存在（link/缓存部分失败）；可重新 install --scope project 或卸载移除记录"
                } else if project_page {
                    " · 用户运行时链接不存在（link/缓存部分失败）；请在全局作用域重新安装或卸载"
                } else {
                    " · 用户运行时链接不存在（link/缓存部分失败）；可重新 install/upgrade 或卸载移除记录"
                });
            }
        }

        // The native runtime gives a project copy precedence over a user copy
        // with the same marketplace ID. Keep only the project row so the shared
        // duplicate-ID guard cannot make the writable project copy read-only;
        // the project row carries the user-copy state and scope guidance.
        if project.is_some() {
            collapse_project_shadows(entries);
        }

        // `doctor` check 3: installed user plugins without node_modules.
        if had_installed_entries
            && !user_root.join("node_modules").exists()
            && entries.iter().any(|entry| entry.scope == "user")
        {
            issues.push("用户插件 node_modules 缺失".into());
        }

        // doctor is delivered only for the user root: `omp plugin doctor` has no
        // project scope. Project residuals stay visible read-only with native
        // recovery guidance instead of a misleading fix button.
        if project.is_none() && !issues.is_empty() {
            entries.push(doctor_entry(&issues));
        }
        Ok(())
    }

    fn fill_missing_resources(&self, entry: &mut PluginEntry) -> Result<(), String> {
        let Some(root) = entry.root.as_deref().map(PathBuf::from) else {
            return Ok(());
        };
        if !root.is_dir() {
            return Ok(());
        }
        let manifest = package_manifest(&root);
        // A malformed or escaping manifest path only marks this entry; it must
        // never fail the whole snapshot and hide every other plugin.
        add_owned_resources(entry, &root, manifest.as_ref(), None);
        Ok(())
    }
}

// =============================================================================
// List parsing
// =============================================================================

fn npm_entry(row: &Value, target: &PluginTarget) -> Result<PluginEntry, String> {
    let name = row
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or("OMP npm 插件条目缺少包名；请使用原生 CLI 检查")?;
    let version = row
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let root = row.get("path").and_then(Value::as_str).map(str::to_owned);
    let enabled = row
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or("OMP npm 插件条目缺少启用状态；未猜测为启用")?;
    let manifest = row.get("manifest").filter(|value| value.is_object());
    let display = manifest
        .and_then(|manifest| manifest.get("name"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(name)
        .to_owned();
    let missing = root.as_deref().is_none_or(|root| !Path::new(root).exists());
    let project_read_only = target.scope == Scope::Project;
    let mut entry = PluginEntry {
        id: name.to_owned(),
        name: display,
        source: name.to_owned(),
        version,
        scope: "user".into(),
        enabled: Some(enabled),
        state: if missing {
            "not_installed"
        } else if enabled {
            "installed_load_unknown"
        } else {
            "disabled"
        }
        .into(),
        policy: "npm/Git/本地 link 安装；启用与功能状态由原生锁文件管理".into(),
        read_only: missing || project_read_only,
        root,
        resources: Vec::new(),
    };
    if missing {
        entry.policy.push_str(if project_read_only {
            " · 安装目录不存在（缓存漂移）；请在全局作用域运行 doctor"
        } else {
            " · 安装目录不存在（缓存漂移）；doctor 可检查"
        });
    }
    if project_read_only {
        entry
            .policy
            .push_str(" · 用户级安装，项目页只读；请在全局作用域管理");
    }
    apply_feature_policy(&mut entry, row.get("enabledFeatures"), manifest);
    let root = entry.root.clone().unwrap_or_default();
    let enabled_features: Option<Vec<String>> = row
        .get("enabledFeatures")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        });
    add_owned_resources(
        &mut entry,
        Path::new(&root),
        manifest,
        enabled_features.as_deref(),
    );
    Ok(entry)
}

fn marketplace_entry(row: &Value, target: &PluginTarget) -> Result<Option<PluginEntry>, String> {
    let id = row
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or("OMP marketplace 插件条目缺少 ID；请使用原生 CLI 检查")?;
    let scope = row
        .get("scope")
        .and_then(Value::as_str)
        .ok_or("OMP marketplace 插件条目缺少作用域")?;
    if !matches!(scope, "user" | "project") {
        return Err(format!("OMP marketplace 插件作用域未知：{scope}"));
    }
    let entries = row
        .get("entries")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty())
        .ok_or("OMP marketplace 插件条目缺少安装记录")?;
    let first = &entries[0];
    let version = first
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let install_path = first
        .get("installPath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let enabled = first
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let shadowed = row.get("shadowedBy").and_then(Value::as_str) == Some("project");
    let missing = install_path
        .as_deref()
        .is_none_or(|root| !Path::new(root).exists());
    let project_read_only = target.scope == Scope::Project && scope == "user";
    let mut entry = PluginEntry {
        id: id.to_owned(),
        name: id.to_owned(),
        source: id.to_owned(),
        version,
        scope: scope.to_owned(),
        enabled: Some(enabled),
        state: if missing {
            "not_installed"
        } else if enabled {
            "installed_load_unknown"
        } else {
            "disabled"
        }
        .into(),
        policy: "原生 marketplace 安装；启用状态由原生注册表与缓存管理".into(),
        // A missing cache directory still has a native registry entry, and
        // `omp plugin uninstall <id> --scope ...` can remove that record even
        // when the cache is gone (verified with isolated OMP). Keep it
        // operable for cleanup; only a user row viewed from a project page is
        // scope read-only.
        read_only: project_read_only,
        root: install_path,
        resources: Vec::new(),
    };
    if missing {
        entry.policy.push_str(if scope == "project" {
            " · 项目缓存目录不存在（缓存漂移）；可卸载移除原生注册表/锁记录，或重新 install --scope project"
        } else if target.scope == Scope::Project {
            " · 原生缓存目录不存在（缓存漂移）；请在全局作用域卸载或重新安装"
        } else {
            " · 原生缓存目录不存在（缓存漂移）；可卸载移除注册表/锁记录或重新安装"
        });
    }
    if project_read_only {
        entry
            .policy
            .push_str(" · 用户作用域安装，项目页只读；请在全局作用域管理");
    }
    if shadowed {
        entry.policy.push_str(
            " · 被同 ID 的项目副本遮蔽，运行时优先使用项目副本；此处保留为用户作用域记录",
        );
    }
    let root = entry.root.clone();
    if let Some(root) = root.as_deref() {
        let root = Path::new(root);
        let manifest = package_manifest(root);
        add_owned_resources(&mut entry, root, manifest.as_ref(), None);
    }
    Ok(Some(entry))
}

fn apply_feature_policy(
    entry: &mut PluginEntry,
    features: Option<&Value>,
    manifest: Option<&Value>,
) {
    let Some(features) = features else {
        if manifest
            .and_then(|manifest| manifest.get("features"))
            .and_then(Value::as_object)
            .is_some_and(|features| !features.is_empty())
        {
            entry.policy.push_str(" · 原生功能：默认集");
        }
        return;
    };
    if features.is_null() {
        entry.policy.push_str(" · 原生功能：默认集");
    } else if let Some(items) = features.as_array() {
        if items.is_empty() {
            entry.policy.push_str(" · 原生功能：未启用可选功能");
        } else {
            let names: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
            entry
                .policy
                .push_str(&format!(" · 原生功能：{}", names.join(", ")));
        }
    }
}

// =============================================================================
// Ownership: resources, locks, overrides
// =============================================================================

fn package_manifest(root: &Path) -> Option<Value> {
    if root.as_os_str().is_empty() {
        return None;
    }
    let text = std::fs::read_to_string(root.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("omp")
        .or_else(|| value.get("pi"))
        .filter(|value| value.is_object())
        .cloned()
        .or_else(|| {
            // Agent Plugins packages have a separate closed manifest.
            [
                "plugin.json",
                ".omp-plugin/plugin.json",
                ".claude-plugin/plugin.json",
            ]
            .iter()
            .find_map(|relative| {
                std::fs::read_to_string(root.join(relative))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .filter(Value::is_object)
            })
        })
}

fn package_dependencies(root: &Path) -> BTreeSet<String> {
    let Ok(text) = std::fs::read_to_string(root.join("package.json")) else {
        return BTreeSet::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return BTreeSet::new();
    };
    value
        .get("dependencies")
        .and_then(Value::as_object)
        .map(|dependencies| dependencies.keys().cloned().collect())
        .unwrap_or_default()
}

fn package_name_of(entry: &PluginEntry) -> Option<String> {
    if let Some(root) = entry.root.as_deref() {
        if let Ok(text) = std::fs::read_to_string(Path::new(root).join("package.json")) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(name) = value.get("name").and_then(Value::as_str) {
                    if !name.trim().is_empty() {
                        return Some(name.to_owned());
                    }
                }
            }
        }
    }
    // Marketplace IDs are `name@marketplace`; npm scoped packages keep one
    // leading `@`. This fallback keeps orphan matching useful when the cache
    // tree was deleted and only the registry is left.
    let base = entry
        .id
        .split_once('[')
        .map_or(entry.id.as_str(), |(base, _)| base);
    match base.rfind('@') {
        Some(index) if index > 0 => Some(base[..index].to_owned()),
        _ if !base.is_empty() => Some(base.to_owned()),
        _ => None,
    }
}

fn add_owned_resources(
    entry: &mut PluginEntry,
    root: &Path,
    manifest: Option<&Value>,
    enabled_features: Option<&[String]>,
) {
    if root.as_os_str().is_empty() || !root.is_dir() {
        return;
    }
    for (kind, relative) in [
        ("agents", "agents"),
        ("skills", "skills"),
        ("commands", "commands"),
        ("hooks", "hooks"),
        ("tools", "tools"),
        ("rules", "rules"),
        ("prompts", "prompts"),
        ("extensions", "extensions"),
        ("themes", "themes"),
        ("lsp", "lsp"),
        ("dap", "dap"),
    ] {
        let path = root.join(relative);
        if path.exists() {
            push_resource(entry, kind, path);
        }
    }
    for (kind, relative) in [("mcp", ".mcp.json"), ("mcp", "mcp.json")] {
        let path = root.join(relative);
        if path.is_file() {
            push_resource(entry, kind, path);
        }
    }
    let Some(manifest) = manifest.and_then(Value::as_object) else {
        return;
    };
    for (key, kind) in [
        ("tools", "tools"),
        ("hooks", "hooks"),
        ("commands", "commands"),
        ("extensions", "extensions"),
    ] {
        if let Some(value) = manifest.get(key) {
            add_manifest_paths(entry, root, kind, value);
        }
    }
    if let Some(features) = manifest.get("features").and_then(Value::as_object) {
        // `null` means the native default set; an array selects exactly those
        // features. Only enabled features can contribute owned resources.
        let selected: BTreeSet<&str> = match enabled_features {
            Some(items) => items.iter().map(String::as_str).collect(),
            None => features
                .iter()
                .filter(|(_, feature)| {
                    feature.get("default").and_then(Value::as_bool) == Some(true)
                })
                .map(|(name, _)| name.as_str())
                .collect(),
        };
        for (name, feature) in features {
            if !selected.contains(name.as_str()) {
                continue;
            }
            let Some(feature) = feature.as_object() else {
                continue;
            };
            for (key, kind) in [
                ("tools", "tools"),
                ("hooks", "hooks"),
                ("commands", "commands"),
                ("extensions", "extensions"),
            ] {
                if let Some(value) = feature.get(key) {
                    add_manifest_paths(entry, root, kind, value);
                }
            }
        }
    }
}

/// Add declared manifest paths without failing the snapshot. An escaping path
/// makes this one entry read-only and is reported in its policy; malformed
/// values or non-strings are warnings only, so one bad plugin package cannot
/// hide every other installed plugin or the doctor baseline.
fn add_manifest_paths(entry: &mut PluginEntry, root: &Path, kind: &str, value: &Value) {
    let items: Vec<&str> = match value {
        Value::String(item) => vec![item.as_str()],
        Value::Array(items) => {
            let mut paths = Vec::new();
            for item in items {
                match item.as_str() {
                    Some(item) => paths.push(item),
                    None => entry
                        .policy
                        .push_str(" · 插件清单资源数组含非字符串项，已忽略该项；请核对原生清单"),
                }
            }
            paths
        }
        _ => {
            entry
                .policy
                .push_str(" · 插件清单资源字段不是路径字符串/数组，已忽略；请核对原生清单");
            return;
        }
    };
    for item in items {
        let Some(relative) = safe_relative(item) else {
            entry.read_only = true;
            entry.policy.push_str(&format!(
                " · 插件清单资源路径 {item:?} 在包外，已忽略并限制管理"
            ));
            continue;
        };
        let path = root.join(relative);
        if path.exists() && !covered_by_resource_directory(entry, &path) {
            push_resource(entry, kind, path);
        }
    }
}

/// A conventional resource directory already enumerates its files; adding the
/// same manifest file again would list every item twice in the read-only view.
fn covered_by_resource_directory(entry: &PluginEntry, path: &Path) -> bool {
    entry.resources.iter().any(|resource| {
        let directory = Path::new(&resource.path);
        directory.is_dir() && path.starts_with(directory)
    })
}

fn safe_relative(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for component in path.components() {
        match component {
            // Manifest writers commonly use `./commands/x`; it stays inside.
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_os_string()),
            // A parent segment is allowed only while it still stays inside the
            // package; the first escape rejects the whole path.
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let mut relative = PathBuf::new();
    for part in parts {
        relative.push(part);
    }
    (!relative.as_os_str().is_empty()).then_some(relative)
}

fn push_resource(entry: &mut PluginEntry, kind: &str, path: PathBuf) {
    let path = path.display().to_string();
    if entry
        .resources
        .iter()
        .any(|resource| resource.kind == kind && resource.path == path)
    {
        return;
    }
    entry.resources.push(PluginResource {
        kind: kind.into(),
        path,
        owner_id: entry.id.clone(),
    });
}

struct LockRecord {
    name: String,
    version: Option<String>,
    enabled: Option<bool>,
    enabled_features: Option<Vec<String>>,
}

fn read_lock(path: &Path, issues: &mut Vec<String>) -> Vec<LockRecord> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => {
            // A damaged lock must not hide valid installed rows. Keep the issue
            // visible and let doctor's own result decide whether it can repair.
            issues.push(format!("原生锁文件 {} 不是有效 JSON", path.display()));
            return Vec::new();
        }
    };
    let Some(plugins) = value.get("plugins").and_then(Value::as_object) else {
        issues.push(format!("原生锁文件 {} 缺少 plugins 对象", path.display()));
        return Vec::new();
    };
    plugins
        .iter()
        .filter_map(|(name, state)| {
            let state = state.as_object()?;
            Some(LockRecord {
                name: name.clone(),
                version: state
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                enabled: state.get("enabled").and_then(Value::as_bool),
                enabled_features: state.get("enabledFeatures").and_then(Value::as_array).map(
                    |items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    },
                ),
            })
        })
        .collect()
}

fn lock_has_entry(
    identities: &[Option<String>],
    entries: &[PluginEntry],
    scope: &str,
    name: &str,
) -> bool {
    entries.iter().enumerate().any(|(index, entry)| {
        entry.scope == scope
            && (identities
                .get(index)
                .and_then(|identity| identity.as_deref())
                == Some(name)
                || entry.id == name
                || entry
                    .id
                    .rsplit_once('@')
                    .is_some_and(|(base, _)| base == name))
    })
}

fn orphan_entry(row: &LockRecord, scope: &str, project: bool) -> PluginEntry {
    PluginEntry {
        id: row.name.clone(),
        name: row.name.clone(),
        source: row.name.clone(),
        version: row.version.clone(),
        scope: scope.into(),
        enabled: row.enabled,
        state: "not_installed".into(),
        policy: if project {
            "项目锁文件仍记录此插件，但磁盘包不存在（残留或只删除了安装目录）。Cliora 不直接改写锁文件；请在原生 CLI 用 install --scope project 重新安装，或用 uninstall --scope project 移除记录。omp plugin doctor 只检查用户插件根。"
                .into()
        } else {
            "用户锁文件仍记录此插件，但磁盘包不存在（残留或只删除了安装目录）。运行 doctor 修复会清理可识别的锁残留，也可用原生 install/uninstall 重新安装或移除。"
                .into()
        },
        read_only: true,
        root: None,
        resources: Vec::new(),
    }
}

fn doctor_entry(issues: &[String]) -> PluginEntry {
    PluginEntry {
        id: DOCTOR_SOURCE.into(),
        name: "插件健康检查（omp plugin doctor）".into(),
        source: DOCTOR_SOURCE.into(),
        version: None,
        scope: "user".into(),
        enabled: None,
        // `not_installed` keeps the shared workspace from offering plugin
        // lifecycle buttons for a diagnostic row; the doctor action is its own.
        state: "not_installed".into(),
        policy: format!(
            "重扫发现原生插件状态问题：{}。运行 doctor 会重新核对用户插件目录、包清单、node_modules、锁文件、缺失包与版本漂移；它不保证回滚此前的部分变更，也不处理项目作用域或远程 marketplace。",
            issues.join("；")
        ),
        read_only: false,
        root: None,
        resources: Vec::new(),
    }
}

fn apply_project_overrides(
    entries: &mut [PluginEntry],
    project: &Path,
    issues: &mut Vec<String>,
) -> Result<(), String> {
    let path = project_overrides_path(project);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    if text.trim().is_empty() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| {
        issues.push(format!("项目插件覆盖 {} 不是有效 JSON", path.display()));
        "项目插件覆盖不是有效 JSON；请修复或移除后重新扫描".to_owned()
    })?;
    let disabled: BTreeSet<&str> = value
        .get("disabled")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let features = value.get("features").and_then(Value::as_object);
    for entry in entries.iter_mut() {
        let name = package_name_of(entry);
        let matches = name.as_deref().is_some_and(|name| disabled.contains(name))
            || disabled.contains(entry.id.as_str())
            || entry
                .id
                .rsplit_once('@')
                .is_some_and(|(base, _)| disabled.contains(base));
        if matches {
            entry.enabled = Some(false);
            entry.state = "disabled".into();
            entry.read_only = true;
            entry.policy.push_str(
                " · 项目覆盖 .omp/plugin-overrides.json 禁用；原生 CLI 不写此文件，项目页只读",
            );
            issues.push(format!("{} 被项目覆盖禁用", entry.id));
        }
        if let Some(name) = name.as_deref() {
            if let Some(features) = features
                .and_then(|features| features.get(name))
                .and_then(Value::as_array)
            {
                let names: Vec<&str> = features.iter().filter_map(Value::as_str).collect();
                entry
                    .policy
                    .push_str(&format!(" · 项目覆盖功能：{}", names.join(", ")));
            }
        }
    }
    Ok(())
}

/// Structural marketplace identity for an installed row (`name@marketplace`).
/// Unlike [`is_marketplace_source`] this is not an install-source heuristic:
/// npm rows are bare names or `@scope/name` with no non-leading `@`.
fn is_marketplace_id(value: &str) -> bool {
    value.rfind('@').is_some_and(|index| index > 0) && !value.contains(['/', '\\', ':'])
}

/// A project marketplace copy shadows the same user marketplace ID at runtime.
/// The shared snapshot's duplicate-ID guard cannot choose between them, so the
/// adapter removes the shadowed user row and records its state on the project
/// row. User-only rows stay visible read-only.
fn collapse_project_shadows(entries: &mut Vec<PluginEntry>) {
    let project_ids: BTreeSet<String> = entries
        .iter()
        .filter(|entry| entry.scope == "project" && is_marketplace_id(&entry.id))
        .map(|entry| entry.id.clone())
        .collect();
    if project_ids.is_empty() {
        return;
    }
    let mut shadowed = BTreeSet::new();
    let mut degraded = BTreeSet::new();
    for entry in entries.iter().filter(|entry| {
        entry.scope == "user" && is_marketplace_id(&entry.id) && project_ids.contains(&entry.id)
    }) {
        shadowed.insert(entry.id.clone());
        if entry.state == "not_installed"
            || entry.policy.contains("缓存目录不存在")
            || entry.policy.contains("运行时链接不存在")
        {
            degraded.insert(entry.id.clone());
        }
    }
    if shadowed.is_empty() {
        return;
    }
    for entry in entries
        .iter_mut()
        .filter(|entry| entry.scope == "project" && shadowed.contains(&entry.id))
    {
        let override_disabled = entry.policy.contains("项目覆盖") && entry.policy.contains("禁用");
        entry.policy.push_str(if override_disabled {
            " · 项目覆盖已禁用同 ID 插件；用户副本也不会在本项目加载"
        } else if entry.enabled == Some(false) {
            " · 同 ID 用户副本仍在；项目副本禁用时原生运行时回退用户副本，用户副本请在全局作用域管理"
        } else {
            " · 同 ID 用户副本被项目副本遮蔽；项目页只管理项目副本，用户副本请在全局作用域查看"
        });
        if degraded.contains(&entry.id) {
            entry.policy.push_str(
                " · 同 ID 用户副本缓存/链接缺失，运行时回退也可能失败；请在全局作用域修复或卸载",
            );
        }
    }
    entries.retain(|entry| !(entry.scope == "user" && shadowed.contains(&entry.id)));
}

/// A conservative `name@marketplace` check for an install source. OMP also
/// accepts npm version pins and dist-tags as `pkg@value`; those must not be
/// sent with `--scope project` (OMP would install them globally after a
/// warning). A real marketplace segment is a name, not a version/range/tag.
fn is_marketplace_source(source: &str) -> bool {
    let base = source.split_once('[').map_or(source, |(base, _)| base);
    let Some(index) = base.rfind('@') else {
        return false;
    };
    if index == 0 || index + 1 >= base.len() {
        return false;
    }
    let (name, marketplace) = (&base[..index], &base[index + 1..]);
    !name.is_empty()
        && !marketplace.is_empty()
        && !name.contains(['/', '\\', ':', '@'])
        && !marketplace.contains(['/', '\\', ':', '@'])
        && marketplace
            .chars()
            .any(|character| character.is_ascii_alphabetic())
        && marketplace.chars().any(|character| {
            !matches!(
                character,
                '0'..='9' | '.' | '-' | '+' | '^' | '~' | '=' | '*' | 'x' | 'X' | ' '
            )
        })
        && !looks_like_version_prefix(marketplace)
        && !matches!(
            marketplace.to_ascii_lowercase().as_str(),
            "latest" | "next" | "beta" | "alpha" | "rc" | "canary" | "experimental"
        )
}

fn looks_like_version_prefix(segment: &str) -> bool {
    segment
        .strip_prefix(['v', 'V'])
        .and_then(|rest| rest.chars().next())
        .is_some_and(|character| character.is_ascii_digit())
}

// =============================================================================
// Native verification cases (`tests/fixtures/omp/plugins/*.json`)
// =============================================================================

pub(crate) fn verify_case(
    case: &Value,
    context: &super::verify::CaseContext,
) -> Result<Value, super::verify::CaseError> {
    use super::verify::CaseError;
    let action = case
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| CaseError::Failed("plugins 用例缺少 action".into()))?;
    let adapter = port().ok_or_else(|| CaseError::Unverified(UNAVAILABLE_REASON.into()))?;
    let mut checks: Vec<(String, bool, String)> = Vec::new();
    match action {
        "capability" => {
            let capability = adapter.capability();
            for expected in case
                .get("actions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                checks.push((
                    format!("action {expected}"),
                    capability.actions.contains(&expected),
                    capability.actions.join(","),
                ));
            }
            if let Some(expected) = case.get("project").and_then(Value::as_bool) {
                checks.push((
                    "project 作用域".into(),
                    capability.project == expected,
                    capability.project.to_string(),
                ));
            }
            for token in case
                .get("sourcesContain")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                checks.push((
                    format!("来源说明包含 {token}"),
                    capability.sources.contains(token),
                    capability.sources.into(),
                ));
            }
            let policy = adapter.version_policy();
            checks.push((
                "18.20.2 版本接受".into(),
                policy.accepts("18.20.2"),
                policy.accepted_text(),
            ));
        }
        "commands" => {
            for item in case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("commands 用例缺少 cases".into()))?
            {
                let action = item
                    .get("action")
                    .and_then(Value::as_str)
                    .ok_or_else(|| CaseError::Failed("commands 用例缺少 action".into()))?;
                let source = item
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("fixture");
                let project = item
                    .get("project")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let actual = adapter.command_args(action, source, project);
                if let Some(expected) = item.get("args").and_then(Value::as_array) {
                    let expected: Vec<String> = expected
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                    checks.push((
                        format!("{action} {source} project={project}"),
                        actual.as_ref().is_ok_and(|args| args == &expected),
                        format!("实际 {actual:?}，期望 {expected:?}"),
                    ));
                } else {
                    let expect_error = item
                        .get("expectError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    checks.push((
                        format!("{action} {source} project={project}"),
                        actual.is_err() == expect_error,
                        format!("实际 {actual:?}"),
                    ));
                }
            }
        }
        "list" => {
            let list = case
                .get("list")
                .ok_or_else(|| CaseError::Failed("list 用例缺少 list".into()))?;
            let target = PluginTarget {
                tool_id: super::ID.into(),
                scope: if case
                    .get("project")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    Scope::Project
                } else {
                    Scope::Global
                },
                project_path: case
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                context_id: None,
            };
            let entries = adapter
                .parse_list(list, &target)
                .map_err(CaseError::Failed)?;
            let expected = case
                .get("expect")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("list 用例缺少 expect".into()))?;
            checks.push((
                "条目数量".into(),
                entries.len() == expected.len(),
                format!("实际 {}，期望 {}", entries.len(), expected.len()),
            ));
            for (index, expected) in expected.iter().enumerate() {
                let Some(entry) = entries.get(index) else {
                    continue;
                };
                for field in ["id", "name", "source", "scope", "state"] {
                    if let Some(value) = expected.get(field).and_then(Value::as_str) {
                        let actual = match field {
                            "id" => &entry.id,
                            "name" => &entry.name,
                            "source" => &entry.source,
                            "scope" => &entry.scope,
                            _ => &entry.state,
                        };
                        checks.push((
                            format!("条目 {index} {field}"),
                            actual == value,
                            format!("实际 {actual}，期望 {value}"),
                        ));
                    }
                }
                if let Some(value) = expected.get("enabled").and_then(Value::as_bool) {
                    checks.push((
                        format!("条目 {index} enabled"),
                        entry.enabled == Some(value),
                        format!("实际 {:?}", entry.enabled),
                    ));
                }
                if let Some(value) = expected.get("readOnly").and_then(Value::as_bool) {
                    checks.push((
                        format!("条目 {index} readOnly"),
                        entry.read_only == value,
                        format!("实际 {}", entry.read_only),
                    ));
                }
            }
        }
        "manifest-paths" => {
            let cases = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| CaseError::Failed("manifest-paths 用例缺少 cases".into()))?;
            for (index, item) in cases.iter().enumerate() {
                let sandbox = context
                    .home
                    .join(format!("plugins-verify-manifest-{index}"));
                let _ = std::fs::remove_dir_all(&sandbox);
                std::fs::create_dir_all(sandbox.join("commands"))
                    .map_err(|_| CaseError::Failed("无法准备隔离清单目录".into()))?;
                std::fs::create_dir_all(sandbox.join("custom"))
                    .map_err(|_| CaseError::Failed("无法准备隔离清单目录".into()))?;
                std::fs::write(sandbox.join("commands/review.md"), "x")
                    .map_err(|_| CaseError::Failed("无法写入隔离清单资源".into()))?;
                std::fs::write(sandbox.join("custom/review.md"), "x")
                    .map_err(|_| CaseError::Failed("无法写入隔离清单资源".into()))?;
                let manifest = item
                    .get("manifest")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                std::fs::write(
                    sandbox.join("package.json"),
                    serde_json::json!({
                        "name": "t5-manifest-fixture",
                        "version": "1.0.0",
                        "omp": manifest,
                    })
                    .to_string(),
                )
                .map_err(|_| CaseError::Failed("无法写入隔离包清单".into()))?;
                let mut entry = PluginEntry {
                    id: "t5-manifest-fixture".into(),
                    name: "T5 manifest fixture".into(),
                    source: "t5-manifest-fixture".into(),
                    version: Some("1.0.0".into()),
                    scope: "user".into(),
                    enabled: Some(true),
                    state: "installed_load_unknown".into(),
                    policy: String::new(),
                    read_only: false,
                    root: Some(sandbox.display().to_string()),
                    resources: Vec::new(),
                };
                adapter
                    .fill_missing_resources(&mut entry)
                    .map_err(CaseError::Failed)?;
                let expect = item.get("expect").and_then(Value::as_object);
                if let Some(read_only) = expect
                    .and_then(|expect| expect.get("readOnly"))
                    .and_then(Value::as_bool)
                {
                    checks.push((
                        format!("{index} readOnly"),
                        entry.read_only == read_only,
                        format!("实际 {}，策略 {}", entry.read_only, entry.policy),
                    ));
                }
                for needle in expect
                    .and_then(|expect| expect.get("policyContains"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    checks.push((
                        format!("{index} policy 包含 {needle}"),
                        entry.policy.contains(needle),
                        entry.policy.clone(),
                    ));
                }
                for suffix in expect
                    .and_then(|expect| expect.get("resourceSuffixes"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    checks.push((
                        format!("{index} 资源 {suffix}"),
                        entry
                            .resources
                            .iter()
                            .any(|resource| resource.path.replace('\\', "/").ends_with(suffix)),
                        entry
                            .resources
                            .iter()
                            .map(|resource| resource.path.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                    ));
                }
                for suffix in expect
                    .and_then(|expect| expect.get("absentSuffixes"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    checks.push((
                        format!("{index} 未包含 {suffix}"),
                        entry
                            .resources
                            .iter()
                            .all(|resource| !resource.path.replace('\\', "/").ends_with(suffix)),
                        entry
                            .resources
                            .iter()
                            .map(|resource| resource.path.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                    ));
                }
                let _ = std::fs::remove_dir_all(&sandbox);
            }
        }
        "supplement" => {
            let sandbox = context.home.join("plugins-verify");
            let project = context.project.join("plugins-verify");
            let _ = std::fs::remove_dir_all(&sandbox);
            let _ = std::fs::remove_dir_all(&project);
            std::fs::create_dir_all(user_plugins_root(&sandbox))
                .map_err(|_| CaseError::Failed("无法准备隔离用户插件根".into()))?;
            std::fs::create_dir_all(project_plugins_root(&project))
                .map_err(|_| CaseError::Failed("无法准备隔离项目插件根".into()))?;
            if let Some(lock) = case.get("lock") {
                let locks = if case
                    .get("project")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    lock_path(&project_plugins_root(&project))
                } else {
                    lock_path(&user_plugins_root(&sandbox))
                };
                std::fs::write(locks, lock.to_string())
                    .map_err(|_| CaseError::Failed("无法写入隔离锁文件".into()))?;
            }
            if let Some(overrides) = case.get("overrides") {
                std::fs::write(project_overrides_path(&project), overrides.to_string())
                    .map_err(|_| CaseError::Failed("无法写入隔离项目覆盖".into()))?;
            }
            let target = PluginTarget {
                tool_id: super::ID.into(),
                scope: if case
                    .get("project")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    Scope::Project
                } else {
                    Scope::Global
                },
                project_path: Some(project.display().to_string()),
                context_id: None,
            };
            let mut entries: Vec<PluginEntry> = case
                .get("entries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(entry_from_value)
                .collect::<Result<_, _>>()?;
            adapter
                .supplement(&sandbox, &target, &mut entries)
                .map_err(CaseError::Failed)?;
            let doctor = entries.iter().find(|entry| entry.id == DOCTOR_SOURCE);
            checks.push((
                "doctor 恢复入口".into(),
                case.get("doctor").and_then(Value::as_bool).unwrap_or(false) == doctor.is_some(),
                format!("实际 {}", doctor.is_some()),
            ));
            if let Some(needles) = case.get("policyContains").and_then(Value::as_array) {
                let policies: String = entries
                    .iter()
                    .map(|entry| entry.policy.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                for needle in needles.iter().filter_map(Value::as_str) {
                    checks.push((
                        format!("policy 包含 {needle}"),
                        policies.contains(needle),
                        policies.clone(),
                    ));
                }
            }
            if let Some(expected) = case.get("expectEntries").and_then(Value::as_array) {
                checks.push((
                    "supplement 后条目数量".into(),
                    entries.len() == expected.len(),
                    format!("实际 {}，期望 {}", entries.len(), expected.len()),
                ));
                for (index, expected) in expected.iter().enumerate() {
                    let id = expected.get("id").and_then(Value::as_str);
                    let scope = expected.get("scope").and_then(Value::as_str);
                    let entry = entries.iter().find(|entry| {
                        id.is_none_or(|id| entry.id == id)
                            && scope.is_none_or(|scope| entry.scope == scope)
                    });
                    checks.push((
                        format!("预期条目 {index} 存在"),
                        entry.is_some(),
                        format!("id={id:?} scope={scope:?}"),
                    ));
                    let Some(entry) = entry else {
                        continue;
                    };
                    if let Some(read_only) = expected.get("readOnly").and_then(Value::as_bool) {
                        checks.push((
                            format!("条目 {index} readOnly"),
                            entry.read_only == read_only,
                            format!("实际 {}，策略 {}", entry.read_only, entry.policy),
                        ));
                    }
                    if let Some(state) = expected.get("state").and_then(Value::as_str) {
                        checks.push((
                            format!("条目 {index} state"),
                            entry.state == state,
                            entry.state.clone(),
                        ));
                    }
                    for needle in expected
                        .get("policyContains")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        checks.push((
                            format!("条目 {index} policy 包含 {needle}"),
                            entry.policy.contains(needle),
                            entry.policy.clone(),
                        ));
                    }
                }
            }
            let _ = std::fs::remove_dir_all(&sandbox);
            let _ = std::fs::remove_dir_all(&project);
        }
        other => {
            return Err(CaseError::Failed(format!(
                "未知的 plugins 用例 action：{other}"
            )))
        }
    }
    let failed = checks.iter().any(|(_, passed, _)| !passed);
    Ok(serde_json::json!({
        "action": action,
        "result": {
            "passed": !failed,
            "checks": checks.into_iter().map(|(name, passed, detail)| serde_json::json!({
                "name": name,
                "passed": passed,
                "detail": detail,
            })).collect::<Vec<_>>(),
        },
    }))
}

fn entry_from_value(value: &Value) -> Result<PluginEntry, super::verify::CaseError> {
    use super::verify::CaseError;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CaseError::Failed(format!("entries 缺少 {name}")))
    };
    Ok(PluginEntry {
        id: field("id")?,
        name: field("name")?,
        source: field("source")?,
        version: value
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        scope: field("scope")?,
        enabled: value.get("enabled").and_then(Value::as_bool),
        state: field("state")?,
        policy: value
            .get("policy")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        read_only: value
            .get("readOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        root: value.get("root").and_then(Value::as_str).map(str::to_owned),
        resources: Vec::new(),
    })
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const LIST_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/plugins/omp-18.20.2-list.json");
    const DOCTOR_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/plugins/omp-18.20.2-doctor.json");

    fn target(scope: Scope, project: Option<&str>) -> PluginTarget {
        PluginTarget {
            tool_id: "omp".into(),
            scope,
            project_path: project.map(str::to_owned),
            context_id: None,
        }
    }

    fn entry(root: Option<&str>) -> PluginEntry {
        PluginEntry {
            id: "t5-fixture-plugin".into(),
            name: "T5 Fixture Plugin".into(),
            source: "t5-fixture-plugin".into(),
            version: Some("1.2.3".into()),
            scope: "user".into(),
            enabled: Some(true),
            state: "installed_load_unknown".into(),
            policy: String::new(),
            read_only: false,
            root: root.map(str::to_owned),
            resources: Vec::new(),
        }
    }

    #[test]
    fn capability_and_commands_follow_the_native_plugin_cli() {
        let adapter = &PORT;
        let capability = adapter.capability();
        assert_eq!(capability.version, "18.20.2");
        assert!(capability.project);
        for action in [
            "install",
            "update",
            "enable",
            "disable",
            "uninstall",
            DOCTOR_ACTION,
        ] {
            assert!(capability.actions.contains(&action), "{action}");
        }
        assert!(capability.sources.contains("npm"));
        assert!(capability.sources.contains("Git"));
        assert!(capability.sources.contains("link"));
        assert!(capability.sources.contains("marketplace"));
        assert!(adapter.version_policy().accepts("18.20.2"));
        assert!(adapter.version_policy().accepts("20.3.1"));

        assert_eq!(
            adapter
                .command_args("install", "@scope/pkg@1.2.3", false)
                .unwrap(),
            ["plugin", "install", "@scope/pkg@1.2.3", "--json"]
        );
        assert_eq!(
            adapter
                .command_args("install", "github:user/repo", false)
                .unwrap(),
            ["plugin", "install", "github:user/repo", "--json"]
        );
        assert_eq!(
            adapter
                .command_args("install", "C:/work/plugin", false)
                .unwrap(),
            ["plugin", "install", "C:/work/plugin", "--json"]
        );
        assert_eq!(
            adapter
                .command_args("install", "fixture@market[extra]", false)
                .unwrap(),
            ["plugin", "install", "fixture@market[extra]", "--json"]
        );
        assert!(adapter.command_args("install", "fixture@v2", true).is_err());
        assert_eq!(
            adapter
                .command_args("install", "fixture@market.v2", true)
                .unwrap(),
            [
                "plugin",
                "install",
                "fixture@market.v2",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert_eq!(
            adapter
                .command_args("install", "fixture@market", true)
                .unwrap(),
            [
                "plugin",
                "install",
                "fixture@market",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert!(adapter.command_args("install", "fixture", true).is_err());
        assert_eq!(
            adapter
                .command_args("update", "fixture@market", true)
                .unwrap(),
            [
                "plugin",
                "upgrade",
                "fixture@market",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert_eq!(
            adapter.command_args("update", "fixture", false).unwrap(),
            ["plugin", "upgrade", "fixture", "--json"]
        );
        assert_eq!(
            adapter
                .command_args("disable", "fixture@market", true)
                .unwrap(),
            [
                "plugin",
                "disable",
                "fixture@market",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert_eq!(
            adapter
                .command_args("uninstall", "fixture@market", true)
                .unwrap(),
            [
                "plugin",
                "uninstall",
                "fixture@market",
                "--json",
                "--scope",
                "project"
            ]
        );
        assert_eq!(
            adapter
                .command_args(DOCTOR_ACTION, "fixture", false)
                .unwrap(),
            ["plugin", "doctor", "--fix", "--json"]
        );
        assert!(adapter
            .command_args(DOCTOR_ACTION, "fixture", true)
            .is_err());
    }

    #[test]
    fn list_fixture_parses_npm_and_marketplace_scope_with_shadowing() {
        let temp = tempfile::tempdir().unwrap();
        let npm_root = temp.path().join("node_modules/t5-fixture-plugin");
        let market_root = temp
            .path()
            .join("cache/t5-market___t5-market-plugin___2.0.0");
        std::fs::create_dir_all(&npm_root).unwrap();
        std::fs::create_dir_all(market_root.join("commands")).unwrap();
        std::fs::write(
            npm_root.join("package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.2.3","omp":{"name":"T5 Fixture Plugin"}}"#,
        )
        .unwrap();
        std::fs::write(
            market_root.join("package.json"),
            r#"{"name":"t5-market-plugin","version":"2.0.0","omp":{"name":"T5 Market Plugin"}}"#,
        )
        .unwrap();
        std::fs::write(market_root.join("commands/review.md"), "x").unwrap();
        let mut value: Value = serde_json::from_str(LIST_FIXTURE).unwrap();
        value["npm"][0]["path"] = json!(npm_root.display().to_string());
        for row in value["marketplace"].as_array_mut().unwrap() {
            row["entries"][0]["installPath"] = json!(market_root.display().to_string());
        }
        let global = PORT
            .parse_list(&value, &target(Scope::Global, None))
            .unwrap();
        let ids: Vec<&str> = global.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            ids,
            ["t5-fixture-plugin", "t5-market-plugin@t5-market"],
            "全局只显示用户级 npm 与用户 marketplace 条目"
        );
        let npm = &global[0];
        assert_eq!(npm.version.as_deref(), Some("1.2.3"));
        assert_eq!(npm.enabled, Some(true));
        assert_eq!(npm.state, "installed_load_unknown");
        assert!(!npm.read_only);
        assert!(npm.policy.contains("原生功能：extra"));
        let market = &global[1];
        assert_eq!(market.scope, "user");
        assert!(!market.read_only);
        assert!(market.policy.contains("被同 ID 的项目副本遮蔽"));

        let mut project = PORT
            .parse_list(&value, &target(Scope::Project, Some("/fixture/project")))
            .unwrap();
        // The native list contains both the project row and the user row marked
        // `shadowedBy: "project"`; the adapter collapses the user copy before
        // the shared duplicate-ID guard runs.
        assert_eq!(
            project
                .iter()
                .filter(|entry| entry.id == "t5-market-plugin@t5-market")
                .count(),
            2
        );
        let shadowed_user = project
            .iter()
            .find(|entry| entry.id == "t5-market-plugin@t5-market" && entry.scope == "user")
            .unwrap();
        assert!(shadowed_user.read_only);
        assert!(shadowed_user.policy.contains("项目页只读"));
        let npm_project = project
            .iter()
            .find(|entry| entry.id == "t5-fixture-plugin")
            .unwrap();
        assert!(npm_project.read_only);

        collapse_project_shadows(&mut project);
        let market_rows: Vec<&PluginEntry> = project
            .iter()
            .filter(|entry| entry.id == "t5-market-plugin@t5-market")
            .collect();
        assert_eq!(market_rows.len(), 1, "同 ID 用户副本应被项目副本折叠");
        let project_row = market_rows[0];
        assert_eq!(project_row.scope, "project");
        assert!(!project_row.read_only);
        assert_eq!(project_row.enabled, Some(false));
        assert_eq!(project_row.state, "disabled");
        assert!(project_row
            .policy
            .contains("项目副本禁用时原生运行时回退用户副本"));
        assert!(project_row.policy.contains("全局作用域"));

        // An enabled project copy shadows the user copy in the other direction.
        let mut enabled: Value = serde_json::from_str(LIST_FIXTURE).unwrap();
        enabled["npm"] = json!([]);
        enabled["marketplace"][0]["entries"][0]["enabled"] = json!(true);
        enabled["marketplace"][1]["entries"][0]["installPath"] =
            json!(market_root.display().to_string());
        enabled["marketplace"][0]["entries"][0]["installPath"] =
            json!(market_root.display().to_string());
        let mut enabled_project = PORT
            .parse_list(&enabled, &target(Scope::Project, Some("/fixture/project")))
            .unwrap();
        collapse_project_shadows(&mut enabled_project);
        let enabled_row = enabled_project
            .iter()
            .find(|entry| entry.id == "t5-market-plugin@t5-market")
            .unwrap();
        assert!(!enabled_row.read_only);
        assert!(enabled_row.policy.contains("同 ID 用户副本被项目副本遮蔽"));
    }

    #[test]
    fn missing_marketplace_cache_keeps_native_uninstall_available() {
        let missing = "/fixture/does-not-exist/t5-market___plugin___1.0.0";
        for (scope, target) in [
            ("user", target(Scope::Global, None)),
            ("project", target(Scope::Project, Some("/fixture/project"))),
        ] {
            let entries = PORT
                .parse_list(
                    &json!({
                        "npm": [],
                        "marketplace": [{
                            "id": "t5-market-plugin@t5-market",
                            "scope": scope,
                            "entries": [{ "scope": scope, "installPath": missing, "version": "1.0.0" }]
                        }]
                    }),
                    &target,
                )
                .unwrap();
            let entry = &entries[0];
            assert_eq!(entry.state, "not_installed");
            assert!(
                !entry.read_only,
                "{scope} 缺缓存仍可用原生 uninstall 清理注册表"
            );
            assert!(entry.root.as_deref() == Some(missing));
            assert!(entry.policy.contains("卸载"));
            assert_eq!(entry.id, "t5-market-plugin@t5-market");
        }
    }

    #[test]
    fn list_rejects_unknown_shapes_and_never_returns_an_empty_store() {
        assert!(PORT
            .parse_list(&json!([]), &target(Scope::Global, None))
            .is_err());
        assert!(PORT
            .parse_list(&json!({ "npm": [] }), &target(Scope::Global, None))
            .is_err());
        assert!(PORT
            .parse_list(
                &json!({ "npm": [{}], "marketplace": [] }),
                &target(Scope::Global, None)
            )
            .is_err());
        assert!(PORT
            .parse_list(
                &json!({ "npm": [{ "name": "x", "version": "1.0.0", "path": "/missing" }], "marketplace": [] }),
                &target(Scope::Global, None)
            )
            .is_err());
        assert!(PORT
            .parse_list(
                &json!({ "npm": [], "marketplace": [{ "id": "x@market", "scope": "user", "entries": [] }] }),
                &target(Scope::Global, None)
            )
            .is_err());
        assert!(PORT
            .parse_list(
                &json!({ "npm": [], "marketplace": [{ "id": "x@market", "scope": "other", "entries": [{}] }] }),
                &target(Scope::Project, Some("/fixture/project"))
            )
            .is_err());
    }

    #[test]
    fn supplement_reports_lock_residual_drift_and_project_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let user_root = user_plugins_root(&home);
        std::fs::create_dir_all(user_root.join("node_modules/t5-fixture-plugin")).unwrap();
        std::fs::write(
            user_root.join("node_modules/t5-fixture-plugin/package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.2.4","omp":{"name":"T5 Fixture Plugin"}}"#,
        )
        .unwrap();
        std::fs::write(
            lock_path(&user_root),
            r#"{"plugins":{"t5-fixture-plugin":{"version":"1.2.3","enabledFeatures":null,"enabled":true},"deleted-plugin":{"version":"9.9.9","enabled":false}},"settings":{}}"#,
        )
        .unwrap();
        let mut installed = entry(Some(
            &user_root
                .join("node_modules/t5-fixture-plugin")
                .display()
                .to_string(),
        ));
        installed.version = Some("1.2.4".into());
        let mut entries = vec![installed];
        PORT.supplement(&home, &target(Scope::Global, None), &mut entries)
            .unwrap();
        let original = entries
            .iter()
            .find(|entry| entry.id == "t5-fixture-plugin")
            .unwrap();
        assert!(original.policy.contains("版本漂移"), "{}", original.policy);
        let orphan = entries
            .iter()
            .find(|entry| entry.id == "deleted-plugin")
            .unwrap();
        assert_eq!(orphan.state, "not_installed");
        assert!(orphan.read_only);
        assert!(orphan.policy.contains("doctor"));
        let doctor = entries
            .iter()
            .find(|entry| entry.id == DOCTOR_SOURCE)
            .unwrap();
        assert_eq!(doctor.state, "not_installed");
        assert!(!doctor.read_only);
        assert!(doctor.policy.contains("deleted-plugin"));
        assert!(doctor.policy.contains("版本漂移") || doctor.policy.contains("版本不一致"));

        // Project overrides disable an installed user plugin without being
        // rewritten by the plugin CLI.
        std::fs::create_dir_all(project_plugins_root(&project)).unwrap();
        std::fs::write(
            project_overrides_path(&project),
            r#"{"disabled":["t5-fixture-plugin"],"features":{"t5-fixture-plugin":["extra"]}}"#,
        )
        .unwrap();
        let project_target = target(Scope::Project, Some(&project.display().to_string()));
        let mut project_entries = vec![entry(Some(
            &user_root
                .join("node_modules/t5-fixture-plugin")
                .display()
                .to_string(),
        ))];
        PORT.supplement(&home, &project_target, &mut project_entries)
            .unwrap();
        let overridden = project_entries
            .iter()
            .find(|entry| entry.id == "t5-fixture-plugin")
            .unwrap();
        assert_eq!(overridden.enabled, Some(false));
        assert_eq!(overridden.state, "disabled");
        assert!(overridden.read_only);
        assert!(overridden.policy.contains("项目覆盖"));
        assert!(overridden.policy.contains("项目覆盖功能：extra"));
        assert!(
            !project_entries
                .iter()
                .any(|entry| entry.id == DOCTOR_SOURCE),
            "项目作用域没有误导性的 doctor 修复入口"
        );
    }

    #[test]
    fn missing_marketplace_runtime_link_is_reported_without_disabling_operations() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let user_root = user_plugins_root(&home);
        std::fs::create_dir_all(&user_root).unwrap();
        let cache = temp.path().join("cache/t5-market-plugin___1.0.0");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join("package.json"),
            r#"{"name":"t5-market-plugin","version":"1.0.0","omp":{"name":"T5"}}"#,
        )
        .unwrap();
        std::fs::write(
            lock_path(&user_root),
            r#"{"plugins":{"t5-market-plugin":{"version":"1.0.0","enabledFeatures":["extra"],"enabled":true}},"settings":{}}"#,
        )
        .unwrap();
        let mut entry = entry(Some(&cache.display().to_string()));
        entry.id = "t5-market-plugin@t5-market".into();
        entry.source = entry.id.clone();
        let mut entries = vec![entry];
        PORT.supplement(&home, &target(Scope::Global, None), &mut entries)
            .unwrap();
        let market = entries
            .iter()
            .find(|entry| entry.id == "t5-market-plugin@t5-market")
            .unwrap();
        assert!(!market.read_only);
        assert!(
            market.policy.contains("运行时链接不存在"),
            "{}",
            market.policy
        );
        assert!(
            market.policy.contains("原生锁功能：extra"),
            "{}",
            market.policy
        );
    }

    #[test]
    fn doctor_fixture_is_parsed_as_native_checks_without_faking_success() {
        let value: Value = serde_json::from_str(DOCTOR_FIXTURE).unwrap();
        let checks = value.as_array().unwrap();
        assert!(checks
            .iter()
            .any(|check| check["name"] == "orphan:t5-fixture-plugin"));
        assert!(checks.iter().any(|check| check["status"] == "warning"));
    }

    #[test]
    fn resources_cover_conventional_and_manifest_entries_and_reject_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugin");
        std::fs::create_dir_all(root.join("agents")).unwrap();
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::create_dir_all(root.join("commands")).unwrap();
        std::fs::write(root.join("agents/reviewer.md"), "x").unwrap();
        std::fs::write(root.join("skills/SKILL.md"), "x").unwrap();
        std::fs::write(root.join("commands/review.md"), "x").unwrap();
        std::fs::write(root.join(".mcp.json"), "{}").unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.0.0","omp":{"commands":["commands/review.md"]}}"#,
        )
        .unwrap();
        let mut item = entry(Some(&root.display().to_string()));
        PORT.fill_missing_resources(&mut item).unwrap();
        let kinds: BTreeSet<&str> = item
            .resources
            .iter()
            .map(|resource| resource.kind.as_str())
            .collect();
        assert!(kinds.contains("agents"));
        assert!(kinds.contains("skills"));
        assert!(kinds.contains("commands"));
        assert!(kinds.contains("mcp"));
        assert!(
            item.resources
                .iter()
                .filter(|resource| resource.kind == "commands")
                .count()
                == 1
        );

        assert_eq!(
            safe_relative("./commands/review.md"),
            Some(PathBuf::from("commands/review.md"))
        );
        assert_eq!(
            safe_relative("a/../commands/review.md"),
            Some(PathBuf::from("commands/review.md"))
        );
        assert!(safe_relative("../outside.md").is_none());
        assert!(safe_relative("/outside.md").is_none());

        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.0.0","omp":{"commands":["./commands/review.md"]}}"#,
        )
        .unwrap();
        let mut dotted = entry(Some(&root.display().to_string()));
        assert!(PORT.fill_missing_resources(&mut dotted).is_ok());
        assert!(!dotted.read_only, "{}", dotted.policy);

        std::fs::write(root.join("commands/other.md"), "x").unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.0.0","omp":{"commands":["./commands/other.md","../outside.md"]}}"#,
        )
        .unwrap();
        let mut escaped = entry(Some(&root.display().to_string()));
        // An escaping manifest item only marks this entry read-only; it must not
        // fail the snapshot, list or doctor baseline.
        assert!(PORT.fill_missing_resources(&mut escaped).is_ok());
        assert!(escaped.read_only);
        assert!(escaped.policy.contains("包外"), "{}", escaped.policy);
        assert!(escaped
            .resources
            .iter()
            .all(|resource| !resource.path.contains("outside.md")));

        std::fs::write(
            root.join("package.json"),
            r#"{"name":"t5-fixture-plugin","version":"1.0.0","omp":{"commands":{"inline":true}}}"#,
        )
        .unwrap();
        let mut malformed = entry(Some(&root.display().to_string()));
        assert!(PORT.fill_missing_resources(&mut malformed).is_ok());
        assert!(!malformed.read_only);
        assert!(malformed.policy.contains("不是路径字符串/数组"));
    }
}
