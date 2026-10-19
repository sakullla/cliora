//! Command Code memory verdict (initial, 2026-10-19): no native memory
//! evidence has been found for Command Code. The declaration records the
//! unverified reason and publishes no management entry until local/official
//! verification decides.
use std::path::{Path, PathBuf};

use super::CommandCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for CommandCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified("尚未核实 Command Code 是否存在独立原生记忆存储")
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Command Code 的记忆存储尚未核实，目录不可解析".into())
    }
}
