//! The one reader of SKILL.md metadata (Agent Skills specification,
//! https://agentskills.io/specification).
//!
//! Reading is lenient: a skill is identified by its directory, so nothing
//! here rejects or hides a skill. Specification problems come back as issue
//! codes for display. The text is never rewritten by this module.

use serde::Serialize;
use serde_yaml::{Mapping, Value};

const NAME_MAX: usize = 64;
const DESCRIPTION_MAX: usize = 1024;
const COMPATIBILITY_MAX: usize = 500;
const LINES_MAX: usize = 500;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestField {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIssue {
    pub code: &'static str,
    pub limit: Option<usize>,
    pub actual: Option<usize>,
}

impl SkillIssue {
    fn plain(code: &'static str) -> Self {
        Self { code, limit: None, actual: None }
    }
    fn over(code: &'static str, limit: usize, actual: usize) -> Self {
        Self { code, limit: Some(limit), actual: Some(actual) }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub name: Option<String>,
    pub description: String,
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub metadata: Vec<ManifestField>,
    pub allowed_tools: Vec<String>,
    /// Top-level fields outside the specification, shown as written.
    pub extra: Vec<ManifestField>,
    /// Zero-based line where the Markdown body starts. Lines are split on
    /// `\n`, with a trailing `\r` belonging to its line.
    pub body_line: usize,
    pub issues: Vec<SkillIssue>,
}

impl SkillManifest {
    pub fn issue_codes(&self) -> Vec<String> {
        self.issues.iter().map(|issue| issue.code.to_owned()).collect()
    }
}

/// Specification name rule: 1-64 of `a-z`, `0-9`, `-`; no leading,
/// trailing or doubled hyphen.
pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= NAME_MAX
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Frontmatter block and the line after its closing delimiter, or `None`
/// when the file does not open with `---`. `Some((None, _))` is an opening
/// delimiter without a closing one.
fn split_frontmatter(lines: &[&str]) -> Option<(Option<String>, usize)> {
    let first = lines.first()?.trim_start_matches('\u{feff}');
    if first.trim_end() != "---" {
        return None;
    }
    for (index, line) in lines.iter().enumerate().skip(1) {
        if line.trim_end() == "---" {
            let block = lines[1..index]
                .iter()
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .collect::<Vec<_>>()
                .join("\n");
            return Some((Some(block), index + 1));
        }
    }
    Some((None, 0))
}

/// Many skills written for other clients carry values such as
/// `description: Use when: ...`, which YAML rejects. Quote those top-level
/// plain scalars once and parse again.
fn quote_colon_values(block: &str) -> Option<String> {
    let mut changed = false;
    let lines = block
        .split('\n')
        .map(|line| {
            let Some((key, value)) = line.split_once(':') else { return line.to_owned() };
            let plain_key = !key.is_empty()
                && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
            let value = value.trim();
            let quotable = plain_key
                && !value.is_empty()
                && !value.starts_with(['"', '\'', '|', '>', '[', '{', '&', '*', '!', '#'])
                && (value.contains(": ") || value.ends_with(':'));
            if !quotable {
                return line.to_owned();
            }
            changed = true;
            format!("{key}: '{}'", value.replace('\'', "''"))
        })
        .collect::<Vec<_>>();
    changed.then(|| lines.join("\n"))
}

fn parse_block(block: &str) -> Option<Mapping> {
    let parse = |text: &str| match serde_yaml::from_str::<Value>(text) {
        Ok(Value::Mapping(map)) => Some(map),
        // An empty block is an empty mapping, not a YAML error.
        Ok(Value::Null) => Some(Mapping::new()),
        _ => None,
    };
    parse(block).or_else(|| quote_colon_values(block).and_then(|fixed| parse(&fixed)))
}

/// Scalars as written; collections as compact YAML.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        Value::Tagged(tagged) => text_of(&tagged.value),
        other => serde_yaml::to_string(other).ok().map(|text| text.trim_end().to_owned()),
    }
}

fn key_text(key: &Value) -> String {
    text_of(key).unwrap_or_else(|| "null".to_owned())
}

/// Reads SKILL.md `text` found in directory `directory_name`.
pub fn analyze(text: &str, directory_name: &str) -> SkillManifest {
    let lines: Vec<&str> = text.split('\n').collect();
    let line_count = text.lines().count();
    let mut manifest = SkillManifest::default();
    let too_long = (line_count > LINES_MAX).then(|| SkillIssue::over("too_many_lines", LINES_MAX, line_count));

    let Some((block, body_line)) = split_frontmatter(&lines) else {
        manifest.issues.push(SkillIssue::plain("frontmatter_missing"));
        manifest.issues.extend(too_long);
        return manifest;
    };
    let Some(map) = block.as_deref().and_then(parse_block) else {
        manifest.issues.push(SkillIssue::plain("yaml_invalid"));
        manifest.issues.extend(too_long);
        return manifest;
    };
    manifest.body_line = body_line;

    let mut issues = Vec::new();
    let mut compatibility_present = false;
    let mut description_present = false;
    for (key, value) in &map {
        let key = key_text(key);
        match key.as_str() {
            "name" => manifest.name = text_of(value).map(|name| name.trim().to_owned()).filter(|name| !name.is_empty()),
            "description" => {
                description_present = true;
                manifest.description = text_of(value).map(|text| text.trim().to_owned()).unwrap_or_default();
            }
            "license" => manifest.license = text_of(value).map(|text| text.trim().to_owned()).filter(|text| !text.is_empty()),
            "compatibility" => {
                compatibility_present = true;
                manifest.compatibility = text_of(value).map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
            }
            "metadata" => match value {
                Value::Mapping(entries) => {
                    let mut valid = true;
                    for (entry_key, entry_value) in entries {
                        valid &= matches!(entry_key, Value::String(_)) && matches!(entry_value, Value::String(_));
                        manifest.metadata.push(ManifestField {
                            key: key_text(entry_key),
                            value: text_of(entry_value).unwrap_or_default(),
                        });
                    }
                    if !valid {
                        issues.push(SkillIssue::plain("metadata_invalid"));
                    }
                }
                Value::Null => {}
                other => {
                    manifest.metadata.push(ManifestField { key: String::new(), value: text_of(other).unwrap_or_default() });
                    issues.push(SkillIssue::plain("metadata_invalid"));
                }
            },
            "allowed-tools" => {
                manifest.allowed_tools = match value {
                    Value::Sequence(items) => items.iter().filter_map(text_of).collect(),
                    other => text_of(other).map(|text| text.split_whitespace().map(str::to_owned).collect()).unwrap_or_default(),
                };
            }
            _ => manifest.extra.push(ManifestField { key, value: text_of(value).unwrap_or_default() }),
        }
    }

    match manifest.name.as_deref() {
        None => issues.insert(0, SkillIssue::plain("name_missing")),
        Some(name) => {
            let mut at = 0;
            if !valid_name(name) {
                issues.insert(at, SkillIssue::plain("name_invalid"));
                at += 1;
            }
            if name != directory_name {
                issues.insert(at, SkillIssue::plain("name_mismatch"));
            }
        }
    }
    let description_chars = manifest.description.chars().count();
    if !description_present || description_chars == 0 {
        issues.push(SkillIssue::plain("description_missing"));
    } else if description_chars > DESCRIPTION_MAX {
        issues.push(SkillIssue::over("description_too_long", DESCRIPTION_MAX, description_chars));
    }
    if compatibility_present {
        match manifest.compatibility.as_deref().map(|text| text.chars().count()) {
            None => issues.push(SkillIssue::plain("compatibility_empty")),
            Some(count) if count > COMPATIBILITY_MAX => {
                issues.push(SkillIssue::over("compatibility_too_long", COMPATIBILITY_MAX, count));
            }
            Some(_) => {}
        }
    }
    issues.extend(too_long);
    manifest.issues = issues;
    manifest
}

#[cfg(test)]
#[path = "../../../tests/resources/skill_manifest.rs"]
mod tests;
