import { expect, test, type Page } from '@playwright/test';

const body = Array.from({ length: 30 }, (_, index) => index % 3 === 0
  ? '自然语言命中以下意图时直接进入本 skill：'
  : '| Stage1 评估 | `评估这个 PRD 的需求规模和 SP` | `$requirement-split-estimator 对这份 PRD 做阶段一需求规模评估` |').join('\n');
const DOC = `---\nname: requirement-split-estimator\ndescription: 需求拆分评估\n---\n${body}\n`;

/** Plugin skills are read-only; one local skill shares no text with the plugin name. */
async function mockPluginSkills(page: Page) {
  await page.addInitScript(({ doc }) => {
    const root = '/tmp/.claude/skills';
    const entry = (name: string, source: string, pluginName: string | null) => ({ name, path: `${root}/${name}`, digest: null, state: 'external', detail: name, packageId: null, source, pluginName, pluginEnabled: pluginName ? true : null, issues: [] });
    const entries = [entry('requirement-split-estimator', 'plugin', 'sdlc@sdlc-marketplace'), entry('retrieving-knowledge', 'plugin', 'sdlc@sdlc-marketplace'), entry('team8-deliver', 'plugin', 'team8-dev@team8-workflow'), entry('local-notes', 'writable', null)];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null };
        if (command === 'scan_native_skills') return entries.map(item => ({ ...item }));
        if (command === 'read_native_skill') return { name: String(args.directory).split('/').pop(), path: args.directory, content: doc };
        if (command === 'analyze_skill_document') return { name: 'requirement-split-estimator', description: '需求拆分评估', license: null, compatibility: null, metadata: [], allowedTools: [], extra: [], bodyLine: 4, issues: [] };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command.startsWith('list_')) return [];
        return null;
      } },
    });
  }, { doc: DOC });
}

async function openSkills(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  return page.getByRole('navigation', { name: 'Skill 列表' });
}

test('Skill search also matches the plugin a skill comes from', async ({ page }) => {
  await mockPluginSkills(page);
  const list = await openSkills(page);
  const search = page.getByRole('searchbox', { name: '搜索 Skill' });
  await expect(search).toHaveAttribute('placeholder', '搜索名称或插件');
  await search.fill('sdlc');
  await expect(list.getByRole('button', { name: /requirement-split-estimator/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /retrieving-knowledge/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /team8-deliver/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /local-notes/ })).toHaveCount(0);
  await search.fill('team8-workflow');
  await expect(list.getByRole('button', { name: /team8-deliver/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /requirement-split-estimator/ })).toHaveCount(0);
  // Names still match as before.
  await search.fill('local');
  await expect(list.getByRole('button', { name: /local-notes/ })).toBeVisible();
});

test('read-only Skill source starts a new selection where the press lands, even inside the old one', async ({ page }) => {
  await mockPluginSkills(page);
  const list = await openSkills(page);
  await list.getByRole('button', { name: /requirement-split-estimator/ }).click();
  await page.getByRole('button', { name: '源码' }).click();
  const line = page.locator('.cm-line').nth(4);
  await line.waitFor();
  await expect(line).toHaveText('自然语言命中以下意图时直接进入本 skill：');
  const selected = () => page.evaluate(() => String(getSelection()));
  async function drag(fromX: number, toX: number) {
    const box = (await line.boundingBox())!;
    await page.mouse.move(box.x + fromX, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++) await page.mouse.move(box.x + fromX + (toX - fromX) * step / 12, box.y + box.height / 2);
    await page.mouse.up();
  }
  // Right to left from fresh.
  await drag(250, 4);
  const first = await selected();
  expect(first.length).toBeGreaterThan(10);
  expect(first.startsWith('自然')).toBe(true);
  // Right to left again, pressing inside the first selection: a new selection, not a text drag.
  await drag(200, 60);
  const second = await selected();
  expect(second.length).toBeGreaterThan(5);
  expect(first.includes(second)).toBe(true);
  expect(second).not.toBe(first);
});
