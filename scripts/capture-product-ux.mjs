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
if (!fs.existsSync(path.join(buildDirectory, 'index.html'))) throw new Error('Run npm run build before capturing the product.');
const allScenes = [
  { id: 'pages', script: 'capture-ui.mjs', args: ['--quick'] },
  { id: 'home', script: 'capture-ui.mjs', args: ['--home'] },
  { id: 'workbench', script: 'capture-workbench.mjs', args: [] },
  { id: 'memory', script: 'capture-memory.mjs', args: [] },
  { id: 'sync', script: 'capture-sync.mjs', args: [] },
];
const onlyIndex = process.argv.indexOf('--only');
const requested = onlyIndex < 0 ? allScenes.map(scene => scene.id) : (process.argv[onlyIndex + 1] ?? '').split(',');
if (requested.some(id => !allScenes.some(scene => scene.id === id))) throw new Error('--only accepts pages,home,workbench,memory,sync');
const scenes = allScenes.filter(scene => requested.includes(scene.id));
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
const results = [];
let child;
let stopped = false;
const stop = () => { stopped = true; child?.kill(); server.httpServer.closeAllConnections(); server.httpServer.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  for (const scene of scenes) {
    if (stopped) break;
    const directory = path.join(out, scene.id);
    fs.mkdirSync(directory, { recursive: true });
    const log = fs.createWriteStream(path.join(directory, 'capture.log'));
    const args = [path.join(root, 'scripts', scene.script), ...scene.args, '--theme', 'all', '--size', '1360,900,640'];
    console.log(`Capturing ${scene.id}: light/dark × 1360/900/640`);
    const exitCode = await new Promise(resolve => {
      child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: { ...process.env, CLIORA_PREVIEW_URL: url, CLIORA_CAPTURE_OUT: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('error', error => { log.write(`${error.message}\n`); resolve(1); });
      child.once('close', code => resolve(code ?? 1));
    });
    await new Promise(resolve => log.end(resolve));
    child = undefined;
    const manifests = fs.readdirSync(directory).filter(name => /^capture-.*manifest\.json$/.test(name));
    const failures = manifests.flatMap(name => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        return [
          ...(manifest.failures ?? manifest.problems ?? []),
          ...(manifest.runErrors ?? []),
          ...(manifest.shots ?? []).filter(shot => shot.pageErrors?.length || shot.overflow || shot.actionError),
        ];
      }
      catch (error) { return [{ type: 'manifest', message: error.message }]; }
    });
    if (!manifests.length) failures.push({ type: 'manifest', message: 'Capture did not produce a manifest.' });
    const success = exitCode === 0 && failures.length === 0;
    results.push({ scene: scene.id, exitCode, success, failures, gallery: `${scene.id}/index.html`, log: `${scene.id}/capture.log` });
    console.log(`${scene.id}: ${success ? 'passed' : 'failed'} (${failures.length} reported failures)`);
  }
} finally {
  child?.kill();
  server.httpServer.closeAllConnections();
  await new Promise(resolve => server.httpServer.close(resolve));
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
const acceptance = { kind: 'playwright-synthetic-ipc', nativePlatform: 'unverified' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ acceptance, results }, null, 2));
fs.writeFileSync(path.join(out, 'README.md'), `# Product UI/UX captures\n\nSynthetic IPC only; native platform behavior is unverified.\n\n${results.map(result => `- [${result.scene}](${result.gallery}): ${result.success ? 'passed' : 'failed'} · [log](${result.log})`).join('\n')}\n`);
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Product UI/UX captures</title><style>body{max-width:720px;margin:48px auto;padding:0 24px;font:16px/1.6 system-ui}li{margin:12px 0}</style><h1>Product UI/UX captures</h1><p>合成 IPC 界面证据，原生平台行为未验证。</p><ul>${results.map(result => `<li><a href="${result.gallery}">${result.scene}</a> — ${result.success ? 'passed' : 'failed'} · <a href="${result.log}">log</a></li>`).join('')}</ul></html>`);
if (stopped || results.some(result => !result.success)) process.exitCode = 1;
