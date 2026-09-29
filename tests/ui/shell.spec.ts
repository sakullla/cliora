import { expect, test } from '@playwright/test';

test('five full pages are navigable and browser mode never implies native data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('浏览器预览');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' })).toBeFocused();
  for (const name of ['快速开始', '工具与连接', '资料库', '使用记录', '设置']) {
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  }
  await expect(page.getByRole('checkbox').first()).toBeDisabled();
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 760 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('native settings result drives the home list and empty management stays recoverable', async ({ page }) => {
  await page.addInitScript(() => {
    let managed = ['codex', 'claude_code', 'grok', 'pi', 'open_code'];
    let theme = 'system';
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const bootstrap = () => ({
      preferences: { schema_version: 1, managed_tools: managed, theme },
      tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })),
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { managedTools?: string[]; theme?: string } = {}) => {
          if (command === 'set_managed_tools') managed = args.managedTools ?? managed;
          if (command === 'set_theme') theme = args.theme ?? theme;
          if (command === 'get_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' } },
            profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
          };
          return bootstrap();
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  for (const name of ['Codex', 'Claude Code', 'Grok', 'Pi', 'OpenCode']) {
    await page.getByRole('checkbox', { name: new RegExp(name) }).uncheck();
  }
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByText('尚未管理工具')).toBeVisible();
  await page.getByRole('button', { name: '前往设置' }).click();
  await page.getByRole('checkbox', { name: /Codex/ }).check();
  await page.getByRole('combobox', { name: '主题' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByRole('button', { name: '编辑配置 →' })).toHaveCount(1);
  await expect(page.locator('[aria-label="管理中的工具"]')).toContainText('Codex');
});

test('home opens Claude Code native JSON editor with full disk text', async ({ page }) => {
  await page.addInitScript(() => {
    const profile = {
      id: 'claude-default', tool: 'claude_code', name: '日常', version: 1,
      inheritCommon: false, files: { settings: '{"model":"claude-sonnet"}' },
      suppressed: {}, nativeCredentials: {}, connection: null,
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return {
          preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' },
          tools: [{ id: 'claude_code', name: 'Claude Code', installation: 'not_checked', configuration: 'not_checked' }],
        };
        if (command === 'get_tool_workspace') return {
          probe: {
            selectedPath: 'C:\\tools\\claude.cmd',
            installations: [{ path: 'C:\\tools\\claude.cmd', version: '2.1.283', source: 'npm_shim', status: 'available', detail: null }],
            nativeFiles: [{ role: 'settings', path: 'C:\\Users\\test\\.claude\\settings.json', format: 'json', writable: true, reason: null, sensitive: false }],
            nativeWrites: { state: 'supported', reason: '已验证此版本' },
            interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [],
            installUrl: 'https://code.claude.com/docs/en/setup', upgradeHint: '', installCommand: null, upgradeCommand: null,
          },
          profiles: [profile], common: null, binding: null,
          snapshots: [{ role: 'settings', fingerprint: 'present', error: null }],
          recoveryNeeded: [], customPath: null,
        };
        if (command === 'read_native_file_for_edit') return '{"env":{"ANTHROPIC_API_KEY":"disk-key"},"model":"claude-sonnet"}';
        if (command === 'inspect_native_draft') return {};
        throw new Error(`Unexpected native command: ${command}`);
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '编辑当前磁盘原文' }).click();
  await expect(page.getByRole('textbox', { name: 'settings 配置草稿' })).toHaveValue(/ANTHROPIC_API_KEY.*disk-key/);
});

test('storage failure preserves an actionable page and retry loads repaired data', async ({ page }) => {
  await page.addInitScript(() => {
    let calls = 0;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async () => {
        calls += 1;
        if (calls <= 2) throw { code: 'storage_unavailable', message: '无法打开本机数据库', action: '先备份原数据库，再检查磁盘和权限；修复后点击重试。', data_directory: 'C:\\Users\\test\\AppData\\Roaming\\Cliora' };
        return {
          preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' },
          tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }],
        };
      } },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法打开本机数据库');
  await expect(page.getByRole('alert')).toContainText('C:\\Users\\test');
  await expect(page.getByText('暂时无法读取本机资料')).toBeVisible();
  await expect(page.locator('.tool-row')).toHaveCount(0);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试读取' }).click();
  await expect(page.getByRole('checkbox', { name: /Codex/ })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
