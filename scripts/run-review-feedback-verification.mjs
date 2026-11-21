/**
 * Rebuild the Cliora ↔ Twiglane review roundtrip gallery in one command.
 *
 * It starts both frontends itself, hands the real URLs to capture-review-roundtrip.mjs and stops
 * them again, so a failed run never leaves a preview server behind. Everything it captures comes
 * from synthetic IPC and synthetic deep links: this is not native scheme, file ACL or PTY evidence.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const twiglaneRoot = path.resolve(process.env.CLIORA_TWIGLANE_REPO ?? path.join(root, '..', 'Twiglane-lightweight-task-workbench'));
const out = path.resolve(process.env.CLIORA_ROUNDTRIP_OUT ?? path.join(root, 'docs/verification/lightweight-task-workbench-roundtrip'));
const buildDirectory = path.join(root, 'dist');
const theme = process.env.CLIORA_ROUNDTRIP_THEME ?? 'all';

if (!fs.existsSync(path.join(buildDirectory, 'index.html'))) {
  throw new Error('Cliora build is missing: run npm run build before the roundtrip capture.');
}
if (!fs.existsSync(path.join(twiglaneRoot, 'package.json'))) {
  throw new Error('Twiglane checkout not found at ' + twiglaneRoot + '; set CLIORA_TWIGLANE_REPO to its worktree.');
}

const freePort = () => new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const { port } = reservation.address();
    reservation.close((error) => (error ? reject(error) : resolve(port)));
  });
});

const ready = async (url, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.ok || response.status === 304) return;
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Preview did not answer in time: ' + url);
};

const port = await freePort();
// strictPort keeps a released port from being taken by something else between reservation and use.
const clioraServer = await preview({ root, build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port, strictPort: true, open: false } });
const clioraUrl = 'http://127.0.0.1:' + port;

let twiglaneChild = null;
const stop = () => {
  if (twiglaneChild && twiglaneChild.exitCode === null) twiglaneChild.kill();
  twiglaneChild = null;
  clioraServer.httpServer.closeAllConnections();
};
process.once('SIGINT', stop);

try {
  let twiglaneUrl = process.env.CLIORA_TWIGLANE_URL ?? '';
  if (!twiglaneUrl) {
    if (!fs.existsSync(path.join(twiglaneRoot, 'node_modules'))) {
      throw new Error('Twiglane preview needs its dependencies: run npm --prefix ' + twiglaneRoot + ' ci, or set CLIORA_TWIGLANE_URL to a running preview:ui.');
    }
    const twiglanePort = await freePort();
    twiglaneUrl = 'http://127.0.0.1:' + twiglanePort;
    twiglaneChild = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'preview:ui', '--', '--port', String(twiglanePort), '--strictPort'],
      { cwd: twiglaneRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    twiglaneChild.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }
  await Promise.all([ready(clioraUrl + '/'), ready(twiglaneUrl + '/')]);

  fs.mkdirSync(out, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'scripts/capture-review-roundtrip.mjs'), '--cliora', clioraUrl, '--twiglane', twiglaneUrl, '--out', out, '--theme', theme], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  const code = await new Promise((resolve) => child.once('exit', (value, signal) => resolve(value ?? (signal ? 1 : 0))));
  if (code !== 0) throw new Error('capture-review-roundtrip.mjs exited with ' + code);

  for (const name of ['manifest.json', 'index.html']) {
    if (!fs.existsSync(path.join(out, name))) throw new Error('Roundtrip capture did not write ' + name);
  }
  const report = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  console.log(JSON.stringify({
    out,
    captures: report.captures?.length ?? 0,
    pageErrors: report.pageErrors?.length ?? 0,
    nativePlatform: 'unverified',
    note: 'Synthetic IPC and deep links only; real scheme, file ACL and PTY writes are Delivery evidence.',
  }, null, 2));
} finally {
  stop();
  await new Promise((resolve) => clioraServer.httpServer.close(resolve));
}
