/** Synthetic, populated native-IPC fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\\/g,'/').replace(/\/$/,'');
const out=root+'/docs/verification/ui'; fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch();
async function mock(initialTheme){
 const names={codex:'Codex',claude_code:'Claude Code',grok:'Grok',pi:'Pi',open_code:'OpenCode'};
 const versions={codex:'0.158.0',claude_code:'2.1.284',grok:'1.0.41',pi:'0.87.1',open_code:'1.18.33'};
 const ids=Object.keys(names); let theme=initialTheme; const tool_icons={};
 const projects=[{id:'cliora',name:'栖点 · 桌面工具',path:'C:\\Projects\\cliora',preferredTool:'codex',available:true,lastOpened:1790758800,modelOverrides:{},selectedProfiles:{codex:'codex-daily'},appliedProfiles:{codex:'codex-daily'}},{id:'site',name:'个人网站',path:'C:\\Projects\\personal-site',preferredTool:'claude_code',available:true,lastOpened:1790738800,modelOverrides:{},selectedProfiles:{},appliedProfiles:{}}];
 const library=[{id:'prompt-1',kind:'prompt',title:'代码审查',body:'检查代码变更是否正确、安全、易于维护。先说明影响用户的行为，再给出具体文件和可执行的建议。优先指出会导致故障的问题。',category:'开发',projectId:null,version:1,updatedAt:1},{id:'prompt-2',kind:'prompt',title:'整理发布说明',body:'根据变更清单写一份简洁的发布说明。分成新功能、改进与修复，突出用户能直接感受到的变化。',category:'写作',projectId:null,version:1,updatedAt:1},{id:'prompt-3',kind:'prompt',title:'排查问题',body:'从可以重复出现的现象开始，提出假设并用最小实验验证。列出实际观察，不把推测当成结论。',category:'开发',projectId:'cliora',version:1,updatedAt:1},{id:'prompt-4',kind:'prompt',title:'解释一段代码',body:'用清晰的语言说明这段代码的作用、数据流与边界条件，再给出一个输入输出示例。',category:'学习',projectId:null,version:1,updatedAt:1},{id:'rule-1',kind:'rule',title:'项目协作约定',body:'保持变更小而明确。先阅读现有实现，不覆盖其他人的工作。针对实际行为验证，保留失败原因与恢复步骤。',category:'项目规则',projectId:'cliora',version:1,updatedAt:1}];
 const records=[{id:'s1',nativeId:'01992e52-1ac0-7387-a5e4-41067718dd93',toolId:'codex',title:'梳理配置继承与应用流程',cwd:projects[0].path,model:'gpt-6-astra',projectId:'cliora',startedAt:1790751600000,updatedAt:1790758800000,favorite:true,partial:false,stale:false,messageCount:8,usageCount:2},{id:'s2',nativeId:'29fbc87e',toolId:'claude_code',title:'为网站添加文章目录',cwd:projects[1].path,model:'claude-sonnet-4-6',projectId:'site',startedAt:1790748800000,updatedAt:1790751000000,favorite:false,partial:false,stale:false,messageCount:6,usageCount:1},{id:'s3',nativeId:null,toolId:'pi',title:'检查本地 API 连接',cwd:null,model:null,projectId:null,startedAt:1790718800000,updatedAt:1790718800000,favorite:false,partial:true,stale:false,messageCount:3,usageCount:0}];
 const scans=ids.map(toolId=>({toolId,scannedAt:1790758800,sourceCount:toolId==='codex'?12:4,failedCount:0,incomplete:false,detail:'本地记录已索引'}));
 const usage={sessionCount:24,usageSessions:21,unknownUsageSessions:3,partialSessions:1,staleSessions:0,input:128450,output:28760,cacheRead:64200,cacheWrite:8400,inputIncludesCache:null,estimatedCost:1.2847,currency:'USD',priceSources:['手动设置 · 2026-09-30'],scans};
 const definitions=[{id:'mcp-1',name:'filesystem',transport:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-filesystem','C:/Projects'],url:null,env:{},headers:{},version:1}];
 const skills=[{id:'skill-1',name:'code-review',description:'检查变更中的正确性、边界条件与可维护性',fileCount:3,digest:'abc',source:'local_directory',version:1}];
 const sync={configured:false,enabled:false,endpoint:null,lastSuccess:null,lastError:null,pendingChanges:0,retryAfter:null,uploaded:0,downloaded:0,conflicts:[]};
 Object.assign(window,{isTauri:true,__uiCalls:[],__TAURI_INTERNALS__:{invoke:async(command,args={})=>{
  window.__uiCalls.push({command,args});
  if(command.startsWith('plugin:event|'))return 1;
  if(command==='get_bootstrap'||command==='set_theme'||command==='set_tool_icon'){if(command==='set_theme')theme=args.theme;if(command==='set_tool_icon'){if(args.dataUrl)tool_icons[args.toolId]=args.dataUrl;else delete tool_icons[args.toolId];}return {preferences:{schema_version:1,managed_tools:ids,theme,tool_icons},tools:ids.map(id=>({id,name:names[id],installation:'not_checked',configuration:'not_checked'}))};}
  if(command==='list_cli_adapters'||command==='set_registered_managed_tools')return {registered:ids.map(id=>({id,name:names[id],interfaceFormats:['openai_chat'],yoloAvailable:true,projectModelOverride:id==='grok',nativeConfig:{state:'available',reason:''},launch:{state:'available',reason:''},resume:{state:'available',reason:''},resources:{state:'available',reason:''},history:{state:'available',reason:''}})),managedIds:args.managedIds??ids,preservedUnknown:[]};
  if(command==='list_projects')return projects;
  if(command==='get_registered_tool_workspace'){const id=args.toolId;const format=id==='codex'||id==='grok'?'toml':'json';const file=format==='toml'?'config.toml':'settings.json';const text=format==='toml'?'# 日常开发\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[projects."C:/Projects/cliora"]\ntrust_level = "trusted"':JSON.stringify({model:'claude-sonnet-4-6',permissions:{allow:['Read','Edit']}},null,2);const profile={id:id+'-daily',tool:id,name:'日常开发',version:1,revision:'r1',inheritCommon:true,files:{settings:text},suppressed:{},nativeCredentials:{},connection:null};return {probe:{selectedPath:'C:/Tools/'+id+'.cmd',installations:[{path:'C:/Tools/'+id+'.cmd',version:versions[id],status:'available',source:'npm_shim'}],nativeFiles:[{role:'settings',path:'C:/Users/local/.'+id+'/'+file,format,writable:true,sensitive:false}],nativeWrites:{state:'supported',reason:'可编辑与应用原生配置'},interfaceFormats:['openai_chat'],providerPresets:[],dependencies:[],installUrl:'https://example.com',upgradeHint:'沿用官方安装方式升级',installCommand:'npm install -g '+id,upgradeCommand:null},profiles:[profile,{...profile,id:id+'-work',name:'工作项目',version:1,inheritCommon:false}],common:{tool:id,version:1,revision:'c1',files:{settings:format==='toml'?'# 所有配置共享的设置':'{}'}},binding:{profileId:profile.id,profileVersion:1},snapshots:[{role:'settings',fingerprint:'hash',error:null}],recoveryNeeded:[],customPath:null};}
  if(command==='inspect_registered_native_draft')return {model:null,providerId:null,connection:null,reasoningEffort:'high'};
  if(command==='preview_registered_native_profile')return {documents:{settings:{model:'gpt-6-astra',model_reasoning_effort:'high'}},sources:{settings:{model:'命名配置'}}};
  if(command==='read_registered_native_file_for_edit')return '# 完整磁盘原文\nmodel = "gpt-6-astra"';
  if(command==='get_launch_settings')return {selected:'power_shell',terminals:[{id:'auto',label:'系统默认',available:true},{id:'power_shell',label:'PowerShell',available:true},{id:'windows_terminal',label:'Windows Terminal',available:true}]};
  if(command==='get_tray_status')return {available:true,error:null};
  if(command==='list_library_items')return library.filter(i=>i.kind===args.kind&&(!args.search||(i.title+i.body+i.category).includes(args.search)));
  if(command==='list_mcp_definitions')return definitions;
  if(command==='list_native_mcp')return [{...definitions[0],enabled:true,protectedValues:false}];
  if(command==='list_skill_packages')return skills;
  if(command==='list_skill_installations')return [{packageId:'skill-1',toolId:'codex',scope:'global',projectPath:null,targetPath:'C:/Users/local/.codex/skills/code-review',state:'current'}];
  if(command==='list_skill_recovery_issues')return [];
  if(command==='scan_native_skills')return [{name:'code-review',path:'C:/Users/local/.codex/skills/code-review',description:'审查代码变更',managed:true}];
  if(command==='refresh_history')return scans;
  if(command==='list_history_sessions')return records.filter(i=>!args.filter.search||i.title.includes(args.filter.search));
  if(command==='get_history_usage')return usage;
  if(command==='list_history_prices')return [];
  if(command==='get_history_session')return {session:records.find(i=>i.id===args.id),resumeReason:null,usage:[],messages:[{id:'m1',role:'user',timestamp:1790751600000,text:'请梳理原生配置与通用配置的继承关系，确认保存草稿和应用配置的行为。'},{id:'m2',role:'assistant',timestamp:1790751800000,text:'命名配置可以继承本工具的通用配置。保存时只更新资料库；点击保存并应用后，合并结果通过文件事务写入 CLI 原生文件。\n\n若文件已被外部程序修改，应用会暂停并提示冲突，保留当前文件和原绑定。'},{id:'m3',role:'user',timestamp:1790753600000,text:'请补充项目作用域的边界，并给出验证步骤。'}]};
  if(command==='copy_history_resume_command')return "Set-Location -LiteralPath 'C:\\Projects\\cliora'; & 'codex' "+(args.mode==='yolo'?"'--yolo' ":'')+"'resume' '01992e52-1ac0-7387-a5e4-41067718dd93'";
  if(command==='list_portable_items')return [{key:'preferences:managed',kind:'preferences',label:'外观与管理偏好',pendingFields:[]},{key:'profile:codex-daily',kind:'profile',label:'Codex · 日常开发',pendingFields:[]},{key:'library:prompt-1',kind:'library',label:'代码审查',pendingFields:[]},{key:'project:cliora',kind:'project',label:'栖点 · 桌面工具',pendingFields:['本机目录']}];
  if(command==='get_webdav_status')return sync;
  if(command==='plugin:dialog|open')return 'C:/backup.cliora';
  if(command==='preview_portable_bundle')return {previewId:'preview',pendingProjects:1,items:[{key:'profile:codex-daily',kind:'profile',toolId:'codex',label:'Codex · 日常开发',status:'conflict',pendingFields:[],localPreview:'model = "gpt-6-astra"',incomingPreview:'model = "gpt-6-sol"'},{key:'project:cliora',kind:'project',label:'栖点 · 桌面工具',status:'new',pendingFields:['项目本机目录'],localPreview:null,incomingPreview:'{"name":"栖点 · 桌面工具"}'}]};
  return null;
 }}});
}
const failures=[];
for(const width of [1360,900,640])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>failures.push(e.message));await page.addInitScript(mock,theme);await page.goto(process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736');await page.getByText('正在读取本机设置').waitFor({state:'hidden'});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 const nav=page.getByRole('navigation',{name:'页面'});
 async function capture(name){await page.waitForTimeout(100);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);const path=`${out}/${name}-${theme}-${width}.png`;await page.screenshot({path});const over=await page.evaluate(()=>[...document.querySelectorAll('main,section,article,input,textarea,select,button')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,text:el.textContent?.slice(0,60)})));if(over.length)failures.push({name,theme,width,over});console.log(path);}
 await capture('home');
 await nav.getByRole('button',{name:'工具与连接'}).click();await page.getByRole('textbox',{name:'settings 配置草稿'}).waitFor();await capture('native-config');
 await page.getByRole('button',{name:'常用设置',exact:true}).click();await capture('config-form');
 await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByRole('button',{name:/filesystem/}).first().click();await capture('mcp');
 await page.getByRole('tab',{name:'Skills',exact:true}).click();await page.getByRole('button',{name:/code-review/}).first().click();await capture('skills');
 await nav.getByRole('button',{name:'资料库'}).click();await page.getByRole('button',{name:'代码审查',exact:true}).waitFor();await capture('library');
 await nav.getByRole('button',{name:'使用记录'}).click();await page.getByLabel('原生恢复命令').waitFor();await capture('sessions');
 await page.getByRole('tab',{name:'用量',exact:true}).click();await capture('usage');
 await nav.getByRole('button',{name:'设置',exact:true}).click();await capture('settings');
 await page.getByRole('tab',{name:'迁移与同步'}).click();await capture('migration');
 await page.getByRole('button',{name:'导出加密配置包',exact:true}).click();await capture('migration-export');
 await page.getByRole('button',{name:'从配置包恢复',exact:true}).click();await page.getByPlaceholder('输入导出时的口令').fill('correct-password');await page.getByRole('button',{name:'选择配置包并预览'}).click();await capture('migration-import');
 await page.close();
}
await browser.close();console.log(JSON.stringify({failures},null,2));if(failures.length)process.exitCode=1;
