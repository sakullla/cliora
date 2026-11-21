use super::{LinkEvent, ReviewState};
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
fn id(value: &str) -> bool {
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
fn path(value: &str) -> bool {
    value.starts_with('/')
        && !value.chars().any(char::is_control)
        && (value == "/"
            || value[1..]
                .split('/')
                .all(|part| !matches!(part, "" | "." | "..")))
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

pub(super) fn event(raw: &str) -> Result<LinkEvent, &'static str> {
    const BAD: &str = "malformed_request";
    if raw.len() > LIMIT
        || !raw.starts_with("cliora://remote-review?")
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
            let seqnum = seq
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && seq == n.to_string())
                .ok_or(BAD)?;
            revision = Some(seqnum);
            let outcome = q
                .remove("outcome")
                .filter(|s| matches!(s.as_str(), "reviewed" | "committed"))
                .ok_or(BAD)?;
            let head_oid = q.remove("headOid");
            if head_oid.as_deref().is_some_and(|s| !oid(s))
                || (outcome == "committed" && head_oid.is_none())
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
            .checked_remote_return(&first, CodeStatus::unknown(session, None, "read_failed")));
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
            CodeStatus::unknown(session, None, "target_changed")
        ));
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
}
