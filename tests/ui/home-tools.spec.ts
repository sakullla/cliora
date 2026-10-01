import { expect, test, type Locator, type Page } from '@playwright/test';

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
          if (failDetection) throw { message: '找不到 Codex 可执行文件' };
          return workspace();
        }
        if (command === 'plugin:dialog|open') return new Promise((resolve) => dialogs.push(resolve));
        if (command === 'launch_cli') {
          (window as unknown as { __launchRequests: unknown[] }).__launchRequests.push(args.request);
          if (failLaunch) { failLaunch = false; throw { message: '终端不存在' }; }
          return { mode: 'normal', status: 'terminal_requested' };
        }
        if (command === 'apply_registered_native_profile') {
          (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args);
          const profileId = args.profileId;
          const finish = () => { applied.codex = profileId; return { applications: [] }; };
          if (holdApply) {
            holdApply = false;
            return new Promise((resolve, reject) => applies.push({ resolve: () => resolve(finish()), reject }));
          }
          return finish();
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

test('launch failure names the tool and replaces the previous success', async ({ page }) => {
  await installHome(page);
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
  await expect(tools.getByRole('status')).toHaveText('Codex 已向外部终端发出请求。');
  await page.evaluate(() => (window as unknown as { __failNextLaunch: () => void }).__failNextLaunch());
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await expect(tools.getByRole('status')).toHaveCount(0);
  await expect(tools.getByRole('button', { name: '正在启动', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __resolveDialog: (value: string | null) => void }).__resolveDialog('C:/work'));
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
  await expect(alert).toContainText('画面仍是原来的选中项');
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

test('detection failure names the tool and points at edit or reread', async ({ page }) => {
  await installHome(page, true);
  await page.setViewportSize({ width: 1360, height: 768 });
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const alert = tools.getByRole('alert');
  await expect(alert).toHaveText('Codex 检测失败。可编辑配置或重新进入本页重新读取。 找不到 Codex 可执行文件');
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
  await expect(menu).toContainText('m0');
  const rowHeight = await menu.evaluate((element) => element.closest('[data-tool-row]')?.getBoundingClientRect().height ?? 999);
  expect(rowHeight).toBeLessThan(140);
  await menu.click();
  const list = page.getByRole('listbox', { name: '切换Codex的配置' });
  await expect(list.getByRole('option')).toHaveCount(20);
  expect((await list.boundingBox())!.height).toBeLessThan(360);
  await page.getByLabel('搜索配置').fill('配置 12');
  await expect(list.getByRole('option')).toHaveCount(1);
  await list.getByRole('option', { name: '配置 12' }).click();
  await expect(menu).toContainText('配置 12');
  await expect(menu).toContainText('m12');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string }> }).__applyCalls);
  expect(calls.map((call) => call.profileId)).toEqual(['p12']);
});

test('a short profile menu switches by step buttons and shows the model', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { codex: 'zhipu' };
    const profiles = [
      { id: 'kimi', tool: 'codex', name: 'Kimi For Coding', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'k3' } },
      { id: 'zhipu', tool: 'codex', name: 'Zhipu GLM', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'glm-5.3' } },
      { id: 'cpa', tool: 'codex', name: 'cpa', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'claude-opus-5-5' } },
      { id: 'deepseek', tool: 'codex', name: 'DeepSeek', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'deepseek-flash' } },
      { id: 'minimax', tool: 'codex', name: 'MiniMax', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { model: 'MiniMax-M3' } },
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
  const stacked = await menu.evaluate((element) => {
    const name = element.querySelector('span span');
    const model = element.querySelector('small');
    if (!name || !model) return false;
    const nameBox = name.getBoundingClientRect();
    const modelBox = model.getBoundingClientRect();
    return modelBox.top >= nameBox.bottom - 1 && model.textContent === 'glm-5.3' && nameBox.width > 40;
  });
  expect(stacked).toBe(true);
  await tools.getByRole('button', { name: '下一个配置' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(menu).toContainText('cpa');
  await expect(menu).toContainText('claude-opus-5-5');
  await expect(tools.getByRole('status')).toHaveText('Codex 已写入原生文件，下次启动读取。');
  await tools.getByRole('button', { name: '上一个配置' }).click();
  await expect(menu).toContainText('Zhipu GLM');
  await menu.focus();
  await page.keyboard.press('ArrowRight');
  await expect(menu).toContainText('cpa');
  await menu.click();
  const list = page.getByRole('listbox', { name: '切换Codex的配置' });
  await expect(list.getByRole('option')).toHaveCount(6);
  await expect(page.getByLabel('搜索配置')).toHaveCount(0);
  const option = list.getByRole('option', { name: 'DeepSeek' });
  await expect(option).toContainText('deepseek-flash');
  const optionStacked = await option.evaluate((element) => {
    const name = element.querySelector('strong')?.getBoundingClientRect();
    const model = element.querySelector('small')?.getBoundingClientRect();
    return !!name && !!model && model.top >= name.bottom - 1;
  });
  expect(optionStacked).toBe(true);
  await expect(list).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(menu).toContainText('DeepSeek');
  await expect(menu).toContainText('deepseek-flash');
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string }> }).__applyCalls);
  expect(calls.map((call) => call.profileId)).toEqual(['cpa', 'zhipu', 'cpa', 'deepseek']);
});
