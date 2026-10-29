import { expect, test } from '@playwright/test';

// The desktop webviews can refuse navigator.clipboard (WebKit does in the macOS app); copying the full
// text still succeeds through the copy command inside the click.
test('copying a prompt still works when the clipboard API is refused', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '示例提示词', body: '第一行说明\n第二行说明', category: '示例', projectId: null, version: 1, updatedAt: 1 }];
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Not allowed', 'NotAllowedError'); } } });
    const command = document.execCommand.bind(document);
    document.execCommand = (name: string, ...rest: unknown[]) => {
      if (name === 'copy') {
        const active = document.activeElement as HTMLTextAreaElement | null;
        copied.push(active?.value?.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0) ?? '');
      }
      return command(name, ...(rest as [boolean, string]));
    };
    Object.assign(window, {
      isTauri: true, __copied: copied,
      __TAURI_INTERNALS__: {
        invoke: async (name: string, args: Record<string, any> = {}) => {
          if (name === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (name === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
          if (name === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (name === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (name === 'get_tray_status') return { available: false, error: null };
          if (name.startsWith('plugin:event|')) return 1;
          if (name.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const card = page.getByRole('article').filter({ hasText: '示例提示词' });
  await card.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect(page.getByText('复制失败', { exact: false })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['第一行说明\n第二行说明']);
});
