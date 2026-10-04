import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeTests = readdirSync(new URL('../tests/native/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/native/${name}`);
const started = performance.now();
const threads = Math.min(16, Math.max(2, availableParallelism() * 2));
const results = await Promise.all([
  ['Rust units', 'cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--', `--test-threads=${threads}`]],
  ['Node units', process.execPath, ['--test', ...nodeTests]],
].map(async ([label, executable, args]) => {
  const start = performance.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('close', resolve);
  });
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(2)}s (includes compilation if needed)`);
  return Number(code ?? 1);
}));
console.log(`All unit suites: ${((performance.now() - started) / 1000).toFixed(2)}s`);
process.exitCode = results.find(code => code !== 0) ?? 0;
