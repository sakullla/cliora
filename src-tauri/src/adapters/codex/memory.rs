//! Codex memory verdict (initial, 2026-10-19): official docs confirm a fixed
//! markdown collection under `~/.codex/memories/` with no project dimension,
//! disabled by default and controlled by a config key. The exact key name and
//! enable conditions still need local verification, so the declaration
//! records the reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::Codex;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Codex {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档已确认 Codex ~/.codex/memories/ 记忆且默认关闭；启用 config 键与生效条件待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Codex 记忆启停键待本机核验，目录暂不解析".into())
    }
}
