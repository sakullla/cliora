import { expect, test, type Page } from '@playwright/test';

async function install(page: Page) {
  await page.addInitScript(() => {
    const targets = ['key', 'password'].map((authMethod, index) => ({ id: `host-${index}`, name: `${authMethod} fixture`, host: `${authMethod}.invalid`, port: 22, user: 'fixture', authMethod, defaultPath: `/fixture/${authMethod}`, enabled: true, createdAt: 1, updatedAt: 1 }));
    const state = { hold: '', failure: '', response: '', createOutcome: '', generation: '', replaceHost: () => {}, reads: [] as string[], readOperations: [] as unknown[], cancelled: 0, writes: [] as string[], release: () => {}, releases: [] as Array<() => void> };
    state.replaceHost = () => { targets[0].updatedAt++; targets[0].host = 'replacement.invalid'; state.generation = 'replacement-'; window.dispatchEvent(new Event('cliora:remote-targets-changed')); };
    localStorage.setItem('cliora:remote-target', 'host-0');
    const descriptor = { id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal', launch: { state: 'available', reason: '' } };
    Object.assign(window, {
      isTauri: true, __remoteFixture: state,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: true }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [descriptor], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_remote_targets') return targets.map(item => ({ ...item }));
          if (command === 'list_remote_saved_passwords') return ['host-1'];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'cancel_remote_operation') { state.cancelled++; return true; }
          if (command === 'list_remote_directories') { state.reads.push(`${args.targetId}:${args.parent}`); state.readOperations.push(args); }
          if (command === 'create_remote_directory') state.writes.push(String(args.path));
          if (command === state.hold) await new Promise<void>(resolve => { state.releases.push(resolve); state.release = () => { for (const release of state.releases.splice(0)) release(); }; });
          if (command === 'create_remote_directory' && state.createOutcome === 'unknown') throw { code: 'remote_unknown', message: 'remote may have created directory', action: '核查远端原路径后再操作。', remote: { outcome: 'unknown', action: '核查远端原路径后再操作。' } };
          if (command === state.failure) throw { message: 'Permission denied fixture', action: '检查远端权限。', remote: { reason: 'permission' } };
          if (command === 'list_remote_directories' && state.response === 'missing') throw { message: 'Directory does not exist', remote: { reason: 'directory_missing' } };
          if (command === 'list_remote_directories') return state.response === 'invalid' ? [] : { parent: args.parent, items: state.response === 'empty' ? [] : [`${args.parent}/${state.generation}child`, ...state.writes], truncated: state.response === 'truncated' };
          if (command === 'test_remote_target') return { reachable: true, system: 'Linux fixture' };
          if (command === 'save_remote_target') return { ...(args.target as object), id: 'saved-host', updatedAt: 2 };
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
async function directory(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '新建会话' }).click();
  return page.getByRole('dialog', { name: '选择远程目录' });
}
async function hosts(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '管理主机', exact: true }).click();
  return page.getByRole('region', { name: '远程主机', exact: true });
}

test('password directories can browse, refresh and create without rewriting a typed path', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await dialog.locator('select').first().selectOption('host-1');
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/password/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/password/new');
  await dialog.getByLabel('项目名称', { exact: true }).fill('保留名称');
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/fixture/password/new');
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('远端目录已创建');
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/password/new');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('保留名称');
  await expect(dialog).toContainText('保存项目不代表已验证路径');
});

test('refresh and create late results cannot replace another host and cancel frees a read', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await fixture(page, { hold: 'list_remote_directories' });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await dialog.locator('select').first().selectOption('host-1');
  await expect(dialog.getByLabel('已有目录')).not.toContainText('/fixture/key/child');
  await dialog.getByRole('button', { name: '取消当前操作' }).click();
  await expect(dialog.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __remoteFixture: { cancelled: number } }).__remoteFixture.cancelled)).toBeGreaterThan(0);
  await fixture(page, { hold: '', release: true });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/password/child');
  await fixture(page, { hold: 'create_remote_directory' });
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/password/new');
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.locator('select').first().selectOption('host-0');
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/fixture/key');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('/fixture/password/new');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
});

test('directory permission and create failure retain paths, names and stale successful content', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/refused');
  await dialog.getByLabel('项目名称', { exact: true }).fill('保留名称');
  await fixture(page, { failure: 'list_remote_directories' });
  await dialog.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Permission denied fixture' })).toBeVisible();
  await expect(dialog).toContainText('上次');
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await fixture(page, { failure: 'create_remote_directory' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Permission denied fixture' })).toBeVisible();
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/fixture/key/refused');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('保留名称');
});

test('warm directory reopening does not reissue a fresh read', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  const count = () => page.evaluate(() => (window as unknown as { __remoteFixture: { reads: string[] } }).__remoteFixture.reads.filter(key => key === 'host-0:/fixture/key').length);
  const before = await count();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '新建会话' }).click();
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  expect(await count()).toBe(before);
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

for (const response of ['empty', 'invalid', 'truncated']) test(`directory ${response} response remains distinct and manual paths stay editable`, async ({ page }) => {
  await install(page); await page.goto('/');
  await fixture(page, { response });
  const dialog = await directory(page);
  if (response === 'invalid') {
    await expect(dialog.getByRole('status')).toContainText('目录响应无效');
    await expect(dialog).not.toContainText('上次成功读取');
  }
  if (response === 'empty') await expect(dialog.getByLabel('已有目录')).toContainText('没有可显示的子目录');
  if (response === 'truncated') await expect(dialog).toContainText('仅显示前 200 个目录');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/manual/unverified');
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/manual/unverified');
  await expect(dialog.getByRole('button', { name: '继续启动', exact: true })).toBeEnabled();
});

test('replacing the same host identity clears directories and preserves the editable project draft', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/typed/path');
  await fixture(page, { hold: 'list_remote_directories' });
  await page.evaluate(() => (window as unknown as { __remoteFixture: { replaceHost: () => void } }).__remoteFixture.replaceHost());
  await expect(dialog.getByLabel('已有目录')).not.toContainText('/fixture/key/child');
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/replacement-child');
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/typed/path');
});

test('creating a directory cannot overwrite subsequent path edits with late success', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/created');
  await fixture(page, { hold: 'create_remote_directory' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.getByLabel('远程路径', { exact: true }).fill('/subsequent/draft');
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByRole('button', { name: '刷新目录', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('/fixture/key/created');
  await expect(dialog.getByRole('region', { name: '目录创建结果' })).toContainText('远端目录已创建');
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/subsequent/draft');
});


test('directory save blocks repeated Escape and retains the submitted draft after failure', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/typed/save-path');
  await dialog.getByLabel('项目名称', { exact: true }).fill('保存失败后保留');
  await fixture(page, { hold: 'save_remote_project', failure: 'save_remote_project' });
  await dialog.getByRole('button', { name: '继续启动', exact: true }).click();
  await expect(dialog.getByLabel('远程路径', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await fixture(page, { hold: '', release: true });
  await expect(dialog.getByRole('status')).toContainText('Permission denied fixture');
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/typed/save-path');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('保存失败后保留');
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
});


test('unknown directory creation receipt survives editing only the project name', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/create-receipt-lost');
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.getByLabel('项目名称', { exact: true }).fill('新名称草稿');
  await dialog.getByRole('button', { name: '取消当前操作', exact: true }).click();
  await fixture(page, { hold: '', release: true });
  const receipt = dialog.getByRole('region', { name: '目录创建结果', exact: true });
  await expect(receipt).toContainText('结果不确定');
  await expect(receipt).toContainText('key fixture');
  await expect(receipt).toContainText('/fixture/key/create-receipt-lost');
  await expect(receipt.getByRole('button', { name: '核查原路径', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('新名称草稿');
});


test('unknown creation inspection reads only the original host and path while another draft stays editable', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/uncertain');
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.locator('select').first().selectOption('host-1');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/password/new-draft');
  await dialog.getByLabel('项目名称', { exact: true }).fill('另一主机草稿');
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
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/fixture/password/new-draft');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('另一主机草稿');
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeEnabled();
  await dialog.locator('select').first().selectOption('host-0');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/uncertain');
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeDisabled();
});

for (const inspection of ['missing', 'permission']) test(`unknown receipt ${inspection} inspection preserves the outcome and gates explicit retry`, async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/uncertain');
  await fixture(page, { createOutcome: 'unknown' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
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

test('late failed creation keeps its original path while edited path and name survive', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/refused');
  await fixture(page, { hold: 'create_remote_directory', failure: 'create_remote_directory' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.getByLabel('远程路径', { exact: true }).fill('/another/draft');
  await dialog.getByLabel('项目名称', { exact: true }).fill('失败后草稿');
  await fixture(page, { hold: '', release: true });
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('/fixture/key/refused');
  await expect(receipt).toContainText('Permission denied fixture');
  await expect(dialog.getByLabel('远程路径', { exact: true })).toHaveValue('/another/draft');
  await expect(dialog.getByLabel('项目名称', { exact: true })).toHaveValue('失败后草稿');
});

test('a dispatched creation receipt survives closing and reopening its consumer', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/closed-unknown');
  await fixture(page, { hold: 'create_remote_directory', createOutcome: 'unknown' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog', { name: '新建工作台会话' }).getByRole('button', { name: '关闭', exact: true }).click();
  await fixture(page, { hold: '', release: true });
  await page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '新建会话' }).click();
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('/fixture/key/closed-unknown');
  await expect(receipt).toContainText('结果不确定');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/closed-unknown');
  await expect(dialog.getByRole('button', { name: '在远端新建目录', exact: true })).toBeDisabled();
});

test('inspection refuses a replaced host identity while preserving the original receipt', async ({ page }) => {
  await install(page); await page.goto('/');
  const dialog = await directory(page);
  await expect(dialog.getByLabel('已有目录')).toContainText('/fixture/key/child');
  await dialog.getByLabel('远程路径', { exact: true }).fill('/fixture/key/old-identity');
  await fixture(page, { createOutcome: 'unknown' });
  await dialog.getByRole('button', { name: '在远端新建目录', exact: true }).click();
  const receipt = dialog.getByRole('region', { name: '目录创建结果' });
  await expect(receipt).toContainText('结果不确定');
  await page.evaluate(() => (window as unknown as { __remoteFixture: { replaceHost: () => void } }).__remoteFixture.replaceHost());
  await expect(dialog.getByLabel('已有目录')).toContainText('replacement-child');
  const reads = () => page.evaluate(() => (window as unknown as { __remoteFixture: { reads: string[] } }).__remoteFixture.reads.length);
  const before = await reads();
  await receipt.getByRole('button', { name: '核查原路径', exact: true }).click();
  await expect(receipt).toContainText('原主机连接信息已变化或已移除');
  await expect(receipt).toContainText('fixture@key.invalid:22');
  expect(await reads()).toBe(before);
});
