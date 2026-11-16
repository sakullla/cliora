//! OMP Agent definitions: user/project Markdown, extension and builtin sources.
//!
//! Native roots are `~/.omp/agent/agents/*.md` and `.omp/agents/*.md`; project
//! definitions override user ones and both override extension/bundled
//! definitions by exact name. Disabling uses OMP's own
//! `task.disabledAgents` setting, never a rewritten definition file.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::adapters::agents::{AgentAdapter, AgentCapability, AgentToggleLocation, BuiltinAgent};
use crate::adapters::Facet;
use crate::native::adapter::Scope;
use crate::native::format::FileKind;

use super::mcp::{project_config_directory, user_agent_directory_checked};
use super::skills::{project_config_path, user_config_path};

pub(crate) const UNAVAILABLE_REASON: &str =
    "OMP Agent 定义（用户/项目 Markdown、扩展来源与禁用策略）尚未交付";
pub(crate) const AVAILABLE_REASON: &str =
    "可管理 OMP 自有用户/项目 Agent 定义；内置与扩展来源保持只读";

const TEMPLATE: &str = "---\nname: reviewer\ndescription: Review a change for correctness.\nmodel: \"@review\"\ntools: read, grep, glob\n---\n\nReview the assigned change and report concrete findings.\n";
const DETAIL: &str = "OMP 用户与项目 Markdown Agent 定义；项目优先于用户、扩展和内置同名定义。禁用写入原生 task.disabledAgents，不修改定义文件。扩展与内置定义只读；未知 frontmatter 字段按原文件保留。";

/// Bundled OMP task agents. They are embedded in the CLI build and never
/// written by Cliora; names are the verified bundled set.
const BUILTINS: &[BuiltinAgent] = &[
    BuiltinAgent {
        name: "scout",
        description: "只读探索代理（OMP 内置）",
    },
    BuiltinAgent {
        name: "reviewer",
        description: "代码审查代理（OMP 内置）",
    },
    BuiltinAgent {
        name: "security-reviewer",
        description: "安全审查代理（OMP 内置）",
    },
    BuiltinAgent {
        name: "task",
        description: "通用任务代理（OMP 内置）",
    },
    BuiltinAgent {
        name: "sonic",
        description: "快速任务代理（OMP 内置）",
    },
    BuiltinAgent {
        name: "seance",
        description: "历史会话查阅代理（OMP 内置）",
    },
];

struct OmpAgents;

static PORT: OmpAgents = OmpAgents;

pub(crate) fn port() -> Option<&'static dyn AgentAdapter> {
    Some(&PORT)
}

pub(crate) fn facet() -> Facet {
    match port() {
        Some(adapter) if adapter.capability().supported => Facet {
            state: "available",
            reason: AVAILABLE_REASON,
        },
        _ => Facet {
            state: "planned",
            reason: UNAVAILABLE_REASON,
        },
    }
}

pub(crate) fn management_visible(port: Option<&dyn AgentAdapter>) -> bool {
    port.is_some_and(|adapter| adapter.capability().supported)
}

fn disabled_pointer() -> String {
    "/task/disabledAgents".into()
}

fn disabled_names_in(path: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_yaml::from_str::<Value>(&text).ok()?;
    let items = value.pointer(&disabled_pointer())?.as_array()?;
    Some(
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

impl AgentAdapter for OmpAgents {
    fn capability(&self) -> AgentCapability {
        AgentCapability {
            version: super::lifecycle::BASELINE,
            supported: true,
            format: "markdown",
            detail: DETAIL,
            template: TEMPLATE,
        }
    }

    fn builtin_definitions(&self) -> &'static [BuiltinAgent] {
        BUILTINS
    }

    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(match scope {
            Scope::Global => user_agent_directory_checked(home)?,
            Scope::Project => project_config_directory(project.ok_or("请选择项目目录")?),
        })
    }

    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents"]
    }

    fn recursive(&self) -> bool {
        false
    }

    fn required_name(&self) -> bool {
        true
    }

    fn directory_name_matches_definition(&self) -> bool {
        // OMP reads `agents/<stem>.md`; frontmatter `name` is independent.
        false
    }

    fn disabled_detail(&self) -> &'static str {
        "已由 OMP 原生 task.disabledAgents 停用。"
    }

    fn toggle_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        _name: &str,
    ) -> Option<AgentToggleLocation> {
        // Each scope writes its own layer. OMP's `task.disabledAgents` array
        // replaces the lower layer, so a project toggle must not edit the user
        // file (and project restore only accepts the project config).
        let path = match scope {
            Scope::Global => user_config_path(home)?,
            Scope::Project => project_config_path(project?),
        };
        Some(AgentToggleLocation {
            path,
            kind: FileKind::Yaml,
            field: vec!["task".into(), "disabledAgents".into()],
        })
    }

    fn toggle_seed(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        _name: &str,
    ) -> Value {
        // Arrays replace rather than concatenate across layers. Start a project
        // override from the effective list so enabling one agent does not
        // re-enable every agent disabled only at user scope.
        let names = match scope {
            Scope::Project => project
                .and_then(|project| disabled_names_in(&project_config_path(project)))
                .or_else(|| user_config_path(home).and_then(|path| disabled_names_in(&path))),
            Scope::Global => user_config_path(home).and_then(|path| disabled_names_in(&path)),
        };
        names.map(|names| json!(names)).unwrap_or(Value::Null)
    }

    fn disabled_names(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<String>, String> {
        let mut names = match scope {
            Scope::Project => project
                .and_then(|project| disabled_names_in(&project_config_path(project)))
                .or_else(|| user_config_path(home).and_then(|path| disabled_names_in(&path))),
            Scope::Global => user_config_path(home).and_then(|path| disabled_names_in(&path)),
        }
        .unwrap_or_default();
        names.sort();
        names.dedup();
        Ok(names)
    }

    fn toggle_value(&self, current: &Value, name: &str, enabled: bool) -> Option<Value> {
        let mut values: Vec<String> = current
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        values.retain(|value| value != name);
        if !enabled {
            values.push(name.to_owned());
        }
        (!values.is_empty()).then(|| json!(values))
    }
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
        .ok_or_else(|| super::verify::CaseError::Failed("agents 用例缺少 action".into()))?;
    let mut entries = Vec::new();
    match action {
        "capability" => {
            let capability = PORT.capability();
            entries.push((
                "supported".into(),
                capability.supported,
                capability.detail.into(),
            ));
            entries.push((
                "format".into(),
                capability.format == "markdown",
                capability.format.into(),
            ));
            entries.push((
                "template frontmatter".into(),
                capability.template.starts_with("---\n") && capability.template.contains("name:"),
                "模板保持 Markdown frontmatter".into(),
            ));
        }
        "layout" => {
            let expect = case
                .get("expect")
                .and_then(Value::as_object)
                .ok_or_else(|| super::verify::CaseError::Failed("layout 用例缺少 expect".into()))?;
            let user = PORT
                .root(Scope::Global, &context.home, None)
                .map(|path| path.join("agents").display().to_string().replace('\\', "/"))
                .unwrap_or_default();
            let project = PORT
                .root(Scope::Project, &context.home, Some(&context.project))
                .map(|path| path.join("agents").display().to_string().replace('\\', "/"))
                .unwrap_or_default();
            for (field, actual) in [("user", user), ("project", project)] {
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
                    format!("{field} Agents 根"),
                    actual == expected,
                    format!("实际 {actual}，期望 {expected}"),
                ));
            }
            let builtins = PORT
                .builtin_definitions()
                .iter()
                .map(|agent| agent.name)
                .collect::<Vec<_>>();
            entries.push((
                "内置代理目录".into(),
                builtins
                    == vec![
                        "scout",
                        "reviewer",
                        "security-reviewer",
                        "task",
                        "sonic",
                        "seance",
                    ],
                format!("{builtins:?}"),
            ));
        }
        "toggle" => {
            let items = case
                .get("cases")
                .and_then(Value::as_array)
                .ok_or_else(|| super::verify::CaseError::Failed("toggle 用例缺少 cases".into()))?;
            for item in items {
                let current = item.get("current").cloned().unwrap_or_else(|| json!([]));
                let name = item
                    .get("agent")
                    .and_then(Value::as_str)
                    .unwrap_or("reviewer");
                let enabled = item
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let next = PORT.toggle_value(&current, name, enabled);
                let expect = item.get("expect").cloned().unwrap_or(Value::Null);
                let expected = if expect.is_null() { None } else { Some(expect) };
                entries.push((
                    format!("{name} -> {enabled}"),
                    next == expected,
                    format!("{next:?}"),
                ));
            }
        }
        other => {
            return Err(super::verify::CaseError::Failed(format!(
                "未知的 agents 用例 action：{other}"
            )))
        }
    }
    Ok(json!({ "kind": "agents", "action": action, "result": checks(entries) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_publishes_user_and_project_markdown_definitions() {
        let capability = PORT.capability();
        assert!(capability.supported);
        assert_eq!(capability.format, "markdown");
        assert!(capability.template.contains("name: reviewer"));
        assert_eq!(
            PORT.root(Scope::Global, Path::new("/home/e"), None)
                .unwrap(),
            Path::new("/home/e/.omp/agent")
        );
        assert_eq!(
            PORT.root(
                Scope::Project,
                Path::new("/home/e"),
                Some(Path::new("/work/app"))
            )
            .unwrap(),
            Path::new("/work/app/.omp")
        );
    }

    #[test]
    fn disabling_edits_only_the_native_disabled_agents_list() {
        let current = json!(["scout"]);
        assert_eq!(
            PORT.toggle_value(&current, "reviewer", false),
            Some(json!(["scout", "reviewer"]))
        );
        assert_eq!(PORT.toggle_value(&current, "scout", true), None);
        assert_eq!(PORT.toggle_value(&json!([]), "scout", true), None);
        let location = PORT
            .toggle_location(Scope::Global, Path::new("/home/e"), None, "scout")
            .unwrap();
        assert_eq!(location.field, ["task", "disabledAgents"]);
        assert_eq!(location.kind, FileKind::Yaml);
    }

    #[test]
    fn builtins_are_the_verified_bundled_names() {
        let names: Vec<&str> = PORT
            .builtin_definitions()
            .iter()
            .map(|agent| agent.name)
            .collect();
        assert_eq!(
            names,
            [
                "scout",
                "reviewer",
                "security-reviewer",
                "task",
                "sonic",
                "seance"
            ]
        );
    }
}
