import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyPointerAndMenu,replaceEditorText} from './editor-interaction.mjs';
const require=createRequire('file:///C:/Users/12976/project/cliora/package.json');
const {chromium}=require('@playwright/test'),runFile=promisify(execFile);
const root='C:/Users/12976/AppData/Local/Temp/cliora-native-verification';
const read=async name=>JSON.parse((await fs.readFile(path.join(root,name),'utf8')).replace(/^\uFEFF/,''));
const pi=await read('final-isolated-process.json'),fixtures=await read('final-fixtures.json');
assert.match(pi.identifier,/^dev\.cliora\.verification\.a6final\d*$/);assert(![38172,63232].includes(pi.pid));
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+pi.port);
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://tauri.localhost'));
assert(page,'Actual native WebView required');page.setDefaultTimeout(25000);
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const nav=name=>page.getByRole('button',{name,exact:true});
const tool=name=>page.getByRole('tab',{name,exact:true});
const dialog=(action,target)=>runFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'native-dialog-win32.ps1'),'-WindowProcessId',String(pi.pid),'-Action',action,...target?['-TargetPath',target]:[]],{windowsHide:true,timeout:25000});
const evidence={kind:'native-final-product-verification',candidateSha256:pi.sha256,identifier:pi.identifier,recordedAt:new Date().toISOString(),checks:[],limits:['Real isolated Tauri WebView and SQLite/keyring; user production windows untouched.','All native modifications restricted to owned Temp project or CODEX_HOME/PI/GROK/XDG fixture directories.','Harmless Skills content imported without executing it; no supplier or billed inference requests.']};
const errors=[];page.on('pageerror',error=>errors.push(String(error).slice(0,300)));page.on('dialog',dialog=>{errors.push('Unexpected browser/system confirmation');void dialog.dismiss();});
async function check(name,action){console.log('START '+name);const value=await action();evidence.checks.push({name,result:'passed',...value});console.log('PASS '+name);await fs.writeFile(path.join(root,'native-final-product-after.json'),JSON.stringify(evidence,null,2));}
async function poll(action,expected,description){for(let i=0;i<150;i++){const value=await action();if(expected(value))return value;await page.waitForTimeout(100);}throw new Error(description);}
async function workspace(id){return invoke('get_registered_tool_workspace',{toolId:id,scope:'project',projectPath:fixtures.project});}
async function selectSavedSkill(name){const list=page.getByRole('complementary').filter({has:page.locator('strong',{hasText:'已保存的 Skills'})});await list.getByRole('button',{name:new RegExp('^'+name+' \\d+')}).click();await page.getByRole('heading',{name,exact:true}).waitFor();await page.waitForTimeout(180);}
async function toggleSkill(packageId,toolId,enabled){const toggle=page.getByRole('checkbox',{name:'启用 Skill',exact:true});if(await toggle.isChecked()!==enabled)await toggle.click();await poll(()=>invoke('get_skill_enabled',{packageId,toolId,scope:'project',projectPath:fixtures.project}),value=>value===enabled,'Skill switch saved');await poll(()=>toggle.isChecked(),value=>value===enabled,'Skill checkbox reflects committed switch');}
let project,monitorPromise,monitorActive=false,acceptedAppConfirmations=0;
async function stopConfirmationMonitor(){monitorActive=false;if(!monitorPromise)return;await monitorPromise;monitorPromise=null;}
try{
 monitorActive=true;monitorPromise=(async()=>{while(monitorActive){const prompt=page.locator('dialog.confirmation-dialog[open]');if(await prompt.count()&&await prompt.isVisible()){await prompt.getByRole('button').last().click();acceptedAppConfirmations++;}await page.waitForTimeout(100);}})();monitorPromise.catch(()=>{});
 await page.addInitScript(()=>{window.__clioraCspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__clioraCspViolations.push({directive:event.violatedDirective,blocked:event.blockedURI,source:event.sourceFile,line:event.lineNumber}));});
 await page.reload();await nav('快速开始').waitFor();
 await check('project-native-folder-add-guidance',async()=>{
  await nav('快速开始').click();await page.getByRole('button',{name:'＋ 添加项目',exact:true}).click();await dialog('ChooseDirectory',fixtures.project);
  project=await poll(()=>invoke('list_projects'),items=>items.some(item=>item.path&&item.path.endsWith(path.basename(fixtures.project))),'Project saved from native directory dialog').then(items=>items.find(item=>item.path&&item.path.endsWith(path.basename(fixtures.project))));
  assert.equal(project.name,path.basename(fixtures.project));assert.equal(project.preferredTool,'codex');
  const title=page.locator('strong').filter({hasText:project.name});await title.waitFor();
  assert(!await page.locator('section').filter({hasText:'最近项目'}).innerText().then(text=>text.includes('\\\\?\\')));
  return {folderPicker:true,automaticName:true,defaultTool:project.preferredTool};
 });
 await nav('工具与连接').click();await tool('Codex').click();await page.getByLabel('配置范围',{exact:false}).selectOption('project');await page.getByLabel('配置项目',{exact:true}).selectOption(project.path);
 await check('current-file-simple-save-and-real-mouse-menu',async()=>{
  const editor=page.getByRole('textbox',{name:'settings 配置草稿',exact:true});await editor.waitFor();const original=await fs.readFile(fixtures.codex,'utf8');
  assert.equal(await page.getByLabel('配置名称',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'保存并使用',exact:true}).count(),0);
  const list=page.getByRole('complementary',{name:'命名配置',exact:true});assert(!(await list.getByRole('button').allTextContents()).some(text=>/^(当前配置|通用配置|复制当前配置)$/.test(text.trim())));
  assert(await page.locator('strong').filter({hasText:/^config\.toml$/}).count());
  const interactions=await verifyPointerAndMenu(page,editor,'native TOML editor');
  await replaceEditorText(page,editor,original+'# final native save\n');await page.getByRole('button',{name:'保存',exact:true}).click();
  await poll(()=>fs.readFile(fixtures.codex,'utf8'),text=>text.includes('# final native save'),'Direct native save writes selected Temp project');
  return {interactions,noMandatoryProfile:true,filenamePrimary:true};
 });
 await check('native-edit-external-conflict-and-backup-restore',async()=>{
  const editor=page.getByRole('textbox',{name:'settings 配置草稿',exact:true});const before=await fs.readFile(fixtures.codex,'utf8');
  await replaceEditorText(page,editor,before+'# unsaved UI edit\n');const external=before+'# external editor edit\n';await fs.writeFile(fixtures.codex,external);
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'保留当前文件',exact:true}).waitFor();assert.equal(await fs.readFile(fixtures.codex,'utf8'),external);
  await page.getByRole('button',{name:'保留当前文件',exact:true}).click();
  await page.locator('summary').filter({hasText:/^修改记录$/}).click();const records=page.getByLabel('选择修改记录',{exact:true});await records.waitFor();const value=await records.locator('option').nth(1).getAttribute('value');await records.selectOption(value);
  await page.getByRole('textbox',{name:'修改前文件备份',exact:true}).waitFor();await page.getByRole('button',{name:'恢复此备份',exact:true}).click();
  await poll(()=>fs.readFile(fixtures.codex,'utf8'),text=>!text.includes('# final native save'),'Encrypted original backup restored');
  return {externalEditPreserved:true,explicitConflictChoice:true,encryptedBackupRestored:true};
 });
 if(!process.argv.includes('--resources-only'))await check('Claude-six-roles-save-apply-read-1M-cancellation',async()=>{
  const profileName='Native model mapping verification '+Date.now();
  await tool('Claude Code').click();await page.getByRole('button',{name:'当前配置',exact:true}).click();await page.getByRole('button',{name:'复制为命名配置',exact:true}).click();await page.getByLabel('配置名称',{exact:true}).fill(profileName);
  await page.locator('summary').filter({hasText:/^高级连接选项$/}).click();await page.locator('summary').filter({hasText:/^模型角色映射$/}).click();
  for(const name of ['默认模型','Sonnet','Opus','Fable','Haiku','Subagent'])assert.equal(await page.getByLabel(name+' 请求模型',{exact:true}).inputValue(),'glm-5.3');
  for(const name of ['Sonnet','Opus','Fable','Haiku'])assert.equal(await page.getByLabel(name+' 显示名称',{exact:true}).inputValue(),'glm-5.3');
  const defaultRow=page.getByLabel('默认模型 请求模型',{exact:true}).locator('xpath=../..');await defaultRow.getByRole('checkbox',{name:'1M 上下文',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存并使用',exact:true}).click();
  const applyChoice=page.getByRole('button',{name:'使用本次配置',exact:true});
  try{await applyChoice.waitFor({state:'visible',timeout:4000});await applyChoice.click();}catch(error){if(error.name!=='TimeoutError')throw error;}
  const saved=await poll(async()=>JSON.parse(await fs.readFile(fixtures.claude,'utf8')),json=>json.env.ANTHROPIC_MODEL==='glm-5.3','Default role without 1M saved to native JSON');
  assert.equal(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'glm-5.3[1M]');assert.equal(saved.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME,'glm-5.3');assert.equal(saved.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'glm-5.3');assert(saved.fixture_keep);
  const current=await workspace('claude_code');const profile=current.profiles.find(item=>item.name===profileName);assert(profile&&profile.connection.model==='glm-5.3');
  return {roles:6,preservedRoleNames:true,preservedUnrelatedSettings:true,noStaleConnectionOverwrite:true};
 });
 await check('skills-folder-import-and-Codex-independent-A-B-toggle',async()=>{
  await tool('Codex').click();await tool('Skills').click();
  for(const source of [fixtures.skill,fixtures.skillBeta]){await page.getByRole('button',{name:'导入文件夹',exact:true}).click();await dialog('ChooseDirectory',source);await page.getByRole('heading',{name:path.basename(source),exact:true}).waitFor();}
  const packages=await invoke('list_skill_packages');const a=packages.find(item=>item.name===path.basename(fixtures.skill)),b=packages.find(item=>item.name===path.basename(fixtures.skillBeta));assert(a&&b);assert.equal(a.fileCount,2);assert.equal(b.fileCount,1);
  for(const item of [a,b]){await selectSavedSkill(item.name);await page.getByRole('button',{name:'安装到当前 CLI',exact:true}).click();await poll(()=>page.getByRole('button',{name:'安装到当前 CLI',exact:true}).isEnabled(),value=>value,'Skill installation complete');if(!await invoke('get_skill_enabled',{packageId:item.id,toolId:'codex',scope:'project',projectPath:fixtures.project}))await toggleSkill(item.id,'codex',true);await poll(()=>invoke('get_skill_enabled',{packageId:item.id,toolId:'codex',scope:'project',projectPath:fixtures.project}),value=>value,'Installed skill enabled');}
  await selectSavedSkill(a.name);await toggleSkill(a.id,'codex',false);await selectSavedSkill(b.name);await toggleSkill(b.id,'codex',false);await selectSavedSkill(a.name);await toggleSkill(a.id,'codex',true);
  assert.equal(await invoke('get_skill_enabled',{packageId:b.id,toolId:'codex',scope:'project',projectPath:fixtures.project}),false);
  await selectSavedSkill(b.name);await toggleSkill(b.id,'codex',true);
  const installations=await invoke('list_skill_installations',{packageId:a.id});const install=installations.find(item=>item.toolId==='codex');assert(install);assert.equal(await fs.readFile(path.join(install.targetPath,'references','notes.md'),'utf8'),await fs.readFile(path.join(fixtures.skill,'references','notes.md'),'utf8'));
  evidence.skillA=a;return {twoPackagesInstalled:true,independentRestore:true,completeResourceBytesPreserved:true};
 });
 await check('Claude-OpenCode-Pi-Skill-switches-native-or-preserved-folder',async()=>{
  const a=evidence.skillA;assert(a);
  for(const [id,name] of [['claude_code','Claude Code'],['open_code','OpenCode'],['pi','Pi']]){
   await tool(name).click();await tool('Skills').click();await selectSavedSkill(a.name);await page.getByRole('button',{name:'安装到当前 CLI',exact:true}).click();await poll(()=>page.getByRole('button',{name:'安装到当前 CLI',exact:true}).isEnabled(),value=>value,'Skill installation complete');if(!await invoke('get_skill_enabled',{packageId:a.id,toolId:id,scope:'project',projectPath:fixtures.project}))await toggleSkill(a.id,id,true);await poll(()=>invoke('get_skill_enabled',{packageId:a.id,toolId:id,scope:'project',projectPath:fixtures.project}),value=>value,'Installed '+name+' Skill');
   await toggleSkill(a.id,id,false);await toggleSkill(a.id,id,true);
   const installations=await invoke('list_skill_installations',{packageId:a.id});const install=installations.find(item=>item.toolId===id);assert(install);assert.equal(await fs.readFile(path.join(install.targetPath,'SKILL.md'),'utf8'),await fs.readFile(path.join(fixtures.skill,'SKILL.md'),'utf8'));
  }
  return {tools:['claude_code','open_code','pi'],nativePoliciesRestored:true,folderFallbackRestored:true};
 });
 await check('MCP-disable-save-reselect-keeps-target-state',async()=>{
  const mcpName='native-toggle-fixture-'+Date.now();await tool('Claude Code').click();await tool('MCP').click();await page.getByRole('button',{name:'＋ 新建',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill(mcpName);await page.getByLabel('命令',{exact:true}).fill('cliora-harmless-placeholder');
  await page.getByRole('button',{name:'保存到当前 CLI',exact:true}).click();
  const target={toolId:'claude_code',scope:'project',projectPath:fixtures.project,enabled:true};await poll(()=>invoke('list_native_mcp',{target}),items=>items.some(item=>item.name===mcpName),'Native MCP created without running command');
  await page.getByRole('checkbox',{name:'启用 MCP',exact:true}).uncheck();await page.getByRole('button',{name:'保存到当前 CLI',exact:true}).click();
  const defs=await invoke('list_mcp_definitions');const def=defs.find(item=>item.name===mcpName);assert(def);
  await poll(()=>invoke('get_managed_mcp_enabled',{definitionId:def.id,target}),value=>value===false,'Managed MCP disabled');
  await tool('原生配置').click();await tool('MCP').click();const list=page.getByRole('complementary').filter({has:page.locator('strong',{hasText:'MCP 资料'})});await list.getByRole('button',{name:new RegExp('^'+mcpName+' cliora-harmless-placeholder')}).click();await poll(()=>page.getByRole('checkbox',{name:'启用 MCP',exact:true}).isChecked(),value=>value===false,'Reselected MCP reflects disabled native target');
  await page.getByRole('checkbox',{name:'启用 MCP',exact:true}).check();await page.getByRole('button',{name:'保存到当前 CLI',exact:true}).click();await poll(()=>invoke('list_native_mcp',{target}),items=>items.some(item=>item.name===mcpName&&item.enabled),'MCP restored');return {disabledDefinitionRetained:true,reselectedTargetState:false,restored:true};
 });
 await check('native-project-rule-disable-enable-exact-content-and-editor-menu',async()=>{
  const original=await fs.readFile(fixtures.agents,'utf8');await nav('资料库').click();await tool('长期规则').click();await page.locator('summary').filter({hasText:/^编辑当前 CLI 规则$/}).click();await page.getByLabel('规则工具',{exact:true}).selectOption('codex');await page.getByLabel('规则范围',{exact:true}).selectOption('project');await page.getByLabel('规则项目',{exact:true}).selectOption(project.path);
  const editor=page.getByRole('textbox',{name:'当前原生规则',exact:true});await editor.waitFor();const interaction=await verifyPointerAndMenu(page,editor,'native Markdown rule editor');await replaceEditorText(page,editor,original);
  const ruleSwitch=page.getByRole('checkbox',{name:'启用规则',exact:true});await ruleSwitch.click();await poll(()=>fs.readFile(fixtures.agents,'utf8'),text=>text==='','Native rule inactive');await poll(()=>ruleSwitch.isChecked(),value=>value===false,'Rule checkbox reflects disabled native file');await ruleSwitch.click();await poll(()=>fs.readFile(fixtures.agents,'utf8'),text=>text===original,'Original rule body restored byte for byte');await poll(()=>ruleSwitch.isChecked(),value=>value===true,'Rule checkbox reflects restored native body');
  const formGeometry=await page.locator('.native-rule-editor').evaluate(element=>({selectHeights:[...element.querySelectorAll('select')].map(item=>item.getBoundingClientRect().height),saveButtonHeight:[...element.querySelectorAll('button')].find(item=>item.textContent==='保存规则')?.getBoundingClientRect().height}));assert(formGeometry.selectHeights.every(height=>height>=32)&&formGeometry.saveButtonHeight>=32,'Native rule controls use the application form style');await page.screenshot({path:path.join(root,'final-native-rule-editor.png')});return {originalBytesRestored:true,interaction,formGeometry};
 });
 await check('project-rename-remove-keeps-folder',async()=>{
  await nav('快速开始').click();const card=page.locator('div').filter({has:page.locator('strong').filter({hasText:new RegExp('^'+project.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})}).filter({has:page.locator('summary').filter({hasText:'项目选项'})}).last();await card.locator('summary').filter({hasText:'项目选项'}).click();await page.getByLabel(project.name+' 项目名称',{exact:true}).fill('本机交互验证项目');await card.getByRole('button',{name:'保存名称',exact:true}).click();
  await poll(()=>invoke('list_projects'),items=>items.some(item=>item.id===project.id&&item.name==='本机交互验证项目'),'Project renamed');const renamedCard=page.locator('div').filter({has:page.locator('strong').filter({hasText:/^本机交互验证项目$/})}).filter({has:page.locator('summary').filter({hasText:'项目选项'})}).last();await stopConfirmationMonitor();const prompt=page.getByRole('dialog',{name:'移除项目',exact:true});
  await renamedCard.getByRole('button',{name:'移除项目',exact:true}).click();await prompt.waitFor();assert(await prompt.getByRole('button',{name:'取消',exact:true}).evaluate(element=>element===document.activeElement),'Cancel is the default focused action');const bounds=await prompt.boundingBox();assert(bounds.width<=500);await prompt.screenshot({path:path.join(root,'final-application-confirmation-light.png')});await page.keyboard.press('Escape');await prompt.waitFor({state:'hidden'});assert((await invoke('list_projects')).some(item=>item.id===project.id),'Application Escape keeps project');
  await renamedCard.getByRole('button',{name:'移除项目',exact:true}).click();await prompt.getByRole('button',{name:'取消',exact:true}).click();await prompt.waitFor({state:'hidden'});assert((await invoke('list_projects')).some(item=>item.id===project.id),'Application Cancel keeps project');
  await nav('设置').click();await page.getByLabel('主题',{exact:true}).selectOption('dark');await nav('快速开始').click();const darkCard=page.locator('div').filter({has:page.locator('strong').filter({hasText:/^本机交互验证项目$/})}).filter({has:page.locator('summary').filter({hasText:'项目选项'})}).last();await darkCard.locator('summary').filter({hasText:'项目选项'}).click();await darkCard.getByRole('button',{name:'移除项目',exact:true}).click();await prompt.waitFor();await prompt.screenshot({path:path.join(root,'final-application-confirmation-dark.png')});await prompt.getByRole('button',{name:'移除项目',exact:true}).click();await poll(()=>invoke('list_projects'),items=>!items.some(item=>item.id===project.id),'Project DB row removed after application confirmation');await fs.access(fixtures.project);await fs.access(fixtures.codex);await nav('设置').click();await page.getByLabel('主题',{exact:true}).selectOption('light');return {renamed:true,applicationEscapePreservedProject:true,applicationCancelPreservedProject:true,applicationAcceptRemovedAssociation:true,removedOnlyAssociation:true,directoryRetained:true,confirmationBounds:bounds,acceptedAppConfirmations};
 });
 await check('native-CSP-and-no-page-errors',async()=>{const violations=await page.evaluate(()=>window.__clioraCspViolations??[]);assert.deepEqual(violations,[]);assert.deepEqual(errors,[]);return {violations:[],pageErrors:[]};});
 delete evidence.skillA;evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error=String(error);try{await page.screenshot({path:path.join(root,'native-final-product-failure.png')});}catch{};throw error;}
finally{await stopConfirmationMonitor();await fs.writeFile(path.join(root,'native-final-product-after.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({result:evidence.result,checks:evidence.checks.length,error:evidence.error}));await browser.close();}
