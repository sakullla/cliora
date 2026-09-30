import { expect, test } from '@playwright/test';

test('migration previews conflicts, keeps choices across navigation, and cancels without importing', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    Object.assign(window, {
      isTauri: true,
      __migrationCalls: calls,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args });
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_portable_items') return [{ key: 'profile:p1', kind: 'profile', label: '工作配置', status: 'available', pendingFields: [] }];
        if (command === 'get_webdav_status') return { configured: false, enabled: false, endpoint: null, lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, conflicts: [] };
        if (command === 'plugin:dialog|open') return 'C:/backup.cliora';
        if (command === 'preview_portable_bundle') return { previewId: 'preview-1', pendingProjects: 1,
          items: [
            { key: 'project:new', kind: 'project', label: '新项目', status: 'new', pendingFields: ['项目本机目录'] },
            { key: 'profile:p1', kind: 'profile', label: '工作配置', status: 'conflict', pendingFields: [] },
          ] };
        if (command === 'cancel_portable_preview') return null;
        if (command === 'apply_portable_bundle') return (args.selected as string[]).length;
        if (command === 'configure_webdav') return { configured: true, enabled: true, endpoint: 'https://dav.example.test/cliora/', lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, conflicts: [] };
        if (command === 'sync_webdav_now') return { configured: true, enabled: true, endpoint: 'https://dav.example.test/cliora/', lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0,
          conflicts: [{ key: 'library:one', label: '常用规则', localPresent: true, localDigest: 'a', remoteVersions: 2, remoteDeleted: false,
            versions: [{ id: 'remote-1', digest: 'b', deleted: false }, { id: 'remote-2', digest: 'c', deleted: false }] }] };
        if (command === 'preview_webdav_conflict') return { key: 'library:one', localSummary: '本机规则正文',
          versions: [{ id: 'remote-1', summary: '远端规则正文 A', deleted: false }, { id: 'remote-2', summary: '远端规则正文 B', deleted: false }] };
        if (command === 'resolve_webdav_conflict') return { configured: true, enabled: true, endpoint: 'https://dav.example.test/cliora/', lastSuccess: 1, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, conflicts: [] };
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await page.getByPlaceholder('输入导出时的口令').fill('correct-password');
  await page.getByRole('button', { name: '选择配置包并预览' }).click();
  await expect(page.getByText('待关联：项目本机目录')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认恢复 1 项' })).toBeVisible();
  await nav.getByRole('button', { name: '快速开始' }).click();
  await nav.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await expect(page.getByRole('button', { name: '确认恢复 1 项' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await page.evaluate(() => (window as typeof window & { __migrationCalls: Array<{ command: string }> }).__migrationCalls))
    .filter((call) => call.command === 'apply_portable_bundle')).toHaveLength(0);
  await page.getByPlaceholder('输入导出时的口令').fill('correct-password');
  await page.getByRole('button', { name: '选择配置包并预览' }).click();
  await page.getByRole('checkbox', { name: /工作配置.*与本机不同/ }).check();
  await page.getByRole('button', { name: '确认恢复 2 项' }).click();
  const applies = (await page.evaluate(() => (window as typeof window & { __migrationCalls: Array<{ command: string; args: Record<string, unknown> }> }).__migrationCalls))
    .filter((call) => call.command === 'apply_portable_bundle');
  expect(applies).toHaveLength(1);
  expect(applies[0].args.selected).toEqual(['project:new', 'profile:p1']);

  await page.getByLabel('WebDAV 目录地址').fill('https://dav.example.test/cliora/');
  await page.getByLabel('用户名').fill('example');
  await page.getByLabel('WebDAV 密码').fill('correct-password');
  await page.getByRole('button', { name: '验证并保存' }).click();
  await expect(page.getByText('待处理的同步冲突')).toBeVisible();
  await page.getByRole('button', { name: '查看内容并选择' }).click();
  await expect(page.getByText('本机规则正文')).toBeVisible();
  await expect(page.getByText('远端规则正文 A')).toBeVisible();
  await page.getByRole('button', { name: '保留本机' }).click();
  await expect(page.getByText('冲突已处理，其他资料保持不变。')).toBeVisible();
});
