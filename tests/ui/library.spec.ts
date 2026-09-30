import { expect, test, type Locator } from '@playwright/test';

async function precedes(earlier: Locator, later: Locator) {
  const laterNode = await later.elementHandle();
  expect(laterNode).toBeTruthy();
  return earlier.evaluate((node, other) => other instanceof Node && Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), laterNode);
}

test('library edit actions stay before the body and distribution waits for a clean save', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [
      { id: 'prompt-1', kind: 'prompt', title: '部署检查', body: '检查服务健康状态', category: '开发', projectId: null, version: 1, updatedAt: 1 },
      { id: 'rule-1', kind: 'rule', title: '代码风格', body: '使用短句', category: '开发', projectId: null, version: 2, updatedAt: 1 },
    ];
    const clipboard: string[] = [];
    const deleted: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboard.push(value); } } });
    Object.assign(window, {
      isTauri: true,
      __libraryClipboard: clipboard,
      __libraryDeleted: deleted,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' },
            interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind && (!args.search || `${item.title} ${item.body} ${item.category}`.toLowerCase().includes(String(args.search).toLowerCase())));
        if (command === 'save_library_item') {
          const draft = args.draft;
          const item = { ...draft, id: draft.id ?? `item-${library.length + 1}`, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 1 };
          const index = library.findIndex((old) => old.id === item.id);
          if (index < 0) library.push(item); else library[index] = item;
          return item;
        }
        if (command === 'delete_library_item') {
          deleted.push(args.id);
          const index = library.findIndex((item) => item.id === args.id);
          if (index >= 0) library.splice(index, 1);
          return null;
        }
        if (command === 'read_native_rule') return { path: 'C:\\rules.md', text: '', fingerprint: 'fp' };
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  const promptCard = library.getByRole('article').filter({ hasText: '部署检查' });
  await expect(library.locator('details')).toHaveCount(0);
  await expect(promptCard.getByRole('button', { name: '复制全文' })).toBeVisible();
  await expect(promptCard.getByRole('button', { name: '编辑 →' })).toBeVisible();
  await promptCard.getByRole('button', { name: '复制全文' }).click();
  await expect(page.getByRole('status').filter({ hasText: '完整正文已复制' })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __libraryClipboard: string[] }).__libraryClipboard)).toEqual(['检查服务健康状态']);

  await promptCard.getByRole('button', { name: '编辑 →' }).click();
  const body = page.getByRole('textbox', { name: '资料正文' });
  const copy = page.getByRole('button', { name: '复制全文', exact: true });
  const save = page.getByRole('button', { name: '保存', exact: true });
  await expect(copy).toBeVisible();
  await expect(save).toBeVisible();
  expect(await precedes(copy, body)).toBe(true);
  expect(await precedes(save, body)).toBe(true);
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toHaveCount(0);

  await body.fill('尚未保存的修改');
  await navigation.getByRole('button', { name: '快速开始' }).click();
  await navigation.getByRole('button', { name: '资料库' }).click();
  await expect(page.getByRole('textbox', { name: '资料正文' })).toHaveText('尚未保存的修改');
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已保存在本机资料库' })).toBeVisible();

  await page.getByRole('button', { name: '删除', exact: true }).click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '部署检查', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '资料正文' })).toHaveText('尚未保存的修改');
  expect(await page.evaluate(() => (window as typeof window & { __libraryDeleted: string[] }).__libraryDeleted)).toEqual([]);

  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: '删除资料', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已删除' })).toBeVisible();
  await expect(library.getByRole('article').filter({ hasText: '部署检查' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __libraryDeleted: string[] }).__libraryDeleted)).toEqual(['prompt-1']);

  await page.getByRole('tab', { name: '长期规则' }).click();
  const ruleCard = library.getByRole('article').filter({ hasText: '代码风格' });
  await expect(library.locator('details.native-rule-editor')).not.toHaveJSProperty('open', true);
  await expect(ruleCard.getByRole('button', { name: '复制全文' })).toBeVisible();
  await expect(ruleCard.getByRole('button', { name: '编辑与分发 →' })).toBeVisible();
  await ruleCard.getByRole('button', { name: '编辑与分发 →' }).click();
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toBeVisible();
  expect(await precedes(page.getByRole('button', { name: '保存', exact: true }), page.getByRole('textbox', { name: '资料正文' }))).toBe(true);
  expect(await precedes(page.getByRole('button', { name: '复制全文', exact: true }), page.getByRole('textbox', { name: '资料正文' }))).toBe(true);
  await page.getByRole('textbox', { name: '资料正文' }).fill('尚未保存的规则');
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '← 返回资料库' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '＋ 新建规则' }).click();
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '标题' }).fill('新规则');
  await page.getByRole('textbox', { name: '资料正文' }).fill('新的规则正文');
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('应用到 CLI 原生规则', { exact: true })).toBeVisible();
});
