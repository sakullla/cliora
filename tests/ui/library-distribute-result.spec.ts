import { expect, test, type Locator, type Page } from '@playwright/test';

/** Two Skill-capable CLIs, so a run always has more than one target. */
const tools = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude_code', name: 'Claude Code' },
];

type Config = {
  /** Per-target preview status; anything missing is 'ready'. */
  previews?: Record<string, 'ready' | 'conflict'>;
  /** Per-target install result; anything missing is installed. */
  installs?: Record<string, 'installed' | 'failed'>;
  /** Initial read failures; tests flip them through `window.__skillReads`. */
  reads?: { packagesFail?: boolean; installsFail?: boolean };
  /** Starts with one library package installed on Codex. */
  seeded?: boolean;
};

async function mockLibrary(page: Page, config: Config = {}) {
  await page.addInitScript(({ tools, config }) => {
    const packages: Array<Record<string, unknown>> = config.seeded ? [{ id: 'pkg-seed', name: 'seeded-skill', description: 'Seeded fixture', compatibility: null, source: '/tmp/seed', digest: 'seed', fileCount: 1, updatedAt: 1, inLibrary: true }] : [];
    const reads = { packagesFail: !!config.reads?.packagesFail, installsFail: !!config.reads?.installsFail };
    const writes: unknown[] = [];
    const descriptor = (tool: { id: string; name: string }) => ({
      id: tool.id, name: tool.name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false,
      launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
      resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      management: { accounts: false, mcp: false, skills: true, agents: false, plugins: false, projectPlugins: false },
    });
    Object.assign(window, {
      isTauri: true,
      __distWrites: writes,
      __skillReads: reads,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'system' }, tools: tools.map((tool) => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(descriptor), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements' || command === 'list_mcp_definitions' || command === 'list_mcp_placements') return [];
          if (command === 'list_library_items') return [];
          if (command === 'list_accounts') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
            profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
          if (command === 'list_skill_packages') {
            if (reads.packagesFail) throw { message: 'skill package fixture denied' };
            return packages;
          }
          if (command === 'list_skill_installations') {
            if (reads.installsFail) throw { message: 'skill install fixture denied' };
            return args.packageId === 'pkg-seed' ? [{ packageId: 'pkg-seed', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: '/tmp/codex/skills/seeded-skill', state: 'current', digest: 'seed' }] : [];
          }
          if (command === 'list_skill_zip_entries') return [''];
          if (command === 'preview_skill_https_zip') return { name: 'alpha', source: args.source, digest: 'new-digest', existingDigest: null, fileCount: 2, changes: [], compatibility: null };
          if (command === 'import_skill_https_zip') {
            const item = { id: 'pkg-alpha', name: 'alpha', description: 'Fixture skill', compatibility: null, source: args.source, digest: 'new-digest', fileCount: 2, updatedAt: 1, inLibrary: true };
            packages.push(item);
            return item;
          }
          if (command === 'preview_skill_target') {
            writes.push({ command, args });
            const status = config.previews?.[String(args.toolId)] ?? 'ready';
            return { path: `/tmp/${args.toolId}/skills/alpha`, status, detail: status === 'conflict' ? '同名内容有外部修改' : '将写入这个 CLI', previewToken: `${args.toolId}-token`, existingDigest: status === 'conflict' ? 'old-digest' : null, packageDigest: 'new-digest', changes: [] };
          }
          if (command === 'install_skill') {
            writes.push({ command, args });
            const result = config.installs?.[String(args.toolId)] ?? 'installed';
            return { toolId: args.toolId, scope: args.scope, projectPath: args.projectPath, path: `/tmp/${args.toolId}/skills/alpha`, status: result, detail: result === 'failed' ? '写入失败：目录不可写' : '完成' };
          }
          return null;
        },
      },
    });
  }, { tools, config });
}

async function openSkills(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('region', { name: '资料库内容' }).getByRole('tab', { name: 'Skill', exact: true }).click();
}

/** Imports one Skill from a URL, installing to whichever CLIs are checked. */
async function importSkill(page: Page, targets: string[]) {
  // The toolbar action and the empty state both open the same dialog.
  await page.getByRole('button', { name: '添加 Skill', exact: true }).first().click();
  // Named, because a conflicted run opens the replace flow dialog right after this one closes.
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '添加 Skill', exact: true }) });
  for (const name of targets) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByRole('textbox', { name: '归档地址' }).fill('https://example.com/alpha.zip');
  await dialog.getByRole('button', { name: '导入地址' }).click();
  await expect(dialog).toHaveCount(0);
}

const resultPanel = (page: Page) => page.getByRole('status', { name: '分发结果' });

test('a failed target keeps its own row next to the target that worked', async ({ page }) => {
  await mockLibrary(page, { installs: { claude_code: 'failed' } });
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, ['Codex', 'Claude Code']);
  const panel = resultPanel(page);
  await expect(panel).toBeVisible();
  // A partial run is a warning, and the headline counts every target it attempted.
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('1 个成功，1 个失败');
  const rows = panel.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'ok');
  await expect(rows.nth(0)).toContainText('Codex');
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'failed');
  await expect(rows.nth(1)).toContainText('写入失败：目录不可写');
  // Failures keep the alert; the panel replaces the success toast.
  await expect(page.getByRole('alert').filter({ hasText: 'Claude Code：写入失败：目录不可写' })).toBeVisible();
});

test('a conflicted target is a skipped result row, not a silent success', async ({ page }) => {
  await mockLibrary(page, { previews: { codex: 'conflict' } });
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, ['Codex']);
  const panel = resultPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('1 个目标：0 个成功，0 个失败，1 个冲突未写入');
  const row = panel.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'conflict');
  await expect(row).toContainText('Codex');
  await expect(row).toContainText('同名内容有外部修改');
  // The existing replace flow still opens the Skill, where the replacement is confirmed.
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改 Skill', exact: true }) });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await dialog.getByRole('button', { name: '安装到所选 CLI' }).click();
  await expect(dialog.getByRole('button', { name: '确认替换' })).toBeVisible();
  await dialog.getByRole('button', { name: '确认替换' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Codex：已安装' })).toBeVisible();
});

test('an import without targets shows no result panel', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, []);
  await expect(page.getByRole('button', { name: 'alpha', exact: true })).toBeVisible();
  await expect(resultPanel(page)).toHaveCount(0);
});

test('Skill package and install-location failures are not shown as an empty library or "not installed"', async ({ page }) => {
  await mockLibrary(page, { seeded: true, reads: { packagesFail: true } });
  await page.goto('/');
  await openSkills(page);
  const library = page.getByRole('region', { name: '资料库内容' });
  // First package failure: an error with retry, not the empty Skill state and not a count of zero.
  await expect(library.getByRole('heading', { name: '暂时无法读取 Skill' })).toBeVisible();
  await expect(library.getByText('还没有 Skill')).toHaveCount(0);
  await expect(library.getByText(/命中 \d+ \/ 共/)).toHaveCount(0);
  await expect(library.getByRole('tab', { name: 'Skill', exact: true }).locator('[data-count-state="unknown"]')).toHaveText('?');
  // Packages recover, but their install locations fail: packages stay, marks are unknown and locked.
  await page.evaluate(() => { const reads = (window as any).__skillReads; reads.packagesFail = false; reads.installsFail = true; });
  await library.getByRole('button', { name: '重试', exact: true }).click();
  const card = library.locator('[data-skill-id="pkg-seed"]');
  await expect(card.getByRole('button', { name: 'seeded-skill', exact: true })).toBeVisible();
  await expect(library.getByRole('status').getByText(/安装位置读取失败/)).toBeVisible();
  await expect(library.getByRole('status').getByText(/skill install fixture denied/)).toBeVisible();
  const codex = card.getByRole('button', { name: 'Codex · 安装状态未知' });
  await expect(codex).toBeDisabled();
  await expect(card.getByRole('button', { name: /未安装/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '修改', exact: true })).toBeDisabled();
  await expect(library.getByRole('tab', { name: 'Skill', exact: true }).locator('[data-count-state]')).toHaveCount(0);
  // Retrying the locations restores real state and the marks become usable.
  await page.evaluate(() => { (window as any).__skillReads.installsFail = false; });
  await library.getByRole('button', { name: '重试读取安装位置' }).click();
  await expect(library.getByText(/安装位置读取失败/)).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^Codex · 已/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('button', { name: /^Codex · 已/ })).toBeEnabled();
  await expect(card.getByRole('button', { name: '修改', exact: true })).toBeEnabled();
  // A no-match search offers a way back; a failed refresh keeps the rows and says they may be stale.
  await library.getByLabel('搜索资料').fill('nothing');
  await expect(library.getByText('没有匹配「nothing」的 Skill。')).toBeVisible();
  await library.getByRole('button', { name: '清除搜索' }).click();
  await expect(card.getByRole('button', { name: 'seeded-skill', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__distWrites.length)).toBe(0);
});

/* Long-term rules: the body save, the list refresh and each target's update are reported apart. */
const ruleTools = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude_code', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kiro', name: 'Kiro' },
];

type RuleFixture = { bound?: string[]; failing?: string[]; conflicts?: string[] };

async function mockRules(page: Page, config: RuleFixture = {}) {
  await page.addInitScript(({ tools, config }) => {
    const rule = { id: 'rule-1', kind: 'rule', title: '提交约定', body: '先跑测试再提交', category: '', projectId: null, version: 1, updatedAt: 1 };
    const state = {
      bound: [...(config.bound ?? tools.map((tool) => tool.id))],
      failing: [...(config.failing ?? [])],
      conflicts: [...(config.conflicts ?? [])],
      written: {} as Record<string, number>,
      saves: 0,
      listFails: false,
      readbackFails: false,
      readbackFailsAfterSync: false,
      syncs: [] as Array<{ expectedVersion: number; toolIds: string[]; scope: string; allowReplace: boolean }>,
      bumpVersion: () => { rule.version += 1; },
    };
    const descriptor = (tool: { id: string; name: string }) => ({
      id: tool.id, name: tool.name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false,
      launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
      resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, rules: { global: true, project: false, catalog: false, globalReason: '', projectReason: '' } },
    });
    const pathOf = (toolId: string) => `C:/Users/fixture-user/AppData/Roaming/very-long-configuration-directory-name/${toolId}/nested/rules/AGENTS.md`;
    Object.assign(window, {
      isTauri: true,
      __rules: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'system' }, tools: tools.map((tool) => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(descriptor), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
          if (command === 'list_library_items') {
            if (args.kind !== 'rule') return [];
            if (state.listFails) throw { message: '资料列表读取失败' };
            return [{ ...rule }];
          }
          if (command === 'save_library_item') {
            if (args.draft.expectedVersion !== rule.version) throw { message: 'fixture version conflict' };
            state.saves += 1;
            Object.assign(rule, args.draft, { version: rule.version + 1, updatedAt: 2 });
            return { ...rule };
          }
          if (command === 'list_rule_placements') {
            if (state.readbackFails) throw { message: 'fixture placement denied' };
            return state.bound.map((toolId) => ({ ruleId: rule.id, toolId, scope: 'global', projectPath: null, state: 'current' }));
          }
          if (command === 'sync_rule_clients') {
            const selection = args.selection;
            state.syncs.push({ expectedVersion: args.expectedVersion, toolIds: [...selection.toolIds].sort(), scope: selection.scope, allowReplace: !!selection.allowReplace });
            if (args.expectedVersion !== rule.version) throw { message: '规则正文已变化，请重新保存' };
            const wanted: string[] = selection.toolIds;
            const conflicts = wanted.filter((toolId) => state.conflicts.includes(toolId));
            if (!selection.allowReplace && conflicts.length) return conflicts.map((toolId) => ({ toolId, path: pathOf(toolId), status: 'conflict', detail: '这个规则文件有资料库之外的修改。', existing: 'outside', proposed: rule.body }));
            const rows = wanted.map((toolId) => {
              if (state.failing.includes(toolId)) return { toolId, path: pathOf(toolId), status: 'failed', detail: `${toolId} 目录不可写`, existing: '', proposed: rule.body };
              if (state.written[toolId] === rule.version) return { toolId, path: pathOf(toolId), status: 'unchanged', detail: '拼接结果与当前文件一致', existing: rule.body, proposed: rule.body };
              state.written[toolId] = rule.version;
              if (!state.bound.includes(toolId)) state.bound.push(toolId);
              return { toolId, path: pathOf(toolId), status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: rule.body };
            });
            // Targets left out of the selection are unbound, as the native command does.
            for (const toolId of state.bound.filter((id) => !wanted.includes(id))) {
              state.bound = state.bound.filter((id) => id !== toolId);
              rows.push({ toolId, path: pathOf(toolId), status: 'written', detail: '已移除', existing: rule.body, proposed: '' });
            }
            if (state.readbackFailsAfterSync) state.readbackFails = true;
            return rows;
          }
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
            profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  }, { tools: ruleTools, config });
}

async function openRule(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  await expect(library.getByRole('button', { name: 'Codex · 已生效', exact: true })).toBeEnabled();
  await library.getByRole('button', { name: '提交约定', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('先跑测试，再提交并写清原因');
  return dialog;
}

const rulePanel = (scope: Locator) => scope.getByRole('status', { name: '规则分发结果' });
const ruleState = (page: Page) => page.evaluate(() => {
  const state = (window as any).__rules;
  return { saves: state.saves as number, bound: [...state.bound].sort() as string[], syncs: state.syncs as Array<{ expectedVersion: number; toolIds: string[]; allowReplace: boolean }> };
});

test('a rule save lists every target result and the retry keeps successful bindings', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await mockRules(page, { failing: ['opencode', 'kiro'] });
  await page.goto('/');
  const dialog = await openRule(page);
  await dialog.locator('[data-dialog-save]').click();
  const panel = rulePanel(dialog);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('正文已保存');
  await expect(panel).toContainText('2 个已更新');
  await expect(panel).toContainText('2 个失败');
  const rows = panel.getByRole('listitem');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'written');
  await expect(rows.filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'written');
  await expect(rows.filter({ hasText: 'OpenCode' })).toHaveAttribute('data-state', 'failed');
  await expect(rows.filter({ hasText: 'OpenCode' })).toContainText('opencode 目录不可写');
  await expect(rows.filter({ hasText: 'Kiro' })).toContainText('kiro 目录不可写');
  await expect(rows.filter({ hasText: 'Kiro' })).toContainText('very-long-configuration-directory-name/kiro');
  // The draft is kept and the result stays readable without page-level overflow in a narrow window.
  await expect(dialog.getByRole('textbox', { name: '资料正文', exact: true })).toHaveText('先跑测试，再提交并写清原因');
  const overflow = await panel.evaluate((element) => ({ panel: element.scrollWidth - element.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(overflow.panel).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(1);
  let state = await ruleState(page);
  expect(state.saves).toBe(1);
  expect(state.syncs).toHaveLength(1);

  await page.evaluate(() => { (window as any).__rules.failing = []; });
  const retry = panel.getByRole('button', { name: '重试未完成的目标', exact: true });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(panel).not.toHaveAttribute('data-tone', 'warning');
  await expect(rows.filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'unchanged');
  await expect(rows.filter({ hasText: 'OpenCode' })).toHaveAttribute('data-state', 'written');
  await expect(rows.filter({ hasText: 'Kiro' })).toHaveAttribute('data-state', 'written');
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  state = await ruleState(page);
  // The retry sends the full expected target set at the saved version, never just the failed ids.
  expect(state.saves).toBe(1);
  expect(state.syncs).toHaveLength(2);
  expect(state.syncs[1]).toMatchObject({ expectedVersion: 2, toolIds: ['claude_code', 'codex', 'kiro', 'opencode'], allowReplace: false });
  expect(state.bound).toEqual(['claude_code', 'codex', 'kiro', 'opencode']);
});

test('cancelling a rule file replacement writes nothing and keeps the conflict visible', async ({ page }) => {
  await mockRules(page, { conflicts: ['claude_code'] });
  await page.goto('/');
  const dialog = await openRule(page);
  await dialog.locator('[data-dialog-save]').click();
  const confirmation = page.getByRole('dialog', { name: '替换规则文件？' });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  const panel = rulePanel(page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: '资料正文', exact: true }) }));
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('正文已保存');
  await expect(panel).toContainText('规则文件保持原样');
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('listitem')).toHaveAttribute('data-state', 'conflict');
  await expect(panel.getByRole('listitem')).toContainText('Claude Code');
  const state = await ruleState(page);
  expect(state.saves).toBe(1);
  expect(state.syncs.filter((call) => call.allowReplace)).toHaveLength(0);
  expect(state.bound).toEqual(['claude_code', 'codex', 'kiro', 'opencode']);
});

test('a retry after the rule changed elsewhere re-reads instead of replaying the old write', async ({ page }) => {
  await mockRules(page, { failing: ['kiro'] });
  await page.goto('/');
  const dialog = await openRule(page);
  await dialog.locator('[data-dialog-save]').click();
  const panel = rulePanel(dialog);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Kiro' })).toHaveAttribute('data-state', 'failed');
  await page.evaluate(() => { const state = (window as any).__rules; state.failing = []; state.bumpVersion(); });
  await panel.getByRole('button', { name: '重试未完成的目标', exact: true }).click();
  await expect(panel).toContainText('规则已在别处更新或删除');
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  const state = await ruleState(page);
  expect(state.syncs).toHaveLength(1);
  expect(state.saves).toBe(1);
});

test('a failed readback after the rule write is pending, not success, and recovers by reading only', async ({ page }) => {
  await mockRules(page, { bound: ['codex', 'claude_code'] });
  await page.goto('/');
  const dialog = await openRule(page);
  await page.evaluate(() => { (window as any).__rules.readbackFailsAfterSync = true; });
  await dialog.locator('[data-dialog-save]').click();
  const panel = rulePanel(dialog);
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('规则已写入，但写入状态读取失败');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  await expect(dialog.locator('[data-dialog-save]')).toBeDisabled();
  await page.evaluate(() => { const state = (window as any).__rules; state.readbackFailsAfterSync = false; state.readbackFails = false; });
  await dialog.getByRole('button', { name: '重试写入状态', exact: true }).click();
  await expect(panel).not.toHaveAttribute('data-tone', 'warning');
  await expect(panel).not.toContainText('写入状态读取失败');
  const state = await ruleState(page);
  expect(state.syncs).toHaveLength(1);
  expect(state.saves).toBe(1);
});
