use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::format::FileKind;
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
    pub tool: CliId,
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
    pub provider_presets: Vec<ProviderPreset>,
}

fn provider_presets(tool: CliId, known: bool) -> Vec<ProviderPreset> {
    let formats = interface_formats(tool, known);
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
            base_url: if tool == CliId::ClaudeCode {
                "https://api.anthropic.com"
            } else {
                "https://api.anthropic.com/v1"
            },
            interface_format: "anthropic_messages",
            source_url: "https://platform.claude.com/docs/en/api/overview",
        });
    }
    presets
}

fn npm_package(tool: CliId) -> &'static str {
    match tool {
        CliId::Codex => "@openai/codex",
        CliId::ClaudeCode => "@anthropic-ai/claude-code",
        CliId::Grok => "@xai-official/grok",
        CliId::Pi => "@mariozechner/pi-coding-agent",
        CliId::OpenCode => "opencode-ai",
    }
}

fn source_of(path: &Path, tool: CliId) -> &'static str {
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    if ext.eq_ignore_ascii_case("ps1") || ext.eq_ignore_ascii_case("cmd") {
        if let Ok(file) = std::fs::File::open(path) {
            let mut bytes = Vec::new();
            if file.take(16_384).read_to_end(&mut bytes).is_err() {
                return "unknown";
            }
            let sample = String::from_utf8_lossy(&bytes).replace('\\', "/");
            if sample.contains("node_modules/") && sample.contains(npm_package(tool)) {
                return "npm_shim";
            }
        }
    }
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if tool == CliId::ClaudeCode && normalized.contains("/.local/bin/claude") {
        return "claude_native";
    }
    "unknown"
}

fn on_path(name: &str) -> bool {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .any(|dir| {
            if cfg!(windows) {
                dir.join(format!("{name}.exe")).is_file()
                    || dir.join(format!("{name}.cmd")).is_file()
            } else {
                dir.join(name).is_file()
            }
        })
}

fn node_major() -> Option<u32> {
    if !on_path("node") {
        return None;
    }
    let mut child = Command::new("node")
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
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn dependencies(tool: CliId, source: &str, no_candidates: bool) -> Vec<Dependency> {
    let mut result = Vec::new();
    let needs_npm =
        source == "npm_shim" || (no_candidates && !matches!(tool, CliId::ClaudeCode | CliId::Grok));
    if needs_npm {
        let major = node_major();
        result.push(Dependency {
            name: "Node.js",
            status: match major {
                None => "missing",
                Some(version) if tool == CliId::ClaudeCode && version < 22 => "outdated",
                Some(_) => "found",
            },
            detail: if tool == CliId::ClaudeCode {
                "Claude Code 的 npm 安装需要 Node.js 22 或更新版本"
            } else {
                "npm 命令入口需要 Node.js"
            },
            help_url: "https://nodejs.org/en/download",
        });
        result.push(Dependency {
            name: "npm",
            status: if on_path("npm") { "found" } else { "missing" },
            detail: "升级 npm 安装需要 npm",
            help_url: "https://nodejs.org/en/download",
        });
    }
    if cfg!(windows) && tool == CliId::Pi {
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

fn install_command(tool: CliId) -> Option<String> {
    if tool == CliId::ClaudeCode {
        return Some(
            if cfg!(windows) {
                "irm https://claude.ai/install.ps1 | iex"
            } else {
                "curl -fsSL https://claude.ai/install.sh | bash"
            }
            .into(),
        );
    }
    if tool == CliId::Grok {
        return Some(
            if cfg!(windows) {
                "irm https://x.ai/cli/install.ps1 | iex"
            } else {
                "curl -fsSL https://x.ai/cli/install.sh | bash"
            }
            .into(),
        );
    }
    Some(format!("npm install -g {}", npm_package(tool)))
}

fn upgrade_command(tool: CliId, source: &str) -> Option<String> {
    match source {
        "npm_shim" => Some(format!("npm install -g {}@latest", npm_package(tool))),
        "claude_native" if tool == CliId::ClaudeCode => Some("claude update".into()),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project,
}

fn command_name(tool: CliId) -> &'static str {
    match tool {
        CliId::Codex => "codex",
        CliId::ClaudeCode => "claude",
        CliId::Grok => "grok",
        CliId::Pi => "pi",
        CliId::OpenCode => "opencode",
    }
}

fn install_guidance(tool: CliId) -> (&'static str, &'static str) {
    match tool {
        CliId::Codex => (
            "https://developers.openai.com/codex/cli",
            "按官方文档更新 Codex CLI；使用原安装来源升级。",
        ),
        CliId::ClaudeCode => (
            "https://code.claude.com/docs/en/setup",
            "按 Claude Code 安装来源更新；原生安装可使用 claude update。",
        ),
        CliId::Grok => (
            "https://x.ai/cli",
            "按 xAI Build 官方安装说明更新 Grok CLI。",
        ),
        CliId::Pi => (
            "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
            "使用安装 Pi 的同一包管理器更新。",
        ),
        CliId::OpenCode => (
            "https://opencode.ai/docs/",
            "使用 opencode upgrade 或原安装来源更新。",
        ),
    }
}

fn candidates(tool: CliId) -> Vec<PathBuf> {
    let name = command_name(tool);
    let mut paths = Vec::new();
    let suffixes: &[&str] = if cfg!(windows) {
        &[".exe", ".ps1", ".cmd", ""]
    } else {
        &[""]
    };
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            for suffix in suffixes {
                let candidate = dir.join(format!("{name}{suffix}"));
                if candidate.is_file() && !paths.contains(&candidate) {
                    paths.push(candidate);
                }
            }
        }
    }
    paths
}

fn version_from_output(tool: CliId, path: &Path, output: &str) -> Option<String> {
    let basename = path.file_stem()?.to_str()?.to_ascii_lowercase();
    let lower = output.to_ascii_lowercase();
    let identity = match tool {
        CliId::Codex => lower.contains("codex"),
        CliId::ClaudeCode => lower.contains("claude"),
        CliId::Grok => lower.contains("grok"),
        CliId::Pi => {
            lower.contains("pi ")
                || (basename == "pi"
                    && (lower.starts_with('v')
                        || lower.chars().next().is_some_and(|c| c.is_ascii_digit())))
        }
        CliId::OpenCode => {
            lower.contains("opencode")
                || (basename == "opencode"
                    && (lower.starts_with('v')
                        || lower.chars().next().is_some_and(|c| c.is_ascii_digit())))
        }
    };
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

fn run_version(path: &Path, tool: CliId) -> Installation {
    let source = source_of(path, tool);
    let mut command = if cfg!(windows)
        && path
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("ps1"))
    {
        let mut cmd = Command::new("powershell.exe");
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
        Command::new(path)
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
        version_from_output(tool, path, &preview)
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
    run_version(path, tool)
}

fn supported_version(tool: CliId, version: &str) -> bool {
    let prefix = match tool {
        CliId::Codex => "0.158.",
        CliId::ClaudeCode => "2.1.",
        CliId::Grok => "1.0.",
        CliId::Pi => "0.87.",
        CliId::OpenCode => "1.18.",
    };
    version.starts_with(prefix)
}

fn file(
    role: &'static str,
    path: PathBuf,
    kind: FileKind,
    writable: bool,
    reason: Option<&'static str>,
    sensitive: bool,
) -> NativeFile {
    NativeFile {
        role,
        path: path.display().to_string(),
        format: match kind {
            FileKind::Toml => "toml",
            FileKind::Json => "json",
            FileKind::Jsonc => "jsonc",
        },
        writable,
        reason,
        sensitive,
    }
}

pub fn native_files(
    tool: CliId,
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    known_version: bool,
) -> Vec<NativeFile> {
    let root = match scope {
        Scope::Global => None,
        Scope::Project => project,
    };
    if scope == Scope::Project && root.is_none() {
        return Vec::new();
    }
    let writable = known_version;
    let unknown = if writable {
        None
    } else {
        Some("此版本的原生写入能力尚未验证")
    };
    match (tool, root) {
        (CliId::Codex, None) => vec![file(
            "settings",
            env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("config.toml"),
            FileKind::Toml,
            writable,
            unknown,
            false,
        )],
        (CliId::Codex, Some(project)) => vec![file(
            "settings",
            project.join(".codex/config.toml"),
            FileKind::Toml,
            writable,
            unknown,
            false,
        )],
        (CliId::ClaudeCode, None) => vec![file(
            "settings",
            home.join(".claude/settings.json"),
            FileKind::Json,
            writable,
            unknown,
            false,
        )],
        (CliId::ClaudeCode, Some(project)) => vec![
            file(
                "settings",
                project.join(".claude/settings.json"),
                FileKind::Json,
                writable,
                unknown,
                false,
            ),
            file(
                "local_settings",
                project.join(".claude/settings.local.json"),
                FileKind::Json,
                writable,
                unknown,
                false,
            ),
        ],
        (CliId::Grok, None) => vec![file(
            "settings",
            env::var_os("GROK_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".grok"))
                .join("config.toml"),
            FileKind::Toml,
            writable,
            unknown,
            false,
        )],
        (CliId::Grok, Some(project)) => vec![file(
            "settings",
            project.join(".grok/config.toml"),
            FileKind::Toml,
            writable,
            if writable {
                Some("项目配置仅支持 MCP、插件和权限；连接与模型须在用户范围设置")
            } else {
                unknown
            },
            false,
        )],
        (CliId::Pi, None) => {
            let directory = env::var_os("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".pi/agent"));
            vec![
                file(
                    "settings",
                    directory.join("settings.json"),
                    FileKind::Json,
                    writable,
                    unknown,
                    false,
                ),
                file(
                    "models",
                    directory.join("models.json"),
                    FileKind::Jsonc,
                    writable,
                    unknown,
                    false,
                ),
                file(
                    "auth",
                    directory.join("auth.json"),
                    FileKind::Json,
                    false,
                    Some("原生凭据文件独立保护，不进入配置草稿"),
                    true,
                ),
            ]
        }
        (CliId::Pi, Some(project)) => vec![file(
            "settings",
            project.join(".pi/settings.json"),
            FileKind::Json,
            writable,
            unknown,
            false,
        )],
        (CliId::OpenCode, None) => {
            let directory = env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("opencode");
            let jsonc = directory.join("opencode.jsonc");
            if jsonc.exists() {
                vec![file(
                    "settings",
                    jsonc,
                    FileKind::Jsonc,
                    writable,
                    unknown,
                    false,
                )]
            } else {
                vec![file(
                    "settings",
                    directory.join("opencode.json"),
                    FileKind::Json,
                    writable,
                    unknown,
                    false,
                )]
            }
        }
        (CliId::OpenCode, Some(project)) => {
            let jsonc = project.join("opencode.jsonc");
            if jsonc.exists() {
                vec![file(
                    "settings",
                    jsonc,
                    FileKind::Jsonc,
                    writable,
                    unknown,
                    false,
                )]
            } else {
                vec![file(
                    "settings",
                    project.join("opencode.json"),
                    FileKind::Json,
                    writable,
                    unknown,
                    false,
                )]
            }
        }
    }
}

pub fn interface_formats(tool: CliId, known: bool) -> Vec<&'static str> {
    if !known {
        return Vec::new();
    }
    match tool {
        CliId::Codex => vec!["openai_responses"],
        CliId::ClaudeCode => vec!["anthropic_messages"],
        CliId::Grok => vec![
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ],
        CliId::Pi => vec![
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ],
        CliId::OpenCode => vec![
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ],
    }
}

pub fn probe(
    tool: CliId,
    custom_path: Option<&Path>,
    home: &Path,
    project: Option<&Path>,
    scope: Scope,
) -> ToolProbe {
    let mut paths = candidates(tool);
    if let Some(path) = custom_path {
        paths.retain(|candidate| candidate != path);
        paths.insert(0, path.to_path_buf());
    }
    let installations: Vec<_> = paths
        .into_iter()
        .map(|path| run_version(&path, tool))
        .collect();
    let selected = installations.iter().find(|item| item.status == "available");
    let known = selected
        .and_then(|item| item.version.as_deref())
        .is_some_and(|version| supported_version(tool, version));
    let native_writes = if known {
        Capability {
            state: "supported",
            reason: "当前版本的原生配置映射已覆盖",
            evidence: "versioned_adapter",
        }
    } else if selected.is_some() {
        Capability {
            state: "unknown",
            reason: "检测到 CLI，但此版本尚无已验证映射；可查看原生文件",
            evidence: "version_probe",
        }
    } else {
        Capability {
            state: "unknown",
            reason: "未发现可确认身份的 CLI",
            evidence: "version_probe",
        }
    };
    let (install_url, upgrade_hint) = install_guidance(tool);
    let source = selected.map(|item| item.source).unwrap_or("unknown");
    let no_candidates = installations.is_empty();
    ToolProbe {
        tool,
        selected_path: selected.map(|item| item.path.clone()),
        installations,
        native_files: native_files(tool, scope, home, project, known),
        native_writes,
        interface_formats: interface_formats(tool, known),
        install_url,
        upgrade_hint,
        dependencies: dependencies(tool, source, no_candidates),
        install_command: if no_candidates {
            install_command(tool)
        } else {
            None
        },
        upgrade_command: upgrade_command(tool, source),
        provider_presets: provider_presets(tool, known),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_do_not_assert_unknown_write_capability() {
        assert!(supported_version(CliId::Codex, "0.158.0"));
        assert!(!supported_version(CliId::Codex, "0.159.0"));
        assert_eq!(
            version_from_output(CliId::Codex, Path::new("codex.ps1"), "codex-cli 0.158.0"),
            Some("0.158.0".into())
        );
        assert_eq!(
            version_from_output(CliId::Codex, Path::new("renamed.exe"), "codex-cli 0.158.0"),
            Some("0.158.0".into())
        );
        assert_eq!(
            version_from_output(CliId::Codex, Path::new("codex.ps1"), "claude 0.158.0"),
            None
        );
    }

    #[test]
    fn npm_source_requires_package_evidence_and_unknown_source_gets_no_upgrade_command() {
        let temp = tempfile::tempdir().unwrap();
        let shim = temp.path().join("grok.ps1");
        std::fs::write(&shim, "$basedir/node_modules/@xai-official/grok/bin/grok").unwrap();
        assert_eq!(source_of(&shim, CliId::Grok), "npm_shim");
        assert_eq!(
            upgrade_command(CliId::Grok, source_of(&shim, CliId::Grok)).as_deref(),
            Some("npm install -g @xai-official/grok@latest")
        );
        std::fs::write(&shim, "unrelated launcher").unwrap();
        assert_eq!(source_of(&shim, CliId::Grok), "unknown");
        assert_eq!(upgrade_command(CliId::Grok, "unknown"), None);
    }

    #[test]
    fn presets_only_offer_documented_addresses_in_tool_supported_formats() {
        assert!(provider_presets(CliId::Codex, false).is_empty());
        let codex = provider_presets(CliId::Codex, true);
        assert_eq!(codex.len(), 2);
        assert!(codex
            .iter()
            .all(|item| item.interface_format == "openai_responses"
                && item.base_url.starts_with("https://")));
        let claude = provider_presets(CliId::ClaudeCode, true);
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
