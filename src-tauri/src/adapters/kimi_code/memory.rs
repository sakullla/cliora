//! Kimi Code memory verdict (initial, 2026-10-19): community material points
//! at per-project memory under `~/.kimi/projects/<hash>/memory/`, but the
//! local `~/.kimi` has no projects directory and no official doc confirms the
//! store, so the declaration records the reason and publishes no management
//! entry until local verification decides.
use std::path::{Path, PathBuf};

use super::KimiCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for KimiCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "已有资料提示 Kimi Code 在 ~/.kimi/projects/ 下按项目存储记忆，本机未见该目录，待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Kimi Code 记忆存储待本机核验，目录暂不解析".into())
    }
}
