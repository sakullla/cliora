//! Pi memory verdict (final, 2026-10-19): no independent native memory store.
//! Local verification on Pi 1.3.0 (`~/.pi/agent`): sessions, skills, MCP,
//! models and settings only, and the command surface exposes no memory
//! feature. Session transcripts are history, not a memory entry family.
use std::path::{Path, PathBuf};

use super::Pi;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Pi {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Pi 无独立记忆存储：本机 1.3.0 的 ~/.pi/agent 仅有会话、技能、MCP 与配置，命令面无记忆功能",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Pi 没有独立原生记忆存储".into())
    }
}
