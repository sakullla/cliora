import { expect, test } from './sharedPage';

const tools = [['codex', 'Codex', true], ['kimi_code', 'Kimi Code', true], ['mimo_code', 'MiMo Code', false], ['cline', 'Cline', false], ['devin', 'Devin', true]] as const;

test('launch buttons stay in one column whether or not a CLI is installed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript((catalog) => {
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme: 'light' }, tools: catalog.map(([id, name]) => ({ id, name })) };
      if (command === 'list_cli_adapters') return { registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'] })), managedIds: catalog.map((item) => item[0]), preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') {
        const installed = catalog.find((item) => item[0] === args.toolId)?.[2];
        return { probe: { tool: args.toolId, selectedPath: installed ? '/fixture/cli' : null, installations: installed ? [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }] : [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      }
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'list_projects') return [];
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    } } });
  }, tools);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '去安装 →' })).toHaveCount(2);
  const rows = page.locator('[data-tool-row]');
  await expect(rows.getByRole('button', { name: '启动', exact: true })).toHaveCount(3);
  await expect(rows.getByRole('button', { name: '重新检测', exact: true })).toHaveCount(2);
  const primary = rows.getByRole('button', { name: /^(启动|重新检测)$/ });
  const edges = await primary.evaluateAll((nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return `${Math.round(box.left)}-${Math.round(box.right)}`; }));
  expect(new Set(edges).size).toBe(1);
  const menus = await rows.getByRole('button', { name: /的更多操作$/ }).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
  expect(menus).toHaveLength(5);
  expect(new Set(menus).size).toBe(1);
  // Compact rows: every single-line row stays at the 40px row height.
  const heights = await rows.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  for (const height of heights) expect(height).toBeLessThanOrEqual(48);
});

test('project cards keep one launch action and home never scrolls sideways', async ({ page }) => {
  await page.addInitScript(() => {
    const catalog = [['codex', 'Codex', true], ['kimi_code', 'Kimi Code', true], ['mimo_code', 'MiMo Code', false]];
    const projects = [
      { id: 'desk', name: '栖点 · 桌面工具', path: 'C:\\Projects\\cliora', available: true, preferredTool: 'codex', lastOpened: 1790758800, modelOverrides: {}, selectedProfiles: { codex: 'daily' }, appliedProfiles: { codex: 'daily' } },
      { id: 'site', name: '个人网站', path: 'C:\\Projects\\personal-site', available: true, preferredTool: 'kimi_code', lastOpened: 1790028800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} },
    ];
    let theme = 'light';
    let remoteSshEnabled = false;
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme, remote_ssh_enabled: remoteSshEnabled }, tools: catalog.map(([id, name]) => ({ id, name })) });
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return bootstrap();
      if (command === 'set_theme') { theme = args.theme; return bootstrap(); }
      if (command === 'set_remote_ssh_enabled') { remoteSshEnabled = args.enabled; return bootstrap(); }
      if (command === 'list_cli_adapters') return { registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'] })), managedIds: catalog.map((item) => item[0]), preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') {
        const installed = catalog.find((item) => item[0] === args.toolId)?.[2];
        return { probe: { tool: args.toolId, selectedPath: installed ? '/fixture/cli' : null, installations: installed ? [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }] : [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      }
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'list_projects') return projects;
      if (command === 'plugin:dialog|open') return null;
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_')) return [];
      return null;
    } } });
  });

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  const cards = page.locator('[data-project-id]');
  await expect(cards).toHaveCount(2);
  // Continue-working is first for both sighted and sequential keyboard/screen-reader users.
  const readingOrder = await page.evaluate(() => {
    const launcher = document.querySelector('.home-launcher');
    const tools = document.querySelector('.home-tools');
    return !!launcher && !!tools && (launcher.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(readingOrder).toBe(true);
  // One primary launch per card, and equal card heights so the actions line up.
  for (const card of await cards.all()) await expect(card.locator('[data-split-variant]')).toHaveCount(1);
  const heights = await cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // A wide card puts launch beside the identity, a narrow one below it; either way launch never
  // covers the identity and ends the card, so cards in a column line their launch buttons up.
  const layout = async () => cards.evaluateAll((nodes) => nodes.map((node) => {
    const card = node.getBoundingClientRect();
    const title = node.querySelector('strong')!;
    const identity = title.closest('div')!.parentElement!.getBoundingClientRect();
    const launch = node.querySelector('[data-split-variant]')!.getBoundingClientRect();
    const clear = launch.top >= identity.bottom - 1 || launch.left >= identity.right - 1;
    return { below: clear, endGap: Math.round(card.right - launch.right), nameShown: title.clientWidth >= title.scrollWidth - 1 };
  }));
  for (const width of [1360, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = await layout();
    expect(rows.every((row) => row.below && row.nameShown)).toBe(true);
    expect(new Set(rows.map((row) => row.endGap)).size).toBe(1);
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // Both split-button halves use secondary surface at rest and gain emerald emphasis on hover.
  const expectSplitPaint = async () => {
    const split = cards.first().locator('[data-split-variant="secondary"]');
    const buttons = split.getByRole('button');
    await expect(buttons).toHaveCount(2);
    const mainButton = split.locator('[data-variant="secondary"]');
    const tokens = await split.evaluate(() => {
      const resolve = (token: string) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `var(${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      return {
        surface: resolve('--surface'),
        text: resolve('--text'),
        soft: resolve('--accent-soft'),
        accent: resolve('--accent'),
        fill: resolve('--accent-fill'),
        ink: resolve('--on-accent'),
      };
    });
    // At rest: calm secondary surface with no background-image.
    await page.mouse.move(0, 0);
    await expect.poll(() => mainButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.backgroundColor}|${style.color}`;
    })).toBe(`${tokens.surface}|${tokens.text}`);

    // On hover of the menu half: row gets emerald soft emphasis on main, and solid emerald fill on hovered half.
    await buttons.nth(1).hover();
    await expect.poll(() => mainButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.backgroundColor}|${style.color}`;
    })).toBe(`${tokens.soft}|${tokens.accent}`);
    await expect.poll(() => buttons.nth(1).evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.backgroundColor}|${style.color}`;
    })).toBe(`${tokens.fill}|${tokens.ink}`);
    const paint = await split.evaluate((element) => {
      const main = element.querySelector<HTMLElement>('[data-variant="secondary"]')!;
      const menu = element.querySelector<HTMLElement>(':scope > div:last-child > button')!;
      return {
        mainImage: getComputedStyle(main).backgroundImage,
        menuImage: getComputedStyle(menu).backgroundImage,
      };
    });
    expect(paint.mainImage).toBe('none');
    expect(paint.menuImage).toBe('none');
    await page.mouse.move(0, 0);
  };
  await expectSplitPaint();

  // The same color token drives a checked switch track; its thumb remains distinguishable.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '远程主机', exact: true }).click();
  const remoteSwitch = page.getByRole('switch').first();
  await expect(remoteSwitch).toBeVisible();
  const offTrack = await remoteSwitch.evaluate((element) => getComputedStyle(element).backgroundColor);
  await remoteSwitch.click();
  await expect(remoteSwitch).toBeChecked();
  const expectSwitchPaint = async () => {
    const fill = await remoteSwitch.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--accent-fill)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    // base.css transitions the switch track background-color over --medium; poll until the
    // transition has reached the resolved accent fill instead of reading a mid-transition color.
    await expect.poll(() => remoteSwitch.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(fill);
    const paint = await remoteSwitch.evaluate((element) => {
      const resolve = (token: string) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `var(${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      const dark = document.documentElement.dataset.theme === 'dark';
      return {
        track: getComputedStyle(element).backgroundColor,
        thumb: getComputedStyle(element, '::after').backgroundColor,
        fill: resolve('--accent-fill'),
        thumbToken: resolve(dark ? '--on-accent' : '--switch-thumb'),
      };
    });
    expect(paint.track).toBe(paint.fill);
    expect(paint.thumb).toBe(paint.thumbToken);
    expect(paint.track).not.toBe(offTrack);
    expect(paint.track).not.toBe(paint.thumb);
  };
  await expectSwitchPaint();
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: '切换主题' }).getByRole('button', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The same switch keeps its accent track in dark mode; Settings reopens on the last category.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await expectSwitchPaint();
  await page.keyboard.press('Escape');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '首页', exact: true }).click();
  await expectSplitPaint();

  // At 640 the tool rows still share one launch column and nothing spills sideways.
  await page.setViewportSize({ width: 640, height: 900 });
  const rows = page.locator('[data-tool-row]');
  await expect(rows).toHaveCount(3);
  const edges = await rows.getByRole('button', { name: /^(启动|重新检测)$/ }).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left) + '-' + Math.round(node.getBoundingClientRect().right)));
  expect(new Set(edges).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

// The reported screenshot: five remote projects on one host, Claude Code and Codex mixed, every
// card carrying both the 远程 and YOLO badges in a two-column grid. Names must stay readable and
// the picker / launch / more row must line up the same way on every card.
async function installRemoteFive(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('cliora:remote-target', 'fixture-host');
    const tools = [['claude_code', 'Claude Code'], ['codex', 'Codex']];
    const target = { id: 'fixture-host', name: 'Remote fixture', host: '192.0.2.10', port: 22, user: 'fixture', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 };
    const projects = ['website', 'admin-dashboard', 'cliora', 'documentation', 'backend'].map((name, index) => ({ id: `p${index}`, targetId: target.id, name, path: `/srv/teams/product/projects/${name}`, preferredTool: index === 2 || index === 4 ? 'codex' : 'claude_code', updatedAt: 1 }));
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((x) => x[0]), theme: 'light', remote_ssh_enabled: true }, tools: tools.map(([id, name]) => ({ id, name })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(([id, name]) => ({ id, name, interfaceFormats: [], yoloAvailable: true, launchForm: 'terminal', launch: { state: 'available', reason: '' } })), managedIds: tools.map((x) => x[0]), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [target];
          if (command === 'list_remote_projects') return projects;
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'yolo' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'probe_remote_clis') return (args.toolIds as string[]).map((toolId) => ({ targetId: target.id, toolId, executable: toolId, installed: true, version: 'fixture', detail: null }));
          if (command === 'get_remote_tool_store') return { profiles: [], common: null, currentFiles: {} };
          if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
          if (command.startsWith('plugin:event|')) return 0;
          return [];
        },
      },
    });
  });
}

test('five remote projects with mixed tools and both badges keep names and actions aligned', async ({ page }) => {
  await installRemoteFive(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const cards = page.locator('[data-project-id^="remote:"]');
  await expect(cards).toHaveCount(5);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1360, 1280, 900, 640]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await cards.evaluateAll((nodes) => nodes.map((node) => {
        const card = node.getBoundingClientRect();
        const title = node.querySelector('strong')!;
        const titleBox = title.getBoundingClientRect();
        const select = node.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')!.getBoundingClientRect();
        const split = node.querySelector('[data-split-variant]')!.getBoundingClientRect();
        const more = node.querySelector('button[aria-haspopup="menu"][aria-label$="的更多操作"]')!.getBoundingClientRect();
        const badges = [...node.querySelectorAll('[data-tone]')].map((badge) => badge.textContent);
        const inside = [...node.querySelectorAll('button, strong, [data-tone]')].every((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= card.left - 0.5 && box.right <= card.right + 0.5;
        });
        return {
          name: title.textContent,
          nameShown: title.clientWidth >= title.scrollWidth - 1 && titleBox.width > 30,
          badges,
          top: Math.round(card.top),
          launchTop: Math.round(split.top - card.top),
          launchEnd: Math.round(card.right - split.right),
          moreEnd: Math.round(card.right - more.right),
          // Launch sits beside the identity on a wide row and below it on a narrow one; never over the name.
          noOverlap: select.right <= split.left + 0.5 && split.right <= more.left + 0.5 && (split.top >= titleBox.bottom - 0.5 || split.left >= titleBox.right - 0.5),
          inside,
        };
      }));
      const label = `${theme} ${width}`;
      for (const row of rows) {
        expect(row.nameShown, `${label} ${row.name}`).toBe(true);
        expect(row.badges, `${label} ${row.name}`).toEqual(['远程', 'YOLO']);
        expect(row.noOverlap, `${label} ${row.name}`).toBe(true);
        expect(row.inside, `${label} ${row.name}`).toBe(true);
      }
      // One arrangement for every card: same launch row offset and the same end edge.
      expect(new Set(rows.map((row) => row.launchTop)).size, label).toBe(1);
      expect(new Set(rows.map((row) => row.launchEnd)).size, label).toBe(1);
      expect(new Set(rows.map((row) => row.moreEnd)).size, label).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), label).toBeLessThanOrEqual(0);
    }
  }
});

test('home attaches resume-by-id under directory surface, routes transient feedback to global toast, and fits 1360/720', async ({ page }) => {
  await page.addInitScript(() => {
    let failHistory = true;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], yoloAvailable: true, launchForm: 'terminal', resume: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_registered_tool_workspace') return { probe: { tool: 'codex', selectedPath: '/fixture/codex', installations: [{ path: '/fixture/codex', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_projects') return [{ id: 'desk', name: '栖点', path: '/work/cliora', available: true, preferredTool: 'codex', lastOpened: 1790758800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
          if (command === 'list_history_sessions') {
            if (failHistory) { failHistory = false; throw { message: '历史索引暂不可用' }; }
            return [{ id: 's1', toolId: 'codex', nativeId: 'nat-1', title: '修复首页层级', cwd: '/work/cliora', updatedAt: Date.now() - 60000 }];
          }
          if (command === 'launch_cli') return { mode: args.request?.mode ?? 'normal', status: 'terminal_requested' };
          if (command.startsWith('plugin:event|')) return 1;
          if (command.startsWith('list_')) return [];
          return null;
        },
      },
    });
  });

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  // '恢复指定会话' attaches inside the same directory surface right below the directory list.
  const surface = page.locator('[data-directory-surface]');
  await expect(surface.locator('[data-project-id="desk"]')).toBeVisible();
  await expect(surface.locator('details summary')).toContainText('恢复指定会话');

  // RecentSessions preserves explicit error/retry state, then recovers to list and uses global Toast.
  const recent = page.locator('[data-home-section="recent"]');
  await expect(recent.getByRole('alert')).toBeVisible();
  await recent.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(recent.getByText('修复首页层级')).toBeVisible();

  // Launching a project routes transient success feedback to the single global ToastStack.
  await surface.locator('[data-project-id="desk"]').getByRole('button', { name: '启动', exact: true }).click();
  await expect(page.locator('.toast-stack')).toHaveCount(1);
  await expect(page.locator('.toast-stack .toast[role="status"]')).toBeVisible();
  await expect(recent.locator('.toast-stack')).toHaveCount(0);

  // No horizontal overflow at 1360px and 720px.
  for (const width of [1360, 720]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `width ${width}`).toBeLessThanOrEqual(0);
  }
});
