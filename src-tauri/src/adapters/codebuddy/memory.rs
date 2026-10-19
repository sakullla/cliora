//! CodeBuddy memory verdict (initial, 2026-10-19): official cloud docs
//! confirm automatic per-project memory plus a global memory store. The
//! project-id directory derivation (including the lowercase drive-letter
//! difference observed in local samples) and the switch surface still need
//! local verification, so the declaration records the reason and publishes no
//! management entry.
use std::path::{Path, PathBuf};

use super::CodeBuddy;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for CodeBuddy {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方文档已确认 CodeBuddy 自动记忆与全局记忆；目录派生规则待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("CodeBuddy 记忆目录派生规则待本机核验，暂不解析".into())
    }
}
