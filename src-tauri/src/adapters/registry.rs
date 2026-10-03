use super::*;
#[cfg(test)]
use std::collections::BTreeMap;
pub struct Registry {
    entries: Vec<&'static dyn CliAdapter>,
    #[cfg(test)]
    pub(crate) fixture_installations: BTreeMap<String, Vec<crate::native::adapter::Installation>>,
}

impl Registry {
    pub fn builtins() -> Self {
        Self {
            entries: vec![&CODEX, &CLAUDE, &GROK, &PI, &OPENCODE],
            #[cfg(test)]
            fixture_installations: BTreeMap::new(),
        }
    }

    pub fn with_adapters(entries: Vec<&'static dyn CliAdapter>) -> Result<Self, String> {
        let mut ids = std::collections::HashSet::new();
        for entry in &entries {
            if entry.id().is_empty() || !ids.insert(entry.id()) {
                return Err("CLI 适配器 ID 为空或重复".into());
            }
        }
        Ok(Self {
            entries,
            #[cfg(test)]
            fixture_installations: BTreeMap::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_fixture_installation(mut self, id: &str, version: &str) -> Self {
        assert!(
            self.get(id).is_some(),
            "fixture must reference a registered adapter"
        );
        self.fixture_installations.insert(
            id.into(),
            vec![crate::native::adapter::Installation {
                path: format!("fixture-cli/{id}"),
                version: Some(version.into()),
                source: "test_fixture",
                status: "available",
                detail: None,
            }],
        );
        self
    }

    pub fn iter(&self) -> impl Iterator<Item = &'static dyn CliAdapter> + '_ {
        self.entries.iter().copied()
    }

    pub fn get(&self, id: &str) -> Option<&'static dyn CliAdapter> {
        self.entries.iter().copied().find(|entry| entry.id() == id)
    }

    pub fn descriptors(&self) -> Vec<AdapterDescriptor> {
        self.entries
            .iter()
            .map(|entry| entry.descriptor())
            .collect()
    }
}
