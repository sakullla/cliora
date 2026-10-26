//! Cursor desktop editor, registered default-off.
//!
//! The stable id is `cursor` and the command is the editor `cursor`. This
//! adapter does not detect or fall back to `agent`. A selected project or
//! session directory is one positional path. A direct launch passes none.
//! Cancelling the preference does not delete local Cursor files.

mod agents;
pub(crate) mod memory;
mod history;
mod install;
mod plugins;
mod rules;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode,
    ManagementCapabilities, McpLocation, RuleFileSpec, RuleSupport, SkillObservation,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::{self, McpDefinition, McpTransport};

pub struct Cursor;

const CONNECTION_DENIED: &str = "Cursor 不提供供应商、请求地址、登录或模型连接";

impl CliAdapter for Cursor {
    fn memory(&self) -> Option<&dyn super::memory::MemoryAdapter> {
        Some(self)
    }
    fn id(&self) -> &'static str {
        "cursor"
    }
    fn name(&self) -> &'static str {
        "Cursor"
    }
    fn command(&self) -> &'static str {
        "cursor"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified `--version` contract. A desktop probe must use install
    /// evidence, and `agent` is a different product.
    fn version_identity(&self, _basename: &str, _output: &str) -> bool {
        false
    }
    fn native_installations(&self, _home: &Path) -> Vec<crate::native::adapter::Installation> {
        install::installations()
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("Cursor.exe"))
            && install::installations()
                .iter()
                .any(|item| Path::new(&item.path) == path)
    }
    fn native_binary_directories(&self, _home: &Path) -> Vec<PathBuf> {
        install::installations()
            .into_iter()
            .filter_map(|item| PathBuf::from(item.path).parent().map(Path::to_path_buf))
            .collect()
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_redacts_secrets(&self) -> bool {
        true
    }
    fn mcp_location(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<McpLocation> {
        let path = match scope {
            Scope::Global => home.join(".cursor").join("mcp.json"),
            Scope::Project => project?.join(".cursor").join("mcp.json"),
        };
        Some(McpLocation {
            path,
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        if !enabled {
            return Ok(None);
        }
        let document = match definition.transport {
            McpTransport::Stdio => mcp::stdio_doc(definition, existing),
            McpTransport::Http => mcp::http_doc(definition, existing, "headers"),
        };
        Ok(Some(Value::Object(document)))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会从当前范围的 mcp.json 移除该条目；受保护的环境变量和请求头留在本机凭据库，再次启用时写回，不进入页面或资料库")
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn skill_root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        match scope {
            Scope::Global => Some(home.join(".cursor").join("skills")),
            Scope::Project => Some(project?.join(".cursor").join("skills")),
        }
    }
    fn skill_requires_manifest(&self) -> bool {
        true
    }
    fn skill_observations(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Vec<SkillObservation> {
        let mut roots = Vec::new();
        match scope {
            Scope::Global => {
                roots.push(SkillObservation {
                    root: home.join(".cursor").join("skills-cursor"),
                    detail: "Cursor 内置 Skill，只读",
                });
                roots.push(SkillObservation {
                    root: home.join(".claude").join("skills"),
                    detail: "兼容目录，只读",
                });
                roots.push(SkillObservation {
                    root: home.join(".codex").join("skills"),
                    detail: "兼容目录，只读",
                });
                roots.push(SkillObservation {
                    root: home.join(".agents").join("skills"),
                    detail: "兼容目录，只读",
                });
            }
            Scope::Project => {
                let Some(project) = project else {
                    return roots;
                };
                for (relative, detail) in [
                    (".agents/skills", "兼容目录，只读"),
                    (".claude/skills", "兼容目录，只读"),
                    (".codex/skills", "兼容目录，只读"),
                ] {
                    roots.push(SkillObservation {
                        root: project.join(relative),
                        detail,
                    });
                }
            }
        }
        roots
    }
    fn agents(&self) -> Option<&dyn super::agents::AgentAdapter> {
        Some(self)
    }
    fn plugins(&self) -> Option<&dyn super::plugins::PluginAdapter> {
        Some(self)
    }
    fn uses_rule_catalog(&self, scope: Scope) -> bool {
        scope == Scope::Project
    }
    fn rule_file_specs(
        &self,
        scope: Scope,
        _home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<RuleFileSpec>, String> {
        if scope != Scope::Project {
            return Err(rules::GLOBAL_REASON.into());
        }
        rules::list_specs(project.ok_or("请选择项目目录")?)
    }
    fn rule_create_path(&self, project: &Path, name: &str) -> Result<PathBuf, String> {
        rules::create_path(project, name)
    }
    fn rule_relocate(&self, project: &Path, path: &Path, enabled: bool) -> Result<PathBuf, String> {
        rules::relocate(project, path, enabled)
    }
    fn rule_unavailable_reason(&self, scope: Scope) -> Option<&'static str> {
        match scope {
            Scope::Global => Some(rules::GLOBAL_REASON),
            Scope::Project => Some(rules::COMPOSE_REASON),
        }
    }
    fn rule_support(&self) -> RuleSupport {
        RuleSupport {
            global: false,
            project: true,
            global_reason: rules::GLOBAL_REASON,
            project_reason: "",
            catalog: true,
        }
    }
    fn native_files(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
        _known: bool,
    ) -> Vec<NativeFile> {
        Vec::new()
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, _role: &str) -> Result<FileKind, String> {
        Err("Cursor 没有已交付的原生配置文件角色".into())
    }
    fn connection_policy(&self, _scope: Scope) -> crate::native::adapter::ConnectionPolicy {
        crate::native::adapter::ConnectionPolicy {
            api_key: crate::native::adapter::api_key_unsupported(CONNECTION_DENIED),
            provider_address: crate::native::adapter::address_unsupported(CONNECTION_DENIED),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err(CONNECTION_DENIED.into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err(CONNECTION_DENIED.into())
    }
    fn has_native_secret(&self, _role: &str, _root: &Value) -> bool {
        false
    }
    fn inspect_values(
        &self,
        _settings: &Value,
        _local_settings: &Value,
        _models: &Value,
    ) -> InspectionFields {
        InspectionFields::default()
    }
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Desktop
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if session.is_some() {
            return Err("Cursor 桌面端没有已核对的会话恢复启动契约".into());
        }
        if matches!(mode, LaunchMode::Yolo) {
            return Err("Cursor 桌面端没有已核对的跳过审批启动参数".into());
        }
        Ok(Vec::new())
    }
    /// Official editor command: `cursor path/to/folder/`. One positional path,
    /// and only when the launcher already has a selected directory.
    fn desktop_launch_args(&self, directory: &Path) -> Result<Vec<String>, String> {
        Ok(vec![directory.display().to_string()])
    }
    fn history_sources(&self, home: &Path) -> Result<Vec<crate::history::HistorySource>, String> {
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
        home: &Path,
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
    fn history_association(&self) -> Option<Facet> {
        Some(Facet {
            state: "available",
            reason: "可从父会话打开与父 transcript 同形状的 subagents JSONL 正文；这些文件不产生用量",
        })
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://cursor.com/docs/configuration/shell",
            "Cursor 桌面编辑器请从官网安装后启动。不探测、不回退到 agent，也不提供猜测的安装命令。",
        )
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            remote: self.remote_capabilities(),
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "planned",
                reason: "Cursor 本机配置编辑尚未交付；取消勾选只改变启用偏好，不删除已有文件",
            },
            launch: Facet {
                state: "available",
                reason: "可直接启动已安装的 Cursor 桌面编辑器，不使用 agent 命令",
            },
            resume: Facet {
                state: "unsupported",
                reason: "Cursor 没有已核对的稳定会话恢复契约",
            },
            resources: Facet {
                state: "available",
                reason: "可管理项目规则、Skills、两级 MCP、子 Agent 和用户本地插件",
            },
            history: Facet {
                state: "available",
                reason: "可只读索引本机 Agent 记录。记录没有模型和 token 时，这两项保持未知，不显示 0",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: self.agents().is_some_and(|adapter| adapter.capability().supported),
                plugins: self
                    .plugins()
                    .is_some_and(|adapter| !adapter.capability().actions.is_empty()),
                project_plugins: false,
                rules: self.rule_support(),
                memory: self.published_memory(),
            },
            configuration: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::adapters::LaunchMode;
    use crate::native::adapter::Scope;

    #[test]
    fn new_profile_keeps_login_and_model_off_the_draft() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("db")).unwrap();
        let registry = crate::adapters::Registry::builtins();
        let sessions = crate::native::workspace::DraftSessions::default();
        let profile = serde_json::from_value(serde_json::json!({
            "id": "",
            "tool": "cursor",
            "name": "新配置",
            "version": 0,
            "inheritCommon": false,
            "files": {},
            "connection": null,
            "nativeCredentials": {}
        }))
        .unwrap();
        let draft = sessions
            .begin(
                &registry,
                &db,
                crate::native::workspace::ConfigurationBeginRequest {
                    tool_id: "cursor".into(),
                    scope: Scope::Global,
                    project_path: None,
                    session_id: "cursor-new".into(),
                    subject: crate::adapters::configuration::ConfigurationSubject::Profile,
                    profile: Some(profile),
                    remote_target_id: None,
                    remote_common: None, remote_files: std::collections::BTreeMap::new(),
                },
                None,
                Vec::new(),
                None,
            )
            .unwrap();
        assert!(draft.issues.is_empty(), "{:?}", draft.issues);
        assert!(draft.profile.connection.is_none());
        assert!(draft.draft_connection.is_none());
        assert!(matches!(
            draft.credential,
            Some(crate::native::workspace::ConfigurationCredential::Native)
        ));
        assert!(draft.source_capabilities.iter().any(|item| item.source == "api_key" && !item.available));
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let saved = sessions
            .save_database(&registry, &db, &keys, draft)
            .unwrap();
        let profile = saved.profile.expect("named profile");
        assert!(profile.connection.is_none());
        assert!(profile.files.is_empty());
        assert!(keys.0.lock().unwrap().is_empty());
    }

    #[test]
    fn selected_directory_is_one_positional_path() {
        let directory = Path::new("/work/demo");
        let args = Cursor.desktop_launch_args(directory).unwrap();
        assert_eq!(args, vec![directory.display().to_string()]);
        assert!(Cursor.launch_args(None, LaunchMode::Normal).unwrap().is_empty());
        assert!(Cursor.launch_args(None, LaunchMode::Yolo).is_err());
        assert!(Cursor.launch_args(Some("session"), LaunchMode::Normal).is_err());
        assert!(Cursor.install_command().is_none());
        assert!(Cursor.npm_install_command().is_none());
    }

    #[test]
    fn missing_or_recorded_probe_has_no_install_command() {
        let registry = crate::adapters::Registry::builtins();
        let probe = crate::native::adapter::probe_registered(
            &registry,
            "cursor",
            None,
            Path::new("/home/example"),
            None,
            Scope::Global,
        )
        .unwrap();
        assert!(probe.install_command.is_none());
        assert!(probe.npm_install_command.is_none());
        assert!(probe.native_install_command.is_none());
        assert!(probe.install_url.contains("cursor.com"));
        assert!(!probe.upgrade_hint.to_ascii_lowercase().contains("npm"));
        assert!(!probe.upgrade_hint.to_ascii_lowercase().contains("agent "));
        assert!(Cursor.history_supported());
        let association = Cursor.history_association().unwrap();
        assert_eq!(association.state, "available");
        assert!(!association.reason.is_empty());
        assert!(Cursor.history_sources(Path::new("/home/example")).unwrap().is_empty());
        let descriptor = registry.get("cursor").unwrap().descriptor();
        assert_eq!(descriptor.history.state, "available");
        assert!(descriptor.history.reason.contains("不显示 0"));
        assert_eq!(descriptor.resume.state, "unsupported");
        for item in &probe.installations {
            assert!(Path::new(&item.path)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("Cursor.exe")));
            assert!(!item.path.to_ascii_lowercase().contains("agent"));
        }
    }

    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::credentials::CredentialStore;
    use crate::database::Database;
    use crate::resources::mcp::{
        distribute, get_definition, list_native, preview_targets, save_definition, McpDraft,
        McpTransport,
    };
    use crate::resources::plugins::{operate, scan, PluginRequest, PluginTarget};
    use crate::resources::rules::{self, RuleTarget};
    use crate::resources::{agents, skills};

    struct MemoryStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for MemoryStore {
        fn put(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn get(&self, key: &str) -> Result<String, String> {
            self.0.lock().unwrap().get(key).cloned().ok_or_else(|| "missing".into())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct ReadFail<'a>(&'a MemoryStore);
    impl CredentialStore for ReadFail<'_> {
        fn put(&self, key: &str, value: &str) -> Result<(), String> {
            self.0.put(key, value)
        }
        fn get(&self, key: &str) -> Result<String, String> {
            if self.0.get(key).is_ok() {
                Err("无法从系统凭据服务读取".into())
            } else {
                Err("missing".into())
            }
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.delete(key)
        }
    }

    fn retained_cursor_secrets(keys: &MemoryStore) -> Vec<String> {
        keys.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, value)| id.starts_with("mcp-retain-") && value.contains("sk-test-cursor-secret"))
            .map(|(_, value)| value.clone())
            .collect()
    }

    fn write_cursor_mcp(
        db: &Database,
        keys: &dyn CredentialStore,
        home: &Path,
        definition_id: &str,
        enabled: bool,
    ) -> crate::resources::mcp::McpTargetResult {
        let registry = crate::adapters::Registry::builtins();
        let request = crate::resources::mcp::McpTargetRequest {
            context_id: None,
            tool_id: "cursor".into(),
            scope: Scope::Global,
            project_path: None,
            enabled,
            baseline_hash: None,
            allow_replace: false,
            preview_token: None,
        };
        let preview = preview_targets(db, &registry, home, definition_id, vec![request.clone()]);
        let body = format!("{:?}", preview[0]);
        assert!(!body.contains("sk-test-cursor-secret"), "{body}");
        assert_ne!(preview[0].status, "failed", "{}", preview[0].detail);
        let mut ready = request;
        ready.allow_replace = true;
        ready.baseline_hash = preview[0].baseline_hash.clone();
        ready.preview_token = preview[0].preview_token.clone();
        distribute(db, keys, &registry, home, definition_id, vec![ready])
            .into_iter()
            .next()
            .unwrap()
    }

    fn copy_fixture(from: &str, to: &Path) {
        let text = match from {
            "review.mdc" => include_str!("../../../../tests/fixtures/cursor/rules/review.mdc"),
            "notes.md" => include_str!("../../../../tests/fixtures/cursor/rules/notes.md"),
            "AGENTS.md" => include_str!("../../../../tests/fixtures/cursor/AGENTS.md"),
            "SKILL.md" => include_str!("../../../../tests/fixtures/cursor/skills/review/SKILL.md"),
            "mcp.json" => include_str!("../../../../tests/fixtures/cursor/mcp.json"),
            "helper.md" => include_str!("../../../../tests/fixtures/cursor/agents/helper.md"),
            "plugin.json" => include_str!("../../../../tests/fixtures/cursor/plugin/.cursor-plugin/plugin.json"),
            "bundled.md" => include_str!("../../../../tests/fixtures/cursor/plugin/skills/bundled/SKILL.md"),
            "hook.md" => include_str!("../../../../tests/fixtures/cursor/plugin/hooks/README.md"),
            "plugin-mcp.json" => include_str!("../../../../tests/fixtures/cursor/plugin/mcp.json"),
            _ => panic!("unknown fixture"),
        };
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(to, text).unwrap();
    }

    #[test]
    fn project_rules_keep_unknown_frontmatter_and_plain_markdown_is_inert() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let registry = crate::adapters::Registry::builtins();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join(".cursor/rules")).unwrap();
        copy_fixture("review.mdc", &project.join(".cursor/rules/review.mdc"));
        copy_fixture("notes.md", &project.join(".cursor/rules/notes.md"));
        copy_fixture("AGENTS.md", &project.join("AGENTS.md"));
        let target = RuleTarget {
            context_id: None,
            tool_id: "cursor".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            baseline_hash: None,
        };
        let files = rules::list_files(&db, &registry, temp.path(), &target).unwrap();
        let mdc = files.iter().find(|file| file.kind == "mdc").unwrap();
        let inert = files.iter().find(|file| file.kind == "inert").unwrap();
        let agents = files.iter().find(|file| file.kind == "agents").unwrap();
        assert!(mdc.text.contains("owner: kept"));
        assert!(mdc.writable && mdc.enabled);
        assert!(!inert.writable);
        assert!(inert.detail.contains("不会被"));
        assert!(agents.writable);
        let saved = rules::save_file(
            &db,
            &keys,
            &registry,
            temp.path(),
            &target,
            &mdc.path,
            &mdc.text,
            &format!("{}\nExtra line.\n", mdc.text),
        );
        assert!(saved.is_ok(), "{saved:?}");
        let again = std::fs::read_to_string(project.join(".cursor/rules/review.mdc")).unwrap();
        assert!(again.contains("owner: kept"));
        assert!(again.contains("Extra line."));
        let rejected = rules::save_file(
            &db,
            &keys,
            &registry,
            temp.path(),
            &target,
            &inert.path,
            &inert.text,
            "changed\n",
        );
        assert!(rejected.unwrap_err().contains("不会被"));
        let moved = rules::set_file_enabled(
            &db,
            &keys,
            &registry,
            temp.path(),
            &target,
            &mdc.path,
            false,
            &again,
        );
        assert!(moved.is_ok(), "{moved:?}");
        assert!(!project.join(".cursor/rules/review.mdc").exists());
        assert!(project
            .join(".cursor/.cliora-disabled-rules/review.mdc")
            .is_file());
        let global = RuleTarget {
            context_id: None,
            tool_id: "cursor".into(),
            scope: Scope::Global,
            project_path: None,
            baseline_hash: None,
        };
        let reason = rules::read_current(&db, &registry, temp.path(), &global).unwrap_err();
        assert!(reason.contains("没有已核对"));
    }

    #[test]
    fn mcp_secrets_stay_off_the_page_and_out_of_the_definition() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let registry = crate::adapters::Registry::builtins();
        let path = temp.path().join(".cursor/mcp.json");
        copy_fixture("mcp.json", &path);
        let request = crate::resources::mcp::McpTargetRequest {
            context_id: None,
            tool_id: "cursor".into(),
            scope: Scope::Global,
            project_path: None,
            enabled: true,
            baseline_hash: None,
            allow_replace: false,
            preview_token: None,
        };
        let entries = list_native(&db, &registry, temp.path(), &request).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].env.contains_key("API_TOKEN"));
        assert_eq!(entries[0].env.get("SAFE").map(String::as_str), Some("visible"));
        assert!(entries[0].protected_values);
        let definition = save_definition(
            &db,
            McpDraft {
                id: None,
                name: "local".into(),
                transport: McpTransport::Stdio,
                command: "echo".into(),
                args: vec!["ok".into()],
                url: String::new(),
                env: indexmap::IndexMap::from([
                    ("SAFE".into(), "visible".into()),
                    ("REF".into(), "${TOKEN}".into()),
                ]),
                headers: indexmap::IndexMap::new(),
                in_library: true,
                expected_version: None,
            },
        )
        .unwrap();
        let stored = serde_json::to_string(&definition).unwrap();
        assert!(!stored.contains("sk-test-cursor-secret"));
        let preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![request.clone()]);
        let body = format!("{:?}", preview[0]);
        assert!(!body.contains("sk-test-cursor-secret"), "{body}");
        let mut ready = request.clone();
        ready.allow_replace = true;
        ready.baseline_hash = preview[0].baseline_hash.clone();
        ready.preview_token = preview[0].preview_token.clone();
        let written = distribute(&db, &keys, &registry, temp.path(), &definition.id, vec![ready]);
        assert_eq!(written[0].status, "written", "{:?}", written[0]);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("sk-test-cursor-secret"));
        assert!(Cursor.native_files(Scope::Global, temp.path(), None, true).is_empty());
        let mut root: serde_json::Value = serde_json::from_str(&disk).unwrap();
        root["mcpServers"]["other"] = serde_json::json!({"command": "other", "args": []});
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let mut disable = request.clone();
        disable.enabled = false;
        let disable_preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![disable.clone()]);
        let disable_body = format!("{:?}", disable_preview[0]);
        assert!(!disable_body.contains("sk-test-cursor-secret"), "{disable_body}");
        disable.allow_replace = true;
        disable.baseline_hash = disable_preview[0].baseline_hash.clone();
        disable.preview_token = disable_preview[0].preview_token.clone();
        let removed = distribute(&db, &keys, &registry, temp.path(), &definition.id, vec![disable]);
        assert_eq!(removed[0].status, "written", "{:?}", removed[0]);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("sk-test-cursor-secret"), "{disk}");
        assert!(disk.contains("other"), "{disk}");
        assert!(!disk.contains("\"local\""), "{disk}");
        let retained: Vec<String> = keys
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, value)| id.starts_with("mcp-retain-") && value.contains("sk-test-cursor-secret"))
            .map(|(_, value)| value.clone())
            .collect();
        assert_eq!(retained.len(), 1);
        assert!(!retained[0].contains("visible"));
        let stored = get_definition(&db, &definition.id).unwrap();
        assert!(!serde_json::to_string(&stored).unwrap().contains("sk-test-cursor-secret"));
        let mut enable = request.clone();
        enable.enabled = true;
        let enable_preview = preview_targets(&db, &registry, temp.path(), &definition.id, vec![enable.clone()]);
        let enable_body = format!("{:?}", enable_preview[0]);
        assert!(!enable_body.contains("sk-test-cursor-secret"), "{enable_body}");
        enable.allow_replace = true;
        enable.baseline_hash = enable_preview[0].baseline_hash.clone();
        enable.preview_token = enable_preview[0].preview_token.clone();
        let restored = distribute(&db, &keys, &registry, temp.path(), &definition.id, vec![enable]);
        assert_eq!(restored[0].status, "written", "{:?}", restored[0]);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("sk-test-cursor-secret"), "{disk}");
        assert!(disk.contains("other"), "{disk}");
        assert!(disk.contains("visible"), "{disk}");
        let listed = list_native(&db, &registry, temp.path(), &request).unwrap();
        let local = listed.iter().find(|entry| entry.name == "local").unwrap();
        assert!(!local.env.contains_key("API_TOKEN"));
        assert!(local.protected_values);
        assert!(listed.iter().any(|entry| entry.name == "other"));
        assert!(keys.0.lock().unwrap().keys().all(|id| !id.starts_with("mcp-retain-")));
        let stored = get_definition(&db, &definition.id).unwrap();
        assert!(!serde_json::to_string(&stored).unwrap().contains("sk-test-cursor-secret"));
    }

    #[test]
    fn secretless_same_name_entry_does_not_drop_the_retained_mcp_secret() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let registry = crate::adapters::Registry::builtins();
        let path = temp.path().join(".cursor/mcp.json");
        copy_fixture("mcp.json", &path);
        let definition = save_definition(
            &db,
            McpDraft {
                id: None,
                name: "local".into(),
                transport: McpTransport::Stdio,
                command: "echo".into(),
                args: vec!["ok".into()],
                url: String::new(),
                env: indexmap::IndexMap::from([("SAFE".into(), "visible".into())]),
                headers: indexmap::IndexMap::new(),
                in_library: true,
                expected_version: None,
            },
        )
        .unwrap();
        let disabled = write_cursor_mcp(&db, &keys, temp.path(), &definition.id, false);
        assert_eq!(disabled.status, "written", "{}", disabled.detail);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("sk-test-cursor-secret"));
        assert_eq!(retained_cursor_secrets(&keys).len(), 1);

        let secretless = serde_json::json!({
            "command": "echo",
            "args": ["ok"],
            "env": { "SAFE": "visible" }
        });
        let mut root: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        root["mcpServers"]["local"] = secretless.clone();
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let disabled_again = write_cursor_mcp(&db, &keys, temp.path(), &definition.id, false);
        assert_eq!(disabled_again.status, "written", "{}", disabled_again.detail);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("\"local\""), "{disk}");
        assert!(!disk.contains("sk-test-cursor-secret"), "{disk}");
        assert_eq!(retained_cursor_secrets(&keys).len(), 1);

        root["mcpServers"]["local"] = secretless;
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let enabled = write_cursor_mcp(&db, &keys, temp.path(), &definition.id, true);
        assert_eq!(enabled.status, "written", "{}", enabled.detail);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("sk-test-cursor-secret"), "{disk}");
        assert!(disk.contains("visible"), "{disk}");
        assert!(retained_cursor_secrets(&keys).is_empty());
        let listed = list_native(
            &db,
            &registry,
            temp.path(),
            &crate::resources::mcp::McpTargetRequest {
                context_id: None,
                tool_id: "cursor".into(),
                scope: Scope::Global,
                project_path: None,
                enabled: true,
                baseline_hash: None,
                allow_replace: false,
                preview_token: None,
            },
        )
        .unwrap();
        let local = listed.iter().find(|entry| entry.name == "local").unwrap();
        assert!(!local.env.contains_key("API_TOKEN"));
        assert!(local.protected_values);
        assert!(!serde_json::to_string(&get_definition(&db, &definition.id).unwrap()).unwrap().contains("sk-test-cursor-secret"));

        let disabled = write_cursor_mcp(&db, &keys, temp.path(), &definition.id, false);
        assert_eq!(disabled.status, "written", "{}", disabled.detail);
        assert_eq!(retained_cursor_secrets(&keys).len(), 1);
        let mut root: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        root["mcpServers"]["local"] = serde_json::json!({
            "command": "echo",
            "args": ["ok"],
            "env": { "API_TOKEN": "other-secret", "SAFE": "visible" }
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let kept = write_cursor_mcp(&db, &keys, temp.path(), &definition.id, true);
        assert_eq!(kept.status, "written", "{}", kept.detail);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("other-secret"), "{disk}");
        assert!(!disk.contains("sk-test-cursor-secret"), "{disk}");
        assert_eq!(retained_cursor_secrets(&keys).len(), 1);

        root["mcpServers"].as_object_mut().unwrap().remove("local");
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();
        let failed = write_cursor_mcp(&db, &ReadFail(&keys), temp.path(), &definition.id, true);
        assert_ne!(failed.status, "written");
        assert!(failed.detail.contains("无法读取"), "{}", failed.detail);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("sk-test-cursor-secret"), "{disk}");
        assert!(!disk.contains("\"local\""), "{disk}");
        assert_eq!(retained_cursor_secrets(&keys).len(), 1);

        let cleared = save_definition(
            &db,
            McpDraft {
                id: Some(definition.id.clone()),
                name: "local".into(),
                transport: McpTransport::Stdio,
                command: "echo".into(),
                args: vec!["ok".into()],
                url: String::new(),
                env: indexmap::IndexMap::from([("API_TOKEN".into(), String::new())]),
                headers: indexmap::IndexMap::new(),
                in_library: true,
                expected_version: Some(definition.version),
            },
        )
        .unwrap();
        let removed = write_cursor_mcp(&db, &keys, temp.path(), &cleared.id, true);
        assert_eq!(removed.status, "written", "{}", removed.detail);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("sk-test-cursor-secret"), "{disk}");
        assert!(retained_cursor_secrets(&keys).is_empty());
        assert!(!serde_json::to_string(&get_definition(&db, &cleared.id).unwrap()).unwrap().contains("sk-test-cursor-secret"));
    }

    #[test]
    fn skills_and_agents_keep_compat_and_builtins_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let registry = crate::adapters::Registry::builtins();
        let project = temp.path().join("project");
        copy_fixture("SKILL.md", &project.join(".cursor/skills/review/SKILL.md"));
        std::fs::create_dir_all(project.join(".cursor/skills/loose")).unwrap();
        std::fs::write(project.join(".cursor/skills/loose/README.md"), "no manifest\n").unwrap();
        copy_fixture("SKILL.md", &project.join(".claude/skills/compat/SKILL.md"));
        copy_fixture("helper.md", &project.join(".cursor/agents/helper.md"));
        std::fs::create_dir_all(project.join(".codex/agents")).unwrap();
        std::fs::write(
            project.join(".codex/agents/compat.md"),
            "---\nname: compat\ndescription: shared\n---\n\nbody\n",
        )
        .unwrap();
        let skills = skills::scan_native(
            &db,
            &registry,
            temp.path(),
            "cursor",
            Scope::Project,
            Some(&project.display().to_string()),
        )
        .unwrap();
        assert!(skills.iter().any(|entry| entry.name == "review" && entry.state == "external"));
        assert!(skills.iter().all(|entry| entry.name != "loose"));
        let compat = skills.iter().find(|entry| entry.name == "compat").unwrap();
        assert_eq!(compat.state, "read_only");
        let rejected = skills::save_document(
            &db,
            &keys,
            &registry,
            temp.path(),
            "cursor",
            Scope::Project,
            Some(&project.display().to_string()),
            &compat.path,
            &std::fs::read_to_string(project.join(".claude/skills/compat/SKILL.md")).unwrap(),
            "changed\n",
        );
        assert!(rejected.unwrap_err().contains("只读"));
        let snapshot = agents::scan(
            &db,
            temp.path(),
            &PluginTarget {
                tool_id: "cursor".into(),
                scope: Scope::Project,
                project_path: Some(project.display().to_string()),
                context_id: None,
            },
        )
        .unwrap();
        let owned = snapshot.entries.iter().find(|entry| entry.name == "helper").unwrap();
        assert!(!owned.read_only);
        assert!(owned.content.contains("owner: kept"));
        let foreign = snapshot.entries.iter().find(|entry| entry.path.contains(".codex")).unwrap();
        assert!(foreign.read_only);
        for name in ["Explore", "Browser", "Agent"] {
            assert!(snapshot.entries.iter().any(|entry| entry.name == name && entry.read_only && entry.builtin));
        }
    }

    #[test]
    fn local_plugins_move_only_manifest_directories() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let source = temp.path().join("source-plugin");
        copy_fixture("plugin.json", &source.join(".cursor-plugin/plugin.json"));
        copy_fixture("bundled.md", &source.join("skills/bundled/SKILL.md"));
        copy_fixture("hook.md", &source.join("hooks/README.md"));
        copy_fixture("plugin-mcp.json", &source.join("mcp.json"));
        let icon = [0xff, 0xfe, 0x00, 0x80, 0xff];
        std::fs::create_dir_all(source.join("assets")).unwrap();
        std::fs::write(source.join("assets/icon.bin"), icon).unwrap();
        std::fs::create_dir_all(temp.path().join(".cursor/plugins/local/managed")).unwrap();
        std::fs::write(
            temp.path().join(".cursor/plugins/local/managed/README.md"),
            "no manifest\n",
        )
        .unwrap();
        let target = PluginTarget {
            tool_id: "cursor".into(),
            scope: Scope::Global,
            project_path: None,
            context_id: None,
        };
        let first = scan(&db, temp.path(), &target).unwrap();
        assert!(first.entries.iter().any(|entry| entry.id == "managed" && entry.read_only));
        let installed = operate(
            &db,
            &keys,
            temp.path(),
            &PluginRequest {
                target: target.clone(),
                action: "install".into(),
                source: source.display().to_string(),
                baseline: first.baseline.clone(),
                trusted: true,
            },
        )
        .unwrap();
        assert_eq!(installed.status, "local_directory_updated", "{installed:?}");
        let snapshot = installed.snapshot.unwrap();
        let entry = snapshot.entries.iter().find(|entry| entry.id == "source-plugin").unwrap();
        assert!(!entry.read_only);
        assert_eq!(
            std::fs::read(temp.path().join(".cursor/plugins/local/source-plugin/assets/icon.bin")).unwrap(),
            icon
        );
        assert!(entry.resources.iter().any(|resource| resource.kind == "skills"));
        assert!(entry.resources.iter().any(|resource| resource.kind == "hooks"));
        assert!(entry.resources.iter().any(|resource| resource.kind == "mcp"));
        let disabled = operate(
            &db,
            &keys,
            temp.path(),
            &PluginRequest {
                target: target.clone(),
                action: "disable".into(),
                source: entry.id.clone(),
                baseline: snapshot.baseline.clone(),
                trusted: false,
            },
        )
        .unwrap();
        assert_eq!(disabled.status, "local_directory_updated", "{disabled:?}");
        assert!(!temp.path().join(".cursor/plugins/local/source-plugin").exists());
        assert_eq!(
            std::fs::read(
                temp.path()
                    .join(".cursor/plugins/.cliora-disabled-plugins/source-plugin/assets/icon.bin")
            )
            .unwrap(),
            icon
        );
        assert!(temp
            .path()
            .join(".cursor/plugins/.cliora-disabled-plugins/source-plugin/.cursor-plugin/plugin.json")
            .is_file());
        let after_disable = disabled.snapshot.unwrap();
        let enabled = operate(
            &db,
            &keys,
            temp.path(),
            &PluginRequest {
                target: target.clone(),
                action: "enable".into(),
                source: "source-plugin".into(),
                baseline: after_disable.baseline,
                trusted: false,
            },
        )
        .unwrap();
        assert_eq!(enabled.status, "local_directory_updated", "{enabled:?}");
        assert_eq!(
            std::fs::read(temp.path().join(".cursor/plugins/local/source-plugin/assets/icon.bin")).unwrap(),
            icon
        );
        let removed = operate(
            &db,
            &keys,
            temp.path(),
            &PluginRequest {
                target,
                action: "uninstall".into(),
                source: "source-plugin".into(),
                baseline: enabled.snapshot.unwrap().baseline,
                trusted: false,
            },
        )
        .unwrap();
        assert_eq!(removed.status, "local_directory_updated", "{removed:?}");
        assert!(!temp.path().join(".cursor/plugins/local/source-plugin").exists());
        assert!(temp.path().join(".cursor/plugins/local/managed/README.md").is_file());
    }

    #[test]
    fn enabling_a_disabled_agent_rejects_an_external_edit() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.db")).unwrap();
        let keys = MemoryStore(Mutex::new(HashMap::new()));
        let project = temp.path().join("project");
        copy_fixture("helper.md", &project.join(".cursor/agents/helper.md"));
        let target = PluginTarget {
            tool_id: "cursor".into(),
            scope: Scope::Project,
            project_path: Some(project.display().to_string()),
            context_id: None,
        };
        let before = agents::scan(&db, temp.path(), &target).unwrap();
        let helper = before.entries.iter().find(|entry| entry.name == "helper").unwrap();
        let disabled = agents::operate(
            &db,
            &keys,
            temp.path(),
            &agents::AgentRequest {
                target: target.clone(),
                action: "disable".into(),
                id: Some(helper.id.clone()),
                name: helper.name.clone(),
                content: helper.content.clone(),
                baseline: before.baseline.clone(),
                transaction_id: None,
            },
        );
        assert!(disabled.is_ok(), "{disabled:?}");
        let parked = project.join(".cursor/.cliora-disabled-agents/agents/helper.md");
        let active = project.join(".cursor/agents/helper.md");
        assert!(parked.is_file());
        assert!(!active.exists());
        let original = std::fs::read(&parked).unwrap();
        std::fs::write(&parked, "---\nname: helper\ndescription: reviews code\nowner: kept\n---\n\nexternal edit\n").unwrap();
        let rescanned = agents::scan(&db, temp.path(), &target).unwrap();
        let parked_entry = rescanned.entries.iter().find(|entry| entry.name == "helper").unwrap();
        assert!(!parked_entry.enabled);
        assert!(parked_entry.content.contains("external edit"));
        let rejected = agents::operate(
            &db,
            &keys,
            temp.path(),
            &agents::AgentRequest {
                target: target.clone(),
                action: "enable".into(),
                id: Some(parked_entry.id.clone()),
                name: parked_entry.name.clone(),
                content: parked_entry.content.clone(),
                baseline: rescanned.baseline.clone(),
                transaction_id: None,
            },
        );
        let message = rejected.unwrap_err();
        assert!(message.contains("外部修改"), "{message}");
        assert_eq!(std::fs::read(&parked).unwrap(), b"---\nname: helper\ndescription: reviews code\nowner: kept\n---\n\nexternal edit\n");
        assert!(!active.exists());
        std::fs::write(&parked, &original).unwrap();
        let restored = agents::scan(&db, temp.path(), &target).unwrap();
        let parked_entry = restored.entries.iter().find(|entry| entry.name == "helper").unwrap();
        let enabled = agents::operate(
            &db,
            &keys,
            temp.path(),
            &agents::AgentRequest {
                target,
                action: "enable".into(),
                id: Some(parked_entry.id.clone()),
                name: parked_entry.name.clone(),
                content: parked_entry.content.clone(),
                baseline: restored.baseline,
                transaction_id: None,
            },
        );
        assert!(enabled.is_ok(), "{enabled:?}");
        assert!(active.is_file());
        assert!(!parked.exists());
        assert_eq!(std::fs::read(&active).unwrap(), original);
    }
}
