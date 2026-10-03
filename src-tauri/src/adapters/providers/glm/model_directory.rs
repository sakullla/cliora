use crate::adapters::model_directory::{DirectoryAuth, ModelDirectoryAdapter};
use url::Url;

pub(super) static MODEL_DIRECTORY: Glm = Glm;
pub struct Glm;

impl ModelDirectoryAdapter for Glm {
    fn route(&self, base: &Url) -> Result<Option<(Url, DirectoryAuth)>, String> {
        if let Some(host) = base.host_str() {
            if matches!(host, "open.bigmodel.cn" | "api.z.ai") && !base.path().contains("/api/") {
                return Err(format!("这是 {host} 的网站地址，不是 API 地址。模型列表请填写 https://{host}/api/paas/v4；Claude 兼容接口请填写 https://{host}/api/anthropic"));
            }
        }
        Ok(None)
    }
}
