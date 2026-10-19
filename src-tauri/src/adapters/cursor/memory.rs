//! Cursor memory verdict (initial, 2026-10-19): memories live in the
//! application's internal storage and are managed from the settings page
//! (Rules & Memories); no public local file path is documented, so there is
//! no manageable independent memory store. The declaration records the
//! no-memory reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::Cursor;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Cursor {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Cursor 记忆保存在应用内部存储并由设置页管理，无公开的本机独立记忆文件",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Cursor 无公开的本机独立记忆文件，目录不可解析".into())
    }
}
