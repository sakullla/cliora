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
    fn configuration(&self) -> Option<&dyn crate::adapters::configuration::ConfigurationAdapter> { Some(self) }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" { &["model", "models", "temperature", "provider", "baseUrl", "interfaceFormat", "unknown"] } else { &[] }
    }
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
        if role == "settings" { &["connections", "models"] } else { &[] }
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
    fn connection_documents_for_existing(&self, connection: &Connection, scope: Scope, existing: &BTreeMap<String, Value>) -> Result<BTreeMap<String, Value>, String> {
        let mut overlay = self.connection_documents(connection, scope)?;
        if !connection.model_records.is_empty() {
            let mut models = existing.get("settings").and_then(|root| root.get("models")).cloned().unwrap_or_else(|| json!({}));
            for record in &connection.model_records {
                if let Some(model) = models.get_mut(&record.id) { crate::adapters::assign_existing_fields(model, &record.fields); }
            }
            overlay.get_mut("settings").unwrap()["models"] = models;
        }
        Ok(overlay)
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
            editing: None,
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
    assert_eq!(binding.applied_summary.as_ref().unwrap().model.as_deref(), Some("named-from-connection"));
    assert_eq!(binding.applied_profile.as_ref().unwrap().model_summary.as_ref().unwrap().model, "named-from-connection");
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
            editing: None,
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

impl crate::adapters::configuration::ConfigurationAdapter for Sixth {
    fn portable_field_kind(&self, path: &[String]) -> crate::adapters::configuration::PortableFieldKind {
        if path.last().is_some_and(|field| field == "maxTokens") { crate::adapters::configuration::PortableFieldKind::Parameter } else { Default::default() }
    }
    fn suppression_changes(&self, action: &crate::adapters::configuration::ConfigurationAction) -> Result<Vec<crate::adapters::configuration::SuppressionChange>, String> {
        if action.operation != "reset" { return Ok(vec![]); }
        let id = action.target.as_str().ok_or("invalid target")?;
        let field = crate::adapters::pointer_token(action.field.as_deref().ok_or("missing field")?);
        let path = if id == "configuration" { format!("/{field}") } else { format!("/models/{}/{field}",crate::adapters::pointer_token(id)) };
        Ok(vec![crate::adapters::configuration::SuppressionChange {role:"settings".into(),path,suppressed:false}])
    }
    fn reconcile_text(&self, _previous: Option<&crate::adapters::configuration::Documents>, next: &crate::adapters::configuration::Documents, _effective: &crate::adapters::configuration::Documents, state: &mut crate::adapters::configuration::EditingState) -> Result<(), String> {
        let root = next.get("settings").cloned().unwrap_or_else(|| json!({}));
        state.intents.retain_mut(|action| {
            let Some(id)=action.target.as_str() else {return false;};
            let entity = root.get("models").and_then(|models|models.get(id));
            match action.operation.as_str() {
                "delete" => entity.is_none(),
                "rename" => entity.is_none() && action.value.as_ref().and_then(Value::as_str).is_some_and(|new_id|root.get("models").and_then(|models|models.get(new_id)).is_some()),
                "reset" => { let target=if id=="configuration" {Some(&root)} else {entity}; target.and_then(|target|action.field.as_deref().and_then(|field|target.get(field))).is_none() },
                "create" => if let Some(entity)=entity {action.value=Some(entity.clone());true} else {false},
                "default" => root.get("model").and_then(Value::as_str)==Some(id),
                "set" => false,
                _ => false,
            }
        });
        Ok(())
    }

    fn describe(&self, _: Scope) -> crate::adapters::configuration::ConfigurationDescriptor {
        use crate::adapters::configuration::*;
        ConfigurationDescriptor { version: 1, operations: vec!["set", "reset", "create", "rename", "delete", "default"].into_iter().map(str::to_owned).collect(), fields: vec![ConfigurationField {
            id: "window".into(), label: "Context window".into(), kind: "integer".into(), required: true, advanced: false, choices: vec![], minimum: Some(1.0), default_source: None, unavailable_reason: None, origin: None,
        }] }
    }
    fn read(&self, documents: &crate::adapters::configuration::Documents, _: &crate::adapters::configuration::EditingState) -> Result<Value, String> {
        Ok(documents.get("settings").cloned().unwrap_or_else(|| json!({})))
    }
    fn edit(&self, documents: &mut crate::adapters::configuration::Documents, _: &mut crate::adapters::configuration::EditingState, action: &crate::adapters::configuration::ConfigurationAction) -> Result<(), String> {
        let root = documents.entry("settings".into()).or_insert_with(|| json!({}));
        let id = action.target.as_str().ok_or("fixture target must be a logical ID")?;
        match action.operation.as_str() {
            "create" => {
                if root.get("models").and_then(|models| models.get(id)).is_some() { return Err("duplicate model".into()); }
                if root.get("models").is_none() { root["models"] = json!({}); }
                root["models"][id] = action.value.clone().ok_or("missing model")?;
            }
            "delete" => {
                root["models"].as_object_mut().ok_or("missing models")?.remove(id);
                if root["model"].as_str() == Some(id) { root.as_object_mut().unwrap().remove("model"); }
            }
            "rename" => {
                let next = action.value.as_ref().and_then(Value::as_str).ok_or("missing new identity")?;
                let models = root["models"].as_object_mut().ok_or("missing models")?;
                if models.contains_key(next) { return Err("duplicate model".into()); }
                let model = models.remove(id).ok_or("missing model")?;
                models.insert(next.into(), model);
                if root["model"].as_str() == Some(id) { root["model"] = json!(next); }
            }
            "default" => { if root["models"].get(id).is_none() { return Err("missing model".into()); } root["model"] = json!(id); }
            "set" | "reset" => {
                let field = action.field.as_deref().ok_or("missing field")?;
                let target = if id == "configuration" { root } else { root["models"].get_mut(id).ok_or("missing model")? };
                let map = target.as_object_mut().ok_or("invalid target")?;
                if action.operation == "reset" { map.remove(field); } else { map.insert(field.into(), action.value.clone().unwrap_or(Value::Null)); }
            }
            _ => return Err("unsupported operation".into()),
        }
        Ok(())
    }
    fn validate(&self, documents: &crate::adapters::configuration::Documents, _: &crate::adapters::configuration::EditingState, _: Scope) -> Vec<crate::adapters::configuration::ConfigurationIssue> {
        let mut issues = vec![];
        if let Some(models) = documents.get("settings").and_then(|root| root.get("models")).and_then(Value::as_object) {
            for (id, model) in models {
                if !model.get("window").and_then(Value::as_u64).is_some_and(|value| value > 0) {
                    issues.push(crate::adapters::configuration::ConfigurationIssue { target: json!(id), field: Some("window".into()), code: "positive_integer".into(), message: "window is required and must be positive".into() });
                }
            }
            if let Some(default) = documents["settings"].get("model").and_then(Value::as_str) {
                if !models.contains_key(default) { issues.push(crate::adapters::configuration::ConfigurationIssue { target: json!("configuration"), field: Some("model".into()), code: "invalid_reference".into(), message: "default model is missing".into() }); }
            }
        }
        issues
    }
    fn connection(&self, documents: &crate::adapters::configuration::Documents, _: &crate::adapters::configuration::EditingState) -> Result<Option<Connection>, String> {
        let root = documents.get("settings").cloned().unwrap_or_else(|| json!({}));
        Ok(match (root["provider"].as_str(), root["baseUrl"].as_str(), root["model"].as_str()) {
            (Some(provider), Some(base), Some(model)) => Some(Connection { provider_id: provider.into(), base_url: base.into(), model: model.into(), interface_format: "openai_responses".into(), secret_ref: None, auth_env_var: None, model_records: vec![] }),
            _ => None,
        })
    }
    fn managed_fields(&self, _: &str, current: &Value, desired: &Value, profile: &RegisteredProfile) -> Result<crate::adapters::configuration::ManagedConfiguration, String> {
        let mut fields = BTreeMap::new();
        crate::native::apply::flatten(desired, &mut Vec::new(), &mut fields);
        let mut managed = crate::adapters::configuration::ManagedConfiguration { fields: fields.into_iter().map(|(path,value)| (path,Some(value))).collect(), released: vec![] };
        for action in &profile.editing.as_ref().unwrap().intents {
            let id = action.target.as_str().unwrap();
            if action.operation == "delete" || action.operation == "rename" {
                let path = format!("/models/{}", crate::adapters::pointer_token(id));
                if let Some(model) = current.get("models").and_then(|models| models.get(id)) {
                    let mut removed = BTreeMap::new();
                    crate::native::apply::flatten(model, &mut vec!["models".into(), id.into()], &mut removed);
                    for pointer in removed.keys() { managed.fields.insert(pointer.clone(), None); }
                    if removed.is_empty() { managed.fields.insert(path, None); }
                }
            } else if action.operation == "reset" {
                let field = crate::adapters::pointer_token(action.field.as_deref().unwrap());
                managed.released.push(if id == "configuration" { format!("/{field}") } else { format!("/models/{}/{field}", crate::adapters::pointer_token(id)) });
            }
        }
        Ok(managed)
    }
}

#[test]
fn sixth_configuration_port_round_trips_logical_edits_and_rejects_invalid_drafts() {
    use crate::native::configuration;
    use crate::adapters::configuration::ConfigurationAction;
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let credentials = MemoryCredentials::default();
    let source = json!({"unknown":{"preserved":true},"temperature":0.5});
    let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"models","version":0,"inheritCommon":false,"files":{"settings":source.to_string()},"connection":null,"nativeCredentials":{}})).unwrap();
    let mut draft = configuration::open(&registry, profile, Scope::Global, "session".into()).unwrap();
    let action = |operation: &str, target: &str, field: Option<&str>, value: Option<Value>| ConfigurationAction { version: 1, target: json!(target), operation: operation.into(), field: field.map(str::to_owned), value };
    assert!(configuration::describe(&registry, "sixth_fixture", Scope::Global).unwrap().unwrap().fields[0].required);
    for id in ["a", "b", "c"] { draft = configuration::edit(&registry, draft, action("create", id, None, Some(json!({"window":100,"unknown":true})))).unwrap(); }
    draft = configuration::edit(&registry, draft, action("default", "a", None, None)).unwrap();
    let before_invalid = draft.view.clone();
    let invalid = configuration::replace_text(&registry, draft.clone(), BTreeMap::from([("settings".into(), "{broken".into())]));
    assert_eq!(invalid.profile.files["settings"], "{broken");
    assert_eq!(invalid.view, before_invalid);
    assert!(!invalid.issues.is_empty());
    assert!(crate::native::profile::save_registered_profile(&db, &registry, invalid.profile, None).is_err());
    let bad = configuration::edit(&registry, draft.clone(), action("set", "b", Some("window"), Some(json!(0)))).unwrap();
    assert_eq!(bad.view["models"]["b"]["window"], 0);
    assert_eq!(bad.issues[0].field.as_deref(), Some("window"));
    assert!(crate::native::profile::save_registered_profile(&db, &registry, bad.profile, None).is_err());
    draft = configuration::edit(&registry, draft, action("rename", "c", None, Some(json!("renamed")))).unwrap();
    let first = crate::native::profile::save_registered_profile(&db, &registry, draft.profile.clone(), None).unwrap();
    assert_eq!(crate::native::profile::get_registered_profile(&db, &first.id).unwrap().editing, first.editing);
    let files = SIXTH.native_files(Scope::Global, temp.path(), None, true);
    std::fs::create_dir_all(temp.path().join(".sixth")).unwrap();
    let target = temp.path().join(".sixth/settings.json");
    std::fs::write(&target, source.to_string()).unwrap();
    crate::native::apply::apply_registered_validated(&registry, &db, &credentials, &first, None, &files, "global", Scope::Global, true).unwrap();
    draft.profile = first;
    draft = configuration::edit(&registry, draft, action("delete", "b", None, None)).unwrap();
    draft = configuration::edit(&registry, draft, action("reset", "configuration", Some("temperature"), None)).unwrap();
    draft = configuration::edit(&registry, draft, action("set", "a", Some("window"), Some(json!(200)))).unwrap();
    let saved = crate::native::profile::save_registered_profile(&db, &registry, draft.profile.clone(), Some(draft.profile.version)).unwrap();
    crate::native::apply::apply_registered_validated(&registry, &db, &credentials, &saved, None, &files, "global", Scope::Global, false).unwrap();
    let disk: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
    assert!(disk["models"].get("b").is_none());
    assert_eq!(disk["models"]["a"]["window"], 200);
    assert_eq!(disk["models"]["renamed"]["unknown"], true);
    assert!(disk.get("temperature").is_none());
    assert_eq!(disk["unknown"]["preserved"], true);
    let snapshot = crate::portable::collect_snapshot(&db, &credentials, &registry).unwrap();
    assert_eq!(snapshot.schema_version, 2);
    let restored: crate::portable::PortableSnapshot = serde_json::from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();
    let portable = restored.entities.iter().find_map(|entity| if let crate::portable::PortablePayload::Profile(value) = &entity.payload { Some(value) } else { None }).unwrap();
    assert_eq!(portable.profile.editing, saved.editing);
    assert_eq!(portable.profile.files, saved.files);
    let destination = tempfile::tempdir().unwrap();
    let imported_db = crate::database::Database::open(&destination.path().join("app.db")).unwrap();
    let preview = crate::portable::preview_import(&imported_db, &credentials, &registry, restored).unwrap();
    let selected = std::collections::BTreeSet::from([format!("profile:{}", saved.id)]);
    crate::portable::apply_import(&imported_db, &credentials, &registry, &preview, &selected).unwrap();
    let imported = crate::native::profile::get_registered_profile(&imported_db, &saved.id).unwrap();
    assert_eq!(imported.editing, saved.editing);
    assert_eq!(imported.files, saved.files);
}

#[test]
fn sixth_configuration_projection_never_reuses_credentials_for_changed_connection_identity() {
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let mut profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"credentials","version":0,"inheritCommon":false,"files":{"settings":json!({"provider":"one","baseUrl":"https://one.test/v1","model":"a"}).to_string()},"connection":{"providerId":"one","baseUrl":"https://one.test/v1","model":"a","interfaceFormat":"openai_responses","secretRef":"connection:test","authEnvVar":"FIRST_KEY"},"nativeCredentials":{}})).unwrap();
    // Simulate an already upgraded profile; the legacy adapter overlays only model.
    profile.editing = Some(Default::default());
    let parsed = crate::native::configuration::documents(&registry, &profile).unwrap();
    crate::native::configuration::derive_connection(&registry, &mut profile, &parsed).unwrap();
    assert_eq!(profile.connection.as_ref().unwrap().secret_ref.as_deref(), Some("connection:test"));
    for field in ["provider", "baseUrl"] {
        let mut changed = parsed.clone();
        changed.get_mut("settings").unwrap()[field] = if field == "provider" { json!("two") } else { json!("https://two.test/v1") };
        let mut next = profile.clone();
        crate::native::configuration::derive_connection(&registry, &mut next, &changed).unwrap();
        assert!(next.connection.as_ref().unwrap().secret_ref.is_none());
        assert!(next.connection.as_ref().unwrap().auth_env_var.is_none());
    }
}

#[test]
fn sixth_reset_restores_inheritance_and_checks_previous_owned_value() {
    use crate::native::configuration;
    use crate::adapters::configuration::ConfigurationAction;
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let credentials = MemoryCredentials::default();
    let common = crate::native::profile::save_registered_common(&db, &registry, crate::native::profile::RegisteredCommon { tool: "sixth_fixture".into(), version: 0, revision: String::new(), files: BTreeMap::from([("settings".into(), json!({"temperature":0.2}).to_string())]) }, None).unwrap();
    let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"inherit","version":0,"inheritCommon":true,"files":{"settings":json!({"temperature":0.8}).to_string()},"connection":null,"nativeCredentials":{}})).unwrap();
    let mut draft = configuration::open_with_common(&registry, profile, Some(common.clone()), Scope::Global, "inherit-session".into()).unwrap();
    let saved = crate::native::profile::save_registered_profile(&db, &registry, draft.profile.clone(), None).unwrap();
    let files = SIXTH.native_files(Scope::Global, temp.path(), None, true);
    std::fs::create_dir_all(temp.path().join(".sixth")).unwrap();
    let target = temp.path().join(".sixth/settings.json");
    std::fs::write(&target, "{}").unwrap();
    crate::native::apply::apply_registered_validated(&registry, &db, &credentials, &saved, Some(&common), &files, "global", Scope::Global, false).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&target).unwrap()).unwrap()["temperature"], 0.8);
    draft.profile = saved;
    draft = configuration::edit(&registry, draft, ConfigurationAction { version: 1, operation: "reset".into(), target: json!("configuration"), field: Some("temperature".into()), value: None }).unwrap();
    assert_eq!(draft.view["temperature"], 0.2);
    assert!(draft.profile.files["settings"].find("temperature").is_none());
    let reset = crate::native::profile::save_registered_profile(&db, &registry, draft.profile.clone(), Some(draft.profile.version)).unwrap();
    std::fs::write(&target, json!({"temperature":0.9,"unrelated":true}).to_string()).unwrap();
    assert!(crate::native::apply::apply_registered_validated(&registry, &db, &credentials, &reset, Some(&common), &files, "global", Scope::Global, false).unwrap_err().contains("外部修改"));
    assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&target).unwrap()).unwrap()["temperature"], 0.9);
    std::fs::write(&target, json!({"temperature":0.8,"unrelated":true}).to_string()).unwrap();
    crate::native::apply::apply_registered_validated(&registry, &db, &credentials, &reset, Some(&common), &files, "global", Scope::Global, false).unwrap();
    let result: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
    assert_eq!(result["temperature"], 0.2);
    assert_eq!(result["unrelated"], true);
}

#[test]
fn sixth_legacy_connection_model_records_normalize_once_and_new_projection_cannot_override_text() {
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"legacy","version":0,"inheritCommon":false,"files":{"settings":json!({"model":"old","models":{"new":{"window":10,"unknown":true}}}).to_string()},"connection":{"providerId":"one","interfaceFormat":"openai_responses","baseUrl":"https://one.test/v1","model":"new","secretRef":null,"authEnvVar":null,"modelRecords":[{"id":"new","fields":{"window":100}}]},"nativeCredentials":{}})).unwrap();
    let draft = crate::native::configuration::open(&registry, profile, Scope::Global, "upgrade".into()).unwrap();
    assert_eq!(draft.view["model"], "new");
    assert_eq!(draft.view["models"]["new"]["window"], 100);
    assert_eq!(draft.view["models"]["new"]["unknown"], true);
    assert_eq!(draft.profile.editing.as_ref().unwrap().version, 1);
    let mut profile = draft.profile;
    profile.connection = Some(Connection { provider_id: "one".into(), interface_format: "openai_responses".into(), base_url: "https://one.test/v1".into(), model: "ignored".into(), secret_ref: None, auth_env_var: None, model_records: vec![] });
    let normalized = profile.files.clone();
    crate::native::configuration::normalize_legacy(&registry, &mut profile, Scope::Global).unwrap();
    assert_eq!(profile.files, normalized);
    let documents = crate::native::apply::desired_registered_documents(&registry, &profile, None, Scope::Global).unwrap();
    assert_eq!(documents["settings"]["model"], "new");
    let version_two = crate::adapters::configuration::EditingState { version: 2, ..Default::default() };
    profile.editing = Some(version_two);
    assert!(crate::native::configuration::normalize_legacy(&registry, &mut profile, Scope::Global).is_err());
}

#[test]
fn sixth_field_intents_compact_obsolete_values_and_reject_plaintext_or_undeclared_actions() {
    use crate::adapters::configuration::ConfigurationAction;
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"compact","version":0,"inheritCommon":false,"files":{"settings":"{}"},"connection":null,"nativeCredentials":{}})).unwrap();
    let mut draft = crate::native::configuration::open(&registry, profile, Scope::Global, "compact".into()).unwrap();
    let action = |field: &str, value: Value| ConfigurationAction { version: 1, target: json!("configuration"), operation: "set".into(), field: Some(field.into()), value: Some(value) };
    for value in 0..100 { draft = crate::native::configuration::edit(&registry, draft, action("temperature", json!(value))).unwrap(); }
    assert_eq!(draft.profile.editing.as_ref().unwrap().intents.len(), 1);
    assert_eq!(draft.profile.editing.as_ref().unwrap().intents[0].value, Some(json!(99)));
    assert!(crate::native::configuration::edit(&registry, draft.clone(), action("api_key", json!("paste-secret-by-mistake"))).unwrap_err().contains("明文密钥"));
    let mut undeclared = action("temperature", json!(10)); undeclared.operation = "unregistered".into();
    assert!(crate::native::configuration::edit(&registry, draft.clone(), undeclared).unwrap_err().contains("未声明"));
    let mut huge = action("temperature", json!(0)); huge.value = Some(json!("x".repeat(512_001)));
    assert!(crate::native::configuration::edit(&registry, draft.clone(), huge).unwrap_err().contains("安全限制"));
    assert_eq!(draft.view["temperature"], 99);
}

#[test]
fn sixth_oauth_and_rebind_profiles_keep_model_view_without_api_connection() {
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let account = json!({"id":"fixture-account","toolId":"sixth_fixture","provider":"fixture","label":"Fixture","version":1,"state":"signed_out","identity":null,"context":null,"pendingLogin":null,"checkedAt":null,"detail":null});
    db.with_connection(|conn| { conn.execute("INSERT INTO auth_accounts(id,tool,version,data) VALUES('fixture-account','sixth_fixture',1,?1)", [account.to_string()]).unwrap(); Ok(()) }).unwrap();
    for authentication in [json!({"kind":"oauth","accountId":"fixture-account"}), json!({"kind":"rebind_required"})] {
        let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"OAuth model","version":0,"inheritCommon":false,"authentication":authentication,"files":{"settings":json!({"provider":"mine","baseUrl":"https://mine.test/v1","model":"a","models":{"a":{"window":100}}}).to_string()},"connection":null,"nativeCredentials":{}})).unwrap();
        let draft = crate::native::configuration::open(&registry, profile, Scope::Global, "oauth-model".into()).unwrap();
        assert_eq!(draft.view["model"], "a");
        assert!(draft.issues.is_empty());
        assert!(draft.profile.connection.is_none());
        let saved = crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None).unwrap();
        assert!(saved.connection.is_none());
        assert!(saved.files["settings"].contains("window"));
    }
}

#[test]
fn sixth_required_values_are_validated_from_effective_common_without_copying_into_own_files() {
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let common = crate::native::profile::save_registered_common(&db, &registry, crate::native::profile::RegisteredCommon { tool: "sixth_fixture".into(), version: 0, revision: String::new(), files: BTreeMap::from([("settings".into(), json!({"models":{"inherited":{"window":128}}}).to_string())]) }, None).unwrap();
    let profile: RegisteredProfile = serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"inherit required","version":0,"inheritCommon":true,"files":{"settings":json!({"models":{"inherited":{"name":"Own name"}}}).to_string()},"connection":null,"nativeCredentials":{}})).unwrap();
    let draft = crate::native::configuration::open_with_common(&registry, profile, Some(common.clone()), Scope::Global, "required".into()).unwrap();
    assert!(draft.issues.is_empty());
    assert_eq!(draft.view["models"]["inherited"]["window"], 128);
    assert!(!draft.profile.files["settings"].contains("window"));
    let saved = crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None).unwrap();
    let effective = crate::native::apply::desired_registered_documents(&registry, &saved, Some(&common), Scope::Global).unwrap();
    assert_eq!(effective["settings"]["models"]["inherited"]["window"], 128);
    assert_eq!(effective["settings"]["models"]["inherited"]["name"], "Own name");
    let mut invalid = common.clone();
    invalid.files.insert("settings".into(), json!({"models":{"inherited":{"window":0}}}).to_string());
    assert!(crate::native::profile::save_registered_common(&db, &registry, invalid, Some(common.version)).is_err());
}

fn editing_fixture_profile(settings: Value) -> RegisteredProfile {
    serde_json::from_value(json!({"id":"","tool":"sixth_fixture","name":"repair fixture","version":0,"inheritCommon":false,"files":{"settings":settings.to_string()},"connection":null,"nativeCredentials":{}})).unwrap()
}

#[test]
fn sixth_omitting_editing_cannot_bypass_required_validation_on_save_or_apply() {
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let invalid = editing_fixture_profile(json!({"models":{"a":{"window":0}}}));
    assert!(crate::native::profile::save_registered_profile(&db, &registry, invalid.clone(), None).is_err());
    assert!(crate::native::apply::desired_registered_documents(&registry, &invalid, None, Scope::Global).is_err());
    assert!(crate::native::profile::list_registered_profiles(&db, "sixth_fixture").unwrap().is_empty());
    let valid = crate::native::profile::save_registered_profile(&db, &registry, editing_fixture_profile(json!({"models":{"a":{"window":100}}})), None).unwrap();
    assert_eq!(valid.editing.unwrap().version, 1);
}

#[test]
fn sixth_raw_restoration_reconciles_delete_and_rename_intents_before_application() {
    use crate::native::configuration;
    use crate::adapters::configuration::ConfigurationAction;
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let credentials = MemoryCredentials::default();
    let source = json!({"models":{"a":{"window":100},"b":{"window":100}}});
    let mut draft = configuration::open(&registry, editing_fixture_profile(source), Scope::Global, "raw-restore".into()).unwrap();
    draft.profile = crate::native::profile::save_registered_profile(&db, &registry, draft.profile, None).unwrap();
    let files = SIXTH.native_files(Scope::Global, temp.path(), None, true);
    std::fs::create_dir_all(temp.path().join(".sixth")).unwrap();
    let path = temp.path().join(".sixth/settings.json");
    std::fs::write(&path, "{}").unwrap();
    crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&draft.profile,None,&files,"global",Scope::Global,false).unwrap();
    let action = |operation:&str, target:&str, value:Option<Value>| ConfigurationAction { version:1, target:json!(target), operation:operation.into(), field:None, value };
    draft = configuration::edit(&registry,draft,action("delete","b",None)).unwrap();
    draft = configuration::edit(&registry,draft,action("rename","a",Some(json!("renamed")))).unwrap();
    let restored = json!({"models":{"a":{"window":150},"b":{"window":200}}});
    draft = configuration::replace_text(&registry,draft,BTreeMap::from([("settings".into(),restored.to_string())]));
    assert!(draft.issues.is_empty());
    assert!(!draft.profile.editing.as_ref().unwrap().intents.iter().any(|action| matches!(action.operation.as_str(),"delete"|"rename")));
    let saved = crate::native::profile::save_registered_profile(&db,&registry,draft.profile.clone(),Some(draft.profile.version)).unwrap();
    crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&saved,None,&files,"global",Scope::Global,false).unwrap();
    let disk:Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(disk["models"]["a"]["window"],150);
    assert_eq!(disk["models"]["b"]["window"],200);
    draft.profile = saved;
    draft = configuration::edit(&registry,draft,action("delete","b",None)).unwrap();
    let raw = draft.profile.files.clone();
    let invalid = configuration::replace_text(&registry,draft.clone(),BTreeMap::from([("settings".into(),"{broken".into())]));
    assert!(!invalid.issues.is_empty());
    assert!(invalid.profile.editing.as_ref().unwrap().intents.iter().any(|action|action.operation=="delete"));
    draft = configuration::replace_text(&registry,invalid,raw);
    assert!(draft.profile.editing.as_ref().unwrap().intents.iter().any(|action|action.operation=="delete"));
    let saved = crate::native::profile::save_registered_profile(&db,&registry,draft.profile.clone(),Some(draft.profile.version)).unwrap();
    crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&saved,None,&files,"global",Scope::Global,false).unwrap();
    assert!(serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap()["models"].get("b").is_none());
}

#[test]
fn sixth_reset_removes_only_its_corresponding_legacy_suppression() {
    use crate::native::configuration;
    let registry = Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let common = crate::native::profile::save_registered_common(&db,&registry,crate::native::profile::RegisteredCommon { tool:"sixth_fixture".into(),version:0,revision:String::new(),files:BTreeMap::from([("settings".into(),json!({"temperature":0.2,"unrelated":true}).to_string())]) },None).unwrap();
    let mut profile = editing_fixture_profile(json!({"temperature":0.8}));
    profile.inherit_common=true;
    profile.suppressed=BTreeMap::from([("settings".into(),vec!["/temperature".into(),"/unrelated".into()])]);
    let mut draft=configuration::open_with_common(&registry,profile,Some(common.clone()),Scope::Global,"suppression".into()).unwrap();
    draft=configuration::edit(&registry,draft,crate::adapters::configuration::ConfigurationAction { version:1,target:json!("configuration"),operation:"reset".into(),field:Some("temperature".into()),value:None }).unwrap();
    assert_eq!(draft.view["temperature"],0.2);
    assert_eq!(draft.profile.suppressed["settings"],vec!["/unrelated"]);
    let saved=crate::native::profile::save_registered_profile(&db,&registry,draft.profile,None).unwrap();
    let desired=crate::native::apply::desired_registered_documents(&registry,&saved,Some(&common),Scope::Global).unwrap();
    assert_eq!(desired["settings"]["temperature"],0.2);
    assert!(desired["settings"].get("unrelated").is_none());
}

#[test]
fn sixth_portable_preserves_declared_model_token_limits_in_documents_and_intents() {
    let registry=Registry::with_adapters(vec![&SIXTH]).unwrap();
    let temp=tempfile::tempdir().unwrap();
    let db=crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let credentials=MemoryCredentials::default();
    let draft=crate::native::configuration::open(&registry,editing_fixture_profile(json!({})),Scope::Global,"portable-fields".into()).unwrap();
    let draft=crate::native::configuration::edit(&registry,draft,crate::adapters::configuration::ConfigurationAction { version:1,target:json!("a"),operation:"create".into(),field:None,value:Some(json!({"window":100,"maxTokens":32,"unknown":true,"cachePath":"/device/only/model-cache","customAuthToken":"must-not-export"})) }).unwrap();
    let saved=crate::native::profile::save_registered_profile(&db,&registry,draft.profile,None).unwrap();
    let snapshot=crate::portable::collect_snapshot(&db,&credentials,&registry).unwrap();
    let portable=snapshot.entities.iter().find_map(|entity|if let crate::portable::PortablePayload::Profile(value)=&entity.payload {Some(value)} else {None}).unwrap();
    let document:Value=serde_json::from_str(&portable.profile.files["settings"]).unwrap();
    assert_eq!(document["models"]["a"]["maxTokens"],32);
    assert!(document["models"]["a"].get("cachePath").is_none());
    assert!(document["models"]["a"].get("customAuthToken").is_none());
    assert!(!serde_json::to_string(portable).unwrap().contains("must-not-export"));
    assert!(!serde_json::to_string(portable).unwrap().contains("/device/only"));
    assert_eq!(portable.profile.editing.as_ref().unwrap().intents[0].value.as_ref().unwrap()["maxTokens"],32);
    let target=crate::database::Database::open(&temp.path().join("target.db")).unwrap();
    let preview=crate::portable::preview_import(&target,&credentials,&registry,snapshot).unwrap();
    crate::portable::apply_import(&target,&credentials,&registry,&preview,&std::collections::BTreeSet::from([format!("profile:{}",saved.id)])).unwrap();
    let imported=crate::native::profile::get_registered_profile(&target,&saved.id).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&imported.files["settings"]).unwrap()["models"]["a"]["maxTokens"],32);
}

struct CredentialFixture;
static CREDENTIAL_FIXTURE: CredentialFixture = CredentialFixture;
impl CliAdapter for CredentialFixture {
    fn configuration(&self)->Option<&dyn crate::adapters::configuration::ConfigurationAdapter>{Some(self)}
    fn id(&self)->&'static str{"credential_fixture"}
    fn name(&self)->&'static str{"Credential fixture"}
    fn command(&self)->&'static str{"fixture"}
    fn npm_package(&self)->&'static str{"fixture"}
    fn version_identity(&self,_:&str,_:&str)->bool{true}
    fn native_files(&self,_:Scope,home:&Path,_:Option<&Path>,known:bool)->Vec<NativeFile>{vec![file("settings",home.join("credential-fixture.toml"),FileKind::Toml,known,None,false)]}
    fn file_kind(&self,role:&str)->Result<FileKind,String>{crate::adapters::CODEX.file_kind(role)}
    fn interface_formats(&self)->&'static [&'static str]{&["openai_responses"]}
    fn connection_documents(&self,connection:&Connection,_:Scope)->Result<BTreeMap<String,Value>,String>{Ok(BTreeMap::from([("settings".into(),json!({"model":connection.model}))]))}
    fn write_connection_secret(&self,profile:&RegisteredProfile,scope:Scope,credentials:&dyn CredentialStore,secrets:&mut NativeSecrets)->Result<(),String>{crate::adapters::CODEX.write_connection_secret(profile,scope,credentials,secrets)}
    fn has_native_secret(&self,role:&str,value:&Value)->bool{crate::adapters::CODEX.has_native_secret(role,value)}
    fn inspect_values(&self,settings:&Value,local:&Value,models:&Value)->InspectionFields{crate::adapters::CODEX.inspect_values(settings,local,models)}
    fn launch_args(&self,_:Option<&str>,_:LaunchMode)->Result<Vec<String>,String>{Ok(vec![])}
    fn install_guidance(&self)->(&'static str,&'static str){("","fixture")}
}
impl crate::adapters::configuration::ConfigurationAdapter for CredentialFixture {
    fn reconcile_text(&self,_:Option<&crate::adapters::configuration::Documents>,_:&crate::adapters::configuration::Documents,_:&crate::adapters::configuration::Documents,_:&mut crate::adapters::configuration::EditingState)->Result<(),String>{Ok(())}
    fn describe(&self,_:Scope)->crate::adapters::configuration::ConfigurationDescriptor{crate::adapters::configuration::ConfigurationDescriptor{version:1,fields:vec![],operations:vec![]}}
    fn read(&self,documents:&crate::adapters::configuration::Documents,_:&crate::adapters::configuration::EditingState)->Result<Value,String>{Ok(documents.get("settings").cloned().unwrap_or_else(||json!({})))}
    fn edit(&self,_:&mut crate::adapters::configuration::Documents,_:&mut crate::adapters::configuration::EditingState,_:&crate::adapters::configuration::ConfigurationAction)->Result<(),String>{Err("fixture read only".into())}
    fn validate(&self,_:&crate::adapters::configuration::Documents,_:&crate::adapters::configuration::EditingState,_:Scope)->Vec<crate::adapters::configuration::ConfigurationIssue>{vec![]}
    fn connection(&self,documents:&crate::adapters::configuration::Documents,_:&crate::adapters::configuration::EditingState)->Result<Option<Connection>,String>{
        let root=documents.get("settings").cloned().unwrap_or_else(||json!({}));
        Ok(match(root["model_provider"].as_str(),root["model"].as_str()) {
            (Some(provider),Some(model))=>root["model_providers"][provider]["base_url"].as_str().map(|base|Connection{provider_id:provider.into(),interface_format:"openai_responses".into(),base_url:base.into(),model:model.into(),secret_ref:None,auth_env_var:None,model_records:vec![]}),_=>None
        })
    }
}
fn inherited_credential_fixture(db:&crate::database::Database,registry:&Registry)->(RegisteredProfile,crate::native::profile::RegisteredCommon){
    let common=crate::native::profile::save_registered_common(db,registry,crate::native::profile::RegisteredCommon {tool:"credential_fixture".into(),version:0,revision:String::new(),files:BTreeMap::from([("settings".into(),"model_provider = 'mine'\n[model_providers.mine]\nbase_url = 'https://old.example/v1'\nwire_api = 'responses'\n".into())])},None).unwrap();
    let profile=serde_json::from_value(json!({"id":"","tool":"credential_fixture","name":"inherited credential","version":0,"inheritCommon":true,"authentication":{"kind":"api_key"},"files":{"settings":"model = 'a'"},"connection":{"providerId":"mine","interfaceFormat":"openai_responses","baseUrl":"https://old.example/v1","model":"a","secretRef":"connection-00000000-0000-4000-8000-000000000001","authEnvVar":"EXISTING_KEY"},"nativeCredentials":{}})).unwrap();
    (profile,common)
}

#[test]
fn inherited_connection_references_survive_legacy_open_and_save_when_identity_is_unchanged(){
    let registry=Registry::with_adapters(vec![&CREDENTIAL_FIXTURE]).unwrap();
    let temp=tempfile::tempdir().unwrap();let db=crate::database::Database::open(&temp.path().join("db")).unwrap();
    let (profile,common)=inherited_credential_fixture(&db,&registry);
    let original=profile.connection.as_ref().unwrap();
    let draft=crate::native::configuration::open_with_common(&registry,profile.clone(),Some(common),Scope::Global,"refs".into()).unwrap();
    let projected=draft.profile.connection.as_ref().unwrap();
    assert_eq!(projected.secret_ref,original.secret_ref);assert_eq!(projected.auth_env_var,original.auth_env_var);
    let saved=crate::native::profile::save_registered_profile(&db,&registry,profile,None).unwrap();
    assert_eq!(saved.connection.as_ref().unwrap().secret_ref,projected.secret_ref);
    assert_eq!(saved.connection.as_ref().unwrap().auth_env_var,projected.auth_env_var);
}

#[test]
fn application_requires_rebinding_when_common_changes_the_effective_credential_destination(){
    let registry=Registry::with_adapters(vec![&CREDENTIAL_FIXTURE]).unwrap();
    let temp=tempfile::tempdir().unwrap();let db=crate::database::Database::open(&temp.path().join("db")).unwrap();let credentials=MemoryCredentials::default();
    let (mut profile,common)=inherited_credential_fixture(&db,&registry);
    credentials.put(profile.connection.as_ref().unwrap().secret_ref.as_deref().unwrap(),"synthetic-old-destination-marker").unwrap();
    profile.editing=Some(Default::default());
    let saved=crate::native::profile::save_registered_profile(&db,&registry,profile,None).unwrap();
    let files=CREDENTIAL_FIXTURE.native_files(Scope::Global,temp.path(),None,true);
    let target=temp.path().join("credential-fixture.toml");std::fs::write(&target,"").unwrap();
    crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&saved,Some(&common),&files,"global",Scope::Global,false).unwrap();
    let original=std::fs::read_to_string(&target).unwrap();
    let mut changed=common.clone();changed.files.insert("settings".into(),common.files["settings"].replace("old.example","new.example"));
    let changed=crate::native::profile::save_registered_common(&db,&registry,changed,Some(common.version)).unwrap();
    let error=crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&saved,Some(&changed),&files,"global",Scope::Global,false).unwrap_err();
    assert!(error.contains("重新选择"),"{error}");assert_eq!(std::fs::read_to_string(&target).unwrap(),original);
    assert!(!original.contains("new.example"));
    // A separately selected key for the new identity can be saved and applied,
    // while the original DB version/revision still protects the transaction.
    let mut rebound=saved.clone();let connection=rebound.connection.as_mut().unwrap();connection.base_url="https://new.example/v1".into();connection.secret_ref=Some("connection-00000000-0000-4000-8000-000000000002".into());connection.auth_env_var=Some("NEW_KEY".into());
    credentials.put(connection.secret_ref.as_deref().unwrap(),"synthetic-new-destination-marker").unwrap();
    let rebound=crate::native::profile::save_registered_profile(&db,&registry,rebound,Some(saved.version)).unwrap();
    crate::native::apply::apply_registered_validated(&registry,&db,&credentials,&rebound,Some(&changed),&files,"global",Scope::Global,false).unwrap();
    let written=std::fs::read_to_string(&target).unwrap();assert!(written.contains("new.example"));assert!(written.contains("synthetic-new-destination-marker"));assert!(!written.contains("synthetic-old-destination-marker"));
}
