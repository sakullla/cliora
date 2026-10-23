//! Terminal `mcode login` / `mcode logout`. China is the default region.
//!
//! Login state is `auth/<buildEnv>/<region>/mcode-public/auth-state.json`. That
//! file is rejected if it contains a credential field. It has no account id.
//! `cli-auth/<buildEnv>/<region>/account-identity.json` may later supply
//! `realUserID` and an optional email; its token fingerprint is ignored.
//! `auth.json` and `local-runtime.auth.json` are never opened.
use super::{data_dir, resolve_data_dir, safe_absolute, DataDir, MiniMaxCode};
use crate::accounts::{context, AccountCapability, AccountIdentity, AccountState, NativeContext, NativeLogin, Observation};
use crate::adapters::accounts::AccountAdapter;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const BUILD_ENVS: [&str; 4] = ["dev", "test", "staging", "prod"];
const REGIONS: [&str; 2] = ["cn", "en"];
const CLIENT_ID: &str = "mcode-public";
const STATE_LIMIT: u64 = 65_536;

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
    fn discovery_needs_executable(&self) -> bool {
        false
    }
    fn observation_needs_executable(&self) -> bool {
        false
    }
    fn discover(
        &self,
        _executable: Option<&Path>,
        context: &NativeContext,
    ) -> Result<Vec<NativeLogin>, String> {
        let observation = self.observe(Path::new(""), context)?;
        Ok(vec![NativeLogin {
            provider: self.capability().provider.into(),
            auth_kind: "oauth".into(),
            state: observation.state,
            identity: observation.identity,
            detail: observation.detail,
            managed_account_id: None,
        }])
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
            reason: "登录和退出在终端执行 mcode login / mcode logout。登录是否完成只看不含凭证的 auth-state.json；账号 ID 只在账号身份文件提供 realUserID 时显示。",
            identity_source: "auth-state.json；可选 cli-auth account-identity.json 的 realUserID",
            identity_required: false,
            refresh_owner: "native_cli",
            acceptance: "已核对 mcode login/logout 与 auth-state.json。不读取 auth.json 或 local-runtime.auth.json",
        }
    }
    fn context(&self, root: PathBuf, id: String) -> Result<NativeContext, String> {
        let directory = root.to_string_lossy().into_owned();
        let mut environment = BTreeMap::new();
        environment.insert("MINIMAX_DATA_DIR".into(), directory.clone());
        environment.insert("MAVIS_DATA_DIR".into(), directory);
        Ok(NativeContext {
            id,
            tool_id: "minimax_code".into(),
            root: root.clone(),
            config_root: root.clone(),
            auth_files: state_candidates(&root),
            history_roots: Vec::new(),
            resource_root: root,
            environment,
            remove_environment: Vec::new(),
            cli_args: Vec::new(),
        })
    }
    fn sign_in_requires_identity(&self) -> bool {
        false
    }
    fn observe(&self, _executable: &Path, context: &NativeContext) -> Result<Observation, String> {
        let directory = data_directory(context)?;
        let states = read_states(&directory)?;
        let authenticated: Vec<_> = states
            .iter()
            .filter(|state| matches!(state.status.as_str(), "authenticated" | "refreshing" | "scope_upgrade_required"))
            .cloned()
            .collect();
        if authenticated.len() > 1 {
            return Ok(unknown("发现多份已登录状态，没有选用其中一份。"));
        }
        let Some(state) = authenticated.first().cloned().or_else(|| states.first().cloned()) else {
            return Ok(signed_out("没有登录状态。"));
        };
        match state.status.as_str() {
            "authenticated" | "refreshing" | "scope_upgrade_required" => signed_in(context, &directory, &state),
            "expired" => Ok(Observation {
                state: AccountState::Expired,
                identity: None,
                detail: Some("登录状态已过期，请重新登录。".into()),
            }),
            "anonymous" | "logging_out" | "logout_pending" => Ok(signed_out("原生上下文未登录。")),
            "authorizing" => Ok(unknown("登录尚未完成。")),
            "error" => Ok(unknown("MiniMax Code 把登录状态标为失败，请重新登录。")),
            _ => Ok(unknown("登录状态无法识别。")),
        }
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

#[derive(Clone)]
struct AuthStatus {
    status: String,
    build_env: Option<String>,
    region: Option<String>,
}

fn signed_out(detail: &str) -> Observation {
    Observation {
        state: AccountState::SignedOut,
        identity: None,
        detail: Some(detail.into()),
    }
}

fn unknown(detail: &str) -> Observation {
    Observation {
        state: AccountState::Unknown,
        identity: None,
        detail: Some(detail.into()),
    }
}

fn signed_in(context: &NativeContext, directory: &Path, state: &AuthStatus) -> Result<Observation, String> {
    let identity = identity_from_file(directory, state)?;
    let legacy = !context.environment.contains_key("MINIMAX_DATA_DIR") && directory != context.root;
    let detail = if identity.is_some() {
        "已登录。账号 ID 来自账号身份文件，未读取凭证。"
    } else if legacy {
        "已登录。这次登录写在 MiniMax 默认数据目录。登录状态没有账号 ID，未读取凭证。"
    } else {
        "已登录。登录状态没有账号 ID 或邮箱，未读取凭证。"
    };
    Ok(Observation {
        state: AccountState::SignedIn,
        identity,
        detail: Some(detail.into()),
    })
}

fn data_directory(context: &NativeContext) -> Result<PathBuf, String> {
    if let Some(path) = configured_directory(context)? {
        return Ok(path);
    }
    if state_present(&context.root) {
        return Ok(context.root.clone());
    }
    // Terminals opened before the data directory was pinned inherited the
    // process default. Only accept that after the login command exits 0.
    if exit_code(&context.root) == Some(0) {
        if let Some(path) = process_default_data_dir() {
            if path.is_dir() {
                context::check_path(&path)?;
                return Ok(path);
            }
        }
    }
    Ok(context.root.clone())
}

fn configured_directory(context: &NativeContext) -> Result<Option<PathBuf>, String> {
    for key in ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"] {
        if let Some(raw) = context.environment.get(key).map(String::as_str) {
            if raw.trim().is_empty() {
                continue;
            }
            let Some(path) = safe_absolute(raw) else {
                return Err("MiniMax Code 数据目录必须是不含上级目录的绝对路径".into());
            };
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn process_default_data_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match data_dir(&home) {
        DataDir::Directory(path) => Some(path),
        DataDir::Unavailable => None,
    }
}

fn exit_code(root: &Path) -> Option<i32> {
    let path = root.join(".cliora-auth-exit");
    context::check_path(&path).ok()?;
    let mut text = String::new();
    File::open(path).ok()?.take(16).read_to_string(&mut text).ok()?;
    text.trim().parse().ok()
}

fn state_candidates(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for build_env in BUILD_ENVS {
        for region in REGIONS {
            paths.push(state_path(root, build_env, region));
        }
    }
    paths.push(root.join("auth").join("auth-state.json"));
    paths
}

fn state_path(root: &Path, build_env: &str, region: &str) -> PathBuf {
    root.join("auth")
        .join(build_env)
        .join(region)
        .join(CLIENT_ID)
        .join("auth-state.json")
}

fn state_present(root: &Path) -> bool {
    state_candidates(root).iter().any(|path| path.is_file())
}

fn read_states(root: &Path) -> Result<Vec<AuthStatus>, String> {
    let mut namespaced = Vec::new();
    for build_env in BUILD_ENVS {
        for region in REGIONS {
            if let Some(state) = read_state(&state_path(root, build_env, region))? {
                namespaced.push(state);
            }
        }
    }
    if !namespaced.is_empty() {
        return Ok(namespaced);
    }
    Ok(read_state(&root.join("auth").join("auth-state.json"))?.into_iter().collect())
}

fn read_state(path: &Path) -> Result<Option<AuthStatus>, String> {
    let Some(value) = read_object(path)? else {
        return Ok(None);
    };
    if contains_secret_key(&value) {
        return Err("登录状态文件含凭证字段，已拒绝使用".into());
    }
    let schema = value.get("schemaVersion").and_then(Value::as_i64);
    if !matches!(schema, Some(1) | Some(2)) {
        return Err("登录状态文件格式不兼容".into());
    }
    if value.get("clientId").and_then(Value::as_str) != Some(CLIENT_ID) {
        return Err("登录状态文件格式不兼容".into());
    }
    let store = value.get("storeKind").and_then(Value::as_str);
    let store_ok = match schema {
        Some(1) => matches!(store, Some("file") | Some("os-keyring")),
        Some(2) => store == Some("file"),
        _ => false,
    };
    if !store_ok {
        return Err("登录状态文件格式不兼容".into());
    }
    let Some(status) = value.get("status").and_then(Value::as_str) else {
        return Err("登录状态文件格式不兼容".into());
    };
    if !matches!(
        status,
        "anonymous"
            | "authorizing"
            | "authenticated"
            | "refreshing"
            | "scope_upgrade_required"
            | "logging_out"
            | "logout_pending"
            | "expired"
            | "error"
    ) {
        return Err("登录状态文件格式不兼容".into());
    }
    Ok(Some(AuthStatus {
        status: status.into(),
        build_env: allowlisted(value.get("buildEnv"), &BUILD_ENVS),
        region: allowlisted(value.get("region"), &REGIONS),
    }))
}

fn identity_from_file(root: &Path, state: &AuthStatus) -> Result<Option<AccountIdentity>, String> {
    let (Some(build_env), Some(region)) = (state.build_env.as_deref(), state.region.as_deref()) else {
        return Ok(None);
    };
    let path = root
        .join("cli-auth")
        .join(build_env)
        .join(region)
        .join("account-identity.json");
    let Some(value) = read_object(&path)? else {
        return Ok(None);
    };
    if contains_secret_key(&value) {
        return Ok(None);
    }
    if value.get("version").and_then(Value::as_i64) != Some(1) || value.get("status").and_then(Value::as_str) != Some("verified") {
        return Ok(None);
    }
    if value.get("buildEnv").and_then(Value::as_str) != Some(build_env) || value.get("region").and_then(Value::as_str) != Some(region) {
        return Ok(None);
    }
    let Some(subject) = plain_id(value.get("realUserID")) else {
        return Ok(None);
    };
    Ok(Some(AccountIdentity {
        subject,
        email: value.get("userEmail").and_then(Value::as_str).and_then(plain_email),
        plan: None,
        source: "minimax_account_identity".into(),
    }))
}

fn allowlisted(value: Option<&Value>, allowed: &[&str]) -> Option<String> {
    let text = value?.as_str()?;
    allowed.iter().find(|item| **item == text).map(|item| (*item).to_owned())
}

fn plain_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if (1..=128).contains(&text.chars().count()) && text.chars().all(|char| !char.is_control() && !char.is_whitespace()) {
        Some(text.to_owned())
    } else {
        None
    }
}

fn plain_email(value: &str) -> Option<String> {
    let text = value.trim();
    if (3..=254).contains(&text.len())
        && text.chars().all(|char| !char.is_control() && !char.is_whitespace())
        && text.matches('@').count() == 1
        && !text.starts_with('@')
        && !text.ends_with('@')
    {
        Some(text.to_owned())
    } else {
        None
    }
}

fn read_object(path: &Path) -> Result<Option<Value>, String> {
    context::check_path(path)?;
    if !path.is_file() {
        return Ok(None);
    }
    let file = File::open(path).map_err(|_| "无法读取登录状态".to_owned())?;
    let mut bytes = Vec::new();
    file.take(STATE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取登录状态".to_owned())?;
    if bytes.len() as u64 > STATE_LIMIT {
        return Err("登录状态文件过大".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "登录状态文件格式不兼容".to_owned())?;
    if !value.is_object() {
        return Err("登录状态文件格式不兼容".into());
    }
    Ok(Some(value))
}

fn contains_secret_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| is_secret_key(key) || contains_secret_key(child)),
        Value::Array(items) => items.iter().any(contains_secret_key),
        _ => false,
    }
}

fn is_secret_key(key: &str) -> bool {
    let compact = key
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    compact == "accesstoken"
        || compact == "refreshtoken"
        || compact == "idtoken"
        || compact == "devicecode"
        || compact == "codeverifier"
        || compact == "password"
        || compact == "secret"
        || compact.contains("accesstoken")
        || compact.contains("refreshtoken")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{complete, create, prepare_login, AccountState};
    use crate::adapters::accounts::AccountAdapter;

    fn authenticated(dir: &Path) {
        let path = state_path(dir, "prod", "cn");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            r#"{"schemaVersion":2,"status":"authenticated","storeKind":"file","clientId":"mcode-public","scopes":["agent.default"],"audience":"agent-backend","buildEnv":"prod","region":"cn","generation":1}"#,
        )
        .unwrap();
    }

    #[test]
    fn authenticated_state_signs_in_without_reading_credentials_or_inventing_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("account");
        std::fs::create_dir_all(&root).unwrap();
        authenticated(&root);
        std::fs::write(root.join("auth").join("prod").join("cn").join(CLIENT_ID).join("auth.json"), r#"{"accessToken":"synthetic-token-must-not-leak"}"#).unwrap();
        let context = MiniMaxCode.context(root.clone(), "account".into()).unwrap();
        assert_eq!(context.environment.get("MINIMAX_DATA_DIR").map(String::as_str), Some(root.to_string_lossy().as_ref()));
        assert!(context.auth_files.iter().any(|path| path == &state_path(&root, "prod", "cn")));
        let observation = MiniMaxCode.observe(Path::new("mcode"), &context).unwrap();
        let discovered = MiniMaxCode.discover(None, &context).unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].state, AccountState::SignedIn);
        assert!(discovered[0].identity.is_none());
        assert_eq!(observation.state, AccountState::SignedIn);
        assert!(observation.identity.is_none());
        let detail = observation.detail.unwrap();
        assert!(detail.contains("已登录"));
        assert!(!detail.contains("synthetic-token"));
        assert!(!AccountAdapter::sign_in_requires_identity(&MiniMaxCode));
        assert!(!AccountAdapter::observation_needs_executable(&MiniMaxCode));
        assert!(!MiniMaxCode.capability().identity_required);
    }

    #[test]
    fn account_identity_supplies_the_subject_and_drops_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        authenticated(root);
        let identity = root.join("cli-auth").join("prod").join("cn").join("account-identity.json");
        std::fs::create_dir_all(identity.parent().unwrap()).unwrap();
        std::fs::write(
            &identity,
            r#"{"version":1,"status":"verified","tokenFingerprint":"sha256:not-an-id","realUserID":"user-123","userEmail":"a@example.com","buildEnv":"prod","region":"cn","updatedAtMs":1}"#,
        )
        .unwrap();
        let context = MiniMaxCode.context(root.to_path_buf(), "account".into()).unwrap();
        let observation = MiniMaxCode.observe(Path::new("mcode"), &context).unwrap();
        let identity = observation.identity.unwrap();
        assert_eq!(identity.subject, "user-123");
        assert_eq!(identity.email.as_deref(), Some("a@example.com"));
        assert!(!format!("{identity:?}").contains("sha256"));
        assert!(!observation.detail.unwrap().contains("sha256"));
    }

    #[test]
    fn credential_field_in_auth_state_is_rejected_without_echoing_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = state_path(root, "prod", "cn");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"schemaVersion":2,"status":"authenticated","storeKind":"file","clientId":"mcode-public","accessToken":"synthetic-token-must-not-leak"}"#).unwrap();
        let context = MiniMaxCode.context(root.to_path_buf(), "account".into()).unwrap();
        let error = MiniMaxCode.observe(Path::new("mcode"), &context).unwrap_err();
        assert!(error.contains("凭证"));
        assert!(!error.contains("synthetic-token"));
    }

    #[test]
    fn sign_in_without_an_account_id_clears_pending_only_for_minimax() {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::database::Database::open(&dir.path().join("cliora.db")).unwrap();
        let account = create(&db, "minimax_code", "MiniMax").unwrap();
        let pending = prepare_login(&db, dir.path(), &account.id, account.version).unwrap();
        let attempt = pending.pending_login.unwrap().id;
        let signed_in = complete(
            &db,
            &account.id,
            &attempt,
            Observation { state: AccountState::SignedIn, identity: None, detail: Some("已登录".into()) },
            crate::accounts::now(),
        )
        .unwrap();
        assert_eq!(signed_in.state, AccountState::SignedIn);
        assert!(signed_in.pending_login.is_none());
        assert!(signed_in.identity.is_none());

        let codex = create(&db, "codex", "Codex").unwrap();
        let pending = prepare_login(&db, dir.path(), &codex.id, codex.version).unwrap();
        let attempt = pending.pending_login.unwrap().id;
        let waiting = complete(
            &db,
            &codex.id,
            &attempt,
            Observation { state: AccountState::SignedIn, identity: None, detail: Some("未完成".into()) },
            crate::accounts::now(),
        )
        .unwrap();
        assert_eq!(waiting.state, AccountState::Pending);
        assert!(waiting.pending_login.is_some());
    }
}
