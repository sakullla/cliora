#[cfg(not(test))]
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
#[cfg(not(test))]
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::adapters::{self, CliAdapter, Registry};
use crate::domain::CliId;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub path: String,
    pub version: Option<String>,
    pub source: &'static str,
    pub status: &'static str,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: &'static str,
    pub status: &'static str,
    pub detail: &'static str,
    pub help_url: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub interface_format: &'static str,
    pub source_url: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFile {
    pub role: &'static str,
    pub path: String,
    pub format: &'static str,
    pub writable: bool,
    pub reason: Option<&'static str>,
    pub sensitive: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: &'static str,
    pub reason: &'static str,
    pub evidence: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub tool: String,
    pub installations: Vec<Installation>,
    pub selected_path: Option<String>,
    pub native_files: Vec<NativeFile>,
    pub native_writes: Capability,
    pub interface_formats: Vec<&'static str>,
    pub install_url: &'static str,
    pub upgrade_hint: &'static str,
    pub dependencies: Vec<Dependency>,
    pub install_command: Option<String>,
    pub upgrade_command: Option<String>,
    pub native_install_command: Option<String>,
    pub npm_install_command: Option<String>,
    pub provider_presets: Vec<ProviderPreset>,
}

fn provider_presets(adapter: &dyn CliAdapter, known: bool) -> Vec<ProviderPreset> {
    let formats = if known {
        adapter.interface_formats().to_vec()
    } else {
        Vec::new()
    };
    let mut presets = Vec::new();
    if formats.contains(&"openai_responses") {
        presets.push(ProviderPreset {
            id: "openai",
            label: "OpenAI",
            base_url: "https://api.openai.com/v1",
            interface_format: "openai_responses",
            source_url: "https://developers.openai.com/api/docs",
        });
        presets.push(ProviderPreset {
            id: "xai",
            label: "xAI",
            base_url: "https://api.x.ai/v1",
            interface_format: "openai_responses",
            source_url: "https://docs.x.ai/overview",
        });
    }
    if formats.contains(&"anthropic_messages") {
        presets.push(ProviderPreset {
            id: "anthropic",
            label: "Anthropic API",
            base_url: adapter.anthropic_base_url(),
            interface_format: "anthropic_messages",
            source_url: "https://platform.claude.com/docs/en/api/overview",
        });
    }
    presets
}

fn source_of(path: &Path, adapter: &dyn CliAdapter) -> &'static str {
    #[cfg(target_os = "macos")]
    if !adapter.npm_package().is_empty() && path.canonicalize().is_ok_and(|target| {
        target.to_string_lossy().contains(&format!("/node_modules/{}/", adapter.npm_package()))
    }) {
        return "npm_shim";
    }
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    if ext.eq_ignore_ascii_case("ps1") || ext.eq_ignore_ascii_case("cmd") {
        if let Ok(file) = std::fs::File::open(path) {
            let mut bytes = Vec::new();
            if file.take(16_384).read_to_end(&mut bytes).is_err() {
                return "unknown";
            }
            let sample = String::from_utf8_lossy(&bytes).replace('\\', "/");
            if sample.contains("node_modules/") && sample.contains(adapter.npm_package()) {
                return "npm_shim";
            }
        }
    }
    // Unix npm links the global binary to the package inside node_modules.
    if !cfg!(windows) && !adapter.npm_package().is_empty() {
        if let Ok(real) = path.canonicalize() {
            let sample = real.to_string_lossy().replace('\\', "/");
            if sample.contains("node_modules/") && sample.contains(adapter.npm_package()) {
                return "npm_shim";
            }
        }
    }
    if adapter.recognizes_native_install_path(path) {
        return "native";
    }
    "unknown"
}

fn on_path(name: &str) -> bool {
    crate::process_environment::directories()
        .into_iter()
        .any(|dir| {
            if cfg!(windows) {
                dir.join(format!("{name}.exe")).is_file()
                    || dir.join(format!("{name}.cmd")).is_file()
            } else {
                dir.join(name).is_file()
            }
        })
}

fn parse_node_version(output: &str) -> Option<(u32, u32, u32)> {
    let mut parts = output.trim().trim_start_matches('v').split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn node_version() -> Option<(u32, u32, u32)> {
    if !on_path("node") {
        return None;
    }
    let mut child = crate::background_process::command("node")
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&output.stdout))
}

fn node_dependency_status(
    adapter: &dyn CliAdapter,
    version: Option<(u32, u32, u32)>,
) -> &'static str {
    match version {
        None => "missing",
        Some(version)
            if adapter
                .minimum_node_version()
                .is_some_and(|minimum| version < minimum) =>
        {
            "outdated"
        }
        Some(_) => "found",
    }
}

fn dependencies(adapter: &dyn CliAdapter, source: &str, no_candidates: bool) -> Vec<Dependency> {
    let mut result = Vec::new();
    let needs_npm = source == "npm_shim" || (no_candidates && adapter.node_required_when_missing());
    if needs_npm {
        let version = node_version();
        result.push(Dependency {
            name: "Node.js",
            status: node_dependency_status(adapter, version),
            detail: adapter.node_dependency_detail(),
            help_url: "https://nodejs.org/en/download",
        });
        result.push(Dependency {
            name: "npm",
            status: if on_path("npm") { "found" } else { "missing" },
            detail: "升级 npm 安装需要 npm",
            help_url: "https://nodejs.org/en/download",
        });
    }
    if cfg!(windows) && adapter.requires_windows_bash() {
        let bash = on_path("bash")
            || env::var_os("ProgramFiles")
                .is_some_and(|dir| PathBuf::from(dir).join("Git/bin/bash.exe").is_file());
        result.push(Dependency {
            name: "Bash",
            status: if bash { "found" } else { "missing" },
            detail: "Pi 在 Windows 使用 Bash 执行 shell 工具",
            help_url: "https://git-scm.com/download/win",
        });
    }
    result
}

#[cfg(test)]
fn shim_key(path: &str) -> Option<(String, String)> {
    let path = Path::new(path);
    Some((
        path.parent()?.to_string_lossy().replace('\\', "/").to_ascii_lowercase(),
        path.file_stem()?.to_string_lossy().to_ascii_lowercase(),
    ))
}

#[cfg(test)]
fn shim_rank(item: &Installation) -> u8 {
    let ext = Path::new(&item.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext_rank = match ext.as_str() {
        "exe" => 0,
        "cmd" => 1,
        "ps1" => 2,
        _ => 3,
    };
    if item.status == "available" { ext_rank } else { 10 + ext_rank }
}

#[cfg(test)]
fn collapse_sibling_shims(items: Vec<Installation>) -> Vec<Installation> {
    if !cfg!(windows) {
        return items;
    }
    let mut kept = Vec::new();
    for item in items {
        let Some(key) = shim_key(&item.path) else {
            kept.push(item);
            continue;
        };
        if let Some(existing) = kept.iter_mut().find(|old| shim_key(&old.path) == Some(key.clone())) {
            if shim_rank(&item) < shim_rank(existing) {
                *existing = item;
            }
            continue;
        }
        kept.push(item);
    }
    kept
}

fn install_command(adapter: &dyn CliAdapter) -> Option<String> {
    adapter.install_command()
}

fn upgrade_command(adapter: &dyn CliAdapter, source: &str) -> Option<String> {
    adapter.upgrade_command(source)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project,
}

/// Unix npm keeps global binaries next to the Node executable, because its default
/// prefix is the Node installation prefix. That directory is not always on PATH — a
/// distribution or hand-installed Node often lives in its own tree — so the app
/// would install a CLI through npm and then fail to find it again.
fn npm_global_bin_dirs(node: Option<PathBuf>, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let node_dir = node
        .and_then(|candidate| candidate.canonicalize().ok())
        .and_then(|real| real.parent().map(Path::to_path_buf));
    if let Some(dir) = node_dir {
        dirs.push(dir);
    }
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".local/share/pnpm"));
        dirs.push(home.join(".bun/bin"));
    }
    dirs
}

fn candidates(adapter: &dyn CliAdapter, home: &Path) -> Vec<PathBuf> {
    let name = adapter.command();
    let mut paths = Vec::new();
    // Windows npm publishes name, name.cmd and name.ps1 together. The extensionless file is a
    // Unix shim and fails as a Win32 image (os error 193), so it is not a separate installation.
    let suffixes: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".ps1"]
    } else {
        &[""]
    };
    let mut directories = crate::process_environment::directories();
    let node = directories.iter().map(|dir| dir.join("node")).find(|candidate| candidate.is_file());
    directories.extend(npm_global_bin_dirs(node, Some(home.to_path_buf())));
    if cfg!(target_os = "macos") {
        directories.extend(adapter.native_binary_directories(home));
    }
    for dir in directories {
        for suffix in suffixes {
            let candidate = dir.join(format!("{name}{suffix}"));
            if candidate.is_file() && !paths.contains(&candidate) {
                paths.push(candidate);
            }
        }
    }
    paths
}

fn version_from_output(adapter: &dyn CliAdapter, path: &Path, output: &str) -> Option<String> {
    let basename = path.file_stem()?.to_str()?.to_ascii_lowercase();
    let lower = output.to_ascii_lowercase();
    let identity = adapter.version_identity(&basename, &lower);
    if !identity {
        return None;
    }
    output
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|part| {
            part.matches('.').count() >= 2 && part.split('.').all(|piece| !piece.is_empty())
        })
        .map(str::to_string)
}

fn run_version(path: &Path, adapter: &dyn CliAdapter) -> Installation {
    let source = source_of(path, adapter);
    let mut command = if cfg!(windows)
        && path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("ps1"))
    {
        let mut cmd = crate::background_process::command("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(path);
        cmd
    } else {
        crate::background_process::command(path)
    };
    let spawned = command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Installation {
                path: path.display().to_string(),
                version: None,
                source,
                status: "probe_failed",
                detail: Some(format!("无法运行版本命令：{error}")),
            }
        }
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Installation {
                    path: path.display().to_string(),
                    version: None,
                    source,
                    status: "probe_failed",
                    detail: Some("版本命令超时".into()),
                };
            }
            Err(error) => {
                return Installation {
                    path: path.display().to_string(),
                    version: None,
                    source,
                    status: "probe_failed",
                    detail: Some(format!("无法读取版本结果：{error}")),
                }
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return Installation {
                path: path.display().to_string(),
                version: None,
                source,
                status: "probe_failed",
                detail: Some(format!("无法读取版本输出：{error}")),
            }
        }
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let preview: String = combined.chars().take(160).collect();
    let version = if output.status.success() {
        version_from_output(adapter, path, &preview)
    } else {
        None
    };
    let status = if version.is_some() {
        "available"
    } else {
        "probe_failed"
    };
    Installation {
        path: path.display().to_string(),
        version,
        source,
        status,
        detail: if status == "available" {
            None
        } else {
            Some("版本命令失败或工具身份无法确认".into())
        },
    }
}

pub fn probe_path(tool: CliId, path: &Path) -> Installation {
    run_version(path, adapters::known(tool))
}

pub fn probe_registered_path(
    registry: &Registry,
    id: &str,
    path: &Path,
) -> Result<Installation, String> {
    Ok(run_version(
        path,
        registry.get(id).ok_or("未注册的 CLI 适配器，不能探测")?,
    ))
}

pub fn native_files(
    tool: CliId,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known_version: bool,
) -> Vec<NativeFile> {
    adapters::known(tool).native_files(scope, home, project, known_version)
}

pub fn interface_formats(tool: CliId, known: bool) -> Vec<&'static str> {
    if known {
        adapters::known(tool).interface_formats().to_vec()
    } else {
        Vec::new()
    }
}

fn probe_path_rank(path: &Path) -> u8 {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "exe" => 0,
        "cmd" => 1,
        "ps1" => 2,
        _ => 3,
    }
}

fn path_group_key(path: &Path) -> Option<(String, String)> {
    Some((
        path.parent()?.to_string_lossy().replace('\\', "/").to_ascii_lowercase(),
        path.file_stem()?.to_string_lossy().to_ascii_lowercase(),
    ))
}

/// Windows npm publishes the same command as `.exe`, `.cmd` and `.ps1`. Running all three
/// starts the CLI two extra times. Keep one group per directory and try the fastest file first.
fn group_probe_paths(paths: Vec<PathBuf>) -> Vec<Vec<PathBuf>> {
    if !cfg!(windows) {
        return paths.into_iter().map(|path| vec![path]).collect();
    }
    let mut groups: Vec<Vec<PathBuf>> = Vec::new();
    let mut keys: Vec<Option<(String, String)>> = Vec::new();
    for path in paths {
        let key = path_group_key(&path);
        if key.is_some() {
            if let Some(index) = keys.iter().position(|old| old == &key) {
                groups[index].push(path);
                continue;
            }
        }
        keys.push(key);
        groups.push(vec![path]);
    }
    for group in &mut groups {
        group.sort_by_key(|path| probe_path_rank(path));
    }
    groups
}

fn probe_group(paths: Vec<PathBuf>, adapter: &dyn CliAdapter) -> Installation {
    let mut fallback = None;
    for path in paths {
        let item = run_version(&path, adapter);
        if item.status == "available" {
            return item;
        }
        if fallback.is_none() {
            fallback = Some(item);
        }
    }
    fallback.expect("版本探测分组不会是空的")
}

fn probe_installations(paths: Vec<PathBuf>, adapter: &dyn CliAdapter, stop_at_first: bool) -> Vec<Installation> {
    let mut installations = Vec::new();
    for group in group_probe_paths(paths) {
        let item = probe_group(group, adapter);
        let found = item.status == "available";
        installations.push(item);
        if stop_at_first && found {
            break;
        }
    }
    installations
}

#[cfg(not(test))]
struct SummaryCacheEntry {
    at: Instant,
    probe: ToolProbe,
}

#[cfg(not(test))]
fn summary_cache() -> &'static Mutex<HashMap<String, SummaryCacheEntry>> {
    static CACHE: std::sync::LazyLock<Mutex<HashMap<String, SummaryCacheEntry>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &CACHE
}

#[cfg(not(test))]
fn summary_cache_key(id: &str, custom_path: Option<&Path>, scope: Scope, project: Option<&Path>) -> String {
    format!(
        "{id}|{}|{}|{}",
        custom_path.map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
        match scope {
            Scope::Global => "global",
            Scope::Project => "project",
        },
        project.map(|path| path.to_string_lossy().to_string()).unwrap_or_default(),
    )
}

#[cfg(not(test))]
fn cached_probe(cache: &Mutex<HashMap<String, SummaryCacheEntry>>, key: &str) -> Option<ToolProbe> {
    let cache = cache.lock().unwrap_or_else(|error| error.into_inner());
    let entry = cache.get(key)?;
    let ttl = if entry.probe.selected_path.is_some() {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(8)
    };
    (entry.at.elapsed() < ttl).then(|| entry.probe.clone())
}

#[cfg(not(test))]
fn store_probe(cache: &Mutex<HashMap<String, SummaryCacheEntry>>, key: String, probe: &ToolProbe) {
    let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());
    cache.retain(|_, entry| entry.at.elapsed() < Duration::from_secs(60));
    cache.insert(key, SummaryCacheEntry { at: Instant::now(), probe: probe.clone() });
}

#[cfg(not(test))]
fn installation_cache() -> &'static Mutex<HashMap<String, SummaryCacheEntry>> {
    static CACHE: std::sync::LazyLock<Mutex<HashMap<String, SummaryCacheEntry>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &CACHE
}

pub fn probe_registered_summary(
    registry: &Registry,
    id: &str,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
) -> Result<ToolProbe, String> {
    #[cfg(not(test))]
    let key = summary_cache_key(id, custom_path, scope, project);
    #[cfg(not(test))]
    if let Some(probe) = cached_probe(summary_cache(), &key) {
        return Ok(probe);
    }
    let probe = finish_probe(registry, id, custom_path, home, project, scope, true)?;
    #[cfg(not(test))]
    store_probe(summary_cache(), key, &probe);
    Ok(probe)
}

/// Full installation probe, reused for a short time so switching CLIs does not
/// start every version command again. `fresh` replaces the cached result.
pub fn probe_registered_cached(
    registry: &Registry,
    id: &str,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
    fresh: bool,
) -> Result<ToolProbe, String> {
    #[cfg(test)]
    let _ = fresh;
    #[cfg(not(test))]
    let key = summary_cache_key(id, custom_path, scope, project);
    #[cfg(not(test))]
    if !fresh {
        if let Some(probe) = cached_probe(installation_cache(), &key) {
            return Ok(probe);
        }
    }
    let probe = probe_registered(registry, id, custom_path, home, project, scope)?;
    #[cfg(not(test))]
    store_probe(installation_cache(), key, &probe);
    Ok(probe)
}

pub fn probe_registered(
    registry: &Registry,
    id: &str,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
) -> Result<ToolProbe, String> {
    finish_probe(registry, id, custom_path, home, project, scope, false)
}

fn finish_probe(
    registry: &Registry,
    id: &str,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
    stop_at_first: bool,
) -> Result<ToolProbe, String> {
    let adapter = registry
        .get(id)
        .ok_or("未注册的 CLI 适配器，不能探测或写入")?;
    let mut paths = candidates(adapter, home);
    if let Some(path) = custom_path {
        paths.retain(|candidate| candidate != path);
        paths.insert(0, path.to_path_buf());
    }
    let installations = {
        #[cfg(test)]
        {
            if let Some(fixture) = registry.fixture_installations.get(id).cloned() {
                collapse_sibling_shims(fixture)
            } else {
                probe_installations(paths, adapter, stop_at_first)
            }
        }
        #[cfg(not(test))]
        {
            probe_installations(paths, adapter, stop_at_first)
        }
    };
    let selected = installations.iter().find(|item| item.status == "available");
    let writable = selected
        .and_then(|item| item.version.as_deref())
        .is_some_and(|version| !adapter.explicitly_incompatible_native_version(version));
    let native_writes = if writable {
        Capability {
            state: "supported",
            reason: "已确认 CLI 身份，原生配置可编辑",
            evidence: "cli_identity_and_format",
        }
    } else if selected.is_some() {
        Capability {
            state: "unsupported",
            reason: "此 CLI 版本的原生配置格式已确认不兼容",
            evidence: "adapter_incompatibility",
        }
    } else {
        Capability {
            state: "unknown",
            reason: "未发现可确认身份的 CLI",
            evidence: "version_probe",
        }
    };
    let (install_url, upgrade_hint) = adapter.install_guidance();
    let source = selected.map(|item| item.source).unwrap_or("unknown");
    let no_candidates = installations.is_empty();
    let runnable = selected.is_some();
    Ok(ToolProbe {
        tool: id.to_owned(),
        selected_path: selected.map(|item| item.path.clone()),
        installations,
        native_files: adapter.native_files(scope, home, project, writable),
        native_writes,
        interface_formats: if writable {
            adapter.interface_formats().to_vec()
        } else {
            Vec::new()
        },
        install_url,
        upgrade_hint,
        dependencies: dependencies(adapter, source, no_candidates),
        install_command: if runnable {
            None
        } else {
            install_command(adapter)
        },
        upgrade_command: upgrade_command(adapter, source),
        native_install_command: adapter.native_install_command(),
        npm_install_command: adapter.npm_install_command(),
        provider_presets: provider_presets(adapter, writable),
    })
}

pub fn probe(
    tool: CliId,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
) -> ToolProbe {
    probe_registered(
        &Registry::builtins(),
        adapters::legacy_id(tool),
        custom_path,
        home,
        project,
        scope,
    )
    .expect("built-in adapter registered")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn npm_globals_beside_a_symlinked_node_are_searched_even_when_off_path() {
        // A hand-installed Node keeps npm's global binaries in the directory holding the
        // node executable, which is reached through a symlink on PATH. Searching only
        // PATH would miss a CLI that npm had just installed.
        let temp = tempfile::tempdir().unwrap();
        let real_bin = temp.path().join("lib/nodejs/bin");
        std::fs::create_dir_all(&real_bin).unwrap();
        std::fs::write(real_bin.join("node"), "#!/bin/sh\n").unwrap();
        let linked_dir = temp.path().join("bin");
        std::fs::create_dir_all(&linked_dir).unwrap();
        std::os::unix::fs::symlink(real_bin.join("node"), linked_dir.join("node")).unwrap();

        let dirs = npm_global_bin_dirs(Some(linked_dir.join("node")), None);

        assert_eq!(dirs.first(), Some(&real_bin), "{dirs:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_npm_symlink_is_recognized_without_confusing_another_package() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("lib/node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "#!/usr/bin/env node\n").unwrap();
        let link = temp.path().join("codex");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(source_of(&link, adapters::known(CliId::Codex)), "npm_shim");
        assert_eq!(source_of(&link, adapters::known(CliId::ClaudeCode)), "unknown");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_discovers_native_cli_outside_the_gui_path() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        for (tool, directory, output) in [
            (CliId::Grok, ".grok/bin", "grok 1.0.0"),
            (CliId::OpenCode, ".opencode/bin", "opencode 1.18.0"),
        ] {
            let adapter = adapters::known(tool);
            let executable = home.path().join(directory).join(adapter.command());
            std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
            std::fs::write(&executable, format!("#!/bin/sh\nprintf '%s\\n' '{output}'\n")).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(candidates(adapter, home.path()).contains(&executable));
            assert_eq!(probe_path(tool, &executable).status, "available");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires locally installed Codex, Claude Code and Grok; only runs version probes"]
    fn live_macos_probe_recovers_cli_and_node_from_finder_environment() {
        let home = dirs::home_dir().unwrap();
        for tool in [CliId::Codex, CliId::ClaudeCode, CliId::Grok] {
            let result = probe(tool, None, &home, None, Scope::Global);
            assert!(result.selected_path.is_some(), "{}: {:?}", tool.name(), result.installations);
            for dependency in &result.dependencies {
                assert_eq!(dependency.status, "found", "{}: {}", tool.name(), dependency.name);
            }
            eprintln!("{}: {} ({})", tool.name(), result.selected_path.unwrap(), result.installations.iter().find(|item| item.status == "available").unwrap().version.as_deref().unwrap());
        }
        assert!(on_path("node"));
        assert!(on_path("npm"));
        assert!(node_version().is_some());
    }

    #[test]
    fn recognized_newer_minor_version_is_not_rejected_for_native_editing() {
        assert!(!adapters::known(CliId::Codex).explicitly_incompatible_native_version("0.159.0"));
        assert!(adapters::plan_launch(
            &adapters::Registry::builtins(),
            "codex",
            "0.159.0",
            None,
            adapters::LaunchMode::Normal
        )
        .is_ok());
        assert_eq!(
            version_from_output(
                adapters::known(CliId::Codex),
                Path::new("codex.ps1"),
                "codex-cli 0.158.0"
            ),
            Some("0.158.0".into())
        );
        assert_eq!(
            version_from_output(
                adapters::known(CliId::Codex),
                Path::new("renamed.exe"),
                "codex-cli 0.158.0"
            ),
            Some("0.158.0".into())
        );
        assert_eq!(
            version_from_output(
                adapters::known(CliId::Codex),
                Path::new("codex.ps1"),
                "claude 0.158.0"
            ),
            None
        );
        let temp = tempfile::tempdir().unwrap();
        let executable = if cfg!(windows) {
            temp.path().join("codex.ps1")
        } else {
            temp.path().join("codex")
        };
        if cfg!(windows) {
            std::fs::write(&executable, "Write-Output 'codex-cli 0.159.0'\n").unwrap();
        } else {
            std::fs::write(&executable, "#!/bin/sh\necho 'codex-cli 0.159.0'\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
        }
        let result = probe_registered(
            &Registry::builtins(),
            "codex",
            Some(&executable),
            temp.path(),
            None,
            Scope::Global,
        )
        .unwrap();
        assert_eq!(result.installations[0].version.as_deref(), Some("0.159.0"));
        assert_eq!(result.native_writes.state, "supported");
        assert!(result.native_files[0].writable);
        assert_eq!(result.native_files[0].reason, None);
    }

    #[test]
    fn version_probe_groups_sibling_shims_and_keeps_other_directories() {
        let command = PathBuf::from("C:/npm/codex.cmd");
        let script = PathBuf::from("C:/npm/codex.ps1");
        let executable = PathBuf::from("C:/npm/codex.exe");
        let other = PathBuf::from("D:/native/codex.exe");
        let grouped = group_probe_paths(vec![command.clone(), script.clone(), executable.clone(), other.clone()]);
        if cfg!(windows) {
            assert_eq!(grouped.len(), 2);
            assert_eq!(grouped[0], vec![executable, command, script]);
            assert_eq!(grouped[1], vec![other]);
        } else {
            assert_eq!(grouped.len(), 4);
        }
    }

    #[test]
    fn npm_source_requires_package_evidence_and_unknown_source_gets_no_upgrade_command() {
        let temp = tempfile::tempdir().unwrap();
        let shim = temp.path().join("grok.ps1");
        std::fs::write(&shim, "$basedir/node_modules/@xai-official/grok/bin/grok").unwrap();
        assert_eq!(source_of(&shim, adapters::known(CliId::Grok)), "npm_shim");
        assert_eq!(
            upgrade_command(
                adapters::known(CliId::Grok),
                source_of(&shim, adapters::known(CliId::Grok))
            )
            .as_deref(),
            Some("npm install -g @xai-official/grok@latest")
        );
        std::fs::write(&shim, "unrelated launcher").unwrap();
        assert_eq!(source_of(&shim, adapters::known(CliId::Grok)), "unknown");
        assert_eq!(
            upgrade_command(adapters::known(CliId::Grok), "unknown"),
            None
        );

        let pi_shim = temp.path().join("pi.ps1");
        std::fs::write(
            &pi_shim,
            "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        )
        .unwrap();
        assert_eq!(source_of(&pi_shim, adapters::known(CliId::Pi)), "npm_shim");
        assert_eq!(
            install_command(adapters::known(CliId::Pi)).as_deref(),
            Some("npm install -g --ignore-scripts @earendil-works/pi-coding-agent")
        );
        assert_eq!(
            upgrade_command(adapters::known(CliId::Pi), "npm_shim").as_deref(),
            Some("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest")
        );
        assert_eq!(parse_node_version("v22.18.9"), Some((22, 18, 9)));
        assert_eq!(parse_node_version("v22.19.0"), Some((22, 19, 0)));
        assert!(parse_node_version("not a version").is_none());
        assert_eq!(
            node_dependency_status(adapters::known(CliId::Pi), Some((22, 18, 9))),
            "outdated"
        );
        assert_eq!(
            node_dependency_status(adapters::known(CliId::Pi), Some((22, 19, 0))),
            "found"
        );
    }

    #[test]
    fn windows_npm_shims_collapse_to_the_runnable_file_and_native_stays_separate() {
        let failed = Installation {
            path: r"C:\Users\me\AppData\Roaming\npm\codex".into(),
            version: None,
            source: "unknown",
            status: "probe_failed",
            detail: Some("os error 193".into()),
        };
        let cmd = Installation {
            path: r"C:\Users\me\AppData\Roaming\npm\codex.cmd".into(),
            version: Some("0.159.3".into()),
            source: "npm_shim",
            status: "available",
            detail: None,
        };
        let ps1 = Installation {
            path: r"C:\Users\me\AppData\Roaming\npm\codex.ps1".into(),
            version: Some("0.159.3".into()),
            source: "npm_shim",
            status: "available",
            detail: None,
        };
        let native = Installation {
            path: r"C:\Users\me\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe".into(),
            version: Some("0.160.0".into()),
            source: "native",
            status: "available",
            detail: None,
        };
        let collapsed = collapse_sibling_shims(vec![failed, ps1, cmd.clone(), native.clone()]);
        if cfg!(windows) {
            assert_eq!(collapsed.len(), 2);
            assert_eq!(collapsed[0].path, cmd.path);
            assert_eq!(collapsed[1].path, native.path);
        } else {
            assert_eq!(collapsed.len(), 4);
        }
        let codex = adapters::known(CliId::Codex);
        assert!(codex.recognizes_native_install_path(Path::new(&native.path)));
        assert!(!codex.recognizes_native_install_path(Path::new(&cmd.path)));
        let install = codex.install_command().unwrap();
        assert!(install.contains(if cfg!(windows) { "install.ps1" } else { "install.sh" }));
        assert_eq!(
            codex.upgrade_command("npm_shim").as_deref(),
            Some("npm install -g @openai/codex@latest")
        );
        assert_eq!(codex.upgrade_command("native"), codex.native_install_command());
        assert_eq!(
            codex.npm_install_command().as_deref(),
            Some("npm install -g @openai/codex")
        );
        assert_eq!(
            codex.npm_uninstall_command().as_deref(),
            Some("npm uninstall -g @openai/codex")
        );
        assert_eq!(
            adapters::known(CliId::ClaudeCode).npm_uninstall_command().as_deref(),
            Some("npm uninstall -g @anthropic-ai/claude-code")
        );
    }

    #[test]
    fn presets_only_offer_documented_addresses_in_tool_supported_formats() {
        assert!(provider_presets(adapters::known(CliId::Codex), false).is_empty());
        let codex = provider_presets(adapters::known(CliId::Codex), true);
        assert_eq!(codex.len(), 2);
        assert!(codex
            .iter()
            .all(|item| item.interface_format == "openai_responses"
                && item.base_url.starts_with("https://")));
        let claude = provider_presets(adapters::known(CliId::ClaudeCode), true);
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].base_url, "https://api.anthropic.com");
    }

    #[test]
    fn distinct_native_roles_and_project_paths() {
        let home = Path::new("/home/example");
        let project = Path::new("/work/project");
        let pi = native_files(CliId::Pi, Scope::Global, home, None, true);
        assert_eq!(pi.len(), 3);
        assert!(
            pi.iter()
                .find(|item| item.role == "auth")
                .unwrap()
                .sensitive
        );
        assert!(!pi.iter().find(|item| item.role == "auth").unwrap().writable);
        let codex = native_files(CliId::Codex, Scope::Project, home, Some(project), true);
        assert_eq!(codex.len(), 1);
        assert!(
            codex[0].path.ends_with(".codex/config.toml")
                || codex[0].path.ends_with(".codex\\config.toml")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires the five installed CLI shims on the local Windows host"]
    fn live_windows_probe_reports_real_versions_without_reading_user_configs() {
        let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap();
        for tool in CliId::ALL {
            let result = probe(tool, None, &home, None, Scope::Global);
            assert!(
                result.selected_path.is_some(),
                "{}: {:?}",
                tool.name(),
                result.installations
            );
            assert_eq!(
                result.native_writes.state,
                "supported",
                "{}: {:?}",
                tool.name(),
                result.installations
            );
        }
    }
}
