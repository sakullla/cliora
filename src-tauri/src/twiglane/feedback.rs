//! feedback-v1 接收：严格 URL、一次性私有文件、digest 与内存暂存。
//!
//! 协议唯一来源是 docs/integrations/twiglane-review-feedback-v1.md。这个模块只做接收侧：
//! 解析 cliora://review-feedback?v=1&...，读取并校验一次性交接文件，把有界意见读入内存供
//! 预览，然后删除文件。它不启动 CLI、不写 PTY、不写 Git；发送由命令层在用户确认后单独触发。

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::ApiError;

use super::{is_uuid, ReviewState};

/// 交接目录名：两端都在各自平台的临时根目录下使用同一个子目录。
const DIRECTORY: &str = "cliora-review-feedback";
/// 入站 host。
const HOST: &str = "review-feedback";
/// 协议规定的整条 URL 上限（UTF-8 字节）。
const MAX_URL_BYTES: usize = 2048;
/// 文件与内容上限：整文件 1 MiB、单条正文 16 KiB、整批 64 条。
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_COMMENTS: usize = 64;
const MAX_PATH_CHARS: usize = 500;
const MAX_WORKTREE_CHARS: usize = 1000;
const MAX_RANGE_VERSION_CHARS: usize = 200;
/// 深链允许的六个参数名；任何其它名字、重复或空值都无效。
const PARAMS: [&str; 6] = ["v", "feedbackId", "reviewId", "sessionId", "resultRevision", "digest"];
/// JS 安全整数上限。
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// 一条意见。字段顺序即 digest 规范里的顺序，oldNo/newNo 必须显式写成 null。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackComment {
    pub id: String,
    pub path: String,
    pub hunk_index: u64,
    pub kind: String,
    pub old_no: Option<i64>,
    pub new_no: Option<i64>,
    pub body: String,
}

/// 交接文件的完整 schema。deny_unknown_fields 让任何额外字段都失败。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackFile {
    pub v: u8,
    pub feedback_id: String,
    pub review_id: String,
    pub session_id: String,
    pub result_revision: u64,
    pub worktree_path: String,
    pub range_version: String,
    pub baseline_oid: String,
    pub head_oid: String,
    pub comments: Vec<FeedbackComment>,
    pub digest: String,
}

/// digest 覆盖的正文：同一结构去掉 digest 后的紧凑序列化。字段顺序与协议第 6 节一致。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackBody<'a> {
    v: u8,
    feedback_id: &'a str,
    review_id: &'a str,
    session_id: &'a str,
    result_revision: u64,
    worktree_path: &'a str,
    range_version: &'a str,
    baseline_oid: &'a str,
    head_oid: &'a str,
    comments: &'a [FeedbackComment],
}

/// 深链携带的标识。正文、路径与代码都不出现在 URL 里。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FeedbackLink {
    pub(crate) feedback_id: String,
    pub(crate) review_id: String,
    pub(crate) session_id: String,
    pub(crate) result_revision: u64,
    pub(crate) digest: String,
}

/// 只读预览：前端展示来源、数量与逐条意见，不含任何可执行动作。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPreview {
    pub feedback_id: String,
    pub review_id: String,
    pub session_id: String,
    pub result_revision: u64,
    pub worktree_path: String,
    pub range_version: String,
    pub comment_count: usize,
    pub comments: Vec<FeedbackCommentView>,
    /// prepared 或 written：后者表示这次反馈已经写过一次终端。
    pub state: String,
}

/// 预览里的一条意见；原样保留行定位与正文，供用户阅读与复制。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackCommentView {
    pub path: String,
    pub kind: String,
    pub old_no: Option<i64>,
    pub new_no: Option<i64>,
    pub body: String,
}

/// 一次发送的结果。written 只表示 write/flush 成功，不代表 Agent 已接受。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSendOutcome {
    pub feedback_id: String,
    pub session_id: String,
    pub state: String,
}

/// 已暂存的一批意见。
#[derive(Clone, Debug)]
pub(crate) struct StagedFeedback {
    pub(crate) file: FeedbackFile,
    pub(crate) state: &'static str,
}

#[derive(Default)]
struct StoreData {
    entries: HashMap<String, StagedFeedback>,
    /// 出现过的 feedbackId：文件已消费后同一标识不能再次暂存。
    seen: HashSet<String>,
}

/// 运行期暂存。重启后自然清空：来源失效，不自动消费或发送。
#[derive(Default)]
pub(crate) struct FeedbackStore {
    data: Mutex<StoreData>,
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 参数值只含未保留字符：不接受百分号编码、加号空格或裸空白。
fn is_plain_value(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
}

fn is_absolute_worktree(value: &str) -> bool {
    if Path::new(value).is_absolute() {
        return true;
    }
    // Windows 盘符形式在以非 Windows 目标编译的测试里也要能判断。
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\')
}

/// 校验一条入站深链，返回其中的标识。失败返回协议里的稳定错误码。
pub(crate) fn parse_feedback_url(url: &str) -> Result<FeedbackLink, &'static str> {
    if url.len() > MAX_URL_BYTES || url.chars().any(|character| character.is_control() || character.is_whitespace()) {
        return Err("feedback_url_invalid");
    }
    let rest = url.strip_prefix("cliora://").ok_or("feedback_url_invalid")?;
    let (authority, query) = rest.split_once('?').ok_or("feedback_url_invalid")?;
    // 系统会把无路径 URL 规范化成 host 后跟一个斜杠；再多斜杠或任何路径段都不是本协议。
    if authority.strip_suffix('/').unwrap_or(authority) != HOST || query.contains('#') || query.contains('?') {
        return Err("feedback_url_invalid");
    }
    let mut params: HashMap<&str, &str> = HashMap::new();
    for part in query.split('&') {
        let (name, value) = part.split_once('=').ok_or("feedback_url_invalid")?;
        if !PARAMS.contains(&name) || !is_plain_value(value) {
            return Err("feedback_url_invalid");
        }
        if params.insert(name, value).is_some() {
            return Err("feedback_url_invalid");
        }
    }
    if params.len() != PARAMS.len() {
        return Err("feedback_url_invalid");
    }
    if params["v"] != "1" {
        return Err("feedback_unsupported_version");
    }
    let feedback_id = params["feedbackId"];
    let review_id = params["reviewId"];
    let session_id = params["sessionId"];
    if !is_uuid(feedback_id) || !is_uuid(review_id) || !is_uuid(session_id) {
        return Err("feedback_url_invalid");
    }
    let digest = params["digest"];
    if !is_lower_hex(digest, 64) {
        return Err("feedback_url_invalid");
    }
    let revision = params["resultRevision"];
    // 不接受前导零、符号或空值。
    if revision.is_empty() || (revision.len() > 1 && revision.starts_with('0')) || !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("feedback_url_invalid");
    }
    let result_revision = revision.parse::<u64>().ok().filter(|value| *value <= MAX_SAFE_INTEGER).ok_or("feedback_url_invalid")?;
    Ok(FeedbackLink {
        feedback_id: feedback_id.to_owned(),
        review_id: review_id.to_owned(),
        session_id: session_id.to_owned(),
        result_revision,
        digest: digest.to_owned(),
    })
}

/// 交接文件路径固定为 temp/cliora-review-feedback/feedbackId.json；调用方不能指定路径。
pub(crate) fn feedback_file_path(feedback_id: &str) -> Result<PathBuf, &'static str> {
    if !is_uuid(feedback_id) {
        return Err("feedback_url_invalid");
    }
    Ok(std::env::temp_dir().join(DIRECTORY).join(format!("{feedback_id}.json")))
}

/// 目录必须是当前用户独占的普通目录；符号链接或宽权限一律拒绝。
fn check_directory(path: &Path) -> Result<(), &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "feedback_read_failed")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("feedback_read_failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // 0700：其他用户没有任何访问权限，等价于协议要求的当前用户隔离。
        if metadata.mode() & 0o077 != 0 {
            return Err("feedback_read_failed");
        }
    }
    Ok(())
}

fn read_file_bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "feedback_read_failed")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("feedback_read_failed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err("feedback_read_failed");
        }
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err("feedback_too_large");
    }
    let file = std::fs::File::open(path).map_err(|_| "feedback_read_failed")?;
    let mut buffer = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut buffer).map_err(|_| "feedback_read_failed")?;
    if buffer.len() > MAX_FILE_BYTES {
        return Err("feedback_too_large");
    }
    Ok(buffer)
}

fn digest_of(file: &FeedbackFile) -> Result<String, &'static str> {
    let body = FeedbackBody {
        v: file.v,
        feedback_id: &file.feedback_id,
        review_id: &file.review_id,
        session_id: &file.session_id,
        result_revision: file.result_revision,
        worktree_path: &file.worktree_path,
        range_version: &file.range_version,
        baseline_oid: &file.baseline_oid,
        head_oid: &file.head_oid,
        comments: &file.comments,
    };
    let bytes = serde_json::to_vec(&body).map_err(|_| "feedback_invalid")?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

fn is_relative_repo_path(value: &str) -> bool {
    let count = value.chars().count();
    (1..=MAX_PATH_CHARS).contains(&count)
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\\')
        && !value.chars().any(char::is_control)
        && value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn is_comment_body(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_BODY_BYTES
        && !value.chars().any(|character| character.is_control() && character != '\n' && character != '\t')
}

/// 校验文件 schema 中不靠 serde 表达的约束：标识形态、行类型、路径、正文、上限与 digest。
fn validate_file(file: &FeedbackFile) -> Result<(), &'static str> {
    if file.v != 1 {
        return Err("feedback_unsupported_version");
    }
    if !is_uuid(&file.feedback_id) || !is_uuid(&file.review_id) || !is_uuid(&file.session_id) {
        return Err("feedback_invalid");
    }
    if file.result_revision > MAX_SAFE_INTEGER {
        return Err("feedback_invalid");
    }
    let worktree_chars = file.worktree_path.chars().count();
    if !(1..=MAX_WORKTREE_CHARS).contains(&worktree_chars)
        || !is_absolute_worktree(&file.worktree_path)
        || file.worktree_path.chars().any(char::is_control)
    {
        return Err("feedback_invalid");
    }
    let range_chars = file.range_version.chars().count();
    if !(1..=MAX_RANGE_VERSION_CHARS).contains(&range_chars) || file.range_version.chars().any(char::is_control) {
        return Err("feedback_invalid");
    }
    if !is_lower_hex(&file.baseline_oid, 40) || !is_lower_hex(&file.head_oid, 40) {
        return Err("feedback_invalid");
    }
    if file.comments.is_empty() || file.comments.len() > MAX_COMMENTS {
        return Err("feedback_too_large");
    }
    let mut ids = HashSet::new();
    for comment in &file.comments {
        if !is_uuid(&comment.id) || !ids.insert(comment.id.as_str()) {
            return Err("feedback_invalid");
        }
        if !is_relative_repo_path(&comment.path) || !matches!(comment.kind.as_str(), "add" | "del" | "context") {
            return Err("feedback_invalid");
        }
        if comment.old_no.is_none() && comment.new_no.is_none() {
            return Err("feedback_invalid");
        }
        if !is_comment_body(&comment.body) {
            return Err("feedback_invalid");
        }
    }
    if !is_lower_hex(&file.digest, 64) {
        return Err("feedback_invalid");
    }
    if digest_of(file)? != file.digest {
        return Err("feedback_digest_mismatch");
    }
    Ok(())
}

/// 从固定交接目录读取并校验一次性文件；删除在暂存成功之后进行（见 consume_file）。
pub(crate) fn receive_file(link: &FeedbackLink) -> Result<FeedbackFile, &'static str> {
    let path = feedback_file_path(&link.feedback_id)?;
    if let Some(directory) = path.parent() {
        check_directory(directory)?;
    }
    read_from(&path, link)
}

/// 读取、校验并核对深链声明。独立出来便于用临时目录验证一次性与上限行为。
fn read_from(path: &Path, link: &FeedbackLink) -> Result<FeedbackFile, &'static str> {
    let bytes = read_file_bounded(path)?;
    let file: FeedbackFile = serde_json::from_slice(&bytes).map_err(|_| "feedback_invalid")?;
    validate_file(&file)?;
    // 深链只是索引：它声明的标识与 digest 必须就是文件里的那一批。
    if file.feedback_id != link.feedback_id
        || file.review_id != link.review_id
        || file.session_id != link.session_id
        || file.result_revision != link.result_revision
        || file.digest != link.digest
    {
        return Err("feedback_digest_mismatch");
    }
    Ok(file)
}

/// 文件已被读入内存后消费掉；失败时不保留暂存，保证同一文件不会被读第二次。
pub(crate) fn consume_file(feedback_id: &str) -> Result<(), &'static str> {
    consume_path(&feedback_file_path(feedback_id)?)
}

fn consume_path(path: &Path) -> Result<(), &'static str> {
    std::fs::remove_file(path).map_err(|_| "feedback_consume_failed")
}

fn canonical(path: &str) -> Option<PathBuf> {
    Path::new(path).canonicalize().ok()
}

/// 与当前来源核对：reviewId/sessionId、resultRevision、canonical worktree 与任务起点。
/// 旧结果、目录改变或来源失效都在这里失败，绝不创建替代会话。
pub(crate) fn check_source(file: &FeedbackFile, source: Option<&ReviewState>) -> Result<(), &'static str> {
    let source = source.ok_or("feedback_stale")?;
    if source.review_id != file.review_id || source.session_id != file.session_id {
        return Err("feedback_stale");
    }
    if source.result_revision != file.result_revision {
        return Err("feedback_stale");
    }
    if source.status != super::STATUS_RETURNED {
        return Err("feedback_stale");
    }
    if source.head_oid.is_some() && source.head_oid.as_deref() != Some(file.head_oid.as_str()) {
        return Err("feedback_stale");
    }
    if let Some(baseline) = source.baseline.as_deref() {
        if baseline != file.baseline_oid {
            return Err("feedback_stale");
        }
    }
    // 同一个工作树在不同写法下必须等价；任一路径无法解析时按字面比较（失败闭合）。
    let source_path = canonical(&source.worktree_path).unwrap_or_else(|| PathBuf::from(&source.worktree_path));
    let file_path = canonical(&file.worktree_path).unwrap_or_else(|| PathBuf::from(&file.worktree_path));
    if source_path != file_path {
        return Err("feedback_worktree_changed");
    }
    Ok(())
}

fn preview_of(file: &FeedbackFile, state: &str) -> FeedbackPreview {
    FeedbackPreview {
        feedback_id: file.feedback_id.clone(),
        review_id: file.review_id.clone(),
        session_id: file.session_id.clone(),
        result_revision: file.result_revision,
        worktree_path: file.worktree_path.clone(),
        range_version: file.range_version.clone(),
        comment_count: file.comments.len(),
        comments: file
            .comments
            .iter()
            .map(|comment| FeedbackCommentView {
                path: comment.path.clone(),
                kind: comment.kind.clone(),
                old_no: comment.old_no,
                new_no: comment.new_no,
                body: comment.body.clone(),
            })
            .collect(),
        state: state.to_owned(),
    }
}

impl FeedbackStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, StoreData> {
        self.data.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 同一 feedbackId 只暂存一次：已经出现过的标识（含已发送、已取消）都视为重复。
    pub(crate) fn stage(&self, file: FeedbackFile) -> Result<FeedbackPreview, &'static str> {
        let mut data = self.lock();
        if data.seen.contains(&file.feedback_id) {
            return Err("feedback_duplicate");
        }
        data.seen.insert(file.feedback_id.clone());
        let preview = preview_of(&file, "prepared");
        data.entries.insert(file.feedback_id.clone(), StagedFeedback { file, state: "prepared" });
        Ok(preview)
    }

    /// 这个标识是否已经接收过（含已发送与已取消），用于在读取文件之前就拒绝重复投递。
    pub(crate) fn is_known(&self, feedback_id: &str) -> bool {
        self.lock().seen.contains(feedback_id)
    }

    pub(crate) fn entry(&self, feedback_id: &str) -> Option<StagedFeedback> {
        self.lock().entries.get(feedback_id).cloned()
    }

    /// 记录一次成功写入。重复调用不改变状态，也不会再次写入。
    pub(crate) fn mark_written(&self, feedback_id: &str) -> Option<FeedbackPreview> {
        let mut data = self.lock();
        let entry = data.entries.get_mut(feedback_id)?;
        if entry.state == "prepared" {
            entry.state = "written";
        }
        Some(preview_of(&entry.file, entry.state))
    }

    /// 取消只清掉运行期暂存；标识仍保留在 seen 里，同一批不会被再次暂存。
    pub(crate) fn dismiss(&self, feedback_id: &str) -> bool {
        self.lock().entries.remove(feedback_id).is_some()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.lock().entries.len()
    }
}

/// 写进终端的正文：只含意见定位与内容，不含反馈 ID 之外的任何路径或凭据。
pub(crate) fn prompt_text(file: &FeedbackFile) -> String {
    let mut text = format!("Twiglane 审阅意见（共 {} 条）：\n\n", file.comments.len());
    for (index, comment) in file.comments.iter().enumerate() {
        let line = comment.new_no.or(comment.old_no).map(|line| line.to_string()).unwrap_or_else(|| "-".into());
        text.push_str(&format!("{}. {}:{} ({})\n{}\n\n", index + 1, comment.path, line, comment.kind, comment.body.trim_end()));
    }
    text
}

/// 命令层统一使用的稳定错误码。日志与界面只说原因，不回显正文。
pub(crate) fn api_error(code: &'static str) -> ApiError {
    let (message, action) = match code {
        "feedback_url_invalid" => ("这条审阅意见链接不完整。", "在 Twiglane 中重新准备送回原任务。"),
        "feedback_unsupported_version" => ("这条审阅意见链接的版本不受支持。", "更新两端应用后重新准备。"),
        "feedback_invalid" => ("审阅意见文件的结构不符合协议。", "在 Twiglane 中重新准备送回原任务。"),
        "feedback_too_large" => ("这批审阅意见超过了单次上限。", "减少意见条数或缩短内容后重新准备。"),
        "feedback_duplicate" => ("这批审阅意见已经接收过。", "在 Twiglane 中重新准备一批新的意见。"),
        "feedback_digest_mismatch" => ("审阅意见内容与链接声明的摘要不一致。", "在 Twiglane 中重新准备送回原任务。"),
        "feedback_read_failed" => ("无法读取本机审阅意见文件。", "确认文件权限后重新准备送回原任务。"),
        "feedback_consume_failed" => ("审阅意见文件没有成功标记为已读。", "重新准备送回原任务，避免重复使用同一批意见。"),
        "feedback_stale" => ("这批审阅意见对应的结果已经过期。", "回到 Twiglane 重新准备，不要发送旧意见。"),
        "feedback_worktree_changed" => ("会话所在的工作树与这批意见不符。", "确认原会话的工作树后重新准备。"),
        "feedback_unknown" => ("没有找到这批审阅意见的暂存内容。", "重新从 Twiglane 准备送回原任务。"),
        "feedback_already_sent" => ("这批审阅意见已经写入过终端一次。", "如需再次反馈，请在 Twiglane 重新准备。"),
        "feedback_session_closed" => ("原会话已经关闭，无法发送。", "重新开始一个会话并说明需要处理的意见。"),
        "feedback_session_ended" => ("原会话已经结束，不会自动恢复。", "使用现有恢复入口继续会话，再重新确认发送。"),
        "feedback_write_failed" => ("意见没有写入终端。", "确认会话仍在运行；不要自动重试，回到 Twiglane 重新准备。"),
        _ => ("反馈操作没有完成。", "确认会话和工作树状态后重试。"),
    };
    ApiError { code, message: message.into(), action, data_directory: None, remote: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEEDBACK_ID: &str = "8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1";
    const REVIEW_ID: &str = "6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8";
    const SESSION_ID: &str = "0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0";
    const DIGEST: &str = "082476955cbba23ba6e82c2eacfff6d59f82c347b088fdb2df0f426ee62c56fc";
    const FIXTURE: &str = include_str!("../../../tests/fixtures/reviews/protocol-feedback-v1.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).expect("protocol fixture parses")
    }

    fn link_url() -> String {
        format!("cliora://review-feedback?v=1&feedbackId={FEEDBACK_ID}&reviewId={REVIEW_ID}&sessionId={SESSION_ID}&resultRevision=2&digest={DIGEST}")
    }

    fn sample() -> FeedbackFile {
        let value = fixture();
        let batch = value["batches"].as_array().unwrap().iter().find(|batch| batch["name"] == "valid-two-comments").unwrap();
        serde_json::from_value(batch["file"].clone()).expect("valid batch parses")
    }

    fn source(file: &FeedbackFile) -> ReviewState {
        let mut state = super::super::new_review(&file.session_id, &file.worktree_path, Some(file.baseline_oid.clone()));
        state.review_id = file.review_id.clone();
        state.status = super::super::STATUS_RETURNED.into();
        state.result_revision = file.result_revision;
        state.outcome = Some("reviewed".into());
        state.head_oid = None;
        state
    }

    /// 用临时目录模拟一次性文件：目录 tempdir 已是当前用户独占，文件收紧到 0600。
    fn write_temp(directory: &Path, file: &FeedbackFile) -> PathBuf {
        let path = directory.join(format!("{}.json", file.feedback_id));
        std::fs::write(&path, serde_json::to_vec(file).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }

    #[test]
    fn the_fixture_urls_agree_with_strict_parsing() {
        let value = fixture();
        for case in value["urls"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let url = case["url"].as_str().unwrap();
            let parsed = parse_feedback_url(url);
            assert_eq!(parsed.is_ok(), case["valid"].as_bool().unwrap(), "fixture case {name}");
        }
    }

    #[test]
    fn a_valid_batch_passes_schema_validation_and_digest() {
        let file = sample();
        assert_eq!(file.feedback_id, FEEDBACK_ID);
        assert!(validate_file(&file).is_ok());
        assert_eq!(digest_of(&file).unwrap(), DIGEST);
        // 深链与文件必须描述同一批意见。
        let link = parse_feedback_url(&link_url()).unwrap();
        assert_eq!(link.feedback_id, FEEDBACK_ID);
        assert_eq!(link.result_revision, 2);
        assert_eq!(link.digest, DIGEST);
    }

    #[test]
    fn every_reject_batch_fails_at_the_stage_the_fixture_declares() {
        let value = fixture();
        for batch in value["batches"].as_array().unwrap() {
            if batch["reject"].is_null() {
                continue;
            }
            let name = batch["name"].as_str().unwrap();
            let expected = batch["reject"].as_str().unwrap();
            let decoded: Result<FeedbackFile, _> = serde_json::from_value(batch["file"].clone());
            let stage = match decoded {
                Err(_) => "schema",
                Ok(file) => match validate_file(&file) {
                    Ok(()) => "none",
                    Err("feedback_digest_mismatch") => "digest",
                    Err(_) => "validation",
                },
            };
            assert_eq!(stage, expected, "fixture batch {name}");
        }
    }

    #[test]
    fn a_private_file_is_read_once_and_deleted_after_staging() {
        let directory = tempfile::tempdir().unwrap();
        let file = sample();
        let path = write_temp(directory.path(), &file);
        let link = parse_feedback_url(&link_url()).unwrap();

        let read = read_from(&path, &link).expect("valid file is accepted");
        assert_eq!(read.comments.len(), 2);
        assert!(path.exists());

        let store = FeedbackStore::default();
        let preview = store.stage(read).expect("first staging succeeds");
        assert_eq!(preview.comment_count, 2);
        assert_eq!(preview.state, "prepared");
        consume_path(&path).expect("file is consumed");
        assert!(!path.exists());

        // 文件已消费，同一 feedbackId 既不能被再次暂存，也无法再读到文件。
        assert_eq!(store.stage(sample()).unwrap_err(), "feedback_duplicate");
        assert_eq!(read_from(&path, &link).unwrap_err(), "feedback_read_failed");
    }

    #[test]
    fn a_file_that_does_not_match_the_link_is_rejected_before_staging() {
        let directory = tempfile::tempdir().unwrap();
        let path = write_temp(directory.path(), &sample());
        let mut link = parse_feedback_url(&link_url()).unwrap();
        link.result_revision = 3;
        assert_eq!(read_from(&path, &link).unwrap_err(), "feedback_digest_mismatch");
        // 被拒的读取不删除文件：用户仍可在 Twiglane 重新准备。
        assert!(path.exists());
    }

    #[test]
    fn a_stale_revision_or_changed_worktree_is_rejected_without_a_replacement_session() {
        let file = sample();
        let mut current = source(&file);
        assert!(check_source(&file, Some(&current)).is_ok());
        assert_eq!(check_source(&file, None).unwrap_err(), "feedback_stale");

        current.result_revision = file.result_revision + 1;
        assert_eq!(check_source(&file, Some(&current)).unwrap_err(), "feedback_stale");

        let mut moved = source(&file);
        moved.worktree_path = "/work/other/demo".into();
        assert_eq!(check_source(&file, Some(&moved)).unwrap_err(), "feedback_worktree_changed");

        let mut accepted = source(&file);
        accepted.status = super::super::STATUS_ACCEPTED.into();
        assert_eq!(check_source(&file, Some(&accepted)).unwrap_err(), "feedback_stale");
    }

    #[test]
    fn a_changed_head_or_baseline_is_stale() {
        let mut file = sample();
        let mut current = source(&file);
        current.head_oid = Some(file.head_oid.clone());
        assert!(check_source(&file, Some(&current)).is_ok());
        current.head_oid = Some("d".repeat(40));
        assert_eq!(check_source(&file, Some(&current)).unwrap_err(), "feedback_stale");

        file.head_oid = "d".repeat(40);
        let mut accepted = source(&file);
        accepted.baseline = Some("e".repeat(40));
        assert_eq!(check_source(&file, Some(&accepted)).unwrap_err(), "feedback_stale");
    }

    #[test]
    fn marking_written_is_idempotent_and_keeps_the_batch_readable() {
        let store = FeedbackStore::default();
        store.stage(sample()).unwrap();
        let written = store.mark_written(FEEDBACK_ID).expect("staged batch is found");
        assert_eq!(written.state, "written");
        assert_eq!(store.mark_written(FEEDBACK_ID).unwrap().state, "written");
        assert_eq!(store.len(), 1);
        assert!(store.dismiss(FEEDBACK_ID));
        assert_eq!(store.len(), 0);
        // 取消之后同一标识仍然不能被重新暂存。
        assert_eq!(store.stage(sample()).unwrap_err(), "feedback_duplicate");
    }

    #[test]
    fn the_prompt_text_names_each_comment_without_extra_context() {
        let file = sample();
        let text = prompt_text(&file);
        assert!(text.starts_with("Twiglane 审阅意见（共 2 条）："));
        assert!(text.contains("1. src/lib/api.ts:13 (add)"));
        assert!(text.contains("2. src/lib/api.ts:14 (add)"));
        assert!(!text.contains(FEEDBACK_ID));
    }

    #[test]
    fn a_world_readable_file_or_a_symlinked_target_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let file = sample();
        let path = write_temp(directory.path(), &file);
        let link = parse_feedback_url(&link_url()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(read_from(&path, &link).unwrap_err(), "feedback_read_failed");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            // 指向真实文件的符号链接不能作为交接文件被跟随。
            let link_path = directory.path().join("link.json");
            std::os::unix::fs::symlink(&path, &link_path).unwrap();
            assert_eq!(read_from(&link_path, &link).unwrap_err(), "feedback_read_failed");
        }
        #[cfg(not(unix))]
        {
            let link_path = directory.path().join("link.json");
            assert!(std::fs::copy(&path, &link_path).is_ok());
            assert!(read_from(&link_path, &link).is_ok());
        }
    }
}
