//! Cursor IDE 3.x: desktop launch, IDE JSONC settings, file-based MCP and Skills.
//! Agent CLI, private state/auth databases and remote/plugin MCP are not adopted.
mod configuration;
mod install;
mod paths;
use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode,
    ManagementCapabilities, McpLocation,
};
use crate::credentials::CredentialStore;
use crate::native::{
    adapter::{self, NativeFile, Scope},
    apply::NativeSecrets,
    format::FileKind,
    profile::{Connection, RegisteredProfile},
};
use crate::resources::mcp::{self, McpDefinition, McpTransport};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
pub struct CursorIde;

impl CliAdapter for CursorIde {
    fn id(&self) -> &'static str {
        "cursor_ide"
    }
    fn name(&self) -> &'static str {
        "Cursor IDE"
    }
    fn command(&self) -> &'static str {
        "cursor"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    fn version_identity(&self, _: &str, _: &str) -> bool {
        false
    }
    fn native_installations(&self, home: &Path) -> Vec<adapter::Installation> {
        install::installations(home)
    }
    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        install::marker(path).is_ok()
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://cursor.com/downloads",
            "安装 Cursor IDE 桌面应用；agent 命令不代表 IDE 已安装。更新使用客户端内置更新。",
        )
    }
    fn launch_form(&self) -> LaunchForm {
        LaunchForm::Desktop
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if session.is_some() || mode != LaunchMode::Normal {
            return Err("Cursor IDE 未提供已验证的会话恢复或 YOLO 启动能力".into());
        }
        Ok(Vec::new())
    }
    fn explicitly_incompatible_native_version(&self, version: &str) -> bool {
        !semver::Version::parse(version).is_ok_and(|v| v.major == 3)
    }
    fn configuration(&self) -> Option<&dyn super::configuration::ConfigurationAdapter> {
        Some(self)
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        match paths::settings(home, scope, project) {
            Ok(path) => vec![file("settings", path, FileKind::Jsonc, known, Some("Cursor IDE 默认 Profile 设置；项目使用 .vscode/settings.json。额外 --user-data-dir/--profile 启动实例不自动推断。"), false)],
            Err(_) => Vec::new(),
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Jsonc)
        } else {
            Err("Cursor IDE 没有此配置角色；不管理 CLI 配置或凭据数据库".into())
        }
    }
    fn validate_draft(&self, role: &str, root: &Value) -> Result<(), String> {
        self.file_kind(role)?;
        if !root.is_object() {
            return Err("Cursor IDE settings.json 必须是 JSONC 对象".into());
        }
        configuration::reject_secrets(root)?;
        configuration::validate_settings(root)
    }
    fn portable_root_fields(&self, _: &str) -> &'static [&'static str] {
        configuration::FIELDS
    }
    fn connection_policy(&self, _: Scope) -> adapter::ConnectionPolicy {
        adapter::ConnectionPolicy {
            api_key: adapter::api_key_unsupported("Cursor IDE 账号及 API 凭据由客户端管理"),
            provider_address: adapter::address_unsupported(
                "IDE settings.json 不是 Agent CLI 配置，不提供 API 连接映射",
            ),
            projection: "single_connection",
        }
    }
    fn connection_documents(
        &self,
        _: &Connection,
        _: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Cursor IDE 不提供 API 连接映射".into())
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        _: Scope,
        _: &dyn CredentialStore,
        _: &mut NativeSecrets,
    ) -> Result<(), String> {
        if profile.connection.is_none()
            && profile.native_credentials.is_empty()
            && profile.authentication == crate::native::profile::ProfileAuthentication::Native
        {
            Ok(())
        } else {
            Err("Cursor IDE 凭据由客户端管理".into())
        }
    }
    fn has_native_secret(&self, _: &str, root: &Value) -> bool {
        configuration::reject_secrets(root).is_err()
    }
    fn inspect_values(&self, _: &Value, _: &Value, _: &Value) -> InspectionFields {
        InspectionFields::default()
    }
    fn supports_mcp(&self) -> bool {
        true
    }
    fn mcp_requires_version(&self) -> bool {
        true
    }
    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        Some(McpLocation {
            path: match scope {
                Scope::Global => home,
                Scope::Project => project?,
            }
            .join(".cursor/mcp.json"),
            kind: FileKind::Json,
            root: "mcpServers",
            child: None,
        })
    }
    fn mcp_location_for_version(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        version: Option<&str>,
    ) -> Option<McpLocation> {
        version
            .filter(|v| !self.explicitly_incompatible_native_version(v))
            .and_then(|_| self.mcp_location(scope, home, project))
    }
    fn mcp_entries(
        &self,
        root: &Value,
        _: &McpLocation,
    ) -> Result<serde_json::Map<String, Value>, String> {
        let object = root.as_object().ok_or("Cursor mcp.json 必须是对象")?;
        match object.get("mcpServers") {
            None => Ok(serde_json::Map::new()),
            Some(value) => value
                .as_object()
                .cloned()
                .ok_or("Cursor mcpServers 必须是对象".into()),
        }
    }
    fn mcp_is_reference(&self, value: &str) -> bool {
        let value = value.strip_prefix("Bearer ").unwrap_or(value);
        value
            .strip_prefix("${env:")
            .and_then(|tail| tail.strip_suffix('}'))
            .is_some_and(|name| {
                let mut bytes = name.bytes();
                bytes
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                    && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
    }
    fn mcp_decode(
        &self,
        name: &str,
        entry: &Value,
    ) -> Result<super::mcp_codec::DecodedMcp, String> {
        if entry.get("command").is_some_and(|v| !v.is_string()) {
            return Err("Cursor IDE MCP command 必须是字符串".into());
        }
        if [
            "enabled",
            "disabled",
            "environment",
            "http_headers",
            "transport",
        ]
        .iter()
        .any(|key| entry.get(key).is_some())
        {
            return Err(
                "Cursor IDE 不读取此 MCP 状态或连接字段；请使用原生字段，停用由移除/恢复管理"
                    .into(),
            );
        }
        let mut decoded = super::mcp_codec::decode(name, entry)?;
        if entry.get("type").is_some() {
            decoded.unmapped_fields.push("type".into());
        }
        Ok(decoded)
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
        Ok(Some(Value::Object(match definition.transport {
            McpTransport::Stdio => {
                mcp::stdio_doc_with_reference(definition, existing, "env", &|value| {
                    self.mcp_is_reference(value)
                })
            }
            McpTransport::Http => {
                mcp::http_doc_with_reference(definition, existing, "headers", &|value| {
                    self.mcp_is_reference(value)
                })
            }
        })))
    }
    fn mcp_disabled_description(&self) -> Option<&'static str> {
        Some("停用会从 mcp.json 移除条目并由栖点保留恢复资料；不修改 Cursor 私有启停与授权状态")
    }
    fn supports_skills(&self) -> bool {
        true
    }
    fn validate_skill_write(&self, home: &Path) -> Result<(), String> {
        if install::installations(home).iter().any(|i| {
            i.status == "available"
                && i.version
                    .as_deref()
                    .is_some_and(|v| !self.explicitly_incompatible_native_version(v))
        }) {
            Ok(())
        } else {
            Err("未确认兼容的 Cursor IDE 安装标记，已停止 Skills 写入".into())
        }
    }
    fn skill_root(&self, scope: Scope, home: &Path, project: Option<&Path>) -> Option<PathBuf> {
        Some(
            match scope {
                Scope::Global => home,
                Scope::Project => project?,
            }
            .join(".cursor/skills"),
        )
    }
    fn skill_read_roots(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Vec<super::SkillReadRoot> {
        let Some(base) = (match scope {
            Scope::Global => Some(home),
            Scope::Project => project,
        }) else {
            return Vec::new();
        };
        [
            ("agents", ".agents/skills"),
            ("claude", ".claude/skills"),
            ("codex", ".codex/skills"),
            ("cursor_builtin", ".cursor/skills-cursor"),
        ]
        .into_iter()
        .map(|(id, path)| super::SkillReadRoot {
            id,
            path: base.join(path),
            reason: "Cursor 兼容或内置来源，只读浏览；安装与修改使用 .cursor/skills",
        })
        .collect()
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor { id: self.id(), name: self.name(), configuration: self.configuration().map(|p| p.describe(Scope::Global)), interface_formats: &[], project_model_override: false, yolo_available: false, launch_form: self.launch_form(), launch_directory: self.launch_directory(),
            native_config: Facet { state: "available", reason: "IDE 默认 Profile 与项目 settings.json（JSONC），保留未知设置；不接管账号或 Agent CLI 配置" },
            launch: Facet { state: "available", reason: "直接启动已安装的 Cursor IDE；目录工作区尚无 cold/warm 实测证据，暂不提供目录启动" },
            resume: Facet { state: "unsupported", reason: "未验证 IDE 精确会话恢复" }, resources: Facet { state: "available", reason: "用户/项目 .cursor/mcp.json 与 .cursor/skills；兼容及内置 Skill 来源只读，团队/扩展 MCP 由 IDE 管理" },
            history: Facet { state: "unsupported", reason: "不读取 IDE 私有会话与认证数据库" }, login: None,
            management: ManagementCapabilities { accounts: false, mcp: true, skills: true, agents: false, plugins: false, project_plugins: false, rules: self.rule_support() } }
    }
}
#[cfg(test)]
#[path = "../../../../tests/adapter/cursor-ide.rs"]
mod tests;
