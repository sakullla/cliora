//! agy hooks.json contract (1.5.9 remote evidence run).
//!
//! Verified on the authorized remote 1.5.9 machine
//! (`docs/verification/remote-workflow/agy-1.5.9/evidence/hooks.json`,
//! sanitized samples `tests/fixtures/native/antigravity-cli-1.5.9/hooks.json`
//! and `.../plugin/hooks.json`, builtin `docs/hooks.md` quoted in the run
//! report):
//!
//! * **Locations**: standalone hooks live at `<workspace>/.agents/hooks.json`
//!   and `~/.gemini/config/hooks.json`; plugin hooks sit at the plugin root
//!   `plugins/<name>/hooks.json` (the nested `hooks/hooks.json` form is only
//!   staged there when importing gemini/claude extensions and is not read for
//!   native plugins). The loader logs `loaded N named hooks from M
//!   hooks.json file(s)` headless before sign-in.
//! * **Schema**: the document is an object whose top-level keys are hook
//!   names; each value holds optional `enabled:false` (disables that named
//!   hook) plus event lists. Events: `SessionStart`, `PreToolUse`,
//!   `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. The tool
//!   events group entries as `{matcher, hooks[]}` with a regex matcher
//!   against tool names; the other events take direct handler arrays.
//!   Handlers are `{type:"command", command, timeout?}` — `command` is the
//!   only evidenced handler type. The JSON stdin/stdout contracts
//!   (camelCase protojson payloads, decisions, `terminationBehavior`) are
//!   runtime behavior of a fired handler, not file fields, so they carry no
//!   validation here.
//!
//! Validation is pre-write only: an invalid document is refused with a
//! diagnosable reason while the original file stays unchanged. Grouped
//! vs. direct entry pairing is enforced exactly as documented — a hook a
//! future line loads under a different pairing stays unedited here rather
//! than guessed.

use serde_json::Value;

use crate::resources::plugin_contents::PluginItem;

/// The six documented event keys (builtin docs/hooks.md, 1.5.9).
pub(crate) const EVENTS: [&str; 6] = [
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
    "PreInvocation",
    "PostInvocation",
    "Stop",
];
/// Tool events group entries behind a regex `matcher`; the other events take
/// direct handler arrays.
const TOOL_EVENTS: [&str; 2] = ["PreToolUse", "PostToolUse"];

fn is_event(key: &str) -> bool {
    EVENTS.contains(&key)
}

fn is_tool_event(key: &str) -> bool {
    TOOL_EVENTS.contains(&key)
}

/// A non-empty string without control characters. Full regex validity stays
/// native — Cliora only refuses values that could never be a matcher.
fn plausible_matcher(text: &str) -> bool {
    !text.is_empty() && !text.chars().any(char::is_control) && text.len() <= 1024
}

/// One command handler: `{type:"command", command, timeout?}`. Extra keys are
/// preserved (an in-range minor update may extend the handler object), but the
/// documented fields must hold the documented shapes.
fn validate_handler(handler: &Value, context: &str) -> Result<(), String> {
    let Some(object) = handler.as_object() else {
        return Err(format!("{context} 的处理器必须是对象"));
    };
    if object.get("type").and_then(Value::as_str) != Some("command") {
        return Err(format!(
            "{context} 的处理器 type 只支持 \"command\"（1.5.9 实证仅此一种）"
        ));
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty());
    if command.is_none() {
        return Err(format!("{context} 的处理器缺少非空 command"));
    }
    match object.get("timeout") {
        None | Some(Value::Null) => {}
        Some(value) => {
            let seconds = value
                .as_f64()
                .filter(|seconds| seconds.is_finite() && *seconds > 0.0);
            if seconds.is_none() {
                return Err(format!("{context} 的 timeout 必须是正数（秒）"));
            }
        }
    }
    Ok(())
}

/// Validate a whole named-hooks document before any write. Every rejection
/// names the offending hook so the editor can point at it.
pub fn validate_document(value: &Value) -> Result<(), String> {
    let Some(document) = value.as_object() else {
        return Err("hooks.json 顶层必须是对象（键为 hook 名称）".into());
    };
    if document.is_empty() {
        return Err("hooks.json 至少需要一个命名 hook".into());
    }
    for (name, hook) in document {
        if name.trim().is_empty() || name.chars().any(char::is_control) {
            return Err(format!("hook 名称「{name}」无效"));
        }
        let Some(entries) = hook.as_object() else {
            return Err(format!("hook「{name}」的值必须是对象（事件到处理器列表）"));
        };
        for (event, list) in entries {
            match event.as_str() {
                "enabled" => {
                    if !matches!(list, Value::Bool(_)) {
                        return Err(format!("hook「{name}」的 enabled 必须是布尔值"));
                    }
                }
                key if is_event(key) => {
                    let Some(items) = list.as_array() else {
                        return Err(format!("hook「{name}」的 {key} 必须是数组"));
                    };
                    for (index, item) in items.iter().enumerate() {
                        let context = format!("hook「{name}」的 {key}[{index}]");
                        if is_tool_event(key) {
                            let Some(group) = item.as_object() else {
                                return Err(format!("{context} 必须是 {{matcher, hooks[]}} 分组"));
                            };
                            if let Some(matcher) = group.get("matcher") {
                                let valid = matcher
                                    .as_str()
                                    .map(plausible_matcher)
                                    .unwrap_or(false);
                                if !valid {
                                    return Err(format!(
                                        "{context} 的 matcher 必须是非空正则字符串"
                                    ));
                                }
                            }
                            let Some(handlers) =
                                group.get("hooks").and_then(Value::as_array)
                            else {
                                return Err(format!("{context} 缺少 hooks 数组"));
                            };
                            for (hook_index, handler) in handlers.iter().enumerate() {
                                validate_handler(
                                    handler,
                                    &format!("{context}.hooks[{hook_index}]"),
                                )?;
                            }
                        } else {
                            validate_handler(item, &context)?;
                        }
                    }
                }
                _ => {
                    return Err(format!(
                        "hook「{name}」包含不支持的事件「{event}」（支持：{}）",
                        EVENTS.join("、")
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Detail rows for the plugin contents list: one per named hook, ordered by
/// the document's own key order, each naming its events (and a disabled
/// marker when `enabled:false`). The path is the hooks document itself so the
/// reader opens the file behind every row.
pub fn detail_items(document: &Value, path: &str) -> Vec<PluginItem> {
    let mut items = Vec::new();
    let Some(document) = document.as_object() else {
        return items;
    };
    for (name, hook) in document {
        let mut events: Vec<&str> = Vec::new();
        let mut disabled = false;
        if let Some(entries) = hook.as_object() {
            if entries.get("enabled") == Some(&Value::Bool(false)) {
                disabled = true;
            }
            for key in entries.keys() {
                if is_event(key) && !events.contains(&key.as_str()) {
                    events.push(key.as_str());
                }
            }
        }
        events.sort_by_key(|event| EVENTS.iter().position(|known| known == event));
        let description = if events.is_empty() {
            "无事件".to_string()
        } else {
            events.join(" · ")
        };
        let description = if disabled {
            format!("{description} · 已停用")
        } else {
            description
        };
        items.push(PluginItem {
            kind: "hooks".into(),
            name: name.clone(),
            description: Some(description),
            path: path.to_owned(),
            location: path.to_owned(),
            format: "json".into(),
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_committed_standalone_and_plugin_samples_validate() {
        let standalone = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/native/antigravity-cli-1.5.9/hooks.json"),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&standalone).unwrap();
        // The fixture file carries its contract documentation in a
        // "description" key; the native document is the named-hooks map
        // without it.
        let hooks = serde_json::Map::from_iter(
            value
                .as_object()
                .unwrap()
                .iter()
                .filter(|(key, _)| key.as_str() != "description")
                .map(|(key, entry)| (key.clone(), entry.clone())),
        );
        let value = Value::Object(hooks);
        validate_document(&value).unwrap();
        assert!(value
            .as_object()
            .unwrap()
            .contains_key("fixture-workspace-hook"));
        let items = detail_items(&value, "/plugins/probe/hooks.json");
        let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert!(names.contains(&"fixture-workspace-hook"));
        assert!(names.contains(&"fixture-disabled-hook"));

        let plugin = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/native/antigravity-cli-1.5.9/plugin/hooks.json"),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&plugin).unwrap();
        validate_document(&value).unwrap();
        let items = detail_items(&value, "/plugins/probe/hooks.json");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "fixture-plugin-hook");
        assert_eq!(items[0].description.as_deref(), Some("PostToolUse"));
    }

    #[test]
    fn unsupported_structures_are_rejected_before_any_write() {
        let cases: Vec<(Value, &str)> = vec![
            (json!([]), "顶层必须是对象"),
            (json!({}), "至少需要一个命名 hook"),
            // Unknown event names never reach the native file.
            (
                json!({"a": {"SessionEnd": []}}),
                "不支持的事件「SessionEnd」",
            ),
            // Non-command handler types are the unsupported structure class.
            (
                json!({"a": {"Stop": [{"type": "http", "url": "https://x"}]}}),
                "type 只支持 \"command\"",
            ),
            (
                json!({"a": {"Stop": [{"type": "command", "command": "  "}]}}),
                "缺少非空 command",
            ),
            (
                json!({"a": {"Stop": [{"type": "command", "command": "/bin/true", "timeout": 0}]}}),
                "timeout 必须是正数",
            ),
            // Tool events require the grouped matcher+hooks shape.
            (
                json!({"a": {"PreToolUse": ["/bin/true"]}}),
                "matcher, hooks[]",
            ),
            (
                json!({"a": {"PostToolUse": [{"matcher": "run_command"}]}}),
                "缺少 hooks 数组",
            ),
            (
                json!({"a": {"PreToolUse": [{"matcher": "", "hooks": []}]}}),
                "matcher 必须是非空正则字符串",
            ),
            (
                json!(
                    {"a": {"PostToolUse": [{"matcher": "run_.*", "hooks": [{"type": "prompt"}]}]}}
                ),
                "type 只支持 \"command\"",
            ),
            // The non-tool events take direct handler arrays, not groups.
            (
                json!({"a": {"SessionStart": [{"hooks": []}]}}),
                "type 只支持 \"command\"",
            ),
            // enabled is a named-hook flag, not a string.
            (json!({"a": {"enabled": "false"}}), "enabled 必须是布尔值"),
            (json!({"a": "not-an-object"}), "值必须是对象"),
            (
                json!({"": {"Stop": []}}),
                "hook 名称「」无效",
            ),
        ];
        for (value, expected) in cases {
            let error = validate_document(&value).unwrap_err();
            assert!(error.contains(expected), "{value:?} → {error}");
        }
    }

    #[test]
    fn valid_documents_across_both_entry_shapes_pass() {
        // Standalone sample shapes: grouped tool events, direct SessionStart,
        // disabled named hook.
        validate_document(&json!({
            "workspace-hook": {
                "PreToolUse": [
                    {"matcher": "run_command|edit_file", "hooks": [
                        {"type": "command", "command": "./check.sh", "timeout": 10}
                    ]}
                ],
                "PostToolUse": [{"hooks": [{"type": "command", "command": "/bin/true"}]}]
            },
            "disabled-hook": {"enabled": false, "SessionStart": [{"type": "command", "command": "/bin/true"}]}
        }))
        .unwrap();
        // Every documented event with an empty list is structurally valid.
        validate_document(&json!({
            "all-events": {
                "SessionStart": [],
                "PreToolUse": [],
                "PostToolUse": [],
                "PreInvocation": [],
                "PostInvocation": [],
                "Stop": []
            }
        }))
        .unwrap();
        // Detail rows keep the documented event order and mark disabled hooks.
        let items = detail_items(
            &json!({
                "z-hook": {"Stop": [{"type": "command", "command": "/bin/true"}]},
                "a-hook": {"enabled": false, "PostToolUse": [{"matcher": "x", "hooks": []}], "SessionStart": []}
            }),
            "/p/hooks.json",
        );
        let a = items.iter().find(|item| item.name == "a-hook").unwrap();
        assert_eq!(a.description.as_deref(), Some("SessionStart · PostToolUse · 已停用"));
        let z = items.iter().find(|item| item.name == "z-hook").unwrap();
        assert_eq!(z.description.as_deref(), Some("Stop"));
    }
}
