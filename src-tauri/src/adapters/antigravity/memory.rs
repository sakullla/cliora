//! Antigravity memory verdict (initial, 2026-10-19): evidence conflicts —
//! Gemini/Antigravity CLI documents memory files and shows a local
//! `~/.gemini/antigravity-cli/brain/` directory of session traces, while an
//! older issue reports `save_memory` never landing on disk. Whether the
//! editable native store exists must be decided locally; the declaration
//! records the unverified reason and publishes no management entry.
use std::path::{Path, PathBuf};

use super::Antigravity;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Antigravity {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Antigravity 记忆证据冲突（brain/ 会话痕迹与 save_memory 不落本地），待本机核验后定论",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Antigravity 的记忆存储形态待本机核验，目录不可解析".into())
    }
}
