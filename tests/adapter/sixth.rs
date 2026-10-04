use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;
use crate::adapters::{CliAdapter,Registry};
use crate::native::adapter;

struct Sixth;
static SIXTH: Sixth = Sixth;

impl CliAdapter for Sixth {
    fn accounts(&self)->Option<&dyn crate::adapters::accounts::AccountAdapter> {Some(self)}
    fn plugins(&self)->Option<&dyn crate::adapters::plugins::PluginAdapter> {Some(self)}
    fn agents(&self)->Option<&dyn crate::adapters::agents::AgentAdapter> {Some(self)}

    fn id(&self) -> &'static str {
        "sixth_fixture"
    }
    fn name(&self) -> &'static str {
        "Sixth fixture"
    }
    fn command(&self) -> &'static str {
        "sixth_fixture"
    }
    fn npm_package(&self) -> &'static str {
        "@fixture/sixth"
    }
    fn version_identity(&self, _: &str, output: &str) -> bool {
        output.contains("sixth_fixture")
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        _: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        if scope != Scope::Global {
            return vec![];
        }
        vec![file(
            "settings",
            home.join(".sixth/settings.json"),
            FileKind::Json,
            known,
            None,
            false,
        )]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &["openai_responses"]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Json)
        } else {
            Err("unsupported role".into())
        }
    }
    fn empty_entry_collections(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" { &["connections"] } else { &[] }
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        _: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Ok(BTreeMap::from([(
            "settings".into(),
            json!({"model": connection.model}),
        )]))
    }
    fn write_connection_secret(
        &self,
        _: &RegisteredProfile,
        _: Scope,
        _: &dyn CredentialStore,
        _: &mut NativeSecrets,
    ) -> Result<(), String> {
        Ok(())
    }
    fn has_native_secret(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        InspectionFields {
            model: settings
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            ..InspectionFields::default()
        }
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if mode == LaunchMode::Yolo {
            return Err("sixth fixture does not support YOLO".into());
        }
        Ok(session
            .map(|id| vec!["--resume".into(), id.into()])
            .unwrap_or_default())
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        ("https://example.invalid/sixth", "fixture only")
    }
}

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, String>>);
impl CredentialStore for MemoryCredentials {
    fn put(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
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

#[test]
fn sixth_adapter_uses_the_same_probe_native_transaction_and_launch_orchestration() {
    let registry =
        Registry::with_adapters(vec![&CODEX, &CLAUDE, &GROK, &PI, &OPENCODE, &SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let executable = if cfg!(windows) {
        home.join("sixth_fixture.ps1")
    } else {
        home.join("sixth_fixture")
    };
    if cfg!(windows) {
        std::fs::write(&executable, "Write-Output 'sixth_fixture 1.0.0'\n").unwrap();
    } else {
        std::fs::write(&executable, "#!/bin/sh\necho 'sixth_fixture 1.0.0'\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let probe = adapter::probe_registered(
        &registry,
        "sixth_fixture",
        Some(&executable),
        home,
        None,
        Scope::Global,
    )
    .unwrap();
    assert_eq!(probe.native_writes.state, "supported");
    assert_eq!(probe.installations[0].version.as_deref(), Some("1.0.0"));
    let native = registered_file(
        &registry,
        "sixth_fixture",
        "settings",
        Scope::Global,
        home,
        None,
        true,
    )
    .unwrap();
    let path = Path::new(&native.path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, r#"{"untouched":true,"model":"old","connections":{"stale":{},"keep":{"url":"https://example.test"}},"unrelated":{}}"#).unwrap();
    let baseline = read_registered_file(
        &registry,
        "sixth_fixture",
        "settings",
        Scope::Global,
        home,
        None,
        true,
    )
    .unwrap();
    let db = Database::open(&home.join("test.db")).unwrap();
    let credentials = MemoryCredentials::default();
    let outcome = apply_registered_fields(
        &registry,
        "sixth_fixture",
        "settings",
        Scope::Global,
        home,
        None,
        "1.0.0",
        &db,
        &credentials,
        baseline,
        vec![FieldChange {
            path: vec!["model".into()],
            value: Some(json!("new")),
        }],
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(outcome.status, "written_for_next_session");
    let text = read_registered_file(
        &registry,
        "sixth_fixture",
        "settings",
        Scope::Global,
        home,
        None,
        true,
    )
    .unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["model"], "new");
    assert_eq!(value["untouched"], true);
    let common = crate::native::profile::save_registered_common(
        &db,
        &registry,
        crate::native::profile::RegisteredCommon {
            revision: String::new(),
            tool: "sixth_fixture".into(),
            version: 0,
            files: BTreeMap::from([("settings".into(), "{\"inherited\":true}".into())]),
        },
        None,
    )
    .unwrap();
    assert_eq!(common.version, 1);
    let imported = crate::native::intake::prepare_registered_import(
        &registry,
        "sixth_fixture",
        BTreeMap::from([("settings".into(), text.clone())]),
        &credentials,
    )
    .unwrap();
    assert_eq!(imported.inspection.model.as_deref(), Some("new"));
    let named = crate::native::profile::save_registered_profile(
        &db,
        &registry,
        RegisteredProfile {
            revision: String::new(),
            id: String::new(),
            tool: "sixth_fixture".into(),
            name: "fixture profile".into(),
            version: 0,
            inherit_common: true,
            files: BTreeMap::from([("settings".into(), "{\"model\":\"named\"}".into())]),
            suppressed: BTreeMap::new(),
            connection: Some(Connection {
                provider_id: "fixture".into(),
                interface_format: "openai_responses".into(),
                base_url: "https://fixture.invalid/v1".into(),
                model: "named-from-connection".into(),
                secret_ref: None,
                auth_env_var: None,
                model_records: Vec::new(),
            }),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
        },
        None,
    )
    .unwrap();
    assert_eq!(named.version, 1);
    assert_eq!(
        crate::native::profile::get_registered_profile(&db, &named.id)
            .unwrap()
            .tool,
        "sixth_fixture"
    );
    assert_eq!(
        crate::native::profile::list_registered_profiles(&db, "sixth_fixture")
            .unwrap()
            .len(),
        1
    );
    let applied = crate::native::apply::apply_registered_profile(
        &registry,
        &db,
        &credentials,
        "sixth_fixture",
        &named.id,
        Scope::Global,
        home,
        None,
        Some(&executable),
        true,
    )
    .unwrap();
    assert_eq!(applied.status, "written_for_next_session");
    let applied_text = read_registered_file(
        &registry,
        "sixth_fixture",
        "settings",
        Scope::Global,
        home,
        None,
        true,
    )
    .unwrap();
    let applied_value: Value = serde_json::from_str(&applied_text).unwrap();
    assert_eq!(applied_value["model"], "named-from-connection");
    assert_eq!(applied_value["inherited"], true);
    assert_eq!(applied_value["untouched"], true);
    assert!(applied_value["connections"].get("stale").is_none());
    assert_eq!(applied_value["connections"]["keep"]["url"], "https://example.test");
    assert_eq!(applied_value["unrelated"], json!({}));
    let binding = crate::native::apply::get_registered_binding(&db, "sixth_fixture", "global")
        .unwrap()
        .unwrap();
    assert_eq!(binding.profile_id, named.id);
    assert_eq!(binding.tool, "sixth_fixture");
    let incompatible = Connection {
        provider_id: "fixture".into(),
        interface_format: "anthropic_messages".into(),
        base_url: "https://fixture.invalid/v1".into(),
        model: "m".into(),
        secret_ref: None,
        auth_env_var: None,
        model_records: Vec::new(),
    };
    let check = crate::native::models::test_registered_connection(
        &registry,
        "sixth_fixture",
        &incompatible,
        &credentials,
        false,
    );
    assert_eq!(check.format.state, "failed");
    assert_eq!(check.model_request.state, "skipped");
    assert_eq!(
        plan_launch(
            &registry,
            "sixth_fixture",
            "1.0.0",
            Some("session 01"),
            LaunchMode::Normal
        )
        .unwrap(),
        ["--resume", "session 01"]
    );
    assert!(plan_launch(&registry, "sixth_fixture", "1.0.0", None, LaunchMode::Yolo).is_err());
    assert!(plan_launch(
        &registry,
        "sixth_fixture",
        "1.1.0",
        None,
        LaunchMode::Normal
    )
    .is_ok());
    assert!(plan_launch(&registry, "sixth_fixture", "", None, LaunchMode::Normal).is_err());
    assert!(
        adapter::probe_registered(&registry, "unregistered", None, home, None, Scope::Global)
            .is_err()
    );
    assert!(plan_launch(&registry, "unregistered", "1.0.0", None, LaunchMode::Normal).is_err());
    assert!(apply_registered_fields(
        &registry,
        "unregistered",
        "settings",
        Scope::Global,
        home,
        None,
        "1.0.0",
        &db,
        &credentials,
        text,
        vec![],
        |_| Ok(())
    )
    .is_err());
    assert!(crate::native::profile::save_registered_profile(
        &db,
        &registry,
        RegisteredProfile {
            revision: String::new(),
            id: String::new(),
            tool: "unregistered".into(),
            name: "blocked".into(),
            version: 0,
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            connection: None,
            authentication: crate::native::profile::ProfileAuthentication::Native,
            native_credentials: BTreeMap::new(),
        },
        None
    )
    .is_err());
    // Direct file editing also uses the open adapter contract, complete native
    // text, and the transaction boundary without creating a profile.
    let target = home.join(".sixth/settings.json");
    let original = "{\n  \"model\": \"old\",\n  \"untouched\": true\n}\n";
    let external = original.replace("true", "false");
    std::fs::write(&target, &external).unwrap();
    let edited = original.replace("old", "direct");
    save_registered_text(&registry, "sixth_fixture", "settings", Scope::Global, home, None, "1.0.0", &db, &credentials, original, &edited).unwrap();
    let actual = std::fs::read_to_string(&target).unwrap();
    assert!(actual.contains("direct") && actual.contains("false"));
    assert!(crate::native::apply::get_registered_binding(&db, "sixth_fixture", "global").unwrap().is_none());
    assert_eq!(crate::native::profile::list_registered_profiles(&db, "sixth_fixture").unwrap().len(), 1);
    assert!(save_registered_text(&registry, "sixth_fixture", "settings", Scope::Global, home, None, "1.0.0", &db, &credentials, original, &original.replace("old", "conflict")).is_err());
    assert!(save_registered_text(&registry, "sixth_fixture", "settings", Scope::Global, home, None, "1.0.0", &db, &credentials, &actual, "invalid json").is_err());
    assert!(save_registered_text(&registry, "sixth_fixture", "settings", Scope::Global, home, None, "", &db, &credentials, &actual, &actual).is_err());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), actual);
}

impl crate::adapters::accounts::AccountAdapter for Sixth {
    fn remove_environment(&self)-> &'static [&'static str] {&["SIXTH_API_KEY"]}
    fn capability(&self)->crate::accounts::AccountCapability {crate::accounts::AccountCapability {
        browser_link: false,
        tool_id:"sixth_fixture",provider:"fixture",version:"1.2.3",managed_login:true,import_native:false,methods:vec!["browser"],reason:"fixture",identity_source:"fixture",refresh_owner:"native_cli",acceptance:"synthetic",
    }}
    fn context(&self,root:std::path::PathBuf,id:String)->Result<crate::accounts::NativeContext,String> {
        Ok(crate::accounts::NativeContext{id,tool_id:"sixth_fixture".into(),config_root:root.clone(),resource_root:root.clone(),auth_files:vec![root.join("fixture-auth.json")],history_roots:vec![],environment:BTreeMap::new(),remove_environment:vec![],cli_args:vec![],root})
    }
}
impl crate::adapters::plugins::PluginAdapter for Sixth {
    fn capability(&self)->crate::adapters::plugins::PluginCapability {crate::adapters::plugins::PluginCapability {version:"1.2.3",sources:"fixture",actions:vec!["install"],project:false,detail:"fixture"}}
    fn command_args(&self,action:&str,source:&str,_project:bool)->Result<Vec<String>,String> {Ok(vec![action.into(),source.into()])}
    fn list_rows<'a>(&self,value:&'a Value)->Option<&'a Vec<Value>> {value.get("fixturePlugins").and_then(Value::as_array)}
}
impl crate::adapters::agents::AgentAdapter for Sixth {
    fn capability(&self)->crate::adapters::agents::AgentCapability {crate::adapters::agents::AgentCapability{version:"1.2.3",supported:true,format:"json",detail:"fixture",template:"{}"}}
    fn root(&self,_scope:Scope,home:&Path,_project:Option<&Path>)->Result<std::path::PathBuf,String> {Ok(home.join(".sixth"))}
    fn validate_fields(&self,value:&Value)->Result<(),String> {if value["fixtureField"]==true {Ok(())} else {Err("missing fixture field".into())}}
}
#[test]
fn sixth_cli_account_plugin_and_agent_capabilities_reach_shared_consumers() {
    let registry=Registry::with_adapters(vec![&SIXTH]).unwrap();let temp=tempfile::tempdir().unwrap();
    let catalog=crate::adapters::accounts::capabilities_registered(&registry);
    assert_eq!(catalog.len(),1);assert_eq!(catalog[0].provider,"fixture");
    let ctx=crate::accounts::context::context_at_registered(&registry,temp.path().join("context"),"sixth_fixture","fixture-context".into()).unwrap();
    assert_eq!(ctx.auth_files,[ctx.root.join("fixture-auth.json")]);
    assert!(ctx.remove_environment.contains(&"SIXTH_API_KEY".into()));
    let target=crate::resources::plugins::PluginTarget{tool_id:"sixth_fixture".into(),scope:Scope::Global,project_path:None,context_id:None};
    let plugins=crate::resources::plugins::parse_list_registered(&registry,"sixth_fixture",&json!({"fixturePlugins":[{"id":"sixth-package","enabled":true}]}),&target).unwrap();
    assert_eq!(plugins[0].id,"sixth-package");
    let source=r#"{"name":"reviewer","description":"fixture","fixtureField":true}"#;
    let agent=crate::adapters::agents::validate_registered(&registry,"sixth_fixture","json",source,"reviewer").unwrap();
    assert_eq!(agent.0,"reviewer");
    assert!(crate::adapters::agents::validate_registered(&registry,"sixth_fixture","json",r#"{"name":"reviewer","description":"fixture"}"#,"reviewer").is_err());
    assert!(registry.get("sixth_fixture").unwrap().official_usage().is_none());
}
#[test]
fn management_descriptors_follow_adapter_ports_and_default_to_absent() {
    let registry = crate::adapters::Registry::builtins();
    for adapter in registry.iter() {
        let descriptor = adapter.descriptor();
        assert_eq!(descriptor.management.accounts, adapter.accounts().is_some_and(|port| {
            let capability = port.capability();
            capability.managed_login || capability.import_native
        }));
        assert_eq!(descriptor.management.agents, adapter.agents().is_some_and(|port| port.capability().supported));
        assert_eq!(descriptor.management.plugins, adapter.plugins().is_some_and(|port| !port.capability().actions.is_empty()));
        assert_eq!(descriptor.management.mcp, adapter.supports_mcp());
    }
    assert!(!registry.get("grok").unwrap().descriptor().management.accounts);
    assert!(!registry.get("pi").unwrap().descriptor().management.agents);
    assert!(registry.get("claude_code").unwrap().descriptor().management.agents);
}
