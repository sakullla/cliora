//! OMP memory backends: `off`, `local` Markdown/Skills, `hindsight`,
//! `mnemopi` and outbox state.
//!
//! Delivered by the memory task. The专项 memory document and the packaged
//! README disagree about backend count and the local directory, and no real
//! CLI has confirmed either in this repository. Nothing is published as a
//! memory entry and no directory is guessed; the recorded reason keeps the
//! feature visible as unavailable.

use std::path::{Path, PathBuf};

use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

pub(crate) const UNVERIFIED_REASON: &str =
    "OMP 记忆后端（local Markdown、Hindsight 远程 bank、Mnemopi SQLite、outbox）根目录尚未核实：不猜测路径、不把非文件后端当作 Markdown 编辑";

pub(crate) fn port() -> Option<&'static dyn MemoryAdapter> {
    Some(&MEMORY)
}

pub(crate) static MEMORY: Memory = Memory;

pub(crate) struct Memory;

impl MemoryAdapter for Memory {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(UNVERIFIED_REASON)
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err(UNVERIFIED_REASON.into())
    }
}
pub(crate) fn verify_case(
    _case: &serde_json::Value,
    _context: &super::verify::CaseContext,
) -> Result<serde_json::Value, super::verify::CaseError> {
    Err(super::verify::CaseError::Unverified(UNVERIFIED_REASON.into()))
}
