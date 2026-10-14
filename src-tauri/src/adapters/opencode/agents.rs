use super::OpenCode;
use crate::adapters::agents::{string, AgentAdapter, AgentCapability};
use crate::{
    accounts::selection,
    native::{
        adapter::Scope,
        format::{self, FileKind},
    },
    resources::{
        agents::{self, AgentEntry, AgentRequest},
        plugins::PluginTarget,
    },
};
use agents::{entry, project, read};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Install line from a probed version. A missing or non-numeric major is
/// unknown here; version-tracked writes are refused in that case.
fn major(version: Option<&str>) -> Option<u32> {
    version?
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}
/// The verified inline container and switch key for an install line.
fn native_shape(version: Option<&str>) -> Result<(&'static str, &'static str), String> {
    match major(version) {
        Some(2) => Ok(("agents", "disabled")),
        Some(1) => Ok(("agent", "disable")),
        Some(_) => Err("此 OpenCode 主版本的 agent 原生形态尚未验证；未执行写入".into()),
        None => Err(
            "OpenCode 安装版本未验证，无法确定配置内 agent 的原生形态；请先确认安装（只读展示仍可用）"
                .into(),
        ),
    }
}
/// 2.x saves keep one native shape per entity: v1 synonym fields with a
/// verified v2 equivalent are rewritten to their v2 names and coexisting
/// synonyms are refused instead of silently picking one. `permission` keeps
/// its v1 map form: native 2.x still loads it unchanged.
fn rewrite_v2_fields(value: &mut Value) -> Result<(), String> {
    let map = value
        .as_object_mut()
        .ok_or_else(|| "定义字段必须是对象".to_owned())?;
    for (v1, v2) in [("prompt", "system"), ("disable", "disabled")] {
        match (map.remove(v1), map.contains_key(v2)) {
            (Some(_), true) => {
                return Err(format!("{v1} 与 {v2} 同义并存；请只保留 {v2} 后保存"));
            }
            (Some(item), false) => {
                map.insert(v2.into(), item);
            }
            (None, _) => {}
        }
    }
    Ok(())
}

impl AgentAdapter for OpenCode {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("1.18.34 / 2.0.29", true, "markdown", "原生 agent/agents/**/*.md 与配置中的 agent（1.x）/agents（2.x）对象；1.x 写 disable/prompt/permission，2.x 写 disabled/system 与 permissions 规则数组；model 支持 #variant。读取兼容双形态。重启会话加载。文件名决定默认名称。", "---\ndescription: Review code\nmode: subagent\npermission:\n  edit: deny\n  bash: ask\n---\nReview code and report findings.\n");
        AgentCapability {
            version,
            supported,
            format,
            detail,
            template,
        }
    }
    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        if scope == Scope::Project {
            return Ok(project.ok_or("请选择项目")?.join(".opencode"));
        }
        Ok(selection::config_root("open_code", || {
            std::env::var_os("OPENCODE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"))
                        .join("opencode")
                })
        }))
    }
    fn required_name(&self) -> bool {
        false
    }
    fn namespaced_names(&self) -> bool {
        true
    }
    fn definition_dirs(&self) -> &'static [&'static str] {
        &["agents", "agent"]
    }
    fn validate_fields(&self, value: &Value) -> Result<(), String> {
        // Reads must accept both native lines, so the synonym fields of the
        // other line stay valid input; saves pick the shape per install line.
        for key in ["disable", "disabled", "hidden"] {
            if value.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("{key} 必须是布尔值"));
            }
        }
        if let Some(mode) = value.get("mode") {
            if !["subagent", "primary", "all"].contains(&mode.as_str().unwrap_or("")) {
                return Err("mode 无效".into());
            }
        }
        if let Some(tools) = value.get("tools") {
            if !tools
                .as_object()
                .is_some_and(|map| map.values().all(Value::is_boolean))
            {
                return Err("tools 必须是工具名到布尔值的对象".into());
            }
        }
        validate_permission_fields(value)?;
        for key in ["prompt", "system"] {
            string(value, key, false)?;
        }
        for key in ["steps", "maxSteps"] {
            if value
                .get(key)
                .is_some_and(|v| v.as_u64().is_none_or(|n| n == 0))
            {
                return Err(format!("{key} 必须为正整数"));
            }
        }
        Ok(())
    }
    fn config_paths(
        &self,
        home: &Path,
        target: &PluginTarget,
        mut paths: Vec<PathBuf>,
    ) -> Result<Vec<PathBuf>, String> {
        let project = project(target)?;
        {
            // Native loads both files; inventory both rather than silently selecting one.
            if let Some(path) = paths.first() {
                let parent = path.parent().ok_or("配置目录缺失")?;
                paths = vec![parent.join("opencode.json"), parent.join("opencode.jsonc")];
            }
        }
        if target.scope == Scope::Project {
            let root = self.root(target.scope, home, project.as_deref())?;
            paths.extend([root.join("opencode.json"), root.join("opencode.jsonc")]);
        }
        Ok(paths)
    }
    fn config_entries(
        &self,
        target: &PluginTarget,
        _root: &Path,
        path: &Path,
        value: &Value,
        entries: &mut Vec<AgentEntry>,
    ) -> Result<(), String> {
        // The singular and plural maps are one native synonym container; read
        // both shapes completely and never merge or drop either.
        let shapes = [
            ("agent", "disable", "agent"),
            ("agents", "disabled", "agents"),
        ];
        let conflict = shapes.iter().all(|(container, _, _)| value.get(*container).is_some());
        for (container, switch, id_segment) in shapes {
            let Some(agents) = value.get(container) else {
                continue;
            };
            let agents = agents
                .as_object()
                .ok_or_else(|| format!("原生 {container} 配置不是对象"))?;
            for (name, value) in agents {
                let mut e = entry(
                    &target.tool_id,
                    path,
                    "json",
                    serde_json::to_string_pretty(value).map_err(|_| "定义无效")?,
                    name,
                    !value
                        .get(switch)
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    "独立定义",
                );
                e.id = format!("{}#{id_segment}/{name}", path.display());
                e.name = name.clone();
                if conflict {
                    e.read_only = true;
                    e.detail.push_str(
                        " · agent 与 agents 同义并存，原生形态冲突；请在原生配置统一为一种形态后再编辑",
                    );
                }
                entries.push(e);
            }
        }
        Ok(())
    }
    fn disabled_detail(&self) -> &'static str {
        "原生 disable/disabled: true；启用会保留其他字段并关闭此开关。 "
    }
    fn config_requires_version(&self) -> bool {
        true
    }
    fn native_disabled_for_version(
        &self,
        format: &str,
        content: &str,
        version: Option<&str>,
    ) -> bool {
        if format != "markdown" {
            return false;
        }
        match major(version) {
            // Verified on 2.0.29: markdown honors both switch keys; the v1
            // line only knows `disable`. Config entries honor their own
            // container's key (checked in config_entries).
            Some(1) => markdown_flag(content, "disable"),
            _ => markdown_flag(content, "disable") || markdown_flag(content, "disabled"),
        }
    }
    fn enable_content_for_version(
        &self,
        content: &str,
        version: Option<&str>,
    ) -> Result<String, String> {
        match major(version) {
            Some(1) => enable_markdown_key(content, "disable"),
            // Verified on 2.0.29: either flag disables a markdown agent, so
            // enabling turns off every switch key the file carries.
            _ => {
                let mut result = content.to_owned();
                let mut changed = false;
                for key in ["disable", "disabled"] {
                    if markdown_flag(&result, key) {
                        result = enable_markdown_key(&result, key)?;
                        changed = true;
                    }
                }
                if changed {
                    Ok(result)
                } else {
                    Ok(content.into())
                }
            }
        }
    }
    fn config_edit_for_version(
        &self,
        entry: &AgentEntry,
        request: &AgentRequest,
        version: Option<&str>,
    ) -> Result<String, String> {
        let (container, switch) = native_shape(version)?;
        let target = &request.target;
        let path = PathBuf::from(&entry.path);
        let old = read(&path)?;
        let kind = FileKind::for_name(&entry.path)?;
        let value = match request.action.as_str() {
            "save" => {
                crate::adapters::agents::validate(
                    &target.tool_id,
                    "json",
                    &request.content,
                    &entry.name,
                )?;
                let mut v = format::parse(FileKind::Json, &request.content)?;
                if major(version) == Some(2) {
                    rewrite_v2_fields(&mut v)?;
                }
                Some(v)
            }
            "delete" => None,
            "enable" | "disable" => {
                let mut v = format::parse(FileKind::Json, &entry.content)?;
                // Keep one shape per entity: set this line's key and drop the
                // synonym of the other line if a mixed file carried it.
                let other = if switch == "disabled" { "disable" } else { "disabled" };
                v.as_object_mut().map(|map| map.remove(other));
                v[switch] = Value::Bool(request.action == "disable");
                Some(v)
            }
            _ => return Err("未知 agent 操作".into()),
        };
        let output = format::set_path(
            kind,
            &old,
            &[container.into(), entry.name.clone()],
            value.as_ref(),
        )?;
        Ok(output)
    }
}
fn validate_permission(value: &Value) -> Result<(), String> {
    if value
        .as_str()
        .is_some_and(|s| ["allow", "deny", "ask"].contains(&s))
    {
        return Ok(());
    }
    if let Some(map) = value.as_object() {
        for value in map.values() {
            validate_permission(value)?;
        }
        return Ok(());
    }
    Err("permission 值必须是 allow、deny、ask 或规则对象".into())
}
/// `permission` keeps the v1 rule map on both lines; `permissions` is the
/// ordered v2 rule array. Native 2.x silently drops an agent whose
/// `permissions` is not the array form, so that shape is rejected here.
fn validate_permission_fields(value: &Value) -> Result<(), String> {
    if let Some(permission) = value.get("permission") {
        validate_permission(permission)?;
    }
    if let Some(permissions) = value.get("permissions") {
        let rules = permissions
            .as_array()
            .ok_or("permissions 必须是 {action,resource,effect} 规则数组（2.x）；v1 对象规则请用 permission")?;
        for rule in rules {
            let map = rule
                .as_object()
                .ok_or("permissions 规则必须是对象（action/resource/effect）")?;
            for key in ["action", "resource"] {
                if let Some(item) = map.get(key) {
                    if !item.is_string() {
                        return Err(format!("permissions 规则的 {key} 必须是字符串"));
                    }
                }
            }
            if let Some(effect) = map.get("effect") {
                if !effect
                    .as_str()
                    .is_some_and(|s| ["allow", "deny", "ask"].contains(&s))
                {
                    return Err("permissions 规则的 effect 必须是 allow、deny 或 ask".into());
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn markdown_disabled(text: &str) -> bool {
    markdown_flag(text, "disable")
}

pub(crate) fn markdown_flag(text: &str, key: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    normalized
        .strip_prefix("---\n")
        .and_then(|tail| tail.split_once("\n---\n"))
        .and_then(|(yaml, _)| serde_yaml::from_str::<Value>(yaml).ok())
        .and_then(|v| v.get(key).and_then(Value::as_bool))
        .unwrap_or(false)
}

pub(crate) fn enable_markdown(text: &str) -> Result<String, String> {
    enable_markdown_key(text, "disable")
}

pub(crate) fn enable_markdown_key(text: &str, key: &str) -> Result<String, String> {
    let mut header = false;
    let mut delimiters = 0;
    let mut changed = false;
    let mut result = String::new();
    for line in text.split_inclusive('\n') {
        if line.trim() == "---" {
            delimiters += 1;
            header = delimiters == 1;
        }
        if header && !line.starts_with(char::is_whitespace) {
            if let Some((name, tail)) = line.split_once(':') {
                if name.trim().trim_matches(['\'', '"']) == key {
                    let value = tail.trim_start();
                    if let Some(rest) = value.strip_prefix("true") {
                        if rest.trim().is_empty() || rest.trim_start().starts_with('#') {
                            let offset = line.len() - value.len();
                            result.push_str(&line[..offset]);
                            result.push_str("false");
                            result.push_str(rest);
                            changed = true;
                            continue;
                        }
                    }
                }
            }
        }
        result.push_str(line);
    }
    if !changed {
        return Err(format!(
            "此 {key} 字段使用复杂 YAML 写法，请在编辑器中改为 false 后保存"
        ));
    }
    Ok(result)
}
