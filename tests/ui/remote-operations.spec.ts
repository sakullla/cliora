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

test('remote records retain a readable source and display the specific failed source', async ({ page }) => {
  await page.addInitScript(() => {
    const host = { id: 'history-host', name: '历史主机', host: '203.0.113.24', port: 22, user: 'fixture', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 };
    localStorage.setItem('cliora:remote-target', host.id);
    const tools = [{ id: 'codex', name: 'Codex' }, { id: 'claude_code', name: 'Claude Code' }];
    const facets = { state: 'available', reason: '' };
    const session = { id: 'remote-native:history-host:codex:fixture', toolId: 'codex', nativeId: 'fixture', title: '成功来源的对话', cwd: '/fixture', model: null, projectId: null, startedAt: 1, updatedAt: 2, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 };
    const totals = { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: null, unpricedTokens: 0 };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map(tool => tool.id), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered: tools.map(tool => ({ ...tool, interfaceFormats: [], launchForm: 'terminal', nativeConfig: facets, launch: facets, resume: facets, resources: facets, history: facets })), managedIds: tools.map(tool => tool.id), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_native_history_snapshot') return { sessions: [session], sourceFailures: [{ toolId: 'claude_code', message: 'fixture source permission failure', remote: null }] };
          if (command === 'get_remote_native_history') return { session, messages: [{ id: 'message', role: 'user', text: '成功来源的正文', timestamp: 2 }], usage: [], children: [], totals, resumeReason: null };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '使用记录内容' }).getByText('成功来源的对话', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Claude Code: fixture source permission failure')).toBeVisible();
  await expect(page.getByText('成功来源的正文')).toBeVisible();
  await expect(page.getByText('已刷新当前主机的使用记录。', { exact: true })).toHaveCount(0);
});
