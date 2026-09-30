import { expect, test } from '@playwright/test';

test('portable notifications refresh applied state and preferences while preserving stale profile and common drafts', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let next = 0;
    let managed = ['codex'];
    let theme = 'system';
    let tool_icons = {};
    let profile = { id: 'p1', tool: 'codex', name: '工作配置', version: 2, revision: 'local-profile', inheritCommon: true, files: { settings: 'model = "local"' }, suppressed: {}, nativeCredentials: {}, connection: null };
    let common = { tool: 'codex', version: 2, revision: 'local-common', files: { settings: 'model = "base"' } };
    let applied = 2;
    const emit = (event: string) => { for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, payload: null }); };
    Object.assign(window, {
      isTauri: true,
      __portableCalls: calls,
      __receivePortable: (kind: string) => {
        applied = 0; theme = 'dark'; tool_icons = { codex: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=' };
        if (kind === 'clean') profile = { ...profile, revision: 'remote-clean', files: { settings: 'model = "remote-clean"' } };
        if (kind === 'profile') { profile = { ...profile, revision: 'remote-profile', files: { settings: 'model = "remote-profile"' } }; managed = []; }
        if (kind === 'common') common = { ...common, revision: 'remote-common', files: { settings: 'model = "remote-common"' } };
        for (const event of ['cliora:portable-changed', 'cliora:bindings-changed', 'cliora:projects-changed']) emit(event);
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++next, callback); return next; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === 'plugin:event|listen') { const event = String(args.event); listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]); return args.handler; }
          if (command === 'plugin:event|unlisten') { const event = String(args.event); listeners.set(event, (listeners.get(event) ?? []).filter((id) => id !== args.eventId)); return null; }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: managed, theme, tool_icons }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available' }, resources: { state: 'available' } }], managedIds: managed, preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_tray_status') return { available: true, error: null };
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_registered_tool_workspace') return structuredClone({
            probe: { selectedPath: 'C:/codex.exe', installations: [], nativeFiles: [{ role: 'settings', path: 'C:/config.toml', format: 'toml', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '' },
            profiles: [profile], common, binding: { profileId: 'p1', profileVersion: applied }, customPath: null, snapshots: [], recoveryNeeded: [],
          });
          if (command === 'inspect_registered_native_draft') return {};
          if (command === 'prepare_registered_native_import') return { files: args.files, inspection: { connection: null }, migratedSecret: false, nativeCredentials: {} };
          if (command === 'save_registered_native_profile') {
            if ((args.profile as typeof profile).revision !== profile.revision) throw { message: '命名配置已由其他操作修改，请重新读取' };
            return args.profile;
          }
          if (command === 'save_registered_common_config') {
            if ((args.common as typeof common).revision !== common.revision) throw { message: '通用配置已由其他操作修改，请重新读取' };
            return { common: args.common, applications: [] };
          }
          if (command === 'list_mcp_definitions' || command === 'list_skill_packages') return [];
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByText('已写入原生文件 · 下次启动读取')).toBeVisible();
  const receive = (kind: string) => page.evaluate((value) => (window as typeof window & { __receivePortable: (kind: string) => void }).__receivePortable(value), kind);
  await receive('clean');
  await expect(page.getByText('已保存的修改尚未应用；请在工具页应用')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByLabel('管理中的工具').locator('img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.getByRole('button', { name: '编辑配置 →' }).click();
  const draft = page.getByRole('textbox', { name: 'settings 配置草稿' });
  await expect(draft).toHaveText('model = "remote-clean"');
  await page.getByRole('button', { name: '通用配置', exact: true }).click();
  await expect(draft).toHaveText('model = "base"');
  await draft.fill('model = "unsaved-common"');
  await receive('common');
  await expect(draft).toHaveText('model = "unsaved-common"');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('通用配置已由其他操作修改');
  await page.getByRole('button', { name: /工作配置.*有未应用的修改/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(draft).toHaveText('model = "remote-clean"');
  await draft.fill('model = "unsaved-profile"');
  await receive('profile');
  await expect(page.getByText('已收到资料更新；当前未保存草稿已保留，保存时会检查资料是否变化。')).toBeVisible();
  await expect(draft).toHaveText('model = "unsaved-profile"');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('命名配置已由其他操作修改');
  const saves = await page.evaluate(() => (window as typeof window & { __portableCalls: Array<{ command: string; args: Record<string, unknown> }> }).__portableCalls.filter((call) => call.command.startsWith('save_registered')));
  expect(saves[0].args.common).toMatchObject({ version: 2, revision: 'local-common', files: { settings: 'model = "unsaved-common"' } });
  expect(saves[1].args.profile).toMatchObject({ version: 2, revision: 'remote-clean', files: { settings: 'model = "unsaved-profile"' } });
});

test('migration previews conflicts, keeps choices, cancels, and separates native failures from imported data', async ({ page }) => {
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
        if (command === 'plugin:dialog|open') return (args.options as { directory?: boolean } | undefined)?.directory ? 'C:/new-project' : 'C:/backup.cliora';
        if (command === 'preview_portable_bundle') return { previewId: 'preview-1', pendingProjects: 1,
          items: [
            { key: 'project:new', kind: 'project', label: '新项目', status: 'new', pendingFields: ['项目本机目录'], localPreview: null, incomingPreview: '{"name":"新项目"}' },
            { key: 'profile:p1', kind: 'profile', toolId: 'codex', label: '工作配置', status: 'conflict', pendingFields: [], localPreview: '{"name":"本机配置"}', incomingPreview: '{"name":"配置包配置"}' },
          ] };
        if (command === 'cancel_portable_preview') return null;
        if (command === 'apply_portable_bundle') {
          const global = (args.applyTargets as Array<{ projectId: string | null }>).some((target) => target.projectId === null);
          return { imported: (args.selected as string[]).length, targets: global
            ? [{ label: '工作配置 · 全局', status: 'failed', detail: '本机文件冲突' }]
            : [{ label: '新项目', status: 'linked', detail: null }, { label: '工作配置 · new', status: 'applied', detail: null }] };
        }
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
  if (!await page.getByPlaceholder('输入导出时的口令').isVisible()) await page.getByRole('button', { name: '从配置包恢复', exact: true }).click();
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
  if (!await page.getByPlaceholder('输入导出时的口令').isVisible()) await page.getByRole('button', { name: '从配置包恢复', exact: true }).click();
  await page.getByPlaceholder('输入导出时的口令').fill('correct-password');
  await page.getByRole('button', { name: '选择配置包并预览' }).click();
  await page.getByRole('checkbox', { name: /工作配置.*与本机不同/ }).check();
  await page.getByText('比较本机与配置包内容').last().click();
  await expect(page.getByText('{"name":"本机配置"}')).toBeVisible();
  await expect(page.getByText('{"name":"配置包配置"}')).toBeVisible();
  await page.getByRole('button', { name: '选择目录' }).click();
  await page.getByLabel('恢复后应用到本机（codex）').selectOption('new');
  await page.getByRole('button', { name: '确认恢复 2 项' }).click();
  const applies = (await page.evaluate(() => (window as typeof window & { __migrationCalls: Array<{ command: string; args: Record<string, unknown> }> }).__migrationCalls))
    .filter((call) => call.command === 'apply_portable_bundle');
  expect(applies).toHaveLength(1);
  expect(applies[0].args.selected).toEqual(['project:new', 'profile:p1']);
  expect(applies[0].args.projectLinks).toEqual([{ projectId: 'new', path: 'C:/new-project' }]);
  expect(applies[0].args.applyTargets).toEqual([{ profileId: 'p1', projectId: 'new' }]);
  await expect(page.getByText(/工作配置 · new：已应用/)).toBeVisible();

  if (!await page.getByPlaceholder('输入导出时的口令').isVisible()) await page.getByRole('button', { name: '从配置包恢复', exact: true }).click();
  await page.getByPlaceholder('输入导出时的口令').fill('correct-password');
  await page.getByRole('button', { name: '选择配置包并预览' }).click();
  await page.getByRole('checkbox', { name: /工作配置.*与本机不同/ }).check();
  await page.getByLabel('恢复后应用到本机（codex）').selectOption('global');
  await page.getByRole('button', { name: '确认恢复 2 项' }).click();
  await expect(page.getByText(/已恢复 2 项资料。工作配置 · 全局：失败，本机文件冲突/)).toBeVisible();
  await expect(page.getByRole('button', { name: '确认恢复 2 项' })).toHaveCount(0);

  await page.getByRole('button', { name: '配置 WebDAV', exact: true }).click();
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
