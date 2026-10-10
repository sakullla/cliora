//! Registry-extension proof for the five default-off CLI additions (ADR-1/ADR-2
//! of docs/sakullla-workflow/2026-10-03-new-cli-adapters-default-off) and the
//! six 2026-10-07 additions (02-technical-solution ADR-2/ADR-6, delivered by
//! the impl-* tasks of docs/sakullla-workflow/2026-10-07-新增客户端完整支持与用量统计修复).
//! All ids register as non-enumerated stable strings, stay out of the default
//! enabled set, flow through the existing unknown-id management channel, and
//! declare exactly the evidence-gated dimensions the adapter tasks delivered:
//! no fabricated quota, accounts or login anywhere, and per-adapter gaps
//! (Qoder CN sessions, DeepSeek agents, action-limited plugin management;
//! Devin/Kiro token usage, Cline/Devin credentials, Devin/Kiro Skills, Agents
//! for five of the six, Plugins for all six) stay absent with recorded
//! reasons instead of silent holes.

use std::path::Path;

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

/// A connection carrying only a stored secret reference: the shape the frozen
/// env-key credential channels (COMMAND_CODE_API_KEY / GEMINI_API_KEY /
/// KIRO_API_KEY) resolve their launch-time env name from.
fn env_key_connection() -> crate::native::profile::Connection {
    crate::native::profile::Connection {
        provider_id: "official".into(),
        interface_format: String::new(),
        base_url: String::new(),
        model: String::new(),
        secret_ref: Some("connection-00000000-0000-4000-8000-000000000001".into()),
        auth_env_var: None,
        model_records: Vec::new(),
    }
}

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
fn six_added_adapters_declare_their_delivered_dimensions() {
    let registry = Registry::builtins();
    let home = std::path::Path::new("/home/example");
    let work = std::path::Path::new("/work/p");
    // Shared delivered surface: every 2026-10-07 impl task delivered
    // configuration-file editing, normal launch, native-session resume, MCP
    // and the read-only session index.
    for id in SIX_IDS {
        let adapter = registry.get(id).unwrap();
        let descriptor = adapter.descriptor();
        assert_eq!(descriptor.id, id);
        assert!(adapter.supports_mcp(), "{id} 应交付 MCP");
        assert!(adapter.history_supported(), "{id} 会话索引应交付");
        assert!(
            adapter
                .launch_args(None, crate::adapters::LaunchMode::Normal)
                .is_ok(),
            "{id} 应支持普通启动"
        );
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_eq!(facet.state, "available", "{id} 的 {dimension} 状态");
        }
        // Nothing fabricated: no quota, accounts or login surface anywhere.
        assert!(adapter.accounts().is_none(), "{id} 不声明账号代管");
        assert!(adapter.official_usage().is_none(), "{id} 不声明官方额度");
        assert!(descriptor.login.is_none(), "{id} 不声明登录");
        assert!(!descriptor.management.accounts, "{id} 无账号管理");
        assert_eq!(
            descriptor.management.plugins,
            adapter
                .plugins()
                .is_some_and(|port| !port.capability().actions.is_empty()),
            "{id} 插件管理面必须与插件端口一致"
        );
        // Product-owned credential files never appear in the managed file
        // list.
        let files = adapter.native_files(crate::native::adapter::Scope::Global, home, None, true);
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
    }
    // mimo_code ([src] XiaomiMiMo/MiMo-Code 0.1.15): JSONC config editing with
    // provider apiKey custody, --session resume (same contract as headless
    // `mimo run -c/--session/--fork`), MCP (config `mcp` key), Skills, Agents
    // (config `agent` key + {agent,agents}/**/*.md), Plugins (config `plugin`
    // array + {plugin,plugins}/*.ts|js auto-discovery, config-only), read-only
    // mimocode.db sessions with per-message token splits; accounts are absent
    // by design (auth.json not adopted), project `.mimocode` is a resource
    // location only.
    let mimo = registry.get("mimo_code").unwrap();
    assert!(mimo.supports_skills());
    assert!(mimo.configuration().is_some());
    assert!(mimo.agents().is_some());
    assert!(mimo.plugins().is_some());
    assert!(mimo.descriptor().yolo_available);
    assert!(mimo
        .launch_args(Some("ses_x"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert!(mimo
        .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
        .is_empty());
    // cline ([src] cline/cline@main 3.0.69): global-settings.json editing,
    // --id resume, MCP (cline_mcp_settings.json) + Skills, sessions/<id>/ +
    // sessions.db with per-message metrics; no credential port (plaintext
    // providers.json stays product-owned) and no verified skip-permissions
    // flag, so Yolo stays unavailable.
    let cline = registry.get("cline").unwrap();
    assert!(cline.supports_skills());
    assert!(cline.configuration().is_none());
    assert!(cline.agents().is_none());
    assert_eq!(cline.auth_env_name(&env_key_connection()), None);
    assert!(cline
        .connection_documents(&env_key_connection(), crate::native::adapter::Scope::Global)
        .is_err());
    assert!(!cline.descriptor().yolo_available);
    assert!(cline
        .launch_args(None, crate::adapters::LaunchMode::Yolo)
        .is_err());
    assert!(cline
        .launch_args(Some("ses_1"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert!(cline
        .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
        .is_empty());
    // devin (local verified 3000.11.3): config.json JSONC editing (project
    // .devin/config.json as the secondary role), --resume/-c, MCP
    // (mcp_config.json), Skills (%APPDATA%/devin/skills 与项目 .devin/skills),
    // ATIF-v1.7 transcript index with the usage dimension
    // delivered (devin-usage 2026-10-08): per-agent-step metrics as inclusive
    // bucket events reconciled against final_metrics on all 8 real local
    // transcripts; credentials.toml is never touched, so no credential
    // channel exists at all.
    let devin = registry.get("devin").unwrap();
    assert!(devin.supports_skills());
    assert!(devin
        .skill_root(crate::native::adapter::Scope::Global, home, None)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
        .ends_with("devin/skills"));
    assert!(devin
        .skill_root(crate::native::adapter::Scope::Project, home, Some(work))
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
        .ends_with("/work/p/.devin/skills"));
    assert!(devin.configuration().is_none());
    assert!(devin.agents().is_none());
    assert!(devin.descriptor().yolo_available);
    assert!(devin
        .launch_args(Some("serene-example"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert!(devin
        .descriptor()
        .history
        .reason
        .contains("用量已交付"));
    // The delivered usage assertion runs the registry adapter over the
    // sanitized transcript fixture: two inclusive-bucket events whose session
    // sums cross-check the fixture's final_metrics totals.
    let transcript = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/history/devin-3000-transcript.json");
    let parsed = devin
        .parse_history(&crate::history::HistorySource {
            native_title: None,
            path: transcript,
            native_id: Some("serene-example".into()),
            fingerprint: String::new(),
            fingerprint_error: None,
        })
        .unwrap();
    assert_eq!(parsed.usage.len(), 2, "devin 用量事件应交付");
    assert!(parsed
        .usage
        .iter()
        .all(|event| event.input_includes_cache && event.request_count == Some(1)));
    assert_eq!(
        parsed.usage.iter().map(|event| event.input.unwrap()).sum::<u64>(),
        3550
    );
    assert_eq!(
        parsed.usage.iter().map(|event| event.cache_read.unwrap()).sum::<u64>(),
        2700
    );
    assert!(devin
        .connection_documents(&env_key_connection(), crate::native::adapter::Scope::Global)
        .is_err());
    assert_eq!(
        devin
            .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
            .len(),
        1
    );
    // command_code (local verified npm command-code 1.73.4): config.json +
    // settings.json editing, --session resume, MCP (user-level mcp.json) +
    // Skills, projects/<slug>/<uuid>.jsonl sessions with per-message usage;
    // COMMAND_CODE_API_KEY is the frozen env channel held in the system
    // credential store (launch-time injection rides the shared launch
    // service); auth.json/providers.json stay product-owned.
    let command_code = registry.get("command_code").unwrap();
    assert!(command_code.supports_skills());
    assert!(command_code.configuration().is_none());
    assert!(command_code.agents().is_none());
    assert!(command_code.descriptor().yolo_available);
    assert!(command_code
        .launch_args(Some("4d2c0a55"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert_eq!(
        command_code.auth_env_name(&env_key_connection()).as_deref(),
        Some("COMMAND_CODE_API_KEY")
    );
    assert!(command_code
        .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
        .is_empty());
    // antigravity (local agy 1.3.1 + [RE] codeburn on 1.2.x): settings.json
    // editing, --conversation resume, MCP (config/mcp_config.json) + Skills,
    // conversation index + gen_metadata protobuf ModelUsageStats usage with
    // strict degrade; headless GEMINI_API_KEY is the only managed credential
    // channel; keyring login is never adopted.
    let antigravity = registry.get("antigravity").unwrap();
    assert!(antigravity.supports_skills());
    assert!(antigravity.configuration().is_none());
    assert!(antigravity.agents().is_none());
    assert!(antigravity.descriptor().yolo_available);
    assert!(antigravity
        .launch_args(Some("conv_1"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert_eq!(
        antigravity.auth_env_name(&env_key_connection()).as_deref(),
        Some("GEMINI_API_KEY")
    );
    assert!(antigravity
        .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
        .is_empty());
    // kiro (official docs + [RE] agentsview/threadle + real local data root
    // %LOCALAPPDATA%\kiro-cli): cli.json editing, --resume-id, dual-scope MCP,
    // legacy + sess_ session index; none of the three session formats carries
    // token fields, so usage stays absent with that recorded reason;
    // KIRO_API_KEY is the frozen env channel; no Skills/Agents evidence.
    let kiro = registry.get("kiro").unwrap();
    assert!(!kiro.supports_skills());
    assert!(kiro.configuration().is_none());
    assert!(kiro.agents().is_none());
    assert!(kiro.descriptor().yolo_available);
    assert!(kiro
        .launch_args(Some("abc123"), crate::adapters::LaunchMode::Normal)
        .is_ok());
    assert_eq!(
        kiro.auth_env_name(&env_key_connection()).as_deref(),
        Some("KIRO_API_KEY")
    );
    assert!(kiro.descriptor().history.reason.contains("无 token 字段"));
    assert!(kiro
        .native_files(crate::native::adapter::Scope::Project, home, Some(work), true)
        .is_empty());
    // Truthful per-client config locations from 02 ADR-2 evidence.
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
