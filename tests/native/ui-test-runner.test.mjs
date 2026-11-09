import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadApp } from '../ui/loadApp.ts';

function runReporterScenario(first, args = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'cliora-runner-regression-'));
  try {
    for (const dir of ['scripts', 'src', 'dist', 'node_modules/@playwright/test']) mkdirSync(path.join(root, dir), { recursive: true });
    copyFileSync(new URL('../../scripts/test-ui.mjs', import.meta.url), path.join(root, 'scripts/test-ui.mjs'));
    for (const file of ['src/index.ts', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json', 'dist/index.html']) {
      const target = path.join(root, file);
      writeFileSync(target, '');
      utimesSync(target, 1, file === 'dist/index.html' ? 2 : 1);
    }
    writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(first));
    writeFileSync(path.join(root, 'node_modules/@playwright/test/cli.js'), `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const retry = fs.existsSync('calls.json');
      const calls = retry ? JSON.parse(fs.readFileSync('calls.json')) : [];
      calls.push(args); fs.writeFileSync('calls.json', JSON.stringify(calls));
      const report = retry ? { suites: [], errors: [], stats: { expected: 1, unexpected: 0, flaky: 0 } } : JSON.parse(fs.readFileSync('scenario.json'));
      report.config = { rootDir: require('node:path').join(process.cwd(), 'tests/ui') };
      fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
      process.exit(retry ? 0 : 1);
    `);
    const result = spawnSync(process.execPath, ['scripts/test-ui.mjs', 'tests/ui/sample.spec.ts', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    return { status: result.status, calls: JSON.parse(readFileSync(path.join(root, 'calls.json'), 'utf8')), output: result.stdout + result.stderr };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const failedReport = (errors, extra = {}) => ({
  errors: [], stats: { unexpected: 1, flaky: 0 },
  suites: [{ specs: [{ file: 'sample.spec.ts', line: 7, tests: [{ results: [{ status: 'failed', errors }] }] }] }],
  ...extra,
});
const network = { message: 'page.goto: net::ERR_NO_BUFFER_SPACE' };

test('environment retry preserves valued options and replaces only the failed selectors', () => {
  const options = ['--output', '.vite/results', '--retries', '0', '--repeat-each', '1', '--max-failures', '3', '--global-timeout', '30000', '-j', '1'];
  const result = runReporterScenario(failedReport([network]), options);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls[1], ['test', ...options, '--reporter=list,json', 'tests/ui/sample.spec.ts:7']);
});

test('global errors, mixed product errors and flaky failures cannot be cleared by an environment retry', () => {
  for (const report of [
    failedReport([network], { errors: [{ message: 'globalTeardown failed' }] }),
    failedReport([network, { message: 'product assertion failed' }]),
    failedReport([network], { stats: { unexpected: 1, flaky: 1 } }),
    failedReport([]),
  ]) {
    const result = runReporterScenario(report);
    assert.equal(result.status, 1, result.output);
    assert.equal(result.calls.length, 1);
  }
});

test('an unknown CLI option keeps the failed run instead of silently losing its value', () => {
  const result = runReporterScenario(failedReport([network]), ['--future-option', 'value']);
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 1);
});

test('app startup retries only a network failure, never a missing app shell', async () => {
  let navigations = 0;
  const failure = new Error('app shell did not mount after a product error');
  await assert.rejects(loadApp({
    goto: async () => { navigations++; },
    getByRole: () => ({ waitFor: async () => { throw failure; } }),
  }), error => error === failure);
  assert.equal(navigations, 1);
  navigations = 0;
  await loadApp({
    goto: async () => { if (++navigations === 1) throw new Error('net::ERR_NO_BUFFER_SPACE'); },
    getByRole: () => ({ waitFor: async () => {} }),
  });
  assert.equal(navigations, 2);
});
