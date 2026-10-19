//! Claude Code memory verdict (initial, 2026-10-19): official docs confirm
//! native memory storage under `~/.claude/projects/<project>/memory/` with a
//! MEMORY.md index, the `autoMemoryEnabled` switch, and the
//! `autoMemoryDirectory` relocation setting. The directory derivation and the
//! settings mapping still need local verification, so the declaration records
//! the reason and publishes no management entry yet.
use std::path::{Path, PathBuf};

use super::Claude;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Claude {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档已确认 Claude Code 原生记忆（~/.claude/projects/<项目>/memory/ 与 autoMemoryEnabled/autoMemoryDirectory），待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Claude Code 记忆待本机核验后接入，目录暂不解析".into())
    }
}
