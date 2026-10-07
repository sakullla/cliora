//! Devin CLI (Cognition, `devin`) adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `devin`. This
//! scaffold records only the verified evidence: the official command, the
//! self-updating install layout under `AppData\Local\devin\cli\bin`, and the
//! documented JSONC global config at `%APPDATA%\devin\config.json`. Every
//! capability dimension stays honestly undeclared until the dedicated adapter
//! task delivers verified contracts. `credentials.toml` is the product-owned
//! credential store and is never read or written.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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

pub struct Devin;

/// Devin keeps its config under the OS config directory (`%APPDATA%\devin` on
/// Windows); tests with a synthetic home fall back to the conventional layout.
fn config_root(home: &Path) -> PathBuf {
    if dirs::home_dir().as_deref() == Some(home) {
        if let Some(dir) = dirs::config_dir() {
            return dir.join("devin");
        }
    }
    home.join(if cfg!(windows) {
        "AppData/Roaming/devin"
    } else {
        ".config/devin"
    })
}

impl CliAdapter for Devin {
    fn id(&self) -> &'static str {
        "devin"
    }
    fn name(&self) -> &'static str {
        "Devin"
    }
    fn command(&self) -> &'static str {
        "devin"
    }
    fn npm_package(&self) -> &'static str {
        ""
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "devin" || basename.starts_with("devin-"))
            && (output.contains("devin")
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
            config_root(home).join("config.json"),
            FileKind::Jsonc,
            known,
            Some("Devin CLI 全局配置（JSONC）；credentials.toml 为产品凭据存储，绝不读写；项目 .devin 由后续适配任务交付"),
            false,
        )]
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        if role == "settings" {
            Ok(FileKind::Jsonc)
        } else {
            Err("Devin 此原生配置文件角色暂不交付，由后续适配任务实现".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Devin 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Devin 凭据由 credentials.toml 保管，Cliora 绝不读写".into())
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
        Err("Devin 启动暂不交付，由后续适配任务实现".into())
    }
    fn node_required_when_missing(&self) -> bool {
        // The official installer ships a standalone self-updating binary.
        false
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://devin.ai",
            "Devin CLI 经官方 setup.ps1/install.sh 安装并自更新；各能力维度由后续适配任务交付。",
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
                reason: "已登记 %APPDATA%/devin/config.json（JSONC）官方路径；编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "Devin 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Devin 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Devin 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Devin 会话索引暂不交付；transcript 无 token 字段，用量维度由适配任务记录原因",
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
        assert!(Devin.version_identity("devin", "3000.11.3"));
        assert!(Devin.version_identity("devin", "devin 3000.11.3"));
        assert!(!Devin.version_identity("devin", "claude 2.1.283"));
        assert!(!Devin.version_identity("other", "3000.11.3"));
    }

    #[test]
    fn native_files_map_the_documented_config_only() {
        let home = Path::new("/home/example");
        let global = Devin.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "jsonc");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with("devin/config.json")
        );
        // The product credential store never enters the managed surface.
        assert!(global.iter().all(|item| !item.path.contains("credentials")));
        assert!(Devin
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Devin.file_kind("settings").unwrap(), FileKind::Jsonc);
        assert!(Devin.file_kind("credentials").is_err());
        assert!(!Devin.node_required_when_missing());
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!Devin.history_supported());
        assert!(!Devin.supports_mcp());
        assert!(!Devin.supports_skills());
        assert!(Devin.configuration().is_none());
        assert!(Devin.agents().is_none());
        assert!(Devin.plugins().is_none());
        assert!(Devin.accounts().is_none());
        assert!(Devin.official_usage().is_none());
        assert!(Devin.launch_args(None, LaunchMode::Normal).is_err());
        let descriptor = Devin.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "devin 的 {dimension}");
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
