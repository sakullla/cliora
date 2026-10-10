/** Self-contained browser verification. Synthetic IPC is not native acceptance. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PLAYWRIGHT_PORT ?? '14731');
const url = `http://127.0.0.1:${port}`;
const out = process.env.CLIORA_CAPTURE_OUT ?? path.join(root, 'docs/verification/resource-experience');
const extra = process.argv.slice(2).filter(arg => arg !== '--skip-build');
async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`${args[0]} exited ${code}`);
}
await mkdir(out, { recursive: true });
if (!process.argv.includes('--skip-build')) {
  await run(['node_modules/typescript/bin/tsc', '-b']);
  await run(['node_modules/vite/bin/vite.js', 'build']);
}
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'pipe', windowsHide: true });
let failure;
server.on('error', error => { failure = error; });
server.on('exit', code => { failure = new Error(`Preview exited ${code}`); });
server.stderr.on('data', data => process.stderr.write(data));
const started = performance.now();
try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (failure) throw failure;
    try { ready = (await fetch(url, { signal: AbortSignal.timeout(500) })).ok; } catch { /* wait for own preview */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready || failure) throw failure ?? new Error('Preview did not become ready');
  await run(['scripts/capture-ui.mjs', '--resources', ...extra], { ...process.env, CLIORA_PREVIEW_URL: url, CLIORA_CAPTURE_OUT: out });
  console.log(JSON.stringify({ synthetic: true, nativeAcceptance: false, fixture: { mcp: 500, skills: 500, delayedStateMs: 120, failedItem: 'skill-002' }, platform: os.platform(), release: os.release(), node: process.version, cpus: os.cpus().length, elapsedSeconds: (performance.now() - started) / 1000, output: out }, null, 2));
} finally { server.kill(); }
