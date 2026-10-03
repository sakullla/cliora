//! Supplier-specific routes. HTTP validation, requests and caching stay in native services.
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirectoryAuth {
    Bearer,
    Anthropic,
}

pub trait ModelDirectoryAdapter: Sync {
    fn route(&self, base: &Url) -> Result<Option<(Url, DirectoryAuth)>, String>;
}

pub fn route(base: &Url) -> Result<Option<(Url, DirectoryAuth)>, String> {
    for adapter in super::providers::model_directory_adapters() {
        if let Some(route) = adapter.route(base)? {
            return Ok(Some(route));
        }
    }
    Ok(None)
}
