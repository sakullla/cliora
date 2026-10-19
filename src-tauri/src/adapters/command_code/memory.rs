//! Command Code memory verdict (final, 2026-10-19): no independent memory
//! store behind `/memory`. Verified against the installed npm package
//! command-code 1.82.3 (`dist/cli.mjs`): "Command Code memory" is the
//! `AGENTS.md` instruction family — user `~/.commandcode/AGENTS.md`, project
//! `<project>/AGENTS.md` or `<project>/.commandcode/AGENTS.md`, plus an
//! enterprise file. Those are rule documents Cliora models as rules, not a
//! multi-entry memory family, so no memory entry publishes.
use std::path::{Path, PathBuf};

use super::CommandCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for CommandCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Command Code 的 /memory 管理的是 AGENTS.md 指令文件（用户与项目各一份），属规则文档而非独立记忆文件族",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Command Code 的记忆即 AGENTS.md 规则文件，不是独立记忆目录".into())
    }
}
