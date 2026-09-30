import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeTests = readdirSync(new URL('../tests/native/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/native/${name}`);
const started = performance.now();
for (const [label, executable, args] of [
  ['Rust units', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--', '--test-threads=8']],
  ['Node units', process.execPath, ['--test', ...nodeTests]],
]) {
  const start = performance.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('close', resolve);
  });
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(2)}s (includes compilation if needed)`);
  if (code !== 0) process.exit(Number(code ?? 1));
}
console.log(`All unit suites: ${((performance.now() - started) / 1000).toFixed(2)}s`);
