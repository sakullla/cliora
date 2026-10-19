//! MiniMax Code memory verdict (final, 2026-10-19): the official binary
//! (@minimax-ai/code 0.6.12) confirms the memory feature, but its writable
//! store is a governed dataset, not a plain file family. Current releases
//! keep `~/.minimax/memories/scopes/<scope>/` with a `MEMORY.md` index plus
//! summary and note files that a curator consolidates through staging,
//! confirm tokens, and a SQLite governance repository (`resetEpoch`,
//! stale-input checks, orphan-file deletion); the older
//! `memory/user.md`/`agents/<name>/memory/MEMORY.md` layout is a migration
//! source with agent memory retired. Writing files directly would bypass
//! governance and can be reverted or deleted as orphans, and this machine
//! keeps `memory.enabled: false` in `~/.minimax/config.yaml`, so no local
//! effect can be observed without flipping the user's native switch. The
//! declaration records the final reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::MiniMaxCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for MiniMaxCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方二进制确认 MiniMax Code memory 功能，但存储为 sqlite 治理仓库管理的 memories/scopes 数据集（confirm-token 整理、孤儿清除），直接文件写入会被绕过治理并有被回退/清除风险；本机 memory.enabled=false 未启用，无法产出生效证据，不接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("MiniMax Code 记忆为治理数据集且本机未启用，不作文件管理".into())
    }
}
