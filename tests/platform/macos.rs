use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::history::{self, HistoryFilter};
use crate::launch::{self, TerminalId};
use crate::native::adapter::Scope;
use crate::adapters::{LaunchMode, Registry};
use crate::resources::{mcp, skills};

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryStore {
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
            .ok_or("missing test key".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

fn registry() -> Registry {
    Registry::builtins()
        .with_fixture_installation("codex", "0.159.3")
        .with_fixture_installation("claude_code", "2.1.283")
        .with_fixture_installation("grok", "1.0.46")
        .with_fixture_installation("pi", "0.99.2")
        .with_fixture_installation("open_code", "1.18.33")
}

#[test]
fn five_cli_mcp_and_skills_work_in_macos_global_and_project_directories() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("用户 home");
    let project = temp.path().join("项目 with 'quotes'");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&project).unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = registry();
    let store = MemoryStore::default();
    let definition = mcp::save_definition(
        &db,
        mcp::McpDraft {
            id: None,
            name: "macos-example".into(),
            transport: mcp::McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "example-mcp".into()],
            url: String::new(),
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            in_library: true,
            expected_version: None,
        },
    )
    .unwrap();
    let source = temp.path().join("sample-skill");
    fs::create_dir_all(source.join("references")).unwrap();
    fs::write(
        source.join("SKILL.md"),
        "---\nname: sample-skill\ndescription: macOS fixture\n---\n",
    )
    .unwrap();
    fs::write(source.join("references/使用.txt"), "完整资源\n").unwrap();
    let package = skills::import_local(&db, source.to_str().unwrap(), None, None).unwrap();
    for tool in ["codex", "claude_code", "grok", "pi", "open_code"] {
        for scope in [Scope::Global, Scope::Project] {
            let project_path = (scope == Scope::Project).then(|| project.to_str().unwrap());
            let mut target = mcp::McpTargetRequest { context_id: None,
                tool_id: tool.into(),
                scope,
                project_path: project_path.map(str::to_owned),
                enabled: true,
                baseline_hash: None,
                allow_replace: false,
                preview_token: None,
            };
            let preview =
                mcp::preview_targets(&db, &registry, &home, &definition.id, vec![target.clone()]);
            assert_eq!(preview[0].status, "ready", "{tool}: {preview:?}");
            target.baseline_hash = preview[0].baseline_hash.clone();
            target.preview_token = preview[0].preview_token.clone();
            let result = mcp::distribute(
                &db,
                &store,
                &registry,
                &home,
                &definition.id,
                vec![target.clone()],
            );
            assert_eq!(result[0].status, "written", "{tool}: {result:?}");
            let path = PathBuf::from(result[0].path.as_ref().unwrap());
            assert!(
                path.starts_with(home.canonicalize().unwrap())
                    || path.starts_with(project.canonicalize().unwrap())
                    || path.starts_with(&home)
            );
            assert!(mcp::list_native(&db, &registry, &home, &target)
                .unwrap()
                .iter()
                .any(|entry| entry.name == "macos-example" && entry.enabled));

            let installed = skills::install(
                &db,
                &registry,
                &home,
                &package.id,
                tool,
                scope,
                project_path,
            );
            assert_eq!(
                installed.status, "installed",
                "{tool}: {}",
                installed.detail
            );
            skills::set_enabled(
                &db,
                &store,
                &registry,
                &home,
                &package.id,
                tool,
                scope,
                project_path,
                false,
            )
            .unwrap();
            assert!(!skills::enabled(
                &db,
                &registry,
                &home,
                &package.id,
                tool,
                scope,
                project_path
            )
            .unwrap());
            skills::set_enabled(
                &db,
                &store,
                &registry,
                &home,
                &package.id,
                tool,
                scope,
                project_path,
                true,
            )
            .unwrap();
            assert!(skills::enabled(
                &db,
                &registry,
                &home,
                &package.id,
                tool,
                scope,
                project_path
            )
            .unwrap());
            let installed_path = registry
                .get(tool)
                .unwrap()
                .skill_root(
                    scope,
                    &home,
                    (scope == Scope::Project).then_some(project.as_path()),
                )
                .unwrap()
                .join(&package.name);
            assert_eq!(
                fs::read_to_string(installed_path.join("references/使用.txt")).unwrap(),
                "完整资源\n"
            );
            assert_eq!(
                skills::remove(
                    &db,
                    &registry,
                    &home,
                    &package.id,
                    tool,
                    scope,
                    project_path
                )
                .status,
                "removed"
            );
        }
    }
}

fn copy_history_fixture(home: &Path, project: &Path, fixture: &str, destination: &str) {
    let path = home.join(destination);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/history");
    let text = fs::read_to_string(root.join(fixture))
        .unwrap()
        .replace("/fixture/project", project.to_str().unwrap());
    fs::write(path, text).unwrap();
}

#[test]
fn five_cli_histories_resume_in_the_original_macos_directory() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let project = temp.path().join("原工作目录 with 'quotes'");
    fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    for (fixture, destination) in [
        ("codex-0.158.jsonl", ".codex/sessions/rollout-macos.jsonl"),
        ("claude-2.1.jsonl", ".claude/projects/project/session.jsonl"),
        (
            "pi-0.87-v3.jsonl",
            ".pi/agent/sessions/project/session.jsonl",
        ),
        (
            "grok-1.0/summary.json",
            ".grok/sessions/project/44444444-4444-4444-8444-444444444444/summary.json",
        ),
        (
            "grok-1.0/chat_history.jsonl",
            ".grok/sessions/project/44444444-4444-4444-8444-444444444444/chat_history.jsonl",
        ),
        (
            "grok-1.0/usage.json",
            ".grok/sessions/project/44444444-4444-4444-8444-444444444444/usage.json",
        ),
    ] {
        copy_history_fixture(&home, &project, fixture, destination);
    }
    let data = home.join(".local/share/opencode");
    fs::create_dir_all(&data).unwrap();
    let native_db = rusqlite::Connection::open(data.join("opencode.db")).unwrap();
    native_db.execute_batch("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, version TEXT, model TEXT);
        CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);").unwrap();
    native_db.execute("INSERT INTO session VALUES ('ses_macos', 'macOS fixture', ?1, 1790668800000, 1790668860000, '1.18.33', NULL)", [project.to_str().unwrap()]).unwrap();
    let db = Database::open(&temp.path().join("app.db")).unwrap();
    let registry = registry();
    let report = history::refresh(&db, &registry, &home).unwrap();
    assert!(
        report.iter().all(|status| status.failed_count == 0),
        "{report:?}"
    );
    let sessions = history::list(&db, &HistoryFilter::default()).unwrap();
    assert_eq!(sessions.len(), 5);
    for session in sessions {
        let plan =
            history::resume_plan(&db, &registry, &home, &session.id, LaunchMode::Normal).unwrap();
        assert_eq!(plan.terminal, TerminalId::MacTerminal);
        assert_eq!(plan.directory, project);
        assert!(plan.cli_args.contains(session.native_id.as_ref().unwrap()));
        let terminal = launch::terminal_command(&plan).unwrap();
        assert_eq!(terminal.program, "/usr/bin/open");
        let script = terminal.mac_script.unwrap();
        assert!(script.contains("export PATH="));
        assert!(script.contains(session.native_id.as_ref().unwrap()));
        assert!(!script.contains("do script"));
    }
}
