use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const USAGE_SCHEMA_VERSION: u32 = 1;
pub const MAX_SCRIPT_BYTES: usize = 256 * 1024;
pub const MAX_RESULT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageErrorCode {
    Network,
    Timeout,
    Cancelled,
    Authentication,
    Permission,
    RateLimit,
    Business,
    Parse,
    Script,
    ResultContract,
    ResourceLimit,
    InvalidConfiguration,
    VersionConflict,
    NotFound,
    Storage,
    Credential,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStage {
    Configuration,
    Credential,
    Launch,
    Ipc,
    Http,
    Script,
    Validation,
    Storage,
}

/// Messages from runtime adapters must be redacted before crossing IPC.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageError {
    pub code: UsageErrorCode,
    pub stage: UsageStage,
    pub message: String,
    pub retry_after_seconds: Option<u32>,
    pub metric_id: Option<String>,
}

impl UsageError {
    pub fn new(code: UsageErrorCode, stage: UsageStage, message: &str) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
            retry_after_seconds: None,
            metric_id: None,
        }
    }

    pub(crate) fn configuration(message: &str) -> Self {
        Self::new(
            UsageErrorCode::InvalidConfiguration,
            UsageStage::Configuration,
            message,
        )
    }

    pub(crate) fn storage() -> Self {
        Self::new(
            UsageErrorCode::Storage,
            UsageStage::Storage,
            "额度查询存储不可用",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSubject {
    Account,
    Plan,
    Key,
    Extra,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryIdentity {
    pub account_id: Option<String>,
    pub context_id: Option<String>,
    pub profile_id: Option<String>,
    pub subject: UsageSubject,
    pub subject_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueryProgram {
    Builtin {
        provider: String,
        template_version: u32,
    },
    #[serde(rename = "javascript")]
    JavaScript { source: String },
}

/// HTTP is permitted only on an explicitly declared self-hosted target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryTarget {
    pub origin: String,
    pub allow_private_network: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryConfig {
    pub schema_version: u32,
    pub label: String,
    pub site: String,
    pub identity: QueryIdentity,
    pub program: QueryProgram,
    pub parameters: BTreeMap<String, serde_json::Value>,
    pub targets: Vec<QueryTarget>,
    pub enabled: bool,
    /// Zero disables automatic refresh; saving never performs a query.
    pub refresh_interval_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialBinding {
    pub name: String,
    pub secret_ref: String,
    pub revision: u32,
    pub allowed_origins: Vec<String>,
}

// Intentionally no Debug: secret-bearing input must not be logged.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialUpdate {
    Keep,
    Replace { secret: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialDraft {
    pub name: String,
    pub allowed_origins: Vec<String>,
    pub value: CredentialUpdate,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageQueryDraft {
    /// Null creates a new host-generated ID; updates require the current version.
    pub id: Option<String>,
    pub expected_version: Option<u32>,
    pub config: QueryConfig,
    pub credentials: Vec<CredentialDraft>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageQuery {
    pub id: String,
    pub version: u32,
    pub generation: u32,
    pub config: QueryConfig,
    pub credentials: Vec<CredentialBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveQueryResult {
    pub query: UsageQuery,
    pub credential_cleanup_pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteQueryResult {
    pub credential_cleanup_pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UsageUnit {
    Tokens,
    Requests,
    Credits,
    Currency { code: String },
    Custom { label: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryKind {
    Fixed,
    Rolling,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageWindow {
    pub duration_seconds: Option<u32>,
    /// RFC 3339 with an explicit offset; never an ambiguous numeric timestamp.
    pub resets_at: Option<String>,
    pub recovery: RecoveryKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageMetric {
    pub id: String,
    pub label: String,
    pub subject: UsageSubject,
    pub subject_id: Option<String>,
    pub unit: UsageUnit,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
    /// Percentage of the quota used, as supplied by the source. May exceed 100.
    pub source_percent: Option<f64>,
    pub unlimited: bool,
    pub window: Option<UsageWindow>,
    pub missing_reason: Option<String>,
}

impl UsageMetric {
    /// Preserve overages. Different metrics/units/windows are never combined.
    pub fn percent(&self) -> Option<f64> {
        self.source_percent.or_else(|| {
            if self.unlimited {
                return None;
            }
            let total = self.total.filter(|v| *v > 0.0)?;
            let used = self
                .used
                .or_else(|| self.remaining.map(|remaining| total - remaining))?;
            let percent = used / total * 100.0;
            percent.is_finite().then_some(percent)
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    Success,
    Partial,
    Failed,
}

/// Provider/script payload contains no host identity or measurement timestamp.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageResult {
    pub schema_version: u32,
    pub status: UsageStatus,
    pub metrics: Vec<UsageMetric>,
    pub errors: Vec<UsageError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UsageExecution {
    Saved {
        query_id: String,
        generation: u32,
        identity: QueryIdentity,
    },
    Draft {
        execution_id: String,
        draft_revision: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub execution: UsageExecution,
    pub source: String,
    pub attempted_at: String,
    pub measured_at: Option<String>,
    pub result: UsageResult,
}

impl UsageSnapshot {
    pub fn saved(query: &UsageQuery, result: UsageResult) -> Result<Self, UsageError> {
        result.validate()?;
        let attempted_at = chrono::Utc::now().to_rfc3339();
        let measured_at = (result.status != UsageStatus::Failed).then(|| attempted_at.clone());
        Ok(Self {
            execution: UsageExecution::Saved {
                query_id: query.id.clone(),
                generation: query.generation,
                identity: query.config.identity.clone(),
            },
            source: source(&query.config.program),
            attempted_at,
            measured_at,
            result,
        })
    }

    pub fn draft(
        config: &QueryConfig,
        draft_revision: u32,
        result: UsageResult,
    ) -> Result<Self, UsageError> {
        config.validate()?;
        result.validate()?;
        let attempted_at = chrono::Utc::now().to_rfc3339();
        let measured_at = (result.status != UsageStatus::Failed).then(|| attempted_at.clone());
        Ok(Self {
            execution: UsageExecution::Draft {
                execution_id: uuid::Uuid::new_v4().to_string(),
                draft_revision,
            },
            source: source(&config.program),
            attempted_at,
            measured_at,
            result,
        })
    }
}

fn source(program: &QueryProgram) -> String {
    match program {
        QueryProgram::Builtin {
            provider,
            template_version,
        } => format!("builtin:{provider}:{template_version}"),
        QueryProgram::JavaScript { .. } => "javascript:v1".into(),
    }
}

fn nonempty(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit
}

pub(crate) fn valid_name(value: &str) -> bool {
    nonempty(value, 128)
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

impl QueryConfig {
    pub fn validate(&self) -> Result<(), UsageError> {
        let invalid = || UsageError::configuration("查询配置格式或版本无效");
        if self.schema_version != USAGE_SCHEMA_VERSION
            || !nonempty(&self.label, 256)
            || !nonempty(&self.site, 256)
            || self.targets.is_empty()
            || self.targets.len() > 16
            || (self.refresh_interval_seconds != 0 && self.refresh_interval_seconds < 60)
            || [
                &self.identity.account_id,
                &self.identity.context_id,
                &self.identity.profile_id,
                &self.identity.subject_id,
            ]
            .iter()
            .any(|v| v.as_ref().is_some_and(|v| !nonempty(v, 256)))
        {
            return Err(invalid());
        }
        match &self.program {
            QueryProgram::Builtin {
                provider,
                template_version,
            } if !valid_name(provider) || *template_version == 0 => return Err(invalid()),
            QueryProgram::JavaScript { source } if !nonempty(source, MAX_SCRIPT_BYTES) => {
                return Err(invalid())
            }
            _ => {}
        }
        let mut origins = BTreeSet::new();
        for target in &self.targets {
            let url = url::Url::parse(&target.origin).map_err(|_| invalid())?;
            let is_private = match url.host() {
                Some(url::Host::Domain(name)) => {
                    name == "localhost" || name.ends_with(".localhost")
                }
                Some(url::Host::Ipv4(ip)) => {
                    ip.is_loopback() || ip.is_private() || ip.is_link_local()
                }
                Some(url::Host::Ipv6(ip)) => {
                    ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
                }
                None => false,
            };
            if target.origin != url.origin().ascii_serialization()
                || !url.username().is_empty()
                || url.password().is_some()
                || !(url.scheme() == "https"
                    || (url.scheme() == "http" && target.allow_private_network && is_private))
                || (is_private && !target.allow_private_network)
                || !origins.insert(&target.origin)
            {
                return Err(UsageError::configuration(
                    "查询目标必须是唯一规范 origin；私网目标须显式启用",
                ));
            }
        }
        if serde_json::to_vec(&self.parameters)
            .map_err(|_| invalid())?
            .len()
            > 64 * 1024
        {
            return Err(invalid());
        }
        Ok(())
    }
}

impl UsageResult {
    pub fn validate(&self) -> Result<(), UsageError> {
        let invalid = || {
            UsageError::new(
                UsageErrorCode::ResultContract,
                UsageStage::Validation,
                "额度结果不符合版本化契约",
            )
        };
        if self.schema_version != USAGE_SCHEMA_VERSION {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        let mut available = 0;
        let mut missing = false;
        for metric in &self.metrics {
            let numbers = [
                metric.used,
                metric.remaining,
                metric.total,
                metric.source_percent,
            ];
            let has_value = metric.unlimited || numbers.iter().any(Option::is_some);
            if !valid_name(&metric.id)
                || !ids.insert(&metric.id)
                || !nonempty(&metric.label, 256)
                || numbers.iter().flatten().any(|v| !v.is_finite())
                || metric.total.is_some_and(|v| v < 0.0)
                || metric.used.is_some_and(|v| v < 0.0)
                || metric.source_percent.is_some_and(|v| v < 0.0)
                || metric
                    .subject_id
                    .as_ref()
                    .is_some_and(|v| !nonempty(v, 256))
                || (metric.unlimited && (metric.total.is_some() || metric.source_percent.is_some()))
                || (!has_value && metric.missing_reason.is_none())
                || metric
                    .missing_reason
                    .as_ref()
                    .is_some_and(|v| !nonempty(v, 2048))
            {
                return Err(invalid());
            }
            match &metric.unit {
                UsageUnit::Currency { code }
                    if code.len() != 3 || !code.bytes().all(|c| c.is_ascii_uppercase()) =>
                {
                    return Err(invalid())
                }
                UsageUnit::Custom { label } if !nonempty(label, 64) => return Err(invalid()),
                _ => {}
            }
            if let Some(window) = &metric.window {
                if window.duration_seconds == Some(0) {
                    return Err(invalid());
                }
                if let Some(time) = &window.resets_at {
                    if chrono::DateTime::parse_from_rfc3339(time).is_err() {
                        return Err(invalid());
                    }
                }
            }
            available += usize::from(has_value);
            missing |= metric.missing_reason.is_some();
        }
        for error in &self.errors {
            if !nonempty(&error.message, 2048)
                || error.metric_id.as_ref().is_some_and(|id| !valid_name(id))
            {
                return Err(invalid());
            }
        }
        match self.status {
            UsageStatus::Success if available == 0 || missing || !self.errors.is_empty() => {
                return Err(invalid())
            }
            UsageStatus::Partial if available == 0 || (!missing && self.errors.is_empty()) => {
                return Err(invalid())
            }
            UsageStatus::Failed if self.errors.is_empty() || !self.metrics.is_empty() => {
                return Err(invalid())
            }
            _ => {}
        }
        if serde_json::to_vec(self).map_err(|_| invalid())?.len() > MAX_RESULT_BYTES {
            return Err(invalid());
        }
        Ok(())
    }
}
