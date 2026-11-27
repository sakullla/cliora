//! The ordered conversation timeline.
//!
//! Every visible thing a conversation produces — a message, a tool call, a host
//! notice, the end of a turn, a subagent — is one item with a stable id. An
//! item's place is fixed when it first appears; later chunks and tool updates
//! merge into it in place instead of appending a second copy, so a reply, a
//! tool, another reply and the tool's update read in the order they arrived.
//!
//! The timeline is bounded: past its character budget the oldest items of
//! finished turns are dropped down to a low-water mark and one notice says so.
//! Trimming below the budget, not just under it, keeps the full-snapshot
//! republish that a trim causes rare: the next one waits until the timeline
//! has grown by a quarter of the budget again (or a turn has ended).

use serde::Serialize;
use serde_json::Value;

/// Total retained characters across the timeline.
pub const MAX_TIMELINE_CHARS: usize = 2_000_000;
/// A trim drops history until the timeline holds at most this share of its
/// budget, in percent.
pub const TRIM_LOW_WATER_PERCENT: usize = 75;
/// Retained text per message. Longer output is truncated once and reported.
pub const MAX_MESSAGE_CHARS: usize = 200_000;
/// Retained characters for each side of a diff.
pub const MAX_DIFF_CHARS: usize = 256_000;
/// Retained characters of the tool input summary.
pub const MAX_RAW_INPUT_CHARS: usize = 4_000;
/// Retained characters of a subagent summary.
const MAX_SUMMARY_CHARS: usize = 400;
/// Retained content entries and locations per tool call.
const MAX_TOOL_ENTRIES: usize = 64;

/// The id of the one notice that reports dropped history.
pub const TRIMMED_NOTICE_ID: &str = "notice-trimmed";

/// Trim retained text to a budget, reporting whether it was cut.
pub fn cap(text: &str, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        Some((index, _)) => (text[..index].to_owned(), true),
        None => (text.to_owned(), false),
    }
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

/// One retained message. `role` is user, agent, thought or session (a message
/// another session sent, reported through a subagent's transcript).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpMessage {
    pub id: String,
    pub role: &'static str,
    pub text: String,
    /// Output past the retained budget was dropped, not silently shortened.
    pub truncated: bool,
    pub turn_id: String,
    /// The child session this message belongs to; none for the conversation's own.
    pub subagent: Option<String>,
}

/// One piece of tool output, as the protocol typed it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AcpToolContent {
    /// Text, including the text of an embedded resource.
    Text { text: String, truncated: bool },
    /// A file change. A missing old text is a new file.
    Diff { path: String, old_text: Option<String>, new_text: String, truncated: bool },
    /// A terminal the agent created; its output belongs to the terminal.
    Terminal { terminal_id: String },
    /// An image: only its type is kept, never its data.
    Image { mime_type: String },
    /// A display-only reference to another session, such as a subagent.
    Session { session_id: String },
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolLocation {
    pub path: String,
    pub line: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    /// The protocol's option kind, kept as the agent sent it.
    pub kind: String,
}

/// An open authorization request, attached to the tool call it asks about. It
/// is valid only while the request, its session and the connection that asked
/// for it are alive, and it is answered at most once.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequest {
    pub request_id: String,
    pub turn_id: String,
    pub options: Vec<AcpPermissionOption>,
}

/// One tool call, merged by its call id within its session.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCall {
    pub id: String,
    pub call_id: String,
    pub title: String,
    /// read, edit, delete, move, search, execute, think, fetch, switch_mode or
    /// other. Named apart from the timeline's own `kind` tag.
    pub tool_kind: &'static str,
    /// pending, in_progress, completed or failed.
    pub status: &'static str,
    pub content: Vec<AcpToolContent>,
    pub locations: Vec<AcpToolLocation>,
    /// A bounded JSON summary of the tool input.
    pub raw_input: Option<String>,
    pub turn_id: String,
    pub subagent: Option<String>,
    pub permission: Option<AcpPermissionRequest>,
}

/// A host notice: something the user should know that is not conversation.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpNotice {
    pub id: String,
    /// info, warning or error.
    pub level: &'static str,
    /// A stable code the view can word itself; empty for a free-text notice.
    pub code: &'static str,
    pub text: String,
    pub turn_id: String,
}

/// The end of one turn and its reason, from the closed set the host reports.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpTurnEnd {
    pub id: String,
    pub turn_id: String,
    pub reason: &'static str,
}

/// A child session the agent announced. Its own messages and tools carry its
/// session id in their `subagent` field.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpSubagent {
    pub id: String,
    pub session_id: String,
    /// The session that owns this child: the conversation itself or another child.
    pub parent: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// running, requires_action, idle, unknown, or a value the agent defined.
    pub state: Option<String>,
    pub stop_reason: Option<String>,
    /// The tail of the child's latest reply.
    pub summary: String,
    pub turn_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AcpTimelineItem {
    Message(AcpMessage),
    Tool(AcpToolCall),
    Notice(AcpNotice),
    Turn(AcpTurnEnd),
    Subagent(AcpSubagent),
}

impl AcpTimelineItem {
    pub fn id(&self) -> &str {
        match self {
            Self::Message(item) => &item.id,
            Self::Tool(item) => &item.id,
            Self::Notice(item) => &item.id,
            Self::Turn(item) => &item.id,
            Self::Subagent(item) => &item.id,
        }
    }

    fn turn_id(&self) -> &str {
        match self {
            Self::Message(item) => &item.turn_id,
            Self::Tool(item) => &item.turn_id,
            Self::Notice(item) => &item.turn_id,
            Self::Turn(item) => &item.turn_id,
            Self::Subagent(item) => &item.turn_id,
        }
    }

    /// Characters this item holds against the timeline budget.
    fn weight(&self) -> usize {
        match self {
            Self::Message(item) => chars(&item.text),
            Self::Tool(item) => {
                chars(&item.title)
                    + item.raw_input.as_deref().map(chars).unwrap_or(0)
                    + item
                        .content
                        .iter()
                        .map(|content| match content {
                            AcpToolContent::Text { text, .. } => chars(text),
                            AcpToolContent::Diff { path, old_text, new_text, .. } => {
                                chars(path) + old_text.as_deref().map(chars).unwrap_or(0) + chars(new_text)
                            }
                            AcpToolContent::Terminal { terminal_id } => chars(terminal_id),
                            AcpToolContent::Image { mime_type } => chars(mime_type),
                            AcpToolContent::Session { session_id } => chars(session_id),
                        })
                        .sum::<usize>()
                    + item.locations.iter().map(|location| chars(&location.path)).sum::<usize>()
            }
            Self::Notice(item) => chars(&item.text),
            Self::Turn(_) => 0,
            Self::Subagent(item) => {
                chars(&item.summary)
                    + item.title.as_deref().map(chars).unwrap_or(0)
                    + item.description.as_deref().map(chars).unwrap_or(0)
            }
        }
    }
}

/// What one appended chunk did, for the chunk event.
#[derive(Clone, Debug, PartialEq)]
pub struct ChunkOutcome {
    pub id: String,
    pub role: &'static str,
    /// The text actually appended; empty when the message was already full.
    pub text: String,
    pub truncated: bool,
    pub subagent: Option<String>,
    pub turn_id: String,
}

pub struct Timeline {
    items: Vec<AcpTimelineItem>,
    weight: usize,
    budget: usize,
    trimmed: usize,
    next_auto: u64,
}

impl Default for Timeline {
    fn default() -> Self {
        Self::new(MAX_TIMELINE_CHARS)
    }
}

/// The id a message chunk lands under. A child's ids live in the child's own
/// namespace: its "m1" is not the conversation's "m1".
fn scoped(subagent: Option<&str>, id: &str) -> String {
    match subagent {
        Some(child) => format!("{child}::{id}"),
        None => id.to_owned(),
    }
}

pub fn tool_item_id(subagent: Option<&str>, call_id: &str) -> String {
    format!("tool:{}", scoped(subagent, call_id))
}

pub fn subagent_item_id(session_id: &str) -> String {
    format!("subagent:{session_id}")
}

fn tool_kind(kind: &str) -> &'static str {
    match kind {
        "read" => "read",
        "edit" => "edit",
        "delete" => "delete",
        "move" => "move",
        "search" => "search",
        "execute" => "execute",
        "think" => "think",
        "fetch" => "fetch",
        "switch_mode" => "switch_mode",
        _ => "other",
    }
}

fn tool_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "pending" => "pending",
        _ => "in_progress",
    }
}

/// The text a content block contributes to a message or a text entry.
pub fn block_text(block: &Value) -> Option<String> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") | None => block.get("text").and_then(Value::as_str).map(ToOwned::to_owned),
        Some("resource") => block
            .get("resource")
            .and_then(|resource| resource.get("text"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        Some("resource_link") => block
            .get("uri")
            .and_then(Value::as_str)
            .map(|uri| {
                let name = block.get("name").and_then(Value::as_str).unwrap_or(uri);
                format!("[{name}]({uri})")
            }),
        _ => None,
    }
}

fn parse_content(items: &[Value]) -> Vec<AcpToolContent> {
    let mut content = Vec::new();
    for item in items.iter().take(MAX_TOOL_ENTRIES) {
        match item.get("type").and_then(Value::as_str) {
            Some("content") => {
                let Some(block) = item.get("content") else { continue };
                if block.get("type").and_then(Value::as_str) == Some("image") {
                    let mime_type = block.get("mimeType").and_then(Value::as_str).unwrap_or("image");
                    content.push(AcpToolContent::Image { mime_type: cap(mime_type, 100).0 });
                } else if let Some(text) = block_text(block) {
                    let (text, truncated) = cap(&text, MAX_MESSAGE_CHARS);
                    content.push(AcpToolContent::Text { text, truncated });
                }
            }
            Some("diff") => {
                let Some(path) = item.get("path").and_then(Value::as_str) else { continue };
                let (old_text, old_cut) = match item.get("oldText").and_then(Value::as_str) {
                    Some(text) => {
                        let (text, cut) = cap(text, MAX_DIFF_CHARS);
                        (Some(text), cut)
                    }
                    None => (None, false),
                };
                let (new_text, new_cut) =
                    cap(item.get("newText").and_then(Value::as_str).unwrap_or_default(), MAX_DIFF_CHARS);
                content.push(AcpToolContent::Diff {
                    path: cap(path, 4_096).0,
                    old_text,
                    new_text,
                    truncated: old_cut || new_cut,
                });
            }
            Some("terminal") => {
                if let Some(id) = item.get("terminalId").and_then(Value::as_str) {
                    content.push(AcpToolContent::Terminal { terminal_id: cap(id, 200).0 });
                }
            }
            Some("session") => {
                if let Some(id) = item.get("sessionId").and_then(Value::as_str) {
                    content.push(AcpToolContent::Session { session_id: cap(id, 200).0 });
                }
            }
            _ => {}
        }
    }
    content
}

fn parse_locations(items: &[Value]) -> Vec<AcpToolLocation> {
    items
        .iter()
        .take(MAX_TOOL_ENTRIES)
        .filter_map(|item| {
            Some(AcpToolLocation {
                path: cap(item.get("path").and_then(Value::as_str)?, 4_096).0,
                line: item.get("line").and_then(Value::as_u64),
            })
        })
        .collect()
}

fn raw_input(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let text = value.to_string();
    let (mut text, cut) = cap(&text, MAX_RAW_INPUT_CHARS);
    if cut {
        text.push('…');
    }
    Some(text)
}

/// Merge one protocol tool update into a call: a field the update carries
/// replaces the stored value as a whole, a field it omits (or sends as null)
/// stays as it was.
fn merge_tool(call: &mut AcpToolCall, update: &Value) {
    if let Some(title) = update.get("title").and_then(Value::as_str) {
        call.title = cap(title, 1_000).0;
    }
    if let Some(kind) = update.get("kind").and_then(Value::as_str) {
        call.tool_kind = tool_kind(kind);
    }
    if let Some(status) = update.get("status").and_then(Value::as_str) {
        call.status = tool_status(status);
    }
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        call.content = parse_content(items);
    }
    if let Some(items) = update.get("locations").and_then(Value::as_array) {
        call.locations = parse_locations(items);
    }
    if let Some(input) = update.get("rawInput").filter(|value| !value.is_null()) {
        call.raw_input = raw_input(input);
    }
}

impl Timeline {
    pub fn new(budget: usize) -> Self {
        Self { items: Vec::new(), weight: 0, budget, trimmed: 0, next_auto: 0 }
    }

    pub fn items(&self) -> &[AcpTimelineItem] {
        &self.items
    }

    pub fn weight(&self) -> usize {
        self.weight
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.items.iter().rposition(|item| item.id() == id)
    }

    pub fn get(&self, id: &str) -> Option<&AcpTimelineItem> {
        self.position(id).map(|index| &self.items[index])
    }

    /// Insert a new item at the end, or replace the item with the same id where
    /// it already stands.
    pub fn upsert(&mut self, item: AcpTimelineItem) {
        let weight = item.weight();
        match self.position(item.id()) {
            Some(index) => {
                self.weight = self.weight.saturating_sub(self.items[index].weight()) + weight;
                self.items[index] = item;
            }
            None => {
                self.weight += weight;
                self.items.push(item);
            }
        }
    }

    /// A fresh id for an item the protocol does not name.
    pub fn auto_id(&mut self, prefix: &str) -> String {
        self.next_auto += 1;
        format!("{prefix}-{}", self.next_auto)
    }

    /// Append one message chunk. A chunk with a message id merges into that
    /// message wherever it stands. A chunk without one continues the latest
    /// item when that item is a message of the same role, session and turn;
    /// otherwise it starts a new message, so a reply that resumes after a tool
    /// call is placed after that tool.
    pub fn append_chunk(
        &mut self,
        role: &'static str,
        message_id: Option<&str>,
        subagent: Option<&str>,
        turn_id: &str,
        text: &str,
    ) -> ChunkOutcome {
        let id = match message_id {
            Some(id) => scoped(subagent, id),
            None => match self.items.last() {
                Some(AcpTimelineItem::Message(last))
                    if last.role == role
                        && last.subagent.as_deref() == subagent
                        && last.turn_id == turn_id =>
                {
                    last.id.clone()
                }
                _ => {
                    let prefix = scoped(subagent, &format!("{role}-{turn_id}"));
                    self.auto_id(&prefix)
                }
            },
        };
        match self.position(&id) {
            Some(index) => {
                let AcpTimelineItem::Message(message) = &mut self.items[index] else {
                    // The id names something that is not a message: keep that
                    // item and file the chunk under its own message.
                    let fresh = self.auto_id(&format!("{id}-message"));
                    return self.start_message(fresh, role, subagent, turn_id, text);
                };
                if message.truncated {
                    return ChunkOutcome {
                        id,
                        role: message.role,
                        text: String::new(),
                        truncated: true,
                        subagent: message.subagent.clone(),
                        turn_id: message.turn_id.clone(),
                    };
                }
                let room = MAX_MESSAGE_CHARS.saturating_sub(chars(&message.text));
                let (appended, cut) = cap(text, room);
                message.text.push_str(&appended);
                message.truncated = cut;
                self.weight += chars(&appended);
                ChunkOutcome {
                    id,
                    role: message.role,
                    text: appended,
                    truncated: cut,
                    subagent: message.subagent.clone(),
                    turn_id: message.turn_id.clone(),
                }
            }
            None => self.start_message(id, role, subagent, turn_id, text),
        }
    }

    fn start_message(
        &mut self,
        id: String,
        role: &'static str,
        subagent: Option<&str>,
        turn_id: &str,
        text: &str,
    ) -> ChunkOutcome {
        let (text, truncated) = cap(text, MAX_MESSAGE_CHARS);
        self.upsert(AcpTimelineItem::Message(AcpMessage {
            id: id.clone(),
            role,
            text: text.clone(),
            truncated,
            turn_id: turn_id.to_owned(),
            subagent: subagent.map(ToOwned::to_owned),
        }));
        ChunkOutcome {
            id,
            role,
            text,
            truncated,
            subagent: subagent.map(ToOwned::to_owned),
            turn_id: turn_id.to_owned(),
        }
    }

    /// Replace a message's whole text (a session message's content is a
    /// replacement, not an increment).
    pub fn set_message(
        &mut self,
        role: &'static str,
        message_id: &str,
        subagent: Option<&str>,
        turn_id: &str,
        text: &str,
    ) -> AcpTimelineItem {
        let id = scoped(subagent, message_id);
        let (text, truncated) = cap(text, MAX_MESSAGE_CHARS);
        let item = match self.get(&id) {
            Some(AcpTimelineItem::Message(existing)) => AcpTimelineItem::Message(AcpMessage {
                text,
                truncated,
                ..existing.clone()
            }),
            _ => AcpTimelineItem::Message(AcpMessage {
                id,
                role,
                text,
                truncated,
                turn_id: turn_id.to_owned(),
                subagent: subagent.map(ToOwned::to_owned),
            }),
        };
        self.upsert(item.clone());
        item
    }

    /// Create or merge one tool call. A call first seen through an update (or
    /// through a permission request's toolCall) is created from it.
    pub fn upsert_tool(&mut self, subagent: Option<&str>, turn_id: &str, update: &Value, fallback_title: &str) -> Option<AcpToolCall> {
        let call_id = update.get("toolCallId").and_then(Value::as_str)?;
        let id = tool_item_id(subagent, call_id);
        let mut call = match self.get(&id) {
            Some(AcpTimelineItem::Tool(existing)) => existing.clone(),
            _ => AcpToolCall {
                id: id.clone(),
                call_id: cap(call_id, 500).0,
                title: fallback_title.to_owned(),
                tool_kind: "other",
                status: "pending",
                content: Vec::new(),
                locations: Vec::new(),
                raw_input: None,
                turn_id: turn_id.to_owned(),
                subagent: subagent.map(ToOwned::to_owned),
                permission: None,
            },
        };
        merge_tool(&mut call, update);
        self.upsert(AcpTimelineItem::Tool(call.clone()));
        Some(call)
    }

    /// Attach or clear the open authorization request on a tool call.
    pub fn set_permission(&mut self, id: &str, permission: Option<AcpPermissionRequest>) -> Option<AcpToolCall> {
        let index = self.position(id)?;
        let AcpTimelineItem::Tool(call) = &mut self.items[index] else { return None };
        call.permission = permission;
        Some(call.clone())
    }

    /// The tail of the latest reply a child produced.
    pub fn subagent_summary(&self, session_id: &str) -> String {
        self.items
            .iter()
            .rev()
            .find_map(|item| match item {
                AcpTimelineItem::Message(message)
                    if message.role == "agent" && message.subagent.as_deref() == Some(session_id) =>
                {
                    Some(message.text.as_str())
                }
                _ => None,
            })
            .map(|text| {
                let count = chars(text);
                if count <= MAX_SUMMARY_CHARS {
                    text.to_owned()
                } else {
                    let tail: String = text.chars().skip(count - MAX_SUMMARY_CHARS).collect();
                    format!("…{tail}")
                }
            })
            .unwrap_or_default()
    }

    /// Once the timeline is over its budget, drop the oldest items of finished
    /// turns until it is back at the low-water mark. Items of the active turn
    /// are never dropped; when they alone keep the timeline over budget, later
    /// calls find nothing to drop and return false until that turn ends.
    /// Returns whether anything was dropped; the caller then republishes the
    /// whole snapshot.
    pub fn trim(&mut self, active_turn: Option<&str>) -> bool {
        if self.weight <= self.budget {
            return false;
        }
        let low_water = self.budget / 100 * TRIM_LOW_WATER_PERCENT
            + self.budget % 100 * TRIM_LOW_WATER_PERCENT / 100;
        let mut dropped = 0usize;
        let mut index = 0usize;
        while self.weight > low_water && index < self.items.len() {
            let item = &self.items[index];
            if item.id() == TRIMMED_NOTICE_ID {
                index += 1;
                continue;
            }
            if active_turn.is_some_and(|turn| !turn.is_empty() && item.turn_id() == turn) {
                break;
            }
            // A tool still waiting for an answer is never dropped under its card.
            if matches!(item, AcpTimelineItem::Tool(call) if call.permission.is_some()) {
                index += 1;
                continue;
            }
            let removed = self.items.remove(index);
            self.weight = self.weight.saturating_sub(removed.weight());
            dropped += 1;
        }
        if dropped == 0 {
            return false;
        }
        self.trimmed += dropped;
        let notice = AcpTimelineItem::Notice(AcpNotice {
            id: TRIMMED_NOTICE_ID.to_owned(),
            level: "info",
            code: "trimmed",
            text: format!("较早的 {} 项对话内容已省略", self.trimmed),
            turn_id: String::new(),
        });
        if let Some(position) = self.position(TRIMMED_NOTICE_ID) {
            self.weight = self.weight.saturating_sub(self.items[position].weight());
            self.items.remove(position);
        }
        self.weight += notice.weight();
        self.items.insert(0, notice);
        true
    }
}
