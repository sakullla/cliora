use super::*;

pub(crate) struct RegionalProvider {
    pub id: &'static str,
    pub title: &'static str,
    pub instruction: &'static str,
    pub description: &'static str,
    pub origins: [&'static str; 2],
    pub endpoints: &'static [(&'static str, &'static str)],
    pub source: &'static str,
    pub connection_paths: &'static [&'static str],
}
impl RegionalProvider {
    fn route(&self, config: &QueryConfig) -> Result<(&'static str, &'static str), UsageError> {
        validate_version(config, self.id)?;
        let region = config.parameters.get("region").and_then(Value::as_str);
        let origin = match region {
            Some("cn") => self.origins[0],
            Some("global") => self.origins[1],
            _ => return Err(UsageError::configuration("内置供应商或区域不可用")),
        };
        let api_version = config
            .parameters
            .get("apiVersion")
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = self
            .endpoints
            .iter()
            .find(|(id, _)| *id == api_version)
            .map(|(_, path)| *path)
            .ok_or_else(|| UsageError::configuration("请选择受支持的套餐接口版本"))?;
        if config.targets.len() != 1
            || config.targets[0].origin != origin
            || config.targets[0].allow_private_network
            || config.site != origin
            || config.identity.subject != UsageSubject::Plan
            || config.parameters.keys().any(|key| {
                key != "region" && !(!self.endpoints[0].0.is_empty() && key == "apiVersion")
            })
        {
            return Err(UsageError::configuration(
                "内置预设的站点、区域、统计对象或参数不匹配",
            ));
        }
        Ok((origin, path))
    }
}
impl UsageProvider for RegionalProvider {
    fn id(&self) -> &'static str {
        self.id
    }
    fn profile_preset(&self, connection: &crate::native::profile::Connection) -> Option<UsagePreset> {
        let url = url::Url::parse(&connection.base_url).ok()?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
            || url.query().is_some() || url.fragment().is_some()
            || !self.connection_paths.iter().any(|path| {
                url.path().trim_end_matches('/') == *path
                    || url.path().strip_prefix(path).is_some_and(|tail| tail.starts_with('/'))
            }) {
            return None;
        }
        let origin = url.origin().ascii_serialization();
        // First endpoint is the current plan API. Region follows the connection.
        self.presets().into_iter().find(|preset| preset.config.site == origin)
    }
    fn script(&self, config: &QueryConfig) -> Result<String, UsageError> {
        let (origin, path) = self.route(config)?;
        let endpoint = serde_json::to_string(&format!("{origin}{path}"))
            .map_err(|_| UsageError::configuration("内置查询地址无效"))?;
        Ok(format!(
            "const endpoint = {endpoint};\n{}\n{}",
            include_str!("common.js"),
            self.source
        ))
    }
    fn validate_credentials(
        &self,
        config: &QueryConfig,
        credentials: &[CredentialScope],
    ) -> Result<(), UsageError> {
        let (origin, _) = self.route(config)?;
        if credentials.len() != 1
            || credentials[0].name != "api_key"
            || credentials[0].allowed_origins != [origin]
        {
            return Err(UsageError::configuration(
                "内置查询需要仅绑定当前区域的 api_key 凭据",
            ));
        }
        Ok(())
    }
    fn presets(&self) -> Vec<UsagePreset> {
        let mut presets = vec![];
        for (index, region) in ["cn", "global"].into_iter().enumerate() {
            for (version, _) in self.endpoints {
                let origin = self.origins[index];
                let region_label = if region == "cn" {
                    "中国大陆"
                } else {
                    "国际"
                };
                let version_label = match *version {
                    "token-plan" => " Token/M Plan",
                    "coding-plan" => " Coding Plan（旧接口）",
                    _ => "",
                };
                let label = format!("{}{version_label} · {region_label}", self.title);
                let mut parameters =
                    std::collections::BTreeMap::from([("region".into(), region.into())]);
                if !version.is_empty() {
                    parameters.insert("apiVersion".into(), (*version).into());
                }
                presets.push(UsagePreset {
                    id: format!(
                        "{}-{region}{}",
                        self.id,
                        if version.is_empty() {
                            String::new()
                        } else {
                            format!("-{version}")
                        }
                    ),
                    label: label.clone(),
                    description: self.description.into(),
                    config: QueryConfig {
                        schema_version: USAGE_SCHEMA_VERSION,
                        label,
                        site: origin.into(),
                        identity: QueryIdentity {
                            account_id: None,
                            context_id: None,
                            profile_id: None,
                            subject: UsageSubject::Plan,
                            subject_id: None,
                        },
                        program: QueryProgram::Builtin {
                            provider: self.id.into(),
                            template_version: BUILTIN_TEMPLATE_VERSION,
                        },
                        parameters,
                        targets: vec![QueryTarget {
                            origin: origin.into(),
                            allow_private_network: false,
                        }],
                        enabled: true,
                        refresh_interval_seconds: 0,
                    },
                    credentials: vec![PresetCredential {
                        name: "api_key".into(),
                        label: "套餐查询 API Key".into(),
                        instructions: self.instruction.into(),
                        allowed_origins: vec![origin.into()],
                    }],
                });
            }
        }
        presets
    }
}
