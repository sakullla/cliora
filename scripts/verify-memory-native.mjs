/** Delivery memory probes. Replays the native-effect verification for every
 * integrated CLI through the product engine and refreshes the
 * docs/verification/memory summary. CLI semantics belong to adapters; this
 * harness only drives the product registry/engine and the installed CLIs. */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const home = process.env.USERPROFILE ?? os.homedir();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The product engine harness: compiled against the offline-built cliora_lib,
// it exposes the production registry catalog (memory publication + recorded
// reasons) and the shared memory engine (list/read/save/delete/switch).
const harness = String.raw`
use cliora_lib::{adapters::Registry, credentials::CredentialStore, database::Database,
    native::adapter::Scope, resources::memory::{self, MemoryDelete, MemoryEnable, MemorySave, MemoryTarget}};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}};
struct FileCredentials{path:PathBuf}
impl FileCredentials{
    fn load(path:&Path)->Result<BTreeMap<String,String>,String>{
        Ok(std::fs::read_to_string(path).ok().and_then(|text|serde_json::from_str(&text).ok()).unwrap_or_default())
    }
    fn save(&self,map:&BTreeMap<String,String>)->Result<(),String>{
        let text=serde_json::to_string(map).map_err(|e|e.to_string())?;
        std::fs::write(&self.path,text).map_err(|e|e.to_string())
    }
}
impl CredentialStore for FileCredentials {
    fn put(&self,id:&str,value:&str)->Result<(),String>{let mut map=Self::load(&self.path)?;map.insert(id.into(),value.into());self.save(&map)}
    fn get(&self,id:&str)->Result<String,String>{Self::load(&self.path)?.get(id).cloned().ok_or("missing synthetic credential".into())}
    fn delete(&self,id:&str)->Result<(),String>{let mut map=Self::load(&self.path)?;map.remove(id);self.save(&map)}
}
fn parse_scope(name:&str)->Scope{if name=="global"{Scope::Global}else{Scope::Project}}
fn target(request:&Value)->MemoryTarget{MemoryTarget{
    tool_id:request["tool"].as_str().unwrap_or_default().to_owned(),
    scope:parse_scope(request["scope"].as_str().unwrap_or("project")),
    project_path:request["project"].as_str().map(str::to_owned),
    context_id:None,
    store_directory:None}}
fn run()->Result<Value,String>{
    let args:Vec<String>=std::env::args().collect();
    let registry=Registry::builtins();
    if args[1]=="catalog"{
        let mut items=Vec::new();
        for adapter in registry.iter(){
            let reason=adapter.memory().map(|port|port.declaration().unverified_reason.to_owned());
            let published=adapter.descriptor().management.memory.clone();
            items.push(json!({"tool":adapter.id(),"command":adapter.command(),"reason":reason,"published":published}));
        }
        return Ok(json!(items));
    }
    if args[1]=="resolve"{
        let adapter=registry.get(args[2].as_str()).ok_or("unregistered tool")?;
        let port=adapter.memory().ok_or("no memory port")?;
        let directory=port.directory(parse_scope(&args[3]),Path::new(&args[4]),args.get(5).map(|p|Path::new(p)))?;
        return Ok(json!({"directory":directory}));
    }
    let request:Value=serde_json::from_str(&std::fs::read_to_string(&args[2]).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let database_path=request["database"].as_str().ok_or("missing database")?;
    let database=Database::open(Path::new(database_path)).map_err(|e|e.to_string())?;
    let store=FileCredentials{path:PathBuf::from(format!("{database_path}.creds.json"))};
    let home=PathBuf::from(request["home"].as_str().ok_or("missing home")?);
    let target=target(&request);
    let id=request["id"].as_str().unwrap_or_default().to_owned();
    let out=match request["op"].as_str().unwrap_or_default(){
        "aggregate"=>json!(memory::list_all_memories(&database,&registry,&home,&target.tool_id)?),
        "group"=>{memory::set_memory_switch_group(&database,&store,&registry,&home,&target.tool_id,request["group"].as_str().ok_or("missing group")?,request["enabled"]==true)?;json!({"updated":true})},
        "list"=>json!(memory::list_memories(&database,&registry,&home,&target)?),
        "read"=>json!(memory::read_memory(&database,&registry,&home,&target,&id)?),
        "save"=>json!(memory::save_memory(&database,&store,&registry,&home,&MemorySave{
            target:target.clone(),id:id.clone(),
            text:request["text"].as_str().ok_or("missing text")?.to_owned(),
            baseline:request["baseline"].as_str().unwrap_or_default().to_owned(),
            confirm_external:request["confirmExternal"]==true})?),
        "delete"=>{memory::delete_memory(&database,&store,&registry,&home,&MemoryDelete{
            target:target.clone(),id:id.clone(),
            baseline:request["baseline"].as_str().unwrap_or_default().to_owned()})?;json!({"deleted":true})}
        "enable"=>json!(memory::set_memory_enabled(&database,&store,&registry,&home,&MemoryEnable{
            target:target.clone(),id:None,enabled:request["enabled"]==true})?),
        other=>return Err(format!("unknown engine op {other:?}")),
    };
    Ok(out)
}
fn main(){match run(){Ok(value)=>println!("{}",value),Err(error)=>{eprintln!("{}",error);std::process::exit(1)}}}
`;

function quoteWindows(value) {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function run(command, args, options = {}) {
  const stdio = options.stdinPath
    ? [fssync.openSync(options.stdinPath, 'r'), 'pipe', 'pipe']
    : ['ignore', 'pipe', 'pipe'];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repository, env: options.env ?? process.env, stdio, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 30_000);
    child.on('error', error => { clearTimeout(timeout); if (options.stdinPath) try { fssync.closeSync(stdio[0]); } catch {} reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (options.stdinPath) try { fssync.closeSync(stdio[0]); } catch {}
      resolve({ command, args, exitCode, signal, stdout, stderr });
    });
  });
}

async function requireSuccess(command, args, options) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).slice(-4000)}`);
  return result;
}

async function fingerprint() {
  // Cover every in-repo input of cliora_lib (sources + manifest + lockfile),
  // not just the memory surfaces: any change during the replay must trip
  // sourceStable.
  const listing = await requireSuccess('git', ['ls-files', '-co', '--exclude-standard', '-z', '--',
    'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'scripts/verify-memory-native.mjs']);
  const entries = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
  const files = [];
  for (const ref of entries) files.push({ ref, sha256: sha256(await fs.readFile(path.join(repository, ref))) });
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function resolveExecutable(command) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const target = path.join(directory, `${command}${suffix}`);
      try { await fs.access(target); return { target, shell: suffix !== '.exe' && process.platform === 'win32' }; } catch {}
    }
  }
  return null;
}

function commandRunner(resolved) {
  if (!resolved) return null;
  if (!resolved.shell) return { command: resolved.target, wrap: args => args };
  const shell = process.env.ComSpec ?? 'cmd.exe';
  return { command: shell, wrap: args => ['/d', '/c', [resolved.target, ...args].map(quoteWindows).join(' ')] };
}

// The `windows` crate family ships its import libraries inside
// windows_<arch>_msvc registry crates; a manual rustc link needs them on the
// native search path (cargo passes this via the crate's `links` directive).
function cargoNativeLibDirs() {
  if (process.platform !== 'win32') return [];
  const registry = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'registry', 'src');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const dirs = [];
  for (const hash of fssync.existsSync(registry) ? fssync.readdirSync(registry) : []) {
    const hashDir = path.join(registry, hash);
    for (const entry of fssync.existsSync(hashDir) ? fssync.readdirSync(hashDir) : []) {
      if (!entry.startsWith(`windows_${arch}_msvc-`)) continue;
      const lib = path.join(hashDir, entry, 'lib');
      if (fssync.existsSync(lib)) dirs.push(lib);
    }
  }
  return dirs;
}

async function buildHarness(temporary) {
  const build = await requireSuccess('cargo', ['build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--message-format=json'], { timeout: 600_000 });
  const artifacts = build.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(item => item?.reason === 'compiler-artifact');
  const library = artifacts.findLast(item => item.target.name === 'cliora_lib')?.filenames.find(ref => ref.endsWith('.rlib'));
  const jsonLibrary = artifacts.findLast(item => item.target.name === 'serde_json')?.filenames.find(ref => ref.endsWith('.rlib'));
  if (!library || !jsonLibrary) throw new Error('Cargo did not report product/JSON library artifacts');
  const source = path.join(temporary, 'memory-harness.rs');
  const binary = path.join(temporary, process.platform === 'win32' ? 'memory-harness.exe' : 'memory-harness');
  await fs.writeFile(source, harness);
  const nativeFlags = cargoNativeLibDirs().flatMap(dir => ['-L', `native=${dir}`]);
  await requireSuccess('rustc', ['--edition=2021', '--crate-name', 'cliora_memory_replay', source, '-L', `dependency=${path.dirname(jsonLibrary)}`, ...nativeFlags, '--extern', `cliora_lib=${library}`, '--extern', `serde_json=${jsonLibrary}`, '-o', binary], { timeout: 120_000 });
  return { binary, library };
}

class Engine {
  constructor(binary, temporary) {
    this.binary = binary;
    this.temporary = temporary;
  }

  async request(request, env) {
    const file = path.join(this.temporary, `request-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    await fs.mkdir(path.dirname(request.database), { recursive: true });
    await fs.writeFile(file, JSON.stringify(request));
    const result = await requireSuccess(this.binary, ['memory', file], { env: env ?? process.env });
    await fs.rm(file, { force: true });
    return JSON.parse(result.stdout);
  }

  database(tool) {
    const directory = path.join(this.temporary, 'engine', tool);
    return path.join(directory, 'engine.sqlite');
  }

  async op(request, env) {
    return this.request({ database: this.database(request.tool), home, ...request }, env);
  }
}

// Model echoes and terminal captures may interleave zero-width/bidi control
// characters and homoglyph substitutions; marker assertions must not fail on
// invisible noise or Cyrillic/full-width lookalikes of Latin letters.
const CONFUSABLES = {
  'А': 'A', 'а': 'A', 'В': 'B', 'в': 'B', 'Е': 'E', 'е': 'E',
  'К': 'K', 'к': 'K', 'М': 'M', 'м': 'M', 'Н': 'H', 'н': 'H',
  'О': 'O', 'о': 'O', 'Р': 'P', 'р': 'P', 'С': 'C', 'с': 'C',
  'Т': 'T', 'т': 'T', 'У': 'Y', 'у': 'Y', 'Х': 'X', 'х': 'X',
  'І': 'I', 'і': 'I', 'Ａ': 'A', 'Ｄ': 'D', 'Ｅ': 'E', 'Ｌ': 'L',
  'Ｉ': 'I', 'Ｏ': 'O', 'Ｒ': 'R', 'Ｖ': 'V', 'Ｙ': 'Y',
};
function visible(text) {
  return text
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, '')
    .replace(/[АаВвЕеКкМмНнОоРрСсТтУуХхІіＡＤＥＩＬＯＲＶＹ]/g, ch => CONFUSABLES[ch] ?? ch);
}

function check(record, name, passed, detail) {
  record.checks.push({ name, passed: passed === true, detail });
  return passed === true;
}

async function captureVersion(runner, env) {
  if (!runner) return null;
  const result = await run(runner.command, runner.wrap(['--version']), { env, timeout: 60_000 });
  return { exitCode: result.exitCode, output: (result.stdout || result.stderr).trim().slice(0, 200) };
}

function noClioraFiles(directory) {
  if (!fssync.existsSync(directory)) return true;
  return !fssync.readdirSync(directory).some(name => name.includes('.cliora'));
}

// ---------------------------------------------------------------- claude ----
async function probeClaude(engine, marker, temporary, context) {
  const record = { tool: 'claude_code', cli: 'claude', marker, scope: 'project', checks: [] };
  const runner = context.runners.claude;
  if (!runner) { record.result = 'unverified'; record.reason = 'claude 未安装或不在 PATH'; return record; }
  const project = path.join(home, 'project', 'cliora-mem-probe');
  await fs.mkdir(project, { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const settingsBefore = await fs.readFile(settingsPath, 'utf8').catch(() => null);
  const target = { tool: 'claude_code', scope: 'project', project };
  const id = 'cliora_delivery_probe';
  const prompt = 'What is the exact marker code in your memory? Answer with the code only, or NONE.';
  const session = async expected => {
    const stdin = path.join(temporary, `claude-prompt-${Math.random().toString(16).slice(2)}.txt`);
    await fs.writeFile(stdin, prompt);
    const result = await run(runner.command, runner.wrap(['-p']), { cwd: project, stdinPath: stdin, timeout: 240_000 });
    const answer = visible(result.stdout.trim());
    // Liveness gate: a session killed by timeout (signal set, empty stdout)
    // must not satisfy the negative expectation vacuously.
    const live = result.exitCode === 0 && !result.signal && answer.length > 0;
    return { answer, passed: live && (expected === 'marker' ? answer.includes(marker) : !answer.includes(marker)),
      detail: `exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ''} answer=${answer.slice(0, 120)}` };
  };
  try {
    const saved = await engine.op({ ...target, op: 'save', id, baseline: '', confirmExternal: true,
      text: `Cliora delivery probe marker ${marker}. Topic body for the native replay evidence.` });
    check(record, 'engine save hits the slug project storage', /cliora-mem-probe/i.test(saved.path.replaceAll('\\', '/')) && saved.path.endsWith(`${id}.md`), saved.path);
    const list = await engine.op({ ...target, op: 'list' });
    check(record, 'MEMORY.md is not an entry', list.entries.some(entry => entry.id === id) && !list.entries.some(entry => entry.id === 'MEMORY'), list.entries.map(entry => entry.id).join(','));
    const memoryDir = path.dirname(saved.path);
    check(record, 'no .cliora-* file in native storage', noClioraFiles(memoryDir));
    const first = await session('marker');
    check(record, 'native session reads the engine-written marker', first.passed, first.detail);
    const disabled = await engine.op({ ...target, op: 'enable', enabled: false });
    check(record, 'engine master switch off', disabled.inUse === false);
    const second = await session('none');
    check(record, 'switch off changes the native session behavior', second.passed, second.detail);
    await engine.op({ ...target, op: 'enable', enabled: true });
    const document = await engine.op({ ...target, op: 'read', id });
    await engine.op({ ...target, op: 'delete', id, baseline: document.text });
    const after = await engine.op({ ...target, op: 'list' });
    check(record, 'engine delete removes the probe entry', !after.entries.some(entry => entry.id === id));
    check(record, 'no .cliora-* file in native storage after cleanup', noClioraFiles(memoryDir));
  } finally {
    if (settingsBefore !== null) await fs.writeFile(settingsPath, settingsBefore);
    else await fs.rm(settingsPath, { force: true });
  }
  const settingsAfter = await fs.readFile(settingsPath, 'utf8').catch(() => null);
  check(record, 'user settings.json restored byte-identically', settingsAfter === settingsBefore,
    `sha256 before=${settingsBefore === null ? 'absent' : sha256(settingsBefore)} after=${settingsAfter === null ? 'absent' : sha256(settingsAfter)}`);
  record.result = record.checks.every(item => item.passed) ? 'passed' : 'failed';
  return record;
}

// ----------------------------------------------------------------- codex ----
async function probeCodex(engine, marker, temporary, context) {
  const record = { tool: 'codex', cli: 'codex', marker, scope: 'global (isolated CODEX_HOME)', checks: [] };
  const runner = context.runners.codex;
  if (!runner) { record.result = 'unverified'; record.reason = 'codex 未安装或不在 PATH'; return record; }
  const codexHome = path.join(temporary, 'codex-home');
  const project = path.join(temporary, 'codex-project');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  // Isolated home: the real config carries a working model provider; the
  // probe copies it (secrets stay local and never enter the report).
  const realConfig = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8')
    .catch(() => { throw new Error('缺少 ~/.codex/config.toml，无法构造隔离模型提供方'); });
  await fs.writeFile(path.join(codexHome, 'config.toml'), realConfig);
  const env = { ...process.env, CODEX_HOME: codexHome };
  const target = { tool: 'codex', scope: 'global', home: codexHome };
  const prompt = '如果记忆里有我的暗号，请直接回答暗号内容；没有就回答 UNKNOWN';
  const session = async extraArgs => {
    const stdin = path.join(temporary, `codex-prompt-${Math.random().toString(16).slice(2)}.txt`);
    await fs.writeFile(stdin, prompt);
    const result = await run(runner.command, runner.wrap(['exec', '--skip-git-repo-check', ...extraArgs]), { cwd: project, env, stdinPath: stdin, timeout: 360_000 });
    return visible((result.stdout + result.stderr).trim());
  };
  try {
    const features = async () => {
      const result = await run(runner.command, runner.wrap(['features', 'list']), { env, timeout: 60_000 });
      return /\bmemories\b[^\n]*\b(stable|experimental)\b[^\n]*\b(true|false)\b/.exec(result.stdout + result.stderr);
    };
    const fresh = await features();
    check(record, 'fresh isolated home keeps memories off by default', !!fresh && fresh[2] === 'false', fresh?.[0] ?? 'features list output missing');
    await engine.request({ database: engine.database('codex'), home: codexHome, ...target, op: 'enable', enabled: true }, env);
    const configAfterEnable = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    check(record, 'engine switch on writes [features] memories', configAfterEnable.includes('memories = true'), configAfterEnable.includes('memories = true') ? 'memories = true present' : 'key missing');
    const enabled = await features();
    check(record, 'codex features list reports memories enabled', !!enabled && enabled[2] === 'true', enabled?.[0] ?? 'features list output missing');
    const memories = path.join(codexHome, 'memories');
    await fs.mkdir(memories, { recursive: true });
    await fs.writeFile(path.join(memories, 'memory_summary.md'), 'v1\n\n# Summary\n\n- delivery replay baseline entry\n');
    await fs.writeFile(path.join(memories, 'MEMORY.md'), 'v1\n\n# Memory\n\n- delivery replay baseline entry\n');
    const document = await engine.request({ database: engine.database('codex'), home: codexHome, ...target, op: 'read', id: 'memory_summary' }, env);
    const withMarker = `${document.text.trimEnd()}\n- delivery probe marker ${marker}\n`;
    await engine.request({ database: engine.database('codex'), home: codexHome, ...target, op: 'save', id: 'memory_summary', baseline: document.text, text: withMarker }, env);
    check(record, 'engine edit lands on the verified memory file', withMarker.includes(marker) && document.path.replaceAll('\\', '/').endsWith('/memories/memory_summary.md'), document.path);
    const answerOn = await session([]);
    check(record, 'native session answers the engine-written marker', answerOn.includes(marker), answerOn.slice(-400));
    const answerOff = await session(['--disable', 'memories']);
    check(record, '--disable memories removes the marker from the session', !answerOff.includes(marker) && answerOff.includes('UNKNOWN'), answerOff.slice(-400));
    await engine.request({ database: engine.database('codex'), home: codexHome, ...target, op: 'enable', enabled: false }, env);
    const configAfterDisable = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const disabled = await features();
    check(record, 'engine switch off removes the key and codex agrees', !configAfterDisable.includes('memories = true') && !!disabled && disabled[2] === 'false', disabled?.[0] ?? 'features list output missing');
    check(record, 'no .cliora-* file in the isolated memory workspace', noClioraFiles(memories));
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
  record.result = record.checks.every(item => item.passed) ? 'passed' : 'failed';
  return record;
}

// ------------------------------------------------------------- codebuddy ----
function startCaptureStub() {
  const captures = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', bytes => { body += bytes; });
    request.on('end', () => {
      captures.push({ url: request.url, body });
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'cliora capture stub' } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, captures, port: server.address().port })));
}

async function probeCodebuddy(engine, marker, temporary, context) {
  const record = { tool: 'codebuddy', cli: 'codebuddy', marker, scope: 'project', checks: [] };
  const runner = context.runners.codebuddy;
  if (!runner) { record.result = 'unverified'; record.reason = 'codebuddy 未安装或不在 PATH'; return record; }
  const project = path.join(home, 'project', 'memory-probe-20261019');
  await fs.mkdir(project, { recursive: true });
  const stub = await startCaptureStub();
  const settingsPath = path.join(home, '.codebuddy', 'settings.json');
  const settingsBefore = await fs.readFile(settingsPath, 'utf8').catch(() => null);
  const env = { ...process.env, CODEBUDDY_BASE_URL: `http://127.0.0.1:${stub.port}` };
  const target = { tool: 'codebuddy', scope: 'project', project };
  const id = 'feedback_cliora_delivery';
  const session = async () => {
    const watermark = stub.captures.length;
    const result = await run(runner.command, runner.wrap(['-p', 'hi']), { cwd: project, env, timeout: 180_000 });
    return { exitCode: result.exitCode, bodies: stub.captures.slice(watermark).map(item => item.body) };
  };
  try {
    const saved = await engine.op({ ...target, op: 'save', id, baseline: '', confirmExternal: true,
      text: `---\nname: Cliora delivery probe\ndescription: ${marker}\ntype: feedback\n---\n${marker} body for the native replay evidence.\n` });
    check(record, 'engine save hits the slug project storage', /memory-probe-20261019/i.test(saved.path.replaceAll('\\', '/')), saved.path);
    const list = await engine.op({ ...target, op: 'list' });
    check(record, 'MEMORY.md is not an entry', list.entries.some(entry => entry.id === id) && !list.entries.some(entry => entry.id === 'MEMORY'), list.entries.map(entry => entry.id).join(','));
    const on = await session();
    const onBody = on.bodies.find(body => body.includes('## MEMORY.md') || body.includes(marker));
    check(record, 'native gateway request carries the memory index and marker',
      !!onBody && onBody.includes('## MEMORY.md') && onBody.includes(marker),
      on.bodies.length ? `${on.bodies.length} captured request(s), memory section ${on.bodies.some(body => body.includes('## MEMORY.md')) ? 'present' : 'absent'}` : 'no captured request');
    await engine.op({ ...target, op: 'enable', enabled: false });
    const off = await session();
    const offBody = off.bodies.find(body => body.includes('## MEMORY.md') || body.includes(marker));
    check(record, 'engine switch off removes memory loading from the next session', off.bodies.length > 0 && !offBody,
      off.bodies.length ? `${off.bodies.length} captured request(s), memory references ${off.bodies.some(body => body.includes(marker)) ? 'still present' : 'absent'}` : 'no captured request — negative outcome not established');
    await engine.op({ ...target, op: 'enable', enabled: true });
    const document = await engine.op({ ...target, op: 'read', id });
    await engine.op({ ...target, op: 'delete', id, baseline: document.text });
    const after = await engine.op({ ...target, op: 'list' });
    check(record, 'engine delete removes the probe entry', !after.entries.some(entry => entry.id === id));
    check(record, 'no .cliora-* file in native storage', noClioraFiles(path.dirname(saved.path)));
  } finally {
    stub.server.close();
    if (settingsBefore !== null) await fs.writeFile(settingsPath, settingsBefore);
    else await fs.rm(settingsPath, { force: true });
  }
  const settingsAfter = await fs.readFile(settingsPath, 'utf8').catch(() => null);
  check(record, 'user settings.json restored byte-identically', settingsAfter === settingsBefore,
    `sha256 before=${settingsBefore === null ? 'absent' : sha256(settingsBefore)} after=${settingsAfter === null ? 'absent' : sha256(settingsAfter)}`);
  record.result = record.checks.every(item => item.passed) ? 'passed' : 'failed';
  return record;
}

// ------------------------------------------------------------------ mimo ----
async function probeMimo(engine, marker, temporary, context) {
  const record = { tool: 'mimo_code', cli: 'mimo', marker, scope: 'project', checks: [] };
  const runner = context.runners.mimo;
  if (!runner) { record.result = 'unverified'; record.reason = 'mimo 未安装或不在 PATH'; return record; }
  const project = path.join(home, 'project', 'cliora');
  const target = { tool: 'mimo_code', scope: 'project', project };
  const paths = await run(runner.command, runner.wrap(['debug', 'paths']), { timeout: 60_000 });
  check(record, 'mimo debug paths reports the native data root', paths.exitCode === 0 && paths.stdout.includes('mimocode'), paths.stdout.trim().slice(0, 200));
  const document = await engine.op({ ...target, op: 'read', id: 'MEMORY' });
  const original = { text: document.text, fingerprint: document.fingerprint };
  check(record, 'engine reads the real project MEMORY.md', document.path.replaceAll('\\', '/').includes('/memory/projects/'), document.path);
  const markerLine = `- Cliora delivery replay: marker ${marker}; the seaside gate opens at dusk.`;
  const lines = original.text.split('\n');
  lines.splice(Math.min(2, lines.length), 0, markerLine);
  const probeText = lines.join('\n');
  // The prompt carries only the search key ("Cliora delivery replay"); the
  // sentinel sentence and the marker hash exist solely in the engine-written
  // memory line, so a tool-call echo of the prompt cannot satisfy the check.
  const sentinel = 'the seaside gate opens at dusk';
  const prompt = 'Search your memory for the topic "Cliora delivery replay" with your memory tool. '
    + 'If the memory tool reports no results, follow its guidance and search the memory directory files. '
    + 'Report each hit as file:line and quote the full matched line verbatim. If nothing is found anywhere, answer NONE.';
  check(record, 'probe prompt embeds neither the sentinel nor the marker', !prompt.includes(sentinel) && !prompt.includes(marker),
    'sentinel/marker live only in the engine-written memory line');
  try {
    await engine.op({ ...target, op: 'save', id: 'MEMORY', baseline: original.text, text: probeText });
    const result = await run(runner.command, runner.wrap(['run', prompt, '--dir', project, '--yolo']), { cwd: project, timeout: 360_000 });
    const plain = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const hitReport = /\d+\s+match|MEMORY[\w.-]*\.md:\d+/.test(plain);
    check(record, 'native session reports a search hit quoting the engine-written line',
      plain.includes(sentinel) && hitReport, plain.trim().slice(-500));
  } finally {
    const current = await engine.op({ ...target, op: 'read', id: 'MEMORY' });
    await engine.op({ ...target, op: 'save', id: 'MEMORY', baseline: current.text, text: original.text });
  }
  const restored = await engine.op({ ...target, op: 'read', id: 'MEMORY' });
  check(record, 'MEMORY.md restored to the original fingerprint', restored.fingerprint === original.fingerprint, `${original.fingerprint.slice(0, 12)} -> ${restored.fingerprint.slice(0, 12)}`);
  check(record, 'no .cliora-* file in native storage', noClioraFiles(path.dirname(restored.path)));
  record.result = record.checks.every(item => item.passed) ? 'passed' : 'failed';
  return record;
}

// ------------------------------------------------------------------ grok ----
async function probeGrok(engine, marker, temporary, context) {
  const record = { tool: 'grok', cli: 'grok', marker, scope: 'global', checks: [] };
  const runner = context.runners.grok;
  if (!runner) { record.result = 'unverified'; record.reason = 'grok 未安装或不在 PATH'; return record; }
  const scope = path.join(home, '.grok', 'memory-v2', 'global');
  const indexPath = path.join(scope, 'MEMORY.md');
  const indexBefore = await fs.readFile(indexPath, 'utf8').catch(() => null);
  const target = { tool: 'grok', scope: 'global' };
  const id = 'cliora_delivery_probe';
  const text = `# Cliora delivery probe\n\n${marker} — delivery replay topic.\n`;
  try {
    const listBefore = await engine.op({ ...target, op: 'list' });
    if (listBefore.inUse === false) {
      check(record, 'engine list reports the switch-off detail (default off)', listBefore.detail.length > 0, listBefore.detail.slice(0, 120));
    } else if (listBefore.inUse === true) {
      // Grok memory already enabled on this machine: the default-off path is
      // not exercised, and the session below uses GROK_MEMORY=1 regardless.
      check(record, 'engine list reflects the pre-existing switch-on state', true, 'grok memory already enabled on this machine; default-off detail not exercised');
    } else {
      check(record, 'engine list reports a usable switch state', false, `inUse=${listBefore.inUse}`);
    }
    await engine.op({ ...target, op: 'save', id, baseline: '', confirmExternal: true, text });
    const list = await engine.op({ ...target, op: 'list' });
    check(record, 'engine save lands in the global topics directory', list.entries.some(entry => entry.id === id)
      && (await engine.op({ ...target, op: 'read', id })).path.replaceAll('\\', '/').endsWith('/memory-v2/global/topics/cliora_delivery_probe.md'), list.entries.map(entry => entry.id).join(','));
    const result = await run(runner.command, runner.wrap(['-p', 'List the topic file names present in your memory index. Answer with file names only.']), { env: { ...process.env, GROK_MEMORY: '1' }, timeout: 300_000 });
    const answer = result.stdout.trim();
    check(record, 'native session (GROK_MEMORY=1) lists the engine-written topic', answer.includes(id), answer.slice(0, 300));
    const document = await engine.op({ ...target, op: 'read', id });
    await engine.op({ ...target, op: 'delete', id, baseline: document.text });
    const after = await engine.op({ ...target, op: 'list' });
    check(record, 'engine delete removes the probe topic', !after.entries.some(entry => entry.id === id));
  } finally {
    if (indexBefore !== null) await fs.writeFile(indexPath, indexBefore);
    else await fs.rm(indexPath, { force: true });
    await fs.rm(path.join(scope, 'topics', `${id}.md`), { force: true });
  }
  check(record, 'no .cliora-* file in the topics directory', noClioraFiles(path.join(scope, 'topics')));
  record.result = record.checks.every(item => item.passed) ? 'passed' : 'failed';
  return record;
}

// Qoder is validated against an isolated home only. This proves the product's
// index/config contract, not a live paid session consuming that memory.
async function probeQoder(engine, marker, temporary) {
  const record = { tool: 'qoder_cn', marker, scope: 'global/project', checks: [] };
  const isolated = path.join(temporary, 'qoder-home');
  const project = path.join(temporary, 'qoder-project');
  await fs.mkdir(project, { recursive: true });
  const env = { ...process.env };
  for (const key of ['QODERCN_CONFIG_DIR', 'CONFIG_DIR_NAME', 'CLI_HOME', 'GEMINI_CLI_HOME']) delete env[key];
  const base = { tool: 'qoder_cn', home: isolated };
  const empty = await engine.op({ ...base, op: 'aggregate' }, env);
  check(record, 'two unknown native-default scope switches without creating a store', empty.stores.length === 0 && empty.switchGroups.length === 2 && empty.switchGroups.every(group => group.enabled === null));
  for (const scope of ['global', 'project']) {
    const target = { ...base, scope, project: scope === 'project' ? project : undefined, id: 'cliora-native-fixture' };
    const saved = await engine.op({ ...target, op: 'save', text: `---\nname: Native fixture\ntype: reference\n---\n${marker}` }, env);
    const index = path.join(path.dirname(saved.path), 'MEMORY.md');
    check(record, `${scope}: topic and native index persisted`, (await fs.readFile(index, 'utf8')).includes('](cliora-native-fixture.md)'));
    const read = await engine.op({ ...target, op: 'read' }, env);
    check(record, `${scope}: shared read returns written bytes`, read.text === saved.text);
    await engine.op({ ...target, op: 'delete', baseline: read.text }, env);
    check(record, `${scope}: delete removes index reference and topic`, !(await fs.readFile(index, 'utf8')).includes('](cliora-native-fixture.md)') && !fssync.existsSync(saved.path));
    check(record, `${scope}: no private item enable records`, noClioraFiles(path.dirname(saved.path)));
  }
  await engine.op({ ...base, op: 'group', group: 'autoMemoryEnabled', enabled: false }, env);
  await engine.op({ ...base, op: 'group', group: 'autoMemoryUserScopeEnabled', enabled: true }, env);
  const result = await engine.op({ ...base, op: 'aggregate' }, env);
  check(record, 'project and user native switches remain independent', result.switchGroups.find(group => group.scope === 'project')?.enabled === false && result.switchGroups.find(group => group.scope === 'global')?.enabled === true);
  record.result = record.checks.every(item => item.passed) ? 'unverified' : 'failed';
  record.reason = '隔离原生格式 CRUD/索引/开关通过；未启动付费推理或改写真实用户配置，原生交互消费效果未验证';
  return record;
}

const RECIPES = {
  qoder_cn: probeQoder,
  claude_code: probeClaude,
  codex: probeCodex,
  codebuddy: probeCodebuddy,
  mimo_code: probeMimo,
  grok: probeGrok,
};

const VERDICT_REFS = {
  claude_code: 'claude/integration.md',
  codex: 'codex/verdict.md',
  codebuddy: 'codebuddy/integration.md',
  mimo_code: 'mimo/verdict.md',
  grok: 'verdicts/grok.md',
  kimi_code: 'kimi/verdict.md',
  minimax_code: 'minimax/verdict.md',
  antigravity: 'antigravity/verdict.md',
  pi: 'verdicts/pi.md',
  devin: 'verdicts/devin.md',
  deepseek: 'verdicts/deepseek.md',
  zcode: 'verdicts/zcode.md',
  command_code: 'verdicts/command-code.md',
  kiro: 'verdicts/kiro.md',
};

function renderSummary(report) {
  const lines = [];
  lines.push('# CLI 原生记忆交付汇总');
  lines.push('');
  lines.push(`生成：\`node scripts/verify-memory-native.mjs\`；时间：${report.recordedAt}；平台：${report.platform}。`);
  lines.push('');
  lines.push(`重放结果：${report.result}。已接入 CLI ${report.replays.length ? report.replays.map(item => `${item.tool}=${item.result}`).join('、') : '（无）'}。`);
  lines.push('');
  lines.push('完整机器报告：[native-replay-report.json](native-replay-report.json)。逐家核实证据见下表链接。');
  lines.push('');
  lines.push('| CLI | 结论 | 入口（生产注册表 descriptor） | 证据 / 原因 |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of report.catalog) {
    const replay = report.replays.find(item => item.tool === entry.tool);
    const ref = VERDICT_REFS[entry.tool];
    if (entry.published) {
      const operations = entry.published.operations.join('/');
      const replayText = replay ? `重放 ${replay.result}` : '无重放配方';
      lines.push(`| ${entry.tool} | 已接入 | ${operations}${entry.published.limitation ? `（${entry.published.limitation}）` : ''} | ${ref ? `[${ref}](${ref})；${replayText}` : replayText} |`);
    } else {
      lines.push(`| ${entry.tool} | 未接入 | 无入口 | ${entry.reason || '原因未记录'}${ref ? `（[${ref}](${ref})）` : ''} |`);
    }
  }
  lines.push('');
  lines.push('## 本次原生生效重放');
  for (const replay of report.replays) {
    lines.push('');
    lines.push(`### ${replay.tool}（${replay.result}${replay.result === 'unverified' ? `：${replay.reason ?? ''}` : ''}）`);
    lines.push('');
    for (const item of replay.checks) lines.push(`- ${item.passed ? '通过' : '失败'}：${item.name}${item.detail ? `（${item.detail.replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 160)}）` : ''}`);
  }
  lines.push('');
  lines.push('## 入口可见性');
  lines.push('');
  lines.push(`生产注册表 descriptor 快照：已接入 ${report.catalog.filter(entry => entry.published).length} 家发布记忆入口，其余 ${report.catalog.filter(entry => !entry.published).length} 家原因非空、不发布（三态一致性另由 tests/adapter/registry-additions.rs 动态校验；UI 行为由 tests/ui/memory.spec.ts 既有场景守护）。`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function verifyMemoryNative({ only, report: reportPath, summary: summaryPath, strict = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cliora-memory-replay-'));
  const before = await fingerprint();
  const { binary } = await buildHarness(temporary);
  const engine = new Engine(binary, temporary);
  const catalog = JSON.parse((await requireSuccess(binary, ['catalog'])).stdout);
  const runners = {};
  for (const cli of ['claude', 'codex', 'codebuddy', 'mimo', 'grok']) runners[cli] = commandRunner(await resolveExecutable(cli));
  const marker = `CLIORA-DELIVERY-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 8).toUpperCase()}`;
  const published = catalog.filter(entry => entry.published).map(entry => entry.tool);
  if (only) {
    const unknown = only.filter(tool => !published.includes(tool));
    if (unknown.length) throw new Error(`--only 引用了未发布记忆入口的 CLI：${unknown.join(', ')}（可用：${published.join(', ') || '无'}）`);
  }
  if (!published.length) throw new Error('生产注册表没有任何已发布记忆入口的 CLI，无重放对象');
  const selected = only ? published.filter(tool => only.includes(tool)) : published;
  const replays = [];
  for (const tool of selected) {
    const recipe = RECIPES[tool];
    if (!recipe) { replays.push({ tool, result: 'failed', reason: '已发布记忆入口但缺少重放配方', checks: [] }); continue; }
    try {
      replays.push(await recipe(engine, marker, temporary, { runners }));
    } catch (error) {
      replays.push({ tool, result: 'failed', reason: error.message, checks: [{ name: 'probe completed', passed: false, detail: error.message.slice(0, 300) }] });
    }
    for (const item of replays.at(-1).checks) console.log(`${tool}: ${item.passed ? 'PASS' : 'FAIL'} ${item.name}`);
  }
  const missing = Object.keys(RECIPES).filter(tool => !published.includes(tool));
  const after = await fingerprint();
  const sourceStable = before.sha256 === after.sha256;
  const failed = replays.filter(item => item.result === 'failed');
  const unverified = replays.filter(item => item.result === 'unverified');
  const versions = {};
  for (const [cli, runner] of Object.entries(runners)) versions[cli] = await captureVersion(runner, process.env);
  const report = {
    schemaVersion: 1, kind: 'native-memory-delivery-replay', recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`, nodeVersion: process.version, marker,
    source: after, sourceStable, catalog, cliVersions: versions, replays,
    result: !sourceStable || failed.length || missing.length ? 'failed' : unverified.length ? 'completed_with_unverified' : 'passed',
    limits: [
      '每个已接入 CLI 的重放复用该 CLI 接入任务的原生探针形态（真实会话/网关捕获/开关探测）。',
      '未接入 CLI 仅随注册表结论报告原因，不做存储探测。',
      'Qoder CN 仅隔离 home 的原生格式契约回归；不执行真实会话、付费推理或改写真实配置，消费效果报告 unverified。',
      '会话行为证据是模型回答或捕获请求体，不是网络抓包。',
      'claude/codebuddy 的用户级 settings.json 与 mimo/grok 的真实存储在探针后按字节恢复。',
    ],
  };
  const reportTarget = reportPath ? path.resolve(reportPath) : path.join(repository, 'docs/verification/memory/native-replay-report.json');
  const summaryTarget = summaryPath ? path.resolve(summaryPath) : path.join(repository, 'docs/verification/memory/SUMMARY.md');
  await fs.mkdir(path.dirname(reportTarget), { recursive: true });
  await fs.writeFile(reportTarget, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(summaryTarget, renderSummary(report));
  for (const item of replays) console.log(`${item.tool}: ${item.result}`);
  console.log(`Report: ${reportTarget}`);
  console.log(`Summary: ${summaryTarget}`);
  if (!sourceStable) console.error('Product inputs changed during execution; rerun against a stable candidate.');
  if (missing.length) console.error(`Published-memory tools without a replay recipe: ${missing.join(', ')}`);
  await fs.rm(temporary, { recursive: true, force: true });
  return { report, reportTarget, summaryTarget, exitCode: !sourceStable || failed.length || missing.length ? 1 : strict && unverified.length ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('node scripts/verify-memory-native.mjs [--only claude_code,codex] [--report path.json] [--summary path.md] [--strict]\nReplays the native-effect verification for every CLI whose memory entry the production registry publishes, then refreshes docs/verification/memory. Exit 1: failed check or unstable source; --strict exits 2 when a CLI is unavailable.');
  } else {
    try {
      const only = value('--only')?.split(',').map(item => item.trim()).filter(Boolean);
      const result = await verifyMemoryNative({ only, report: value('--report'), summary: value('--summary'), strict: args.includes('--strict') });
      process.exitCode = result.exitCode;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
