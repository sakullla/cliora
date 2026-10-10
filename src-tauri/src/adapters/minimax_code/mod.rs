//! MiniMax Code 0.6.x native configuration and resources, verified at 0.6.7.
mod configuration;
mod paths;
mod resources;
use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode,
    ManagementCapabilities,
};
use crate::{
    credentials::CredentialStore,
    native::{
        adapter::{self, NativeFile, Scope},
        apply::NativeSecrets,
        format::{self, FileKind},
        profile::{Connection, RegisteredProfile},
    },
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub struct MiniMaxCode;

impl CliAdapter for MiniMaxCode {
    fn id(&self) -> &'static str {
        "minimax_code"
    }
    fn name(&self) -> &'static str {
        "MiniMax Code"
    }
    fn command(&self) -> &'static str {
        "mcode"
    }
    fn npm_package(&self) -> &'static str {
        "@minimax-ai/code"
    }
    fn npm_script_dependencies(&self) -> &'static [&'static str] {
        &["better-sqlite3", "@vscode/ripgrep"]
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        basename == "mcode" && semver::Version::parse(output.trim().trim_start_matches('v')).is_ok()
    }
    fn explicitly_incompatible_native_version(&self, version: &str) -> bool {
        !semver::Version::parse(version.trim().trim_start_matches('v'))
            .is_ok_and(|v| v.major == 0 && v.minor >= 6)
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 19, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "MiniMax Code 0.6.7 要求 Node 22.19+（22.x）或 24–26；不支持 Node 23/27"
    }
    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".minimax-code/bin")]
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        ("https://www.npmjs.com/package/@minimax-ai/code", "安装 @minimax-ai/code 后使用 mcode；.minimax-code 为安装目录，用户配置在 .minimax 或显式数据目录。")
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if mode != LaunchMode::Normal {
            return Err("MiniMax Code 未开放跳审批启动；可在客户端配置权限模式".into());
        }
        if let Some(home) = dirs::home_dir() {
            paths::root(&home)?;
        }
        Ok(session
            .map(|id| vec!["--session".into(), id.into()])
            .unwrap_or_default())
    }
    fn session_env_markers(&self) -> &'static [&'static str] {
        &[
            "__MAVIS_RUNTIME_SESSION_ID",
            "__MAVIS_RUNTIME_AGENT_NAME",
            "__MAVIS_RUNTIME_DAEMON_URL",
            "__MAVIS_PARENT_DAEMON_URL",
            "__MAVIS_PARENT_SESSION_ID",
            "__MAVIS_PARENT_AGENT_NAME",
            "__MAVIS_PARENT_ACCESS_TOKEN",
            "__MAVIS_PARENT_AUTH_SECRET",
            "MAVIS_ACCESS_TOKEN",
        ]
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
        match paths::root(home) {
            Ok(root) => vec![file("settings", root.join("config.yaml"), FileKind::Yaml, known, Some("用户级 config.yaml；官方登录文件由 mcode 管理。--data-dir/--profile 的额外运行实例不自动推断。"), false)],
            Err(_) => vec![file("settings", home.join(".minimax/config.yaml"), FileKind::Yaml, false, Some("MiniMax 数据目录覆盖无效；请改用绝对路径"), false)],
        }
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Yaml)
        } else {
            Err("MiniMax Code 仅管理 config.yaml".into())
        }
    }
    fn validate_role_scope(&self, _: &str, scope: Scope) -> Result<(), String> {
        if scope == Scope::Global {
            Ok(())
        } else {
            Err("MiniMax Code 模型配置仅支持用户级；项目 MCP/Skills 请使用资源页".into())
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "anthropic_messages",
            "openai_completions",
            "openai_responses",
        ]
    }
    fn connection_policy(&self, scope: Scope) -> adapter::ConnectionPolicy {
        if scope == Scope::Global {
            adapter::ConnectionPolicy {
                api_key: adapter::api_key_writable(),
                provider_address: adapter::address_configurable(),
                projection: "single_connection",
            }
        } else {
            adapter::ConnectionPolicy {
                api_key: adapter::api_key_unsupported("MiniMax API key 只写用户 config.yaml"),
                provider_address: adapter::address_unsupported("项目配置不包含模型连接"),
                projection: "single_connection",
            }
        }
    }
    fn auth_env_name(&self, _: &Connection) -> Option<String> {
        None
    }
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        Some(self)
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        self.validate_role_scope("settings", scope)?;
        let root = configuration::connection_document(connection)?;
        Ok(BTreeMap::from([("settings".into(), root)]))
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        self.validate_role_scope("settings", scope)?;
        configuration::connection_document(connection)?;
        if let Some(id) = &connection.secret_ref {
            let path = configuration::key_path(&connection.provider_id)?;
            let path: Vec<_> = path.iter().map(String::as_str).collect();
            secrets.put(
                "settings",
                &path,
                crate::native::apply::read_secret(id, credentials)?,
            );
        }
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && (root
                .pointer("/minimax_api/apiKey")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                || root
                    .get("custom_provider")
                    .and_then(Value::as_object)
                    .is_some_and(|providers| {
                        providers.values().any(|p| {
                            p.pointer("/options/apiKey")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty())
                        })
                    }))
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let Ok(Some(connection)) = configuration::read_connection(settings) else {
            return InspectionFields::default();
        };
        InspectionFields {
            provider: Some(connection.provider_id),
            model: Some(connection.model),
            base: Some(connection.base_url),
            wire: configuration::wire(&connection.interface_format),
            ..Default::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut crate::native::intake::NativeInspection,
        pending: &mut super::PendingSecrets,
        _: &mut super::NativeCredentialRefs,
    ) -> Result<(), String> {
        let Some(text) = files.get("settings").cloned() else {
            return Ok(());
        };
        let mut root = format::parse(FileKind::Yaml, &text)?;
        // Official provider/auth is product-owned. Do not adopt login tokens,
        // or modify these native subtrees when applying a settings profile.
        if let Some(map) = root.as_object_mut() {
            map.remove("provider");
        }
        let active = found
            .connection
            .as_ref()
            .map(|c| configuration::key_path(&c.provider_id))
            .transpose()?;
        let mut paths = vec![vec!["minimax_api".into(), "apiKey".into()]];
        if let Some(providers) = root.get("custom_provider").and_then(Value::as_object) {
            paths.extend(providers.keys().map(|id| {
                vec![
                    "custom_provider".into(),
                    id.clone(),
                    "options".into(),
                    "apiKey".into(),
                ]
            }));
        }
        for path in paths {
            let pointer = super::configuration::location_pointer(&path);
            let Some(secret) = root
                .pointer(&pointer)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
            else {
                continue;
            };
            if active.as_ref() != Some(&path) {
                return Err("MiniMax 非当前 BYOK 连接包含密钥；请在 mcode 中选择该连接后再接入，原文件未更改".into());
            }
            let id = format!("connection-{}", uuid::Uuid::new_v4());
            found.connection.as_mut().unwrap().secret_ref = Some(id.clone());
            pending.push((id, secret));
            let rendered = format::render(FileKind::Yaml, &root)?;
            root = format::parse(
                FileKind::Yaml,
                &format::set_path(FileKind::Yaml, &rendered, &path, None)?,
            )?;
        }
        files.insert("settings".into(), format::render(FileKind::Yaml, &root)?);
        Ok(())
    }
    fn validate_draft(&self, role: &str, root: &Value) -> Result<(), String> {
        self.file_kind(role)?;
        crate::native::profile::reject_plaintext_secrets(root)?;
        configuration::validate(root)
    }
    fn portable_root_fields(&self, _: &str) -> &'static [&'static str] {
        &[
            "defaultModel",
            "defaultLightModel",
            "defaultModelVariant",
            "minimaxModelSource",
            "minimax_api",
            "custom_provider",
            "permissionMode",
            "skills",
            "notifications",
            "tui",
            "logLevel",
        ]
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_requires_version(&self) -> bool {
        true
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<super::McpLocation> {
        resources::location(scope, home, project)
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        version: Option<&str>,
    ) -> Option<super::McpLocation> {
        version
            .filter(|v| !self.explicitly_incompatible_native_version(v))
            .and_then(|_| resources::location(scope, home, project))
    }
    fn mcp_render_entry(
        &self,
        location: &super::McpLocation,
        name: &str,
        entry: Value,
    ) -> Result<String, String> {
        format::render(location.kind, &json!({"mcpServers":{name:entry}}))
    }
    fn mcp_entries(
        &self,
        parsed: &Value,
        _: &super::McpLocation,
    ) -> Result<serde_json::Map<String, Value>, String> {
        resources::entries(parsed)
    }
    fn mcp_decode(
        &self,
        name: &str,
        entry: &Value,
    ) -> Result<super::mcp_codec::DecodedMcp, String> {
        resources::decode(name, entry)
    }
    fn mcp_entry_view(&self, entry: &Value) -> Value {
        let mut value = entry.clone();
        if value["configured"] == false {
            value["enabled"] = json!(false);
        }
        value
    }
    fn mcp_document_at(
        &self,
        definition: &crate::resources::mcp::McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
        location: &super::McpLocation,
    ) -> Result<Option<Value>, String> {
        resources::document(self, definition, enabled, existing, location)
    }
    fn mcp_change(
        &self,
        parsed: &Value,
        _: &super::McpLocation,
        name: &str,
        value: Option<Value>,
    ) -> Result<crate::native::transaction::FieldChange, String> {
        resources::change(parsed, name, value)
    }
    fn mcp_is_reference(&self, value: &str) -> bool {
        resources::is_reference(value)
    }
    fn mcp_is_reference_at(&self, value: &str, scope: Scope) -> bool {
        scope == Scope::Project && resources::is_reference(value)
    }
    fn mcp_reference_fragments_at(
        &self,
        value: &str,
        scope: Option<Scope>,
    ) -> Result<Vec<String>, String> {
        let fragments = self.mcp_reference_fragments(value);
        match scope {
            Some(Scope::Global) => Ok(vec![]),
            Some(Scope::Project) => Ok(fragments),
            None if fragments.is_empty() => Ok(fragments),
            None => Err(
                "MiniMax 引用来源缺少用户/项目范围，无法保证插值语义；请从原生范围重新导入".into(),
            ),
        }
    }
    fn skill_root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        paths::skill_root(scope, home, project)
    }
    fn skill_read_roots(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Vec<super::SkillReadRoot> {
        paths::skill_sources(scope, home, project)
    }
    fn validate_skill_write(&self, home: &Path) -> Result<(), String> {
        paths::config(home).map(|_| ())
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor { id: self.id(), name: self.name(), interface_formats: self.interface_formats(), configuration: self.configuration().map(|p| p.describe(Scope::Global)), project_model_override: false, yolo_available: false, launch_form: self.launch_form(), launch_directory: self.launch_directory(),
            native_config: Facet { state: "available", reason: "config.yaml：官方登录由 mcode 管理，MiniMax API 与自定义 BYOK 使用独立字段" },
            launch: Facet { state: "available", reason: "在所选工作目录启动 mcode；数据目录覆盖与安装目录分开处理" },
            resume: Facet { state: "available", reason: "使用 mcode --session <id> 恢复原生会话" }, history: Facet { state: "unsupported", reason: "本次不接入原生历史和用量" },
            resources: Facet { state: "available", reason: "全局 mcp.json / 项目 .mcp.json；用户 Skills 可写，外部及内置来源只读；内嵌非文件 Skill 由客户端管理" }, login: None,
            management: ManagementCapabilities { accounts: false, mcp: true, skills: true, agents: false, plugins: false, project_plugins: false, rules: self.rule_support() } }
    }
}
#[cfg(test)]
#[path = "../../../../tests/adapter/minimax-code.rs"]
mod tests;
