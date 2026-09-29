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
use crate::native::intake::{api_format, string_at};
use crate::native::profile::{self, Connection, RegisteredProfile};

pub struct Grok;

impl CliAdapter for Grok {
    fn id(&self) -> &'static str {
        "grok"
    }
    fn name(&self) -> &'static str {
        "Grok"
    }
    fn command(&self) -> &'static str {
        "grok"
    }
    fn npm_package(&self) -> &'static str {
        "@xai-official/grok"
    }
    fn version_identity(&self, _basename: &str, output: &str) -> bool {
        output.contains("grok")
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
                root.join(".grok/config.toml"),
                FileKind::Toml,
                known,
                Some("Grok 的项目配置只读取 MCP、插件和权限规则；模型与连接在用户配置中设置"),
                false,
            )],
            None => vec![file(
                "settings",
                env::var_os("GROK_HOME")
                    .map(Into::into)
                    .unwrap_or_else(|| home.join(".grok"))
                    .join("config.toml"),
                FileKind::Toml,
                known,
                None,
                false,
            )],
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
        if role == "settings" {
            Ok(FileKind::Toml)
        } else {
            Err("Grok 不支持此原生文件角色".into())
        }
    }
    fn connection_documents(
        &self,
        connection: &Connection,
        scope: Scope,
    ) -> Result<BTreeMap<String, Value>, String> {
        if scope == Scope::Project {
            return Err("Grok 项目层不能安全写入供应商连接；请使用全局配置".into());
        }
        let backend = match connection.interface_format.as_str() {
            "openai_completions" => "chat_completions",
            "openai_responses" => "responses",
            "anthropic_messages" => "messages",
            _ => return Err("Grok 不支持所选接口格式".into()),
        };
        let mut settings = json!({});
        let model = connection.model.as_str();
        set_json(&mut settings, &["models", "default"], json!(model));
        set_json(&mut settings, &["model", model, "model"], json!(model));
        set_json(
            &mut settings,
            &["model", model, "base_url"],
            json!(connection.base_url),
        );
        set_json(
            &mut settings,
            &["model", model, "api_backend"],
            json!(backend),
        );
        if let Some(env) = profile::auth_env_name(crate::domain::CliId::Grok, connection) {
            set_json(&mut settings, &["model", model, "env_key"], json!(env));
        }
        Ok(BTreeMap::from([("settings".into(), settings)]))
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
            return Err("Grok 项目层不能写入供应商密钥；请使用全局配置".into());
        }
        secrets.put(
            "settings",
            &["model", &connection.model, "api_key"],
            read_secret(id, credentials)?,
        );
        secrets.remove("settings", &["model", &connection.model, "env_key"]);
        Ok(())
    }
    fn has_native_secret(&self, role: &str, root: &Value) -> bool {
        role == "settings"
            && root
                .get("model")
                .and_then(Value::as_object)
                .is_some_and(|models| models.values().any(|item| item.get("api_key").is_some()))
    }
    fn inspect_values(&self, settings: &Value, _: &Value, _: &Value) -> InspectionFields {
        let model = string_at(settings, &["models", "default"]).map(str::to_owned);
        let (base, wire, env) = model
            .as_ref()
            .map(|id| {
                (
                    string_at(settings, &["model", id, "base_url"]).map(str::to_owned),
                    string_at(settings, &["model", id, "api_backend"]).and_then(api_format),
                    string_at(settings, &["model", id, "env_key"]).map(str::to_owned),
                )
            })
            .unwrap_or((None, None, None));
        InspectionFields {
            provider: Some("grok".into()),
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
        super::import_toml_key(
            "model",
            "api_key",
            found.model.as_deref().map(str::to_owned).as_deref(),
            files,
            found,
            pending,
        )
    }
    fn launch_args(&self, session: Option<&str>, mode: LaunchMode) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        if let Some(id) = session {
            args.extend(["--resume".into(), id.into()]);
        }
        if matches!(mode, LaunchMode::Yolo) {
            args.push("--yolo".into());
        }
        Ok(args)
    }
    fn supports_project_model_override(&self) -> bool {
        true
    }
    fn project_model_args(&self, model: Option<&str>) -> Result<Vec<String>, String> {
        let Some(model) = model else {
            return Ok(Vec::new());
        };
        if model.trim().is_empty() {
            return Err("请输入 Grok 项目启动模型".into());
        }
        Ok(vec!["-m".into(), model.into()])
    }
    fn install_guidance(&self) -> (&'static str, &'static str) {
        (
            "https://x.ai/cli",
            "按 xAI Build 官方安装说明更新 Grok CLI。",
        )
    }
    fn node_required_when_missing(&self) -> bool {
        false
    }
    fn install_command(&self) -> Option<String> {
        Some(
            if cfg!(windows) {
                "irm https://x.ai/cli/install.ps1 | iex"
            } else {
                "curl -fsSL https://x.ai/cli/install.sh | bash"
            }
            .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_toml_keeps_native_permission_and_unrecognized_fields() {
        let text =
            "[permission]\nrules = [{ action = 'allow', tool = 'read' }]\n[future]\nflag = true\n";
        let parsed = crate::native::format::parse(FileKind::Toml, text).unwrap();
        let documents = BTreeMap::from([("settings".into(), parsed)]);
        Grok.validate_documents(Scope::Project, &documents).unwrap();
    }

    #[test]
    fn project_model_is_passed_as_launch_argument() {
        assert!(Grok.supports_project_model_override());
        assert_eq!(
            Grok.project_model_args(Some("grok-4.7")).unwrap(),
            ["-m", "grok-4.7"]
        );
        assert!(Grok.project_model_args(Some(" ")).is_err());
    }
}
