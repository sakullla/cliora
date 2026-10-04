import { expect, test } from '@playwright/test';

for (const terminal of ['auto', 'mac_terminal', 'cmd']) {
  const program = terminal === 'cmd' ? 'C:/Program Files/Tabby/Tabby.exe' : '/Applications/Tabby.app/Contents/MacOS/Tabby';
  test(`${terminal === 'cmd' ? 'Windows' : 'macOS'} can switch from Tabby to ${terminal} while retaining its saved command`, async ({ page }) => {
    await page.addInitScript(({ terminal, program }) => {
      const tabby = { id: 'tabby', label: 'Tabby', program, args: ['run', '/bin/sh', '{script}'] };
      const settings = JSON.parse(sessionStorage.getItem('test.launch') ?? 'null') ?? {
        selected: 'custom', custom: { program: tabby.program, args: tabby.args }, presets: [tabby],
        terminals: [{ id: 'auto', label: '系统默认', available: true }, terminal === 'cmd' ? { id: 'cmd', label: 'CMD（命令提示符）', available: true } : { id: 'mac_terminal', label: 'Terminal', available: true }],
        cliMode: 'normal', projectMode: 'normal',
      };
      const control = { settings, failSave: false };
      const save = () => { sessionStorage.setItem('test.launch', JSON.stringify(settings)); return { ...settings }; };
      Object.assign(window, {
        isTauri: true, __terminalTest: control,
        __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme: 'light' }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
          if (command === 'get_tray_status') return { available: true, error: null };
          if (command === 'get_launch_settings') return { ...settings };
          if (command === 'set_preferred_terminal') {
            if (control.failSave) throw { message: '终端设置保存失败' };
            settings.selected = args.terminal;
            // The native backend preserves custom_terminal when preferred_terminal changes.
            return save();
          }
          if (command === 'set_custom_terminal') {
            settings.selected = 'custom'; settings.custom = { program: args.program, args: args.args }; return save();
          }
          if (command === 'set_default_launch_mode') { settings[args.target === 'cli' ? 'cliMode' : 'projectMode'] = args.mode; return save(); }
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        } },
      });
    }, { terminal, program });
    await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
    const select = page.getByRole('combobox', { name: '启动终端', exact: true });
    await expect(select).toHaveValue('preset:tabby');
    await select.selectOption(terminal);
    await expect(select).toHaveValue(terminal);
    expect(await page.evaluate(() => {
      const { settings } = (window as any).__terminalTest;
      return { selected: settings.selected, program: settings.custom.program };
    })).toEqual({ selected: terminal, program });
    await page.getByRole('combobox', { name: 'CLI 默认启动模式' }).selectOption('yolo');
    await expect(select).toHaveValue(terminal);
    await page.reload();
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
    await expect(select).toHaveValue(terminal);
    await select.selectOption('preset:tabby');
    await expect(select).toHaveValue('preset:tabby');
    await page.evaluate(() => { (window as any).__terminalTest.failSave = true; });
    await select.selectOption(terminal);
    await expect(page.getByRole('region', { name: '外部终端' }).getByRole('alert')).toContainText('终端设置保存失败');
    await expect(select).toHaveValue('preset:tabby');
  });
}
