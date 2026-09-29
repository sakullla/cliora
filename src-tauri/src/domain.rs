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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Preferences {
    pub schema_version: u32,
    pub managed_tools: Vec<CliId>,
    pub theme: Theme,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: 1,
            managed_tools: CliId::ALL.to_vec(),
            theme: Theme::System,
        }
    }
}

impl Preferences {
    pub fn set_managed(&mut self, ids: &[CliId]) {
        self.managed_tools = CliId::ALL
            .into_iter()
            .filter(|id| ids.contains(id))
            .collect();
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
    pub fn new(preferences: Preferences) -> Self {
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
    fn managed_set_is_canonical_and_can_be_empty() {
        let mut p = Preferences::default();
        p.set_managed(&[CliId::Grok, CliId::Codex, CliId::Grok]);
        assert_eq!(p.managed_tools, vec![CliId::Codex, CliId::Grok]);
        p.set_managed(&[]);
        assert!(p.managed_tools.is_empty());
    }
}
