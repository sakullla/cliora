/** Capture immutable source provenance and fixed inputs before comparing runs.
 * Use the same native verifier --phase measure against isolated old/new builds.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const reference = option('--ref', 'd6a2011');
const output = path.resolve(option('--out', 'docs/verification/remote-workflow/baseline'));
if (!/^[a-zA-Z0-9._/-]+$/.test(reference) || reference.startsWith('-')) throw new Error('Invalid baseline reference.');
const commit = execFileSync('git', ['rev-parse', '--verify', `${reference}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const files = ['src-tauri/src/launch.rs', 'src-tauri/src/database.rs', 'src-tauri/src/session_host.rs', 'src/features/sessions/SessionWorkbench.tsx', 'src/features/remote/RemoteProjectDialog.tsx', 'src-tauri/src/remote/mod.rs', 'src-tauri/src/history/remote_native.rs'];
await mkdir(output, { recursive: true });
const sources = [];
for (const file of files) {
  const content = execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, windowsHide: true });
  const destination = path.join(output, 'sources', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
  sources.push({ file, sha256: createHash('sha256').update(content).digest('hex') });
}
await writeFile(path.join(output, 'baseline.json'), `${JSON.stringify({
  schemaVersion: 1, commit, capturedAt: new Date().toISOString(), sources,
  fixedScenarios: ['same-target-directory-tool-new-A-B-C', 'index-reopen-exact-reattach', 'end-only-B', 'directory-tool-config-cold-warm', 'offline-target-does-not-block-other-target', 'cancel-obsolete-read', 'write-accepted-then-disconnected'],
  status: 'source_provenance_only',
  measurementProtocol: 'Build this immutable commit in an isolated temporary checkout with a dedicated Tauri identifier. Run the same native verifier and input dataset against baseline and candidate. Record OS/CLI/multiplexer/network/data sizes and repeated samples. Source capture is not a performance measurement.',
}, null, 2)}\n`);
console.log(`Captured immutable baseline ${commit.slice(0, 12)}; performance has not been measured.`);
if (args.includes('--measure')) {
  const config = option('--config', process.env.CLIORA_REMOTE_TEST_CONFIG);
  if (!config) throw new Error('--measure requires an isolated native configuration.');
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/verify-remote-native.mjs'), '--phase', 'measure', '--config', config, '--out', path.join(output, 'native')], { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}
