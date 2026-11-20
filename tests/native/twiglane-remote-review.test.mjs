import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../../src-tauri/src/remote/twiglane_review_metadata.py', import.meta.url));

test('captures a remote launch baseline in the actual linked worktree and refuses a replacement checkout', {skip: process.platform === 'win32'}, t => {
  const dir = mkdtempSync(path.join(tmpdir(),'cliora-review-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const repo=path.join(dir,'main'), tree=path.join(dir,'linked tree'), tools=path.join(dir,'bin');
  mkdirSync(repo); mkdirSync(tools);
  const env={...process.env,HOME:dir,PATH:tools+path.delimiter+process.env.PATH};
  const run=(bin,args,cwd,input='')=>spawnSync(bin,args,{cwd,input,encoding:'utf8',env,timeout:15000});
  const git=(cwd,...args)=>{const r=run('git',args,cwd);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(repo,'init','-q');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','test@example.invalid');
  writeFileSync(path.join(repo,'file'),'one\n');git(repo,'add','.');git(repo,'commit','-qm','one');
  git(repo,'worktree','add','-qb','fixture',tree);
  const id='cliora-session1', base=git(tree,'rev-parse','HEAD');
  assert.equal(run('python3',['-I',helper,'record',id],tree).status,0);
  writeFileSync(path.join(tree,'file'),'two\n');git(tree,'commit','-qam','two');git(tree,'mv','file','renamed');
  assert.notEqual(run('python3',['-I',helper,'record',id],tree).status,0);
  writeFileSync(path.join(tree,'new'),'untracked');
  const inspect=(session,project)=>run('python3',['-I',helper,'inspect'],dir,JSON.stringify({session,directory:project})+'\n');
  const result=inspect(id,tree);
  assert.equal(result.status,0,result.stderr);const info=JSON.parse(result.stdout.trim().split('\n')[1]);
  const directoryKey = entry => {
    const canonical = realpathSync(entry);
    const st = statSync(canonical);
    return [canonical,st.dev,st.ino];
  };
  const gitDir = git(tree,'rev-parse','--absolute-git-dir');
  const wire = JSON.stringify([hostname(),directoryKey(tree),directoryKey(gitDir)])
    .replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));
  assert.equal(info.worktreeIdentity,createHash('sha256').update(wire).digest('hex'));
  assert.equal(info.baseline,base);assert.equal(info.headOid,git(tree,'rev-parse','HEAD'));assert.equal(info.uncommitted,2);
  assert.equal(inspect(id,repo).status,2);
  writeFileSync(path.join(tools,'tmux'),'#!/bin/sh\ntest "$1" = has-session && test "$3" = =cliora-old\n');
  chmodSync(path.join(tools,'tmux'),0o700);
  const older=inspect('cliora-old',tree);assert.equal(older.status,0);assert.equal(JSON.parse(older.stdout.trim().split('\n')[1]).baseline,null);
  assert.equal(inspect('cliora-absent',tree).status,2);
  renameSync(tree,tree+'.moved');git(repo,'clone','-q',repo,tree);assert.equal(inspect(id,tree).status,2);
});
