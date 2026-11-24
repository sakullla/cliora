//! OMP configuration regressions. Native semantics are asserted through the
//! same registry and adapter the application uses; real CLI evidence lives in
//! `docs/verification/omp-configuration.md` and the shared native verifier.

use super::*;
use crate::adapters::configuration::{ConfigurationAdapter, Documents, EditingState};
use crate::native::profile::{Connection, ProfileAuthentication, RegisteredProfile};
use serde_json::json;
use std::collections::BTreeMap;

const CONFIG: &str = include_str!("../../../../tests/fixtures/native/omp-18.20.2-config.yml");
const MODELS: &str = include_str!("../../../../tests/fixtures/native/omp-18.20.2-models.yml");

#[test]
fn resolver_error_has_no_default_fallback_target() {
    let home = Path::new("/home/omp-user");
    assert!(native_global_directory(home, Err("invalid".into())).is_none());
    let directory = native_global_directory(
        home,
        Ok(ResolvedRoot {
            kind: "default",
            root: home.join("explicit/agent"),
        }),
    )
    .unwrap();
    assert_eq!(directory, home.join("explicit/agent"));
}

fn documents() -> Documents {
    BTreeMap::from([
        (
            SETTINGS_ROLE.into(),
            format::parse(FileKind::Yaml, CONFIG).unwrap(),
        ),
        (
            MODELS_ROLE.into(),
            format::parse(FileKind::Yaml, MODELS).unwrap(),
        ),
    ])
}

fn profile() -> RegisteredProfile {
    RegisteredProfile {
        editing: Some(EditingState::default()),
        id: "omp-profile".into(),
        tool: "omp".into(),
        name: "工作".into(),
        version: 1,
        revision: "r1".into(),
        inherit_common: false,
        files: BTreeMap::from([
            (SETTINGS_ROLE.into(), CONFIG.into()),
            (MODELS_ROLE.into(), MODELS.into()),
        ]),
        suppressed: BTreeMap::new(),
        authentication: ProfileAuthentication::Native,
        connection: None,
        native_credentials: BTreeMap::new(),
    }
}

fn action(target: Value, operation: &str, field: Option<&str>, value: Option<Value>) -> ConfigurationAction {
    ConfigurationAction {
        version: EDITING_VERSION,
        target,
        operation: operation.into(),
        field: field.map(str::to_owned),
        value,
    }
}

fn rendered(documents: &Documents, role: &str) -> Value {
    format::parse(
        FileKind::Yaml,
        &format::render(FileKind::Yaml, &documents[role]).unwrap(),
    )
    .unwrap()
}

#[test]
fn default_named_and_project_roots_stay_isolated() {
    let home = Path::new("/home/omp-user");
    let default = resolve_root(&ResolutionInput {
        home,
        profile: None,
        config_dir: None,
        coding_agent_dir: None,
    })
    .unwrap();
    assert_eq!(default.kind, "default");
    assert_eq!(default.root, home.join(".omp/agent"));

    // OMP 18.20.2 treats trimmed empty values and literal `default` as the
    // default profile.
    for value in ["", "   ", "default", " default "] {
        let outcome = resolve_agent_root(home, Some(value), None, None, None).unwrap();
        assert_eq!(outcome.kind, "default", "{value:?}");
        assert_eq!(outcome.root, home.join(".omp/agent"), "{value:?}");
    }
    // An explicitly present empty OMP_PROFILE must not fall back to PI_PROFILE.
    assert_eq!(select_profile(Some(""), Some("work")), Some(""));
    let explicit_empty = resolve_agent_root(home, Some(""), Some("work"), None, None).unwrap();
    assert_eq!(explicit_empty.kind, "default");
    assert_eq!(explicit_empty.root, home.join(".omp/agent"));

    // PI_CODING_AGENT_DIR relocates only the default profile.
    let absolute_agent = std::env::temp_dir().join("omp-agent");
    let relocated = resolve_root(&ResolutionInput {
        home,
        profile: None,
        config_dir: None,
        coding_agent_dir: Some(&absolute_agent),
    })
    .unwrap();
    assert_eq!(relocated.root, absolute_agent);

    // Accounts and MCP pass the raw OMP/PI profile values through the same
    // resolver; a fallback profile is trimmed and a named profile ignores the
    // default-only coding directory.
    let shared = resolve_agent_root(
        home,
        None,
        Some(" work "),
        Some(Path::new("custom-config")),
        Some(&absolute_agent),
    )
    .unwrap();
    assert_eq!(shared.kind, "profile");
    assert_eq!(shared.root, home.join("custom-config/profiles/work/agent"));

    let named = resolve_root(&ResolutionInput {
        home,
        profile: Some("work"),
        config_dir: Some(Path::new("custom-config")),
        coding_agent_dir: Some(&absolute_agent),
    })
    .unwrap();
    assert_eq!(named.kind, "profile");
    assert_eq!(
        named.root,
        home.join("custom-config/profiles/work/agent")
    );

    let configured = resolve_root(&ResolutionInput {
        home,
        profile: None,
        config_dir: Some(Path::new("custom-config")),
        coding_agent_dir: None,
    })
    .unwrap();
    assert_eq!(configured.root, home.join("custom-config/agent"));

    let max_name = "a".repeat(64);
    for valid in ["a", "a.b_c-d", max_name.as_str()] {
        assert!(
            resolve_root(&ResolutionInput {
                home,
                profile: Some(valid),
                config_dir: None,
                coding_agent_dir: None,
            })
            .is_ok(),
            "{valid:?} 必须被接受"
        );
    }
    let too_long = "a".repeat(65);
    for invalid in [
        ".",
        "..",
        "../work",
        "work/name",
        "a\\b",
        "Work",
        "work.",
        "work name",
        "con",
        "CON.txt",
        "com0",
        "com1",
        "lpt0",
        "-work",
        "_work",
        too_long.as_str(),
    ] {
        assert!(
            resolve_root(&ResolutionInput {
                home,
                profile: Some(invalid),
                config_dir: None,
                coding_agent_dir: None,
            })
            .is_err(),
            "{invalid:?} 必须被拒绝"
        );
    }
    for blank in ["", "   "] {
        let outcome = resolve_root(&ResolutionInput {
            home,
            profile: None,
            config_dir: Some(Path::new(blank)),
            coding_agent_dir: None,
        })
        .unwrap();
        assert_eq!(outcome.root, home.join(".omp/agent"), "{blank:?}");
    }
    for relative in ["relative-agent", "../agent"] {
        assert!(
            resolve_root(&ResolutionInput {
                home,
                profile: None,
                config_dir: None,
                coding_agent_dir: Some(Path::new(relative)),
            })
            .is_err(),
            "PI_CODING_AGENT_DIR {relative:?} 必须被拒绝"
        );
        let named = resolve_agent_root(
            home,
            Some("work"),
            None,
            None,
            Some(Path::new(relative)),
        )
        .unwrap();
        assert_eq!(named.kind, "profile");
        assert_eq!(named.root, home.join(".omp/profiles/work/agent"));
    }
    #[cfg(windows)]
    for root_relative in ["\\foo", "/foo"] {
        assert!(
            resolve_root(&ResolutionInput {
                home,
                profile: None,
                config_dir: None,
                coding_agent_dir: Some(Path::new(root_relative)),
            })
            .is_err(),
            "Windows root-relative {root_relative:?} 必须被拒绝"
        );
    }
}

#[test]
fn config_directory_validation_is_platform_independent() {
    let home = Path::new("/home/omp-user");
    for profile in [None, Some("work")] {
        for invalid in [
            "/absolute",
            "../outside",
            "nested/../../outside",
            r"C:\absolute",
            "C:/absolute",
            r"c:relative",
            r"\rooted",
            r"\\server\share",
            r"\\?\C:\absolute",
            r"..\outside",
            r"nested\..\..\outside",
            r"nested/..\outside",
        ] {
            assert!(
                resolve_root(&ResolutionInput {
                    home,
                    profile,
                    config_dir: Some(Path::new(invalid)),
                    coding_agent_dir: None,
                })
                .is_err(),
                "PI_CONFIG_DIR {invalid:?} 必须被拒绝，profile={profile:?}"
            );
        }
        for valid in ["custom-config", "nested/config", r"nested\config", "./custom-config"] {
            let outcome = resolve_root(&ResolutionInput {
                home,
                profile,
                config_dir: Some(Path::new(valid)),
                coding_agent_dir: None,
            })
            .unwrap();
            let config = home.join(valid);
            let expected = match profile {
                Some(name) => config.join("profiles").join(name).join("agent"),
                None => config.join("agent"),
            };
            assert_eq!(outcome.root, expected, "{valid:?}, profile={profile:?}");
        }
    }
}

#[test]
fn existing_yaml_spelling_is_used_and_preferred_yml_wins() {
    let temp = tempfile::tempdir().unwrap();
    let only_yaml = pick(temp.path(), "config");
    assert_eq!(only_yaml, temp.path().join("config.yml"));
    std::fs::write(temp.path().join("config.yaml"), "modelRoles: {}\n").unwrap();
    assert_eq!(pick(temp.path(), "config"), temp.path().join("config.yaml"));
    std::fs::write(temp.path().join("config.yml"), "modelRoles: {}\n").unwrap();
    assert_eq!(pick(temp.path(), "config"), temp.path().join("config.yml"));
}

#[test]
fn native_files_publish_yaml_roles_and_respect_project_directory() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let project = temp.path().join("project");
    std::fs::create_dir_all(home.join(".omp/agent")).unwrap();
    std::fs::create_dir_all(project.join(".omp")).unwrap();
    std::fs::write(home.join(".omp/agent/config.yaml"), "modelRoles: {}\n").unwrap();
    let files = native_files(Scope::Global, &home, None, true);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].role, "settings");
    assert_eq!(files[0].format, "yaml");
    assert!(files[0].path.ends_with("config.yaml"));
    assert!(files[1].path.ends_with("models.yml"));
    let project_files = native_files(Scope::Project, &home, Some(&project), true);
    assert_eq!(project_files.len(), 1);
    assert!(project_files[0].path.ends_with("config.yml"));
    assert!(project_files[0].path.contains(".omp"));
}

#[test]
fn read_projects_roles_models_and_unknown_roles_without_losing_them() {
    let documents = documents();
    let view = CONFIGURATION
        .read(&documents, &EditingState::default())
        .unwrap();
    assert_eq!(view["providerId"], "alpha");
    assert_eq!(view["providers"], json!(["alpha", "beta"]));
    assert_eq!(view["defaultModel"], "one");
    assert_eq!(view["roles"]["customRole"], "alpha/one");
    let ids: Vec<&str> = view["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|model| model["id"].as_str())
        .collect();
    assert_eq!(ids, ["one", "two"]);
    assert_eq!(
        view["settings"]["modelRoles.smol"],
        "beta/small"
    );
    assert_eq!(view["settings"]["retry"]["maxRetries"], 3);
}

#[test]
fn editing_one_model_field_preserves_unknown_fields_providers_and_roles() {
    let mut documents = documents();
    let mut state = EditingState::default();
    CONFIGURATION
        .edit(
            &mut documents,
            &mut state,
            &action(
                json!({"kind":"model","provider":"alpha","id":"one"}),
                "set",
                Some("contextWindow"),
                Some(json!(100000)),
            ),
        )
        .unwrap();
    let models = rendered(&documents, MODELS_ROLE);
    assert_eq!(models["providers"]["alpha"]["models"][0]["contextWindow"], 100000);
    assert_eq!(
        models["providers"]["alpha"]["models"][0]["customModelField"],
        "keep"
    );
    assert_eq!(
        models["providers"]["alpha"]["customProviderField"]["keep"],
        true
    );
    assert_eq!(models["providers"]["beta"]["auth"], "none");
    let settings = rendered(&documents, SETTINGS_ROLE);
    assert_eq!(settings["modelRoles"]["customRole"], "alpha/one");
    assert_eq!(settings["modelRoles"]["smol"], "beta/small");
    assert_eq!(settings["unverifiedExtension"]["nested"], json!(["one", "two"]));
}

#[test]
fn role_edit_and_reset_only_touch_that_role() {
    let mut documents = documents();
    let mut state = EditingState::default();
    CONFIGURATION
        .edit(
            &mut documents,
            &mut state,
            &action(
                json!({"kind":"settings"}),
                "set",
                Some("modelRoles.slow"),
                Some(json!("beta/small")),
            ),
        )
        .unwrap();
    let settings = rendered(&documents, SETTINGS_ROLE);
    assert_eq!(settings["modelRoles"]["slow"], "beta/small");
    assert_eq!(settings["modelRoles"]["customRole"], "alpha/one");
    CONFIGURATION
        .edit(
            &mut documents,
            &mut state,
            &action(
                json!({"kind":"settings"}),
                "reset",
                Some("modelRoles.slow"),
                None,
            ),
        )
        .unwrap();
    let settings = rendered(&documents, SETTINGS_ROLE);
    assert!(settings["modelRoles"].get("slow").is_none());
    assert_eq!(settings["modelRoles"]["default"], "alpha/one");
    assert_eq!(settings["modelRoles"]["customRole"], "alpha/one");
}

#[test]
fn default_role_and_referenced_model_deletion_are_guarded() {
    let mut documents = documents();
    let mut state = EditingState::default();
    CONFIGURATION
        .edit(
            &mut documents,
            &mut state,
            &action(
                json!({"kind":"model","provider":"alpha","id":"two"}),
                "default",
                None,
                None,
            ),
        )
        .unwrap();
    assert_eq!(
        rendered(&documents, SETTINGS_ROLE)["modelRoles"]["default"],
        "alpha/two"
    );
    let error = CONFIGURATION
        .edit(
            &mut documents,
            &mut state,
            &action(
                json!({"kind":"model","provider":"alpha","id":"one"}),
                "delete",
                None,
                None,
            ),
        )
        .err()
        .unwrap();
    assert!(error.contains("模型角色"));
}

#[test]
fn literal_keys_are_rejected_and_imported_as_environment_references() {
    let text = MODELS.replace("${OMP_ALPHA_API_KEY}", "sk-literal");
    let parsed = format::parse(FileKind::Yaml, &text).unwrap();
    assert!(validate_draft(MODELS_ROLE, &parsed).is_err());

    let mut files = BTreeMap::from([(MODELS_ROLE.into(), text)]);
    let mut found = NativeInspection {
        provider_id: Some("alpha".into()),
        model: Some("one".into()),
        connection: Some(Connection {
            provider_id: "alpha".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://alpha.example.test/v1".into(),
            model: "one".into(),
            secret_ref: None,
            auth_env_var: None,
            model_records: Vec::new(),
        }),
        reasoning_effort: None,
        projected_models: None,
    };
    let mut pending = Vec::new();
    let mut native_refs = NativeCredentialRefs::new();
    import_literal_secrets(&mut files, &mut found, &mut pending, &mut native_refs).unwrap();
    assert!(files[MODELS_ROLE].contains("${OMP_ALPHA_API_KEY}"));
    assert!(!files[MODELS_ROLE].contains("sk-literal"));
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1, "sk-literal");
    // Like Pi, the selected connection owns the imported key; apply writes it back literally.
    assert!(native_refs.is_empty());
    assert_eq!(
        found.connection.as_ref().unwrap().secret_ref.as_deref(),
        Some(pending[0].0.as_str())
    );
    assert_eq!(
        found.connection.unwrap().auth_env_var.as_deref(),
        Some("OMP_ALPHA_API_KEY")
    );
}

#[test]
fn native_bare_environment_names_are_canonicalised_without_importing_a_secret() {
    let text = MODELS.replace("${OMP_ALPHA_API_KEY}", "OMP_ALPHA_API_KEY");
    let mut files = BTreeMap::from([(MODELS_ROLE.into(), text)]);
    let mut found = NativeInspection {
        provider_id: Some("alpha".into()),
        model: Some("one".into()),
        connection: None,
        reasoning_effort: None,
        projected_models: None,
    };
    let mut pending = Vec::new();
    let mut native_refs = NativeCredentialRefs::new();
    import_literal_secrets(&mut files, &mut found, &mut pending, &mut native_refs).unwrap();
    assert!(files[MODELS_ROLE].contains("${OMP_ALPHA_API_KEY}"));
    assert!(pending.is_empty());
    assert!(native_refs.is_empty());
}

#[test]
fn project_scope_rejects_managed_secrets_and_plaintext_but_allows_references() {
    let reference = Connection {
        provider_id: "alpha".into(),
        interface_format: "openai_completions".into(),
        base_url: "https://alpha.example.test/v1".into(),
        model: "one".into(),
        secret_ref: Some("connection-00000000-0000-4000-8000-000000000001".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    };
    assert!(connection_documents(&reference, Scope::Project).is_err());
    let project = BTreeMap::from([(
        SETTINGS_ROLE.into(),
        json!({"modelRoles":{"default":"alpha/one"},"retry":{"maxRetries":3}}),
    )]);
    let issues = CONFIGURATION.validate(&project, &EditingState::default(), Scope::Project);
    assert!(issues.is_empty(), "{issues:?}");
    let all = documents();
    assert!(CONFIGURATION
        .validate(&all, &EditingState::default(), Scope::Project)
        .iter()
        .any(|issue| issue.code == "invalid_native_value"));
    let mut literal = documents();
    literal
        .get_mut(MODELS_ROLE)
        .unwrap()["providers"]["alpha"]["apiKey"] = json!("sk-private");
    assert!(validate_draft(
        MODELS_ROLE,
        &literal[MODELS_ROLE]
    )
    .is_err());
    assert!(CONFIGURATION
        .validate(&literal, &EditingState::default(), Scope::Project)
        .iter()
        .any(|issue| issue.code == "invalid_native_value"));
    assert_eq!(
        connection_policy(Scope::Project).api_key.state,
        "scope_denied"
    );
    assert_eq!(
        connection_policy(Scope::Project).provider_address.state,
        "unsupported"
    );
}

#[test]
fn connection_projects_native_reference_and_never_renders_a_literal() {
    let docs = documents();
    let connection = CONFIGURATION
        .connection(&docs, &EditingState::default())
        .unwrap()
        .unwrap();
    assert_eq!(connection.provider_id, "alpha");
    assert_eq!(connection.interface_format, "openai_responses");
    assert_eq!(connection.auth_env_var.as_deref(), Some("OMP_ALPHA_API_KEY"));
    assert_eq!(connection.model_records.len(), 2);

    let written = connection_documents(
        &Connection {
            provider_id: "alpha".into(),
            interface_format: "openai_completions".into(),
            base_url: "https://alpha.example.test/v1".into(),
            model: "one".into(),
            secret_ref: Some("connection-00000000-0000-4000-8000-000000000002".into()),
            auth_env_var: Some("OMP_ALPHA_API_KEY".into()),
            model_records: Vec::new(),
        },
        Scope::Global,
    )
    .unwrap();
    let rendered = format::render(FileKind::Yaml, &written[MODELS_ROLE]).unwrap();
    assert!(rendered.contains("${OMP_ALPHA_API_KEY}"));
    assert!(!rendered.contains("connection-"));

    let no_key = connection_documents(
        &Connection {
            provider_id: "beta".into(),
            interface_format: "anthropic_messages".into(),
            base_url: "https://beta.example.test".into(),
            model: "small".into(),
            secret_ref: None,
            auth_env_var: None,
            model_records: Vec::new(),
        },
        Scope::Global,
    )
    .unwrap();
    let rendered = format::render(FileKind::Yaml, &no_key[MODELS_ROLE]).unwrap();
    assert!(!rendered.contains("apiKey"));
}

#[test]
fn unknown_protocol_is_visible_but_existing_value_is_not_blocked() {
    let mut documents = documents();
    documents.get_mut(MODELS_ROLE).unwrap()["providers"]["alpha"]["api"] =
        json!("future-wire");
    let issues = CONFIGURATION.validate(&documents, &EditingState::default(), Scope::Global);
    assert!(issues.iter().any(|issue| issue.code == "invalid_native_value"));
    // A raw save that keeps the native protocol is allowed; introducing a new
    // unsupported one is not.
    let previous = documents.clone();
    assert!(CONFIGURATION
        .validate_changes(Some(&previous), &documents, &EditingState::default(), Scope::Global)
        .is_empty());
    let mut changed = documents.clone();
    changed.get_mut(MODELS_ROLE).unwrap()["providers"]["beta"]["api"] =
        json!("future-wire");
    assert!(!CONFIGURATION
        .validate_changes(Some(&previous), &changed, &EditingState::default(), Scope::Global)
        .is_empty());
}

#[test]
fn portable_fields_classify_references_and_settings() {
    assert_eq!(
        portable_field_kind(&["providers".into(), "alpha".into(), "apiKey".into()]),
        PortableFieldKind::CredentialReference
    );
    assert_eq!(
        portable_field_kind(&["modelRoles".into(), "default".into()]),
        PortableFieldKind::Parameter
    );
    assert_eq!(
        portable_field_kind(&["providers".into(), "alpha".into(), "custom".into()]),
        PortableFieldKind::Unknown
    );
    assert!(CONFIGURATION.portable_reference_valid(&["apiKey".into()], &json!("${KEY}")));
    assert!(CONFIGURATION.portable_reference_valid(&["apiKey".into()], &json!("KEY")));
    assert!(!CONFIGURATION.portable_reference_valid(
        &["apiKey".into()],
        &json!("sk-literal")
    ));
}

#[test]
fn descriptor_publishes_configuration_and_project_override() {
    assert_eq!(facet().state, "available");
    assert!(project_model_override());
    assert_eq!(interface_formats().len(), 3);
    for role in ["settings", "models"] {
        assert_eq!(file_kind(role).unwrap(), FileKind::Yaml);
    }
    assert!(file_kind("auth").is_err());
    let descriptor = CONFIGURATION.describe(Scope::Global);
    assert!(descriptor.fields.iter().any(|field| field.id == "retry"));
    assert!(descriptor
        .fields
        .iter()
        .any(|field| field.id == "modelRoles.default"));
    assert!(descriptor.operations.contains(&"create".to_string()));
    assert!(!CONFIGURATION
        .describe(Scope::Project)
        .operations
        .contains(&"create".to_string()));
    // The frozen composition root forwards through this module, not a local
    // capability switch.
    let registered = crate::adapters::Registry::builtins();
    let omp = registered.get("omp").unwrap();
    assert_eq!(omp.descriptor().native_config.state, "available");
    assert!(omp.configuration().is_some());
    assert_eq!(omp.interface_formats(), interface_formats());
    assert!(profile().files.contains_key(MODELS_ROLE));
}

#[test]
fn project_scope_publishes_only_config_and_rejects_models_role() {
    let project = BTreeMap::from([(
        SETTINGS_ROLE.into(),
        json!({"modelRoles":{"default":"alpha/one"},"retry":{"maxRetries":3}}),
    )]);
    let issues = CONFIGURATION.validate(&project, &EditingState::default(), Scope::Project);
    assert!(issues.is_empty(), "{issues:?}");
    assert!(validate_role_scope(SETTINGS_ROLE, Scope::Project).is_ok());
    assert!(validate_role_scope(MODELS_ROLE, Scope::Project).is_err());
}

#[test]
fn apply_rewrites_environment_references_to_the_native_bare_name() {
    struct Store;
    impl CredentialStore for Store {
        fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, _id: &str) -> Result<String, String> {
            Err("missing".into())
        }
        fn delete(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let mut secrets = NativeSecrets::default();
    write_connection_secret(&profile(), Scope::Global, &Store, &mut secrets).unwrap();
    let text = secrets
        .apply_text(MODELS_ROLE, FileKind::Yaml, MODELS.to_owned())
        .unwrap();
    assert!(text.contains("apiKey: OMP_ALPHA_API_KEY"), "{text}");
    assert!(!text.contains("${"), "{text}");
}

/// `omp` started outside Cliora reads `providers.<id>.apiKey` with no launch
/// environment, so a managed connection key must land literally in models.yml.
#[test]
fn apply_writes_the_managed_key_literally_and_refuses_keys_omp_would_reinterpret() {
    struct Store(&'static str);
    impl CredentialStore for Store {
        fn put(&self, _id: &str, _secret: &str) -> Result<(), String> {
            Ok(())
        }
        fn get(&self, _id: &str) -> Result<String, String> {
            Ok(self.0.into())
        }
        fn delete(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let mut managed = profile();
    managed.connection = Some(Connection {
        provider_id: "alpha".into(),
        interface_format: "openai_responses".into(),
        base_url: "https://alpha.example.test/v1".into(),
        model: "one".into(),
        secret_ref: Some("connection-00000000-0000-4000-8000-000000000001".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    });
    let mut secrets = NativeSecrets::default();
    write_connection_secret(&managed, Scope::Global, &Store("sk-synthetic-1"), &mut secrets).unwrap();
    let text = secrets
        .apply_text(MODELS_ROLE, FileKind::Yaml, MODELS.to_owned())
        .unwrap();
    let parsed = format::parse(FileKind::Yaml, &text).unwrap();
    assert_eq!(parsed["providers"]["alpha"]["apiKey"], "sk-synthetic-1");

    for reinterpreted in ["!pass show key", "SOME_ENV_NAME", "$OTHER", "${OTHER}"] {
        let mut secrets = NativeSecrets::default();
        assert!(
            write_connection_secret(&managed, Scope::Global, &Store(reinterpreted), &mut secrets).is_err(),
            "{reinterpreted}"
        );
    }
    assert!(write_connection_secret(&managed, Scope::Project, &Store("sk-synthetic-1"), &mut NativeSecrets::default()).is_err());

    // A binding applied by the former launch-environment channel left the bare
    // variable name behind: it reads as changed so re-applying repairs it.
    let connection = managed.connection.as_ref().unwrap();
    let path = ["providers".to_owned(), "alpha".to_owned(), "apiKey".to_owned()];
    assert!(outdated_applied_secret(connection, MODELS_ROLE, &path, &json!("CLIORA_OMP_ALPHA_API_KEY")));
    assert!(!outdated_applied_secret(connection, MODELS_ROLE, &path, &json!("sk-synthetic-1")));
}

#[test]
fn named_profile_saves_yaml_but_never_a_literal_key() {
    let temp = tempfile::tempdir().unwrap();
    let db = crate::database::Database::open(&temp.path().join("app.db")).unwrap();
    let registry = crate::adapters::Registry::builtins();
    let mut fresh = profile();
    fresh.id = String::new();
    let saved = crate::native::profile::save_registered_profile(
        &db,
        &registry,
        fresh,
        None,
    )
    .unwrap();
    assert_eq!(saved.tool, "omp");
    assert!(saved.files[SETTINGS_ROLE].contains("customRole"));
    assert!(saved.files[MODELS_ROLE].contains("${OMP_ALPHA_API_KEY}"));
    assert!(!saved.files[MODELS_ROLE].contains("sk-"));

    let mut literal = profile();
    literal.id = String::new();
    literal.name = "literal".into();
    literal.files.insert(
        MODELS_ROLE.into(),
        MODELS.replace("${OMP_ALPHA_API_KEY}", "sk-live-private"),
    );
    assert!(crate::native::profile::save_registered_profile(&db, &registry, literal, None)
        .unwrap_err()
        .contains("明文密钥"));
}

#[test]
fn model_directory_adds_only_new_ids_into_the_native_array() {
    assert!(CONFIGURATION.catalog_support().available);
    assert!(CONFIGURATION.catalog_support().multiple);
    let mut documents = documents();
    let mut state = EditingState { selected_provider: Some("alpha".into()), ..EditingState::default() };
    let ids = vec!["one".to_owned(), "two".to_owned(), "new-1".to_owned()];
    let actions = CONFIGURATION.catalog_actions(&documents, &state, &ids).unwrap();
    assert_eq!(actions.len(), 1, "existing models are not created again");
    assert_eq!(actions[0].target, json!({"kind":"model","provider":"alpha","id":"new-1"}));
    assert_eq!(actions[0].operation, "create");
    for action in &actions {
        CONFIGURATION.edit(&mut documents, &mut state, action).unwrap();
    }
    let models = rendered(&documents, MODELS_ROLE);
    let list = models["providers"]["alpha"]["models"].as_array().unwrap();
    assert_eq!(list.iter().filter_map(|model| model["id"].as_str()).collect::<Vec<_>>(), vec!["one", "two", "new-1"]);
    assert_eq!(models["providers"]["alpha"]["customProviderField"]["keep"], true);
    assert_eq!(models["providers"]["alpha"]["models"][0]["customModelField"], "keep");
}

#[test]
fn model_directory_reads_the_selected_provider_without_writing_roles() {
    let documents = documents();
    let state = EditingState { selected_provider: Some("beta".into()), ..EditingState::default() };
    // The default role points at alpha; the directory still asks the provider being edited.
    let connection = CONFIGURATION.draft_connection(&documents, &state).unwrap().unwrap();
    assert_eq!(connection.provider_id, "beta");
    assert_eq!(connection.base_url, "https://beta.example.test");
    assert_eq!(rendered(&documents, SETTINGS_ROLE)["modelRoles"]["default"], "alpha/one");
}

#[test]
fn model_directory_works_for_a_provider_with_no_models_yet() {
    let mut documents = documents();
    documents.get_mut(MODELS_ROLE).unwrap()["providers"]["fresh"] =
        json!({"api":"openai-completions","baseUrl":"https://fresh.example.test/v1","apiKey":"${OMP_FRESH_API_KEY}"});
    let state = EditingState { selected_provider: Some("fresh".into()), ..EditingState::default() };
    let connection = CONFIGURATION.draft_connection(&documents, &state).unwrap().unwrap();
    assert_eq!(connection.provider_id, "fresh");
    assert_eq!(connection.base_url, "https://fresh.example.test/v1");
    let actions = CONFIGURATION.catalog_actions(&documents, &state, &["m1".to_owned()]).unwrap();
    assert_eq!(actions.len(), 1);
}
