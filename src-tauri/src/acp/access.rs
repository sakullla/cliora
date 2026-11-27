//! Out-of-directory approval, session grants and YOLO.
//!
//! The file-system and terminal capabilities serve paths inside the session
//! directory directly. Anything outside goes through this module, in a fixed
//! order:
//!
//! 1. A hard refusal (Cliora's own data, devices, non-regular files) is decided
//!    by `safe_fs` before this module is reached; no grant changes it.
//! 2. A YOLO session, or a category the user already allowed for this session,
//!    is approved at once and recorded in the timeline.
//! 3. Otherwise an approval card is opened and the request waits for the
//!    user's answer: allow once, allow for this session, or deny.
//!
//! A card is bound to the turn that asked for it and shares the authorization
//! cards' withdrawal rules: stopping the turn, the turn ending or the session
//! ending withdraws it and the agent is refused. An answer for a card that is
//! no longer pending is rejected.

use std::sync::mpsc::{channel, Sender};

use serde_json::{json, Value};

use super::timeline::{AcpAccess, AcpFileDiff, AcpTimelineItem};
use super::{guard, AcpUpdate, Session};

/// What an access does.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessKind {
    Read,
    Write,
    Execute,
}

impl AccessKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Execute => "execute",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "execute" => Some(Self::Execute),
            _ => None,
        }
    }
}

/// The categories allowed for the rest of this session. Memory only: a new
/// session asks again.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Grants {
    pub read: bool,
    pub write: bool,
    pub execute: bool,
}

impl Grants {
    pub fn has(&self, kind: AccessKind) -> bool {
        match kind {
            AccessKind::Read => self.read,
            AccessKind::Write => self.write,
            AccessKind::Execute => self.execute,
        }
    }

    pub fn set(&mut self, kind: AccessKind, value: bool) {
        match kind {
            AccessKind::Read => self.read = value,
            AccessKind::Write => self.write = value,
            AccessKind::Execute => self.execute = value,
        }
    }

    /// The granted categories, in a fixed order, as the snapshot publishes them.
    pub fn list(&self) -> Vec<&'static str> {
        [AccessKind::Read, AccessKind::Write, AccessKind::Execute]
            .into_iter()
            .filter(|kind| self.has(*kind))
            .map(AccessKind::as_str)
            .collect()
    }
}

/// The user's answer to an approval card.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccessAnswer {
    Once,
    Session,
    Deny,
    /// The card was taken away (stop, turn end, session end).
    Withdrawn,
}

impl AccessAnswer {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "once" | "allow_once" => Some(Self::Once),
            "session" | "allow_session" => Some(Self::Session),
            "deny" | "reject" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// An approval card still waiting for its answer.
pub(crate) struct PendingAccess {
    pub request_id: String,
    pub item_id: String,
    pub turn_id: String,
    pub kind: AccessKind,
    pub sender: Sender<AccessAnswer>,
}

/// The refusal an agent receives when an access is not allowed.
pub const DENIED: &str = "用户拒绝了目录外的访问";
pub const WITHDRAWN: &str = "目录外访问的审批已撤回（轮次已结束或已停止）";

impl Session {
    pub(super) fn access_pending_ids(&self) -> Vec<String> {
        guard(&self.accesses).iter().map(|pending| pending.request_id.clone()).collect()
    }

    /// Record an access in the timeline and return its item.
    fn record_access(&self, entry: AcpAccess) -> AcpTimelineItem {
        let _order = self.order();
        let item = AcpTimelineItem::Access(entry);
        guard(&self.timeline).upsert(item.clone());
        self.emit_update(AcpUpdate::Item { item: item.clone() });
        item
    }

    fn access_entry(&self, id: &str) -> Option<AcpAccess> {
        match guard(&self.timeline).get(id) {
            Some(AcpTimelineItem::Access(entry)) => Some(entry.clone()),
            _ => None,
        }
    }

    /// Record an access the session directory already covers. Only writes are
    /// recorded (with their diff); reads inside the directory stay quiet.
    pub(super) fn record_inside(&self, kind: AccessKind, subagent: Option<&str>, path: &str, detail: Option<String>) -> String {
        let id = guard(&self.timeline).auto_id("access");
        self.record_access(AcpAccess {
            id: id.clone(),
            access_kind: kind.as_str(),
            path: path.to_owned(),
            detail,
            decision: "inside",
            request_id: None,
            diff: None,
            turn_id: self.current_turn_id(),
            subagent: subagent.map(ToOwned::to_owned),
        });
        id
    }

    /// Attach the diff a write produced to its access record.
    pub(super) fn attach_diff(&self, item_id: &str, diff: AcpFileDiff) {
        let _order = self.order();
        if let Some(mut entry) = self.access_entry(item_id) {
            entry.diff = Some(diff);
            self.record_access(entry);
        }
    }

    /// Decide an access outside the session directory. Blocks the calling
    /// worker (never the protocol reader) until the user answers a card.
    /// Returns the access record's id when allowed.
    pub(super) fn authorize_outside(
        &self,
        kind: AccessKind,
        subagent: Option<&str>,
        path: &str,
        detail: Option<String>,
    ) -> Result<String, String> {
        let automatic = if self.yolo {
            Some("yolo")
        } else if guard(&self.grants).has(kind) {
            Some("granted")
        } else {
            None
        };
        if let Some(decision) = automatic {
            let turn_id = self.current_turn_id();
            let id = guard(&self.timeline).auto_id("access");
            self.record_access(AcpAccess {
                id: id.clone(),
                access_kind: kind.as_str(),
                path: path.to_owned(),
                detail,
                decision,
                request_id: None,
                diff: None,
                turn_id,
                subagent: subagent.map(ToOwned::to_owned),
            });
            return Ok(id);
        }
        let (sender, receiver) = channel();
        let id = guard(&self.timeline).auto_id("access");
        let request_id = format!("{id}-request");
        // Decide and register under the turn lock. A stop, a turn end or a
        // session end changes the turn first and withdraws cards after, so it
        // either finds this card and withdraws it, or ran before and the card
        // is never opened: no card can outlive the turn that asked for it.
        let opened = {
            let turn = guard(&self.turn);
            let turn_id = turn.as_ref().map(|turn| turn.id.clone()).unwrap_or_default();
            let cancelled = turn.as_ref().is_some_and(|turn| turn.cancel_requested);
            let ended = guard(&self.writer).is_none();
            // Like an authorization card, the conversation's own request needs
            // a live turn that was not stopped; a child's may arrive between
            // turns.
            if cancelled || ended || (turn_id.is_empty() && subagent.is_none()) {
                Err(turn_id)
            } else {
                guard(&self.accesses).push(PendingAccess {
                    request_id: request_id.clone(),
                    item_id: id.clone(),
                    turn_id: turn_id.clone(),
                    kind,
                    sender,
                });
                Ok(turn_id)
            }
        };
        let turn_id = match opened {
            Ok(turn_id) => turn_id,
            Err(turn_id) => {
                self.record_access(AcpAccess {
                    id,
                    access_kind: kind.as_str(),
                    path: path.to_owned(),
                    detail,
                    decision: "withdrawn",
                    request_id: None,
                    diff: None,
                    turn_id,
                    subagent: subagent.map(ToOwned::to_owned),
                });
                return Err(WITHDRAWN.into());
            }
        };
        // An answer that arrives before the card is recorded is kept by the
        // channel; the record below is then updated with it.
        let entry = AcpAccess {
            id: id.clone(),
            access_kind: kind.as_str(),
            path: path.to_owned(),
            detail,
            decision: "pending",
            request_id: Some(request_id),
            diff: None,
            turn_id,
            subagent: subagent.map(ToOwned::to_owned),
        };
        self.record_access(entry);
        self.emit_pending();
        self.settle_state();
        let answer = receiver.recv().unwrap_or(AccessAnswer::Withdrawn);
        let decision = match answer {
            AccessAnswer::Once => "allowed_once",
            AccessAnswer::Session => "allowed_session",
            AccessAnswer::Deny => "denied",
            AccessAnswer::Withdrawn => "withdrawn",
        };
        let _order = self.order();
        if let Some(mut entry) = self.access_entry(&id) {
            entry.decision = decision;
            entry.request_id = None;
            self.record_access(entry);
        }
        match answer {
            AccessAnswer::Once | AccessAnswer::Session => Ok(id),
            AccessAnswer::Deny => Err(DENIED.into()),
            AccessAnswer::Withdrawn => Err(WITHDRAWN.into()),
        }
    }

    /// Answer one approval card. The card is consumed, so a second answer — or
    /// an answer after the card was withdrawn — is rejected.
    pub(super) fn respond_access(&self, access_id: &str, answer: AccessAnswer) -> Result<(), String> {
        if answer == AccessAnswer::Withdrawn {
            return Err("无效的审批答复".into());
        }
        let pending = {
            let mut accesses = guard(&self.accesses);
            let index = accesses
                .iter()
                .position(|item| item.request_id == access_id || item.item_id == access_id)
                .ok_or("该审批已失效或已回答")?;
            accesses.remove(index)
        };
        let mut released = Vec::new();
        if answer == AccessAnswer::Session {
            guard(&self.grants).set(pending.kind, true);
            // Other cards of the same category are covered by the new grant.
            let mut accesses = guard(&self.accesses);
            let (same, other): (Vec<_>, Vec<_>) =
                std::mem::take(&mut *accesses).into_iter().partition(|item| item.kind == pending.kind);
            *accesses = other;
            released = same;
        }
        let _ = pending.sender.send(answer);
        for item in released {
            let _ = item.sender.send(AccessAnswer::Session);
        }
        self.emit_pending();
        self.settle_state();
        Ok(())
    }

    /// Withdraw every card that matches `filter` and refuse its request.
    /// Returns whether anything was withdrawn; the caller publishes the
    /// pending set.
    pub(super) fn withdraw_accesses(&self, filter: impl Fn(&PendingAccess) -> bool) -> bool {
        let dropped: Vec<PendingAccess> = {
            let mut accesses = guard(&self.accesses);
            let (dropped, kept) = std::mem::take(&mut *accesses).into_iter().partition(|item| filter(item));
            *accesses = kept;
            dropped
        };
        let withdrew = !dropped.is_empty();
        for pending in dropped {
            let _ = pending.sender.send(AccessAnswer::Withdrawn);
        }
        withdrew
    }

    /// Revoke session grants; the next access of that category asks again.
    pub(super) fn revoke_grants(&self, kinds: &[AccessKind]) {
        {
            let mut grants = guard(&self.grants);
            for kind in kinds {
                grants.set(*kind, false);
            }
        }
        self.publish();
    }

    /// YOLO answers an authorization request with the first allow-once
    /// option only. An allow-always option is never chosen for the user: the
    /// agent could persist it as a rule that a later, ordinary session would
    /// then skip. A request without an allow-once option is left for the user.
    pub(super) fn yolo_option(options: &[super::AcpPermissionOption]) -> Option<&super::AcpPermissionOption> {
        options.iter().find(|option| option.kind == "allow_once")
    }

    /// The error frame a refused client request receives.
    pub(super) fn answer_error(&self, id: &Value, code: i64, message: &str) {
        let _ = self.write_value(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    pub(super) fn answer_result(&self, id: &Value, result: Value) {
        let _ = self.write_value(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }
}
