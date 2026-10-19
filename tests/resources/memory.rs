use super::*;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::accounts::{AccountState, AuthAccount, NativeContext};
use crate::adapters::memory::{
    MemoryDeclaration, MemoryOperation, MemoryScope, MemoryTargetDimension,
};
use crate::adapters::{CliAdapter, Registry};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::library::LibraryKind;
use crate::native::adapter::Scope;
use crate::portable::{self, PortablePayload};

const FULL: &[MemoryOperation] = &[
    MemoryOperation::List,
    MemoryOperation::Open,
    MemoryOperation::Create,
    MemoryOperation::Edit,
    MemoryOperation::Delete,
    MemoryOperation::MasterSwitch,
    MemoryOperation::ItemEnable,
];
const READ: &[MemoryOperation] = &[MemoryOperation::List, MemoryOperation::Open];
const ACCOUNT: &[MemoryTargetDimension] = &[MemoryTargetDimension::Account];
const PROJECT_DIM: &[MemoryTargetDimension] = &[MemoryTargetDimension::Project];
const NO_TARGET: &[MemoryTargetDimension] = &[];

struct MemoryCli {
    id: &'static str,
    location: &'static str,
    read_only: bool,
    binds_account: bool,
    global: bool,
    project: bool,
}

const WRITABLE: MemoryCli = MemoryCli {
    id: "fixture_memory_write",
    location: "cliora-memory",
    read_only: false,
    binds_account: true,
    global: true,
    project: false,
};
const OTHER: MemoryCli = MemoryCli {
    id: "fixture_memory_other",
    location: "cliora-memory-other",
    read_only: false,
    binds_account: true,
    global: true,
    project: false,
};
const READ_ONLY: MemoryCli = MemoryCli {
    id: "fixture_memory_readonly",
    location: "cliora-memory-readonly",
    read_only: true,
    binds_account: false,
    global: true,
    project: false,
};
const SHARED: MemoryCli = MemoryCli {
    id: "fixture_memory_shared",
    location: "cliora-memory-shared",
    read_only: false,
    binds_account: false,
    global: true,
    project: false,
};
const PROJECT: MemoryCli = MemoryCli {
    id: "fixture_memory_project",
    location: "cliora-memory",
    read_only: false,
    binds_account: false,
    global: false,
    project: true,
};
const PROMPTS: MemoryCli = MemoryCli {
    id: "fixture_memory_prompts",
    location: "declared/prompts",
    read_only: false,
    binds_account: false,
    global: true,
    project: false,
};

impl MemoryCli {
    fn base<'a>(&self, scope: Scope, home: &'a Path, project: Option<&'a Path>) -> &'a Path {
        match scope {
            Scope::Project => project.unwrap_or(home),
            Scope::Global => home,
        }
    }

    fn declared(&self) -> MemoryDeclaration {
        MemoryDeclaration {
            scope: MemoryScope {
                global: self.global,
                project: self.project,
            },
            targets: if self.binds_account {
                ACCOUNT
            } else if self.project && !self.global {
                PROJECT_DIM
            } else {
                NO_TARGET
            },
            operations: if self.read_only { READ } else { FULL },
            unverified_reason: "",
            limitation: if self.read_only {
                "只读存储，不能新建、编辑、删除或启停"
            } else {
                ""
            },
            binds_account: self.binds_account,
        }
    }
}

impl crate::adapters::memory::MemoryAdapter for MemoryCli {
    fn declaration(&self) -> MemoryDeclaration {
        self.declared()
    }

    fn directory(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Ok(self.base(scope, home, project).join(self.location))
    }
}

impl crate::adapters::plugins::PluginAdapter for MemoryCli {
    fn capability(&self) -> crate::adapters::plugins::PluginCapability {
        crate::adapters::plugins::PluginCapability {
            version: "fixture",
            sources: "none",
            actions: Vec::new(),
            project: self.project,
            detail: "fixture",
        }
    }

    fn command_args(
        &self,
        _action: &str,
        _source: &str,
        _project: bool,
    ) -> Result<Vec<String>, String> {
        Err("夹具不执行插件命令".into())
    }

    fn snapshot_files(
        &self,
        home: &Path,
        _target: &crate::resources::plugins::PluginTarget,
    ) -> Vec<PathBuf> {
        vec![home.join("declared").join("prompts")]
    }
}

impl crate::adapters::agents::AgentAdapter for MemoryCli {
    fn capability(&self) -> crate::adapters::agents::AgentCapability {
        crate::adapters::agents::AgentCapability {
            version: "fixture",
            supported: true,
            format: "md",
            detail: "fixture",
            template: "",
        }
    }

    fn root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Result<PathBuf, String> {
        Ok(self
            .base(scope, home, project)
            .join("declared")
            .join("agents"))
    }
}

impl CliAdapter for MemoryCli {
    fn id(&self) -> &'static str {
        self.id
    }
    fn name(&self) -> &'static str {
        self.id
    }
    fn command(&self) -> &'static str {
        "fixture-memory"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn version_identity(&self, _basename: &str, _output: &str) -> bool {
        false
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        _known: bool,
    ) -> Vec<crate::native::adapter::NativeFile> {
        let base = self.base(scope, home, project);
        vec![
            crate::native::adapter::NativeFile {
                role: "settings",
                path: base
                    .join("declared")
                    .join("config.json")
                    .display()
                    .to_string(),
                format: "json",
                writable: true,
                reason: None,
                sensitive: false,
            },
            crate::native::adapter::NativeFile {
                role: "auth",
                path: base
                    .join("declared")
                    .join("auth.json")
                    .display()
                    .to_string(),
                format: "json",
                writable: true,
                reason: None,
                sensitive: true,
            },
        ]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, _role: &str) -> Result<crate::native::format::FileKind, String> {
        Err("夹具不提供原生文件".into())
    }
    fn connection_documents(
        &self,
        _connection: &crate::native::profile::Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, serde_json::Value>, String> {
        Ok(BTreeMap::new())
    }
    fn write_connection_secret(
        &self,
        _profile: &crate::native::profile::RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut crate::native::apply::NativeSecrets,
    ) -> Result<(), String> {
        Ok(())
    }
    fn has_native_secret(&self, _role: &str, _root: &serde_json::Value) -> bool {
        false
    }
    fn inspect_values(
        &self,
        _settings: &serde_json::Value,
        _local_settings: &serde_json::Value,
        _models: &serde_json::Value,
    ) -> crate::adapters::InspectionFields {
        crate::adapters::InspectionFields::default()
    }
    fn launch_args(
        &self,
        _session: Option<&str>,
        _mode: crate::adapters::LaunchMode,
    ) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        ("", "")
    }
    fn memory(&self) -> Option<&dyn crate::adapters::memory::MemoryAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn rule_path(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(
            self.base(scope, home, project)
                .join("declared")
                .join("RULE.md"),
        )
    }
    fn uses_rule_catalog(&self, _scope: Scope) -> bool {
        true
    }
    fn rule_file_specs(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<crate::adapters::RuleFileSpec>, String> {
        Ok(vec![crate::adapters::RuleFileSpec {
            id: "declared-rule".into(),
            path: self
                .base(scope, home, project)
                .join(self.location)
                .join("RULE.md"),
            name: "RULE.md".into(),
            kind: "mdc",
            enabled: true,
            writable: true,
            detail: "",
        }])
    }
    fn skill_root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(
            self.base(scope, home, project)
                .join("declared")
                .join("skills"),
        )
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<crate::adapters::McpLocation> {
        Some(crate::adapters::McpLocation {
            path: self
                .base(scope, home, project)
                .join("declared")
                .join("mcp.json"),
            kind: crate::native::format::FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn history_sources(&self, home: &Path) -> Result<Vec<crate::history::HistorySource>, String> {
        Ok(vec![crate::history::HistorySource {
            native_title: None,
            path: home.join("declared").join("sessions").join("log.jsonl"),
            native_id: None,
            fingerprint: String::new(),
            fingerprint_error: None,
        }])
    }
}

struct Store(Mutex<HashMap<String, String>>);

impl CredentialStore for Store {
    fn put(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn get(&self, key: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| "missing".into())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

struct Harness {
    temp: tempfile::TempDir,
    db: Database,
    store: Store,
    registry: Registry,
    home: PathBuf,
}

fn harness() -> Harness {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("cliora.db")).unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    Harness {
        temp,
        db,
        store: Store(Mutex::new(HashMap::new())),
        registry: Registry::with_adapters(vec![
            &WRITABLE, &OTHER, &READ_ONLY, &SHARED, &PROJECT, &PROMPTS,
        ])
        .unwrap(),
        home,
    }
}

fn memory_target(tool: &str, scope: Scope, project: Option<&Path>, context: Option<&str>) -> MemoryTarget {
    MemoryTarget {
        tool_id: tool.into(),
        scope,
        project_path: project.map(|path| path.display().to_string()),
        context_id: context.map(str::to_owned),
    }
}

fn save<'a>(
    harness: &'a Harness,
    target: MemoryTarget,
    id: &str,
    text: &str,
    baseline: &str,
    confirm: bool,
) -> Result<MemoryDocument, String> {
    save_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemorySave {
            target,
            id: id.into(),
            text: text.into(),
            baseline: baseline.into(),
            confirm_external: confirm,
        },
    )
}

fn write_declared(
    adapter: &dyn CliAdapter,
    home: &Path,
    scope: Scope,
    project: Option<&Path>,
) -> Vec<(PathBuf, String)> {
    let prompts = adapter.plugins().unwrap().snapshot_files(
        home,
        &crate::resources::plugins::PluginTarget {
            tool_id: adapter.id().into(),
            scope,
            project_path: project.map(|path| path.display().to_string()),
            context_id: None,
        },
    );
    let mut files = vec![
        (
            adapter.rule_path(scope, home, project).unwrap(),
            "rule-sentinel\n".into(),
        ),
        (
            adapter.rule_file_specs(scope, home, project).unwrap()[0]
                .path
                .clone(),
            "catalog-rule-sentinel\n".into(),
        ),
        (
            adapter
                .skill_root(scope, home, project)
                .unwrap()
                .join("SKILL.md"),
            "skill-sentinel\n".into(),
        ),
        (
            adapter.mcp_location(scope, home, project).unwrap().path,
            "mcp-sentinel\n".into(),
        ),
        (
            adapter
                .agents()
                .unwrap()
                .root(scope, home, project)
                .unwrap()
                .join("agent.md"),
            "agent-sentinel\n".into(),
        ),
        (
            adapter
                .history_sources(home)
                .unwrap()
                .into_iter()
                .next()
                .unwrap()
                .path,
            "history-sentinel\n".into(),
        ),
        (prompts[0].join("note.md"), "prompt-sentinel\n".into()),
    ];
    for native in adapter.native_files(scope, home, project, true) {
        files.push((
            PathBuf::from(native.path),
            format!("{}-sentinel\n", native.role),
        ));
    }
    for (path, text) in &files {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }
    files
}

fn assert_unchanged(files: &[(PathBuf, String)]) {
    for (path, text) in files {
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            *text,
            "{}",
            path.display()
        );
    }
}

fn count(db: &Database, table: &str) -> i64 {
    db.with_connection(|conn| {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
    })
    .unwrap()
}

fn counts(db: &Database) -> (i64, i64, i64, i64) {
    (
        count(db, "library_items"),
        count(db, "auth_accounts"),
        count(db, "skill_packages"),
        count(db, "mcp_definitions"),
    )
}

fn apply_oauth_binding(db: &Database, tool: &str, context_id: &str) {
    let account_id = format!("account-{context_id}");
    let profile_id = format!("profile-{context_id}");
    let profile = crate::native::profile::RegisteredProfile {
        editing: None,
        id: profile_id.clone(),
        tool: tool.into(),
        name: "applied".into(),
        version: 1,
        revision: String::new(),
        inherit_common: false,
        files: BTreeMap::new(),
        suppressed: BTreeMap::new(),
        connection: None,
        authentication: crate::native::profile::ProfileAuthentication::OAuth {
            account_id,
        },
        native_credentials: BTreeMap::new(),
    };
    let snapshot = crate::native::apply::AppliedProfileSnapshot {
        source_profile: profile.clone(),
        runtime_profile: profile,
        model_summary: None,
    };
    let applied = serde_json::to_string(&snapshot).unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO applied_bindings(scope_key,tool,profile_id,profile_version,managed,context_id,applied_profile) VALUES('global',?1,?2,1,'{}',?3,?4)",
            rusqlite::params![tool, profile_id, context_id, applied],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
}

fn break_applied_binding(db: &Database, tool: &str) {
    db.with_connection(|conn| {
        conn.execute(
            "UPDATE applied_bindings SET profile_id='broken-profile' WHERE scope_key='global' AND tool=?1",
            [tool],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
}

fn insert_account(db: &Database, tool: &str, context_id: &str, home: &Path) {
    let context = NativeContext {
        id: context_id.into(),
        tool_id: tool.into(),
        root: home.join("accounts").join(context_id),
        config_root: home.join("declared").join("config-root"),
        auth_files: vec![home.join("declared").join("auth.json")],
        history_roots: vec![home.join("declared").join("sessions")],
        resource_root: home.join("declared").join("resources"),
        environment: BTreeMap::new(),
        remove_environment: Vec::new(),
        cli_args: Vec::new(),
    };
    let account = AuthAccount {
        id: format!("account-{context_id}"),
        tool_id: tool.into(),
        provider: "fixture".into(),
        label: "fixture".into(),
        version: 1,
        state: AccountState::SignedIn,
        identity: None,
        context: Some(context),
        retired_contexts: Vec::new(),
        pending_login: None,
        checked_at: None,
        detail: None,
    };
    let data = serde_json::to_string(&account).unwrap();
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO auth_accounts(id,tool,version,data) VALUES(?1,?2,?3,?4)",
            rusqlite::params![account.id, account.tool_id, account.version, data],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .unwrap();
}

fn account_json(db: &Database, id: &str) -> String {
    db.with_connection(|conn| {
        conn.query_row("SELECT data FROM auth_accounts WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())
    })
    .unwrap()
}

struct ClearReadonly(PathBuf);

impl Drop for ClearReadonly {
    fn drop(&mut self) {
        if let Ok(metadata) = fs::metadata(&self.0) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&self.0, permissions);
        }
    }
}

fn payload_kind(payload: &PortablePayload) -> &'static str {
    match payload {
        PortablePayload::Preferences(_) => "preferences",
        PortablePayload::Profile(_) => "profile",
        PortablePayload::Common(_) => "common",
        PortablePayload::Project(_) => "project",
        PortablePayload::Library(_) => "library",
        PortablePayload::Mcp(_) => "mcp",
        PortablePayload::Skill(_) => "skill",
        PortablePayload::Account(_) => "account",
        PortablePayload::Binding(_) => "binding",
    }
}

fn library_name(kind: LibraryKind) -> &'static str {
    match kind {
        LibraryKind::Prompt => "prompt",
        LibraryKind::Rule => "rule",
    }
}

#[test]
fn create_reread_stays_on_that_account_and_cli() {
    let harness = harness();
    let adapter = harness.registry.get(WRITABLE.id).unwrap();
    let declared = write_declared(adapter, &harness.home, Scope::Global, None);
    insert_account(&harness.db, WRITABLE.id, "acct-a", &harness.home);
    let before_account = account_json(&harness.db, "account-acct-a");
    let before_counts = counts(&harness.db);
    let missing = memory_target(WRITABLE.id, Scope::Global, None, Some("missing"));
    assert!(save(&harness, missing, "note", "alpha memory", "", false).is_err());
    assert!(!harness
        .home
        .join(WRITABLE.location)
        .join("missing")
        .exists());

    let bound = memory_target(WRITABLE.id, Scope::Global, None, Some("acct-a"));
    let saved = save(&harness, bound.clone(), "note", "alpha memory", "", false).unwrap();
    let opened = read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &bound,
        "note",
    )
    .unwrap();
    assert_eq!(opened.text, "alpha memory");
    assert_eq!(saved.text, opened.text);
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "alpha memory");
    assert!(saved.path.contains("acct-a"));
    assert!(!saved.path.contains("_unbound"));
    assert!(!Path::new(&saved.path).starts_with(harness.home.join("declared")));
    let listed = list_memories(&harness.db, &harness.registry, &harness.home, &bound).unwrap();
    assert!(listed.operations.contains(&MemoryOperation::Create));
    assert_eq!(listed.entries.len(), 1);

    let other = memory_target(OTHER.id, Scope::Global, None, None);
    assert!(
        list_memories(&harness.db, &harness.registry, &harness.home, &other)
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &other,
        "note"
    )
    .is_err());
    let other_bound = memory_target(OTHER.id, Scope::Global, None, Some("acct-a"));
    assert!(read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &other_bound,
        "note"
    )
    .is_err());
    assert!(!harness
        .home
        .join(OTHER.location)
        .join("_unbound")
        .join("note.md")
        .exists());
    assert!(!harness
        .home
        .join(OTHER.location)
        .join("acct-a")
        .join("note.md")
        .exists());

    let unbound = memory_target(WRITABLE.id, Scope::Global, None, None);
    assert!(
        list_memories(&harness.db, &harness.registry, &harness.home, &unbound)
            .unwrap()
            .entries
            .is_empty()
    );
    save(&harness, unbound.clone(), "note", "beta memory", "", false).unwrap();
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &bound,
            "note"
        )
        .unwrap()
        .text,
        "alpha memory"
    );
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &unbound,
            "note"
        )
        .unwrap()
        .text,
        "beta memory"
    );
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "alpha memory");
    assert_unchanged(&declared);
    assert_eq!(account_json(&harness.db, "account-acct-a"), before_account);
    assert!(!before_account.contains("alpha memory"));
    assert_eq!(counts(&harness.db), before_counts);
}

#[test]
fn omitted_context_stays_unbound_when_oauth_binding_is_applied() {
    let harness = harness();
    insert_account(&harness.db, WRITABLE.id, "acct-applied", &harness.home);
    apply_oauth_binding(&harness.db, WRITABLE.id, "acct-applied");
    let resolved = crate::accounts::selection::bound(
        &harness.db,
        &harness.home,
        WRITABLE.id,
        Scope::Global,
        None,
        false,
    )
    .unwrap()
    .expect("applied oauth binding");
    assert_eq!(resolved.1.id, "acct-applied");

    let explicit = memory_target(WRITABLE.id, Scope::Global, None, Some("acct-applied"));
    let account = save(
        &harness,
        explicit.clone(),
        "note",
        "account memory",
        "",
        false,
    )
    .unwrap();
    assert!(account.path.contains("acct-applied"));
    assert!(!account.path.contains("_unbound"));
    let account_note = PathBuf::from(&account.path);

    let omitted = memory_target(WRITABLE.id, Scope::Global, None, None);
    let blank = memory_target(WRITABLE.id, Scope::Global, None, Some(""));
    assert!(
        list_memories(&harness.db, &harness.registry, &harness.home, &omitted)
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &omitted,
        "note"
    )
    .is_err());

    let unbound = save(
        &harness,
        omitted.clone(),
        "note",
        "unbound memory",
        "",
        false,
    )
    .unwrap();
    assert!(unbound.path.contains("_unbound"));
    assert!(!unbound.path.contains("acct-applied"));
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &omitted,
            "note"
        )
        .unwrap()
        .text,
        "unbound memory"
    );
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &blank,
            "note"
        )
        .unwrap()
        .text,
        "unbound memory"
    );
    let listed = list_memories(&harness.db, &harness.registry, &harness.home, &omitted).unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert!(listed.entries[0].path.contains("_unbound"));
    assert!(!listed.entries[0].path.contains("acct-applied"));
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &explicit,
            "note"
        )
        .unwrap()
        .text,
        "account memory"
    );
    let listed_account =
        list_memories(&harness.db, &harness.registry, &harness.home, &explicit).unwrap();
    assert_eq!(listed_account.entries.len(), 1);
    assert!(listed_account.entries[0].path.contains("acct-applied"));
    assert_eq!(fs::read_to_string(&account_note).unwrap(), "account memory");

    break_applied_binding(&harness.db, WRITABLE.id);
    let broken = crate::accounts::selection::bound(
        &harness.db,
        &harness.home,
        WRITABLE.id,
        Scope::Global,
        None,
        false,
    )
    .unwrap_err();
    assert!(broken.contains("不一致"), "{broken}");

    let revised = save(
        &harness,
        omitted.clone(),
        "note",
        "unbound revised",
        "unbound memory",
        false,
    )
    .unwrap();
    assert!(revised.path.contains("_unbound"));
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &omitted,
            "note"
        )
        .unwrap()
        .text,
        "unbound revised"
    );
    let switched = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target: omitted.clone(),
            id: None,
            enabled: false,
        },
    )
    .unwrap();
    assert!(!switched.in_use);
    assert!(switched.entries.iter().all(|entry| entry.path.contains("_unbound")));
    let enabled = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target: omitted.clone(),
            id: Some("note".into()),
            enabled: false,
        },
    )
    .unwrap();
    assert!(!enabled.entries[0].enabled);
    delete_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryDelete {
            target: omitted,
            id: "note".into(),
            baseline: "unbound revised".into(),
        },
    )
    .unwrap();
    assert!(!PathBuf::from(&revised.path).exists());
    assert_eq!(fs::read_to_string(&account_note).unwrap(), "account memory");
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &explicit,
            "note"
        )
        .unwrap()
        .text,
        "account memory"
    );
    assert!(
        list_memories(&harness.db, &harness.registry, &harness.home, &blank)
            .unwrap()
            .entries
            .is_empty()
    );
}

#[test]
fn account_context_participates_only_when_declared() {
    let harness = harness();
    let with_context = memory_target(SHARED.id, Scope::Global, None, Some("missing"));
    let saved = save(&harness, with_context, "note", "shared body", "", false).unwrap();
    assert!(!saved.path.contains("missing"));
    assert!(!saved.path.contains("_unbound"));
    let plain = memory_target(SHARED.id, Scope::Global, None, None);
    let other = memory_target(SHARED.id, Scope::Global, None, Some("other"));
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &plain,
            "note"
        )
        .unwrap()
        .text,
        "shared body"
    );
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &other,
            "note"
        )
        .unwrap()
        .text,
        "shared body"
    );
    assert_eq!(counts(&harness.db).1, 0);
}

#[test]
fn read_only_exposes_no_write_operation() {
    let harness = harness();
    let path = harness.home.join(READ_ONLY.location).join("note.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "read only body").unwrap();
    let target = memory_target(READ_ONLY.id, Scope::Global, None, None);
    let listed = list_memories(&harness.db, &harness.registry, &harness.home, &target).unwrap();
    assert_eq!(listed.operations, READ);
    for operation in [
        MemoryOperation::Create,
        MemoryOperation::Edit,
        MemoryOperation::Delete,
        MemoryOperation::MasterSwitch,
        MemoryOperation::ItemEnable,
    ] {
        assert!(!listed.operations.contains(&operation), "{operation:?}");
    }
    assert!(listed.limitation.contains("只读"));
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &target,
            "note"
        )
        .unwrap()
        .text,
        "read only body"
    );
    let save_error = save(
        &harness,
        target.clone(),
        "note",
        "changed",
        "read only body",
        false,
    )
    .unwrap_err();
    assert!(save_error.contains("只读"), "{save_error}");
    let delete_error = delete_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryDelete {
            target: target.clone(),
            id: "note".into(),
            baseline: "read only body".into(),
        },
    )
    .unwrap_err();
    assert!(delete_error.contains("只读"), "{delete_error}");
    let enable_error = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target,
            id: None,
            enabled: false,
        },
    )
    .unwrap_err();
    assert!(enable_error.contains("只读"), "{enable_error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), "read only body");
    assert!(!path
        .parent()
        .unwrap()
        .join(".cliora-memory-switch")
        .exists());
}

#[test]
fn master_switch_off_still_lists_and_opens() {
    let harness = harness();
    insert_account(&harness.db, WRITABLE.id, "acct-a", &harness.home);
    let target = memory_target(WRITABLE.id, Scope::Global, None, Some("acct-a"));
    let saved = save(&harness, target.clone(), "note", "switch body", "", false).unwrap();
    let disabled = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target: target.clone(),
            id: None,
            enabled: false,
        },
    )
    .unwrap();
    assert!(!disabled.in_use);
    assert!(disabled.detail.contains("未使用"), "{}", disabled.detail);
    assert_eq!(disabled.entries.len(), 1);
    let opened = read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &target,
        "note",
    )
    .unwrap();
    assert_eq!(opened.text, "switch body");
    assert!(!opened.in_use);
    assert!(opened.detail.contains("未使用"));
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "switch body");
    let enabled = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target: target.clone(),
            id: None,
            enabled: true,
        },
    )
    .unwrap();
    assert!(enabled.in_use);
    let item_off = set_memory_enabled(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryEnable {
            target: target.clone(),
            id: Some("note".into()),
            enabled: false,
        },
    )
    .unwrap();
    assert!(!item_off.entries[0].enabled);
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "switch body");
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &target,
            "note"
        )
        .unwrap()
        .text,
        "switch body"
    );
}

#[test]
fn external_edit_is_not_written_until_confirmed() {
    let harness = harness();
    let target = memory_target(SHARED.id, Scope::Global, None, None);
    let saved = save(&harness, target.clone(), "note", "page", "", false).unwrap();
    fs::write(&saved.path, "external").unwrap();
    let rejected = save(&harness, target.clone(), "note", "next", "page", false).unwrap_err();
    assert!(rejected.contains("请重试"), "{rejected}");
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "external");
    let confirmed = save(&harness, target.clone(), "note", "next", "page", true).unwrap();
    assert_eq!(confirmed.text, "next");
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "next");
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &target,
            "note"
        )
        .unwrap()
        .text,
        "next"
    );
}

#[test]
fn failed_read_save_or_delete_keeps_bytes_and_list() {
    let harness = harness();
    let target = memory_target(SHARED.id, Scope::Global, None, None);
    let saved = save(&harness, target.clone(), "note", "kept", "", false).unwrap();
    fs::write(&saved.path, [0xff, 0xfe]).unwrap();
    let read_error = read_memory(
        &harness.db,
        &harness.registry,
        &harness.home,
        &target,
        "note",
    )
    .unwrap_err();
    assert!(read_error.contains("请重试"), "{read_error}");
    assert_eq!(fs::read(&saved.path).unwrap(), vec![0xff, 0xfe]);
    let listed = list_memories(&harness.db, &harness.registry, &harness.home, &target).unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert_eq!(listed.entries[0].id, "note");

    fs::write(&saved.path, "kept").unwrap();
    let fingerprint = list_memories(&harness.db, &harness.registry, &harness.home, &target)
        .unwrap()
        .entries[0]
        .fingerprint
        .clone();
    {
        let _clear = ClearReadonly(PathBuf::from(&saved.path));
        let mut permissions = fs::metadata(&saved.path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&saved.path, permissions).unwrap();
        let save_error =
            save(&harness, target.clone(), "note", "changed", "kept", false).unwrap_err();
        assert!(save_error.contains("请重试"), "{save_error}");
        assert_eq!(fs::read_to_string(&saved.path).unwrap(), "kept");
        assert_eq!(
            list_memories(&harness.db, &harness.registry, &harness.home, &target)
                .unwrap()
                .entries[0]
                .fingerprint,
            fingerprint
        );
    }
    let delete_error = delete_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryDelete {
            target: target.clone(),
            id: "note".into(),
            baseline: "stale".into(),
        },
    )
    .unwrap_err();
    assert!(delete_error.contains("重试"), "{delete_error}");
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "kept");
    assert_eq!(
        list_memories(&harness.db, &harness.registry, &harness.home, &target)
            .unwrap()
            .entries
            .len(),
        1
    );
}

#[test]
fn skipping_delete_leaves_the_entry() {
    let harness = harness();
    let target = memory_target(SHARED.id, Scope::Global, None, None);
    let saved = save(&harness, target.clone(), "note", "stay", "", false).unwrap();
    assert_eq!(
        list_memories(&harness.db, &harness.registry, &harness.home, &target)
            .unwrap()
            .entries
            .len(),
        1
    );
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "stay");
    assert_eq!(
        list_memories(&harness.db, &harness.registry, &harness.home, &target)
            .unwrap()
            .entries[0]
            .id,
        "note"
    );
    delete_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryDelete {
            target: target.clone(),
            id: "note".into(),
            baseline: "stay".into(),
        },
    )
    .unwrap();
    assert!(
        list_memories(&harness.db, &harness.registry, &harness.home, &target)
            .unwrap()
            .entries
            .is_empty()
    );
    assert!(!Path::new(&saved.path).exists());
}

#[test]
fn list_and_writes_skip_declared_non_memory_paths() {
    let harness = harness();
    let adapter = harness.registry.get(SHARED.id).unwrap();
    let declared = write_declared(adapter, &harness.home, Scope::Global, None);
    let before = counts(&harness.db);
    let target = memory_target(SHARED.id, Scope::Global, None, None);
    let saved = save(&harness, target.clone(), "note", "only memory", "", false).unwrap();
    let listed = list_memories(&harness.db, &harness.registry, &harness.home, &target).unwrap();
    assert_eq!(
        listed
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["note"]
    );
    for (path, _) in &declared {
        assert!(listed
            .entries
            .iter()
            .all(|entry| Path::new(&entry.path) != path));
    }
    assert_unchanged(&declared);
    let blocked = save(&harness, target.clone(), "RULE", "overwrite", "", false).unwrap_err();
    assert!(blocked.contains("不能当作记忆"), "{blocked}");
    let delete_blocked = delete_memory(
        &harness.db,
        &harness.store,
        &harness.registry,
        &harness.home,
        &MemoryDelete {
            target,
            id: "RULE".into(),
            baseline: "catalog-rule-sentinel\n".into(),
        },
    )
    .unwrap_err();
    assert!(delete_blocked.contains("不能当作记忆"), "{delete_blocked}");
    assert_unchanged(&declared);
    assert_eq!(fs::read_to_string(&saved.path).unwrap(), "only memory");
    assert_eq!(counts(&harness.db), before);

    let prompts = harness.registry.get(PROMPTS.id).unwrap();
    let prompt_files = write_declared(prompts, &harness.home, Scope::Global, None);
    let prompt_target = memory_target(PROMPTS.id, Scope::Global, None, None);
    let prompt_list = list_memories(
        &harness.db,
        &harness.registry,
        &harness.home,
        &prompt_target,
    )
    .unwrap();
    assert!(prompt_list
        .entries
        .iter()
        .all(|entry| entry.id != "note" && entry.id != "RULE"));
    let prompt_save = save(
        &harness,
        prompt_target.clone(),
        "note",
        "should not land",
        "",
        false,
    )
    .unwrap_err();
    assert!(prompt_save.contains("不能当作记忆"), "{prompt_save}");
    assert_unchanged(&prompt_files);
}

#[test]
fn import_export_do_not_rewrite_memory_files() {
    let harness = harness();
    let target = memory_target(SHARED.id, Scope::Global, None, None);
    let saved = save(
        &harness,
        target,
        "note",
        "memory-body-not-in-snapshot",
        "",
        false,
    )
    .unwrap();
    let bytes = fs::read(&saved.path).unwrap();
    let before = counts(&harness.db);
    assert!(serde_json::from_str::<LibraryKind>("\"memory\"").is_err());
    assert_eq!(
        library_name(serde_json::from_str("\"prompt\"").unwrap()),
        "prompt"
    );
    assert_eq!(
        library_name(serde_json::from_str("\"rule\"").unwrap()),
        "rule"
    );

    let snapshot =
        portable::collect_snapshot(&harness.db, &harness.store, &harness.registry).unwrap();
    assert_eq!(snapshot.schema_version, 3);
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("memory-body-not-in-snapshot"));
    for entity in &snapshot.entities {
        assert!(matches!(
            payload_kind(&entity.payload),
            "preferences"
                | "profile"
                | "common"
                | "project"
                | "library"
                | "mcp"
                | "skill"
                | "account"
                | "binding"
        ));
    }
    let draft =
        portable::preview_import(&harness.db, &harness.store, &harness.registry, snapshot).unwrap();
    let selected: BTreeSet<String> = draft.items.iter().map(|item| item.key.clone()).collect();
    portable::apply_import(
        &harness.db,
        &harness.store,
        &harness.registry,
        &draft,
        &selected,
    )
    .unwrap();
    portable::export_bundle(
        &harness.db,
        &harness.store,
        &harness.registry,
        "memory-export-test",
        None,
        &harness.temp.path().join("bundle.bin"),
    )
    .unwrap();
    assert_eq!(fs::read(&saved.path).unwrap(), bytes);
    assert_eq!(counts(&harness.db), before);
}

#[test]
fn project_memory_stays_on_the_selected_project() {
    let harness = harness();
    let project = harness.temp.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let adapter = harness.registry.get(PROJECT.id).unwrap();
    let declared = write_declared(adapter, &harness.home, Scope::Project, Some(&project));
    let target = memory_target(PROJECT.id, Scope::Project, Some(&project), Some("acct-a"));
    let saved = save(&harness, target, "note", "project memory", "", false).unwrap();
    assert_eq!(saved.text, "project memory");
    assert!(Path::new(&saved.path).starts_with(project.canonicalize().unwrap()));
    assert!(!harness.home.join("cliora-memory").join("note.md").exists());
    assert_unchanged(&declared);
    let global = memory_target(PROJECT.id, Scope::Global, None, None);
    assert!(list_memories(&harness.db, &harness.registry, &harness.home, &global).is_err());
    assert_eq!(counts(&harness.db).1, 0);
}

#[test]
fn missing_port_does_not_create_memory() {
    let harness = harness();
    let registry = Registry::builtins();
    for id in ["codex", "claude_code"] {
        let error = list_memories(
            &harness.db,
            &registry,
            &harness.home,
            &memory_target(id, Scope::Global, None, None),
        )
        .unwrap_err();
        assert!(error.contains("没有已核实的记忆"), "{id}: {error}");
    }
    assert!(!harness.home.join("cliora-memory").exists());
}

fn link_directory(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg keeps the quotes cmd.exe expects. Command::arg would wrap the
        // whole mklink line and make cmd strip the path quotes.
        let output = std::process::Command::new("cmd")
            .raw_arg(format!(
                "/C mklink /J \"{}\" \"{}\"",
                link.display(),
                target.display()
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link).unwrap();
}

struct Unlink<'a>(&'a Path);

impl Drop for Unlink<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_dir(self.0);
    }
}

fn assert_reparse_rejected(error: &str) {
    assert!(
        error.contains("重解析点") || error.contains("符号链接"),
        "{error}"
    );
}

fn reject_linked_memory(harness: &Harness, link_target: &MemoryTarget, real_note: &Path) {
    assert_reparse_rejected(
        &list_memories(&harness.db, &harness.registry, &harness.home, link_target).unwrap_err(),
    );
    assert_reparse_rejected(
        &read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            link_target,
            "note",
        )
        .unwrap_err(),
    );
    assert_reparse_rejected(
        &save(harness, link_target.clone(), "note", "rewritten", "", false).unwrap_err(),
    );
    assert_reparse_rejected(
        &set_memory_enabled(
            &harness.db,
            &harness.store,
            &harness.registry,
            &harness.home,
            &MemoryEnable {
                target: link_target.clone(),
                id: None,
                enabled: false,
            },
        )
        .unwrap_err(),
    );
    assert_eq!(fs::read_to_string(real_note).unwrap(), "original memory");
    assert!(!real_note.parent().unwrap().join(".cliora-memory-switch").exists());
}

#[test]
fn junction_memory_directory_and_ancestor_are_not_followed() {
    let harness = harness();
    let real = harness.temp.path().join("real-memory");
    fs::create_dir_all(&real).unwrap();
    let note = real.join("note.md");
    fs::write(&note, "original memory").unwrap();
    let link = harness.home.join(SHARED.location);
    link_directory(&real, &link);
    let _unlink = Unlink(&link);
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let metadata = fs::symlink_metadata(&link).unwrap();
        assert_ne!(
            metadata.file_attributes() & 0x400,
            0,
            "directory junction must keep FILE_ATTRIBUTE_REPARSE_POINT"
        );
    }
    reject_linked_memory(
        &harness,
        &memory_target(SHARED.id, Scope::Global, None, None),
        &note,
    );

    let real_declared = harness.temp.path().join("real-declared");
    let prompts = real_declared.join("prompts");
    fs::create_dir_all(&prompts).unwrap();
    let prompt_note = prompts.join("note.md");
    fs::write(&prompt_note, "original memory").unwrap();
    let declared_link = harness.home.join("declared");
    link_directory(&real_declared, &declared_link);
    let _unlink_declared = Unlink(&declared_link);
    reject_linked_memory(
        &harness,
        &memory_target(PROMPTS.id, Scope::Global, None, None),
        &prompt_note,
    );
}
