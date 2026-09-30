import {createRequire} from 'node:module';
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {performance} from 'node:perf_hooks';
const require=createRequire('file:///C:/Users/12976/project/cliora/package.json');const {chromium}=require('@playwright/test'),runFile=promisify(execFile);
const root='C:/Users/12976/AppData/Local/Temp/cliora-native-verification';const pi=JSON.parse((await fs.readFile(path.join(root,'final-isolated-process.json'),'utf8')).replace(/^\uFEFF/,''));
assert.match(pi.identifier,/^dev\.cliora\.verification\.a6final\d*$/);assert(![38172,63232].includes(pi.pid));
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+pi.port);const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://tauri.localhost'));assert(page);page.setDefaultTimeout(30000);
const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});const nav=name=>page.getByRole('button',{name,exact:true});
const evidence={kind:'native-records-and-window-layout-verification',candidateSha256:pi.sha256,identifier:pi.identifier,recordedAt:new Date().toISOString(),checks:[],limits:['Real native window resized through Win32 at 1160/900/720 logical pixels.','History reads actual user files; evidence stores counts/timings only, not conversation content.','Full private history screenshots are omitted.']};
try{
 if(!process.argv.includes('--layout-only')){
 const start=performance.now();await nav('使用记录').click();await page.getByRole('tab',{name:'会话',exact:true}).waitFor();await page.getByLabel('筛选工具',{exact:true}).selectOption('codex');
 const foregroundReadyMs=performance.now()-start;assert(foregroundReadyMs<10000,'History controls available without full scan blocking');
 let completed=false;let lastProgress;let stopMs=null;let stopRequested=false;const scanStart=performance.now();
 for(let i=0;i<300;i++){lastProgress=await invoke('get_history_scan_progress');if(!lastProgress.running){completed=true;break;}await page.waitForTimeout(100);}
 if(!completed){const stopping=performance.now();stopRequested=true;await page.getByRole('button',{name:'停止扫描',exact:true}).click();for(let i=0;i<100;i++){lastProgress=await invoke('get_history_scan_progress');if(!lastProgress.running){completed=true;break;}await page.waitForTimeout(100);}stopMs=performance.now()-stopping;}
 evidence.scanObservation={completed,stopRequested,stopMs:stopMs===null?null:+stopMs.toFixed(1),lastProgress};
 assert(completed,'History refresh completed or stopped instead of permanent loader');
 let t=performance.now();const sessions=await invoke('list_history_sessions',{filter:{toolId:'codex',favoriteOnly:false}});const listMs=performance.now()-t;t=performance.now();const usage=await invoke('get_history_usage',{filter:{toolId:'codex',favoriteOnly:false}});const usageMs=performance.now()-t;
 assert(sessions.length>0,'Actual cached Codex records');assert(usage.byModel.length>0,'Actual model-specific totals');assert(listMs<5000&&usageMs<5000,'Cached history calls stay responsive');
 await page.getByRole('tab',{name:'用量',exact:true}).click();const table=page.getByRole('table',{name:'按模型用量明细',exact:true});await table.waitFor();assert(await table.locator('tbody tr').count()>0);
 await page.locator('summary').filter({hasText:/^更多筛选/}).click();const model=usage.byModel.find(row=>row.model)?.model;assert(model);await page.getByLabel('筛选模型',{exact:true}).selectOption(model);await page.waitForTimeout(400);
 assert((await invoke('get_history_usage',{filter:{toolId:'codex',model,favoriteOnly:false}})).byModel.every(row=>row.model===model));
 await nav('工具与连接').click();await nav('使用记录').click();assert.equal(await page.getByLabel('筛选工具',{exact:true}).inputValue(),'codex');assert.equal(await page.getByLabel('筛选模型',{exact:true}).inputValue(),model);
 evidence.checks.push({name:'history-cached-first-background-progress-model-totals',result:'passed',foregroundReadyMs:+foregroundReadyMs.toFixed(1),scanWaitMs:+(performance.now()-scanStart).toFixed(1),cachedSessions:sessions.length,modelGroups:usage.byModel.length,listMs:+listMs.toFixed(1),usageMs:+usageMs.toFixed(1),selectionPreserved:true,scanCompletedOrStopped:true,stopRequested,stopMs:stopMs===null?null:+stopMs.toFixed(1)});
 await page.getByRole('button',{name:'清除更多筛选',exact:true}).click();
 await page.getByRole('button',{name:'刷新本机记录',exact:true}).click();
 await page.getByRole('button',{name:'停止扫描',exact:true}).waitFor();
 let runningProgress;
 for(let i=0;i<30;i++){runningProgress=await invoke('get_history_scan_progress');if(runningProgress.running)break;await page.waitForTimeout(20);}
 assert(runningProgress.running,'Explicit refresh is running before native stop check');
 const nativeStopStart=performance.now();await page.getByRole('button',{name:'停止扫描',exact:true}).click();let nativeStopped=false;
 for(let i=0;i<100;i++){const progress=await invoke('get_history_scan_progress');if(!progress.running){nativeStopped=true;break;}await page.waitForTimeout(50);}
 const nativeStopMs=performance.now()-nativeStopStart;
 assert(nativeStopped&&nativeStopMs<5000,'Native scan cancellation responds within five seconds');
 const afterStop=await invoke('list_history_sessions',{filter:{toolId:'codex',favoriteOnly:false}});const ids=new Set(afterStop.map(session=>session.id));assert(sessions.every(session=>ids.has(session.id)),'Cancelled scan preserves cached sessions');
 evidence.checks.push({name:'native-scan-cancel-keeps-cache',result:'passed',nativeStopMs:+nativeStopMs.toFixed(1),phaseAtRequest:runningProgress.toolId,cachedSessionsRetained:true});
 } else evidence.limits.push('Layout-only observation; scan and cached history timing not checked in this run.');
 for(const [width,height] of [[1160,780],[900,650],[720,560]]){
  const scale=await page.evaluate(()=>devicePixelRatio);await runFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'resize-final-window.ps1'),'-WindowProcessId',String(pi.pid),'-LogicalWidth',String(width),'-LogicalHeight',String(height),'-Scale',String(scale)],{windowsHide:true});await page.waitForFunction(width=>Math.abs(innerWidth-width)<=2,width);
  for(const theme of ['light','dark']){
   await nav('设置').click();await page.getByLabel('主题',{exact:true}).selectOption(theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
   for(const name of ['快速开始','工具与连接','资料库','使用记录','设置']){
    await nav(name).click();await page.waitForTimeout(80);
    const geometry=await page.evaluate(()=>{const d=document.scrollingElement,s=document.querySelector('.shell'),m=document.querySelector('main'),r=s.getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},document:{width:d.clientWidth,height:d.clientHeight,scrollWidth:d.scrollWidth,scrollHeight:d.scrollHeight},shell:{x:r.x,y:r.y,width:r.width,height:r.height},main:{overflowY:getComputedStyle(m).overflowY,clientHeight:m.clientHeight,scrollHeight:m.scrollHeight}}});
    assert(geometry.document.scrollWidth<=geometry.document.width+1,name+' outer horizontal overflow');assert(geometry.document.scrollHeight<=geometry.document.height+1,name+' second vertical scrollbar');assert(Math.abs(geometry.shell.height-geometry.viewport.height)<=1,name+' fills height');
    evidence.checks.push({name:'single-native-page-scroll-owner',page:name,theme,width,height,result:'passed',geometry});
    if(width===1160&&name!=='使用记录'){await page.screenshot({path:path.join(root,'final-'+name+'-'+theme+'.png')});}
   }
  }
 }
 await nav('设置').click();await page.getByLabel('主题',{exact:true}).selectOption('light');evidence.result='passed';
}catch(error){evidence.result='failed';evidence.error=String(error);throw error;}
finally{await fs.writeFile(path.join(root,'native-final-records-layout-after.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({result:evidence.result,checks:evidence.checks.length,error:evidence.error}));await browser.close();}
