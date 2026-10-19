//! ZCode memory verdict (final, 2026-10-19, not integrated): the desktop app
//! does ship a memory feature (verified by reading its own bundles,
//! `app.asar` memory service and `glm/zcode.cjs` backend), with the project
//! family at `<~/.zcode/cli>/memories/projects/<name>-<sha256(path)[:16]>/`
//! holding `MEMORY.md` plus `*.md` items, and the global memory being the
//! single Claude-family file `~/.claude/memory/MEMORY.md`. Locally the
//! feature has never been enabled (`memoryEnabled: false`, no `memories`
//! directory exists), so no native store can be observed and a Cliora-written
//! entry cannot be shown to be read natively; the entry stays unpublished
//! with this reason until the feature is enabled and observed on this
//! machine.
use std::path::{Path, PathBuf};

use super::ZCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for ZCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "ZCode 记忆功能存在但本机从未启用（memoryEnabled=false 且无 memories 存储），无法核实原生读取，暂不接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("ZCode 的记忆存储在本机尚未建立，先在 ZCode 中启用记忆后重试".into())
    }
}
