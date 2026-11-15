//! OMP session v3 history: the 256-byte title slot, tree entries, message and
//! `model_usage` accounting, and native `--resume` identity.
//!
//! Native facts checked against oh-my-pi 18.20.2 (`src/session`):
//! `sessions/<project>/<uuid>.jsonl` is a JSONL file whose first line is a
//! fixed-width 256-byte title slot (`type: "title"`, `v: 1`, `title`, optional
//! `source: "auto" | "user"`, `updatedAt`, `pad`) followed by a
//! `type: "session"` header (`version: 3`; v1 has no version and no entry ids)
//! and tree entries with `id`/`parentId`/`activeLeafId`. Assistant messages and
//! standalone `model_usage` entries carry `usage.input/output/cacheRead/
//! cacheWrite` plus a locally priced `cost`. The slot wins over the header
//! title, and an empty slot title clears it instead of falling back.
//!
//! This module only reads. It never rewrites the JSONL body or the title slot,
//! and never substitutes Pi's JSONL/session semantics. Native cost has no
//! channel in the shared `UsageEvent`; it is verified in this module's tests and
//! deliberately left out of the shared pipeline, matching other adapters.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::history::usage::{self, RequestUsage};
use crate::history::{
    discover_jsonl_controlled, read_jsonl_controlled, text_content, timestamp, valid_native_id,
    HistorySource, ParsedSession, UsageEvent,
};

pub(crate) const AVAILABLE_REASON: &str =
    "可只读索引 OMP session v3 的标题槽与本地用量，并用 --resume 恢复指定会话";

/// Native JSONL is never opened for writing by this module.
#[allow(dead_code)]
const TITLE_SLOT_BYTES: usize = 256;
const SUPPORTED_VERSIONS: std::ops::RangeInclusive<u64> = 1..=3;

pub(crate) fn supported() -> bool {
    true
}

pub(crate) fn facet() -> crate::adapters::Facet {
    crate::adapters::Facet {
        state: "available",
        reason: AVAILABLE_REASON,
    }
}

fn environment() -> BTreeMap<String, String> {
    ["OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]
        .iter()
        .filter_map(|name| {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| ((*name).to_owned(), value))
        })
        .collect()
}

/// Session root for one explicit environment map. `configuration::resolve_root`
/// owns the default/named Profile rules; OMP stores sessions below that agent
/// directory. Invalid profile or config-dir values stay errors instead of
/// guessing a location.
fn sessions_root_with(
    home: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    let profile = environment
        .get("OMP_PROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| environment.get("PI_PROFILE").filter(|value| !value.is_empty()));
    let config_dir = environment
        .get("PI_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let coding_agent_dir = environment
        .get("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let resolved = super::configuration::resolve_root(&super::configuration::ResolutionInput {
        home,
        profile: profile.map(String::as_str),
        config_dir: config_dir.as_deref(),
        coding_agent_dir: coding_agent_dir.as_deref(),
    })?;
    Ok(resolved.root.join("sessions"))
}

/// Effective session root: the active account context wins over the environment
/// root, exactly like the configuration editor and MCP/Skills/Agents roots.
fn sessions_root(home: &Path) -> Result<PathBuf, String> {
    let fallback = sessions_root_with(home, &environment())?;
    Ok(crate::accounts::selection::history_root(super::ID, || fallback))
}

pub(crate) fn sources(home: &Path) -> Result<Vec<HistorySource>, String> {
    let root = sessions_root(home)?;
    let mut sources = discover_jsonl_controlled(
        &root,
        |path| path.extension().is_some_and(|value| value == "jsonl"),
        &|| false,
    )?;
    // A title-only rewrite keeps the file size but changes mtime/change-time;
    // the explicit prefix also rebuilds indexes written by the pre-title parser.
    for source in &mut sources {
        source.fingerprint = format!("omp-title-slot-v1|{}", source.fingerprint);
    }
    Ok(sources)
}

#[derive(Clone, Debug)]
struct Slot {
    title: String,
    /// Kept so auto/user semantics stay inspectable; the slot title itself is
    /// already the authoritative value for display.
    #[allow(dead_code)]
    source: Option<String>,
}

#[derive(Clone, Debug)]
struct Header {
    version: u64,
    id: Option<String>,
    title: Option<String>,
    timestamp: Option<i64>,
    cwd: Option<String>,
}

#[derive(Clone, Debug)]
struct UsageSample {
    counts: usage::TokenCounts,
    /// Native priced cost has no shared `UsageEvent` channel; module tests verify
    /// it from the same parse without persisting a currency claim.
    #[allow(dead_code)]
    cost: Option<f64>,
    model: Option<String>,
    timestamp: Option<i64>,
}

#[derive(Clone, Debug)]
enum EntryKind {
    Ignore,
    Message {
        role: String,
        text: String,
        timestamp: Option<i64>,
        usage: Option<UsageSample>,
    },
    ModelUsage(UsageSample),
    System {
        text: String,
        timestamp: Option<i64>,
    },
}

#[derive(Clone, Debug)]
struct Entry {
    line: usize,
    id: Option<String>,
    parent: Option<String>,
    /// `None` = field absent, `Some(None)` = explicit null leaf.
    active_leaf: Option<Option<String>>,
    timestamp: Option<i64>,
    model: Option<String>,
    kind: EntryKind,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

/// Native per-call cost, as OMP writes `usage.cost.total` (or component sums in
/// older files). Missing prices stay unknown rather than becoming zero.
fn cost_total(usage: &Value) -> Option<f64> {
    let cost = usage.get("cost")?;
    if let Some(total) = number(cost.get("total")) {
        return Some(total);
    }
    if let Some(total) = number(Some(cost)) {
        return Some(total);
    }
    let parts = ["input", "output", "cacheRead", "cacheWrite"];
    let mut sum = 0.0;
    let mut seen = false;
    for part in parts {
        if let Some(value) = number(cost.get(part)) {
            sum += value;
            seen = true;
        }
    }
    seen.then_some(sum)
}

fn model_identifier(provider: Option<&str>, model: Option<&str>) -> Option<String> {
    let model = model.map(str::trim).filter(|model| !model.is_empty())?;
    let provider = provider.map(str::trim).filter(|provider| !provider.is_empty());
    Some(match provider {
        Some(provider) if !model.starts_with(&format!("{provider}/")) => {
            format!("{provider}/{model}")
        }
        _ => model.to_owned(),
    })
}

fn usage_sample(
    usage: &Value,
    provider: Option<&str>,
    model: Option<&str>,
    timestamp: Option<i64>,
) -> Option<UsageSample> {
    let counts = usage::from_optional(
        usage::field(usage, "input"),
        usage::field(usage, "output"),
        usage::field(usage, "cacheRead"),
        usage::field(usage, "cacheWrite"),
    )?;
    if !usage::active(counts) {
        return None;
    }
    Some(UsageSample {
        counts,
        cost: cost_total(usage),
        model: model_identifier(provider, model),
        timestamp,
    })
}

/// Parse the fixed-width title slot. The native reader accepts the shape; the
/// 256-byte width is a writer invariant verified by tests and fixtures.
fn parse_slot(row: &Value) -> Option<Slot> {
    if row.get("type").and_then(Value::as_str) != Some("title") {
        return None;
    }
    if row.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let title = row.get("title")?.as_str()?;
    // Both fields are required by OMP's own slot parser.
    row.get("updatedAt")?.as_str()?;
    row.get("pad")?.as_str()?;
    let source = row
        .get("source")
        .and_then(Value::as_str)
        .filter(|source| ["auto", "user"].contains(source))
        .map(str::to_owned);
    Some(Slot {
        title: title.to_owned(),
        source,
    })
}

fn entry_leaf(row: &Value) -> Option<Option<String>> {
    match row.get("activeLeafId") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(id)) => Some(Some(id.clone())),
        // A non-string marker cannot name a leaf; treat it as a cleared leaf.
        _ => Some(None),
    }
}

fn role(value: &str) -> Option<&'static str> {
    match value {
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        // OMP persists tool results as `toolResult`; the reader shows `tool`.
        "toolResult" => Some("tool"),
        "system" | "developer" => Some("system"),
        // `hookMessage` is the v2 spelling migrated to `custom` and is not a
        // conversation turn; unknown roles stay out instead of being guessed.
        _ => None,
    }
}

fn new_entry(line: usize, row: &Value, kind: EntryKind) -> Entry {
    Entry {
        line,
        id: row.get("id").and_then(Value::as_str).map(str::to_owned),
        parent: row.get("parentId").and_then(Value::as_str).map(str::to_owned),
        active_leaf: entry_leaf(row),
        timestamp: row.get("timestamp").and_then(timestamp),
        model: row.get("model").and_then(Value::as_str).map(str::to_owned),
        kind,
    }
}

fn message_entry(line: usize, row: &Value, message: &Value) -> Entry {
    let entry_timestamp = row.get("timestamp").and_then(timestamp);
    let message_timestamp = message.get("timestamp").and_then(timestamp);
    let effective_time = message_timestamp.or(entry_timestamp);
    let raw_role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let text = message.get("content").map(text_content).unwrap_or_default();
    let provider = message.get("provider").and_then(Value::as_str);
    let model = message.get("model").and_then(Value::as_str);
    // Usage is kept even when an interrupted assistant turn has no text left.
    let usage = if raw_role == "assistant" {
        message
            .get("usage")
            .and_then(|usage| usage_sample(usage, provider, model, effective_time))
    } else {
        None
    };
    let kind = match role(raw_role) {
        Some(role) => EntryKind::Message {
            role: role.to_owned(),
            text,
            timestamp: effective_time,
            usage,
        },
        _ => EntryKind::Ignore,
    };
    let mut entry = new_entry(line, row, kind);
    // Assistant messages carry the resolved provider/model; `model_change`
    // entries below already carry the `provider/id` spelling.
    entry.model = model_identifier(provider, model);
    entry
}

/// The active branch, resolved exactly like OMP's `resolveSessionLeafId`:
/// the last entry selects itself unless an `activeLeafId` was recorded, an
/// explicit null clears the leaf, and an unknown captured leaf falls back to the
/// newest self-selecting entry. Cycles and missing parents stop the walk.
fn active_path(entries: &[Entry]) -> (Vec<usize>, bool) {
    if entries.is_empty() {
        return (Vec::new(), false);
    }
    let mut by_id = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = entry.id.as_deref().filter(|id| !id.is_empty()) {
            // OMP's loader lets the last entry with an id win.
            by_id.insert(id.to_owned(), index);
        }
    }
    // v1 files, and unindexed entries OMP would migrate, have no tree.
    if by_id.is_empty() {
        return ((0..entries.len()).collect(), false);
    }
    let last = entries.last().expect("non-empty");
    let captured = match &last.active_leaf {
        Some(None) => None,
        Some(Some(id)) => Some(id.clone()),
        None => last.id.clone(),
    };
    let leaf = match captured {
        Some(id) if by_id.contains_key(&id) => Some(id),
        _ => entries
            .iter()
            .rev()
            .find(|entry| match &entry.active_leaf {
                None => entry.id.as_deref().is_some_and(|id| by_id.contains_key(id)),
                Some(Some(id)) => entry.id.as_deref() == Some(id.as_str()),
                Some(None) => false,
            })
            .and_then(|entry| entry.id.clone()),
    };
    let Some(leaf) = leaf else {
        return (Vec::new(), false);
    };
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut damaged = false;
    let mut current = Some(leaf);
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            damaged = true;
            break;
        }
        let Some(&index) = by_id.get(&id) else {
            damaged = true;
            break;
        };
        path.push(index);
        current = entries[index].parent.clone();
        if current.as_ref().is_some_and(|parent| !by_id.contains_key(parent)) {
            damaged = true;
            break;
        }
    }
    path.reverse();
    (path, damaged)
}

fn parse_controlled(
    source: &HistorySource,
    cancelled: &dyn Fn() -> bool,
) -> Result<ParsedSession, String> {
    let mut header: Option<Header> = None;
    let mut fatal: Option<String> = None;
    let mut slot: Option<Slot> = None;
    let mut entries: Vec<Entry> = Vec::new();
    let mut first_record = true;
    let mut damaged = false;

    let partial = read_jsonl_controlled(source, cancelled, |line, row| {
        if fatal.is_some() {
            return;
        }
        let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
        if header.is_none() {
            if first_record {
                first_record = false;
                if kind == "title" {
                    match parse_slot(&row) {
                        Some(parsed) => {
                            slot = Some(parsed);
                            return;
                        }
                        None => {
                            // A damaged slot is one damaged record; the next
                            // readable record can still be the session header.
                            damaged = true;
                            return;
                        }
                    }
                }
            }
            if kind != "session" {
                fatal = Some("无法识别的 OMP 会话头：首条记录不是 session".into());
                return;
            }
            let version = match row.get("version") {
                None => 1,
                Some(value) => match value.as_u64() {
                    Some(version) => version,
                    None => {
                        fatal = Some("无法识别的 OMP 会话头：版本不是整数".into());
                        return;
                    }
                },
            };
            if !SUPPORTED_VERSIONS.contains(&version) {
                fatal = Some(format!(
                    "不支持的 OMP session 版本：{version}；当前解析器仅支持 1–3"
                ));
                return;
            }
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            if id.is_none() {
                fatal = Some("无法识别的 OMP 会话头：缺少会话 ID".into());
                return;
            }
            header = Some(Header {
                version,
                id,
                title: row
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|title| !title.trim().is_empty()),
                timestamp: row.get("timestamp").and_then(timestamp),
                cwd: row
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|cwd| !cwd.trim().is_empty())
                    .map(str::to_owned),
            });
            return;
        }

        let entry_timestamp = row.get("timestamp").and_then(timestamp);
        let entry = match kind {
            "message" => match row.get("message") {
                Some(message) => message_entry(line, &row, message),
                None => new_entry(line, &row, EntryKind::Ignore),
            },
            "model_usage" => {
                let sample = row.get("usage").and_then(|usage| {
                    usage_sample(
                        usage,
                        row.get("provider").and_then(Value::as_str),
                        row.get("model").and_then(Value::as_str),
                        entry_timestamp,
                    )
                });
                new_entry(
                    line,
                    &row,
                    sample.map_or(EntryKind::Ignore, EntryKind::ModelUsage),
                )
            }
            "compaction" | "branch_summary" => new_entry(
                line,
                &row,
                EntryKind::System {
                    text: row
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_default(),
                    timestamp: entry_timestamp,
                },
            ),
            "custom_message" => new_entry(
                line,
                &row,
                EntryKind::System {
                    text: row.get("content").map(text_content).unwrap_or_default(),
                    timestamp: entry_timestamp,
                },
            ),
            _ => new_entry(line, &row, EntryKind::Ignore),
        };
        entries.push(entry);
    })?;

    if let Some(error) = fatal {
        return Err(error);
    }
    let Some(header) = header else {
        return Err("未找到可识别的 OMP session 头".into());
    };
    // The slot is authoritative: an empty slot title clears a header title.
    let explicit_title = match &slot {
        Some(slot) => slot.title.trim().to_owned(),
        None => header.title.clone().unwrap_or_default(),
    };
    let mut session = ParsedSession::new();
    session.native_id = header.id.as_deref().filter(|id| valid_native_id(id)).map(str::to_owned);
    if session.native_id.is_none() {
        damaged = true;
    }
    session.title = explicit_title;
    session.cwd = header.cwd.clone();
    session.started_at = header.timestamp;
    session.model = None;

    // v1 is the pre-tree format; OMP migrates it into a linear chain.
    let (path, path_damaged) = if header.version == 1 {
        ((0..entries.len()).collect::<Vec<_>>(), false)
    } else {
        active_path(&entries)
    };
    damaged |= path_damaged;
    let mut active_model: Option<String> = None;
    // Updated time covers diagnostics and usage too, not only transcript rows.
    let mut latest_time = header.timestamp;
    for entry in &entries {
        latest_time = latest_time.max(entry.timestamp.or_else(|| entry_time(entry)));
    }
    for index in path {
        let entry = &entries[index];
        if let Some(model) = entry.model.as_ref() {
            active_model = Some(model.clone());
        }
        match &entry.kind {
            EntryKind::Message {
                role,
                text,
                timestamp,
                ..
            } => {
                session.add_message(
                    entry_key(entry),
                    role,
                    text.clone(),
                    *timestamp,
                );
            }
            EntryKind::System { text, timestamp } if !text.trim().is_empty() => {
                session.add_message(
                    format!("system:{}", entry_key(entry)),
                    "system",
                    text.clone(),
                    *timestamp,
                );
            }
            _ => {}
        }
    }
    session.model = active_model;

    let mut events = BTreeMap::<String, RequestUsage>::new();
    for entry in &entries {
        let sample = match &entry.kind {
            EntryKind::Message { usage: Some(sample), .. } => Some(sample),
            EntryKind::ModelUsage(sample) => Some(sample),
            _ => None,
        };
        let Some(sample) = sample else {
            continue;
        };
        usage::keep_largest_output(
            &mut events,
            format!("{}:{}", source.key(), entry_key(entry)),
            RequestUsage {
                counts: sample.counts,
                model: sample.model.clone(),
                timestamp: sample.timestamp,
            },
        );
    }
    session.usage = events
        .into_iter()
        .map(|(id, event)| UsageEvent {
            native_usage: None,
            request_count: Some(1),
            id,
            model: event.model,
            timestamp: event.timestamp,
            input: Some(event.counts.input),
            output: Some(event.counts.output),
            cache_read: Some(event.counts.read),
            cache_write: Some(event.counts.write),
            input_includes_cache: false,
            attributions: Vec::new(),
        })
        .collect();
    session.updated_at = latest_time;
    session.partial |= partial || damaged;
    if session.messages.is_empty() && session.usage.is_empty() && session.title.trim().is_empty() {
        return Err(crate::history::EMPTY_SESSION.into());
    }
    session.finish(source)
}

fn entry_key(entry: &Entry) -> String {
    entry
        .id
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("line-{}", entry.line))
}

fn entry_time(entry: &Entry) -> Option<i64> {
    match &entry.kind {
        EntryKind::Message { timestamp, .. } | EntryKind::System { timestamp, .. } => *timestamp,
        EntryKind::ModelUsage(sample) => sample.timestamp,
        EntryKind::Ignore => None,
    }
}

pub(crate) fn parse(source: &HistorySource) -> Result<ParsedSession, String> {
    parse_controlled(source, &|| false)
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/history")
        .join(name)
}

fn checks(entries: Vec<(String, bool, String)>) -> Value {
    let failed = entries.iter().any(|(_, passed, _)| !passed);
    serde_json::json!({
        "passed": !failed,
        "checks": entries
            .into_iter()
            .map(|(name, passed, detail)| serde_json::json!({ "name": name, "passed": passed, "detail": detail }))
            .collect::<Vec<_>>(),
    })
}

fn fixture_source(name: &str) -> HistorySource {
    HistorySource {
        native_title: None,
        path: fixture_path(name),
        native_id: None,
        fingerprint: "fixture".into(),
        fingerprint_error: None,
    }
}

fn aggregate(parsed: &ParsedSession) -> (u64, u64, u64, u64, Vec<String>) {
    let mut input = 0;
    let mut output = 0;
    let mut read = 0;
    let mut write = 0;
    let mut models: Vec<String> = Vec::new();
    for event in &parsed.usage {
        input += event.input.unwrap_or(0);
        output += event.output.unwrap_or(0);
        read += event.cache_read.unwrap_or(0);
        write += event.cache_write.unwrap_or(0);
        if let Some(model) = event
            .model
            .as_ref()
            .filter(|model| !models.iter().any(|item| item == *model))
        {
            models.push(model.clone());
        }
    }
    (input, output, read, write, models)
}

fn expect_session(
    case: &Value,
    entries: &mut Vec<(String, bool, String)>,
) -> Result<(), String> {
    let name = case
        .get("fixture")
        .and_then(Value::as_str)
        .ok_or("history 用例缺少 fixture")?;
    let parsed = parse(&fixture_source(name)).map_err(|error| format!("{name}：{error}"))?;
    let expect = case
        .get("expect")
        .and_then(Value::as_object)
        .ok_or("session 用例缺少 expect")?;
    fn compare(
        entries: &mut Vec<(String, bool, String)>,
        field: &str,
        actual: String,
        expected: &str,
    ) {
        entries.push((
            field.to_owned(),
            actual == expected,
            format!("实际 {actual}，期望 {expected}"),
        ));
    }
    if let Some(expected) = expect.get("title").and_then(Value::as_str) {
        compare(entries, "title", parsed.title.clone(), expected);
    }
    if let Some(expected) = expect.get("nativeId").and_then(Value::as_str) {
        compare(
            entries,
            "nativeId",
            parsed.native_id.clone().unwrap_or_default(),
            expected,
        );
    }
    if let Some(expected) = expect.get("cwd").and_then(Value::as_str) {
        compare(
            entries,
            "cwd",
            parsed.cwd.clone().unwrap_or_default(),
            expected,
        );
    }
    if let Some(expected) = expect.get("partial").and_then(Value::as_bool) {
        entries.push(("partial".into(), parsed.partial == expected, format!("实际 {}", parsed.partial)));
    }
    if let Some(expected) = expect.get("messages").and_then(Value::as_array) {
        let actual: Vec<String> = parsed.messages.iter().map(|message| message.text.clone()).collect();
        let expected: Vec<String> = expected.iter().filter_map(Value::as_str).map(str::to_owned).collect();
        entries.push((
            "messages".into(),
            actual == expected,
            format!("实际 {actual:?}，期望 {expected:?}"),
        ));
    }
    if let Some(expected) = expect.get("usageCount").and_then(Value::as_u64) {
        entries.push((
            "usageCount".into(),
            parsed.usage.len() as u64 == expected,
            format!("实际 {}", parsed.usage.len()),
        ));
    }
    let (input, output, read, write, models) = aggregate(&parsed);
    for (field, actual) in [
        ("input", input),
        ("output", output),
        ("cacheRead", read),
        ("cacheWrite", write),
    ] {
        if let Some(expected) = expect.get(field).and_then(Value::as_u64) {
            entries.push((field.into(), actual == expected, format!("实际 {actual}，期望 {expected}")));
        }
    }
    if let Some(expected) = expect.get("models").and_then(Value::as_array) {
        let expected: Vec<String> = expected.iter().filter_map(Value::as_str).map(str::to_owned).collect();
        entries.push(("models".into(), models == expected, format!("实际 {models:?}")));
    }
    Ok(())
}

pub(crate) fn verify_case(
    case: &Value,
    _context: &super::verify::CaseContext,
) -> Result<Value, super::verify::CaseError> {
    let action = case
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| super::verify::CaseError::Failed("history 用例缺少 action".into()))?;
    let mut entries = Vec::new();
    match action {
        "session" => {
            expect_session(case, &mut entries).map_err(super::verify::CaseError::Failed)?;
            Ok(serde_json::json!({ "kind": action, "result": checks(entries) }))
        }
        "unsupported" => {
            let name = case
                .get("fixture")
                .and_then(Value::as_str)
                .ok_or_else(|| super::verify::CaseError::Failed("unsupported 用例缺少 fixture".into()))?;
            let error = parse(&fixture_source(name))
                .err()
                .ok_or_else(|| super::verify::CaseError::Failed(format!("{name} 应不可用")))?;
            let expected = case
                .get("errorContains")
                .and_then(Value::as_str)
                .unwrap_or("版本");
            entries.push((
                "errorContains".into(),
                error.contains(expected),
                error,
            ));
            Ok(serde_json::json!({ "kind": action, "result": checks(entries) }))
        }
        "resume" => {
            let id = case
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| super::verify::CaseError::Failed("resume 用例缺少 id".into()))?;
            let args = super::lifecycle::launch_args(Some(id), crate::adapters::LaunchMode::Normal)
                .map_err(super::verify::CaseError::Failed)?;
            let expected: Vec<String> = case
                .get("args")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_else(|| vec!["--resume".into(), id.into()]);
            entries.push(("args".into(), args == expected, format!("实际 {args:?}")));
            entries.push((
                "no-pi-session".into(),
                !args.iter().any(|arg| arg == "--session"),
                "OMP 不得使用 Pi 的 --session".into(),
            ));
            if case.get("latest").and_then(Value::as_bool).unwrap_or(false) {
                let latest = super::lifecycle::resume_latest_args(crate::adapters::LaunchMode::Normal)
                    .map_err(super::verify::CaseError::Failed)?;
                entries.push((
                    "latest".into(),
                    latest == ["--continue"],
                    format!("实际 {latest:?}"),
                ));
            }
            Ok(serde_json::json!({ "kind": action, "result": checks(entries) }))
        }
        other => Err(super::verify::CaseError::Failed(format!(
            "未知的 history 用例 action：{other}；应为 session/unsupported/resume"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn file(name: &str) -> HistorySource {
        fixture_source(name)
    }

    fn parse_fixture(name: &str) -> ParsedSession {
        parse(&file(name)).unwrap_or_else(|error| panic!("{name}：{error}"))
    }

    #[test]
    fn real_18_20_2_session_uses_the_first_user_turn_when_the_slot_has_no_title() {
        let parsed = parse_fixture("omp-18.20.2-v3.jsonl");
        assert_eq!(
            parsed.native_id.as_deref(),
            Some("0190f4a2-0000-7000-8000-000000000001")
        );
        assert_eq!(parsed.cwd.as_deref(), Some("/fixture/project"));
        assert_eq!(parsed.title, "Explain the fixture project in one sentence.");
        assert_eq!(parsed.messages.len(), 4);
        assert_eq!(parsed.messages[0].role, "user");
        assert_eq!(parsed.messages[1].role, "assistant");
        assert_eq!(parsed.messages[3].text, "Fixture reply from the local test endpoint.");
        assert!(!parsed.partial);
        assert_eq!(
            parsed.model.as_deref(),
            Some("fixture/fixture-model"),
            "resume appends to the same session and keeps the model"
        );
        let (input, output, read, write, models) = aggregate(&parsed);
        assert_eq!((input, output, read, write), (2000, 680, 400, 0));
        assert_eq!(models, ["fixture/fixture-model"]);
        assert!(parsed.usage.iter().all(|event| !event.input_includes_cache));
        assert!(parsed.usage.iter().all(|event| event.request_count == Some(1)));
        // The two session_exit records are diagnostics, not turns.
        assert_eq!(parsed.messages.len(), 4);
    }

    #[test]
    fn title_slot_is_a_256_byte_physical_record_and_wins_over_the_header() {
        let bytes = fs::read(fixture_path("omp-v3-branch-compaction.jsonl")).unwrap();
        assert_eq!(bytes[255], b'\n');
        assert!(
            bytes[..255].iter().all(|byte| *byte != b'\n'),
            "槽必须是一行 256 字节"
        );
        let first = std::str::from_utf8(&bytes[..255]).unwrap();
        let slot = parse_slot(&serde_json::from_str::<Value>(first).unwrap()).unwrap();
        assert_eq!(slot.title, "OMP fixture branch session");
        assert_eq!(slot.source.as_deref(), Some("user"));
        let parsed = parse_fixture("omp-v3-branch-compaction.jsonl");
        assert_eq!(parsed.title, "OMP fixture branch session");
        assert_eq!(parsed.started_at, Some(1_794_700_800_000));
        assert_eq!(parsed.updated_at, Some(1_794_701_400_000));
    }

    #[test]
    fn empty_slot_title_clears_the_header_title_instead_of_falling_back() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("slot-empty.jsonl");
        let slot = {
            let base = serde_json::json!({
                "type": "title",
                "v": 1,
                "title": "",
                "updatedAt": "2026-11-15T00:00:00Z",
                "pad": ""
            });
            let unpadded = format!("{base}\n");
            let pad = TITLE_SLOT_BYTES - unpadded.len();
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "title",
                    "v": 1,
                    "title": "",
                    "updatedAt": "2026-11-15T00:00:00Z",
                    "pad": " ".repeat(pad)
                })
            )
        };
        fs::write(
            &path,
            format!(
                "{slot}{}\n{}\n",
                r#"{"type":"session","version":3,"id":"0190f4a2-0000-7000-8000-000000000010","timestamp":"2026-11-15T00:00:00Z","cwd":"/fixture/project","title":"Header title"}"#,
                r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-15T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Fallback prompt"}]}}"#
            ),
        )
        .unwrap();
        let parsed = parse(&HistorySource {
            path,
            ..file("unused")
        })
        .unwrap();
        assert_eq!(parsed.title, "Fallback prompt");
    }

    #[test]
    fn branch_compaction_interruption_and_model_usage_stay_readable() {
        let parsed = parse_fixture("omp-v3-branch-compaction.jsonl");
        let texts: Vec<&str> = parsed.messages.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "First question",
                "First answer",
                "Active branch question",
                "Active branch answer",
                "Compacted fixture summary.",
                "Explored the abandoned branch.",
                "After compaction",
                "After compaction answer",
                "Interrupted partial answer",
            ]
        );
        assert!(
            !texts.iter().any(|text| text.contains("Abandoned branch")),
            "非活动分支不进入正文"
        );
        assert_eq!(parsed.usage.len(), 6, "标题 model_usage 与中断调用都计入本地用量");
        let (input, output, read, write, models) = aggregate(&parsed);
        assert_eq!((input, output, read, write), (700, 135, 50, 10));
        assert_eq!(models, ["fixture/fixture-model", "fixture/title-model"]);
        assert!(parsed
            .usage
            .iter()
            .any(|event| event.model.as_deref() == Some("fixture/title-model")));
        assert!(parsed
            .messages
            .iter()
            .any(|message| message.text == "Interrupted partial answer"));
        assert!(!parsed.partial);
    }

    #[test]
    fn active_leaf_selects_the_branch_omp_last_had_open() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("active-leaf.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"session","version":3,"id":"0190f4a2-0000-7000-8000-000000000011","timestamp":"2026-11-15T00:00:00Z","cwd":"/fixture/project"}"#,
                r#"{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-15T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"root"}]}}"#,
                r#"{"type":"message","id":"b1","parentId":"a1","timestamp":"2026-11-15T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"kept branch"}]}}"#,
                r#"{"type":"message","id":"c1","parentId":"a1","timestamp":"2026-11-15T00:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"later branch"}]}}"#,
                r#"{"type":"label","id":"l1","parentId":"c1","activeLeafId":"b1","timestamp":"2026-11-15T00:00:04Z","targetId":"b1","label":"pinned"}"#,
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let parsed = parse(&HistorySource {
            path,
            ..file("unused")
        })
        .unwrap();
        let texts: Vec<&str> = parsed.messages.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(texts, ["root", "kept branch"]);
    }

    #[test]
    fn one_damaged_record_marks_partial_without_hiding_other_history() {
        let parsed = parse_fixture("omp-v3-damaged.jsonl");
        assert!(parsed.partial);
        assert_eq!(parsed.title, "Before the damaged record");
        let texts: Vec<&str> = parsed.messages.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(texts, ["Before the damaged record", "After the damaged record."]);
        let (input, output, _, _, _) = aggregate(&parsed);
        assert_eq!((input, output), (10, 5));
    }

    #[test]
    fn unknown_session_versions_and_headers_are_unavailable() {
        let error = parse(&file("omp-v3-unknown-version.jsonl")).unwrap_err();
        assert!(error.contains("版本"), "{error}");
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bad-header.jsonl");
        fs::write(&path, "{\"type\":\"message\",\"id\":\"a1\"}\n").unwrap();
        let error = parse(&HistorySource {
            path,
            ..file("unused")
        })
        .unwrap_err();
        assert!(error.contains("会话头"), "{error}");
    }

    #[test]
    fn version_one_has_no_tree_and_stays_linear() {
        let parsed = parse_fixture("omp-v1-linear.jsonl");
        assert_eq!(parsed.native_id.as_deref(), Some("0190f4a2-0000-7000-8000-000000000005"));
        assert_eq!(parsed.title, "Legacy question");
        let texts: Vec<&str> = parsed.messages.iter().map(|message| message.text.as_str()).collect();
        assert_eq!(texts, ["Legacy question", "Legacy answer"]);
        let (input, output, _, _, _) = aggregate(&parsed);
        assert_eq!((input, output), (7, 3));
    }

    #[test]
    fn native_cost_is_read_per_call_without_entering_the_shared_pipeline() {
        let fixture = fs::read_to_string(fixture_path("omp-v3-branch-compaction.jsonl")).unwrap();
        let mut total = 0.0;
        for line in fixture.lines() {
            let row: Value = serde_json::from_str(line).unwrap();
            let usage = match row.get("type").and_then(Value::as_str) {
                Some("message") => row.get("message").and_then(|message| message.get("usage")),
                Some("model_usage") => row.get("usage"),
                _ => None,
            };
            if let Some(usage) = usage {
                total += cost_total(usage).unwrap_or(0.0);
            }
        }
        assert!((total - 0.000895).abs() < 1e-12, "实际 {total}");
        let parsed = parse_fixture("omp-v3-branch-compaction.jsonl");
        assert!(parsed
            .usage
            .iter()
            .all(|event| event.native_usage.is_none()));
    }

    #[test]
    fn sessions_root_reuses_the_shared_profile_resolver() {
        let home = Path::new("/home/fixture");
        let default = sessions_root_with(home, &BTreeMap::new()).unwrap();
        assert_eq!(default, PathBuf::from("/home/fixture/.omp/agent/sessions"));
        let relocated = sessions_root_with(
            home,
            &BTreeMap::from([("PI_CODING_AGENT_DIR".into(), "/custom/agent".into())]),
        )
        .unwrap();
        assert_eq!(relocated, PathBuf::from("/custom/agent/sessions"));
        let named = sessions_root_with(
            home,
            &BTreeMap::from([
                ("OMP_PROFILE".into(), "work".into()),
                ("PI_PROFILE".into(), "ignored".into()),
                ("PI_CODING_AGENT_DIR".into(), "/custom/agent".into()),
            ]),
        )
        .unwrap();
        assert_eq!(named, PathBuf::from("/home/fixture/.omp/profiles/work/agent/sessions"));
        assert!(sessions_root_with(
            home,
            &BTreeMap::from([("PI_CONFIG_DIR".into(), "../escape".into())])
        )
        .is_err());
    }

    #[test]
    fn native_source_flows_through_the_shared_index_and_resume_plan() {
        use crate::adapters::Registry;
        use crate::database::Database;
        use crate::history::{list, refresh_controlled, resume_plan, HistoryFilter};

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");
        let sessions = home.join(".omp/agent/sessions/--fixture-project--");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&project).unwrap();
        let fixture = fs::read_to_string(fixture_path("omp-18.20.2-v3.jsonl")).unwrap();
        let mut lines = fixture.split_inclusive('\n');
        let slot = lines.next().expect("title slot");
        let mut body = String::from(slot);
        for line in lines {
            if line.contains("\"type\":\"session\"") {
                let mut row: Value = serde_json::from_str(line.trim()).unwrap();
                row["cwd"] = Value::String(project.display().to_string());
                body.push_str(&serde_json::to_string(&row).unwrap());
                body.push('\n');
            } else {
                body.push_str(line);
            }
        }
        fs::write(sessions.join("0190f4a2-0000-7000-8000-000000000001.jsonl"), body).unwrap();

        let db = Database::open(&temp.path().join("index.db")).unwrap();
        let registry = Registry::with_adapters(vec![&crate::adapters::omp::Omp])
            .unwrap()
            .with_fixture_installation(crate::adapters::omp::ID, "18.20.2");
        let terminal = temp.path().join("fixture-terminal");
        fs::write(&terminal, "").unwrap();
        crate::launch::set_custom_terminal(
            &db,
            terminal.display().to_string(),
            vec!["{script}".into()],
        )
        .unwrap();
        let scans = refresh_controlled(
            &db,
            &registry,
            &home,
            &[crate::adapters::omp::ID.to_owned()],
            &|| false,
        )
        .unwrap();
        assert_eq!(scans.len(), 1, "{scans:?}");
        assert_eq!(scans[0].source_count, 1);
        assert_eq!(scans[0].failed_count, 0, "{:?}", scans[0].detail);
        let sessions = list(&db, &HistoryFilter::default()).unwrap();
        assert_eq!(sessions.len(), 1);
        let stored = &sessions[0];
        assert_eq!(stored.tool_id, crate::adapters::omp::ID);
        assert_eq!(stored.title, "Explain the fixture project in one sentence.");
        assert_eq!(
            stored.native_id.as_deref(),
            Some("0190f4a2-0000-7000-8000-000000000001")
        );
        assert_eq!(stored.usage_count, 2);
        assert_eq!(stored.message_count, 4);
        assert!(!stored.partial);

        let plan = resume_plan(&db, &registry, &home, &stored.id, crate::adapters::LaunchMode::Normal)
            .unwrap();
        assert_eq!(
            plan.cli_args,
            [
                "--resume".to_string(),
                "0190f4a2-0000-7000-8000-000000000001".to_string()
            ]
        );
        assert_eq!(plan.directory, project.canonicalize().unwrap());
    }

    #[test]
    fn empty_session_files_are_not_published() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("header-only.jsonl");
        fs::write(
            &path,
            r#"{"type":"session","version":3,"id":"0190f4a2-0000-7000-8000-000000000012","timestamp":"2026-11-15T00:00:00Z","cwd":"/fixture/project"}"#,
        )
        .unwrap();
        assert_eq!(
            parse(&HistorySource {
                path,
                ..file("unused")
            })
            .unwrap_err(),
            crate::history::EMPTY_SESSION
        );
    }
}
