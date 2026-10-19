//! Devin memory verdict (final, 2026-10-19): no local editable memory store.
//! Local verification on devin 3000.11.92: `%APPDATA%/devin` holds config,
//! credentials, MCP and skills only, and the command surface exposes no
//! memory feature. Devin memory lives with cloud sessions; no local memory
//! file family exists to manage.
use std::path::{Path, PathBuf};

use super::Devin;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Devin {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Devin 无本地记忆存储：本机 3000.11.92 的数据目录仅有配置、凭据、MCP 与技能，命令面无记忆功能",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Devin 没有可管理的本地记忆存储".into())
    }
}
