use super::*;
use crate::adapters::providers::{ProviderRegistry,UsageProvider,CredentialScope};
struct ExtraProvider;
static EXTRA:ExtraProvider=ExtraProvider;
impl UsageProvider for ExtraProvider {
    fn id(&self)->&'static str {"sixth_quota"}
    fn script(&self,_config:&QueryConfig)->Result<String,UsageError> {Ok(r#"async function query() { return {schemaVersion:1,status:'success',metrics:[{id:'fixture',label:'Fixture remaining',subject:'plan',subjectId:null,unit:{kind:'requests'},used:null,remaining:17,total:null,sourcePercent:null,unlimited:false,expiresAt:null,neverExpires:false,window:null,missingReason:null}],errors:[]}; }"#.into())}
    fn validate_credentials(&self,_config:&QueryConfig,scopes:&[CredentialScope])->Result<(),UsageError> {if scopes.is_empty(){Ok(())}else{Err(UsageError::configuration("no credentials expected"))}}
    fn presets(&self)->Vec<UsagePreset> {vec![]}
}
#[test]
fn extra_supplier_compiles_and_runs_without_service_id_switches() {
    let registry=ProviderRegistry::with_providers(vec![&EXTRA]).unwrap();
    let mut config=usage_presets().into_iter().next().unwrap().config;
    config.program=QueryProgram::Builtin{provider:"sixth_quota".into(),template_version:1};
    let source=registry.script(&config).unwrap();
    config.program=QueryProgram::JavaScript{source};
    let result=crate::usage::runtime::execute(crate::usage::runtime::HelperInput{config,secrets:vec![]});
    assert!(result.error.is_none(),"{:?}",result.error);
    assert_eq!(result.result.unwrap().metrics[0].remaining,Some(17.));
    assert!(ProviderRegistry::with_providers(vec![&EXTRA,&EXTRA]).is_err());
}
