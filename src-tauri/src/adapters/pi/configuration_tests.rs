use crate::adapters::{configuration::ConfigurationAction, Registry};
use crate::credentials::CredentialStore;
use crate::database::Database;
use crate::native::{adapter::{NativeFile,Scope},apply,configuration,format::{self,FileKind},profile::{self,RegisteredProfile,RegisteredCommon}};
use serde_json::{json,Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
#[derive(Default)]struct Store(Mutex<BTreeMap<String,String>>);
impl CredentialStore for Store{fn put(&self,id:&str,value:&str)->Result<(),String>{self.0.lock().unwrap().insert(id.into(),value.into());Ok(())}fn get(&self,id:&str)->Result<String,String>{self.0.lock().unwrap().get(id).cloned().ok_or("missing synthetic key".into())}fn delete(&self,id:&str)->Result<(),String>{self.0.lock().unwrap().remove(id);Ok(())}}
fn blank(tool:&str)->RegisteredProfile{serde_json::from_value(json!({"id":"","tool":tool,"name":"native matrix","version":0,"inheritCommon":false,"files":{},"connection":null,"nativeCredentials":{}})).unwrap()}
fn action(operation:&str,provider:&str,id:&str,field:Option<&str>,value:Option<Value>)->ConfigurationAction{ConfigurationAction{version:1,target:json!({"kind":if matches!(operation,"configure_provider"|"select_provider"){"provider"}else{"model"},"provider":provider,"id":id}),operation:operation.into(),field:field.map(str::to_owned),value}}
fn create(tool:&str,id:&str)->Value{match tool{"kimi_code"=>json!({"provider":"alpha","model":format!("request-{id}"),"max_context_size":64000,"display_name":id}),"pi"=>json!({"name":id,"contextWindow":64000,"maxTokens":32,"reasoning":true,"input":["text"]}),_=>json!({"name":id,"limit":{"context":64000,"output":32},"reasoning":true,"modalities":{"input":["text"],"output":["text"]}})}}
fn files(registry:&Registry,tool:&str,directory:&Path)->Vec<NativeFile>{let adapter=registry.get(tool).unwrap();let roles:Vec<&str>=if tool=="pi"{vec!["settings","models"]}else{vec!["settings"]};roles.iter().map(|role|{let kind=adapter.file_kind(role).unwrap();crate::adapters::file(role,directory.join(format!("{role}.{}",match kind {FileKind::Toml=>"toml",FileKind::Jsonc=>"jsonc",FileKind::Yaml=>"yaml",FileKind::Json=>"json"})),kind,true,None,false)}).collect()}
fn disk(files:&[NativeFile],role:&str)->Value{let file=files.iter().find(|file|file.role==role).unwrap();format::parse(match file.format{"toml"=>FileKind::Toml,"jsonc"=>FileKind::Jsonc,_=>FileKind::Json},&std::fs::read_to_string(&file.path).unwrap()).unwrap()}
fn fixture(tool:&str)->RegisteredProfile{let mut profile=blank(tool);match tool{"pi"=>{profile.files.insert("models".into(),include_str!("../../../../tests/fixtures/native/pi-model-editor.json").into());profile.files.insert("settings".into(),json!({"defaultProvider":"alpha","defaultModel":"family/a~one"}).to_string());},"open_code"=>{profile.files.insert("settings".into(),include_str!("../../../../tests/fixtures/native/opencode-model-editor.jsonc").into());},_=>{profile.files.insert("settings".into(),include_str!("../../../../tests/fixtures/native/kimi-model-editor.toml").into());}}profile}

#[test]fn multi_native_three_models_copy_rename_delete_defaults_and_unknown_fields(){
    let registry=Registry::builtins();
    for tool in ["pi","open_code","kimi_code"]{
        let temp=tempfile::tempdir().unwrap();let db=Database::open(&temp.path().join("db")).unwrap();let store=Store::default();
        let mut draft=configuration::open(&registry,blank(tool),Scope::Global,format!("{tool}-crud")).unwrap();
        draft=configuration::edit(&registry,draft,action("configure_provider","alpha","",None,Some(json!({"baseUrl":"https://alpha.example/v1","interfaceFormat":"openai_responses"})))).unwrap();
        for id in ["first","slash/~victim","third"]{draft=configuration::edit(&registry,draft,action("create","alpha",id,None,Some(create(tool,id)))).unwrap();}
        draft=configuration::edit(&registry,draft,action("default","alpha","first",None,None)).unwrap();
        if tool=="open_code"{draft=configuration::edit(&registry,draft,action("small_default","alpha","first",None,None)).unwrap();}
        let saved=profile::save_registered_profile(&db,&registry,draft.profile.clone(),None).unwrap();let files=files(&registry,tool,temp.path());
        apply::apply_registered_validated(&registry,&db,&store,&saved,None,&files,"global",Scope::Global,false).unwrap();draft.profile=saved;
        draft=configuration::edit(&registry,draft,action("copy","alpha","third",None,Some(json!("copy")))).unwrap();
        draft=configuration::edit(&registry,draft,action("rename","alpha","first",None,Some(json!("slash/~renamed")))).unwrap();
        draft=configuration::edit(&registry,draft,action("delete","alpha","slash/~victim",None,None)).unwrap();
        let updated=profile::save_registered_profile(&db,&registry,draft.profile.clone(),Some(draft.profile.version)).unwrap();
        apply::apply_registered_validated(&registry,&db,&store,&updated,None,&files,"global",Scope::Global,false).unwrap();
        let settings=disk(&files,"settings");match tool{
            "pi"=>{let models=disk(&files,"models");let models=models["providers"]["alpha"]["models"].as_array().unwrap();assert!(!models.iter().any(|model|model["id"]=="slash/~victim"||model["id"]=="first"));assert_eq!(models.len(),3);assert_eq!(settings["defaultModel"],"slash/~renamed");},
            "open_code"=>{assert!(settings["provider"]["alpha"]["models"].get("slash/~victim").is_none());assert!(settings["provider"]["alpha"]["models"].get("first").is_none());assert_eq!(settings["model"],"alpha/slash/~renamed");assert_eq!(settings["small_model"],"alpha/slash/~renamed");},
            _=>{assert!(settings["models"].get("slash/~victim").is_none());assert!(settings["models"].get("first").is_none());assert_eq!(settings["models"]["slash/~renamed"]["model"],"request-first");assert_eq!(settings["default_model"],"slash/~renamed");},
        }
    }
}

#[test]fn multi_native_fixture_fields_raw_roundtrip_and_complete_submission_validation(){let registry=Registry::builtins();for tool in["pi","open_code","kimi_code"]{let temp=tempfile::tempdir().unwrap();let db=Database::open(&temp.path().join("db")).unwrap();let mut draft=configuration::open(&registry,fixture(tool),Scope::Global,format!("{tool}-fixture")).unwrap();assert!(draft.issues.is_empty(),"{tool}: {:?}",draft.issues);
    let id=if tool=="kimi_code"{"alias/a~one"}else{"family/a~one"};let field=match tool{"pi"=>"contextWindow","open_code"=>"limit.context",_=>"max_context_size"};
    draft=configuration::edit(&registry,draft,action("set","alpha",id,Some(field),Some(json!(123456)))).unwrap();let before=draft.view.clone();let raw=draft.profile.files.clone();draft=configuration::replace_text(&registry,draft,raw);assert_eq!(draft.view,before);
    assert!(draft.view["models"].as_array().unwrap().iter().any(|row|row["id"]==id&&(row["fields"].get("extensionFlag").is_some()||row["fields"].get("extension_flag").is_some())));
    let invalid=configuration::edit(&registry,draft.clone(),action("set","alpha",id,Some(field),Some(json!(0)))).unwrap();assert!(!invalid.issues.is_empty());assert!(profile::save_registered_profile(&db,&registry,invalid.profile,None).is_err());
    let own=configuration::documents(&registry,&draft.profile).unwrap();for(role,text)in &draft.profile.files{let parsed=format::parse(registry.get(tool).unwrap().file_kind(role).unwrap(),text).unwrap();assert_eq!(parsed,own[role]);}
}}

#[test]fn multi_native_pi_sparse_inheritance_tracks_future_common_and_rfc_pointer_sources(){let registry=Registry::builtins();let mut source=fixture("pi");source.inherit_common=true;source.files.insert("models".into(),json!({"providers":{"alpha":{"models":[{"id":"family/a~one","maxTokens":64}]}}}).to_string());let common=RegisteredCommon{tool:"pi".into(),version:1,revision:"common".into(),files:fixture("pi").files};let resolved=profile::resolve_registered_file(&registry,&source,Some(&common),"models").unwrap();assert_eq!(resolved.contents["providers"]["alpha"]["models"][0]["contextWindow"],64000);assert_eq!(resolved.contents["providers"]["alpha"]["models"][0]["maxTokens"],64);assert!(resolved.source_by_path.keys().any(|key|key.ends_with("/maxTokens")));
    let mut newer=common.clone();let mut models:Value=serde_json::from_str(&newer.files["models"]).unwrap();models["providers"]["alpha"]["models"][0]["contextWindow"]=json!(128000);newer.files.insert("models".into(),models.to_string());assert_eq!(profile::resolve_registered_file(&registry,&source,Some(&newer),"models").unwrap().contents["providers"]["alpha"]["models"][0]["contextWindow"],128000);
    source.suppressed.insert("models".into(),vec!["/providers/alpha/models/family~1a~0one/contextWindow".into()]);let mut draft=configuration::open_with_common(&registry,source,Some(newer),Scope::Global,"inherit".into()).unwrap();draft=configuration::edit(&registry,draft,action("reset","alpha","family/a~one",Some("contextWindow"),None)).unwrap();assert_eq!(draft.view["models"][0]["fields"]["contextWindow"],128000);
}

#[test]fn multi_native_environment_and_managed_secret_v2_roundtrip_reaches_actual_apply(){let registry=Registry::builtins();for tool in["pi","open_code","kimi_code"]{for managed in[false,true]{let temp=tempfile::tempdir().unwrap();let db=Database::open(&temp.path().join("source-db")).unwrap();let target=Database::open(&temp.path().join("target-db")).unwrap();let store=Store::default();let draft=configuration::open(&registry,fixture(tool),Scope::Global,format!("{tool}-portable")).unwrap();let mut profile=draft.profile;
    if managed{let id="connection-00000000-0000-4000-8000-000000000011";store.put(id,"synthetic-managed-marker").unwrap();profile.connection.as_mut().unwrap().secret_ref=Some(id.into());profile.authentication=profile::ProfileAuthentication::ApiKey;}
    let saved=profile::save_registered_profile(&db,&registry,profile,None).unwrap();let snapshot=crate::portable::collect_snapshot(&db,&store,&registry).unwrap();let preview=crate::portable::preview_import(&target,&store,&registry,snapshot).unwrap();crate::portable::apply_import(&target,&store,&registry,&preview,&std::collections::BTreeSet::from([format!("profile:{}",saved.id)])).unwrap();let imported=profile::get_registered_profile(&target,&saved.id).unwrap();let native=temp.path().join("native");std::fs::create_dir_all(&native).unwrap();let files=files(&registry,tool,&native);apply::apply_registered_validated(&registry,&target,&store,&imported,None,&files,"global",Scope::Global,false).unwrap();let result=if tool=="pi"{disk(&files,"models")}else{disk(&files,"settings")};match tool{
       "pi"=>assert_eq!(result["providers"]["alpha"]["apiKey"],if managed{"synthetic-managed-marker"}else{"${alpha_key}"}),
       "open_code"=>assert_eq!(result["provider"]["alpha"]["options"]["apiKey"],if managed{"synthetic-managed-marker"}else{"{env:alpha_key}"}),
       _=>{if managed{assert_eq!(result["providers"]["alpha"]["api_key"],"synthetic-managed-marker");assert!(result["providers"]["alpha"].get("api_key_env").is_none());}else{assert_eq!(result["providers"]["alpha"]["api_key_env"],"alpha_key");}}
    }
}}}

#[test]fn multi_native_opencode_deleted_empty_tree_and_live_reference_do_not_touch_other_models(){let registry=Registry::builtins();let temp=tempfile::tempdir().unwrap();let db=Database::open(&temp.path().join("db")).unwrap();let store=Store::default();let mut draft=configuration::open(&registry,fixture("open_code"),Scope::Global,"delete-empty".into()).unwrap();draft=configuration::edit(&registry,draft,action("create","alpha","slash/~victim",None,Some(json!({"limit":{"context":64000,"output":32},"modalities":{"input":["text"]}})))).unwrap();let saved=profile::save_registered_profile(&db,&registry,draft.profile,None).unwrap();let files=files(&registry,"open_code",temp.path());apply::apply_registered_validated(&registry,&db,&store,&saved,None,&files,"global",Scope::Global,false).unwrap();let file=&files[0];let mut original=disk(&files,"settings");original["provider"]["beta"]=json!({"models":{"valid-empty":{}}});original["agent"]=json!({"consumer":{"model":"alpha/slash/~victim"}});std::fs::write(&file.path,original.to_string()).unwrap();let mut draft=configuration::open(&registry,saved.clone(),Scope::Global,"delete-live".into()).unwrap();draft=configuration::edit(&registry,draft,action("delete","alpha","slash/~victim",None,None)).unwrap();let updated=profile::save_registered_profile(&db,&registry,draft.profile,Some(saved.version)).unwrap();let error=apply::apply_registered_validated(&registry,&db,&store,&updated,None,&files,"global",Scope::Global,false).unwrap_err();assert!(error.contains("角色"));assert_eq!(disk(&files,"settings"),original);
    original.as_object_mut().unwrap().remove("agent");std::fs::write(&file.path,original.to_string()).unwrap();apply::apply_registered_validated(&registry,&db,&store,&updated,None,&files,"global",Scope::Global,false).unwrap();let result=disk(&files,"settings");assert!(result["provider"]["alpha"]["models"].get("slash/~victim").is_none());assert_eq!(result["provider"]["beta"]["models"]["valid-empty"],json!({}));
}

// A common layer may inherit model definitions, but not a profile's default references.
fn suitable_common_files(tool: &str, files: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let registry = Registry::builtins();
    let adapter = registry.get(tool).unwrap();
    files.iter().map(|(role, text)| {
        let mut value = format::parse(adapter.file_kind(role).unwrap(), text).unwrap();
        if role == "settings" {
            let fields: &[&str] = match tool { "pi" => &["defaultProvider", "defaultModel"], "open_code" => &["model", "small_model"], _ => &["default_model"] };
            for field in fields { value.as_object_mut().unwrap().remove(*field); }
        }
        (role.clone(), format::render(adapter.file_kind(role).unwrap(), &value).unwrap())
    }).collect()
}

fn initialized(tool: &str) -> configuration::ConfigurationDraft {
    let registry = Registry::builtins();
    let mut draft = configuration::open(&registry, blank(tool), Scope::Global, format!("{tool}-a2")).unwrap();
    for provider in ["alpha", "beta"] {
        draft = configuration::edit(&registry, draft, action("configure_provider", provider, "", None,
            Some(json!({"baseUrl":format!("https://{provider}.example/v1"),"interfaceFormat":"openai_completions"})))).unwrap();
    }
    for id in ["safe", "slash/~victim"] {
        draft = configuration::edit(&registry, draft, action("create", "alpha", id, None, Some(create(tool, id)))).unwrap();
    }
    draft = configuration::edit(&registry, draft, action("default", "alpha", "safe", None, None)).unwrap();
    configuration::edit(&registry, draft, action("select_provider", "alpha", "", None, None)).unwrap()
}
fn save_reopen(registry: &Registry, db: &Database, draft: configuration::ConfigurationDraft) -> configuration::ConfigurationDraft {
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    let expected = (!draft.profile.id.is_empty()).then_some(draft.profile.version);
    let saved = profile::save_registered_profile(db, registry, draft.profile, expected).unwrap();
    let reopened = profile::get_registered_profile(db, &saved.id).unwrap();
    let draft = configuration::open(registry, reopened, Scope::Global, "a2-reopened".into()).unwrap();
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    draft
}
fn apply_draft(registry: &Registry, db: &Database, store: &Store, draft: &configuration::ConfigurationDraft, files: &[NativeFile]) {
    apply::apply_registered_validated(registry, db, store, &draft.profile, None, files, "global", Scope::Global, false).unwrap();
}
fn model<'a>(document: &'a Value, tool: &str, id: &str) -> Option<&'a Value> {
    match tool {
        "pi" => document["providers"]["alpha"]["models"].as_array()?.iter().find(|model| model["id"] == id),
        "open_code" => document["provider"]["alpha"]["models"].get(id),
        _ => document["models"].get(id),
    }
}
fn native_document(files: &[NativeFile], tool: &str) -> Value { disk(files, if tool == "pi" { "models" } else { "settings" }) }
fn replace_documents(registry: &Registry, draft: configuration::ConfigurationDraft, documents: BTreeMap<String, Value>) -> configuration::ConfigurationDraft {
    let adapter = registry.get(&draft.profile.tool).unwrap();
    let files = documents.into_iter().map(|(role, value)| {
        let text = format::render(adapter.file_kind(&role).unwrap(), &value).unwrap();
        (role, text)
    }).collect();
    configuration::replace_text(registry, draft, files)
}
fn remove_model(documents: &mut BTreeMap<String, Value>, tool: &str, id: &str) {
    match tool {
        "pi" => documents.get_mut("models").unwrap()["providers"]["alpha"]["models"].as_array_mut().unwrap().retain(|model| model["id"] != id),
        "open_code" => { documents.get_mut("settings").unwrap()["provider"]["alpha"]["models"].as_object_mut().unwrap().remove(id); },
        _ => { documents.get_mut("settings").unwrap()["models"].as_object_mut().unwrap().remove(id); },
    }
}

#[test]
fn multi_native_a2_browsing_keeps_credentials_and_management_while_identity_edits_rebind() {
    let registry = Registry::builtins();
    for tool in ["pi", "open_code", "kimi_code"] {
        let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
        let mut draft = initialized(tool);
        let credential = "connection-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        store.put(credential, "synthetic-a2-credential").unwrap();
        draft.profile.authentication = profile::ProfileAuthentication::ApiKey;
        draft.profile.connection.as_mut().unwrap().secret_ref = Some(credential.into());
        let mut draft = save_reopen(&registry, &db, draft); let files = files(&registry, tool, temp.path());
        apply_draft(&registry, &db, &store, &draft, &files);
        let before = native_document(&files, tool);
        for provider in ["beta", "alpha"] {
            draft = configuration::edit(&registry, draft, action("select_provider", provider, "", None, None)).unwrap();
            assert_eq!(draft.profile.connection.as_ref().unwrap().secret_ref.as_deref(), Some(credential));
            draft = save_reopen(&registry, &db, draft);
            apply_draft(&registry, &db, &store, &draft, &files);
            assert_eq!(native_document(&files, tool), before, "{tool} navigation changed native file");
            let binding = apply::get_registered_binding(&db, tool, "context:default:global").unwrap().unwrap();
            assert!(!binding.managed.values().flat_map(|fields| fields.keys()).any(|key| key.contains("/beta/")));
        }
        draft = configuration::edit(&registry, draft, action("configure_provider", "alpha", "", None,
            Some(json!({"baseUrl":"https://changed.example/v1","interfaceFormat":"openai_completions"})))).unwrap();
        assert!(draft.profile.connection.as_ref().unwrap().secret_ref.is_none());
    }
}

#[test]
fn multi_native_a2_reused_model_id_retires_delete_rename_and_reset_tombstones() {
    let registry = Registry::builtins();
    for tool in ["pi", "open_code", "kimi_code"] {
        let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
        let mut draft = initialized(tool);
        // Native extension containers must not leave a deleted entity's empty shell.
        if tool != "pi" {
            let mut raw = configuration::documents(&registry, &draft.profile).unwrap();
            if tool == "open_code" { raw.get_mut("settings").unwrap()["provider"]["alpha"]["models"]["slash/~victim"]["extension"] = json!({"nested":{"flag":"keep"}}); }
            else { raw.get_mut("settings").unwrap()["models"]["slash/~victim"]["extension"] = json!({"nested":{"flag":"keep"}}); }
            draft = replace_documents(&registry, draft, raw);
        }
        let mut draft = save_reopen(&registry, &db, draft); let files = files(&registry, tool, temp.path());
        apply_draft(&registry, &db, &store, &draft, &files);
        draft = configuration::edit(&registry, draft, action("delete", "alpha", "slash/~victim", None, None)).unwrap();
        draft = save_reopen(&registry, &db, draft);
        let mut fields = create(tool, "slash/~victim");
        match tool { "pi" => fields["contextWindow"] = json!(200000), "open_code" => fields["limit"]["context"] = json!(200000), _ => fields["max_context_size"] = json!(200000) }
        draft = configuration::edit(&registry, draft, action("create", "alpha", "slash/~victim", None, Some(fields))).unwrap();
        draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
        let document = native_document(&files, tool); let native = model(&document, tool, "slash/~victim").unwrap();
        let context = match tool { "pi" => &native["contextWindow"], "open_code" => &native["limit"]["context"], _ => &native["max_context_size"] };
        assert_eq!(context, &json!(200000));
        draft = configuration::edit(&registry, draft, action("rename", "alpha", "slash/~victim", None, Some(json!("renamed")))).unwrap();
        draft = configuration::edit(&registry, draft, action("copy", "alpha", "safe", None, Some(json!("slash/~victim")))).unwrap();
        draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
        let document = native_document(&files, tool);
        assert!(model(&document, tool, "slash/~victim").is_some()); assert!(model(&document, tool, "renamed").is_some());
        draft = configuration::edit(&registry, draft, action("delete", "alpha", "slash/~victim", None, None)).unwrap();
        draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
        assert!(model(&native_document(&files, tool), tool, "slash/~victim").is_none());
    }
    let tool = "pi"; let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
    let mut draft = initialized(tool); let mut create_override = action("create_override", "alpha", "builtin/~id", None, Some(json!({"contextWindow":1000,"thinkingLevelMap":{"high":"high"}})));
    create_override.target["kind"] = json!("override");
    draft = configuration::edit(&registry, draft, create_override.clone()).unwrap();
    draft = save_reopen(&registry, &db, draft); let files = files(&registry, tool, temp.path()); apply_draft(&registry, &db, &store, &draft, &files);
    let mut delete = action("delete", "alpha", "builtin/~id", None, None); delete.target["kind"] = json!("override");
    draft = configuration::edit(&registry, draft, delete).unwrap();
    create_override.value = Some(json!({"contextWindow":2000}));
    draft = configuration::edit(&registry, draft, create_override).unwrap();
    draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
    assert_eq!(disk(&files, "models")["providers"]["alpha"]["modelOverrides"]["builtin/~id"]["contextWindow"], 2000);
    let mut delete = action("delete", "alpha", "builtin/~id", None, None); delete.target["kind"] = json!("override");
    draft = configuration::edit(&registry, draft, delete).unwrap();
    draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
    assert!(disk(&files, "models")["providers"]["alpha"]["modelOverrides"].get("builtin/~id").is_none());
}

#[test]
fn multi_native_a2_raw_delete_is_explicit_and_checks_current_native_cas_and_default_refs() {
    let registry = Registry::builtins();
    for tool in ["pi", "open_code", "kimi_code"] {
        let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
        let draft = save_reopen(&registry, &db, initialized(tool)); let files = files(&registry, tool, temp.path());
        apply_draft(&registry, &db, &store, &draft, &files);
        let mut raw = configuration::documents(&registry, &draft.profile).unwrap(); remove_model(&mut raw, tool, "slash/~victim");
        let mut deleted = replace_documents(&registry, draft, raw);
        assert!(deleted.profile.editing.as_ref().unwrap().intents.iter().any(|action| action.operation == "delete"));
        deleted = save_reopen(&registry, &db, deleted);
        let native_file = files.iter().find(|file| file.role == if tool == "pi" {"models"} else {"settings"}).unwrap();
        let original = std::fs::read_to_string(&native_file.path).unwrap();
        let external = original.replace("request-slash/~victim", "external-request").replace("64000", "65000");
        std::fs::write(&native_file.path, &external).unwrap();
        let error = apply::apply_registered_validated(&registry, &db, &store, &deleted.profile, None, &files, "global", Scope::Global, false).unwrap_err();
        assert!(error.contains("外部修改"), "{tool}: {error}"); assert_eq!(std::fs::read_to_string(&native_file.path).unwrap(), external);
        std::fs::write(&native_file.path, original).unwrap(); apply_draft(&registry, &db, &store, &deleted, &files);
        let document = native_document(&files, tool); assert!(model(&document, tool, "slash/~victim").is_none()); assert!(model(&document, tool, "safe").is_some());
        let mut raw = configuration::documents(&registry, &deleted.profile).unwrap(); remove_model(&mut raw, tool, "safe");
        let invalid = replace_documents(&registry, deleted.clone(), raw);
        assert!(!invalid.issues.is_empty(), "{tool} dangling default accepted");
        assert!(profile::save_registered_profile(&db, &registry, invalid.profile, Some(deleted.profile.version)).is_err());
    }
}

#[test]
fn multi_native_a2_kimi_default_reassociation_and_nondefault_recovery_survive_saved_apply() {
    let registry = Registry::builtins();
    for raw_mode in [false, true] {
        let tool = "kimi_code"; let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
        let mut draft = initialized(tool);
        draft = configuration::edit(&registry, draft, action("default", "alpha", "slash/~victim", None, None)).unwrap();
        draft = save_reopen(&registry, &db, draft); let files = files(&registry, tool, temp.path()); apply_draft(&registry, &db, &store, &draft, &files);
        let mut moved = if raw_mode {
            let mut raw = configuration::documents(&registry, &draft.profile).unwrap(); raw.get_mut("settings").unwrap()["models"]["slash/~victim"]["provider"] = json!("beta");
            replace_documents(&registry, draft, raw)
        } else { configuration::edit(&registry, draft, action("set", "alpha", "slash/~victim", Some("provider"), Some(json!("beta")))).unwrap() };
        assert_eq!(moved.profile.connection.as_ref().unwrap().provider_id, "beta");
        moved = save_reopen(&registry, &db, moved); apply_draft(&registry, &db, &store, &moved, &files);
        let native = disk(&files, "settings"); assert_eq!(native["default_model"], "slash/~victim"); assert_eq!(native["models"]["slash/~victim"]["provider"], "beta");
        assert!(native["providers"].get("beta").is_some()); assert_eq!(native["models"]["safe"]["provider"], "alpha");
        let mut raw = configuration::documents(&registry, &moved.profile).unwrap(); raw.get_mut("settings").unwrap()["models"]["safe"]["provider"] = json!("beta");
        // This reassociation is now valid because beta is the active default supplier.
        let migrated = save_reopen(&registry, &db, replace_documents(&registry, moved, raw));
        let before = std::fs::read_to_string(&files[0].path).unwrap();
        let error = apply::apply_registered_validated(&registry, &db, &store, &migrated.profile, None, &files, "global", Scope::Global, false).unwrap_err();
        assert!(error.contains("接管"), "{error}");
        assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), before);
        apply::apply_registered_validated(&registry, &db, &store, &migrated.profile, None, &files, "global", Scope::Global, true).unwrap();
        assert_eq!(disk(&files, "settings")["models"]["safe"]["provider"], "beta");
    }
    for raw_mode in [false, true] {
        let tool = "kimi_code"; let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
        let draft = save_reopen(&registry, &db, initialized(tool));
        let mut invalid = if raw_mode { let mut raw = configuration::documents(&registry, &draft.profile).unwrap(); raw.get_mut("settings").unwrap()["models"]["slash/~victim"]["provider"] = json!("beta"); replace_documents(&registry, draft, raw) }
            else { configuration::edit(&registry, draft, action("set", "alpha", "slash/~victim", Some("provider"), Some(json!("beta")))).unwrap() };
        assert!(invalid.issues.iter().any(|issue| issue.field.as_deref() == Some("provider")));
        let same_raw = invalid.profile.files.clone(); invalid = configuration::replace_text(&registry, invalid, same_raw);
        assert!(invalid.issues.iter().any(|issue| issue.field.as_deref() == Some("provider")));
        assert!(profile::save_registered_profile(&db, &registry, invalid.profile.clone(), Some(invalid.profile.version)).is_err());
        invalid = configuration::edit(&registry, invalid, action("default", "beta", "slash/~victim", None, None)).unwrap();
        let migrated = save_reopen(&registry, &db, invalid); let store = Store::default(); let files = files(&registry, tool, temp.path());
        apply_draft(&registry, &db, &store, &migrated, &files);
        assert_eq!(disk(&files, "settings")["models"]["slash/~victim"]["provider"], "beta");
    }
}

#[test]
fn multi_native_a2_pi_thinking_map_validates_native_known_keys_and_preserves_extensions() {
    let registry = Registry::builtins(); let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let draft = initialized("pi");
    for level in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
        for value in [json!(42), json!(true), json!([]), json!({})] {
            let invalid = configuration::edit(&registry, draft.clone(), action("set", "alpha", "safe", Some("thinkingLevelMap"), Some(json!({level:value})))).unwrap();
            assert!(invalid.issues.iter().any(|issue| issue.field.as_deref() == Some("thinkingLevelMap")), "{level}");
            assert!(profile::save_registered_profile(&db, &registry, invalid.profile, None).is_err());
        }
    }
    let valid = configuration::edit(&registry, draft, action("set", "alpha", "safe", Some("thinkingLevelMap"), Some(json!({"high":"native-high","off":null,"future_extension":42})))).unwrap();
    let valid = save_reopen(&registry, &db, valid); let store = Store::default(); let files = files(&registry, "pi", temp.path()); apply_draft(&registry, &db, &store, &valid, &files);
    assert_eq!(model(&disk(&files, "models"), "pi", "safe").unwrap()["thinkingLevelMap"]["future_extension"], 42);
}

#[test]
fn multi_native_a2_kimi_capabilities_reject_new_unknowns_even_when_ipc_baseline_is_forged() {
    let registry = Registry::builtins(); let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let mut draft = initialized("kimi_code");
    let supported = json!(["image_in","video_in","audio_in","thinking","always_thinking","tool_use","dynamically_loaded_tools"]);
    let descriptor = registry.get("kimi_code").unwrap().configuration().unwrap().describe(Scope::Global);
    let field = descriptor.fields.iter().find(|field| field.id == "capabilities").unwrap(); assert_eq!(field.kind, "string_list"); assert!(!field.advanced); assert_eq!(json!(field.choices), supported);
    draft = configuration::edit(&registry, draft, action("set", "alpha", "safe", Some("capabilities"), Some(supported.clone()))).unwrap();
    let draft = save_reopen(&registry, &db, draft); let store = Store::default(); let files = files(&registry, "kimi_code", temp.path()); apply_draft(&registry, &db, &store, &draft, &files);
    assert_eq!(disk(&files, "settings")["models"]["safe"]["capabilities"], supported);
    let invalid = configuration::edit(&registry, draft.clone(), action("set", "alpha", "safe", Some("capabilities"), Some(json!(["text","image"])))).unwrap();
    assert!(invalid.issues.iter().any(|issue| issue.field.as_deref() == Some("capabilities")));
    assert!(profile::save_registered_profile(&db, &registry, invalid.profile.clone(), Some(invalid.profile.version)).is_err());
    let mut raw = configuration::documents(&registry, &draft.profile).unwrap(); raw.get_mut("settings").unwrap()["models"]["safe"]["capabilities"] = json!(["future_new"]);
    let mut invalid = replace_documents(&registry, draft, raw); assert!(invalid.issues.iter().any(|issue| issue.field.as_deref() == Some("capabilities")));
    // An IPC caller cannot grant itself preservation by changing its draft baseline or metadata.
    invalid.baseline_files = invalid.profile.files.clone(); invalid = configuration::refresh(&registry, invalid); assert!(invalid.issues.is_empty());
    let mut forged = serde_json::to_value(&invalid.profile).unwrap(); forged["editing"]["preservedValues"] = json!({"/models/safe/capabilities":["future_new"]});
    let forged: RegisteredProfile = serde_json::from_value(forged).unwrap();
    assert!(profile::save_registered_profile(&db, &registry, forged.clone(), Some(forged.version)).is_err());
    let mut forged_new = forged; forged_new.id.clear(); forged_new.version = 0; forged_new.revision.clear();
    assert!(profile::save_registered_profile(&db, &registry, forged_new, None).is_err());
    assert!(apply::apply_registered_validated(&registry, &db, &store, &invalid.profile, None, &files, "global", Scope::Global, false).is_err());
    assert_eq!(disk(&files, "settings")["models"]["safe"]["capabilities"], supported);
}

#[test]
fn multi_native_a2_kimi_legacy_unknown_capabilities_copy_rename_and_portable_remain_intact() {
    let registry = Registry::builtins(); let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
    let draft = save_reopen(&registry, &db, initialized("kimi_code"));
    // Seed a preexisting DB record, representing a legacy/native extension accepted before this editor.
    let mut legacy = draft.profile; let mut raw = configuration::documents(&registry, &legacy).unwrap();
    raw.get_mut("settings").unwrap()["models"]["safe"]["capabilities"] = json!(["future_native","thinking"]);
    legacy.files.insert("settings".into(), format::render(FileKind::Toml, &raw["settings"]).unwrap());
    db.with_connection(|conn| conn.execute("UPDATE native_profiles SET data=?1 WHERE id=?2", rusqlite::params![serde_json::to_string(&legacy).unwrap(), legacy.id]).map(|_|()).map_err(|error| error.to_string())).unwrap();
    let mut draft = configuration::open(&registry, profile::get_registered_profile(&db, &legacy.id).unwrap(), Scope::Global, "legacy".into()).unwrap(); assert!(draft.issues.is_empty());
    draft = configuration::edit(&registry, draft, action("set", "alpha", "safe", Some("capabilities"), Some(json!(["future_native","thinking","image_in"])))).unwrap();
    draft = configuration::edit(&registry, draft, action("copy", "alpha", "safe", None, Some(json!("copied")))).unwrap();
    draft = configuration::edit(&registry, draft, action("rename", "alpha", "copied", None, Some(json!("renamed")))).unwrap();
    let same_raw = draft.profile.files.clone(); draft = configuration::replace_text(&registry, draft, same_raw);
    draft = save_reopen(&registry, &db, draft); let files = files(&registry, "kimi_code", temp.path()); apply_draft(&registry, &db, &store, &draft, &files);
    assert_eq!(disk(&files, "settings")["models"]["renamed"]["capabilities"], json!(["future_native","thinking","image_in"]));
    let target = Database::open(&temp.path().join("target")).unwrap(); let snapshot = crate::portable::collect_snapshot(&db, &store, &registry).unwrap();
    let preview = crate::portable::preview_import(&target, &store, &registry, snapshot).unwrap();
    crate::portable::apply_import(&target, &store, &registry, &preview, &std::collections::BTreeSet::from([format!("profile:{}", draft.profile.id)])).unwrap();
    let imported = profile::get_registered_profile(&target, &draft.profile.id).unwrap();
    let imported = save_reopen(&registry, &target, configuration::open(&registry, imported, Scope::Global, "portable-legacy".into()).unwrap());
    let native = temp.path().join("portable-native"); std::fs::create_dir_all(&native).unwrap(); let imported_files = self::files(&registry, "kimi_code", &native);
    apply_draft(&registry, &target, &store, &imported, &imported_files);
    assert_eq!(disk(&imported_files, "settings")["models"]["renamed"]["capabilities"], json!(["future_native","thinking","image_in"]));
}

#[test]
fn multi_native_a2_raw_removal_suppresses_inherited_entities_without_changing_common() {
    let registry = Registry::builtins();
    for tool in ["pi", "open_code", "kimi_code"] {
        let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
        let mut draft = initialized(tool);
        let common = profile::save_registered_common(&db, &registry, RegisteredCommon {
            tool: tool.into(), version: 0, revision: String::new(), files: suitable_common_files(tool, &draft.profile.files),
        }, None).unwrap();
        draft.profile.inherit_common = true;
        draft = configuration::open_with_common(&registry, draft.profile, Some(common.clone()), Scope::Global, "a2-inherited".into()).unwrap();
        let saved = profile::save_registered_profile(&db, &registry, draft.profile, None).unwrap(); let files = files(&registry, tool, temp.path());
        apply::apply_registered_validated(&registry, &db, &store, &saved, Some(&common), &files, "global", Scope::Global, false).unwrap();
        let mut draft = configuration::open_with_common(&registry, saved, Some(common.clone()), Scope::Global, "a2-inherited-raw".into()).unwrap();
        let mut raw = configuration::documents(&registry, &draft.profile).unwrap(); remove_model(&mut raw, tool, "slash/~victim");
        draft = replace_documents(&registry, draft, raw); assert!(draft.issues.is_empty(), "{tool}: {:?}", draft.issues);
        let saved = profile::save_registered_profile(&db, &registry, draft.profile.clone(), Some(draft.profile.version)).unwrap();
        let reopened = configuration::open_with_common(&registry, profile::get_registered_profile(&db, &saved.id).unwrap(), Some(common.clone()), Scope::Global, "a2-inherited-reopen".into()).unwrap();
        assert!(reopened.issues.is_empty());
        let effective = configuration::effective_documents(&registry, &reopened.profile, Some(&common)).unwrap();
        assert!(model(&effective[if tool == "pi" {"models"} else {"settings"}], tool, "slash/~victim").is_none());
        apply::apply_registered_validated(&registry, &db, &store, &saved, Some(&common), &files, "global", Scope::Global, false).unwrap();
        assert!(model(&native_document(&files, tool), tool, "slash/~victim").is_none());
        assert_eq!(profile::get_registered_common(&db, tool).unwrap().unwrap().files, common.files);
    }
}

#[test]
fn multi_native_a2_kimi_common_unknowns_use_authoritative_db_baselines_and_inherit_safely() {
    let registry = Registry::builtins(); let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap();
    let initial = initialized("kimi_code");
    let mut common = profile::save_registered_common(&db, &registry, RegisteredCommon {
        tool: "kimi_code".into(), version: 0, revision: String::new(), files: suitable_common_files("kimi_code", &initial.profile.files),
    }, None).unwrap();
    let mut value = format::parse(FileKind::Toml, &common.files["settings"]).unwrap(); value["models"]["safe"]["capabilities"] = json!(["future_common","thinking"]);
    common.files.insert("settings".into(), format::render(FileKind::Toml, &value).unwrap());
    db.with_connection(|conn| conn.execute("UPDATE common_configs SET data=?1 WHERE tool=?2", rusqlite::params![serde_json::to_string(&common).unwrap(), common.tool]).map(|_|()).map_err(|error| error.to_string())).unwrap();
    let mut retained = common.clone(); value["models"]["safe"]["capabilities"] = json!(["future_common","thinking","image_in"]);
    retained.files.insert("settings".into(), format::render(FileKind::Toml, &value).unwrap());
    common = profile::save_registered_common(&db, &registry, retained, Some(common.version)).unwrap();
    let mut invalid = common.clone(); value["models"]["safe"]["capabilities"] = json!(["future_common","future_new"]);
    invalid.files.insert("settings".into(), format::render(FileKind::Toml, &value).unwrap());
    assert!(profile::save_registered_common(&db, &registry, invalid, Some(common.version)).is_err());
    assert_eq!(profile::get_registered_common(&db, "kimi_code").unwrap().unwrap().files, common.files);
    let mut source = blank("kimi_code"); source.inherit_common = true; source.files.insert("settings".into(), "default_model = \"safe\"\n".into());
    let mut draft = configuration::open_with_common(&registry, source, Some(common.clone()), Scope::Global, "inherited-unknown".into()).unwrap();
    draft = configuration::edit(&registry, draft, action("set", "alpha", "safe", Some("capabilities"), Some(json!(["future_common","thinking","image_in","tool_use"])))).unwrap();
    assert!(draft.issues.is_empty()); let saved = profile::save_registered_profile(&db, &registry, draft.profile, None).unwrap();
    let reopened = configuration::open_with_common(&registry, saved.clone(), Some(common.clone()), Scope::Global, "inherited-unknown-reopen".into()).unwrap(); assert!(reopened.issues.is_empty());
    let files = files(&registry, "kimi_code", temp.path()); let store = Store::default();
    apply::apply_registered_validated(&registry, &db, &store, &saved, Some(&common), &files, "global", Scope::Global, false).unwrap();
    assert_eq!(disk(&files, "settings")["models"]["safe"]["capabilities"], json!(["future_common","thinking","image_in","tool_use"]));
}

fn save_reopen_with_common(
    registry: &Registry,
    db: &Database,
    draft: configuration::ConfigurationDraft,
    common: Option<&RegisteredCommon>,
) -> configuration::ConfigurationDraft {
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    let expected = (!draft.profile.id.is_empty()).then_some(draft.profile.version);
    let saved = profile::save_registered_profile(db, registry, draft.profile, expected).unwrap();
    let draft = configuration::open_with_common(registry,
        profile::get_registered_profile(db, &saved.id).unwrap(), common.cloned(),
        Scope::Global, "a3-reopened".into()).unwrap();
    assert!(draft.issues.is_empty(), "{:?}", draft.issues);
    draft
}

#[test]
fn multi_native_a3_opencode_navigation_view_targets_the_browsed_provider_and_keeps_default_ownership() {
    let registry = Registry::builtins(); let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
    let mut draft = initialized("open_code");
    draft = configuration::edit(&registry, draft, action("create", "beta", "safe", None,
        Some(json!({"name":"Beta safe","limit":{"context":100000,"output":1000}})))).unwrap();
    draft = configuration::edit(&registry, draft, action("small_default", "alpha", "safe", None, None)).unwrap();
    let credential = "connection-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.put(credential, "synthetic-a3-alpha-key").unwrap();
    draft.profile.authentication = profile::ProfileAuthentication::ApiKey;
    draft.profile.connection.as_mut().unwrap().secret_ref = Some(credential.into());
    let mut draft = save_reopen(&registry, &db, draft); let files = files(&registry, "open_code", temp.path());
    apply_draft(&registry, &db, &store, &draft, &files);
    let mut native = disk(&files, "settings");
    native["provider"]["beta"] = json!({"npm":"@ai-sdk/openai-compatible",
        "options":{"baseURL":"https://native-beta.example/v1","apiKey":"synthetic-foreign-beta-key"},
        "models":{"foreign":{"name":"foreign-native-model"}},"user_empty":{}});
    std::fs::write(&files[0].path, format::render(FileKind::Jsonc, &native).unwrap()).unwrap();
    for operation in ["select_provider", "configure_provider"] {
        draft = configuration::edit(&registry, draft, action(operation, "beta", "", None,
            (operation == "configure_provider").then(|| json!({"baseUrl":"https://configured-beta.example/v1","interfaceFormat":"openai_responses"})))).unwrap();
        assert_eq!(draft.view["providerId"], "beta", "{operation}");
        assert_eq!(draft.view["models"][0]["fields"]["name"], "Beta safe");
        assert!(draft.view["defaultModel"].is_null()); assert!(draft.view["smallModel"].is_null());
        assert_eq!(draft.view["connection"]["baseUrl"], if operation == "select_provider" { "https://beta.example/v1" } else { "https://configured-beta.example/v1" });
        assert_eq!(draft.profile.connection.as_ref().unwrap().provider_id, "alpha");
        assert_eq!(draft.profile.connection.as_ref().unwrap().secret_ref.as_deref(), Some(credential));
        let id = format!("{operation}/~created");
        // The frontend constructs each model action from read.providerId.
        let target_provider = draft.view["providerId"].as_str().unwrap().to_owned();
        draft = configuration::edit(&registry, draft, action("create", &target_provider, &id, None,
            Some(json!({"name":"new beta model","limit":{"context":32000}})))).unwrap();
        draft = configuration::edit(&registry, draft, action("set", &target_provider, &id, Some("limit.context"), Some(json!(222222)))).unwrap();
        let documents = configuration::documents(&registry, &draft.profile).unwrap();
        assert_eq!(documents["settings"]["provider"]["beta"]["models"][&id]["limit"]["context"], 222222);
        assert!(documents["settings"]["provider"]["alpha"]["models"].get(&id).is_none());
        draft = save_reopen(&registry, &db, draft);
        assert_eq!(draft.view["providerId"], "beta");
        apply_draft(&registry, &db, &store, &draft, &files);
        assert_eq!(disk(&files, "settings"), native, "navigation adopted foreign beta native values");
        let binding = apply::get_registered_binding(&db, "open_code", "context:default:global").unwrap().unwrap();
        assert!(!binding.managed["settings"].keys().any(|path| path.starts_with("/provider/beta/")));
        draft = configuration::edit(&registry, draft, action("select_provider", "alpha", "", None, None)).unwrap();
        assert_eq!(draft.view["providerId"], "alpha"); assert_eq!(draft.view["defaultModel"], "safe"); assert_eq!(draft.view["smallModel"], "safe");
        assert_eq!(draft.profile.connection.as_ref().unwrap().secret_ref.as_deref(), Some(credential));
        draft = save_reopen(&registry, &db, draft); apply_draft(&registry, &db, &store, &draft, &files);
        assert_eq!(disk(&files, "settings"), native);
    }
}

#[test]
fn multi_native_a3_opencode_reuses_deleted_and_renamed_ids_for_default_and_small_model_after_reopen() {
    let registry = Registry::builtins();
    for prior_operation in ["delete", "rename"] {
        for reuse in ["copy", "rename"] {
            for inherit in [false, true] {
                let temp = tempfile::tempdir().unwrap(); let db = Database::open(&temp.path().join("db")).unwrap(); let store = Store::default();
                let mut draft = initialized("open_code");
                draft = configuration::edit(&registry, draft, action("small_default", "alpha", "safe", None, None)).unwrap();
                let common = if inherit { Some(profile::save_registered_common(&db, &registry, RegisteredCommon {
                    tool: "open_code".into(), version: 0, revision: String::new(), files: suitable_common_files("open_code", &draft.profile.files),
                }, None).unwrap()) } else { None };
                draft.profile.inherit_common = inherit;
                draft = configuration::open_with_common(&registry, draft.profile, common.clone(), Scope::Global, "a3-id-reuse".into()).unwrap();
                draft = save_reopen_with_common(&registry, &db, draft, common.as_ref());
                let files = files(&registry, "open_code", temp.path());
                apply::apply_registered_validated(&registry, &db, &store, &draft.profile, common.as_ref(), &files, "global", Scope::Global, false).unwrap();
                draft = configuration::edit(&registry, draft, action("reset", "alpha", "slash/~victim", Some("limit.context"), None)).unwrap();
                draft = configuration::edit(&registry, draft, action(prior_operation, "alpha", "slash/~victim", None,
                    (prior_operation == "rename").then(|| json!("released")))).unwrap();
                draft = save_reopen_with_common(&registry, &db, draft, common.as_ref());
                draft = configuration::edit(&registry, draft, action(reuse, "alpha", "safe", None, Some(json!("slash/~victim")))).unwrap();
                draft = configuration::edit(&registry, draft, action("default", "alpha", "slash/~victim", None, None)).unwrap();
                draft = configuration::edit(&registry, draft, action("small_default", "alpha", "slash/~victim", None, None)).unwrap();
                assert!(draft.issues.is_empty(), "{prior_operation}/{reuse}/{inherit}: {:?}", draft.issues);
                assert!(!draft.profile.editing.as_ref().unwrap().intents.iter().any(|action|
                    action.target["id"] == "slash/~victim" && matches!(action.operation.as_str(), "delete" | "rename" | "reset")));
                assert!(!draft.profile.suppressed.values().flatten().any(|path| path == "/provider/alpha/models/slash~1~0victim"));
                if reuse == "rename" { assert!(draft.profile.suppressed["settings"].contains(&"/provider/alpha/models/safe".into())); }
                draft = save_reopen_with_common(&registry, &db, draft, common.as_ref());
                assert_eq!(draft.view["defaultModel"], "slash/~victim"); assert_eq!(draft.view["smallModel"], "slash/~victim");
                let original = std::fs::read_to_string(&files[0].path).unwrap();
                let mut external = disk(&files, "settings"); external["provider"]["alpha"]["models"]["slash/~victim"]["limit"]["context"] = json!(999999);
                let external = format::render(FileKind::Jsonc, &external).unwrap(); std::fs::write(&files[0].path, &external).unwrap();
                let error = apply::apply_registered_validated(&registry, &db, &store, &draft.profile, common.as_ref(), &files, "global", Scope::Global, false).unwrap_err();
                assert!(error.contains("外部修改"), "{error}"); assert_eq!(std::fs::read_to_string(&files[0].path).unwrap(), external);
                std::fs::write(&files[0].path, original).unwrap();
                apply::apply_registered_validated(&registry, &db, &store, &draft.profile, common.as_ref(), &files, "global", Scope::Global, false).unwrap();
                let native = disk(&files, "settings"); assert_eq!(native["model"], "alpha/slash/~victim"); assert_eq!(native["small_model"], "alpha/slash/~victim");
                assert_eq!(native["provider"]["alpha"]["models"]["slash/~victim"]["limit"]["context"], 64000);
                assert_eq!(native["provider"]["alpha"]["models"].get("safe").is_some(), reuse == "copy");
                assert_eq!(native["provider"]["alpha"]["models"].get("released").is_some(), prior_operation == "rename");
                assert!(configuration::edit(&registry, draft.clone(), action("delete", "alpha", "slash/~victim", None, None)).is_err());
                // Returning both references to safe permits a genuine deletion of the reused identity.
                let mut draft = if reuse == "rename" { configuration::edit(&registry, draft, action("copy", "alpha", "slash/~victim", None, Some(json!("safe")))).unwrap() } else { draft };
                for operation in ["default", "small_default"] { draft = configuration::edit(&registry, draft, action(operation, "alpha", "safe", None, None)).unwrap(); }
                draft = configuration::edit(&registry, draft, action("delete", "alpha", "slash/~victim", None, None)).unwrap();
                draft = save_reopen_with_common(&registry, &db, draft, common.as_ref());
                apply::apply_registered_validated(&registry, &db, &store, &draft.profile, common.as_ref(), &files, "global", Scope::Global, false).unwrap();
                assert!(disk(&files, "settings")["provider"]["alpha"]["models"].get("slash/~victim").is_none());
            }
        }
    }
}
