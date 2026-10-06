import { expect, test, type Locator, type Page } from '@playwright/test';
import { installConfigurationProtocol, setupConfigurationWorkspace } from './configuration-workspace-fixture';

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
  await installConfigurationProtocol(page);
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
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('配置名称')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true })).toBeChecked();
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
  await installConfigurationProtocol(page);
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
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByText('安装与更新').click();
  await expect(page.getByRole('button', { name: '安装', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '安装 npm', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '安装', exact: true }).click();
  const maintain = await page.evaluate(() => (window as unknown as { __maintainCalls: Array<{ action: string; source: string | null }> }).__maintainCalls);
  expect(maintain).toEqual([{ toolId: 'codex', action: 'install', source: 'npm_shim' }]);
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
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('button', { name: '新建配置' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
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
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.locator('[data-profile-id="saved-1"]').getByRole('button', { name: '使用' }).click();
  const comparison = page.getByRole('dialog', { name: '比较当前文件与本次配置' });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText('model = "old"')).toBeVisible();
  await expect(comparison.getByText('model = "new"')).toBeVisible();
  await expect(comparison.locator('[data-banner="conflict"]')).toHaveCount(1);
  await expect(comparison.getByRole('button', { name: '保留当前文件' })).toHaveCount(1);
  await expect(comparison.getByRole('button', { name: '使用本次内容' })).toHaveCount(1);
  await expect(page.locator('[data-profile-id="saved-1"]').getByText('正在使用')).toHaveCount(0);
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
  await installConfigurationProtocol(page);
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
  await installConfigurationProtocol(page);
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
      profiles, binding: { scopeKey: 'global', tool: 'claude_code', profileId: applied.id, profileVersion: 1, appliedProfileAvailable: true, appliedSummary: { profileVersion: 1, profileRevision: profiles.find(profile => profile.id === applied.id)!.revision, authentication: { kind: 'native' }, contextId: null, providerId: null, baseUrl: null, model: null }, commonVersion: null, commonRevision: null, managed: {} }, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
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
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const group = page.getByRole('list', { name: '配置项' });
  await expect(page.getByLabel('搜索配置')).toBeVisible();
  const overflow = await group.evaluate((element) => element.scrollHeight > element.clientHeight && element.clientHeight <= 406);
  expect(overflow).toBe(true);
  await page.getByLabel('搜索配置').fill('配置 12');
  await expect(group.getByRole('listitem')).toHaveCount(1);
  await group.getByRole('button', { name: '使用' }).click();
  await expect(group.getByText('正在使用')).toBeVisible();
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

async function installConnectionHarness(page: Page, options: { piPresets?: boolean } = {}) {
  await page.addInitScript(({ tools, piPresets }) => {
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
    const state = window as unknown as { __savedProfile: unknown; __importMode?: string };
    Object.assign(window, {
      isTauri: true,
      __savedProfile: null,
      __importMode: '',
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
              providerPresets: toolId === 'pi' && piPresets
                ? [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }, { id: 'demo', label: 'Demo', baseUrl: 'https://demo.example/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://demo.example' }]
                : toolId === 'codebuddy' || toolId === 'codex' ? [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', interfaceFormat: 'openai_responses', sourceUrl: 'https://platform.openai.com' }] : [],
              dependencies: [], installUrl: '', upgradeHint: '', connectionPolicy: policy(toolId, scope),
            },
            profiles: profiles.filter(item => item.tool === toolId), common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
        }
        if (command === 'inspect_registered_native_draft') {
          const toolId = String(args?.toolId ?? '');
          const files = args?.files ?? {};
          if (toolId === 'pi' && String(files.models ?? '').includes('model-a')) return { providerId: 'demo', model: 'model-a', reasoningEffort: null, projectedModels: [{ id: 'model-a', fields: { contextWindow: 100, cost: { input: 1 }, modalities: ['text'] } }, { id: 'sibling', fields: { name: 'Keep' } }], connection: connection('demo', 'model-a') };
          if (toolId === 'open_code') return { providerId: 'demo', model: 'm1', reasoningEffort: null, projectedModels: [{ id: 'm1', fields: { name: 'Custom', extra: true } }, { id: 'm2', fields: { name: 'Second' } }], connection: connection('demo', 'm1') };
          if (toolId === 'codex') return { providerId: 'demo', model: 'gpt', reasoningEffort: 'low', projectedModels: null, connection: connection('demo', 'gpt', 'https://api.openai.com/v1') };
          return { connection: null, reasoningEffort: null, projectedModels: null };
        }
        if (command === 'prepare_registered_native_import') {
          const mode = state.__importMode ?? '';
          const files = args?.files ?? {};
          if (mode === 'migrate-same' || mode === 'migrate-other') {
            const providerId = mode === 'migrate-other' ? 'other' : 'demo';
            return { files, inspection: { providerId, model: 'inspected-model', reasoningEffort: null, projectedModels: null, connection: { providerId, interfaceFormat: 'openai_responses', baseUrl: 'https://api.example/v1', model: 'inspected-model', secretRef: 'migrated-ref', authEnvVar: null } }, migratedSecret: true, nativeCredentials: {} };
          }
          return { files, inspection: { connection: null, reasoningEffort: null, projectedModels: null }, migratedSecret: false, nativeCredentials: {} };
        }
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
  }, { tools: connectionTools, piPresets: options.piPresets === true });
}

async function openConnections(page: Page) {
  await installConfigurationProtocol(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接' })).toBeVisible();
}

async function replaceNumber(field: ReturnType<Page['locator']>, value: string) {
  await field.click();
  await field.press('ControlOrMeta+A');
  await field.pressSequentially(value);
}

async function setImportMode(page: Page, mode: string) {
  await page.evaluate((value) => { (window as unknown as { __importMode: string }).__importMode = value; }, mode);
}

async function savedConnection(page: Page) {
  return page.evaluate(() => (window as unknown as { __savedProfile: { connection: { providerId: string; baseUrl: string; model: string; secretRef: string | null; authEnvVar: string | null; modelRecords?: { id: string; fields: Record<string, unknown> }[] } } }).__savedProfile.connection);
}

async function openAdvanced(dialog: Locator) {
  await dialog.getByText('更多选项', { exact: true }).click();
  await dialog.getByText('高级连接选项', { exact: true }).click();
}

for (const [width, height, name] of [[720, 560, 'minimum'], [1160, 780, 'default'], [1600, 960, 'wide']] as const) {
  test(`unified Kimi editor keeps required fields and main controls reachable ${name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await setupConfigurationWorkspace(page);
    await page.getByRole('button', { name: '修改', exact: true }).last().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^one(?: ·|$)/ }).click();
    await expect(dialog.getByLabel('上下文上限', { exact: false }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^two(?: ·|$)/ })).not.toBeVisible();
    const primary = dialog.getByRole('button', { name: '保存配置', exact: true });
    const box = await primary.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await primary.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`kimi-${name}-${width}x${height}.png`), fullPage: true });
    await dialog.getByRole('button', { name: /^返回模型列表/ }).click();
    await expect(dialog.getByRole('button', { name: /^two(?: ·|$)/ })).toBeVisible();
  });
}

test('saved profile editor shows save-and-use directly without opening more actions', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存并使用', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存并使用', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).configurationProtocol.calls);
  expect(calls.some((call: any) => call.command === 'apply_registered_native_profile')).toBe(true);
});

test('active configuration save only updates DB; explicit use changes the binding', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('配置名称').fill('只保存的配置');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const before = await page.evaluate(() => (window as any).workspaceFixture);
  expect(before.binding.profileVersion).toBe(3);
  expect(before.profiles[0].version).toBe(4);
  expect(before.calls.filter((call: any) => call.command === 'apply_registered_native_profile')).toEqual([]);
  await page.locator('[data-profile-id="existing"]').getByRole('button', { name: '使用新版本', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).workspaceFixture.binding.profileVersion)).toBe(4);
});

test('common save and explicit partial apply preserve each recovery target', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '通用配置', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('通用参数')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存并使用', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('通用配置影响')).toContainText('/tmp/project');
  await dialog.getByLabel('通用参数').fill('8');
  await expect(dialog.getByRole('button', { name: '保存通用配置', exact: true })).toBeEnabled();
  await dialog.getByText('更多保存操作', { exact: true }).click();
  await dialog.getByRole('button', { name: '保存并应用到继承范围', exact: true }).click();
  await expect(dialog.getByText('通用配置已保存；部分范围应用失败，可逐项重试。')).toBeVisible();
  const influenceSection = dialog.getByLabel('通用配置影响');
  const failure = dialog.getByRole('alert').filter({ hasText: '项目配置' });
  await expect(failure).toContainText('外部修改，请重新比较');
  await expect(failure.getByRole('button', { name: '重试此范围' })).toBeVisible();
  await expect(influenceSection).not.toContainText('written_for_next_session');
  await expect(influenceSection).not.toContainText('failed');
  await expect(influenceSection).not.toContainText('project:/tmp/project');
  await expect(influenceSection).toContainText('已保存，下次会话生效');
  await page.evaluate(() => { (window as any).configurationProtocol.commonFailures = []; });
  await failure.getByRole('button', { name: '重试此范围' }).click();
  const retried = dialog.getByRole('status').filter({ hasText: '项目配置' });
  await expect(retried).toContainText('已保存，下次会话生效');
  await expect(retried).not.toContainText('written_for_next_session');
  await expect(influenceSection).not.toContainText('project:/tmp/project');
  const calls = await page.evaluate(() => (window as any).configurationProtocol.calls);
  expect(calls.filter((call: any) => call.command === 'apply_common_configuration').at(-1).args.targets).toHaveLength(1);
});

test('invalid raw text survives subview switches and Escape protects the draft', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  const opener = page.getByRole('button', { name: '修改', exact: true }).last();
  await opener.click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'settings 配置草稿' }).fill('{broken');
  await expect(dialog.getByRole('alert').filter({ hasText: '原文语法无效' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveText('{broken');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog').filter({ hasText: '放弃未保存修改' })).toBeVisible();
  await page.getByRole('dialog').filter({ hasText: '放弃未保存修改' }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveText('{broken');
});

for (const tool of ['pi', 'open_code', 'kimi_code', 'codex', 'claude_code']) {
  test(`registered ${tool} mounts its parameter editor for the current file`, async ({ page }) => {
    await setupConfigurationWorkspace(page, tool);
    await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '保存到当前文件', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '常用设置', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '保存到当前文件', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).configurationProtocol.calls);
    expect(calls.find((call: any) => call.command === 'save_configuration_draft').args.draft.subject).toBe('current');
    expect(calls.filter((call: any) => call.command === 'save_registered_native_profile')).toEqual([]);
  });
}

test('ordered field writes retain sequential typing and focus while IPC is delayed', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog'); const input = dialog.getByLabel('当前模型', { exact: true });
  await page.evaluate(() => { (window as any).configurationProtocol.delayEdit = true; });
  await input.focus(); await input.press('ControlOrMeta+A');
  await input.pressSequentially('long-new-model', { delay: 30 });
  const observed = await page.evaluate(() => ({ values: (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'edit_configuration_draft').map((call: any) => call.args.action.value), active: document.activeElement?.getAttribute('aria-label') }));
  console.log('Delayed sequential input:', observed);
  await expect.soft(input).toHaveValue('long-new-model');
  await expect.soft(input).toBeFocused();
  await page.evaluate(() => { const fixture = (window as any).configurationProtocol; fixture.delayEdit = false; fixture.releaseEdit(); });
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'settings 配置草稿' })).toContainText('long-new-model');
});

test('numeric middle state and API input survive account source and login return without shortcut submission', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click();
  await dialog.getByRole('button', { name: '替换密钥', exact: true }).click();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-pending-key');
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  const number = dialog.getByLabel('上下文窗口（Token）', { exact: false });
  await number.focus(); await number.press('ControlOrMeta+A'); await number.pressSequentially('1e', { delay: 35 });
  await expect(number).toHaveValue('1e');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '连接与模型', exact: true }).click();
  await dialog.getByRole('radio', { name: '选择已管理账号', exact: true }).click();
  await expect(dialog.getByLabel('选择已管理账号')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'))).toEqual([]);
  await dialog.getByRole('button', { name: '登录新账号' }).click();
  await dialog.getByLabel('账号名称').fill('新登录账号'); await dialog.getByRole('button', { name: '添加并登录' }).click();
  const added = dialog.getByRole('listitem', { name: '新登录账号' });
  await expect(added.getByRole('button', { name: '选择并返回' })).toBeDisabled();
  await page.evaluate(() => { const value = (window as any).workspaceFixture.accounts.find((account: any) => account.id === 'new'); Object.assign(value, { state: 'signed_in', version: 3, pendingLogin: null, identity: { subject: 'new', email: 'new@example.test' }, context: { id: 'ctx-new' } }); });
  await expect(added.getByRole('button', { name: '选择并返回' })).toBeEnabled();
  await added.getByRole('button', { name: '选择并返回' }).click();
  await expect(dialog.getByRole('radio', { name: '选择已管理账号', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  await expect(number).toHaveValue('1e');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '连接与模型', exact: true }).click();
  await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('synthetic-pending-key');
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click(); await number.fill('16384');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dialog).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).configurationProtocol.calls);
  const save = calls.find((call: any) => call.command === 'save_configuration_draft');
  expect(save.args.draft.profile.files.settings).toContain('16384');
  expect(save.args.draft.credential.source).toBe('api_key');
  expect(calls.filter((call: any) => call.command.includes('apply_'))).toEqual([]);
});

test('draft key diagnosis preserves independent sources and explicit removal never restores a stored key', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'pi');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click();
  await dialog.getByRole('button', { name: '替换密钥' }).click(); await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-directory-key');
  await dialog.getByText('模型目录与连接检查', { exact: true }).click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect(dialog.getByText('密钥在草稿中 · 尚未保存到系统')).toBeVisible();
  const temporary = await page.evaluate(() => Object.keys((window as any).configurationProtocol.leases)[0]);
  await dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true }).click(); await expect(dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true })).toBeChecked();
  await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
  await expect(dialog.getByText('密钥在草稿中 · 尚未保存到系统')).toBeVisible();
  expect(await page.evaluate(() => Object.keys((window as any).configurationProtocol.leases))).toContain(temporary);
  await dialog.getByText('密钥在草稿中 · 尚未保存到系统', { exact: true }).click();
  await dialog.getByRole('button', { name: '移除密钥' }).click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toBeVisible();
  const state = await page.evaluate(() => (window as any).configurationProtocol);
  const latest = Object.values(state.sessions).at(-1) as any;
  expect(latest.credential).toMatchObject({ source: 'api_key', secretRef: null, remove: true });
  expect(latest.profile.connection.secretRef).toBeNull();
  expect(state.calls.filter((call: any) => call.command === 'set_connection_secret')).toEqual([]);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog').filter({ hasText: '放弃未保存修改' }).getByRole('button', { name: '放弃修改' }).click();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).configurationProtocol.leases))).toEqual([]);
  expect(await page.evaluate(() => (window as any).workspaceFixture.profiles[0].connection.secretRef)).toBe('saved-original');
});

test('directory multi-select keeps edited model parameters and missing Kimi metadata remains invalid', async ({ page }) => {
  await setupConfigurationWorkspace(page);
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^one(?: ·|$)/ }).click(); await dialog.getByLabel('模型 one', { exact: true }).getByLabel('上下文上限', { exact: false }).fill('32768');
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: /^返回模型列表/ }).click();
  await dialog.getByText('模型目录与连接检查', { exact: true }).click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  const directory = dialog.getByLabel('模型目录', { exact: true }); await directory.getByLabel('one', { exact: true }).check(); await directory.getByLabel('new-1', { exact: true }).check(); await directory.getByLabel('new-2', { exact: true }).check();
  await directory.getByRole('button', { name: '添加所选模型' }).click();
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert').filter({ hasText: 'new-1 缺少必填上下文' })).toBeVisible();
  await dialog.getByRole('button', { name: /^one(?: ·|$)/ }).click(); await expect(dialog.getByLabel('上下文上限', { exact: false }).first()).toHaveValue('32768');
  await dialog.getByRole('button', { name: /^返回模型列表/ }).click();
  for (const id of ['new-1','new-2']) { await dialog.getByRole('button', { name: new RegExp(`^${id}(?: ·|$)`) }).click(); await dialog.getByLabel(`模型 ${id}`, { exact: true }).getByLabel('上下文上限', { exact: false }).fill('8192'); await dialog.getByRole('button', { name: /^返回模型列表/ }).click(); }
  await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
});

test('a cancelled directory request cannot replace a changed source and manual model creation stays available', async ({ page }) => {
  await setupConfigurationWorkspace(page);
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await page.evaluate(() => { (window as any).configurationProtocol.delayDirectory = true; });
  await dialog.getByText('模型目录与连接检查', { exact: true }).click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).configurationProtocol.releaseDirectory)).toBe(true);
  await dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true }).click(); await page.evaluate(() => { (window as any).configurationProtocol.releaseDirectory(); });
  await expect(dialog.getByLabel('模型目录', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '新增模型', exact: true })).toBeEnabled();
});

for (const choice of ['使用本次', '保留现有'] as const) {
  test(`current conflict ${choice} rebases safely and preserves the rest of the draft`, async ({ page }) => {
    await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('当前模型', { exact: true }).fill('my-edited-model');
    await expect(dialog.getByRole('button', { name: '保存到当前文件' })).toBeEnabled();
    await page.evaluate(() => { const state = (window as any).configurationProtocol; const view = JSON.parse(state.disk.settings); view.values.model = 'external-model'; view.values.external = 'preserve'; state.disk.settings = JSON.stringify(view); });
    await dialog.getByRole('button', { name: '保存到当前文件' }).click();
    await expect(dialog.locator('[data-banner="conflict"]')).toHaveCount(1);
    const compare = dialog.getByRole('button', { name: choice === '使用本次' ? '使用本次内容' : '保留当前文件', exact: true });
    await expect(compare).toBeVisible(); await compare.click();
    await expect(dialog.getByRole('status').filter({ hasText: '比较基线已更新' })).toContainText('比较基线已更新');
    await dialog.getByRole('button', { name: '保存到当前文件' }).click(); await expect(dialog).toHaveCount(0);
    const disk = JSON.parse(await page.evaluate(() => (window as any).configurationProtocol.disk.settings));
    expect(disk.values.model).toBe(choice === '使用本次' ? 'my-edited-model' : 'external-model');
    expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'read_registered_native_file_for_edit'))).toEqual([]);
  });
}

test('current comparison rejects a second external change and supports a fresh explicit recovery', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '正在使用的文件', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前模型', { exact: true }).fill('my-edited-model'); await expect(dialog.getByRole('button', { name: '保存到当前文件' })).toBeEnabled();
  await page.evaluate(() => { const state = (window as any).configurationProtocol; const value = JSON.parse(state.disk.settings); value.values.model = 'external-one'; state.disk.settings = JSON.stringify(value); });
  await dialog.getByRole('button', { name: '保存到当前文件' }).click();
  await expect(dialog.locator('[data-banner="conflict"]')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '使用本次内容' })).toBeVisible();
  await page.evaluate(() => { const state = (window as any).configurationProtocol; const value = JSON.parse(state.disk.settings); value.values.model = 'external-two'; state.disk.settings = JSON.stringify(value); });
  await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '比较后文件再次变化' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => (window as any).configurationProtocol.disk.settings)).values.model).toBe('external-two');
  await dialog.getByText('当前文件恢复', { exact: true }).click(); await dialog.getByRole('button', { name: '重新比较文件' }).click(); await dialog.getByRole('button', { name: '使用本次内容' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '比较基线已更新' })).toContainText('比较基线已更新');
  await dialog.getByRole('button', { name: '保存到当前文件' }).click();
  expect(JSON.parse(await page.evaluate(() => (window as any).configurationProtocol.disk.settings)).values.model).toBe('my-edited-model');
});

test('diff editor loading states are explicit and a failed chunk can be retried', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  let mode = 'hold';
  let release: (() => void) | null = null;
  await page.route(/\/assets\/CodeEditorImpl-[^?]*\.js(\?.*)?$/, async route => {
    if (mode === 'hold') {
      await new Promise<void>(resolve => { release = resolve; });
      await route.abort();
      return;
    }
    if (mode === 'fail') { await route.abort(); return; }
    await route.continue();
  });
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
  await expect(dialog.getByText('正在准备编辑器…')).toBeVisible();
  mode = 'fail';
  release!();
  const failed = dialog.getByRole('alert').filter({ hasText: '编辑器加载失败' });
  await expect(failed).toBeVisible();
  await expect(dialog.getByText('加载编辑器…')).toHaveCount(0);
  mode = 'allow';
  await failed.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'settings 配置草稿' })).toBeVisible();
  await expect(dialog.getByText('加载编辑器…')).toHaveCount(0);
});

test('history replaces the current editor with sanitized typed preview and guards later changes', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '正在使用的文件', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByText('当前文件恢复', { exact: true }).click(); await dialog.getByRole('button', { name: '修改记录', exact: true }).click();
  await dialog.getByLabel('修改记录').getByRole('button').filter({ hasNotText: '返回编辑' }).last().click();
  await expect(dialog.getByRole('textbox', { name: '历史原文' })).toBeVisible();
  await expect(dialog.getByLabel('当前模型', { exact: true })).not.toBeVisible();
  await page.evaluate(() => { const state = (window as any).configurationProtocol; const value = JSON.parse(state.disk.settings); value.values.model = 'later-external'; state.disk.settings = JSON.stringify(value); });
  await dialog.getByRole('button', { name: '恢复这个版本', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '历史比较后文件变化' })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => (window as any).configurationProtocol.disk.settings)).values.model).toBe('later-external');
  expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => ['preview_native_backup','restore_native_backup'].includes(call.command)))).toEqual([]);
  await dialog.getByRole('button', { name: '返回编辑' }).click(); await expect(dialog.getByLabel('当前模型', { exact: true })).toBeVisible();
});

test('generic registered fallback uses temporary keys for directory and cancels without modifying the saved key', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'qoder_cn');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('兼容配置连接')).toBeVisible();
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click();
  await dialog.getByRole('button', { name: '替换密钥' }).click(); await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-fallback-key');
  await dialog.getByText('模型目录与连接检查', { exact: true }).click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect(dialog.getByText(/目录已获取 · \d+ 个模型可用/)).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByRole('dialog').filter({ hasText: '放弃未保存修改' }).getByRole('button', { name: '放弃修改' }).click();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).configurationProtocol.leases))).toEqual([]);
  expect(await page.evaluate(() => (window as any).workspaceFixture.profiles[0].connection.secretRef)).toBe('saved-original');
  expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'set_connection_secret'))).toEqual([]);
});

test('Kimi default first screen shows connection and compact model list', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1160, height: 780 }); await setupConfigurationWorkspace(page);
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('配置名称')).toBeVisible(); await expect(dialog.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('上下文上限', { exact: false }).first()).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('kimi-first-screen-1160x780.png'), fullPage: true });
});

test('configuration list separates saved connection from frozen last-used source', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex', true, true);
  const row = page.locator('[data-profile-id="existing"]');
  await expect(row).toContainText('保存设置：API 密钥 · gateway.example.test');
  await expect(row).toContainText('上次已使用：CLI 当前凭据 · old-provider · old.example.test · old-model');
  await expect(row.getByRole('button', { name: '使用新版本', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).workspaceFixture.calls.filter((call: any) => call.command.includes('apply')))).toEqual([]);
});

test('native field units and merged origin distinguish inherited and explicit values', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '常用设置' }).click();
  const number = dialog.getByLabel('上下文窗口（Token）', { exact: false }); await number.fill('8192');
  const field = number.locator('..');
  const info = field.getByRole('button', { name: '字段信息' });
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(field.getByText('本层显式值', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '合并与来源' }).click();
  await dialog.getByText('字段来源', { exact: true }).click();
  await expect(dialog.getByText('继承 · 通用配置', { exact: true })).toBeVisible();
  await expect(dialog.getByText('本层显式 · 命名配置', { exact: true })).toBeVisible();
});

for (const variant of ['revision', 'no_snapshot', 'no_summary', 'common_revision', 'common_unknown'] as const) {
  test(`applied state keeps explicit use for ${variant} despite the same numeric version`, async ({ page }) => {
    await setupConfigurationWorkspace(page, 'codex');
    await page.evaluate(variant => {
      const fixture = (window as any).workspaceFixture;
      if (variant === 'revision') fixture.profiles[0].revision = 'same-version-replacement';
      if (variant === 'no_snapshot') fixture.binding.appliedProfileAvailable = false;
      if (variant === 'no_summary') fixture.binding.appliedSummary = null;
      if (variant === 'common_revision') fixture.binding.commonRevision = 'old-common-revision';
      if (variant === 'common_unknown') fixture.binding.commonRevision = null;
      window.dispatchEvent(new Event('focus'));
    }, variant);
    const row = page.locator('[data-profile-id="existing"]');
    await expect(row.getByRole('button', { name: '使用新版本', exact: true })).toBeVisible();
    await expect(row.getByText('正在使用', { exact: true })).toHaveCount(0);
    await expect(row.getByText('已保存，待使用', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).workspaceFixture.calls.filter((call: any) => call.command.includes('apply_')))).toEqual([]);
  });
}

test('known full applied identity keeps its source distinct and has no pending use', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  const row = page.locator('[data-profile-id="existing"]');
  await expect(row.getByText('正在使用', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '使用新版本', exact: true })).toHaveCount(0);
});

test('cancel request button stops a delayed directory while keeping draft edits and key lease', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => { (window as any).configurationProtocol.delayDirectory = true; });
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('配置名称').fill('保留取消后的草稿');
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click();
  await dialog.getByRole('button', { name: '替换密钥' }).click();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-cancel-key');
  await dialog.getByLabel('当前模型', { exact: true }).click();
  await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).configurationProtocol.releaseDirectory)).toBe(true);
  const before = await page.evaluate(() => Object.values((window as any).configurationProtocol.sessions)[0]) as any;
  await dialog.getByLabel('配置名称').click();
  await dialog.getByText('连接检查与诊断', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消请求', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '取消请求', exact: true }).click();
  await dialog.getByLabel('当前模型', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '获取模型目录' })).toBeEnabled();
  await page.evaluate(() => { (window as any).configurationProtocol.releaseDirectory(); });
  await expect(dialog.getByLabel('模型目录', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('配置名称')).toHaveValue('保留取消后的草稿');
  const after = await page.evaluate(() => Object.values((window as any).configurationProtocol.sessions)[0]) as any;
  expect(after.revision).toBe(before.revision);
  expect(after.requestGeneration).toBe(before.requestGeneration + 1);
  expect(after.profile.files).toEqual(before.profile.files);
  expect(after.credential).toEqual(before.credential);
  expect(await page.evaluate(ref => !!(window as any).configurationProtocol.leases[ref], before.credential.secretRef)).toBe(true);
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('cancel request error offers retry and suppresses the old response', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => { const state = (window as any).configurationProtocol; state.delayDirectory = true; state.cancelRequestFailure = '暂时无法取消，请重试'; });
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('当前模型', { exact: true }).click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await dialog.getByLabel('配置名称').click();
  await dialog.getByText('连接检查与诊断', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '取消请求', exact: true })).toBeEnabled(); await dialog.getByRole('button', { name: '取消请求', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '暂时无法取消' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消请求', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).configurationProtocol.cancelRequestFailure = ''; });
  await dialog.getByRole('button', { name: '取消请求', exact: true }).click();
  await dialog.getByLabel('当前模型', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '获取模型目录' })).toBeEnabled();
  await page.evaluate(() => { (window as any).configurationProtocol.releaseDirectory(); });
  await expect(dialog.getByLabel('模型目录', { exact: true })).toHaveCount(0);
});

test('API source buffers separate changed connection B from the stored A key and restore A', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'qoder_cn');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  const sourceNative = dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true });
  const sourceApi = dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true });
  await sourceNative.click();
  await dialog.getByText('连接 · gateway', { exact: true }).click();
  await dialog.getByLabel('供应商 ID', { exact: true }).fill('b'); await expect(sourceNative).toBeEnabled();
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await sourceApi.click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toBeVisible();
  const selected = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'select_configuration_credential').at(-1));
  expect(selected.args.credential).toEqual({ source: 'api_key', secretRef: null });
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-b-key');
  await dialog.getByText('模型目录与连接检查', { exact: true }).click(); await dialog.getByRole('button', { name: '检查连接', exact: true }).click();
  await expect(dialog.getByText('合成非推理检查通过', { exact: true })).toBeVisible();
  const bRef = await page.evaluate(() => Object.keys((window as any).configurationProtocol.leases)[0]);
  await sourceNative.click();
  await dialog.getByLabel('供应商 ID', { exact: true }).fill('gateway'); await expect(sourceNative).toBeEnabled();
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://gateway.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await sourceApi.click();
  await expect(dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true })).toBeVisible();
  await sourceNative.click();
  await dialog.getByLabel('供应商 ID', { exact: true }).fill('b'); await expect(sourceNative).toBeEnabled();
  await dialog.getByLabel('API 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await sourceApi.click();
  await expect(dialog.getByText('密钥在草稿中 · 尚未保存到系统', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  const save = await page.evaluate(() => (window as any).configurationProtocol.calls.find((call: any) => call.command === 'save_configuration_draft'));
  expect(save.args.draft.credential.secretRef).toBe(bRef);
  expect(save.args.draft.profile.connection.baseUrl).toBe('https://b.example.test/v1');
});

for (const capability of ['writable', 'denied', 'missing', 'managed'] as const) {
  test(`current key editing follows explicit source capability: ${capability}`, async ({ page }) => {
    await setupConfigurationWorkspace(page, 'codex');
    await page.evaluate(capability => {
      const state = (window as any).configurationProtocol;
      state.currentApiWritable = capability === 'writable'; state.omitSourceCapabilities = capability === 'missing';
      if (capability === 'managed') (window as any).workspaceFixture.effectiveContextId = 'managed-context';
      window.dispatchEvent(new Event('focus'));
    }, capability);
    await page.getByRole('button', { name: '正在使用的文件', exact: true }).click(); const dialog = page.getByRole('dialog');
    if (capability !== 'writable') {
      await expect(dialog.getByRole('radiogroup', { name: '凭据来源', exact: true })).toHaveCount(0);
      await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '移除当前密钥' })).toHaveCount(0);
      return;
    }
    await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: '选择已管理账号' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '选择账号或登录新账号' })).toHaveCount(0);
    await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-current-key');
    await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
    await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
    await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-input-discarded-by-remove');
    await dialog.getByRole('button', { name: '移除当前密钥' }).click();
    await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click();
    const saves = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'));
    expect(saves[0].args.draft.credential.source).toBe('api_key');
    expect(saves[1].args.draft.credential).toMatchObject({ source: 'api_key', secretRef: null, remove: true });
    expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command.includes('account_login')))).toEqual([]);
  });
}

test('model combobox keeps the fetched catalog filterable while typing edits the draft', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  const model = dialog.getByLabel('当前模型', { exact: true });
  await model.click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect(dialog.getByText(/目录已获取 · \d+ 个模型已同步到模型选择框/)).toBeVisible();
  await model.fill('new');
  await expect(dialog.getByRole('option', { name: 'new-1', exact: true })).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'new-2', exact: true })).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'one', exact: true })).toHaveCount(0);
});

test('Claude directory writes its default model field and common edits native effortLevel', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'claude_code');
  await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  const defaultModel = dialog.getByLabel('默认模型', { exact: true });
  await defaultModel.click(); await dialog.getByRole('button', { name: '获取模型目录' }).click();
  await expect(dialog.getByText(/目录已获取 · \d+ 个模型已同步到模型选择框/)).toBeVisible();
  await defaultModel.fill('new-1');
  await dialog.getByRole('option', { name: 'new-1', exact: true }).click();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('button', { name: '通用配置', exact: true }).first().click();
  await dialog.getByLabel('默认推理 effort', { exact: true }).fill('xhigh');
  await dialog.getByRole('button', { name: '保存通用配置', exact: true }).click();
  const saves = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'));
  expect(saves[0].args.draft.profile.editing.intents.at(-1)).toMatchObject({ field: 'default.model', target: 'configuration', value: 'new-1' });
  expect(JSON.parse(saves[0].args.draft.profile.files.settings).env.ANTHROPIC_MODEL).toBe('new-1');
  expect(JSON.parse(saves[1].args.draft.profile.files.settings).effortLevel).toBe('xhigh');
});

test('saved OAuth and native model summaries distinguish configurations independently of HTTP connections', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => {
    const fixture = (window as any).workspaceFixture;
    const original = fixture.profiles[0];
    fixture.profiles = [{ ...original, connection: null, authentication: { kind: 'oauth', accountId: 'a' } }, { ...original, id: 'second', name: '工作配置 2', connection: null, authentication: { kind: 'native' } }];
    fixture.modelSummaries = { existing: { providerId: 'openai', model: 'oauth-model-a' }, second: { providerId: 'openai', model: 'native-model-b' } };
    fixture.binding.appliedSummary = { ...fixture.binding.appliedSummary, authentication: { kind: 'oauth', accountId: 'a' }, model: 'frozen-oauth-model', baseUrl: null };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.locator('[data-profile-id="existing"]')).toContainText('oauth-model-a');
  await expect(page.locator('[data-profile-id="second"]')).toContainText('native-model-b');
  await expect(page.locator('[data-profile-id="existing"]')).toContainText('上次已使用：已管理账号');
  await expect(page.locator('[data-profile-id="existing"]')).toContainText('frozen-oauth-model');
});

test('current native key target permits replace and remove without inventing HTTP diagnostics', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codebuddy');
  await page.evaluate(() => {
    const state = (window as any).configurationProtocol;
    state.currentApiWritable = true;
    state.nativeCredentialTarget = { identity: 'fixture-native-target', label: '原生环境密钥', role: 'settings', path: ['env', 'CODEBUDDY_API_KEY'], removePaths: [['env', 'CODEBUDDY_API_KEY'], ['env', 'CODEBUDDY_AUTH_TOKEN']] };
  });
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
  await expect(dialog.getByText('用于 原生环境密钥；保存后更新当前文件中的密钥。', { exact: true })).toBeVisible();
  await dialog.getByText('模型目录与连接检查', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: '获取模型目录' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '检查连接', exact: true })).toBeDisabled();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-native-target-key');
  await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
  await dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true }).click();
  await dialog.getByRole('button', { name: '移除当前密钥' }).click();
  await dialog.getByRole('button', { name: '保存到当前文件', exact: true }).click();
  const saves = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'));
  expect(saves[0].args.draft.profile.connection).toBeNull();
  expect(saves[0].args.draft.draftConnection).toBeNull();
  expect(saves[0].args.draft.nativeCredentialTarget.identity).toBe('fixture-native-target');
  expect(saves[1].args.draft.credential.remove).toBe(true);
});

for (const document of [{ model: 'sonnet' }, { env: { ANTHROPIC_MODEL: 'sonnet' } }]) {
  test(`Claude common rejects local_settings model references: ${JSON.stringify(document)}`, async ({ page }) => {
    await setupConfigurationWorkspace(page, 'claude_code');
    await page.evaluate(() => { (window as any).configurationProtocol.commonFiles = { settings: '{"effortLevel":"high"}', local_settings: '{}' }; });
    await page.getByRole('button', { name: '通用配置', exact: true }).first().click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '原生文本', exact: true }).click();
    await dialog.getByRole('button', { name: 'local_settings', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'local_settings 配置草稿' }).fill(JSON.stringify(document));
    await expect(dialog.getByRole('alert').filter({ hasText: '通用配置不允许模型引用' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存通用配置', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'save_configuration_draft'))).toEqual([]);
  });
}


test('unknown old applied context retains saved configurations and explicit recovery without native reads', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => {
    const fixture = (window as any).workspaceFixture;
    fixture.binding.appliedProfileAvailable = false; fixture.binding.appliedSummary = null;
    fixture.nativeContextError = '旧应用身份未知，请明确使用保存配置以恢复';
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('alert').filter({ hasText: '旧应用身份未知' })).toBeVisible();
  await expect(page.getByRole('button', { name: '正在使用的文件', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-profile-id="existing"]').getByRole('button', { name: '使用新版本', exact: true })).toBeEnabled();
  await page.locator('[data-profile-id="existing"]').getByRole('button', { name: '修改', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('工作配置');
  expect(await page.evaluate(() => (window as any).workspaceFixture.calls.filter((call: any) => call.command.includes('apply_')))).toEqual([]);
});

for (const originalKey of ['stored', 'lease'] as const) {
  for (const changed of ['provider', 'address'] as const) {
    test(`API-internal connection change keeps ${originalKey} A ref out of the new ${changed} B buffer`, async ({ page }) => {
      await setupConfigurationWorkspace(page, 'codex');
      await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
      const sourceNative = dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true });
      const sourceApi = dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true });
      await dialog.getByText('连接检查与诊断', { exact: true }).click();
      if (originalKey === 'lease') {
        await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click();
        await dialog.getByRole('button', { name: '替换密钥' }).click();
        await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-original-a');
        await dialog.getByRole('button', { name: '检查连接', exact: true }).click();
        await expect(dialog.getByText('密钥在草稿中 · 尚未保存到系统', { exact: true })).toBeVisible();
      }
      const aRef = await page.evaluate(() => (Object.values((window as any).configurationProtocol.sessions)[0] as any).credential.secretRef);
      await dialog.getByText('供应商连接', { exact: true }).click();
      if (changed === 'provider') { await dialog.getByLabel('供应商 ID', { exact: true }).fill('b'); await expect(sourceNative).toBeEnabled(); }
      await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
      await expect(sourceApi).toBeChecked();
      await sourceNative.click(); await expect(sourceNative).toBeEnabled();
      await sourceApi.click();
      await expect(sourceApi).toBeChecked();
      await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('');
      const bSelection = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'select_configuration_credential').at(-1));
      expect(bSelection.args.credential).toEqual({ source: 'api_key', secretRef: null });
      await expect(dialog.getByRole('alert').filter({ hasText: '密钥引用不属于当前连接' })).toHaveCount(0);
      await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-new-b');
      await dialog.getByRole('button', { name: '检查连接', exact: true }).click();
      await expect(dialog.getByText('合成非推理检查通过', { exact: true })).toBeVisible();
      const bRef = await page.evaluate(() => (Object.values((window as any).configurationProtocol.sessions)[0] as any).credential.secretRef);
      expect(bRef).not.toBe(aRef);
      if (changed === 'provider') { await dialog.getByLabel('供应商 ID', { exact: true }).fill('gateway'); await expect(sourceNative).toBeEnabled(); }
      await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://gateway.example.test/v1'); await expect(sourceNative).toBeEnabled();
      await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
      await expect(dialog.getByText(originalKey === 'lease' ? '密钥在草稿中 · 尚未保存到系统' : '密钥已保存到系统 · 空输入保留', { exact: true })).toBeVisible();
      const restored = await page.evaluate(() => (Object.values((window as any).configurationProtocol.sessions)[0] as any).credential.secretRef);
      expect(restored).toBe(aRef);
      if (changed === 'provider') { await dialog.getByLabel('供应商 ID', { exact: true }).fill('b'); await expect(sourceNative).toBeEnabled(); }
      await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
      await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
      await expect(dialog.getByText('密钥在草稿中 · 尚未保存到系统', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toHaveCount(0);
      const save = await page.evaluate(() => (window as any).configurationProtocol.calls.find((call: any) => call.command === 'save_configuration_draft'));
      expect(save.args.draft.credential.secretRef).toBe(bRef);
      expect(save.args.draft.profile.connection.baseUrl).toBe('https://b.example.test/v1');
      const checks = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'check_configuration_connection'));
      expect(checks.at(-1).args.draft.credential.secretRef).toBe(bRef);
    });
  }
}

test('unfinished A key is retained for A and cannot be submitted to a changed API connection B', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  const sourceNative = dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true });
  const sourceApi = dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true });
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click(); await dialog.getByRole('button', { name: '替换密钥' }).click();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-unfinished-a');
  await dialog.getByText('供应商连接', { exact: true }).click(); await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '此密钥输入属于先前连接' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'set_configuration_draft_secret'))).toEqual([]);
  await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://gateway.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('synthetic-unfinished-a');
});

test('explicit B key input while API still carries A ref is restored separately without changing A ownership', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex'); await page.getByRole('button', { name: '修改', exact: true }).last().click(); const dialog = page.getByRole('dialog');
  const sourceNative = dialog.getByRole('radio', { name: '使用 CLI 当前登录或凭据', exact: true });
  const sourceApi = dialog.getByRole('radio', { name: '为此连接提供 API 密钥', exact: true });
  await dialog.getByText('供应商连接', { exact: true }).click(); await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://b.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true }).click(); await dialog.getByRole('button', { name: '替换密钥' }).click();
  await dialog.getByLabel('API 密钥', { exact: true }).fill('synthetic-unfinished-b');
  await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
  await expect(dialog.getByLabel('API 密钥', { exact: true })).toHaveValue('synthetic-unfinished-b');
  const selected = await page.evaluate(() => (window as any).configurationProtocol.calls.filter((call: any) => call.command === 'select_configuration_credential').at(-1));
  expect(selected.args.credential).toEqual({ source: 'api_key', secretRef: null });
  await dialog.getByLabel('Responses 地址', { exact: true }).fill('https://gateway.example.test/v1'); await expect(sourceNative).toBeEnabled();
  await sourceNative.click(); await expect(sourceNative).toBeEnabled(); await sourceApi.click();
  await expect(dialog.getByText('密钥已保存到系统 · 空输入保留', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (Object.values((window as any).configurationProtocol.sessions)[0] as any).credential.secretRef)).toBe('saved-original');
});

test('codex named configuration hides restore for inherited and unset descriptor fields', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'codex');
  await page.evaluate(() => {
    (window as any).configurationProtocol.fieldOrigins = {
      'codex:model': 'explicit',
      'codex:model_reasoning_summary': 'inherited',
      'codex:model_verbosity': 'unset',
    };
  });
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  const explicitField = dialog.getByLabel('当前模型', { exact: true }).locator('xpath=../..');
  await expect(explicitField.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  const inheritedField = dialog.getByLabel('推理摘要', { exact: true }).locator('..');
  await expect(inheritedField.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0);
  const unsetField = dialog.getByLabel('回答详细程度', { exact: true }).locator('..');
  await expect(unsetField.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0);
  // A field the descriptor does not classify keeps the conservative restore affordance.
  const unknownField = dialog.getByLabel('推理强度（Codex 原生）', { exact: true }).locator('..');
  await expect(unknownField.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible();
  // A session intent overrides the descriptor baseline back to explicit.
  await dialog.getByLabel('推理摘要', { exact: true }).fill('concise');
  await expect(inheritedField.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible();
});

test('claude named configuration hides restore for inherited and unset descriptor fields', async ({ page }) => {
  await setupConfigurationWorkspace(page, 'claude_code');
  await page.evaluate(() => {
    (window as any).configurationProtocol.fieldOrigins = {
      'claude_code:default.model': 'explicit',
      'claude_code:effortLevel': 'inherited',
      'claude_code:opus.model': 'unset',
    };
  });
  await page.getByRole('button', { name: '修改', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  const explicitField = dialog.getByLabel('默认模型', { exact: true }).locator('xpath=../..');
  await expect(explicitField.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  const inheritedField = dialog.getByLabel('默认推理 effort', { exact: true }).locator('..');
  await expect(inheritedField.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0);
  const unsetField = dialog.getByLabel('opus 模型', { exact: true }).locator('xpath=../..');
  await expect(unsetField.getByRole('button', { name: '恢复默认', exact: true })).toHaveCount(0);
});
