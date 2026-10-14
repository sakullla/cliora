//! Bounded public release queries. Adapter-owned URLs, shared transport/cache.
use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::adapters::CliAdapter;

type Cache = HashMap<String, (Instant, String)>;
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn parse_version(adapter: &dyn CliAdapter, bytes: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "版本清单格式无法识别")?;
    let version = adapter.parse_latest_version(text).ok_or("版本清单缺少有效版本")?;
    let version = version.trim();
    semver::Version::parse(version.trim_start_matches('v')).map_err(|_| "版本清单缺少有效版本")?;
    Ok(version.trim_start_matches('v').to_owned())
}

/// Queries the public release of the install line selected by the identified
/// version. Unknown versions yield the adapter's own no-source error instead of
/// guessing a line.
pub fn latest_for(adapter: &dyn CliAdapter, version: Option<&str>) -> Result<String, String> {
    let url = adapter.latest_version_url_for_version(version).ok_or("此工具尚未提供公开版本查询，请查看官方安装说明")?;
    if let Some((at, version)) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&url) {
        if at.elapsed() < Duration::from_secs(300) { return Ok(version.clone()); }
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("Cliora release-check")
        .build().map_err(|_| "无法创建版本查询")?;
    let response = client.get(&url)
        .send().map_err(|_| "版本查询连接失败，请重试")?
        .error_for_status().map_err(|_| "版本查询服务暂时不可用，请重试")?;
    let mut bytes = Vec::new();
    response.take(1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "读取版本清单失败")?;
    if bytes.len() > 1024 * 1024 { return Err("版本清单超过大小限制".into()); }
    let version = parse_version(adapter, &bytes)?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(url, (Instant::now(), version.clone()));
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_public_manifest_versions() {
        let adapter = &crate::adapters::DEVIN;
        assert_eq!(parse_version(adapter, br#"{"version":"3000.11.3","platforms":{}}"#).unwrap(), "3000.11.3");
        assert_eq!(parse_version(adapter, br#"{"version":"v1.3.2"}"#).unwrap(), "1.3.2");
        for invalid in [br#"{"version":"latest"}"#.as_slice(), br#"{"version":null}"#, b"<html>error</html>"] {
            assert!(parse_version(adapter, invalid).is_err());
        }
        assert_eq!(parse_version(&crate::adapters::ZCODE, b"href=\"https://cdn-zcode.z.ai/zcode/electron/releases/3.14.4/windows-x64/ZCode.exe\"").unwrap(), "3.14.4");
        assert!(parse_version(&crate::adapters::ZCODE, b"unrelated 99.0.0").is_err());
        assert_eq!(parse_version(&crate::adapters::DEEPSEEK, b"version: 0.2.0-rc.2\nfiles: []").unwrap(), "0.2.0-rc.2");
    }
    #[test]
    fn registry_controls_release_sources_and_npm_install_policy() {
        let registry = crate::adapters::Registry::builtins();
        for adapter in registry.iter() {
            if adapter.npm_package().is_empty() {
                assert!(
                    adapter.latest_version_url().is_none_or(|url| !url.contains("registry.npmjs.org")),
                    "{}",
                    adapter.id()
                );
                assert!(adapter.npm_install_command().is_none(), "{}", adapter.id());
            } else if let Some(command) = adapter.npm_install_command() {
                for flag in ["@latest", "--include=optional", "--ignore-scripts=false", "--foreground-scripts"] {
                    assert!(command.contains(flag), "{}: {flag}", adapter.id());
                }
                assert_eq!(adapter.upgrade_command("npm_shim"), Some(command));
            } else {
                let package = adapter.npm_package();
                assert_eq!(
                    adapter.latest_version_url().as_deref(),
                    Some(format!("https://registry.npmjs.org/{package}/latest")).as_deref(),
                    "{}",
                    adapter.id()
                );
                assert!(adapter.install_command().is_none(), "{}", adapter.id());
                assert!(adapter.upgrade_command("npm_shim").is_none(), "{}", adapter.id());
                assert!(adapter.npm_uninstall_command().is_none(), "{}", adapter.id());
            }
        }
        assert!(registry.get("devin").unwrap().latest_version_url().unwrap().contains("static.devin.ai"));
    }
    #[test]
    fn opencode_release_queries_follow_the_identified_install_line() {
        let adapter = &crate::adapters::OPENCODE;
        assert_eq!(
            adapter.latest_version_url_for_version(Some("1.19.0")).as_deref(),
            Some("https://registry.npmjs.org/opencode-ai/latest")
        );
        assert_eq!(
            adapter.latest_version_url_for_version(Some("v2.0.29")).as_deref(),
            Some("https://registry.npmjs.org/@opencode%2Fcli/latest")
        );
        assert_eq!(adapter.latest_version_url_for_version(None), None);
        assert_eq!(adapter.latest_version_url_for_version(Some("3.0.0")), None);
        // A single-line adapter keeps its own release source for any version.
        assert_eq!(
            crate::adapters::DEVIN.latest_version_url_for_version(Some("3000.11.3")),
            crate::adapters::DEVIN.latest_version_url()
        );
    }
    #[test]
    #[ignore = "read-only public network verification"]
    fn live_release_sources() {
        let registry = crate::adapters::Registry::builtins();
        for adapter in registry.iter().filter(|adapter| adapter.latest_version_url_for_version(None).is_some()) {
            eprintln!("{}: {}", adapter.id(), latest_for(adapter, None).unwrap());
        }
    }
}
