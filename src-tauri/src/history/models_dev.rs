//! models.dev 公开价格表：介于用户自定义价格与内置 published 兜底价之间的一级来源。
//! 报表生成时若缓存过期，在模块内起分离线程拉取 https://models.dev/api.json，
//! 不阻塞当前请求；缓存持久化为数据库文件旁的 JSON 文件。拉取或解析失败保留
//! 上次缓存，从未成功过时该级自然为空，回退既有 published/不显示语义。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::HistoryPrice;
#[cfg(not(test))]
use super::now_ms;
use crate::database::Database;

#[cfg(not(test))]
use std::io::{Read, Write};
#[cfg(not(test))]
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
#[cfg(not(test))]
use std::time::Duration;

#[cfg(not(test))]
const API_URL: &str = "https://models.dev/api.json";
pub(crate) const SOURCE: &str = "models.dev";
/// 缓存超过一天后，下次报表生成时后台刷新。
#[cfg(not(test))]
const REFRESH_AFTER_MS: i64 = 24 * 3_600_000;
/// 失败重试的最小间隔，避免每次打开用量页都压网络。
#[cfg(not(test))]
const RETRY_AFTER_MS: i64 = 30 * 60_000;
#[cfg(not(test))]
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// 价格表只有几 MB；上限只防异常响应。
#[cfg(not(test))]
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

#[cfg(not(test))]
static FETCHING: AtomicBool = AtomicBool::new(false);
#[cfg(not(test))]
static LAST_ATTEMPT: AtomicI64 = AtomicI64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PriceCache {
    pub fetched_at: i64,
    pub prices: Vec<HistoryPrice>,
}

pub(crate) fn cache_path(directory: &Path) -> PathBuf {
    directory.join("models-dev-prices.json")
}

/// 归一化只剥离大小写与常见 provider 前缀，不猜测日期后缀等变体。
const PROVIDER_PREFIXES: &[&str] = &[
    "ai21", "amazon", "anthropic", "azure", "bedrock", "cohere", "deepseek",
    "gemini", "google", "groq", "meta", "mistral", "nvidia", "openai",
    "openrouter", "vertex", "xai",
];

pub(crate) fn normalize_model(model: &str) -> String {
    let lowered = model.trim().to_ascii_lowercase();
    if let Some((prefix, rest)) = lowered.split_once('/') {
        if PROVIDER_PREFIXES.contains(&prefix) && !rest.is_empty() {
            return rest.to_owned();
        }
    }
    lowered
}

/// api.json 按 provider 分组，`cost` 字段为每百万 token 的美元价，可缺省。
/// 顶层结构不符或解析不出任何价格时返回 Err：整次导入丢弃，调用方保留旧缓存。
pub(crate) fn parse_prices(body: &str, fetched_at: i64) -> Result<Vec<HistoryPrice>, String> {
    let root: Value = serde_json::from_str(body).map_err(|error| format!("models.dev 响应不是 JSON：{error}"))?;
    let providers = root.as_object().ok_or("models.dev 响应格式无法识别")?;
    let mut prices = Vec::new();
    for (provider, entry) in providers {
        let Some(models) = entry.get("models").and_then(Value::as_object) else { continue };
        for (id, model) in models {
            let Some(cost) = model.get("cost").and_then(Value::as_object) else { continue };
            let rate = |key: &str| -> Option<f64> {
                match cost.get(key) {
                    None => Some(0.0),
                    Some(value) => value
                        .as_f64()
                        .filter(|rate| rate.is_finite() && *rate >= 0.0 && *rate <= 1_000_000.0),
                }
            };
            let (Some(input), Some(output), Some(cache_read), Some(cache_write)) =
                (rate("input"), rate("output"), rate("cache_read"), rate("cache_write"))
            else {
                continue;
            };
            prices.push(HistoryPrice {
                tool_id: provider.clone(),
                model: id.clone(),
                currency: "USD".into(),
                input_per_million: input,
                output_per_million: output,
                cache_read_per_million: cache_read,
                cache_write_per_million: cache_write,
                source: SOURCE.into(),
                updated_at: fetched_at,
            });
        }
    }
    if prices.is_empty() {
        return Err("models.dev 响应中没有任何可用价格".into());
    }
    Ok(prices)
}

/// 缓存损坏或不存在都视为该级为空，不影响报表。
pub(crate) fn load(path: &Path) -> Option<PriceCache> {
    let text = fs::read_to_string(path).ok()?;
    let cache: PriceCache = serde_json::from_str(&text).ok()?;
    (!cache.prices.is_empty()).then_some(cache)
}

/// 缓存放在数据库文件旁；内存库没有目录，该级自然为空。
pub(crate) fn database_directory(db: &Database) -> Option<PathBuf> {
    db.with_connection(|conn| {
        let mut statement = conn.prepare("PRAGMA database_list").map_err(|error| error.to_string())?;
        let files = statement
            .query_map([], |row| Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(files
            .into_iter()
            .find(|(name, _)| name == "main")
            .and_then(|(_, file)| (!file.is_empty()).then_some(file))
            .and_then(|file| PathBuf::from(file).parent().map(Path::to_owned)))
    })
    .ok()
    .flatten()
}

/// 缓存过期时起分离线程刷新，立即返回不阻塞报表。测试构建不触网。
pub(crate) fn maybe_refresh(directory: &Path) {
    #[cfg(not(test))]
    maybe_refresh_inner(directory);
    #[cfg(test)]
    let _ = directory;
}

#[cfg(not(test))]
fn maybe_refresh_inner(directory: &Path) {
    let now = now_ms();
    let fresh = fs::metadata(cache_path(directory))
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|age| now - age.as_millis() as i64 <= REFRESH_AFTER_MS);
    if fresh || now - LAST_ATTEMPT.load(Ordering::Relaxed) < RETRY_AFTER_MS {
        return;
    }
    if FETCHING.swap(true, Ordering::AcqRel) {
        return;
    }
    LAST_ATTEMPT.store(now, Ordering::Relaxed);
    let directory = directory.to_owned();
    std::thread::spawn(move || {
        let _ = fetch_and_store(&directory);
        FETCHING.store(false, Ordering::Release);
    });
}

#[cfg(not(test))]
fn fetch_and_store(directory: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("cliora/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(API_URL)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?;
    let mut body = Vec::new();
    response
        .take(MAX_BODY_BYTES)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    let text = String::from_utf8(body).map_err(|error| error.to_string())?;
    let fetched_at = now_ms();
    // 先完整解析再动缓存：数据格式变化时整次导入丢弃，保留旧缓存。
    let prices = parse_prices(&text, fetched_at)?;
    let payload = serde_json::to_string(&PriceCache { fetched_at, prices }).map_err(|error| error.to_string())?;
    let target = cache_path(directory);
    let staging = target.with_extension("json.tmp");
    let mut file = fs::File::create(&staging).map_err(|error| error.to_string())?;
    file.write_all(payload.as_bytes()).map_err(|error| error.to_string())?;
    drop(file);
    // Windows 不允许 rename 覆盖已存在文件。
    let _ = fs::remove_file(&target);
    fs::rename(&staging, &target).map_err(|error| error.to_string())?;
    Ok(())
}

/// 模型匹配先精确后归一化；不带 `/` 的直接 id 优先于 provider 前缀的重复条目。
#[derive(Default)]
pub(crate) struct ImportedPrices {
    exact: HashMap<String, HistoryPrice>,
    normalized: HashMap<String, HistoryPrice>,
}

impl ImportedPrices {
    pub(crate) fn index(prices: Vec<HistoryPrice>) -> Self {
        let mut index = ImportedPrices::default();
        for price in prices.iter().filter(|price| !price.model.contains('/')) {
            index.insert(price.clone());
        }
        for price in prices.iter().filter(|price| price.model.contains('/')) {
            index.insert(price.clone());
        }
        index
    }

    fn insert(&mut self, price: HistoryPrice) {
        self.normalized
            .entry(normalize_model(&price.model))
            .or_insert_with(|| price.clone());
        self.exact.entry(price.model.clone()).or_insert(price);
    }

    pub(crate) fn resolve(&self, model: &str) -> Option<HistoryPrice> {
        self.exact
            .get(model)
            .or_else(|| self.normalized.get(&normalize_model(model)))
            .cloned()
    }
}
