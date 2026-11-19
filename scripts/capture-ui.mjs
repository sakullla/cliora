import { installPromptFixtureBridge, installRichPromptFixtures } from './capture-prompt-fixtures.mjs';
import { installWorkspaceFixtures } from './capture-workspace-fixtures.mjs';
import { settleCapture, previousCaptureCleanup } from './capture-ready.mjs';
import { mock } from './capture-ui-mock.mjs';
/** Synthetic, populated native-IPC fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { workflowFixtures, qoderHistoryFixtures } from './capture-workflow-fixtures.mjs';
import { captureConfiguration, configurationScenarios, installCaptureConfigurationProtocol } from './capture-configuration.mjs';
const qoderHistoryScenarioNames=['qoder-history-detail','qoder-history-credits','qoder-history-groups','qoder-history-unknown'];
const historyScenarioNames=['grok-precise-detail','grok-inferred-time','grok-no-usage','grok-statistics','grok-statistics-details'];
const scenarioNames=[...configurationScenarios.map(item=>item.name),...historyScenarioNames,...qoderHistoryScenarioNames];
const option=(flag,fallback)=>{const index=process.argv.indexOf(flag);if(index<0)return fallback;const value=process.argv[index+1];if(!value||value.startsWith('--'))throw new Error('Missing value for '+flag);return value;};
const themeOption=option('--theme','all');
if(!['all','light','dark'].includes(themeOption))throw new Error('Invalid --theme; use all, light or dark');
const themes=themeOption==='all'?['light','dark']:[themeOption];
const sizeOption=option('--size','1360');
// --home adds the 1280 width where the reported two-column project grid squeezed card titles.
const homeCapture=process.argv.includes('--home');
const compat640=process.env.CLIORA_CAPTURE_640==='1'||process.argv.includes('--compat-640');
const allowedWidths=homeCapture?[1360,1280,900,720,640]:[1360,900,720,640];
const defaultWidths=(homeCapture?[1360,1280,900,720]:[1360,900,720]).concat(compat640?[640]:[]);
const widths=sizeOption==='all'?defaultWidths:[...new Set(sizeOption.split(',').map(Number))];
if(!widths.length||widths.some(width=>!allowedWidths.includes(width)))throw new Error('Invalid --size; use all|1360,900,720' + (homeCapture?',1280':'') + '; 640 requires an explicit width or CLIORA_CAPTURE_640=1');
// --measure: count fully visible entries in main for each page scenario at 1360x1000 light (02 ADR-0).
const measure=process.argv.includes('--measure');
const measureViewport={width:1360,height:1000};
const pageScenarioNames=new Set(['home','tools','oauth-accounts','native-plugins','native-agents','mcp','skills','library','library-rules','library-mcp','library-skills','sessions','usage','settings','migration']);
const firstScreen={};
if(measure&&(!themes.includes('light')||!widths.includes(measureViewport.width)))throw new Error('--measure needs the light theme and the 1360 width in the capture matrix');
const onlyOption=option('--only','*');
const patterns=onlyOption.split(',').map(pattern=>new RegExp('^'+pattern.split('').map(char=>char==='*'?'.*':char==='?'?'.':char.replace(/[\\^$+.[\]{}()|]/g,'\\$&')).join('')+'$'));
const quickPageNames=['home','tools','library','sessions','usage','settings','migration'];
const selectedPages=quickPageNames.filter(name=>patterns.some(pattern=>pattern.test(name)));
const candidates=(process.argv.includes('--features')||process.argv.includes('--workflows'))&&!process.argv.includes('--only')?configurationScenarios.map(item=>item.name):scenarioNames;
const selectedScenarios=candidates.filter(name=>patterns.some(pattern=>pattern.test(name)));
if((process.argv.includes('--features')||process.argv.includes('--workflows')||process.argv.includes('--list')||process.argv.includes('--only'))&&!selectedScenarios.length&&!selectedPages.length)throw new Error('No matching capture scenarios');
if(process.argv.includes('--list')){console.log([...selectedPages,...selectedScenarios].join('\n'));process.exit(0);}
const pagesOnly=process.argv.includes('--only')&&selectedPages.length>0&&selectedScenarios.length===0;
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\\/g,'/').replace(/\/$/,'');
const workflowsOnly=process.argv.includes('--features')||process.argv.includes('--workflows');
const scopedCapture=process.argv.some(arg=>['--full','--only','--features','--workflows','--records','--sessions','--connections','--skills','--mcp','--rules','--remote-hosts','--write-recovery','--home','--projects','--prompts'].includes(arg));
const quickCapture=process.argv.includes('--quick')||!scopedCapture;
const fullCapture=!quickCapture&&!pagesOnly&&!process.argv.some(arg=>['--features','--workflows','--records','--sessions','--connections','--skills','--mcp','--rules','--remote-hosts','--write-recovery','--home','--projects','--prompts'].includes(arg));
const captureMode=process.argv.includes('--prompts')?'prompts':process.argv.includes('--projects')?'projects':homeCapture?'home':process.argv.includes('--write-recovery')?'write-recovery':process.argv.includes('--remote-hosts')?'remote-hosts':workflowsOnly?'features':process.argv.includes('--sessions')?'sessions':process.argv.includes('--records')?'records':process.argv.includes('--connections')?'connections':process.argv.includes('--skills')?'skills':process.argv.includes('--mcp')?'mcp':process.argv.includes('--rules')?'rules':'full';
const manifestName=`capture-ui${['features','sessions','records','connections','skills','mcp','rules','remote-hosts','write-recovery','home','projects','prompts'].includes(captureMode)?'-'+captureMode:''}-manifest.json`;
const acceptanceNote='Playwright 与合成 IPC 截图仅用于浏览器界面检查，不是 WebView2、真实桌面主题/焦点/键盘或原生 CLI/文件写入验收；未执行的平台行为均为未验证。';
const acceptance={kind:'playwright-synthetic-ipc',nativePlatform:'unverified',webview2:'unverified',desktopThemeFocusKeyboard:'unverified',nativeCliAndFileWrites:'unverified',note:acceptanceNote};
const out=process.env.CLIORA_CAPTURE_OUT ?? root+'/docs/verification/ui'; fs.mkdirSync(out,{recursive:true});
const prunePrevious=previousCaptureCleanup(out,manifestName);
const previewUrl=process.env.CLIORA_PREVIEW_URL??'http://127.0.0.1:14736';
let previewReady=false;
for(let attempt=0;attempt<50;attempt++){
 try{const response=await fetch(previewUrl,{signal:AbortSignal.timeout(1000)});if(response.ok){previewReady=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,200));
}
if(!previewReady)throw new Error(`预览服务未就绪：${previewUrl}。请先构建并启动 Vite preview，再运行捕获。`);
const browser=await chromium.launch();
const failures=[];
const captures=[];
// Ignore content deliberately clipped by a horizontal scroll or clipping container.
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
async function captureImage(page,name,theme,width,metadata={}){
 await page.mouse.move(0,0);
 await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 await settleCapture(page);
 const file=`${name}-${theme}-${width}.png`;
 const path=`${out}/${file}`;
 await page.screenshot({path,animations:'disabled'});
 captures.push({name,theme,width,height:page.viewportSize().height,path,file,category:'general_ui',state:name,...metadata});
 const over=await page.evaluate(findOverflow);
 if(over.length)failures.push({name,theme,width,over});
 if(measure&&theme==='light'&&width===measureViewport.width&&pageScenarioNames.has(name)&&!(name in firstScreen)){
  const previous=page.viewportSize();
  const resize=previous.width!==measureViewport.width||previous.height!==measureViewport.height;
  if(resize){await page.setViewportSize(measureViewport);await settleCapture(page);}
  firstScreen[name]=await page.evaluate(countFirstScreen);
  captures[captures.length-1].firstScreen=firstScreen[name];
  if(resize)await page.setViewportSize(previous);
 }
 console.log(path);
}
// Entries fully inside the viewport and every clipping ancestor; querySelectorAll deduplicates elements.
function countFirstScreen(){
 const main=document.querySelector('main');
 if(!main)return 0;
 return [...main.querySelectorAll('[data-tool-row], [data-project-id], [data-profile-id], article, li, [role="row"], [role="listitem"]')].filter(el=>{
  if(!el.getClientRects().length)return false;
  const style=getComputedStyle(el);
  if(style.visibility==='hidden'||style.display==='none')return false;
  const rect=el.getBoundingClientRect();
  if(rect.width<=0||rect.height<=0)return false;
  let top=0,left=0,bottom=innerHeight,right=innerWidth;
  for(let parent=el.parentElement;parent&&parent!==document.documentElement;parent=parent.parentElement){
   const parentStyle=getComputedStyle(parent);
   if(['auto','scroll','hidden','clip'].includes(parentStyle.overflowX)||['auto','scroll','hidden','clip'].includes(parentStyle.overflowY)){
    const box=parent.getBoundingClientRect();top=Math.max(top,box.top);left=Math.max(left,box.left);bottom=Math.min(bottom,box.bottom);right=Math.min(right,box.right);
   }
  }
  return rect.top>=top-1&&rect.left>=left-1&&rect.bottom<=bottom+1&&rect.right<=right+1;
 }).length;
}
// CLIs are chosen from the h2 switcher in the 工具 header (a single managed CLI has no switcher).
async function openCli(page, name) {
  const region = page.getByRole('region', { name: '工具' });
  if (!await region.isVisible()) await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  const title = region.locator('[data-workspace-chrome] h2');
  await title.waitFor();
  const picker = title.getByRole('button', { name: /，切换 CLI$/ });
  if (await picker.count() && !(await picker.getAttribute('aria-label')).startsWith(`${name}，`)) {
    await picker.click();
    await page.getByRole('listbox', { name: /，切换 CLI$/ }).getByRole('option').filter({ has: page.getByText(name, { exact: true }) }).click();
  }
  await region.getByRole('heading', { level: 2, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(，切换 CLI)?$`) }).waitFor();
}
async function captureSkillViews(page,capture){
 await openCli(page,'Codex');
 await page.getByRole('tab',{name:'Skill',exact:true}).click();
 const list=page.getByRole('region',{name:'Skill'});
 const article=()=>page.getByRole('article');
 await list.getByRole('button',{name:/code-review/}).waitFor();
 await expect(list.getByRole('button',{name:/code-review/})).toContainText('已安装');
 await expect(list.getByRole('button',{name:/crud-page/})).toContainText('本机目录');
 await expect(list.getByRole('button',{name:/lark-apps/})).toContainText('本机目录');
 await expect(list.getByText('暂不可读取')).toHaveCount(0);
 await capture('skills');
 async function discardIfAsked(){
  const confirmation=page.getByRole('dialog',{name:'放弃未保存修改？'});
  if(await confirmation.count()&&await confirmation.isVisible())await confirmation.getByRole('button',{name:'放弃修改',exact:true}).click();
 }
 async function openSkill(name,sample,reading){
  const save=page.getByRole('button',{name:'保存',exact:true});
  const dirty=await save.count()&&await save.isEnabled();
  await list.getByRole('button',{name:new RegExp(name)}).click();
  if(dirty)await discardIfAsked();
  await page.getByRole('region',{name:'SKILL.md 预览'}).waitFor();
  if(reading)await capture(reading);
  await article().getByRole('button',{name:'编辑',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'SKILL.md'});
  await editor.waitFor();
  await expect(editor).toContainText(sample);
  return editor;
 }
 async function closeSkill(){
  const back=page.getByRole('button',{name:'返回列表',exact:true});
  if(!(await back.count())||!(await back.isVisible()))return;
  const save=page.getByRole('button',{name:'保存',exact:true});
  const dirty=await save.count()&&await save.isEnabled();
  await back.click();
  if(dirty)await discardIfAsked();
  await expect(back).toBeHidden();
 }
 const loose=await openSkill('crud-page','# page');
 await expect(article()).toContainText('目录名就是这份 Skill');
 await expect(article().getByRole('heading',{name:'crud-page',exact:true})).toBeVisible();
 await expect(article().getByRole('button',{name:'放进资料库',exact:true})).toBeVisible();
 await expect(article().getByRole('button',{name:'保存',exact:true})).toBeDisabled();
 await loose.click();
 await page.keyboard.press('End');
 await page.keyboard.type('编辑过');
 await expect(article().getByRole('button',{name:'保存',exact:true})).toBeEnabled();
 await capture('skill-editor');
 await closeSkill();
 await openSkill('lark-apps','# just markdown');
 await expect(article().getByRole('button',{name:'放进资料库',exact:true})).toBeVisible();
 await closeSkill();
 await openSkill('code-review','# 代码审查','skill-reading');
 await closeSkill();
 // Specification fields, notes and bundled files in the reading view.
 await list.getByRole('button',{name:/pdf-processing/}).click();
 const reading=page.getByRole('region',{name:'SKILL.md 预览'});
 await reading.getByLabel('SKILL.md 字段').waitFor();
 await expect(reading.getByRole('list',{name:'allowed-tools'}).getByRole('listitem')).toHaveText(['Bash(python:*)','Read']);
 await expect(reading.getByText('实验字段')).toBeVisible();
 const files=reading.getByLabel('附带文件',{exact:true});
 await capture('skill-manifest');
 await files.scrollIntoViewIfNeeded();
 await capture('skill-attachments');
 // Bundled and linked files open in the reader with a breadcrumb back to SKILL.md.
 const trail=page.getByRole('navigation',{name:'Skill 文件导航'});
 await reading.getByRole('link',{name:'FORMS.md'}).click();
 await page.getByRole('region',{name:'引用文件：references/FORMS.md'}).getByRole('heading',{name:'表单字段'}).waitFor();
 await capture('skill-reference');
 await trail.getByRole('button',{name:'返回'}).click();
 await files.getByRole('button',{name:'scripts/extract.py'}).click();
 await page.getByRole('textbox',{name:'引用文件：scripts/extract.py'}).waitFor();
 await capture('skill-file');
 await trail.getByRole('button',{name:'SKILL.md'}).click();
 await files.getByRole('button',{name:'assets/form-template.pdf'}).click();
 await expect(page.getByRole('region',{name:'引用文件：assets/form-template.pdf'})).toContainText('二进制文件');
 await trail.getByRole('button',{name:'返回'}).click();
 await closeSkill();
 await list.getByRole('button',{name:/crud-page/}).click();
 await expect(page.getByRole('region',{name:'SKILL.md 预览'}).getByLabel('规范提示').getByRole('listitem')).toHaveCount(2);
 await capture('skill-issues');
 await closeSkill();
 await openSkill('code-review','# 代码审查');
 await expect(article().getByRole('switch',{name:'启用 Skill'})).toBeVisible();
 await expect(article().getByRole('button',{name:'放进资料库',exact:true})).toHaveCount(0);
 await expect(article().getByRole('button',{name:'保存',exact:true})).toBeVisible();
 await capture('skill-editor-managed');
 await closeSkill();
}
// RecordsPage reads tool.history.state. workflowFixtures replaces these tools without history.
function annotateCaptureHistoryTools(){
 const invoke=window.__TAURI_INTERNALS__.invoke;
 const withHistory=tool=>tool&&typeof tool==='object'?{...tool,history:tool.history&&typeof tool.history==='object'?tool.history:{state:'available',reason:''}}:tool;
 window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
  const result=await invoke(command,args);
  if(command==='get_bootstrap'&&result&&Array.isArray(result.tools))return {...result,tools:result.tools.map(withHistory)};
  if(command==='list_cli_adapters'&&result&&Array.isArray(result.registered))return {...result,registered:result.registered.map(withHistory)};
  return result;
 };
}
async function captureHistoryFeatures(){
 for(const width of widths)for(const theme of themes){
  const page=await browser.newPage({viewport:{width,height:1100},locale:process.env.CLIORA_CAPTURE_LOCALE??'zh-CN'});
  page.on('pageerror',error=>failures.push({type:'pageerror',theme,width,message:error.message}));
  await page.addInitScript(mock,theme);
  await page.addInitScript(workflowFixtures);
  await page.addInitScript(annotateCaptureHistoryTools);
  await page.goto(process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736');
  await page.getByText('正在读取本机设置').waitFor({state:'hidden'});
  const nav=page.getByRole('navigation',{name:'页面'});
  const dialog=page.locator('dialog.guide-dialog');
  async function capture(name,workflow,state){
   if(!selectedScenarios.includes(name))return;
   await captureImage(page,name,theme,width,{category:'records',title:name.replace(/^grok-/, 'Grok · '),state});
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
   await nav.getByRole('button',{name:'记录'}).click();
   await page.getByRole('button',{name:/Grok · Token 核对示例/}).click();
   await expect(page.locator('time[title*="按轮次开始时间推断"]')).toContainText('约');
   await capture('grok-precise-detail','history','native timestamp / inferred turn time / no usage summary card');
   await page.locator('[data-message-id="a"]').scrollIntoViewIfNeeded();
   await expect(page.locator('[data-message-id="u"]')).toContainText('没有可验证时间');
   await capture('grok-inferred-time','history','native timestamp / inferred turn time / unknown message time');
   if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();
   await page.getByRole('button',{name:/Grok · 没有用量的会话/}).click();
   await capture('grok-no-usage','history','session without usage records / preserved readable message');
   if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();
   await page.getByRole('textbox',{name:'搜索会话'}).fill('Token');
   await page.getByRole('group',{name:'会话筛选'}).getByRole('button',{name:'只看收藏',exact:true}).click();
   await expect(page.getByRole('group',{name:'会话筛选'}).getByRole('button',{name:'只看收藏',exact:true})).toHaveAttribute('aria-pressed','true');
   await page.getByRole('tab',{name:'用量',exact:true}).click();
   const overview=page.getByRole('region',{name:'用量概览'});
   await expect(overview).toContainText('1 条记录次数未知');
   await expect(overview).not.toContainText('每次约');
   await expect(page.getByText('筛选：搜索「Token」 · 只看收藏',{exact:true})).toBeVisible();
   await capture('grok-statistics','history','search Token + favorite filter / known calls with unknown count / no misleading average');
   await page.getByRole('region',{name:'消耗最多的会话'}).scrollIntoViewIfNeeded();
   await capture('grok-statistics-details','history','consistent model/tool/project/session group totals');
  }catch(error){failures.push({type:'scenario',theme,width,message:error.message});console.error(error.message);}
  finally{await page.close();}
 }
}

async function captureQoderHistoryFeatures(){
 const variants=[false,true].filter(unknown=>selectedScenarios.some(name=>qoderHistoryScenarioNames.includes(name)&&(name==='qoder-history-unknown')===unknown));
 for(const width of widths)for(const theme of themes)for(const unknownAmounts of variants){
  const page=await browser.newPage({viewport:{width,height:1100},locale:process.env.CLIORA_CAPTURE_LOCALE??'zh-CN'});
  page.on('pageerror',error=>failures.push({type:'pageerror',theme,width,message:error.message}));
  await page.addInitScript(mock,theme);
  await page.addInitScript(qoderHistoryFixtures,{unknownAmounts});
  async function capture(name,state){if(selectedScenarios.includes(name))await captureImage(page,name,theme,width,{category:'records',title:name,state});}
  try {
   await page.goto(previewUrl);
   await page.getByRole('navigation',{name:'页面'}).getByRole('button',{name:'记录'}).click();
   await page.getByRole('button',{name:/Qoder CN · 原生 Credits 与会话/}).click();
   if(unknownAmounts){
    await expect(page.getByRole('tabpanel',{name:/^会话/})).toContainText('1 条记录没有 token');
    await page.getByRole('tab',{name:'用量',exact:true}).click();
    await expect(page.getByRole('region',{name:'用量概览'})).toContainText('未知');
    await expect(page.getByRole('region',{name:'用量概览'})).not.toContainText('暂无调用次数');
    await capture('qoder-history-unknown','one known call with unknown native amounts and tokens');
    continue;
   }
   await expect(page.getByRole('region',{name:'CLI 自带计量'})).toContainText('12.345 Credits');
   await capture('qoder-history-detail','native transcript and original/billable credits');
   await page.getByRole('tab',{name:'用量',exact:true}).click();
   await expect(page.getByRole('region',{name:'用量概览'})).toContainText('未知');
   await expect(page.getByRole('radio',{name:'Credits',exact:true})).toHaveAttribute('aria-checked','true');
   await capture('qoder-history-credits','credits trend with unknown tokens and no invented monetary cost');
   await page.getByRole('region',{name:'消耗最多的会话'}).scrollIntoViewIfNeeded();
   await capture('qoder-history-groups','model tool project and session groups retain native units');
  } catch(error){failures.push({type:'scenario',theme,width,message:error.message});console.error(error.message);}
  finally{await page.close();}
 }
}

function writeGallery(){
 const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const label=item=>item.title??item.name;
 const scenarioOptions=[...new Map(captures.map(item=>[item.name,label(item)]))].map(([name,title])=>`<option value="${escape(name)}">${escape(title)}</option>`).join('');
 const cards=captures.map(item=>`<figure data-scenario="${escape(item.name)}" data-theme="${item.theme}" data-width="${item.width}" data-keywords="${escape((item.name+' '+item.state+' '+label(item)).toLowerCase())}"><a href="${escape(item.file)}" target="_blank" rel="noopener"><img loading="lazy" src="${escape(item.file)}" alt="${escape(label(item))} ${item.theme} ${item.width}"></a><figcaption>${escape(label(item))}<small>${item.theme} · ${item.width} × ${item.height}</small><small>${escape(item.state)}</small></figcaption></figure>`).join('');
 const missing=workflowsOnly||fullCapture?widths.flatMap(width=>themes.flatMap(theme=>selectedScenarios.filter(name=>!captures.some(item=>item.name===name&&item.width===width&&item.theme===theme)).map(name=>({name,theme,width})))):[];
 if(missing.length)failures.push({type:'missing',missing});
 fs.writeFileSync(`${out}/index.html`,`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cliora UI 捕获</title><style>
body{margin:0;background:#101114;color:#f5f2ec;font:15px system-ui}header{position:sticky;top:0;padding:20px 4vw;background:#191b20;z-index:2;border-bottom:1px solid #34363d}h1{font-size:24px;margin:0 0 8px}p{color:#b3afa6}.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:end}label{display:grid;gap:5px;font-size:13px;color:#c9c6c0}select,input,button{font:inherit;padding:9px;border:1px solid #555;border-radius:8px;background:#25272d;color:#f5f2ec;max-width:100%;box-sizing:border-box}select{max-width:min(350px,80vw)}button{cursor:pointer}input{width:240px}.result{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0 0}main{padding:24px 4vw;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:24px}figure{margin:0;padding:12px;border:1px solid #34363d;border-radius:12px;min-width:0}img{width:100%;height:340px;object-fit:contain;background:#070709}figcaption{padding:12px 0 0;overflow-wrap:anywhere}a{color:#b8d2ff}small{display:block;color:#b3afa6;margin-top:5px}#empty{padding:24px 4vw}[hidden]{display:none!important}</style></head><body><header><h1>Cliora UI 捕获</h1><p>${failures.length?'捕获有失败，请查看清单':'捕获完成'} · ${captures.length} 张 · 合成 IPC 数据，仅用于界面检查。</p><p>${acceptanceNote}</p><form class="filters" id="filters"><label>场景<select id="scenario" aria-label="场景"><option value="">全部场景</option>${scenarioOptions}</select></label><label>主题<select id="theme" aria-label="主题"><option value="">全部主题</option><option value="light">浅色 light</option><option value="dark">深色 dark</option></select></label><label>宽度<select id="width" aria-label="宽度"><option value="">全部宽度</option>${widths.map(width=>`<option>${width}</option>`).join('')}</select></label><label>关键词<input id="query" type="search" placeholder="如 Kimi / 上下文 / 账号" aria-label="场景或关键词"></label><button type="reset">重置筛选</button></form><div class="result"><output id="count" aria-live="polite"></output><a href="${manifestName}">捕获清单</a></div></header><p id="empty" hidden>没有匹配的图片，请调整筛选或重置。</p><main>${cards}</main><script>
const ids=['scenario','theme','width','query'];const controls=ids.map(id=>document.getElementById(id));const cards=[...document.querySelectorAll('figure')];function filter(){let count=0;const query=controls[3].value.trim().toLowerCase();for(const card of cards){card.hidden=controls.slice(0,3).some((control,index)=>control.value&&card.dataset[ids[index]]!==control.value)||!card.dataset.keywords.includes(query);if(!card.hidden)count++;}document.getElementById('count').textContent='显示 '+count+' / '+cards.length+' 张';document.getElementById('empty').hidden=count!==0;}controls.forEach(control=>control.addEventListener('input',filter));document.getElementById('filters').addEventListener('submit',event=>event.preventDefault());document.getElementById('filters').addEventListener('reset',()=>setTimeout(filter,0));filter();
</script></body></html>`);
 const rows=[...new Map(captures.map(item=>[item.name,label(item)]))].map(([name,title])=>`| ${title} | ${captures.filter(item=>item.name===name).map(item=>`[${item.theme} ${item.width}](${item.file})`).join(' · ')} |`);
 fs.writeFileSync(`${out}/README.md`,`# UI 捕获\n\n[浏览图片画廊](index.html) · [机器可读清单](${manifestName})\n\n按场景、主题、宽度或关键词浏览功能界面，支持重置、匹配数量和原图查看。\n\n执行：\n\n\`\`\`sh\nCLIORA_PREVIEW_URL=http://127.0.0.1:14736 ${['node','scripts/capture-ui.mjs',...process.argv.slice(2)].join(' ')}\n\`\`\`\n\n\`--rules\` 捕获远程规则绑定读取、失败、陈旧、编辑草稿与恢复；\`--features\` 捕获配置与账号功能；\`--theme light|dark|all\`、\`--size all|1360,900,720\`（640 需显式指定或 CLIORA_CAPTURE_640=1）、\`--only 'kimi-*'\` 可缩小范围，\`--list\` 列出场景。CLIORA_CAPTURE_OUT 可指定输出目录。预览服务器需运行当前 frontend build。\n\n本次生成 ${captures.length} 张图片，${failures.length} 项检查失败。${acceptanceNote}真实登录与计费也未验证。\n\n| 功能场景 | 图片 |\n| --- | --- |\n${rows.join('\n')}\n`);
 fs.writeFileSync(`${out}/${manifestName}`,JSON.stringify({capturedAt:new Date().toISOString(),synthetic:true,acceptance,invocation:['node','scripts/capture-ui.mjs',...process.argv.slice(2)].join(' '),previewUrl:process.env.CLIORA_PREVIEW_URL??'http://127.0.0.1:14736',mode:captureMode,matrix:{themes,widths},selectedScenarios:pagesOnly?selectedPages:workflowsOnly||fullCapture?selectedScenarios:[],missing,success:failures.length===0&&missing.length===0,imageCount:captures.length,...(measure?{firstScreen:{viewport:measureViewport,theme:'light',selector:'[data-tool-row], [data-project-id], [data-profile-id], article, li, [role="row"], [role="listitem"]',counts:firstScreen}}:{}),captures:captures.map(({path,...item})=>item),failures},null,2)+'\n');
}

// Default full capture includes the screens that used to require --sessions, --connections, or --mcp.
// Session detail stays width <= 760, matching the narrow reader.
async function captureSessionReading(page,capture,width){
 await page.getByLabel('会话正文').locator('article').nth(1).scrollIntoViewIfNeeded();
 await capture('session-reading');
 if(width<=760)await page.getByRole('button',{name:'← 返回会话列表'}).click();
 // 时间范围 lives under 更多筛选; open it first, then capture the open 时间范围 menu.
 const filterBar=page.getByRole('group',{name:'会话筛选'});
 const rangeButton=filterBar.getByRole('button',{name:'时间范围',exact:true});
 if(!(await rangeButton.isVisible().catch(()=>false)))await filterBar.locator('summary').filter({hasText:'更多筛选'}).click();
 await rangeButton.click();
 const ranges=page.getByRole('listbox',{name:'时间范围'});
 await ranges.waitFor();
 await capture('session-range-menu');
 await ranges.getByRole('option',{name:'自定义',exact:true}).click();
 const calendar=page.getByRole('dialog',{name:'自定义时间范围'});
 await calendar.getByRole('button',{name:/^\d{4}-\d{2}-\d{2}$/}).nth(4).click();
 await calendar.getByRole('button',{name:/^\d{4}-\d{2}-\d{2}$/}).nth(11).click();
 await capture('session-dates');
}
// Today is hourly, and the fixture has no calls before 09:00, so this region is not rendered.
// 近 7 天 is daily and shows 「消耗最多的会话」. A miss is recorded and does not abort later pages.
async function captureUsageDetails(page,capture,theme,width){
 try{
  await page.getByRole('radio',{name:'近 7 天',exact:true}).click();
  const sessions=page.getByRole('region',{name:'消耗最多的会话'});
  await sessions.waitFor();
  await sessions.scrollIntoViewIfNeeded();
  await capture('usage-details');
  await page.getByRole('radio',{name:'自定义',exact:true}).click();
  await page.getByRole('dialog',{name:'自定义时间范围'}).waitFor();
  await capture('usage-dates');
 }catch(error){
  failures.push({type:'scenario',theme,width,name:'usage-details',message:error.message});
  console.error(error.message);
 }finally{
  const dialog=page.getByRole('dialog',{name:'自定义时间范围'});
  if(await dialog.isVisible().catch(()=>false)){
   await page.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'}).catch(()=>{});
  }
 }
}
async function captureConnectionScreens(page,capture,width){
 const previous=page.viewportSize();
 await page.setViewportSize({width,height:Math.max(1100,previous?.height??1000)});
 const region=page.getByRole('region',{name:'工具'});
 const profiles=region.getByLabel('配置列表');
 for(const name of ['Codex','Claude Code','Grok','Pi','OpenCode']){
  await openCli(page,name);
  await region.getByRole('tab',{name:'配置',exact:true}).click();
  await profiles.waitFor();
  const slug=name.toLowerCase().replace(/\s+/g,'-');
  await capture(`conn-${slug}`);
  const edits=profiles.getByRole('button',{name:'修改',exact:true});
  const count=await edits.count();
  if(!count)continue;
  await edits.nth(Math.min(2,count-1)).click();
  const dialog=page.getByRole('dialog');
  await dialog.waitFor();
  await capture(`conn-${slug}-config`);
  const more=dialog.getByText('更多选项',{exact:true});
  if(await more.count()){
   await more.click();
   const advanced=dialog.getByText('高级连接选项',{exact:true});
   if(await advanced.count())await advanced.click();
   await dialog.locator('summary').filter({hasText:'更多选项'}).scrollIntoViewIfNeeded();
   await capture(`conn-${slug}-more`);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
 }
 if(previous)await page.setViewportSize(previous);
}
async function captureMcpScreens(page,capture){
 const nav=page.getByRole('navigation',{name:'页面'});
 await nav.getByRole('button',{name:'工具'}).click();
 await openCli(page,'Codex');
 await page.getByRole('tab',{name:'MCP',exact:true}).click();
 const tool=page.getByRole('region',{name:'MCP 服务器'});
 const toolRow=tool.getByRole('button',{name:'查看 filesystem',exact:true});
 // The list and its document share one surface: a row opens the entry, no dialog is involved.
 await toolRow.waitFor();
 await capture('mcp-tool');
 await toolRow.click();
 const toolDetails=page.getByRole('article',{name:'filesystem'});
 await toolDetails.getByRole('region',{name:'MCP 详情'}).waitFor();
 await capture('mcp-tool-details');
 await toolDetails.getByRole('button',{name:'编辑',exact:true}).click();
 const toolName=toolDetails.getByRole('textbox',{name:'名称'});
 await toolName.waitFor();
 await toolName.fill('filesystem-local');
 await toolDetails.getByText('有未保存的更改',{exact:true}).waitFor();
 await capture('mcp-tool-edit');
 // Reading shows the unsaved draft, so an edit is reviewable before it is written.
 await toolDetails.getByRole('button',{name:'阅读',exact:true}).click();
 const toolDraftRegion=toolDetails.getByRole('region',{name:'MCP 详情'});
 await toolDraftRegion.getByText('filesystem-local',{exact:true}).waitFor();
 await capture('mcp-tool-draft');
 await toolDetails.getByRole('button',{name:'编辑',exact:true}).click();
 // The same target conflict the library reports, confirmed on the document itself.
 await page.evaluate(()=>window.__captureMcpConflict=true);
 await toolDetails.getByRole('button',{name:'保存',exact:true}).click();
 const toolPreview=toolDetails.getByRole('group',{name:'MCP 写入预览'});
 await toolPreview.waitFor();
 await toolDetails.locator('[data-conflict="true"]').waitFor();
 // Both diff editors load lazily; capture them once they render instead of their preparing state.
 await toolDetails.locator('[role="status"][aria-label="当前 MCP"]').waitFor({state:'detached'});
 await toolDetails.locator('[role="status"][aria-label="本次 MCP 修改"]').waitFor({state:'detached'});
 await capture('mcp-tool-conflict');
 await toolDetails.getByRole('button',{name:'返回',exact:true}).click();
 await toolPreview.waitFor({state:'hidden'});
 await page.evaluate(()=>window.__captureMcpConflict=false);
 await page.getByRole('button',{name:'关闭详情'}).click();
 const discard=page.getByRole('dialog',{name:'放弃未保存修改？'});
 await discard.waitFor();
 await discard.getByRole('button',{name:'放弃修改',exact:true}).click();
 await toolDetails.waitFor({state:'hidden'});
 await tool.getByRole('button',{name:'添加 MCP',exact:true}).first().click();
 const toolNew=page.getByRole('article',{name:'添加 MCP'});
 await toolNew.waitFor();
 await capture('mcp-tool-new');
 await page.getByRole('button',{name:'关闭详情'}).click();
 await toolNew.waitFor({state:'hidden'});
 await nav.getByRole('button',{name:'资料库'}).click();
 await page.getByRole('tab',{name:/^MCP/}).click();
 const list=page.getByLabel('MCP 列表');
 await list.getByText('filesystem',{exact:true}).first().waitFor();
 await capture('mcp-library');
 await list.getByRole('button',{name:'修改',exact:true}).first().click();
 let dialog=page.getByRole('dialog',{name:'修改 MCP'});await dialog.waitFor();await capture('mcp-library-edit');
 await dialog.evaluate(el=>{const body=el.querySelector('.guide-dialog-body')??el;body.scrollTop=body.scrollHeight;});await capture('mcp-library-edit-targets');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 const closeLibraryDetails=page.getByRole('button',{name:'关闭 MCP 详情',exact:true});if(await closeLibraryDetails.isVisible())await closeLibraryDetails.click();
 await page.getByRole('button',{name:'新建 MCP',exact:true}).first().click();
 dialog=page.getByRole('dialog',{name:'新建 MCP'});await dialog.waitFor();await capture('mcp-library-new');
 await dialog.getByRole('button',{name:'粘贴导入'}).click();
 await dialog.getByRole('textbox',{name:'粘贴 MCP JSON'}).fill(JSON.stringify({mcpServers:{good:{command:'npx',args:['-y','good-server']},bad:{command:'uvx',args:['bad-server']}}}));
 await dialog.getByRole('button',{name:'解析并填入'}).click();
 const review=page.getByRole('dialog',{name:'审查 MCP 导入'});await review.waitFor();await capture('mcp-library-batch');
 await review.getByRole('button',{name:'预览选中的 2 项'}).click();
 await review.getByRole('button',{name:'确认导入 2 项'}).waitFor();await capture('mcp-library-batch-preview');
 await page.evaluate(()=>window.__captureMcpBatchFailure='bad');
 await review.getByRole('button',{name:'确认导入 2 项'}).click();
 await review.getByText('该条目校验失败，其他条目继续处理').waitFor();await capture('mcp-library-batch-failure');
 await page.evaluate(()=>window.__captureMcpBatchFailure=null);
 await review.getByRole('button',{name:'返回',exact:true}).click();
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 if(await closeLibraryDetails.isVisible())await closeLibraryDetails.click();
 
 await list.getByRole('button',{name:'修改',exact:true}).first().click();dialog=page.getByRole('dialog',{name:'修改 MCP'});await dialog.waitFor();
 await page.evaluate(()=>window.__captureMcpConflict=true);
 await dialog.locator('[data-dialog-save]').click();await dialog.locator('[data-conflict="true"]').waitFor();await capture('mcp-library-conflict');
 await dialog.getByRole('button',{name:'保留当前文件',exact:true}).click();
 await page.evaluate(()=>window.__captureMcpConflict=false);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 if(await closeLibraryDetails.isVisible())await closeLibraryDetails.click();
 await page.evaluate(()=>window.__captureMcpEmpty=true);
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('还没有 MCP',{exact:true}).waitFor();await capture('mcp-library-empty');
 await page.evaluate(()=>window.__captureMcpEmpty=false);
 await page.getByRole('button',{name:'刷新',exact:true}).click();await list.getByText('filesystem',{exact:true}).first().waitFor();
 if(await closeLibraryDetails.isVisible())await closeLibraryDetails.click();
 await page.evaluate(()=>window.__captureMcpReadFailure=true);
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('最近一次读取失败，已保留上次成功的定义与写入分布。').waitFor();await capture('mcp-library-stale');
 await page.evaluate(()=>window.__captureMcpReadFailure=false);
 await page.getByRole('button',{name:'重试',exact:true}).click();await list.getByText('filesystem',{exact:true}).first().waitFor();
 if(await closeLibraryDetails.isVisible())await closeLibraryDetails.click();
 await page.getByRole('textbox',{name:'搜索资料'}).fill('missing-mcp');await page.getByText('没有匹配「missing-mcp」的 MCP。').waitFor();await capture('mcp-library-no-match');
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();
}

async function capturePluginScreens(page,capture){
 await openCli(page,'Claude Code');
 await page.getByRole('tab',{name:'插件',exact:true}).click();
 const list=page.getByRole('list',{name:'插件',exact:true});
 await list.getByRole('button',{name:/Code Review/}).waitFor();await capture('native-plugins');
 await list.getByRole('button',{name:/Code Review/}).click();
 let details=page.getByRole('article',{name:'插件详情'});await details.waitFor();
 const contents=details.getByRole('list',{name:'插件内容'});await contents.waitFor();await capture('plugin-details');
 await contents.getByRole('button',{name:/reviewer/}).first().click();await page.getByText('检查改动影响').first().waitFor();await capture('plugin-item-preview');
 await page.getByRole('button',{name:'返回插件',exact:true}).click();await contents.waitFor();
 await details.getByRole('button',{name:'关闭插件详情',exact:true}).click();
 await page.evaluate(()=>window.__capturePluginHold=true);
 await list.getByRole('button',{name:/Code Review/}).click();details=page.getByRole('article',{name:'插件详情'});
 await details.getByRole('button',{name:'禁用',exact:true}).click();
 await details.getByRole('button',{name:'关闭插件详情',exact:true}).click();
 const queue=page.locator('[aria-label="插件操作队列"]');await queue.waitFor();
 await page.getByRole('button',{name:'安装新插件',exact:true}).click();
 const install=page.getByRole('dialog',{name:'安装新插件'});await install.waitFor();
 await install.getByLabel('插件来源',{exact:true}).fill('capture-plugin@official');
 await install.getByRole('checkbox',{name:/我信任所选来源/}).check();await capture('plugin-install');
 await install.getByRole('button',{name:'安装插件',exact:true}).click();
 await queue.locator('[data-state="queued"]').waitFor();await capture('plugin-queue');
 await page.evaluate(()=>{window.__capturePluginHold=false;window.__capturePluginFailure=true;window.__releaseCapturePlugin?.();});
 await queue.locator('[data-state="failed"]').first().waitFor();
 await expect(queue.locator('[data-state="running"]')).toHaveCount(0);await capture('plugin-operation-failure');
 await page.evaluate(()=>window.__capturePluginFailure=false);
 await list.getByRole('button',{name:/Code Review/}).click();details=page.getByRole('article',{name:'插件详情'});
 await details.getByRole('button',{name:'更新',exact:true}).click();
 const confirmation=page.getByRole('dialog',{name:'更新原生插件'});await confirmation.waitFor();await capture('plugin-update-confirmation');
 await confirmation.getByRole('button',{name:'取消',exact:true}).click();
 await details.getByRole('button',{name:'关闭插件详情',exact:true}).click();
 await page.getByLabel('搜索插件').fill('missing-plugin');await capture('plugin-search-empty');await page.getByRole('button',{name:'清除筛选'}).click();
 await page.getByLabel('插件状态筛选').selectOption('readonly');await capture('plugin-readonly-filter');await page.getByLabel('插件状态筛选').selectOption('all');
 await page.evaluate(()=>window.__capturePluginsEmpty=true);
 await page.getByRole('button',{name:'重新扫描',exact:true}).first().click();
 await page.getByText('此作用域还没有插件',{exact:true}).waitFor();await capture('plugin-empty');
 await page.evaluate(()=>window.__capturePluginsEmpty=false);
 await page.getByRole('button',{name:'重新扫描',exact:true}).first().click();await list.getByRole('button',{name:/Code Review/}).waitFor();
 await page.evaluate(()=>window.__capturePluginScanFailure=true);
 await page.getByRole('button',{name:'重新扫描',exact:true}).first().click();
 await page.getByText('最近一次扫描失败，已保留上次成功读取的插件。').waitFor();await capture('plugin-scan-failure');
 await page.evaluate(()=>window.__capturePluginScanFailure=false);
 for(const name of ['关闭错误提示','关闭提示']){const dismiss=page.getByRole('button',{name,exact:true});if(await dismiss.count())await dismiss.click();}
}

// --home: project cards for the reported remote grid, their full details, read failures and a card-level
// directory failure. Remote first (the fixture starts with a failing read), then local after a reload.
async function captureHomeScreens(page,capture){
 const projects=page.getByRole('region',{name:'项目与启动'});
 const readState=state=>page.waitForFunction(value=>document.querySelector('[data-remote-read]')?.getAttribute('data-remote-read')===value,state);
 await readState('failed');
 await capture('home-remote-failed');
 await page.evaluate(()=>sessionStorage.setItem('capture-home-remote-fail','0'));
 await projects.locator('[data-remote-read]').getByRole('button',{name:'重新读取远程项目',exact:true}).click();
 await projects.locator('[data-project-id="remote:p7"]').waitFor();
 await projects.locator('[data-remote-read]').waitFor({state:'detached'});
 await capture('home-remote');
 await projects.locator('[data-project-id="remote:p6"]').getByRole('button',{name:'api 的更多操作',exact:true}).click();
 await page.getByRole('menuitem',{name:'项目信息',exact:true}).click();
 await page.getByRole('dialog',{name:'api 的项目信息'}).waitFor();
 await capture('home-remote-info');
 await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 // Re-entering the host re-reads its projects; a failure there keeps the last good list marked stale.
 const switcher=page.locator('.sidebar-host button').first();
 if(await switcher.isVisible()){
  await page.evaluate(()=>sessionStorage.setItem('capture-home-remote-fail','1'));
  await switcher.click();await page.getByRole('menuitemradio',{name:/^本机/}).click();
  await switcher.click();await page.getByRole('menuitemradio',{name:/产品开发主机/}).click();
  await readState('stale');
  await capture('home-remote-stale');
  await page.evaluate(()=>sessionStorage.setItem('capture-home-remote-fail','0'));
 }
 await page.evaluate(()=>localStorage.setItem('cliora:remote-target','local'));
 await page.reload();await page.getByText('正在读取本机设置').waitFor({state:'hidden'});
 await projects.locator('[data-project-id="api-b"]').waitFor();
 await capture('home-local');
 await page.evaluate(()=>sessionStorage.setItem('capture-home-open-fail','1'));
 const card=projects.locator('[data-project-id="cliora"]');
 await card.getByRole('button',{name:/的更多操作$/}).click();
 await page.getByRole('menuitem',{name:/^打开.*的目录$/}).click();
 await card.getByRole('alert').waitFor();
 await capture('home-local-open-failed');
 // Session-only launch selectors (antigravity 1.5) sit beside the project
 // model field and are never persisted as configuration.
 const agy=projects.locator('[data-project-id="agy"]');
 await agy.getByRole('button',{name:/的更多操作$/}).click();
 await page.getByRole('menuitem',{name:'修改',exact:true}).click();
 const edit=page.getByRole('dialog');
 await edit.getByLabel('agy 项目 · 执行模式',{exact:true}).waitFor();
 await edit.getByLabel('agy 项目 · 执行模式',{exact:true}).selectOption('plan');
 await edit.getByLabel('agy 项目 · 推理强度',{exact:true}).selectOption('high');
 await edit.getByLabel('agy 项目 项目模型',{exact:true}).waitFor();
 await capture('home-launch-options');
}

if(!workflowsOnly){
for(const width of widths)for(const theme of themes){
 const page=await browser.newPage({viewport:{width,height:1000},locale:process.env.CLIORA_CAPTURE_LOCALE??'zh-CN'});page.on('pageerror',e=>failures.push({type:'pageerror',theme,width,message:e.message}));await page.addInitScript(mock,homeCapture?{theme,home:true}:process.argv.includes('--write-recovery')?{theme,remoteHosts:true,writeRecovery:true}:process.argv.includes('--remote-hosts')?{theme,remoteHosts:true}:process.argv.includes('--rules')?{theme,rules:true}:theme);await installCaptureConfigurationProtocol(page);await page.addInitScript(installPromptFixtureBridge);if(process.argv.includes('--projects')||process.argv.includes('--prompts'))await page.addInitScript(installWorkspaceFixtures);if(process.argv.includes('--prompts'))await page.addInitScript(installRichPromptFixtures);
 const nav=page.getByRole('navigation',{name:'页面'});
 let lastCapture='(before home)';
 async function capture(name){await captureImage(page,name,theme,width);lastCapture=name;}
 // A failed step is recorded with the last completed capture and the remaining widths/themes still run.
 // Navigation is inside the try so a boot timeout under load is recorded instead of crashing the run.
 try{
 await page.goto(process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736');await page.getByText('正在读取本机设置').waitFor({state:'hidden'});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 if(process.argv.includes('--prompts')){
  await nav.getByRole('button',{name:'资料库',exact:true}).click();
  const panel=page.locator('[data-prompt-library]');
  await panel.locator('[data-library-id]').first().waitFor();await capture('prompts-library-many');
  const search=panel.getByRole('textbox',{name:'搜索资料'});
  await search.fill('全文后段命中-119');await panel.getByRole('button',{name:'模板 119',exact:true}).waitFor();await capture('prompts-fulltext-search');
  await search.fill('');await panel.getByRole('button',{name:'项目筛选',exact:true}).click();
  await page.getByRole('option',{name:/^电商平台/}).click();await panel.getByRole('button',{name:'项目 A 发布',exact:true}).waitFor();await capture('prompts-project-scope');
  await panel.getByRole('button',{name:'项目 A 发布',exact:true}).click();
  await page.getByRole('dialog',{name:'编辑提示词'}).getByRole('textbox',{name:'资料正文',exact:true}).waitFor();await capture('prompts-edit');
  await page.getByRole('dialog',{name:'编辑提示词'}).getByRole('button',{name:'关闭',exact:true}).click();
  await panel.getByRole('button',{name:'批量导入',exact:true}).click();
  const input=page.getByRole('dialog',{name:'导入提示词'});await input.getByLabel('JSON 内容').fill(JSON.stringify([{title:'通用审查',body:'先检查边界，再检查错误恢复。'},{title:'通用审查',body:'确认变更范围。\n检查回滚步骤。',tags:['release']}],null,2));
  await input.getByRole('button',{name:'预览导入'}).click();const imported=page.getByRole('dialog',{name:'确认导入内容'});await imported.getByText('发现同名或相同正文',{exact:false}).first().waitFor();await imported.getByText('本批次同名或相同正文',{exact:false}).first().waitFor();await capture('prompts-import-preview');
  await imported.getByRole('button',{name:'关闭',exact:true}).click();
  await nav.getByRole('button',{name:'工作台',exact:true}).click();await page.getByRole('button',{name:'新建会话',exact:true}).first().click();
  const session=page.getByRole('dialog',{name:'新建工作台会话'});await session.getByLabel('初始提示词（可选）').fill('已有初始草稿');
  await session.getByRole('button',{name:'查找提示词',exact:true}).click();const picker=page.getByRole('dialog',{name:'查找提示词'});await picker.getByRole('textbox',{name:'搜索提示词标题或完整正文'}).fill('全文后段命中-119');
  await picker.getByRole('button',{name:'模板 119',exact:true}).click();await picker.locator('pre').waitFor();await capture('prompts-workbench-picker');
  await picker.getByRole('button',{name:'插入草稿',exact:true}).click();await session.getByLabel('初始提示词（可选）').waitFor();await capture('prompts-inserted-draft');
  await page.close();continue;
 }
 if(process.argv.includes('--projects')){
  const project=page.locator('[data-business-workspaces]').first();
  await project.locator('[data-repository-id="repo-47"]').waitFor({state:'attached'});
  await capture('projects-many');
  await project.getByRole('button',{name:/^需处理/}).click();await project.locator('[data-repository-id="repo-46"]').waitFor();await capture('projects-attention');
  await project.getByRole('button',{name:/^需处理/}).click();
  await project.getByRole('textbox',{name:'搜索仓库名称或路径'}).fill('team-1/api');
  await project.locator('[data-repository-id]').first().waitFor();await capture('projects-same-name-search');
  await project.getByRole('textbox',{name:'搜索仓库名称或路径'}).fill('');
  await project.getByRole('button',{name:'添加仓库',exact:true}).click();
  await page.getByRole('dialog',{name:'选择要添加的仓库'}).getByText('Permission denied').waitFor();await capture('projects-batch-preview');
  await page.getByRole('dialog',{name:'选择要添加的仓库'}).getByRole('button',{name:'关闭',exact:true}).click();
  await project.getByRole('button',{name:'项目操作',exact:true}).click();await page.getByRole('menuitem',{name:'打开项目清单',exact:true}).click();
  await page.getByRole('dialog',{name:'关联项目清单'}).getByText('shared-api',{exact:true}).waitFor();await capture('projects-manifest-preview');
  await page.getByRole('dialog',{name:'关联项目清单'}).getByRole('button',{name:'关联项目',exact:true}).click();
  await project.getByText('已关联项目清单',{exact:false}).waitFor();await capture('projects-linked');
  await page.close();continue;
 }
 if(homeCapture){await page.setViewportSize({width,height:1400});await captureHomeScreens(page,capture);await page.close();continue;}
 if(process.argv.includes('--write-recovery')){
  await page.getByText('存在未确认的远程写入，请先核查回执，保留草稿并勿直接重试。',{exact:true}).waitFor();
  await capture('write-unknown');
  await nav.getByRole('button',{name:'工作台',exact:true}).click();
  await page.getByRole('region',{name:'当前会话'}).getByRole('button',{name:'写入恢复',exact:true}).waitFor();
  await capture('write-no-session-fault');
  await nav.getByRole('button',{name:'首页',exact:true}).click();
  await page.getByRole('button',{name:'写入恢复',exact:true}).click();
  const recovery=page.getByRole('dialog',{name:'远程写入与恢复',exact:true});
  await recovery.getByRole('button',{name:'核查实际结果',exact:true}).click();
  await recovery.getByText('实际为提交后版本',{exact:false}).waitFor();
  await capture('write-inspected-partial');
  await page.evaluate(()=>{const r=structuredClone(window.__writeFixture);r.items[0].state='rollback_failed';r.items[1].state='conflict';r.items[1].observed='conflict';window.dispatchEvent(new CustomEvent('cliora:remote-write',{detail:{targetId:'capture-host',error:{message:'合成恢复失败，备份已保留；外部修改未覆盖。',remote:{receipt:r}}}}));});
  await recovery.getByText('恢复失败，备份保留',{exact:false}).waitFor();
  await capture('write-rollback-failure-conflict');
  await page.evaluate(()=>{const r=window.__writeFixture;r.outcome='recovering';r.items[0].state='rolled_back';r.items[0].observed='before';r.items[1].state='committed';r.items[1].observed='after';});
  await recovery.getByRole('button',{name:'刷新回执',exact:true}).click();
  await recovery.getByText('恢复中或结果未知',{exact:true}).waitFor();
  await capture('write-interrupted-restore');
  await page.evaluate(()=>{const r=window.__writeFixture;r.outcome='committed';for(const item of r.items){item.state='committed';item.observed='conflict';}});
  await recovery.getByRole('button',{name:'刷新回执',exact:true}).click();
  await recovery.getByText('当前文件已被后续修改。此回执的完成状态保留，历史备份不能覆盖这些修改。',{exact:true}).waitFor();
  await expect(recovery.getByRole('button',{name:'恢复写入前备份',exact:true})).toBeDisabled();
  await capture('write-historical-drift');
  await recovery.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(page.getByRole('button',{name:'写入恢复',exact:true})).toHaveCount(0);
  await capture('write-resolved-no-entry');
  await page.close();continue;
 }
 if(process.argv.includes('--remote-hosts')){
  await nav.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('tab',{name:'远程主机',exact:true}).click();
  await page.getByRole('button',{name:'编辑 开发环境 · 远程 SSH',exact:true}).click();
  const form=page.getByRole('form',{name:'编辑主机',exact:true});
  await capture('t5-host-editor');
  await page.evaluate(()=>{window.__hostCapture.hold=true;});
  await form.getByRole('button',{name:'测试连接',exact:true}).click();
  await form.getByRole('button',{name:'取消测试',exact:true}).waitFor();
  await capture('t5-host-testing');
  await form.getByRole('button',{name:'取消测试',exact:true}).click();
  await page.evaluate(()=>{window.__hostCapture.hold=false;window.__hostCapture.failure=true;});
  await form.getByRole('button',{name:'测试连接',exact:true}).click();
  await form.getByRole('status').filter({hasText:'Permission denied'}).waitFor();
  await capture('t5-host-authentication-failure');
  await form.getByRole('textbox',{name:'主机地址',exact:true}).fill('bad/path');
  await form.getByRole('button',{name:'保存',exact:true}).click();
  await form.getByText('请填写主机地址（不含空格和斜杠）',{exact:true}).waitFor();
  await capture('t5-host-validation');
  await page.close();continue;
 }
 if(process.argv.includes('--records') || process.argv.includes('--sessions')){
  await nav.getByRole('button',{name:'记录'}).click();
  await page.getByLabel('会话列表').getByRole('button').first().waitFor();if(width>760)await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('sessions');
  if(width<=760){await page.getByLabel('会话列表').getByRole('button').first().click();await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('session-detail');}
  if(process.argv.includes('--sessions')){await captureSessionReading(page,capture,width);await page.close();continue;}
  await page.getByRole('tab',{name:'用量',exact:true}).click();await page.getByRole('radio',{name:'近 7 天',exact:true}).click();
  await page.getByRole('region',{name:'用量概览'}).waitFor();await capture('usage');
  await captureUsageDetails(page,capture,theme,width);
  await page.close();continue;
 }
 if(process.argv.includes('--connections')){
  await nav.getByRole('button',{name:'工具'}).click();
  await captureConnectionScreens(page,capture,width);
  await page.close(); continue;
 }
 if(process.argv.includes('--rules')){
  await nav.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByRole('tab',{name:/^长期规则/}).click();
  const ruleRow=page.getByRole('article').filter({has:page.getByRole('button',{name:'项目协作约定',exact:true})});
  await ruleRow.getByRole('button',{name:'Codex · 写入状态尚未确定',exact:true}).waitFor();
  await capture('rules-bindings-loading');
  await page.getByRole('button',{name:'项目协作约定',exact:true}).click();
  const dialog=page.getByRole('dialog');const editor=dialog.getByRole('textbox',{name:'资料正文',exact:true});
  await editor.fill('保留规则编辑草稿，确认绑定后再分发。');
  await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();await capture('rules-bindings-editor-loading');
  await page.evaluate(()=>{window.__captureBindings.fail=true;window.__releaseBindings();});
  await dialog.getByText('无法读取规则写入状态。重试成功后可保存和分发规则。',{exact:true}).waitFor();
  await capture('rules-bindings-editor-failed');
  await page.evaluate(()=>window.__captureBindings.fail=false);await dialog.getByRole('button',{name:'重试写入状态',exact:true}).click();
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await page.evaluate(()=>window.__captureBindings.fail=true);await dialog.locator('[data-dialog-save]').click();
  await dialog.getByText('规则写入状态刷新失败，当前显示上次成功读取的结果。重试成功后可保存和分发规则。',{exact:true}).waitFor();
  await expect(editor).toHaveText('保留规则编辑草稿，确认绑定后再分发。');
  expect(await page.evaluate(()=>window.__captureBindings.saves)).toBe(0);await capture('rules-bindings-editor-stale');
  await page.evaluate(()=>window.__captureBindings.fail=false);await dialog.getByRole('button',{name:'重试写入状态',exact:true}).click();
  await expect(dialog.locator('[data-dialog-save]')).toBeEnabled();
  await page.evaluate(()=>window.__captureBindings.hold=true);await dialog.locator('[data-dialog-save]').click();
  await expect(editor).toHaveAttribute('aria-readonly','true');
  await expect(dialog.getByLabel('标题',{exact:true})).toBeDisabled();await expect(dialog.getByRole('button',{name:'关联项目',exact:true})).toBeDisabled();
  await expect(dialog.getByLabel('添加标签')).toBeDisabled();await expect(dialog.getByRole('button',{name:'项目规则 ×',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'关闭',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
  await dialog.getByText('正在处理，请稍候…',{exact:true}).waitFor();await capture('rules-bindings-editor-saving');
  expect(await page.evaluate(()=>window.__captureBindings.saves)).toBe(0);
  await page.evaluate(()=>window.__releaseBindings());await dialog.waitFor({state:'hidden'});
  await expect(ruleRow.getByRole('button',{name:'Codex · 已生效',exact:true})).toBeEnabled();
  const dismiss=page.getByRole('button',{name:'关闭提示',exact:true});if(await dismiss.isVisible()){await dismiss.click();await dismiss.waitFor({state:'hidden'});}
  await capture('rules-bindings-ready');
  await page.evaluate(()=>{window.__captureBindings.fail=true;window.__expireBindings();});
  await nav.getByRole('button',{name:'首页',exact:true}).click();await nav.getByRole('button',{name:'资料库',exact:true}).click();
  await page.getByText('规则写入状态刷新失败，当前显示上次成功读取的结果。重试成功后可保存和分发规则。',{exact:true}).waitFor();
  await expect(ruleRow.getByRole('button',{name:'Codex · 已生效',exact:true})).toBeDisabled();await capture('rules-bindings-stale');
  await page.evaluate(()=>window.__captureBindings.fail=false);await page.getByRole('button',{name:'重试写入状态',exact:true}).click();
  await expect(ruleRow.getByRole('button',{name:'Codex · 已生效',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>({saves:window.__captureBindings.saves,syncs:window.__captureBindings.syncs}))).toEqual({saves:1,syncs:1});
  await page.close();continue;
 }
 if(process.argv.includes('--mcp')){
  await page.setViewportSize({width,height:Math.max(1000,page.viewportSize()?.height??1000)});
  await captureMcpScreens(page,capture);
  await page.close(); continue;
 }
 if(process.argv.includes('--skills')){
  await page.setViewportSize({width,height:Math.max(1100,page.viewportSize()?.height??1000)});
  await nav.getByRole('button',{name:'工具'}).click();
  await page.getByRole('region',{name:'工具'}).getByLabel('配置列表').waitFor();
  await captureSkillViews(page,capture);
  await page.close(); continue;
 }
 if(pagesOnly){
  for(const name of selectedPages){
   if(await page.getByRole('dialog',{name:'设置',exact:true}).count())await page.keyboard.press('Escape');
   if(name==='home')await nav.getByRole('button',{name:'首页',exact:true}).click();
   if(name==='tools'){await nav.getByRole('button',{name:'工具',exact:true}).click();await page.getByRole('region',{name:'工具'}).getByLabel('配置列表').waitFor();}
   if(name==='library'){await nav.getByRole('button',{name:'资料库',exact:true}).click();await page.getByRole('button',{name:'代码审查',exact:true}).waitFor();}
   if(name==='sessions'||name==='usage'){await nav.getByRole('button',{name:'记录',exact:true}).click();await page.getByLabel('会话列表').getByRole('button').first().waitFor();if(name==='usage')await page.getByRole('tab',{name:'用量',exact:true}).click();}
   if(name==='settings'||name==='migration'){await nav.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'同步与备份'}).waitFor();await page.locator('.skeleton-page').first().waitFor({state:'detached'});if(name==='migration'){await page.getByRole('tab',{name:'同步与备份'}).click();await page.getByRole('button',{name:'导出加密配置包',exact:true}).waitFor();}}
   await capture(name);
  }
  await page.close();continue;
 }
 await capture('home');
 if(quickCapture){
  // --quick: one screen per page, for fast visual iteration.
  await nav.getByRole('button',{name:'工具'}).click();await page.getByRole('region',{name:'工具'}).getByLabel('配置列表').waitFor();await capture('tools');
  await nav.getByRole('button',{name:'资料库'}).click();await page.getByRole('button',{name:'代码审查',exact:true}).waitFor();await capture('library');
  await nav.getByRole('button',{name:'记录'}).click();await page.getByLabel('会话列表').getByRole('button').first().waitFor();await capture('sessions');
  await page.getByRole('tab',{name:'用量',exact:true}).click();await capture('usage');
  await nav.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'同步与备份'}).waitFor();await page.locator('.skeleton-page').first().waitFor({state:'detached'});await capture('settings');
  if(!process.argv.includes('--skip-migration')){await page.getByRole('tab',{name:'同步与备份'}).click();await page.getByRole('button',{name:'导出加密配置包',exact:true}).waitFor();await capture('migration');}
  await page.close();continue;
 }
 await nav.getByRole('button',{name:'工具'}).click();const profiles=page.getByRole('region',{name:'工具'}).getByLabel('配置列表');await profiles.waitFor();await capture('tools');
 await profiles.getByRole('button',{name:'修改'}).first().click();await page.getByRole('dialog').waitFor();await capture('native-config');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await profiles.getByRole('button',{name:'修改'}).nth(1).click();await page.getByRole('dialog').waitFor();await capture('config-form');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 const officialRow=profiles.locator('[data-profile-id="codex-work"]');await officialRow.getByText('25% 已用',{exact:true}).first().waitFor();await officialRow.scrollIntoViewIfNeeded();await capture('quota-results');
 await officialRow.locator('summary').filter({hasText:/^额度详情/}).first().click();await officialRow.getByText('最近成功：',{exact:false}).first().waitFor();await capture('quota-details');await officialRow.locator('summary').filter({hasText:/^额度详情/}).first().click();
 await officialRow.getByRole('button',{name:'额度设置'}).first().click();await page.getByRole('dialog').waitFor();await capture('quota-linked-settings');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await officialRow.getByRole('button',{name:'额度设置'}).nth(1).click();await page.getByRole('textbox',{name:'额度查询脚本'}).waitFor();await page.getByRole('textbox',{name:'额度查询脚本'}).scrollIntoViewIfNeeded();await capture('quota-script-editor');await page.getByRole('button',{name:'测试当前草稿'}).click();await page.getByLabel('草稿测试结果').waitFor();await page.getByLabel('草稿测试结果').scrollIntoViewIfNeeded();await capture('quota-script-preview');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:'账号',exact:true}).click();await page.getByText('开发账号',{exact:true}).waitFor();await page.getByText('CLI 已登录',{exact:true}).waitFor();await capture('oauth-accounts');await page.getByRole('button',{name:'添加账号',exact:true}).click();await capture('oauth-add-account');
 const accountRow=page.getByRole('listitem').filter({has:page.getByText('开发账号',{exact:true})}).first();
 await accountRow.getByText('管理与关联',{exact:true}).click();await accountRow.getByRole('button',{name:'删除账号',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('account-delete-confirmation');await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 await page.evaluate(()=>window.__captureNativeOnly=true);await openCli(page,'OpenCode');await page.getByRole('tab',{name:'账号',exact:true}).click();await page.getByText(/还没有独立账号/).waitFor();await page.getByText('CLI 已登录',{exact:true}).first().waitFor();await capture('native-cli-login');
 await page.evaluate(()=>{window.__captureNativeOnly=false;window.__captureLoginPending=true;});await page.getByRole('button',{name:'打开授权页面',exact:true}).waitFor();await capture('oauth-browser-retry');await page.evaluate(()=>window.__captureLoginPending=false);
 await capturePluginScreens(page,capture);
 await page.getByRole('tab',{name:'Agents',exact:true}).click();await page.getByText('reviewer',{exact:true}).waitFor();await capture('native-agents');await page.getByRole('listitem').filter({has:page.getByText('reviewer',{exact:true})}).getByRole('button').click();await page.getByRole('region',{name:'Agent 定义预览'}).waitFor();await capture('agent-reading');await page.getByRole('article',{name:'reviewer'}).getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('textbox',{name:'原生 Agent 定义',exact:true}).waitFor();await capture('agent-editor');await page.getByRole('button',{name:'完成',exact:true}).click();
 const agentSearch=page.getByLabel('搜索 Agent 定义');if(!await agentSearch.isVisible())await page.getByRole('button',{name:'返回列表',exact:true}).click();
 await agentSearch.fill('missing-agent');await capture('agent-search-empty');await page.getByRole('button',{name:'清除筛选'}).click();await page.getByLabel('Agent 状态筛选').selectOption('readonly');await capture('agent-readonly-filter');await page.getByLabel('Agent 状态筛选').selectOption('all');
 await openCli(page,'Grok');await page.getByRole('tab',{name:'配置',exact:true}).waitFor();if(await page.getByRole('tab',{name:'账号',exact:true}).count())throw new Error('Unsupported Grok accounts tab is visible');await capture('grok-capabilities');
 await openCli(page,'Pi');await page.getByRole('tab',{name:'配置',exact:true}).waitFor();if(await page.getByRole('tab',{name:'Agents',exact:true}).count())throw new Error('Unsupported Pi agents tab is visible');await capture('pi-capabilities');
 await openCli(page,'Codex');
 await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByRole('button',{name:/filesystem/}).first().waitFor();await capture('mcp');
 await captureSkillViews(page,capture);
 await captureConnectionScreens(page,capture,width);
 await nav.getByRole('button',{name:'资料库'}).click();await page.getByRole('button',{name:'代码审查',exact:true}).waitFor();await capture('library');
 await page.getByRole('tab',{name:/^长期规则/}).click();await page.getByRole('button',{name:'项目协作约定',exact:true}).waitFor();await capture('library-rules');
 await page.getByRole('tab',{name:'MCP',exact:true}).click();await page.getByLabel('MCP 列表').getByText('filesystem',{exact:true}).first().waitFor();await capture('library-mcp');
 const closeLibraryOverview=page.getByRole('button',{name:'关闭 MCP 详情',exact:true});if(await closeLibraryOverview.isVisible())await closeLibraryOverview.click();
 await page.getByRole('button',{name:'新建 MCP',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('library-mcp-editor');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.getByRole('tab',{name:'Skill',exact:true}).click();await page.getByLabel('Skill 列表').getByRole('button',{name:'code-review',exact:true}).waitFor();await capture('library-skills');
 await page.getByRole('button',{name:'添加 Skill',exact:true}).click();await page.getByRole('dialog').waitFor();await capture('library-skill-add');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 await captureMcpScreens(page,capture);
 await nav.getByRole('button',{name:'记录'}).click();await page.getByLabel('会话列表').getByRole('button').first().waitFor();if(width>760)await page.getByRole('button',{name:'在外部终端继续'}).waitFor();if(width>760)await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('sessions');
 if(width<=760){await page.getByLabel('会话列表').getByRole('button').first().click();await page.getByRole('button',{name:'在外部终端继续'}).waitFor();await page.getByRole('button',{name:'复制代码',exact:true}).waitFor();await capture('session-detail');}
 await captureSessionReading(page,capture,width);
 await page.keyboard.press('Escape');
 await page.getByRole('dialog',{name:'自定义时间范围'}).waitFor({state:'hidden'});
 await page.getByRole('tab',{name:'用量',exact:true}).click();await capture('usage');
 await captureUsageDetails(page,capture,theme,width);
 await nav.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.skeleton-page').first().waitFor({state:'detached'}).catch(()=>{});await capture('settings');
 await page.getByRole('tab',{name:'同步与备份'}).click();await capture('migration');
 await page.getByRole('button',{name:'导出加密配置包',exact:true}).click();await page.getByRole('region',{name:'导出加密配置包'}).waitFor();await capture('migration-export');await page.keyboard.press('Escape');await page.getByRole('region',{name:'导出加密配置包'}).waitFor({state:'hidden'});
 await page.getByRole('button',{name:'从配置包恢复',exact:true}).click();const importView=page.getByRole('region',{name:'从配置包恢复'});await importView.waitFor();await importView.getByRole('button',{name:/选择配置包文件/}).click();await importView.getByRole('button',{name:/backup\.cliora/}).waitFor();await importView.getByPlaceholder('输入导出时的口令').fill('correct-password');await capture('migration-import');await page.keyboard.press('Escape');await importView.waitFor({state:'hidden'});
 await page.close();
 }catch(error){
  failures.push({type:'scenario',theme,width,after:lastCapture,message:error.message.split('\n')[0]});
  console.error(`${theme}/${width} after ${lastCapture}: ${error.message.split('\n')[0]}`);
  await page.close().catch(()=>{});
 }
}
}
if(workflowsOnly||fullCapture){
 await captureConfiguration({browser,themes,widths,selected:selectedScenarios,url:process.env.CLIORA_PREVIEW_URL??'http://127.0.0.1:14736',capture:captureImage,failures});
 if(selectedScenarios.some(name=>historyScenarioNames.includes(name)))await captureHistoryFeatures();
 if(selectedScenarios.some(name=>qoderHistoryScenarioNames.includes(name)))await captureQoderHistoryFeatures();
}
await browser.close();writeGallery();console.log(JSON.stringify({imageCount:captures.length,failures,acceptance},null,2));if(failures.length)process.exitCode=1;

if(!failures.length)prunePrevious(captures.map(item=>item.file));
