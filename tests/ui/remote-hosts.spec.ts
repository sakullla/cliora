import { expect, test, type Locator, type Page } from '@playwright/test';

async function install(page: Page) {
  await page.addInitScript(() => {
    const targets = ['key', 'password'].map((authMethod, index) => ({ id: `host-${index}`, name: `${authMethod} fixture`, host: `${authMethod}.invalid`, port: 22, user: 'fixture', authMethod, defaultPath: `/fixture/${authMethod}`, enabled: true, createdAt: 1, updatedAt: 1 }));
    const state = { hold: '', failure: '', response: '', createOutcome: '', generation: '', savedRevision: 0, replaceHost: () => {}, reads: [] as string[], readOperations: [] as unknown[], cancelled: 0, writes: [] as string[], release: () => {}, releases: [] as Array<() => void> };
    const savedHost = localStorage.getItem('fixture:replaced-host');
    if (savedHost) Object.assign(targets[0], JSON.parse(savedHost));
    state.replaceHost = () => { targets[0].updatedAt++; targets[0].host = 'replacement.invalid'; localStorage.setItem('fixture:replaced-host', JSON.stringify(targets[0])); state.generation = 'replacement-'; window.dispatchEvent(new Event('cliora:remote-targets-changed')); };
    localStorage.setItem('cliora:remote-target', 'host-0');
    const descriptor = { id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', launch: { state: 'available', reason: '' } };
    Object.assign(window, {
      isTauri: true, __remoteFixture: state,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          const backend = (window as unknown as { __directoryBackend?: (command: string, args: Record<string, unknown>) => Promise<unknown> }).__directoryBackend;
          if (backend && ['list_remote_directory_receipts', 'save_remote_directory_receipt', 'create_remote_directory'].includes(command)) return backend(command, args);
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: true }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [descriptor], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_remote_targets') return targets.map(item => ({ ...item }));
          if (command === 'list_remote_saved_passwords') return ['host-1'];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'cancel_remote_operation') { state.cancelled++; return true; }
          if (command === 'list_remote_directories') { state.reads.push(`${args.targetId}:${args.parent}`); state.readOperations.push(args); }
          if (command === 'create_remote_directory') { state.writes.push(String(args.path)); localStorage.setItem('fixture:mkdir-count', String(Number(localStorage.getItem('fixture:mkdir-count') ?? 0) + 1)); }
          if (command === state.hold) await new Promise<void>(resolve => { state.releases.push(resolve); state.release = () => { for (const release of state.releases.splice(0)) release(); }; });
          if (command === 'create_remote_directory' && state.createOutcome === 'unknown') throw { code: 'remote_unknown', message: 'remote may have created directory', action: '核查远端原路径后再操作。', remote: { outcome: 'unknown', action: '核查远端原路径后再操作。' } };
          if (command === state.failure) throw { message: 'Permission denied fixture', action: '检查远端权限。', remote: { reason: 'permission', outcome: 'failed' } };
          // Synthetic shared database survives a full document reload. Product
          // persistence is SQLite; localStorage is only this IPC fixture.
          if (command === 'list_remote_directory_receipts') return JSON.parse(localStorage.getItem('fixture:directory-receipts') ?? '[]').map((item: any) => ({ ...item, outcome: item.outcome === 'pending' ? 'unknown' : item.outcome, inspection: item.inspection?.state === 'checking' ? undefined : item.inspection }));
          if (command === 'save_remote_directory_receipt') {
            const receipt = args.receipt as { id: string };
            const stored = JSON.parse(localStorage.getItem('fixture:directory-receipts') ?? '[]') as Array<{ id: string }>;
            localStorage.setItem('fixture:directory-receipts', JSON.stringify([...stored.filter(item => item.id !== receipt.id), receipt]));
            return null;
          }
          if (command === 'list_remote_directories' && state.response === 'missing') throw { message: 'Directory does not exist', remote: { reason: 'directory_missing' } };
          if (command === 'list_remote_directories') return state.response === 'invalid' ? [] : { parent: args.parent, items: state.response === 'empty' ? [] : [`${args.parent}/${state.generation}child`, ...state.writes], truncated: state.response === 'truncated' };
          if (command === 'test_remote_target') return { reachable: true, system: 'Linux fixture' };
          if (command === 'save_remote_target') {
            const incoming = args.target as typeof targets[number];
            const existing = targets.find(item => item.id === incoming.id);
            if (existing) {
              const sameConnection = ['host', 'port', 'user', 'authMethod', 'identityFile', 'sshConfig', 'defaultPath', 'enabled'].every(key => ((existing as any)[key] ?? null) === ((incoming as any)[key] ?? null));
              const updatedAt = sameConnection ? existing.updatedAt : existing.updatedAt + 1;
              Object.assign(existing, incoming, { createdAt: existing.createdAt, updatedAt });
              state.savedRevision = updatedAt;
              return { ...existing };
            }
            return { ...incoming, id: 'saved-host', updatedAt: 2 };
          }
          if (command === 'save_remote_project') return { ...(args.project as object), id: 'saved-project' };
          if (command === 'plugin:event|listen') return 0;
          return [];
        },
      },
    });
  });
}

async function fixture(page: Page, patch: { hold?: string; failure?: string; release?: boolean; response?: string; createOutcome?: string }) {
  await page.evaluate(patch => {
    const state = (window as unknown as { __remoteFixture: { hold: string; failure: string; response: string; createOutcome: string; release: () => void } }).__remoteFixture;
    if (patch.hold !== undefined) state.hold = patch.hold;
    if (patch.failure !== undefined) state.failure = patch.failure;
    if (patch.response !== undefined) state.response = patch.response;
    if (patch.createOutcome !== undefined) state.createOutcome = patch.createOutcome;
    if (patch.release) state.release();
  }, patch);
}
/** The remote folder picker opens from 选择其他文件夹… in the same new-session dialog as this computer. */
async function directory(page: Page) {
  const navigation = page.getByRole('navigation', { name: '页面' });
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  if (!await dialog.isVisible()) {
    if (!await page.getByRole('region', { name: '当前会话' }).isVisible()) await navigation.getByRole('button', { name: '工作台', exact: true }).click();
    await page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '新建会话' }).click();
  }
  await dialog.getByRole('button', { name: '工作目录 / 项目' }).click();
  await page.getByRole('button', { name: '选择其他文件夹…' }).click();
  return page.getByRole('dialog', { name: '选择远程文件夹' });
}
const folders = (dialog: Locator) => dialog.getByRole('listbox', { name: '已有目录' });
/** Types a new folder name in the current folder and returns the create button. */
async function folderDraft(dialog: Locator, name: string) {
  const input = dialog.getByLabel('新文件夹名称', { exact: true });
  if (!await input.isVisible()) await dialog.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await input.fill(name);
  return dialog.getByRole('button', { name: '在远端新建目录', exact: true });
}
async function createFolder(dialog: Locator, name: string) {
  await (await folderDraft(dialog, name)).click();
}
async function closePicker(page: Page) {
  await page.getByRole('dialog', { name: '选择远程文件夹' }).getByRole('button', { name: '取消', exact: true }).click();
}
async function switchHost(page: Page, name: RegExp) {
  await page.locator('.sidebar-host').getByRole('button', { name: /运行位置/ }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

test('the picker browses folders with breadcrumbs, filter, keyboard and a typed path', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByRole('navigation', { name: '当前位置' })).toContainText('fixture');
  await expect(dialog.getByRole('navigation', { name: '当前位置' })).toContainText('key');
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key');
  // Selecting a row chooses it; the footer always says which folder will be used.
  await folders(dialog).getByRole('option', { name: 'child' }).click();
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key/child');
  // Double-click opens a folder; the breadcrumb goes back up.
  await folders(dialog).getByRole('option', { name: 'child' }).dblclick();
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key/child');
  await expect(dialog.getByRole('navigation', { name: '当前位置' }).getByRole('button', { name: 'child' })).toHaveAttribute('aria-current', 'location');
  await dialog.getByRole('button', { name: '上一级' }).click();
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key');
  // The filter narrows the list; no match says so.
  await dialog.getByRole('textbox', { name: '筛选当前文件夹' }).fill('zzz');
  await expect(folders(dialog)).toContainText('没有名称包含“zzz”的文件夹');
  await dialog.getByRole('textbox', { name: '筛选当前文件夹' }).fill('');
  // Keyboard: arrow selects, Enter opens, Backspace goes up.
  await folders(dialog).focus();
  await page.keyboard.press('ArrowDown');
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key/child');
  await folders(dialog).focus();
  await page.keyboard.press('Backspace');
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key');
  // Ctrl+L edits the path directly.
  await page.keyboard.press('Control+l');
  const path = dialog.getByRole('textbox', { name: '远程路径' });
  await expect(path).toHaveValue('/fixture/key');
  await path.fill('/manual/typed/');
  await path.press('Enter');
  await expect(dialog.locator('footer code')).toHaveText('/manual/typed');
  await dialog.getByRole('button', { name: '选择此文件夹' }).click();
  await expect(dialog).toHaveCount(0);
  const session = page.getByRole('dialog', { name: '新建工作台会话' });
  await expect(session.getByRole('button', { name: '工作目录 / 项目' })).toHaveAttribute('title', 'typed · /manual/typed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('a picked folder becomes a saved project only when the session starts, and a save failure keeps the dialog', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await folders(dialog).getByRole('option', { name: 'child' }).click();
  await dialog.getByRole('button', { name: '选择此文件夹' }).click();
  const session = page.getByRole('dialog', { name: '新建工作台会话' });
  await fixture(page, { failure: 'save_remote_project' });
  await session.locator('[data-dialog-save]').click();
  await expect(session.getByRole('alert')).toContainText('Permission denied fixture');
  await expect(session.getByRole('button', { name: '工作目录 / 项目' })).toHaveAttribute('title', 'child · /fixture/key/child');
});

test('a cancelled consumer late intent response keeps another unknown directory reachable on reopen', async ({ page }) => {
  const durable = new Map<string, any>();
  const writes: string[] = [];
  let releaseA!: () => void;
  await page.exposeFunction('__directoryBackend', async (command: string, args: any) => {
    if (command === 'list_remote_directory_receipts') return [...durable.values()].map(item => structuredClone(item));
    if (command === 'save_remote_directory_receipt') {
      durable.set(args.receipt.id, structuredClone(args.receipt));
      if (args.receipt.path === '/fixture/key/A' && args.receipt.outcome === 'pending') await new Promise<void>(resolve => { releaseA = resolve; });
      return;
    }
    writes.push(args.path);
    throw { code: 'remote_unknown', message: 'B may already exist', remote: { outcome: 'unknown' } };
  });
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await createFolder(dialog, 'A');
  await expect.poll(() => durable.size).toBe(1);
  await closePicker(page);
  dialog = await directory(page);
  await createFolder(dialog, 'B');
  let receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('B may already exist');
  releaseA();
  await expect(receipt.locator('article[data-outcome]')).toHaveCount(2);
  await expect(receipt.locator('article[data-outcome]').filter({ hasText: '/fixture/key/A' })).toContainText('创建失败');
  await closePicker(page);
  dialog = await directory(page);
  receipt = dialog.getByRole('region', { name: '目录创建结果' });
  const b = receipt.locator('article[data-outcome]').filter({ hasText: '/fixture/key/B' });
  await expect(b).toContainText('结果不确定');
  await expect(await folderDraft(dialog, 'B')).toBeDisabled();
  await expect(dialog.getByText('这个路径有待核查的创建结果')).toBeVisible();
  await b.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(b).toContainText('原路径当前是目录');
  expect(writes).toEqual(['/fixture/key/B']);
  expect([...durable.values()].find(item => item.path === '/fixture/key/B').outcome).toBe('unknown');
});

for (const outcome of ['unknown', 'pending', 'checking']) test(`directory ${outcome} receipt survives a full document restart without replay`, async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  const name = `restart-${outcome}`;
  const path = `/fixture/key/${name}`;
  await fixture(page, { createOutcome: 'unknown', ...(outcome === 'pending' ? { hold: 'create_remote_directory' } : {}) });
  await createFolder(dialog, name);
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
  let receipt = dialog.getByRole('region', { name: '目录创建结果' });
  if (outcome !== 'pending') await expect(receipt).toContainText('结果不确定');
  if (outcome === 'checking') {
    await fixture(page, { hold: 'list_remote_directories' });
    await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
    await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeDisabled();
  }
  await page.reload();
  dialog = await directory(page);
  receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await expect(receipt).toContainText('fixture@key.invalid:22');
  await expect(receipt).toContainText(path);
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeEnabled();
  await expect(await folderDraft(dialog, name)).toBeDisabled();
  await fixture(page, { failure: 'list_remote_directories' });
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('Permission denied fixture');
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeDisabled();
  await fixture(page, { failure: '' });
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('原路径当前是目录');
  expect(await page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
});

test('a still running native mkdir remains pending across WebView reload and is never replayed', async ({ page }) => {
  let stored: any;
  let active = false;
  let writes = 0;
  let finish!: () => void;
  await page.exposeFunction('__directoryBackend', async (command: string, args: any) => {
    if (command === 'list_remote_directory_receipts') return stored ? [{ ...stored, active, outcome: active ? 'pending' : stored.outcome }] : [];
    if (command === 'save_remote_directory_receipt') { stored = structuredClone(args.receipt); return; }
    active = true; writes++;
    await new Promise<void>(resolve => { finish = resolve; });
    stored = { ...stored, outcome: 'created', inspection: undefined }; active = false;
  });
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await createFolder(dialog, 'active-reload');
  await expect.poll(() => active).toBe(true);
  await page.reload();
  dialog = await directory(page);
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('正在创建原路径');
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeDisabled();
  await expect(await folderDraft(dialog, 'active-reload')).toBeDisabled();
  finish();
  await expect(receipt).toContainText('远端目录已创建');
  expect(writes).toBe(1);
});

test('receipt storage failures block dispatch and can recover without losing the draft', async ({ page }) => {
  await install(page); await page.goto('/');
  await fixture(page, { failure: 'list_remote_directory_receipts' });
  const dialog = await directory(page);
  await expect(dialog.getByRole('status').filter({ hasText: 'Permission denied fixture' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '新建文件夹', exact: true })).toBeDisabled();
  await fixture(page, { failure: '' });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  const create = await folderDraft(dialog, 'storage-recovery');
  await fixture(page, { failure: 'save_remote_directory_receipt' });
  await create.click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Permission denied fixture' })).toBeVisible();
  expect(await page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(0);
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('storage-recovery');
  await fixture(page, { failure: '' });
  await create.click();
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
  await expect(folders(dialog).getByRole('option', { name: 'storage-recovery' })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
});

test('an outcome persistence failure after dispatch retains an inspectable fault across restart', async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await createFolder(dialog, 'outcome-storage-failed');
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
  await fixture(page, { hold: '', failure: 'save_remote_directory_receipt', release: true });
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('结果不确定');
  await page.reload();
  dialog = await directory(page);
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeEnabled();
  await expect(await folderDraft(dialog, 'outcome-storage-failed')).toBeDisabled();
  expect(await page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
});

test('restarted unknown receipt refuses a revised host before any inspection read', async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await fixture(page, { createOutcome: 'unknown' });
  await createFolder(dialog, 'revised-restart');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('结果不确定');
  await page.evaluate(() => (window as any).__remoteFixture.replaceHost());
  await page.reload();
  dialog = await directory(page);
  await expect(folders(dialog)).toContainText('child');
  const before = await page.evaluate(() => (window as any).__remoteFixture.reads.length);
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('原主机连接信息已变化或已移除');
  await expect(receipt).toContainText('fixture@key.invalid:22');
  expect(await page.evaluate(() => (window as any).__remoteFixture.reads.length)).toBe(before);
  expect(await page.evaluate(() => Number(localStorage.getItem('fixture:mkdir-count')))).toBe(1);
});

test('password hosts browse, refresh and create without dropping a typed folder name', async ({ page }) => {
  await install(page); await page.goto('/');
  await switchHost(page, /password fixture/);
  const dialog = await directory(page);
  await expect(dialog).toContainText('fixture@password.invalid');
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await folderDraft(dialog, 'new');
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('new');
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('/fixture/password/new');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
  await expect(folders(dialog).getByRole('option', { name: 'new' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('footer code')).toHaveText('/fixture/password/new');
});

test('late read and create results cannot replace the folder being browsed, and cancel frees a read', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'list_remote_directories' });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await folders(dialog).getByRole('option', { name: 'child' }).dblclick();
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key/child');
  await dialog.getByRole('button', { name: '取消当前操作' }).click();
  await expect(dialog.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __remoteFixture: { cancelled: number } }).__remoteFixture.cancelled)).toBeGreaterThan(0);
  await fixture(page, { hold: '', release: true });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'create_remote_directory' });
  await createFolder(dialog, 'late');
  await dialog.getByRole('button', { name: '上一级' }).click();
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('/fixture/key/child/late');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key');
});

test('directory permission and create failures keep the folder name and the last good listing', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { failure: 'list_remote_directories' });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Permission denied fixture' })).toBeVisible();
  await expect(dialog).toContainText('上次');
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { failure: 'create_remote_directory' });
  await createFolder(dialog, 'refused');
  await expect(dialog.getByRole('region', { name: '目录创建结果' }).locator('article').filter({ hasText: '/fixture/key/refused' })).toContainText('Permission denied fixture');
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('refused');
});

test('warm directory reopening does not reissue a fresh read', async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  const count = () => page.evaluate(() => (window as unknown as { __remoteFixture: { reads: string[] } }).__remoteFixture.reads.filter(key => key === 'host-0:/fixture/key').length);
  const before = await count();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  expect(await count()).toBe(before);
});

for (const response of ['empty', 'invalid', 'truncated', 'missing']) test(`directory ${response} response remains distinct and a typed path stays usable`, async ({ page }) => {
  await install(page); await page.goto('/');
  await fixture(page, { response });
  const dialog = await directory(page);
  if (response === 'invalid') {
    await expect(dialog.getByRole('status').filter({ hasText: '目录响应无效' })).toBeVisible();
    await expect(dialog).not.toContainText('上次成功读取');
  }
  if (response === 'empty') await expect(folders(dialog)).toContainText('没有可显示的子目录');
  if (response === 'truncated') await expect(dialog).toContainText('仅显示前 200 个目录');
  if (response === 'missing') {
    await expect(dialog.getByRole('status').filter({ hasText: '/fixture/key 不存在或已被移除' })).toBeVisible();
    // A folder that does not exist cannot be chosen until another one is opened.
    await expect(dialog.getByRole('button', { name: '选择此文件夹' })).toBeDisabled();
    await fixture(page, { response: '' });
  }
  await dialog.getByRole('button', { name: '输入路径' }).click();
  await dialog.getByRole('textbox', { name: '远程路径' }).fill('/manual/unverified');
  await dialog.getByRole('textbox', { name: '远程路径' }).press('Enter');
  await expect(dialog.locator('footer code')).toHaveText('/manual/unverified');
  await expect(dialog.getByRole('button', { name: '选择此文件夹' })).toBeEnabled();
});

test('replacing the same host identity clears folders and keeps a new-folder draft', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await folderDraft(dialog, 'typed-draft');
  await fixture(page, { hold: 'list_remote_directories' });
  await page.evaluate(() => (window as unknown as { __remoteFixture: { replaceHost: () => void } }).__remoteFixture.replaceHost());
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toHaveCount(0);
  await fixture(page, { hold: '', release: true });
  await expect(folders(dialog).getByRole('option', { name: 'replacement-child' })).toBeVisible();
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('typed-draft');
});

test('a late create success keeps a folder name typed after submitting', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'create_remote_directory' });
  await createFolder(dialog, 'created');
  await dialog.getByLabel('新文件夹名称', { exact: true }).fill('subsequent');
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('/fixture/key/created');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('subsequent');
  await expect(dialog.locator('footer code')).toHaveText('/fixture/key');
});

test('cancelling an unknown creation keeps its receipt and blocks the same name', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await createFolder(dialog, 'create-receipt-lost');
  await dialog.getByRole('button', { name: '取消当前操作', exact: true }).click();
  await fixture(page, { hold: '', release: true });
  const receipt = dialog.getByRole('region', { name: '目录创建结果', exact: true });
  await expect(receipt).toContainText('结果不确定');
  await expect(receipt).toContainText('key fixture');
  await expect(receipt).toContainText('/fixture/key/create-receipt-lost');
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('新文件夹名称', { exact: true })).toHaveValue('create-receipt-lost');
});

test('unknown creation inspection reads only the original host and path while another host stays usable', async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await createFolder(dialog, 'uncertain');
  await closePicker(page);
  await page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('button', { name: '关闭', exact: true }).click();
  await switchHost(page, /password fixture/);
  dialog = await directory(page);
  await fixture(page, { hold: '', release: true });
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await expect(receipt).toContainText('fixture@key.invalid:22');
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('原路径当前是目录；仅确认当前状态，不能证明由本次创建。');
  await expect(receipt).toContainText('结果不确定');
  const state = await page.evaluate(() => {
    const state = (window as unknown as { __remoteFixture: { readOperations: unknown[]; writes: string[] } }).__remoteFixture;
    return { last: state.readOperations.at(-1), writes: state.writes };
  });
  expect(state.last).toMatchObject({ targetId: 'host-0', parent: '/fixture/key/uncertain', operation: { targetRevision: 1, refresh: true, kind: 'read' } });
  expect(state.writes).toEqual(['/fixture/key/uncertain']);
  // The same folder name on another host is a different path.
  await expect(await folderDraft(dialog, 'uncertain')).toBeEnabled();
});

for (const inspection of ['missing', 'permission']) test(`unknown receipt ${inspection} inspection preserves the outcome and gates explicit retry`, async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { createOutcome: 'unknown' });
  await createFolder(dialog, 'uncertain');
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await fixture(page, inspection === 'missing' ? { response: 'missing' } : { failure: 'list_remote_directories' });
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText(inspection === 'missing' ? '原路径当前不存在' : 'Permission denied fixture');
  await expect(receipt).toContainText('结果不确定');
  const create = dialog.getByRole('button', { name: '在远端新建目录', exact: true });
  if (inspection === 'missing') await expect(create).toBeEnabled();
  else await expect(create).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { __remoteFixture: { writes: string[] } }).__remoteFixture.writes.length)).toBe(1);
});

test('a dispatched creation receipt survives closing and reopening its consumer', async ({ page }) => {
  await install(page); await page.goto('/');
  let dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await createFolder(dialog, 'closed-unknown');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('button', { name: '关闭', exact: true }).click();
  await fixture(page, { hold: '', release: true });
  dialog = await directory(page);
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('/fixture/key/closed-unknown');
  await expect(receipt).toContainText('结果不确定');
  await expect(await folderDraft(dialog, 'closed-unknown')).toBeDisabled();
});

test('inspection refuses a replaced host identity while preserving the original receipt', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(folders(dialog).getByRole('option', { name: 'child' })).toBeVisible();
  await fixture(page, { createOutcome: 'unknown' });
  await createFolder(dialog, 'old-identity');
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await page.evaluate(() => (window as unknown as { __remoteFixture: { replaceHost: () => void } }).__remoteFixture.replaceHost());
  await expect(folders(dialog).getByRole('option', { name: 'replacement-child' })).toBeVisible();
  const reads = () => page.evaluate(() => (window as unknown as { __remoteFixture: { reads: string[] } }).__remoteFixture.reads.length);
  const before = await reads();
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('原主机连接信息已变化或已移除');
  await expect(receipt).toContainText('fixture@key.invalid:22');
  expect(await reads()).toBe(before);
});

async function hosts(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '管理主机', exact: true }).click();
  return page.getByRole('region', { name: '远程主机', exact: true });
}

test('a name-only host save keeps its connection revision and remains renamed after re-entering settings', async ({ page }) => {
  await install(page); await page.goto('/');
  const panel = await hosts(page);
  await panel.getByRole('button', { name: '编辑 key fixture', exact: true }).click();
  const form = page.getByRole('form', { name: '编辑主机', exact: true });
  await form.getByLabel('显示名称', { exact: true }).fill('renamed fixture');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByRole('button', { name: '编辑 renamed fixture', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar-host').getByRole('button', { name: '运行位置：renamed fixture' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__remoteFixture.savedRevision)).toBe(1);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '编辑 renamed fixture', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '编辑 renamed fixture', exact: true }).click();
  await expect(form.getByLabel('显示名称', { exact: true })).toHaveValue('renamed fixture');
  await expect(form.getByLabel(/^主机地址/)).toHaveValue('key.invalid');
});

test('host testing belongs to a cancellable draft revision and failures preserve input', async ({ page }) => {
  await install(page); await page.goto('/');
  const panel = await hosts(page);
  await panel.getByRole('button', { name: '编辑 key fixture', exact: true }).click();
  const form = page.getByRole('form', { name: '编辑主机', exact: true });
  await fixture(page, { hold: 'test_remote_target' });
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await form.getByLabel(/^主机地址/).fill('new.invalid');
  await expect(form.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await fixture(page, { hold: '', release: true });
  await expect(form.getByRole('status')).toHaveCount(0);
  await fixture(page, { failure: 'test_remote_target' });
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Permission denied fixture');
  await expect(form.getByLabel(/^主机地址/)).toHaveValue('new.invalid');
  await fixture(page, { failure: '', hold: 'test_remote_target' });
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await form.getByRole('button', { name: '取消测试', exact: true }).click();
  await expect(form.getByRole('status')).toHaveCount(0);
  await fixture(page, { hold: '', release: true });
  await expect(form.getByRole('status')).toHaveCount(0);
});

test('invalid host fields and save failure keep the entire host draft', async ({ page }) => {
  await install(page); await page.goto('/');
  const panel = await hosts(page);
  await panel.getByRole('button', { name: '添加主机', exact: true }).click();
  const form = page.getByRole('form', { name: '添加远程主机', exact: true });
  await form.getByLabel(/^主机地址/).fill('bad/path');
  await form.getByLabel(/^端口/).fill('0');
  await form.getByLabel(/^用户名/).fill('bad user');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByLabel(/^主机地址/)).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel(/^端口/)).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel(/^用户名/)).toHaveAttribute('aria-invalid', 'true');
  await form.getByLabel(/^主机地址/).fill('valid.invalid');
  await form.getByLabel(/^端口/).fill('2222');
  await form.getByLabel(/^用户名/).fill('fixture');
  await form.locator('input[type=password]').fill('synthetic-only');
  await fixture(page, { failure: 'save_remote_target' });
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Permission denied fixture');
  await expect(form.locator('input[type=password]')).toHaveValue('synthetic-only');
  await expect(form.getByLabel(/^端口/)).toHaveValue('2222');
});
