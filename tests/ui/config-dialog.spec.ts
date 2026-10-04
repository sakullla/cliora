import { expect, test, type Page } from '@playwright/test';

test('new configuration dialog has one save action', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __externalLinks: [] as string[],
      __failExternal: false,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { url?: string }) => {
        if (command === 'open_external_url') {
          const state=window as unknown as {__externalLinks:string[];__failExternal:boolean};
          if (state.__failExternal) throw {message:'无法打开系统浏览器，请复制链接到浏览器打开'};
          state.__externalLinks.push(args!.url!);return null;
        }
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'], login: { hint: '登录' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }], dependencies: [], installUrl: 'https://developers.openai.com/codex/cli', upgradeHint: '', installCommand: null, upgradeCommand: 'npm install -g @openai/codex@latest', nativeInstallCommand: null },
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
  const docs=page.getByRole('link', { name: '官方安装说明 ↗' });
  await expect(docs).toBeVisible();
  await docs.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {__externalLinks:string[]}).__externalLinks)).toEqual(['https://developers.openai.com/codex/cli']);
  expect(page.context().pages()).toHaveLength(1);
  await page.evaluate(() => { (window as unknown as {__failExternal:boolean}).__failExternal=true; });
  await docs.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({hasText:'无法打开系统浏览器'})).toBeVisible();

  await expect(page.getByText('当前 1.0.0')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检测' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安装原生' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更新', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '新建配置' })).toHaveCount(1);
  await expect(dialog.getByText('先填写名称')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '仅保存' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存并给这个工具使用' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('配置名称')).toBeVisible();
  await expect(dialog.getByLabel('API 地址')).toHaveValue('https://api.openai.com/v1');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
});

test('install panel updates the active source and can switch to the native CLI', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __maintainCalls: [] as unknown[],
      __pathCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { action?: string; source?: string; path?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'cli_latest_version') return '0.200.0';
        if (command === 'maintain_registered_cli') { (window as unknown as { __maintainCalls: unknown[] }).__maintainCalls.push(args); return null; }
        if (command === 'set_registered_custom_cli_path') { (window as unknown as { __pathCalls: unknown[] }).__pathCalls.push(args); return null; }
        if (command === 'get_registered_tool_workspace') return {
          probe: {
            selectedPath: 'C:/Users/me/AppData/Roaming/npm/codex.cmd',
            installations: [
              { path: 'C:/Users/me/AppData/Roaming/npm/codex.cmd', version: '0.159.3', source: 'npm_shim', status: 'available', detail: null },
              { path: 'C:/Users/me/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe', version: '0.160.0', source: 'native', status: 'available', detail: null },
            ],
            nativeFiles: [], nativeWrites: { state: 'supported', reason: '已确认 CLI 身份，原生配置可编辑' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [{ name: 'Node.js', status: 'found', detail: 'npm 命令入口需要 Node.js', helpUrl: 'https://nodejs.org' }, { name: 'npm', status: 'missing', detail: '升级 npm 安装需要 npm', helpUrl: 'https://nodejs.org' }],
            installUrl: 'https://developers.openai.com/codex/cli', upgradeHint: '按官方文档更新 Codex CLI；使用原安装来源升级。', installCommand: null, upgradeCommand: 'npm install -g @openai/codex@latest', nativeInstallCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex', npmInstallCommand: 'npm install -g @openai/codex',
          },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByText('安装与更新').click();
  await expect(page.getByText('按官方文档更新')).toHaveCount(0);
  await expect(page.getByText('npm 命令入口需要 Node.js')).toHaveCount(0);
  await expect(page.getByText('os error 193')).toHaveCount(0);
  await expect(page.getByText('两份都在。选择栖点启动用的那一份。')).toBeVisible();
  await expect(page.getByRole('button', { name: '卸载 npm 版' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安装原生' })).toHaveCount(0);
  await page.getByText('指定路径').click();
  await expect(page.getByRole('textbox', { name: 'CLI 可执行文件路径' })).toBeVisible();
  await expect(page.getByText('npm 缺失')).toBeVisible();
  await expect(page.getByText('最新 0.200.0')).toBeVisible();
  await expect(page.getByRole('button', { name: '安装原生' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新检测' })).toHaveCount(0);
  await page.getByRole('button', { name: '更新 npm', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '使用', exact: true }).click();
  const maintain = await page.evaluate(() => (window as unknown as { __maintainCalls: Array<{ action: string; source: string | null }> }).__maintainCalls);
  const paths = await page.evaluate(() => (window as unknown as { __pathCalls: Array<{ path: string }> }).__pathCalls);
  expect(maintain).toEqual([{ toolId: 'codex', action: 'upgrade', source: 'npm_shim' }]);
  expect(paths).toEqual([{ toolId: 'codex', path: 'C:/Users/me/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe' }]);
});

test('a missing CLI asks which install channel to use', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __maintainCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { action?: string; source?: string | null }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'maintain_registered_cli') { (window as unknown as { __maintainCalls: unknown[] }).__maintainCalls.push(args); return null; }
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '未发现可确认身份的 CLI' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: 'https://developers.openai.com/codex/cli', upgradeHint: '', installCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex', upgradeCommand: null, nativeInstallCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex', npmInstallCommand: 'npm install -g @openai/codex' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByText('安装与更新').click();
  await expect(page.getByRole('button', { name: '安装', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '安装 npm', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '安装', exact: true }).click();
  const maintain = await page.evaluate(() => (window as unknown as { __maintainCalls: Array<{ action: string; source: string | null }> }).__maintainCalls);
  expect(maintain).toEqual([{ toolId: 'codex', action: 'install', source: 'npm_shim' }]);
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

test('saving a configuration closes the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profile?: { name: string } }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'prepare_registered_native_import') return { files: {}, inspection: { connection: null, reasoningEffort: null }, migratedSecret: false, nativeCredentials: {} };
        if (command === 'save_registered_native_profile') return { id: 'saved-1', tool: 'codex', name: args?.profile?.name ?? '新配置', version: 1, revision: '', inheritCommon: false, files: {}, suppressed: {}, connection: { providerId: 'my-provider', interfaceFormat: 'openai_responses', baseUrl: '', model: '', secretRef: null, authEnvVar: null }, nativeCredentials: {} };
        if (command === 'apply_registered_native_profile') return { transactionId: '1', changedFiles: [], status: 'written_for_next_session' };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('已保存');
});

test('enabling a saved profile opens a comparison when the native file differs', async ({ page }) => {
  await page.addInitScript(() => {
    const saved = { id: 'saved-1', tool: 'codex', name: '新配置', version: 1, revision: '', inheritCommon: false, files: {}, suppressed: {}, connection: { providerId: 'my-provider', interfaceFormat: 'openai_responses', baseUrl: 'https://api.openai.com/v1', model: '', secretRef: null, authEnvVar: null }, nativeCredentials: {} };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [{ role: 'config', path: 'C:/codex/config.toml', format: 'toml', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: '' }], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [saved], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'apply_registered_native_profile') throw '原生文件已有不同的字段值：config；请确认接管';
        if (command === 'compare_registered_application') return { profile: saved, common: null, files: [{ role: 'config', format: 'toml', current: 'model = "old"', proposed: { model: 'new' }, proposedText: 'model = "new"\n' }] };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.locator('[data-profile-id="saved-1"]').getByRole('button', { name: '启用' }).click();
  const comparison = page.getByRole('dialog', { name: '比较当前文件与本次配置' });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText('model = "old"')).toBeVisible();
  await expect(comparison.getByText('model = "new"')).toBeVisible();
  await expect(comparison.getByRole('button', { name: '保留当前文件' })).toBeVisible();
  await expect(comparison.getByRole('button', { name: '使用本次配置' })).toBeVisible();
  await expect(page.locator('[data-profile-id="saved-1"]').getByText('正在使用')).toHaveCount(0);
});

test('claude role models sit in the form and copy the current model with 1M context', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/claude.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '所有角色使用当前模型' })).toBeVisible();
  await expect(dialog.getByText('模型角色映射')).toHaveCount(0);
  await dialog.getByLabel('模型', { exact: true }).fill('glm-5.3');
  await dialog.getByRole('checkbox', { name: '1M 上下文', exact: true }).check();
  await dialog.getByRole('button', { name: '所有角色使用当前模型' }).click();
  await expect(dialog.getByLabel('Sonnet 请求模型')).toHaveValue('glm-5.3');
  await expect(dialog.getByLabel('Opus 请求模型')).toHaveValue('glm-5.3');
  await expect(dialog.getByRole('checkbox', { name: 'Sonnet 1M 上下文' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Opus 1M 上下文' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Haiku 1M 上下文' })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: 'Sonnet 1M 上下文' }).uncheck();
  await expect(dialog.getByRole('checkbox', { name: 'Sonnet 1M 上下文' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Sonnet 1M 上下文' }).check();
  await expect(dialog.getByRole('checkbox', { name: 'Sonnet 1M 上下文' })).toBeChecked();
});

test('the model menu filters inside the dropdown', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: '' }], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'list_provider_models') return { models: ['glm-5.3', 'glm-4.5', 'glm-5.3-flashx'], status: 'ready', fetchedAt: 1, error: null, source: 'provider_directory' };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '获取模型' }).click();
  await dialog.getByLabel('模型', { exact: true }).click();
  await expect(page.getByRole('option', { name: 'glm-4.5' })).toBeVisible();
  await dialog.getByLabel('模型', { exact: true }).fill('flash');
  await expect(page.getByRole('option', { name: 'glm-5.3-flashx' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'glm-4.5' })).toHaveCount(0);
  await page.getByRole('option', { name: 'glm-5.3-flashx' }).click();
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('glm-5.3-flashx');
});

test('clicking a saved profile switches the active configuration', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { id: 'kimi' };
    const profiles = [
      { id: 'kimi', tool: 'claude_code', name: 'Kimi For Coding', version: 1, revision: 'a', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { providerId: 'kimi', interfaceFormat: 'anthropic_messages', baseUrl: 'https://api.kimi.com/coding', model: 'k3', secretRef: null, authEnvVar: null } },
      { id: 'zhipu', tool: 'claude_code', name: 'Zhipu GLM', version: 1, revision: 'b', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { providerId: 'zhipu', interfaceFormat: 'anthropic_messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', secretRef: null, authEnvVar: null } },
    ];
    const workspace = () => {
      const profile = profiles.find((item) => item.id === applied.id);
      return {
        probe: { selectedPath: 'C:/claude.cmd', installations: [{ path: 'C:/claude.cmd', version: '2.1.284', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
        profiles, binding: { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: profile?.version ?? 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
      };
    };
    Object.assign(window, {
      isTauri: true,
      __applyCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profileId?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return workspace();
        if (command === 'apply_registered_native_profile') {
          (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args);
          applied.id = args?.profileId ?? applied.id;
          return { transactionId: '1', changedFiles: ['settings'], status: 'written_for_next_session' };
        }
        if (command === 'prepare_registered_native_import') return { files: {}, inspection: { connection: null, reasoningEffort: null }, migratedSecret: false, nativeCredentials: {} };
        if (command === 'save_registered_native_profile') return profiles.find((item) => item.id === 'zhipu');
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const kimi = page.locator('[data-profile-id="kimi"]');
  const zhipu = page.locator('[data-profile-id="zhipu"]');
  await expect(kimi.getByText('正在使用')).toBeVisible();
  await zhipu.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('dialog', { name: '修改配置' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '修改配置' })).toHaveCount(0);
  await expect(page.getByText('当前仍使用「Kimi For Coding」')).toBeVisible();
  await expect(kimi.getByText('正在使用')).toBeVisible();
  await zhipu.getByRole('button', { name: '启用' }).click();
  await expect(zhipu.getByText('正在使用')).toBeVisible();
  await expect(kimi.getByText('已保存')).toBeVisible();
  await expect(page.getByText('已使用此配置，下次启动生效。')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string; scope: string; allowTakeover: boolean }> }).__applyCalls);
  expect(calls).toEqual([{ toolId: 'claude_code', profileId: 'zhipu', scope: 'global', projectPath: null, allowTakeover: false }]);
});

test('save and enable switches to the edited profile from the dialog', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { id: 'kimi' };
    const profiles = [
      { id: 'kimi', tool: 'claude_code', name: 'Kimi For Coding', version: 1, revision: 'a', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { providerId: 'kimi', interfaceFormat: 'anthropic_messages', baseUrl: 'https://api.kimi.com/coding', model: 'k3', secretRef: null, authEnvVar: null } },
      { id: 'zhipu', tool: 'claude_code', name: 'Zhipu GLM', version: 1, revision: 'b', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: { providerId: 'zhipu', interfaceFormat: 'anthropic_messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-5.3', secretRef: null, authEnvVar: null } },
    ];
    Object.assign(window, {
      isTauri: true,
      __applyCalls: [] as unknown[],
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profileId?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/claude.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles, binding: { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
        };
        if (command === 'apply_registered_native_profile') {
          (window as unknown as { __applyCalls: unknown[] }).__applyCalls.push(args);
          applied.id = args?.profileId ?? applied.id;
          return { transactionId: '1', changedFiles: ['settings'], status: 'written_for_next_session' };
        }
        if (command === 'prepare_registered_native_import') return { files: {}, inspection: { connection: null, reasoningEffort: null }, migratedSecret: false, nativeCredentials: {} };
        if (command === 'save_registered_native_profile') return profiles[1];
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const zhipu = page.locator('[data-profile-id="zhipu"]');
  await page.locator('[data-profile-id="kimi"]').getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '保存并启用' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await zhipu.getByRole('button', { name: '修改', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改配置' });
  await dialog.getByRole('button', { name: '保存并启用' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(zhipu.getByText('正在使用')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('已保存并启用');
  const calls = await page.evaluate(() => (window as unknown as { __applyCalls: Array<{ profileId: string }> }).__applyCalls);
  expect(calls.map(call => call.profileId)).toEqual(['zhipu']);
});

test('subscription profiles are grouped apart and quota is added from the row menu', async ({ page }) => {
  await page.addInitScript(() => {
    const connection = { providerId: 'p', interfaceFormat: 'openai_responses', baseUrl: 'https://api.example.test/v1', model: 'm', secretRef: null, authEnvVar: null };
    const profiles = [
      { id: 'plain', tool: 'codex', name: '普通配置', version: 1, revision: 'a', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection },
      { id: 'plan', tool: 'codex', name: '套餐配置', version: 1, revision: 'b', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection },
    ];
    const config = { schemaVersion: 1, label: '套餐查询', site: 'https://quota.example.test', identity: { profileId: 'plan', accountId: null, contextId: null, subject: 'plan', subjectId: null }, program: { kind: 'builtin', provider: 'glm', templateVersion: 1 }, parameters: {}, targets: [], enabled: true, refreshIntervalSeconds: 0 };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp' || command === 'list_usage_cache') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles, binding: { scopeKey: 'global', tool: 'codex', profileId: 'plain', profileVersion: 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
        };
        if (command === 'list_usage_queries') return [{ id: 'q1', version: 1, generation: 1, config, credentials: [] }];
        if (command === 'usage_presets') return [{ id: 'glm-cn', label: 'GLM', description: '套餐查询', config, credentials: [] }];
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const subscription = page.locator('[data-group="subscription"]');
  const other = page.locator('[data-group="other"]');
  await expect(subscription.getByText('订阅套餐', { exact: true })).toBeVisible();
  await expect(subscription.locator('[data-profile-id="plan"]')).toBeVisible();
  await expect(other.getByText('其他配置', { exact: true })).toBeVisible();
  await expect(other.locator('[data-profile-id="plain"]')).toBeVisible();
  const plain = other.locator('[data-profile-id="plain"]');
  await expect(plain.getByRole('button', { name: '添加额度查询' })).toHaveCount(0);
  await plain.getByRole('button', { name: '普通配置 更多操作' }).click();
  await page.getByRole('menuitem', { name: '添加额度查询' }).click();
  await expect(page.getByRole('dialog', { name: '额度查询设置' })).toBeVisible();
});

test('the profile row menu stays fully clickable past the card edge', async ({ page }) => {
  await page.addInitScript(() => {
    const connection = { providerId: 'p', interfaceFormat: 'openai_responses', baseUrl: 'https://cpa.example.test/v1', model: 'devin/swe-2', secretRef: null, authEnvVar: null };
    const profiles = [{ id: 'live', tool: 'codex', name: '新配置', version: 1, revision: 'a', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp' || command === 'list_usage_queries' || command === 'list_usage_cache') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles, binding: { scopeKey: 'global', tool: 'codex', profileId: 'live', profileVersion: 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
        };
        if (command === 'usage_presets') return [];
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新配置 更多操作' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: '修改配置' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '删除配置' })).toBeVisible();
  const hit = await menu.evaluate((node) => {
    const menuRect = node.getBoundingClientRect();
    const list = document.querySelector('[aria-label="配置列表"]');
    const listRect = list?.getBoundingClientRect();
    const points = [
      [menuRect.left + menuRect.width / 2, menuRect.top + 8],
      [menuRect.left + menuRect.width / 2, menuRect.top + menuRect.height / 2],
      [menuRect.left + 12, menuRect.bottom - 8],
      [menuRect.right - 12, menuRect.bottom - 8],
    ];
    return {
      escapes: !!listRect && menuRect.bottom > listRect.bottom + 4,
      covered: points.some(([x, y]) => {
        const target = document.elementFromPoint(x, y);
        return !target || !node.contains(target);
      }),
    };
  });
  expect(hit.escapes).toBe(true);
  expect(hit.covered).toBe(false);
  await menu.getByRole('menuitem', { name: '修改配置' }).click();
  await expect(page.getByRole('dialog', { name: '修改配置' })).toBeVisible();
});

test('a long configuration list can be searched without growing the page', async ({ page }) => {
  await page.addInitScript(() => {
    const applied = { id: 'p0' };
    const profiles = Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, tool: 'claude_code', name: index === 0 ? 'Kimi For Coding' : `配置 ${index}`, version: 1, revision: String(index), inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: null }));
    const workspace = () => ({
      probe: { selectedPath: 'C:/claude.cmd', installations: [{ path: 'C:/claude.cmd', version: '2.1.284', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
      profiles, binding: { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: 1, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { profileId?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'] }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return workspace();
        if (command === 'apply_registered_native_profile') { applied.id = args?.profileId ?? applied.id; return { transactionId: '1', changedFiles: [], status: 'written_for_next_session' }; }
        if (command === 'inspect_registered_native_draft') return { connection: null, reasoningEffort: null };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const group = page.getByRole('list', { name: '配置项' });
  await expect(page.getByLabel('搜索配置')).toBeVisible();
  const overflow = await group.evaluate((element) => element.scrollHeight > element.clientHeight && element.clientHeight <= 406);
  expect(overflow).toBe(true);
  await page.getByLabel('搜索配置').fill('配置 12');
  await expect(group.getByRole('listitem')).toHaveCount(1);
  await group.getByRole('button', { name: '启用' }).click();
  await expect(group.getByText('正在使用')).toBeVisible();
});

test('native file history replaces the editor instead of stacking a diff', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { transactionId?: string }) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_skill_recovery_issues' || command === 'scan_native_skills' || command === 'list_native_mcp') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '0.159.2', status: 'available' }], nativeFiles: [{ role: 'config', path: 'C:\\Users\\12976\\.codex\\config.toml', format: 'toml', writable: true, reason: null, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
          profiles: [], common: null, binding: null, snapshots: [{ role: 'config', fingerprint: 'abc' }], recoveryNeeded: [], customPath: null,
        };
        if (command === 'read_registered_native_file_for_edit') return 'model = "now"\n';
        if (command === 'list_native_backups') return [
          { transactionId: 'newer', path: 'C:\\Users\\12976\\.codex\\config.toml', createdAt: 0 },
          { transactionId: 'older', path: 'C:\\Users\\12976\\.codex\\config.toml', createdAt: 0 },
        ];
        if (command === 'preview_native_backup') return { transactionId: args?.transactionId, current: 'model = "now"\n', original: args?.transactionId === 'older' ? 'model = "older"\n' : 'model = "old"\n' };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '修改正在使用的文件' }).click();
  const dialog = page.getByRole('dialog', { name: '修改正在使用的文件' });
  await dialog.getByRole('button', { name: '修改记录' }).click();
  const history = page.getByRole('dialog', { name: '修改记录' });
  const list = history.getByRole('list', { name: '修改记录' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('button', { name: '最近一次', pressed: true })).toBeVisible();
  await expect(history.getByRole('textbox', { name: '当时的文件' })).toContainText('model = "old"');
  await expect(history.getByText('当前文件')).toHaveCount(0);
  await list.getByRole('button', { name: '往前 1 次' }).click();
  await expect(history.getByRole('textbox', { name: '当时的文件' })).toContainText('model = "older"');
  await history.getByRole('button', { name: '恢复这个版本' }).click();
  await expect(page.getByRole('dialog', { name: '恢复这个版本？' })).toBeVisible();
  await page.getByRole('button', { name: '取消' }).click();
  await history.getByRole('button', { name: '返回编辑' }).click();
  await expect(page.getByRole('dialog', { name: '修改正在使用的文件' })).toBeVisible();
});


test('native multi-file switching reuses the editor and separates undo history', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { reads: [] as string[] };
    Object.assign(window, { isTauri: true, multiFileHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args?: { role?: string }) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['zcode'], theme: 'system' }, tools: [{ id: 'zcode', name: 'ZCode' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'zcode', name: 'ZCode', interfaceFormats: [] }], managedIds: ['zcode'], preservedUnknown: [] };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'scan_native_skills') return [];
      if (command === 'get_registered_tool_workspace') return {
        probe: { selectedPath: 'C:/pi.cmd', installations: [], nativeFiles: [
          { role: 'settings', path: 'C:/fixture/settings.json', format: 'json', writable: true, sensitive: false },
          { role: 'models', path: 'C:/fixture/models.json', format: 'json', writable: true, sensitive: false }],
          nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
        profiles: [], common: null, binding: null, snapshots: [{ role: 'settings', fingerprint: 'a' }, { role: 'models', fingerprint: 'b' }], recoveryNeeded: [], customPath: null,
      };
      if (command === 'read_registered_native_file_for_edit') { state.reads.push(args?.role ?? ''); return args?.role === 'models' ? '{"models": []}' : '{"theme": "light"}'; }
      return null;
    } } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '修改正在使用的文件' }).click();
  const dialog = page.getByRole('dialog', { name: '修改正在使用的文件' });
  const settings = dialog.getByRole('textbox', { name: 'settings 配置草稿' });
  await expect(settings).toContainText('light');
  await settings.evaluate(element => { (window as any).firstEditor = element; });
  await settings.fill('{"theme": "dark"}');
  await dialog.getByRole('button', { name: 'models.json', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(settings).toContainText('dark');
  expect(await page.evaluate(() => (window as any).multiFileHarness.reads)).toEqual(['settings']);
  await dialog.getByRole('button', { name: 'models.json', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存修改？' }).getByRole('button', { name: '放弃修改' }).click();
  const models = dialog.getByRole('textbox', { name: 'models 配置草稿' });
  await expect(models).toContainText('"models"');
  expect(await models.evaluate(element => element === (window as any).firstEditor)).toBe(true);
  await models.press('Control+z');
  await expect(models).toContainText('"models"');
  await expect(models).not.toContainText('theme');
  await dialog.getByRole('button', { name: 'settings.json', exact: true }).click();
  await expect(settings).toContainText('light');
  expect(await page.evaluate(() => (window as any).multiFileHarness.reads)).toEqual(['settings', 'models', 'settings']);
  await page.screenshot({ path: 'test-results/native-multi-file.png' });
});

const connectionTools = [
  { id: 'pi', name: 'Pi' },
  { id: 'open_code', name: 'OpenCode' },
  { id: 'codex', name: 'Codex' },
  { id: 'claude_code', name: 'Claude Code' },
  { id: 'grok', name: 'Grok' },
  { id: 'codebuddy', name: 'CodeBuddy' },
  { id: 'zcode', name: 'ZCode' },
];

async function installConnectionHarness(page: Page) {
  await page.addInitScript(({ tools }) => {
    const connectionProfile = (partial: Record<string, unknown>) => ({ version: 1, revision: '', inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, ...partial });
    const projectDenied: Record<string, string> = {
      codex: 'Codex 项目层不能写入供应商密钥；请使用全局配置',
      pi: 'Pi 项目层不能写入供应商密钥；请使用全局配置',
      open_code: 'OpenCode 项目共享配置不能写入明文密钥；请使用全局配置或原生登录',
      grok: 'Grok 项目层不能写入供应商密钥；请使用全局配置',
    };
    const unsupportedKey: Record<string, string> = { zcode: 'ZCode 凭据由产品加密保管（credentials.json），不提供凭据管理' };
    const unsupportedAddress: Record<string, string> = {
      codebuddy: 'CodeBuddy 此版本不提供第三方供应商接口接入；模型经官方网关访问',
      zcode: 'ZCode 桌面端经产品内账号登录；setting.json 无文档化 API 连接字段',
    };
    const projectionFor = (id: string) => id === 'pi' || id === 'open_code' ? 'provider_models' : id === 'codex' ? 'current_model' : 'single_connection';
    const policy = (id: string, scope: string) => {
      const keyState = unsupportedKey[id] ? 'unsupported' : scope === 'project' && projectDenied[id] ? 'scope_denied' : 'writable';
      return {
        apiKey: { state: keyState, reason: keyState === 'writable' ? '' : unsupportedKey[id] || projectDenied[id] || '' },
        providerAddress: { state: unsupportedAddress[id] ? 'unsupported' : 'configurable', reason: unsupportedAddress[id] || '' },
        projection: projectionFor(id),
      };
    };
    const connection = (providerId: string, model: string, baseUrl = 'https://api.example/v1') => ({ providerId, interfaceFormat: 'openai_responses', baseUrl, model, secretRef: null, authEnvVar: null });
    const profiles = [
      connectionProfile({ id: 'pi-models', tool: 'pi', name: 'Pi 多模型', files: { models: 'model-a' }, connection: connection('demo', 'model-a') }),
      connectionProfile({ id: 'pi-empty', tool: 'pi', name: '无模型', connection: connection('demo', '') }),
      connectionProfile({ id: 'oc-models', tool: 'open_code', name: 'OpenCode 模型', files: { models: 'm1' }, connection: connection('demo', 'm1') }),
      connectionProfile({ id: 'codex-draft', tool: 'codex', name: 'Codex 草稿', files: { settings: 'model = "gpt"\nmodel_reasoning_effort = "high"\n' }, connection: connection('demo', 'gpt', 'https://api.openai.com/v1') }),
      connectionProfile({ id: 'cb-official', tool: 'codebuddy', name: '官方网关', connection: { providerId: 'official', interfaceFormat: 'openai_responses', baseUrl: 'https://third.example/v1', model: 'auto', secretRef: null, authEnvVar: null } }),
      connectionProfile({ id: 'zc-login', tool: 'zcode', name: '已有登录', authentication: { kind: 'api_key' }, connection: connection('zcode', 'z', 'https://hidden.example') }),
    ];
    const project = { id: 'demo', name: '示例项目', path: '/work/demo', available: true, preferredTool: null, lastOpened: 0, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} };
    const state = window as unknown as { __savedProfile: unknown };
    Object.assign(window, {
      isTauri: true,
      __savedProfile: null,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, any>) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map(item => item.id), theme: 'system' }, tools };
        if (command === 'list_cli_adapters') return { registered: tools.map(item => ({ ...item, interfaceFormats: ['openai_responses'] })), managedIds: tools.map(item => item.id), preservedUnknown: [] };
        if (command === 'list_projects') return [project];
        if (['list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp', 'list_accounts', 'account_capabilities', 'list_usage_queries', 'list_usage_cache', 'usage_presets'].includes(command)) return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        if (command === 'discover_native_logins') return { logins: [] };
        if (command === 'get_registered_tool_workspace') {
          const toolId = String(args?.toolId ?? '');
          const scope = String(args?.scope ?? 'global');
          return {
            probe: {
              selectedPath: 'C:/tool.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [toolId === 'claude_code' ? 'anthropic_messages' : 'openai_responses'],
              providerPresets: toolId === 'codebuddy' || toolId === 'codex' ? [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }] : [],
              dependencies: [], installUrl: '', upgradeHint: '', connectionPolicy: policy(toolId, scope),
            },
            profiles: profiles.filter(item => item.tool === toolId), common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
        }
        if (command === 'inspect_registered_native_draft') {
          const toolId = String(args?.toolId ?? '');
          const files = args?.files ?? {};
          if (toolId === 'pi' && String(files.models ?? '').includes('model-a')) return { providerId: 'demo', model: 'model-a', reasoningEffort: null, projectedModels: [{ id: 'model-a', fields: { contextWindow: 100, cost: { input: 1 } } }, { id: 'sibling', fields: { name: 'Keep' } }], connection: connection('demo', 'model-a') };
          if (toolId === 'open_code') return { providerId: 'demo', model: 'm1', reasoningEffort: null, projectedModels: [{ id: 'm1', fields: { name: 'Custom', extra: true } }, { id: 'm2', fields: { name: 'Second' } }], connection: connection('demo', 'm1') };
          if (toolId === 'codex') return { providerId: 'demo', model: 'gpt', reasoningEffort: 'low', projectedModels: null, connection: connection('demo', 'gpt', 'https://api.openai.com/v1') };
          return { connection: null, reasoningEffort: null, projectedModels: null };
        }
        if (command === 'prepare_registered_native_import') return { files: args?.files ?? {}, inspection: { connection: null, reasoningEffort: null, projectedModels: null }, migratedSecret: false, nativeCredentials: {} };
        if (command === 'save_registered_native_profile') {
          state.__savedProfile = args?.profile ?? null;
          const profile = args?.profile ?? {};
          return { ...profile, id: profile.id || 'saved-1', version: (profile.version || 0) + 1 };
        }
        if (command === 'apply_registered_native_profile') return { transactionId: '1', changedFiles: [], status: 'written_for_next_session' };
        if (command === 'set_codex_reasoning_effort') {
          const text = String(args?.text ?? '');
          const effort = args?.effort ? String(args.effort) : '';
          const line = /^\s*model_reasoning_effort\s*=.*$/m;
          if (!effort) return text.replace(line, '');
          const next = `model_reasoning_effort = "${effort}"`;
          return line.test(text) ? text.replace(line, next) : `${text.replace(/\s*$/, '')}\n${next}\n`;
        }
        return null;
      } },
    });
  }, { tools: connectionTools });
}

async function openConnections(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接' })).toBeVisible();
}

async function replaceNumber(field: ReturnType<Page['locator']>, value: string) {
  await field.click();
  await field.press('ControlOrMeta+A');
  await field.pressSequentially(value);
}

test('projected model fields stay on the selected provider and codex effort comes from the draft', async ({ page }) => {
  test.setTimeout(45_000);
  await installConnectionHarness(page);
  await openConnections(page);
  await page.locator('[data-profile-id="pi-models"]').getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('model-a contextWindow')).toHaveValue('100');
  await expect(dialog.getByLabel('model-a cost.input')).toHaveValue('1');
  await expect(dialog.getByLabel('sibling name')).toHaveValue('Keep');
  await expect(dialog.getByRole('checkbox', { name: '1M 上下文' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '获取模型' })).toHaveCount(0);
  await expect(dialog.getByLabel('推理强度（Codex 原生）')).toHaveCount(0);
  await replaceNumber(dialog.getByLabel('model-a contextWindow'), '128');
  await expect(dialog.getByLabel('model-a contextWindow')).toHaveValue('128');
  await dialog.getByLabel('sibling name').fill('Renamed');
  await dialog.getByLabel('当前模型').selectOption('sibling');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await page.evaluate(() => (window as unknown as { __savedProfile: { connection: { model: string; modelRecords: unknown } } }).__savedProfile);
  expect(saved.connection.model).toBe('sibling');
  expect(saved.connection.modelRecords).toEqual([
    { id: 'model-a', fields: { contextWindow: 128, cost: { input: 1 } } },
    { id: 'sibling', fields: { name: 'Renamed' } },
  ]);

  await page.locator('[data-profile-id="pi-empty"]').getByRole('button', { name: '修改' }).click();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('当前模型')).toHaveCount(0);
  await expect(dialog.getByLabel('已有模型字段')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'OpenCode' }).click();
  await page.locator('[data-profile-id="oc-models"]').getByRole('button', { name: '修改' }).click();
  await expect(dialog.getByLabel('m1 name')).toHaveValue('Custom');
  await expect(dialog.getByRole('checkbox', { name: 'm1 extra' })).toBeChecked();
  await expect(dialog.getByLabel('m2 name')).toHaveValue('Second');
  await expect(dialog.getByLabel(/contextWindow/)).toHaveCount(0);
  await expect(dialog.getByLabel('推理强度（Codex 原生）')).toHaveCount(0);
  await dialog.getByLabel('当前模型').selectOption('m2');
  await expect(dialog.getByLabel('当前模型')).toHaveValue('m2');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.locator('[data-profile-id="codex-draft"]').getByRole('button', { name: '修改' }).click();
  const effort = dialog.getByLabel('推理强度（Codex 原生）');
  await expect(effort).toHaveValue('high');
  await effort.selectOption('medium');
  await expect(effort).toHaveValue('medium');
  await expect(dialog.getByLabel('已有模型字段')).toHaveCount(0);
  await expect(dialog.getByLabel('当前模型')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: '1M 上下文' })).toHaveCount(0);
  await expect(dialog.getByLabel(/contextWindow/)).toHaveCount(0);
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
});

test('key entry follows the current scope and writable CLI without hiding provider fields', async ({ page }) => {
  test.setTimeout(60_000);
  await installConnectionHarness(page);
  await openConnections(page);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: /示例项目/ }).click();
  await page.locator('[data-profile-id="pi-models"]').getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('model-a contextWindow')).toHaveValue('100');
  await expect(dialog.locator('option', { hasText: 'API Key' })).toHaveCount(0);
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog).toContainText('Pi 项目层不能写入供应商密钥；请使用全局配置');
  await expect(dialog).not.toContainText('不支持密钥');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.locator('option', { hasText: 'API Key' })).toHaveCount(0);
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog).toContainText('Pi 项目层不能写入供应商密钥；请使用全局配置');
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'Claude Code' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.getByLabel('API 密钥')).toBeVisible();
  await expect(dialog.getByLabel('API 地址')).toBeVisible();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: '1M 上下文', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '所有角色使用当前模型' })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'Pi' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog).toContainText('Pi 项目层不能写入供应商密钥；请使用全局配置');
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '全局配置', exact: true }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.locator('option', { hasText: 'API Key' })).toHaveCount(1);
  await expect(dialog.getByLabel('API 密钥')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'Grok' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.getByLabel('API 地址')).toBeVisible();
  await expect(dialog.getByLabel('API 密钥')).toBeVisible();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('当前模型')).toHaveCount(0);
  await expect(dialog.getByLabel('已有模型字段')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: '1M 上下文' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: /示例项目/ }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog).toContainText('Grok 项目层不能写入供应商密钥；请使用全局配置');
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog.getByLabel('API 地址')).toBeVisible();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('不支持密钥');
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'CodeBuddy' }).click();
  await page.locator('[data-profile-id="cb-official"]').getByRole('button', { name: '修改' }).click();
  await expect(dialog.getByLabel('API 密钥')).toBeVisible();
  await expect(dialog.getByLabel('API 地址')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'OpenAI' })).toHaveCount(0);
  await expect(dialog).not.toContainText('https://third.example');
  await dialog.getByText('更多选项', { exact: true }).click();
  await dialog.getByText('高级连接选项', { exact: true }).click();
  await expect(dialog.getByLabel('供应商 ID')).toHaveCount(1);
  await expect(dialog.getByLabel('供应商 ID')).toHaveValue('official');
  await dialog.getByLabel('认证环境变量名').fill('CODEBUDDY_API_KEY');
  await expect(dialog.getByLabel('认证环境变量名')).toHaveValue('CODEBUDDY_API_KEY');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('tab', { name: 'ZCode' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  await expect(dialog.locator('option', { hasText: 'API Key' })).toHaveCount(0);
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog.getByLabel('API 地址')).toHaveCount(0);
  await expect(dialog).not.toContainText('不支持密钥');
  await expect(dialog).not.toContainText('凭据由产品加密保管');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.locator('[data-profile-id="zc-login"]').getByRole('button', { name: '修改' }).click();
  await expect(dialog.locator('option', { hasText: 'API Key' })).toHaveCount(0);
  await expect(dialog.getByLabel('API 密钥')).toHaveCount(0);
  await expect(dialog.getByLabel('API 地址')).toHaveCount(0);
  await expect(dialog).not.toContainText('不支持密钥');
  await expect(dialog).not.toContainText('https://hidden.example');
});
