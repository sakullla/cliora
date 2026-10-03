//! Bundled supplier adapters; the controlled VM/HTTP broker remains in usage.
use crate::usage::runtime::HelperInput;
use crate::usage::*;
use serde_json::Value;
mod deepseek;
mod example;
mod glm;
mod kimi;
mod minimax;
mod newapi;
mod regional;
mod site;
mod sub2api;
pub const BUILTIN_TEMPLATE_VERSION: u32 = 1;

pub(super) fn model_directory_adapters(
) -> [&'static dyn super::model_directory::ModelDirectoryAdapter; 2] {
    [&deepseek::MODEL_DIRECTORY, glm::model_directory_adapter()]
}
pub struct CredentialScope {
    pub name: String,
    pub allowed_origins: Vec<String>,
}
pub trait UsageProvider: Sync {
    fn id(&self) -> &'static str;
    fn script(&self, config: &QueryConfig) -> Result<String, UsageError>;
    fn validate_credentials(
        &self,
        config: &QueryConfig,
        credentials: &[CredentialScope],
    ) -> Result<(), UsageError>;
    fn presets(&self) -> Vec<UsagePreset>;
    /// Recognition belongs to the supplier; shared services never infer from labels.
    fn profile_preset(&self, _connection: &crate::native::profile::Connection) -> Option<UsagePreset> {
        None
    }
}
pub struct ProviderRegistry {
    entries: Vec<&'static dyn UsageProvider>,
}
impl ProviderRegistry {
    pub fn builtins() -> Self {
        Self {
            entries: vec![
                &glm::ADAPTER,
                &kimi::ADAPTER,
                &minimax::ADAPTER,
                &sub2api::ADAPTER,
                &newapi::ADAPTER,
            ],
        }
    }
    pub fn with_providers(entries: Vec<&'static dyn UsageProvider>) -> Result<Self, UsageError> {
        let mut ids = std::collections::HashSet::new();
        for e in &entries {
            if e.id().is_empty() || !ids.insert(e.id()) {
                return Err(UsageError::configuration("供应商 ID 为空或重复"));
            }
        }
        Ok(Self { entries })
    }
    pub fn get(&self, id: &str) -> Result<&'static dyn UsageProvider, UsageError> {
        self.entries
            .iter()
            .copied()
            .find(|a| a.id() == id)
            .ok_or_else(|| UsageError::configuration("内置供应商不可用"))
    }
    pub fn presets(&self) -> Vec<UsagePreset> {
        self.entries.iter().flat_map(|a| a.presets()).collect()
    }
    pub fn profile_preset(&self, connection: &crate::native::profile::Connection) -> Option<UsagePreset> {
        self.entries.iter().find_map(|adapter| adapter.profile_preset(connection))
    }
    pub fn script(&self, config: &QueryConfig) -> Result<String, UsageError> {
        config.validate()?;
        let QueryProgram::Builtin { provider, .. } = &config.program else {
            return Err(UsageError::configuration("需要内置查询配置"));
        };
        self.get(provider)?.script(config)
    }
}
fn validate_version(config: &QueryConfig, id: &str) -> Result<(), UsageError> {
    if !matches!(&config.program,QueryProgram::Builtin{provider,template_version} if provider==id && *template_version==BUILTIN_TEMPLATE_VERSION)
    {
        return Err(UsageError::configuration(
            "此内置查询版本不可用，请选择受支持的预设",
        ));
    }
    Ok(())
}
pub fn builtin_script(config: &QueryConfig) -> Result<String, UsageError> {
    ProviderRegistry::builtins().script(config)
}
pub(crate) fn validate_builtin_credentials(input: &HelperInput) -> Result<(), UsageError> {
    let QueryProgram::Builtin { provider, .. } = &input.config.program else {
        return Err(UsageError::configuration("需要内置查询配置"));
    };
    let scopes = input
        .secrets
        .iter()
        .map(|s| CredentialScope {
            name: s.name.clone(),
            allowed_origins: s.allowed_origins.clone(),
        })
        .collect::<Vec<_>>();
    ProviderRegistry::builtins()
        .get(provider)?
        .validate_credentials(&input.config, &scopes)
}
pub(crate) fn presets() -> Vec<UsagePreset> {
    let mut entries = ProviderRegistry::builtins().presets();
    entries.extend(example::presets());
    entries
}
