use super::Pi;
use crate::adapters::agents::{AgentAdapter, AgentCapability};
use crate::native::adapter::Scope;
use std::path::{Path, PathBuf};

impl AgentAdapter for Pi {
    fn capability(&self) -> AgentCapability {
        let (version,supported,format,detail,template) = ("0.99.2", false, "text", "此版本未证实统一的原生 agent 定义格式。扩展自定义的 subagent 由对应 package 管理；AGENTS.md 属于规则。", "");
        AgentCapability {
            version,
            supported,
            format,
            detail,
            template,
        }
    }
    fn root(
        &self,
        _scope: Scope,
        _home: &Path,
        _project: Option<&Path>,
    ) -> Result<PathBuf, String> {
        Err(self.capability().detail.into())
    }
}
