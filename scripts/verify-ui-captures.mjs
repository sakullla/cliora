/**
 * One command for the UI capture acceptance run (02 ADR-7): build the frontend, serve it with
 * vite preview on 127.0.0.1:14736, run the four capture scripts over all themes and widths, then
 * stop the preview. Output goes to docs/verification/ui-redesign/<script>. Any failing script makes
 * the run exit non-zero and its failing scenarios are printed. Captures use synthetic IPC and are
 * not native platform acceptance.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 14736;
const previewUrl = `http://127.0.0.1:${port}`;
const outRoot = path.join(root, 'docs', 'verification', 'ui-redesign');
const matrix = ['--theme', 'all', '--size', 'all'];
const captures = [
  { script: 'capture-ui', args: [...matrix, '--measure'], manifest: 'capture-ui-manifest.json' },
  { script: 'capture-sync', args: matrix, manifest: 'capture-sync-manifest.json' },
  { script: 'capture-workbench', args: matrix, manifest: 'capture-workbench-manifest.json' },
  { script: 'capture-memory', args: matrix, manifest: 'capture-memory-manifest.json' },
];

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
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
  if (script === 'capture-workbench') return data.shots.filter((item) => item.pageErrors.length || item.overflow || item.actionError).map((item) => `${item.name}: ${item.actionError ?? (item.pageErrors.length ? `page error ${item.pageErrors[0]}` : `overflow ${JSON.stringify(item.overflow)}`)}`);
  if (script === 'capture-memory') return data.problems;
  return (data.failures ?? []).map((item) => typeof item === 'string' ? item : describe(item));
}

if (await reachable()) {
  console.error(`${previewUrl} 已有服务在运行；请先停止它，本命令需要独占端口 ${port} 提供当前构建。`);
  process.exit(1);
}

console.log('> build: tsc -b && vite build');
if (await run(['node_modules/typescript/bin/tsc', '-b']) !== 0 || await run(['node_modules/vite/bin/vite.js', 'build']) !== 0) {
  console.error('前端构建失败，未运行截图。');
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
  for (const { script, args, manifest } of captures) {
    const out = path.join(outRoot, script);
    // Each run replaces its own output so stale images from earlier runs are not reported as current.
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    console.log(`> ${script} ${args.join(' ')} → ${path.relative(root, out)}`);
    const code = await run([`scripts/${script}.mjs`, ...args], { CLIORA_PREVIEW_URL: previewUrl, CLIORA_CAPTURE_OUT: out.replace(/\\/g, '/') });
    const failing = code === 0 ? [] : failingScenarios(script, path.join(out, manifest));
    results.push({ script, code, failing });
  }
} catch (error) {
  console.error(error.message);
  results.push({ script: 'preview', code: 1, failing: [error.message] });
} finally {
  stopPreview();
}

console.log('\n截图验收结果（合成 IPC，仅浏览器界面检查，不是原生平台验收）：');
for (const { script, code, failing } of results) {
  console.log(`- ${script}: ${code === 0 ? '通过' : `失败（退出码 ${code}）`}`);
  for (const item of failing) console.log(`    ${item}`);
}
const failed = results.filter((item) => item.code !== 0);
if (failed.length || results.length < captures.length) process.exitCode = 1;
