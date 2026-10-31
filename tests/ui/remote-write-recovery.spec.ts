import { expect, test, type Page } from '@playwright/test';

async function install(page: Page, revision = 1, mode = 'unknown', session = false) {
  await page.addInitScript(({ revision, mode, session }) => {
    const host = { id: 'recovery-host', name: '恢复主机', host: 'fixture.invalid', port: 22, user: 'fixture', authMethod: 'key', enabled: true, updatedAt: revision, createdAt: 1 };
    const receipt = { id: '7ae443eb-0ac1-4d44-b720-2e519f8f9665', targetId: host.id, targetRevision: 1, identity: 'fixture', outcome: 'committing', items: [
      { path: '$HOME/.cliora/store.json', state: 'committed', before: 'a'.repeat(64), after: 'b'.repeat(64), observed: null },
      { path: '$HOME/.fixture/config.json', state: 'applying', before: 'c'.repeat(64), after: 'd'.repeat(64), observed: null },
    ] };
    if (['committed', 'rolled_back', 'prepare_failed', 'conflict_before_commit'].includes(mode)) receipt.outcome = mode;
    if (mode === 'recovering') receipt.outcome = 'recovering';
    localStorage.setItem('cliora:remote-target', host.id);
    if (!localStorage.getItem('cliora:remote-writes:v1')) localStorage.setItem('cliora:remote-writes:v1', JSON.stringify(mode === 'empty' || mode === 'discovery-failed' ? [] : [receipt]));
    if (mode === 'discovery-failed') localStorage.setItem('cliora:remote-write-faults:v1', JSON.stringify([{ targetId: host.id, targetRevision: 1 }]));
    const state = { inspections: 0, restores: 0, after: false, fallback: false, listFails: mode === 'discovery-failed', commands: [] as string[] };
    Object.assign(window, { isTauri: true, __recoveryState: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, any> = {}) => {
        state.commands.push(command);
        if (command === 'get_bootstrap') return { preferences: { managed_tools: [], theme: 'light', remote_ssh_enabled: true }, tools: [] };
        if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
        if (command === 'list_remote_targets') return [host, { ...host, id: 'other-host', name: '另一主机' }];
        if (command === 'list_remote_projects') return [{ id: 'project', targetId: host.id, name: '远程项目', path: '/srv/project', updatedAt: 1 }];
        if (command === 'list_workbench_sessions') return session ? [{ id: 'session', toolId: 'codex', projectId: 'remote:project', directory: '/srv/project', mode: 'normal', running: false, connectionState: 'disconnected', reattachable: true, remoteSessionId: 'owned-session', exitCode: 255, startedAt: 1 }] : [];
        if (command === 'replay_workbench_session') return '';
        if (command === 'list_remote_write_receipts') { if (state.listFails) throw { message: 'fixture journal temporarily unavailable' }; return mode === 'discovery-failed' ? [receipt] : []; }
        if (command === 'inspect_remote_write') {
          state.fallback = args.receipt?.id === receipt.id;
          if (args.rollback) { state.restores++; return { ...receipt, outcome: 'recovery_required', items: receipt.items.map((item, index) => ({ ...item, state: index ? 'conflict' : 'rollback_failed', observed: index ? 'conflict' : 'after' })) }; }
          state.inspections++;
          return { ...receipt, outcome: mode === 'historical-drift' || state.after ? 'committed' : 'recovery_required', items: receipt.items.map((item, index) => ({ ...item, observed: mode === 'historical-drift' ? 'conflict' : state.after || index === 0 ? 'after' : 'before' })) };
        }
        if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        return [];
      },
    } });
  }, { revision, mode, session });
}

for (const mode of ['empty', 'committed', 'rolled_back', 'prepare_failed', 'conflict_before_commit']) {
  test(`normal remote pages with ${mode} receipts have no recovery entry or journal reads`, async ({ page }) => {
    await install(page, 1, mode); await page.goto('/');
    await expect(page.getByRole('navigation', { name: '页面' })).toBeVisible();
    await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
    await expect(page.getByRole('region', { name: '当前会话' })).toBeVisible();
    await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__recoveryState.commands.filter((name: string) => name === 'list_remote_write_receipts'))).toEqual([]);
  });
}

test('write recovery shares the existing resume controls and disappears when inspection settles the fault', async ({ page }) => {
  await install(page, 1, 'unknown', true); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: '终端操作' });
  const resume = toolbar.getByRole('button', { name: '重新附着远程会话', exact: true });
  const recovery = toolbar.getByRole('button', { name: '写入恢复', exact: true });
  await expect(recovery).toBeVisible();
  expect(await recovery.evaluate((button, resumeClass) => ({ same: button.className === resumeClass, group: button.parentElement?.querySelectorAll('button').length }), await resume.getAttribute('class'))).toEqual({ same: true, group: 2 });
  const endedResume = page.getByRole('button', { name: '继续会话', exact: true });
  const endedRecovery = endedResume.locator('..').getByRole('button', { name: '写入恢复', exact: true });
  expect(await endedRecovery.getAttribute('class')).toBe(await endedResume.getAttribute('class'));
  await page.evaluate(() => { (window as any).__recoveryState.after = true; });
  await recovery.click();
  const dialog = page.getByRole('dialog', { name: '远程写入与恢复' });
  await dialog.getByRole('button', { name: '核查实际结果' }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
  await expect(resume).toBeVisible();
});

test('closing recovery keeps a no-session fault reachable across pages and restart without affecting another host', async ({ page }) => {
  await install(page); await page.goto('/');
  const entry = page.getByRole('button', { name: '写入恢复', exact: true });
  await expect(page.locator('.error-banner').getByRole('button', { name: '写入恢复', exact: true })).toBeVisible();
  await entry.click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('region', { name: '当前会话' }).getByRole('button', { name: '写入恢复' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.locator('.error-banner').getByRole('button', { name: '写入恢复' })).toBeVisible();
  await page.reload(); await expect(entry).toBeVisible();
  await page.locator('.sidebar-host').getByRole('button').click();
  await page.getByRole('menuitemradio', { name: /另一主机/ }).click();
  await expect(entry).toHaveCount(0);
  await page.locator('.sidebar-host').getByRole('button').click();
  await page.getByRole('menuitemradio', { name: /恢复主机/ }).click();
  await expect(entry).toBeVisible();
});

test('a failed fault-triggered journal discovery survives closing and restart then discovers the original receipt', async ({ page }) => {
  await install(page, 1, 'discovery-failed'); await page.goto('/');
  const entry = page.getByRole('button', { name: '写入恢复', exact: true });
  await expect(entry).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__recoveryState.commands.filter((name: string) => name === 'list_remote_write_receipts').length)).toBe(1);
  await entry.click();
  await expect(page.getByRole('dialog').getByText('fixture journal temporarily unavailable')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await expect(entry).toBeVisible();
  await page.evaluate(() => { (window as any).__recoveryState.listFails = false; });
  await entry.click();
  await expect(page.getByRole('dialog').getByText('提交中或结果未知')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cliora:remote-write-faults:v1')!))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cliora:remote-writes:v1')!)[0].targetId)).toBe('recovery-host');
});

test('receipt-less discovery cannot use a changed host revision', async ({ page }) => {
  await install(page, 2, 'discovery-failed'); await page.goto('/');
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/不能向当前地址恢复/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryState.commands.filter((name: string) => name === 'list_remote_write_receipts'))).toEqual([]);
});

test('historical completed receipts show later file changes without reopening a blocking write or allowing overwrite', async ({ page }) => {
  await install(page, 1, 'historical-drift'); await page.goto('/');
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '核查实际结果' }).click();
  await expect(dialog.getByText('已确认提交', { exact: true })).toBeVisible();
  await expect(dialog.getByText('当前文件已被后续修改。此回执的完成状态保留，历史备份不能覆盖这些修改。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '恢复写入前备份' })).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cliora:remote-writes:v1')!)[0].outcome)).toBe('committed');
  expect(await page.evaluate(() => (window as any).__recoveryState.restores)).toBe(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('存在未确认的远程写入，请先核查回执，保留草稿并勿直接重试。')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
});

test('a durable restoring outcome remains visibly unresolved after restart', async ({ page }) => {
  await install(page, 1, 'recovering'); await page.goto('/');
  await expect(page.getByText('存在未确认的远程写入，请先核查回执，保留草稿并勿直接重试。')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('恢复中或结果未知')).toBeVisible();
});

test('unknown receipts survive restart, inspect actual files, and retain failed recovery evidence', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('提交中或结果未知')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '恢复写入前备份' })).toBeDisabled();
  await page.reload();
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  await dialog.getByRole('button', { name: '核查实际结果' }).click();
  await expect(dialog.getByText('实际为提交后版本', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryState.fallback)).toBe(true);
  await dialog.getByRole('button', { name: '恢复写入前备份' }).click();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect(dialog.getByText('恢复失败，备份保留', { exact: false })).toBeVisible();
  await expect(dialog.getByText('实际版本发生冲突', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryState.restores)).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  await expect(dialog.getByText('恢复失败，备份保留', { exact: false })).toBeVisible();
});

test('a changed host revision disables inspection and recovery', async ({ page }) => {
  await install(page, 2);
  await page.goto('/');
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '核查实际结果' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '恢复写入前备份' })).toBeDisabled();
  await expect(dialog.getByText(/不能向当前地址恢复/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryState.inspections)).toBe(0);
});

test('inspection settles a fully committed unknown outcome without replaying its write', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__recoveryState.after = true; });
  await page.getByRole('button', { name: '写入恢复', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '核查实际结果' }).click();
  await expect(dialog.getByText('已确认提交', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__recoveryState.restores)).toBe(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('存在未确认的远程写入，请先核查回执，保留草稿并勿直接重试。')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('navigation', { name: '页面' })).toBeVisible();
  await expect(page.getByRole('button', { name: '写入恢复', exact: true })).toHaveCount(0);
});
