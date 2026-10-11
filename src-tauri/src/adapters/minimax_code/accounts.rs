//! Terminal `mcode login` / `mcode logout`. China is the default region.
//! There is no verified status command that avoids printing credentials, so
//! observation stays unconfirmed and never reads the data-dir auth files.
use super::{data_dir, resolve_data_dir, DataDir, MiniMaxCode};
use crate::accounts::{AccountCapability, AccountState, NativeContext, Observation};
use crate::adapters::accounts::AccountAdapter;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

impl AccountAdapter for MiniMaxCode {
    fn native_environment_keys(&self) -> &'static [&'static str] {
        &["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]
    }
    fn native_context(
        &self,
        home: &Path,
        environment: &BTreeMap<String, String>,
    ) -> Result<Option<NativeContext>, String> {
        let dir = match resolve_data_dir(
            home,
            environment.get("MINIMAX_DATA_DIR").map(String::as_str),
            environment.get("MAVIS_DATA_DIR").map(String::as_str),
        ) {
            DataDir::Directory(path) => path,
            DataDir::Unavailable => {
                return Err("MiniMax Code 数据目录必须是不含上级目录的绝对路径".into())
            }
        };
        self.context(dir, "native-default".into()).map(Some)
    }
    fn capability(&self) -> AccountCapability {
        AccountCapability {
            browser_link: false,
            tool_id: "minimax_code",
            provider: "minimax_code",
            version: "0.6.8",
            managed_login: true,
            import_native: false,
            methods: vec!["browser", "device"],
            reason: "登录和退出在终端执行 mcode login / mcode logout。没有已核对的、不输出凭证的状态命令，因此状态保持未确认。",
            identity_source: "未确认",
            refresh_owner: "native_cli",
            acceptance: "已核对 mcode login/logout 参数；不读取数据目录中的凭证文件",
        }
    }
    fn context(&self, root: PathBuf, id: String) -> Result<NativeContext, String> {
        Ok(NativeContext {
            id,
            tool_id: "minimax_code".into(),
            root: root.clone(),
            config_root: root.clone(),
            auth_files: Vec::new(),
            history_roots: Vec::new(),
            resource_root: root,
            environment: BTreeMap::new(),
            remove_environment: Vec::new(),
            cli_args: Vec::new(),
        })
    }
    fn observe(&self, _executable: &Path, _context: &NativeContext) -> Result<Observation, String> {
        Ok(Observation {
            state: AccountState::Unknown,
            identity: None,
            detail: Some("未确认。MiniMax Code 没有已核对的、不输出凭证的状态命令。".into()),
        })
    }
    fn login_args(&self, method: &str) -> Result<Vec<String>, String> {
        match method {
            "browser" | "cn" | "" => Ok(vec!["login".into()]),
            "device" | "global" => Ok(vec!["login".into(), "--region".into(), "global".into()]),
            _ => Err("MiniMax Code 登录只支持中国区与国际区".into()),
        }
    }
    fn logout_args(&self) -> Vec<String> {
        vec!["logout".into()]
    }
    fn terminal_logout(&self) -> bool {
        true
    }
    fn login_detail(&self) -> &'static str {
        "请在隔离终端完成 mcode login。取消只停止接纳结果，已打开的终端仍由用户控制。"
    }
    fn logout_detail(&self) -> &'static str {
        "在终端执行 mcode logout。这不删除栖点里保存的 API Key。"
    }
    fn native_root(&self, home: &Path) -> Result<PathBuf, String> {
        match data_dir(home) {
            DataDir::Directory(path) => Ok(path),
            DataDir::Unavailable => Err("MiniMax Code 数据目录必须是不含上级目录的绝对路径".into()),
        }
    }
}
