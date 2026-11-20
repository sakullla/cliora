/** Build and run the curated product gallery. --full runs the archived compatibility matrix. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runStarted = Date.now();
const args = process.argv.slice(2);
const full = args.includes('--full');
const port = 14736;
const previewUrl = `http://127.0.0.1:${port}`;
const outRoot = path.join(root, 'docs', 'verification', 'ui-redesign');
const themes = ['light', 'dark'];
// The native minimum width 720 is the default compatibility edge. 640 stays
// an explicit opt-in sweep (CLIORA_CAPTURE_640=1). All four galleries share it.
const desktopWidths = [1360, 900, 720];
const compat640 = process.env.CLIORA_CAPTURE_640 === '1' || process.argv.includes('--compat-640');
const widths = compat640 ? [...desktopWidths, 640] : desktopWidths;
// Independent capture jobs share the one preview server. Two at a time by default: at four, CPU
// contention on a loaded host pushed Playwright waits past 30 s. CLIORA_CAPTURE_JOBS (integer ≥ 1)
// overrides it. Each job covers one theme × width of one script and writes to
// docs/verification/ui-redesign/<script>/<theme>-<width>; only capture-ui light/1360 measures.
const jobsSetting = process.env.CLIORA_CAPTURE_JOBS;
if (jobsSetting !== undefined && !/^[1-9]\d*$/.test(jobsSetting.trim())) {
  console.error(`CLIORA_CAPTURE_JOBS 必须是不小于 1 的整数，当前为 "${jobsSetting}"。`);
  process.exit(1);
}
const poolSize = jobsSetting === undefined ? 2 : Number(jobsSetting.trim());
const scripts = ['capture-ui', 'capture-sync', 'capture-workbench', 'capture-memory'];
const jobs = scripts.flatMap((script) => themes.flatMap((theme) => widths.map((width) => ({
  script,
  label: `${theme}-${width}`,
  args: ['--theme', theme, '--size', String(width), ...(script === 'capture-ui' ? [] : ['--full']), ...(script === 'capture-ui' && theme === 'light' && width === 1360 ? ['--measure'] : [])],
  manifest: `${script}-manifest.json`,
}))));

function run(args, env = {}, logFile = null) {
  return new Promise((resolve, reject) => {
    const log = logFile ? fs.openSync(logFile, 'w') : null;
    const child = spawn(process.execPath, args, { cwd: root, stdio: log === null ? 'inherit' : ['ignore', log, log], windowsHide: true, env: { ...process.env, ...env } });
    child.on('error', (error) => { if (log !== null) fs.closeSync(log); reject(error); });
    child.on('close', (code, signal) => { if (log !== null) fs.closeSync(log); resolve(code ?? (signal ? 1 : 0)); });
  });
}

async function reachable() {
  try { return (await fetch(previewUrl, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

// Names of failing scenarios from each script's own manifest; the shapes differ per script.
function failingScenarios(script, file) {
  if (!fs.existsSync(file)) return ['(no manifest written)'];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const describe = (item) => [item.type, item.name ?? item.after, item.theme, item.width, item.message ?? (item.over ? `overflow ${JSON.stringify(item.over).slice(0, 160)}` : item.missing ? `missing ${item.missing.map((entry) => `${entry.name}/${entry.theme}/${entry.width}`).join(', ')}` : '')].filter((part) => part !== undefined && part !== '').join(' ');
  if (script === 'capture-workbench') return [...(data.runErrors ?? []).map((message) => `run: ${message}`), ...data.shots.filter((item) => item.pageErrors.length || item.overflow || item.actionError).map((item) => `${item.name}: ${item.actionError ?? (item.pageErrors.length ? `page error ${item.pageErrors[0]}` : `overflow ${JSON.stringify(item.overflow)}`)}`)];
  if (script === 'capture-memory') return data.problems;
  return (data.failures ?? []).map((item) => typeof item === 'string' ? item : describe(item));
}

if (args.includes('--list')) process.exit(await run(['scripts/capture-product-ux.mjs', '--list']));

if (!args.includes('--skip-build')) {
  console.log('> build: tsc -b && vite build');
  if (await run(['node_modules/typescript/bin/tsc', '-b']) !== 0 || await run(['node_modules/vite/bin/vite.js', 'build']) !== 0) {
    console.error('前端构建失败，未运行截图。');
    process.exit(1);
  }
}

if (!full) {
  const code = await run(['scripts/capture-product-ux.mjs', ...args.filter(arg => arg !== '--skip-build')]);
  console.log(`总耗时 ${Math.round((Date.now() - runStarted) / 1000)} s`);
  process.exit(code);
}
if (await reachable()) {
  console.error(`${previewUrl} 已有服务在运行；请先停止它，本命令需要独占端口 ${port} 提供当前构建。`);
  process.exit(1);
}

console.log(`> preview: vite preview --host 127.0.0.1 --port ${port} --strictPort`);
const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
let previewExit = null;
preview.on('close', (code) => { previewExit = code ?? 1; });
const stopPreview = () => { if (previewExit === null) preview.kill(); };
process.on('SIGINT', () => { stopPreview(); process.exit(130); });
process.on('SIGTERM', () => { stopPreview(); process.exit(143); });

const results = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 150 && previewExit === null; attempt += 1) {
    if (await reachable()) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(previewExit === null ? `vite preview 30 秒内未就绪：${previewUrl}` : `vite preview 提前退出（退出码 ${previewExit}）`);
  // Each run replaces its own output so stale images from earlier runs are not reported as current.
  for (const script of scripts) fs.rmSync(path.join(outRoot, script), { recursive: true, force: true });
  console.log(`> ${jobs.length} capture jobs, ${poolSize} at a time → ${path.relative(root, outRoot)}/<script>/<theme>-<width> (log in job.log)`);
  const started = Date.now();
  const runJob = async ({ script, label, args, manifest }) => {
    const out = path.join(outRoot, script, label);
    fs.mkdirSync(out, { recursive: true });
    const jobStart = Date.now();
    let code;
    try {
      code = await run([`scripts/${script}.mjs`, ...args], { CLIORA_PREVIEW_URL: previewUrl, CLIORA_CAPTURE_OUT: out.replace(/\\/g, '/') }, path.join(out, 'job.log'));
    } catch (error) {
      code = 1;
      fs.appendFileSync(path.join(out, 'job.log'), `\n${error.message}\n`);
    }
    let failing = [];
    if (code !== 0) {
      try { failing = failingScenarios(script, path.join(out, manifest)); } catch (error) { failing = [`(manifest unreadable: ${error.message})`]; }
      if (!failing.length) failing = [`(no failing scenario in manifest; see ${path.relative(root, path.join(out, 'job.log'))})`];
    }
    console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'} ${script} ${args.join(' ')} (${Math.round((Date.now() - jobStart) / 1000)} s)`);
    results.push({ script, label, code, failing });
  };
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(poolSize, queue.length) }, async () => {
    while (queue.length) await runJob(queue.shift());
  }));
  console.log(`> captures finished in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.error(error.message);
  results.push({ script: 'preview', label: '', code: 1, failing: [error.message] });
} finally {
  stopPreview();
}

console.log('\n截图验收结果（合成 IPC，仅浏览器界面检查，不是原生平台验收）：');
for (const script of scripts) {
  const own = results.filter((item) => item.script === script);
  const bad = own.filter((item) => item.code !== 0);
  const passed = own.length === jobs.filter((job) => job.script === script).length && !bad.length;
  console.log(`- ${script}: ${passed ? '通过' : own.length ? `失败（${bad.length}/${own.length} 组非零退出）` : '未运行'}`);
  for (const { label, code, failing } of bad) {
    console.log(`  ${label}（退出码 ${code}）`);
    for (const item of failing) console.log(`    ${item}`);
  }
}
for (const { failing } of results.filter((item) => item.script === 'preview')) for (const item of failing) console.log(`- preview: ${item}`);
const failed = results.filter((item) => item.code !== 0);
console.log(`\n总耗时 ${Math.round((Date.now() - runStarted) / 1000)} s（构建、预览与 ${jobs.length} 组截图，${poolSize} 组并行）`);
if (failed.length || results.length < jobs.length) process.exitCode = 1;
