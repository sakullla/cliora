//! CodeBuddy (Tencent Cloud) CLI adapter.
//!
//! Evidence base: npm `@tencent-ai/codebuddy-code` 2.161.1 verified on the
//! local machine (`codebuddy --version`, settings.json, projects/*.jsonl,
//! `codebuddy plugin list --json`) plus the official docs at
//! https://codebuddy.ai/docs/zh. Native config lives in `~/.codebuddy`
//! (`CODEBUDDY_CONFIG_DIR` overrides it); project files live in
//! `<project>/.codebuddy`.
//!
//! Credentials: settings.json `env` values named CODEBUDDY_API_KEY or
//! CODEBUDDY_AUTH_TOKEN are the documented key channels (priority
//! AUTH_TOKEN > apiKeyHelper > API_KEY). They move to the system credential
//! store exactly like Claude Code's env keys; drafts and exports never keep
//! the plaintext. `apiKeyHelper` is a helper-program reference whose output
//! is produced at runtime, so it stays an ordinary editable field.
pub(crate) mod agents;
pub mod history;
pub(crate) mod plugins;

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{
    file, project_root, CliAdapter, InspectionFields, LaunchMode, McpLocation,
    NativeCredentialRefs, PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::{string_at, NativeInspection};
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct CodeBuddy;

/// Frozen credential field set inside settings.json `env`, verified against the
/// installed 2.161.1 release (dist constants + cli/iam docs).
pub(crate) const CREDENTIAL_ENV_NAMES: &[&str] = &["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN"];

/// Injected by a running CodeBuddy session into its subprocesses; a fresh
/// terminal launch must not inherit them (dist evidence: session/project/plugin
/// markers are exported to child processes).
const SESSION_ENV_MARKERS: &[&str] = &[
    "CODEBUDDY_SESSION_ID",
    "CODEBUDDY_CONVERSATION_REQUEST_ID",
    "CODEBUDDY_PROJECT_DIR",
    "CODEBUDDY_PLUGIN_ROOT",
];

pub(crate) fn config_root(home: &Path) -> PathBuf {
    crate::accounts::selection::config_root("codebuddy", || {
        env::var_os("CODEBUDDY_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codebuddy"))
    })
}

impl CliAdapter for CodeBuddy {
    fn native_credential_target(&self, scope: Scope) -> Option<super::contract::NativeCredentialTarget> {
        Some(super::contract::NativeCredentialTarget {
            identity: format!("codebuddy:{scope:?}:env-key"),
            label: "CodeBuddy 原生 API 密钥（不提供 HTTP 目录或诊断）".into(),
            role: "settings".into(),
            // AUTH_TOKEN precedes apiKeyHelper and API_KEY in this native CLI.
            path: vec!["env".into(), "CODEBUDDY_AUTH_TOKEN".into()],
            remove_paths: CREDENTIAL_ENV_NAMES.iter().map(|name| vec!["env".into(), (*name).into()]).collect(),
        })
    }
    fn supports_mcp(&self) -> bool { true }
    fn supports_skills(&self) -> bool { true }
    fn agents(&self) -> Option<&dyn crate::adapters::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn crate::adapters::plugins::PluginAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "codebuddy"
    }
    fn name(&self) -> &'static str {
        "CodeBuddy"
    }
    fn command(&self) -> &'static str {
        "codebuddy"
    }
    fn npm_package(&self) -> &'static str {
        "@tencent-ai/codebuddy-code"
    }
    /// `codebuddy --version` prints a bare semver string ("2.161.1"), so the
    /// probed binary name is the only identity signal.
    fn version_identity(&self, basename: &str, _output: &str) -> bool {
        basename.contains("codebuddy")
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        let path = match root {
            Some(root) => root.join(".codebuddy/settings.json"),
            None => config_root(home).join("settings.json"),
        };
        vec![file("settings", path, FileKind::Json, known, None, false)]
    }
    /// CODEBUDDY_BASE_URL targets the CodeBuddy gateway protocol (`<base>/v2`),
    /// not an OpenAI/Anthropic provider API, so no interface format is declared.
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Json)
        } else {
            Err("CodeBuddy 不支持此原生文件角色".into())
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        if role == "settings" {
            &[
                "language",
                "model",
                "variantModels",
                "env",
                "apiKeyHelper",
                "enabledPlugins",
            ]
        } else {
            &[]
        }
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        // User scope manages the recommended `~/.codebuddy/.mcp.json` (JSONC
        // mcpServers); project scope manages the recommended `<root>/.mcp.json`.
        let path = match scope {
            Scope::Global => config_root(home).join(".mcp.json"),
            Scope::Project => project?.join(".mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Jsonc,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会移除原生条目，Cliora 中的定义仍保留")
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        // No per-entry enabled flag: removing the entry stops loading it, the
        // same boundary Claude Code uses. `type` is inferred from command/url.
        if !enabled {
            return Ok(None);
        }
        let map = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        Ok(Some(Value::Object(map)))
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => config_root(home).join("skills"),
            Scope::Project => project?.join(".codebuddy/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        match scope {
            Scope::Global => Some(config_root(home).join("CODEBUDDY.md")),
            // The project memory-file location is not verified from official
            // evidence, so no project rule path is declared.
            Scope::Project => None,
        }
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_writable(),
            provider_address: crate::native::adapter::address_unsupported(
                "CodeBuddy 此版本不提供第三方供应商接口接入；模型经官方网关访问",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Ok(BTreeMap::from([("settings".into(), json!({}))]))
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        _scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        let name = connection
            .auth_env_var
            .as_deref()
            .unwrap_or("CODEBUDDY_API_KEY");
        if !CREDENTIAL_ENV_NAMES.contains(&name) {
            return Err(
                "CodeBuddy 原生认证只支持 env 中 CODEBUDDY_API_KEY 或 CODEBUDDY_AUTH_TOKEN"
                    .into(),
            );
        }
        secrets.put("settings", &["env", name], read_secret(id, credentials)?);
        let other = if name == "CODEBUDDY_API_KEY" {
            "CODEBUDDY_AUTH_TOKEN"
        } else {
            "CODEBUDDY_API_KEY"
        };
        secrets.remove("settings", &["env", other]);
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("env")
                .and_then(Value::as_object)
                .is_some_and(|env| {
                    CREDENTIAL_ENV_NAMES.iter().any(|name| env.contains_key(*name))
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        InspectionFields {
            provider: None,
            model: string_at(settings, &["model"]).map(str::to_owned),
            base: string_at(settings, &["env", "CODEBUDDY_BASE_URL"]).map(str::to_owned),
            wire: None,
            env: None,
            reasoning_effort: None,
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        _found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        let mut text = files.get("settings").cloned().unwrap_or_default();
        let parsed = crate::native::format::parse(FileKind::Json, &text)?;
        for name in CREDENTIAL_ENV_NAMES.iter().copied() {
            let Some(key) = string_at(&parsed, &["env", name]) else {
                continue;
            };
            if key.is_empty() || key.len() > 16_384 {
                return Err("原生 API 密钥为空或超过系统凭据库限制；原文件未更改".into());
            }
            let id = format!("connection-{}", uuid::Uuid::new_v4());
            text = crate::native::format::set_path(
                FileKind::Json,
                &text,
                &["env".into(), name.into()],
                None,
            )?;
            native_refs
                .entry("settings".into())
                .or_default()
                .insert(name.into(), id.clone());
            pending.push((id, key.to_owned()));
        }
        if native_refs.contains_key("settings") {
            files.insert("settings".into(), text);
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "settings" {
            return Ok(());
        }
        if let Some(env) = parsed.get("env").and_then(Value::as_object) {
            if CREDENTIAL_ENV_NAMES.iter().any(|name| env.contains_key(*name)) {
                return Err(
                    "CodeBuddy 原生配置中的认证字段不能存入草稿；请通过安全接入迁入系统凭据库"
                        .into(),
                );
            }
        }
        Ok(())
    }
    fn accepts_native_credential(&self, role: &str, name: &str) -> bool {
        role == "settings" && CREDENTIAL_ENV_NAMES.contains(&name)
    }
    fn restore_imported_secrets(
        &self,
        profile: &RegisteredProfile,
        _scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        for (name, id) in profile
            .native_credentials
            .get("settings")
            .into_iter()
            .flatten()
        {
            if CREDENTIAL_ENV_NAMES.contains(&name.as_str()) {
                secrets.put("settings", &["env", name], read_secret(id, credentials)?);
            }
        }
        Ok(())
    }
    fn session_env_markers(&self) -> &'static [&'static str] {
        SESSION_ENV_MARKERS
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["-r".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            // Skips most permission prompts; HIGH/CRITICAL actions may still
            // confirm unless CODEBUDDY_IS_SANDBOX=1 (official cli reference).
            args.push("--dangerously-skip-permissions".into());
        }
        Ok(args)
    }
    fn history_sources(
        &self,
        home: &std::path::Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse(source)
    }
    fn history_sources_controlled(
        &self,
        home: &std::path::Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources_controlled(home, cancelled)
    }
    fn parse_history_controlled(
        &self,
        source: &crate::history::HistorySource,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse_controlled(source, cancelled)
    }
    fn history_supported(&self) -> bool {
        true
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        version.starts_with("2.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://codebuddy.ai/docs/zh",
            "npm 渠道安装并保持更新；官方原生安装器仍为 Beta，PATH 位于 %USERPROFILE%\\AppData\\Local\\codebuddy\\bin。",
        )
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((18, 20, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "codebuddy 的 npm 安装需要 Node.js 18.20 或更新版本"
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        match source {
            "npm_shim" => Some(format!("npm install -g {}@latest", self.npm_package())),
            "native" => Some("codebuddy update".into()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    struct MemoryStore(Mutex<BTreeMap<String, String>>);
    impl CredentialStore for MemoryStore {
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
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn fixtures(role: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../tests/fixtures/{role}"))
    }

    #[test]
    fn bare_version_output_identifies_only_codebuddy_binaries() {
        assert!(CodeBuddy.version_identity("codebuddy", "2.161.1\n"));
        assert!(!CodeBuddy.version_identity("renamed", "2.161.1"));
    }

    #[test]
    fn native_settings_roles_cover_user_and_project_scopes() {
        let home = Path::new("/home/example");
        let global = CodeBuddy.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert!(global[0].path.replace('\\', "/").ends_with("/.codebuddy/settings.json"));
        assert_eq!(CodeBuddy.file_kind("settings").unwrap(), FileKind::Json);
        let project = Path::new("/work/demo");
        let scoped = CodeBuddy.native_files(Scope::Project, home, Some(project), true);
        assert!(scoped[0]
            .path
            .replace('\\', "/")
            .ends_with("/work/demo/.codebuddy/settings.json"));
        assert!(CodeBuddy
            .native_files(Scope::Project, home, None, true)
            .is_empty());
    }

    #[test]
    fn launch_args_cover_cwd_yolo_and_resume_modes() {
        assert_eq!(CodeBuddy.launch_args(None, LaunchMode::Normal).unwrap(), Vec::<String>::new());
        assert_eq!(
            CodeBuddy.launch_args(None, LaunchMode::Yolo).unwrap(),
            vec!["--dangerously-skip-permissions".to_string()]
        );
        assert_eq!(
            CodeBuddy.launch_args(Some("0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0"), LaunchMode::Normal)
                .unwrap(),
            vec![
                "-r".to_string(),
                "0aa0fb40-0b9c-74c9-8d7c-cd5d630dc6f0".to_string()
            ]
        );
        assert_eq!(
            CodeBuddy.launch_args(Some("sid-1"), LaunchMode::Yolo).unwrap(),
            vec![
                "-r".to_string(),
                "sid-1".to_string(),
                "--dangerously-skip-permissions".to_string()
            ]
        );
    }

    #[test]
    fn mcp_targets_the_recommended_jsonc_files() {
        let home = Path::new("/home/example");
        let global = CodeBuddy
            .mcp_location(Scope::Global, home, None)
            .unwrap();
        assert!(global.path.to_string_lossy().replace('\\', "/").ends_with("/.codebuddy/.mcp.json"));
        assert_eq!(global.kind, FileKind::Jsonc);
        assert_eq!(global.root, "mcpServers");
        let project = CodeBuddy
            .mcp_location(Scope::Project, home, Some(Path::new("/work/demo")))
            .unwrap();
        assert!(project.path.to_string_lossy().replace('\\', "/").ends_with("/work/demo/.mcp.json"));
        let definition = McpDefinition {
            id: "m1".into(),
            name: "fetch".into(),
            transport: McpTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "fetch".into()],
            url: String::new(),
            env: BTreeMap::from([("API_TOKEN".into(), "${FETCH_TOKEN}".into())]),
            headers: BTreeMap::new(),
            in_library: true,
            version: 1,
        };
        let doc = CodeBuddy
            .mcp_document(&definition, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(doc["command"], "npx");
        assert_eq!(doc["env"]["API_TOKEN"], "${FETCH_TOKEN}");
        assert!(doc.get("enabled").is_none());
        assert!(CodeBuddy.mcp_document(&definition, false, None).unwrap().is_none());
    }

    #[test]
    fn fixture_settings_inspect_and_portable_fields_stay_honest() {
        let text = std::fs::read_to_string(fixtures("native").join("codebuddy-2.161.1.json"))
            .unwrap();
        let parsed = crate::native::format::parse(FileKind::Json, &text).unwrap();
        let fields = CodeBuddy.inspect_values(&parsed, &json!({}), &json!({}));
        assert_eq!(fields.model.as_deref(), Some("kimi-k3-2"));
        assert!(fields.provider.is_none());
        assert!(fields.wire.is_none());
        let portable = CodeBuddy.portable_root_fields("settings");
        assert!(portable.contains(&"model"));
        assert!(portable.contains(&"enabledPlugins"));
        assert!(portable.contains(&"env"));
        assert!(!portable.contains(&"trustedDirectories"));
        CodeBuddy.validate_draft("settings", &parsed).unwrap();
    }

    #[test]
    fn env_credentials_move_to_the_store_and_never_stay_in_drafts() {
        let source = r#"{
            "model": "kimi-k3-2",
            "env": {
                "CODEBUDDY_BASE_URL": "https://example.invalid/gateway",
                "CODEBUDDY_API_KEY": "test-only-key",
                "CODEBUDDY_AUTH_TOKEN": "test-only-token"
            }
        }"#;
        let store = MemoryStore(Mutex::new(BTreeMap::new()));
        let imported = crate::native::intake::prepare_registered_import(
            &crate::adapters::Registry::builtins(),
            "codebuddy",
            BTreeMap::from([("settings".into(), source.into())]),
            &store,
        )
        .unwrap();
        assert!(imported.migrated_secret);
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("test-only-key"));
        assert!(!serde_json::to_string(&imported)
            .unwrap()
            .contains("test-only-token"));
        assert!(imported.files["settings"].contains("CODEBUDDY_BASE_URL"));
        let refs = &imported.native_credentials["settings"];
        for name in CREDENTIAL_ENV_NAMES {
            let id = &refs[*name];
            let value = store.get(id).unwrap();
            assert!(value.starts_with("test-only-"));
            assert!(CodeBuddy.accepts_native_credential("settings", name));
        }
        // Re-adding a literal key to a draft is rejected before any write.
        let draft = crate::native::format::parse(
            FileKind::Json,
            r#"{"env":{"CODEBUDDY_API_KEY":"literal-again"}}"#,
        )
        .unwrap();
        assert!(CodeBuddy.validate_draft("settings", &draft).is_err());
        // Detection covers both frozen names.
        assert!(CodeBuddy.has_native_secret("settings", &draft));
    }

    #[test]
    fn connection_secrets_only_use_the_frozen_env_names() {
        let store = MemoryStore(Mutex::new(BTreeMap::from([(
            "connection-00000000-0000-0000-0000-000000000001".into(),
            "test-only-key".into(),
        )])));
        let profile = RegisteredProfile {
            editing: None,
            id: "p".into(),
            tool: "codebuddy".into(),
            name: "接入".into(),
            version: 1,
            revision: String::new(),
            inherit_common: false,
            files: BTreeMap::new(),
            suppressed: BTreeMap::new(),
            authentication: crate::native::profile::ProfileAuthentication::Native,
            connection: Some(Connection {
                provider_id: "custom".into(),
                interface_format: "openai_completions".into(),
                base_url: "https://example.invalid".into(),
                model: "m".into(),
                secret_ref: Some("connection-00000000-0000-0000-0000-000000000001".into()),
                auth_env_var: Some("CODEBUDDY_WRONG_NAME".into()),
                model_records: Vec::new(),
            }),
            native_credentials: BTreeMap::new(),
        };
        let mut secrets = NativeSecrets::default();
        assert!(CodeBuddy
            .write_connection_secret(&profile, Scope::Global, &store, &mut secrets)
            .unwrap_err()
            .contains("CODEBUDDY_API_KEY"));
        // Restoring imported secrets keeps working for the frozen names.
        let mut restore_profile = profile;
        restore_profile.connection = None;
        restore_profile.native_credentials = BTreeMap::from([(
            "settings".into(),
            BTreeMap::from([(
                "CODEBUDDY_API_KEY".into(),
                "connection-00000000-0000-0000-0000-000000000001".into(),
            )]),
        )]);
        let mut restore_secrets = NativeSecrets::default();
        CodeBuddy
            .restore_imported_secrets(&restore_profile, Scope::Global, &store, &mut restore_secrets)
            .unwrap();
    }
}
