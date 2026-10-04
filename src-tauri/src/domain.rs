use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Identifiers are stable across installs, migrations and IPC. The presentation names can change.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliId {
    Codex,
    ClaudeCode,
    Grok,
    Pi,
    OpenCode,
}

impl CliId {
    pub const ALL: [CliId; 5] = [
        CliId::Codex,
        CliId::ClaudeCode,
        CliId::Grok,
        CliId::Pi,
        CliId::OpenCode,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CliId::Codex => "Codex",
            CliId::ClaudeCode => "Claude Code",
            CliId::Grok => "Grok",
            CliId::Pi => "Pi",
            CliId::OpenCode => "OpenCode",
        }
    }

    pub fn stable_id(self) -> &'static str {
        match self {
            CliId::Codex => "codex",
            CliId::ClaudeCode => "claude_code",
            CliId::Grok => "grok",
            CliId::Pi => "pi",
            CliId::OpenCode => "open_code",
        }
    }

    pub fn from_stable_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.stable_id() == id)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(from = "PreferencesWire", into = "PreferencesWire")]
pub struct Preferences {
    pub schema_version: u32,
    pub managed_tools: Vec<CliId>,
    pub theme: Theme,
    pub tool_icons: BTreeMap<String, String>,
    /// Future/absent adapters remain in the saved setting without entering
    /// the current five-tool UI or being silently dropped by another update.
    unknown_managed_tools: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PreferencesWire {
    schema_version: u32,
    managed_tools: Vec<String>,
    theme: Theme,
    #[serde(default)]
    tool_icons: BTreeMap<String, String>,
}

impl From<PreferencesWire> for Preferences {
    fn from(wire: PreferencesWire) -> Self {
        let mut managed_tools = Vec::new();
        let mut unknown_managed_tools = Vec::new();
        for id in wire.managed_tools {
            if let Some(tool) = CliId::from_stable_id(&id) {
                if !managed_tools.contains(&tool) {
                    managed_tools.push(tool);
                }
            } else if !unknown_managed_tools.contains(&id) {
                unknown_managed_tools.push(id);
            }
        }
        Self {
            schema_version: wire.schema_version,
            managed_tools,
            theme: wire.theme,
            tool_icons: wire.tool_icons,
            unknown_managed_tools,
        }
    }
}

impl From<Preferences> for PreferencesWire {
    fn from(preferences: Preferences) -> Self {
        let mut managed_tools: Vec<String> = preferences
            .managed_tools
            .into_iter()
            .map(|tool| tool.stable_id().to_owned())
            .collect();
        managed_tools.extend(preferences.unknown_managed_tools);
        Self {
            schema_version: preferences.schema_version,
            managed_tools,
            theme: preferences.theme,
            tool_icons: preferences.tool_icons,
        }
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            managed_tools: CliId::ALL.to_vec(),
            theme: Theme::System,
            tool_icons: BTreeMap::new(),
            unknown_managed_tools: Vec::new(),
        }
    }
}

impl Preferences {
    pub fn unknown_managed_tools(&self) -> &[String] {
        &self.unknown_managed_tools
    }

    /// Enum-managed and registered adapters share one string-ID view for registry consumers.
    pub fn managed_tool_ids(&self) -> Vec<String> {
        self.managed_tools
            .iter()
            .map(|tool| tool.stable_id().to_owned())
            .chain(self.unknown_managed_tools.iter().cloned())
            .collect()
    }

    pub fn set_managed(&mut self, ids: &[CliId]) {
        self.managed_tools = CliId::ALL
            .into_iter()
            .filter(|id| ids.contains(id))
            .collect();
    }

    pub fn set_registered_managed(
        &mut self,
        ids: &[String],
        is_registered: impl Fn(&str) -> bool,
    ) -> Result<(), String> {
        if ids.iter().any(|id| !is_registered(id)) {
            return Err("不能管理未注册的 CLI 适配器".into());
        }
        self.managed_tools = CliId::ALL
            .into_iter()
            .filter(|tool| ids.iter().any(|id| id == tool.stable_id()))
            .collect();
        self.unknown_managed_tools.retain(|id| !is_registered(id));
        for id in ids {
            if CliId::from_stable_id(id).is_none() && !self.unknown_managed_tools.contains(id) {
                self.unknown_managed_tools.push(id.clone());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolSummary {
    pub id: CliId,
    pub name: &'static str,
    /// T1 has not probed installations or read native files. No placeholder may imply success.
    pub installation: &'static str,
    pub configuration: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct Bootstrap {
    pub preferences: Preferences,
    pub tools: Vec<ToolSummary>,
}

impl Bootstrap {
    pub fn new(mut preferences: Preferences) -> Self {
        // The active UI only understands registered built-ins. The database
        // keeps unknown IDs; the adapter catalog exposes them read-only.
        preferences.unknown_managed_tools.clear();
        Self {
            preferences,
            tools: CliId::ALL
                .into_iter()
                .map(|id| ToolSummary {
                    id,
                    name: id.name(),
                    installation: "not_checked",
                    configuration: "not_checked",
                })
                .collect(),
        }
    }
}

/// Portable raster content only: device paths and remote image URLs never enter preferences.
pub fn valid_icon_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn valid_tool_icons(icons: &BTreeMap<String, String>) -> bool {
    use base64::Engine;
    icons.len() <= 100 && icons.iter().all(|(id, data)| {
        valid_icon_id(id) && data.len() <= 180_000
        && ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"].iter().any(|prefix| {
            data.strip_prefix(prefix).and_then(|value| base64::engine::general_purpose::STANDARD.decode(value).ok()).is_some_and(|bytes| {
                bytes.len() <= 128 * 1024 && match *prefix {
                    "data:image/png;base64," => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "data:image/jpeg;base64," => bytes.starts_with(&[0xff, 0xd8, 0xff]),
                    _ => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
                }
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_preferences_accept_portable_rasters_and_reject_device_paths_and_invalid_content() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=";
        assert!(valid_tool_icons(&BTreeMap::from([("sixth_cli".into(), png.into())])));
        for value in ["C:/icons/icon.png", "https://example.com/logo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,bm90LWFuLWltYWdl"] {
            assert!(!valid_tool_icons(&BTreeMap::from([("codex".into(), value.into())])));
        }
        assert!(!valid_tool_icons(&BTreeMap::from([("../tool".into(), png.into())])));
        let old: Preferences = serde_json::from_str(r#"{"schema_version":1,"managed_tools":["codex"],"theme":"system"}"#).unwrap();
        assert!(old.tool_icons.is_empty());
    }

    #[test]
    fn registered_management_can_select_future_adapter_and_preserve_absent_one() {
        let mut preferences: Preferences = serde_json::from_str(
            r#"{"schema_version":1,"managed_tools":["codex","future_cli","missing_cli"],"theme":"system"}"#,
        ).unwrap();
        let registered = |id: &str| CliId::from_stable_id(id).is_some() || id == "future_cli";
        preferences
            .set_registered_managed(&["pi".into(), "future_cli".into()], registered)
            .unwrap();
        assert_eq!(preferences.managed_tools, vec![CliId::Pi]);
        assert_eq!(
            preferences.unknown_managed_tools(),
            &["missing_cli", "future_cli"]
        );
        assert!(preferences
            .set_registered_managed(&["missing_cli".into()], registered)
            .is_err());
        let stored = serde_json::to_string(&preferences).unwrap();
        assert!(stored.contains("future_cli") && stored.contains("missing_cli"));
    }

    #[test]
    fn managed_set_is_canonical_and_can_be_empty() {
        let mut p = Preferences::default();
        p.set_managed(&[CliId::Grok, CliId::Codex, CliId::Grok]);
        assert_eq!(p.managed_tools, vec![CliId::Codex, CliId::Grok]);
        p.set_managed(&[]);
        assert!(p.managed_tools.is_empty());
    }
}
