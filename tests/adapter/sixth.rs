use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;
use crate::native::adapter;

struct Sixth;
static SIXTH: Sixth = Sixth;

impl CliAdapter for Sixth {
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
    std::fs::write(path, "{\"untouched\":true,\"model\":\"old\"}\n").unwrap();
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
            }),
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
