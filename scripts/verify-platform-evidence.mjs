/** Read-only acceptance gate. Mock UI, version discovery and cross-compiles are not native evidence. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const platforms=['windows','macos','linux'];
const tools=['codex','claude_code','grok','pi','open_code'];
const cases=['native_config','launch_resume','tray','resources_rules','history_usage','migration_sync'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** platformCandidates maps each platform to a content-hashed desktop-build record (or null until built). */
export function verifyPlatformEvidence(matrix,repositoryRoot=root){
 const pending=[];
 function artifact(ref,label,evidenceOnly=true){
 if(!ref||typeof ref.path!=='string'||(evidenceOnly&&!/^docs\/verification\//.test(ref.path))||! /^[a-f0-9]{64}$/.test(ref.sha256??''))throw new Error(`${label}: missing repository-relative evidence path or SHA-256`);
 const base=fs.realpathSync(evidenceOnly?path.resolve(repositoryRoot,'docs/verification'):repositoryRoot);
 const target=path.resolve(repositoryRoot,ref.path);
 const relative=path.relative(base,target);
 if(path.isAbsolute(ref.path)||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(`${label}: evidence escapes directory`);
 const resolved=path.relative(base,fs.realpathSync(target));
 if(resolved==='..'||resolved.startsWith(`..${path.sep}`)||path.isAbsolute(resolved))throw new Error(`${label}: evidence escapes directory`);
 const bytes=fs.readFileSync(target);if(!bytes.length||sha(bytes)!==ref.sha256)throw new Error(`${label}: empty, missing or changed evidence file`);
 return {target,bytes};
 }
 function candidate(row){
 const id=`${row.platform}/${row.tool}`;
 const record=JSON.parse(artifact(matrix.platformCandidates?.[row.platform],`${id} candidate record`).bytes);
 if(record.kind!==`${row.platform}-desktop-build`||record.exitCode!==0||typeof record.command!=='string'||!record.command.trim()||!Number.isFinite(Date.parse(record.recordedAt)))throw new Error(`${id}: candidate record must describe a successful platform build`);
 for(const field of ['platform','system','architecture'])if(record[field]!==row[field])throw new Error(`${id}: candidate ${field} differs from matrix`);
 const {bytes}=artifact(record.candidate,`${id} candidate artifact`,false);
 if(!Number.isSafeInteger(record.candidate.sizeBytes)||record.candidate.sizeBytes!==bytes.length)throw new Error(`${id}: candidate artifact size differs from record`);
 artifact(record.buildOutput,`${id} build output`);
 return record.candidate.sha256;
 }
 function observation(ref,row,name,candidateSha256){
 const {bytes}=artifact(ref,`${row.platform}/${row.tool}/${name}`);
 const report=JSON.parse(bytes);
 for(const field of ['platform','tool','system','architecture','cliVersion'])if(report[field]!==row[field])throw new Error(`${name}: evidence ${field} differs from matrix`);
 if(report.kind!=='native-platform-observation'||report.method!=='on-device'||report.result!=='passed'||report.case!==name)throw new Error(`${name}: only matching on-device behavioral evidence may pass`);
 if(!Number.isFinite(Date.parse(report.recordedAt))||! /^[a-f0-9]{64}$/.test(report.candidateSha256??''))throw new Error(`${name}: missing observation date or candidate digest`);
 if(report.candidateSha256!==candidateSha256)throw new Error(`${name}: observation candidate digest differs from platform candidate`);
 if(typeof report.observed!=='string'||report.observed.trim().length<20||!Array.isArray(report.steps)||!report.steps.length)throw new Error(`${name}: missing observed behavior or reproduction steps`);
 if(report.steps.every(step=>/--(?:version|help)\b/.test(String(step))))throw new Error(`${name}: version/help output cannot prove native behavior`);
 if(!Array.isArray(report.attachments)||!report.attachments.length)throw new Error(`${name}: attach the actual log, screenshot or trace`);
 for(const attachment of report.attachments)artifact(attachment,`${name} attachment`);
 }
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
  let complete=true;let candidateSha256;
  for(const name of cases){
   const item=row.cases?.[name];if(!item||!['passed','unverified','failed'].includes(item.status))throw new Error(`${id}/${name}: missing or invalid case`);
   if(item.status==='passed'){
    if(!row.system||!row.architecture||!row.cliVersion||!Array.isArray(item.evidence)||!item.evidence.length)throw new Error(`${id}/${name}: no host identity or evidence`);
    candidateSha256??=candidate(row);
    for(const ref of item.evidence)observation(ref,row,name,candidateSha256);
   }else{
    complete=false;
    if(typeof item.reason!=='string'||!item.reason.trim())throw new Error(`${id}/${name}: pending/failed cases require a reason`);
   }
  }
  if(row.status==='accepted'&&!complete)throw new Error(`${id}: accepted combination has incomplete cases`);
  if(row.status!=='accepted')pending.push(id);
 }
 return {accepted:15-pending.length,pending};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const matrixPath=path.resolve(root,process.argv[2]??'docs/verification/platform-evidence.json');
  const matrix=JSON.parse(fs.readFileSync(matrixPath,'utf8').replace(/^\uFEFF/,''));
  const result=verifyPlatformEvidence(matrix);
  console.log(`Platform evidence structurally valid. Accepted ${result.accepted}/15 combinations.`);
  if(result.pending.length){console.log(`Unaccepted: ${result.pending.join(', ')}`);process.exitCode=2;}
 }catch(error){console.error(`Invalid platform evidence: ${error.message}`);process.exitCode=1;}
}
