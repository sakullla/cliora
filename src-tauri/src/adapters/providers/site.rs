use super::*;
pub(crate) struct SiteProvider {
    pub id: &'static str,
    pub title: &'static str,
    pub source: &'static str,
    pub description: &'static str,
    pub user_instructions: &'static str,
    pub extra_parameters: &'static [&'static str],
    pub validate_parameters: fn(&QueryConfig) -> Result<(), UsageError>,
}
fn settings<'a>(
    adapter: &SiteProvider,
    config: &'a QueryConfig,
) -> Result<(&'a str, &'a str), UsageError> {
    let QueryProgram::Builtin {
        provider,
        template_version,
    } = &config.program
    else {
        return Err(UsageError::configuration("需要站点内置查询配置"));
    };
    let mode = config
        .parameters
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let subject = match mode {
        "key" => UsageSubject::Key,
        "account" | "account-plans" => UsageSubject::Account,
        "plans" => UsageSubject::Plan,
        _ => return Err(UsageError::configuration("请选择账户、套餐或 Key 查询范围")),
    };
    if *template_version != BUILTIN_TEMPLATE_VERSION
        || provider != adapter.id
        || config.targets.len() != 1
        || config.site != config.targets[0].origin
        || config.identity.subject != subject
        || config
            .parameters
            .keys()
            .any(|key| key != "mode" && !adapter.extra_parameters.contains(&key.as_str()))
    {
        return Err(UsageError::configuration(
            "站点、查询版本、参数或统计范围不匹配",
        ));
    }
    (adapter.validate_parameters)(config)?;

    Ok((provider, mode))
}
impl UsageProvider for SiteProvider {
    fn id(&self) -> &'static str {
        self.id
    }
    fn script(&self, config: &QueryConfig) -> Result<String, UsageError> {
        let (_, mode) = settings(self, config)?;
        let site = serde_json::to_string(&config.site)
            .map_err(|_| UsageError::configuration("站点无效"))?;
        let mode =
            serde_json::to_string(mode).map_err(|_| UsageError::configuration("范围无效"))?;
        Ok(format!(
            "const site = {site};\nconst mode = {mode};\n{}\n{}\n{}",
            include_str!("common.js"),
            include_str!("site-common.js"),
            self.source
        ))
    }
    fn validate_credentials(
        &self,
        config: &QueryConfig,
        credentials: &[CredentialScope],
    ) -> Result<(), UsageError> {
        let (_, mode) = settings(self, config)?;
        let name = if mode == "key" {
            "api_key"
        } else {
            "user_token"
        };
        if credentials.len() != 1
            || credentials[0].name != name
            || credentials[0].allowed_origins != [config.site.clone()]
        {
            return Err(UsageError::configuration(
                "Key 查询需要 api_key；账户/套餐查询需要独立 user_token，且只能绑定本站点",
            ));
        }
        Ok(())
    }
    fn presets(&self) -> Vec<UsagePreset> {
        let adapter = self;
        let (provider, title) = (self.id, self.title);
        let mut presets = vec![];
        for (mode, label, subject) in [
            ("key", "Key 可见额度", UsageSubject::Key),
            ("account", "账户余额", UsageSubject::Account),
            ("plans", "订阅套餐", UsageSubject::Plan),
            ("account-plans", "账户余额与多个套餐", UsageSubject::Account),
        ] {
            let site = "https://your-site.example";
            let label = format!("{title} · {label}");
            let key = mode == "key";
            presets.push(UsagePreset {
                id: format!("{provider}-{mode}"),
                label: label.clone(),
                description: adapter.description.into(),
                config: QueryConfig {
                    schema_version: USAGE_SCHEMA_VERSION,
                    label,
                    site: site.into(),
                    identity: QueryIdentity {
                        account_id: None,
                        context_id: None,
                        profile_id: None,
                        subject,
                        subject_id: None,
                    },
                    program: QueryProgram::Builtin {
                        provider: provider.into(),
                        template_version: BUILTIN_TEMPLATE_VERSION,
                    },
                    parameters: std::collections::BTreeMap::from([("mode".into(), mode.into())]),
                    targets: vec![QueryTarget {
                        origin: site.into(),
                        allow_private_network: false,
                    }],
                    enabled: true,
                    refresh_interval_seconds: 0,
                },
                credentials: vec![PresetCredential {
                    name: if key { "api_key" } else { "user_token" }.into(),
                    label: if key {
                        "模型 API Key"
                    } else {
                        "用户查询令牌"
                    }
                    .into(),
                    instructions: if key {
                        "只查询此 Key 实际可见的范围，不能代替面板用户凭据。"
                    } else {
                        adapter.user_instructions
                    }
                    .into(),
                    allowed_origins: vec![site.into()],
                }],
            });
        }
        presets
    }
}
