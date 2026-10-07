//! Registry-extension proof for the five default-off CLI additions (ADR-1/ADR-2
//! of docs/sakullla-workflow/2026-10-03-new-cli-adapters-default-off) and the
//! six 2026-10-07 scaffold additions (02-technical-solution ADR-2/ADR-6). All
//! ids register as non-enumerated stable strings, stay out of the default
//! enabled set, flow through the existing unknown-id management channel, and
//! declare exactly the evidence-gated dimensions the adapter tasks delivered:
//! no fabricated quota, accounts or login anywhere, and per-adapter gaps
//! (Qoder CN sessions, DeepSeek agents, action-limited plugin management) stay
//! absent or action-limited with recorded reasons. The six new clients are
//! honest scaffolds: only the verified config file locations are mapped and
//! every capability dimension stays planned until the dedicated impl tasks.

use crate::adapters::Registry;
use crate::domain::{CliId, Preferences};

const NEW_IDS: [&str; 5] = ["zcode", "qoder_cn", "kimi_code", "deepseek", "codebuddy"];
const SIX_IDS: [&str; 6] = [
    "mimo_code",
    "cline",
    "devin",
    "command_code",
    "antigravity",
    "kiro",
];
// mimo_code graduated from the scaffold set on 2026-10-07 (impl-mimo-code):
// its dimensions are asserted in the delivered block below instead of the
// honest-scaffold loop.
const UNDELIVERED_SCAFFOLD_IDS: [&str; 5] = [
    "cline",
    "devin",
    "command_code",
    "antigravity",
    "kiro",
];

fn legacy_ids() -> Vec<String> {
    CliId::ALL
        .iter()
        .map(|tool| tool.stable_id().to_owned())
        .collect()
}

#[test]
fn five_new_ids_register_once_without_redundant_aliases() {
    let registry = Registry::builtins();
    for id in NEW_IDS {
        assert!(registry.get(id).is_some(), "{id} 应注册进内置注册表");
    }
    let mut seen = std::collections::HashSet::new();
    for adapter in registry.iter() {
        assert!(
            seen.insert(adapter.id()),
            "注册表出现重复 ID：{}",
            adapter.id()
        );
    }
    let descriptors = registry.descriptors();
    assert_eq!(descriptors.len(), seen.len());
    for id in NEW_IDS {
        assert_eq!(
            descriptors.iter().filter(|item| item.id == id).count(),
            1,
            "{id} 描述符应恰好一条"
        );
    }
    // No redundant product alias such as "hernes" may ride along (R4).
    assert!(registry.get("hernes").is_none());
    assert!(registry.get("qoder").is_none());
}

#[test]
fn default_enabled_set_excludes_the_five_additions() {
    for id in NEW_IDS {
        assert!(CliId::from_stable_id(id).is_none(), "{id} 不得进入枚举");
    }
    let defaults = Preferences::default();
    assert_eq!(defaults.managed_tools, CliId::ALL.to_vec());
    assert!(defaults.unknown_managed_tools().is_empty());
    // A fresh database deserializing the legacy wire format keeps the legacy
    // five enabled and files the new ids away as unknown (default off).
    let existing: Preferences = serde_json::from_str(
        r#"{"schema_version":1,"managed_tools":["codex","claude_code","grok","pi","open_code","zcode"],"theme":"system"}"#,
    )
    .unwrap();
    assert_eq!(existing.managed_tools, CliId::ALL.to_vec());
    assert_eq!(existing.unknown_managed_tools(), &["zcode".to_string()]);
}

#[test]
fn checking_new_ids_flows_through_the_unknown_managed_channel() {
    let registry = Registry::builtins();
    let registered = |id: &str| registry.get(id).is_some();
    let mut preferences = Preferences::default();
    let mut ids = legacy_ids();
    ids.push("zcode".into());
    ids.push("qoder_cn".into());
    preferences.set_registered_managed(&ids, registered).unwrap();
    assert_eq!(preferences.managed_tools, CliId::ALL.to_vec());
    assert_eq!(
        preferences.unknown_managed_tools(),
        &["zcode".to_string(), "qoder_cn".to_string()]
    );
    // Submitting an unregistered id is rejected by the existing guard.
    assert!(preferences
        .set_registered_managed(&["hernes".into()], registered)
        .is_err());
    // Unchecking removes the ids from the managed set only.
    preferences.set_registered_managed(&legacy_ids(), registered).unwrap();
    assert!(preferences.unknown_managed_tools().is_empty());
    // A previously stored unregistered id stays preserved read-only while a
    // registered selection is applied (preserved_unknown semantics).
    let mut stored: Preferences = serde_json::from_str(
        r#"{"schema_version":1,"managed_tools":["codex","qoder","kimi_code"],"theme":"system"}"#,
    )
    .unwrap();
    assert_eq!(
        stored.unknown_managed_tools(),
        &["qoder".to_string(), "kimi_code".to_string()]
    );
    stored
        .set_registered_managed(&["pi".into(), "kimi_code".into()], registered)
        .unwrap();
    assert_eq!(stored.managed_tools, vec![CliId::Pi]);
    // kimi_code stays managed through the unknown list; the unregistered id
    // remains preserved there for the read-only catalog view.
    assert_eq!(
        stored.unknown_managed_tools(),
        &["qoder".to_string(), "kimi_code".to_string()]
    );
}

#[test]
fn five_added_adapters_declare_their_delivered_dimensions() {
    let registry = Registry::builtins();
    for id in NEW_IDS {
        let adapter = registry.get(id).unwrap();
        let descriptor = adapter.descriptor();
        assert_eq!(descriptor.id, id);
        // Nothing fabricated: none of the five ships an official quota
        // adapter, managed accounts or a login surface.
        assert!(adapter.official_usage().is_none(), "{id} 不声明官方额度");
        assert!(adapter.accounts().is_none(), "{id} 不声明账号代管");
        assert!(descriptor.login.is_none(), "{id} 不声明登录");
        assert!(!descriptor.management.accounts);
        // Config editing, launching and MCP/Skills resources are delivered by
        // all five additions.
        assert!(adapter.supports_mcp(), "{id} 应交付 MCP");
        assert!(adapter.supports_skills(), "{id} 应交付 Skills");
        assert!(
            adapter
                .launch_args(None, crate::adapters::LaunchMode::Normal)
                .is_ok(),
            "{id} 应支持普通启动"
        );
        assert_eq!(descriptor.native_config.state, "available", "{id} 配置面");
        assert_eq!(descriptor.launch.state, "available", "{id} 启动面");
        assert_eq!(descriptor.resources.state, "available", "{id} 资源面");
        // Every undelivered facet must stay in the honest vocabulary with a
        // recorded reason instead of a silent gap.
        for (facet, dimension) in [
            (&descriptor.resume, "resume"),
            (&descriptor.history, "history"),
        ] {
            assert!(
                ["available", "planned", "unsupported"].contains(&facet.state),
                "{id} 的 {dimension} 状态词汇异常：{}",
                facet.state
            );
            if facet.state != "available" {
                assert!(
                    !facet.reason.trim().is_empty(),
                    "{id} 的 {dimension} 未交付时原因不得为空"
                );
            }
        }
    }
    // zcode: desktop form; sessions with token usage, native plugin
    // management, agents delivered; no resume contract and no verified YOLO.
    let zcode = registry.get("zcode").unwrap();
    assert!(zcode.history_supported());
    assert!(zcode.agents().is_some());
    assert_eq!(zcode.plugins().unwrap().capability().actions, ["install", "update", "enable", "disable", "uninstall"]);
    assert!(!zcode.descriptor().management.project_plugins);
    assert_eq!(zcode.descriptor().resume.state, "unsupported");
    assert!(!zcode.descriptor().yolo_available);
    assert!(zcode.launch_args(None, crate::adapters::LaunchMode::Yolo).is_err());
    // Qoder CN: terminal CLI with full plugin verbs and project scope, agents and
    // YOLO; the session dimension stays planned because the transcript fields
    // are undocumented and usage is metered in Credits only.
    let qoder = registry.get("qoder_cn").unwrap();
    assert!(!qoder.history_supported());
    assert_eq!(qoder.descriptor().history.state, "planned");
    assert_eq!(qoder.descriptor().resume.state, "planned");
    assert!(qoder.agents().is_some());
    assert_eq!(
        qoder.plugins().unwrap().capability().actions,
        ["install", "update", "enable", "disable", "uninstall"]
    );
    assert!(qoder.plugins().unwrap().capability().project);
    assert!(qoder.descriptor().management.project_plugins);
    assert!(qoder.descriptor().yolo_available);
    // kimi_code: config.toml editing, resumable sessions with per-stream token
    // usage, read-only plugin listing, YOLO as Ask-When-Needed.
    let kimi = registry.get("kimi_code").unwrap();
    assert!(kimi.history_supported());
    assert!(kimi.agents().is_some());
    assert_eq!(kimi.plugins().unwrap().capability().actions, ["list"]);
    assert_eq!(kimi.descriptor().resume.state, "available");
    assert!(kimi.descriptor().yolo_available);
    // deepseek: YAML patch editing, zstd sessions with TokenUsage, MCP/Skills;
    // agents remain unavailable; installed user bundles support enable/disable.
    let deepseek = registry.get("deepseek").unwrap();
    assert!(deepseek.history_supported());
    assert!(deepseek.agents().is_none());
    assert_eq!(deepseek.plugins().unwrap().capability().actions, ["enable", "disable"]);
    assert!(!deepseek.descriptor().management.agents);
    assert!(deepseek.descriptor().management.plugins);
    assert_eq!(deepseek.descriptor().resume.state, "unsupported");
    assert!(!deepseek.descriptor().yolo_available);
    // codebuddy: resumable sessions with provider usage, agents, project-scope
    // plugin enable/disable only (install/uninstall stay native).
    let codebuddy = registry.get("codebuddy").unwrap();
    assert!(codebuddy.history_supported());
    assert!(codebuddy.agents().is_some());
    assert_eq!(
        codebuddy.plugins().unwrap().capability().actions,
        ["enable", "disable"]
    );
    assert!(codebuddy.plugins().unwrap().capability().project);
    assert_eq!(codebuddy.descriptor().resume.state, "available");
    assert!(codebuddy.descriptor().yolo_available);
    // mimo_code ([src] XiaomiMiMo/MiMo-Code 0.1.15): JSONC config editing with
    // provider apiKey custody, --session resume (same contract as headless
    // `mimo run -c/--session/--fork`), MCP (config `mcp` key), Skills, Agents
    // (config `agent` key), read-only mimocode.db sessions with per-message
    // token splits; plugins stay pending native `plug` verification, accounts
    // are absent by design (auth.json not adopted), no quota interface.
    let mimo = registry.get("mimo_code").unwrap();
    assert!(mimo.history_supported());
    assert!(mimo.supports_mcp());
    assert!(mimo.supports_skills());
    assert!(mimo.configuration().is_some());
    assert!(mimo.agents().is_some());
    assert!(mimo.plugins().is_none());
    assert!(mimo.accounts().is_none());
    assert!(mimo.official_usage().is_none());
    assert!(mimo.descriptor().login.is_none());
    assert_eq!(mimo.descriptor().resume.state, "available");
    assert!(mimo
        .launch_args(Some("ses_x"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert!(mimo.descriptor().yolo_available);
    assert!(!mimo.descriptor().management.plugins);
}

#[test]
fn six_scaffold_ids_register_once_without_redundant_aliases() {
    let registry = Registry::builtins();
    for id in SIX_IDS {
        assert!(registry.get(id).is_some(), "{id} 应注册进内置注册表");
    }
    let mut seen = std::collections::HashSet::new();
    for adapter in registry.iter() {
        assert!(
            seen.insert(adapter.id()),
            "注册表出现重复 ID：{}",
            adapter.id()
        );
    }
    let descriptors = registry.descriptors();
    assert_eq!(descriptors.len(), seen.len());
    for id in SIX_IDS {
        assert_eq!(
            descriptors.iter().filter(|item| item.id == id).count(),
            1,
            "{id} 描述符应恰好一条"
        );
    }
    // No product aliases (IDE-era names, package names) may ride along.
    assert!(registry.get("mimo").is_none());
    assert!(registry.get("cmd").is_none());
    assert!(registry.get("agy").is_none());
    assert!(registry.get("kiro-cli").is_none());
}

#[test]
fn default_enabled_set_excludes_the_six_additions() {
    for id in SIX_IDS {
        assert!(CliId::from_stable_id(id).is_none(), "{id} 不得进入枚举");
    }
    let defaults = Preferences::default();
    assert_eq!(defaults.managed_tools, CliId::ALL.to_vec());
    assert!(defaults.unknown_managed_tools().is_empty());
    // A stored legacy wire format keeps the enumerated tools enabled and files
    // the scaffold ids away as unknown (default off), preserving them read-only.
    let existing: Preferences = serde_json::from_str(
        r#"{"schema_version":1,"managed_tools":["codex","cline","kiro"],"theme":"system"}"#,
    )
    .unwrap();
    assert_eq!(existing.managed_tools, vec![CliId::Codex]);
    assert_eq!(
        existing.unknown_managed_tools(),
        &["cline".to_string(), "kiro".to_string()]
    );
}

#[test]
fn checking_six_ids_flows_through_the_unknown_managed_channel() {
    let registry = Registry::builtins();
    let registered = |id: &str| registry.get(id).is_some();
    let mut preferences = Preferences::default();
    let mut ids = legacy_ids();
    ids.push("mimo_code".into());
    ids.push("devin".into());
    ids.push("command_code".into());
    preferences.set_registered_managed(&ids, registered).unwrap();
    assert_eq!(preferences.managed_tools, CliId::ALL.to_vec());
    assert_eq!(
        preferences.unknown_managed_tools(),
        &[
            "mimo_code".to_string(),
            "devin".to_string(),
            "command_code".to_string()
        ]
    );
    // Unchecking removes the scaffold ids from the managed set only.
    preferences.set_registered_managed(&legacy_ids(), registered).unwrap();
    assert!(preferences.unknown_managed_tools().is_empty());
    // A stored unregistered alias stays preserved read-only while a registered
    // scaffold selection is applied (preserved_unknown semantics).
    let mut stored: Preferences = serde_json::from_str(
        r#"{"schema_version":1,"managed_tools":["pi","agy","antigravity"],"theme":"system"}"#,
    )
    .unwrap();
    stored
        .set_registered_managed(&["antigravity".into(), "kiro".into()], registered)
        .unwrap();
    assert_eq!(stored.managed_tools, Vec::new());
    assert_eq!(
        stored.unknown_managed_tools(),
        &["agy".to_string(), "antigravity".to_string(), "kiro".to_string()]
    );
}

#[test]
fn six_scaffold_adapters_declare_only_the_mapped_native_files() {
    let registry = Registry::builtins();
    // mimo_code left the honest-scaffold set when impl-mimo-code delivered its
    // verified dimensions (asserted in the delivered block above); the loop
    // keeps checking the remaining undelivered scaffolds.
    for id in UNDELIVERED_SCAFFOLD_IDS {
        let adapter = registry.get(id).unwrap();
        let descriptor = adapter.descriptor();
        assert_eq!(descriptor.id, id);
        // Nothing fabricated: the scaffolds declare no optional capability
        // port at all, history included.
        assert!(!adapter.history_supported(), "{id} 会话维度未交付");
        assert!(!adapter.supports_mcp(), "{id} 不声明 MCP");
        assert!(!adapter.supports_skills(), "{id} 不声明 Skills");
        assert!(adapter.configuration().is_none(), "{id} 不声明配置面");
        assert!(adapter.agents().is_none(), "{id} 不声明 Agents");
        assert!(adapter.plugins().is_none(), "{id} 不声明插件");
        assert!(adapter.accounts().is_none(), "{id} 不声明账号代管");
        assert!(adapter.official_usage().is_none(), "{id} 不声明官方额度");
        assert!(descriptor.login.is_none(), "{id} 不声明登录");
        assert!(
            adapter
                .launch_args(None, crate::adapters::LaunchMode::Normal)
                .is_err(),
            "{id} 启动未交付"
        );
        assert!(!descriptor.yolo_available);
        // Every undelivered facet stays planned with a recorded reason instead
        // of a silent gap or a fabricated capability.
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "planned", "{id} 的 {dimension} 状态");
            assert!(
                !facet.reason.trim().is_empty(),
                "{id} 的 {dimension} 未交付时原因不得为空"
            );
        }
        // Project scope stays out of the scaffold surface; product-owned
        // credential files never appear in the managed file list.
        let home = std::path::Path::new("/home/example");
        let files = adapter.native_files(
            crate::native::adapter::Scope::Global,
            home,
            None,
            true,
        );
        assert!(!files.is_empty(), "{id} 应登记已核实的全局配置文件");
        for file in &files {
            let path = file.path.replace('\\', "/").to_ascii_lowercase();
            for forbidden in ["auth.json", "credentials", "providers.json"] {
                assert!(
                    !path.contains(forbidden),
                    "{id} 的管理面不得包含 {forbidden}"
                );
            }
            adapter.file_kind(file.role).unwrap();
        }
        assert!(adapter
            .native_files(
                crate::native::adapter::Scope::Project,
                home,
                Some(std::path::Path::new("/work/p")),
                true,
            )
            .is_empty());
    }
    // Truthful per-client config locations from 02 ADR-2 evidence.
    let home = std::path::Path::new("/home/example");
    let suffix = |id: &str, role: &str| -> String {
        let adapter = registry.get(id).unwrap();
        adapter
            .native_files(crate::native::adapter::Scope::Global, home, None, true)
            .into_iter()
            .find(|file| file.role == role)
            .unwrap_or_else(|| panic!("{id} 缺少 {role} 角色"))
            .path
            .replace('\\', "/")
    };
    assert!(suffix("mimo_code", "settings").ends_with(".config/mimocode/mimocode.jsonc"));
    assert!(suffix("mimo_code", "tui").ends_with(".config/mimocode/tui.json"));
    assert!(suffix("cline", "settings").ends_with(".cline/global-settings.json"));
    assert!(suffix("devin", "settings").ends_with("devin/config.json"));
    assert!(suffix("command_code", "config").ends_with(".commandcode/config.json"));
    assert!(suffix("command_code", "settings").ends_with(".commandcode/settings.json"));
    assert!(suffix("antigravity", "settings").ends_with(".gemini/antigravity-cli/settings.json"));
    assert!(suffix("kiro", "settings").ends_with(".kiro/settings/cli.json"));
}
