//! Antigravity memory verdict (final; the 1.3.1 finding confirmed, not
//! replaced, on 1.5.9): no editable native memory store. Established on
//! agy 1.3.1 (2026-10-19, local Windows probes: `~/.gemini/antigravity-cli/
//! brain/` empty, `implicit/` holding only an encrypted protobuf session
//! trajectory, the binary's embedded prompts describing
//! `<appDataDir>/brain/<conversation-id>/` as per-conversation artifacts) and
//! re-confirmed on 1.5.9 by the isolated remote evidence run of 2026-11-16
//! (docs/verification/remote-workflow/agy-1.5.9/evidence/memory.json): the
//! enumerated command surface has no `memory` subcommand, the interactive
//! `/` menu (48 commands, paged end to end) has no memory entry, the
//! signed-in machine's settings.json holds exactly `model`/`trustedWorkspaces`
//! with no memory key, no memory directory exists anywhere under
//! `~/.gemini/antigravity-cli/`, and `retrieve_memory`/`user_memory_summary`
//! remain cloud-protocol protobuf fields only. Session `brain/` trees,
//! transcripts, `implicit/` trajectories and cloud-held summaries are not
//! manageable storage; the declaration records the final reason and
//! publishes no management entry.
use std::path::{Path, PathBuf};

use super::Antigravity;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

/// Recorded absence verdict with the truthful history (1.3.1 finding,
/// 1.5.9 confirmation with the probe classes). Published on the descriptor
/// (`management.memory_reason`) so the shared UI shows an unavailable memory
/// view carrying this reason instead of hiding the dimension.
pub(crate) const UNVERIFIED_REASON: &str = "agy 无用户可编辑记忆存储（1.3.1 实证 2026-10-19，1.5.9 复核确认 2026-11-16）：命令面与交互 / 菜单（48 条）均无 memory 命令，settings.json 仅含 model/trustedWorkspaces 无记忆键，~/.gemini/antigravity-cli/ 下无记忆目录（brain/<id>/ 为会话产物与转录，implicit/ 为加密 protobuf 会话轨迹），retrieve_memory/user_memory_summary 仅存在于云端协议字段；会话产物与云端摘要不作记忆管理";

impl MemoryAdapter for Antigravity {
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
    fn confirmed_absence_verdict_records_the_reason_and_never_resolves_a_directory() {
        let adapter = Antigravity;
        let declaration = adapter.declaration();
        assert_eq!(declaration.unverified_reason, UNVERIFIED_REASON);
        // The recorded reason keeps the truthful history: the original 1.3.1
        // finding and its 1.5.9 confirmation with the probe classes.
        assert!(UNVERIFIED_REASON.contains("1.3.1"));
        assert!(UNVERIFIED_REASON.contains("1.5.9"));
        assert!(UNVERIFIED_REASON.contains("云端协议"));
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
                UNVERIFIED_REASON
            );
        }
    }
}
