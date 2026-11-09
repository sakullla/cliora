import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function newest(directory) {
  return Math.max(0, ...readdirSync(directory, { withFileTypes: true }).map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? newest(target) : statSync(target).mtimeMs;
  }));
}
async function spawnRun(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
    child.on('error', reject); child.on('close', resolve);
  });
}
async function run(args) {
  const code = await spawnRun(args, {});
  if (code !== 0) process.exit(Number(code ?? 1));
}
const artifact = path.join(root, 'dist/index.html');
const sourceTime = Math.max(newest(path.join(root, 'src')), ...['index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json'].map(name => statSync(path.join(root, name)).mtimeMs));
if (!existsSync(artifact) || statSync(artifact).mtimeMs < sourceTime) {
  await run(['node_modules/typescript/bin/tsc', '-b']);
  await run(['node_modules/vite/bin/vite.js', 'build']);
}

// ADR-7: bounded retries only for the proven environment failure class. The local
// preview under parallel load intermittently drops page requests with
// net::ERR_NO_BUFFER_SPACE (Windows + TUN proxy); those runs recorded 1-2 distinct
// failures per full pass that pass on an immediate re-run. Product failures never
// re-run, never get their assertion messages rewritten, and nothing is skipped:
// only tests whose recorded failure text matches the environment signature below
// are re-invoked at most once, and the retry count and category stay on stdout.
const ENV_CLASS = /net::ERR_NO_BUFFER_SPACE/;
function reportFile(name) {
  return path.join(mkdtempSync(path.join(tmpdir(), 'cliora-test-ui-')), `${name}.json`);
}
function failedTests(report) {
  const out = [];
  // spec.file is relative to config.rootDir (the testDir); CLI selectors need the
  // path relative to the repo root the runner is spawned with.
  const rootDir = report.config?.rootDir ? path.relative(root, report.config.rootDir).replace(/\\/g, '/') : 'tests/ui';
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = (test.results ?? []).at(-1);
        if (!last || last.status !== 'failed') continue;
        const text = (last.errors ?? []).map(error => typeof error === 'string' ? error : `${error?.message ?? ''}\n${error?.stack ?? ''}`).join('\n');
        const line = test.location?.line ?? spec.line ?? 1;
        out.push({ selector: `${rootDir}/${spec.file}:${line}`, env: ENV_CLASS.test(text) });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}
function readReport(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const userArgs = process.argv.slice(2);
// Respect an explicit reporter choice: the environment retry needs our JSON report.
const useReporter = !userArgs.some(arg => arg.startsWith('--reporter'));
const start = performance.now();
let code;
if (!useReporter) {
  code = await spawnRun(['node_modules/@playwright/test/cli.js', 'test', ...userArgs], {});
} else {
  const first = reportFile('pass1');
  code = await spawnRun(['node_modules/@playwright/test/cli.js', 'test', ...userArgs, '--reporter=list,json'], { PLAYWRIGHT_JSON_OUTPUT_NAME: first });
  const report = code !== 0 ? readReport(first) : null;
  const failed = report ? failedTests(report) : [];
  const envFailures = failed.filter(item => item.env);
  const productFailures = failed.length - envFailures.length;
  if (envFailures.length) {
    console.log(`[env-retry] category=net::ERR_NO_BUFFER_SPACE count=${envFailures.length} product_failures=${productFailures} bounded_reruns=1 tests=${envFailures.map(item => item.selector).join(', ')}`);
    const second = reportFile('pass2');
    const rerun = await spawnRun(['node_modules/@playwright/test/cli.js', 'test', ...userArgs, '--reporter=list,json', ...envFailures.map(item => item.selector)], { PLAYWRIGHT_JSON_OUTPUT_NAME: second });
    const rerunReport = readReport(second);
    const rerunRan = (rerunReport?.stats?.expected ?? 0) + (rerunReport?.stats?.unexpected ?? 0) + (rerunReport?.stats?.flaky ?? 0);
    if (rerunRan < envFailures.length) {
      console.log(`[env-retry] rerun matched ${rerunRan}/${envFailures.length} tests; keeping the original failure`);
    } else {
      const stillFailed = rerunReport ? failedTests(rerunReport).filter(item => item.env).length : envFailures.length;
      console.log(`[env-retry] rerun done: ${envFailures.length - stillFailed}/${envFailures.length} environment failures cleared`);
      // Product failures from pass 1 must keep the run red even if the rerun passed.
      code = productFailures > 0 ? (code ?? 1) : rerun;
    }
  }
}
console.log(`Browser suite: ${((performance.now() - start) / 1000).toFixed(2)}s (build preparation excluded)`);
process.exit(Number(code ?? 1));
