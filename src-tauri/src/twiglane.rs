//! cliora ↔ Twiglane 审查协议 v2 的 cliora 侧实现。
//!
//! 协议唯一来源是 `docs/integrations/twiglane-review-v2.md`。这个模块只做四件事：
//! 生成 `twiglane://review` 链接、校验并处理回送的 `cliora://review` 事件、维护内存态
//! 审查关联，以及在目标 worktree 上用参数数组读取真实 Git 状态。
//! 它不写 Git、不改会话、不联网：所有失败都在任何仓库写入之前结束。
//!
//! v2 与 v1 不兼容：两端同步升级，其他版本一律 `unsupported_version`，没有回退。
//! returned 的 Git outcome 与工作区声明正交，两者都只是待复核声明；有界的 `meta.*`
//! 只被保存，不执行、不影响核心解析与复核。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::commands::ApiError;
use crate::git_status::{is_oid, run_git};

/// 出站 scheme：cliora 发起审查。
const SCHEME_OUT: &str = "twiglane";
/// 两个方向共用的 host。
const HOST: &str = "review";
/// 协议规定的整条 URL 上限（UTF-8 字节）。
pub(crate) const MAX_URL_BYTES: usize = 2048;
/// 协议规定的路径长度上限（字符）。
const MAX_PATH_CHARS: usize = 1000;
/// 协议主版本。
const VERSION: &str = "2";
/// 入站事件允许的核心查询参数名。除合法的 `meta.*` 外，任何其它名字都是无效输入。
const PARAMS: [&str; 8] =
    ["v", "event", "reviewId", "sessionId", "reason", "outcome", "headOid", "worktreeState"];
/// 扩展元数据参数名的固定前缀。
const META_PREFIX: &str = "meta.";
/// 一条 returned 最多携带的 meta 个数。
const MAX_META_ENTRIES: usize = 8;
/// meta 值解码后的字符上限。
const MAX_META_VALUE_CHARS: usize = 128;
/// returned 的工作区声明只接受这三种取值。
const WORKTREE_STATES: [&str; 3] = ["clean", "dirty", "unknown"];

/// `rejected` 只接受协议第 4 节列出的稳定错误码。
const REJECT_REASONS: [&str; 5] = [
    "unsupported_version",
    "malformed_request",
    "invalid_path",
    "not_a_worktree",
    "open_failed",
];

/// `returned` 只接受这三种结果。
const OUTCOMES: [&str; 3] = ["reviewed", "committed", "merged"];

/// 审查状态只有这四种取值。
pub(crate) const STATUS_OPENING: &str = "opening";
pub(crate) const STATUS_ACCEPTED: &str = "accepted";
pub(crate) const STATUS_REJECTED: &str = "rejected";
pub(crate) const STATUS_RETURNED: &str = "returned";

/// 一次已发起的审查。字段名与前端 camelCase 契约一致。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    pub review_id: String,
    pub session_id: String,
    pub worktree_path: String,
    /// 会话启动时的 HEAD（见 `baseline`）；空仓库读不到时省略，Twiglane 也不会收到这个参数。
    pub baseline: Option<String>,
    pub status: String,
    pub reason: Option<String>,
    pub outcome: Option<String>,
    pub head_oid: Option<String>,
    /// Twiglane 返回时声明的工作区状态（clean/dirty/unknown）；只是声明，以真实读取为准。
    pub worktree_state: Option<String>,
    /// 返回时携带的说明性元数据（键不含 `meta.` 前缀）。只保存用于诊断，不影响任何结论。
    pub meta: BTreeMap<String, String>,
    /// 发起时刻（Unix 毫秒），前端用它判断是否已经超过 10 秒未确认。
    pub created_at: u64,
}

/// 处理一条入站链接的结果。kind 为 ignored 时其余字段只用于说明原因。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOutcome {
    pub kind: String,
    pub session_id: Option<String>,
    pub review_id: Option<String>,
    pub outcome: Option<String>,
    pub head_oid: Option<String>,
    pub worktree_state: Option<String>,
    pub reason: Option<String>,
}

impl LinkOutcome {
    pub(crate) fn ignored(reason: &str) -> Self {
        LinkOutcome {
            kind: "ignored".into(),
            session_id: None,
            review_id: None,
            outcome: None,
            head_oid: None,
            worktree_state: None,
            reason: Some(reason.into()),
        }
    }
}

/// 入站链接的三种合法语义。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LinkEvent {
    Accepted { review_id: String, session_id: String },
    Rejected { review_id: String, session_id: String, reason: String },
    Returned {
        review_id: String,
        session_id: String,
        outcome: String,
        head_oid: Option<String>,
        worktree_state: String,
        meta: BTreeMap<String, String>,
    },
}

/// 目标 worktree 的真实代码状态。state 为 unknown 时各项读取结果不可用，不能显示成 0。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStatus {
    pub session_id: String,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub uncommitted_files: Option<u64>,
    /// Files this session changed since it started; `None` without a start record
    /// (the session moved to another worktree, or the launch read failed).
    pub session_files: Option<u64>,
    /// HEAD when the session started in this worktree.
    pub session_base: Option<String>,
    pub state: &'static str,
    pub reason: Option<String>,
}

impl CodeStatus {
    fn unknown(session_id: &str, path: Option<String>, reason: &str) -> Self {
        CodeStatus {
            session_id: session_id.into(),
            worktree_path: path,
            branch: None,
            head_oid: None,
            uncommitted_files: None,
            session_files: None,
            session_base: None,
            state: "unknown",
            reason: Some(reason.into()),
        }
    }
}

/// 按协议第 2 节编码：只有未保留字符原样出现，空格是 %20，加号按字面加号处理。
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(*byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let text = std::str::from_utf8(pair).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// 路径必须绝对、长度受限，且不含控制字符。
fn is_valid_path(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_PATH_CHARS
        && Path::new(value).is_absolute()
        && !value.starts_with('~')
        && !value.chars().any(|character| character.is_control())
}

/// 固定 host：`review`，或系统对无路径 URL 规范化出的 `review/`（恰好一个尾斜杠）。
///
/// Windows 把 `twiglane://review?...` 交给应用时会写成 `twiglane://review/?...`，
/// 两端都必须接受；再多的斜杠或任何路径段都不是本协议。
fn is_host(authority: &str) -> bool {
    authority.strip_suffix('/').unwrap_or(authority) == HOST
}

/// `meta.<namespace>.<name>`：namespace `[a-z][a-z0-9-]{0,31}`，name `[A-Za-z][A-Za-z0-9_-]{0,31}`。
/// 参数名必须原样出现：百分号编码的名字不匹配。
fn is_meta_key(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(META_PREFIX) else { return false };
    let mut parts = rest.split('.');
    let (Some(namespace), Some(key), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let namespace_ok = (1..=32).contains(&namespace.len())
        && namespace.as_bytes()[0].is_ascii_lowercase()
        && namespace.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let key_ok = (1..=32).contains(&key.len())
        && key.as_bytes()[0].is_ascii_alphabetic()
        && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    namespace_ok && key_ok
}

/// meta 值：解码后 1–128 字符的单行短文本，不含任何控制字符。
fn is_meta_value(value: &str) -> bool {
    let count = value.chars().count();
    (1..=MAX_META_VALUE_CHARS).contains(&count) && !value.chars().any(char::is_control)
}

/// 一条 URL 出现控制字符或裸空白即无效（协议第 2 节）。
fn has_raw_whitespace_or_control(url: &str) -> bool {
    url.chars().any(|character| character.is_control() || character.is_whitespace())
}

/// 生成 twiglane://review?v=2&...。参数顺序固定，baseline 为空时不出现。
pub(crate) fn review_url(
    review_id: &str,
    session_id: &str,
    worktree_path: &str,
    baseline: Option<&str>,
) -> String {
    let mut url = format!(
        "{SCHEME_OUT}://{HOST}?v={VERSION}&reviewId={}&sessionId={}&worktreePath={}",
        percent_encode(review_id),
        percent_encode(session_id),
        percent_encode(worktree_path)
    );
    if let Some(baseline) = baseline {
        url.push_str("&baseline=");
        url.push_str(&percent_encode(baseline));
    }
    url
}

/// 生成链接并校验整条 URL 的 2048 字节上限（协议第 2 节）。
/// 超限时必须在这里失败：接收端只会静默丢弃超长链接，cliora 会误等 10 秒再报"环境未知"。
pub(crate) fn checked_review_url(
    review_id: &str,
    session_id: &str,
    worktree_path: &str,
    baseline: Option<&str>,
) -> Result<String, &'static str> {
    let url = review_url(review_id, session_id, worktree_path, baseline);
    // percent_encode 之后整条链接只有 ASCII，len() 就是 UTF-8 字节数。
    if url.len() > MAX_URL_BYTES {
        return Err("path_too_long");
    }
    Ok(url)
}

/// 校验并解析回送的 cliora://review 事件。失败返回协议里的稳定错误码。
pub(crate) fn parse_event_url(url: &str) -> Result<LinkEvent, &'static str> {
    if url.len() > MAX_URL_BYTES || has_raw_whitespace_or_control(url) {
        return Err("malformed_request");
    }
    let rest = url.strip_prefix("cliora://").ok_or("malformed_request")?;
    // host 之后只能紧跟查询串：不接受 userinfo、端口、路径或 fragment。
    // 系统会把无路径 URL 规范化成 host 后跟一个斜杠，因此 `review` 与 `review/` 等价。
    let (authority, query) = rest.split_once('?').ok_or("malformed_request")?;
    if !is_host(authority) || query.contains('#') || query.contains('?') {
        return Err("malformed_request");
    }
    let mut params: HashMap<&str, &str> = HashMap::new();
    for part in query.split('&') {
        if part.is_empty() {
            return Err("malformed_request");
        }
        let (name, value) = part.split_once('=').ok_or("malformed_request")?;
        if name.is_empty() {
            return Err("malformed_request");
        }
        // 重复参数与未知参数都是无效输入。
        if params.insert(name, value).is_some() {
            return Err("malformed_request");
        }
    }
    // 核心参数是固定白名单；只有形状合法的 meta.* 可以作为扩展出现，且个数有界。
    if params.keys().any(|name| !PARAMS.contains(name) && !is_meta_key(name)) {
        return Err("malformed_request");
    }
    if params.keys().filter(|name| name.starts_with(META_PREFIX)).count() > MAX_META_ENTRIES {
        return Err("malformed_request");
    }
    let text = |name: &str| -> Result<Option<String>, &'static str> {
        match params.get(name) {
            Some(value) => percent_decode(value).map(Some).ok_or("malformed_request"),
            None => Ok(None),
        }
    };
    match params.get("v").copied() {
        Some(VERSION) => {}
        // v1 与其他主版本都不得按 v2 猜测处理，也没有回退。
        Some(_) | None => return Err("unsupported_version"),
    }
    let event = text("event")?.ok_or("malformed_request")?;
    let review_id = text("reviewId")?.ok_or("malformed_request")?;
    let session_id = text("sessionId")?.ok_or("malformed_request")?;
    if !is_uuid(&review_id) || !is_uuid(&session_id) {
        return Err("malformed_request");
    }
    let reason = text("reason")?;
    let outcome = text("outcome")?;
    let head_oid = text("headOid")?;
    let worktree_state = text("worktreeState")?;
    let mut meta = BTreeMap::new();
    for (name, value) in &params {
        if let Some(key) = name.strip_prefix(META_PREFIX) {
            let value = percent_decode(value).ok_or("malformed_request")?;
            if !is_meta_value(&value) {
                return Err("malformed_request");
            }
            meta.insert(key.to_owned(), value);
        }
    }
    match event.as_str() {
        "accepted" => {
            if reason.is_some() || outcome.is_some() || head_oid.is_some() || worktree_state.is_some() || !meta.is_empty() {
                return Err("malformed_request");
            }
            Ok(LinkEvent::Accepted { review_id, session_id })
        }
        "rejected" => {
            let reason = reason.ok_or("malformed_request")?;
            if !REJECT_REASONS.contains(&reason.as_str())
                || outcome.is_some()
                || head_oid.is_some()
                || worktree_state.is_some()
                || !meta.is_empty()
            {
                return Err("malformed_request");
            }
            Ok(LinkEvent::Rejected { review_id, session_id, reason })
        }
        "returned" => {
            let outcome = outcome.ok_or("malformed_request")?;
            if !OUTCOMES.contains(&outcome.as_str()) {
                return Err("malformed_request");
            }
            if reason.is_some() {
                return Err("malformed_request");
            }
            // 提交与合入必须带完整 OID；没有提交或合入的 reviewed 不得携带提交声明。
            let head_oid = match (outcome.as_str(), head_oid) {
                ("reviewed", None) => None,
                ("reviewed", Some(_)) => return Err("malformed_request"),
                (_, Some(oid)) if is_oid(&oid) => Some(oid),
                _ => return Err("malformed_request"),
            };
            // 工作区声明必填且与 outcome 正交；缺失不能默认成 clean。
            let worktree_state = worktree_state.ok_or("malformed_request")?;
            if !WORKTREE_STATES.contains(&worktree_state.as_str()) {
                return Err("malformed_request");
            }
            Ok(LinkEvent::Returned { review_id, session_id, outcome, head_oid, worktree_state, meta })
        }
        _ => Err("malformed_request"),
    }
}

/// 一条入站事件对注册表的结果。
enum UpdateOutcome {
    /// 该 reviewId 就是此 session 的最新审查，状态已更新。
    Applied,
    /// 注册表里从来没有这个 reviewId（应用重启后旧链接到达也走这里）。
    Unknown,
    /// 记录还在，但同一 session 已经发起了更新的审查。
    Superseded,
}

#[derive(Default)]
struct RegistryData {
    entries: HashMap<String, ReviewState>,
    latest: HashMap<String, String>,
}

/// 内存态审查关联：每个 session 只认最新 reviewId，重启后自然清空。
#[derive(Default)]
pub(crate) struct ReviewRegistry {
    data: Mutex<RegistryData>,
}

impl ReviewRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryData> {
        self.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 记录一次新发起的审查，并使同一会话的旧 reviewId 失效。
    pub(crate) fn begin(&self, state: ReviewState) {
        let mut data = self.lock();
        data.latest.insert(state.session_id.clone(), state.review_id.clone());
        data.entries.insert(state.review_id.clone(), state);
    }

    /// 只有当作最新 reviewId 且记录仍在时更新状态，旧请求不会被晚到的结果改写。
    /// 只有当作最新 reviewId 且记录仍在时更新状态，旧请求不会被晚到的结果改写。
    /// 完全没见过的 reviewId 与"存在但已被更新 review 取代"分开报告：前者是失效来源，
    /// 后者是迟到事件，界面上的下一步不同。
    fn update<F: FnOnce(&mut ReviewState)>(&self, review_id: &str, session_id: &str, update: F) -> UpdateOutcome {
        let mut data = self.lock();
        let Some(known_session) = data.entries.get(review_id).map(|entry| entry.session_id.clone()) else {
            return UpdateOutcome::Unknown;
        };
        if known_session != session_id {
            return UpdateOutcome::Unknown;
        }
        if data.latest.get(session_id).map(String::as_str) != Some(review_id) {
            return UpdateOutcome::Superseded;
        }
        match data.entries.get_mut(review_id) {
            Some(entry) => {
                update(entry);
                UpdateOutcome::Applied
            }
            None => UpdateOutcome::Unknown,
        }
    }

    pub(crate) fn latest_for_session(&self, session_id: &str) -> Option<ReviewState> {
        let data = self.lock();
        let review_id = data.latest.get(session_id)?;
        data.entries.get(review_id).cloned()
    }

    /// 应用一条入站事件：未知或被取代的 reviewId 一律丢弃，不覆盖新结果。
    /// 未知来源回 `unknown_review`，迟到事件回 `superseded_review`，两者由调用方分别提示。
    pub(crate) fn apply(&self, event: LinkEvent) -> LinkOutcome {
        match event {
            LinkEvent::Accepted { review_id, session_id } => {
                match self.update(&review_id, &session_id, |entry| {
                    entry.status = STATUS_ACCEPTED.into();
                    entry.reason = None;
                }) {
                    UpdateOutcome::Applied => LinkOutcome {
                        kind: "accepted".into(),
                        session_id: Some(session_id),
                        review_id: Some(review_id),
                        outcome: None,
                        head_oid: None,
                        worktree_state: None,
                        reason: None,
                    },
                    other => LinkOutcome::ignored(other.code()),
                }
            }
            LinkEvent::Rejected { review_id, session_id, reason } => {
                match self.update(&review_id, &session_id, |entry| {
                    entry.status = STATUS_REJECTED.into();
                    entry.reason = Some(reason.clone());
                }) {
                    UpdateOutcome::Applied => LinkOutcome {
                        kind: "rejected".into(),
                        session_id: Some(session_id),
                        review_id: Some(review_id),
                        outcome: None,
                        head_oid: None,
                        worktree_state: None,
                        reason: Some(reason),
                    },
                    other => LinkOutcome::ignored(other.code()),
                }
            }
            LinkEvent::Returned { review_id, session_id, outcome, head_oid, worktree_state, meta } => {
                match self.update(&review_id, &session_id, |entry| {
                    entry.status = STATUS_RETURNED.into();
                    entry.outcome = Some(outcome.clone());
                    entry.head_oid = head_oid.clone();
                    entry.worktree_state = Some(worktree_state.clone());
                    // 新结果整体替代旧结果：上一次返回的 meta 不会残留到这一次。
                    entry.meta = meta;
                    entry.reason = None;
                }) {
                    UpdateOutcome::Applied => LinkOutcome {
                        kind: "returned".into(),
                        session_id: Some(session_id),
                        review_id: Some(review_id),
                        outcome: Some(outcome),
                        head_oid,
                        worktree_state: Some(worktree_state),
                        reason: None,
                    },
                    other => LinkOutcome::ignored(other.code()),
                }
            }
        }
    }
}

impl UpdateOutcome {
    fn code(&self) -> &'static str {
        match self {
            UpdateOutcome::Applied => "applied",
            UpdateOutcome::Unknown => "unknown_review",
            UpdateOutcome::Superseded => "superseded_review",
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// 新建一条 opening 审查记录。每次显式发起或重试都会得到新的 reviewId。
pub(crate) fn new_review(session_id: &str, worktree_path: &str, baseline: Option<String>) -> ReviewState {
    ReviewState {
        review_id: uuid::Uuid::new_v4().hyphenated().to_string(),
        session_id: session_id.into(),
        worktree_path: worktree_path.into(),
        baseline,
        status: STATUS_OPENING.into(),
        reason: None,
        outcome: None,
        head_oid: None,
        worktree_state: None,
        meta: BTreeMap::new(),
        created_at: now_millis(),
    }
}

/// 远程会话在本机没有可审查的目录，必须在 native 层拒绝。
pub(crate) fn review_target(directory: Option<PathBuf>) -> Result<PathBuf, &'static str> {
    directory.ok_or("remote_session")
}

/// 工作树根目录（rev-parse --show-toplevel 的规范结果）。
pub(crate) fn worktree_root(directory: &Path) -> Result<PathBuf, &'static str> {
    let (ok, stdout) = run_git(directory, &["rev-parse", "--show-toplevel"])?;
    let text = stdout.trim_end_matches(['\r', '\n']).trim();
    if !ok || text.is_empty() {
        return Err("not_a_worktree");
    }
    PathBuf::from(text).canonicalize().map_err(|_| "invalid_path")
}

/// 目录必须就是工作树根目录：子目录、父仓库和同名仓库都不能替代。
pub(crate) fn checked_worktree(directory: &Path) -> Result<PathBuf, &'static str> {
    let canonical = directory.canonicalize().map_err(|_| "invalid_path")?;
    let root = worktree_root(&canonical)?;
    if root != canonical {
        return Err("not_a_worktree");
    }
    Ok(root)
}

/// 审查基线：会话在这个工作树启动时的 HEAD（仍是当前 HEAD 的祖先时），历史被改写后取
/// 两者的共同祖先；没有启动记录时退回发起时的 HEAD。同一会话上一次审查返回了提交或合入、
/// 且那个提交仍在当前历史里时，从那里算起，已审查过的提交不再重复出现。
/// 空仓库读不到时为 None，链接里也不会出现。
pub(crate) fn baseline(session_id: &str, root: &Path, previous: Option<&ReviewState>) -> Option<String> {
    let start = crate::session_baseline::for_root(session_id, root)
        .and_then(|start| crate::session_baseline::review_base(&start, root));
    let path = url_path(root).ok();
    let reviewed = previous
        .filter(|review| review.status == STATUS_RETURNED)
        .filter(|review| matches!(review.outcome.as_deref(), Some("committed" | "merged")))
        .filter(|review| path.as_deref() == Some(review.worktree_path.as_str()))
        .and_then(|review| review.head_oid.clone())
        .filter(|oid| is_oid(oid))
        .filter(|oid| crate::session_baseline::is_ancestor(root, oid, "HEAD"))
        .filter(|oid| start.as_deref().is_none_or(|start| crate::session_baseline::is_ancestor(root, start, oid)));
    reviewed.or(start).or_else(|| head_oid(root))
}

fn head_oid(root: &Path) -> Option<String> {
    let (ok, stdout) = run_git(root, &["rev-parse", "--verify", "HEAD"]).ok()?;
    let text = stdout.trim();
    (ok && is_oid(text)).then(|| text.to_owned())
}

/// 读取目标 worktree 的真实分支、HEAD 与完整未提交文件数。
pub(crate) fn code_status(session_id: &str, directory: &Path) -> CodeStatus {
    let root = match checked_worktree(directory) {
        Ok(root) => root,
        Err(reason) => {
            let path = crate::launch::terminal_path(directory).ok();
            return CodeStatus::unknown(session_id, path, reason);
        }
    };
    let path = crate::launch::terminal_path(&root).ok();
    let start = crate::session_baseline::for_root(session_id, &root);
    match crate::git_status::read(&root) {
        Ok(snapshot) => CodeStatus {
            session_id: session_id.into(),
            worktree_path: path,
            branch: snapshot.branch,
            head_oid: snapshot.head_oid,
            uncommitted_files: Some(snapshot.files),
            session_files: start.as_ref().and_then(|start| crate::session_baseline::session_changes(start, &root).ok()),
            session_base: start.and_then(|start| start.head.clone()),
            state: "ready",
            reason: None,
        },
        Err(reason) => CodeStatus::unknown(session_id, path, reason),
    }
}

/// 链接里使用的规范路径文字：DOS/UNC 形式、正斜杠分隔。
pub(crate) fn url_path(root: &Path) -> Result<String, &'static str> {
    let text = crate::launch::terminal_path(root).map_err(|_| "invalid_path")?;
    let text = text.replace('\\', "/");
    if !is_valid_path(&text) {
        return Err("invalid_path");
    }
    Ok(text)
}

/// 命令层统一使用的稳定错误码。
pub(crate) fn api_error(code: &'static str) -> ApiError {
    let (message, action) = match code {
        "session_unknown" => ("找不到这个会话，无法发起审查。", "重新选择一个进行中的本地会话后重试。"),
        "remote_session" => ("远程 SSH 会话不支持在 Twiglane 中审查。", "首期只支持本机可访问的本地会话。"),
        "invalid_path" => ("会话目录已经失效或无法读取。", "确认目录仍然存在后重试。"),
        "not_a_worktree" => ("这个目录不是 Git 工作树根目录。", "在会话所在的工作树根目录中重新发起。"),
        "git_missing" => ("找不到 Git，无法读取工作树状态。", "安装 Git 后重试。"),
        "path_too_long" => ("工作树路径太长，无法生成审查链接。", "把工作树放到更短的路径下再发起审查。"),
        "output_too_large" => ("工作树的改动太多，这次没有读完。", "在终端里整理改动后重试。"),
        "read_failed" => ("这次没有读到工作树的 Git 状态。", "稍后重试；期间显示为未知。"),
        "open_failed" => ("系统没有接受打开 Twiglane 的请求。", "确认已安装 Twiglane 后重试，或手动打开它。"),
        _ => ("审查操作没有完成。", "确认会话与工作树状态后重试。"),
    };
    ApiError { code, message: message.into(), action, data_directory: None, remote: None }
}
#[cfg(test)]
mod tests {
    use super::*;

    const REVIEW_ID: &str = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
    const SESSION_ID: &str = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
    const OID: &str = "4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0";
    const NEXT_OID: &str = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

    fn accepted_url() -> String {
        format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}")
    }

    fn review(review_id: &str, session_id: &str) -> ReviewState {
        let mut state = new_review(session_id, "C:/w/a", Some(OID.into()));
        state.review_id = review_id.into();
        state
    }

    #[test]
    fn the_outbound_url_encodes_spaces_unicode_and_keeps_the_protocol_order() {
        let url = review_url(REVIEW_ID, SESSION_ID, "C:/w/a b/代码", Some(OID));
        assert_eq!(
            url,
            format!(
                "twiglane://review?v=2&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreePath=C%3A%2Fw%2Fa%20b%2F%E4%BB%A3%E7%A0%81&baseline={OID}"
            )
        );
        // 空仓库读不到 HEAD 时不发 baseline，也不发空值。
        assert!(!review_url(REVIEW_ID, SESSION_ID, "C:/w", None).contains("baseline"));
    }

    #[test]
    fn inbound_links_accept_only_the_contract_shapes() {
        assert_eq!(
            parse_event_url(&accepted_url()),
            Ok(LinkEvent::Accepted { review_id: REVIEW_ID.into(), session_id: SESSION_ID.into() })
        );
        let rejected = format!(
            "cliora://review?v=2&event=rejected&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&reason=not_a_worktree"
        );
        assert_eq!(
            parse_event_url(&rejected),
            Ok(LinkEvent::Rejected {
                review_id: REVIEW_ID.into(),
                session_id: SESSION_ID.into(),
                reason: "not_a_worktree".into(),
            })
        );
        let returned = format!(
            "cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&outcome=committed&headOid={OID}&worktreeState=dirty"
        );
        assert_eq!(
            parse_event_url(&returned),
            Ok(LinkEvent::Returned {
                review_id: REVIEW_ID.into(),
                session_id: SESSION_ID.into(),
                outcome: "committed".into(),
                head_oid: Some(OID.into()),
                worktree_state: "dirty".into(),
                meta: BTreeMap::new(),
            })
        );
        // 参数顺序不参与语义。
        let reordered =
            format!("cliora://review?sessionId={SESSION_ID}&reviewId={REVIEW_ID}&event=accepted&v=2");
        assert!(parse_event_url(&reordered).is_ok());
    }

    #[test]
    fn inbound_links_accept_a_single_trailing_slash_and_nothing_more() {
        // 生成端继续输出零斜杠形式，接收端把系统的单斜杠规范化当作同一个 host。
        let plain = accepted_url();
        assert!(plain.starts_with("cliora://review?"));
        let slashed = plain.replacen("cliora://review?", "cliora://review/?", 1);
        for url in [&plain, &slashed] {
            assert_eq!(
                parse_event_url(url),
                Ok(LinkEvent::Accepted { review_id: REVIEW_ID.into(), session_id: SESSION_ID.into() }),
                "{url}"
            );
        }

        for hostile in [
            plain.replacen("cliora://review?", "cliora://review//?", 1),
            plain.replacen("cliora://review?", "cliora://review/x?", 1),
            plain.replacen("cliora://review?", "cliora://review/a/b?", 1),
            plain.replacen("cliora://review?", "cliora://review/%2F?", 1),
            plain.replacen("cliora://review?", "cliora://review:1?", 1),
            plain.replacen("cliora://review?", "cliora://me@review?", 1),
        ] {
            assert!(parse_event_url(&hostile).is_err(), "should reject: {hostile}");
        }

        // 带尾斜杠的 returned 与 rejected 也照常解析。
        for event in [
            format!("cliora://review/?v=2&event=rejected&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&reason=open_failed"),
            format!("cliora://review/?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&outcome=merged&headOid={OID}&worktreeState=dirty"),
        ] {
            assert!(parse_event_url(&event).is_ok(), "{event}");
        }
    }

    #[test]
    fn inbound_links_reject_version_scheme_and_parameter_violations() {
        let cases = [
            format!("cliora://review?v=3&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=1&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&outcome=reviewed"),
            format!("cliora://review?event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://other?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("twiglane://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review/path?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}#x"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&foo=1"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=2&event=accepted&reviewId=not-a-uuid&sessionId={SESSION_ID}"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&reason=open_failed"),
            format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean&outcome=committed"),
            format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean&outcome=reviewed&headOid={OID}"),
            format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean&outcome=committed&headOid={OID}&reason=open_failed"),
            format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean&outcome=merged&headOid={}", &OID[..7]),
            format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean&outcome=merged&headOid={}", OID.to_uppercase()),
            format!("cliora://review?v=2&event=unknown&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=2&event=rejected&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&reason=whatever"),
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID} "),
        ];
        for case in cases {
            assert!(parse_event_url(&case).is_err(), "should reject: {case}");
        }
    }

    fn returned_url(tail: &str) -> String {
        format!("cliora://review?v=2&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}{tail}")
    }

    fn returned_event(outcome: &str, head_oid: Option<&str>, worktree_state: &str) -> LinkEvent {
        LinkEvent::Returned {
            review_id: REVIEW_ID.into(),
            session_id: SESSION_ID.into(),
            outcome: outcome.into(),
            head_oid: head_oid.map(Into::into),
            worktree_state: worktree_state.into(),
            meta: BTreeMap::new(),
        }
    }

    #[test]
    fn worktree_state_is_required_and_orthogonal_to_the_git_outcome() {
        for (tail, outcome, head, state) in [
            ("&outcome=reviewed&worktreeState=dirty".to_string(), "reviewed", None, "dirty"),
            ("&outcome=reviewed&worktreeState=clean".to_string(), "reviewed", None, "clean"),
            ("&outcome=reviewed&worktreeState=unknown".to_string(), "reviewed", None, "unknown"),
            (format!("&outcome=committed&headOid={OID}&worktreeState=dirty"), "committed", Some(OID), "dirty"),
            (format!("&outcome=merged&headOid={OID}&worktreeState=clean"), "merged", Some(OID), "clean"),
        ] {
            assert_eq!(parse_event_url(&returned_url(&tail)), Ok(returned_event(outcome, head, state)), "{tail}");
        }
        for tail in [
            "&outcome=reviewed",
            "&outcome=reviewed&worktreeState=",
            "&outcome=reviewed&worktreeState=approved",
            "&outcome=reviewed&worktreeState=Dirty",
            "&outcome=edited&worktreeState=dirty",
            "&outcome=reviewed&worktreeState=dirty&worktreeState=clean",
        ] {
            assert_eq!(parse_event_url(&returned_url(tail)), Err("malformed_request"), "{tail}");
        }
        for url in [
            format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&worktreeState=clean"),
            format!("cliora://review?v=2&event=rejected&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&reason=open_failed&worktreeState=dirty"),
        ] {
            assert_eq!(parse_event_url(&url), Err("malformed_request"), "{url}");
        }
    }

    #[test]
    fn v1_and_other_versions_are_rejected_without_fallback() {
        for url in [
            format!("cliora://review?v=1&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&outcome=reviewed"),
            format!("cliora://review?v=1&event=returned&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&outcome=reviewed&worktreeState=dirty"),
            format!("cliora://review?v=3&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
            format!("cliora://review?event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}"),
        ] {
            assert_eq!(parse_event_url(&url), Err("unsupported_version"), "{url}");
        }
        // 发起端只生成 v2 链接。
        assert!(review_url(REVIEW_ID, SESSION_ID, "C:/w", None).starts_with("twiglane://review?v=2&"));
    }

    #[test]
    fn bounded_meta_is_kept_without_changing_the_core_event() {
        let plain = parse_event_url(&returned_url(&format!("&outcome=committed&headOid={OID}&worktreeState=dirty"))).unwrap();
        let extended = parse_event_url(&returned_url(&format!(
            "&outcome=committed&headOid={OID}&worktreeState=dirty&meta.twiglane.version=0.3.3&meta.acme-tools.build_id=b%201"
        )))
        .unwrap();
        let LinkEvent::Returned { meta, .. } = &extended else { panic!("returned") };
        assert_eq!(meta.get("twiglane.version").map(String::as_str), Some("0.3.3"));
        assert_eq!(meta.get("acme-tools.build_id").map(String::as_str), Some("b 1"));
        // 去掉 meta 后核心事件完全相同。
        let LinkEvent::Returned { review_id, session_id, outcome, head_oid, worktree_state, .. } = extended else { unreachable!() };
        assert_eq!(plain, LinkEvent::Returned { review_id, session_id, outcome, head_oid, worktree_state, meta: BTreeMap::new() });

        let long = "x".repeat(MAX_META_VALUE_CHARS + 1);
        let too_many: String = (0..=MAX_META_ENTRIES).map(|index| format!("&meta.ns.k{index}=v")).collect();
        for extra in [
            "&meta.x=1".to_string(),
            "&meta.x.y.z=1".to_string(),
            "&meta..y=1".to_string(),
            "&meta.x.=1".to_string(),
            "&meta.X.y=1".to_string(),
            "&meta.x.1y=1".to_string(),
            "&meta.x.y=".to_string(),
            "&meta.x.y=a%0Ab".to_string(),
            "&meta.x.y=a%09b".to_string(),
            format!("&meta.x.y={long}"),
            "&meta%2Ex.y=1".to_string(),
            "&meta.x.y=1&meta.x.y=2".to_string(),
            "&meta.x.y=%ZZ".to_string(),
            too_many,
            "&metadata=1".to_string(),
        ] {
            let url = returned_url(&format!("&outcome=reviewed&worktreeState=clean{extra}"));
            assert_eq!(parse_event_url(&url), Err("malformed_request"), "{url}");
        }
        // meta 只属于 returned。
        let accepted = format!("cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&meta.twiglane.version=1");
        assert_eq!(parse_event_url(&accepted), Err("malformed_request"));
    }

    #[test]
    fn the_registry_keeps_the_worktree_claim_and_meta_and_replaces_them_on_the_next_return() {
        let registry = ReviewRegistry::default();
        registry.begin(review(REVIEW_ID, SESSION_ID));
        let first = parse_event_url(&returned_url("&outcome=reviewed&worktreeState=dirty&meta.twiglane.version=0.3.3")).unwrap();
        let outcome = registry.apply(first);
        assert_eq!(outcome.kind, "returned");
        assert_eq!(outcome.worktree_state.as_deref(), Some("dirty"));
        let state = registry.latest_for_session(SESSION_ID).unwrap();
        assert_eq!(state.outcome.as_deref(), Some("reviewed"));
        assert_eq!(state.worktree_state.as_deref(), Some("dirty"));
        assert_eq!(state.meta.get("twiglane.version").map(String::as_str), Some("0.3.3"));
        assert!(state.head_oid.is_none());

        // 同一审查再次返回：新结果整体替代旧结果，不残留旧 meta。
        registry.apply(returned_event("committed", Some(NEXT_OID), "clean"));
        let state = registry.latest_for_session(SESSION_ID).unwrap();
        assert_eq!(state.outcome.as_deref(), Some("committed"));
        assert_eq!(state.worktree_state.as_deref(), Some("clean"));
        assert!(state.meta.is_empty());

        // 序列化给前端的字段名保持 camelCase。
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["worktreeState"], "clean");
        assert!(json["meta"].is_object());
    }

    #[test]
    fn an_over_long_link_is_rejected_before_parsing() {
        let padding = "a".repeat(MAX_URL_BYTES);
        let url = format!(
            "cliora://review?v=2&event=accepted&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&pad={padding}"
        );
        assert_eq!(parse_event_url(&url), Err("malformed_request"));
    }

    #[test]
    fn only_the_latest_review_of_a_session_is_accepted() {
        let registry = ReviewRegistry::default();
        registry.begin(review(REVIEW_ID, SESSION_ID));
        let newer = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        registry.begin(review(newer, SESSION_ID));

        // 旧 reviewId 的 accepted 不得改写新记录。
        let stale = registry.apply(LinkEvent::Accepted {
            review_id: REVIEW_ID.into(),
            session_id: SESSION_ID.into(),
        });
        assert_eq!(stale.kind, "ignored");
        assert_eq!(stale.reason.as_deref(), Some("superseded_review"));

        let latest =
            registry.apply(LinkEvent::Accepted { review_id: newer.into(), session_id: SESSION_ID.into() });
        assert_eq!(latest.kind, "accepted");

        let returned = registry.apply(LinkEvent::Returned {
            review_id: newer.into(),
            session_id: SESSION_ID.into(),
            outcome: "committed".into(),
            head_oid: Some(NEXT_OID.into()),
            worktree_state: "dirty".into(),
            meta: BTreeMap::new(),
        });
        assert_eq!(returned.kind, "returned");
        let state = registry.latest_for_session(SESSION_ID).unwrap();
        assert_eq!(state.review_id, newer);
        assert_eq!(state.status, STATUS_RETURNED);
        assert_eq!(state.outcome.as_deref(), Some("committed"));
        assert_eq!(state.head_oid.as_deref(), Some(NEXT_OID));
        assert_eq!(state.baseline.as_deref(), Some(OID));
    }

    #[test]
    fn an_unknown_review_is_ignored_and_creates_nothing() {
        let registry = ReviewRegistry::default();
        let outcome = registry.apply(returned_event("merged", Some(OID), "clean"));
        assert_eq!(outcome.kind, "ignored");
        // 完全没有过的 reviewId 是"来源失效"，不能报成迟到事件。
        assert_eq!(outcome.reason.as_deref(), Some("unknown_review"));
        assert!(registry.latest_for_session(SESSION_ID).is_none());
    }

    #[test]
    fn an_unknown_review_and_a_superseded_review_are_reported_differently() {
        let registry = ReviewRegistry::default();
        let missing = registry.apply(LinkEvent::Accepted {
            review_id: "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb".into(),
            session_id: SESSION_ID.into(),
        });
        assert_eq!(missing.kind, "ignored");
        assert_eq!(missing.reason.as_deref(), Some("unknown_review"));

        registry.begin(review(REVIEW_ID, SESSION_ID));
        let newer = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        registry.begin(review(newer, SESSION_ID));
        let late = registry.apply(returned_event("reviewed", None, "dirty"));
        assert_eq!(late.kind, "ignored");
        assert_eq!(late.reason.as_deref(), Some("superseded_review"));
        // 迟到事件不改写最新状态。
        let state = registry.latest_for_session(SESSION_ID).unwrap();
        assert_eq!(state.review_id, newer);
        assert_eq!(state.status, STATUS_OPENING);

        // 同一个 reviewId 换了 sessionId 也不算已知来源。
        let mismatched = registry.apply(LinkEvent::Accepted {
            review_id: newer.into(),
            session_id: "11111111-2222-4333-8444-555555555555".into(),
        });
        assert_eq!(mismatched.reason.as_deref(), Some("unknown_review"));
    }

    #[test]
    fn an_outbound_url_over_the_byte_limit_fails_before_it_is_opened() {
        // 中文路径在百分号编码后每字符 9 字节，仍在 1000 字符的路径上限内。
        let short = format!("C:/w/{}", "代码".repeat(10));
        let url = checked_review_url(REVIEW_ID, SESSION_ID, &short, Some(OID)).expect("short path fits");
        assert!(url.len() <= MAX_URL_BYTES);
        assert!(url.contains("%E4%BB%A3%E7%A0%81"));

        let long = format!("C:/w/{}", "代".repeat(300));
        assert!(long.chars().count() <= MAX_PATH_CHARS);
        // 只有整条链接的字节上限能拦住它。
        assert!(review_url(REVIEW_ID, SESSION_ID, &long, Some(OID)).len() > MAX_URL_BYTES);
        assert_eq!(checked_review_url(REVIEW_ID, SESSION_ID, &long, Some(OID)), Err("path_too_long"));
        // 不带 baseline 也不能绕过。
        assert_eq!(checked_review_url(REVIEW_ID, SESSION_ID, &long, None), Err("path_too_long"));
    }

    #[test]
    fn every_attempt_gets_a_new_review_id() {
        let first = new_review(SESSION_ID, "C:/w/a", None);
        let second = new_review(SESSION_ID, "C:/w/a", None);
        assert_ne!(first.review_id, second.review_id);
        assert!(is_uuid(&first.review_id));
        assert_eq!(first.status, STATUS_OPENING);
        assert!(first.baseline.is_none());
    }

    #[test]
    fn a_remote_session_has_no_local_directory_to_review() {
        assert_eq!(review_target(None), Err("remote_session"));
        let path = PathBuf::from("C:/w");
        assert_eq!(review_target(Some(path.clone())), Ok(path));
    }

    fn git(cwd: &Path, args: &[&str]) -> bool {
        matches!(run_git(cwd, args), Ok((true, _)))
    }

    fn commit_all(repo: &Path, message: &str) -> bool {
        git(repo, &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "add", "-A"])
            && git(
                repo,
                &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "commit", "-q", "-m", message],
            )
    }

    fn init_repo(root: &Path) -> Option<PathBuf> {
        if crate::git_status::find_git().is_none() {
            eprintln!("git unavailable; skipping Twiglane status test");
            return None;
        }
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        if !git(&repo, &["init", "-b", "main"]) {
            return None;
        }
        Some(repo)
    }

    #[test]
    fn the_status_reports_branch_head_and_every_uncommitted_file() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        assert!(commit_all(&repo, "root"));
        for index in 0..45 {
            std::fs::write(repo.join(format!("new-{index}.txt")), "x\n").unwrap();
        }
        std::fs::write(repo.join("tracked.txt"), "two\n").unwrap();

        let status = code_status(SESSION_ID, &repo);
        assert_eq!(status.state, "ready", "{status:?}");
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.uncommitted_files, Some(46));
        assert!(status.head_oid.as_deref().is_some_and(is_oid));
        // 读取过后工作树仍然是同一份改动，没有被清理。
        assert!(git(&repo, &["status", "--porcelain=v1"]));
    }

    #[test]
    fn an_empty_repository_reports_no_head_instead_of_zero_commits() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        let status = code_status(SESSION_ID, &repo);
        assert_eq!(status.state, "ready", "{status:?}");
        assert!(status.head_oid.is_none());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.uncommitted_files, Some(0));
    }

    #[test]
    fn linked_worktree_status_counts_a_rename_once_and_keeps_its_own_branch() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("old name.txt"), "one\n").unwrap();
        assert!(commit_all(&repo, "root"));
        let linked = temp.path().join("linked");
        assert!(git(&repo, &["worktree", "add", "-b", "feature/linked", linked.to_str().unwrap()]));
        assert!(git(&linked, &["mv", "old name.txt", "new name.txt"]));
        std::fs::write(linked.join("中文.txt"), "new\n").unwrap();
        let status = code_status(SESSION_ID, &linked);
        assert_eq!(status.state, "ready", "{status:?}");
        assert_eq!(status.branch.as_deref(), Some("feature/linked"));
        assert_eq!(status.uncommitted_files, Some(2));
        assert_eq!(code_status(SESSION_ID, &repo).uncommitted_files, Some(0));
    }

    #[test]
    fn status_counts_an_unmerged_file_once() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("file.txt"), "base\n").unwrap();
        assert!(commit_all(&repo, "root"));
        assert!(git(&repo, &["checkout", "-b", "other"]));
        std::fs::write(repo.join("file.txt"), "other\n").unwrap();
        assert!(commit_all(&repo, "other"));
        assert!(git(&repo, &["checkout", "main"]));
        std::fs::write(repo.join("file.txt"), "main\n").unwrap();
        assert!(commit_all(&repo, "main"));
        assert!(!git(&repo, &["-c", "user.name=cliora", "-c", "user.email=cliora@example.com", "merge", "other"]));
        let status = code_status(SESSION_ID, &repo);
        assert_eq!(status.state, "ready", "{status:?}");
        assert_eq!(status.uncommitted_files, Some(1));
    }

    #[test]
    fn a_detached_head_reports_no_branch_but_a_real_head() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        assert!(commit_all(&repo, "root"));
        assert!(git(&repo, &["checkout", "--detach", "-q"]));
        let status = code_status(SESSION_ID, &repo);
        assert_eq!(status.state, "ready", "{status:?}");
        assert!(status.branch.is_none());
        assert!(status.head_oid.as_deref().is_some_and(is_oid));
    }

    #[test]
    fn a_directory_outside_a_repository_is_unknown_not_empty() {
        let temp = tempfile::tempdir().unwrap();
        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let status = code_status(SESSION_ID, &plain);
        assert_eq!(status.state, "unknown");
        assert_eq!(status.reason.as_deref(), Some("not_a_worktree"));
        assert_eq!(status.uncommitted_files, None);
    }

    #[test]
    fn a_subdirectory_is_not_a_worktree_root_for_review() {
        let temp = tempfile::tempdir().unwrap();
        let Some(repo) = init_repo(temp.path()) else { return };
        std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        assert!(commit_all(&repo, "root"));
        let nested = repo.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(checked_worktree(&nested), Err("not_a_worktree"));
        assert!(checked_worktree(&repo).is_ok());
        // 链接里的路径文字必须是正斜杠的 DOS 形式，供 Twiglane 再次 canonicalize。
        assert!(!url_path(&repo).unwrap().contains('\\'));
    }
}
