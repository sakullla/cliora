//! Antigravity memory verdict (final, 2026-10-19, agy 1.3.1 on Windows):
//! no editable native memory store. Local probes show
//! `~/.gemini/antigravity-cli/brain/` empty and `implicit/` holding only an
//! encrypted protobuf session trajectory; the binary's own embedded prompts
//! describe `<appDataDir>/brain/<conversation-id>/` as per-conversation
//! artifact/scratch/transcript directories, `retrieve_memory` and
//! `cascade/user_memory_summary` exist only as cloud protocol fields, and no
//! memory command, tool, settings key, or markdown store exists anywhere in
//! the CLI surface. Session traces and cloud-held summaries are not
//! manageable storage; the declaration records the final reason and
//! publishes no management entry.
use std::path::{Path, PathBuf};

use super::Antigravity;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Antigravity {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "本机 agy 1.3.1 实证无可编辑记忆存储：brain/<id>/ 是会话产物与转录目录，implicit/ 是加密 protobuf 会话轨迹，记忆摘要仅存在于云端协议；无记忆命令、工具或配置键",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Antigravity 无可编辑原生存储，目录不可解析".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_verdict_records_the_reason_and_never_resolves_a_directory() {
        let adapter = Antigravity;
        let declaration = adapter.declaration();
        assert!(!declaration.unverified_reason.trim().is_empty());
        assert!(!declaration.scope.declared());
        assert!(declaration.operations.is_empty());
        assert!(crate::adapters::memory::publish(&declaration).is_none());
        for (scope, project) in [
            (Scope::Global, None),
            (Scope::Project, Some(Path::new("/work/p"))),
        ] {
            assert_eq!(
                adapter
                    .directory(scope, Path::new("/home/example"), project)
                    .unwrap_err(),
                "Antigravity 无可编辑原生存储，目录不可解析"
            );
        }
    }
}
