//! Cline memory verdict (initial, 2026-10-19): the Memory Bank is an official
//! documentation methodology (prompt-driven files), not a native store, so
//! Cline has no independent native memory storage. The declaration records
//! the no-memory reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::Cline;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Cline {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Memory Bank 是官方文档的方法论而非原生存储；无独立原生记忆存储",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Cline 无独立原生记忆存储，目录不可解析".into())
    }
}
