use crate::adapters::Registry;
use super::*;
use crate::credentials::CredentialStore;
use crate::native::{
    adapter::Scope,

    apply,
    profile::{self, ProfileAuthentication, RegisteredProfile},
};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Secrets(Mutex<HashMap<String, String>>);
impl CredentialStore for Secrets {
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
            .ok_or("missing".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
fn account(db: &Database, base: &Path, label: &str) -> AuthAccount {
    let mut a = create(db, "codex", label).unwrap();
    let root = base.join(label);
    std::fs::create_dir_all(&root).unwrap();
    a.context = Some(context::context_at(root, "codex", format!("context-{label}")).unwrap());
    a.state = AccountState::SignedIn;
    a.identity = Some(AccountIdentity {
        subject: label.into(),
        email: None,
        plan: None,
        source: "synthetic".into(),
    });
    store::replace(db, &mut a).unwrap();
    a
}
fn profile(db: &Database, a: &AuthAccount) -> RegisteredProfile {
    profile::save_registered_profile(
        db,
        &Registry::builtins(),
        RegisteredProfile {
            id: String::new(),
            tool: "codex".into(),
            name: a.label.clone(),
            version: 0,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::from([("settings".into(), r#"model = "gpt-test""#.to_owned())]),
            suppressed: BTreeMap::new(),
            connection: None,
            native_credentials: BTreeMap::new(),
            authentication: ProfileAuthentication::OAuth {
                account_id: a.id.clone(),
            },
        },
        None,
    )
    .unwrap()
}
#[test]
fn scoped_paths_restore_nested_panics_and_never_cross_threads() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let a = account(&db, temp.path(), "a").context.unwrap();
    let b = account(&db, temp.path(), "b").context.unwrap();
    {
        let _a = selection::enter(Some(a.clone()));
        assert_eq!(selection::current("codex"), Some(a.clone()));
        let _ = std::panic::catch_unwind(|| {
            let _b = selection::enter(Some(b.clone()));
            assert_eq!(selection::current("codex"), Some(b.clone()));
            panic!("restore guard");
        });
        assert_eq!(selection::current("codex"), Some(a.clone()));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let expected = b.clone();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                assert!(selection::current("codex").is_none());
                let _b = selection::enter(Some(expected.clone()));
                other.wait();
                assert_eq!(selection::current("codex"), Some(expected));
            });
            barrier.wait();
            assert_eq!(selection::current("codex"), Some(a.clone()));
        });
    }
    assert!(selection::current("codex").is_none());
}
#[test]
fn applying_accounts_preserves_each_native_file_and_context_binding() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let secret = Secrets::default();
    let registry = Registry::builtins();
    let a = account(&db, temp.path(), "a");
    let b = account(&db, temp.path(), "b");
    let pa = profile(&db, &a);
    let pb = profile(&db, &b);
    for (account, profile) in [(&a, &pa), (&b, &pb), (&a, &pa)] {
        let _context = selection::enter(account.context.clone());
        let files =
            registry
                .get("codex")
                .unwrap()
                .native_files(Scope::Global, temp.path(), None, true);
        apply::apply_registered_validated(
            &registry,
            &db,
            &secret,
            profile,
            None,
            &files,
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
        let binding = apply::get_registered_binding(&db, "codex", "global")
            .unwrap()
            .unwrap();
        assert_eq!(binding.profile_id, profile.id);
        assert_eq!(
            binding.context_id,
            account.context.as_ref().map(|ctx| ctx.id.clone())
        );
    }
    for account in [&a, &b] {
        let text = std::fs::read_to_string(
            account
                .context
                .as_ref()
                .unwrap()
                .config_root
                .join("config.toml"),
        )
        .unwrap();
        assert!(text.contains("openai"));
    }
    assert!(!temp.path().join(".codex/config.toml").exists());
    {
        let _context = selection::enter(a.context.clone());
        let path = a.context.as_ref().unwrap().root.join("config.toml");
        let original = std::fs::read_to_string(&path).unwrap();
        crate::adapters::save_registered_text(
            &registry,
            "codex",
            "settings",
            Scope::Global,
            temp.path(),
            None,
            "0.160.0",
            &db,
            &secret,
            &original,
            &original.replace("gpt-test", "edited-model"),
        )
        .unwrap();
        let binding = apply::get_registered_binding(&db, "codex", "global")
            .unwrap()
            .unwrap();
        assert_eq!(
            binding.context_id,
            a.context.as_ref().map(|ctx| ctx.id.clone())
        );
        assert_eq!(binding.profile_version, 0);
    }

    let _context = selection::enter_bound(&db, temp.path(), "codex", Scope::Global, None).unwrap();
    assert!(
        selection::validate_expected("codex", b.context.as_ref().map(|ctx| ctx.id.as_str()))
            .is_err()
    );
    let mcp = crate::resources::mcp::McpTargetRequest {
        context_id: b.context.as_ref().map(|ctx| ctx.id.clone()),
        tool_id: "codex".into(),
        scope: Scope::Global,
        project_path: None,
        enabled: true,
        baseline_hash: None,
        allow_replace: false,
        preview_token: None,
    };
    assert!(crate::resources::mcp::list_native(&db, &registry, temp.path(), &mcp).is_err());
}
#[test]
fn project_conflicting_auth_is_rejected_and_scopes_keep_native_project_paths() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let a = account(&db, temp.path(), "a");
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".codex")).unwrap();
    std::fs::write(
        project.join(".codex/config.toml"),
        r#"model_provider = "third-party""#,
    )
    .unwrap();
    let registry = Registry::builtins();
    let _context = selection::enter(a.context.clone());
    let native = registry.get("codex").unwrap().native_files(
        Scope::Project,
        temp.path(),
        Some(&project),
        true,
    );
    assert_eq!(
        PathBuf::from(&native[0].path),
        project.join(".codex/config.toml")
    );
    assert!(
        selection::validate_oauth_files(&registry, "codex", temp.path(), Some(&project)).is_err()
    );
    assert_eq!(selection::key("project:shared"), "project:shared");
}
#[test]
fn portable_account_binding_requires_rebinding_and_contains_no_machine_context() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let a = account(&db, temp.path(), "a");
    profile(&db, &a);
    let snapshot =
        crate::portable::collect_snapshot(&db, &Secrets::default(), &Registry::builtins()).unwrap();
    let text = serde_json::to_string(&snapshot).unwrap();
    assert!(text.contains("rebind_required"));
    assert!(!text.contains(&a.id));
    assert!(!text.contains("context-a"));
    assert!(!text.contains("auth.json"));
}
#[test]
fn spawn_rejects_logout_or_reauthentication_since_plan_before_terminal_side_effect() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let mut a = account(&db, temp.path(), "a");
    let plan = crate::launch::LaunchPlan {
        account_context: Some((a.id.clone(), a.context.clone().unwrap())),
        account_version: Some(a.version),
        tool_id: "codex".into(),
        project_id: None,
        mode: crate::adapters::LaunchMode::Normal,
        executable: PathBuf::from("never-launched"),
        cli_args: vec![],
        directory: temp.path().to_owned(),
        terminal: crate::launch::TerminalId::Auto,
        session_markers: &[],
    };
    let command = crate::launch::native_command(&plan).unwrap();
    assert!(command.contains("CODEX_HOME"));
    assert!(command.contains("OPENAI_API_KEY"));
    assert!(!command.contains("export HOME="));
    assert!(!command.contains("$env:HOME ="));
    a.state = AccountState::SignedOut;
    store::replace(&db, &mut a).unwrap();
    assert!(crate::launch::spawn(&db, plan)
        .unwrap_err()
        .contains("账号"));
}

#[test]
fn history_discovers_both_accounts_with_same_native_id_and_retired_root_without_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let a = account(&db, temp.path(), "a");
    let b = account(&db, temp.path(), "b");
    let native = "11111111-1111-4111-8111-111111111111";
    for account in [&a, &b] {
        let root = &account.context.as_ref().unwrap().history_roots[0];
        std::fs::create_dir_all(root).unwrap();
        let rows = [
            serde_json::json!({"timestamp":"2026-10-02T01:00:00Z","type":"session_meta","payload":{"id":native,"cwd":temp.path().to_string_lossy()}}),
            serde_json::json!({"timestamp":"2026-10-02T01:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":account.label}]}}),
        ];
        std::fs::write(
            root.join("rollout-fixture.jsonl"),
            rows.iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    }
    let reports = crate::history::refresh_controlled(
        &db,
        &Registry::builtins(),
        temp.path(),
        &["codex".to_string()],
        &|| false,
    )
    .unwrap();
    assert_eq!(reports[0].source_count, 2);
    let sessions = crate::history::list(&db, &crate::history::HistoryFilter::default()).unwrap();
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0].id, sessions[1].id);
    assert!(crate::history::unique_session_id(&db, "codex", native).is_err());
    let mut a = a;
    let old = a.context.take().unwrap();
    a.retired_contexts.push(old);
    let root = temp.path().join("reauth");
    std::fs::create_dir_all(&root).unwrap();
    a.context = Some(context::context_at(root, "codex", "reauth-context".into()).unwrap());
    store::replace(&db, &mut a).unwrap();
    crate::history::refresh_controlled(
        &db,
        &Registry::builtins(),
        temp.path(),
        &["codex".to_string()],
        &|| false,
    )
    .unwrap();
    assert_eq!(
        crate::history::list(&db, &crate::history::HistoryFilter::default())
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn all_supported_adapters_share_config_resource_and_history_context_roots() {
    let temp = tempfile::tempdir().unwrap();
    let registry = Registry::builtins();
    for tool in ["codex", "claude_code", "pi", "open_code"] {
        let root = temp.path().join(tool);
        std::fs::create_dir_all(&root).unwrap();
        let context = context::context_at(root.clone(), tool, tool.into()).unwrap();
        let _context = selection::enter(Some(context.clone()));
        let adapter = registry.get(tool).unwrap();
        for file in adapter.native_files(Scope::Global, temp.path(), None, true) {
            assert!(
                Path::new(&file.path).starts_with(&root),
                "{tool}: {}",
                file.path
            );
        }
        assert!(
            adapter
                .skill_root(Scope::Global, temp.path(), None)
                .unwrap()
                .starts_with(&root),
            "{tool} skill"
        );
        assert!(
            adapter
                .rule_path(Scope::Global, temp.path(), None)
                .unwrap()
                .starts_with(&root),
            "{tool} rule"
        );
        if let Some(mcp) =
            adapter.mcp_location_for_version(Scope::Global, temp.path(), None, Some("1.18.34"))
        {
            assert!(mcp.path.starts_with(&root), "{tool} MCP");
        }
        assert_eq!(
            selection::history_root(tool, PathBuf::new),
            context.history_roots[0]
        );
    }
}

#[test]
fn rule_ownership_and_old_editor_request_stay_bound_to_account() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let secrets = Secrets::default();
    let registry = Registry::builtins();
    let a = account(&db, temp.path(), "a");
    let b = account(&db, temp.path(), "b");
    let pa = profile(&db, &a);
    let pb = profile(&db, &b);
    let bind = |account: &AuthAccount, profile: &RegisteredProfile| {
        let _context = selection::enter(account.context.clone());
        let files =
            registry
                .get("codex")
                .unwrap()
                .native_files(Scope::Global, temp.path(), None, true);
        apply::apply_registered_validated(
            &registry,
            &db,
            &secrets,
            profile,
            None,
            &files,
            "global",
            Scope::Global,
            true,
        )
        .unwrap();
    };
    let rule = crate::library::save(
        &db,
        crate::library::LibraryDraft {
            id: None,
            kind: crate::library::LibraryKind::Rule,
            title: "team".into(),
            body: "rule A".into(),
            category: String::new(),
            project_id: None,
            expected_version: None,
        },
    )
    .unwrap();
    let selection = |tools: Vec<String>| crate::resources::rules::RuleClientSelection {
        tool_ids: tools,
        scope: Scope::Global,
        project_path: None,
        allow_replace: false,
    };
    bind(&a, &pa);
    crate::resources::rules::sync_clients(
        &db,
        &secrets,
        &registry,
        temp.path(),
        &rule.id,
        rule.version,
        selection(vec!["codex".into()]),
    )
    .unwrap();
    let request = crate::resources::rules::RuleTarget {
        context_id: a.context.as_ref().map(|ctx| ctx.id.clone()),
        tool_id: "codex".into(),
        scope: Scope::Global,
        project_path: None,
        baseline_hash: None,
    };
    bind(&b, &pb);
    crate::resources::rules::sync_clients(
        &db,
        &secrets,
        &registry,
        temp.path(),
        &rule.id,
        rule.version,
        selection(vec!["codex".into()]),
    )
    .unwrap();
    assert!(crate::resources::rules::save_current(
        &db,
        &secrets,
        &registry,
        temp.path(),
        &request,
        "rule A",
        "stale editor"
    )
    .is_err());
    crate::resources::rules::sync_clients(
        &db,
        &secrets,
        &registry,
        temp.path(),
        &rule.id,
        rule.version,
        selection(vec![]),
    )
    .unwrap();
    assert!(
        std::fs::read_to_string(a.context.as_ref().unwrap().root.join("AGENTS.md"))
            .unwrap()
            .contains("rule A")
    );
    assert_eq!(
        std::fs::read_to_string(b.context.as_ref().unwrap().root.join("AGENTS.md")).unwrap(),
        ""
    );
}

#[test]
fn opencode_oauth_does_not_allow_implicit_provider_fallback() {
    let profile:RegisteredProfile=serde_json::from_value(serde_json::json!({"id":"p","tool":"open_code","name":"OpenAI","version":1,"inheritCommon":false,"files":{},"connection":null,"authentication":{"kind":"oauth","accountId":"a"}})).unwrap();
    assert!(apply::desired_registered_documents(
        &Registry::builtins(),
        &profile,
        None,
        Scope::Global
    )
    .is_err());
    let mut valid = profile;
    valid
        .files
        .insert("settings".into(), r#"{"model":"openai/gpt-test"}"#.into());
    assert!(apply::desired_registered_documents(
        &Registry::builtins(),
        &valid,
        None,
        Scope::Global
    )
    .is_ok());
}

#[test]
fn skill_recovery_blocks_only_its_native_account_or_shared_project() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let a = account(&db, temp.path(), "a");
    let b = account(&db, temp.path(), "b");
    let issue = crate::resources::skills::SkillRecoveryIssue {
        context_id: Some("context-a".into()),
        operation_id: "broken".into(),
        tool_id: "codex".into(),
        scope: Scope::Global,
        project_path: None,
        target_path: String::new(),
        backup_path: String::new(),
        detail: String::new(),
        scope_key: "context:context-a:global".into(),
    };
    {
        let _context = selection::enter(a.context);
        assert!(issue.affects("codex", "project:shared"));
    }
    {
        let _context = selection::enter(b.context);
        assert!(!issue.affects("codex", "project:shared"));
    }
}

#[test]
fn project_without_binding_inherits_global_account_for_native_and_resource_writes() {
    use crate::resources::{mcp, skills};
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = Registry::builtins();
    let secret = Secrets::default();
    let a = account(&db, temp.path(), "inherited");
    let profile = profile(&db, &a);
    {
        let _context = selection::enter(a.context.clone());
        let files = registry.get("codex").unwrap().native_files(Scope::Global, temp.path(), None, true);
        apply::apply_registered_validated(&registry, &db, &secret, &profile, None, &files, "global", Scope::Global, true).unwrap();
    }
    let project = temp.path().join("project");
    std::fs::create_dir_all(project.join(".codex")).unwrap();
    std::fs::write(project.join(".codex/config.toml"), "model = \"before\"\n").unwrap();
    let key = apply::scope_key(Scope::Project, Some(&project)).unwrap();
    assert!(apply::get_registered_binding(&db, "codex", &key).unwrap().is_none());
    let _context = selection::enter_bound(&db, temp.path(), "codex", Scope::Project, Some(&project)).unwrap();
    let effective = selection::current("codex").map(|context| context.id);
    assert_eq!(effective, a.context.as_ref().map(|context| context.id.clone()));
    assert!(selection::validate_expected("codex", None).is_err());
    selection::validate_expected("codex", effective.as_deref()).unwrap();
    let original = crate::adapters::read_registered_file(&registry, "codex", "settings", Scope::Project, temp.path(), Some(&project), true).unwrap();
    crate::adapters::save_registered_text(&registry, "codex", "settings", Scope::Project, temp.path(), Some(&project), "0.160.0", &db, &secret, &original, "model = \"after\"\n").unwrap();
    assert!(std::fs::read_to_string(project.join(".codex/config.toml")).unwrap().contains("after"));
    assert!(apply::get_registered_binding(&db, "codex", &key).unwrap().is_none());

    let definition = mcp::save_definition(&db, serde_json::from_value(serde_json::json!({
        "name":"inherited-server", "transport":"stdio", "command":"node", "args":[], "url":"", "env":{}, "headers":{}, "inLibrary":true
    })).unwrap()).unwrap();
    let mut target = mcp::McpTargetRequest { context_id: effective.clone(), tool_id: "codex".into(), scope: Scope::Project, project_path: Some(project.to_string_lossy().into()), enabled: true, baseline_hash: None, allow_replace: false, preview_token: None };
    let preview = mcp::preview_targets(&db, &registry, temp.path(), &definition.id, vec![target.clone()]);
    assert_eq!(preview[0].status, "ready", "{}", preview[0].detail);
    target.baseline_hash = preview[0].baseline_hash.clone();
    target.preview_token = preview[0].preview_token.clone();
    let written = mcp::distribute(&db, &secret, &registry, temp.path(), &definition.id, vec![target.clone()]);
    assert_eq!(written[0].status, "written", "{}", written[0].detail);
    assert_eq!(mcp::list_native(&db, &registry, temp.path(), &target).unwrap().len(), 1);
    mcp::remove_native(&db, &secret, &registry, temp.path(), &target, &definition.name).unwrap();
    assert!(mcp::list_native(&db, &registry, temp.path(), &target).unwrap().is_empty());

    let source = temp.path().join("inherited-skill");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("SKILL.md"), "---\nname: inherited-skill\ndescription: fixture\n---\n").unwrap();
    let package = skills::import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    let installed = skills::install(&db, &registry, temp.path(), &package.id, "codex", Scope::Project, project.to_str());
    assert_eq!(installed.status, "installed", "{}", installed.detail);
    selection::validate_expected("codex", effective.as_deref()).unwrap();
    skills::set_enabled(&db, &secret, &registry, temp.path(), &package.id, "codex", Scope::Project, project.to_str(), false).unwrap();
    assert!(!skills::enabled(&db, &registry, temp.path(), &package.id, "codex", Scope::Project, project.to_str()).unwrap());
    skills::set_enabled(&db, &secret, &registry, temp.path(), &package.id, "codex", Scope::Project, project.to_str(), true).unwrap();
    let removed = skills::remove(&db, &registry, temp.path(), &package.id, "codex", Scope::Project, project.to_str());
    assert_eq!(removed.status, "removed", "{}", removed.detail);
    assert!(!temp.path().join(".codex/config.toml").exists());
}
