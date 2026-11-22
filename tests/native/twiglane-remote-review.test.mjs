import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../../src-tauri/src/remote/twiglane_review_metadata.py', import.meta.url));

test('Windows launch records a drive checkout, keeps its original baseline, and refuses replacement', {skip: process.platform !== 'win32'}, t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cliora-review-windows-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const repo = path.join(dir, '目录 with spaces');
  const env = {...process.env, USERPROFILE: dir};
  const run = (bin, args, cwd, input = '') => spawnSync(bin, args, {cwd, input, encoding: 'utf8', env, timeout: 15000});
  const git = (cwd, ...args) => {
    const result = run('git', args, cwd);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git(repo, 'init', '-qb', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(repo, 'file'), 'first\n');
  git(repo, 'add', 'file');
  git(repo, 'commit', '-qm', 'first');
  const original = git(repo, 'rev-parse', 'HEAD');
  const session = 'cliora-windows-review';
  const request = {session, directory: repo, executable: 'git', args: ['status', '--short'], environment: []};
  const packed = Buffer.from(JSON.stringify(request)).toString('base64');
  const launch = () => run('python.exe', ['-I', helper, 'launch', packed], dir);
  const started = launch();
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /cliora-windows-review;ready/);
  assert.match(started.stdout, /cliora-windows-review;ended/);
  git(repo, 'commit', '--allow-empty', '-qm', 'second');
  assert.notEqual(launch().status, 0);

  const inspect = () => {
    const result = run('python.exe', ['-I', helper, 'inspect'], dir, JSON.stringify({session, directory: repo}) + '\n');
    assert.ok(result.stdout.startsWith('cliora-review/1\n'), result.stderr);
    return {status: result.status, ...JSON.parse(result.stdout.slice('cliora-review/1\n'.length))};
  };
  const first = inspect();
  assert.equal(first.status, 0, JSON.stringify(first));
  assert.equal(first.baseline, original);
  assert.equal(first.headOid, git(repo, 'rev-parse', 'HEAD'));
  assert.match(first.root, /^[A-Z]:\/.*\/目录 with spaces$/);
  assert.match(first.worktreeIdentity, /^[0-9a-f]{64}$/);
  assert.equal(inspect().worktreeIdentity, first.worktreeIdentity);
  git(repo, 'reset', '--hard', original);
  git(repo, 'commit', '--amend', '--allow-empty', '-qm', 'rewritten start');
  assert.deepEqual(inspect(), {status: 2, error: 'invalid_baseline'});
  git(repo, 'reset', '--hard', original);
  assert.equal(inspect().baseline, original);

  const empty = path.join(dir, 'unborn');
  const emptySession = 'cliora-windows-unborn';
  mkdirSync(empty);
  git(empty, 'init', '-qb', 'main');
  const emptyLaunch = Buffer.from(JSON.stringify({...request, session: emptySession, directory: empty})).toString('base64');
  assert.equal(run('python.exe', ['-I', helper, 'launch', emptyLaunch], dir).status, 0);
  const emptyRead = run('python.exe', ['-I', helper, 'inspect'], dir,
    JSON.stringify({session: emptySession, directory: empty}) + '\n');
  assert.equal(emptyRead.status, 0, emptyRead.stderr);
  assert.equal(JSON.parse(emptyRead.stdout.split('\n')[1]).baseline, null);

  const moved = repo + '.original';
  renameSync(repo, moved);
  git(dir, 'clone', '-q', moved, repo);
  assert.deepEqual(inspect(), {status: 2, error: 'worktree_changed'});
});

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
  const live = spawn('sleep',['90'],{cwd:tree,stdio:'ignore'});
  t.after(() => live.kill());
  const panePath = path.join(dir,'pane-cwd');
  env.TEST_PANE_PATH = panePath;
  writeFileSync(panePath,tree);
  const legacyRow = (name='cliora-old', pane='%19') => `printf '%s\\t%s\\t%s\\t0\\t%s\\n' '${name}' '${pane}' '${live.pid}' "$(cat "$TEST_PANE_PATH")"`;
  const mockPane = script => {
    writeFileSync(path.join(tools,'tmux'), '#!/bin/sh\n[ "$1" = list-panes ] && [ "$2" = -s ] && [ "$3" = -t ] && [ "$4" = =cliora-old: ] || exit 1\n'+script+'\n');
    chmodSync(path.join(tools,'tmux'),0o700);
  };
  const restart = () => {
    const refused = inspect('cliora-old',tree);
    assert.equal(refused.status,2);
    assert.equal(JSON.parse(refused.stdout.trim().split('\n')[1]).error,'remote_review_restart');
  };
  mockPane(legacyRow());
  const older=inspect('cliora-old',tree);assert.equal(older.status,0,older.stdout);assert.equal(JSON.parse(older.stdout.trim().split('\n')[1]).baseline,null);
  writeFileSync(panePath,repo);restart(); // same Git object store, another checkout
  writeFileSync(panePath,tree);
  mockPane(legacyRow('cliora-older'));restart();
  mockPane(legacyRow()+'\n'+legacyRow('cliora-old','%20'));restart();
  mockPane('exit 1');
  writeFileSync(path.join(tools,'screen'),'#!/bin/sh\necho "   123.cliora-old (Attached)"\n');chmodSync(path.join(tools,'screen'),0o700);
  restart();
  renameSync(tree,tree+'.moved');git(repo,'clone','-q',repo,tree);
  mockPane(legacyRow());
  writeFileSync(panePath,tree+'.moved');restart();
  if (process.platform === 'linux') {
    writeFileSync(panePath,tree);restart(); // stale tmux pathname vs kernel cwd of the original live pane
  }
  assert.equal(inspect(id,tree).status,2);

});

test('reads dirty submodules and rejects a recorded start commit that no longer belongs to HEAD', {skip: process.platform === 'win32'}, t => {
  const dir = mkdtempSync(path.join(tmpdir(),'cliora-review-history-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const repo = path.join(dir,'repo'), sub = path.join(dir,'sub');
  const env = {...process.env,HOME:dir,LC_ALL:'C'};
  const run = (bin,args,cwd,input='') => {
    const r=spawnSync(bin,args,{cwd,env,input,encoding:'utf8',timeout:15000});
    assert.equal(r.status,0,r.stderr || r.stdout); return r.stdout.trim();
  };
  const git = (cwd,...args) => run('git',args,cwd);
  for (const folder of [repo,sub]) {
    mkdirSync(folder);git(folder,'init','-qb','main');git(folder,'config','user.name','Fixture');
    git(folder,'config','user.email','test@example.invalid');
    writeFileSync(path.join(folder,'base'),'base\n');git(folder,'add','.');git(folder,'commit','-qm','base');
  }
  const parent = git(repo,'rev-parse','HEAD');
  git(repo,'-c','protocol.file.allow=always','submodule','add','-q',sub,'mod');
  git(repo,'commit','-qm','add submodule');
  const original = git(repo,'rev-parse','HEAD');
  const id = 'cliora-rewrite';
  run('python3',['-I',helper,'record',id],repo);
  const read = (status = 0) => {
    const result = spawnSync('python3', ['-I',helper,'inspect'], {cwd:repo,env,encoding:'utf8',timeout:15000,
      input: JSON.stringify({session:id,directory:repo})+'\n'});
    assert.equal(result.status,status,result.stdout || result.stderr);
    return JSON.parse(result.stdout.split('\n')[1]);
  };
  git(repo,'config','submodule.mod.ignore','all');
  writeFileSync(path.join(repo,'mod','base'),'uncommitted\n');
  assert.equal(git(repo,'status','--porcelain'),'');
  assert.notEqual(git(repo,'status','--porcelain','--ignore-submodules=none'),'');
  assert.equal(read().uncommitted,1);
  git(path.join(repo,'mod'),'restore','base');
  git(repo,'commit','--amend','-qm','rewritten baseline');
  assert.equal(git(repo,'merge-base',original,'HEAD'),parent);
  assert.equal(read(2).error,'invalid_baseline');
  git(repo,'switch','--detach',original);
  assert.equal(read().baseline,original); // receipt is still the exact start, not the common ancestor
  git(repo,'switch','-qc','topic',original);
  git(repo,'commit','--allow-empty','-qm','later');
  assert.equal(read().baseline,original);
  git(repo,'switch','-qc','upstream',parent);
  git(repo,'commit','--allow-empty','-qm','upstream');
  git(repo,'rebase','--onto','upstream',parent,'topic');
  assert.equal(git(repo,'merge-base',original,'HEAD'),parent);
  assert.equal(read(2).error,'invalid_baseline');
});
