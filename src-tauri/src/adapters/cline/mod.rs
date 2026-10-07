//! Cline CLI adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `cline`. This
//! scaffold records only the verified evidence: the official npm command and
//! the documented global settings family under `~/.cline`
//! (`global-settings.json` here; the rest of the family is expanded by the
//! dedicated adapter task). Every capability dimension stays honestly
//! undeclared until that task delivers verified contracts. `data/settings/
//! providers.json` stores account keys in plaintext, so it never enters the
//! managed surface (read-only discovery only, decided by the adapter task).

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

pub struct Cline;

impl CliAdapter for Cline {
    fn id(&self) -> &'static str {
        "cline"
    }
    fn name(&self) -> &'static str {
        "Cline"
    }
    fn command(&self) -> &'static str {
        "cline"
    }
    fn npm_package(&self) -> &'static str {
        "cline"
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "cline" || basename.starts_with("cline-"))
            && (output.contains("cline")
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
            home.join(".cline").join("global-settings.json"),
            FileKind::Json,
            known,
            Some("Cline 全局设置；settings 族其余文件与项目 .cline 由后续适配任务交付；providers.json 含明文密钥，绝不进入管理面"),
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
            Err("Cline 此原生配置文件角色暂不交付，由后续适配任务实现".into())
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("Cline 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("Cline 凭据由产品登录态与 providers.json 保管，Cliora 不接管".into())
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
        Err("Cline 启动暂不交付，由后续适配任务实现".into())
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 0, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "官方 npm 包 cline 3.0.x 要求 Node.js 22+"
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://github.com/cline/cline",
            "Cline CLI 通过官方 npm 包 cline 安装（Node.js 22+）；各能力维度由后续适配任务交付。",
        )
    }
    fn install_command(&self) -> Option<String> {
        self.npm_install_command()
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
                reason: "已登记 ~/.cline global-settings.json 官方路径；settings 族与编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "Cline 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "Cline 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "Cline 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "Cline 会话索引与用量统计暂不交付，由后续适配任务实现",
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
        assert!(Cline.version_identity("cline", "3.0.69"));
        assert!(Cline.version_identity("cline", "cline 3.0.69"));
        assert!(Cline.version_identity("cline-3.0.69", "3.0.69\n"));
        assert!(!Cline.version_identity("cline", "claude 2.1.283"));
        assert!(!Cline.version_identity("decliner", "3.0.69"));
    }

    #[test]
    fn native_files_map_the_documented_settings_only() {
        let home = Path::new("/home/example");
        let global = Cline.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].role, "settings");
        assert!(global[0]
            .path
            .replace('\\', "/")
            .ends_with(".cline/global-settings.json"));
        // Plaintext account keys never enter the managed surface; project
        // scope stays undelivered by the scaffold.
        assert!(global.iter().all(|item| !item.path.contains("providers.json")));
        assert!(Cline
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(Cline.file_kind("settings").unwrap(), FileKind::Json);
        assert!(Cline.file_kind("providers").is_err());
        assert_eq!(Cline.minimum_node_version(), Some((22, 0, 0)));
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!Cline.history_supported());
        assert!(!Cline.supports_mcp());
        assert!(!Cline.supports_skills());
        assert!(Cline.configuration().is_none());
        assert!(Cline.agents().is_none());
        assert!(Cline.plugins().is_none());
        assert!(Cline.accounts().is_none());
        assert!(Cline.official_usage().is_none());
        assert!(Cline.launch_args(None, LaunchMode::Normal).is_err());
        let descriptor = Cline.descriptor();
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "cline 的 {dimension}");
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
