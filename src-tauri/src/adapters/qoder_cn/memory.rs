//! Qoder CN memory verdict (initial, 2026-10-19): official docs confirm
//! project-level memory under `~/.qoder/projects/<project>/memory/` plus an
//! opt-in user-level root (`QODER_MEMORY_USER=1`), with a MEMORY.md index and
//! the `autoMemoryEnabled` settings switch. The CLI is not installed locally,
//! so the declaration records the reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::QoderAdapter;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for QoderAdapter {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档已确认 Qoder 项目级 ~/.qoder/projects/<项目>/memory/ 与可选用户级记忆，本机未安装，待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Qoder 本机未安装，记忆目录待本机核验后解析".into())
    }
}
