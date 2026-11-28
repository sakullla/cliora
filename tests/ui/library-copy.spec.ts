import { installPromptFixtureBridge } from '../../scripts/capture-prompt-fixtures.mjs';
import { expect, test } from './sharedPage';

test.beforeEach(async ({ page }) => { await page.addInitScript(installPromptFixtureBridge); });

// The desktop webviews can refuse navigator.clipboard (WebKit does in the macOS app); copying the full
// text still succeeds through the copy command inside the click.
test('copying a prompt still works when the clipboard API is refused', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '示例提示词', body: '第一行说明\n第二行说明', category: '示例', projectId: null, version: 1, updatedAt: 1 }];
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Not allowed', 'NotAllowedError'); } } });
    const command = document.execCommand.bind(document);
    document.execCommand = (name: string, ...rest: unknown[]) => {
      if (name === 'copy') {
        const active = document.activeElement as HTMLTextAreaElement | null;
        copied.push(active?.value?.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0) ?? '');
      }
      return command(name, ...(rest as [boolean, string]));
    };
    Object.assign(window, {
      isTauri: true, __copied: copied,
      __TAURI_INTERNALS__: {
        invoke: async (name: string, args: Record<string, any> = {}) => {
          if (name === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (name === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
          if (name === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (name === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (name === 'get_tray_status') return { available: false, error: null };
          if (name.startsWith('plugin:event|')) return 1;
          if (name.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const card = page.getByRole('article').filter({ hasText: '示例提示词' });
  await card.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect(page.getByText('复制失败', { exact: false })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['第一行说明\n第二行说明']);
});

const longBody = [
  '第一行：说明这次改动影响的行为',
  '第二行：列出受影响的文件',
  '第三行：给出可以执行的建议',
  '第四行：标出还需要验证的风险',
  '结尾补充：'.repeat(40),
].join('\n');

// The card shows a two-line summary; the copy action must still hand over the whole body,
// and when both copy paths are refused the page has to say so instead of claiming success.
test('copying a prompt card copies the whole body and reports a refused copy as a failure', async ({ page }) => {
  await page.addInitScript((body) => {
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '多行提示词', body, category: '示例', projectId: null, version: 1, updatedAt: 1 }];
    const control = { refuse: true, body, copied: [] as string[] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Not allowed', 'NotAllowedError'); } } });
    const command = document.execCommand.bind(document);
    document.execCommand = (name: string, ...rest: unknown[]) => {
      if (name !== 'copy') return command(name, ...(rest as [boolean, string]));
      if (control.refuse) return false;
      const active = document.activeElement as HTMLTextAreaElement | null;
      control.copied.push(active?.value?.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0) ?? '');
      return true;
    };
    Object.assign(window, {
      isTauri: true, __copyControl: control,
      __TAURI_INTERNALS__: {
        invoke: async (name: string, args: Record<string, any> = {}) => {
          if (name === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (name === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
          if (name === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (name === 'get_launch_settings') return { selected: 'terminal', terminals: [] };
          if (name === 'get_tray_status') return { available: false, error: null };
          if (name.startsWith('plugin:event|')) return 1;
          if (name.startsWith('list_')) return [];
          return null;
        },
      },
    });
  }, longBody);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const card = page.getByRole('article').filter({ hasText: '多行提示词' });
  await expect(card.locator('[data-prompt-preview]')).toContainText('…');
  await card.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('复制失败');
  await expect(page.getByText('完整正文已复制，可以粘贴使用。')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '复制全文', exact: true })).toBeEnabled();
  await expect(card.locator('[data-copied="true"]')).toHaveCount(0);
  // The same action then succeeds with the whole multi-line body, not the card summary.
  await page.evaluate(() => { (window as unknown as { __copyControl: { refuse: boolean } }).__copyControl.refuse = false; });
  await card.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect(page.getByText('完整正文已复制，可以粘贴使用。')).toBeVisible();
  // The card marks the copied state on the same button (its accessible name stays 「复制全文」).
  await expect(card.locator('[data-copied="true"]')).toHaveCount(1);
  const copied = await page.evaluate(() => (window as unknown as { __copyControl: { copied: string[]; body: string } }).__copyControl);
  expect(copied.copied).toEqual([copied.body]);
  expect(copied.body.length).toBeGreaterThan(200);
  expect(copied.copied[0].split('\n')).toHaveLength(5);
});

// Launching from a card must show which CLI and workspace it will use, keep the edited
// message when the launch fails, and let the same dialog submit again.
test('a failed prompt launch keeps the edited message, its error and the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    const prompt = { id: 'prompt-1', kind: 'prompt', title: '审查改动', body: '请审查本次改动\n并说明风险', category: '开发', projectId: 'cliora', version: 1, updatedAt: 1 };
    const control = { fail: true, launches: [] as Array<Record<string, unknown>> };
    const facet = { state: 'available', reason: '' };
    Object.assign(window, {
      isTauri: true, __launchControl: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'kimi_code'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'kimi_code', name: 'Kimi Code' }] };
          if (command === 'list_cli_adapters') return { registered: [
            { id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal', yoloAvailable: false, nativeConfig: facet, launch: facet, resources: facet },
            { id: 'kimi_code', name: 'Kimi Code', interfaceFormats: [], launchForm: 'terminal', yoloAvailable: false, nativeConfig: facet, launch: facet, resources: facet },
          ], managedIds: ['codex', 'kimi_code'], preservedUnknown: [] };
          if (command === 'list_projects') return [
            { id: 'cliora', name: 'cliora', path: '/tmp/cliora', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
            { id: 'docs', name: 'docs', path: '/tmp/docs', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
          ];
          if (command === 'list_library_items') return args.kind === 'prompt' ? [prompt] : [];
          if (command === 'get_launch_settings') return { selected: 'terminal', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'launch_cli') {
            if (control.fail) throw new Error('终端没有打开');
            control.launches.push(args.request);
            return { toolId: args.request.toolId, projectId: args.request.projectId, mode: args.request.mode, terminal: 'auto', status: 'terminal_requested' };
          }
          if (command.startsWith('plugin:event|')) return 1;
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '用这条提示词启动' });
  // The launch target is visible before submitting: CLI, workspace and where it opens.
  await expect(dialog.getByRole('button', { name: '启动 CLI' })).toContainText('Codex');
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目' })).toContainText('cliora');
  await dialog.getByRole('button', { name: '启动 CLI' }).click();
  await page.getByRole('option', { name: /Kimi Code/ }).click();
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('option', { name: /docs/ }).click();
  await dialog.getByLabel('启动提示词').fill('请审查本次改动\n并说明风险\n只列出阻塞问题');
  await dialog.getByRole('button', { name: '在外部终端启动' }).click();
  await expect(dialog.getByRole('alert')).toContainText('终端没有打开');
  await expect(dialog.getByLabel('启动提示词')).toHaveValue('请审查本次改动\n并说明风险\n只列出阻塞问题');
  await expect(dialog.getByRole('button', { name: '启动 CLI' })).toContainText('Kimi Code');
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目' })).toContainText('docs');
  expect(await page.evaluate(() => (window as unknown as { __launchControl: { launches: unknown[] } }).__launchControl.launches)).toEqual([]);
  // Retry in the same dialog sends the edited message to the chosen CLI and workspace.
  await page.evaluate(() => { (window as unknown as { __launchControl: { fail: boolean } }).__launchControl.fail = false; });
  await dialog.getByRole('button', { name: '在外部终端启动' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已请求外部终端启动会话。')).toBeVisible();
  const request = await page.evaluate(() => (window as unknown as { __launchControl: { launches: Array<Record<string, unknown>> } }).__launchControl.launches);
  expect(request).toHaveLength(1);
  expect(request[0]).toMatchObject({ toolId: 'kimi_code', projectId: 'docs', initialPrompt: '请审查本次改动\n并说明风险\n只列出阻塞问题' });
});

// The agent picker exists only for CLIs that publish agentLaunchAvailable,
// lists the launchable main agents of the workspace and global scans (same-name
// duplicates, subagent-only, builtin and disabled rows excluded), and carries
// the selection on the launch request.
test('the launch dialog picks a roster agent only for CLIs that publish it', async ({ page }) => {
  await page.addInitScript(() => {
    const prompt = { id: 'prompt-1', kind: 'prompt', title: '审查改动', body: '请审查本次改动', category: '', projectId: 'cliora', version: 1, updatedAt: 1 };
    const control = { launches: [] as Array<Record<string, unknown>>, scans: [] as Array<Record<string, unknown>> };
    const facet = { state: 'available', reason: '' };
    const entry = (over: Record<string, unknown>) => ({ id: 'fixture', name: 'fixture', description: '', path: '/fixture/agents/fixture/agent.md', format: 'markdown', content: '', enabled: true, readOnly: false, builtin: false, owner: '独立定义', detail: '', ...over });
    Object.assign(window, {
      isTauri: true, __launchControl: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'antigravity'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'antigravity', name: 'Antigravity' }] };
          if (command === 'list_cli_adapters') return { registered: [
            { id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal', yoloAvailable: false, nativeConfig: facet, launch: facet, resources: facet },
            { id: 'antigravity', name: 'Antigravity', interfaceFormats: [], launchForm: 'terminal', yoloAvailable: false, agentLaunchAvailable: true, nativeConfig: facet, launch: facet, resources: facet },
          ], managedIds: ['codex', 'antigravity'], preservedUnknown: [] };
          if (command === 'list_projects') return [
            { id: 'cliora', name: 'cliora', path: '/tmp/cliora', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
          ];
          if (command === 'list_library_items') return args.kind === 'prompt' ? [prompt] : [];
          if (command === 'get_launch_settings') return { selected: 'terminal', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'scan_native_agents') {
            control.scans.push(args.target);
            const entries = args.target.scope === 'global' ? [
              entry({ id: 'g-main', name: 'global-main', description: '全局主代理', launchable: true }),
              entry({ id: 'g-sub', name: 'global-subagent', description: '全局子代理', launchable: false }),
            ] : [
              entry({ id: 'w-main', name: 'workspace-main', description: '工作区主代理', launchable: true }),
              entry({ id: 'w-dup', name: 'global-main', description: '工作区同名主代理', launchable: true }),
              entry({ id: 'w-builtin', name: 'default', description: '内置', builtin: true, launchable: true }),
              entry({ id: 'w-off', name: 'disabled-main', description: '已停用主代理', enabled: false, launchable: true }),
            ];
            return { target: args.target, capability: { version: '1.5.9', supported: true, format: 'markdown', detail: '', template: '' }, entries, baseline: 'fixture', detail: '' };
          }
          if (command === 'launch_cli') { control.launches.push(args.request); return { status: 'terminal_requested', mode: args.request.mode, toolId: args.request.toolId, projectId: args.request.projectId, terminal: 'auto' }; }
          if (command.startsWith('plugin:event|')) return 1;
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '用这条提示词启动' });
  // The prompt belongs to the cliora project, so the dialog starts there.
  await expect(dialog.getByRole('button', { name: '工作目录 / 项目' })).toContainText('cliora');
  // Codex publishes no agent launchability: no picker, no roster scan.
  await expect(dialog.getByRole('button', { name: '启动 Agent' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __launchControl: { scans: unknown[] } }).__launchControl.scans)).toEqual([]);
  await dialog.getByRole('button', { name: '启动 CLI' }).click();
  await page.getByRole('option', { name: /Antigravity/ }).click();
  const picker = dialog.getByRole('button', { name: '启动 Agent' });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('默认');
  // Both the workspace and the global scan feed the roster.
  const scans = await page.evaluate(() => (window as unknown as { __launchControl: { scans: Array<Record<string, unknown>> } }).__launchControl.scans);
  expect(scans.map((scan) => scan.scope).sort()).toEqual(['global', 'project']);
  await picker.click();
  await expect(page.getByRole('option', { name: /workspace-main/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /global-main/ })).toContainText('工作区同名主代理');
  await expect(page.getByRole('option', { name: /global-subagent|default|disabled-main/ })).toHaveCount(0);
  await page.getByRole('option', { name: /workspace-main/ }).click();
  await expect(picker).toContainText('workspace-main');
  await dialog.getByLabel('启动提示词').fill('请审查本次改动');
  await dialog.getByRole('button', { name: '在外部终端启动' }).click();
  await expect(dialog).toHaveCount(0);
  const request = await page.evaluate(() => (window as unknown as { __launchControl: { launches: Array<Record<string, unknown>> } }).__launchControl.launches);
  expect(request).toHaveLength(1);
  expect(request[0]).toMatchObject({ toolId: 'antigravity', projectId: 'cliora', agent: 'workspace-main' });
});

// Cancel has to leave no launch behind and keep the record in the library.
test('cancelling a prompt launch closes the dialog without launching', async ({ page }) => {
  await page.addInitScript(() => {
    const prompt = { id: 'prompt-1', kind: 'prompt', title: '审查改动', body: '请审查本次改动', category: '', projectId: null, version: 1, updatedAt: 1 };
    const control = { launches: [] as Array<Record<string, unknown>> };
    Object.assign(window, {
      isTauri: true, __launchControl: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_library_items') return args.kind === 'prompt' ? [prompt] : [];
          if (command === 'get_launch_settings') return { selected: 'terminal', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'launch_cli') { control.launches.push(args.request); return { status: 'terminal_requested', mode: 'normal', toolId: args.request.toolId, projectId: null, terminal: 'auto' }; }
          if (command.startsWith('plugin:event|')) return 1;
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '用这条提示词启动' });
  await dialog.getByLabel('启动提示词').fill('这一段不会发出');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '审查改动', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __launchControl: { launches: unknown[] } }).__launchControl.launches)).toEqual([]);
  // Reopening starts from the stored body again, not the discarded edit.
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '用这条提示词启动' }).getByLabel('启动提示词')).toHaveValue('请审查本次改动');
});
