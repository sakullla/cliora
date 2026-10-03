//! Desktop links use the OS default browser on Windows, macOS and Linux.
use tauri_plugin_opener::OpenerExt;

pub(crate) fn validated_url(value: &str) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("外部链接格式无效".into());
    }
    let url = url::Url::parse(value).map_err(|_| "外部链接格式无效")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅允许不含凭据的 HTTP/HTTPS 文档链接".into());
    }
    Ok(url.into())
}
pub(crate) fn open(app: &tauri::AppHandle, value: &str) -> Result<(), String> {
    let url = validated_url(value)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "无法打开系统浏览器，请复制链接到浏览器打开".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn documentation_url_validation_preserves_query_and_fragment() {
        let value = "https://code.claude.com/docs/en/setup?platform=macos#install";
        assert_eq!(validated_url(value).unwrap(), value);
        assert!(validated_url("http://docs.example/setup").is_ok());
    }
    #[test]
    fn executable_and_credential_urls_are_rejected() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:user@example.test",
            "https://token@example.test",
            "https://docs.example/\n",
            "/relative",
        ] {
            assert!(validated_url(value).is_err(), "{value}");
        }
    }
}
