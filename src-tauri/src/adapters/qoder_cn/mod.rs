//! Qoder CN uses its own CLI, native root and account. Never substitute the
//! international binary or credentials when this installation is unavailable.
pub static QODER_CN: super::qoder::QoderAdapter = super::qoder::QoderAdapter {
    id: "qoder_cn", name: "Qoder CN", command: "qoderclicn",
    directory: ".qoder-cn", config_env: None, plugin_ledger: Some("plugins/installed_plugins_v2.json"),
    binary_directory: "bin/qoderclicn", yolo_flag: "--dangerously-skip-permissions",
    npm: "", install_url: "https://qoder.cn/download",
    install_hint: "使用 Qoder CN 安装或更新内置 qoderclicn；也可选择已安装的 CN CLI 路径。",
    install_script: None,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{LaunchMode, Registry};
    use crate::native::adapter::Scope;
    #[test]
    fn native_ledger_uses_cn_settings_and_filters_other_projects() {
        use crate::adapters::plugins::PluginAdapter;
        use crate::resources::plugins::PluginTarget;
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".qoder-cn");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(root.join("plugins/installed_plugins_v2.json"), r#"{"version":2,"plugins":{"fixture@market":[{"scope":"user","version":"1","enabled":false},{"scope":"project","projectPath":"/other","enabled":false}]}}"#).unwrap();
        std::fs::write(root.join("settings.json"), r#"{"enabledPlugins":{"fixture@market":true}}"#).unwrap();
        let target = PluginTarget { tool_id: "qoder_cn".into(), scope: Scope::Global, project_path: None, context_id: None };
        let entries = QODER_CN.discover(home.path(), &target, &root).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].enabled, Some(true));
        let project = PluginTarget { scope: Scope::Project, project_path: Some("/selected".into()), ..target };
        assert!(QODER_CN.discover(home.path(), &project, &root).unwrap().is_empty());
        std::fs::write(root.join("plugins/installed_plugins_v2.json"), r#"{"version":3,"plugins":{}}"#).unwrap();
        assert!(QODER_CN.discover(home.path(), &project, &root).is_err());
    }

    #[test]
    fn cn_registration_isolated_paths_and_versioned_binary() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".qoder-cn/bin/qoderclicn");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("version.txt"), "1.1.65\n").unwrap();
        let filename = format!("qoderclicn-1.1.65{}", if cfg!(windows) { ".exe" } else { "" });
        std::fs::write(bin.join(&filename), "fixture").unwrap();
        let registry = Registry::builtins();
        let cn = registry.get("qoder_cn").unwrap();
        assert_eq!(cn.extra_binary_candidates(home.path()), vec![bin.join(filename)]);
        assert!(cn.version_identity("qoderclicn-1.1.65", "1.1.65\n"));
        assert!(!cn.version_identity("other", "1.1.65"));
        assert!(!cn.version_identity("qoder", "qoder 1.1.65"));
        assert!(cn.native_files(Scope::Global, home.path(), None, true)[0].path.replace('\\', "/").ends_with(".qoder-cn/settings.json"));
        assert_eq!(cn.launch_args(None, LaunchMode::Yolo).unwrap(), ["--dangerously-skip-permissions"]);
        assert!(cn.npm_install_command().is_none());
        assert_ne!(cn.skill_root(Scope::Global, home.path(), None), registry.get("qoder").unwrap().skill_root(Scope::Global, home.path(), None));
        assert!(cn.plugins().is_some() && cn.agents().is_some());
    }
}
