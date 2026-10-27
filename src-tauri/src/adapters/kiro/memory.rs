//! Kiro memory (V3 engine) verdict, re-verified 2026-10-27.
//!
//! The V2-era "no memory feature" declaration is superseded: kiro.dev
//! docs/memory documents a V3 memory that is stored locally per user account
//! and shared between the IDE and the CLI on the same machine, configured
//! in-session through `/memories` (access levels read & write / read only /
//! off; under read & write the `reflection` toggle is the documented
//! "Automatic memory updates"). No local storage family exists on this
//! machine yet: every V3 `session.json` reads `memoryConfig {mode:
//! "disabled", reflection: false}` and no memory directory is present under
//! `~/.kiro` (probed 2026-10-27), and the storage path is not published in
//! any evidence class. The declaration therefore degrades with the enable
//! guidance instead of guessing a directory. Cliora never enables memory on
//! the user's behalf and never rewrites a session's `memoryConfig`.
use std::path::{Path, PathBuf};

use super::Kiro;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

/// Recorded degradation reason with the native enable guidance. The storage
/// path stays unverified until a local enable produces evidence. Published on
/// the descriptor (`management.memory_reason`) so the shared UI shows an
/// unavailable memory view instead of hiding the dimension.
pub(crate) const UNVERIFIED_REASON: &str = "Kiro V3 记忆按用户账号本地存储、IDE/CLI 同机共享（官方文档），但本机尚未启用：会话 memoryConfig 为 disabled 且 ~/.kiro 下无记忆存储目录（2026-10-27 实测），官方亦未记载存储路径；请在会话内 /memories → config 设为 read & write 启用（reflection 即 Automatic memory updates），本应用不代为启用、不改写会话内 memoryConfig";

impl MemoryAdapter for Kiro {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unverified_declaration_carries_the_native_enable_guidance() {
        let declaration = Kiro.declaration();
        assert!(!declaration.unverified_reason.is_empty());
        assert!(declaration.unverified_reason.contains("/memories"));
        assert!(declaration
            .unverified_reason
            .contains("read & write"));
        assert!(declaration
            .unverified_reason
            .contains("不代为启用"));
        // No scope or operation is published from an unverified declaration.
        assert!(!declaration.scope.declared());
        assert!(declaration.operations.is_empty());
        assert!(crate::adapters::memory::publish(&declaration).is_none());
        // Directory resolution keeps the same recorded reason instead of
        // inventing a native path.
        assert_eq!(
            Kiro.directory(Scope::Global, Path::new("/home/example"), None)
                .unwrap_err(),
            UNVERIFIED_REASON
        );
    }
}
