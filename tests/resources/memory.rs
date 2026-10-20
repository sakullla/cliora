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
    /// Read-only store scan fixtures: (label, scope, directory name under home).
    stores: &'static [(&'static str, Scope, &'static str)],
}

const WRITABLE: MemoryCli = MemoryCli {
    id: "fixture_memory_write",
    location: "cliora-memory",
    read_only: false,
    binds_account: true,
    global: true,
    project: false,
    stores: &[],
};
const OTHER: MemoryCli = MemoryCli {
    id: "fixture_memory_other",
    location: "cliora-memory-other",
    read_only: false,
    binds_account: true,
    global: true,
    project: false,
    stores: &[],
};
const READ_ONLY: MemoryCli = MemoryCli {
    id: "fixture_memory_readonly",
    location: "cliora-memory-readonly",
    read_only: true,
    binds_account: false,
    global: true,
    project: false,
    stores: &[],
};
const SHARED: MemoryCli = MemoryCli {
    id: "fixture_memory_shared",
    location: "cliora-memory-shared",
    read_only: false,
    binds_account: false,
    global: true,
    project: false,
    stores: &[],
};
const PROJECT: MemoryCli = MemoryCli {
    id: "fixture_memory_project",
    location: "cliora-memory",
    read_only: false,
    binds_account: false,
    global: false,
    project: true,
    stores: &[],
};
const PROMPTS: MemoryCli = MemoryCli {
    id: "fixture_memory_prompts",
    location: "declared/prompts",
    read_only: false,
    binds_account: false,
    global: true,
    project: false,
    stores: &[],
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

    fn existing_stores(&self, home: &Path) -> Vec<crate::adapters::memory::MemoryStoreRef> {
        if self.id == "fixture_memory_performance" {
            MEMORY_ENUM_COUNT.with(|count| count.set(count.get() + 1));
        }
        self.stores
            .iter()
            .filter_map(|(label, scope, name)| {
                let directory = self.base(*scope, home, None).join(name);
                crate::adapters::memory::store_present(&directory).then(|| {
                    crate::adapters::memory::MemoryStoreRef {
                        scope: *scope,
                        project_path: None,
                        label: (*label).to_owned(),
                        directory,
                    }
                })
            })
            .collect()
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

fn memory_target(
    tool: &str,
    scope: Scope,
    project: Option<&Path>,
    context: Option<&str>,
) -> MemoryTarget {
    MemoryTarget {
        tool_id: tool.into(),
        scope,
        project_path: project.map(|path| path.display().to_string()),
        context_id: context.map(str::to_owned),
        store_directory: None,
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
        authentication: crate::native::profile::ProfileAuthentication::OAuth { account_id },
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
    assert!(switched
        .entries
        .iter()
        .all(|entry| entry.path.contains("_unbound")));
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
fn unverified_builtin_memory_does_not_create_memory() {
    let harness = harness();
    let registry = Registry::builtins();
    // Declarations follow each CLI's recorded verdict: an unverified reason
    // must make the engine refuse before creating anything, while a complete
    // declaration resolves its own storage. The fixture never writes into a
    // builtin store either way.
    let mut unverified = 0;
    for adapter in registry.iter() {
        let declaration = adapter.memory().expect("builtin memory port").declaration();
        if !declaration.unverified_reason.trim().is_empty() {
            unverified += 1;
            let error = list_memories(
                &harness.db,
                &registry,
                &harness.home,
                &memory_target(adapter.id(), Scope::Global, None, None),
            )
            .unwrap_err();
            assert!(
                error.contains("尚未核实") || error.contains("不覆盖当前范围"),
                "{}: {error}",
                adapter.id()
            );
        }
    }
    assert!(unverified > 0, "至少一个 builtin 仍应记录未核实原因");
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
    assert!(!real_note
        .parent()
        .unwrap()
        .join(".cliora-memory-switch")
        .exists());
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

const SCAN_STORES: &[(&str, Scope, &str)] = &[
    ("全局", Scope::Global, "scan-stores/global"),
    ("proj-slug", Scope::Project, "scan-stores/proj"),
    ("坏源", Scope::Global, "scan-stores/broken"),
    ("缺失", Scope::Global, "scan-stores/missing"),
];

fn scan_cli() -> MemoryCli {
    MemoryCli {
        id: "fixture_memory_scan",
        location: "cliora-memory-scan",
        stores: SCAN_STORES,
        project: true,
        ..SHARED
    }
}

#[test]
fn existing_stores_scan_hits_empty_and_missing_directories() {
    let harness = harness();
    let cli: &'static MemoryCli = Box::leak(Box::new(scan_cli()));
    let global = harness.home.join("scan-stores").join("global");
    let project = harness.home.join("scan-stores").join("proj");
    fs::create_dir_all(&global).unwrap();
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("note.md"), "project body").unwrap();
    let registry = Registry::with_adapters(vec![cli as &dyn CliAdapter]).unwrap();
    let adapter = registry.get(cli.id).unwrap();
    let mut stores = adapter.memory().unwrap().existing_stores(&harness.home);
    stores.sort_by(|left, right| left.label.cmp(&right.label));
    // 命中与空目录都返回，缺失不返回也绝不创建。
    assert_eq!(stores.len(), 2, "{stores:?}");
    assert_eq!(stores[0].label, "proj-slug");
    assert_eq!(stores[0].scope, Scope::Project);
    assert_eq!(stores[0].directory, project);
    assert_eq!(stores[0].project_path, None);
    assert_eq!(stores[1].label, "全局");
    assert_eq!(stores[1].scope, Scope::Global);
    assert_eq!(stores[1].directory, global);
    assert!(!harness.home.join("scan-stores").join("missing").exists());
    // 无存储配置的夹具端口默认返回空（未接入为空）。
    assert!(harness
        .registry
        .get(SHARED.id)
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&harness.home)
        .is_empty());
}

#[test]
fn aggregated_listing_merges_stores_and_keeps_write_paths() {
    let mut harness = harness();
    let cli: &'static MemoryCli = Box::leak(Box::new(scan_cli()));
    harness.registry = Registry::with_adapters(vec![cli as &dyn CliAdapter]).unwrap();
    let global = harness.home.join("scan-stores").join("global");
    let project = harness.home.join("scan-stores").join("proj");
    let broken = harness.home.join("scan-stores").join("broken");
    fs::create_dir_all(&global).unwrap();
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&broken).unwrap();
    fs::write(global.join("global-note.md"), "global body").unwrap();
    fs::write(project.join("project-note.md"), "project body").unwrap();
    // 该来源的总开关记录不可读取：单源失败，其余来源照常返回。
    fs::create_dir_all(broken.join(".cliora-memory-switch")).unwrap();

    let aggregate =
        list_all_memories(&harness.db, &harness.registry, &harness.home, cli.id).unwrap();
    assert_eq!(aggregate.tool_id, cli.id);
    let mut labels: Vec<&str> = aggregate
        .entries
        .iter()
        .map(|entry| entry.source_label.as_str())
        .collect();
    labels.sort_unstable();
    assert_eq!(labels, ["proj-slug", "全局"]);
    assert_eq!(
        aggregate.failed_sources.len(),
        1,
        "{:?}",
        aggregate.failed_sources
    );
    assert_eq!(aggregate.failed_sources[0].label, "坏源");
    assert!(aggregate.failed_sources[0].reason.contains("总开关"));
    // 每个可列出的存储都有摘要（含条目数与原样 target）；引擎托管的开关按存储区分。
    let mut summaries: Vec<(&str, usize)> = aggregate
        .stores
        .iter()
        .map(|store| (store.label.as_str(), store.entry_count))
        .collect();
    summaries.sort_unstable();
    assert_eq!(summaries, [("proj-slug", 1), ("全局", 1)]);
    assert!(aggregate
        .stores
        .iter()
        .all(|store| store.target.store_directory.as_deref() == Some(store.directory.as_str())));
    assert!(!aggregate.switch_shared);

    let global_entry = aggregate
        .entries
        .iter()
        .find(|entry| entry.source_label == "全局")
        .unwrap();
    assert_eq!(global_entry.id, "global-note");
    assert!(global_entry.target.store_directory.is_some());
    // 聚合条目携带的 target 走既有读写 IPC，仍落在所属存储内。
    assert_eq!(
        read_memory(
            &harness.db,
            &harness.registry,
            &harness.home,
            &global_entry.target,
            "global-note",
        )
        .unwrap()
        .text,
        "global body"
    );
    let saved = save(
        &harness,
        global_entry.target.clone(),
        "global-note",
        "edited body",
        "global body",
        false,
    )
    .unwrap();
    assert_eq!(Path::new(&saved.path), global.join("global-note.md"));
    assert_eq!(
        fs::read_to_string(global.join("global-note.md")).unwrap(),
        "edited body"
    );
    // 未被适配器枚举的存储路径一律拒绝，写路径不因此改变。
    let mut forged = global_entry.target.clone();
    forged.store_directory = Some(harness.home.join("declared").display().to_string());
    let refused = save(&harness, forged, "smuggle", "no", "", false).unwrap_err();
    assert!(refused.contains("已不在磁盘上"), "{refused}");
    assert!(!harness.home.join("declared").join("smuggle.md").exists());
    // 不带存储目录的原有目标解析保持不变。
    let plain = memory_target(cli.id, Scope::Global, None, None);
    save(&harness, plain, "plain-note", "plain body", "", false).unwrap();
    assert_eq!(
        fs::read_to_string(
            harness
                .home
                .join("cliora-memory-scan")
                .join("plain-note.md")
        )
        .unwrap(),
        "plain body"
    );
}

#[test]
fn aggregation_refuses_unverified_and_unregistered_tools() {
    let harness = harness();
    // 未核实：内置声明仍以未核实原因拒绝，端口扫描为空。
    let builtins = Registry::builtins();
    let mut unverified = 0;
    for adapter in builtins.iter() {
        let declaration = adapter.memory().unwrap().declaration();
        if declaration.unverified_reason.trim().is_empty() {
            continue;
        }
        unverified += 1;
        assert!(adapter
            .memory()
            .unwrap()
            .existing_stores(&harness.home)
            .is_empty());
        let error =
            list_all_memories(&harness.db, &builtins, &harness.home, adapter.id()).unwrap_err();
        assert!(error.contains("尚未核实"), "{}: {error}", adapter.id());
    }
    assert!(unverified > 0);
    // 未注册：直接拒绝。
    let unknown = list_all_memories(&harness.db, &builtins, &harness.home, "no_such_cli");
    assert!(unknown.unwrap_err().contains("尚无注册适配器"));
    // 绑定账号的声明没有枚举存储：聚合为空结果而非伪造路径。
    let bound: &'static MemoryCli = Box::leak(Box::new(MemoryCli {
        id: "fixture_memory_bound",
        stores: &[("should-not-exist", Scope::Global, "bound-store")],
        ..WRITABLE
    }));
    let registry = Registry::with_adapters(vec![bound as &dyn CliAdapter]).unwrap();
    fs::create_dir_all(harness.home.join("bound-store")).unwrap();
    let aggregate = list_all_memories(&harness.db, &registry, &harness.home, bound.id).unwrap();
    assert!(aggregate.entries.is_empty());
    assert!(aggregate.failed_sources.is_empty());
    assert!(!harness.home.join("bound-store").join("_unbound").exists());
}

#[test]
fn builtin_existing_stores_scan_the_verified_locations() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let builtins = Registry::builtins();

    // claude：projects/<slug>/memory 命中；用户级改址根单独列出；
    // projects 根不可读时跳过该来源。
    let claude_slug = "scan--project--alpha";
    let claude_memory = home
        .join(".claude")
        .join("projects")
        .join(claude_slug)
        .join("memory");
    fs::create_dir_all(&claude_memory).unwrap();
    fs::write(claude_memory.join("topic.md"), "body").unwrap();
    let stores = builtins
        .get("claude_code")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert_eq!(stores.len(), 1, "{stores:?}");
    assert_eq!(stores[0].label, claude_slug);
    assert_eq!(stores[0].scope, Scope::Project);
    assert_eq!(stores[0].directory, claude_memory);
    // 用户级改址根指向已存在的目录时单独列出（正向斜杠绝对路径是已
    // 核实的可改址形式）。
    let relocated = home.join("relocated-claude-memory");
    fs::create_dir_all(&relocated).unwrap();
    let relocation_value = relocated.display().to_string().replace('\\', "/");
    fs::write(
        home.join(".claude").join("settings.json"),
        format!(r#"{{"autoMemoryDirectory": "{relocation_value}"}}"#),
    )
    .unwrap();
    let stores = builtins
        .get("claude_code")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert!(
        stores
            .iter()
            .any(|store| store.label == "改址根" && store.directory == relocated),
        "{stores:?}"
    );
    // IO 错误跳过：projects 根变成普通文件后只剩改址根。
    fs::remove_dir_all(home.join(".claude").join("projects")).unwrap();
    fs::write(home.join(".claude").join("projects"), "not a dir").unwrap();
    let stores = builtins
        .get("claude_code")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert_eq!(stores.len(), 1, "{stores:?}");
    assert_eq!(stores[0].label, "改址根");
    assert_eq!(stores[0].directory, relocated);

    // codebuddy：全局 + projects 命中；legacy 仅在主目录缺失时回退列出。
    let codebuddy_root = home.join(".codebuddy");
    let global = codebuddy_root.join("memories").join("global");
    fs::create_dir_all(&global).unwrap();
    let slug = "c-scan-project-alpha";
    let primary = codebuddy_root.join("projects").join(slug).join("memory");
    let legacy = codebuddy_root.join("memories").join(slug);
    fs::create_dir_all(&legacy).unwrap();
    let stores = builtins
        .get("codebuddy")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    let labels: Vec<(&str, &Path)> = stores
        .iter()
        .map(|store| (store.label.as_str(), store.directory.as_path()))
        .collect();
    assert!(labels.contains(&("全局", global.as_path())), "{labels:?}");
    assert!(labels.contains(&(slug, legacy.as_path())), "{labels:?}");
    fs::create_dir_all(&primary).unwrap();
    let stores = builtins
        .get("codebuddy")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert!(
        stores.iter().any(|store| store.directory == primary),
        "{stores:?}"
    );
    assert!(
        stores.iter().all(|store| store.directory != legacy),
        "{stores:?}"
    );

    // grok：全局 topics + workspace 命中，非 slug 目录跳过。
    if std::env::var_os("GROK_HOME").is_none() {
        let grok_root = home.join(".grok").join("memory-v2");
        let grok_global = grok_root.join("global").join("topics");
        let workspace = grok_root
            .join("workspaces")
            .join("alpha-490670fe")
            .join("topics");
        fs::create_dir_all(&grok_global).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(grok_root.join("workspaces").join("not-a-hash")).unwrap();
        let stores = builtins
            .get("grok")
            .unwrap()
            .memory()
            .unwrap()
            .existing_stores(&home);
        assert_eq!(stores.len(), 2, "{stores:?}");
        assert!(stores
            .iter()
            .any(|store| store.label == "全局" && store.directory == grok_global));
        assert!(stores
            .iter()
            .any(|store| store.label == "alpha-490670fe" && store.directory == workspace));
    }

    // mimo：全局 + projects/<id> 命中。
    let mimo_memory = home
        .join(".local")
        .join("share")
        .join("mimocode")
        .join("memory");
    let mimo_global = mimo_memory.join("global");
    let mimo_project = mimo_memory
        .join("projects")
        .join("242f1d80-4457-460b-916f-799d3d3adb75");
    fs::create_dir_all(&mimo_global).unwrap();
    fs::create_dir_all(&mimo_project).unwrap();
    let stores = builtins
        .get("mimo_code")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert_eq!(stores.len(), 2, "{stores:?}");
    assert!(stores
        .iter()
        .any(|store| store.directory == mimo_global && store.scope == Scope::Global));
    assert!(stores
        .iter()
        .any(|store| store.directory == mimo_project && store.scope == Scope::Project));

    // codex：单一全局 workspace，缺失时不返回。
    let codex_memories = home.join(".codex").join("memories");
    let stores = builtins
        .get("codex")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert!(stores.is_empty(), "{stores:?}");
    fs::create_dir_all(&codex_memories).unwrap();
    let stores = builtins
        .get("codex")
        .unwrap()
        .memory()
        .unwrap()
        .existing_stores(&home);
    assert_eq!(stores.len(), 1, "{stores:?}");
    assert_eq!(stores[0].directory, codex_memories);
    assert_eq!(stores[0].scope, Scope::Global);
}

/// Engine-level regression for the on-disk identities whose project cannot be
/// recovered (claude slug, grok workspace hash, mimo uuid): the aggregated
/// listing must not fail on the project-scoped exclusion walk, and the entry
/// target must drive the shared read, edit, and delete paths inside the
/// adapter-enumerated store directory.
#[test]
fn slug_hash_and_uuid_stores_drive_the_shared_engine_without_a_project() {
    if std::env::var_os("GROK_HOME").is_some() {
        // grok store resolution is env-sensitive; the local GROK_HOME would
        // redirect the workspace scan outside this temp home.
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let db = Database::open(&temp.path().join("stores.db")).unwrap();
    let registry = Registry::builtins();
    let credentials = Store(Mutex::new(HashMap::new()));

    // claude：projects/<slug>/memory，slug 不可逆推项目。
    let claude_slug = "C--Users-example-project-cliora";
    let claude_store = home
        .join(".claude")
        .join("projects")
        .join(claude_slug)
        .join("memory");
    fs::create_dir_all(&claude_store).unwrap();
    fs::write(claude_store.join("MEMORY.md"), "# Memory Index\n").unwrap();
    fs::write(claude_store.join("claude-note.md"), "claude body").unwrap();
    let claude_index = claude_store.join("MEMORY.md");

    // grok：workspaces/<name>-<hash>/topics，hash 不可逆推项目。
    let grok_slug = "cliora-490670fe";
    let grok_store = home
        .join(".grok")
        .join("memory-v2")
        .join("workspaces")
        .join(grok_slug)
        .join("topics");
    fs::create_dir_all(&grok_store).unwrap();
    fs::write(grok_store.join("grok-note.md"), "grok body").unwrap();

    // mimo：memory/projects/<uuid>，uuid 不可逆推项目。
    let mimo_id = "242f1d80-4457-460b-916f-799d3d3adb75";
    let mimo_store = home
        .join(".local")
        .join("share")
        .join("mimocode")
        .join("memory")
        .join("projects")
        .join(mimo_id);
    fs::create_dir_all(&mimo_store).unwrap();
    fs::write(mimo_store.join("mimo-note.md"), "mimo body").unwrap();

    for (tool, label, id, body, store) in [
        (
            "claude_code",
            claude_slug,
            "claude-note",
            "claude body",
            &claude_store,
        ),
        ("grok", grok_slug, "grok-note", "grok body", &grok_store),
        ("mimo_code", mimo_id, "mimo-note", "mimo body", &mimo_store),
    ] {
        let aggregate = list_all_memories(&db, &registry, &home, tool).unwrap();
        // 原生布局的总开关为整个 CLI 共用（mimo 无总开关，不声明共用）。
        assert_eq!(aggregate.switch_shared, tool != "mimo_code", "{tool}");
        assert!(
            aggregate.failed_sources.is_empty(),
            "{tool}: {:?}",
            aggregate.failed_sources
        );
        let entry = aggregate
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .unwrap_or_else(|| panic!("{tool} 缺少 {id}: {:?}", aggregate.entries));
        assert_eq!(entry.source_label, label);
        assert_eq!(entry.target.project_path, None);
        assert!(entry.target.store_directory.is_some());
        assert!(Path::new(&entry.path).starts_with(store), "{}", entry.path);
        // 条目携带的 target 走既有读路径。
        assert_eq!(
            read_memory(&db, &registry, &home, &entry.target, id)
                .unwrap()
                .text,
            body
        );
        // 编辑仍落在所属存储内。
        let edited = format!("{body} edited");
        let saved = save_memory(
            &db,
            &credentials,
            &registry,
            &home,
            &MemorySave {
                target: entry.target.clone(),
                id: id.into(),
                text: edited.clone(),
                baseline: body.into(),
                confirm_external: false,
            },
        )
        .unwrap();
        assert_eq!(Path::new(&saved.path), store.join(format!("{id}.md")));
        assert_eq!(fs::read_to_string(&saved.path).unwrap(), edited);
        // 删除也只作用于该存储。
        delete_memory(
            &db,
            &credentials,
            &registry,
            &home,
            &MemoryDelete {
                target: entry.target.clone(),
                id: id.into(),
                baseline: edited,
            },
        )
        .unwrap();
        assert!(!store.join(format!("{id}.md")).exists());
    }

    // claude 的原生索引随保存与删除维护，且不产生任何 .cliora-* 文件。
    let index_text = fs::read_to_string(&claude_index).unwrap();
    assert!(!index_text.contains("claude-note"), "{index_text}");
    assert!(index_text.contains("# Memory Index"));
    let mut stray = Vec::new();
    for entry in fs::read_dir(&home).unwrap().flatten() {
        if entry.file_name().to_string_lossy().starts_with(".cliora-") {
            stray.push(entry.path());
        }
    }
    assert!(stray.is_empty(), "{stray:?}");
}

thread_local! { static MEMORY_ENUM_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }

#[test]
fn memory_batches_bound_work_and_reuse_enumeration_on_ten_stores() {
    static CLI: MemoryCli = MemoryCli {
        id: "fixture_memory_performance",
        location: "perf",
        read_only: false,
        binds_account: false,
        global: true,
        project: false,
        stores: &[
            ("0", Scope::Global, "perf/0"),
            ("1", Scope::Global, "perf/1"),
            ("2", Scope::Global, "perf/2"),
            ("3", Scope::Global, "perf/3"),
            ("4", Scope::Global, "perf/4"),
            ("5", Scope::Global, "perf/5"),
            ("6", Scope::Global, "perf/6"),
            ("7", Scope::Global, "perf/7"),
            ("8", Scope::Global, "perf/8"),
            ("9", Scope::Global, "perf/9"),
        ],
    };
    let h = harness();
    let registry = Registry::with_adapters(vec![&CLI]).unwrap();
    for store in 0..10 {
        let path = h.home.join(format!("perf/{store}"));
        fs::create_dir_all(&path).unwrap();
        for index in 0..100 {
            fs::write(
                path.join(format!("entry-{index}.md")),
                format!("# Entry {index}\nStore {store}"),
            )
            .unwrap();
        }
    }
    let reset = || {
        MEMORY_READ_COUNT.with(|count| count.set(0));
        MEMORY_ENUM_COUNT.with(|count| count.set(0));
    };
    let counts = || {
        (
            MEMORY_ENUM_COUNT.with(|count| count.get()),
            MEMORY_READ_COUNT.with(|count| count.get()),
        )
    };
    reset();
    let baseline = list_all_memories(&h.db, &registry, &h.home, CLI.id).unwrap();
    for entry in &baseline.entries {
        read_memory(&h.db, &registry, &h.home, &entry.target, &entry.id).unwrap();
    }
    assert_eq!(counts(), (1001, 2000));
    println!(
        "MEMORY_PERF baseline_single_reads ipc=1001 enumerations={} bodies={}",
        counts().0,
        counts().1
    );
    reset();
    let first = list_all_memories(&h.db, &registry, &h.home, CLI.id).unwrap();
    assert_eq!(counts(), (1, 1000));
    let requests: Vec<_> = first
        .entries
        .iter()
        .map(|entry| MemoryReadRequest {
            target: entry.target.clone(),
            id: entry.id.clone(),
        })
        .collect();
    for batch in requests.chunks(32) {
        let result = read_memories(&h.db, &registry, &h.home, batch).unwrap();
        assert!(result
            .iter()
            .all(|item| item.document.is_some() && item.error.is_none()));
    }
    assert_eq!(counts(), (33, 2000));
    println!(
        "MEMORY_PERF cold ipc=33 enumerations={} bodies={}",
        counts().0,
        counts().1
    );
    reset();
    let warm = list_all_memories(&h.db, &registry, &h.home, CLI.id).unwrap();
    assert!(warm
        .entries
        .iter()
        .zip(&first.entries)
        .all(|(a, b)| a.fingerprint == b.fingerprint));
    assert_eq!(counts(), (1, 1000));
    println!(
        "MEMORY_PERF warm ipc=1 enumerations={} bodies={}",
        counts().0,
        counts().1
    );
    for entry in first.entries.iter().take(3) {
        fs::write(&entry.path, "external change").unwrap();
    }
    reset();
    let changed = list_all_memories(&h.db, &registry, &h.home, CLI.id).unwrap();
    let requests: Vec<_> = changed
        .entries
        .iter()
        .zip(&first.entries)
        .filter(|(a, b)| a.fingerprint != b.fingerprint)
        .map(|(entry, _)| MemoryReadRequest {
            target: entry.target.clone(),
            id: entry.id.clone(),
        })
        .collect();
    assert_eq!(requests.len(), 3);
    read_memories(&h.db, &registry, &h.home, &requests).unwrap();
    assert_eq!(counts(), (2, 1003));
    println!(
        "MEMORY_PERF changed_3 ipc=2 enumerations={} bodies={}",
        counts().0,
        counts().1
    );

    assert!(read_memories(&h.db, &registry, &h.home, &vec![requests[0].clone(); 33]).is_err());
    let mut mixed = requests.clone();
    mixed[1].target.tool_id = "unregistered".into();
    let unknown = read_memories(&h.db, &registry, &h.home, &mixed).unwrap();
    assert!(unknown[0].document.is_some() && unknown[1].error.is_some());
    mixed[1] = requests[1].clone();
    mixed[1].id = "missing".into();
    let result = read_memories(&h.db, &registry, &h.home, &mixed).unwrap();
    assert!(
        result[0].document.is_some() && result[1].error.is_some() && result[2].document.is_some()
    );
    fs::write(&changed.entries[0].path, "x".repeat(MAX_BYTES)).unwrap();
    let result = read_memories(&h.db, &registry, &h.home, &vec![requests[0].clone(); 6]).unwrap();
    assert_eq!(
        result.iter().filter(|item| item.document.is_some()).count(),
        4
    );
    assert!(result[4].error.as_ref().unwrap().contains("字节上限"));
    fs::write(&changed.entries[0].path, "x".repeat(MAX_BYTES + 1)).unwrap();
    assert!(
        read_memories(&h.db, &registry, &h.home, &requests[..1]).unwrap()[0]
            .error
            .is_some()
    );
    assert!(read_memory(
        &h.db,
        &registry,
        &h.home,
        &requests[0].target,
        &requests[0].id
    )
    .is_ok());
    // Snapshot never authorizes a later operation after the store disappears.
    fs::remove_dir_all(Path::new(&changed.entries[0].path).parent().unwrap()).unwrap();
    assert!(
        read_memories(&h.db, &registry, &h.home, &requests[..1]).unwrap()[0]
            .error
            .is_some()
    );
}

#[test]
fn qoder_memory_native_indexes_groups_and_conflicts_are_transactional() {
    let h = harness();
    let registry = Registry::builtins();
    let port = registry.get("qoder_cn").unwrap().memory().unwrap();
    let project = h.temp.path().join("项目-😀");
    fs::create_dir_all(&project).unwrap();
    let user = memory_target("qoder_cn", Scope::Global, None, None);
    let project_target = memory_target("qoder_cn", Scope::Project, Some(&project), None);
    let empty = list_all_memories(&h.db, &registry, &h.home, "qoder_cn").unwrap();
    assert!(empty.stores.is_empty() && empty.switch_groups.len() == 2);
    assert!(empty
        .switch_groups
        .iter()
        .all(|group| group.enabled.is_none()));
    assert!(!port
        .declaration()
        .operations
        .contains(&MemoryOperation::ItemEnable));
    assert!(!h.home.join(".qoder-cn").exists());
    for target in [&user, &project_target] {
        let saved = save_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemorySave {
                target: target.clone(),
                id: "topic".into(),
                text: "---\nname: Native topic\ndescription: A fixture\n---\nhello".into(),
                baseline: String::new(),
                confirm_external: false,
            },
        )
        .unwrap();
        assert!(saved.detail.contains("生效状态未知"));
        let index = Path::new(&saved.path).parent().unwrap().join("MEMORY.md");
        assert!(fs::read_to_string(&index)
            .unwrap()
            .contains("[Native topic](topic.md)"));
        let before = fs::read_to_string(&index).unwrap();
        fs::write(&saved.path, "external").unwrap();
        assert!(save_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemorySave {
                target: target.clone(),
                id: "topic".into(),
                text: "overwrite".into(),
                baseline: saved.text,
                confirm_external: false,
            }
        )
        .unwrap_err()
        .contains("外部修改"));
        assert_eq!(fs::read_to_string(&index).unwrap(), before);
        fs::write(&index, format!("{before}\nKeep this unrelated line\n")).unwrap();
        delete_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemoryDelete {
                target: target.clone(),
                id: "topic".into(),
                baseline: "external".into(),
            },
        )
        .unwrap();
        let after = fs::read_to_string(&index).unwrap();
        assert!(!after.contains("topic.md") && after.contains("Keep this unrelated line"));
    }
    let settings = h.home.join(".qoder-cn/settings.json");
    fs::write(&settings, "{\"unknown\":{\"keep\":123}}\n").unwrap();
    set_memory_switch_group(
        &h.db,
        &h.store,
        &registry,
        &h.home,
        "qoder_cn",
        "autoMemoryEnabled",
        false,
    )
    .unwrap();
    let groups = list_all_memories(&h.db, &registry, &h.home, "qoder_cn")
        .unwrap()
        .switch_groups;
    assert_eq!(
        groups
            .iter()
            .find(|g| g.scope == Scope::Project)
            .unwrap()
            .enabled,
        Some(false)
    );
    assert_eq!(
        groups
            .iter()
            .find(|g| g.scope == Scope::Global)
            .unwrap()
            .enabled,
        None
    );
    set_memory_switch_group(
        &h.db,
        &h.store,
        &registry,
        &h.home,
        "qoder_cn",
        "autoMemoryUserScopeEnabled",
        true,
    )
    .unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(settings).unwrap()).unwrap();
    assert_eq!(value["unknown"]["keep"], 123);
    assert!(set_memory_switch_group(
        &h.db, &h.store, &registry, &h.home, "qoder_cn", "unknown", true
    )
    .is_err());
    assert!(save_memory(
        &h.db,
        &h.store,
        &registry,
        &h.home,
        &MemorySave {
            target: user,
            id: "MEMORY".into(),
            text: "bad".into(),
            baseline: String::new(),
            confirm_external: false
        }
    )
    .is_err());
}

#[test]
fn qoder_memory_group_switch_rejects_junction_without_changing_settings() {
    let h = harness();
    let registry = Registry::builtins();
    let outside = h.temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    let settings = outside.join("settings.json");
    let sentinel = "{\"autoMemoryEnabled\":true,\"unknown\":123}";
    fs::write(&settings, sentinel).unwrap();
    link_directory(&outside, &h.home.join(".qoder-cn"));
    assert!(set_memory_switch_group(
        &h.db,
        &h.store,
        &registry,
        &h.home,
        "qoder_cn",
        "autoMemoryEnabled",
        false
    )
    .is_err());
    assert_eq!(fs::read_to_string(&settings).unwrap(), sentinel);
    #[cfg(windows)]
    fs::remove_dir(h.home.join(".qoder-cn")).unwrap();
    #[cfg(unix)]
    fs::remove_file(h.home.join(".qoder-cn")).unwrap();
}

#[cfg(windows)]
#[test]
fn memory_list_keeps_healthy_entries_when_one_file_is_exclusively_locked() {
    use std::os::windows::fs::OpenOptionsExt;
    let h = harness();
    let registry = Registry::builtins();
    let target = memory_target("qoder_cn", Scope::Global, None, None);
    let directory = h.home.join(".qoder-cn/memory");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("a.md"), "healthy body").unwrap();
    fs::write(directory.join("b.md"), "locked body").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(directory.join("b.md"))
        .unwrap();
    let list = list_memories(&h.db, &registry, &h.home, &target).unwrap();
    assert_eq!(list.entries.len(), 2);
    assert!(list
        .entries
        .iter()
        .find(|entry| entry.id == "a")
        .unwrap()
        .read_error
        .is_none());
    let failed = list.entries.iter().find(|entry| entry.id == "b").unwrap();
    assert!(failed.read_error.is_some() && failed.fingerprint.is_empty());
    let aggregate = list_all_memories(&h.db, &registry, &h.home, "qoder_cn").unwrap();
    assert!(aggregate.failed_sources.is_empty());
    assert_eq!(aggregate.entries.len(), 2);
    let requests: Vec<_> = aggregate
        .entries
        .iter()
        .map(|entry| MemoryReadRequest {
            target: entry.target.clone(),
            id: entry.id.clone(),
        })
        .collect();
    let read = read_memories(&h.db, &registry, &h.home, &requests).unwrap();
    assert_eq!(read[0].document.as_ref().unwrap().text, "healthy body");
    assert!(read[1].document.is_none() && read[1].error.is_some());
    drop(lock);
    let recovered = list_all_memories(&h.db, &registry, &h.home, "qoder_cn").unwrap();
    assert!(recovered
        .entries
        .iter()
        .all(|entry| entry.read_error.is_none() && !entry.fingerprint.is_empty()));
    assert_eq!(
        read_memories(&h.db, &registry, &h.home, &requests).unwrap()[1]
            .document
            .as_ref()
            .unwrap()
            .text,
        "locked body"
    );
}

#[test]
fn qoder_native_topic_names_support_unicode_and_dots_without_weakening_path_guards() {
    let h = harness();
    let registry = Registry::builtins();
    let target = memory_target("qoder_cn", Scope::Global, None, None);
    let directory = h.home.join(".qoder-cn/memory");
    fs::create_dir_all(&directory).unwrap();
    for id in ["normal", "user.preferences", "用户偏好"] {
        fs::write(directory.join(format!("{id}.md")), "native body").unwrap();
    }
    let aggregate = list_all_memories(&h.db, &registry, &h.home, "qoder_cn").unwrap();
    assert!(aggregate.native_file_names);
    assert_eq!(aggregate.entries.len(), 3);
    for entry in aggregate.entries {
        let document = read_memory(&h.db, &registry, &h.home, &entry.target, &entry.id).unwrap();
        assert_eq!(document.text, "native body");
        let saved = save_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemorySave {
                target: entry.target.clone(),
                id: entry.id.clone(),
                text: "edited native body".into(),
                baseline: document.text,
                confirm_external: false,
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&saved.path).unwrap(),
            "edited native body"
        );
        assert!(fs::read_to_string(directory.join("MEMORY.md"))
            .unwrap()
            .contains(&format!("]({}.md)", entry.id)));
        delete_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemoryDelete {
                target: entry.target,
                id: entry.id.clone(),
                baseline: saved.text,
            },
        )
        .unwrap();
        assert!(!fs::read_to_string(directory.join("MEMORY.md"))
            .unwrap()
            .contains(&format!("]({}.md)", entry.id)));
    }
    for id in ["new.preferences", "新增偏好"] {
        save_memory(
            &h.db,
            &h.store,
            &registry,
            &h.home,
            &MemorySave {
                target: target.clone(),
                id: id.into(),
                text: "new native body".into(),
                baseline: String::new(),
                confirm_external: false,
            },
        )
        .unwrap();
    }
    for id in [
        "../outside",
        r"..\outside",
        "/absolute",
        "C:stream",
        "CON",
        "con.notes",
        "LPT1",
        "COM¹",
        ".hidden",
        "trailing.",
        "trailing ",
        "MEMORY",
        "memory",
    ] {
        assert!(
            save_memory(
                &h.db,
                &h.store,
                &registry,
                &h.home,
                &MemorySave {
                    target: target.clone(),
                    id: id.into(),
                    text: "must not write".into(),
                    baseline: String::new(),
                    confirm_external: false
                }
            )
            .is_err(),
            "accepted unsafe id {id}"
        );
    }
    // Other adapters retain their declared legacy identifiers.
    let shared = memory_target(SHARED.id, Scope::Global, None, None);
    assert!(save(&h, shared.clone(), "user.preferences", "no", "", false).is_err());
    assert!(save(&h, shared, "用户偏好", "no", "", false).is_err());
}
