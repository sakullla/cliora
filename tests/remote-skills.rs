use super::*;
use crate::adapters::{CliAdapter, PublishedDescriptor, Registry, RemoteResourceLayout, RemoteSkillDirectory};

struct SkillFixture { available: bool, writable: bool }
impl CliAdapter for SkillFixture {
    fn id(&self) -> &'static str { if self.available { "skill_extension_fixture" } else { "skill_unavailable_fixture" } }
    fn name(&self) -> &'static str { "Skill extension" }
    fn command(&self) -> &'static str { "fixture" }
    fn npm_package(&self) -> &'static str { "" }
    fn version_identity(&self, _: &str, _: &str) -> bool { false }
    fn native_files(&self, _: crate::native::adapter::Scope, _: &std::path::Path, _: Option<&std::path::Path>, _: bool) -> Vec<crate::native::adapter::NativeFile> { vec![] }
    fn interface_formats(&self) -> &'static [&'static str] { &[] }
    fn file_kind(&self, _: &str) -> Result<crate::native::format::FileKind, String> { Err("unavailable".into()) }
    fn connection_documents(&self, _: &crate::native::profile::Connection, _: crate::native::adapter::Scope) -> Result<BTreeMap<String, serde_json::Value>, String> { Ok(BTreeMap::new()) }
    fn write_connection_secret(&self, _: &crate::native::profile::RegisteredProfile, _: crate::native::adapter::Scope, _: &dyn crate::credentials::CredentialStore, _: &mut crate::native::apply::NativeSecrets) -> Result<(), String> { Ok(()) }
    fn has_native_secret(&self, _: &str, _: &serde_json::Value) -> bool { false }
    fn inspect_values(&self, _: &serde_json::Value, _: &serde_json::Value, _: &serde_json::Value) -> crate::adapters::InspectionFields { Default::default() }
    fn launch_args(&self, _: Option<&str>, _: crate::adapters::LaunchMode) -> Result<Vec<String>, String> { Ok(vec![]) }
    fn install_guidance(&self) -> (&'static str, &'static str) { ("https://example.invalid", "fixture") }
    fn supports_skills(&self) -> bool { true }
    fn remote_resource_layout(&self) -> RemoteResourceLayout {
        RemoteResourceLayout { skill_root: (self.available && self.writable).then_some(".skill-extension/skills"), ..Default::default() }
    }
    fn remote_skill_directories(&self) -> Vec<RemoteSkillDirectory> {
        if !self.available { return vec![]; }
        vec![RemoteSkillDirectory { relative: ".skill-extension/skills", read_only: !self.writable, detail: "fixture" },
             RemoteSkillDirectory { relative: ".skill-extension/skills/bundled", read_only: true, detail: "bundled fixture" }]
    }
}

#[test]
fn all_builtin_skill_adapters_publish_their_own_remote_read_write_roots() {
    let expected = [("codex", ".codex/skills"), ("claude_code", ".claude/skills"), ("grok", ".grok/skills"), ("pi", ".pi/agent/skills"),
        ("open_code", ".config/opencode/skills"), ("zcode", ".zcode/skills"), ("qoder_cn", ".qoder/skills"), ("kimi_code", ".kimi-code/skills"),
        ("deepseek", ".dsh/skills"), ("codebuddy", ".codebuddy/skills"), ("mimo_code", ".config/mimocode/skills"), ("cline", ".cline/skills"),
        ("devin", ".config/devin/skills"), ("command_code", ".commandcode/skills"), ("antigravity", ".gemini/antigravity-cli/skills"),
        ("kiro", ".kiro/skills"), ("cursor", ".cursor/skills"), ("minimax_code", ".minimax/skills")];
    let registry = Registry::builtins();
    assert_eq!(registry.iter().filter(|adapter| adapter.supports_skills()).count(), expected.len());
    for (id, root) in expected {
        let adapter = registry.get(id).unwrap();
        validate_remote_skills(adapter).unwrap();
        assert_eq!(adapter.remote_resource_layout().skill_root, Some(root), "{id}");
        let published = serde_json::to_value(PublishedDescriptor::from_adapter(adapter)).unwrap();
        assert_eq!(published["remoteResources"]["skillRoot"], root);
        assert!(published["remoteSkillDirectories"].as_array().unwrap().iter().any(|entry| entry["relative"] == root && entry["readOnly"] == false));
        assert_eq!(adapter_skill_document_path(adapter, &format!("/home/fixture/{root}/owned/SKILL.md")).unwrap(), (format!("$HOME/{root}/owned/SKILL.md"), false));
    }
}

#[test]
fn claude_forty_native_skills_are_scanned_read_observed_and_written_in_its_own_root() {
    let body = "---\nname: perf-skill\ndescription: performance fixture\n---\nbody";
    let files: Vec<_> = (0..40).map(|n| (0, format!("/home/fixture/.claude/skills/perf-skill-{n}/SKILL.md"), body.to_owned())).collect();
    let context = operations::Context::local(operations::Kind::Read, Duration::from_secs(3));
    let value = operations::scoped(context.clone(), || skill_store_from_files("claude_code", &files));
    assert_eq!(value["entries"].as_array().unwrap().len(), 40);
    assert_eq!(value["documents"].as_object().unwrap().len(), 40);
    assert_eq!(context.file_versions().len(), 40);
    let script = resource_bundle_script(&["claude_code".into()], "skills");
    assert!(script.contains("$HOME/.claude/skills"));
    assert!(!script.contains(".codex/skills"));
    assert!(script.contains("-exec sh -c"));
    assert!(script.contains("|| exit 46"));
    assert!(!script.contains("-print | while"));
    let upload = materialize_adapter_skills(&crate::adapters::CLAUDE, Some(&value), &value).unwrap();
    assert!(upload.removes.is_empty());
    assert_eq!(upload.files.len(), 40);
    assert!(upload.files.iter().all(|(path, bytes)| path.starts_with("$HOME/.claude/skills/perf-skill-") && bytes == body.as_bytes()));
}

#[test]
fn skill_registry_extension_drives_inventory_aliases_writes_and_nested_readonly_without_service_ids() {
    static EXTENSION: SkillFixture = SkillFixture { available: true, writable: true };
    let registry = Registry::with_adapters(vec![&EXTENSION]).unwrap();
    let adapter = registry.get("skill_extension_fixture").unwrap();
    validate_remote_skills(adapter).unwrap();
    let roots = adapter_skill_roots(adapter);
    let mut script = String::new();
    append_skill_scan(&mut script, &roots[0], 0);
    assert!(script.contains("$HOME/.skill-extension/skills"));
    assert!(!script.contains(".codex"));
    let path = "/srv/home/.skill-extension/skills/owned/SKILL.md";
    let bundled = "/srv/home/.skill-extension/skills/bundled/core/SKILL.md";
    let before = assemble_adapter_skill_store(adapter, &[(0, path.into()), (1, bundled.into())], &BTreeMap::from([(path.into(), "body".into()), (bundled.into(), "bundled".into())]));
    assert_eq!(before["entries"][1]["source"], "read_only");
    let alias = serde_json::json!({"documents": {"$HOME/.skill-extension/skills/owned/SKILL.md": "edited", ".skill-extension/skills/bundled/core/SKILL.md": "bundled"}});
    let upload = materialize_adapter_skills(adapter, Some(&before), &alias).unwrap();
    assert!(upload.removes.is_empty());
    assert_eq!(upload.files, vec![("$HOME/.skill-extension/skills/owned/SKILL.md".into(), b"edited".to_vec())]);
    let removed = serde_json::json!({"documents": {"$HOME/.skill-extension/skills/bundled/core/SKILL.md": "bundled"}});
    assert_eq!(materialize_adapter_skills(adapter, Some(&before), &removed).unwrap().removes, vec!["$HOME/.skill-extension/skills/owned/SKILL.md"]);
    for invalid in [serde_json::json!({"documents": {}}), serde_json::json!({"documents": {"$HOME/.skill-extension/skills/bundled/core/SKILL.md":"changed"}})] {
        assert!(materialize_adapter_skills(adapter, Some(&before), &invalid).is_err());
    }
    assert!(adapter_skill_document_path(adapter, "/home/fixture/.claude/skills/foreign/SKILL.md").is_err());
    assert!(adapter_skill_document_path(adapter, "../escape/SKILL.md").is_err());
    let duplicate = serde_json::json!({"documents": {"owned/SKILL.md":"a", "$HOME/.skill-extension/skills/owned/SKILL.md":"b"}});
    assert!(materialize_adapter_skills(adapter, None, &duplicate).is_err());
}

#[test]
fn declared_readonly_skill_inventory_stays_available_and_unsupported_never_succeeds_empty() {
    static READONLY: SkillFixture = SkillFixture { available: true, writable: false };
    static UNAVAILABLE: SkillFixture = SkillFixture { available: false, writable: false };
    validate_remote_skills(&READONLY).unwrap();
    assert!(adapter_skill_write_root(&READONLY).is_err());
    let path = "/home/fixture/.skill-extension/skills/owned/SKILL.md";
    let value = assemble_adapter_skill_store(&READONLY, &[(0, path.into())], &BTreeMap::from([(path.into(), "read-only".into())]));
    assert_eq!(value["entries"][0]["source"], "read_only");
    assert!(materialize_adapter_skills(&READONLY, Some(&value), &value).unwrap().files.is_empty());
    assert!(materialize_adapter_skills(&READONLY, Some(&value), &serde_json::json!({"documents":{}})).is_err());
    assert!(validate_remote_skills(&UNAVAILABLE).is_err());
    assert!(skill_adapter("unregistered_skill_fixture").is_err());
}

#[test]
fn short_skill_alias_cannot_update_or_create_under_nested_readonly_root() {
    let adapter = &crate::adapters::CODEX;
    let original = serde_json::json!({"documents": {"/home/fixture/.codex/skills/.system/core/SKILL.md": "original"}});
    for alias in ["/home/fixture/.codex/skills/.system/core/SKILL.md", "$HOME/.codex/skills/.system/core/SKILL.md", ".codex/skills/.system/core/SKILL.md", ".system/core/SKILL.md"] {
        let edited = serde_json::json!({"documents": {alias: "replaced"}});
        assert!(materialize_adapter_skills(adapter, Some(&original), &edited).is_err(), "readonly edit accepted: {alias}");
        assert!(materialize_adapter_skills(adapter, None, &edited).is_err(), "readonly creation accepted: {alias}");
        let unchanged = serde_json::json!({"documents": {alias: "original"}});
        let upload = materialize_adapter_skills(adapter, Some(&original), &unchanged).unwrap();
        assert!(upload.files.is_empty() && upload.removes.is_empty(), "unchanged readonly alias writes: {alias}");
    }
    assert!(materialize_adapter_skills(adapter, Some(&original), &serde_json::json!({"documents": {}})).is_err());
    let writable = serde_json::json!({"documents": {"owned/SKILL.md": "body"}});
    assert_eq!(materialize_adapter_skills(adapter, None, &writable).unwrap().files, vec![("$HOME/.codex/skills/owned/SKILL.md".into(), b"body".to_vec())]);
    static EXTENSION: SkillFixture = SkillFixture { available: true, writable: true };
    assert!(materialize_adapter_skills(&EXTENSION, None, &serde_json::json!({"documents": {"bundled/new/SKILL.md": "body"}})).is_err());
}

#[test]
fn skill_scan_distinguishes_missing_directories_from_invalid_parents() {
    #[cfg(windows)]
    let shell = std::env::var("CLIORA_TEST_POSIX_SHELL").unwrap_or_else(|_| "C:/Program Files/Git/bin/bash.exe".into());
    #[cfg(not(windows))]
    let shell = "/bin/sh".to_owned();
    assert!(Path::new(&shell).exists(), "POSIX shell is required to verify the generated scan");
    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path().to_string_lossy().replace('\\', "/");
    let mut script = format!("HOME={}; ", shell_quote(&home));
    append_skill_scan(&mut script, &SkillScanRoot { relative: ".claude/skills".into(), read_only: false, detail: "fixture".into() }, 0);
    script.push_str("printf %s __SCAN_SUCCEEDED__");
    let run = |script: &str| {
        let mut command = Command::new(&shell);
        command.args(["-c", script]);
        #[cfg(windows)]
        command.env("MSYS", "winsymlinks:nativestrict");
        hide_console_window(&mut command);
        command.output().unwrap()
    };
    let missing = run(&script);
    assert!(missing.status.success());
    assert_eq!(String::from_utf8(missing.stdout).unwrap(), "__SCAN_SUCCEEDED__");
    std::fs::write(fixture.path().join(".claude"), "ordinary file").unwrap();
    let file_parent = run(&script);
    assert_eq!(file_parent.status.code(), Some(46), "ordinary parent file became empty success");
    std::fs::remove_file(fixture.path().join(".claude")).unwrap();
    // Make the dangling link in the POSIX shell so this also works on Windows without native symlink privileges.
    assert!(run(&format!("ln -s {} {}", shell_quote(&format!("{home}/absent")), shell_quote(&format!("{home}/.claude")))).status.success());
    assert!(run(&format!("[ -L {} ]", shell_quote(&format!("{home}/.claude")))).status.success());
    assert_eq!(run(&script).status.code(), Some(46), "dangling parent link became empty success");
    assert!(run(&format!("rm {}", shell_quote(&format!("{home}/.claude")))).status.success());
    std::fs::create_dir(fixture.path().join(".claude")).unwrap();
    assert!(run(&script).status.success(), "genuinely missing leaf is empty");
    std::fs::write(fixture.path().join(".claude/skills"), "ordinary file").unwrap();
    assert_eq!(run(&script).status.code(), Some(46), "ordinary root file became empty success");
    std::fs::remove_file(fixture.path().join(".claude/skills")).unwrap();
    std::fs::create_dir_all(fixture.path().join(".claude/skills/owned")).unwrap();
    std::fs::write(fixture.path().join(".claude/skills/owned/SKILL.md"), "full Skill body\n").unwrap();
    let valid = run(&script);
    assert!(valid.status.success(), "{}", String::from_utf8_lossy(&valid.stderr));
    let stdout = String::from_utf8(valid.stdout).unwrap();
    assert!(stdout.contains("__CLIORA_FILE__\n0\n"));
    assert!(stdout.contains(&base64::engine::general_purpose::STANDARD.encode("full Skill body\n")));

    std::fs::rename(fixture.path().join(".claude/skills"), fixture.path().join("actual-skills")).unwrap();
    assert!(run(&format!("ln -s {} {}", shell_quote(&format!("{home}/actual-skills")), shell_quote(&format!("{home}/.claude/skills")))).status.success());
    assert!(run(&format!("[ -L {} ]", shell_quote(&format!("{home}/.claude/skills")))).status.success());
    assert_eq!(run(&script).status.code(), Some(46), "root directory link became empty success");
    assert!(run(&format!("rm {}", shell_quote(&format!("{home}/.claude/skills")))).status.success());
    std::fs::rename(fixture.path().join("actual-skills"), fixture.path().join(".claude/skills")).unwrap();
    std::fs::rename(fixture.path().join(".claude"), fixture.path().join("actual-parent")).unwrap();
    assert!(run(&format!("ln -s {} {}", shell_quote(&format!("{home}/actual-parent")), shell_quote(&format!("{home}/.claude")))).status.success());
    let parent_link = run(&script);
    assert!(parent_link.status.success(), "valid traversable parent link must remain readable");
    assert!(String::from_utf8(parent_link.stdout).unwrap().contains(&base64::engine::general_purpose::STANDARD.encode("full Skill body\n")));
}
