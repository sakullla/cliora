import { expect, test, type Locator, type Page } from '@playwright/test';
import { cliSwitcher, openCli } from './cli-switcher';

async function installHome(page: Page, detect = false) {
  await page.addInitScript((failDetection: boolean) => {
    const applied = { codex: 'daily' };
    const profiles = [
      { id: 'daily', tool: 'codex', name: '日常', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5' } },
      { id: 'work', tool: 'codex', name: '工作', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5-codex' } },
    ];
    const dialogs: Array<(value: string | null) => void> = [];
    const applies: Array<{ resolve: () => void; reject: (reason?: unknown) => void }> = [];
    let failLaunch = false;
    let holdApply = false;
    const workspace = () => {
      const profile = profiles.find((item) => item.id === applied.codex);
      return {
        probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
        profiles,
        binding: { scopeKey: 'global', tool: 'codex', profileId: applied.codex, profileVersion: profile?.version ?? 1, managed: {} },
        snapshots: [], recoveryNeeded: [], common: null, customPath: null,
      };
    };
    Object.assign(window, {
      isTauri: true,
      __probeMode: failDetection ? 'error' : 'available',
      __probeCalls: [] as unknown[],
      __launchRequests: [] as unknown[],
      __applyCalls: [] as unknown[],
      __resolveDialog: (value: string | null) => {
        const resolve = dialogs.shift();
        if (!resolve) throw new Error('no dialog');
        resolve(value);
      },
      __failNextLaunch: () => { failLaunch = true; },
      __holdNextApply: () => { holdApply = true; },
      __resolveApply: (ok: boolean) => {
        const pending = applies.shift();
        if (!pending) throw new Error('no apply');
        if (ok) pending.resolve();
        else pending.reject({ message: '写入被拒绝' });
      },
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, string> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') {
          const state = window as unknown as { __probeMode: string; __probeCalls: unknown[] };
          state.__probeCalls.push(args);
          if (state.__probeMode === 'error') throw { message: '找不到 Codex 可执行文件' };
          const result = workspace();
          if (state.__probeMode === 'failed' || state.__probeMode === 'absent') return { ...result, probe: { ...result.probe, selectedPath: null, nativeWrites: { state: 'unknown', reason: '未确认 CLI 身份' }, installations: state.__probeMode === 'absent' ? [] : [{ path: 'C:/codex.cmd', version: null, status: 'probe_failed', detail: '版本命令超时' }] } };
          return result;
        }
        if (command === 'plugin:dialog|open') return new Promise((resolve) => dialogs.push(resolve));
        if (command === 'launch_cli') {
          (window as unknown as { __launchRequests: unknown[] }).__launchRequests.push(args.request);
          const forcedLaunch = (window as unknown as { __launchError?: unknown }).__launchError;
          if (forcedLaunch) { (window as unknown as { __launchError?: unknown }).__launchError = undefined; throw forcedLaunch; }
          if (failLaunch) { failLaunch = false; throw { message: '终端不存在' }; }
          return { mode: 'normal', status: 'terminal_requested' };
        }
        if (command === 'apply_registered_native_profile') {
          (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args);
          const forced = (window as unknown as { __applyError?: string | { code?: string; message: string } }).__applyError;
          if (forced) throw typeof forced === 'string' ? { message: forced } : forced;
          const profileId = args.profileId;
          const finish = () => { applied.codex = profileId; return { applications: [] }; };
          if (holdApply) {
            holdApply = false;
            return new Promise((resolve, reject) => applies.push({ resolve: () => resolve(finish()), reject }));
          }
          return finish();
        }
        if (command === 'compare_registered_application') { const state = window as unknown as { __compareResult: unknown; __compareCount?: number }; state.__compareCount = (state.__compareCount ?? 0) + 1; return state.__compareResult; }
        if (command === 'apply_compared_application') {
          const failure = (window as unknown as { __applyComparedError?: string }).__applyComparedError;
          if (failure) { (window as unknown as { __applyComparedError?: string }).__applyComparedError = undefined; throw { message: failure }; }
          const comparison = (args as unknown as { comparison?: { profile?: { id?: string } } }).comparison;
          applied.codex = comparison?.profile?.id ?? applied.codex;
          const calls = ((window as unknown as { __comparedCalls?: unknown[] }).__comparedCalls ??= []);
          calls.push(args);
          return { status: 'written_for_next_session' };
        }
        if (command === 'plugin:window|set_theme') return null;
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  }, detect);
}

async function oneLine(note: Locator) {
  await expect(note).toBeVisible();
  const shown = await note.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const style = getComputedStyle(el);
    return range.getClientRects().length === 1 && style.whiteSpace === 'nowrap' && el.scrollWidth <= el.clientWidth + 1;
  });
  expect(shown).toBe(true);
}

test('launch names the tool, blocks a second click, and ignores a cancelled directory', async ({ page }) => {
  await installHome(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const launch = tools.getByRole('button', { name: '启动', exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
  const starting = tools.getByRole('button', { name: '正在启动', exact: true });
  await expect(starting).toBeDisabled();
  await expect(starting).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog(null));
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await expect(tools.getByRole('status')).toHaveCount(0);
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(tools).not.toContainText('已向外部终端');
  await expect(tools).not.toContainText('已登录');
  await expect(tools).not.toContainText('会话已开始');
  expect(await page.evaluate(() => (window as unknown as { __launchRequests: unknown[] }).__launchRequests)).toEqual([]);

  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await expect(tools.getByRole('button', { name: '正在启动', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
  const row = tools.getByRole('button', { name: '启动', exact: true }).locator('..').locator('..');
  const status = row.getByRole('status');
  await expect(status).toHaveText('Codex 已向外部终端发出请求。');
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(tools).not.toContainText('已登录');
  await expect(tools).not.toContainText('会话已开始');
  await expect(tools).not.toContainText('会话已经开始');
  await oneLine(status);
  await page.locator('#main').evaluate((el) => { el.scrollTop = 0; });
  const box = await tools.getByRole('button', { name: '启动', exact: true }).boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1360);
  expect(await page.evaluate(() => (window as unknown as { __launchRequests: Array<Record<string, unknown>> }).__launchRequests)).toEqual([
    { toolId: 'codex', projectId: null, sessionId: null, mode: 'normal', directory: 'C:/work' },
  ]);
});

test('launch failure names the tool and replaces the previous success', { tag: '@integration' }, async ({ page }) => {
  await installHome(page);
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');
  await page.evaluate(() => (window as unknown as { __failNextLaunch: () => void }).__failNextLaunch());
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  const alert = tools.getByRole('alert');
  await expect(alert).toContainText('Codex');
  await expect(alert).toContainText('启动失败');
  await expect(alert).toContainText('可再次启动或编辑配置');
  await expect(alert).toContainText('终端不存在');
  await expect(tools.getByRole('status')).toHaveCount(0);
  await expect(tools).not.toContainText('已向外部终端');
  await expect(tools).not.toContainText('已登录');
  await expect(tools).not.toContainText('会话已开始');
  await expect(tools).not.toContainText('检测失败');
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await expect(tools.getByRole('button', { name: '编辑配置 →' })).toBeEnabled();
});

test('the launch directory is remembered, and right-click picks another', async ({ page }) => {
  await installHome(page);
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const launch = tools.getByRole('button', { name: '启动', exact: true });
  await launch.click();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');

  await launch.click();
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');
  expect(await page.evaluate(() => (window as unknown as { __launchRequests: Array<Record<string, unknown>> }).__launchRequests)).toEqual([
    { toolId: 'codex', projectId: null, sessionId: null, mode: 'normal', directory: 'C:/work' },
    { toolId: 'codex', projectId: null, sessionId: null, mode: 'normal', directory: 'C:/work' },
  ]);

  await launch.click({ button: 'right' });
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('D:/else'));
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');
  let requests = await page.evaluate(() => (window as unknown as { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual({ toolId: 'codex', projectId: null, sessionId: null, mode: 'normal', directory: 'D:/else' });

  const dirMenu = tools.getByRole('button', { name: 'Codex 的更多操作' });
  await dirMenu.click();
  const menu = page.getByRole('menu', { name: 'Codex 的更多操作' });
  await expect(menu.getByRole('menuitem', { name: '编辑配置' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '选择其他目录…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '清除记住的目录' })).toBeVisible();
  await menu.getByRole('menuitem', { name: '选择其他目录…' }).click();
  await expect(menu).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('E:/menu'));
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');
  requests = await page.evaluate(() => (window as unknown as { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toHaveLength(4);
  expect(requests[3]).toEqual({ toolId: 'codex', projectId: null, sessionId: null, mode: 'normal', directory: 'E:/menu' });

  await dirMenu.click();
  await page.getByRole('menu', { name: 'Codex 的更多操作' }).getByRole('menuitem', { name: '清除记住的目录' }).click();
  await launch.click();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog(null));
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await expect(tools.getByRole('status')).toHaveCount(0);
  requests = await page.evaluate(() => (window as unknown as { __launchRequests: Array<Record<string, unknown>> }).__launchRequests);
  expect(requests).toHaveLength(4);
});

test('applying a profile reports the native write, and failure keeps the previous selection', async ({ page }) => {
  await installHome(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const group = tools.getByRole('radiogroup', { name: '切换Codex的配置' });
  const daily = group.getByRole('radio', { name: '日常' });
  const work = group.getByRole('radio', { name: '工作' });
  await expect(daily).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => (window as unknown as { __holdNextApply: () => void }).__holdNextApply());
  await work.click();
  const progress = tools.getByRole('status');
  await expect(progress).toHaveText('正在应用 Codex 的配置。');
  await oneLine(progress);
  await expect(daily).toBeDisabled();
  await expect(work).toBeDisabled();
  await expect(daily).toHaveAttribute('aria-checked', 'true');
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeDisabled();
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __resolveApply: (ok: boolean) => void }).__resolveApply(true));
  const saved = tools.getByRole('status');
  await expect(saved).toHaveText('Codex 已写入原生文件，下次启动读取。');
  await oneLine(saved);
  await expect(work).toHaveAttribute('aria-checked', 'true');
  await expect(tools.getByRole('alert')).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { __holdNextApply: () => void }).__holdNextApply());
  await daily.click();
  await expect(tools.getByRole('status')).toHaveText('正在应用 Codex 的配置。');
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(work).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => (window as unknown as { __resolveApply: (ok: boolean) => void }).__resolveApply(false));
  const alert = tools.getByRole('alert');
  await expect(alert).toContainText('Codex');
  await expect(alert).toContainText('未切换');
  await expect(alert).toContainText('写入被拒绝');
  await oneLine(alert);
  await expect(tools.getByRole('status')).toHaveCount(0);
  await expect(tools).not.toContainText('已写入原生文件');
  await expect(work).toHaveAttribute('aria-checked', 'true');
  await expect(daily).toHaveAttribute('aria-checked', 'false');
  await expect(group).toBeVisible();

  await daily.click();
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(daily).toHaveAttribute('aria-checked', 'true');
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<Record<string, unknown>> }).__applyCalls);
  expect(calls.map((call) => ({ toolId: call.toolId, profileId: call.profileId, scope: call.scope, allowTakeover: call.allowTakeover }))).toEqual([
    { toolId: 'codex', profileId: 'work', scope: 'global', allowTakeover: false },
    { toolId: 'codex', profileId: 'daily', scope: 'global', allowTakeover: false },
    { toolId: 'codex', profileId: 'daily', scope: 'global', allowTakeover: false },
  ]);
});

test('a home switch that differs from the file opens the comparison', async ({ page }) => {
  await installHome(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as unknown as { __applyError: string; __compareResult: unknown; __comparedCalls: unknown[] };
    state.__applyError = '原生文件已有不同的字段值：settings；请确认接管';
    state.__compareResult = {
      profile: { id: 'work', tool: 'codex', name: '工作', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5-codex' } },
      common: null,
      files: [{ role: 'settings', format: 'toml', current: 'model = "old"', proposed: { model: 'new' }, proposedText: 'model = "new"\n' }],
    };
    state.__comparedCalls = [];
  });
  const tools = page.getByLabel('管理中的工具');
  await tools.getByRole('radio', { name: '工作' }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前文件与本次配置' });
  await expect(dialog).toBeVisible();
  const changed = dialog.getByRole('list', { name: '改了什么' });
  await expect(changed).toContainText('model');
  await expect(changed).toContainText('"old"');
  await expect(changed).toContainText('"new"');
  await expect(dialog.getByText('改了 1 处 · 删除 1 行，新增 1 行')).toBeVisible();
  await expect(dialog.getByText('model = "old"')).toBeVisible();
  await expect(dialog.getByText('model = "new"')).toBeVisible();
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(tools.getByRole('radio', { name: '日常' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  await expect(tools.getByRole('radio', { name: '工作' })).toHaveAttribute('aria-checked', 'true');
  const compared = await page.evaluate(() => (window as unknown as { __comparedCalls: unknown[] }).__comparedCalls);
  expect(compared).toHaveLength(1);
});

test('an English launch failure with the stable code shows a localized recovery hint', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('cliora:language', 'en'); });
  await installHome(page);
  await page.goto('/');
  await page.evaluate(() => {
    // Only the code routes this; the raw message stays Chinese exactly as the backend sends it.
    (window as unknown as { __launchError?: unknown }).__launchError = { code: 'terminal_command_too_long', message: '启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal' };
  });
  const tools = page.getByLabel('Managed tools');
  await tools.getByRole('button', { name: 'Launch', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
  const alert = tools.getByRole('alert');
  await expect(alert).toContainText('failed to launch');
  await expect(alert).toContainText('exceeds the terminal length limit');
  await expect(alert).toContainText('Settings → Terminal');
  await expect(alert).not.toContainText('CMD');
});

test('the onboarding config entry routes to setup while no CLI is managed yet', async ({ page }) => {
  await installFreshState(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: '首次使用引导' });
  await expect(card).toBeVisible();
  // Without a managed CLI there is no configuration target; the entry guides to step 1
  // instead of landing on the empty tools page.
  await card.getByRole('button', { name: '去创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toHaveCount(0);
});

test('an English takeover error opens the comparison by error code alone', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('cliora:language', 'en'); });
  await installHome(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as unknown as { __applyError?: { code?: string; message: string }; __compareResult: unknown; __comparedCalls: unknown[] };
    // Neither legacy marker string appears in the message, so only the code can route this.
    state.__applyError = { code: 'native_takeover_required', message: 'Native settings differ from this profile' };
    state.__compareResult = {
      profile: { id: 'work', tool: 'codex', name: '工作', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5-codex' } },
      common: null,
      files: [{ role: 'settings', format: 'toml', current: 'model = "old"', proposed: { model: 'new' }, proposedText: 'model = "new"\n' }],
    };
    state.__comparedCalls = [];
  });
  const tools = page.getByLabel('Managed tools');
  await tools.getByRole('radio', { name: '工作' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare the current file with this profile' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'What changed' })).toContainText('model');
  await expect(tools.getByRole('alert')).toHaveCount(0);
  await expect(tools.getByRole('radio', { name: '日常' })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Use incoming content' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tools.getByRole('status')).toHaveText('Codex written to the native file; the next launch reads it.');
  await expect(tools.getByRole('radio', { name: '工作' })).toHaveAttribute('aria-checked', 'true');
  const compared = await page.evaluate(() => (window as unknown as { __comparedCalls: unknown[] }).__comparedCalls);
  expect(compared).toHaveLength(1);
});

test('a project tool is searched and switched from the card', async ({ page }) => {
  await page.addInitScript(() => {
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const ids = Object.keys(names);
    let preferred = 'codex';
    const project = () => ({ id: 'demo', name: 'Demo', path: 'C:/demo', available: true, preferredTool: preferred, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} });
    Object.assign(window, {
      isTauri: true,
      __toolCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'system' }, tools: ids.map((id) => ({ id, name: names[id] })) };
        if (command === 'list_cli_adapters') return { registered: ids.map((id) => ({ id, name: names[id], interfaceFormats: [], yoloAvailable: true })), managedIds: ids, preservedUnknown: [] };
        if (command === 'list_projects') return [project()];
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: `C:/${args.toolId}.cmd`, installations: [{ path: `C:/${args.toolId}.cmd`, version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'set_project_tool') { preferred = args.toolId; (window as unknown as { __toolCalls: unknown[] }).__toolCalls.push(args); return project(); }
        return null;
      } },
    });
  });
  await page.goto('/');
  const projects = page.getByRole('region', { name: '项目与启动' });
  const trigger = projects.getByRole('button', { name: 'Demo 的工具' });
  await expect(trigger).toContainText('Codex');
  await trigger.click();
  const list = page.getByRole('listbox', { name: 'Demo 的工具' });
  await expect(list.getByRole('option')).toHaveCount(6);
  const search = page.getByLabel('搜索工具');
  await expect(search).toBeFocused();
  await search.fill('gr');
  await expect(list.getByRole('option')).toHaveCount(1);
  await list.getByRole('option', { name: 'Grok' }).click();
  await expect(trigger).toContainText('Grok');
  expect(await page.evaluate(() => (window as unknown as { __toolCalls: unknown[] }).__toolCalls)).toEqual([{ projectId: 'demo', toolId: 'grok' }]);
});

/** Two tools that differ in YOLO support; the project default mode is YOLO, so the mode follows the launched tool. */
async function installSplitLaunch(page: Page, options: { remote?: boolean } = {}) {
  await page.addInitScript((remote: boolean) => {
    const host = { id: 'host-1', name: '测试主机', host: '10.0.0.2', port: 22, user: 'dev', authMethod: 'key', identityFile: null, sshConfig: null, defaultPath: '/srv', enabled: true, createdAt: 1, updatedAt: 1 };
    if (remote) localStorage.setItem('cliora:remote-target', host.id);
    else localStorage.removeItem('cliora:remote-target');
    const names: Record<string, string> = { codex: 'Codex', grok: 'Grok' };
    const ids = Object.keys(names);
    let preferred = 'codex';
    const project = () => ({ id: 'demo', name: 'Demo', path: 'C:/demo', available: true, preferredTool: preferred, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} });
    const calls: Array<[string, unknown]> = [];
    const state = { failSave: false };
    Object.assign(window, {
      isTauri: true,
      __calls: calls,
      __split: state,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'light', remote_ssh_enabled: remote }, tools: ids.map((id) => ({ id, name: names[id] })) };
        if (command === 'list_cli_adapters') return { registered: ids.map((id) => ({ id, name: names[id], interfaceFormats: [], launchForm: 'terminal', yoloAvailable: id === 'grok' })), managedIds: ids, preservedUnknown: [] };
        if (command === 'list_projects') return [project()];
        if (command === 'list_remote_targets') return [host];
        if (command === 'list_remote_projects') return [{ id: 'rp', targetId: host.id, name: '远程仓库', path: '/srv/repo', preferredTool: 'codex', updatedAt: 1 }];
        if (command === 'probe_remote_clis') return (args.toolIds as string[]).map((toolId) => ({ targetId: host.id, toolId, executable: toolId, installed: true, version: '1.0.0', detail: null }));
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: `C:/${args.toolId}.cmd`, installations: [{ path: `C:/${args.toolId}.cmd`, version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'yolo' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'set_project_tool') {
          calls.push([command, args]);
          if (state.failSave) throw { message: '项目文件被占用' };
          preferred = args.toolId;
          return project();
        }
        if (command === 'launch_cli') {
          calls.push([command, args.request]);
          return { mode: args.request.mode, status: 'terminal_requested', toolId: args.request.toolId, projectId: args.request.projectId, terminal: 'auto' };
        }
        if (command.startsWith('list_')) return [];
        return null;
      } },
    });
  }, options.remote ?? false);
}

const splitCalls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Array<[string, unknown]> }).__calls);

test('the project launch menu saves another tool, then launches it with that tool\'s mode', async ({ page }) => {
  await installSplitLaunch(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: '项目与启动' }).locator('[data-project-id="demo"]');
  await expect(card.locator('[data-variant="primary"]')).toHaveCount(1);
  const launch = card.getByRole('button', { name: '启动', exact: true });
  await expect(launch).toHaveAttribute('data-variant', 'primary');
  const menuButton = card.getByRole('button', { name: '用其他工具启动 Demo' });
  await menuButton.click();
  const menu = page.getByRole('menu', { name: '用其他工具启动 Demo' });
  await expect(menu.getByRole('menuitem')).toHaveText([/Codex/, /Grok/]);
  await expect(menu.getByRole('menuitem', { name: /Codex/ })).toHaveAttribute('aria-current', 'true');
  await expect(menu).not.toContainText('工作台');
  await menu.getByRole('menuitem', { name: /Grok/ }).click();
  await expect(card.getByRole('button', { name: 'Demo 的工具' })).toContainText('Grok');
  await expect(page.getByRole('region', { name: '项目与启动' }).getByRole('status')).toContainText('已向外部终端发送启动 YOLO请求');
  expect(await splitCalls(page)).toEqual([
    ['set_project_tool', { projectId: 'demo', toolId: 'grok' }],
    ['launch_cli', { toolId: 'grok', projectId: 'demo', sessionId: null, mode: 'yolo', directory: null }],
  ]);

  // The primary half keeps launching the project's (now saved) tool; Codex has no YOLO, so it runs normally.
  await launch.click();
  await menuButton.click();
  await page.getByRole('menu', { name: '用其他工具启动 Demo' }).getByRole('menuitem', { name: /Codex/ }).click();
  const calls = await splitCalls(page);
  expect(calls.slice(2)).toEqual([
    ['launch_cli', { toolId: 'grok', projectId: 'demo', sessionId: null, mode: 'yolo', directory: null }],
    ['set_project_tool', { projectId: 'demo', toolId: 'codex' }],
    ['launch_cli', { toolId: 'codex', projectId: 'demo', sessionId: null, mode: 'normal', directory: null }],
  ]);
});

test('a failed tool save from the launch menu shows the page error and does not launch', async ({ page }) => {
  await installSplitLaunch(page);
  await page.goto('/');
  await page.evaluate(() => { (window as unknown as { __split: { failSave: boolean } }).__split.failSave = true; });
  const projects = page.getByRole('region', { name: '项目与启动' });
  const card = projects.locator('[data-project-id="demo"]');
  await card.getByRole('button', { name: '用其他工具启动 Demo' }).click();
  await page.getByRole('menu', { name: '用其他工具启动 Demo' }).getByRole('menuitem', { name: /Grok/ }).click();
  const alert = projects.getByRole('alert');
  await expect(alert).toContainText('项目文件被占用');
  await expect(projects.getByRole('status')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Demo 的工具' })).toContainText('Codex');
  await expect(card.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  expect(await splitCalls(page)).toEqual([['set_project_tool', { projectId: 'demo', toolId: 'grok' }]]);
});

test('a remote project launches another tool from the menu without saving it', async ({ page }) => {
  await installSplitLaunch(page, { remote: true });
  await page.goto('/');
  const projects = page.getByRole('region', { name: '项目与启动' });
  const card = projects.locator('[data-project-id="remote:rp"]');
  await expect(card).toContainText('远程仓库');
  await expect(projects.locator('[data-project-id="demo"]')).toHaveCount(0);
  await expect(card.locator('[data-variant="primary"]')).toHaveCount(1);
  await card.getByRole('button', { name: '用其他工具启动 远程仓库' }).click();
  await page.getByRole('menu', { name: '用其他工具启动 远程仓库' }).getByRole('menuitem', { name: /Grok/ }).click();
  await expect(card.getByRole('button', { name: '远程仓库 的工具' })).toContainText('Grok');
  await expect.poll(() => splitCalls(page)).toEqual([
    ['launch_cli', { toolId: 'grok', projectId: 'remote:rp', sessionId: null, mode: 'yolo', directory: null }],
  ]);
});

test('detection failure names the tool and points at edit or reread', async ({ page }) => {
  await installHome(page, true);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const alert = tools.getByRole('alert');
  await expect(alert).toHaveText('Codex 检测失败。可重新检测或编辑配置。 找不到 Codex 可执行文件');
  await expect(tools.getByRole('status')).toHaveCount(0);
  await expect(tools).not.toContainText('操作失败，请重试');
  await expect(tools.getByRole('button', { name: '编辑配置 →' })).toBeEnabled();
  await oneLine(alert);
  const color = await alert.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    el.appendChild(probe);
    const match = getComputedStyle(probe).color === getComputedStyle(el).color;
    probe.remove();
    return match;
  });
  expect(color).toBe(true);
});

test('many profiles stay in one searchable menu', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { codex: 'p0' };
    const profiles = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, tool: 'codex', name: index === 0 ? '日常' : `配置 ${index}`, version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: `m${index}` } }));
    Object.assign(window, {
      isTauri: true,
      __applyCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: { profileId?: string } = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') {
          const profile = profiles.find((item) => item.id === applied.codex);
          return { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles, binding: { scopeKey: 'global', tool: 'codex', profileId: applied.codex, profileVersion: profile?.version ?? 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        }
        if (command === 'apply_registered_native_profile') { (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args); applied.codex = args.profileId ?? applied.codex; return { applications: [] }; }
        if (command === 'inspect_registered_native_draft') return null;
        return null;
      } },
    });
  });
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  await expect(tools.getByRole('radiogroup')).toHaveCount(0);
  const menu = tools.getByRole('button', { name: '切换Codex的配置' });
  await expect(menu).toContainText('日常');
  // One line: the model is in the tooltip and the open list, not under the name.
  await expect(menu).not.toContainText('m0');
  await expect(menu).toHaveAttribute('title', /日常 · m0/);
  const rowHeight = await menu.evaluate((element) => element.closest('[data-tool-row]')?.getBoundingClientRect().height ?? 999);
  expect(rowHeight).toBeLessThan(56);
  await menu.click();
  const list = page.getByRole('listbox', { name: '切换Codex的配置' });
  await expect(list.getByRole('option')).toHaveCount(20);
  expect((await list.boundingBox())!.height).toBeLessThan(360);
  const before = await list.evaluate((node) => node.scrollTop);
  const visibleIndex = await list.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const options = [...node.querySelectorAll<HTMLElement>('[role="option"]')];
    return options.findLastIndex((option) => {
      const rect = option.getBoundingClientRect();
      return rect.top >= box.top + 2 && rect.bottom <= box.bottom - 2;
    });
  });
  expect(visibleIndex).toBeGreaterThan(2);
  await list.getByRole('option').nth(visibleIndex).hover();
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowDown');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
  await page.getByLabel('搜索配置').fill('配置 12');
  await expect(list.getByRole('option')).toHaveCount(1);
  await list.getByRole('option', { name: '配置 12' }).click();
  await expect(menu).toContainText('配置 12');
  await expect(menu).toHaveAttribute('title', /配置 12 · m12/);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string }> }).__applyCalls);
  expect(calls.map((call) => call.profileId)).toEqual(['p12']);
});

test('a short profile menu is one line, switches with arrow keys and keeps the model in the tooltip', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { codex: 'plan-b' };
    const profiles = [
      { id: 'plan-a', tool: 'codex', name: 'Plan A', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'model-a' } },
      { id: 'plan-b', tool: 'codex', name: 'Plan B', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'model-b' } },
      { id: 'plan-c', tool: 'codex', name: 'Plan C', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'model-c' } },
      { id: 'plan-d', tool: 'codex', name: 'Plan D', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'model-d' } },
      { id: 'plan-e', tool: 'codex', name: 'Plan E', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'model-e' } },
      { id: 'spare', tool: 'codex', name: '备用', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'spare-model' } },
    ];
    Object.assign(window, {
      isTauri: true,
      __applyCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: { profileId?: string } = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') {
          const profile = profiles.find((item) => item.id === applied.codex);
          return { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' }, profiles, binding: { scopeKey: 'global', tool: 'codex', profileId: applied.codex, profileVersion: profile?.version ?? 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        }
        if (command === 'apply_registered_native_profile') { (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args); applied.codex = args.profileId ?? applied.codex; return { applications: [] }; }
        return null;
      } },
    });
  });
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const menu = tools.getByRole('button', { name: '切换Codex的配置' });
  await expect(menu).toHaveText('Plan B');
  await expect(menu).toHaveAttribute('title', /Plan B · model-b/);
  await expect(menu.locator('small')).toHaveCount(0);
  await expect(tools.getByRole('button', { name: '下一个配置' })).toHaveCount(0);
  await menu.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(menu).toHaveText('Plan C');
  await expect(menu).toHaveAttribute('title', /Plan C · model-c/);
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  await menu.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(menu).toHaveText('Plan B');
  await menu.focus();
  await page.keyboard.press('ArrowRight');
  await expect(menu).toHaveText('Plan C');
  await menu.click();
  const list = page.getByRole('listbox', { name: '切换Codex的配置' });
  await expect(list.getByRole('option')).toHaveCount(6);
  const search = page.getByLabel('搜索配置');
  await expect(search).toBeFocused();
  await search.fill('plan d');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option', { name: 'Plan D' })).toBeVisible();
  await search.fill('');
  await expect(list.getByRole('option')).toHaveCount(6);
  const option = list.getByRole('option', { name: 'Plan D' });
  await expect(option).toContainText('model-d');
  const optionStacked = await option.evaluate((element) => {
    const name = element.querySelector('strong')?.getBoundingClientRect();
    const model = element.querySelector('small')?.getBoundingClientRect();
    return !!name && !!model && model.top >= name.bottom - 1;
  });
  expect(optionStacked).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await menu.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(menu).toHaveText('Plan D');
  await expect(menu).toHaveAttribute('title', /Plan D · model-d/);
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string }> }).__applyCalls);
  expect(calls.map((call) => call.profileId)).toEqual(['plan-c', 'plan-b', 'plan-c', 'plan-d']);
});


test('a transient version failure automatically rechecks and enables launch', async ({ page }) => {
  await installHome(page);
  await page.clock.install();
  await page.addInitScript(() => { (window as unknown as { __probeMode: string }).__probeMode = 'failed'; });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  await expect(tools).toContainText('版本检测失败');
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
  await expect(tools.getByRole('button', { name: '重新检测', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __probeMode: string }).__probeMode = 'available'; });
  await page.clock.fastForward(8500);
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await expect(tools).toContainText('1.0.0');
  const calls = await page.evaluate(() => (window as unknown as { __probeCalls: Array<{ fresh: boolean; summary: boolean }> }).__probeCalls);
  expect(calls.map(({ fresh, summary }) => ({ fresh, summary }))).toEqual([{ fresh: false, summary: true }, { fresh: true, summary: true }]);
});

test('missing installations do not loop and a manual recheck discovers a new install', async ({ page }) => {
  await installHome(page);
  await page.clock.install();
  await page.addInitScript(() => { (window as unknown as { __probeMode: string }).__probeMode = 'absent'; });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  await expect(tools).toContainText('未发现安装');
  await page.clock.fastForward(30_000);
  expect(await page.evaluate(() => (window as unknown as { __probeCalls: unknown[] }).__probeCalls.length)).toBe(1);
  await page.evaluate(() => { (window as unknown as { __probeMode: string }).__probeMode = 'available'; });
  await tools.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __probeCalls: Array<{ fresh: boolean }> }).__probeCalls[1].fresh)).toBe(true);
});

test('desktop tools launch directly and an uninstalled editor keeps official guidance', async ({ page }) => {
  await page.addInitScript(() => {
    const management = { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, rules: { global: false, project: false } };
    const descriptor = (id: string, name: string, launchForm: 'desktop' | 'terminal') => ({
      id, name, launchForm, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false, management,
    });
    const installed = (id: string) => ({
      tool: id, latestVersionSupported: false, selectedPath: `C:/Apps/${id}.exe`,
      installations: [{ path: `C:/Apps/${id}.exe`, version: '1.0.0', source: 'native', status: 'available', detail: null }],
      nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [],
      installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null, npmInstallCommand: null,
    });
    const cursorMissing = {
      tool: 'cursor', latestVersionSupported: false, selectedPath: null, installations: [],
      nativeFiles: [], nativeWrites: { state: 'unknown', reason: '未发现可确认身份的 CLI' }, interfaceFormats: [], providerPresets: [], dependencies: [],
      installUrl: 'https://cursor.com/docs/configuration/shell', upgradeHint: 'Cursor 桌面编辑器请从官网安装后启动。不探测、不回退到 agent，也不提供猜测的安装命令。',
      installCommand: null, upgradeCommand: null, nativeInstallCommand: null, npmInstallCommand: null,
    };
    const dialogs: Array<(value: string | null) => void> = [];
    const state = {
      cursorInstalled: false,
      launchRequests: [] as unknown[],
      dialogs,
    };
    const workspace = (toolId: string) => ({
      probe: toolId === 'cursor' && !state.cursorInstalled ? cursorMissing : installed(toolId),
      profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, {
      isTauri: true,
      __desktop: state,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['zcode', 'deepseek', 'cursor', 'codex'], theme: 'system', tool_icons: {} }, tools: [] };
        if (command === 'list_cli_adapters') return {
          registered: [
            descriptor('zcode', 'ZCode', 'desktop'),
            descriptor('deepseek', 'DeepSeek Harness', 'desktop'),
            descriptor('cursor', 'Cursor', 'desktop'),
            descriptor('codex', 'Codex', 'terminal'),
          ],
          managedIds: ['zcode', 'deepseek', 'cursor', 'codex'],
          preservedUnknown: [],
        };
        if (command === 'get_registered_tool_workspace') return workspace(String(args.toolId));
        if (command === 'get_registered_tool_context') return { effectiveContextId: null, nativeContextError: null };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_projects') return [{ id: 'proj-1', name: '演示项目', path: 'C:/work/demo', available: true, preferredTool: 'zcode', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
        if (command === 'plugin:dialog|open') return new Promise((resolve) => dialogs.push(resolve));
        if (command === 'launch_cli') {
          state.launchRequests.push(args.request);
          return { mode: args.request.mode, status: args.request.toolId === 'codex' ? 'terminal_requested' : 'desktop_requested', toolId: args.request.toolId, projectId: args.request.projectId, terminal: args.request.toolId === 'codex' ? 'auto' : 'desktop' };
        }
        if (command === 'open_external_url') return null;
        if (command.startsWith('plugin:event|') || command.startsWith('plugin:window|')) return 1;
        if (command.startsWith('list_') || command === 'usage_presets' || command === 'account_capabilities') return [];
        return null;
      } },
    });
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const row = (name: string) => tools.locator('[data-tool-row]').filter({ hasText: name });
  const dialogs = () => page.evaluate(() => (window as unknown as { __desktop: { dialogs: unknown[] } }).__desktop.dialogs.length);
  const requests = () => page.evaluate(() => (window as unknown as { __desktop: { launchRequests: Array<{ toolId: string; projectId: string | null; sessionId: string | null; directory: string | null; mode: string }> } }).__desktop.launchRequests);

  async function launchDirect(name: string, toolId: string) {
    const launch = row(name).getByRole('button', { name: '启动', exact: true });
    const before = await dialogs();
    await launch.click();
    await expect(row(name).getByRole('status')).toContainText('已请求启动桌面应用');
    await expect(launch).toBeEnabled();
    await launch.click();
    await expect(launch).toBeEnabled();
    await launch.click({ button: 'right' });
    await expect(launch).toBeEnabled();
    expect(await dialogs()).toBe(before);
    const mine = (await requests()).filter((item) => item.toolId === toolId && item.projectId == null);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const item of mine) {
      expect(item.directory).toBeNull();
      expect(item.sessionId).toBeNull();
      expect(item.mode).toBe('normal');
    }
    // Desktop tools have no launch directory; their row menu keeps profile creation and the edit entry.
    await row(name).getByRole('button', { name: `${name} 的更多操作` }).click();
    const rowMenu = page.getByRole('menu', { name: `${name} 的更多操作` });
    await expect(rowMenu.getByRole('menuitem')).toHaveText(['新建配置', '编辑配置']);
    await page.keyboard.press('Escape');
    await expect(rowMenu).toHaveCount(0);
    await expect(row(name)).not.toContainText('选择其他目录');
    await expect(row(name)).not.toContainText('清除记住的目录');
  }

  await expect(row('ZCode').getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  await launchDirect('ZCode', 'zcode');
  await launchDirect('DeepSeek Harness', 'deepseek');
  const cursor = row('Cursor');
  await expect(cursor.getByRole('button', { name: '重新检测', exact: true })).toBeVisible();
  await expect(cursor.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
  await expect(cursor.getByRole('button', { name: 'Cursor 的更多操作' })).toHaveCount(0);
  await expect(cursor).not.toContainText('选择其他目录');
  await expect(cursor).not.toContainText('清除记住的目录');

  const codex = row('Codex');
  await expect(codex.getByRole('button', { name: 'Codex 的更多操作' })).toBeVisible();
  await codex.getByRole('button', { name: 'Codex 的更多操作' }).click();
  await expect(page.getByRole('menuitem', { name: '选择其他目录…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await codex.getByRole('button', { name: '启动', exact: true }).click();
  await expect.poll(dialogs).toBe(1);
  await page.evaluate(() => {
    const pending = (window as unknown as { __desktop: { dialogs: Array<(value: string | null) => void> } }).__desktop.dialogs.shift();
    pending?.('C:/chosen');
  });
  await expect(codex.getByRole('status')).toContainText('已向外部终端发出请求');
  const codexRequest = (await requests()).find((item) => item.toolId === 'codex');
  expect(codexRequest?.directory).toBe('C:/chosen');
  expect(await dialogs()).toBe(0);

  const projects = page.getByLabel('项目与启动');
  const projectLaunch = projects.getByRole('button', { name: '启动', exact: true });
  await projectLaunch.click();
  await expect(projects.getByRole('status')).toContainText('ZCode 已请求启动桌面应用');
  await expect(projects).not.toContainText('已向外部终端');
  expect(await dialogs()).toBe(0);
  const projectRequest = (await requests()).find((item) => item.projectId === 'proj-1');
  expect(projectRequest).toMatchObject({ toolId: 'zcode', projectId: 'proj-1', sessionId: null, directory: null, mode: 'normal' });
  await projects.getByRole('button', { name: '修改', exact: true }).click();
  const projectEdit = page.getByRole('dialog');
  await expect(projectEdit.getByRole('button', { name: '这次用 YOLO', exact: true })).toHaveCount(0);
  await projectEdit.getByRole('button', { name: '关闭', exact: true }).click();

  await cursor.getByRole('button', { name: '去安装 →', exact: true }).click();
  const workspace = page.getByRole('region', { name: '工具与连接' });
  await expect(workspace.getByRole('heading', { level: 2, name: 'Cursor' })).toBeVisible();
  await expect(cliSwitcher(page)).toHaveAccessibleName('Cursor，切换 CLI');
  const guide = workspace.getByRole('link', { name: '官方安装说明 ↗' });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute('href', /cursor\.com/);
  await expect(workspace.getByRole('button', { name: '安装', exact: true })).toHaveCount(0);
  await expect(workspace.getByRole('button', { name: '安装 npm' })).toHaveCount(0);
  await expect(workspace).not.toContainText('npm');
  await expect(workspace).not.toContainText('agent');
  await openCli(page, 'ZCode');
  await expect(workspace.getByRole('heading', { level: 2, name: 'ZCode' })).toBeVisible();
  const toolLaunch = workspace.getByRole('button', { name: '启动', exact: true });
  await expect(toolLaunch).toHaveAttribute('title', '直接启动已安装的 ZCode，不选择目录');
  const beforeTool = await dialogs();
  await toolLaunch.click();
  await expect(workspace.getByRole('status')).toContainText('ZCode 已请求启动桌面应用');
  await toolLaunch.click({ button: 'right' });
  await expect(toolLaunch).toBeEnabled();
  expect(await dialogs()).toBe(beforeTool);
  const toolRequests = (await requests()).filter((item) => item.toolId === 'zcode' && item.projectId == null);
  expect(toolRequests.at(-1)?.directory).toBeNull();
  expect(toolRequests.at(-2)?.directory).toBeNull();

  await page.evaluate(() => { (window as unknown as { __desktop: { cursorInstalled: boolean } }).__desktop.cursorInstalled = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await launchDirect('Cursor', 'cursor');
  await openCli(page, 'Cursor');
  await expect(workspace.getByRole('heading', { level: 2, name: 'Cursor' })).toBeVisible();
  const cursorLaunch = workspace.getByRole('button', { name: '启动', exact: true });
  await expect(cursorLaunch).toHaveAttribute('title', '直接启动已安装的 Cursor，不选择目录');
  const beforeCursor = await dialogs();
  await cursorLaunch.click();
  await cursorLaunch.click({ button: 'right' });
  await expect(workspace.getByRole('status')).toContainText('Cursor 已请求启动桌面应用');
  expect(await dialogs()).toBe(beforeCursor);
  const cursorRequests = (await requests()).filter((item) => item.toolId === 'cursor' && item.projectId == null);
  expect(cursorRequests.length).toBeGreaterThanOrEqual(2);
  for (const item of cursorRequests) expect(item.directory).toBeNull();
});

/** Native mock in the fully fresh state; a localStorage seed keeps variants across reloads. */
async function installFreshState(page: Page) {
  await page.addInitScript(() => {
    const seed = JSON.parse(localStorage.getItem('__fresh-seed') ?? '{}') as {
      managed?: string[];
      profiles?: Array<{ id: string; name: string }>;
      projects?: Array<Record<string, unknown>>;
    };
    const state = { managed: seed.managed ?? [], profiles: seed.profiles ?? [], projects: seed.projects ?? [] };
    const catalog = () => ({
      registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true }],
      managedIds: [...state.managed],
      preservedUnknown: [],
    });
    Object.assign(window, {
      isTauri: true,
      __fresh: state,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [...state.managed], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return catalog();
        if (command === 'set_registered_managed_tools') { state.managed = [...(args.managedIds ?? [])]; return catalog(); }
        if (command === 'list_projects') return [...state.projects];
        if (command === 'list_portable_items') return state.profiles.map((profile) => ({ key: `profile:${profile.id}`, kind: 'profile', toolId: 'codex', label: profile.name, status: 'available', pendingFields: [] }));
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: state.profiles.map((profile) => ({ id: profile.id, tool: 'codex', name: profile.name, version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5' } })),
          binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
        };
        if (command === 'launch_cli') return { mode: 'normal', status: 'terminal_requested' };
        if (command === 'plugin:dialog|open') return 'C:/work';
        return null;
      } },
    });
  });
}

test('the fresh onboarding checklist checks its steps and retires once complete', async ({ page }) => {
  await installFreshState(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: '首次使用引导' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveCount(3);
  await expect(card.locator('li[data-done]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);

  // Step 1: the entry reaches the managed-CLI checkboxes; checking one marks the step.
  await card.getByRole('button', { name: '去勾选', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(card.locator('li[data-done]')).toHaveCount(1);

  // Step 2: the entry opens the new-profile dialog. Close it before navigating
  // home, then simulate a saved profile to check the onboarding progress.
  await card.getByRole('button', { name: '去创建', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  const profileDialog = page.getByRole('dialog', { name: '新建配置', exact: true });
  await expect(profileDialog).toBeVisible();
  await profileDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(profileDialog).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __fresh: { profiles: Array<{ id: string; name: string }> } }).__fresh.profiles = [{ id: 'daily', name: '日常' }]; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(card.locator('li[data-done]')).toHaveCount(2);

  // Step 3: one launch through the app finishes the guide and records both markers.
  await page.getByLabel('管理中的工具').getByRole('button', { name: '启动', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cliora:onboarding-complete'))).toBe('true');
  expect(await page.evaluate(() => localStorage.getItem('cliora:onboarding-launched'))).toBe('true');
});

test('closing the onboarding checklist keeps it away and settings reopens it', async ({ page }) => {
  await installFreshState(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: '首次使用引导' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '关闭引导' }).click();
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cliora:onboarding-complete'))).toBe('true');
  await page.reload();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('尚未管理工具')).toBeVisible();

  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '重新查看 →' }).click();
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cliora:onboarding-complete'))).toBeNull();
});

test('any existing tool, profile, or project keeps the onboarding checklist hidden', async ({ page }) => {
  await installFreshState(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: '首次使用引导' });
  await expect(card).toBeVisible();
  const seedVariant = async (value: Record<string, unknown>) => {
    await page.evaluate((data) => localStorage.setItem('__fresh-seed', JSON.stringify(data)), value);
    await page.reload();
    await expect(card).toHaveCount(0);
  };
  await seedVariant({ managed: ['codex'] });
  await seedVariant({ profiles: [{ id: 'daily', name: '日常' }] });
  await seedVariant({ projects: [{ id: 'demo', name: 'Demo', path: 'C:/demo', available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }] });
});

test('workbench launch opens the page, external and desktop launches do not, and failure can be retried there', async ({ page }) => {
  await page.addInitScript(() => {
    const sessions: Array<Record<string, unknown>> = [];
    const launches: unknown[] = [];
    const control = { mode: 'workbench' as 'workbench' | 'external' | 'desktop' | 'fail' };
    const project = { id: 'p1', name: '示例项目', path: 'C:/work', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} };
    const facet = { state: 'available', reason: '' };
    const workspace = () => ({ probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [] }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null });
    Object.assign(window, {
      isTauri: true, __launches: launches, __bench: control,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'cursor'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'cursor', name: 'Cursor' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', yoloAvailable: false, interfaceFormats: [], nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet }, { id: 'cursor', name: 'Cursor', launchForm: 'desktop', yoloAvailable: false, interfaceFormats: [], nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet }], managedIds: ['codex', 'cursor'], preservedUnknown: [] };
          if (command === 'list_projects') return [project];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }, { id: 'windows_terminal', label: 'Windows Terminal', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_registered_tool_workspace') return workspace();
          if (command === 'launch_cli') {
            launches.push(args.request);
            if (control.mode === 'fail') throw { message: '目录不可用' };
            if (control.mode === 'external') return { toolId: args.request.toolId, projectId: args.request.projectId, mode: args.request.mode, terminal: 'windows_terminal', status: 'terminal_requested', sessionId: null };
            if (control.mode === 'desktop') return { toolId: args.request.toolId, projectId: args.request.projectId, mode: args.request.mode, terminal: 'desktop', status: 'desktop_requested', sessionId: null };
            const id = `s${sessions.length + 1}`;
            sessions.push({ id, toolId: args.request.toolId, projectId: args.request.projectId, directory: 'C:/work', mode: args.request.mode, running: true, exitCode: null });
            return { toolId: args.request.toolId, projectId: args.request.projectId, mode: args.request.mode, terminal: 'workbench', status: 'session_started', sessionId: id };
          }
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return btoa('ready');
          if (command === 'resize_workbench_session' || command === 'write_workbench_session') return null;
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  });
  const setMode = (mode: string) => page.evaluate((value) => { (window as unknown as { __bench: { mode: string } }).__bench.mode = value; }, mode);
  await page.goto('/');
  const projects = page.getByRole('region', { name: '项目与启动' });
  await projects.getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  const stage = page.getByRole('region', { name: '当前会话' });
  await expect(stage).toContainText('Codex');
  await expect(stage).toContainText('示例项目');
  await expect(stage).toContainText('普通');
  await expect(page.getByText('已向外部终端')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始', exact: true }).click();
  await setMode('external');
  await projects.getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await expect(projects.getByRole('status')).toContainText('已向外部终端发送启动请求');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Codex/ })).toHaveCount(1);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始', exact: true }).click();
  await setMode('desktop');
  const cursor = page.locator('[data-tool-row]', { hasText: 'Cursor' });
  await cursor.getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByRole('heading', { name: '快速开始', level: 1 })).toBeVisible();
  await expect(cursor.getByRole('status')).toContainText('已请求启动桌面应用');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Codex/ })).toHaveCount(1);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始', exact: true }).click();
  await setMode('fail');
  await projects.getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  const alert = page.getByRole('region', { name: '当前会话' }).getByRole('alert');
  await expect(alert).toContainText('目录不可用');
  await expect(alert).toContainText('不会改用外部终端');
  await expect(page.getByRole('tab', { name: /Codex/ })).toHaveCount(1);
  await setMode('workbench');
  await alert.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('tab', { name: /Codex/ })).toHaveCount(2);
  await expect(alert).toHaveCount(0);
});

test('a library prompt opens in the workbench with its initial text', async ({ page }) => {
  await page.addInitScript(() => {
    const prompt = { id: 'prompt-1', kind: 'prompt', title: '审查改动', body: '请先阅读 diff', category: '', projectId: null, version: 1, updatedAt: 1 };
    const launches: Array<Record<string, unknown>> = [];
    const sessions: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true, __promptLaunches: launches,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', yoloAvailable: false, interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_mcp_placements') return [];
          if (command === 'list_library_items') return args.kind === 'prompt' ? [prompt] : [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'launch_cli') {
            launches.push(args.request);
            sessions.push({ id: 'prompt-session', toolId: args.request.toolId, projectId: args.request.projectId, directory: 'C:/work', mode: args.request.mode, running: true, exitCode: null });
            return { toolId: args.request.toolId, projectId: args.request.projectId, mode: args.request.mode, terminal: 'workbench', status: 'session_started', sessionId: 'prompt-session' };
          }
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return btoa('prompt-ready');
          if (command === 'resize_workbench_session') return null;
          if (command === 'plugin:dialog|open') return 'C:/sample/folder';
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '用这条提示词启动' });
  // The same working-directory picker as the workbench's new-session dialog.
  const place = dialog.getByRole('button', { name: '工作目录 / 项目' });
  await expect(place).toHaveText('默认主目录');
  await place.click();
  await page.getByRole('button', { name: '选择其他文件夹…' }).click();
  await expect(place).toContainText('folder');
  await dialog.getByRole('button', { name: '在外部终端启动' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __promptLaunches: Array<{ initialPrompt?: string; directory?: string | null; projectId: string | null }> }).__promptLaunches.map((item) => [item.initialPrompt, item.directory, item.projectId]))).toEqual([['请先阅读 diff', 'C:/sample/folder', null]]);
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: '当前会话' })).toContainText('Codex');
  await expect(page.getByText('已请求外部终端启动会话')).toHaveCount(0);
});

test('a desktop library launch failure stays in the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    const prompt = { id: 'prompt-1', kind: 'prompt', title: '打开编辑器', body: '请打开仓库', category: '', projectId: null, version: 1, updatedAt: 1 };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['cursor'], theme: 'light' }, tools: [{ id: 'cursor', name: 'Cursor' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'cursor', name: 'Cursor', launchForm: 'desktop', yoloAvailable: false, interfaceFormats: [], history: { state: 'available', reason: '' } }], managedIds: ['cursor'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_mcp_placements' || command === 'list_library_items' && args.kind !== 'prompt') return [];
          if (command === 'list_library_items') return [prompt];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'launch_cli') throw new Error('桌面没有打开');
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('button', { name: '启动会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '用这条提示词启动' });
  await dialog.getByRole('button', { name: '在外部终端启动' }).click();
  await expect(dialog.getByRole('alert')).toContainText('桌面没有打开');
  await expect(page.getByRole('heading', { name: '资料库', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '工作台', level: 1 })).toHaveCount(0);
});

test('home lists the tools in daily use first and folds the rest behind one toggle', async ({ page }) => {
  await page.addInitScript(() => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const name = (id: string) => `Tool ${id.toUpperCase()}`;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'system' }, tools: ids.map((id) => ({ id, name: name(id) })) };
        if (command === 'list_cli_adapters') return { registered: ids.map((id) => ({ id, name: name(id), interfaceFormats: [], launchForm: 'terminal' })), managedIds: ids, preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: `C:/${args.toolId}.cmd`, installations: [{ path: `C:/${args.toolId}.cmd`, version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: args.toolId === 'c' ? [{ id: 'daily', tool: 'c', name: '日常', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'm1' } }] : [],
          binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
        };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:dialog|open') return 'C:/work';
        if (command === 'launch_cli') return { mode: args.request.mode, status: 'terminal_requested', toolId: args.request.toolId, projectId: null, terminal: 'auto' };
        if (command.startsWith('plugin:event|')) return 1;
        if (command.startsWith('list_') || command === 'usage_presets') return [];
        return null;
      } },
    });
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const rows = tools.locator('[data-tool-row]');
  // Tools come first; the projects section follows.
  const projectsTop = (await page.getByRole('region', { name: '项目与启动' }).boundingBox())!.y;
  expect((await tools.boundingBox())!.y).toBeLessThan(projectsTop);

  // Only the configured tool is listed; the other seven fold behind one toggle.
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Tool C');
  const more = tools.getByRole('button', { name: '其他 7 个工具', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(rows).toHaveCount(8);
  const less = tools.getByRole('button', { name: '收起其他工具', exact: true });
  await expect(less).toHaveAttribute('aria-expanded', 'true');

  // A row without profiles is quiet: grey 未配置, version as plain text, 新建配置 in the row menu.
  const toolF = rows.filter({ hasText: 'Tool F' });
  await expect(toolF).toContainText('未配置');
  await expect(toolF.locator('[data-status="managedTool.ok"]')).toHaveText('1.0.0');
  await expect(toolF.getByRole('button', { name: '新建配置' })).toHaveCount(0);
  await toolF.getByRole('button', { name: 'Tool F 的更多操作' }).click();
  await expect(page.getByRole('menu', { name: 'Tool F 的更多操作' }).getByRole('menuitem', { name: '新建配置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const heights = await rows.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);

  // A launched tool joins the daily list, and the list survives a reload.
  await toolF.getByRole('button', { name: '启动', exact: true }).click();
  await expect(toolF.getByRole('status')).toContainText('已向外部终端发出请求');
  await less.click();
  await expect(rows).toHaveCount(2);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Tool C');
  await expect(rows.nth(1)).toContainText('Tool F');
  await expect(tools.getByRole('button', { name: '其他 6 个工具', exact: true })).toHaveAttribute('aria-expanded', 'false');

  // Starring a folded tool pins it to the top, above the daily list, and it stays there after a reload.
  await tools.getByRole('button', { name: '其他 6 个工具', exact: true }).click();
  const star = rows.filter({ hasText: 'Tool H' }).getByRole('button', { name: '收藏 Tool H', exact: true });
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(0)).toContainText('Tool H');
  await tools.getByRole('button', { name: '收起其他工具', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.reload();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Tool H');
  await expect(tools.getByRole('button', { name: '其他 5 个工具', exact: true })).toBeVisible();
  // Removing the star returns it to the fold.
  await rows.nth(0).getByRole('button', { name: '收藏 Tool H', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Tool C');
});
test('a failed compared apply explains itself in the dialog and retries with a fresh comparison', async ({ page }) => {
  await installHome(page);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as unknown as { __applyError: string; __compareResult: unknown; __applyComparedError: string };
    state.__applyError = '原生文件已有不同的字段值：settings；请确认接管';
    state.__applyComparedError = '配置资料在比较后变化，请重新比较';
    state.__compareResult = {
      profile: { id: 'work', tool: 'codex', name: '工作', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'gpt-5-codex' } },
      common: null,
      files: [{ role: 'settings', format: 'toml', current: 'model = "old"', proposed: { model: 'new' }, proposedText: 'model = "new"\n' }],
    };
  });
  const tools = page.getByLabel('管理中的工具');
  await tools.getByRole('radio', { name: '工作' }).click();
  const dialog = page.getByRole('dialog', { name: '比较当前文件与本次配置' });
  await expect(dialog).toBeVisible();
  const compares = () => page.evaluate(() => (window as unknown as { __compareCount: number }).__compareCount);
  const before = await compares();
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog.getByRole('alert')).toContainText('配置资料在比较后变化');
  await expect.poll(compares).toBe(before + 1);
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
});
