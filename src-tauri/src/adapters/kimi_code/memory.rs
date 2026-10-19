//! Kimi Code memory verdict (final, 2026-10-19, kimi-code 2.2.0 on Windows):
//! the CLI has no persistent memory feature. The official data-locations page
//! enumerates the complete `$KIMI_CODE_HOME` layout with no memory directory,
//! the docs site has no memory page, `kimi --help` exposes no memory command,
//! the dist bundle carries no memory storage path or config key (its
//! "memory" hits are in-process agent context machinery plus an unused
//! bundled SDK surface), and neither the active `~/.kimi-code` root nor the
//! legacy `~/.kimi` root holds any memory or projects directory. The earlier
//! community hint about `~/.kimi/projects/<hash>/memory/` did not survive
//! verification. The declaration records the final no-memory reason and
//! publishes no management entry.
use std::path::{Path, PathBuf};

use super::KimiCode;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for KimiCode {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "官方数据路径文档列全 $KIMI_CODE_HOME 布局无记忆目录，本机 kimi-code 2.2.0 无记忆命令、配置键或目录；无持久记忆功能",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Kimi Code 无持久记忆功能，目录不可解析".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_verdict_records_the_reason_and_never_resolves_a_directory() {
        let adapter = KimiCode;
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
                "Kimi Code 无持久记忆功能，目录不可解析"
            );
        }
    }
}
