use serde::{Deserialize, Serialize};

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
    /// Future/absent adapters remain in the saved setting without entering
    /// the current five-tool UI or being silently dropped by another update.
    unknown_managed_tools: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PreferencesWire {
    schema_version: u32,
    managed_tools: Vec<String>,
    theme: Theme,
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
        }
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            managed_tools: CliId::ALL.to_vec(),
            theme: Theme::System,
            unknown_managed_tools: Vec::new(),
        }
    }
}

impl Preferences {
    pub fn unknown_managed_tools(&self) -> &[String] {
        &self.unknown_managed_tools
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

#[cfg(test)]
mod tests {
    use super::*;

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
