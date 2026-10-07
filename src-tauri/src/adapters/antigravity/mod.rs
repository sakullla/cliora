//! Antigravity CLI (Google, `agy`) adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `antigravity`.
//! This scaffold records only the verified evidence: the official `agy`
//! command (installed at `%LOCALAPPDATA%\agy\bin` by the official
//! install.ps1) and the documented settings file
//! `~/.gemini/antigravity-cli/settings.json`. Every capability dimension
//! stays honestly undeclared until the dedicated adapter task delivers
//! verified contracts. OS-keyring login state is never adopted or logged out;
//! only the headless `GEMINI_API_KEY` channel may enter managed credentials
//! once that task delivers it.

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

pub struct Antigravity;

impl CliAdapter for Antigravity {
    fn id(&self) -> &'static str {
        "antigravity"
    }
    fn name(&self) -> &'static str {
        "Antigravity"
    }
    fn command(&self) -> &'static str {
        "agy"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "agy" || basename.starts_with("agy-"))
            && (output.contains("agy")
                || output.contains("antigravity")
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
        vec![file(
            "settings",
            home.join(".gemini").join("antigravity-cli").join("settings.json"),
            FileKind::Json,
            known,
            Some("Antigravity CLI（agy）设置；keyring 登录态不接管，headless GEMINI_API_KEY 由后续适配任务交付"),
            false,
        )]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Json)
        } else {
            Err("Antigravity 此原生配置文件角色暂不交付，由后续适配任务实现".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Antigravity 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Antigravity 凭据管理暂不交付，由后续适配任务实现".into())
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
        Err("Antigravity 启动暂不交付，由后续适配任务实现".into())
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone binary.
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://antigravity.google",
            "Antigravity CLI（agy）经官方 install.ps1 安装；各能力维度由后续适配任务交付。",
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
                reason: "已登记 ~/.gemini/antigravity-cli/settings.json 官方路径；编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "Antigravity 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Antigravity 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Antigravity 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Antigravity 会话索引与用量统计暂不交付，由后续适配任务实现",
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
    fn identity_accepts_only_the_official_command_name() {
        assert!(Antigravity.version_identity("agy", "1.3.1"));
        assert!(Antigravity.version_identity("agy", "antigravity 1.3.1"));
        assert!(!Antigravity.version_identity("agy", "claude 2.1.283"));
        assert!(!Antigravity.version_identity("other", "1.3.1"));
    }

    #[test]
    fn native_files_map_the_documented_settings_only() {
        let home = Path::new("/home/example");
        let global = Antigravity.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with(".gemini/antigravity-cli/settings.json")
        );
        assert!(Antigravity
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Antigravity.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Antigravity.file_kind("config").is_err());
        assert!(!Antigravity.node_required_when_missing());
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!Antigravity.history_supported());
        assert!(!Antigravity.supports_mcp());
        assert!(!Antigravity.supports_skills());
        assert!(Antigravity.configuration().is_none());
        assert!(Antigravity.agents().is_none());
        assert!(Antigravity.plugins().is_none());
        assert!(Antigravity.accounts().is_none());
        assert!(Antigravity.official_usage().is_none());
        assert!(Antigravity
            .launch_args(None, LaunchMode::Normal)
            .is_err());
        let descriptor = Antigravity.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "antigravity 的 {dimension}");
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
