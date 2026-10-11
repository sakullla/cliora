//! MiniMax Code CLI (`mcode`), registered default-off.
//!
//! The stable id is `minimax_code`. It is not the `minimax` quota provider,
//! not `mimo_code`, and not the desktop or `mmx` products. Version output is
//! not yet verified, so the shared probe must not treat a binary as installed.
//! Cancelling the preference does not delete local MiniMax files.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::{
    AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode,
    ManagementCapabilities, RuleSupport,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};

pub struct MiniMaxCode;

const CONNECTION_DENIED: &str = "MiniMax Code 的原生连接尚未交付，额度查询仍使用供应商 minimax";

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
        ""
    }
    /// No verified `mcode --version` transcript yet. Do not accept `mmx` or a
    /// guessed version string as this CLI.
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
        Err("MiniMax Code 没有已交付的原生配置文件角色".into())
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
        LaunchForm::Terminal
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if session.is_some() {
            return Err("MiniMax Code 没有已核对的会话恢复参数".into());
        }
        if matches!(mode, LaunchMode::Yolo) {
            return Err("MiniMax Code 没有已核对的交互式全权限参数".into());
        }
        Ok(Vec::new())
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://agent.minimax.io/docs/cli/configuration",
            "MiniMax Code CLI 的命令是 mcode。未找到时只显示官方说明和重新检查，不提供桌面端、mmx 或 npm 安装命令。",
        )
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "planned",
                reason: "MiniMax Code 的 config.yaml 编辑尚未交付；取消勾选只改变启用偏好，不删除已有文件",
            },
            launch: Facet {
                state: "available",
                reason: "可在外部终端启动 mcode；不恢复会话，也不提供 YOLO",
            },
            resume: Facet {
                state: "unsupported",
                reason: "MiniMax Code 的 --continue 与 --session 恢复尚未交付",
            },
            resources: Facet {
                state: "planned",
                reason: "规则、MCP 与本地插件尚未按已核对契约交付",
            },
            history: Facet {
                state: "unsupported",
                reason: "没有已核对的会话索引格式",
            },
            login: None,
            management: ManagementCapabilities {
                accounts: false,
                mcp: false,
                skills: false,
                agents: false,
                plugins: false,
                project_plugins: false,
                rules: RuleSupport {
                    global: false,
                    project: false,
                },
            },
            configuration: None,
        }
    }
}
