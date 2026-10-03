use crate::adapters::model_directory::{DirectoryAuth, ModelDirectoryAdapter};
use url::Url;

pub(super) static MODEL_DIRECTORY: DeepSeek = DeepSeek;
pub struct DeepSeek;

impl ModelDirectoryAdapter for DeepSeek {
    fn route(&self, base: &Url) -> Result<Option<(Url, DirectoryAuth)>, String> {
        if base.host_str() != Some("api.deepseek.com") {
            return Ok(None);
        }
        let mut url = base.clone();
        url.set_path("/models");
        url.set_query(None);
        Ok(Some((url, DirectoryAuth::Bearer)))
    }
}
