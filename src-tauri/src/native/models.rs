use std::collections::{BTreeSet, HashSet};
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use super::profile::Connection;
use crate::credentials::CredentialStore;
use crate::database::Database;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDirectory {
    pub models: Vec<String>,
    pub status: String,
    pub fetched_at: Option<u64>,
    pub error: Option<String>,
    pub source: String,
}

fn cache_key(connection: &Connection) -> String {
    let input = format!(
        "{}\n{}\n{}\n{}",
        connection.provider_id,
        connection.interface_format,
        connection.base_url,
        connection.secret_ref.as_deref().unwrap_or("")
    );
    format!("{:x}", Sha256::digest(input.as_bytes()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cached(db: &Database, key: &str) -> Result<Option<ModelDirectory>, String> {
    db.with_connection(|conn| {
        let data: Option<String> = conn
            .query_row(
                "SELECT data FROM model_cache WHERE cache_key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        data.map(|json| serde_json::from_str(&json).map_err(|_| "模型缓存格式无法识别".into()))
            .transpose()
    })
}

fn save_cache(db: &Database, key: &str, directory: &ModelDirectory) -> Result<(), String> {
    let data = serde_json::to_string(directory).map_err(|_| "模型目录无法保存")?;
    db.with_connection(|conn| {
        conn.execute("INSERT INTO model_cache (cache_key, fetched_at, data) VALUES (?1, ?2, ?3) ON CONFLICT(cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data", params![key, directory.fetched_at.unwrap_or(0) as i64, data]).map_err(|_| "模型目录无法缓存")?;
        Ok(())
    })
}

fn endpoint(connection: &Connection) -> Result<Url, String> {
    let mut url = Url::parse(&connection.base_url).map_err(|_| "模型目录地址不是有效 URL")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("模型目录只支持 HTTP(S) 地址".into());
    }
    if url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err("模型目录地址不能包含认证信息、查询或片段".into());
    }
    if url.scheme() == "http"
        && !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    {
        return Err("远程模型目录须使用 HTTPS".into());
    }
    if !url.path().ends_with("/models") {
        let mut path = url.path().trim_end_matches('/').to_owned();
        path.push_str("/models");
        url.set_path(&path);
    }
    Ok(url)
}

fn fetch(
    connection: &Connection,
    credentials: &dyn CredentialStore,
) -> Result<Vec<String>, String> {
    let mut url = endpoint(connection)?;
    let secret = match &connection.secret_ref {
        Some(id) => Some(credentials.get(id).map_err(|_| "模型目录凭据不可用")?),
        None => None,
    };
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法建立模型目录连接")?;
    let mut models = BTreeSet::new();
    let mut seen_cursors = HashSet::new();
    for _ in 0..10 {
        let mut request = client.get(url.clone()).header(ACCEPT, "application/json");
        if let Some(secret) = &secret {
            request = if connection.interface_format == "anthropic_messages" {
                request
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01")
            } else {
                request.header(AUTHORIZATION, format!("Bearer {secret}"))
            };
        }
        let response = request.send().map_err(|error| {
            if error.is_timeout() {
                "模型目录请求超时"
            } else {
                "无法连接模型目录"
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => "模型目录认证失败，请检查 API 密钥".into(),
                404 => "供应商没有在该地址提供模型目录，可直接填写模型 ID".into(),
                429 => "模型目录请求受到频率限制，请稍后刷新".into(),
                300..=399 => "模型目录发生跳转，出于凭据安全没有继续请求".into(),
                _ => format!("模型目录返回 HTTP {}", status.as_u16()),
            });
        }
        let mut bytes = Vec::new();
        response
            .take(2_000_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取模型目录响应")?;
        if bytes.len() > 2_000_000 {
            return Err("模型目录响应过大".into());
        }
        let body: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "模型目录响应不是有效 JSON")?;
        let data = body
            .get("data")
            .and_then(serde_json::Value::as_array)
            .ok_or("模型目录缺少 data 列表")?;
        for item in data {
            if let Some(id) = item.get("id").and_then(serde_json::Value::as_str) {
                if !id.trim().is_empty() {
                    models.insert(id.to_string());
                }
            }
        }
        let has_more = body
            .get("has_more")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !has_more {
            return Ok(models.into_iter().collect());
        }
        let cursor = body
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                data.last()
                    .and_then(|item| item.get("id"))
                    .and_then(serde_json::Value::as_str)
            })
            .ok_or("模型目录未提供下一页位置")?;
        if !seen_cursors.insert(cursor.to_string()) {
            return Err("模型目录分页重复，已停止请求".into());
        }
        url.query_pairs_mut().append_pair(
            if connection.interface_format == "anthropic_messages" {
                "after_id"
            } else {
                "after"
            },
            cursor,
        );
    }
    Err("模型目录超过 10 页，请缩小查询范围或稍后重试".into())
}

pub fn list_models(
    db: &Database,
    credentials: &dyn CredentialStore,
    connection: &Connection,
    force: bool,
    query: &str,
) -> Result<ModelDirectory, String> {
    let key = cache_key(connection);
    let previous = cached(db, &key)?;
    let fresh = previous
        .as_ref()
        .and_then(|item| item.fetched_at)
        .is_some_and(|time| now().saturating_sub(time) < 3600);
    let mut directory = if fresh && !force {
        previous.unwrap()
    } else {
        match fetch(connection, credentials) {
            Ok(models) => {
                let result = ModelDirectory {
                    status: if models.is_empty() {
                        "empty".into()
                    } else {
                        "ready".into()
                    },
                    models,
                    fetched_at: Some(now()),
                    error: None,
                    source: "provider_directory".into(),
                };
                save_cache(db, &key, &result)?;
                result
            }
            Err(error) => match previous {
                Some(mut cached) => {
                    cached.status = "stale".into();
                    cached.error = Some(error);
                    cached.source = "cached_provider_directory".into();
                    cached
                }
                None => ModelDirectory {
                    models: Vec::new(),
                    status: "error".into(),
                    fetched_at: None,
                    error: Some(error),
                    source: "provider_directory".into(),
                },
            },
        }
    };
    let needle = query.trim().to_lowercase();
    if !needle.is_empty() {
        directory
            .models
            .retain(|model| model.to_lowercase().contains(&needle));
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    struct NoCredential;
    impl CredentialStore for NoCredential {
        fn put(&self, _: &str, _: &str) -> Result<(), String> {
            Err("unused".into())
        }
        fn get(&self, _: &str) -> Result<String, String> {
            Err("unused".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("unused".into())
        }
    }

    #[test]
    fn real_http_directory_paginates_deduplicates_and_caches_without_inference() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for page in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert!(first.starts_with("GET /v1/models"));
                if page == 1 {
                    assert!(first.contains("after=alpha"));
                }
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                let body = if page == 0 {
                    r#"{"data":[{"id":"alpha"}],"has_more":true,"last_id":"alpha"}"#
                } else {
                    r#"{"data":[{"id":"alpha"},{"id":"beta"}],"has_more":false}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let connection = Connection {
            provider_id: "fixture".into(),
            interface_format: "openai_responses".into(),
            base_url: format!("http://{address}/v1"),
            model: "manual".into(),
            secret_ref: None,
            auth_env_var: None,
        };
        let result = list_models(&db, &NoCredential, &connection, true, "").unwrap();
        assert_eq!(result.models, vec!["alpha", "beta"]);
        assert_eq!(
            list_models(&db, &NoCredential, &connection, false, "bet")
                .unwrap()
                .models,
            vec!["beta"]
        );
        server.join().unwrap();
    }

    #[test]
    fn invalid_directory_does_not_destroy_manual_model() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let connection = Connection {
            provider_id: "fixture".into(),
            interface_format: "openai_responses".into(),
            base_url: "not a url".into(),
            model: "hand-entered".into(),
            secret_ref: None,
            auth_env_var: None,
        };
        let result = list_models(&db, &NoCredential, &connection, true, "").unwrap();
        assert_eq!(result.status, "error");
        assert!(result.models.is_empty());
        assert_eq!(connection.model, "hand-entered");
    }

    #[test]
    fn rate_limit_keeps_prior_catalog_and_protocol_change_uses_separate_cache() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for page in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                if page == 0 {
                    let body = r#"{"data":[{"id":"retained"}]}"#;
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                } else {
                    write!(stream, "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                }
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("app.db")).unwrap();
        let mut connection = Connection {
            provider_id: "fixture".into(),
            interface_format: "openai_responses".into(),
            base_url: format!("http://{address}/v1"),
            model: "manual".into(),
            secret_ref: None,
            auth_env_var: None,
        };
        assert_eq!(
            list_models(&db, &NoCredential, &connection, true, "")
                .unwrap()
                .status,
            "ready"
        );
        let stale = list_models(&db, &NoCredential, &connection, true, "").unwrap();
        assert_eq!(stale.status, "stale");
        assert_eq!(stale.models, vec!["retained"]);
        assert!(stale.error.unwrap().contains("频率限制"));
        server.join().unwrap();
        connection.interface_format = "openai_completions".into();
        let changed = list_models(&db, &NoCredential, &connection, true, "").unwrap();
        assert_eq!(changed.status, "error");
        assert!(changed.models.is_empty());
        assert_eq!(connection.model, "manual");
    }
}
