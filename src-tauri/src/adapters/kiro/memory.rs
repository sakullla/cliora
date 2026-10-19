//! Kiro memory verdict (final, 2026-10-19): no local editable memory store.
//! Verified against the real local data root `%LOCALAPPDATA%/kiro-cli`:
//! `data.sqlite3` (conversations, history, auth, state) and
//! `knowledge_bases` (internal model caches for built-in knowledge assets)
//! only; no memory file family exists and the official command surface
//! documents no memory feature. Session and steering material stays in the
//! history/rules dimensions.
use std::path::{Path, PathBuf};

use super::Kiro;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Kiro {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Kiro 无本地可编辑记忆存储：本机 %LOCALAPPDATA%/kiro-cli 仅有会话库与内部模型缓存，命令面无记忆功能",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Kiro 没有可管理的本地记忆存储".into())
    }
}
