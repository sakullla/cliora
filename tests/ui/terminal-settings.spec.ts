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

test('English keeps the CMD-length recovery advice by error code and falls back to text', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('cliora:language', 'en'); });
  await page.addInitScript(() => {
    const tabby = { id: 'tabby', label: 'Tabby', program: '/Applications/Tabby.app/Contents/MacOS/Tabby', args: ['run', '/bin/sh', '{script}'] };
    const settings = { selected: 'custom', custom: { program: tabby.program, args: tabby.args }, presets: [tabby], terminals: [{ id: 'auto', label: 'System default', available: true }], cliMode: 'normal', projectMode: 'normal' };
    const control = { rejection: null as { code?: string; message: string } | null };
    Object.assign(window, {
      isTauri: true, __terminalCodeTest: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme: 'light' }, tools: [] };
        if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
        if (command === 'get_tray_status') return { available: true, error: null };
        if (command === 'get_launch_settings') return { ...settings };
        if (command === 'set_preferred_terminal') {
          if (control.rejection) throw control.rejection;
          settings.selected = args.terminal;
          return { ...settings };
        }
        if (command === 'set_default_launch_mode') { settings[args.target === 'cli' ? 'cliMode' : 'projectMode'] = args.mode; return { ...settings }; }
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return [];
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Launch terminal', exact: true });
  await expect(select).toHaveValue('preset:tabby');
  const alert = page.getByRole('region', { name: 'External terminal' }).getByRole('alert');
  const rejectWith = (rejection: { code?: string; message: string }) => page.evaluate((payload) => {
    (window as unknown as { __terminalCodeTest: { rejection: { code?: string; message: string } | null } }).__terminalCodeTest.rejection = payload;
  }, rejection);

  // Code-first recognition: the message keeps its own recovery advice, without the generic repick hint.
  await rejectWith({ code: 'terminal_command_too_long', message: '启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal' });
  await select.selectOption('auto');
  await expect(alert).toContainText('启动命令超过 CMD 长度限制，请在设置中选择 PowerShell 或 Windows Terminal');
  await expect(alert).not.toContainText('Choose the terminal again');
  await expect(select).toHaveValue('preset:tabby');

  // Legacy payloads without a code keep the previous text-driven presentation.
  await rejectWith({ message: '终端设置保存失败' });
  await select.selectOption('auto');
  await expect(alert).toContainText('终端设置保存失败');
  await expect(alert).toContainText('Choose the terminal again');

  // A message that already asks to re-pick the terminal is still recognized by text alone.
  await rejectWith({ message: '所选终端不可用，请在设置中重新选择终端' });
  await select.selectOption('auto');
  await expect(alert).toContainText('请在设置中重新选择终端');
  await expect(alert).not.toContainText('Choose the terminal again');
});
