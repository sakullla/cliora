//! Structured questions an agent asks through `elicitation/create`.
//!
//! Only form mode is advertised and served. A form is a timeline item plus a
//! pending request id; it is answered at most once with accept (and the
//! content), decline or cancel. A stop, the end of the turn that asked, or the
//! end of the session withdraws it and the agent receives a cancel; an answer
//! that arrives after that is refused.
//!
//! The submitted content is checked against the requested schema here as well
//! as in the view: a field the form did not ask for, a value of the wrong type
//! or outside the declared choices never reaches the agent. The content itself
//! is not retained.

use serde_json::{json, Map, Value};

use super::timeline::{cap, AcpElicitation, AcpTimelineItem};
use super::{guard, AcpUpdate, Scope, Session};

/// The largest schema a form may carry, serialized.
const MAX_SCHEMA_BYTES: usize = 64 * 1024;
/// The largest number of fields one form may ask for.
const MAX_FIELDS: usize = 64;
/// The largest answer, serialized.
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const MAX_MESSAGE_CHARS: usize = 4_000;

/// An open form: the protocol id to answer and the item that shows it.
pub(crate) struct PendingElicitation {
    pub id: Value,
    pub request_id: String,
    pub item_id: String,
    pub turn_id: String,
    pub schema: Value,
}

/// How the user answered a form.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Action {
    Accept,
    Decline,
    Cancel,
}

impl Action {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "accept" => Some(Self::Accept),
            "decline" => Some(Self::Decline),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }

    fn decision(self) -> &'static str {
        match self {
            Self::Accept => "accepted",
            Self::Decline => "declined",
            Self::Cancel => "cancelled",
        }
    }
}

/// A requested schema this client can render: a flat object whose properties
/// are strings, numbers, integers, booleans or arrays of enumerated strings.
fn check_schema(schema: &Value) -> Result<(), String> {
    if schema.to_string().len() > MAX_SCHEMA_BYTES {
        return Err("表单定义过大".into());
    }
    let object = schema.as_object().ok_or("表单定义必须是对象")?;
    if let Some(kind) = object.get("type") {
        if kind.as_str() != Some("object") {
            return Err("表单定义的顶层类型必须是 object".into());
        }
    }
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .ok_or("表单定义缺少 properties")?;
    if properties.len() > MAX_FIELDS {
        return Err("表单字段过多".into());
    }
    for (name, property) in properties {
        let kind = property.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(kind, "string" | "number" | "integer" | "boolean" | "array") {
            return Err(format!("表单字段 {name} 的类型不受支持"));
        }
    }
    if let Some(required) = object.get("required") {
        let names = required.as_array().ok_or("表单定义的 required 必须是数组")?;
        for name in names {
            let name = name.as_str().ok_or("表单定义的 required 只能列出字段名")?;
            if !properties.contains_key(name) {
                return Err(format!("必填字段 {name} 不在表单定义中"));
            }
        }
    }
    Ok(())
}

/// The string choices a property declares: `enum`, or `oneOf`/`anyOf` items
/// with a `const` (titled choices). None when the property is free text.
fn choices(property: &Value) -> Option<Vec<&str>> {
    if let Some(values) = property.get("enum").and_then(Value::as_array) {
        return Some(values.iter().filter_map(Value::as_str).collect());
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(options) = property.get(key).and_then(Value::as_array) {
            return Some(options.iter().filter_map(|option| option.get("const").and_then(Value::as_str)).collect());
        }
    }
    None
}

fn bound(property: &Value, key: &str) -> Option<f64> {
    property.get(key).and_then(Value::as_f64)
}

/// Check one submitted value against its property.
fn check_value(name: &str, property: &Value, value: &Value) -> Result<(), String> {
    let kind = property.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "string" => {
            let text = value.as_str().ok_or_else(|| format!("字段 {name} 需要文本"))?;
            let length = text.chars().count() as f64;
            if bound(property, "minLength").is_some_and(|min| length < min) {
                return Err(format!("字段 {name} 太短"));
            }
            if bound(property, "maxLength").is_some_and(|max| length > max) {
                return Err(format!("字段 {name} 太长"));
            }
            if let Some(allowed) = choices(property) {
                if !allowed.contains(&text) {
                    return Err(format!("字段 {name} 的取值不在可选项中"));
                }
            }
            Ok(())
        }
        "number" | "integer" => {
            let number = value.as_f64().ok_or_else(|| format!("字段 {name} 需要数字"))?;
            if kind == "integer" && (number.fract() != 0.0 || !number.is_finite()) {
                return Err(format!("字段 {name} 需要整数"));
            }
            if bound(property, "minimum").is_some_and(|min| number < min) {
                return Err(format!("字段 {name} 小于允许的最小值"));
            }
            if bound(property, "maximum").is_some_and(|max| number > max) {
                return Err(format!("字段 {name} 大于允许的最大值"));
            }
            Ok(())
        }
        "boolean" => value.as_bool().map(|_| ()).ok_or_else(|| format!("字段 {name} 需要是或否")),
        "array" => {
            let items = value.as_array().ok_or_else(|| format!("字段 {name} 需要多选列表"))?;
            let allowed = property.get("items").and_then(choices);
            for item in items {
                let text = item.as_str().ok_or_else(|| format!("字段 {name} 只能包含文本选项"))?;
                if let Some(allowed) = &allowed {
                    if !allowed.contains(&text) {
                        return Err(format!("字段 {name} 包含不在可选项中的取值"));
                    }
                }
            }
            let count = items.len() as f64;
            if bound(property, "minItems").is_some_and(|min| count < min) {
                return Err(format!("字段 {name} 选择的项太少"));
            }
            if bound(property, "maxItems").is_some_and(|max| count > max) {
                return Err(format!("字段 {name} 选择的项太多"));
            }
            Ok(())
        }
        _ => Err(format!("字段 {name} 的类型不受支持")),
    }
}

/// Check an accepted answer against the form it answers.
pub(crate) fn check_content(schema: &Value, content: Option<&Value>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let content = match content {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(object)) => object,
        Some(_) => return Err("表单内容必须是对象".into()),
    };
    if Value::Object(content.clone()).to_string().len() > MAX_CONTENT_BYTES {
        return Err("表单内容过大".into());
    }
    let properties = schema.get("properties").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, value) in content {
        let property = properties.get(name).ok_or_else(|| format!("表单没有字段 {name}"))?;
        check_value(name, property, value)?;
    }
    for name in schema.get("required").and_then(Value::as_array).into_iter().flatten() {
        if let Some(name) = name.as_str() {
            if !content.contains_key(name) {
                return Err(format!("缺少必填字段 {name}"));
            }
        }
    }
    Ok(content.clone())
}

impl Session {
    pub(super) fn elicitation_pending_ids(&self) -> Vec<String> {
        guard(&self.elicitations).iter().map(|pending| pending.request_id.clone()).collect()
    }

    fn form_entry(&self, id: &str) -> Option<AcpElicitation> {
        match guard(&self.timeline).get(id) {
            Some(AcpTimelineItem::Elicitation(entry)) => Some(entry.clone()),
            _ => None,
        }
    }

    fn record_form(&self, entry: AcpElicitation) {
        let _order = self.order();
        let item = AcpTimelineItem::Elicitation(entry);
        guard(&self.timeline).upsert(item.clone());
        self.emit_update(AcpUpdate::Item { item });
    }

    /// Close a form in the timeline with its final decision.
    fn settle_form(&self, item_id: &str, decision: &'static str) {
        let _order = self.order();
        if let Some(mut entry) = self.form_entry(item_id) {
            entry.decision = decision;
            entry.request_id = None;
            self.record_form(entry);
        }
    }

    /// `elicitation/create`: open a form card, or refuse a request this client
    /// cannot honour (another session, a mode it did not advertise, a schema
    /// it cannot render) with "invalid params".
    pub(super) fn open_elicitation(&self, id: Value, params: Value) {
        let subagent = match self.scope_of(&params) {
            Scope::Root => None,
            Scope::Child(child) => Some(child),
            Scope::Foreign => {
                self.answer_error(&id, -32602, "该请求不属于本会话");
                self.diagnostic("收到其他会话的结构化提问，已拒绝");
                return;
            }
        };
        // The mode must be stated and must be form. ACP v1 differs from MCP
        // here: "ACP also requires mode explicitly. It does not apply MCP's
        // omitted-mode form default" (ACP elicitation documentation), so a
        // request without a mode is invalid params, not a form.
        if params.get("mode").and_then(Value::as_str) != Some("form") {
            self.answer_error(&id, -32602, "客户端只支持表单形式的结构化提问");
            self.diagnostic("agent 请求了未声明的结构化提问形式，已拒绝");
            return;
        }
        let Some(message) = params.get("message").and_then(Value::as_str) else {
            self.answer_error(&id, -32602, "缺少参数 message");
            return;
        };
        let schema = params.get("requestedSchema").cloned().unwrap_or(Value::Null);
        if let Err(reason) = check_schema(&schema) {
            self.answer_error(&id, -32602, &reason);
            self.diagnostic(&format!("结构化提问无法显示：{reason}"));
            return;
        }
        let tool_call_id = params
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(|value| cap(value, 500).0);
        let item_id = guard(&self.timeline).auto_id("elicitation");
        let request_id = format!("{item_id}-request");
        // Register under the turn lock, like the other cards: a stop or a turn
        // end either finds this form and withdraws it, or ran first and the
        // form is cancelled at once.
        let turn_id = {
            let turn = guard(&self.turn);
            let turn_id = turn.as_ref().map(|turn| turn.id.clone()).unwrap_or_default();
            let cancelled = turn.as_ref().is_some_and(|turn| turn.cancel_requested);
            if cancelled || guard(&self.writer).is_none() {
                drop(turn);
                self.answer_result(&id, json!({ "action": "cancel" }));
                self.notice("warning", "elicitation_cancelled", "本轮已停止，新的提问已取消");
                return;
            }
            guard(&self.elicitations).push(PendingElicitation {
                id,
                request_id: request_id.clone(),
                item_id: item_id.clone(),
                turn_id: turn_id.clone(),
                schema: schema.clone(),
            });
            turn_id
        };
        self.record_form(AcpElicitation {
            id: item_id,
            message: cap(message, MAX_MESSAGE_CHARS).0,
            requested_schema: schema,
            tool_call_id,
            decision: "pending",
            request_id: Some(request_id),
            turn_id,
            subagent,
        });
        self.emit_pending();
        self.settle_state();
    }

    /// Answer one form. An accepted answer must fit the schema; a refused one
    /// keeps the form open. The form is consumed, so a second answer — or one
    /// after the form was withdrawn — is refused.
    pub(super) fn respond_elicitation(&self, request_id: &str, action: &str, content: Option<&Value>) -> Result<(), String> {
        let action = Action::parse(action).ok_or("未知的表单答复")?;
        let (pending, content) = {
            let mut forms = guard(&self.elicitations);
            let index = forms
                .iter()
                .position(|form| form.request_id == request_id || form.item_id == request_id)
                .ok_or("该提问已失效或已回答")?;
            let content = match action {
                Action::Accept => Some(check_content(&forms[index].schema, content)?),
                _ => None,
            };
            (forms.remove(index), content)
        };
        let mut answer = json!({ "action": action.as_str() });
        if let Some(content) = content {
            answer["content"] = Value::Object(content);
        }
        let written = self.write_value(&json!({ "jsonrpc": "2.0", "id": pending.id, "result": answer }));
        self.settle_form(&pending.item_id, action.decision());
        self.emit_pending();
        self.settle_state();
        written
    }

    /// Withdraw every form that matches `filter`: the agent receives a cancel
    /// and the card closes as withdrawn. Returns whether anything was
    /// withdrawn; the caller publishes the pending set.
    pub(super) fn withdraw_elicitations(&self, filter: impl Fn(&PendingElicitation) -> bool) -> bool {
        let dropped: Vec<PendingElicitation> = {
            let mut forms = guard(&self.elicitations);
            let (dropped, kept) = std::mem::take(&mut *forms).into_iter().partition(|form| filter(form));
            *forms = kept;
            dropped
        };
        let withdrew = !dropped.is_empty();
        for pending in dropped {
            let _ = self.write_value(&json!({ "jsonrpc": "2.0", "id": pending.id, "result": { "action": "cancel" } }));
            self.settle_form(&pending.item_id, "withdrawn");
        }
        withdrew
    }
}
