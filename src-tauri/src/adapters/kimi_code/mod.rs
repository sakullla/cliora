//! Kimi Code (Moonshot AI) CLI adapter stub.
//!
//! Registered with the non-enumerated stable id `kimi_code` so the settings page
//! can list and manage it through the existing unknown-id channel. Every
//! capability is honestly undeclared: detection, native config editing, launch,
//! resources and history stay unplanned until the dedicated adapter task
//! replaces this stub with verified evidence. Nothing here may imply support
//! that does not exist yet.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::{AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};

pub struct KimiCode;

impl CliAdapter for KimiCode {
    fn id(&self) -> &'static str {
        "kimi_code"
    }
    fn name(&self) -> &'static str {
        "Kimi Code"
    }
    fn command(&self) -> &'static str {
        "kimi"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified version output exists yet; detection is owned by the future
    /// adapter task.
    fn version_identity(&self, _basename: &str, _output: &str) -> bool {
        false
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
        Err("Kimi Code 原生配置编辑面暂不交付，由后续适配器任务实现".into())
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Kimi Code 连接配置写入暂不交付，由后续适配器任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Kimi Code 凭据管理暂不交付，由后续适配器任务实现".into())
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
    fn launch_args(
        &self,
        _session: Option<&str>,
        _mode: LaunchMode,
    ) -> Result<Vec<String>, String> {
        Err("Kimi Code 启动暂不交付，由后续适配器任务实现".into())
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://kimi.com/code/docs",
            "Kimi Code 适配暂未交付；请参考官方文档安装。",
        )
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn npm_install_command(&self) -> Option<String> {
        None
    }
    fn upgrade_command(&self, _source: &str) -> Option<String> {
        None
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: false,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "planned",
                reason: "Kimi Code 原生配置编辑面暂不交付，由后续适配器任务实现",
            },
            launch: Facet {
                state: "planned",
                reason: "Kimi Code 启动暂不交付，由后续适配器任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Kimi Code 会话恢复暂不交付，由后续适配器任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Kimi Code 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配器任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Kimi Code 会话浏览与 token 用量统计暂不交付，由后续适配器任务实现",
            },
            login: None,
            management: super::ManagementCapabilities {
                accounts: false,
                mcp: false,
                skills: false,
                agents: false,
                plugins: false,
                project_plugins: false,
            },
        }
    }
}
