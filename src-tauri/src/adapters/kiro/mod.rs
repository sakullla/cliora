//! Kiro CLI (AWS, `kiro-cli`) adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `kiro`. This
//! scaffold records only the verified evidence: the official `kiro-cli`
//! command (installed through the cli.kiro.dev scripts) and the documented
//! settings file `~/.kiro/settings/cli.json`. Every capability dimension
//! stays honestly undeclared until the dedicated adapter task delivers
//! verified contracts, including the Windows data-root confirmation and the
//! `KIRO_HOME` override.

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

pub struct Kiro;

impl CliAdapter for Kiro {
    fn id(&self) -> &'static str {
        "kiro"
    }
    fn name(&self) -> &'static str {
        "Kiro"
    }
    fn command(&self) -> &'static str {
        "kiro-cli"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        // Only the kiro-cli names identify the CLI; a bare `kiro` binary may be
        // the Kiro IDE launcher and never verifies identity here.
        (basename == "kiro-cli" || basename.starts_with("kiro-cli-"))
            && (output.contains("kiro")
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
            home.join(".kiro").join("settings").join("cli.json"),
            FileKind::Json,
            known,
            Some("Kiro CLI 设置；KIRO_HOME 覆盖与项目 .kiro 由后续适配任务交付"),
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
            Err("Kiro 此原生配置文件角色暂不交付，由后续适配任务实现".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Kiro 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Kiro 凭据管理暂不交付，由后续适配任务实现".into())
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
        Err("Kiro 启动暂不交付，由后续适配任务实现".into())
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone binary.
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://cli.kiro.dev",
            "Kiro CLI 经官方脚本（cli.kiro.dev）安装；各能力维度由后续适配任务交付。",
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
                reason: "已登记 ~/.kiro/settings/cli.json 官方路径；编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "Kiro 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Kiro 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Kiro 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Kiro 会话索引暂不交付；已知会话格式无 token 字段，用量维度由适配任务记录原因",
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
        assert!(Kiro.version_identity("kiro-cli", "1.0.0"));
        assert!(Kiro.version_identity("kiro-cli", "kiro-cli 1.0.0"));
        assert!(!Kiro.version_identity("kiro-cli", "claude 2.1.283"));
        assert!(!Kiro.version_identity("other", "1.0.0"));
    }

    #[test]
    fn native_files_map_the_documented_settings_only() {
        let home = Path::new("/home/example");
        let global = Kiro.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with(".kiro/settings/cli.json")
        );
        assert!(Kiro
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Kiro.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Kiro.file_kind("mcp").is_err());
        assert!(!Kiro.node_required_when_missing());
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!Kiro.history_supported());
        assert!(!Kiro.supports_mcp());
        assert!(!Kiro.supports_skills());
        assert!(Kiro.configuration().is_none());
        assert!(Kiro.agents().is_none());
        assert!(Kiro.plugins().is_none());
        assert!(Kiro.accounts().is_none());
        assert!(Kiro.official_usage().is_none());
        assert!(Kiro.launch_args(None, LaunchMode::Normal).is_err());
        let descriptor = Kiro.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "kiro 的 {dimension}");
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
