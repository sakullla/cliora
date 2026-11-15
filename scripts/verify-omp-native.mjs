/**
 * Isolated real-OMP lifecycle verification.
 *
 * The product adapter is exercised through the same registry the application
 * uses. Native observations run in temporary homes with an isolated BUN_INSTALL:
 * the user's `~/.bun`, `~/.omp` and global installation are never written.
 *
 * A fixture case is a declaration, never evidence. When no real `omp` can be
 * acquired the report is `completed_with_unverified` (exit 2); a failed product
 * assertion or a changed source tree exits 1.
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = 'tests/fixtures/omp';
const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
const OMP_BASELINE = '18.20.2';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Public product API only: the harness links the ordinary library build.
const harness = String.raw`
use cliora_lib::{adapters::{LaunchMode, Registry, omp::verify::{self, CaseContext, CaseError}}, native::adapter::{self, Scope}};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::collections::BTreeMap;

fn context(spec: &Value) -> CaseContext {
    CaseContext {
        home: PathBuf::from(spec["home"].as_str().unwrap_or_default()),
        project: PathBuf::from(spec["project"].as_str().unwrap_or_default()),
        executable: spec["executable"].as_str().map(PathBuf::from),
        environment: spec["environment"]
            .as_object()
            .map(|map| map.iter().filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned()))).collect())
            .unwrap_or_default(),
    }
}

fn read(path: &str) -> Result<Value, String> {
    serde_json::from_str(&std::fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn run() -> Result<Value, String> {
    let args: Vec<String> = std::env::args().collect();
    let registry = Registry::builtins();
    let omp = registry.get("omp").ok_or("omp 未注册")?;
    match args[1].as_str() {
        "catalog" => {
            let acceptance: BTreeMap<String, bool> = ["18.20.2", "18.20.3", "19.0.0", "20.3.1", "v20.3.1", "19.0.0-beta.1", "invalid"]
                .iter()
                .map(|version| (version.to_string(), omp.history_resume_version_supported(version)))
                .collect();
            Ok(json!({
                "catalog": verify::catalog(),
                "descriptor": omp.descriptor(),
                "launch": {
                    "plain": omp.launch_args(None, LaunchMode::Normal),
                    "session": omp.launch_args(Some("ses_01H"), LaunchMode::Normal),
                    "latest": omp.resume_latest_args(LaunchMode::Normal),
                    "yolo": omp.launch_args(None, LaunchMode::Yolo).is_err(),
                },
                "versionAcceptance": acceptance,
            }))
        }
        "probe" => {
            let spec = read(&args[2])?;
            let home = PathBuf::from(spec["home"].as_str().ok_or("missing home")?);
            let probed = adapter::probe_registered(
                &registry,
                "omp",
                spec["path"].as_str().map(Path::new),
                &home,
                None,
                Scope::Global,
            )?;
            Ok(serde_json::to_value(probed).map_err(|error| error.to_string())?)
        }
        "fixture" => {
            let spec = read(&args[2])?;
            let capability = spec["capability"].as_str().ok_or("missing capability")?;
            let case = spec.get("case").ok_or("missing case")?;
            let context = context(&spec["context"]);
            match verify::run_case(capability, case, &context) {
                Ok(value) => {
                    let passed = value["result"]["passed"].as_bool().unwrap_or(true);
                    if !passed {
                        let failed: Vec<String> = value["result"]["checks"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|check| check["passed"].as_bool() == Some(false))
                            .map(|check| format!("{} ({})", check["name"], check["detail"]))
                            .collect();
                        eprintln!("FAILED:{}", failed.join("; "));
                        std::process::exit(1)
                    }
                    Ok(value)
                }
                Err(CaseError::Unverified(reason)) => {
                    eprintln!("UNVERIFIED:{reason}");
                    std::process::exit(2)
                }
                Err(CaseError::Failed(reason)) => {
                    eprintln!("FAILED:{reason}");
                    std::process::exit(1)
                }
            }
        }
        other => Err(format!("unknown harness command {other}")),
    }
}

fn main() {
    match run() {
        Ok(value) => println!("{}", value),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
}
`;

export function isolatedEnvironment(home, temporary, bunRoot) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    CI: '1',
    // Bun's documented relocation variables. Both stay inside the temporary
    // tree, so a global install and its cache never touch the user's home.
    BUN_INSTALL: bunRoot,
    BUN_INSTALL_CACHE_DIR: path.join(bunRoot, 'cache'),
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 60_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ command, args, exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

async function requireSuccess(command, args, options) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.slice(-4000)}`);
  }
  return result;
}

async function fingerprint() {
  const listing = await requireSuccess('git', [
    'ls-files', '-co', '--exclude-standard', '-z', '--',
    'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
    'src/adapters', 'src/assets/tools', 'tests/fixtures/omp',
    'scripts/verify-omp-native.mjs',
  ]);
  const entries = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
  const files = [];
  for (const ref of entries) files.push({ ref, sha256: sha256(await fs.readFile(path.join(repository, ref))) });
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function executableOnPath(names) {
  const directories = (process.env.PATH ?? '').split(path.delimiter);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

/** Bun is only the runtime used to prepare an isolated install. */
export async function resolveBun(explicit) {
  if (explicit) return (await fs.access(explicit).then(() => explicit, () => null));
  if (process.env.CLIORA_BUN) return (await fs.access(process.env.CLIORA_BUN).then(() => process.env.CLIORA_BUN, () => null));
  return executableOnPath(process.platform === 'win32' ? ['bun.exe', 'bun.cmd'] : ['bun']);
}

async function resolveOmp() {
  return executableOnPath(process.platform === 'win32' ? ['omp.exe', 'omp.cmd'] : ['omp']);
}

/** Every `tests/fixtures/omp/<capability>/*.json` case, sorted. */
export async function fixtureCases(root = repository) {
  const base = path.join(root, fixtureRoot);
  const directories = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const cases = [];
  for (const directory of directories.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!directory.isDirectory()) continue;
    const files = (await fs.readdir(path.join(base, directory.name))).filter(name => name.endsWith('.json')).sort();
    for (const name of files) {
      const ref = path.join(fixtureRoot, directory.name, name).replaceAll('\\', '/');
      const fixture = JSON.parse(await fs.readFile(path.join(base, directory.name, name), 'utf8'));
      cases.push({ ref, directory: directory.name, fixture });
    }
  }
  return cases;
}

// The `windows` crate family ships its import libraries inside the
// windows_<arch>_msvc registry crates; a manual rustc link needs them on the
// native search path (cargo passes this through the crate `links` directive).
function cargoNativeLibDirs() {
  if (process.platform !== 'win32') return [];
  const registry = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'registry', 'src');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const directories = [];
  for (const hash of existsSync(registry) ? readdirSync(registry) : []) {
    const hashDirectory = path.join(registry, hash);
    for (const entry of existsSync(hashDirectory) ? readdirSync(hashDirectory) : []) {
      if (!entry.startsWith(`windows_${arch}_msvc-`)) continue;
      const library = path.join(hashDirectory, entry, 'lib');
      if (existsSync(library)) directories.push(library);
    }
  }
  return directories;
}

async function buildHarness(temporary) {
  const build = await requireSuccess('cargo', [
    'build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--message-format=json',
  ], { timeout: 900_000 });
  const artifacts = build.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(item => item?.reason === 'compiler-artifact');
  const library = artifacts.findLast(item => item.target.name === 'cliora_lib')?.filenames.find(ref => ref.endsWith('.rlib'));
  const jsonLibrary = artifacts.findLast(item => item.target.name === 'serde_json')?.filenames.find(ref => ref.endsWith('.rlib'));
  if (!library || !jsonLibrary) throw new Error('Cargo did not report product/JSON library artifacts');
  const source = path.join(temporary, 'omp-harness.rs');
  const binary = path.join(temporary, process.platform === 'win32' ? 'omp-harness.exe' : 'omp-harness');
  await fs.writeFile(source, harness);
  const nativeFlags = cargoNativeLibDirs().flatMap(directory => ['-L', `native=${directory}`]);
  await requireSuccess('rustc', [
    '--edition=2021', '--crate-name', 'cliora_omp_verification', source,
    '-L', `dependency=${path.dirname(jsonLibrary)}`, ...nativeFlags,
    '--extern', `cliora_lib=${library}`, '--extern', `serde_json=${jsonLibrary}`,
    '-o', binary,
  ], { timeout: 180_000 });
  return binary;
}

async function harnessJson(binary, args, environment) {
  const result = await run(binary, args, { env: { ...process.env, ...environment }, timeout: 120_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `harness exited ${result.exitCode}`);
  return JSON.parse(result.stdout);
}

async function probe(binary, environment, home, candidate) {
  const spec = path.join(path.dirname(home), 'probe.json');
  await fs.writeFile(spec, JSON.stringify({ home, path: candidate }));
  return harnessJson(binary, ['probe', spec], environment);
}

function observationOf(probeResult, pathValue) {
  const installations = probeResult.installations ?? [];
  const selected = installations.find(item => item.path === probeResult.selectedPath) ?? installations[0] ?? null;
  return {
    path: pathValue,
    selectedPath: probeResult.selectedPath ?? null,
    installations: installations.map(item => ({ path: item.path, version: item.version, source: item.source, status: item.status, detail: item.detail })),
    source: selected?.source ?? null,
    version: selected?.version ?? null,
    status: selected?.status ?? null,
  };
}

async function fakeIdentity(binary, temporary, environment) {
  // Product behaviour only: a file named `omp` that answers without OMP identity
  // must not be reported as an available installation. Its own empty home/Bun
  // root keeps a successful isolated install out of the observation.
  const directory = path.join(temporary, 'fake-identity');
  await fs.mkdir(directory, { recursive: true });
  const fakeHome = path.join(directory, 'home');
  await fs.mkdir(fakeHome, { recursive: true });
  const fakeBun = path.join(directory, 'bun');
  await fs.mkdir(path.join(fakeBun, 'bin'), { recursive: true });
  const fakeEnvironment = isolatedEnvironment(fakeHome, directory, fakeBun);
  const candidate = path.join(directory, process.platform === 'win32' ? 'omp.ps1' : 'omp');
  if (process.platform === 'win32') {
    await fs.writeFile(candidate, "Write-Output 'not-an-omp 18.20.2'\n");
  } else {
    await fs.writeFile(candidate, '#!/bin/sh\necho not-an-omp 18.20.2\n');
    await fs.chmod(candidate, 0o755);
  }
  const probed = await probe(binary, fakeEnvironment, fakeHome, candidate);
  return { ...observationOf(probed, candidate), installations: (probed.installations ?? []).map(item => ({ path: item.path, version: item.version, source: item.source, status: item.status, detail: item.detail })) };
}

export async function verifyOmpNative({ output, offline = false, bun, strict = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cliora-omp-native-'));
  const home = path.join(temporary, 'home');
  const project = path.join(temporary, 'project');
  const bunRoot = path.join(temporary, 'bun');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(path.join(bunRoot, 'bin'), { recursive: true });
  const environment = isolatedEnvironment(home, temporary, bunRoot);
  const before = await fingerprint();
  const binary = await buildHarness(temporary);
  const catalog = await harnessJson(binary, ['catalog'], environment);

  const cases = [];
  for (const item of await fixtureCases()) {
    const { ref, fixture } = item;
    if (!fixture || typeof fixture.capability !== 'string' || typeof fixture.case !== 'object' || fixture.case === null) {
      cases.push({ ref, capability: item.directory, name: fixture?.name ?? ref, result: 'failed', reason: 'fixture 缺少 capability/case' });
      continue;
    }
    const spec = path.join(temporary, `case-${cases.length}.json`);
    await fs.writeFile(spec, JSON.stringify({
      capability: fixture.capability,
      case: fixture.case,
      context: { home, project, environment },
    }));
    const result = await run(binary, ['fixture', spec], { env: { ...process.env, ...environment }, timeout: 60_000 });
    if (result.exitCode === 0) {
      let checks = null;
      try { checks = JSON.parse(result.stdout); } catch {}
      cases.push({ ref, capability: fixture.capability, name: fixture.name ?? ref, result: 'passed', checks });
    } else if (result.exitCode === 2) {
      cases.push({ ref, capability: fixture.capability, name: fixture.name ?? ref, result: 'unverified', reason: result.stderr.replace(/^UNVERIFIED:/, '').trim() });
    } else {
      cases.push({ ref, capability: fixture.capability, name: fixture.name ?? ref, result: 'failed', reason: result.stderr.replace(/^FAILED:/, '').trim() || `exit ${result.exitCode}` });
    }
  }

  const bunPath = await resolveBun(bun);
  const bunVersion = bunPath ? await run(bunPath, ['--version'], { env: { ...process.env, ...environment } }) : null;
  const native = {
    bun: {
      path: bunPath,
      version: bunVersion?.stdout.trim() || null,
      detail: bunPath ? null : '未找到 Bun 可执行文件；OMP 的隔离安装与真实 CLI 证据无法准备',
    },
    install: { state: 'not_attempted', reason: null, output: null },
    candidate: null,
    sourceLabel: null,
    standalone: null,
    bunUpdate: null,
    ompUpdate: null,
    bunRemove: null,
    versionCommand: null,
    help: null,
    resumeContract: { state: 'unverified', reason: '未运行交互式 TUI，仅核对 CLI 帮助文本与启动参数' },
    upgrade: { state: 'source-aware', reason: '按检测来源选择命令：Bun 用 bun update，原生用 omp update；未知来源不执行也不切换' },
    hostOmp: null,
    fakeIdentity: null,
  };

  if (offline) {
    native.install = { state: 'skipped', reason: '--offline：不访问包来源', output: null };
  } else if (!bunPath) {
    native.install = { state: 'unavailable', reason: native.bun.detail, output: null };
  } else {
    const installTimeout = Number(process.env.CLIORA_OMP_INSTALL_TIMEOUT_MS ?? 300_000);
    const install = await run(bunPath, ['install', '-g', `${OMP_PACKAGE}@${OMP_BASELINE}`], {
      cwd: project,
      env: { ...process.env, ...environment },
      timeout: Number.isFinite(installTimeout) && installTimeout > 0 ? installTimeout : 300_000,
    }).catch(error => ({ exitCode: -1, stdout: '', stderr: `隔离安装失败：${error.message}` }));
    native.install = {
      state: install.exitCode === 0 && !install.timedOut ? 'succeeded' : 'failed',
      reason: install.exitCode === 0 && !install.timedOut
        ? null
        : install.timedOut
          ? `隔离安装超时（${Math.round((Number(process.env.CLIORA_OMP_INSTALL_TIMEOUT_MS ?? 300_000)) / 1000)} 秒），包来源不可达或网络受限；未改用其他安装来源`
          : (install.stderr.trim() || install.stdout.trim()).slice(-4000) || `bun exited ${install.exitCode}`,
      output: `${install.stdout}${install.stderr}`.slice(-8000),
    };
  }

  if (native.install.state === 'succeeded') {
    const binDirectory = path.join(bunRoot, 'bin');
    const names = await fs.readdir(binDirectory).catch(() => []);
    const preferred = process.platform === 'win32' ? ['omp.exe', 'omp.cmd', 'omp.ps1', 'omp'] : ['omp'];
    const found = preferred.find(name => names.includes(name)) ?? names.find(name => /^omp(\.|$)/i.test(name));
    const candidatePath = found ? path.join(binDirectory, found) : path.join(binDirectory, process.platform === 'win32' ? 'omp.exe' : 'omp');
    const exists = Boolean(found) && await fs.access(candidatePath).then(() => true, () => false);
    if (!exists) {
      native.install = { ...native.install, state: 'failed', reason: `Bun 安装结束但未找到隔离二进制：${candidatePath}` };
    } else {
      const version = await run(candidatePath, ['--version'], { env: { ...process.env, ...environment }, timeout: 120_000 });
      native.versionCommand = { exitCode: version.exitCode, stdout: version.stdout.trim(), stderr: version.stderr.trim() };
      native.candidate = observationOf(await probe(binary, environment, home, candidatePath), candidatePath);
      native.sourceLabel = {
        expected: 'bun',
        actual: native.candidate.source,
        passed: native.candidate.source === 'bun',
        reason: native.candidate.source === 'bun' ? null : '真实 Bun 全局安装未被共享 probe 标为 bun',
      };
      if (version.exitCode === 0) {
        const help = await run(candidatePath, ['--help'], { env: { ...process.env, ...environment }, timeout: 120_000 });
        const text = `${help.stdout}\n${help.stderr}`;
        native.help = {
          exitCode: help.exitCode,
          resume: /(^|\s)(-r,\s*)?--resume(=|\s|$)/m.test(text),
          continue: /(^|\s)(-c,\s*)?--continue(\s|$)/m.test(text),
          piSessionFlag: /(^|\s)--session(\s|=|$)/m.test(text),
          head: text.trim().slice(0, 1600),
        };
        native.resumeContract = native.help.resume && native.help.continue && !native.help.piSessionFlag
          ? { state: 'contract_verified', reason: '帮助文本声明 --resume/--continue，且没有 Pi 的 --session <id>；交互式恢复未执行' }
          : { state: 'unverified', reason: '帮助文本未同时确认 OMP 的 --resume/--continue 与缺少 Pi 的 --session <id>' };
      }

      // Copy the same executable outside the package layout: the standalone
      // (precompiled) channel must stay `native`. A copy that cannot run away
      // from its install tree is reported unverified, never assumed.
      const standaloneDirectory = path.join(temporary, 'standalone');
      await fs.mkdir(standaloneDirectory, { recursive: true });
      const standalonePath = path.join(standaloneDirectory, path.basename(candidatePath));
      await fs.copyFile(candidatePath, standalonePath);
      const standaloneRun = await run(standalonePath, ['--version'], { env: { ...process.env, ...environment }, timeout: 120_000 });
      if (standaloneRun.exitCode === 0) {
        const observation = observationOf(await probe(binary, environment, home, standalonePath), standalonePath);
        native.standalone = {
          state: observation.source === 'native' ? 'verified' : 'failed',
          path: standalonePath,
          versionCommand: { exitCode: standaloneRun.exitCode, stdout: standaloneRun.stdout.trim(), stderr: standaloneRun.stderr.trim() },
          probe: observation,
          reason: observation.source === 'native' ? null : `复制后的同一二进制未被标为 native，而是 ${observation.source}`,
        };
      } else {
        native.standalone = {
          state: 'unverified',
          path: standalonePath,
          versionCommand: { exitCode: standaloneRun.exitCode, stdout: standaloneRun.stdout.trim(), stderr: standaloneRun.stderr.trim() },
          probe: null,
          reason: '同一 omp 二进制无法脱离 Bun 安装目录运行，预编译来源未验证',
        };
      }

      // Real channel-preserving updates. Failures are recorded with the actual
      // command output and never reported as success or a source switch.
      const bunUpdate = await run(bunPath, ['update', '-g', OMP_PACKAGE], {
        cwd: project, env: { ...process.env, ...environment }, timeout: 300_000,
      });
      native.bunUpdate = {
        command: `bun update -g ${OMP_PACKAGE}`,
        exitCode: bunUpdate.exitCode,
        timedOut: bunUpdate.timedOut,
        stdout: bunUpdate.stdout.trim().slice(-2000),
        stderr: bunUpdate.stderr.trim().slice(-2000),
      };
      if (bunUpdate.exitCode === 0) {
        native.candidateAfterUpdate = observationOf(await probe(binary, environment, home, candidatePath), candidatePath);
        native.bunUpdate.source = native.candidateAfterUpdate.source;
      }
      const ompUpdate = await run(candidatePath, ['update'], { env: { ...process.env, ...environment }, timeout: 180_000 });
      native.ompUpdate = {
        command: 'omp update',
        exitCode: ompUpdate.exitCode,
        timedOut: ompUpdate.timedOut,
        stdout: ompUpdate.stdout.trim().slice(-2000),
        stderr: ompUpdate.stderr.trim().slice(-2000),
      };

      // Isolated uninstall: the adapter declares `bun remove -g`, and the real
      // command must remove only this isolated installation.
      const bunRemove = await run(bunPath, ['remove', '-g', OMP_PACKAGE], {
        cwd: project, env: { ...process.env, ...environment }, timeout: 300_000,
      });
      const remaining = await fs.readdir(path.join(bunRoot, 'bin')).catch(() => []);
      native.bunRemove = {
        command: `bun remove -g ${OMP_PACKAGE}`,
        exitCode: bunRemove.exitCode,
        timedOut: bunRemove.timedOut,
        stdout: bunRemove.stdout.trim().slice(-2000),
        stderr: bunRemove.stderr.trim().slice(-2000),
        remainingOmp: remaining.filter(name => /^omp(\.|$)/i.test(name)),
      };
    }
  }

  const hostOmp = await resolveOmp();
  if (hostOmp) {
    const version = await run(hostOmp, ['--version'], { env: { ...process.env, ...environment }, timeout: 120_000 });
    native.hostOmp = {
      executable: hostOmp,
      versionCommand: { exitCode: version.exitCode, stdout: version.stdout.trim(), stderr: version.stderr.trim() },
      probe: observationOf(await probe(binary, environment, home, hostOmp), hostOmp),
    };
  }

  const fake = await fakeIdentity(binary, temporary, environment);
  native.fakeIdentity = {
    status: fake.status,
    detail: fake.installations[0]?.detail ?? null,
    installations: fake.installations,
    rejected: fake.status !== 'available' && fake.installations.every(item => item.status !== 'available'),
  };

  const after = await fingerprint();
  const sourceStable = before.sha256 === after.sha256;
  const failed = cases.filter(item => item.result === 'failed');
  const nativeVerified = native.install.state === 'succeeded' || Boolean(native.hostOmp?.probe?.status === 'available');
  const unresolved = [];
  if (!nativeVerified) unresolved.push(native.install.reason ?? '没有可用的真实 omp 观察');
  if (native.sourceLabel && !native.sourceLabel.passed) unresolved.push(native.sourceLabel.reason);
  if (native.standalone?.state === 'unverified') unresolved.push(native.standalone.reason);
  if (native.standalone?.state === 'failed') unresolved.push(native.standalone.reason);
  if (native.bunUpdate && native.bunUpdate.exitCode !== 0) unresolved.push('Bun 更新未成功，已记录真实命令输出');
  if (native.ompUpdate && native.ompUpdate.exitCode !== 0) unresolved.push('omp update 未成功，已记录真实命令输出');
  if (native.bunRemove && native.bunRemove.remainingOmp?.length) unresolved.push('Bun 卸载后仍检测到 omp 文件');
  if (native.resumeContract.state !== 'contract_verified') unresolved.push(native.resumeContract.reason);
  unresolved.push('交互式 TUI 会话恢复未在本机执行；只核对了真实 --help 契约与启动参数');
  const report = {
    schemaVersion: 1,
    kind: 'isolated-omp-lifecycle',
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    source: after,
    sourceStable,
    catalog,
    cases,
    native,
    unresolved,
    result: !sourceStable || failed.length || !native.fakeIdentity.rejected
      || native.sourceLabel?.passed === false
      || native.standalone?.state === 'failed'
      ? 'failed'
      : 'completed_with_unverified',
    limits: [
      '真实 OMP 只在临时 home 与隔离 BUN_INSTALL 中准备；用户 ~/.bun、~/.omp 与全局安装不被读写。',
      'fixture 只是声明；没有真实 omp 时报告 completed_with_unverified，不以 fixture 冒充原生证据。',
      '未核实官方预编译下载地址与升级命令，因此这些动作不执行并保留原因，也不在来源之间切换。',
      '18.20.2 仅为展示基线；更新的普通版本默认接受，未逐版验证。',
      '交互式 TUI 恢复、macOS/Linux 与账号提供方未在本机执行。',
      'Bun install 需要包来源网络；失败时保留真实 stdout/stderr 尾部。',
      '复制同一 omp 二进制到独立目录验证 native 来源；若其无法脱离 Bun 安装树运行，记录为未验证而不是假定。',
    ],
  };
  const outputPath = output ? path.resolve(output) : path.join(temporary, 'result.json');
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const item of cases) console.log(`${item.ref}: ${item.result}${item.reason ? ` (${item.reason.slice(0, 160)})` : ''}`);
  console.log(`native: install=${native.install.state} candidate=${native.candidate?.source ?? 'none'} label=${native.sourceLabel?.actual ?? 'none'} standalone=${native.standalone?.state ?? 'none'} bunUpdate=${native.bunUpdate?.exitCode ?? 'none'} ompUpdate=${native.ompUpdate?.exitCode ?? 'none'} remove=${native.bunRemove?.exitCode ?? 'none'} host=${native.hostOmp ? 'found' : 'missing'} bun=${native.bun.version ?? 'missing'}`);
  console.log(`Report: ${outputPath}`);
  if (!sourceStable) console.error('Product inputs changed during execution; rerun against a stable candidate.');
  return {
    report,
    outputPath,
    exitCode: report.result === 'failed' ? 1 : strict && report.result !== 'passed' ? 2 : report.result === 'completed_with_unverified' ? 2 : 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const bunIndex = args.indexOf('--bun');
  if (args.includes('--help')) {
    console.log('node scripts/verify-omp-native.mjs [--output report.json] [--bun /path/to/bun] [--offline]\nBuilds the product offline, runs declared fixture cases against the real adapter, then prepares a real OMP only inside a temporary home/BUN_INSTALL. Exit 1: product assertion failed or source changed; exit 2: real OMP evidence unverified.');
  } else {
    try {
      if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a path');
      if (bunIndex >= 0 && !args[bunIndex + 1]) throw new Error('--bun requires a path');
      const result = await verifyOmpNative({
        output: outputIndex >= 0 ? args[outputIndex + 1] : undefined,
        bun: bunIndex >= 0 ? args[bunIndex + 1] : undefined,
        offline: args.includes('--offline'),
      });
      process.exitCode = result.exitCode;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

