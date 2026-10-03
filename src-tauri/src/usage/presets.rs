//! Query catalog DTOs, independent of provider implementations.
use super::QueryConfig;
use serde::Serialize;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetCredential {
    pub name: String,
    pub label: String,
    pub instructions: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePreset {
    pub id: String,
    pub label: String,
    pub description: String,
    pub config: QueryConfig,
    pub credentials: Vec<PresetCredential>,
}
