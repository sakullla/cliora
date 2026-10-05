use std::collections::BTreeMap;

use serde_json::Value;

/// One usage record, split into the four buckets every CLI can be normalized to.
/// `input` includes cache only when the source log says so; callers record that
/// separately on the stored event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub read: u64,
    pub write: u64,
}

#[derive(Clone, Debug)]
pub struct RequestUsage {
    pub counts: TokenCounts,
    pub model: Option<String>,
    pub timestamp: Option<i64>,
}

pub fn json_u64(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    number.as_u64().or_else(|| {
        number
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value as u64)
    })
}

pub fn field(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(json_u64)
}

pub fn from_optional(
    input: Option<u64>,
    output: Option<u64>,
    read: Option<u64>,
    write: Option<u64>,
) -> Option<TokenCounts> {
    if input.is_none() && output.is_none() && read.is_none() && write.is_none() {
        return None;
    }
    Some(TokenCounts {
        input: input.unwrap_or(0),
        output: output.unwrap_or(0),
        read: read.unwrap_or(0),
        write: write.unwrap_or(0),
    })
}

pub fn active(counts: TokenCounts) -> bool {
    counts.input > 0 || counts.output > 0 || counts.read > 0 || counts.write > 0
}

/// OpenAI-style logs (Codex, Grok) store cache read/write inside `input`.
/// Clamp the breakdown so it cannot exceed that input.
pub fn clamp_cache_inside_input(mut counts: TokenCounts) -> TokenCounts {
    counts.read = counts.read.min(counts.input);
    counts.write = counts.write.min(counts.input.saturating_sub(counts.read));
    counts
}

/// OpenCode stores reasoning beside output. Both are generated tokens.
pub fn generated(output: Option<u64>, reasoning: Option<u64>) -> Option<u64> {
    match (output, reasoning) {
        (None, None) => None,
        (output, reasoning) => Some(output.unwrap_or(0).saturating_add(reasoning.unwrap_or(0))),
    }
}

/// Streaming snapshots of one request repeat the same input and grow `output`.
/// Keep the largest output. A later smaller snapshot is an earlier partial, not a new call.
pub fn keep_largest_output(events: &mut BTreeMap<String, RequestUsage>, key: String, next: RequestUsage) {
    if events
        .get(&key)
        .is_some_and(|previous| next.counts.output < previous.counts.output)
    {
        return;
    }
    events.insert(key, next);
}

/// Cumulative snapshots only contribute the increase above the high-water mark.
/// A lower input means that counter restarted, so the snapshot is a new baseline
/// rather than a reason to discard every later event.
pub fn cumulative_delta(high_water: &mut Option<TokenCounts>, total: TokenCounts) -> TokenCounts {
    let Some(high) = *high_water else {
        *high_water = Some(total);
        return total;
    };
    if total.input < high.input {
        *high_water = Some(total);
        return total;
    }
    let delta = TokenCounts {
        input: total.input.saturating_sub(high.input),
        output: total.output.saturating_sub(high.output),
        read: total.read.saturating_sub(high.read),
        write: total.write.saturating_sub(high.write),
    };
    *high_water = Some(TokenCounts {
        input: high.input.max(total.input),
        output: high.output.max(total.output),
        read: high.read.max(total.read),
        write: high.write.max(total.write),
    });
    delta
}

// Normalize legacy serialized model labels persisted in history storage.
pub(crate) fn stored_model_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(id) = value
            .get("id")
            .or_else(|| value.get("modelID"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            return id.to_owned();
        }
    }
    trimmed.to_owned()
}