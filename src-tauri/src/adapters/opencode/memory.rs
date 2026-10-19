//! OpenCode memory verdict (initial, 2026-10-19): official docs provide only
//! AGENTS.md rule files; persistent memory relies on third-party plugins, so
//! the CLI itself has no independent native memory store. The declaration
//! records the no-memory reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::OpenCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for OpenCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档仅提供 AGENTS.md 规则文件，持久记忆依赖第三方插件；无独立原生记忆存储",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("OpenCode 无独立原生记忆存储，目录不可解析".into())
    }
}
