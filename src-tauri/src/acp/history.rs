//! The agent's own session history: `session/list` and `session/delete`,
//! asked over an open conversation's connection.
//!
//! Each call is made only when the agent declared the matching session
//! capability; otherwise it is refused with the reason. Continuing a listed
//! session is a new launch (`resumeNativeId`), not something done here, so the
//! open conversation is never replaced underneath its view.

use serde::Serialize;
use serde_json::{json, Value};

use super::timeline::cap;
use super::{guard, Session};

/// The most sessions one page keeps.
const MAX_SESSIONS: usize = 200;

/// One session the agent knows about.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpNativeSession {
    /// The agent's own session id: what `resumeNativeId` continues.
    pub native_id: String,
    pub title: Option<String>,
    /// ISO 8601, as the agent reported it.
    pub updated_at: Option<String>,
    pub cwd: Option<String>,
    /// This is the conversation the list was asked from.
    pub current: bool,
}

/// One page of the agent's session history.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AcpNativeSessionPage {
    pub sessions: Vec<AcpNativeSession>,
    /// Pass back to fetch the next page; none at the end.
    pub next_cursor: Option<String>,
}

fn text(value: Option<&Value>, limit: usize) -> Option<String> {
    value.and_then(Value::as_str).map(|text| cap(text, limit).0)
}

/// Read a `session/list` answer, keeping only well-formed entries.
pub(crate) fn parse_page(result: &Value, current: Option<&str>) -> AcpNativeSessionPage {
    let sessions = result
        .get("sessions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let native_id = text(item.get("sessionId"), 500)?;
                    Some(AcpNativeSession {
                        current: current == Some(native_id.as_str()),
                        native_id,
                        title: text(item.get("title"), 300),
                        updated_at: text(item.get("updatedAt"), 100),
                        cwd: text(item.get("cwd"), 4_096),
                    })
                })
                .take(MAX_SESSIONS)
                .collect()
        })
        .unwrap_or_default();
    AcpNativeSessionPage {
        sessions,
        next_cursor: text(result.get("nextCursor"), 4_096).filter(|cursor| !cursor.is_empty()),
    }
}

impl Session {
    /// `session/list` for this session's directory, one page at a time.
    pub(super) fn native_sessions(&self, cursor: Option<&str>) -> Result<AcpNativeSessionPage, String> {
        if !guard(&self.agent).session_capabilities.list {
            return Err("该 agent 没有声明会话列表能力（sessionCapabilities.list），无法列出历史会话".into());
        }
        let cwd = crate::launch::terminal_path(&self.directory)?;
        let mut params = json!({ "cwd": cwd });
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            params["cursor"] = Value::String(cursor.to_owned());
        }
        let result = self.request("session/list", params).map_err(|error| format!("无法列出历史会话：{error}"))?;
        let current = guard(&self.native_session_id).clone();
        Ok(parse_page(&result, current.as_deref()))
    }

    /// `session/delete` for one listed session. The conversation's own
    /// session is not deleted from under it. A "not found" answer means it is
    /// already gone, which is what the user asked for.
    pub(super) fn delete_native_session(&self, native_id: &str) -> Result<(), String> {
        if !guard(&self.agent).session_capabilities.delete {
            return Err("该 agent 没有声明删除会话能力（sessionCapabilities.delete），无法删除".into());
        }
        if native_id.trim().is_empty() {
            return Err("缺少要删除的会话编号".into());
        }
        if guard(&self.native_session_id).as_deref() == Some(native_id) {
            return Err("不能删除当前正在使用的会话".into());
        }
        match self.request_raw("session/delete", json!({ "sessionId": native_id }), self.timeout) {
            Ok(_) => Ok(()),
            Err(error) if error.code == Some(-32002) => Ok(()),
            Err(error) => Err(format!("删除历史会话失败：{}", error.message)),
        }
    }
}
