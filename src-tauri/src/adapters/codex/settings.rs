use crate::native::format::{self, FileKind};
use serde_json::json;
pub fn set_codex_reasoning_effort(text: &str, effort: Option<&str>) -> Result<String, String> {
    if effort.is_some_and(|value| !matches!(value, "minimal" | "low" | "medium" | "high" | "xhigh"))
    {
        return Err("不支持的 Codex 推理强度".into());
    }
    let value = effort.map(|value| json!(value));
    format::set_path(
        FileKind::Toml,
        text,
        &["model_reasoning_effort".into()],
        value.as_ref(),
    )
}
