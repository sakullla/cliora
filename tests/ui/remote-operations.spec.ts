import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the production lifecycle with browser AbortSignal/timers. This is
// synthetic transport evidence; actual SSH acceptance is recorded separately.
const source = readFileSync('src/lib/remoteOperations.ts', 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

test('a cancelled browser subscription ignores its late result while another reader completes', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (code) => {
    const { RemoteOperations } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
    const calls: string[] = [];
    let finish!: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const operations = new RemoteOperations(async (name: string) => {
      calls.push(name);
      return name === 'cancel_remote_operation' ? true : pending;
    });
    const signal = new AbortController();
    const a = operations.start('list', { scope: 'project' }, 'a', 'read', { shareKey: 'resource', signal: signal.signal });
    const b = operations.start('list', { scope: 'project' }, 'a', 'read', { shareKey: 'resource' });
    signal.abort();
    const failure = await a.promise.catch((error: { reason: string }) => error.reason);
    finish('current');
    return { failure, current: await b.promise, calls };
  }, javascript);
  expect(result).toEqual({ failure: 'cancelled', current: 'current', calls: ['list'] });
});

test('a dispatched write keeps its native unknown result and recovery action', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (code) => {
    const { RemoteOperations } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
    const calls: string[] = [];
    let fail!: (error: unknown) => void;
    const pending = new Promise((_, reject) => { fail = reject; });
    const operations = new RemoteOperations(async (name: string) => {
      calls.push(name);
      return name === 'cancel_remote_operation' ? true : pending;
    });
    const handle = operations.start('save', {}, 'host', 'write');
    handle.cancel();
    fail({ code: 'remote_error', remote: { code: 'remote_unknown', stage: 'process_wait', reason: 'cancelled', outcome: 'unknown', action: '核查远端内容后再操作' } });
    return { failure: await handle.promise.catch((error: unknown) => error), calls };
  }, javascript);
  expect(result.calls).toEqual(['save', 'cancel_remote_operation']);
  expect(result.failure).toEqual({ code: 'remote_error', remote: { code: 'remote_unknown', stage: 'process_wait', reason: 'cancelled', outcome: 'unknown', action: '核查远端内容后再操作' } });
});
