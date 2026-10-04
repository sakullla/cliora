import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function newest(directory) {
  return Math.max(0, ...readdirSync(directory, { withFileTypes: true }).map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? newest(target) : statSync(target).mtimeMs;
  }));
}
async function run(args) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('close', resolve);
  });
  if (code !== 0) process.exit(Number(code ?? 1));
}
const artifact = path.join(root, 'dist/index.html');
const sourceTime = Math.max(newest(path.join(root, 'src')), ...['index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json'].map(name => statSync(path.join(root, name)).mtimeMs));
if (!existsSync(artifact) || statSync(artifact).mtimeMs < sourceTime) {
  await run(['node_modules/typescript/bin/tsc', '-b']);
  await run(['node_modules/vite/bin/vite.js', 'build']);
}
const start = performance.now();
await run(['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)]);
console.log(`Browser suite: ${((performance.now() - start) / 1000).toFixed(2)}s (build preparation excluded)`);
