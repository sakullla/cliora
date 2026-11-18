//! Desktop links use the OS default browser on Windows, macOS and Linux.
use std::path::Path;
use tauri_plugin_opener::OpenerExt;

fn validated_twiglane_workspace_url(value: &str) -> Result<String, String> {
    if value.len() > 16_384 || value.chars().any(|c| c.is_control() || c == ' ') || value.contains('#') {
        return Err("项目清单链接无效".into());
    }
    let query = value
        .strip_prefix("twiglane://workspace?")
        .or_else(|| value.strip_prefix("twiglane://workspace/?"))
        .ok_or_else(|| "项目清单链接无效".to_string())?;
    if query.contains('+') {
        return Err("项目清单链接无效".into());
    }
    let mut version = None;
    let mut path = None;
    for (key, val) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "v" if version.is_none() => version = Some(val.into_owned()),
            "file" if path.is_none() => path = Some(val.into_owned()),
            _ => return Err("项目清单链接含未知或重复字段".into()),
        }
    }
    if version.as_deref() != Some("1") {
        return Err("项目清单链接版本不受支持".into());
    }
    let path = path.ok_or_else(|| "项目清单链接缺少文件".to_string())?;
    if !Path::new(&path).is_absolute() || path.chars().any(char::is_control) {
        return Err("项目清单链接需使用本机绝对路径".into());
    }
    Ok(value.to_owned())
}

pub(crate) fn validated_url(value: &str) -> Result<String, String> {
    if value.starts_with("twiglane://") {
        return validated_twiglane_workspace_url(value);
    }
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
    let is_twiglane = url.starts_with("twiglane://");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| {
            if is_twiglane {
                "无法打开 Twiglane，请确认已安装 Twiglane 或在 Twiglane 中手动打开清单文件".into()
            } else {
                "无法打开系统浏览器，请复制链接到浏览器打开".into()
            }
        })
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
    fn twiglane_workspace_handoff_url_is_validated() {
        #[cfg(unix)]
        let valid = "twiglane://workspace?v=1&file=%2Fwork%2Fmy%20team%2Fshared.dev-workspace.json";
        #[cfg(windows)]
        let valid = "twiglane://workspace?v=1&file=C%3A%2Fwork%2Fmy%20team%2Fshared.dev-workspace.json";
        assert_eq!(validated_url(valid).unwrap(), valid);

        for invalid in [
            "twiglane://workspace?v=2&file=%2Fwork%2Fa.json",
            "twiglane://workspace?v=1&file=relative.json",
            "twiglane://workspace?v=1&file=%2Fwork%2Fa+b.json",
            "twiglane://workspace?v=1&file=%2Fwork%2Fa.json#frag",
            "twiglane://other?v=1&file=%2Fwork%2Fa.json",
        ] {
            assert!(validated_url(invalid).is_err(), "{invalid}");
        }
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
