import { expect, test } from '@playwright/test';

test('new configuration dialog has one save action', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '登录' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接' })).toBeVisible();
  await expect(page.getByText('安装与更新')).toBeVisible();
  await page.getByText('安装与更新').click();
  await expect(page.getByRole('link', { name: '官方安装说明 ↗' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检测' })).toBeVisible();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '新建配置' })).toHaveCount(1);
  await expect(dialog.getByText('先填写名称')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '仅保存' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存并给这个工具使用' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存' })).toBeVisible();
  await expect(dialog.getByLabel('配置名称')).toBeVisible();
  await expect(dialog.getByLabel('API 地址')).toHaveValue('https://api.openai.com/v1');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
});

test('an unfinished tool load does not leave the empty configuration dialog open', async ({ page }) => {
  await page.addInitScript(() => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const workspace = {
      probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: '' }], dependencies: [], installUrl: '', upgradeHint: '' },
      profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
    };
    Object.assign(window, {
      isTauri: true,
      __releaseWorkspace: () => release(),
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex', 'grok'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'grok', name: 'Grok' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }, { id: 'grok', name: 'Grok', interfaceFormats: ['openai_responses'] }], managedIds: ['codex', 'grok'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') { await gate; return workspace; }
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '编辑配置 →' }).first().click();
  await expect(page.getByRole('heading', { name: '工具与连接' })).toBeVisible();
  await expect(page.getByText('正在准备配置')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Grok' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __releaseWorkspace: () => void }).__releaseWorkspace());
  await expect(page.getByText('正在准备配置')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toBeVisible();
});

test('copy path writes the native file path and shows that it copied', async ({ page }) => {
  await page.addInitScript(() => {
    const clipboard: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboard.push(value); } } });
    Object.assign(window, {
      isTauri: true,
      __copiedPaths: clipboard,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.159.2', status: 'available' }], nativeFiles: [{ role: 'config', path: 'C:\\Users\\12976\\.codex\\config.toml', format: 'toml', writable: true, reason: null, sensitive: false }], nativeWrites: { state: 'supported', reason: '已确认 CLI 身份，原生配置可编辑' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('更多选项').click();
  await dialog.getByRole('button', { name: '复制路径' }).click();
  await expect(dialog.getByRole('button', { name: '已复制' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedPaths: string[] }).__copiedPaths)).toEqual(['C:\\Users\\12976\\.codex\\config.toml']);
});
