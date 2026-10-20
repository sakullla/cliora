//! Native 1.1.74 fpe/Atu, Hjn and historical IBo projection. Transcript selection
//! is independent of request accounting: rewinding never refunds past usage.
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::history::{self, ParsedSession};

fn string<'a>(row: &'a Value, key: &str) -> Option<&'a str> { row.get(key).and_then(Value::as_str) }
fn flag(row: &Value, key: &str) -> bool { row.get(key).and_then(Value::as_bool) == Some(true) }
fn kind(row: &Value) -> &str { string(row, "type").unwrap_or_default() }
fn optional(row: &Value, key: &str, check: fn(&Value) -> bool) -> bool { row.get(key).is_none_or(check) }
fn nullable_string(value: &Value) -> bool { value.is_null() || value.is_string() }

/// Known type names alone do not establish a readable source. Match native
/// required shapes before accepting metadata, transcript nodes or usage.
pub(super) fn valid_row(row: &Value) -> bool {
    let strings = |keys: &[&str]| keys.iter().all(|key| string(row, key).is_some());
    let session = strings(&["sessionId"]);
    match kind(row) {
        "user" | "assistant" => strings(&["uuid", "timestamp"]) && row.get("message").is_some_and(Value::is_object),
        "system" => strings(&["uuid", "timestamp"]) && optional(row, "requiresActiveLeafCommit", Value::is_boolean),
        "attachment" => strings(&["uuid", "timestamp", "cwd", "sessionId", "userType", "version"])
            && row.get("parentUuid").is_some_and(nullable_string) && row.get("isSidechain").is_some_and(Value::is_boolean),
        "summary" => strings(&["leafUuid", "summary"]),
        "ai-title" => session && strings(&["aiTitle"]),
        "custom-title" => session && strings(&["customTitle"]),
        "last-prompt" => session && strings(&["lastPrompt"]),
        "tag" => session && strings(&["tag"]),
        "workspace-directories" => session && row.get("directories").and_then(Value::as_array).is_some_and(|items| items.iter().all(Value::is_string)),
        "runtime-config" => session && row.get("timestamp").is_some_and(Value::is_number),
        "mode" => session && matches!(string(row, "mode"), Some("normal" | "coordinator")),
        "content-replacement" => session && row.get("replacements").is_some_and(Value::is_array),
        "file-history-snapshot" => strings(&["messageId"]) && row.get("snapshot").is_some_and(Value::is_object) && row.get("isSnapshotUpdate").is_some_and(Value::is_boolean),
        "token-stats" => session && row.get("promptTokenCount").is_some_and(Value::is_number) && row.get("timestamp").is_some_and(Value::is_number),
        "active-leaf" => session && row.get("leafUuid").is_some_and(nullable_string)
            && row.get("explicit").is_some_and(Value::is_boolean) && optional(row, "rewound", Value::is_boolean)
            && row.get("compactBoundaryUuid").is_none_or(|value| value.is_string() && !flag(row, "explicit"))
            && row.get("timestamp").is_some_and(Value::is_number),
        "relocated" => session && strings(&["relocatedCwd"]),
        "worktree-state" => session && optional(row, "discardLegacyFileHistorySnapshots", |value| value == true)
            && row.get("worktreeSession").is_some_and(|value| value.is_null() || valid_worktree(value)),
        _ => false,
    }
}

fn valid_worktree(row: &Value) -> bool {
    ["originalCwd", "worktreePath", "worktreeName", "sessionId"].iter().all(|key| string(row, key).is_some())
        && ["preEnterOriginalCwd", "worktreeCwd", "worktreeBranch", "originalBranch", "originalHeadCommit", "pendingOwnerReleasePath"].iter().all(|key| optional(row, key, Value::is_string))
        && ["hookBased", "enteredExisting"].iter().all(|key| optional(row, key, Value::is_boolean))
        && optional(row, "pendingExit", |value| value == true)
        && row.get("lifecycle").is_none_or(|value| matches!(value.as_str(), Some("owner" | "attached")))
}

struct Node { row: Value, order: usize }
impl Node {
    fn id(&self) -> &str { string(&self.row, "uuid").unwrap() }
    fn parent(&self) -> Option<&str> { string(&self.row, "parentUuid").filter(|id| !id.is_empty()) }
    fn conversation(&self) -> bool { matches!(kind(&self.row), "user" | "assistant") }
    fn message_id(&self) -> Option<&str> { self.row.pointer("/message/id").and_then(Value::as_str).filter(|id| !id.is_empty()) }
    fn time(&self) -> Option<i64> { self.row.get("timestamp").and_then(history::timestamp) }
    fn tool_result(&self) -> bool { kind(&self.row) == "user" && self.row.pointer("/message/content").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| string(item, "type") == Some("tool_result"))) }
}

#[derive(Default)]
pub(super) struct Transcript {
    // Preserve native Map insertion order even when the value is overwritten.
    nodes: Vec<Node>,
    indices: HashMap<String, usize>,
    active: Option<Value>,
}

impl Transcript {
    pub(super) fn record(&mut self, row: &Value, order: usize) {
        if kind(row) == "active-leaf" { self.active = Some(row.clone()); }
        if !matches!(kind(row), "user" | "assistant" | "system" | "attachment") { return; }
        if kind(row) == "attachment" && row.get("attachment").is_none() { return; }
        if kind(row) == "system" {
            let subtype = string(row, "subtype").unwrap_or_default();
            let content = string(row, "content").unwrap_or_default();
            if matches!(subtype, "background_tasks_changed" | "task_started" | "task_progress" | "task_updated" | "task_notification" | "permission_denied" | "permission_mode_transient")
                || subtype == "informational" && (content.contains("Shift+Tab") || content.contains("Alt+Q")) && (content.contains("YOLO mode") || content.contains("Don't Ask mode")) { return; }
        }
        let id = string(row, "uuid").unwrap();
        let node = Node { row: row.clone(), order };
        if let Some(index) = self.indices.get(id) { self.nodes[*index] = node; }
        else { self.indices.insert(id.to_owned(), self.nodes.len()); self.nodes.push(node); }
    }

    // Hjn repairs old parent references which used message.id rather than uuid,
    // and the parentless message following a queued-command attachment.
    fn normalize(&mut self) {
        let mut aliases: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, node) in self.nodes.iter().enumerate() {
            if let Some(id) = node.message_id() { aliases.entry(id.into()).or_default().push(index); }
        }
        for index in 0..self.nodes.len() {
            for key in ["parentUuid", "logicalParentUuid"] {
                let node = &self.nodes[index];
                let Some(parent) = string(&node.row, key).filter(|id| !self.indices.contains_key(*id)) else { continue; };
                let Some(candidates) = aliases.get(parent) else { continue; };
                let tool_ids: Vec<_> = node.row.pointer("/message/content").and_then(Value::as_array).into_iter().flatten()
                    .filter(|item| string(item, "type") == Some("tool_result")).filter_map(|item| string(item, "tool_use_id")).collect();
                let matching: Vec<_> = candidates.iter().copied().filter(|candidate| {
                    let row = &self.nodes[*candidate].row;
                    kind(row) == "assistant" && tool_ids.iter().all(|id| row.pointer("/message/content").and_then(Value::as_array).into_iter().flatten().any(|item| string(item, "type") == Some("tool_use") && string(item, "id") == Some(*id)))
                }).collect();
                let chosen = if candidates.len() == 1 { candidates.first().copied() }
                    else if node.tool_result() && matching.len() == 1 { matching.first().copied() }
                    else { candidates.iter().copied().rev().find(|candidate| string(&self.nodes[*candidate].row, "timestamp") <= string(&node.row, "timestamp")) };
                if let Some(chosen) = chosen { self.nodes[index].row[key] = self.nodes[chosen].id().into(); }
            }
        }
        for index in 1..self.nodes.len() {
            let previous = &self.nodes[index - 1];
            if self.nodes[index].parent().is_none() && kind(&previous.row) == "attachment" && previous.row.pointer("/attachment/type").and_then(Value::as_str) == Some("queued_command") {
                if let Some(parent) = previous.parent().map(str::to_owned) { self.nodes[index].row["parentUuid"] = parent.into(); }
            }
        }
    }

    fn nearest_conversation(&self, mut index: usize) -> Option<usize> {
        let mut seen = HashSet::new();
        while seen.insert(index) {
            let node = &self.nodes[index];
            if node.conversation() { return Some(index); }
            index = *self.indices.get(node.parent()?)?;
        }
        None
    }

    fn default_leaf(&self) -> Option<usize> {
        let parents: HashSet<_> = self.nodes.iter().filter_map(Node::parent).collect();
        let conversation_parents: HashSet<_> = self.nodes.iter().filter(|node| node.conversation()).filter_map(Node::parent).collect();
        let candidates: HashSet<_> = self.nodes.iter().enumerate().filter(|(_, node)| !parents.contains(node.id()))
            .filter_map(|(index, _)| self.nearest_conversation(index))
            .filter(|index| !conversation_parents.contains(self.nodes[*index].id()) && !flag(&self.nodes[*index].row, "isSidechain")).collect();
        let stable = |index: &usize| kind(&self.nodes[*index].row) != "assistant" || self.nodes[*index].row.pointer("/message/stop_reason") != Some(&Value::Null);
        let any_stable = candidates.iter().any(stable);
        candidates.into_iter().filter(|index| !any_stable || stable(index)).max_by(|a, b| {
            let a = &self.nodes[*a]; let b = &self.nodes[*b];
            a.time().zip(b.time()).map(|(a, b)| a.cmp(&b)).filter(|order| !order.is_eq()).unwrap_or_else(|| a.order.cmp(&b.order))
        })
    }

    pub(super) fn append(mut self, session: &mut ParsedSession, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        history::check_cancelled(cancelled)?;
        self.normalize();
        let active = self.active.as_ref();
        if active.is_some_and(|row| row.get("leafUuid") == Some(&Value::Null)) { return Ok(()); }
        let selected = active.and_then(|row| string(row, "leafUuid")).and_then(|id| self.indices.get(id)).copied()
            .filter(|index| string(&self.nodes[*index].row, "sessionId") == active.and_then(|row| string(row, "sessionId")));
        if active.is_some() && selected.is_none() { session.partial = true; }
        let Some(mut current) = selected.and_then(|index| self.nearest_conversation(index)).or_else(|| self.default_leaf()) else {
            if self.nodes.iter().any(Node::conversation) { session.partial = true; }
            return Ok(());
        };
        let mut chain = Vec::new(); let mut seen = HashSet::new();
        loop {
            history::check_cancelled(cancelled)?;
            if !seen.insert(current) { session.partial = true; break; }
            chain.push(current);
            let node = &self.nodes[current];
            let parent = if kind(&node.row) == "system" && string(&node.row, "subtype") == Some("compact_boundary") {
                string(&node.row, "logicalParentUuid").or_else(|| node.parent())
            } else { node.parent() };
            let Some(parent) = parent else { break; };
            if let Some(index) = self.indices.get(parent).filter(|index| !seen.contains(*index)) { current = *index; continue; }
            session.partial = true;
            // Native KAu timestamp recovery is bounded to five seconds and the
            // same sidechain. First inserted candidate wins equal timestamps.
            let recovered = node.time().and_then(|time| self.nodes.iter().enumerate()
                .filter(|(index, candidate)| !seen.contains(index) && flag(&candidate.row, "isSidechain") == flag(&node.row, "isSidechain"))
                .filter_map(|(index, candidate)| candidate.time().map(|previous| (index, time - previous)))
                .filter(|(_, delta)| (0..=5000).contains(delta)).min_by_key(|(_, delta)| *delta).map(|(index, _)| index));
            if let Some(index) = recovered { current = index; } else { break; }
        }
        chain.reverse();
        // XAu: a response can consist of sibling assistant chunks sharing one
        // message.id, plus tool-result children outside the parent chain.
        let mut groups: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut tool_results: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, node) in self.nodes.iter().enumerate() {
            if kind(&node.row) == "assistant" { if let Some(id) = node.message_id() { groups.entry(id).or_default().push(index); } }
            else if node.tool_result() { if let Some(id) = node.parent() { tool_results.entry(id).or_default().push(index); } }
        }
        let mut anchors = HashMap::new();
        for index in &chain { if kind(&self.nodes[*index].row) == "assistant" { if let Some(id) = self.nodes[*index].message_id() { anchors.insert(id, *index); } } }
        for index in chain {
            history::check_cancelled(cancelled)?;
            let node = &self.nodes[index];
            let mut extras = Vec::new();
            let order = |a: &usize, b: &usize| string(&self.nodes[*a].row, "timestamp").cmp(&string(&self.nodes[*b].row, "timestamp")).then(self.nodes[*a].order.cmp(&self.nodes[*b].order));
            if let Some(id) = node.message_id().filter(|id| anchors.get(id) == Some(&index)) {
                if let Some(siblings) = groups.get(id) {
                    extras.extend(siblings.iter().copied().filter(|sibling| !seen.contains(sibling)));
                    extras.sort_by(order);
                    let mut children: Vec<_> = siblings.iter().flat_map(|sibling| tool_results.get(self.nodes[*sibling].id()).into_iter().flatten()).copied().filter(|child| !seen.contains(child)).collect();
                    children.sort_by(order);
                    extras.extend(children);
                }
            }
            let (before, after): (Vec<_>, Vec<_>) = extras.into_iter().partition(|extra| kind(&self.nodes[*extra].row) == "assistant" && self.nodes[*extra].order < node.order);
            for item in before.into_iter().chain([index]).chain(after) {
                seen.insert(item);
                let node = &self.nodes[item];
                if !node.conversation() || ["isMeta", "isSidechain", "isCompactSummary"].iter().any(|key| flag(&node.row, key)) { continue; }
                session.add_message(node.id().into(), kind(&node.row), node.row.pointer("/message/content").map(super::text).unwrap_or_default(), node.time());
            }
        }
        Ok(())
    }
}
