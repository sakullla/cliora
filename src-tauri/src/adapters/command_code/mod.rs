//! Command Code (`cmd`/`cmdc`) adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `command_code`.
//! This scaffold records only the verified evidence: the official command
//! (`cmd`, published as the `cmdc` alias on Windows because the bare name
//! collides with the system shell) and the documented global config files
//! `~/.commandcode/config.json` + `settings.json`. Every capability dimension
//! stays honestly undeclared until the dedicated adapter task delivers
//! verified contracts. `auth.json` holds the login/subscription token and is
//! never read or written; BYOK stays with the product.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;

use super::{
    file, AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchMode, ManagementCapabilities,
    RuleSupport,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::profile::{Connection, RegisteredProfile};

pub struct CommandCode;

impl CliAdapter for CommandCode {
    fn id(&self) -> &'static str {
        "command_code"
    }
    fn name(&self) -> &'static str {
        "Command Code"
    }
    /// The product command is `cmd`; the official Windows shim resolves through
    /// the `cmdc` alias so PATH probing never matches the system shell.
    fn command(&self) -> &'static str {
        if cfg!(windows) {
            "cmdc"
        } else {
            "cmd"
        }
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified `--version` transcript exists yet; identity accepts the
    /// documented names only with a bare semver response (a `cmdc`-named
    /// output), keeping the Windows `cmd.exe` collision out of scope.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        let name = basename == "cmdc" || basename.starts_with("cmdc-")
            || (!cfg!(windows) && basename == "cmd");
        name && (output.contains("cmdc")
            || semver::Version::parse(output.trim().trim_start_matches('v')).is_ok())
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        _project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        if scope != Scope::Global {
            return Vec::new();
        }
        vec![
            file(
                "config",
                home.join(".commandcode").join("config.json"),
                FileKind::Json,
                known,
                Some("Command Code 全局 config.json；auth.json 含登录令牌，绝不读写；providers.json BYOK 不接管"),
                false,
            ),
            file(
                "settings",
                home.join(".commandcode").join("settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            ),
        ]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if matches!(role, "config" | "settings") {
            Ok(FileKind::Json)
        } else {
            Err("Command Code 此原生配置文件角色暂不交付，由后续适配任务实现".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Command Code 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Command Code 凭据管理暂不交付，由后续适配任务实现".into())
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
        Err("Command Code 启动暂不交付，由后续适配任务实现".into())
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone binary.
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "",
            "Command Code 经官方渠道安装；Windows 以 cmdc 别名解析实际 shim。各能力维度由后续适配任务交付。",
        )
    }
    fn install_command(&self) -> Option<String> {
        None
    }
    fn descriptor(&self) -> AdapterDescriptor {
        AdapterDescriptor {
            id: self.id(),
            configuration: None,
            name: self.name(),
            interface_formats: self.interface_formats(),
            project_model_override: false,
            yolo_available: false,
            launch_form: self.launch_form(),
            native_config: Facet {
                state: "planned",
                reason: "已登记 ~/.commandcode config.json/settings.json 官方路径；编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "Command Code 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Command Code 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Command Code 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Command Code 会话索引与用量统计暂不交付，由后续适配任务实现",
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_accepts_only_the_official_names() {
        assert!(CommandCode.version_identity("cmdc", "1.73.4"));
        assert!(CommandCode.version_identity("cmdc", "cmdc 1.73.4"));
        assert!(!CommandCode.version_identity("cmdc", "claude 2.1.283"));
        assert!(!CommandCode.version_identity("other", "1.73.4"));
        if !cfg!(windows) {
            assert!(CommandCode.version_identity("cmd", "1.73.4"));
        }
        // The Windows system shell (basename `cmd`) never verifies identity
        // through generic help output.
        assert!(!CommandCode.version_identity(
            "cmd",
            "starts a new instance of the windows command interpreter"
        ));
    }

    #[test]
    fn native_files_map_the_documented_config_only() {
        let home = Path::new("/home/example");
        let global = CommandCode.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 2);
        assert_eq!(global[0].role, "config");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".commandcode/config.json"));
        assert!(global[1]
            .path
            .replace('\\', "/")
            .ends_with(".commandcode/settings.json"));
        // Credential files never enter the managed surface.
        assert!(global.iter().all(|item| !item.path.contains("auth.json")));
        assert!(global
            .iter()
            .all(|item| !item.path.contains("providers.json")));
        assert!(CommandCode
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(CommandCode.file_kind("config").unwrap(), FileKind::Json);
        assert_eq!(CommandCode.file_kind("settings").unwrap(), FileKind::Json);
        assert!(CommandCode.file_kind("auth").is_err());
        assert!(!CommandCode.node_required_when_missing());
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!CommandCode.history_supported());
        assert!(!CommandCode.supports_mcp());
        assert!(!CommandCode.supports_skills());
        assert!(CommandCode.configuration().is_none());
        assert!(CommandCode.agents().is_none());
        assert!(CommandCode.plugins().is_none());
        assert!(CommandCode.accounts().is_none());
        assert!(CommandCode.official_usage().is_none());
        assert!(CommandCode
            .launch_args(None, LaunchMode::Normal)
            .is_err());
        let descriptor = CommandCode.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "command_code 的 {dimension}");
            assert!(!facet.reason.trim().is_empty());
        }
        assert!(descriptor.login.is_none());
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.mcp);
        assert!(!descriptor.management.skills);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.rules.global);
        assert!(!descriptor.management.rules.project);
        assert!(!descriptor.yolo_available);
    }
}
