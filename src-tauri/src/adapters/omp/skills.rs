//! OMP Skills and rules: user/project `skills/<name>/SKILL.md`, generated
//! Skills, and OMP-owned context rule files.
//!
//! OMP owns the writable roots; generated/learned Skills and foreign provider
//! roots (`claude`, `codex`, `.agent`/`.agents`, `.github`) are read-only
//! observations. A switch only edits OMP's own `disabledExtensions` array in
//! its user/project `config.yml`; no foreign file is changed.
//!
//! Rules follow OMP's native context files: `~/.omp/agent/AGENTS.md` and the
//! project `.omp/AGENTS.md`. `RULES.md` stays native and is not rewritten.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::adapters::{RuleFileSpec, RuleSupport, SkillObservation, SkillSwitchLocation};
use crate::native::adapter::Scope;
use crate::native::format::FileKind;

use super::mcp::{project_config_directory, user_agent_directory_checked};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP Skills 与规则资源（原生根、外部来源只读、禁用覆盖）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 自有 Skills 与规则；扩展、插件与内置来源保持只读";

pub(crate) fn supported() -> bool {
    true
}

pub(crate) fn facet() -> crate::adapters::Facet {
    if supported() {
        crate::adapters::Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        }
    } else {
        crate::adapters::Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        }
    }
}

pub(crate) fn root(scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
    Some(match scope {
        Scope::Global => user_agent_directory_checked(home).ok()?.join("skills"),
        Scope::Project => project_config_directory(project?).join("skills"),
    })
}

pub(crate) fn requires_manifest() -> bool {
    true
}

pub(crate) fn observations(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
) -> Vec<SkillObservation> {
    let mut roots = Vec::new();
    match scope {
        Scope::Global => {
            if let Ok(agent) = user_agent_directory_checked(home) {
                roots.push(SkillObservation {
                    root: agent.join("managed-skills"),
                    detail: "OMP 自动学习生成的 Skills，只读，由原生自动学习写入",
                });
            }
            for (relative, detail) in [
                (
                    ".claude/skills",
                    "Claude Code Skills，只读；OMP 是否加载受 enabledProviders 控制",
                ),
                (
                    ".codex/skills",
                    "Codex Skills，只读；OMP 是否加载受 enabledProviders 控制",
                ),
                (".agent/skills", ".agent Skills，只读"),
                (".agents/skills", ".agents Skills，只读"),
                (
                    ".config/opencode/skills",
                    "OpenCode Skills，只读；OMP 是否加载受 enabledProviders 控制",
                ),
            ] {
                roots.push(SkillObservation {
                    root: home.join(relative),
                    detail,
                });
            }
        }
        Scope::Project => {
            let Some(project) = project else {
                return roots;
            };
            for (relative, detail) in [
                (".claude/skills", "项目 Claude Code Skills，只读"),
                (".codex/skills", "项目 Codex Skills，只读"),
                (".agent/skills", "项目 .agent Skills，只读"),
                (".agents/skills", "项目 .agents Skills，只读"),
                (".github/skills", "项目 GitHub Agent Skills，只读"),
            ] {
                roots.push(SkillObservation {
                    root: project.join(relative),
                    detail,
                });
            }
        }
    }
    roots
}

fn config_file(base: &Path) -> PathBuf {
    let yml = base.join("config.yml");
    if yml.is_file() {
        return yml;
    }
    let yaml = base.join("config.yaml");
    if yaml.is_file() {
        yaml
    } else {
        yml
    }
}

pub(crate) fn user_config_path(home: &Path) -> Option<PathBuf> {
    user_agent_directory_checked(home)
        .ok()
        .map(|agent| config_file(&agent))
}

pub(crate) fn project_config_path(project: &Path) -> PathBuf {
    // OMP 18.20.2 reads only `.omp/config.yml` in project scope; a `.yaml`
    // sibling is ignored, so the switch must not target it.
    project_config_directory(project).join("config.yml")
}

pub(crate) fn switch_location(
    scope: Scope,
    home: &Path,
    project: Option<&Path>,
    _name: &str,
) -> Option<SkillSwitchLocation> {
    Some(SkillSwitchLocation {
        path: match scope {
            Scope::Global => user_config_path(home)?,
            Scope::Project => project_config_path(project?),
        },
        kind: FileKind::Yaml,
        field: vec!["disabledExtensions".into()],
    })
}

pub(crate) fn switch_requires_version() -> bool {
    false
}

fn skill_tag(skill_path: &Path) -> Option<String> {
    let name = skill_path.file_name()?.to_str()?;
    (!name.is_empty()).then(|| format!("skill:{name}"))
}

fn current_list(current: &Value) -> Vec<String> {
    current
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn switch_value(current: &Value, enabled: bool, skill_path: &Path) -> Value {
    let Some(tag) = skill_tag(skill_path) else {
        return current.clone();
    };
    let mut values = current_list(current);
    values.retain(|value| value != &tag);
    if !enabled {
        values.push(tag);
    }
    json!(values)
}

pub(crate) fn switch_enabled(current: &Value, skill_path: &Path) -> bool {
    let Some(tag) = skill_tag(skill_path) else {
        return true;
    };
    !current_list(current).iter().any(|value| value == &tag)
}

/// `true` records "this skill is disabled"; absence records the enabled state.
pub(crate) fn switch_snapshot(current: &Value, skill_path: &Path) -> Option<Value> {
    let tag = skill_tag(skill_path)?;
    current_list(current)
        .iter()
        .any(|value| value == &tag)
        .then(|| json!(true))
}

pub(crate) fn switch_restore(
    current: &Value,
    _previous: Option<&Value>,
    skill_path: &Path,
) -> Option<Value> {
    let tag = skill_tag(skill_path)?;
    let mut values = current_list(current);
    values.retain(|value| value != &tag);
    (!values.is_empty()).then(|| json!(values))
}

pub(crate) fn rule_path(scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
    Some(match scope {
        Scope::Global => user_agent_directory_checked(home).ok()?.join("AGENTS.md"),
        Scope::Project => project_config_directory(project?).join("AGENTS.md"),
    })
}

pub(crate) fn rule_support() -> RuleSupport {
    RuleSupport::bare(true, true)
}

pub(crate) fn uses_rule_catalog(_scope: Scope) -> bool {
    false
}

pub(crate) fn rule_file_specs(
    _scope: Scope,
    _home: &Path,
    _project: Option<&Path>,
) -> Result<Vec<RuleFileSpec>, String> {
    Err("OMP 使用单文件 AGENTS.md 规则，没有目录型规则".into())
}

pub(crate) fn rule_create_path(_project: &Path, _name: &str) -> Result<PathBuf, String> {
    Err("OMP 使用单文件 AGENTS.md 规则，不能新建目录型规则".into())
}

pub(crate) fn rule_relocate(
    _project: &Path,
    _path: &Path,
    _enabled: bool,
) -> Result<PathBuf, String> {
    Err("OMP 使用单文件 AGENTS.md 规则，不能启停目录型规则".into())
}

pub(crate) fn rule_unavailable_reason(_scope: Scope) -> Option<&'static str> {
    None
}

/// Remote POSIX roots under the login home: the writable OMP root first, then
/// generated and foreign roots OMP can read but never write.
pub(crate) fn remote_directories() -> Vec<crate::adapters::RemoteSkillDirectory> {
    use crate::adapters::RemoteSkillDirectory;
    let mut roots = vec![RemoteSkillDirectory {
        relative: ".omp/agent/skills",
        read_only: false,
        detail: "OMP 用户 Skills（默认 Profile）",
    }];
    for (relative, detail) in [
        (
            ".omp/agent/managed-skills",
            "OMP 自动学习生成的 Skills，只读",
        ),
        (".claude/skills", "Claude Code Skills，只读"),
        (".codex/skills", "Codex Skills，只读"),
        (".agent/skills", ".agent Skills，只读"),
        (".agents/skills", ".agents Skills，只读"),
        (".config/opencode/skills", "OpenCode Skills，只读"),
    ] {
        roots.push(RemoteSkillDirectory {
            relative,
            read_only: true,
            detail,
        });
    }
    roots
}

fn checks(entries: Vec<(String, bool, String)>) -> Value {
    let failed = entries.iter().any(|(_, passed, _)| !passed);
    json!({
        "passed": !failed,
        "checks": entries
            .into_iter()
            .map(|(name, passed, detail)| json!({ "name": name, "passed": passed, "detail": detail }))
            .collect::<Vec<_>>(),
    })
}

pub(crate) fn verify_case(
    case: &serde_json::Value,
    context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    let action = case
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| super::verify::CaseError::Failed("skills 用例缺少 action".into()))?;
    let mut entries = Vec::new();
    match action {
        "layout" => {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .ok_or_else(|| super::verify::CaseError::Failed("layout 用例缺少 expect".into()))?;
            let actual = |scope: Scope| {
                root(scope, &context.home, Some(&context.project))
                    .map(|path| path.display().to_string().replace('\\', "/"))
                    .unwrap_or_default()
            };
            for (field, value) in [
                ("user", actual(Scope::Global)),
                ("project", actual(Scope::Project)),
            ] {
                let expected = expect
                    .get(field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .replace(
                        "{home}",
                        &context.home.display().to_string().replace('\\', "/"),
                    )
                    .replace(
                        "{project}",
                        &context.project.display().to_string().replace('\\', "/"),
                    );
                entries.push((
                    format!("{field} Skills 根"),
                    value == expected,
                    format!("实际 {value}，期望 {expected}"),
                ));
            }
            entries.push((
                "规则文件".into(),
                rule_path(Scope::Global, &context.home, None)
                    .is_some_and(|path| path.ends_with("AGENTS.md")),
                "AGENTS.md".into(),
            ));
        }
        "switch" => {
            let items = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| super::verify::CaseError::Failed("switch 用例缺少 cases".into()))?;
            for item in items {
                let current = item.get("current").cloned().unwrap_or_else(|| json!([]));
                let name = item
                    .get("skill")
                    .and_then(Value::as_str)
                    .unwrap_or("example");
                let enabled = item
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let path = context.project.join("skills").join(name);
                let value = switch_value(&current, enabled, &path);
                let expect = item
                    .get("expect")
                    .and_then(Value::as_array)
                    .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                    .unwrap_or_default();
                let actual = current_list(&value);
                entries.push((
                    format!("{name} -> {enabled}"),
                    actual == expect,
                    format!("实际 {actual:?}"),
                ));
                entries.push((
                    format!("{name} 启用状态"),
                    switch_enabled(&value, &path) == enabled,
                    format!("{:?}", switch_enabled(&value, &path)),
                ));
            }
        }
        "observations" => {
            let expected = case
                .get("sources")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let observed = observations(Scope::Global, &context.home, Some(&context.project));
            for source in expected {
                entries.push((
                    source.to_owned(),
                    observed
                        .iter()
                        .any(|observation| observation.detail.contains(source)),
                    observed
                        .iter()
                        .map(|observation| observation.detail)
                        .collect::<Vec<_>>()
                        .join("；"),
                ));
            }
        }
        other => {
            return Err(super::verify::CaseError::Failed(format!(
                "未知的 skills 用例 action：{other}"
            )))
        }
    }
    Ok(json!({ "kind": "skills", "action": action, "result": checks(entries) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/example")
    }

    #[test]
    fn native_roots_and_rule_paths_are_omp_owned() {
        assert_eq!(
            root(Scope::Global, &home(), None).unwrap(),
            home().join(".omp/agent/skills")
        );
        assert_eq!(
            root(Scope::Project, &home(), Some(Path::new("/work/app"))).unwrap(),
            Path::new("/work/app/.omp/skills")
        );
        assert_eq!(
            rule_path(Scope::Global, &home(), None).unwrap(),
            home().join(".omp/agent/AGENTS.md")
        );
        assert_eq!(
            rule_path(Scope::Project, &home(), Some(Path::new("/work/app"))).unwrap(),
            Path::new("/work/app/.omp/AGENTS.md")
        );
        assert!(rule_support().global);
        assert!(rule_support().project);
    }

    #[test]
    fn switch_only_adds_or_removes_omp_disabled_extension_tags() {
        let path = Path::new("/work/app/.omp/skills/example");
        let disabled = switch_value(&json!(["skill:keep"]), false, path);
        assert_eq!(disabled, json!(["skill:keep", "skill:example"]));
        assert!(!switch_enabled(&disabled, path));
        let enabled = switch_value(&disabled, true, path);
        assert_eq!(enabled, json!(["skill:keep"]));
        assert!(switch_enabled(&enabled, path));
        assert_eq!(switch_snapshot(&disabled, path), Some(json!(true)));
        assert_eq!(switch_snapshot(&enabled, path), None);
        assert_eq!(
            switch_restore(&disabled, Some(&json!(true)), path),
            Some(json!(["skill:keep"]))
        );
    }

    #[test]
    fn generated_and_foreign_roots_are_read_only_observations() {
        let roots = observations(Scope::Global, &home(), None);
        assert!(roots
            .iter()
            .any(|root| root.root == home().join(".omp/agent/managed-skills")));
        assert!(roots
            .iter()
            .any(|root| root.root == home().join(".claude/skills")));
        let project = observations(Scope::Project, &home(), Some(Path::new("/work/app")));
        assert!(project
            .iter()
            .any(|root| root.root == Path::new("/work/app/.github/skills")));
    }
}
