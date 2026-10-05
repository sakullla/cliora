/** Synthetic, populated native-IPC fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { workflowFixtures, workflowRefs } from './capture-workflow-fixtures.mjs';
const workflowScenarioNames=['workflow-pi-models','workflow-opencode-models','workflow-codex-draft-effort','workflow-global-key','workflow-project-key-denied','workflow-zcode-key-unsupported','workflow-codebuddy-official-address','workflow-grok-precise-detail','workflow-grok-inferred-time','workflow-grok-no-usage','workflow-grok-statistics','workflow-grok-statistics-details'];
const option=(flag,fallback)=>{const index=process.argv.indexOf(flag);if(index<0)return fallback;const value=process.argv[index+1];if(!value||value.startsWith('--'))throw new Error('Missing value for '+flag);return value;};
const themeOption=option('--theme','all');
if(!['all','light','dark'].includes(themeOption))throw new Error('Invalid --theme; use all, light or dark');
const themes=themeOption==='all'?['light','dark']:[themeOption];
const sizeOption=option('--size','all');
const widths=sizeOption==='all'?[1360,900,640]:[...new Set(sizeOption.split(',').map(Number))];
if(!widths.length||widths.some(width=>![1360,900,640].includes(width)))throw new Error('Invalid --size; use 1360,900,640');
const onlyOption=option('--only','*');
const patterns=onlyOption.split(',').map(pattern=>new RegExp('^'+pattern.split('').map(char=>char==='*'?'.*':char==='?'?'.':char.replace(/[\\^$+.[\]{}()|]/g,'\\$&')).join('')+'$'));
const selectedScenarios=workflowScenarioNames.filter(name=>patterns.some(pattern=>pattern.test(name)));
if((process.argv.includes('--workflows')||process.argv.includes('--list')||process.argv.includes('--only'))&&!selectedScenarios.length)throw new Error('No matching workflow scenarios');
if(process.argv.includes('--list')){console.log(selectedScenarios.join('\n'));process.exit(0);}
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\\/g,'/').replace(/\/$/,'');
const workflowsOnly=process.argv.includes('--workflows');
const fullCapture=!process.argv.some(arg=>['--workflows','--records','--sessions','--connections'].includes(arg));
const out=process.env.CLIORA_CAPTURE_OUT ?? root+(workflowsOnly?'/docs/verification/workflow-capture':'/docs/verification/ui'); fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch();
async function mock(initialTheme){
 const names={codex:'Codex',claude_code:'Claude Code',grok:'Grok',pi:'Pi',open_code:'OpenCode'};
 const versions={codex:'0.160.0',claude_code:'2.1.287',grok:'1.0.46',pi:'1.0.0',open_code:'1.18.34'};
 const connectionPolicy=(id,scope)=>({apiKey:{state:scope==='project'&&id!=='claude_code'?'scope_denied':'writable',reason:scope==='project'&&id!=='claude_code'?names[id]+' 项目层不能写入供应商密钥；请使用全局配置':''},providerAddress:{state:'configurable',reason:''},projection:id==='pi'||id==='open_code'?'provider_models':id==='codex'?'current_model':'single_connection'});
 const ids=Object.keys(names); let theme=initialTheme; const tool_icons={};
 const projects=[{id:'cliora',name:'栖点 · 桌面工具',path:'C:\\Projects\\cliora',preferredTool:'codex',available:true,lastOpened:1790758800,modelOverrides:{},selectedProfiles:{codex:'codex-daily'},appliedProfiles:{codex:'codex-daily'}},{id:'site',name:'个人网站',path:'C:\\Projects\\personal-site',preferredTool:'claude_code',available:true,lastOpened:1790738800,modelOverrides:{},selectedProfiles:{},appliedProfiles:{}}];
 const library=[{id:'prompt-1',kind:'prompt',title:'代码审查',body:'检查代码变更是否正确、安全、易于维护。先说明影响用户的行为，再给出具体文件和可执行的建议。优先指出会导致故障的问题。',category:'开发',projectId:null,version:1,updatedAt:1},{id:'prompt-2',kind:'prompt',title:'整理发布说明',body:'根据变更清单写一份简洁的发布说明。分成新功能、改进与修复，突出用户能直接感受到的变化。',category:'写作',projectId:null,version:1,updatedAt:1},{id:'prompt-3',kind:'prompt',title:'排查问题',body:'从可以重复出现的现象开始，提出假设并用最小实验验证。列出实际观察，不把推测当成结论。',category:'开发',projectId:'cliora',version:1,updatedAt:1},{id:'prompt-4',kind:'prompt',title:'解释一段代码',body:'用清晰的语言说明这段代码的作用、数据流与边界条件，再给出一个输入输出示例。',category:'学习',projectId:null,version:1,updatedAt:1},{id:'rule-1',kind:'rule',title:'项目协作约定',body:'保持变更小而明确。先阅读现有实现，不覆盖其他人的工作。针对实际行为验证，保留失败原因与恢复步骤。',category:'项目规则',projectId:'cliora',version:1,updatedAt:1}];
 const records=[{id:'s1',nativeId:'01992e52-1ac0-7387-a5e4-41067718dd93',toolId:'codex',title:'梳理配置继承与应用流程',cwd:projects[0].path,model:'gpt-6-astra',projectId:'cliora',startedAt:1790751600000,updatedAt:1790758800000,favorite:true,partial:false,stale:false,messageCount:8,usageCount:2},{id:'s2',nativeId:'29fbc87e',toolId:'claude_code',title:'为网站添加文章目录',cwd:projects[1].path,model:'claude-sonnet-4-6',projectId:'site',startedAt:1790748800000,updatedAt:1790751000000,favorite:false,partial:false,stale:false,messageCount:6,usageCount:1},{id:'s3',nativeId:null,toolId:'pi',title:'检查本地 API 连接',cwd:null,model:null,projectId:null,startedAt:1790718800000,updatedAt:1790718800000,favorite:false,partial:true,stale:false,messageCount:3,usageCount:0}];
 const scans=ids.map(toolId=>({toolId,scannedAt:1790758800,sourceCount:toolId==='codex'?12:4,failedCount:0,incomplete:false,detail:'本地记录已索引'}));
 const usageReport=(filter)=>{const hour=3600000,day=86400000,now=Date.now(),start=filter.fromMs??now-29*day,end=filter.toMs??now+1,step=end-start<=2*day+hour?hour:day;
  const sum=(a,b)=>({requests:a.requests+b.requests,usageRecords:a.usageRecords+b.usageRecords,unknownRequestRecords:a.unknownRequestRecords+b.unknownRequestRecords,sessions:Math.max(a.sessions,b.sessions),input:a.input+b.input,cacheRead:a.cacheRead+b.cacheRead,cacheWrite:a.cacheWrite+b.cacheWrite,output:a.output+b.output,total:a.total+b.total,cost:(a.cost??0)+(b.cost??0),unpricedTokens:a.unpricedTokens+b.unpricedTokens});
  const zero={requests:0,usageRecords:0,unknownRequestRecords:0,sessions:0,input:0,cacheRead:0,cacheWrite:0,output:0,total:0,cost:0,unpricedTokens:0};
  const make=(scale)=>{const input=Math.round(42000*scale),cacheRead=Math.round(610000*scale),cacheWrite=Math.round(9000*scale),output=Math.round(21000*scale);return {usageRecords:Math.max(1,Math.round(18*scale)),unknownRequestRecords:0,requests:Math.max(1,Math.round(18*scale)),sessions:Math.max(1,Math.round(2*scale)),input,cacheRead,cacheWrite,output,total:input+cacheRead+cacheWrite+output,cost:Math.round(scale*41)/100,unpricedTokens:Math.round(120000*scale)};};
  const timeline=[];for(let t=start;t<end;t+=step){const h=new Date(t).getHours(),d=new Date(t).getDay();const scale=t>now?0:step===hour?(h>=9&&h<=23?(1+Math.sin(h/2.2))*1.6:0):(d===0||d===6?1.5:6+Math.cos(t/day)*3);timeline.push({start:t,end:Math.min(t+step,end),totals:scale>0?make(scale):zero});}
  const totals=timeline.reduce((a,b)=>sum(a,b.totals),zero);
  const part=(share,extra={})=>({...Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,typeof v==='number'?Math.round(v*share*(k==='cost'?100:1))/(k==='cost'?100:1):v])),...extra});
  const group=(key,label,toolId,model,share,priced=true)=>({key,label,toolId,model,projectId:null,priced,totals:part(share,priced?{unpricedTokens:0}:{cost:null})});
  return {generatedAt:now,from:start,to:end,bucket:step===hour?'hour':'day',currency:'USD',totals,previous:filter.fromMs?{from:start-(end-start),to:start-(end-start)+Math.min(end,now)-start,totals:part(.82)}:null,timeline,
   byModel:[group('codex|gpt-6-astra','gpt-6-astra','codex','gpt-6-astra',.46),group('claude_code|glm-5.3','glm-5.3','claude_code','glm-5.3',.27,false),group('open_code|deepseek-v4.1-flash','deepseek-v4.1-flash','open_code','deepseek-v4.1-flash',.17,false),group('pi|devin/swe-2','devin/swe-2','pi','devin/swe-2',.07,false),group('codex|gpt-6.1-sol','gpt-6.1-sol','codex','gpt-6.1-sol',.03)],
   byTool:[group('codex','codex','codex',null,.49),group('claude_code','claude_code','claude_code',null,.27,false),group('open_code','open_code','open_code',null,.17,false),group('pi','pi','pi',null,.07,false)],
   byProject:[{...group('project:cliora','栖点 · 桌面工具',null,null,.71),projectId:'cliora'},{...group('dir:c:/projects/site','site',null,null,.21)},{...group('unknown','未归类',null,null,.08)}],
   topSessions:records.slice(0,5).map((r,i)=>({id:r.id,toolId:r.toolId,title:r.title,model:r.model,updatedAt:r.updatedAt,totals:part([.31,.22,.14,.09,.05][i])})),
   models:['deepseek-v4.1-flash','devin/swe-2','glm-5.3','gpt-6-astra','gpt-6.1-sol'],untimedRequests:0,duplicateRequests:3,partialSessions:1,staleSessions:0,mixedCurrency:false,latestEventAt:now-120000,priceSources:['codex / gpt-6-astra · OpenAI 公开价'],scans};};
 const definitions=[{id:'mcp-1',name:'filesystem',transport:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-filesystem','C:/Projects'],url:null,env:{},headers:{},version:1}];
 const skills=[{id:'skill-1',name:'code-review',description:'检查变更中的正确性、边界条件与可维护性',fileCount:3,digest:'abc',source:'local_directory',version:1}];
 const sync={configured:false,enabled:false,endpoint:null,lastSuccess:null,lastError:null,pendingChanges:0,retryAfter:null,uploaded:0,downloaded:0,conflicts:[]};
 const quotaConfig={schemaVersion:1,label:'GLM Coding Plan · 中国大陆',site:'https://open.bigmodel.cn',identity:{profileId:'codex-work',accountId:null,contextId:null,subject:'plan',subjectId:null},program:{kind:'profile_builtin',provider:'glm',templateVersion:1,profileVersion:1},parameters:{region:'cn'},targets:[{origin:'https://open.bigmodel.cn',allowPrivateNetwork:false}],enabled:true,refreshIntervalSeconds:0};
 const quotaResult={schemaVersion:1,status:'success',metrics:[{id:'five-hours',label:'五小时套餐',subject:'plan',subjectId:null,unit:{kind:'requests'},used:250,remaining:750,total:1000,sourcePercent:null,unlimited:false,window:{durationSeconds:18000,resetsAt:'2026-10-03T12:00:00Z',recovery:'rolling'},missingReason:null},{id:'week',label:'周额度',subject:'plan',subjectId:null,unit:{kind:'tokens'},used:null,remaining:null,total:null,sourcePercent:42,unlimited:false,window:{durationSeconds:604800,resetsAt:null,recovery:'rolling'},missingReason:null}],errors:[]};
 const exampleSource='async function query(ctx) {\n  const response = await ctx.http({\n    url: ctx.parameters.site + "/usage",\n    auth: { credential: ctx.credentials.api_key, prefix: "Bearer " }\n  });\n  return response.json();\n}';
 const quotaQueries=[{id:'linked-glm',version:1,generation:1,config:quotaConfig,credentials:[]},{id:'custom-usage',version:1,generation:1,config:{...quotaConfig,label:'自定义套餐脚本',program:{kind:'javascript',source:exampleSource},parameters:{site:'https://quota.example.test'},site:'https://quota.example.test',targets:[{origin:'https://quota.example.test',allowPrivateNetwork:false}]},credentials:[{name:'api_key',secretRef:'synthetic-ref',revision:1,allowedOrigins:['https://quota.example.test']}]}];
 const quotaCaches=quotaQueries.map(query=>({queryId:query.id,generation:1,success:{execution:{kind:'saved',queryId:query.id,generation:1,identity:query.config.identity},source:query.id==='linked-glm'?'profile:glm:1:1':'javascript:v1',attemptedAt:'2026-10-03T04:00:00Z',measuredAt:'2026-10-03T04:00:00Z',result:quotaResult},attemptedAt:'2026-10-03T04:00:00Z',errors:[],nextAllowedAt:0,nextAutoAt:0,failures:0,authPaused:false,refreshing:false}));
 const accounts=ids.map(toolId=>({id:'account-'+toolId,toolId,provider:toolId,version:1,label:'开发账号',state:'signed_in',identity:{subject:'fixture-'+toolId,email:'developer@example.test',plan:'订阅套餐',source:'synthetic'},context:{id:'context-'+toolId},retiredContexts:[],pendingLogin:null,detail:null,checkedAt:1790992800}));
 const pluginEntry={id:'code-review@official',name:'Code Review',source:'code-review@official',version:'1.2.0',scope:'user',enabled:true,state:'installed_load_unknown',policy:'AVAILABLE',readOnly:false,root:'C:/fixture/plugins/code-review',resources:[{kind:'agents',path:'C:/fixture/plugins/code-review/agents',ownerId:'code-review@official'}]};
 const agentEntry={id:'reviewer',name:'reviewer',description:'审查正确性、安全与边界条件',path:'C:/fixture/agents/reviewer.md',format:'markdown',content:'---\nname: reviewer\ndescription: 审查正确性、安全与边界条件\ntools: Read, Grep, Glob\nmodel: inherit\n---\n检查改动影响，引用具体证据并说明验证范围。\n',enabled:true,readOnly:false,owner:'独立定义',detail:'下一次委派读取此定义'};
 Object.assign(window,{isTauri:true,__uiCalls:[],__TAURI_INTERNALS__:{invoke:async(command,args={})=>{
  window.__uiCalls.push({command,args});
  if(command.startsWith('plugin:event|'))return 1;
  if(command==='get_bootstrap'||command==='set_theme'||command==='set_tool_icon'){if(command==='set_theme')theme=args.theme;if(command==='set_tool_icon'){if(args.dataUrl)tool_icons[args.toolId]=args.dataUrl;else delete tool_icons[args.toolId];}return {preferences:{schema_version:1,managed_tools:ids,theme,tool_icons},tools:ids.map(id=>({id,name:names[id],installation:'not_checked',configuration:'not_checked'}))};}
  if(command==='list_cli_adapters'||command==='set_registered_managed_tools')return {registered:ids.map(id=>({id,name:names[id],management:{accounts:id!=='grok',mcp:true,skills:true,agents:id!=='pi',plugins:true,projectPlugins:true},interfaceFormats:['openai_chat'],yoloAvailable:true,projectModelOverride:id==='grok',nativeConfig:{state:'available',reason:''},launch:{state:'available',reason:''},resume:{state:'available',reason:''},resources:{state:'available',reason:''},history:{state:'available',reason:''}})),managedIds:args.managedIds??ids,preservedUnknown:[]};
  if(command==='list_accounts')return window.__captureNativeOnly ? accounts.filter(account=>account.toolId!=='open_code') : accounts.map(account=>window.__captureLoginPending && account.toolId==='open_code'?{...account,state:'pending',pendingLogin:{id:'capture-attempt',operation:'login',expiresAt:1999999999}}:account);
  if(command==='discover_native_logins')return {toolId:args.toolId,checkedAt:1790992800,logins:args.toolId==='open_code'?[{provider:'openai',authKind:'oauth',state:'signed_in',identity:null,detail:'已发现本地 OAuth 登录，CLI 未提供账号身份；未在线核验。',managedAccountId:null},{provider:'anthropic',authKind:'api_key',state:'signed_in',identity:null,detail:'已配置原生 API Key；不是 OAuth 订阅账号，未在线核验。',managedAccountId:null}]:[{provider:'chatgpt',authKind:'oauth',state:'signed_in',identity:{subject:'native-user',email:'native@example.test',plan:'plus',source:'synthetic'},detail:'原生本地账号状态；未在线核验。',managedAccountId:null}]};
  if(command==='account_capabilities')return ids.map(toolId=>({toolId,provider:toolId,version:versions[toolId],browserLink:toolId==='open_code',managedLogin:toolId!=='grok',importNative:toolId!=='grok',methods:['browser','device'],reason:'使用原生登录并核验身份；截图为合成数据。',identitySource:'synthetic',refreshOwner:'native_cli',acceptance:'mock only'}));
  if(command==='list_usage_queries')return quotaQueries;
  if(command==='list_usage_cache')return quotaCaches;
  if(command==='ensure_profile_usage')return args.profileId==='codex-work'?quotaQueries[0]:null;
  if(command==='usage_presets')return [{id:'glm-cn',label:quotaConfig.label,description:'官方套餐查询，独立展示额度窗口',config:{...quotaConfig,identity:{...quotaConfig.identity,profileId:null},program:{kind:'builtin',provider:'glm',templateVersion:1}},credentials:[{name:'api_key',label:'API Key',instructions:'需要所选区域的套餐 API Key',allowedOrigins:['https://open.bigmodel.cn']}]},{id:'javascript-example',label:'自定义 JavaScript',description:'受控 HTTP 查询与结构化结果',config:{...quotaQueries[1].config,identity:{...quotaConfig.identity,profileId:null}},credentials:[]}];
  if(command==='create_usage_test')return 'capture-test';
  if(command==='test_usage_query')return {execution:{kind:'draft',executionId:args.executionId,draftRevision:args.draftRevision},result:quotaResult,error:null,elapsedMs:42,stage:'validation',preview:JSON.stringify(quotaResult,null,2),requestOrigins:[args.draft.config.site]};
  if(command==='scan_native_plugins')return {target:args.target,capability:{version:versions[args.target.toolId],sources:'plugin@marketplace',actions:['install','update','enable','disable','uninstall'],project:true,detail:'静态安装状态；重启会话后加载'},entries:[pluginEntry,{...pluginEntry,id:'required@org',name:'Organization Plugin',policy:'REQUIRED',readOnly:true}],baseline:'capture-plugins',detail:'合成插件列表，实际加载未验证'};
  if(command==='scan_native_agents')return {target:args.target,capability:{version:versions[args.target.toolId],supported:true,format:'markdown',template:agentEntry.content,detail:'下一次委派读取定义'},entries:[agentEntry,{...agentEntry,id:'plugin-reviewer',name:'plugin-reviewer',owner:'插件：code-review@official',readOnly:true}],baseline:'capture-agents',detail:'合成原生定义，插件所属定义只读'};
  if(command==='list_projects')return projects;
  if(command==='get_registered_tool_workspace'){const id=args.toolId;const format=id==='codex'||id==='grok'?'toml':'json';const file=format==='toml'?'config.toml':'settings.json';const text=format==='toml'?'# 日常开发\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[projects."C:/Projects/cliora"]\ntrust_level = "trusted"':JSON.stringify({model:'claude-sonnet-4-6',permissions:{allow:['Read','Edit']}},null,2);const profile={id:id+'-daily',tool:id,name:'日常开发',version:1,revision:'r1',inheritCommon:true,files:{settings:text},suppressed:{},nativeCredentials:{},connection:null};return {probe:{selectedPath:'C:/Tools/'+id+'.cmd',installations:[{path:'C:/Tools/'+id+'.cmd',version:versions[id],status:'available',source:'npm_shim'}],nativeFiles:[{role:'settings',path:'C:/Users/local/.'+id+'/'+file,format,writable:true,sensitive:false}],nativeWrites:{state:'supported',reason:'可编辑与应用原生配置'},interfaceFormats:['openai_chat'],providerPresets:[],dependencies:[],installUrl:'https://example.com',upgradeHint:'沿用官方安装方式升级',installCommand:'npm install -g '+id,upgradeCommand:null,connectionPolicy:connectionPolicy(id,args.scope??'global')},profiles:[profile,{...profile,id:id+'-work',name:id==='codex'?'GLM 官方套餐':'工作项目',version:1,inheritCommon:false,authentication:{kind:'api_key'},connection:id==='codex'?{providerId:'glm',interfaceFormat:'openai_responses',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4',model:'glm-5.3',secretRef:'synthetic-profile-key',authEnvVar:null}:null}],common:{tool:id,version:1,revision:'c1',files:{settings:format==='toml'?'# 所有配置共享的设置':'{}'}},binding:{profileId:profile.id,profileVersion:1},snapshots:[{role:'settings',fingerprint:'hash',error:null}],recoveryNeeded:[],customPath:null};}
  if(command==='inspect_registered_native_draft')return {model:null,providerId:null,connection:null,reasoningEffort:'high',projectedModels:null};
  if(command==='preview_registered_native_profile')return {documents:{settings:{model:'gpt-6-astra',model_reasoning_effort:'high'}},sources:{settings:{model:'命名配置'}}};
  if(command==='read_registered_native_file_for_edit')return '# 完整磁盘原文\nmodel = "gpt-6-astra"';
  if(command==='get_launch_settings')return {selected:'power_shell',terminals:[{id:'auto',label:'系统默认',available:true},{id:'power_shell',label:'PowerShell',available:true},{id:'windows_terminal',label:'Windows Terminal',available:true}]};
  if(command==='get_tray_status')return {available:true,error:null};
  if(command==='list_library_items')return library.filter(i=>i.kind===args.kind&&(!args.search||(i.title+i.body+i.category).includes(args.search)));
  if(command==='list_mcp_definitions')return definitions;
  if(command==='list_mcp_placements')return [{definitionId:'mcp-1',toolId:'codex',scope:'global',projectPath:null,enabled:true}];
  if(command==='list_native_mcp')return [{...definitions[0],enabled:true,protectedValues:false}];
  if(command==='list_skill_packages')return skills;
  if(command==='list_skill_installations')return [{packageId:'skill-1',toolId:'codex',scope:'global',projectPath:null,targetPath:'C:/Users/local/.codex/skills/code-review',state:'current'}];
  if(command==='list_skill_recovery_issues')return [];
  if(command==='scan_native_skills')return [{name:'code-review',path:'C:/Users/local/.codex/skills/code-review',description:'审查代码变更',managed:true}];
  if(command==='refresh_history')return scans;
  if(command==='list_history_sessions')return records.filter(i=>!args.filter.search||i.title.includes(args.filter.search));
  if(command==='get_usage_report')return usageReport(args.filter);
  if(command==='list_history_prices')return [];
  if(command==='get_history_session')return {session:records.find(i=>i.id===args.id),resumeReason:null,usage:[],totals:{requests:2,usageRecords:2,unknownRequestRecords:0,sessions:1,input:1234,cacheRead:8000,cacheWrite:76,output:690,total:10000,cost:null,unpricedTokens:10000},messages:[{id:'m1',role:'user',timestampSource:'native',timestamp:1790751600000,text:'请梳理原生配置与通用配置的继承关系，确认保存草稿和应用配置的行为。'},{id:'m2',role:'assistant',timestampSource:'native',timestamp:1790751800000,text:'## 配置继承关系\n\n命名配置可以继承本工具的**通用配置**。\n\n1. 保存草稿：仅更新本机资料库。\n2. 保存并应用：合并配置并写入 CLI 原生文件。\n3. 检测到冲突：保留当前文件，等待确认。\n\n```typescript\nconst config = { ...common, ...profile };\nawait applyConfiguration(config);\n```\n\n> 已运行的会话继续使用原配置，新会话使用更新后的配置。'},{id:'m3',role:'user',timestampSource:'native',timestamp:1790753600000,text:'请补充项目作用域的边界，并给出验证步骤。'}]};
  if(command==='copy_history_resume_command')return "Set-Location -LiteralPath 'C:\\Projects\\cliora'; & 'codex' "+(args.mode==='yolo'?"'--yolo' ":'')+"'resume' '01992e52-1ac0-7387-a5e4-41067718dd93'";
  if(command==='list_portable_items')return [{key:'preferences:managed',kind:'preferences',label:'外观与管理偏好',pendingFields:[]},{key:'profile:codex-daily',kind:'profile',label:'Codex · 日常开发',pendingFields:[]},{key:'library:prompt-1',kind:'library',label:'代码审查',pendingFields:[]},{key:'project:cliora',kind:'project',label:'栖点 · 桌面工具',pendingFields:['本机目录']}];
  if(command==='get_webdav_status')return sync;
  if(command==='plugin:dialog|open')return 'C:/backup.cliora';
  if(command==='preview_portable_bundle')return {previewId:'preview',pendingProjects:1,items:[{key:'profile:codex-daily',kind:'profile',toolId:'codex',label:'Codex · 日常开发',status:'conflict',pendingFields:[],localPreview:'model = "gpt-6-astra"',incomingPreview:'model = "gpt-6-sol"'},{key:'project:cliora',kind:'project',label:'栖点 · 桌面工具',status:'new',pendingFields:['项目本机目录'],localPreview:null,incomingPreview:'{"name":"栖点 · 桌面工具"}'}]};
  return null;
 }}});
}
const failures=[];
const captures=[];
// Ignore content deliberately clipped by a horizontal scroll container (CLI tabs).
// A visible element crossing the viewport still fails the same capture check.
function findOverflow(){
 return [...document.querySelectorAll('main,section,article,input,textarea,select,button')].filter(el=>{
  if(!el.getClientRects().length)return false;
  let {left,right}=el.getBoundingClientRect();
  for(let parent=el.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
   if(['auto','scroll','hidden','clip'].includes(getComputedStyle(parent).overflowX)){
    const rect=parent.getBoundingClientRect();left=Math.max(left,rect.left);right=Math.min(right,rect.right);
   }
  }
  return right>left&&(right>innerWidth+1||left< -1);
 }).map(el=>({tag:el.tagName,text:el.textContent?.slice(0,60)}));
}
async function captureWorkflows(){
 for(const width of widths)for(const theme of themes){
  const page=await browser.newPage({viewport:{width,height:1100}});
  page.on('pageerror',error=>failures.push({type:'pageerror',theme,width,message:error.message}));
  await page.addInitScript(mock,theme);
  await page.addInitScript(workflowFixtures);
  await page.goto(process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736');
  await page.getByText('正在读取本机设置').waitFor({state:'hidden'});
  const nav=page.getByRole('navigation',{name:'页面'});
  const dialog=page.locator('dialog.guide-dialog');
  async function capture(name,workflow,state){
   if(!selectedScenarios.includes(name))return;
   await page.mouse.move(0,0);
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.waitForTimeout(100);
   const path=`${out}/${name}-${theme}-${width}.png`;
   await page.screenshot({path});
   captures.push({name,theme,width,height:1100,path,file:path.slice(out.length+1),workflowRef:workflowRefs[workflow],state});
   const over=await page.evaluate(findOverflow);
   if(over.length)failures.push({name,theme,width,over});
   console.log(path);
  }
  async function closeDialog(){
   await page.keyboard.press('Escape');
   await Promise.race([dialog.waitFor({state:'hidden'}),page.getByRole('dialog',{name:'放弃未保存修改？'}).waitFor()]);
   const confirmation=page.getByRole('dialog',{name:'放弃未保存修改？'});
   if(await confirmation.isVisible())await confirmation.getByRole('button',{name:'放弃修改',exact:true}).click();
   await dialog.waitFor({state:'hidden'});
  }
  async function edit(id){await page.locator(`[data-profile-id="${id}"]`).getByRole('button',{name:'修改',exact:true}).click();await dialog.waitFor();}
  try{
   await nav.getByRole('button',{name:'工具与连接'}).click();
   const region=page.getByRole('region',{name:'工具与连接'});
   const tabs=region.getByRole('tablist',{name:'CLI'});
   await tabs.getByRole('tab',{name:'Pi',exact:true}).click();
   await edit('pi-models');
   await expect(dialog.getByLabel('model-a contextWindow')).toHaveValue('100');
   await expect(dialog.getByLabel('sibling name')).toHaveValue('Keep');
   await dialog.getByLabel('sibling name').scrollIntoViewIfNeeded();
   await capture('workflow-pi-models','connections','provider_models / two existing records');
   await closeDialog();
   await tabs.getByRole('tab',{name:'OpenCode',exact:true}).click();
   await edit('oc-models');
   await expect(dialog.getByLabel('m2 name')).toHaveValue('Second');
   await dialog.getByLabel('当前模型').selectOption('m2');
   await capture('workflow-opencode-models','connections','provider_models / switched current model to sibling');
   await dialog.getByLabel('当前模型').selectOption('m1');
   await closeDialog();
   await tabs.getByRole('tab',{name:'Codex',exact:true}).click();
   await edit('codex-draft');
   await expect(dialog.getByLabel('推理强度（Codex 原生）')).toHaveValue('high');
   await capture('workflow-codex-draft-effort','connections','draft effort high / inspected effort low');
   await closeDialog();
   await tabs.getByRole('tab',{name:'Pi',exact:true}).click();
   await region.getByRole('button',{name:'新建配置',exact:true}).click();
   await expect(dialog.getByLabel('API 密钥')).toBeVisible();
   await capture('workflow-global-key','connections','global / writable API key');
   await closeDialog();
   await page.getByRole('button',{name:'配置范围',exact:true}).click();
   await page.getByRole('option',{name:/示例项目/}).click();
   await edit('pi-models');
   await expect(dialog).toContainText('Pi 项目层不能写入供应商密钥；请使用全局配置');
   await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
   await capture('workflow-project-key-denied','connections','project / scope_denied / retained provider model fields');
   await closeDialog();
   await page.getByRole('button',{name:'配置范围',exact:true}).click();
   await page.getByRole('option',{name:'全局配置',exact:true}).click();
   await tabs.getByRole('tab',{name:'ZCode',exact:true}).click();
   await edit('zc-login');
   await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
   await expect(dialog.getByLabel('API 地址')).toHaveCount(0);
   await capture('workflow-zcode-key-unsupported','connections','unsupported key and provider address / existing login');
   await closeDialog();
   await tabs.getByRole('tab',{name:'CodeBuddy',exact:true}).click();
   await edit('cb-official');
   await expect(dialog.getByLabel('API 密钥')).toBeVisible();
   await expect(dialog.getByLabel('API 地址')).toHaveCount(0);
   await expect(dialog).not.toContainText('https://third.example');
   await capture('workflow-codebuddy-official-address','connections','official gateway / unsupported third-party address / writable key');
   await closeDialog();
   await nav.getByRole('button',{name:'使用记录'}).click();
   await page.getByRole('button',{name:/Grok · Token 核对示例/}).click();
   const usage=page.getByRole('region',{name:'会话 Token 用量'});
   await expect(usage).toContainText('总 Token 10,000');
   await expect(usage).toContainText('已知调用 3,729 次');
   await expect(usage).toContainText('1 条记录次数未知');
   await expect(page.locator('time[title*="按轮次开始时间推断"]')).toContainText('约');
   await capture('workflow-grok-precise-detail','history','10,000 disjoint tokens / 3,729 known calls / 108 usage records / one unknown count');
   await page.locator('[data-message-id="a"]').scrollIntoViewIfNeeded();
   await expect(page.locator('[data-message-id="u"]')).toContainText('没有可验证时间');
   await capture('workflow-grok-inferred-time','history','native timestamp / inferred turn time / unknown message time');
   if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();
   await page.getByRole('button',{name:/Grok · 没有用量的会话/}).click();
   await expect(usage).toHaveText('暂无用量数据');
   await capture('workflow-grok-no-usage','history','missing usage / preserved readable message');
   if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();
   await page.getByRole('textbox',{name:'搜索会话'}).fill('Token');
   await page.locator('summary').filter({hasText:/^筛选/}).click();
   await page.getByRole('checkbox',{name:'只看收藏'}).check();
   await page.locator('summary').filter({hasText:/^筛选/}).click();
   await page.getByRole('tab',{name:'用量',exact:true}).click();
   const overview=page.getByRole('region',{name:'用量概览'});
   await expect(overview).toContainText('1 条记录次数未知');
   await expect(overview).not.toContainText('每次约');
   await expect(page.getByText('筛选：搜索「Token」 · 只看收藏',{exact:true})).toBeVisible();
   await capture('workflow-grok-statistics','history','search Token + favorite filter / known calls with unknown count / no misleading average');
   await page.getByRole('region',{name:'消耗最多的会话'}).scrollIntoViewIfNeeded();
   await capture('workflow-grok-statistics-details','history','consistent model/tool/project/session group totals');
  }catch(error){failures.push({type:'scenario',theme,width,message:error.message});console.error(error.message);}
  finally{await page.close();}
 }
}

function writeWorkflowGallery(){
 const workflowCaptures=captures.filter(item=>item.workflowRef);
 if(!workflowsOnly&&!fullCapture)return;
 const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const workflowOptions=Object.values(workflowRefs).map(ref=>`<option value="${escape(ref)}">${escape(ref.split('/').at(-1))}</option>`).join('');
 const scenarioOptions=[...new Set(workflowCaptures.map(item=>item.name))].map(name=>`<option value="${escape(name)}">${escape(name)}</option>`).join('');
 const cards=workflowCaptures.map(item=>`<figure data-workflow="${escape(item.workflowRef)}" data-scenario="${escape(item.name)}" data-theme="${item.theme}" data-width="${item.width}" data-keywords="${escape((item.name+' '+item.state+' '+item.workflowRef).toLowerCase())}"><a href="${escape(item.file)}" target="_blank" rel="noopener"><img loading="lazy" src="${escape(item.file)}" alt="${escape(item.name)} ${item.theme} ${item.width}"></a><figcaption>${escape(item.name)}<small>${escape(item.workflowRef.split('/').at(-1))}</small><small>${item.theme} · ${item.width} × ${item.height}</small><small>${escape(item.state)}</small></figcaption></figure>`).join('');
 const missing=widths.flatMap(width=>themes.flatMap(theme=>selectedScenarios.filter(name=>!workflowCaptures.some(item=>item.name===name&&item.width===width&&item.theme===theme)).map(name=>({name,theme,width}))));
 if(missing.length)failures.push({type:'missing',missing});
 fs.writeFileSync(`${out}/index.html`,`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cliora 工作流 UI 捕获</title><style>
body{margin:0;background:#101114;color:#f5f2ec;font:15px system-ui}header{position:sticky;top:0;padding:20px 4vw;background:#191b20;z-index:2;border-bottom:1px solid #34363d}h1{font-size:24px;margin:0 0 8px}p{color:#b3afa6}.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end}label{display:grid;gap:5px;font-size:13px;color:#c9c6c0}select,input,button{font:inherit;padding:9px;border:1px solid #555;border-radius:8px;background:#25272d;color:#f5f2ec;max-width:100%;box-sizing:border-box}select{max-width:min(350px,80vw)}button{cursor:pointer}input{width:240px}.result{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0 0}main{padding:24px 4vw;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:24px}figure{margin:0;padding:12px;border:1px solid #34363d;border-radius:12px;min-width:0}img{width:100%;height:340px;object-fit:contain;background:#070709}figcaption{padding:12px 0 0;overflow-wrap:anywhere}a{color:#b8d2ff}small{display:block;color:#b3afa6;margin-top:5px}#empty{padding:24px 4vw}[hidden]{display:none!important}</style></head><body><header><h1>Cliora 工作流 UI 捕获</h1><p>${failures.length?'捕获有失败，请查看清单':'捕获完成'} · ${workflowCaptures.length} 张 · 合成 IPC 数据，仅用于界面检查。</p><form class="filters" id="filters"><label>工作流<select id="workflow" aria-label="工作流"><option value="">全部工作流</option>${workflowOptions}</select></label><label>场景<select id="scenario" aria-label="场景"><option value="">全部场景</option>${scenarioOptions}</select></label><label>主题<select id="theme" aria-label="主题"><option value="">全部主题</option><option value="light">浅色 light</option><option value="dark">深色 dark</option></select></label><label>宽度<select id="width" aria-label="宽度"><option value="">全部宽度</option>${widths.map(width=>`<option>${width}</option>`).join('')}</select></label><label>关键词<input id="query" type="search" placeholder="如 Grok / Token / project" aria-label="场景或关键词"></label><button type="reset">重置筛选</button></form><div class="result"><output id="count" aria-live="polite"></output><a href="capture-ui-workflows-manifest.json">捕获清单</a>${Object.values(workflowRefs).map(ref=>`<a href="../../../${encodeURI(ref)}/03-execution-plan.md">${escape(ref.split('/').at(-1))}</a>`).join('')}</div></header><p id="empty" hidden>没有匹配的图片，请调整筛选或重置。</p><main>${cards}</main><script>
const ids=['workflow','scenario','theme','width','query'];const controls=ids.map(id=>document.getElementById(id));const cards=[...document.querySelectorAll('figure')];function filter(){let count=0;const query=controls[4].value.trim().toLowerCase();for(const card of cards){card.hidden=controls.slice(0,4).some((control,index)=>control.value&&card.dataset[ids[index]]!==control.value)||!card.dataset.keywords.includes(query);if(!card.hidden)count++;}document.getElementById('count').textContent='显示 '+count+' / '+cards.length+' 张';document.getElementById('empty').hidden=count!==0;}controls.forEach(control=>control.addEventListener('input',filter));document.getElementById('filters').addEventListener('submit',event=>event.preventDefault());document.getElementById('filters').addEventListener('reset',()=>setTimeout(filter,0));filter();
</script></body></html>`);
 const rows=[...new Set(workflowCaptures.map(item=>item.name))].map(name=>{
  const items=workflowCaptures.filter(item=>item.name===name);
  return `| ${name} | ${items[0].workflowRef.split('/').at(-1)} | ${items.map(item=>`[${item.theme} ${item.width}](${item.file})`).join(' · ')} |`;
 });
 fs.writeFileSync(`${out}/README.md`,`# 工作流 UI 捕获\n\n[浏览图片画廊](index.html) · [机器可读清单](capture-ui-workflows-manifest.json)\n\n执行：\n\n\`\`\`sh\nCLIORA_PREVIEW_URL=http://127.0.0.1:14736 node scripts/capture-ui.mjs --workflows\n\`\`\`\n\nHTML 画廊沿用 Rillight UI 捕获的固定工具栏、响应式网格与原图入口，可按工作流、场景、主题、宽度和关键词筛选，显示匹配数量，支持重置及空结果提示。\n\n可选捕获参数：\`--theme light|dark|all\`、\`--size 1360,900,640\`、\`--only 'workflow-grok-*'\`、\`--list\`（只列工作流场景，不启动浏览器）。默认完整捕获也包含下面的工作流场景；可用 CLIORA_CAPTURE_OUT 指定输出目录。预览服务器需运行当前 frontend build。\n\n本次生成 ${workflowCaptures.length} 张图片，${failures.length} 项检查失败；本次主题 ${themes.join('/')}，宽度 ${widths.join('/')}，高度 1100。截图使用脱敏合成 IPC 数据，不构成原生平台、计费或凭据验收。Grok 样例的 3,729 次已知调用与 108 条用量记录用于检查两个计数口径；精确 Token 总量固定为 10,000，并含 1 条次数未知记录。\n\n来源工作流：\n\n- [单供应商多模型与密钥入口](../../../${workflowRefs.connections}/03-execution-plan.md)\n- [历史记录与 Token 统计准确度](../../../${workflowRefs.history}/03-execution-plan.md)\n\n| 场景 | 工作流 | 图片 |\n| --- | --- | --- |\n${rows.join('\n')}\n`);
 fs.writeFileSync(`${out}/capture-ui-workflows-manifest.json`,JSON.stringify({capturedAt:new Date().toISOString(),synthetic:true,invocation:['node','scripts/capture-ui.mjs',...process.argv.slice(2)].join(' '),previewUrl:process.env.CLIORA_PREVIEW_URL??'http://127.0.0.1:14736',workflows:Object.values(workflowRefs),matrix:{themes,widths,height:1100},selectedScenarios,missing,success:failures.length===0&&missing.length===0,imageCount:workflowCaptures.length,captures:workflowCaptures.map(({path,...item})=>item),failures},null,2)+'\n');
}

if(!workflowsOnly){
for(const width of widths)for(const theme of themes){
 const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>failures.push(e.message));await page.addInitScript(mock,theme);await page.goto(process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736');await page.getByText('正在读取本机设置').waitFor({state:'hidden'});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 const nav=page.getByRole('navigation',{name:'页面'});
 async function capture(name){await page.mouse.move(0,0);await page.waitForTimeout(100);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);const path=`${out}/${name}-${theme}-${width}.png`;await page.screenshot({path});captures.push({name,theme,width,path});const over=await page.evaluate(findOverflow);if(over.length)failures.push({name,theme,width,over});console.log(path);}
 if(process.argv.includes('--records') || process.argv.includes('--sessions')){
  await nav.getByRole('button',{name:'使用记录'}).click();
  await page.getByLabel('会话列表').getByRole('button').first().waitFor();if(width>760)await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('sessions');
  if(width<=760){await page.getByLabel('会话列表').getByRole('button').first().click();await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('session-detail');}
  if(process.argv.includes('--sessions')){await page.getByLabel('会话正文').locator('article').nth(1).scrollIntoViewIfNeeded();await capture('session-reading');if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();await page.locator('summary').filter({hasText:/^筛选/}).click();await capture('session-filters');await page.getByRole('button',{name:'自定义',exact:true}).click();const calendar=page.getByRole('dialog',{name:'自定义时间范围'});await calendar.getByRole('button',{name:/^\d{4}-\d{2}-\d{2}$/}).nth(4).click();await calendar.getByRole('button',{name:/^\d{4}-\d{2}-\d{2}$/}).nth(11).click();await capture('session-dates');await page.close();continue;}
  await page.getByRole('tab',{name:'用量',exact:true}).click();await page.getByRole('radio',{name:'近 7 天',exact:true}).click();
  await page.getByRole('region',{name:'用量概览'}).waitFor();await capture('usage');
  await page.getByRole('region',{name:'消耗最多的会话'}).scrollIntoViewIfNeeded();await capture('usage-details');await page.getByRole('radio',{name:'自定义',exact:true}).click();await capture('usage-dates');
  await page.close();continue;
 }
 if(process.argv.includes('--connections')){
  await page.setViewportSize({width,height:Math.max(1100,page.viewportSize()?.height??1000)});
  await nav.getByRole('button',{name:'工具与连接'}).click();
  const region=page.getByRole('region',{name:'工具与连接'});
  const profiles=region.getByLabel('配置列表');
  await profiles.waitFor();
  for(const name of ['Codex','Claude Code','Grok','Pi','OpenCode']){
   await region.getByRole('tablist',{name:'CLI'}).getByRole('tab',{name,exact:true}).click();
   await profiles.waitFor();
   const slug=name.toLowerCase().replace(/\s+/g,'-');
   await capture(`conn-${slug}`);
   const edits=profiles.getByRole('button',{name:'修改',exact:true});
   const count=await edits.count();
   if(!count) continue;
   await edits.nth(Math.min(2,count-1)).click();
   const dialog=page.getByRole('dialog');
   await dialog.waitFor();
   await capture(`conn-${slug}-config`);
   const more=dialog.getByText('更多选项',{exact:true});
   if(await more.count()){
    await more.click();
    const advanced=dialog.getByText('高级连接选项',{exact:true});
    if(await advanced.count()) await advanced.click();
    await dialog.locator('summary').filter({hasText:'更多选项'}).scrollIntoViewIfNeeded();
    await capture(`conn-${slug}-more`);
   }
   await page.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
  }
  await page.close(); continue;
 }
 await capture('home');
 await nav.getByRole('button',{name:'工具与连接'}).click();const profiles=page.getByRole('region',{name:'工具与连接'}).getByLabel('配置列表');await profiles.waitFor();await capture('tools');
 await profiles.getByRole('button',{name:'修改'}).first().click();await page.getByRole('dialog').waitFor();await capture('native-config');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await profiles.getByRole('button',{name:'修改'}).nth(1).click();await page.getByRole('dialog').waitFor();await capture('config-form');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 const officialRow=profiles.locator('[data-profile-id="codex-work"]');await officialRow.getByText('25% 已用',{exact:true}).first().waitFor();await officialRow.scrollIntoViewIfNeeded();await capture('quota-results');
 await officialRow.locator('summary').filter({hasText:/^额度详情/}).first().click();await officialRow.getByText('最近成功：',{exact:false}).first().waitFor();await capture('quota-details');await officialRow.locator('summary').filter({hasText:/^额度详情/}).first().click();
 await officialRow.getByRole('button',{name:'额度设置'}).first().click();await page.getByRole('dialog').waitFor();await capture('quota-linked-settings');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await officialRow.getByRole('button',{name:'额度设置'}).nth(1).click();await page.getByRole('textbox',{name:'额度查询脚本'}).waitFor();await page.getByRole('textbox',{name:'额度查询脚本'}).scrollIntoViewIfNeeded();await capture('quota-script-editor');await page.getByRole('button',{name:'测试当前草稿'}).click();await page.getByLabel('草稿测试结果').waitFor();await page.getByLabel('草稿测试结果').scrollIntoViewIfNeeded();await capture('quota-script-preview');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:'账号',exact:true}).click();await page.getByText('开发账号',{exact:true}).waitFor();await page.getByText('CLI 已登录',{exact:true}).waitFor();await capture('oauth-accounts');await page.getByRole('button',{name:'添加账号',exact:true}).click();await capture('oauth-add-account');
 await page.getByRole('button',{name:'删除账号',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('account-delete-confirmation');await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 await page.evaluate(()=>window.__captureNativeOnly=true);await page.getByRole('tab',{name:'OpenCode',exact:true}).click();await page.getByRole('tab',{name:'账号',exact:true}).click();await page.getByText(/还没有独立账号/).waitFor();await page.getByText('CLI 已登录',{exact:true}).first().waitFor();await capture('native-cli-login');
 await page.evaluate(()=>{window.__captureNativeOnly=false;window.__captureLoginPending=true;});await page.getByRole('button',{name:'打开授权页面',exact:true}).waitFor();await capture('oauth-browser-retry');await page.evaluate(()=>window.__captureLoginPending=false);
 await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
 await page.getByRole('tab',{name:'插件',exact:true}).click();await page.getByText('Code Review',{exact:true}).waitFor();await capture('native-plugins');await page.getByLabel('插件来源',{exact:true}).fill('code-review@official');await page.getByRole('checkbox').check();await capture('plugin-install');
 await page.getByLabel('搜索插件').fill('missing-plugin');await capture('plugin-search-empty');await page.getByRole('button',{name:'清除筛选'}).click();await page.getByLabel('插件状态筛选').selectOption('readonly');await capture('plugin-readonly-filter');await page.getByLabel('插件状态筛选').selectOption('all');
 await page.getByRole('tab',{name:'Agents',exact:true}).click();await page.getByText('reviewer',{exact:true}).waitFor();await capture('native-agents');await page.getByRole('listitem').filter({has:page.getByText('reviewer',{exact:true})}).getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('textbox',{name:'原生 Agent 定义',exact:true}).waitFor();await capture('agent-editor');await page.getByRole('button',{name:'关闭编辑',exact:true}).click();
 await page.getByLabel('搜索 Agent 定义').fill('missing-agent');await capture('agent-search-empty');await page.getByRole('button',{name:'清除筛选'}).click();await page.getByLabel('Agent 状态筛选').selectOption('readonly');await capture('agent-readonly-filter');await page.getByLabel('Agent 状态筛选').selectOption('all');
 await page.getByRole('tab',{name:'Grok',exact:true}).click();await page.getByRole('tab',{name:'配置',exact:true}).waitFor();if(await page.getByRole('tab',{name:'账号',exact:true}).count())throw new Error('Unsupported Grok accounts tab is visible');await capture('grok-capabilities');
 await page.getByRole('tab',{name:'Pi',exact:true}).click();await page.getByRole('tab',{name:'配置',exact:true}).waitFor();if(await page.getByRole('tab',{name:'Agents',exact:true}).count())throw new Error('Unsupported Pi agents tab is visible');await capture('pi-capabilities');
 await page.getByRole('tab',{name:'Codex',exact:true}).click();
 await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByRole('button',{name:/filesystem/}).first().waitFor();await capture('mcp');
 await page.getByRole('tab',{name:'Skill',exact:true}).click();await page.getByRole('button',{name:/code-review/}).first().waitFor();await capture('skills');
 await nav.getByRole('button',{name:'资料库'}).click();await page.getByRole('button',{name:'代码审查',exact:true}).waitFor();await capture('library');
 await page.getByRole('tab',{name:/^长期规则/}).click();await page.getByRole('button',{name:'项目协作约定',exact:true}).waitFor();await capture('library-rules');
 await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByLabel('MCP 列表').getByRole('button',{name:'filesystem',exact:true}).waitFor();await capture('library-mcp');
 await page.getByRole('button',{name:'＋ 新建 MCP',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('library-mcp-editor');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:'Skill',exact:true}).click();await page.getByLabel('Skill 列表').getByRole('button',{name:'code-review',exact:true}).waitFor();await capture('library-skills');
 await page.getByRole('button',{name:'添加 Skill',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('library-skill-add');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await nav.getByRole('button',{name:'使用记录'}).click();await page.getByLabel('会话列表').getByRole('button').first().waitFor();if(width>760)await page.getByRole('button',{name:'在外部终端继续'}).waitFor();if(width>760)await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('sessions');
 if(width<=760){await page.getByLabel('会话列表').getByRole('button').first().click();await page.getByRole('button',{name:'在外部终端继续'}).waitFor();await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('session-detail');}
 await page.getByRole('tab',{name:'用量',exact:true}).click();await capture('usage');
 await nav.getByRole('button',{name:'设置',exact:true}).click();await capture('settings');
 await page.getByRole('tab',{name:'迁移与同步'}).click();await capture('migration');
 await page.getByRole('button',{name:'导出加密配置包',exact:true}).click();await capture('migration-export');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'从配置包恢复',exact:true}).click();await page.getByPlaceholder('输入导出时的口令').fill('correct-password');await page.getByRole('button',{name:'选择配置包并预览'}).click();await capture('migration-import');
 await page.close();
}
}
if(workflowsOnly||fullCapture)await captureWorkflows();
await browser.close();writeWorkflowGallery();if(!workflowsOnly)fs.writeFileSync(`${out}/capture-ui${process.argv.includes('--sessions')?'-sessions':process.argv.includes('--records')?'-records':workflowsOnly?'-workflows':''}-manifest.json`,JSON.stringify({capturedAt:new Date().toISOString(),synthetic:true,captures,failures},null,2)+'\n');console.log(JSON.stringify({failures},null,2));if(failures.length)process.exitCode=1;
