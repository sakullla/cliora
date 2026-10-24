//! Devin memory verdict (re-checked 2026-10-24, still undelivered): no local
//! editable memory store. Local verification on devin 3000.11.205: the data
//! directory `%APPDATA%/devin` holds config.json, credentials.toml, mcp* and
//! skills/cli only, and the full `--help` command surface exposes no memory
//! command. Official docs agree three ways on the same date: the CLI
//! quickstart states "Devin CLI does not yet support Knowledge, Playbooks, or
//! Secrets from your Devin account." (cli/index.md line 118, memory not
//! listed), the llms.txt index of all 39 cli/ pages contains no CLI memory
//! page, and the changelog carries no memory entry. Devin Memory (the cloud
//! memory drive) is a product capability that never touches the CLI. The
//! nearest CLI mechanism is per-session rule injection — explicitly maintained
//! context files, not cross-session accumulated memory.
use std::path::{Path, PathBuf};

use super::Devin;
use crate::adapters::memory::{MemoryAdapter, MemoryDeclaration};
use crate::native::adapter::Scope;

impl MemoryAdapter for Devin {
    fn declaration(&self) -> MemoryDeclaration {
        MemoryDeclaration::unverified(
            "Devin 无本地记忆存储（2026-10-24 复核）：本机 3000.11.205 数据目录仅 config.json/credentials.toml/mcp*/skills/cli，全量命令面无记忆命令；官方 CLI quickstart 明示 Knowledge/Playbooks/Secrets 尚未支持且未列 Memory，llms.txt 全量索引无 CLI memory 页面，changelog 无记忆条目；云端 Devin Memory 为 product 能力与 CLI 无涉",
        )
    }

    fn directory(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err("Devin 没有可管理的本地记忆存储（云端 Devin Memory 与 CLI 无涉）".into())
    }
}
