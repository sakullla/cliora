import { expect, test, type Page } from '@playwright/test';

/** OMP plugin workspace: scope ownership, residual doctor entry, rescan result. */
async function setup(page: Page) {
  await page.addInitScript(() => {
    const npm = {
      id: 't5-fixture-plugin', name: 'T5 Fixture Plugin', source: 't5-fixture-plugin', version: '1.2.3',
      scope: 'user', enabled: true, state: 'installed_load_unknown',
      policy: 'npm/Git/本地 link 安装；原生功能：extra', readOnly: false,
      root: '/fixture/home/.omp/plugins/node_modules/t5-fixture-plugin', resources: [],
    };
    const project = {
      id: 't5-market-plugin@t5-market', name: 't5-market-plugin@t5-market', source: 't5-market-plugin@t5-market',
      version: '2.0.0', scope: 'project', enabled: true, state: 'installed_load_unknown',
      policy: '原生 marketplace 安装', readOnly: false,
      root: '/fixture/home/.omp/plugins/cache/t5-market', resources: [],
    };
    const user = {
      ...project, scope: 'user', readOnly: true,
      policy: '原生 marketplace 安装 · 用户作用域安装，项目页只读；请在全局作用域管理 · 被同 ID 的项目副本遮蔽',
    };
    const doctor = {
      id: 'doctor:omp', name: '插件健康检查（omp plugin doctor）', source: 'doctor:omp',
      version: null, scope: 'user', enabled: null, state: 'not_installed',
      policy: '重扫发现原生插件状态问题：用户锁文件仍记录 deleted-plugin，磁盘插件不存在。运行 doctor 会重新核对用户插件目录、包清单、node_modules、锁文件、缺失包与版本漂移；它不保证回滚此前的部分变更，也不处理项目作用域或远程 marketplace。',
      readOnly: false, root: null, resources: [],
    };
    const state = {
      calls: [] as any[],
      entries: [npm, project, user, doctor],
      baseline: 'omp-plugins-baseline',
      doctorCalls: 0,
    };
    const snapshot = (target: any) => ({
      target,
      capability: {
        version: '18.20.2',
        sources: 'npm 包@版本、GitHub/Git URL、本地目录（link）、marketplace name@marketplace',
        actions: ['install', 'update', 'enable', 'disable', 'uninstall', 'doctor'],
        project: true,
        detail: '经 omp plugin 原生命令管理；命令非事务',
      },
      entries: state.entries.map(item => ({ ...item })),
      baseline: state.baseline,
      detail: '列表与本机文件快照；原生会话是否已加载无法从静态列表确认。',
    });
    Object.assign(window, {
      isTauri: true,
      ompPluginsHarness: state,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
        state.calls.push({ command, args });
        if (command === 'get_bootstrap') return {
          preferences: { schema_version: 1, managed_tools: ['omp'], theme: 'system' },
          tools: [{ id: 'omp', name: 'oh-my-pi (OMP)' }],
        };
        if (command === 'list_cli_adapters') return {
          registered: [{
            id: 'omp', name: 'oh-my-pi (OMP)', interfaceFormats: [], yoloAvailable: false,
            launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' },
            launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' },
            resources: { state: 'available', reason: '' }, history: { state: 'planned', reason: '' },
            management: { accounts: false, mcp: false, skills: false, agents: false, plugins: true, projectPlugins: true },
          }],
          managedIds: ['omp'], preservedUnknown: [],
        };
        if (command === 'list_projects') return [{ id: 'project', name: '测试项目', path: '/fixture/project', available: true, selectedProfiles: {}, appliedProfiles: {} }];
        if (['list_usage_queries', 'list_usage_cache', 'list_accounts'].includes(command)) return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('plugin:event|')) return 1;
        if (command === 'get_registered_tool_context') return { effectiveContextId: 'ctx-omp', nativeContextError: null };
        if (command === 'get_registered_tool_workspace') return {
          probe: { tool: 'omp', selectedPath: 'C:/omp/omp.exe', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
          profiles: [], effectiveContextId: 'ctx-omp', binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [],
        };
        if (command === 'preview_native_plugins') return null;
        if (command === 'inspect_native_plugin') return {
          pluginId: args.pluginId, root: args.pluginId, manifest: { description: null, author: null, homepage: null, license: null, keywords: [], path: null }, items: [], truncated: false,
        };
        if (command === 'scan_native_plugins') {
          if (args.target.scope === 'project') {
            return {
              ...snapshot(args.target),
              entries: state.entries.filter((entry: any) => entry.scope === 'project' || entry.id === 't5-fixture-plugin').map((entry: any) => entry.id === 't5-fixture-plugin'
                ? { ...entry, readOnly: true, policy: '用户级安装，项目页只读；请在全局作用域管理' }
                : { ...entry }),
            };
          }
          return snapshot(args.target);
        }
        if (command === 'operate_native_plugin') {
          const request = args.request;
          if (request.action !== 'doctor') return { status: 'native_command_completed', detail: '未使用', transactionId: null, snapshot: snapshot(request.target) };
          state.doctorCalls += 1;
          if (request.source !== 'doctor:omp') throw { message: 'doctor 来源应为诊断条目' };
          state.entries = state.entries.filter((entry: any) => entry.id !== 'doctor:omp');
          return {
            status: 'native_command_completed',
            detail: 'doctor 已重新核对；用户根残留已清理',
            transactionId: null,
            snapshot: snapshot(request.target),
          };
        }
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具' }).click();
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('T5 Fixture Plugin', { exact: true })).toBeVisible();
}

test('OMP plugin rows keep user/project scope, shadowing and the doctor recovery entry', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('t5-fixture-plugin · 全局')).toBeVisible();
  await expect(page.getByText('t5-market-plugin@t5-market · 项目')).toBeVisible();
  await page.getByLabel('插件状态筛选').selectOption('readonly');
  const shadow = page.getByRole('listitem').filter({ has: page.getByText('t5-market-plugin@t5-market', { exact: true }) });
  await expect(shadow).toBeVisible();
  await shadow.getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await details.locator('summary').click();
  await expect(details.getByText(/用户作用域安装，项目页只读/)).toBeVisible();
  await expect(details.getByRole('button', { name: '卸载', exact: true })).toBeDisabled();
});

test('the doctor recovery entry runs the native doctor action and clears the residual row', async ({ page }) => {
  await setup(page);
  const notice = page.getByRole('status').filter({ has: page.getByText('插件状态需要修复') });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('用户锁文件仍记录 deleted-plugin');
  await page.getByRole('button', { name: '运行 doctor 修复' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '运行 doctor 修复', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).ompPluginsHarness.doctorCalls)).toBe(1);
  const requests = await page.evaluate(() => (window as any).ompPluginsHarness.calls.filter((call: any) => call.command === 'operate_native_plugin').map((call: any) => call.args.request));
  expect(requests[0]).toMatchObject({ action: 'doctor', source: 'doctor:omp', trusted: false });
  await expect(page.getByRole('status').filter({ has: page.getByText('插件状态需要修复') })).toHaveCount(0);
  await expect(page.getByText('插件健康检查（omp plugin doctor）', { exact: true })).toHaveCount(0);
});

test('project scope keeps user npm plugins read-only', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  const npm = page.getByRole('listitem').filter({ has: page.getByText('T5 Fixture Plugin', { exact: true }) });
  await expect(npm).toBeVisible();
  await npm.getByRole('button').click();
  const details = page.getByRole('article', { name: '插件详情' });
  await expect(details.getByRole('button', { name: '禁用', exact: true })).toBeDisabled();
  await details.locator('summary').click();
  await expect(details.getByText(/项目页只读/)).toBeVisible();
});
