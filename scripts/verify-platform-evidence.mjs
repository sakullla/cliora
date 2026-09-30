/** Read-only acceptance gate. Mock UI, version discovery and cross-compiles are not native evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const matrixPath=path.resolve(root,process.argv[2]??'docs/verification/platform-evidence.json');
const platforms=['windows','macos','linux'];
const tools=['codex','claude_code','grok','pi','open_code'];
const cases=['native_config','launch_resume','tray','resources_rules','history_usage','migration_sync'];
const errors=[];const pending=[];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function artifact(ref,label){
 if(!ref||typeof ref.path!=='string'||!/^docs\/verification\//.test(ref.path)||! /^[a-f0-9]{64}$/.test(ref.sha256??''))throw new Error(`${label}: missing repository-relative evidence path or SHA-256`);
 const target=path.resolve(root,ref.path);if(!target.startsWith(path.resolve(root,'docs/verification')+path.sep))throw new Error(`${label}: evidence escapes directory`);
 const bytes=fs.readFileSync(target);if(!bytes.length||sha(bytes)!==ref.sha256)throw new Error(`${label}: empty, missing or changed evidence file`);
 return {target,bytes};
}
function observation(ref,row,name){
 const {bytes}=artifact(ref,`${row.platform}/${row.tool}/${name}`);
 const report=JSON.parse(bytes);
 for(const field of ['platform','tool','system','architecture','cliVersion'])if(report[field]!==row[field])throw new Error(`${name}: evidence ${field} differs from matrix`);
 if(report.kind!=='native-platform-observation'||report.method!=='on-device'||report.result!=='passed'||report.case!==name)throw new Error(`${name}: only matching on-device behavioral evidence may pass`);
 if(!Number.isFinite(Date.parse(report.recordedAt))||! /^[a-f0-9]{64}$/.test(report.candidateSha256??''))throw new Error(`${name}: missing observation date or candidate digest`);
 if(typeof report.observed!=='string'||report.observed.trim().length<20||!Array.isArray(report.steps)||!report.steps.length)throw new Error(`${name}: missing observed behavior or reproduction steps`);
 if(report.steps.every(step=>/--(?:version|help)\b/.test(String(step))))throw new Error(`${name}: version/help output cannot prove native behavior`);
 if(!Array.isArray(report.attachments)||!report.attachments.length)throw new Error(`${name}: attach the actual log, screenshot or trace`);
 for(const attachment of report.attachments)artifact(attachment,`${name} attachment`);
}
try{
 const matrix=JSON.parse(fs.readFileSync(matrixPath,'utf8').replace(/^\uFEFF/,''));
 if(matrix.schemaVersion!==1||!Array.isArray(matrix.combinations)||matrix.combinations.length!==15)throw new Error('Require schemaVersion 1 and exactly fifteen platform/tool combinations');
 const seen=new Set();
 for(const row of matrix.combinations){
  const id=`${row.platform}/${row.tool}`;
  if(!platforms.includes(row.platform)||!tools.includes(row.tool)||seen.has(id))throw new Error(`Unknown or duplicate combination ${id}`);seen.add(id);
  if(!['accepted','unverified'].includes(row.status))throw new Error(`${id}: invalid acceptance status`);
  if(row.discovery){
   const report=JSON.parse(artifact(row.discovery,`${id} discovery`).bytes);
   if(report.kind!=='cli-version-discovery'||!report.observations?.some(item=>item.tool===row.tool&&item.version===row.cliVersion&&item.exitCode===0))throw new Error(`${id}: version discovery does not match`);
  }
  let complete=true;
  for(const name of cases){
   const item=row.cases?.[name];if(!item||!['passed','unverified','failed'].includes(item.status))throw new Error(`${id}/${name}: missing or invalid case`);
   if(item.status==='passed'){
    if(!row.system||!row.architecture||!row.cliVersion||!Array.isArray(item.evidence)||!item.evidence.length)throw new Error(`${id}/${name}: no host identity or evidence`);
    for(const ref of item.evidence)observation(ref,row,name);
   }else{
    complete=false;
    if(typeof item.reason!=='string'||!item.reason.trim())throw new Error(`${id}/${name}: pending/failed cases require a reason`);
   }
  }
  if(row.status==='accepted'&&!complete)throw new Error(`${id}: accepted combination has incomplete cases`);
  if(row.status!=='accepted')pending.push(id);
 }
 console.log(`Platform evidence structurally valid. Accepted ${15-pending.length}/15 combinations.`);
 if(pending.length){console.log(`Unaccepted: ${pending.join(', ')}`);process.exitCode=2;}
}catch(error){errors.push(error.message);console.error(`Invalid platform evidence: ${errors.join('; ')}`);process.exitCode=1;}
