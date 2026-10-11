//! Cursor desktop editor, registered default-off.
//!
//! The stable id is `cursor` and the command is the editor `cursor`. This
//! adapter does not detect or fall back to `agent`. A selected project or
//! session directory is one positional path. A direct launch passes none.
//! Cancelling the preference does not delete local Cursor files.

mod install;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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

pub struct Cursor;

const CONNECTION_DENIED: &str = "Cursor 不提供供应商、请求地址、登录或模型连接";

impl CliAdapter for Cursor {
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
                state: "planned",
                reason: "规则、Skills、MCP、子 Agent 与本地插件尚未按已核对契约交付",
            },
            history: Facet {
                state: "unsupported",
                reason: "没有已核对的、不接触登录凭证的稳定会话格式",
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::adapters::LaunchMode;
    use crate::native::adapter::Scope;

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
        for item in &probe.installations {
            assert!(Path::new(&item.path)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("Cursor.exe")));
            assert!(!item.path.to_ascii_lowercase().contains("agent"));
        }
    }
}
