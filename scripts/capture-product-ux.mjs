/** Capture the product matrix with synthetic IPC; this is not native acceptance. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(process.env.CLIORA_PRODUCT_CAPTURE_OUT ?? path.join(root, 'docs/verification/product-ui-ux'));
const buildDirectory = path.resolve(root, process.env.CLIORA_PRODUCT_BUILD_OUT ?? 'dist');
const uiAreas = ['home', 'projects', 'connections', 'features', 'quota', 'plugins', 'agents', 'skills', 'mcp', 'prompts', 'rules', 'records', 'sessions', 'remote-hosts', 'write-recovery'];
const allScenes = [
  { id: 'pages', script: 'capture-ui.mjs', args: ['--quick', '--only', 'tools,library,settings'], manifest: 'capture-ui-manifest.json' },
  ...uiAreas.map(id => ({ id, script: 'capture-ui.mjs', args: [`--${id}`], manifest: `capture-ui-${id}-manifest.json` })),
  { id: 'rule-results', script: 'capture-library-rule-results.mjs', args: [], manifest: 'capture-rule-results-manifest.json' },
  ...['workbench', 'memory', 'sync'].map(id => ({ id, script: `capture-${id}.mjs`, args: [], manifest: `capture-${id}-manifest.json` })),
];
const sceneNames = allScenes.map(scene => scene.id);
if (process.argv.includes('--list')) {
  console.log(sceneNames.join('\n'));
  process.exit(0);
}
if (!fs.existsSync(path.join(buildDirectory, 'index.html'))) throw new Error('Run npm run build before capturing the product.');
const onlyIndex = process.argv.indexOf('--only');
const requested = onlyIndex < 0 ? sceneNames : (process.argv[onlyIndex + 1] ?? '').split(',');
if (requested.some(id => !sceneNames.includes(id))) throw new Error(`--only accepts ${sceneNames.join(',')}`);
const scenes = allScenes.filter(scene => requested.includes(scene.id));
const option = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
};
const theme = option('--theme', 'all');
const size = option('--size', '1360');
const jobs = process.env.CLIORA_CAPTURE_JOBS ?? '2';
if (!/^[1-9]\d*$/.test(jobs)) throw new Error('CLIORA_CAPTURE_JOBS must be a positive integer.');
fs.mkdirSync(out, { recursive: true });
const port = await new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const address = reservation.address();
    reservation.close(error => error ? reject(error) : resolve(address.port));
  });
});
// strictPort prevents capturing an unrelated server if the released ephemeral port is taken.
const server = await preview({ root, build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port, strictPort: true, open: false } });
const url = `http://127.0.0.1:${port}`;
const completed = new Map();
const children = new Set();
let stopped = false;
const stop = () => {
  stopped = true;
  for (const child of children) child.kill();
  server.httpServer.closeAllConnections();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function captureArea(scene) {
  const directory = path.join(out, scene.id);
  fs.mkdirSync(directory, { recursive: true });
  const captureStarted = Date.now();
  const log = fs.createWriteStream(path.join(directory, 'capture.log'));
  const args = [path.join(root, 'scripts', scene.script), ...scene.args, '--theme', theme, '--size', size];
  if (scene.id === 'workbench' && process.argv.includes('--performance')) args.push('--performance');
  if (process.argv.includes('--full')) args.push('--full');
  console.log(`Capturing ${scene.id}: ${theme} × ${size}`);
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: { ...process.env, CLIORA_PREVIEW_URL: url, CLIORA_CAPTURE_OUT: directory, CLIORA_RULE_CAPTURE_OUT: directory, CLIORA_RULE_CAPTURE_BUILD_OUT: buildDirectory }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', error => log.write(`${error.message}\n`));
    child.once('close', code => { children.delete(child); resolve(code ?? 1); });
  });
  await new Promise(resolve => log.end(resolve));
  const failures = [];
  let imageCount = 0;
  try {
    const file = path.join(directory, scene.manifest);
    if (fs.statSync(file).mtimeMs < captureStarted) throw new Error('Capture did not write a fresh manifest.');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shots = manifest.captures ?? manifest.shots ?? [];
    failures.push(
      ...(manifest.failures ?? manifest.problems ?? []),
      ...(manifest.runErrors ?? []),
      ...shots.filter(shot => shot.pageErrors?.length || shot.overflow || shot.actionError),
    );
    failures.push(...(manifest.missing ?? []));
    imageCount = shots.filter(shot => fs.existsSync(path.join(directory, typeof shot === 'string' ? shot : shot.file ?? `${shot.name}.png`))).length;
    if (!imageCount || imageCount !== shots.length) failures.push({ type: 'manifest', message: `Captured ${imageCount} of ${shots.length} images.` });
  } catch (error) {
    failures.push({ type: 'manifest', message: error.message });
  }
  const success = exitCode === 0 && failures.length === 0;
  completed.set(scene.id, { scene: scene.id, exitCode, success, imageCount, failures, gallery: `${scene.id}/index.html`, log: `${scene.id}/capture.log` });
  console.log(`${scene.id}: ${success ? 'passed' : 'failed'} (${imageCount} images, ${failures.length} reported failures)`);
}

try {
  const queue = [...scenes];
  await Promise.all(Array.from({ length: Math.min(Number(jobs), queue.length) }, async () => {
    while (queue.length && !stopped) await captureArea(queue.shift());
  }));
} finally {
  for (const child of children) child.kill();
  server.httpServer.closeAllConnections();
  await new Promise(resolve => server.httpServer.close(resolve));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
const results = scenes.map(scene => completed.get(scene.id)).filter(Boolean);
const acceptance = { kind: 'playwright-synthetic-ipc', nativePlatform: 'unverified' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ acceptance, results }, null, 2));
fs.writeFileSync(path.join(out, 'README.md'), `# Product UI/UX captures\n\nSynthetic IPC only; native platform behavior is unverified.\n\n${results.map(result => `- [${result.scene}](${result.gallery}): ${result.success ? 'passed' : 'failed'} · [log](${result.log})`).join('\n')}\n`);
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Product UI/UX captures</title><style>body{max-width:720px;margin:48px auto;padding:0 24px;font:16px/1.6 system-ui}li{margin:12px 0}</style><h1>Product UI/UX captures</h1><p>合成 IPC 界面证据，原生平台行为未验证。</p><ul>${results.map(result => `<li><a href="${result.gallery}">${result.scene}</a> — ${result.success ? 'passed' : 'failed'} · <a href="${result.log}">log</a></li>`).join('')}</ul></html>`);
if (stopped || results.some(result => !result.success)) process.exitCode = 1;
