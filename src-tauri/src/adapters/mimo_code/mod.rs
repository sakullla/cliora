//! MiMo Code (Xiaomi, `mimo`) adapter scaffold.
//!
//! Registered default-off through the non-enumerated stable id `mimo_code` so
//! the settings page lists it via the existing unknown-id channel. This
//! scaffold records only the verified evidence from the workflow exploration:
//! the official command/npm package and the documented global config files
//! (`~/.config/mimocode/mimocode.jsonc` and `tui.json`). Every capability
//! dimension — configuration editing, launch/resume, MCP, skills, agents,
//! plugins, credential custody, session history and usage — stays honestly
//! undeclared until the dedicated adapter task replaces this stub with
//! verified delivery. `auth.json` never enters the managed surface.

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

pub struct MiMoCode;

impl CliAdapter for MiMoCode {
    fn id(&self) -> &'static str {
        "mimo_code"
    }
    fn name(&self) -> &'static str {
        "MiMo Code"
    }
    fn command(&self) -> &'static str {
        "mimo"
    }
    fn npm_package(&self) -> &'static str {
        "@mimo-ai/cli"
    }
    /// No verified `--version` transcript exists yet; identity only accepts the
    /// documented command name with a self-named or bare semver response.
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        (basename == "mimo" || basename.starts_with("mimo-"))
            && (output.contains("mimo")
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
                "settings",
                home.join(".config").join("mimocode").join("mimocode.jsonc"),
                FileKind::Jsonc,
                known,
                Some("MiMo Code 全局配置（JSONC）；MIMOCODE_HOME 数据根覆盖与项目 .mimocode 由后续适配任务交付"),
                false,
            ),
            file(
                "tui",
                home.join(".config").join("mimocode").join("tui.json"),
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
        match role {
            "settings" => Ok(FileKind::Jsonc),
            "tui" => Ok(FileKind::Json),
            _ => Err("MiMo Code 此原生配置文件角色暂不交付，由后续适配任务实现".into()),
        }
    }
    fn connection_documents(
        &self,
        _connection: &Connection,
        _scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        Err("MiMo Code 连接配置写入暂不交付，由后续适配任务实现".into())
    }
    fn write_connection_secret(
        &self,
        _profile: &RegisteredProfile,
        _scope: Scope,
        _credentials: &dyn CredentialStore,
        _secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        Err("MiMo Code 凭据管理暂不交付，由后续适配任务实现".into())
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
        Err("MiMo Code 启动暂不交付，由后续适配任务实现".into())
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://www.npmjs.com/package/@mimo-ai/cli",
            "MiMo Code 通过官方 npm 包 @mimo-ai/cli 或官方脚本安装；各能力维度由后续适配任务交付。",
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
                reason: "已登记 mimocode.jsonc/tui.json 官方路径；编辑面由后续适配任务交付",
            },
            launch: Facet {
                state: "planned",
                reason: "MiMo Code 启动暂不交付，由后续适配任务实现",
            },
            resume: Facet {
                state: "planned",
                reason: "MiMo Code 会话恢复暂不交付，由后续适配任务实现",
            },
            resources: Facet {
                state: "planned",
                reason: "MiMo Code 的 MCP、Skills、Agents 与插件能力暂不交付，由后续适配任务实现",
            },
            history: Facet {
                state: "planned",
                reason: "MiMo Code 会话索引与用量统计暂不交付，由后续适配任务实现",
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
        assert!(MiMoCode.version_identity("mimo", "0.1.15"));
        assert!(MiMoCode.version_identity("mimo", "mimo cli v0.1.15"));
        assert!(MiMoCode.version_identity("mimo-0.1.15", "0.1.15\n"));
        assert!(!MiMoCode.version_identity("mimo", "claude 2.1.283"));
        assert!(!MiMoCode.version_identity("other", "0.1.15"));
    }

    #[test]
    fn native_files_map_the_documented_global_config_only() {
        let home = Path::new("/home/example");
        let global = MiMoCode.native_files(Scope::Global, home, None, true);
        assert_eq!(global.len(), 2);
        assert_eq!(global[0].role, "settings");
        assert_eq!(global[0].format, "jsonc");
        assert!(
            global[0]
                .path
                .replace('\\', "/")
                .ends_with(".config/mimocode/mimocode.jsonc")
        );
        assert!(global[1]
            .path
            .replace('\\', "/")
            .ends_with(".config/mimocode/tui.json"));
        // Credential files and project scope stay out of the scaffold surface.
        assert!(global.iter().all(|item| !item.path.contains("auth")));
        assert!(MiMoCode
            .native_files(Scope::Project, home, Some(Path::new("/work/p")), true)
            .is_empty());
        assert_eq!(MiMoCode.file_kind("settings").unwrap(), FileKind::Jsonc);
        assert_eq!(MiMoCode.file_kind("tui").unwrap(), FileKind::Json);
        assert!(MiMoCode.file_kind("auth").is_err());
    }

    #[test]
    fn all_capability_dimensions_stay_honestly_undeclared() {
        assert!(!MiMoCode.history_supported());
        assert!(!MiMoCode.supports_mcp());
        assert!(!MiMoCode.supports_skills());
        assert!(MiMoCode.configuration().is_none());
        assert!(MiMoCode.agents().is_none());
        assert!(MiMoCode.plugins().is_none());
        assert!(MiMoCode.accounts().is_none());
        assert!(MiMoCode.official_usage().is_none());
        assert!(MiMoCode
            .launch_args(None, LaunchMode::Normal)
            .is_err());
        let descriptor = MiMoCode.descriptor();
        assert_eq!(descriptor.native_config.state, "planned");
        assert_eq!(descriptor.launch.state, "planned");
        assert_eq!(descriptor.resume.state, "planned");
        assert_eq!(descriptor.resources.state, "planned");
        assert_eq!(descriptor.history.state, "planned");
        assert!(descriptor.login.is_none());
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.mcp);
        assert!(!descriptor.management.skills);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.yolo_available);
        assert!(!descriptor.management.rules.global);
        assert!(!descriptor.management.rules.project);
    }
}
