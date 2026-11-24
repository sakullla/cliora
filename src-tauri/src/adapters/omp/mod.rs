//! oh-my-pi (OMP) adapter composition root.
//!
//! OMP is an independent CLI, not a Pi variant: `omp`, package
//! `@oh-my-pi/pi-coding-agent`, YAML configuration, `agent.db` authentication
//! and `--resume`/`--continue` session arguments all differ from Pi. This module
//! only assembles identity, lifecycle and capability forwarding. Each capability
//! module owns its evidence and turns itself on (or keeps an explicit reason)
//! without editing this file again.
//!
//! Registered with a non-enumerated stable id, so OMP stays default-off through
//! the existing unknown-managed-tool channel and never enters `CliId::ALL`.

pub(crate) mod accounts;
pub(crate) mod agents;
pub(crate) mod configuration;
pub(crate) mod history;
pub(crate) mod lifecycle;
pub(crate) mod mcp;
pub(crate) mod memory;
pub(crate) mod plugins;
pub(crate) mod skills;
pub mod verify;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    AdapterDescriptor, CliAdapter, Facet, InspectionFields, LaunchForm, LaunchMode, McpLocation,
    NativeCredentialRefs, NativeCredentialTarget, PendingSecrets, RuleFileSpec, RuleSupport,
    SkillObservation, SkillSwitchLocation,
};
use crate::adapters::accounts::AccountAdapter;
use crate::adapters::agents::AgentAdapter;
use crate::adapters::configuration::{ConfigurationAdapter, PortableFieldKind};
use crate::adapters::memory::MemoryAdapter;
use crate::adapters::plugins::PluginAdapter;
use crate::adapters::RemoteNativeDocument;
use crate::adapters::RemoteResourceLayout;
use crate::credentials::CredentialStore;
use crate::native::adapter::{ConnectionPolicy, NativeFile, Scope};
use crate::native::apply::NativeSecrets;
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::profile::{Connection, RegisteredProfile};
use crate::resources::mcp::McpDefinition;

pub(crate) const ID: &str = "omp";
pub(crate) const NAME: &str = "oh-my-pi (OMP)";
pub(crate) const COMMAND: &str = "omp";

/// Resource facets are composed here from the owning modules only. A resource
/// task publishes an available facet in its own file and this composition
/// follows without editing the capability state.
pub(crate) fn resources_facet() -> Facet {
    let facets = [mcp::facet(), skills::facet(), agents::facet()];
    if facets.iter().any(|facet| facet.state == "available") {
        Facet {
            state: "available",
            reason: resources_reason(true),
        }
    } else {
        Facet {
            state: "planned",
            reason: resources_reason(false),
        }
    }
}

fn resources_reason(available: bool) -> &'static str {
    static AVAILABLE_REASON: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    static PLANNED_REASON: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if available {
        AVAILABLE_REASON
            .get_or_init(|| "部分资源能力已由模块发布；未交付模块保留各自不可用原因".to_owned())
            .as_str()
    } else {
        PLANNED_REASON
            .get_or_init(|| {
                format!(
                    "MCP：{}；Skills 与规则：{}；Agents：{}",
                    mcp::UNAVAILABLE_REASON,
                    skills::UNAVAILABLE_REASON,
                    agents::UNAVAILABLE_REASON
                )
            })
            .as_str()
    }
}

pub struct Omp;

impl CliAdapter for Omp {
    fn id(&self) -> &'static str {
        ID
    }

    fn name(&self) -> &'static str {
        NAME
    }

    fn command(&self) -> &'static str {
        COMMAND
    }

    fn npm_package(&self) -> &'static str {
        lifecycle::PACKAGE
    }

    fn version_identity(&self, basename: &str, output: &str) -> bool {
        let lowered = output.to_ascii_lowercase();
        let tokens = lowered
            .split(|character: char| {
                !(character.is_ascii_alphanumeric() || character == '-' || character == '_')
            })
            .filter(|token| !token.is_empty());
        let named = tokens
            .into_iter()
            .any(|token| matches!(token, "omp" | "oh-my-pi"));
        // A bare version is only OMP when the probed executable is `omp`; Pi's
        // `pi --version` therefore never passes this identity check.
        named
            || (basename.eq_ignore_ascii_case(COMMAND)
                && (lowered.starts_with('v')
                    || lowered
                        .chars()
                        .next()
                        .is_some_and(|character| character.is_ascii_digit())))
    }

    fn configuration(&self) -> Option<&dyn ConfigurationAdapter> {
        configuration::port()
    }

    fn portable_field_kind(&self, path: &[String]) -> PortableFieldKind {
        configuration::portable_field_kind(path)
    }

    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        configuration::native_files(scope, home, project, known)
    }

    fn interface_formats(&self) -> &'static [&'static str] {
        configuration::interface_formats()
    }

    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        configuration::file_kind(role)
    }

    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        configuration::portable_root_fields(role)
    }

    fn connection_policy(&self, scope: Scope) -> ConnectionPolicy {
        configuration::connection_policy(scope)
    }

    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        configuration::connection_documents(connection, scope)
    }

    fn connection_documents_for_existing(
        &self,
        connection: &Connection,
        scope: Scope,
        existing: &BTreeMap<String, Value>,
    ) -> Result<BTreeMap<String, Value>, String> {
        configuration::connection_documents_for_existing(connection, scope, existing)
    }

    fn preserve_native_fields(
        &self,
        role: &str,
        original: &Value,
        fields: &mut BTreeMap<String, Value>,
        profile: &RegisteredProfile,
    ) -> Result<(), String> {
        configuration::preserve_native_fields(role, original, fields, profile)
    }

    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        configuration::write_connection_secret(profile, scope, credentials, secrets)
    }

    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        configuration::has_native_secret(role, root)
    }

    fn outdated_applied_secret(
        &self,
        connection: &Connection,
        role: &str,
        path: &[String],
        value: &Value,
    ) -> bool {
        configuration::outdated_applied_secret(connection, role, path, value)
    }

    fn inspect_values(
        &self,
        settings: &Value,
        local_settings: &Value,
        models: &Value,
    ) -> InspectionFields {
        configuration::inspect_values(settings, local_settings, models)
    }

    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        native_refs: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        configuration::import_literal_secrets(files, found, pending, native_refs)
    }

    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        configuration::validate_draft(role, parsed)
    }

    fn connection_roles(&self) -> &'static [&'static str] {
        configuration::connection_roles()
    }

    fn empty_entry_collections(&self, role: &str) -> &'static [&'static str] {
        configuration::empty_entry_collections(role)
    }

    fn validate_role_scope(&self, role: &str, scope: Scope) -> Result<(), String> {
        configuration::validate_role_scope(role, scope)
    }

    fn native_credential_target(&self, scope: Scope) -> Option<NativeCredentialTarget> {
        accounts::native_credential_target(scope)
    }

    fn accounts(&self) -> Option<&dyn AccountAdapter> {
        accounts::port()
    }

    fn agents(&self) -> Option<&dyn AgentAdapter> {
        agents::port()
    }

    fn plugins(&self) -> Option<&dyn PluginAdapter> {
        plugins::port()
    }

    fn memory(&self) -> Option<&dyn MemoryAdapter> {
        memory::port()
    }

    fn supports_mcp(&self) -> bool {
        mcp::supported()
    }

    fn mcp_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<McpLocation> {
        mcp::location(scope, home, project)
    }

    fn mcp_entries(
        &self,
        parsed: &Value,
        location: &McpLocation,
    ) -> Result<serde_json::Map<String, Value>, String> {
        mcp::entries(parsed, location)
    }

    fn mcp_entry_view(&self, entry: &Value) -> Value {
        mcp::entry_view(entry)
    }

    fn mcp_observations(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<crate::adapters::McpObservations, String> {
        let _ = scope;
        let found = mcp::observations(home, project)?;
        Ok(crate::adapters::McpObservations {
            servers: found
                .observations
                .into_iter()
                .map(|observation| crate::adapters::McpObservation {
                    name: observation.name,
                    entry: observation.entry,
                    source: observation.source,
                    path: observation.path,
                    enabled: observation.source_enabled,
                    detail: "OMP 从其他工具发现的只读配置；启停只写 OMP 自有覆盖",
                })
                .collect(),
            issues: found
                .issues
                .into_iter()
                .map(|issue| crate::adapters::McpObservationIssue {
                    source: issue.source,
                    path: issue.path,
                    message: issue.message,
                })
                .collect(),
        })
    }

    fn mcp_external_switch(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<crate::adapters::McpExternalSwitch> {
        mcp::external_switch(scope, home, project)
    }

    fn mcp_external_changes(
        &self,
        parsed: &Value,
        name: &str,
        enabled: bool,
        source_enabled: bool,
    ) -> Option<Vec<crate::native::transaction::FieldChange>> {
        Some(mcp::external_changes(
            parsed,
            name,
            enabled,
            source_enabled,
        ))
    }

    fn mcp_project_scope_effective(&self, home: &Path) -> Result<bool, String> {
        mcp::project_scope_effective(home)
    }

    fn mcp_redacts_secrets(&self) -> bool {
        true
    }

    fn mcp_document(
        &self,
        definition: &McpDefinition,
        enabled: bool,
        existing: Option<&Value>,
    ) -> Result<Option<Value>, String> {
        mcp::document(definition, enabled, existing)
    }

    fn mcp_disabled_description(&self) -> Option<&'static str> {
        mcp::disabled_description()
    }

    fn mcp_supports_cwd(&self) -> bool {
        mcp::supports_cwd()
    }

    fn mcp_supports_sse(&self) -> bool {
        mcp::supports_sse()
    }

    fn supports_skills(&self) -> bool {
        skills::supported()
    }

    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        skills::root(scope, home, project)
    }

    fn skill_requires_manifest(&self) -> bool {
        skills::requires_manifest()
    }

    fn skill_observations(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Vec<SkillObservation> {
        skills::observations(scope, home, project)
    }

    fn remote_skill_directories(&self) -> Vec<crate::adapters::RemoteSkillDirectory> {
        skills::remote_directories()
    }

    fn skill_switch_location(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        name: &str,
    ) -> Option<SkillSwitchLocation> {
        skills::switch_location(scope, home, project, name)
    }

    fn skill_switch_requires_version(&self) -> bool {
        skills::switch_requires_version()
    }

    fn skill_switch_value(&self, current: &Value, enabled: bool, skill_path: &Path) -> Value {
        skills::switch_value(current, enabled, skill_path)
    }

    fn skill_switch_enabled(&self, current: &Value, skill_path: &Path) -> bool {
        skills::switch_enabled(current, skill_path)
    }

    fn skill_switch_snapshot(&self, current: &Value, skill_path: &Path) -> Option<Value> {
        skills::switch_snapshot(current, skill_path)
    }

    fn skill_switch_restore(
        &self,
        current: &Value,
        previous: Option<&Value>,
        skill_path: &Path,
    ) -> Option<Value> {
        skills::switch_restore(current, previous, skill_path)
    }

    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<PathBuf> {
        skills::rule_path(scope, home, project)
    }

    fn rule_support(&self) -> RuleSupport {
        skills::rule_support()
    }

    fn uses_rule_catalog(&self, scope: Scope) -> bool {
        skills::uses_rule_catalog(scope)
    }

    fn rule_file_specs(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Result<Vec<RuleFileSpec>, String> {
        skills::rule_file_specs(scope, home, project)
    }

    fn rule_create_path(&self, project: &Path, name: &str) -> Result<PathBuf, String> {
        skills::rule_create_path(project, name)
    }

    fn rule_relocate(&self, project: &Path, path: &Path, enabled: bool) -> Result<PathBuf, String> {
        skills::rule_relocate(project, path, enabled)
    }

    fn rule_unavailable_reason(&self, scope: Scope) -> Option<&'static str> {
        skills::rule_unavailable_reason(scope)
    }

    fn remote_resource_layout(&self) -> RemoteResourceLayout {
        mcp::remote_layout()
    }

    fn remote_native_documents(&self) -> &'static [RemoteNativeDocument] {
        mcp::remote_native_documents()
    }

    fn history_sources(
        &self,
        home: &Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        history::sources(home)
    }

    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        history::parse(source)
    }

    fn history_supported(&self) -> bool {
        history::supported()
    }

    fn history_resume_version_supported(&self, version: &str) -> bool {
        lifecycle::version_policy().accepts(version)
    }

    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        lifecycle::launch_args(session, mode)
    }

    fn resume_latest_args(&self, mode: LaunchMode) -> Result<Vec<String>, String> {
        lifecycle::resume_latest_args(mode)
    }

    fn explicitly_incompatible_launch_version(&self, version: &str) -> bool {
        !lifecycle::version_policy().accepts(version)
    }

    fn install_guidance(&self) -> (&'static str, &'static str) {
        lifecycle::install_guidance()
    }

    fn node_required_when_missing(&self) -> bool {
        // OMP runs on Bun; the shared Node/npm dependency panel must not claim a
        // Node requirement it has not verified.
        false
    }

    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        None
    }

    fn requires_windows_bash(&self) -> bool {
        false
    }

    fn native_binary_directories(&self, home: &Path) -> Vec<PathBuf> {
        lifecycle::binary_directories(home)
    }

    fn recognizes_native_install_path(&self, path: &Path) -> bool {
        lifecycle::is_standalone_binary(path)
    }

    fn installation_source(&self, path: &Path) -> Option<&'static str> {
        lifecycle::source_label(path)
    }

    fn npm_packages(&self) -> Vec<&'static str> {
        // No verified npm channel: naming the package here would let a Bun
        // symlink be reported as npm before the adapter-owned Bun label.
        Vec::new()
    }

    fn runtime_dependencies(&self, source: &str, installed: bool, home: &Path) -> Vec<crate::native::adapter::Dependency> {
        lifecycle::runtime_dependencies(source, installed, home)
    }

    fn source_install_command(&self, source: Option<&str>) -> Option<String> {
        lifecycle::source_install_command(source)
    }

    fn source_upgrade_command(&self, source: &str, version: Option<&str>) -> Option<String> {
        lifecycle::source_upgrade_command(source, version)
    }

    fn source_uninstall_command(&self, source: &str, version: Option<&str>) -> Option<String> {
        lifecycle::source_uninstall_command(source, version)
    }

    fn install_command(&self) -> Option<String> {
        lifecycle::install_command()
    }

    fn native_install_command(&self) -> Option<String> {
        lifecycle::native_install_command()
    }

    fn npm_install_command(&self) -> Option<String> {
        lifecycle::npm_install_command()
    }

    fn upgrade_command(&self, source: &str) -> Option<String> {
        lifecycle::upgrade_command(source)
    }

    fn uninstall_command(&self) -> Option<String> {
        lifecycle::uninstall_command()
    }

    fn npm_uninstall_command(&self) -> Option<String> {
        lifecycle::npm_uninstall_command()
    }

    fn login_args(&self) -> Option<Vec<String>> {
        accounts::login_args()
    }

    fn login_hint(&self) -> &'static str {
        accounts::login_hint()
    }

    fn descriptor(&self) -> AdapterDescriptor {
        let plugins = self.plugins();
        AdapterDescriptor {
            remote: self.remote_capabilities(),
            secret_mcp: self.secret_mcp_capability(),
            id: ID,
            name: NAME,
            interface_formats: self.interface_formats(),
            project_model_override: configuration::project_model_override(),
            yolo_available: self.launch_args(None, LaunchMode::Yolo).is_ok(),
            launch_form: LaunchForm::Terminal,
            native_config: configuration::facet(),
            launch: lifecycle::launch_facet(),
            resume: lifecycle::resume_facet(),
            resources: resources_facet(),
            history: history::facet(),
            login: accounts::login_capability(),
            management: super::ManagementCapabilities {
                accounts: accounts::management_visible(self.accounts()),
                mcp: self.supports_mcp(),
                skills: self.supports_skills(),
                agents: agents::management_visible(self.agents()),
                plugins: plugins::management_visible(plugins),
                project_plugins: plugins::project_visible(plugins),
                rules: self.rule_support(),
                memory: self.published_memory(),
                memory_reason: memory::management_reason(),
            },
            configuration: self.configuration().map(|port| port.describe(Scope::Global)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::Registry;
    use crate::domain::{CliId, Preferences};

    #[test]
    fn omp_registers_as_a_non_enumerated_default_off_tool() {
        let registry = Registry::builtins();
        let adapter = registry.get(ID).expect("OMP 应注册进内置注册表");
        assert_eq!(adapter.id(), "omp");
        assert_eq!(adapter.command(), "omp");
        assert_eq!(adapter.npm_package(), "@oh-my-pi/pi-coding-agent");
        assert_ne!(adapter.id(), "pi");
        assert_ne!(adapter.command(), "pi");
        assert!(CliId::from_stable_id("omp").is_none());
        assert_eq!(
            registry
                .descriptors()
                .iter()
                .filter(|item| item.id == "omp")
                .count(),
            1
        );
        let defaults = Preferences::default();
        assert_eq!(defaults.managed_tools, CliId::ALL.to_vec());
        assert!(!defaults.managed_tool_ids().iter().any(|id| id == "omp"));
        // A stored selection reaches OMP through the unknown-id channel only.
        let mut preferences = Preferences::default();
        let registered = |id: &str| registry.get(id).is_some();
        let mut ids: Vec<String> = CliId::ALL
            .iter()
            .map(|tool| tool.stable_id().to_owned())
            .collect();
        ids.push("omp".into());
        preferences.set_registered_managed(&ids, registered).unwrap();
        assert_eq!(preferences.unknown_managed_tools(), &["omp".to_string()]);
    }

    #[test]
    fn omp_identity_never_accepts_pis_version_output() {
        let adapter = &super::Omp;
        assert!(adapter.version_identity("omp", "omp 18.20.2"));
        assert!(adapter.version_identity("omp", "oh-my-pi 18.20.2"));
        assert!(adapter.version_identity("omp", "v18.20.2"));
        assert!(!adapter.version_identity("pi", "pi 1.0.0"));
        assert!(!adapter.version_identity("omp", "prompt 18.20.2"));
        assert!(!adapter.version_identity("other", "something 18.20.2"));
    }

    #[test]
    fn omp_descriptor_is_composed_from_owning_modules() {
        let adapter = &super::Omp;
        let descriptor = adapter.descriptor();
        // Every published state comes from its owning module or port, never a
        // literal stored in the composition root.
        assert_eq!(descriptor.native_config.state, configuration::facet().state);
        assert_eq!(descriptor.native_config.reason, configuration::facet().reason);
        assert_eq!(descriptor.launch.state, lifecycle::launch_facet().state);
        assert_eq!(descriptor.launch.reason, lifecycle::launch_facet().reason);
        assert_eq!(descriptor.resume.state, lifecycle::resume_facet().state);
        assert_eq!(descriptor.resume.reason, lifecycle::resume_facet().reason);
        assert_eq!(descriptor.resources.state, resources_facet().state);
        assert_eq!(descriptor.resources.reason, resources_facet().reason);
        assert_eq!(descriptor.history.state, history::facet().state);
        assert_eq!(descriptor.history.reason, history::facet().reason);
        assert_eq!(
            descriptor.login.is_some(),
            accounts::login_capability().is_some()
        );
        assert_eq!(
            descriptor.management.accounts,
            accounts::management_visible(adapter.accounts())
        );
        assert_eq!(
            descriptor.management.plugins,
            plugins::management_visible(adapter.plugins())
        );
        assert_eq!(
            descriptor.management.project_plugins,
            plugins::project_visible(adapter.plugins())
        );
        assert_eq!(
            descriptor.management.memory_reason,
            memory::management_reason()
        );
        assert_eq!(
            descriptor.project_model_override,
            configuration::project_model_override()
        );
        let rules = adapter.rule_support();
        assert_eq!(descriptor.management.mcp, adapter.supports_mcp());
        assert_eq!(descriptor.management.skills, adapter.supports_skills());
        assert_eq!(
            descriptor.management.agents,
            agents::management_visible(adapter.agents())
        );
        assert_eq!(descriptor.management.rules.global, rules.global);
        assert_eq!(descriptor.management.rules.project, rules.project);
        assert_eq!(
            descriptor.yolo_available,
            adapter.launch_args(None, LaunchMode::Yolo).is_ok()
        );
        assert_eq!(descriptor.configuration.is_some(), adapter.configuration().is_some());
        assert_eq!(
            descriptor.management.memory.is_some(),
            adapter.published_memory().is_some()
        );
        assert_eq!(
            adapter
                .native_files(Scope::Global, Path::new("/home/e"), None, true)
                .len(),
            configuration::native_files(Scope::Global, Path::new("/home/e"), None, true).len()
        );
        assert_eq!(adapter.interface_formats(), configuration::interface_formats());
        let policy = adapter.connection_policy(Scope::Global);
        assert_eq!(policy.api_key.state, configuration::connection_policy(Scope::Global).api_key.state);
        assert_eq!(
            policy.provider_address.state,
            configuration::connection_policy(Scope::Global).provider_address.state
        );
        let connection = Connection {
            provider_id: "official".into(),
            interface_format: "openai_responses".into(),
            base_url: "https://example.test/v1".into(),
            model: "fixture".into(),
            secret_ref: None,
            auth_env_var: None,
            model_records: Vec::new(),
        };
        assert_eq!(
            adapter.connection_documents(&connection, Scope::Global).is_err(),
            configuration::connection_documents(&connection, Scope::Global).is_err()
        );
    }

    #[test]
    fn omp_resume_rejects_unverified_versions_and_never_uses_pi_flag() {
        let adapter = &super::Omp;
        assert!(!adapter.explicitly_incompatible_launch_version("18.20.2"));
        assert!(!adapter.explicitly_incompatible_launch_version("19.0.0"));
        assert!(!adapter.explicitly_incompatible_launch_version("20.4.1"));
        assert!(adapter.explicitly_incompatible_launch_version("invalid"));
        assert!(adapter.history_resume_version_supported("18.21.0"));
        assert!(adapter.history_resume_version_supported("19.1.0"));
        assert!(!adapter.history_resume_version_supported("19.1.0-beta.1"));
        let args = adapter
            .launch_args(Some("ses_01H"), LaunchMode::Normal)
            .unwrap();
        assert_eq!(args, ["--resume", "ses_01H"]);
        assert_eq!(
            adapter.resume_latest_args(LaunchMode::Normal).unwrap(),
            ["--continue"]
        );
        assert!(adapter.launch_args(None, LaunchMode::Yolo).is_err());
        assert_eq!(
            adapter.install_command().as_deref(),
            Some("bun add -g @oh-my-pi/pi-coding-agent")
        );
        assert_eq!(
            adapter.native_install_command().is_some(),
            cfg!(windows),
            "预编译安装入口按平台核实"
        );
        assert!(adapter.npm_install_command().is_none());
        assert_eq!(
            adapter.source_upgrade_command("bun", Some("18.20.2")).as_deref(),
            Some("bun update -g --latest @oh-my-pi/pi-coding-agent")
        );
        assert_eq!(
            adapter.source_upgrade_command("native", Some("18.20.2")).as_deref(),
            Some("omp update")
        );
        assert!(adapter.source_upgrade_command("unknown", Some("18.20.2")).is_none());
        assert!(adapter
            .source_upgrade_command("npm_shim", Some("18.20.3"))
            .is_some_and(|command| command.starts_with("npm install -g @oh-my-pi/pi-coding-agent@latest")));
        assert!(adapter.source_install_command(Some("npm_shim")).is_none());
        assert!(adapter.npm_packages().is_empty());
        assert!(adapter.install_guidance().0.contains("can1357/oh-my-pi"));
    }

    #[test]
    fn pi_registration_behavior_is_unchanged() {
        let registry = Registry::builtins();
        let pi = registry.get("pi").expect("Pi 仍应注册");
        assert_eq!(pi.command(), "pi");
        assert_eq!(pi.npm_package(), "@earendil-works/pi-coding-agent");
        assert_eq!(
            pi.launch_args(Some("session-1"), LaunchMode::Normal)
                .unwrap(),
            ["--session", "session-1"]
        );
        assert!(pi.accounts().is_some());
        assert!(pi.descriptor().configuration.is_some());
        assert!(Preferences::default().managed_tools.contains(&CliId::Pi));
    }
}
