//! Usage dashboard aggregation. Every usage record is normalized into four disjoint
//! buckets (fresh input, cache read, cache write, output) so totals can be added
//! across CLIs whose logs disagree about whether input already includes cache.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use chrono::{Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde::Serialize;

use super::{now_ms, prices, published_rate, scans, HistoryFilter, HistoryPrice, ScanStatus};
use crate::database::Database;

/// Requests above this prompt size are billed at long-context public rates.
const LONG_CONTEXT_PROMPT: u64 = 272_000;
const TOP_SESSIONS: usize = 10;
const MAX_GROUPS: usize = 24;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    /// Known native model calls after de-duplication. Unknown aggregates add no calls.
    pub requests: u64,
    pub usage_records: u64,
    pub unknown_request_records: u64,
    pub sessions: u64,
    /// Prompt tokens that were neither read from nor written to cache.
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub total: u64,
    /// `None` when no call in the set has a known price.
    pub cost: Option<f64>,
    /// Tokens whose model has no price, so `cost` leaves them out.
    pub unpriced_tokens: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub start: i64,
    pub end: i64,
    pub totals: UsageTotals,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageGroup {
    pub key: String,
    pub label: String,
    pub tool_id: Option<String>,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub priced: bool,
    pub totals: UsageTotals,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub id: String,
    pub tool_id: String,
    pub title: String,
    pub model: Option<String>,
    pub updated_at: Option<i64>,
    pub totals: UsageTotals,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousPeriod {
    pub from: i64,
    pub to: i64,
    pub totals: UsageTotals,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub generated_at: i64,
    /// Effective chart range; open-ended filters are closed with the data or now.
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub bucket: &'static str,
    pub currency: String,
    pub totals: UsageTotals,
    /// Same elapsed length immediately before `from`, e.g. yesterday up to this time.
    pub previous: Option<PreviousPeriod>,
    pub timeline: Vec<UsageBucket>,
    pub by_model: Vec<UsageGroup>,
    pub by_tool: Vec<UsageGroup>,
    pub by_project: Vec<UsageGroup>,
    pub top_sessions: Vec<SessionUsage>,
    pub models: Vec<String>,
    /// Usage records without a timestamp, excluded from the selected date range.
    pub untimed_requests: u64,
    /// Duplicate usage records across sources, counted once (not native call counts).
    pub duplicate_requests: u64,
    pub partial_sessions: u64,
    pub stale_sessions: u64,
    pub mixed_currency: bool,
    pub latest_event_at: Option<i64>,
    pub price_sources: Vec<String>,
    pub scans: Vec<ScanStatus>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Bucket {
    Hour,
    Day,
    Month,
}

impl Bucket {
    fn name(self) -> &'static str {
        match self {
            Bucket::Hour => "hour",
            Bucket::Day => "day",
            Bucket::Month => "month",
        }
    }
    fn for_span(span: i64) -> Self {
        if span <= 2 * 86_400_000 + 3_600_000 {
            Bucket::Hour
        } else if span <= 92 * 86_400_000 {
            Bucket::Day
        } else {
            Bucket::Month
        }
    }
}

fn local_ms(naive: NaiveDateTime) -> i64 {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(time) | LocalResult::Ambiguous(time, _) => time.timestamp_millis(),
        // A wall-clock time skipped by a DST change starts one hour later.
        LocalResult::None => local_ms(naive + Duration::hours(1)),
    }
}

fn local_naive(ms: i64) -> Option<NaiveDateTime> {
    Local.timestamp_millis_opt(ms).earliest().map(|time| time.naive_local())
}

fn month_start(year: i32, month: u32) -> Option<NaiveDateTime> {
    NaiveDate::from_ymd_opt(year, month, 1)?.and_hms_opt(0, 0, 0)
}

fn floor(ms: i64, bucket: Bucket) -> i64 {
    let Some(time) = local_naive(ms) else { return ms };
    let floored = match bucket {
        Bucket::Hour => time.date().and_hms_opt(time.hour(), 0, 0),
        Bucket::Day => time.date().and_hms_opt(0, 0, 0),
        Bucket::Month => month_start(time.year(), time.month()),
    };
    floored.map(local_ms).unwrap_or(ms)
}

fn next(start: i64, bucket: Bucket) -> i64 {
    let fallback = start + 3_600_000;
    let Some(time) = local_naive(start) else { return fallback };
    let following = match bucket {
        Bucket::Hour => return fallback,
        Bucket::Day => time.date().succ_opt().and_then(|date| date.and_hms_opt(0, 0, 0)),
        Bucket::Month => if time.month() == 12 { month_start(time.year() + 1, 1) } else { month_start(time.year(), time.month() + 1) },
    };
    following.map(local_ms).filter(|value| *value > start).unwrap_or(fallback)
}

fn bucket_starts(from: i64, to: i64) -> (Bucket, Vec<i64>) {
    let mut bucket = Bucket::for_span(to - from);
    loop {
        let mut starts = Vec::new();
        let mut cursor = floor(from, bucket);
        while cursor < to && starts.len() <= 400 {
            starts.push(cursor);
            cursor = next(cursor, bucket);
        }
        if starts.len() <= 400 || bucket == Bucket::Month {
            return (bucket, starts);
        }
        bucket = if bucket == Bucket::Hour { Bucket::Day } else { Bucket::Month };
    }
}

struct PriceBook {
    custom: HashMap<(String, String), HistoryPrice>,
    currency: String,
    /// Set when a call had a price, but in another currency than `currency`.
    mixed: std::cell::Cell<bool>,
}

impl PriceBook {
    fn load(db: &Database) -> Result<Self, String> {
        let custom: HashMap<_, _> = prices(db)?
            .into_iter()
            .map(|price| ((price.tool_id.clone(), price.model.clone()), price))
            .collect();
        let currencies: HashSet<&str> = custom.values().map(|price| price.currency.as_str()).collect();
        // Costs are only summed in one currency. A single custom currency wins; otherwise
        // USD, which is also the currency of the built-in public rates.
        let currency = match currencies.iter().next() {
            Some(only) if currencies.len() == 1 => (*only).to_owned(),
            _ => "USD".to_owned(),
        };
        Ok(Self { custom, currency, mixed: std::cell::Cell::new(false) })
    }

    /// Resolves the rate and its provenance, or `None` when unpriced.
    fn resolve(&self, tool: &str, model: &str) -> Option<PricedModel> {
        let (price, published) = self
            .custom
            .get(&(tool.to_owned(), model.to_owned()))
            .cloned()
            .map(|price| (price, false))
            .or_else(|| published_rate(tool, model).map(|price| (price, true)))?;
        if price.currency != self.currency {
            self.mixed.set(true);
            return None;
        }
        let label = if price.updated_at == 0 {
            format!("{} / {} · {}", price.tool_id, price.model, price.source)
        } else {
            let updated = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(price.updated_at)
                .map(|time| time.with_timezone(&Local).format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            format!("{} / {} · {} · {updated}", price.tool_id, price.model, price.source)
        };
        Some(PricedModel { price, published, label })
    }
}

// A report resolves each tool/model rate and formats its provenance once.
struct PricedModel {
    price: HistoryPrice,
    published: bool,
    label: String,
}
impl PricedModel {
    fn cost(&self, call: &Call) -> f64 {
        let (mut input, mut read, mut write, mut output) = (
            self.price.input_per_million,
            self.price.cache_read_per_million,
            self.price.cache_write_per_million,
            self.price.output_per_million,
        );
        if self.published && call.request_count == Some(1) && call.input + call.cache_read + call.cache_write > LONG_CONTEXT_PROMPT {
            input *= 2.0;
            read *= 2.0;
            write *= 2.0;
            output *= 1.5;
        }
        (call.input as f64 * input
            + call.cache_read as f64 * read
            + call.cache_write as f64 * write
            + call.output as f64 * output)
            / 1_000_000.0
    }
}

/// One de-duplicated usage record with disjoint token buckets.
#[derive(Clone, Debug)]
struct Call {
    session: usize,
    request_count: Option<u64>,
    /// Index into `Loaded::tools`.
    tool: usize,
    model: Option<String>,
    timestamp: Option<i64>,
    input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    cost: Option<f64>,
}

impl Call {
    fn total(&self) -> u64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
}

struct SessionRow {
    id: String,
    project_id: Option<String>,
    cwd: Option<String>,
    partial: bool,
    stale: bool,
}

#[derive(Default)]
struct Tally {
    totals: UsageTotals,
    sessions: HashSet<usize>,
    priced: bool,
}

impl Tally {
    fn add(&mut self, call: &Call) {
        let totals = &mut self.totals;
        totals.requests += call.request_count.unwrap_or(0);
        totals.usage_records += 1;
        totals.unknown_request_records += u64::from(call.request_count.is_none());
        totals.input += call.input;
        totals.cache_read += call.cache_read;
        totals.cache_write += call.cache_write;
        totals.output += call.output;
        totals.total += call.total();
        match call.cost {
            Some(cost) => {
                *totals.cost.get_or_insert(0.0) += cost;
                self.priced = true;
            }
            None => totals.unpriced_tokens += call.total(),
        }
        self.sessions.insert(call.session);
    }
    fn finish(mut self) -> UsageTotals {
        self.totals.sessions = self.sessions.len() as u64;
        self.totals
    }
}

/// Builds the shared WHERE clause. Time bounds are half-open: `[from, to)`.
fn conditions(filter: &HistoryFilter, from: Option<i64>, to: Option<i64>, untimed: bool, with_model: bool) -> (String, Vec<SqlValue>) {
    let mut clauses = vec!["1 = 1".to_owned()];
    let mut values = Vec::new();
    let mut bind = |clause: &str, value: SqlValue, clauses: &mut Vec<String>| {
        values.push(value);
        clauses.push(clause.replace('?', &format!("?{}", values.len())));
    };
    if let Some(tool) = filter.tool_id.as_deref().filter(|tool| !tool.is_empty()) {
        bind("u.tool = ?", SqlValue::Text(tool.into()), &mut clauses);
    }
    if let Some(project) = filter.project_id.as_deref().filter(|project| !project.is_empty()) {
        if project == "__unknown__" {
            clauses.push("s.project_id IS NULL".into());
        } else {
            bind("s.project_id = ?", SqlValue::Text(project.into()), &mut clauses);
        }
    }
    if filter.favorite_only {
        clauses.push("s.favorite = 1".into());
    }
    if let Some(search) = super::search_pattern(filter.search.as_deref()) {
        bind("(s.title LIKE ? ESCAPE '\\' OR s.messages_json LIKE ? ESCAPE '\\')", SqlValue::Text(search), &mut clauses);
    }
    if with_model {
        if let Some(model) = filter.model.as_deref().filter(|model| !model.is_empty()) {
            if model == "__unknown__" {
                clauses.push("u.model IS NULL".into());
            } else {
                bind("u.model = ?", SqlValue::Text(model.into()), &mut clauses);
            }
        }
    }
    if let Some(from) = from {
        bind("u.timestamp >= ?", SqlValue::Integer(from), &mut clauses);
    }
    if let Some(to) = to {
        bind("u.timestamp < ?", SqlValue::Integer(to), &mut clauses);
    }
    if untimed {
        clauses.push("u.timestamp IS NULL".into());
    }
    let tools: Vec<&String> = filter.tools.iter().flatten().filter(|tool| !tool.is_empty()).collect();
    if !tools.is_empty() {
        let mut placeholders = Vec::new();
        for tool in tools {
            values.push(SqlValue::Text(tool.clone()));
            placeholders.push(format!("?{}", values.len()));
        }
        clauses.push(format!("u.tool IN ({})", placeholders.join(",")));
    }
    (clauses.join(" AND "), values)
}

/// Session filters require the join; unfiltered catalog scans can use the usage index.
fn usage_source(filter: &HistoryFilter) -> &'static str {
    if filter.favorite_only || super::search_pattern(filter.search.as_deref()).is_some() || filter.project_id.as_deref().is_some_and(|project| !project.is_empty()) {
        "history_usage u JOIN history_sessions s ON s.id = u.session_id"
    } else {
        "history_usage u"
    }
}

struct Loaded {
    tools: Vec<String>,
    calls: Vec<Call>,
    sessions: Vec<SessionRow>,
    duplicates: u64,
    price_sources: Vec<String>,
}

fn load_calls(conn: &Connection, filter: &HistoryFilter, from: Option<i64>, to: Option<i64>, book: &PriceBook, session_id: Option<&str>) -> Result<Loaded, String> {
    let (mut clause, mut values) = conditions(filter, from, to, false, true);
    if let Some(id) = session_id {
        values.push(SqlValue::Text(id.into()));
        clause.push_str(&format!(" AND u.session_id = ?{}", values.len()));
    }
    let sql = format!(
        "SELECT u.session_id, u.event_id, u.tool, u.model, u.timestamp, u.input, u.output, u.cache_read, u.cache_write,
                u.input_includes_cache, u.request_count
         FROM {}
         WHERE {clause}
         ORDER BY u.timestamp", usage_source(filter)
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(values))
        .map_err(|error| error.to_string())?;
    let mut loaded = Loaded { tools: Vec::new(), calls: Vec::new(), sessions: Vec::new(), duplicates: 0, price_sources: Vec::new() };
    let mut session_index = HashMap::<String, usize>::new();
    // Session bodies can occupy thousands of SQLite pages. Load metadata once
    // per session instead of joining that large table for every model call.
    let mut session_metadata = conn.prepare(
        "SELECT id, project_id, cwd, partial, stale FROM history_sessions INDEXED BY idx_history_list
         WHERE (?1 IS NULL OR id = ?1)"
    ).map_err(|error| error.to_string())?;
    let mut known_sessions = session_metadata.query_map([session_id], |row| {
        let id: String = row.get(0)?;
        Ok((id.clone(), SessionRow {
            id, project_id: row.get(1)?, cwd: row.get(2)?,
            partial: row.get::<_, i64>(3)? != 0, stale: row.get::<_, i64>(4)? != 0,
        }))
    }).map_err(|error| error.to_string())?
        .collect::<Result<HashMap<_, _>, _>>().map_err(|error| error.to_string())?;
    // Hashed (tool, event id) keys keep de-duplication cheap over hundreds of thousands of calls.
    let mut seen = HashSet::<u64>::new();
    let mut sources = std::collections::BTreeSet::new();
    let mut rates: HashMap<usize, HashMap<String, Option<PricedModel>>> = HashMap::new();
    let count = |value: Option<i64>| value.unwrap_or(0).max(0) as u64;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let session_id: String = row.get(0).map_err(|error| error.to_string())?;
        let event_id: String = row.get(1).map_err(|error| error.to_string())?;
        let tool_name: String = row.get(2).map_err(|error| error.to_string())?;
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (tool_name.as_str(), event_id.as_str()).hash(&mut hasher);
        if !seen.insert(hasher.finish()) {
            loaded.duplicates += 1;
            continue;
        }
        let tool = match loaded.tools.iter().position(|known| *known == tool_name) {
            Some(index) => index,
            None => {
                loaded.tools.push(tool_name);
                loaded.tools.len() - 1
            }
        };
        let session = match session_index.get(&session_id) {
            Some(index) => *index,
            None => {
                loaded.sessions.push(known_sessions.remove(&session_id).ok_or("用量所属会话不存在")?);
                session_index.insert(session_id, loaded.sessions.len() - 1);
                loaded.sessions.len() - 1
            }
        };
        let model: Option<String> = row.get(3).map_err(|error| error.to_string())?;
        let input = count(row.get(5).map_err(|error| error.to_string())?);
        let output = count(row.get(6).map_err(|error| error.to_string())?);
        let mut cache_read = count(row.get(7).map_err(|error| error.to_string())?);
        let mut cache_write = count(row.get(8).map_err(|error| error.to_string())?);
        let includes_cache = row.get::<_, i64>(9).map_err(|error| error.to_string())? != 0;
        // OpenAI-style logs fold cache into input; others report it beside input.
        let fresh = if includes_cache {
            cache_read = cache_read.min(input);
            cache_write = cache_write.min(input - cache_read);
            input - cache_read - cache_write
        } else {
            input
        };
        let mut call = Call {
            request_count: row.get::<_, Option<i64>>(10).map_err(|error| error.to_string())?.map(|value| value.max(0) as u64),
            session,
            tool,
            model,
            timestamp: row.get(4).map_err(|error| error.to_string())?,
            input: fresh,
            cache_read,
            cache_write,
            output,
            cost: None,
        };
        if let Some(model) = call.model.as_ref() {
            let prices = rates.entry(call.tool).or_default();
            if !prices.contains_key(model) {
                let price = book.resolve(&loaded.tools[call.tool], model);
                if let Some(price) = &price { sources.insert(price.label.clone()); }
                prices.insert(model.clone(), price);
            }
            call.cost = prices.get(model).and_then(Option::as_ref).map(|price| price.cost(&call));
        }
        loaded.calls.push(call);
    }
    loaded.price_sources = sources.into_iter().collect();
    Ok(loaded)
}

fn ranked(groups: Vec<(UsageGroup, Tally)>, limit: usize) -> Vec<UsageGroup> {
    let mut groups: Vec<UsageGroup> = groups
        .into_iter()
        .map(|(mut group, tally)| {
            group.priced = tally.priced;
            group.totals = tally.finish();
            group
        })
        .collect();
    groups.sort_by(|left, right| {
        right.totals.total.cmp(&left.totals.total).then_with(|| left.key.cmp(&right.key))
    });
    groups.truncate(limit);
    groups
}

fn group(key: String, label: String) -> UsageGroup {
    UsageGroup { key, label, tool_id: None, model: None, project_id: None, priced: false, totals: UsageTotals::default() }
}

fn directory_label(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .to_owned()
}

pub fn usage_report(db: &Database, filter: &HistoryFilter) -> Result<UsageReport, String> {
    let book = PriceBook::load(db)?;
    let scans: Vec<ScanStatus> = scans(db)?;
    let now = now_ms();
    db.with_read_connection(|conn| {
        let loaded = load_calls(conn, filter, filter.from_ms, filter.to_ms, &book, None)?;
        let dated = filter.from_ms.is_some() || filter.to_ms.is_some();

        let mut totals = Tally::default();
        for call in &loaded.calls {
            totals.add(call);
        }

        let first_time = loaded.calls.iter().filter_map(|call| call.timestamp).min();
        let last_time = loaded.calls.iter().filter_map(|call| call.timestamp).max();
        let from = filter.from_ms.or(first_time);
        let to = filter.to_ms.or_else(|| last_time.map(|last| last.max(now) + 1));
        let (bucket, timeline) = match (from, to) {
            (Some(from), Some(to)) if to > from => {
                let (bucket, starts) = bucket_starts(from, to);
                let mut tallies: Vec<Tally> = starts.iter().map(|_| Tally::default()).collect();
                for call in &loaded.calls {
                    let Some(time) = call.timestamp else { continue };
                    let slot = starts.partition_point(|start| *start <= time);
                    if slot > 0 {
                        tallies[slot - 1].add(call);
                    }
                }
                let timeline = starts
                    .iter()
                    .zip(tallies)
                    .map(|(start, tally)| UsageBucket { start: *start, end: next(*start, bucket).min(to.max(*start + 1)), totals: tally.finish() })
                    .collect();
                (bucket, timeline)
            }
            _ => (Bucket::Day, Vec::new()),
        };

        let project_names: HashMap<String, String> = {
            let mut statement = conn.prepare("SELECT id, name FROM projects").map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|error| error.to_string())?
        };
        let session_projects: Vec<(String, String, Option<String>)> = loaded
            .sessions
            .iter()
            .map(|session| match (&session.project_id, &session.cwd) {
                (Some(id), _) => (format!("project:{id}"), project_names.get(id).cloned().unwrap_or_else(|| id.clone()), Some(id.clone())),
                (None, Some(cwd)) => (format!("dir:{}", cwd.to_ascii_lowercase()), directory_label(cwd), None),
                (None, None) => ("unknown".to_owned(), "未归类".to_owned(), None),
            })
            .collect();
        let mut models: HashMap<(usize, Option<&str>), Tally> = HashMap::new();
        let mut tools: HashMap<usize, Tally> = HashMap::new();
        let mut projects_by_key: HashMap<&str, (usize, Tally)> = HashMap::new();
        let mut per_session: HashMap<usize, Tally> = HashMap::new();
        for call in &loaded.calls {
            models.entry((call.tool, call.model.as_deref())).or_default().add(call);
            tools.entry(call.tool).or_default().add(call);
            projects_by_key
                .entry(session_projects[call.session].0.as_str())
                .or_insert_with(|| (call.session, Tally::default()))
                .1
                .add(call);
            per_session.entry(call.session).or_default().add(call);
        }
        let models = models
            .into_iter()
            .map(|((tool, model), tally)| {
                let tool = &loaded.tools[tool];
                let mut value = group(format!("{tool}\u{1f}{}", model.unwrap_or("")), model.unwrap_or("模型未知").to_owned());
                value.tool_id = Some(tool.clone());
                value.model = model.map(str::to_owned);
                (value, tally)
            })
            .collect();
        let tools = tools
            .into_iter()
            .map(|(tool, tally)| {
                let tool = &loaded.tools[tool];
                let mut value = group(tool.clone(), tool.clone());
                value.tool_id = Some(tool.clone());
                (value, tally)
            })
            .collect();
        let projects_by_key = projects_by_key
            .into_values()
            .map(|(session, tally)| {
                let (key, label, project_id) = session_projects[session].clone();
                let mut value = group(key, label);
                value.project_id = project_id;
                (value, tally)
            })
            .collect();

        let mut ranked_sessions: Vec<(usize, UsageTotals)> = per_session
            .into_iter()
            .map(|(index, tally)| (index, tally.finish()))
            .collect();
        ranked_sessions.sort_by(|left, right| right.1.total.cmp(&left.1.total).then_with(|| left.0.cmp(&right.0)));
        ranked_sessions.truncate(TOP_SESSIONS);
        let mut top_sessions = Vec::new();
        {
            let mut statement = conn
                .prepare("SELECT tool, title, model, updated_at FROM history_sessions WHERE id = ?1")
                .map_err(|error| error.to_string())?;
            for (index, totals) in ranked_sessions {
                let id = loaded.sessions[index].id.clone();
                let (tool_id, title, model, updated_at): (String, String, Option<String>, Option<i64>) = statement
                    .query_row([&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                    .map_err(|error| error.to_string())?;
                top_sessions.push(SessionUsage { id, tool_id, title, model, updated_at, totals });
            }
        }

        let previous = filter.from_ms.and_then(|from| {
            let end = filter.to_ms.unwrap_or(now);
            let length = end - from;
            let elapsed = (end.min(now) - from).clamp(0, length);
            (length > 0 && elapsed > 0).then_some((from - length, from - length + elapsed))
        });
        let previous = match previous {
            Some((start, end)) => {
                let earlier = load_calls(conn, filter, Some(start), Some(end), &book, None)?;
                let mut tally = Tally::default();
                for call in &earlier.calls {
                    tally.add(call);
                }
                Some(PreviousPeriod { from: start, to: end, totals: tally.finish() })
            }
            None => None,
        };

        let untimed_requests = if dated {
            let (clause, values) = conditions(filter, None, None, true, true);
            conn.query_row(
                &format!("SELECT COUNT(*) FROM (SELECT DISTINCT u.tool, u.event_id FROM {} WHERE {clause})", usage_source(filter)),
                rusqlite::params_from_iter(values),
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as u64
        } else {
            0
        };
        let catalog_filter = HistoryFilter { model: None, ..filter.clone() };
        let (clause, values) = conditions(&catalog_filter, filter.from_ms, filter.to_ms, false, false);
        let mut statement = conn
            .prepare(&format!(
                "SELECT DISTINCT u.model FROM {} WHERE {clause} AND u.model IS NOT NULL ORDER BY u.model",
                usage_source(filter)
            ))
            .map_err(|error| error.to_string())?;
        let models_catalog = statement
            .query_map(rusqlite::params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let latest_event_at: Option<i64> = conn
            .query_row("SELECT MAX(timestamp) FROM history_usage", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;

        let touched: HashSet<usize> = loaded.calls.iter().map(|call| call.session).collect();
        Ok(UsageReport {
            generated_at: now,
            from,
            to,
            bucket: bucket.name(),
            currency: book.currency.clone(),
            totals: totals.finish(),
            previous,
            timeline,
            by_model: ranked(models, usize::MAX),
            by_tool: ranked(tools, usize::MAX),
            by_project: ranked(projects_by_key, MAX_GROUPS),
            top_sessions,
            models: models_catalog,
            untimed_requests,
            duplicate_requests: loaded.duplicates,
            partial_sessions: touched.iter().filter(|index| loaded.sessions[**index].partial).count() as u64,
            stale_sessions: touched.iter().filter(|index| loaded.sessions[**index].stale).count() as u64,
            mixed_currency: book.mixed.get(),
            latest_event_at,
            price_sources: loaded.price_sources,
            scans,
        })
    })
}

/// Details and dashboards use the same stored normalization and event de-duplication.
pub fn session_totals(db: &Database, id: &str) -> Result<UsageTotals, String> {
    let book = PriceBook::load(db)?;
    db.with_read_connection(|conn| {
        let loaded = load_calls(conn, &HistoryFilter::default(), None, None, &book, Some(id))?;
        let mut tally = Tally::default();
        for call in &loaded.calls { tally.add(call); }
        Ok(tally.finish())
    })
}
