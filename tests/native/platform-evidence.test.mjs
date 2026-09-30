import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const base=JSON.parse(fs.readFileSync(new URL('../../docs/verification/platform-evidence.json',import.meta.url),'utf8'));
const script=new URL('../../scripts/verify-platform-evidence.mjs',import.meta.url);
function gate(change){
 const fixture=structuredClone(base);change(fixture);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cliora-evidence-'));
 try{
  const file=path.join(temporary,'matrix.json');fs.writeFileSync(file,JSON.stringify(fixture));
  return spawnSync(process.execPath,[fileURLToPath(script),file],{encoding:'utf8'});
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
test('unobserved fifteen combinations remain unaccepted with a distinct gate result',()=>{
 const result=gate(()=>{});assert.equal(result.status,2);assert.match(result.stdout,/Accepted 0\/15/);
});
test('a discovery-only combination cannot be marked accepted',()=>{
 const result=gate(matrix=>matrix.combinations[0].status='accepted');assert.equal(result.status,1);assert.match(result.stderr,/incomplete cases/);
});
test('changed discovery output is rejected by its content hash',()=>{
 const result=gate(matrix=>matrix.combinations[0].discovery.sha256='0'.repeat(64));assert.equal(result.status,1);assert.match(result.stderr,/changed evidence/);
});
test('version output cannot be submitted as native behavioral evidence',()=>{
 const result=gate(matrix=>{const row=matrix.combinations[0];row.cases.native_config={status:'passed',evidence:[row.discovery]};});assert.equal(result.status,1);assert.match(result.stderr,/only matching on-device behavioral evidence|evidence .* differs/);
});
