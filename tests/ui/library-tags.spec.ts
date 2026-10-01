import { expect, test } from '@playwright/test';

test('library category is edited and filtered as tags', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [{ id: 'rule-1', kind: 'rule', title: '已有规则', body: '正文', category: '开发,写作', projectId: null, version: 1, updatedAt: 1 }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (command === 'save_library_item') {
            const draft = args.draft;
            const item = { ...draft, id: draft.id ?? `item-${library.length + 1}`, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 1, projectId: draft.projectId ?? null };
            const index = library.findIndex((old) => old.id === item.id);
            if (index < 0) library.push(item); else library[index] = item;
            return item;
          }
          if (command === 'read_native_rule') return { text: '', path: '' };
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: '长期规则' }).click();
  await expect(page.getByText('开发 · 写作')).toBeVisible();
  await page.getByRole('button', { name: '＋ 新建规则' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('标题')).toBeVisible();
  await expect(dialog.getByLabel('分类')).toHaveCount(0);
  await dialog.getByRole('button', { name: '开发' }).click();
  await dialog.getByLabel('添加标签').fill('文档');
  await dialog.getByLabel('添加标签').press('Enter');
  await expect(dialog.getByRole('button', { name: '开发 ×' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '文档 ×' })).toBeVisible();
  await dialog.getByRole('button', { name: '开发 ×' }).click();
  await expect(dialog.getByRole('button', { name: '开发 ×' })).toHaveCount(0);
  await dialog.getByLabel('标题').fill('发布检查');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByRole('heading', { name: '修改规则' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '文档 ×' })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发布检查' })).toBeVisible();
  await expect(page.getByText('文档 · 全局')).toBeVisible();
  await page.getByLabel('标签筛选').selectOption('写作');
  await expect(page.getByRole('button', { name: '已有规则' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发布检查' })).toHaveCount(0);
});
