//! Devin custom subagent profiles (official docs `cli/subagents.md`, curl
//! 2026-10-24; local 3000.11.205 verified — `devin doctor` loads profiles from
//! a project `.devin/agents/` and a frontmatter-less probe file was loaded
//! under its file name).
//!
//! Directory contract (subagents.md): user-level `%APPDATA%\devin\agents`,
//! project-level `.devin\agents`. A flat `<name>.md` file names the profile by
//! its file name; a directory form `<name>/AGENT.md` names it by the parent
//! directory (`AGENTS.md`, `agent.md`, `agents.md` are accepted too, and when
//! several are present the native precedence is AGENT.md > AGENTS.md >
//! agent.md > agents.md, line 237). Plugins contribute the same layout inside
//! their package root (plugins/overview.md lines 31-32, "reviewer/AGENT.md
//! also works").
//!
//! `config.json` never carries inline agent definitions (definitions live in
//! the agents directories and in plugins only), and the file is JSONC content
//! under a `.json` name, so `config_paths` clears the settings documents
//! entirely: the shared engine would parse them as plain JSON and fail on
//! comments/trailing commas, breaking the Agents page on every real install.
use super::Devin;
use crate::adapters::agents::{validate_markdown_fields, AgentAdapter, AgentCapability, BuiltinAgent};
use crate::native::adapter::Scope;
use serde_json::Value;
use std::path::{Path, PathBuf};

impl AgentAdapter for Devin {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: "3000.11.205",
            supported: true,
            format: "markdown",
            detail: "原生 %APPDATA%\\devin\\agents 与项目 .devin\\agents 的 Markdown frontmatter（本机 doctor 实测加载）；平铺文件名即 profile id，或目录式 <name>\\AGENT.md（多候选时原生按 AGENT.md>AGENTS.md>agent.md>agents.md 取一，此处全部列出不代选）；name 可选（缺省取文件名/目录名）、description/model/allowed-tools（别名 tools）/max-nesting；allowed-tools 不能授予 ask_user_question；name 撞内置 subagent_explore/subagent_general 会被原生跳过并警告；重启会话后加载。config.json 为 JSONC 内容且无内联定义，不参与解析。",
            template: "---\nname: reviewer\ndescription: Review code changes\nmodel: example-opus-medium\nallowed-tools: Read, Grep, Glob\nmax-nesting: 2\n---\nReview code changes and report findings.\n",
        }
    }
    /// Built-in profile catalog, subagents.md lines 125-126: the read-only
    /// explore profile runs on the default subagent model; the general profile
    /// (including code changes) follows the parent agent's model.
    fn builtin_definitions(&self) -> &'static [BuiltinAgent] {
        &[
            BuiltinAgent {
                name: "subagent_explore",
                description: "内置只读探索 subagent：只读代码探索与研究，含 web 搜索，不能改文件；运行在默认 subagent 模型上",
            },
            BuiltinAgent {
                name: "subagent_general",
                description: "内置通用 subagent：通用任务含代码修改，前台拥有完整工具；跟随父 agent 的模型",
            },
        ]
    }
    /// Same combination as codex: the adapter root is the config root itself
    /// and the default `definition_dirs() == ["agents"]` appends the agents
    /// directory, yielding `%APPDATA%\devin\agents` and `.devin/agents`.
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(match scope {
            Scope::Global => super::config_root(home),
            Scope::Project => project.ok_or("请选择项目")?.join(".devin"),
        })
    }
    /// Devin has no inline agent definitions and config.json is JSONC content
    /// under a .json name; a settings document in the scan would make every
    /// JSONC-configured install fail the Agents page, so clear the paths.
    fn config_paths(
        &self,
        _home: &Path,
        _target: &crate::resources::plugins::PluginTarget,
        _paths: Vec<PathBuf>,
    ) -> Result<Vec<PathBuf>, String> {
        Ok(Vec::new())
    }
    /// Frontmatter `name` is optional (subagents.md): a probe file without it
    /// was loaded by its file name on 3000.11.205.
    fn required_name(&self) -> bool {
        false
    }
    /// Directory form `<name>/AGENT.md`: the parent directory names the
    /// profile (subagents.md line 237; the sibling file names are accepted
    /// with the listed precedence).
    fn definition_fallback(&self, path: &Path) -> Option<String> {
        let file = path.file_name()?.to_str()?;
        if matches!(file, "AGENT.md" | "AGENTS.md" | "agent.md" | "agents.md") {
            return path
                .parent()?
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned);
        }
        None
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        validate_markdown_fields(value)?;
        // ask_user_question is always withheld from subagents
        // (subagents.md line 310: "Cannot grant `ask_user_question`").
        for key in ["allowed-tools", "tools"] {
            if let Some(tools) = value.get(key) {
                let granted = match tools {
                    Value::String(text) => text
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .any(|tool| tool == "ask_user_question"),
                    Value::Array(list) => list
                        .iter()
                        .any(|tool| tool.as_str() == Some("ask_user_question")),
                    _ => false,
                };
                if granted {
                    return Err("ask_user_question 不能授予 subagent（原生始终扣留）".into());
                }
            }
        }
        // Devin has none of these fields; `devin doctor` flags unsupported
        // frontmatter (CFG005) on 3000.11.205, so reject instead of writing
        // definitions the CLI will skip.
        for key in ["permissionMode", "maxTurns", "effort"] {
            if value.get(key).is_some() {
                return Err(format!("{key} 不是 Devin subagent 字段"));
            }
        }
        if value
            .get("max-nesting")
            .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0))
        {
            return Err("max-nesting 必须为正整数".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::agents::validate_registered;
    use crate::adapters::Registry;
    use crate::native::format::FileKind;
    use crate::resources::plugins::PluginTarget;

    const NATIVE_FIXTURE: &str =
        include_str!("../../../../tests/fixtures/native/devin-3000.json");

    fn devin_adapter() -> &'static dyn AgentAdapter {
        crate::adapters::agents::get_registered(&Registry::builtins(), "devin").unwrap()
    }

    #[test]
    fn roots_follow_the_official_user_and_project_agent_layout() {
        let home = Path::new("/home/example");
        let global = Devin.root(Scope::Global, home, None).unwrap();
        let global = global.to_string_lossy().replace('\\', "/");
        assert!(global.ends_with("devin"), "{global}");
        let project = Devin
            .root(Scope::Project, home, Some(Path::new("/work/p")))
            .unwrap();
        assert!(project
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("p/.devin"));
        assert!(Devin.root(Scope::Project, home, None).is_err());
        let adapter = devin_adapter();
        assert_eq!(adapter.definition_dirs(), ["agents"]);
        assert!(!adapter.required_name());
        // The default writable definition lands in root/agents/<name>.md.
        let writable = adapter
            .writable_definition(Path::new("/work/p/.devin"), "reviewer")
            .unwrap();
        assert!(writable
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("agents/reviewer.md"));
        let capability = adapter.capability();
        assert!(capability.supported);
        assert_eq!(capability.format, "markdown");
        let builtins: Vec<_> = adapter
            .builtin_definitions()
            .iter()
            .map(|builtin| builtin.name)
            .collect();
        assert_eq!(builtins, ["subagent_explore", "subagent_general"]);
    }

    #[test]
    fn config_paths_clear_settings_documents_entirely() {
        let adapter = devin_adapter();
        let target = PluginTarget {
            tool_id: "devin".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let paths = adapter
            .config_paths(
                Path::new("/home/example"),
                &target,
                vec![PathBuf::from("/home/example/devin/config.json")],
            )
            .unwrap();
        assert!(paths.is_empty(), "settings 不参与 agents 解析：{paths:?}");
        // Lock the exclusion with the sanitized native fixture: config.json is
        // JSONC content under a .json name, so a plain-JSON parse fails while
        // a JSONC parse succeeds — letting it through would break the page.
        assert!(crate::native::format::parse(FileKind::Json, NATIVE_FIXTURE).is_err());
        assert!(crate::native::format::parse(FileKind::Jsonc, NATIVE_FIXTURE).is_ok());
    }

    #[test]
    fn frontmatter_contract_accepts_devin_fields_and_rejects_foreign_ones() {
        let registry = Registry::builtins();
        let (name, description) = validate_registered(
            &registry,
            "devin",
            "markdown",
            "---\nname: reviewer\ndescription: Review code\nmodel: example-opus-medium\nallowed-tools: Read, Grep\nmax-nesting: 2\n---\nReview code.\n",
            "fallback",
        )
        .unwrap();
        assert_eq!(name, "reviewer");
        assert_eq!(description, "Review code");
        // name is optional: the fallback (file/directory) name applies.
        let (fallback_name, _) = validate_registered(
            &registry,
            "devin",
            "markdown",
            "---\ndescription: Probe profile\n---\nBody text.\n",
            "probe-no-name",
        )
        .unwrap();
        assert_eq!(fallback_name, "probe-no-name");
        // Directory-form AGENT.md falls back to the parent directory name.
        let (directory_name, _) = validate_registered(
            &registry,
            "devin",
            "markdown",
            "---\ndescription: Directory form\n---\nBody text.\n",
            "AGENT",
        )
        .unwrap();
        assert_eq!(directory_name, "AGENT");
        let path = Path::new("/work/p/.devin/agents/reviewer/AGENT.md");
        assert_eq!(
            devin_adapter().definition_fallback(path).as_deref(),
            Some("reviewer")
        );
        assert_eq!(
            devin_adapter()
                .definition_fallback(Path::new("/work/p/.devin/agents/flat.md")),
            None
        );
        // ask_user_question is never grantable (subagents.md line 310).
        for source in [
            "---\nname: bad\ndescription: d\nallowed-tools: Read, ask_user_question\n---\nbody\n",
            "---\nname: bad\ndescription: d\ntools:\n  - ask_user_question\n---\nbody\n",
        ] {
            assert!(validate_registered(&registry, "devin", "markdown", source, "fallback")
                .is_err());
        }
        // Foreign fields Devin does not have are rejected up front.
        for source in [
            "---\nname: bad\ndescription: d\npermissionMode: auto\n---\nbody\n",
            "---\nname: bad\ndescription: d\nmaxTurns: 5\n---\nbody\n",
            "---\nname: bad\ndescription: d\neffort: high\n---\nbody\n",
        ] {
            assert!(
                validate_registered(&registry, "devin", "markdown", source, "fallback").is_err(),
                "应拒绝非 Devin 字段：{source}"
            );
        }
        // max-nesting must be a positive integer.
        assert!(validate_registered(
            &registry,
            "devin",
            "markdown",
            "---\nname: bad\ndescription: d\nmax-nesting: 0\n---\nbody\n",
            "fallback"
        )
        .is_err());
        assert!(validate_registered(
            &registry,
            "devin",
            "markdown",
            "---\nname: bad\ndescription: d\nmax-nesting: two\n---\nbody\n",
            "fallback"
        )
        .is_err());
    }
}
