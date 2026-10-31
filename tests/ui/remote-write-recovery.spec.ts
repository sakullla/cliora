import { expect, test, type Page } from '@playwright/test';

async function install(page: Page, revision = 1, mode = 'unknown') {
  await page.addInitScript(({ revision, mode }) => {
    const host = { id: 'recovery-host', name: '恢复主机', host: 'fixture.invalid', port: 22, user: 'fixture', authMethod: 'key', enabled: true, updatedAt: revision, createdAt: 1 };
    const receipt = { id: '7ae443eb-0ac1-4d44-b720-2e519f8f9665', targetId: host.id, targetRevision: 1, identity: 'fixture', outcome: 'committing', items: [
      { path: '$HOME/.cliora/store.json', state: 'committed', before: 'a'.repeat(64), after: 'b'.repeat(64), observed: null },
      { path: '$HOME/.fixture/config.json', state: 'applying', before: 'c'.repeat(64), after: 'd'.repeat(64), observed: null },
    ] };
    if (mode === 'historical') { receipt.outcome = 'committed'; receipt.items.forEach(item => { item.state = 'committed'; }); }
    if (mode === 'recovering') receipt.outcome = 'recovering';
    localStorage.setItem('cliora:remote-target', host.id);
    if (!localStorage.getItem('cliora:remote-writes:v1')) localStorage.setItem('cliora:remote-writes:v1', JSON.stringify([receipt]));
    const state = { inspections: 0, restores: 0, after: false, fallback: false };
    Object.assign(window, { isTauri: true, __recoveryState: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { managed_tools: [], theme: 'light', remote_ssh_enabled: true }, tools: [] };
        if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
        if (command === 'list_remote_targets') return [host];
        if (command === 'list_remote_write_receipts') return [];
        if (command === 'inspect_remote_write') {
          state.fallback = args.receipt?.id === receipt.id;
          if (args.rollback) { state.restores++; return { ...receipt, outcome: 'recovery_required', items: receipt.items.map((item, index) => ({ ...item, state: index ? 'conflict' : 'rollback_failed', observed: index ? 'conflict' : 'after' })) }; }
          state.inspections++;
          return { ...receipt, outcome: mode === 'historical' || state.after ? 'committed' : 'recovery_required', items: receipt.items.map((item, index) => ({ ...item, observed: mode === 'historical' ? 'conflict' : state.after || index === 0 ? 'after' : 'before' })) };
        }
        if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        return [];
      },
    } });
  }, { revision, mode });
}

test('historical completed receipts show later file changes without reopening a blocking write or allowing overwrite', async ({ page }) => {
  await install(page, 1, 'historical'); await page.goto('/');
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
});
