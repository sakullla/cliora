//! Registry-extension proof for the five default-off CLI additions (ADR-1/ADR-2
//! of docs/sakullla-workflow/2026-10-03-new-cli-adapters-default-off). The five
//! ids register as non-enumerated stable strings, stay out of the default
//! enabled set, flow through the existing unknown-id management channel, and
//! expose only honest stub descriptors until the adapter tasks deliver.

use crate::adapters::Registry;
use crate::domain::{CliId, Preferences};

const NEW_IDS: [&str; 5] = ["zcode", "qoder", "kimi_code", "deepseek", "codebuddy"];

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
    ids.push("qoder".into());
    preferences.set_registered_managed(&ids, registered).unwrap();
    assert_eq!(preferences.managed_tools, CliId::ALL.to_vec());
    assert_eq!(
        preferences.unknown_managed_tools(),
        &["zcode".to_string(), "qoder".to_string()]
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
        r#"{"schema_version":1,"managed_tools":["codex","hernes","kimi_code"],"theme":"system"}"#,
    )
    .unwrap();
    assert_eq!(
        stored.unknown_managed_tools(),
        &["hernes".to_string(), "kimi_code".to_string()]
    );
    stored
        .set_registered_managed(&["pi".into(), "kimi_code".into()], registered)
        .unwrap();
    assert_eq!(stored.managed_tools, vec![CliId::Pi]);
    // kimi_code stays managed through the unknown list; the unregistered id
    // remains preserved there for the read-only catalog view.
    assert_eq!(
        stored.unknown_managed_tools(),
        &["hernes".to_string(), "kimi_code".to_string()]
    );
}

#[test]
fn five_stub_descriptors_stay_honest_and_unavailable() {
    let registry = Registry::builtins();
    for id in NEW_IDS {
        let adapter = registry.get(id).unwrap();
        assert!(adapter.official_usage().is_none(), "{id} 不声明官方额度");
        assert!(adapter.agents().is_none(), "{id} 不声明 Agents");
        assert!(adapter.plugins().is_none(), "{id} 不声明插件");
        assert!(adapter.accounts().is_none(), "{id} 不声明账号");
        assert!(!adapter.supports_mcp(), "{id} 不声明 MCP");
        assert!(!adapter.supports_skills(), "{id} 不声明 Skills");
        assert!(!adapter.history_supported(), "{id} 不声明会话");
        assert!(adapter.launch_args(None, Default::default()).is_err());
        let descriptor = adapter.descriptor();
        assert_eq!(descriptor.id, id);
        assert!(!descriptor.yolo_available, "{id} 不声明 YOLO");
        assert!(!descriptor.project_model_override);
        assert!(descriptor.login.is_none(), "{id} 不声明登录");
        assert!(!descriptor.management.accounts);
        assert!(!descriptor.management.mcp);
        assert!(!descriptor.management.skills);
        assert!(!descriptor.management.agents);
        assert!(!descriptor.management.plugins);
        assert!(!descriptor.management.project_plugins);
        for (facet, dimension) in [
            (&descriptor.native_config, "native_config"),
            (&descriptor.launch, "launch"),
            (&descriptor.resume, "resume"),
            (&descriptor.resources, "resources"),
            (&descriptor.history, "history"),
        ] {
            assert_ne!(facet.state, "available", "{id} 的 {dimension} 不得宣称可用");
            assert!(
                !facet.reason.trim().is_empty(),
                "{id} 的 {dimension} 原因不得为空"
            );
        }
    }
}
