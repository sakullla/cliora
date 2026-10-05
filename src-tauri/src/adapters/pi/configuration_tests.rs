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
