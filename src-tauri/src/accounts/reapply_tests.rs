use super::*;
use crate::{
    accounts::{contract::*, impact, store},
    adapters::Registry,
    credentials::CredentialStore,
    native::{adapter::NativeFile, apply, profile::RegisteredProfile},
};
use rusqlite::params;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
};

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), value.into());
        Ok(())
    }
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("missing fixture credential".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    db: Database,
    account: AuthAccount,
    profile: RegisteredProfile,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let context = |id: &str| {
            let root = temp.path().join(format!("private-{id}"));
            std::fs::create_dir_all(&root).unwrap();
            NativeContext {
                id: id.into(),
                tool_id: "codex".into(),
                root: root.clone(),
                config_root: root.clone(),
                auth_files: vec![root.join("do-not-return-auth-file.json")],
                history_roots: vec![root.join("private-history")],
                resource_root: root,
                environment: BTreeMap::from([(
                    "DO_NOT_RETURN_ENV".into(),
                    "fixture-env-secret".into(),
                )]),
                remove_environment: vec!["private-marker".into()],
                cli_args: vec!["fixture-private-argument".into()],
            }
        };
        let account = AuthAccount {
            id: "account-a".into(),
            tool_id: "codex".into(),
            provider: "fixture-provider".into(),
            label: "Account A".into(),
            version: 7,
            state: AccountState::SignedIn,
            identity: Some(AccountIdentity {
                subject: "fixture-subject".into(),
                email: None,
                plan: None,
                source: "fixture".into(),
            }),
            context: Some(context("new-context")),
            retired_contexts: vec![context("old-context")],
            pending_login: None,
            checked_at: None,
            detail: None,
        };
        store::insert(&db, &account).unwrap();
        let profile:RegisteredProfile=serde_json::from_value(json!({"id":"profile-a","tool":"codex","name":"Config A","version":2,"revision":"profile-revision-2","inheritCommon":false,"editing":{"version":1,"selectedProvider":null,"intents":[]},"files":{"settings":"model = \"gpt-6.1-sol\"\n"},"authentication":{"kind":"oauth","accountId":"account-a"},"connection":null,"nativeCredentials":{}})).unwrap();
        db.with_connection(|conn| {conn.execute("INSERT INTO native_profiles(id,tool,version,data) VALUES(?1,?2,?3,?4)",params![profile.id,profile.tool,profile.version as i64,serde_json::to_string(&profile).unwrap()]).unwrap();
            for key in ["global","context:old-context:global"] {conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,context_id,managed) VALUES(?1,?2,?3,?4,?5,?6)",params![key,"codex",profile.id,1,"old-context","{}"] ).unwrap();}Ok(())}).unwrap();
        Self {
            temp,
            db,
            account,
            profile,
        }
    }
    fn request(&self) -> AccountReapplyRequest {
        impact::query(&self.db, &self.account.id)
            .unwrap()
            .scopes
            .into_iter()
            .find(|scope| scope.active)
            .unwrap()
            .reapply_request
            .unwrap()
    }
    fn own_check(&self) {
        let before = store::get(&self.db, &self.account.id).unwrap();
        before_check(&before).unwrap();
        let mut after = before.clone();
        after.checked_at = Some(1234);
        store::replace(&self.db, &mut after).unwrap();
        after_check(&before, &after).unwrap();
    }
    fn replace_profile(&self, profile: &RegisteredProfile) {
        self.db
            .with_connection(|conn| {
                conn.execute(
                    "UPDATE native_profiles SET version=?1,data=?2 WHERE id=?3",
                    params![
                        profile.version as i64,
                        serde_json::to_string(profile).unwrap(),
                        profile.id
                    ],
                )
                .unwrap();
                Ok(())
            })
            .unwrap();
    }
    fn native(&self, matching: bool) -> (std::path::PathBuf, NativeFile, String) {
        let path = self.temp.path().join("isolated-config.toml");
        let baseline = if matching {
            let documents = apply::desired_registered_documents(
                &Registry::builtins(),
                &self.profile,
                None,
                Scope::Global,
            )
            .unwrap();
            crate::native::format::render(
                crate::native::format::FileKind::Toml,
                &documents["settings"],
            )
            .unwrap()
        } else {
            "unrelated = true\n".into()
        };
        std::fs::write(&path, &baseline).unwrap();
        let file = NativeFile {
            role: "settings",
            path: path.display().to_string(),
            format: "toml",
            writable: true,
            reason: None,
            sensitive: false,
        };
        (path, file, baseline)
    }
    fn apply(&self, file: &NativeFile) -> Result<crate::native::transaction::ApplyOutcome, String> {
        let _context = crate::accounts::selection::enter(self.account.context.clone());
        apply::apply_registered_validated(
            &Registry::builtins(),
            &self.db,
            &MemoryCredentials::default(),
            &self.profile,
            None,
            std::slice::from_ref(file),
            "global",
            Scope::Global,
            false,
        )
    }
    fn binding(&self) -> serde_json::Value {
        serde_json::to_value(apply::get_registered_binding(&self.db, "codex", "global").unwrap())
            .unwrap()
    }
}

#[test]
fn impact_joins_real_references_sanitizes_native_data_and_deduplicates_global_mirror() {
    let fixture = Fixture::new();
    fixture.db.with_connection(|conn| {
        let direct=json!({"config":{"label":"Old quota","enabled":true,"identity":{"accountId":"account-a","contextId":"old-context","profileId":"profile-a"},"program":{"kind":"official","tool":"codex"},"parameters":{"secret":"do-not-return-query-secret"}},"credentials":[{"secretRef":"do-not-return-reference"}]});
        let indirect=json!({"config":{"label":"Profile quota","enabled":false,"identity":{"accountId":null,"contextId":null,"profileId":"profile-a"},"program":{"kind":"profile_builtin"}}});
        for (id,data) in [("quota-old",direct),("quota-profile",indirect)] {conn.execute("INSERT INTO usage_queries(id,version,generation,data) VALUES(?1,1,1,?2)",params![id,data.to_string()]).unwrap();}Ok(())}).unwrap();
    let before = store::get(&fixture.db, &fixture.account.id).unwrap();
    let result = impact::query(&fixture.db, &fixture.account.id).unwrap();
    assert_eq!(result.profiles.len(), 1);
    assert_eq!(result.scopes.len(), 1);
    assert!(result.scopes[0].needs_reapply);
    assert!(result.scopes[0].can_reapply);
    assert_eq!(
        result.scopes[0].context_kind,
        AccountImpactContextKind::Retained
    );
    assert_eq!(result.current_context_id.as_deref(), Some("new-context"));
    assert_eq!(result.usage_references.len(), 2);
    assert!(result.usage_references[0].needs_rebind);
    assert!(!result.usage_references[1].needs_rebind);
    let encoded = serde_json::to_string(&result).unwrap();
    for hidden in [
        "private-new-context",
        "do-not-return-auth-file",
        "private-history",
        "fixture-env-secret",
        "fixture-private-argument",
        "do-not-return-query-secret",
        "do-not-return-reference",
    ] {
        assert!(!encoded.contains(hidden));
    }
    let after = store::get(&fixture.db, &fixture.account.id).unwrap();
    assert_eq!(after.version, before.version);
    assert_eq!(after.checked_at, before.checked_at);
    assert_eq!(fixture.binding()["contextId"], "old-context");
    assert!(
        store::delete(&fixture.db, &fixture.account.id, after.version)
            .unwrap_err()
            .contains("仍绑定")
    );
}

#[test]
fn impact_reports_project_metadata_and_other_tools_without_native_observation() {
    let fixture = Fixture::new();
    fixture.db.with_connection(|conn| {
        conn.execute("INSERT INTO projects(id,name,path) VALUES('project-fixture','Fixture project','/fixture/project')",[]).unwrap();
        conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,context_id,managed) VALUES('project:/fixture/project','codex','profile-a',1,'old-context','{}')",[]).unwrap();
        conn.execute("INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,context_id,managed) VALUES('context:new-context:global','codex','profile-a',2,'new-context','{}')",[]).unwrap();
        let unrelated=json!({"config":{"label":"Unrelated","enabled":true,"identity":{"accountId":"another-account","contextId":"another-context","profileId":"another-profile"},"program":{"kind":"official"}}});conn.execute("INSERT INTO usage_queries(id,version,generation,data) VALUES('unrelated',1,1,?1)",[unrelated.to_string()]).unwrap();Ok(())
    }).unwrap();
    let impact = impact::query(&fixture.db, &fixture.account.id).unwrap();
    assert!(impact.usage_references.is_empty());
    let project = impact
        .scopes
        .iter()
        .find(|scope| scope.scope == Some(Scope::Project))
        .unwrap();
    assert_eq!(project.project_name.as_deref(), Some("Fixture project"));
    assert_eq!(project.project_path.as_deref(), Some("/fixture/project"));
    assert!(project.active && project.needs_reapply && project.can_reapply);
    assert_eq!(
        project.reapply_request.as_ref().unwrap().project_path,
        project.project_path
    );
    assert!(impact.scopes.iter().any(|scope| !scope.active
        && scope.context_kind == AccountImpactContextKind::Current
        && !scope.can_reapply));
    let mut generic_account = fixture.account.clone();
    generic_account.tool_id = "fixture-cli".into();
    generic_account.context.as_mut().unwrap().tool_id = "fixture-cli".into();
    for context in &mut generic_account.retired_contexts {
        context.tool_id = "fixture-cli".into();
    }
    let mut profile = fixture.profile.clone();
    profile.tool = "fixture-cli".into();
    fixture
        .db
        .with_connection(|conn| {
            conn.execute(
                "UPDATE auth_accounts SET tool='fixture-cli',data=?1 WHERE id='account-a'",
                [serde_json::to_string(&generic_account).unwrap()],
            )
            .unwrap();
            conn.execute(
                "UPDATE native_profiles SET tool='fixture-cli',data=?1 WHERE id='profile-a'",
                [serde_json::to_string(&profile).unwrap()],
            )
            .unwrap();
            conn.execute("UPDATE applied_bindings SET tool='fixture-cli'", [])
                .unwrap();
            Ok(())
        })
        .unwrap();
    let generic = impact::query(&fixture.db, &fixture.account.id).unwrap();
    assert_eq!(generic.tool_id, "fixture-cli");
    assert_eq!(generic.profiles.len(), 1);
    assert!(generic
        .scopes
        .iter()
        .any(|scope| scope.active && scope.tool_id == "fixture-cli"));
}
#[test]
fn own_check_revision_progression_commits_write_and_already_matching_without_scope_fallback() {
    for matching in [false, true] {
        let fixture = Fixture::new();
        let request = fixture.request();
        let _guard = enter(request).unwrap();
        validate_profile(&fixture.db, &fixture.profile, Scope::Global, None).unwrap();
        fixture.own_check();
        let (path, file, _) = fixture.native(matching);
        let result = fixture.apply(&file).unwrap();
        if matching {
            assert_eq!(result.status, "already_matching");
        }
        assert_eq!(fixture.binding()["profileId"], "profile-a");
        assert_eq!(fixture.binding()["contextId"], "new-context");
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("gpt-6.1-sol"));
        let impact = impact::query(&fixture.db, &fixture.account.id).unwrap();
        assert!(impact
            .scopes
            .iter()
            .filter(|scope| scope.active)
            .all(|scope| !scope.needs_reapply));
        assert!(impact.scopes.iter().any(|scope| !scope.active
            && scope.context_kind == AccountImpactContextKind::Retained
            && !scope.can_reapply));
    }
}
#[test]
fn initial_guard_rejects_profile_rebind_revision_and_scope_context_replacement() {
    for change in [
        "profile_account",
        "profile_version",
        "profile_revision",
        "scope_profile",
        "scope_context",
        "account_version",
        "account_context",
        "account_pending",
    ] {
        let fixture = Fixture::new();
        let request = fixture.request();
        let (path, _, baseline) = fixture.native(false);
        match change {
            "profile_account" => {
                let mut profile = fixture.profile.clone();
                profile.authentication = ProfileAuthentication::OAuth {
                    account_id: "other-account".into(),
                };
                fixture.replace_profile(&profile);
            }
            "profile_version" => {
                let mut profile = fixture.profile.clone();
                profile.version += 1;
                fixture.replace_profile(&profile);
            }
            "profile_revision" => {
                let mut profile = fixture.profile.clone();
                profile.revision = "changed".into();
                fixture.replace_profile(&profile);
            }
            "scope_profile" | "scope_context" => {
                fixture.db.with_connection(|conn|{conn.execute(if change=="scope_profile" {"UPDATE applied_bindings SET profile_id='other-profile' WHERE scope_key='global'"} else {"UPDATE applied_bindings SET context_id='other-context' WHERE scope_key='global'"},[]).unwrap();Ok(())}).unwrap();
            }
            _ => {
                let mut account = fixture.account.clone();
                if change == "account_context" {
                    account.context.as_mut().unwrap().id = "changed-context".into();
                }
                if change == "account_pending" {
                    account.pending_login = Some(PendingLogin {
                        id: "pending-attempt".into(),
                        expires_at: i64::MAX,
                        context: account.context.clone().unwrap(),
                        previous_state: account.state.clone(),
                        external_terminal: true,
                        operation: "login".into(),
                    });
                }
                store::replace(&fixture.db, &mut account).unwrap();
            }
        }
        let binding = fixture.binding();
        let _guard = enter(request).unwrap();
        assert!(
            validate_profile(&fixture.db, &fixture.profile, Scope::Global, None).is_err(),
            "{change}"
        );
        assert_eq!(fixture.binding(), binding);
        assert_eq!(std::fs::read_to_string(path).unwrap(), baseline);
    }
}
#[test]
fn transaction_rejects_external_changes_after_own_check_without_writing_or_changing_binding() {
    for matching in [false, true] {
        for change in [
            "rename",
            "reauth",
            "cancel_pending",
            "concurrent_check",
            "profile_account",
            "profile_version",
            "scope_profile",
            "scope_context",
        ] {
            let fixture = Fixture::new();
            let request = fixture.request();
            let _guard = enter(request).unwrap();
            validate_profile(&fixture.db, &fixture.profile, Scope::Global, None).unwrap();
            fixture.own_check();
            let (path, file, baseline) = fixture.native(matching);
            match change {
                "profile_account" | "profile_version" => {
                    let mut profile = fixture.profile.clone();
                    if change == "profile_account" {
                        profile.authentication = ProfileAuthentication::OAuth {
                            account_id: "another-account".into(),
                        };
                    } else {
                        profile.version += 1;
                    }
                    fixture.replace_profile(&profile);
                }
                "scope_profile" | "scope_context" => {
                    fixture.db.with_connection(|conn|{conn.execute(if change=="scope_profile" {"UPDATE applied_bindings SET profile_id='other-profile' WHERE scope_key='global'"}else{"UPDATE applied_bindings SET context_id='other-context' WHERE scope_key='global'"},[]).unwrap();Ok(())}).unwrap();
                }
                "cancel_pending" => {
                    let mut account = store::get(&fixture.db, &fixture.account.id).unwrap();
                    account.pending_login = Some(PendingLogin {
                        id: "cancel-me".into(),
                        expires_at: i64::MAX,
                        context: account.context.clone().unwrap(),
                        previous_state: AccountState::SignedIn,
                        external_terminal: true,
                        operation: "login".into(),
                    });
                    account.state = AccountState::Pending;
                    store::replace(&fixture.db, &mut account).unwrap();
                    crate::accounts::cancel(&fixture.db, &account.id, "cancel-me", false).unwrap();
                }
                _ => {
                    let mut account = store::get(&fixture.db, &fixture.account.id).unwrap();
                    if change == "rename" {
                        account.label = "Renamed".into();
                    }
                    if change == "reauth" {
                        account.context.as_mut().unwrap().id = "another-current-context".into();
                    }
                    if change == "concurrent_check" {
                        account.checked_at = Some(9999);
                    }
                    store::replace(&fixture.db, &mut account).unwrap();
                }
            }
            let binding = fixture.binding();
            assert!(fixture.apply(&file).is_err(), "{matching}/{change}");
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                baseline,
                "{matching}/{change}"
            );
            assert_eq!(fixture.binding(), binding, "{matching}/{change}");
        }
    }
}
#[test]
fn observation_requires_own_current_version_and_guard_drop_restores_ordinary_check_and_apply() {
    let fixture = Fixture::new();
    let request = fixture.request();
    let (path, file, _) = fixture.native(false);
    {
        let _guard = enter(request).unwrap();
        validate_profile(&fixture.db, &fixture.profile, Scope::Global, None).unwrap();
        let mut external = store::get(&fixture.db, &fixture.account.id).unwrap();
        external.checked_at = Some(777);
        store::replace(&fixture.db, &mut external).unwrap();
        assert!(before_check(&external).is_err());
        let mut after = external.clone();
        after.version += 1;
        assert!(after_check(&external, &after).is_err());
    }
    let mut signed_out = fixture.account.clone();
    signed_out.state = AccountState::SignedOut;
    assert!(before_check(&signed_out).is_ok());
    let mut changed = signed_out.clone();
    changed.version += 10;
    changed.context = None;
    assert!(after_check(&signed_out, &changed).is_ok());
    fixture.apply(&file).unwrap();
    assert!(std::fs::read_to_string(path)
        .unwrap()
        .contains("gpt-6.1-sol"));
    assert_eq!(fixture.binding()["contextId"], "new-context");
}
#[test]
fn subject_or_context_change_cannot_be_approved_as_an_own_check() {
    for change in ["subject", "context", "label"] {
        let fixture = Fixture::new();
        let _guard = enter(fixture.request()).unwrap();
        validate_profile(&fixture.db, &fixture.profile, Scope::Global, None).unwrap();
        let before = fixture.account.clone();
        let mut after = before.clone();
        after.version += 1;
        match change {
            "subject" => after.identity.as_mut().unwrap().subject = "other-subject".into(),
            "context" => after.context.as_mut().unwrap().id = "other-context".into(),
            _ => after.label = "other-label".into(),
        };
        assert!(after_check(&before, &after).is_err());
    }
}
