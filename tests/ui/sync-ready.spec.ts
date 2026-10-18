import { expect, test, type Page } from '@playwright/test';

type SyncSeed = {
  configured?: boolean;
  enabled?: boolean;
  lastSuccess?: number | null;
  lastError?: string | null;
  pending?: number;
  items?: unknown[];
  previewItems?: unknown[];
  projects?: unknown[];
  conflicts?: unknown[];
  blockers?: unknown[];
  accounts?: unknown[];
  badPassword?: boolean;
  corrupt?: boolean;
  cancelOpen?: boolean;
};

async function install(page: Page, seed: SyncSeed = {}) {
  await page.addInitScript((initial: SyncSeed) => {
    const control = {
      configured: false,
      enabled: true,
      lastSuccess: 1700000000 as number | null,
      lastError: null as string | null,
      pending: 0,
      endpoint: 'https://sync.example.com/cliora/',
      items: [] as unknown[],
      previewItems: [] as unknown[],
      projects: [] as unknown[],
      conflicts: [] as { key: string }[],
      blockers: [] as unknown[],
      accounts: [] as { id: string; toolId: string; version: number }[],
      badPassword: false,
      corrupt: false,
      cancelOpen: false,
      previewCalls: 0,
      applyCalls: 0,
      openCalls: 0,
      lastExport: null as { destination?: string; password?: string; selected?: string[] } | null,
      lastApply: null as { previewId?: string; selected?: string[]; projectLinks?: unknown[]; applyTargets?: unknown[] } | null,
      lastConfigure: null as { encryptionPassword?: string; previousEncryptionPassword?: string; authPassword?: string; endpoint?: string; username?: string } | null,
      lastRelink: null as { projectId?: string; projectPath?: string } | null,
      lastLogin: null as { id?: string; expectedVersion?: number; method?: string } | null,
      lastRetry: null as string | null,
      syncCalls: 0,
      syncResult: null as { uploaded?: number; downloaded?: number; compared?: number; transfers?: unknown[]; receipt?: unknown } | null,
      storedReceipt: null as unknown,
      installReady: false,
      loginReady: false,
      ...initial,
    };
    const remembered = (() => {
      try { return JSON.parse(window.sessionStorage.getItem('cliora-sync-ready-memory') || 'null') as { projects?: unknown[]; blockers?: unknown[] } | null; }
      catch { return null; }
    })();
    if (remembered?.projects) control.projects = remembered.projects;
    if (remembered?.blockers) control.blockers = remembered.blockers;
    const theme = 'light';
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    const codex = { id: 'codex', name: 'Codex', interfaceFormats: [], projectModelOverride: false, yoloAvailable: true, nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } };
    const status = () => ({
      configured: control.configured,
      enabled: control.enabled,
      endpoint: control.configured ? control.endpoint : null,
      lastSuccess: control.configured ? control.lastSuccess : null,
      lastError: control.lastError,
      retryAfter: null,
      uploaded: 0,
      downloaded: 0,
      pendingChanges: control.pending,
      conflicts: control.conflicts,
      blockers: control.blockers,
      transfers: [],
      compared: 0,
      receipt: control.storedReceipt,
    });
    Object.assign(window, {
      isTauri: true,
      __syncReady: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap' || command === 'set_language' || command === 'set_theme') return bootstrap();
        if (command === 'list_cli_adapters') return { registered: [codex], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return control.projects;
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: true, error: null };
        if (command === 'list_portable_items') return control.items;
        if (command === 'get_webdav_status' || command === 'set_webdav_enabled') return status();
        if (command === 'configure_webdav') {
          control.lastConfigure = args.setup;
          control.configured = true;
          control.enabled = args.setup?.enabled !== false;
          control.endpoint = args.setup?.endpoint ?? control.endpoint;
          control.lastError = null;
          return status();
        }
        if (command === 'sync_webdav_now') {
          control.syncCalls += 1;
          control.lastError = null;
          control.pending = 0;
          const produced = control.syncResult;
          const uploaded = produced?.uploaded ?? 1;
          const downloaded = produced?.downloaded ?? 0;
          const compared = produced?.compared ?? 0;
          const transfers = produced?.transfers ?? [];
          const receipt = produced?.receipt ?? { at: 1700000000, compared, uploaded, downloaded, transfers };
          control.storedReceipt = receipt;
          control.lastSuccess = 1700000000;
          return { ...status(), uploaded, downloaded, compared, transfers, receipt, lastSuccess: 1700000000, pendingChanges: 0 };
        }
        if (command === 'retry_restore_blocker') {
          control.lastRetry = args.key;
          const blockers = control.blockers as { key?: string; action?: string; detail?: string }[];
          const blocker = blockers.find((item) => item.key === args.key);
          if (blocker?.action === 'install' && !control.installReady) throw { message: blocker.detail || '未发现可执行文件' };
          if (blocker?.action === 'relogin' && !control.loginReady) throw { message: blocker.detail || '登录被拒绝，材料已保留' };
          control.blockers = blockers.filter((item) => item.key !== args.key);
          return status();
        }
        if (command === 'export_portable_bundle') {
          control.lastExport = args;
          return Array.isArray(control.items) ? control.items.length : 0;
        }
        if (command === 'preview_portable_bundle') {
          control.previewCalls += 1;
          if (control.badPassword) throw { message: '口令不正确', action: '本机资料没有改动。' };
          if (control.corrupt) throw { message: '配置包资料结构损坏', action: '本机资料没有改动。' };
          return { previewId: 'prev-1', pendingProjects: 0, items: control.previewItems };
        }
        if (command === 'apply_portable_bundle') {
          control.applyCalls += 1;
          control.lastApply = args;
          const previewItems = control.previewItems as { key: string; label: string; status: string }[];
          control.conflicts = previewItems.filter((item) => item.status === 'conflict').map((item) => ({
            key: item.key, label: item.label, localPresent: true, localDigest: 'aa', remoteVersions: 1, remoteDeleted: false, versions: [{ id: 'bundle:1', digest: 'bb', deleted: false }],
          }));
          return { imported: previewItems.filter((item) => item.status !== 'conflict').length, targets: [] };
        }
        if (command === 'cancel_portable_preview') return null;
        if (command === 'preview_webdav_conflict') return { key: args.key, localSummary: '本机仍是原来的内容', versions: [{ id: 'bundle:1', summary: '配置包里的版本', deleted: false }] };
        if (command === 'resolve_webdav_conflict') {
          control.conflicts = control.conflicts.filter((item) => item.key !== args.key);
          return status();
        }
        if (command === 'relink_project') {
          control.lastRelink = args;
          const projects = control.projects as { id: string; path?: string; available?: boolean }[];
          const current = projects.find((item) => item.id === args.projectId);
          const previous = current?.path ?? '';
          const updated = { ...(current ?? { id: args.projectId, name: '项目' }), path: args.projectPath, available: true };
          control.projects = projects.map((item) => item.id === args.projectId ? updated : item);
          const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
          control.blockers = (control.blockers as { action?: string; detail?: string }[]).filter((blocker) => {
            const detail = blocker.detail ?? '';
            if (blocker.action === 'relink' && previous) {
              const mark = '目录不存在：';
              const index = detail.indexOf(mark);
              if (index >= 0 && normalize(detail.slice(index + mark.length).trim()) === normalize(previous)) return false;
            }
            const writeMark = '写入已选目录：';
            const writeAt = detail.indexOf(writeMark);
            if (writeAt >= 0) {
              const target = normalize(detail.slice(writeAt + writeMark.length).trim());
              if (target && (target === normalize(args.projectPath ?? '') || (previous && target === normalize(previous)))) return false;
            }
            return true;
          });
          window.sessionStorage.setItem('cliora-sync-ready-memory', JSON.stringify({ projects: control.projects, blockers: control.blockers }));
          return updated;
        }
        if (command === 'list_accounts') return control.accounts;
        if (command === 'account_capabilities') return [{ toolId: 'codex', methods: ['browser'], managedLogin: true }];
        if (command === 'start_account_login') {
          control.lastLogin = args;
          return { id: args.id, toolId: 'codex', version: args.expectedVersion, state: 'pending' };
        }
        if (command === 'plugin:dialog|save') return 'C:/backup.cliora';
        if (command === 'plugin:dialog|open') {
          control.openCalls += 1;
          if (control.cancelOpen) return null;
          if (args.options?.directory) return 'C:/work';
          return 'C:/incoming.cliora';
        }
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, seed);
}

async function openMigration(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
}

const portableItem = (key: string, label: string, status = 'available') => ({ key, kind: 'profile', label, status, pendingFields: [], toolId: 'codex', localPreview: null, incomingPreview: '' });
const project = (id: string, name: string, path: string, available: boolean) => ({ id, name, path, available, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} });

test('export uses one passphrase for every item and rejects a short one', async ({ page }) => {
  await install(page, { items: [portableItem('profile:1', '默认配置'), portableItem('library:1', '提示')] });
  await openMigration(page);
  await page.getByRole('button', { name: '导出加密配置包' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('将导出全部 2 项可迁移资料。')).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByText('至少勾选一项资料。')).toHaveCount(0);
  await expect(dialog.locator('input[type="password"], input[type="text"]')).toHaveCount(1);
  const password = dialog.getByLabel('配置包口令');
  await password.fill('12345678901');
  await expect(dialog.getByRole('button', { name: '导出配置包', exact: true })).toBeDisabled();
  await password.fill('123456789012');
  await expect(dialog.getByRole('button', { name: '导出配置包', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '导出配置包', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastExport: { destination: string; password: string; selected: string[] } | null } }).__syncReady.lastExport)).toEqual({ destination: 'C:/backup.cliora', password: '123456789012', selected: [] });
  await expect(page.getByText('已导出 2 项。')).toBeVisible();
  await expect(page.getByText('重新绑定', { exact: true })).toHaveCount(0);
  await expect(page.getByText('稍后应用', { exact: true })).toHaveCount(0);
});

test('unlock restores immediately and a bad passphrase or cancel writes nothing', async ({ page }) => {
  await install(page, { previewItems: [portableItem('library:1', '提示', 'new'), portableItem('profile:1', '默认配置', 'conflict')] });
  await openMigration(page);
  await page.getByRole('button', { name: '从配置包恢复' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByText('稍后应用')).toHaveCount(0);
  await expect(dialog.getByText('重新关联')).toHaveCount(0);
  await expect(dialog.getByText('逐项')).toHaveCount(0);
  await dialog.getByLabel('配置包口令').fill('123456789012');
  await dialog.getByRole('button', { name: '解锁并恢复' }).click();
  await expect(page.getByText('冲突项仍保留本机，请选择版本；其它资料可以使用。')).toBeVisible();
  await expect(page.getByRole('region', { name: 'WebDAV 同步' }).getByRole('button', { name: '选择冲突版本' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const state = (window as unknown as { __syncReady: { previewCalls: number; applyCalls: number; lastApply: { selected: string[]; projectLinks: unknown[]; applyTargets: unknown[] } | null } }).__syncReady;
    return { previewCalls: state.previewCalls, applyCalls: state.applyCalls, apply: state.lastApply };
  })).toEqual({ previewCalls: 1, applyCalls: 1, apply: { previewId: 'prev-1', selected: [], projectLinks: [], applyTargets: [] } });

  await page.evaluate(() => { (window as unknown as { __syncReady: { badPassword: boolean; previewCalls: number; applyCalls: number } }).__syncReady.badPassword = true; });
  await page.getByRole('button', { name: '从配置包恢复' }).click();
  const again = page.getByRole('dialog');
  await again.getByLabel('配置包口令').fill('wrong-password');
  await again.getByRole('button', { name: '解锁并恢复' }).click();
  await expect(again.getByRole('alert')).toContainText('口令不正确');
  await expect(again.getByRole('alert')).toContainText('本机资料没有改动');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { applyCalls: number } }).__syncReady.applyCalls)).toBe(1);

  await page.evaluate(() => {
    const state = (window as unknown as { __syncReady: { badPassword: boolean; corrupt: boolean; cancelOpen: boolean } }).__syncReady;
    state.badPassword = false;
    state.corrupt = true;
    state.cancelOpen = false;
  });
  await again.getByRole('button', { name: '解锁并恢复' }).click();
  await expect(again.getByRole('alert')).toContainText('配置包资料结构损坏');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { applyCalls: number } }).__syncReady.applyCalls)).toBe(1);

  await page.evaluate(() => {
    const state = (window as unknown as { __syncReady: { corrupt: boolean; cancelOpen: boolean; previewCalls: number } }).__syncReady;
    state.corrupt = false;
    state.cancelOpen = true;
  });
  const previews = await page.evaluate(() => (window as unknown as { __syncReady: { previewCalls: number } }).__syncReady.previewCalls);
  await again.getByRole('button', { name: '解锁并恢复' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { previewCalls: number; applyCalls: number; openCalls: number } }).__syncReady.openCalls)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { previewCalls: number } }).__syncReady.previewCalls)).toBe(previews);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { applyCalls: number } }).__syncReady.applyCalls)).toBe(1);
});

test('an unconnected WebDAV dialog collects only the connection', async ({ page }) => {
  await install(page);
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('尚未连接')).toBeVisible();
  await expect(webdav.getByText('同步已打开')).toHaveCount(0);
  await expect(webdav.getByText('当前可用')).toHaveCount(0);
  await expect(webdav.getByText('上次成功')).toHaveCount(0);
  await expect(webdav.getByText('https://sync.example.com/cliora/')).toHaveCount(0);
  await webdav.getByRole('button', { name: '配置 WebDAV' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('WebDAV 目录地址')).toBeVisible();
  await expect(dialog.getByLabel('用户名')).toBeVisible();
  await expect(dialog.getByLabel('连接口令')).toBeVisible();
  await expect(dialog.locator('input[type="password"]')).toHaveCount(1);
  await expect(dialog.getByText('单独设置加密口令')).toHaveCount(0);
  await expect(dialog.getByLabel('新的独立加密口令')).toHaveCount(0);
  await expect(dialog.getByLabel('旧加密口令')).toHaveCount(0);
  await expect(dialog.getByText('默认用连接密码解锁远端加密空间')).toBeVisible();
  await dialog.getByLabel('WebDAV 目录地址').fill('https://sync.example.com/cliora/');
  await dialog.getByLabel('用户名').fill('me');
  await dialog.getByLabel('连接口令').fill('too-short');
  await expect(dialog.getByRole('button', { name: '验证并保存' })).toBeDisabled();
  await dialog.getByLabel('连接口令').fill('connection-pw');
  await expect(dialog.getByText('不再另设加密口令')).toBeVisible();
  await dialog.getByRole('button', { name: '验证并保存' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastConfigure: { endpoint: string; username: string; authPassword: string; encryptionPassword: string; previousEncryptionPassword: string } | null } }).__syncReady.lastConfigure)).toEqual({
    endpoint: 'https://sync.example.com/cliora/',
    username: 'me',
    authPassword: 'connection-pw',
    encryptionPassword: '',
    previousEncryptionPassword: '',
    enabled: true,
  });
});

test('a connected WebDAV with nothing blocking shows sync, the last result, and readiness', async ({ page }) => {
  await install(page, { configured: true, enabled: true, lastSuccess: 1700000000, projects: [project('p1', '示例项目', 'C:/work', true)] });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('同步已打开')).toBeVisible();
  await expect(webdav.getByText(/上次成功/)).toBeVisible();
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('https://sync.example.com/cliora/')).toHaveCount(0);
  await expect(webdav.getByText('默认用连接密码解锁远端加密空间')).toHaveCount(0);
  await expect(webdav.getByText('重新绑定')).toHaveCount(0);
  await expect(webdav.getByText('稍后应用')).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '下一步' })).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '选择目录' })).toHaveCount(0);
  await webdav.getByRole('button', { name: '修改连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('WebDAV 目录地址')).toHaveValue('https://sync.example.com/cliora/');
  await expect(dialog.getByText('默认用连接密码解锁远端加密空间')).toBeVisible();
  await expect(dialog.getByLabel('新的独立加密口令')).toHaveCount(0);
});

test('pending uploads stay usable and a connection failure can be retried', async ({ page }) => {
  await install(page, { configured: true, pending: 4, lastSuccess: 1700000000 });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('尚未上传 4 项。已应用的内容仍可使用。')).toBeVisible();
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('尚未可用')).toHaveCount(0);
  await expect(webdav.getByText('设备不可用')).toHaveCount(0);
  await expect(webdav.getByText('其余内容可用')).toHaveCount(0);

  await page.evaluate(() => {
    const state = (window as unknown as { __syncReady: { lastError: string | null; pending: number } }).__syncReady;
    state.lastError = 'WebDAV 无法连接：offline';
    state.pending = 0;
  });
  await page.getByRole('tab', { name: '常规' }).click();
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await expect(webdav.getByText('连接失败：WebDAV 无法连接：offline')).toBeVisible();
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('https://sync.example.com/cliora/')).toHaveCount(0);
  await webdav.getByRole('button', { name: '重试', exact: true }).click();
  await expect(webdav.getByText('连接失败：WebDAV 无法连接：offline')).toHaveCount(0);
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();
  await expect(webdav.getByRole('button', { name: '修改连接', exact: true })).toBeVisible();
});

test('pending uploads stay visible beside a real blocker without replacing readiness', async ({ page }) => {
  await install(page, {
    configured: true,
    pending: 13,
    blockers: [{ key: 'account:m', label: 'MiniMax', action: 'relogin', detail: '账号 MiniMax 的认证文件无法读取，不能当作已导出' }],
  });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('其余内容可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('尚未上传 13 项。已应用的内容仍可使用。')).toBeVisible();
  await expect(webdav.getByText('当前可用', { exact: true })).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '重新登录', exact: true })).toBeVisible();
});

test('one missing directory, install, sign-in, or conflict leaves everything else usable', async ({ page }) => {
  await install(page, {
    configured: true,
    projects: [project('p-missing', '缺目录项目', 'D:/missing', false), project('p-ok', '可用项目', 'C:/work', true)],
    blockers: [
      { key: 'binding:missing', label: 'Codex 活动配置', action: 'relink', detail: '目录不存在：D:/missing' },
      { key: 'binding:codex', label: 'Codex 活动配置', action: 'install', detail: '未发现可执行文件' },
      { key: 'account:a1', label: '工作账号', action: 'relogin', detail: '登录被拒绝，材料已保留' },
    ],
    conflicts: [{ key: 'profile:9', label: '默认配置', localPresent: true, localDigest: 'aa', remoteVersions: 1, remoteDeleted: false, versions: [{ id: 'v1', digest: 'bb', deleted: false }] }],
    accounts: [{ id: 'a1', toolId: 'codex', version: 4 }],
  });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('其余内容可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('设备不可用')).toHaveCount(0);
  await expect(webdav.getByText('尚未可用')).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(1);
  await expect(webdav.getByRole('button', { name: '安装 CLI', exact: true })).toBeVisible();
  await expect(webdav.getByRole('button', { name: '重新登录', exact: true })).toBeVisible();
  await expect(webdav.getByRole('button', { name: '选择冲突版本', exact: true })).toBeVisible();
  await expect(webdav.getByText('重新绑定')).toHaveCount(0);
  await expect(webdav.getByText('稍后应用')).toHaveCount(0);

  await webdav.getByRole('button', { name: '安装 CLI', exact: true }).click();
  await expect(webdav.getByText('请安装 Codex 活动配置 后重试。未发现可执行文件')).toBeVisible();
  await webdav.getByRole('button', { name: '重新登录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastLogin: { id: string; expectedVersion: number; method: string } | null } }).__syncReady.lastLogin)).toEqual({ id: 'a1', expectedVersion: 4, method: 'browser' });
  await webdav.getByRole('button', { name: '选择冲突版本', exact: true }).click();
  await expect(webdav.getByRole('button', { name: '保留本机', exact: true })).toBeVisible();
  await webdav.getByRole('button', { name: '保留本机', exact: true }).click();
  await expect(webdav.getByRole('button', { name: '选择冲突版本', exact: true })).toHaveCount(0);
  await webdav.getByRole('button', { name: '选择目录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRelink: { projectId: string; projectPath: string } | null } }).__syncReady.lastRelink)).toEqual({ projectId: 'p-missing', projectPath: 'C:/work' });
  await expect(webdav.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(0);
  await expect(webdav.getByText('其余内容可用', { exact: true })).toBeVisible();
});

test('a chosen directory stays chosen after status is loaded again', async ({ page }) => {
  await install(page, {
    configured: true,
    projects: [project('p-missing', '缺目录项目', 'D:/missing', false), project('p-ok', '可用项目', 'C:/ok', true)],
    blockers: [
      { key: 'binding:missing', label: 'Codex 活动配置', action: 'relink', detail: '目录不存在：D:/missing' },
      { key: 'binding:codex', label: 'Codex 活动配置', action: 'install', detail: '未发现可执行文件' },
    ],
  });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(1);
  await webdav.getByRole('button', { name: '选择目录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { blockers: { action: string }[] } }).__syncReady.blockers.map((item) => item.action))).toEqual(['install']);
  await page.reload();
  await openMigration(page);
  const again = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(again.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(0);
  await expect(again.getByText('目录不存在：D:/missing')).toHaveCount(0);
  await expect(again.getByRole('button', { name: '安装 CLI', exact: true })).toBeVisible();
  await expect(again.getByText('其余内容可用', { exact: true })).toBeVisible();
  await expect(again.getByText('稍后应用')).toHaveCount(0);
  await expect(again.getByText('重新绑定')).toHaveCount(0);
});

test('a partial directory write retries into the chosen directory instead of a stale relink', async ({ page }) => {
  await install(page, {
    configured: true,
    projects: [project('p-chosen', '已选项目', 'C:/chosen', true)],
    blockers: [
      { key: 'binding:failed', label: 'Codex 活动配置', action: 'retry', detail: '上次管理的字段已被外部修改：settings/model\n写入已选目录：C:/chosen' },
      { key: 'binding:other', label: '其它目录', action: 'relink', detail: '目录不存在：D:/other' },
    ],
  });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('其余内容可用', { exact: true })).toBeVisible();
  await expect(webdav.getByText('上次管理的字段已被外部修改：settings/model')).toBeVisible();
  await expect(webdav.getByText('目录不存在：C:/missing')).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '写入已选目录', exact: true })).toHaveCount(1);
  await expect(webdav.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(1);
  await webdav.getByRole('button', { name: '写入已选目录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRelink: { projectId: string; projectPath: string } | null; openCalls: number } }).__syncReady.lastRelink)).toEqual({ projectId: 'p-chosen', projectPath: 'C:/chosen' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { openCalls: number } }).__syncReady.openCalls)).toBe(0);
  await expect(webdav.getByRole('button', { name: '写入已选目录', exact: true })).toHaveCount(0);
  await expect(webdav.getByText('已把「Codex 活动配置」写入选定目录。其它资料保持可用。')).toBeVisible();
  await expect(webdav.getByRole('button', { name: '选择目录', exact: true })).toHaveCount(1);
  await expect(webdav.getByText('其余内容可用', { exact: true })).toBeVisible();
});

test('a failed CLI write or release retries locally, and install or sign-in clears the blocker', async ({ page }) => {
  await install(page, {
    configured: true,
    blockers: [
      { key: 'binding:write', label: 'Codex 活动配置', action: 'retry', detail: '上次写入失败' },
      { key: 'binding:release', label: 'Pi 活动配置', action: 'retry', detail: '上次释放失败' },
      { key: 'binding:install', label: 'Codex 活动配置', action: 'install', detail: '未发现可执行文件' },
      { key: 'account:a1', label: '工作账号', action: 'relogin', detail: '登录被拒绝，材料已保留' },
    ],
    accounts: [{ id: 'a1', toolId: 'codex', version: 4, state: 'signed_in', pendingLogin: null }],
  });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  const retryButtons = webdav.getByRole('button', { name: '重试', exact: true });
  await retryButtons.nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRetry: string | null; syncCalls: number } }).__syncReady.lastRetry)).toBe('binding:write');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { syncCalls: number } }).__syncReady.syncCalls)).toBe(0);
  await expect(webdav.getByText('「Codex 活动配置」已按同步结果写回本机。其它资料保持可用。')).toBeVisible();
  await retryButtons.nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRetry: string | null } }).__syncReady.lastRetry)).toBe('binding:release');
  await expect(webdav.getByText('「Pi 活动配置」已按同步结果写回本机。其它资料保持可用。')).toBeVisible();

  await webdav.getByRole('button', { name: '安装 CLI', exact: true }).click();
  await expect(webdav.getByText('请安装 Codex 活动配置 后重试。未发现可执行文件')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __syncReady: { installReady: boolean } }).__syncReady.installReady = true; });
  await webdav.getByRole('button', { name: '安装 CLI', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRetry: string | null } }).__syncReady.lastRetry)).toBe('binding:install');
  await expect(webdav.getByRole('button', { name: '安装 CLI', exact: true })).toHaveCount(0);

  await page.evaluate(() => { (window as unknown as { __syncReady: { loginReady: boolean } }).__syncReady.loginReady = true; });
  await webdav.getByRole('button', { name: '重新登录', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastRetry: string | null; lastLogin: unknown } }).__syncReady.lastRetry)).toBe('account:a1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { lastLogin: unknown } }).__syncReady.lastLogin)).toBeNull();
  await expect(webdav.getByRole('button', { name: '重新登录', exact: true })).toHaveCount(0);
  await expect(webdav.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __syncReady: { syncCalls: number } }).__syncReady.syncCalls)).toBe(0);
});

test('a sync says what matched or moved instead of a zero count', async ({ page }) => {
  await install(page, { configured: true, enabled: true, lastSuccess: 1700000000 });
  await openMigration(page);
  const webdav = page.getByRole('region', { name: 'WebDAV 同步' });
  await expect(webdav.getByText('上次同步没有留下明细', { exact: true })).toBeVisible();
  await expect(webdav.getByText('上传 0 项、接收 0 项')).toHaveCount(0);
  const aligned = {
    uploaded: 0,
    downloaded: 0,
    compared: 12,
    transfers: [] as unknown[],
    receipt: { at: 1700000000, compared: 12, uploaded: 0, downloaded: 0, transfers: [] as unknown[] },
  };
  const moved = {
    uploaded: 1,
    downloaded: 1,
    compared: 12,
    transfers: [
      { direction: 'download', key: 'library:1', label: 'Example', kind: 'library', deleted: false },
      { direction: 'upload', key: 'account:1', label: '工作账号', kind: 'account', deleted: false },
    ],
    receipt: {
      at: 1700000100,
      compared: 12,
      uploaded: 1,
      downloaded: 1,
      transfers: [
        { direction: 'download', key: 'library:1', label: 'Example', kind: 'library', deleted: false },
        { direction: 'upload', key: 'account:1', label: '工作账号', kind: 'account', deleted: false },
      ],
    },
  };
  await page.evaluate((next) => {
    (window as unknown as { __syncReady: { syncResult: unknown } }).__syncReady.syncResult = next;
  }, aligned);
  await webdav.getByRole('button', { name: '立即同步', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('已经和云端一致', { exact: true })).toBeVisible();
  await expect(dialog.getByText('比对了 12 项。没有需要上传或接收的内容。', { exact: true })).toBeVisible();
  await expect(dialog.getByText('当前可用', { exact: true })).toHaveCount(0);
  await expect(page.getByText('上传 0 项、接收 0 项')).toHaveCount(0);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(webdav.getByText('已经和云端一致', { exact: true })).toBeVisible();
  await expect(webdav.getByText('比对了 12 项。没有需要上传或接收的内容。', { exact: true })).toBeVisible();
  await expect(webdav.getByText('当前可用', { exact: true })).toBeVisible();

  await page.evaluate((next) => {
    (window as unknown as { __syncReady: { syncResult: unknown } }).__syncReady.syncResult = next;
  }, moved);
  await webdav.getByRole('button', { name: '立即同步', exact: true }).click();
  await expect(dialog.getByText('Example', { exact: true })).toBeVisible();
  await expect(dialog.getByText('工作账号', { exact: true })).toBeVisible();
  await expect(dialog.getByText('资料库', { exact: true })).toBeVisible();
  await expect(dialog.getByText('登录', { exact: true })).toBeVisible();
  await expect(dialog.getByText('已经和云端一致', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '知道了' }).click();
  await expect(webdav.getByText('Example', { exact: true })).toBeVisible();
  await webdav.getByRole('button', { name: '查看明细' }).click();
  await expect(page.getByRole('dialog').getByText('已接收', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('已上传', { exact: true })).toBeVisible();
});
