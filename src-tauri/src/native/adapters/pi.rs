use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::path::Path;

use super::{
    file, project_root, CliAdapter, InspectionFields, LaunchMode, NativeCredentialRefs,
    PendingSecrets,
};
use crate::credentials::CredentialStore;
use crate::native::adapter::{NativeFile, Scope};
use crate::native::apply::{read_secret, set_json, NativeSecrets};
use crate::native::format::FileKind;
use crate::native::intake::NativeInspection;
use crate::native::intake::{api_format, pi_env_name, string_at};
use crate::native::profile::{self, Connection, RegisteredProfile};

pub struct Pi;

impl CliAdapter for Pi {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn name(&self) -> &'static str {
        "Pi"
    }
    fn command(&self) -> &'static str {
        "pi"
    }
    fn npm_package(&self) -> &'static str {
        "@earendil-works/pi-coding-agent"
    }
    fn version_identity(&self, basename: &str, output: &str) -> bool {
        output.contains("pi ")
            || (basename == "pi"
                && (output.starts_with('v')
                    || output.chars().next().is_some_and(|c| c.is_ascii_digit())))
    }
    fn native_files(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
        known: bool,
    ) -> Vec<NativeFile> {
        let Some(root) = project_root(scope, project) else {
            return vec![];
        };
        match root {
            Some(root) => vec![file(
                "settings",
                root.join(".pi/settings.json"),
                FileKind::Json,
                known,
                None,
                false,
            )],
            None => {
                let dir = env::var_os("PI_CODING_AGENT_DIR")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".pi/agent"));
                vec![
                    file(
                        "settings",
                        dir.join("settings.json"),
                        FileKind::Json,
                        known,
                        None,
                        false,
                    ),
                    file(
                        "models",
                        dir.join("models.json"),
                        FileKind::Jsonc,
                        known,
                        None,
                        false,
                    ),
                    file(
                        "auth",
                        dir.join("auth.json"),
                        FileKind::Json,
                        known,
                        Some("原生凭据文件独立保护，不进入配置草稿"),
                        true,
                    ),
                ]
            }
        }
    }
    fn interface_formats(&self) -> &'static [&'static str] {
        &[
            "openai_completions",
            "openai_responses",
            "anthropic_messages",
        ]
    }
    fn file_kind(&self, role: &str) -> Result<FileKind, String> {
        match role {
            "settings" => Ok(FileKind::Json),
            "models" => Ok(FileKind::Jsonc),
            _ => Err("Pi 不支持此原生文件角色".into()),
        }
    }
    fn portable_root_fields(&self, role: &str) -> &'static [&'static str] {
        match role {
            "settings" => &["defaultProvider", "defaultModel", "defaultThinkingLevel", "models"],
            "models" => &["providers"],
            _ => &[],
        }
    }
    fn skill_root(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => env::var_os("PI_CODING_AGENT_DIR")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".pi/agent"))
                .join("skills"),
            Scope::Project => project?.join(".pi/skills"),
        })
    }
    fn rule_path(
        &self,
        scope: Scope,
        home: &Path,
        project: Option<&Path>,
    ) -> Option<std::path::PathBuf> {
        Some(match scope {
            Scope::Global => env::var_os("PI_CODING_AGENT_DIR")
                .map(Into::into)
                .unwrap_or_else(|| home.join(".pi/agent"))
                .join("AGENTS.md"),
            Scope::Project => project?.join("AGENTS.md"),
        })
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Pi 项目层不能安全写入供应商连接；请使用全局配置".into());
        }
        let api = match connection.interface_format.as_str() {
            "openai_completions" => "openai-completions",
            "openai_responses" => "openai-responses",
            "anthropic_messages" => "anthropic-messages",
            _ => return Err("Pi 不支持所选接口格式".into()),
        };
        let provider = connection.provider_id.as_str();
        let model = connection.model.as_str();
        let mut settings = json!({});
        set_json(&mut settings, &["defaultProvider"], json!(provider));
        set_json(&mut settings, &["defaultModel"], json!(model));
        let mut models = json!({});
        set_json(
            &mut models,
            &["providers", provider, "baseUrl"],
            json!(connection.base_url),
        );
        set_json(&mut models, &["providers", provider, "api"], json!(api));
        set_json(
            &mut models,
            &["providers", provider, "models"],
            json!([{"id":model}]),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::Pi, connection) {
            set_json(
                &mut models,
                &["providers", provider, "apiKey"],
                json!(format!("${{{env}}}")),
            );
        }
        Ok(BTreeMap::from([
            ("settings".into(), settings),
            ("models".into(), models),
        ]))
    }
    fn connection_documents_for_existing(&self, connection: &Connection, scope: Scope, existing: &BTreeMap<String, Value>) -> Result<BTreeMap<String, Value>, String> {
        let mut docs = self.connection_documents(connection,scope)?;
        if let Some(models) = docs.get_mut("models") {
            let old = existing.get("models").and_then(|root| root.get("providers")).and_then(|root| root.get(&connection.provider_id)).and_then(|root| root.get("models")).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut values = old;
            if !values.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(connection.model.as_str())) { values.push(json!({"id":connection.model})); }
            set_json(models,&["providers",&connection.provider_id,"models"],json!(values));
        }
        Ok(docs)
    }
    fn preserve_native_fields(&self, role: &str, original: &Value, fields: &mut BTreeMap<String, Value>, profile: &RegisteredProfile) -> Result<(), String> {
        if role != "models" { return Ok(()); }
        let Some(connection) = &profile.connection else { return Ok(()); };
        let pointer = format!("/providers/{}/models",connection.provider_id.replace('~',"~0").replace('/',"~1"));
        let Some(next) = fields.get_mut(&pointer).and_then(Value::as_array_mut) else { return Ok(()); };
        if let Some(old) = original.pointer(&pointer).and_then(Value::as_array) {
            for item in old {
                if let Some(found) = next.iter_mut().find(|value| value.get("id") == item.get("id")) {
                    if let (Some(current),Some(changes)) = (item.as_object(),found.as_object()) { let mut merged=current.clone(); merged.extend(changes.clone()); *found=Value::Object(merged); }
                } else { next.push(item.clone()); }
            }
        }
        Ok(())
    }
    fn write_connection_secret(
        &self,
        profile: &RegisteredProfile,
        scope: Scope,
        credentials: &dyn CredentialStore,
        secrets: &mut NativeSecrets,
    ) -> Result<(), String> {
        let Some(connection) = &profile.connection else {
            return Ok(());
        };
        let Some(id) = &connection.secret_ref else {
            return Ok(());
        };
        if scope == Scope::Project {
            return Err("Pi 项目层不能写入供应商密钥；请使用全局配置".into());
        }
        secrets.put(
            "models",
            &["providers", &connection.provider_id, "apiKey"],
            read_secret(id, credentials)?,
        );
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "models"
            && root
                .get("providers")
                .and_then(Value::as_object)
                .is_some_and(|providers| {
                    providers.values().any(|item| item.get("apiKey").is_some())
                })
    }
    fn inspect_values(&self, settings: &Value, _: &Value, models: &Value) -> InspectionFields {
        let provider = string_at(settings, &["defaultProvider"])
            .map(str::to_owned)
            .or_else(|| models.get("providers")?.as_object()?.keys().next().cloned());
        let mut model = string_at(settings, &["defaultModel"]).map(str::to_owned);
        let entry = provider
            .as_ref()
            .and_then(|id| models.get("providers").and_then(|value| value.get(id)));
        let base = entry
            .and_then(|value| value.get("baseUrl"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let wire = entry
            .and_then(|value| value.get("api"))
            .and_then(Value::as_str)
            .and_then(api_format);
        let env = entry
            .and_then(|value| value.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(pi_env_name)
            .map(str::to_owned);
        if model.is_none() {
            model = entry
                .and_then(|value| value.get("models"))
                .and_then(Value::as_array)
                .and_then(|list| list.first())
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        InspectionFields {
            provider,
            model,
            base,
            wire,
            env,
            ..InspectionFields::default()
        }
    }
    fn import_literal_secrets(
        &self,
        files: &mut BTreeMap<String, String>,
        found: &mut NativeInspection,
        pending: &mut PendingSecrets,
        _: &mut NativeCredentialRefs,
    ) -> Result<(), String> {
        let raw = files.get("models").cloned().unwrap_or_default();
        let models = crate::native::format::parse(FileKind::Jsonc, &raw)?;
        if let Some(providers) = models.get("providers").and_then(Value::as_object) {
            for (name, provider) in providers {
                let Some(key) = provider.get("apiKey").and_then(Value::as_str) else {
                    continue;
                };
                if pi_env_name(key).is_some() {
                    continue;
                }
                if found.provider_id.as_deref() != Some(name.as_str()) || found.connection.is_none()
                {
                    return Err(format!("Pi 供应商 {name} 含字面 apiKey；请先在原生配置中选择完整的默认供应商与模型，再逐一安全接入。原文件未更改"));
                }
                if key.is_empty() || key.len() > 16_384 {
                    return Err("Pi 原生 apiKey 为空或超过系统凭据库限制；原文件未更改".into());
                }
                let id = format!("connection-{}", uuid::Uuid::new_v4());
                let connection = found.connection.as_mut().unwrap();
                connection.secret_ref = Some(id.clone());
                let env = self
                    .auth_env_name(connection)
                    .ok_or("无法确定 Pi 的认证环境变量")?;
                connection.auth_env_var = Some(env.clone());
                let replaced = crate::native::format::set_path(
                    FileKind::Jsonc,
                    &raw,
                    &["providers".into(), name.clone(), "apiKey".into()],
                    Some(&json!(format!("${{{env}}}"))),
                )?;
                files.insert("models".into(), replaced);
                pending.push((id, key.to_owned()));
            }
        }
        Ok(())
    }
    fn validate_draft(&self, role: &str, parsed: &Value) -> Result<(), String> {
        if role != "models" {
            return Ok(());
        }
        if let Some(providers) = parsed.get("providers").and_then(Value::as_object) {
            for (name, provider) in providers {
                if let Some(key) = provider.get("apiKey").and_then(Value::as_str) {
                    if pi_env_name(key).is_none() {
                        return Err(format!("Pi 供应商 {name} 的 apiKey 须使用 $NAME 或 ${{NAME}} 环境变量引用；请通过安全接入迁移字面密钥"));
                    }
                }
            }
        }
        Ok(())
    }
    fn connection_roles(&self) -> &'static [&'static str] {
        &["settings", "models"]
    }
    fn validate_role_scope(&self, role: &str, scope: Scope) -> Result<(), String> {
        if scope == Scope::Project && role == "models" {
            Err("Pi 项目层不支持自定义 models.json".into())
        } else {
            Ok(())
        }
    }
    fn login_args(&self) -> Option<Vec<String>> { Some(vec![]) }
    fn login_hint(&self) -> &'static str { "Pi 打开后输入 /login，选择供应商并登录。" }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        if matches!(mode, LaunchMode::Yolo) {
            return Err("Pi 尚无已验证的 YOLO 启动参数".into());
        }
        Ok(session
            .map(|id| vec!["--session".into(), id.into()])
            .unwrap_or_default())
    }
    fn history_sources(
        &self,
        home: &std::path::Path,
    ) -> Result<Vec<crate::history::HistorySource>, String> {
        crate::history::pi::sources(home)
    }
    fn parse_history(
        &self,
        source: &crate::history::HistorySource,
    ) -> Result<crate::history::ParsedSession, String> {
        crate::history::pi::parse(source)
    }
    fn history_sources_controlled(&self, home: &std::path::Path, cancelled: &dyn Fn() -> bool) -> Result<Vec<crate::history::HistorySource>, String> {
        crate::history::pi::sources_controlled(home, cancelled)
    }
    fn parse_history_controlled(&self, source: &crate::history::HistorySource, cancelled: &dyn Fn() -> bool) -> Result<crate::history::ParsedSession, String> {
        crate::history::pi::parse_controlled(source, cancelled)
    }
    fn history_supported(&self) -> bool {
        true
    }
    fn history_resume_version_supported(&self, version: &str) -> bool {
        version.starts_with("0.")
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
            "使用安装 Pi 的同一包管理器更新。",
        )
    }
    fn minimum_node_version(&self) -> Option<(u32, u32, u32)> {
        Some((22, 19, 0))
    }
    fn node_dependency_detail(&self) -> &'static str {
        "Pi 的 npm 安装需要 Node.js 22.19 或更新版本"
    }
    fn requires_windows_bash(&self) -> bool {
        true
    }
    fn install_command(&self) -> Option<String> {
        Some(format!(
            "npm install -g --ignore-scripts {}",
            self.npm_package()
        ))
    }
    fn upgrade_command(&self, source: &str) -> Option<String> {
        (source == "npm_shim").then(|| {
            format!(
                "npm install -g --ignore-scripts {}@latest",
                self.npm_package()
            )
        })
    }
}
