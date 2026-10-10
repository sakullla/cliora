use crate::native::{
    adapter::Scope,
    format::{self, FileKind},
    transaction,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Resolve only documented/verified inputs; never perform the client's legacy
/// directory migration merely to inspect configuration.
pub(super) fn resolve(
    home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<PathBuf, String> {
    let nonempty = |name| {
        env(name)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let legacy = nonempty("__MAVIS_ALLOW_LEGACY_RUNTIME_ENV").as_deref() == Some("1");
    if let Some(root) = nonempty("MINIMAX_DATA_DIR")
        .or_else(|| nonempty("MAVIS_DATA_DIR"))
        .or_else(|| {
            legacy
                .then(|| nonempty("__MAVIS_RUNTIME_DATA_DIR"))
                .flatten()
        })
    {
        let path = PathBuf::from(root);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err("MiniMax 数据目录覆盖必须使用绝对路径，避免启动工作目录改变配置目标".into())
        };
    }
    let profile = legacy
        .then(|| nonempty("__MAVIS_RUNTIME_PROFILE"))
        .flatten();
    if profile.as_deref().is_some_and(|v| {
        !v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }) {
        return Err("MiniMax 原生 profile 名称无效；请使用显式绝对数据目录".into());
    }
    let suffix = profile.map(|v| format!("-{v}")).unwrap_or_default();
    let primary = home.join(format!(".minimax{suffix}"));
    let old = home.join(format!(".mavis{suffix}"));
    Ok(if !primary.exists() && old.is_dir() {
        old
    } else {
        primary
    })
}
pub(super) fn root(home: &Path) -> Result<PathBuf, String> {
    resolve(home, &|name| {
        if dirs::home_dir().as_deref() == Some(home) {
            std::env::var(name).ok()
        } else {
            None
        }
    })
}
pub(super) fn config(home: &Path) -> Result<Value, String> {
    format::parse(
        FileKind::Yaml,
        &transaction::read_native(&root(home)?.join("config.yaml"))?,
    )
}
fn external_enabled(config: &Value, source: &str) -> bool {
    let external = &config["skills"]["external"];
    let alias = match source {
        "user-cc" => "user-claude",
        "workspace-cc" => "workspace-claude",
        _ => source,
    };
    let source = external["sources"]
        .get(source)
        .or_else(|| external["sources"].get(alias));
    external["enabled"].as_bool().unwrap_or(true)
        && source.and_then(|v| v["enabled"].as_bool()).unwrap_or(true)
}
pub(super) fn skill_root(scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
    match scope {
        Scope::Global => Some(root(home).ok()?.join("skills")),
        Scope::Project => external_enabled(&config(home).ok()?, "workspace-minimax")
            .then(|| project.map(|p| p.join(".minimax/skills")))
            .flatten(),
    }
}
pub(super) fn skill_sources(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Vec<super::super::SkillReadRoot> {
    let (Ok(root), Ok(config)) = (root(home), config(home)) else {
        return vec![];
    };
    let reason =
        "MiniMax 外部、agent 或内置来源：只读浏览；来源启用设置及同名优先级由原生客户端决定";
    let mut sources = Vec::new();
    let mut add = |id, path| sources.push(super::super::SkillReadRoot { id, path, reason });
    if scope == Scope::Global {
        add("minimax_builtin", root.join(".builtin-skills"));
        // Default CLI agent, not arbitrary agents belonging to another session.
        add("minimax_agent", root.join("agents/mavis/skills"));
        for (id, path) in [
            ("user-cc", ".claude/skills"),
            ("user-codex", ".codex/skills"),
            ("user-agents", ".agents/skills"),
        ] {
            if external_enabled(&config, id) {
                add(id, home.join(path));
            }
        }
        if dirs::home_dir().as_deref() == Some(home) {
            if let Some(path) = std::env::var_os("MAVIS_BUILTIN_SKILLS_DIR")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
            {
                add("minimax_builtin_override", path);
            }
            if let Some(path) = std::env::var_os("MAVIS_BUILTIN_AGENTS_DIR")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
            {
                add("minimax_agent_override", path.join("mavis/skills"));
            }
        }
    } else if let Some(project) = project {
        let walk = config["skills"]["external"]["walkUp"]
            .as_bool()
            .unwrap_or(true);
        let mut bases = vec![project.to_path_buf()];
        if walk {
            let mut current = project;
            while !current.join(".git").exists() {
                let Some(parent) = current.parent() else {
                    bases.truncate(1);
                    break;
                };
                bases.push(parent.to_path_buf());
                current = parent;
            }
        }
        for (index, base) in bases.into_iter().enumerate() {
            for (id, path) in [
                ("workspace-minimax", ".minimax/skills"),
                ("workspace-cc", ".claude/skills"),
                ("workspace-agents", ".agents/skills"),
            ] {
                if external_enabled(&config, id) && !(index == 0 && id == "workspace-minimax") {
                    add(id, base.join(path));
                }
            }
        }
    }
    sources
}
