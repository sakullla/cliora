use super::{CodeStatus, LinkEvent, LinkOutcome, ReviewRegistry, ReviewState};
use crate::database::Database;
use crate::launch::RemoteSessionIndexEntry;
use crate::remote::twiglane_review::Binding;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LIMIT: usize = 8192;
const REASONS: &[&str] = &[
    "open_failed",
    "target_changed",
    "invalid_path",
    "not_a_worktree",
    "cancelled",
    "busy",
    "invalid_baseline",
];
pub(crate) fn id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.hyphenated().to_string() == value)
}
fn hex(value: &str) -> bool {
    value
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && hex(value)
}
pub(crate) fn receipt_revision(value: &str) -> Option<u64> {
    let revision = value.parse::<u64>().ok()?;
    (revision > 0 && revision <= 9_007_199_254_740_991 && value == revision.to_string())
        .then_some(revision)
}

pub(crate) fn windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

pub(crate) fn path(value: &str) -> bool {
    if value.chars().any(char::is_control) {
        return false;
    }
    let suffix = if let Some(suffix) = value.strip_prefix('/') {
        suffix
    } else if windows_path(value) {
        &value[3..]
    } else {
        return false;
    };
    let windows = windows_path(value);
    suffix.is_empty()
        || suffix.split(|c| c == '/' || (windows && c == '\\')).all(|part| {
            !matches!(part, "" | "." | "..")
                && (!windows || !part.contains([':', '<', '>', '"', '|', '?', '*']))
        })
}

fn store_result(conn: &Connection, state: &ReviewState) -> Result<(), String> {
    let binding = state.remote_binding.as_ref().ok_or("missing review binding")?;
    let outcome = state.outcome.as_deref().ok_or("missing review outcome")?;
    let worktree = state.worktree_state.as_deref().ok_or("missing worktree state")?;
    let revision = i64::try_from(state.result_revision).map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO twiglane_remote_review_results
         (review_id, session_id, result_revision, target_id, outcome, head_oid, worktree_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(review_id, session_id, result_revision) DO NOTHING",
        params![state.review_id, state.session_id, revision, binding.target_id, outcome, state.head_oid, worktree],
    ).map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn stored_result(
    db: &Database,
    review_id: &str,
    session_id: &str,
    revision: u64,
) -> Result<bool, String> {
    db.with_read_connection(|conn| has_result(conn, review_id, session_id, revision))
}

fn has_result(conn: &Connection, review_id: &str, session_id: &str, revision: u64) -> Result<bool, String> {
    let revision = i64::try_from(revision).map_err(|err| err.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM twiglane_remote_review_results
         WHERE review_id = ?1 AND session_id = ?2 AND result_revision = ?3)",
        params![review_id, session_id, revision],
        |row| row.get(0),
    ).map_err(|err| err.to_string())
}

#[derive(Serialize, Deserialize)]
struct StoredSource {
    state: ReviewState,
    binding: Binding,
    verified_head: Option<String>,
}

fn save_source(state: &ReviewState) -> Result<String, String> {
    let binding = state.remote_binding.as_ref().ok_or("missing review binding")?;
    serde_json::to_string(&StoredSource {
        state: state.clone(),
        binding: binding.clone(),
        verified_head: state.verified_head.clone(),
    }).map_err(|err| err.to_string())
}

fn read_source(value: String) -> Result<ReviewState, String> {
    let StoredSource { mut state, binding, verified_head } =
        serde_json::from_str(&value).map_err(|err| err.to_string())?;
    state.remote_binding = Some(binding);
    state.verified_head = verified_head;
    Ok(state)
}

pub(crate) fn publish(
    db: &Database,
    state: ReviewState,
    open: impl FnOnce() -> Result<(), ()>,
) -> Result<ReviewState, String> {
    let binding = state.remote_binding.as_ref().ok_or("missing review binding")?;
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO twiglane_remote_review_sources
             (review_id, session_id, target_id, remote_session_id, state)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![state.review_id, state.session_id, binding.target_id, binding.remote_session, save_source(&state)?],
        ).map_err(|err| err.to_string())?;
        Ok(())
    })?;
    if open().is_err() {
        let removed = db.with_connection(|conn| {
            conn.execute(
                "DELETE FROM twiglane_remote_review_sources WHERE review_id = ?1 AND json_extract(state, '$.state.status') = 'opening'",
                [&state.review_id],
            ).map_err(|err| err.to_string())
        })?;
        if removed > 0 { return Err("open_failed".into()); }
    }
    db.with_read_connection(|conn| latest_source(conn, &binding.target_id, &binding.remote_session))?
        .ok_or_else(|| "open_failed".into())
}

fn latest_source(conn: &Connection, target_id: &str, remote_session: &str) -> Result<Option<ReviewState>, String> {
    conn.query_row(
        "SELECT state FROM twiglane_remote_review_sources
         WHERE target_id = ?1 AND remote_session_id = ?2 ORDER BY position DESC LIMIT 1",
        params![target_id, remote_session],
        |row| row.get::<_, String>(0),
    ).optional().map_err(|err| err.to_string())?.map(read_source).transpose()
}

pub(crate) fn source_for_origin(db: &Database, origin: &RemoteSessionIndexEntry) -> Result<Option<ReviewState>, String> {
    let latest = db.with_read_connection(|conn| latest_source(conn, &origin.target_id, &origin.remote_session_id))?;
    Ok(latest.filter(|state| state.remote_binding.as_ref().is_some_and(|binding| binding.matches_origin(origin))))
}

pub(crate) fn source_for_session(db: &Database, session_id: &str) -> Result<Option<ReviewState>, String> {
    db.with_read_connection(|conn| {
        conn.query_row(
            "SELECT r.state FROM twiglane_remote_review_sources r
             WHERE r.session_id = ?1 AND r.position = (
               SELECT MAX(latest.position) FROM twiglane_remote_review_sources latest
               WHERE latest.target_id = r.target_id AND latest.remote_session_id = r.remote_session_id
             ) ORDER BY r.position DESC LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|err| err.to_string())?.map(read_source).transpose()
    })
}

fn current_source(
    conn: &Connection,
    review_id: &str,
    session_id: &str,
) -> Result<Result<ReviewState, &'static str>, String> {
    let row = conn.query_row(
        "SELECT r.state, NOT EXISTS(
           SELECT 1 FROM twiglane_remote_review_sources newer
           WHERE newer.target_id = r.target_id AND newer.remote_session_id = r.remote_session_id AND newer.position > r.position
         ) FROM twiglane_remote_review_sources r WHERE r.review_id = ?1 AND r.session_id = ?2",
        params![review_id, session_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
    ).optional().map_err(|err| err.to_string())?;
    match row {
        Some((value, true)) => read_source(value).map(Ok),
        Some((_, false)) => Ok(Err("superseded_review")),
        None => Ok(Err("unknown_review")),
    }
}

fn update_source(conn: &Connection, state: &ReviewState) -> Result<(), String> {
    conn.execute(
        "UPDATE twiglane_remote_review_sources SET state = ?1 WHERE review_id = ?2",
        params![save_source(state)?, state.review_id],
    ).map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn apply_event(db: &Database, event: LinkEvent) -> Result<(LinkOutcome, Option<ReviewState>), String> {
    let (review_id, session_id) = match &event {
        LinkEvent::Remote { event, .. } => match event.as_ref() {
            LinkEvent::Opening { review_id, session_id }
            | LinkEvent::Accepted { review_id, session_id }
            | LinkEvent::Rejected { review_id, session_id, .. }
            | LinkEvent::Returned { review_id, session_id, .. } => (review_id, session_id),
            _ => return Ok((LinkOutcome::ignored("malformed_request"), None)),
        },
        _ => return Ok((LinkOutcome::ignored("malformed_request"), None)),
    };
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let current = match current_source(&tx, review_id, session_id)? {
            Ok(current) => current,
            Err(reason) => return Ok((LinkOutcome::ignored(reason), None)),
        };
        let registry = ReviewRegistry::default();
        registry.begin(current);
        let mut outcome = registry.apply(event.clone());
        let mut pending = None;
        if outcome.kind != "ignored" {
            let updated = registry.latest_for_session(session_id).ok_or("missing review source")?;
            update_source(&tx, &updated)?;
            if outcome.kind == "returned" { pending = Some(updated); }
        } else if outcome.reason.as_deref() == Some("duplicate_result") {
            if let Some(source) = registry.remote_return_retry(&event) {
                if !has_result(&tx, review_id, session_id, source.result_revision)? {
                    outcome = LinkOutcome {
                        remote_target_id: source.remote_binding.as_ref().map(|binding| binding.target_id.clone()),
                        kind: "returned".into(),
                        session_id: Some(source.session_id.clone()),
                        review_id: Some(source.review_id.clone()),
                        outcome: source.outcome.clone(),
                        head_oid: source.head_oid.clone(),
                        worktree_state: source.worktree_state.clone(),
                        reason: None,
                    };
                    pending = Some(source);
                }
            }
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok((outcome, pending))
    })
}

pub(crate) fn verify_return(db: &Database, source: &ReviewState, status: CodeStatus) -> Result<bool, String> {
    db.with_connection(|conn| {
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        let Ok(current) = current_source(&tx, &source.review_id, &source.session_id)? else {
            return Ok(false);
        };
        let registry = ReviewRegistry::default();
        registry.begin(current);
        if !registry.checked_remote_return(source, status, |entry| store_result(&tx, entry))? {
            return Ok(false);
        }
        let checked = registry.latest_for_session(&source.session_id).ok_or("missing review source")?;
        update_source(&tx, &checked)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(true)
    })
}
pub(super) fn request(state: &ReviewState) -> Result<String, &'static str> {
    let source = state.remote_binding.as_ref().ok_or("target_changed")?;
    if !id(&state.review_id)
        || !id(&state.session_id)
        || !path(&state.worktree_path)
        || source.target_id.is_empty()
        || source.target_id.chars().any(char::is_control)
        || [
            &source.target_revision,
            &source.peer_revision,
            &source.peer_identity,
            &source.worktree_identity,
        ]
        .iter()
        .any(|v| v.len() != 64 || !hex(v))
        || state.baseline.as_ref().is_some_and(|v| !oid(v))
    {
        return Err("invalid_path");
    }
    let mut url = url::Url::parse("twiglane://remote-review").expect("static URL");
    {
        let mut q = url.query_pairs_mut();
        for (key, value) in [
            ("v", "1"),
            ("reviewId", &state.review_id),
            ("sessionId", &state.session_id),
            ("targetId", &source.target_id),
            ("targetRevision", &source.target_revision),
            ("peerRevision", &source.peer_revision),
            ("peerIdentity", &source.peer_identity),
            ("worktreePath", &state.worktree_path),
            ("worktreeIdentity", &source.worktree_identity),
        ] {
            q.append_pair(key, value);
        }
        if let Some(base) = &state.baseline {
            q.append_pair("baseline", base);
        }
    }
    if url.as_str().len() > LIMIT {
        return Err("path_too_long");
    }
    Ok(url.into())
}

pub(super) fn is_event_url(raw: &str) -> bool {
    raw.starts_with("cliora://remote-review?") || raw.starts_with("cliora://remote-review/?")
}

pub(super) fn event(raw: &str) -> Result<LinkEvent, &'static str> {
    const BAD: &str = "malformed_request";
    if raw.len() > LIMIT
        || !is_event_url(raw)
        || raw.contains('#')
        || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(BAD);
    }
    let url = url::Url::parse(raw).map_err(|_| BAD)?;
    let mut q = BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if q.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(BAD);
        }
    }
    let version = q.remove("v");
    if version.as_deref() != Some("1") {
        return Err("unsupported_version");
    }
    let kind = q.remove("event").ok_or(BAD)?;
    let review_id = q.remove("reviewId").filter(|v| id(v)).ok_or(BAD)?;
    let session_id = q.remove("sessionId").filter(|v| id(v)).ok_or(BAD)?;
    let mut revision = None;
    let event = match kind.as_str() {
        "opening" => LinkEvent::Opening {
            review_id,
            session_id,
        },
        "accepted" => LinkEvent::Accepted {
            review_id,
            session_id,
        },
        "rejected" => LinkEvent::Rejected {
            review_id,
            session_id,
            reason: q
                .remove("reason")
                .filter(|s| REASONS.contains(&s.as_str()))
                .ok_or(BAD)?,
        },
        "returned" => {
            let seq = q.remove("resultRevision").ok_or(BAD)?;
            let seqnum = receipt_revision(&seq).ok_or(BAD)?;
            revision = Some(seqnum);
            let outcome = q
                .remove("outcome")
                .filter(|s| matches!(s.as_str(), "reviewed" | "committed" | "merged"))
                .ok_or(BAD)?;
            let head_oid = q.remove("headOid");
            if head_oid.as_deref().is_some_and(|s| !oid(s))
                || (matches!(outcome.as_str(), "committed" | "merged") && head_oid.is_none())
            {
                return Err(BAD);
            }
            let worktree_state = q
                .remove("worktreeState")
                .filter(|s| matches!(s.as_str(), "clean" | "dirty" | "unknown"))
                .ok_or(BAD)?;
            LinkEvent::Returned {
                review_id,
                session_id,
                outcome,
                head_oid,
                worktree_state,
                meta: BTreeMap::new(),
            }
        }
        _ => return Err(BAD),
    };
    if !q.is_empty() {
        return Err(BAD);
    }
    Ok(LinkEvent::Remote {
        event: Box::new(event),
        result_revision: revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::twiglane::{new_review, CodeStatus, ReviewRegistry};

    #[test]
    fn shared_remote_review_request_and_event_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/reviews/remote-protocol-v1.json"
        ))
        .unwrap();
        for case in fixtures["events"].as_array().unwrap() {
            let result = event(case["url"].as_str().unwrap());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let expected = url::Url::parse(fixtures["requests"][0]["url"].as_str().unwrap()).unwrap();
        let fields: BTreeMap<_, _> = expected.query_pairs().collect();
        let mut state = new_review(
            &fields["sessionId"],
            &fields["worktreePath"],
            Some(fields["baseline"].to_string()),
        );
        state.review_id = fields["reviewId"].to_string();
        state.protocol_version = 1;
        state.remote_binding = Some(crate::remote::twiglane_review::Binding {
            target_id: fields["targetId"].to_string(),
            target_revision: fields["targetRevision"].to_string(),
            peer_revision: fields["peerRevision"].to_string(),
            peer_identity: fields["peerIdentity"].to_string(),
            worktree_identity: fields["worktreeIdentity"].to_string(),
            remote_session: "cliora-fixture".into(),
            project_id: "fixture-project".into(),
            tool_id: "codex".into(),
            directory: fields["worktreePath"].to_string(),
            worktree_key: "f".repeat(64),
        });
        let actual = url::Url::parse(&request(&state).unwrap()).unwrap();
        assert_eq!(actual.host_str(), expected.host_str());
        assert_eq!(actual.query_pairs().collect::<BTreeMap<_, _>>(), fields);
    }

    #[test]
    fn remote_source_checks_identity_ordering_and_the_revision_of_a_completed_read() {
        let session = "998aaaaa-1111-4222-8333-444444444444";
        let mut state = new_review(session, "/srv/仓库 #one", Some("a".repeat(64)));
        state.protocol_version = 1;
        state.remote_binding = Some(crate::remote::twiglane_review::Binding {
            target_id: "build-b".into(),
            target_revision: "b".repeat(64),
            peer_revision: "c".repeat(64),
            peer_identity: "d".repeat(64),
            remote_session: "cliora-pane".into(),
            project_id: "p".into(),
            tool_id: "codex".into(),
            directory: "/srv/仓库 #one".into(),
            worktree_key: "e".repeat(64),
            worktree_identity: "f".repeat(64),
        });
        let url = url::Url::parse(&request(&state).unwrap()).unwrap();
        let args: BTreeMap<_, _> = url.query_pairs().collect();
        assert_eq!(args["worktreePath"], "/srv/仓库 #one");
        assert_eq!(args["peerIdentity"], "d".repeat(64));
        assert_eq!(args["worktreeIdentity"], "f".repeat(64));
        let registry = ReviewRegistry::default();
        let base = format!(
            "cliora://remote-review?v=1&reviewId={}&sessionId={session}",
            state.review_id
        );
        registry.publish(state, || Ok(())).unwrap();
        assert!(event(&format!("{base}&event=accepted&v=1")).is_err());
        assert!(event(&format!(
            "{base}&event=returned&outcome=committed&worktreeState=clean&resultRevision=1"
        ))
        .is_err());
        assert_eq!(
            registry
                .apply(event(&format!("{base}&event=opening")).unwrap())
                .kind,
            "opening"
        );
        assert_eq!(
            registry
                .apply(event(&format!("{base}&event=accepted")).unwrap())
                .kind,
            "accepted"
        );
        assert_eq!(
            registry
                .apply(event(&format!("{base}&event=opening")).unwrap())
                .kind,
            "ignored"
        );
        let returned = format!(
            "{base}&event=returned&outcome=reviewed&worktreeState=dirty&headOid={}",
            "e".repeat(64)
        );
        let r1 = registry.apply(event(&format!("{returned}&resultRevision=1")).unwrap());
        assert_eq!(r1.remote_target_id.as_deref(), Some("build-b"));
        let first = registry.latest_for_session(session).unwrap();
        assert_eq!(
            registry
                .apply(event(&format!("{returned}&resultRevision=2")).unwrap())
                .kind,
            "returned"
        );
        assert!(!registry
            .checked_remote_return(&first, CodeStatus::unknown(session, None, "read_failed"), |_| panic!("stale result must not persist"))
            .unwrap());
        assert_eq!(
            registry
                .apply(event(&format!("{returned}&resultRevision=1")).unwrap())
                .kind,
            "ignored"
        );
        assert_eq!(
            registry
                .apply(event(&format!("{base}&event=rejected&reason=cancelled")).unwrap())
                .kind,
            "ignored"
        );
        let latest = registry.latest_for_session(session).unwrap();
        assert!(registry.checked_remote_return(
            &latest,
            CodeStatus::unknown(session, None, "target_changed"),
            |_| panic!("unverified result must not persist"),
        ).unwrap());
        assert_eq!(
            registry
                .latest_for_session(session)
                .unwrap()
                .remote_check
                .unwrap()
                .reason
                .as_deref(),
            Some("target_changed")
        );
    }

    #[test]
    fn windows_review_survives_restart_and_retries_only_the_same_return() {
        let session = "998aaaaa-1111-4222-8333-444444444444";
        let root = "D:/目录 with spaces/linked";
        let mut review = new_review(session, root, Some("a".repeat(40)));
        review.protocol_version = 1;
        let db_directory = tempfile::tempdir().unwrap();
        let database_file = db_directory.path().join("review.sqlite");
        let database = Database::open(&database_file).unwrap();
        let target = crate::remote::save_target(&database, crate::remote::RemoteTarget {
            id: String::new(), name: "Fixture".into(), host: "example.test".into(),
            user: "git".into(), port: 22, auth_method: "key".into(),
            identity_file: None, ssh_config: None, default_path: None,
            enabled: true, created_at: 0, updated_at: 0,
        }).unwrap();
        review.remote_binding = Some(Binding {
            target_id: target.id.clone(),
            target_revision: "a".repeat(64), peer_revision: "b".repeat(64),
            peer_identity: "c".repeat(64), remote_session: "cliora-windows".into(),
            project_id: "windows".into(), tool_id: "codex".into(), directory: root.into(),
            worktree_identity: "d".repeat(64), worktree_key: "e".repeat(64),
        });
        let url = url::Url::parse(&request(&review).unwrap()).unwrap();
        assert_eq!(url.query_pairs().find(|(key, _)| key == "worktreePath").unwrap().1, root);
        for invalid in ["C:relative", "C://strip", "C:/../other", "C:/dir:stream", "C:/dir\\..\\elsewhere"] {
            assert!(!path(invalid), "{invalid}");
        }
        let origin = RemoteSessionIndexEntry {
            remote_session_id: "cliora-windows".into(),
            project_id: "windows".into(),
            target_id: target.id,
            tool_id: "codex".into(),
            directory: root.into(),
            mode: crate::adapters::LaunchMode::Normal,
            started_at: 0, last_seen_at: 0,
        };
        let review_id = review.review_id.clone();
        let base = format!("cliora://remote-review/?v=1&reviewId={review_id}&sessionId={session}");
        let accepted = format!("{base}&event=accepted");
        assert_eq!(super::super::parse_event_url(&accepted), event(&accepted));
        assert!(event(&accepted.replace("/?", "//?")).is_err());
        assert!(event(&accepted.replace("/?", "/unexpected?")).is_err());
        assert_eq!(publish(&database, review.clone(), || {
            assert_eq!(apply_event(&database, event(&accepted).unwrap()).unwrap().0.kind, "accepted");
            Ok(())
        }).unwrap().status, "accepted");
        drop(database);

        let database = Database::open(&database_file).unwrap();
        let recovered = source_for_origin(&database, &origin).unwrap().unwrap();
        assert_eq!(recovered.status, "accepted");
        assert_eq!(recovered.review_id, review_id);
        assert_eq!(recovered.session_id, session);
        assert_eq!(recovered.remote_binding, review.remote_binding);
        let wrong_origin = RemoteSessionIndexEntry { tool_id: "other".into(), ..origin.clone() };
        assert!(source_for_origin(&database, &wrong_origin).unwrap().is_none());
        drop(database);
        let returned = |revision: u64, outcome: &str, head: &str| {
            event(&format!("{base}&event=returned&resultRevision={revision}&outcome={outcome}&worktreeState=clean&headOid={head}")).unwrap()
        };
        for (revision, outcome, digit) in [(1, "reviewed", "a"), (2, "committed", "b"), (3, "merged", "c")] {
            let oid = digit.repeat(40);
            let incoming = returned(revision, outcome, &oid);
            let database = Database::open(&database_file).unwrap();
            let (applied, pending) = apply_event(&database, incoming.clone()).unwrap();
            assert_eq!(applied.kind, "returned");
            let pending = pending.unwrap();
            let unavailable = CodeStatus::unknown(session, Some(root.into()), "read_failed");
            assert!(verify_return(&database, &pending, unavailable).unwrap());
            assert!(!stored_result(&database, &review_id, session, revision).unwrap());
            drop(database);
            let database = Database::open(&database_file).unwrap();
            assert!(apply_event(&database, returned(revision, outcome, &"f".repeat(40))).unwrap().1.is_none());
            let pending = apply_event(&database, incoming.clone()).unwrap().1.unwrap();
            let checked = CodeStatus {
                session_id: session.into(), worktree_path: Some(root.into()), branch: Some("main".into()),
                head_oid: Some(oid), uncommitted_files: Some(0), session_files: None,
                session_base: review.baseline.clone(), state: "ready".into(), reason: None,
            };
            let wrong_base = CodeStatus { session_base: None, ..checked.clone() };
            assert!(verify_return(&database, &pending, wrong_base).unwrap());
            assert!(!stored_result(&database, &review_id, session, revision).unwrap());
            assert!(verify_return(&database, &pending, checked).unwrap());
            assert!(stored_result(&database, &review_id, session, revision).unwrap());
            assert!(apply_event(&database, incoming).unwrap().1.is_none());
        }
        let database = Database::open(&database_file).unwrap();
        let latest = source_for_origin(&database, &origin).unwrap().unwrap();
        assert_eq!(latest.outcome.as_deref(), Some("merged"));
        assert_eq!(latest.remote_check.unwrap().state, "ready");
        assert_eq!(source_for_session(&database, session).unwrap().unwrap().review_id, review_id);
        let remote = Database::open_read_only(&database_file).unwrap();
        assert!(stored_result(&remote, &review_id, session, 3).unwrap());
        assert!(!stored_result(&remote, &review_id, "other-session", 3).unwrap());
        assert_eq!(apply_event(&database, returned(4, "reviewed", &"c".repeat(40))).unwrap().0.reason.as_deref(), Some("late_result"));
        assert!(event(&format!("{base}&event=returned&resultRevision=4&outcome=merged&worktreeState=clean")).is_err());

        let reattached = "f10ccccc-1111-4222-8333-444444444444";
        let mut replacement = new_review(reattached, root, review.baseline.clone());
        replacement.remote_binding = review.remote_binding;
        replacement.protocol_version = 1;
        assert_eq!(publish(&database, replacement.clone(), || Err(())).unwrap_err(), "open_failed");
        assert_eq!(source_for_origin(&database, &origin).unwrap().unwrap().review_id, review_id);
        publish(&database, replacement, || Ok(())).unwrap();
        assert_eq!(source_for_origin(&database, &origin).unwrap().unwrap().session_id, reattached);
        assert!(source_for_session(&database, session).unwrap().is_none());
        assert_eq!(apply_event(&database, returned(4, "merged", &"d".repeat(40))).unwrap().0.reason.as_deref(), Some("superseded_review"));
    }
}
