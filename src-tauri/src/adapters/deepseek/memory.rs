//! DeepSeek memory verdict (initial, 2026-10-19): no native memory evidence
//! has been found for DeepSeek. The declaration records the unverified reason
//! and publishes no management entry until local/official verification
//! decides.
use std::path::{Path, PathBuf};

use super::DeepSeek;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for DeepSeek {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified("尚未核实 DeepSeek 是否存在独立原生记忆存储")
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("DeepSeek 的记忆存储尚未核实，目录不可解析".into())
    }
}
