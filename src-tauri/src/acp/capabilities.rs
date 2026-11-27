//! Handshake and session-level state: what this client publishes, what the
//! agent declared, and the session settings an agent reports (modes, config
//! options, the legacy model list, the plan, slash commands, title and usage).
//!
//! Every parser here is tolerant: a field the agent omits keeps its protocol
//! default, a malformed entry is skipped instead of failing the session, and
//! every retained string is bounded.

use serde::Serialize;
use serde_json::{json, Value};

/// JSON-RPC protocol revision this host speaks. The check is exact: an agent
/// that answers with another revision is refused with a stated reason.
pub const PROTOCOL_VERSION: u64 = 1;

/// The configuration id under which the legacy `models` selector is addressed.
/// It cannot collide with an agent's own option id because the agent's options
/// are matched first and this id is only honoured when legacy models exist.
pub const LEGACY_MODEL_CONFIG_ID: &str = "_model";

const MAX_LABEL_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_ENTRIES: usize = 200;

fn bounded(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}…")
}

fn label(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(|text| bounded(text, MAX_LABEL_CHARS))
}

fn description(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(|text| bounded(text, MAX_DESCRIPTION_CHARS))
}

/// The client identity sent with initialize.
pub fn client_info() -> Value {
    json!({ "name": "Cliora", "title": "Cliora", "version": env!("CARGO_PKG_VERSION") })
}

/// The client capabilities this host can honour today. A capability is only
/// published once the host serves it. File reads and writes go through
/// `client_fs` (shared `safe_fs`, approvals outside the session directory),
/// terminals through `terminal` (no shell, process trees ended with the
/// session). Elicitation requests are still refused with "method not found",
/// so they are not advertised. Subagents are served: a child session is
/// registered, its updates and requests are attributed to it, and nothing is
/// ever sent for a child.
pub fn client_capabilities() -> Value {
    json!({
        "fs": { "readTextFile": true, "writeTextFile": true },
        "terminal": true,
        "subagents": {},
    })
}

/// Refuse an agent that negotiated another protocol revision. A missing version
/// is not a match either: the field is required.
pub fn check_protocol(result: &Value) -> Result<(), String> {
    match result.get("protocolVersion").and_then(Value::as_u64) {
        Some(PROTOCOL_VERSION) => Ok(()),
        Some(other) => Err(format!(
            "agent 使用 ACP 协议版本 {other}，Cliora 只支持版本 {PROTOCOL_VERSION}，无法建立对话"
        )),
        None => Err(format!(
            "agent 没有返回 ACP 协议版本，Cliora 只支持版本 {PROTOCOL_VERSION}，无法建立对话"
        )),
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpImplementation {
    pub name: String,
    pub title: Option<String>,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptCapabilities {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

/// The session lifecycle methods the agent declared. Each one is present only
/// when the agent advertised it; nothing is inferred from the agent's name.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionCapabilities {
    pub list: bool,
    pub resume: bool,
    pub delete: bool,
    pub close: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// agent (answered through authenticate) or terminal (an interactive run).
    #[serde(rename = "type")]
    pub kind: String,
}

/// What the agent declared in its initialize answer.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentDescriptor {
    pub protocol_version: Option<u64>,
    pub agent_info: Option<AcpImplementation>,
    pub prompt_capabilities: AcpPromptCapabilities,
    pub session_capabilities: AcpSessionCapabilities,
    pub load_session: bool,
    pub auth_methods: Vec<AcpAuthMethod>,
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
}

pub fn agent_descriptor(result: &Value) -> AcpAgentDescriptor {
    let capabilities = result.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let prompt = capabilities.get("promptCapabilities").cloned().unwrap_or(Value::Null);
    let session = capabilities.get("sessionCapabilities").cloned().unwrap_or(Value::Null);
    let flag = |value: &Value, name: &str| value.get(name).and_then(Value::as_bool).unwrap_or(false);
    AcpAgentDescriptor {
        protocol_version: result.get("protocolVersion").and_then(Value::as_u64),
        agent_info: result.get("agentInfo").and_then(|info| {
            Some(AcpImplementation {
                name: label(info.get("name"))?,
                title: label(info.get("title")),
                version: label(info.get("version")),
            })
        }),
        prompt_capabilities: AcpPromptCapabilities {
            image: flag(&prompt, "image"),
            audio: flag(&prompt, "audio"),
            embedded_context: flag(&prompt, "embeddedContext"),
        },
        session_capabilities: AcpSessionCapabilities {
            list: present(session.get("list")),
            resume: present(session.get("resume")),
            delete: present(session.get("delete")),
            close: present(session.get("close")),
        },
        load_session: flag(&capabilities, "loadSession"),
        auth_methods: result
            .get("authMethods")
            .and_then(Value::as_array)
            .map(|methods| {
                methods
                    .iter()
                    .take(MAX_ENTRIES)
                    .filter_map(|method| {
                        let id = label(method.get("id"))?;
                        Some(AcpAuthMethod {
                            name: label(method.get("name")).unwrap_or_else(|| id.clone()),
                            id,
                            description: description(method.get("description")),
                            kind: label(method.get("type")).unwrap_or_else(|| "agent".to_owned()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpModes {
    pub current_mode_id: String,
    pub available_modes: Vec<AcpMode>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpConfigChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    /// The group header a grouped selector files this value under.
    pub group: Option<String>,
}

/// One session configuration selector. A select carries a string value and its
/// choices; a boolean carries true or false and no choices.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    /// select or boolean.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub current_value: Value,
    pub options: Vec<AcpConfigChoice>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpModel {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
}

/// The legacy model selector some agents still report beside configOptions.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpModels {
    pub current_model_id: String,
    pub available_models: Vec<AcpModel>,
}

/// Session settings the agent reported, each kept exactly as declared.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionConfig {
    pub modes: Option<AcpModes>,
    pub options: Vec<AcpConfigOption>,
    pub models: Option<AcpModels>,
}

pub fn parse_modes(value: &Value) -> Option<AcpModes> {
    let current = label(value.get("currentModeId"))?;
    let available = value
        .get("availableModes")
        .and_then(Value::as_array)?
        .iter()
        .take(MAX_ENTRIES)
        .filter_map(|mode| {
            let id = label(mode.get("id"))?;
            Some(AcpMode {
                name: label(mode.get("name")).unwrap_or_else(|| id.clone()),
                id,
                description: description(mode.get("description")),
            })
        })
        .collect();
    Some(AcpModes { current_mode_id: current, available_modes: available })
}

fn parse_choice(item: &Value, group: Option<&str>) -> Option<AcpConfigChoice> {
    let value = label(item.get("value"))?;
    Some(AcpConfigChoice {
        name: label(item.get("name")).unwrap_or_else(|| value.clone()),
        value,
        description: description(item.get("description")),
        group: group.map(ToOwned::to_owned),
    })
}

pub fn parse_config_option(item: &Value) -> Option<AcpConfigOption> {
    let id = label(item.get("id"))?;
    let name = label(item.get("name")).unwrap_or_else(|| id.clone());
    let (kind, current_value, options) = match item.get("type").and_then(Value::as_str) {
        Some("boolean") => ("boolean", Value::Bool(item.get("currentValue")?.as_bool()?), Vec::new()),
        Some("select") => {
            let current = item.get("currentValue")?.as_str()?.to_owned();
            let mut choices = Vec::new();
            for entry in item.get("options").and_then(Value::as_array).into_iter().flatten() {
                if choices.len() >= MAX_ENTRIES {
                    break;
                }
                if let Some(grouped) = entry.get("options").and_then(Value::as_array) {
                    let header = label(entry.get("name")).or_else(|| label(entry.get("group")));
                    // A group's choices count against the same bound as
                    // top-level ones: one group cannot hold an unbounded list.
                    for nested in grouped {
                        if choices.len() >= MAX_ENTRIES {
                            break;
                        }
                        if let Some(choice) = parse_choice(nested, header.as_deref()) {
                            choices.push(choice);
                        }
                    }
                } else if let Some(choice) = parse_choice(entry, None) {
                    choices.push(choice);
                }
            }
            ("select", Value::String(current), choices)
        }
        // A selector type this host does not know is not shown as something it
        // cannot set.
        _ => return None,
    };
    Some(AcpConfigOption {
        id,
        name,
        description: description(item.get("description")),
        category: label(item.get("category")),
        kind,
        current_value,
        options,
    })
}

pub fn parse_config_options(value: &Value) -> Vec<AcpConfigOption> {
    value
        .as_array()
        .map(|items| items.iter().take(MAX_ENTRIES).filter_map(parse_config_option).collect())
        .unwrap_or_default()
}

pub fn parse_models(value: &Value) -> Option<AcpModels> {
    let current = label(value.get("currentModelId"))?;
    let available = value
        .get("availableModels")
        .and_then(Value::as_array)?
        .iter()
        .take(MAX_ENTRIES)
        .filter_map(|model| {
            let id = label(model.get("modelId"))?;
            Some(AcpModel {
                name: label(model.get("name")).unwrap_or_else(|| id.clone()),
                model_id: id,
                description: description(model.get("description")),
            })
        })
        .collect();
    Some(AcpModels { current_model_id: current, available_models: available })
}

/// The settings a session/new, session/load or session/resume answer carries.
/// A field the answer omits keeps what the session already had.
pub fn apply_session_setup(config: &mut AcpSessionConfig, result: &Value) {
    if let Some(modes) = result.get("modes").filter(|value| !value.is_null()) {
        config.modes = parse_modes(modes);
    }
    if let Some(options) = result.get("configOptions").filter(|value| !value.is_null()) {
        config.options = parse_config_options(options);
    }
    if let Some(models) = result.get("models").filter(|value| !value.is_null()) {
        config.models = parse_models(models);
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPlanEntry {
    pub content: String,
    /// high, medium or low.
    pub priority: &'static str,
    /// pending, in_progress or completed.
    pub status: &'static str,
}

pub fn parse_plan(update: &Value) -> Vec<AcpPlanEntry> {
    update
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .take(MAX_ENTRIES)
                .filter_map(|entry| {
                    Some(AcpPlanEntry {
                        content: description(entry.get("content"))?,
                        priority: match entry.get("priority").and_then(Value::as_str) {
                            Some("high") => "high",
                            Some("low") => "low",
                            _ => "medium",
                        },
                        status: match entry.get("status").and_then(Value::as_str) {
                            Some("in_progress") => "in_progress",
                            Some("completed") => "completed",
                            _ => "pending",
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpAvailableCommand {
    pub name: String,
    pub description: String,
    /// The hint shown while the command's input is still empty.
    pub hint: Option<String>,
}

pub fn parse_commands(update: &Value) -> Vec<AcpAvailableCommand> {
    update
        .get("availableCommands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .take(MAX_ENTRIES)
                .filter_map(|command| {
                    Some(AcpAvailableCommand {
                        name: label(command.get("name"))?,
                        description: description(command.get("description")).unwrap_or_default(),
                        hint: command.get("input").and_then(|input| label(input.get("hint"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpCost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpUsage {
    pub used: u64,
    pub size: u64,
    pub cost: Option<AcpCost>,
}

/// Title and usage. Usage stays empty until the agent actually reports it.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionInfo {
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub usage: Option<AcpUsage>,
}

/// Patch title and timestamp: an omitted field is unchanged, null clears it.
pub fn apply_session_info(info: &mut AcpSessionInfo, update: &Value) {
    if let Some(title) = update.get("title") {
        info.title = label(Some(title));
    }
    if let Some(updated) = update.get("updatedAt") {
        info.updated_at = label(Some(updated));
    }
}

pub fn parse_usage(update: &Value) -> Option<AcpUsage> {
    Some(AcpUsage {
        used: update.get("used")?.as_u64()?,
        size: update.get("size")?.as_u64()?,
        cost: update.get("cost").and_then(|cost| {
            Some(AcpCost {
                amount: cost.get("amount")?.as_f64()?,
                currency: label(cost.get("currency"))?,
            })
        }),
    })
}
