import path from 'node:path';

const ENV_CLASS = /net::ERR_NO_BUFFER_SPACE/;
const FAILURE_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);
export function failedTests(report, root) {
  const out = [];
  // spec.file is relative to config.rootDir (the testDir); CLI selectors need the
  // path relative to the repo root the runner is spawned with.
  const rootDir = report.config?.rootDir ? path.relative(root, report.config.rootDir).replace(/\\/g, '/') : 'tests/ui';
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = (test.results ?? []).at(-1);
        if (!last || !FAILURE_STATUSES.has(last.status)) continue;
        const errors = (last.errors ?? []).map(error => typeof error === 'string' ? error : `${error?.message ?? ''}\n${error?.stack ?? ''}`);
        const line = test.location?.line ?? spec.line ?? 1;
        out.push({ selector: `${rootDir}/${spec.file}:${line}`, env: errors.length > 0 && errors.every(error => ENV_CLASS.test(error)) });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}
// Playwright ORs positional file/line filters, so re-passing the caller's selectors on the
// rerun would also re-run product failures. Keep flags, drop positional args, and select
// exactly the environment-class failures instead.
export function flagArgs(args) {
  const valueFlags = new Set(['--add-reporter', '--browser', '-c', '--config', '--global-timeout', '-g', '--grep', '-G', '--grep-invert',
    '--last-failed-file', '--max-failures', '--output', '--repeat-each', '--reporter', '--retries', '--run-agents', '--shard',
    '--test-list', '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host', '--ui-port', '--update-source-method', '-j', '--workers']);
  const switches = new Set(['--fail-on-flaky-tests', '--forbid-only', '--fully-parallel', '--headed', '--ignore-snapshots', '--last-failed',
    '--list', '--no-deps', '--pass-with-no-tests', '--quiet', '--ui', '-x']);
  const optional = new Set(['--debug', '--only-changed', '-u', '--update-snapshots']);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0];
    // Unknown CLI options must not be silently rewritten on the retry.
    if (!valueFlags.has(name) && !switches.has(name) && !optional.has(name) && name !== '--project') return null;
    out.push(arg);
    if (arg.includes('=')) continue;
    if (name === '--project') {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) out.push(args[++i]);
    } else if (valueFlags.has(name)) {
      if (i + 1 >= args.length) return null;
      out.push(args[++i]);
    } else if (optional.has(name) && i + 1 < args.length && !args[i + 1].startsWith('-')) out.push(args[++i]);
  }
  return out;
}

export function retryPlan(report, args, root) {
  const failed = report ? failedTests(report, root) : [];
  const envFailures = failed.filter(item => item.env);
  const productFailures = failed.length - envFailures.length + (report?.errors?.length ?? 0) + (report?.stats?.flaky ?? 0);
  const retryFlags = flagArgs(args);
  return envFailures.length && productFailures === 0 && retryFlags !== null ? { envFailures, productFailures, retryFlags } : null;
}
