//! MiniMax Code memory verdict (initial, 2026-10-19): official docs confirm
//! a memory feature (a session-level generate-memory setting), and the local
//! adapter's agent notes reference a native `memory/MEMORY.md` concept, but
//! neither the storage path nor the enable surface is verified. The
//! declaration records the reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::MiniMaxCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for MiniMaxCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档已确认 MiniMax Code 的 memory 功能；存储路径与启停方式待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("MiniMax Code 记忆存储待本机核验，目录暂不解析".into())
    }
}
