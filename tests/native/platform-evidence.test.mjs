import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyPlatformEvidence } from '../../scripts/verify-platform-evidence.mjs';

// Synthetic matrix fixture. Real on-device evidence stays in the untracked docs/verification directory and is not required here.
const platforms=['windows','macos','linux'];
const tools=['codex','claude_code','grok','pi','open_code'];
const caseNames=['native_config','launch_resume','tray','resources_rules','history_usage','migration_sync'];
const discoveryBytes=Buffer.from(`${JSON.stringify({kind:'cli-version-discovery',recordedAt:'2026-09-30T00:00:00Z',observations:[{tool:'codex',version:'0.0.0',command:'codex --version',exitCode:0,stdout:'codex 0.0.0'}]})}\n`);
const base={
 schemaVersion:1,
 platformCandidates:{windows:null,macos:null,linux:null},
 combinations:platforms.flatMap((platform)=>tools.map((tool)=>({
  platform,tool,system:'fixture-host',architecture:'x64',cliVersion:'0.0.0',status:'unverified',
  discovery:platform==='windows'&&tool==='codex'?{path:'docs/verification/fixture-discovery.json',sha256:createHash('sha256').update(discoveryBytes).digest('hex')}:null,
  cases:Object.fromEntries(caseNames.map((name)=>[name,{status:'unverified',reason:'Synthetic fixture has not been observed on device.'}])),
 }))),
};
const script=new URL('../../scripts/verify-platform-evidence.mjs',import.meta.url);
function gate(change){
 const fixture=structuredClone(base);change(fixture);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cliora-evidence-'));
 try{
  const file=path.join(temporary,'matrix.json');fs.writeFileSync(file,JSON.stringify(fixture));
  return spawnSync(process.execPath,[fileURLToPath(script),file],{encoding:'utf8'});
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
function withDiscoveryEvidence(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliora-evidence-'));
 try{
  const target=path.join(root,'docs/verification/fixture-discovery.json');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,discoveryBytes);
  return run(root);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('unobserved fifteen combinations remain unaccepted with a distinct gate result',()=>{
 const result=gate((matrix)=>{for(const row of matrix.combinations)row.discovery=null;});assert.equal(result.status,2);assert.match(result.stdout,/Accepted 0\/15/);
});
test('a discovery-only combination cannot be marked accepted',()=>{
 const result=gate(matrix=>{matrix.combinations[0].discovery=null;matrix.combinations[0].status='accepted';});assert.equal(result.status,1);assert.match(result.stderr,/incomplete cases/);
});
test('changed discovery output is rejected by its content hash',()=>{
 withDiscoveryEvidence((root)=>{
  const matrix=structuredClone(base);matrix.combinations[0].discovery.sha256='0'.repeat(64);
  assert.throws(()=>verifyPlatformEvidence(matrix,root),/changed evidence/);
 });
});
test('repository path aliases work while an evidence symlink escaping the directory is rejected',()=>{
 withDiscoveryEvidence((root)=>{
  const alias=path.join(root,'repository-alias');fs.symlinkSync(root,alias,'dir');
  const result=verifyPlatformEvidence(structuredClone(base),alias);
  assert.equal(result.accepted,0);
  const outside=path.join(root,'outside.json');fs.writeFileSync(outside,discoveryBytes);
  const evidence=path.join(root,'docs/verification/fixture-discovery.json');fs.unlinkSync(evidence);fs.symlinkSync(outside,evidence);
  assert.throws(()=>verifyPlatformEvidence(structuredClone(base),alias),/evidence escapes directory/);
 });
});
test('version output cannot be submitted as native behavioral evidence',()=>{
 linkedFixture(({matrix,root,reports,saveReport})=>{
  reports.native_config.kind='cli-version-discovery';saveReport('native_config');
  assert.throws(()=>verifyPlatformEvidence(matrix,root),/only matching on-device behavioral evidence/);
 });
});

// All files below are synthetic fixtures in an isolated directory, never native acceptance evidence.
function linkedFixture(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cliora-candidate-evidence-'));
 const matrix=structuredClone(base);
 for(const row of matrix.combinations)row.discovery=null;
 const row=matrix.combinations[0];row.status='accepted';
 const write=(relative,value)=>{
  const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
  const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  return {path:relative,sha256:createHash('sha256').update(bytes).digest('hex')};
 };
 const candidate=write('src-tauri/target/release/cliora.exe','Synthetic executable fixture, not a native candidate.');
 const record={kind:'windows-desktop-build',platform:'windows',system:row.system,architecture:row.architecture,command:'fixture build',exitCode:0,recordedAt:'2026-09-30T00:00:00Z',candidate:{...candidate,sizeBytes:fs.statSync(path.join(root,candidate.path)).size},buildOutput:write('docs/verification/fixture-build.txt','Synthetic successful build output.')};
 const recordPath='docs/verification/fixture-candidate.json';
 matrix.platformCandidates={windows:write(recordPath,record),macos:null,linux:null};
 const attachment=write('docs/verification/fixture-behavior.txt','Synthetic observed behavior attachment.');
 const reports={};
 for(const name of Object.keys(row.cases)){
  reports[name]={kind:'native-platform-observation',method:'on-device',result:'passed',case:name,platform:row.platform,tool:row.tool,system:row.system,architecture:row.architecture,cliVersion:row.cliVersion,recordedAt:'2026-09-30T00:00:01Z',candidateSha256:candidate.sha256,observed:`Synthetic fixture behavior for ${name}.`,steps:[`Exercise ${name} in the fixture`],attachments:[attachment]};
  row.cases[name]={status:'passed',evidence:[write(`docs/verification/fixture-${name}.json`,reports[name])]};
 }
 const saveReport=name=>row.cases[name].evidence=[write(`docs/verification/fixture-${name}.json`,reports[name])];
 const saveRecord=()=>matrix.platformCandidates.windows=write(recordPath,record);
 try{return run({root,matrix,row,record,reports,write,saveReport,saveRecord});}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('six matching cases bind to one content-hashed candidate record and actual artifact',()=>{
 linkedFixture(({matrix,root})=>{const result=verifyPlatformEvidence(matrix,root);assert.equal(result.accepted,1);assert.equal(result.pending.length,14);});
});
test('a passed case requires a platform candidate reference',()=>{
 linkedFixture(({matrix,root})=>{matrix.platformCandidates.windows=null;assert.throws(()=>verifyPlatformEvidence(matrix,root),/candidate record: missing/);});
});
test('six identical but wrong observation candidate digests are rejected',()=>{
 linkedFixture(({matrix,root,reports,saveReport})=>{
  for(const name of Object.keys(reports)){reports[name].candidateSha256='0'.repeat(64);saveReport(name);}
  assert.throws(()=>verifyPlatformEvidence(matrix,root),/observation candidate digest differs/);
 });
});
test('a different candidate digest in a later case cannot mix with five matching cases',()=>{
 linkedFixture(({matrix,root,reports,saveReport})=>{reports.migration_sync.candidateSha256='1'.repeat(64);saveReport('migration_sync');assert.throws(()=>verifyPlatformEvidence(matrix,root),/migration_sync: observation candidate digest differs/);});
});
test('a modified candidate record is rejected by its reference digest',()=>{
 linkedFixture(({matrix,root,record,write})=>{record.command='changed build';write(matrix.platformCandidates.windows.path,record);assert.throws(()=>verifyPlatformEvidence(matrix,root),/candidate record: empty, missing or changed evidence/);});
});
test('mutually matching wrong record and report digests cannot replace the actual candidate artifact',()=>{
 linkedFixture(({matrix,root,record,reports,saveRecord,saveReport})=>{
  record.candidate.sha256='0'.repeat(64);saveRecord();
  for(const name of Object.keys(reports)){reports[name].candidateSha256=record.candidate.sha256;saveReport(name);}
  assert.throws(()=>verifyPlatformEvidence(matrix,root),/candidate artifact: empty, missing or changed evidence/);
 });
});
test('candidate platform and host must match the observed combination',()=>{
 for(const field of ['platform','system','architecture'])linkedFixture(({matrix,root,record,saveRecord})=>{record[field]=field==='platform'?'macos':'different host';saveRecord();assert.throws(()=>verifyPlatformEvidence(matrix,root),new RegExp(`candidate ${field} differs`));});
});
test('candidate build output must retain its recorded bytes',()=>{
 linkedFixture(({matrix,root,record,write})=>{write(record.buildOutput.path,'Changed build output.');assert.throws(()=>verifyPlatformEvidence(matrix,root),/build output: empty, missing or changed evidence/);});
});
