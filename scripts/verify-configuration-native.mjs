/** Offline native configuration probes. CLI semantics belong to registry-selected adapter modules. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// This harness calls the product registry, draft editor, persistence and protected apply.
// It never instantiates SystemCredentialStore or reads the user's database/native files.
const harness = String.raw`
use cliora_lib::{adapters::Registry, credentials::CredentialStore, database::Database,
    native::{adapter::Scope, configuration, format, profile::{self,RegisteredProfile},apply}};
use serde_json::{json,Value};
use std::{collections::BTreeMap,path::Path,sync::Mutex};
#[derive(Default)] struct MemoryCredentials(Mutex<BTreeMap<String,String>>);
impl CredentialStore for MemoryCredentials {
    fn put(&self,id:&str,value:&str)->Result<(),String>{self.0.lock().unwrap().insert(id.into(),value.into());Ok(())}
    fn get(&self,id:&str)->Result<String,String>{self.0.lock().unwrap().get(id).cloned().ok_or("missing synthetic credential".into())}
    fn delete(&self,id:&str)->Result<(),String>{self.0.lock().unwrap().remove(id);Ok(())}
}
fn run()->Result<Value,String>{
    let args:Vec<String>=std::env::args().collect();let registry=Registry::builtins();
    if args[1]=="catalog" {return Ok(json!(registry.iter().filter_map(|a| {
        a.configuration()?.native_verification_module().map(|module|json!({"tool":a.id(),"command":a.command(),"npmPackage":a.npm_package(),"moduleRef":module}))
    }).collect::<Vec<_>>()));}
    let directory=Path::new(&args[1]);let specs:Vec<Value>=serde_json::from_str(&std::fs::read_to_string(&args[2]).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let mut results=Vec::new();
    for spec in specs {
        let tool=spec["tool"].as_str().ok_or("missing registered tool")?;
        let adapter=registry.get(tool).ok_or("unregistered fixture")?;
        let home=directory.join(tool).join("home");let project=directory.join(tool).join("project");
        std::fs::create_dir_all(&home).map_err(|e|e.to_string())?;std::fs::create_dir_all(&project).map_err(|e|e.to_string())?;
        let db=Database::open(&directory.join(tool).join("synthetic.sqlite")).map_err(|e|e.to_string())?;
        let store=MemoryCredentials::default();
        let mut initial:RegisteredProfile=serde_json::from_value(json!({"id":"","tool":tool,"name":"Isolated native verification","version":0,"inheritCommon":false,"files":{},"connection":null,"nativeCredentials":{}})).map_err(|e|e.to_string())?;
        if let Some(documents)=spec["documents"].as_object(){for(role,document)in documents{initial.files.insert(role.clone(),format::render(adapter.file_kind(role)?,document)?);}}
        let mut draft=configuration::open(&registry,initial,Scope::Global,format!("native-verification-{tool}"))?;
        if let Some(actions)=spec["actions"].as_array(){for action in actions{draft=configuration::edit(&registry,draft,serde_json::from_value(action.clone()).map_err(|e|e.to_string())?)?;}}
        if !draft.issues.is_empty(){return Err(format!("{tool}: invalid product draft: {:?}",draft.issues));}
        if spec["managedSecret"]==true {
            let connection=draft.profile.connection.as_mut().ok_or("synthetic secret requires a connection")?;
            let id="connection-00000000-0000-4000-8000-000000000015";
            store.put(id,"synthetic-offline-native-verification")?;connection.secret_ref=Some(id.into());
            draft.profile.authentication=profile::ProfileAuthentication::ApiKey;
        }
        let native_files=adapter.native_files(Scope::Global,&home,Some(&project),true);
        for file in &native_files {if !Path::new(&file.path).starts_with(&home) && !Path::new(&file.path).starts_with(&project){return Err(format!("{tool}: adapter path escaped isolation"));}}
        let saved=profile::save_registered_profile(&db,&registry,draft.profile,None)?;
        let reopened=profile::get_registered_profile(&db,&saved.id)?;
        for file in &native_files{if Path::new(&file.path).exists(){return Err(format!("{tool}: save unexpectedly wrote native file"));}}
        let outcome=apply::apply_registered_validated(&registry,&db,&store,&reopened,None,&native_files,"global",Scope::Global,false)?;
        let mut files=Vec::new();
        for file in &native_files {
            if file.sensitive {continue;}
            if let Ok(text)=std::fs::read_to_string(&file.path){let parsed=format::parse(adapter.file_kind(file.role)?,&text)?;files.push(json!({"role":file.role,"path":file.path,"format":file.format,"document":parsed}));}
        }
        results.push(json!({"tool":tool,"home":home,"project":project,"profileId":saved.id,"profileVersion":saved.version,"profileRevision":saved.revision,"saveOnlyDidNotWrite":true,"applyOutcome":outcome,"files":files}));
    }
    Ok(json!(results))
}
fn main(){match run(){Ok(value)=>println!("{}",value),Err(error)=>{eprintln!("{}",error);std::process::exit(1)}}}
`;

function isolatedEnvironment(home, temporary) {
  return {
    PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    LANG: 'en_US.UTF-8', NO_COLOR: '1', CI: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9',
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repository, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 30_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (exitCode, signal) => { clearTimeout(timeout); resolve({ command, args, exitCode, signal, stdout, stderr }); });
  });
}

async function requireSuccess(command, args, options) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.slice(-6000)}`);
  return result;
}

async function fingerprint() {
  const listing = await requireSuccess('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'tests/fixtures/native', 'scripts/verify-configuration-native.mjs']);
  const entries = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
  const files = [];
  for (const ref of entries) files.push({ ref, sha256: sha256(await fs.readFile(path.join(repository, ref))) });
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function executable(command) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const target = path.join(directory, `${command}${suffix}`);
      try { await fs.access(target, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return await fs.realpath(target); } catch {}
    }
  }
  return null;
}

async function installedPackage(binary, expectedName) {
  if (!binary || !expectedName) return null;
  let directory = path.dirname(binary);
  for (;;) {
    try {
      const packagePath = path.join(directory, 'package.json');
      const info = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      if (info.name === expectedName) return { root: directory, name: info.name, version: info.version, packagePath };
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function verifyConfigurationNative({ output, strict = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cliora-native-configuration-'));
  const bootstrapHome = path.join(temporary, 'bootstrap-home'); await fs.mkdir(bootstrapHome);
  const before = await fingerprint();
  const build = await requireSuccess('cargo', ['build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--message-format=json'], { timeout: 600_000 });
  const artifacts = build.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(item => item?.reason === 'compiler-artifact');
  const library = artifacts.findLast(item => item.target.name === 'cliora_lib')?.filenames.find(ref => ref.endsWith('.rlib'));
  const jsonLibrary = artifacts.findLast(item => item.target.name === 'serde_json')?.filenames.find(ref => ref.endsWith('.rlib'));
  if (!library || !jsonLibrary) throw new Error('Cargo did not report product/JSON library artifacts');
  const source = path.join(temporary, 'native-harness.rs'); const binary = path.join(temporary, process.platform === 'win32' ? 'native-harness.exe' : 'native-harness');
  await fs.writeFile(source, harness);
  await requireSuccess('rustc', ['--edition=2021', '--crate-name', 'cliora_native_verification', source, '-L', `dependency=${path.dirname(jsonLibrary)}`, '--extern', `cliora_lib=${library}`, '--extern', `serde_json=${jsonLibrary}`, '-o', binary], { timeout: 120_000 });
  const env = isolatedEnvironment(bootstrapHome, temporary);
  const catalog = JSON.parse((await requireSuccess(binary, ['catalog'], { env })).stdout);
  // The redesign Recipe requires five CLI observations; never silently pass a partial registry export.
  if (catalog.length < 5) throw new Error('The configuration redesign requires at least five registry-declared native verification modules');
  const modules = [];
  for (const entry of catalog) {
    const ref = entry.moduleRef;
    if (!/^src-tauri\/src\/adapters\/[^/]+\/native_verification\.mjs$/.test(ref)) throw new Error(`Invalid adapter verifier ref: ${ref}`);
    const module = await import(pathToFileURL(path.join(repository, ref)).href);
    modules.push({ entry, module });
  }
  const specs = modules.map(({ entry, module }) => ({ tool: entry.tool, ...module.fixture }));
  const specsPath = path.join(temporary, 'synthetic-inputs.json'); await fs.writeFile(specsPath, JSON.stringify(specs));
  const applied = JSON.parse((await requireSuccess(binary, [temporary, specsPath], { env })).stdout);
  const observations = [];
  for (const { entry, module } of modules) {
    const application = applied.find(item => item.tool === entry.tool);
    for (const file of application.files) file.sha256 = sha256(await fs.readFile(file.path));
    const candidate = await executable(entry.command);
    const environment = { ...isolatedEnvironment(application.home, temporary), ...module.environment?.(application) };
    const nativeRun = (command, args, options = {}) => run(command, args, { env: environment, cwd: application.project, ...options });
    const version = candidate ? await nativeRun(candidate, ['--version']) : null;
    const packageInfo = await installedPackage(candidate, entry.npmPackage);
    const context = { application, candidate, packageInfo, environment, temporary, run: nativeRun, sha256, repository };
    let verification;
    try { verification = await module.verify(context); } catch (error) { verification = { level: 'unavailable', result: 'failed', reason: error.message }; }
    observations.push({ tool: entry.tool, moduleRef: entry.moduleRef, platform: `${process.platform}-${process.arch}`, command: entry.command, executable: candidate, versionDiscovery: version, installedPackage: packageInfo, application, verification });
  }
  const after = await fingerprint();
  const sourceStable = before.sha256 === after.sha256;
  const failed = observations.filter(item => item.verification.result === 'failed');
  const unverified = observations.filter(item => item.verification.result === 'unverified');
  const report = { schemaVersion: 1, kind: 'isolated-native-configuration', recordedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, nodeVersion: process.version, source: after, sourceStable, productLibrarySha256: sha256(await fs.readFile(library)), temporary, observations, result: !sourceStable || failed.length ? 'failed' : unverified.length ? 'completed_with_unverified' : 'passed', limits: ['Synthetic configuration save/apply and native acceptance are separate observations.', 'Loader/schema acceptance does not prove authentication, inference, hot reload or other platforms.', 'Version/help output is discovery only.', 'Proxy variables are defense in depth; only adapter-declared offline probes are run.'] };
  const outputPath = output ? path.resolve(output) : path.join(temporary, 'result.json'); await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const item of observations) console.log(`${item.tool}: ${item.verification.level} / ${item.verification.result} (${item.installedPackage?.version ?? item.versionDiscovery?.stdout.trim() ?? 'version unverified'})`);
  console.log(`Report: ${outputPath}`);
  if (!sourceStable) console.error('Product inputs changed during execution; rerun against a stable candidate.');
  return { report, outputPath, exitCode: !sourceStable || failed.length ? 1 : strict && unverified.length ? 2 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const outputIndex = args.indexOf('--output');
  if (args.includes('--help')) console.log('node scripts/verify-configuration-native.mjs [--output /tmp/report.json] [--strict]\nBuilds the current product offline, applies adapter fixtures in fresh temporary homes, then runs registry-declared offline verifiers. Exit 1: rejected config/unstable source; --strict exits 2 for unverified native combinations.');
  else {
    try {
      if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a path');
      const result = await verifyConfigurationNative({ output: outputIndex >= 0 ? args[outputIndex + 1] : undefined, strict: args.includes('--strict') }); process.exitCode = result.exitCode;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
