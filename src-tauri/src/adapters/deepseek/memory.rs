//! DeepSeek Harness memory verdict (final, 2026-10-19): no independent
//! native memory store. Local verification against the installed `dsh`
//! (`~/.dsh`): rules (`AGENTS.md`), profiles, sessions, and caches only —
//! `storages/session_projcache` is session state and `llm-deepseek` is a file
//! cache, not a memory entry family.
use std::path::{Path, PathBuf};

use super::DeepSeek;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for DeepSeek {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "DeepSeek Harness 无独立记忆存储：本机 ~/.dsh 仅有规则、会话与缓存，无记忆文件族",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("DeepSeek Harness 没有独立原生记忆存储".into())
    }
}
