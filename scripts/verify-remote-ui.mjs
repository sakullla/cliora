/** Fresh, isolated browser evidence; never controls a desktop Cliora window. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.env.CLIORA_REMOTE_UI_OUT ?? path.join(root, 'docs/verification/remote-workflow/ui'));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const theme = option('--theme', 'all');
const size = option('--size', 'all');
if (!['all', 'light', 'dark'].includes(theme) || !/^(all|(?:1360|900|640)(?:,(?:1360|900|640))*)$/.test(size)) throw new Error('Invalid capture matrix.');
const children = new Set();
const report = { schemaVersion: 1, synthetic: true, nativeAcceptance: 'unverified', status: 'failed', matrix: { theme, size }, runs: [], failures: [] };
let stopping = false;

function start(scriptArgs, env = {}) {
  const child = spawn(process.execPath, scriptArgs, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', () => children.delete(child));
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
}
async function run(scriptArgs, env) {
  const child = start(scriptArgs, env);
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${scriptArgs[0]} failed (${code ?? signal})`);
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [...children]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32') {
      // Only PIDs launched by this runner are ever passed to taskkill.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await once(killer, 'exit');
    } else child.kill('SIGTERM');
  }
}
const interrupt = () => { process.exitCode = 1; void stop(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await mkdir(output, { recursive: true });
  // Build through the same TypeScript/Vite entry used by npm run build.
  if (!args.includes('--skip-build')) {
    await run(['node_modules/typescript/bin/tsc', '-b']);
    await run(['node_modules/vite/bin/vite.js', 'build']);
  }
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const preview = start(['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
  const url = `http://127.0.0.1:${port}`;
  report.previewUrl = url;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (preview.exitCode !== null || stopping) throw new Error('Owned preview exited before capture.');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Owned preview did not become ready.');
  for (const [name, script, flags, manifestName] of [
    ['workbench', 'scripts/capture-workbench.mjs', [], 'capture-workbench-manifest.json'],
    ['hosts', 'scripts/capture-ui.mjs', ['--remote-hosts'], 'capture-ui-remote-hosts-manifest.json'],
    ['rules', 'scripts/capture-ui.mjs', ['--rules'], 'capture-ui-rules-manifest.json'],
    ['writes', 'scripts/capture-ui.mjs', ['--write-recovery'], 'capture-ui-write-recovery-manifest.json'],
  ]) {
    const directory = path.join(output, name);
    try {
      await run([script, ...flags, '--theme', theme, '--size', size], { CLIORA_PREVIEW_URL: url, CLIORA_CAPTURE_OUT: directory });
      const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
      const imageCount = manifest.imageCount ?? manifest.shots?.length ?? 0;
      const themes = theme === 'all' ? ['light', 'dark'] : [theme];
      const widths = size === 'all' ? [1360, 900, 640] : size.split(',').map(Number);
      const captures = manifest.captures ?? manifest.shots ?? [];
      if (themes.some(value => widths.some(width => !captures.some(shot => shot.theme === value && (shot.width === width || shot.viewport?.width === width))))) throw new Error(`${name}: incomplete theme/width matrix`);
      if (manifest.success !== true || manifest.failures?.length || manifest.missing?.length || manifest.runErrors?.length || manifest.shots?.some(shot => shot.pageErrors?.length || shot.overflow || shot.actionError) || !(imageCount > 0)) throw new Error(`${name}: capture errors, missing scenarios, or no images`);
      report.runs.push({ name, manifest: `${name}/${manifestName}`, imageCount, success: true });
    } catch (error) {
      report.failures.push({ name, message: error.message });
    }
  }
  if (report.failures.length) throw new Error('Remote UI capture checks failed.');
  report.status = 'passed';
} catch (error) {
  report.failures.push({ message: error.message }); process.exitCode = 1;
} finally {
  await stop();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'remote-ui-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Remote UI ${report.status}: ${output}`);
}
