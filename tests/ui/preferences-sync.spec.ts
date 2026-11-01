import { expect, test } from '@playwright/test';

test('a delayed sync refresh cannot undo a newer theme choice', async ({ page }) => {
  await page.addInitScript(() => {
    let theme = 'light';
    let hold = false;
    let release: (() => void) | undefined;
    const callbacks: Array<(event: { payload: unknown }) => void> = [];
    const listeners: Record<string, number> = {};
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, language: 'zh', remote_ssh_enabled: false }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    Object.assign(window, {
      isTauri: true,
      __holdRefresh: () => { hold = true; callbacks[listeners['cliora:portable-changed']]({ payload: null }); },
      __refreshWaiting: () => !!release,
      __releaseRefresh: () => release?.(),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') {
            const snapshot = bootstrap();
            if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
            return snapshot;
          }
          if (command === 'set_theme') { theme = String(args.theme); return bootstrap(); }
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal' }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen') { listeners[String(args.event)] = Number(args.handler); return args.handler; }
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __holdRefresh: () => void }).__holdRefresh());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshWaiting: () => boolean }).__refreshWaiting())).toBe(true);
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => (window as unknown as { __releaseRefresh: () => void }).__releaseRefresh());
  // Allow the released IPC and React render to settle before checking the choice.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
