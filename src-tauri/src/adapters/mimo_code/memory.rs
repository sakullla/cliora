//! MiMo Code memory verdict (initial, 2026-10-19): third-party reporting
//! (kocpc, 2026-06) describes a layered memory that includes a project
//! MEMORY.md, but no official document confirms the store and nothing was
//! checked locally. The declaration records the reason and publishes no
//! management entry; third-party retelling is not an integration basis.
use std::path::{Path, PathBuf};

use super::MiMoCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for MiMoCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "已有资料提示 MiMo Code 存在多层记忆（含项目 MEMORY.md），未经官方确认，待本机核验后接入",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("MiMo Code 记忆存储待本机核验，目录暂不解析".into())
    }
}
