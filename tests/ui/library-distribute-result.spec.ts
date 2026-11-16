import { installPromptFixtureBridge } from '../../scripts/capture-prompt-fixtures.mjs';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.addInitScript(installPromptFixtureBridge); });

/** Two Skill-capable CLIs, so a run always has more than one target. */
const tools = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude_code', name: 'Claude Code' },
];

type Config = {
  /** Per-target preview status; anything missing is 'ready'. */
  previews?: Record<string, 'ready' | 'conflict'>;
  /** Per-target install result; anything missing is installed. */
  installs?: Record<string, 'installed' | 'failed' | 'already_current'>;
  /** Per-target removal result; anything missing is removed. */
  removes?: Record<string, 'removed' | 'failed'>;
  /** Initial read failures; tests flip them through `window.__skillReads`. */
  reads?: { packagesFail?: boolean; installsFail?: boolean };
  /** Starts with one library package installed on Codex. */
  seeded?: boolean;
  /** With `seeded`, leaves the package uninstalled so its marks can install. */
  uninstalled?: boolean;
  /** Reported install locations of the seeded package; the default is Codex global. */
  placement?: Array<{ toolId: string; scope?: 'global' | 'project'; projectPath?: string | null; state?: string }>;
  /** Projects the scope picker can switch to. */
  projects?: Array<{ id: string; name: string; path: string }>;
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
      /** While true, install_skill answers only after a test releases it. */
      __skillDeferInstall: false,
      __skillInstallWaiters: [] as Array<() => void>,
      /** While true, install-location reads stay unresolved. */
      __skillDeferWorkspace: false,
      __skillWorkspaceWaiters: [] as Array<() => void>,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'system' }, tools: tools.map((tool) => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(descriptor), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
          if (command === 'list_projects') return (config.projects ?? []).map((project) => ({ ...project, available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }));
          if (command === 'list_rule_placements' || command === 'list_mcp_definitions' || command === 'list_mcp_placements') return [];
          if (command === 'list_library_items') return [];
          if (command === 'list_accounts') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_registered_tool_workspace') {
            if ((window as any).__skillDeferWorkspace) await new Promise<void>((resolve) => { (window as any).__skillWorkspaceWaiters.push(resolve); });
            return {
              probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
              profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
            };
          }
          if (command === 'list_skill_packages') {
            if (reads.packagesFail) throw { message: 'skill package fixture denied' };
            return packages;
          }
          if (command === 'list_skill_installations') {
            if (reads.installsFail) throw { message: 'skill install fixture denied' };
            if (args.packageId !== 'pkg-seed' || config.uninstalled) return [];
            return (config.placement ?? [{ toolId: 'codex' }]).map((place) => ({ packageId: 'pkg-seed', toolId: place.toolId, scope: place.scope ?? 'global', projectPath: place.projectPath ?? null, contextId: null, targetPath: `/tmp/${place.toolId}/skills/seeded-skill`, state: place.state ?? 'current', digest: 'seed' }));
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
            if ((window as any).__skillDeferInstall) await new Promise<void>((resolve) => { (window as any).__skillInstallWaiters.push(resolve); });
            // Tests flip `window.__skillInstallMode` to change a target between runs.
            const overrides = (window as any).__skillInstallMode ?? {};
            const result = overrides[String(args.toolId)] ?? config.installs?.[String(args.toolId)] ?? 'installed';
            return { toolId: args.toolId, scope: args.scope, projectPath: args.projectPath, path: `/tmp/${args.toolId}/skills/alpha`, status: result, detail: result === 'failed' ? '写入失败：目录不可写' : result === 'already_current' ? '原生内容已相同' : '完成' };
          }
          if (command === 'remove_skill') {
            writes.push({ command, args });
            const overrides = (window as any).__skillRemoveMode ?? {};
            const result = overrides[String(args.toolId)] ?? config.removes?.[String(args.toolId)] ?? 'removed';
            return { toolId: args.toolId, scope: args.scope, projectPath: args.projectPath, path: `/tmp/${args.toolId}/skills/seeded-skill`, status: result, detail: result === 'failed' ? '目录不可写' : '完成' };
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
  await expect(panel).toContainText('1 个目标：0 个成功，0 个未变化，0 个失败，1 个冲突未写入');
  const row = panel.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'conflict');
  await expect(row).toContainText('Codex');
  await expect(row).toContainText('同名内容有外部修改');
  // The existing replace flow still opens the Skill, where the replacement is confirmed.
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改 Skill', exact: true }) });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('没有勾选 CLI，不会写入任何目标。')).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await expect(dialog.getByText('将安装到 Codex')).toBeVisible();
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
  // The result is a library save only, and no target was attempted.
  await expect(page.getByRole('status').filter({ hasText: '已放进资料库。' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__distWrites.length)).toBe(0);
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

test('a partial Skill import names the unfinished target and retries only that one', async ({ page }) => {
  await mockLibrary(page, { installs: { claude_code: 'failed' } });
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, ['Codex', 'Claude Code']);
  const panel = resultPanel(page);
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('1 个成功，1 个失败');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toContainText('写入失败：目录不可写');
  await page.evaluate(() => { (window as any).__skillInstallMode = { claude_code: 'installed' }; });
  await panel.getByRole('button', { name: '重试未完成的目标', exact: true }).click();
  // Recovery keeps the row that already worked and re-checks the unfinished target.
  await expect(panel).not.toHaveAttribute('data-tone', 'warning');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'ok');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'ok');
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  const installs = await page.evaluate(() => (window as any).__distWrites.filter((entry: { command: string }) => entry.command === 'install_skill').map((entry: { args: { toolId: string } }) => entry.args.toolId));
  expect(installs).toEqual(['codex', 'claude_code', 'claude_code']);
});

test('a Skill target that is already current is unchanged, not a second write', async ({ page }) => {
  await mockLibrary(page, { seeded: true, uninstalled: true, installs: { codex: 'already_current' } });
  await page.goto('/');
  await openSkills(page);
  const card = page.getByRole('region', { name: '资料库内容' }).locator('[data-skill-id="pkg-seed"]');
  await card.getByRole('button', { name: 'Codex · 未安装' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Codex 已是最新，没有重复写入。' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已安装到 Codex' })).toHaveCount(0);
});

test('an import reports a target that was already current as unchanged next to the real write', async ({ page }) => {
  await mockLibrary(page, { installs: { codex: 'already_current' } });
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, ['Codex', 'Claude Code']);
  const panel = resultPanel(page);
  await expect(panel).not.toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('1 个已处理，1 个未变化');
  const unchanged = panel.getByRole('listitem').filter({ hasText: 'Codex' });
  await expect(unchanged).toHaveAttribute('data-state', 'unchanged');
  await expect(unchanged).toContainText('已是最新，没有重复写入');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'ok');
});

test('a conflicted Skill import still counts the target that was already current', async ({ page }) => {
  await mockLibrary(page, { installs: { codex: 'already_current' }, previews: { claude_code: 'conflict' } });
  await page.goto('/');
  await openSkills(page);
  await importSkill(page, ['Codex', 'Claude Code']);
  const panel = resultPanel(page);
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  // Every attempted target is in the count, so the numbers still add up to the total.
  await expect(panel).toContainText('2 个目标：0 个成功，1 个未变化，0 个失败，1 个冲突未写入');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'unchanged');
});

test('a failed Skill removal inside the dialog reports the native reason without a retry that would install', async ({ page }) => {
  await mockLibrary(page, { seeded: true, removes: { codex: 'failed' } });
  await page.goto('/');
  await openSkills(page);
  await page.getByRole('button', { name: '修改' }).click();
  const editor = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改 Skill', exact: true }) });
  await editor.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog', { name: '从该工具移除' }).getByRole('button', { name: '移除', exact: true }).click();
  const panel = editor.getByRole('status', { name: 'Skill 写入结果' });
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await expect(panel.getByRole('listitem')).toHaveAttribute('data-state', 'failed');
  await expect(panel).toContainText('Codex：目录不可写');
  // Recovery for a failed removal is its own confirmed 移除 action, not a reinstall.
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  await expect(editor.locator('ul').filter({ hasText: '全局 · 已安装' }).getByText('Codex')).toBeVisible();
});

test('a failed Skill removal keeps the installation with its native reason', async ({ page }) => {
  await mockLibrary(page, { seeded: true, removes: { codex: 'failed' } });
  await page.goto('/');
  await openSkills(page);
  const library = page.getByRole('region', { name: '资料库内容' });
  const mark = library.locator('[data-skill-id="pkg-seed"]').getByRole('button', { name: 'Codex · 已生效' });
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await mark.click();
  await expect(page.getByRole('alert')).toContainText('目录不可写');
  await expect(page.getByRole('status').filter({ hasText: '已从' })).toHaveCount(0);
  await expect(library.locator('[data-skill-id="pkg-seed"]').getByRole('button', { name: 'Codex · 已生效' })).toHaveAttribute('aria-pressed', 'true');
});

/* Skill dialog runs: every row keeps the range it was written in, and a retry only
   touches the targets that failed in that same range. */
const skillPanel = (dialog: Locator) => dialog.getByRole('status', { name: 'Skill 写入结果' });
const skillWrites = (page: Page) => page.evaluate(() => ((window as any).__distWrites as Array<{ command: string; args: Record<string, unknown> }>)
  .filter((entry) => entry.command === 'install_skill')
  .map((entry) => ({ toolId: entry.args.toolId, scope: entry.args.scope, projectPath: entry.args.projectPath, allowTakeover: entry.args.allowTakeover })));

async function openSkillEditor(page: Page) {
  await page.getByRole('button', { name: '修改', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '修改 Skill', exact: true }) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('retrying a failed Skill target keeps the target that already succeeded', async ({ page }) => {
  await mockLibrary(page, { seeded: true, placement: [{ toolId: 'codex' }, { toolId: 'claude_code' }] });
  await page.goto('/');
  await openSkills(page);
  const dialog = await openSkillEditor(page);
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Claude Code', exact: true })).toBeChecked();
  await page.evaluate(() => { (window as any).__skillInstallMode = { claude_code: 'failed' }; });
  await dialog.getByRole('button', { name: '安装到所选 CLI', exact: true }).click();
  const panel = skillPanel(dialog);
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel).toContainText('2 个目标：1 个成功，0 个未变化，1 个失败，0 个冲突未写入。');
  await page.evaluate(() => { (window as any).__skillInstallMode = { claude_code: 'installed' }; });
  await panel.getByRole('button', { name: '重试未完成的目标', exact: true }).click();
  // The row that already worked survives the retry, and the count still covers both targets.
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'ok');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'ok');
  await expect(panel).toContainText('2 个目标已完成。');
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  expect(await skillWrites(page)).toEqual([
    { toolId: 'codex', scope: 'global', projectPath: null, allowTakeover: false },
    { toolId: 'claude_code', scope: 'global', projectPath: null, allowTakeover: false },
    { toolId: 'claude_code', scope: 'global', projectPath: null, allowTakeover: false },
  ]);
});

test('a failed Skill run is neither retried nor re-pointed at a scope selected afterwards', async ({ page }) => {
  await mockLibrary(page, { seeded: true, placement: [{ toolId: 'codex' }, { toolId: 'claude_code' }], projects: [{ id: 'second', name: 'Second project', path: '/tmp/second-project' }] });
  await page.goto('/');
  await openSkills(page);
  const dialog = await openSkillEditor(page);
  await page.evaluate(() => { (window as any).__skillInstallMode = { claude_code: 'failed' }; });
  await dialog.getByRole('button', { name: '安装到所选 CLI', exact: true }).click();
  const panel = skillPanel(dialog);
  await expect(panel.getByRole('button', { name: '重试未完成的目标', exact: true })).toBeVisible();
  // Switching scope clears the rows of the global run, including its retry entry.
  await dialog.getByRole('button', { name: '分发范围' }).click();
  await dialog.getByRole('option', { name: 'Second project' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).not.toBeChecked();
  await expect(skillPanel(dialog)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  // The failed global target was never written into the project range.
  expect(await skillWrites(page)).toEqual([
    { toolId: 'codex', scope: 'global', projectPath: null, allowTakeover: false },
    { toolId: 'claude_code', scope: 'global', projectPath: null, allowTakeover: false },
  ]);
});

test('a Skill write that answers after a scope switch is dropped instead of credited to the new range', async ({ page }) => {
  await mockLibrary(page, { seeded: true, placement: [{ toolId: 'codex' }, { toolId: 'claude_code' }], projects: [{ id: 'second', name: 'Second project', path: '/tmp/second-project' }] });
  await page.goto('/');
  await openSkills(page);
  const dialog = await openSkillEditor(page);
  await page.evaluate(() => { (window as any).__skillDeferInstall = true; });
  await dialog.getByRole('button', { name: '安装到所选 CLI', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__skillInstallWaiters.length)).toBe(1);
  await dialog.getByRole('button', { name: '分发范围' }).click();
  await dialog.getByRole('option', { name: 'Second project' }).click();
  await page.evaluate(() => {
    const state = window as any;
    state.__skillDeferInstall = false;
    for (const resume of state.__skillInstallWaiters) resume();
    state.__skillInstallWaiters.length = 0;
  });
  // The late answer belongs to the old range: no panel, no row, and no second target.
  await expect(skillPanel(dialog)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '重试未完成的目标', exact: true })).toHaveCount(0);
  expect(await skillWrites(page)).toEqual([{ toolId: 'codex', scope: 'global', projectPath: null, allowTakeover: false }]);
});

test('a conflict waiting for confirmation survives retrying another Skill target', async ({ page }) => {
  await mockLibrary(page, { seeded: true, placement: [{ toolId: 'codex' }, { toolId: 'claude_code' }], previews: { claude_code: 'conflict' } });
  await page.goto('/');
  await openSkills(page);
  const dialog = await openSkillEditor(page);
  await page.evaluate(() => { (window as any).__skillInstallMode = { codex: 'failed' }; });
  await dialog.getByRole('button', { name: '安装到所选 CLI', exact: true }).click();
  const panel = skillPanel(dialog);
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'conflict');
  await expect(dialog.getByRole('button', { name: '确认替换并安装' })).toBeVisible();
  await page.evaluate(() => { (window as any).__skillInstallMode = {}; });
  await panel.getByRole('button', { name: '重试未完成的目标', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'ok');
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'conflict');
  await expect(panel).toContainText('2 个目标：1 个成功，0 个未变化，0 个失败，1 个冲突未写入。');
  // The replacement is still authorized from the same dialog, and only then written.
  await expect(dialog.getByRole('button', { name: '确认替换并安装' })).toBeVisible();
  await dialog.getByRole('button', { name: '确认替换并安装' }).click();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Claude Code' })).toHaveAttribute('data-state', 'ok');
  expect((await skillWrites(page)).at(-1)).toEqual({ toolId: 'claude_code', scope: 'global', projectPath: null, allowTakeover: true });
});

test('the pre-submit summary does not call a disabled or relocated Skill current', async ({ page }) => {
  await mockLibrary(page, { seeded: true, placement: [{ toolId: 'codex', state: 'disabled' }, { toolId: 'claude_code', state: 'unavailable' }] });
  await page.goto('/');
  await openSkills(page);
  const dialog = await openSkillEditor(page);
  const summary = dialog.locator('[data-skill-summary]');
  await expect(summary).toContainText('Codex 已停用，安装会重新写入');
  await expect(summary).toContainText('Claude Code 的安装目录已不在原位，安装会按当前位置重新写入');
  await expect(summary).not.toContainText('已是最新');
  // The promise holds: submitting does write both targets.
  await dialog.getByRole('button', { name: '安装到所选 CLI', exact: true }).click();
  await expect.poll(async () => (await skillWrites(page)).length).toBe(2);
});

test('the pre-submit summary says the install location is unknown instead of claiming nothing is checked', async ({ page }) => {
  await mockLibrary(page, { seeded: true });
  await page.goto('/');
  await openSkills(page);
  await page.evaluate(() => { (window as any).__skillDeferWorkspace = true; });
  const dialog = await openSkillEditor(page);
  const summary = dialog.locator('[data-skill-summary]');
  await expect(summary).toContainText('安装位置还在读取，现在无法确认会写入');
  await expect(summary).not.toContainText('没有勾选 CLI');
});


/* MCP: the library save, the pre-submit target set and each committed target are separate claims. */
type McpConfig = {
  /** Seeded placement for the fixture definition; an empty list keeps it library-only. */
  placements?: Array<{ toolId: string }>;
  /** Per-target commit result; anything missing is written. */
  commits?: Record<string, 'written' | 'failed' | 'already_matching'>;
};

async function mockMcp(page: Page, config: McpConfig = {}) {
  await page.addInitScript(({ tools, config }) => {
    const definitions: Array<Record<string, unknown>> = config.placements ? [{ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y'], cwd: '', url: '', env: {}, headers: {}, inLibrary: true, version: 1 }] : [];
    const placements: Array<Record<string, unknown>> = (config.placements ?? []).map((item) => ({ definitionId: 'mcp-1', toolId: item.toolId, scope: 'global', projectPath: null, contextId: null, enabled: true }));
    const writes: string[] = [];
    const commits: Array<Record<string, unknown>> = [];
    const save = (draft: Record<string, any>) => {
      const item = { ...draft, id: draft.id || `mcp-${definitions.length + 1}`, version: (draft.expectedVersion ?? 0) + 1 };
      const index = definitions.findIndex((old) => old.id === item.id);
      if (index < 0) definitions.push(item); else definitions[index] = item;
      return item;
    };
    const descriptor = (tool: { id: string; name: string }) => ({
      id: tool.id, name: tool.name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false,
      launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
      resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      management: { accounts: false, mcp: true, skills: false, agents: false, plugins: false, projectPlugins: false },
    });
    Object.assign(window, {
      isTauri: true,
      __mcpWrites: writes,
      __mcpCommits: commits,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'system' }, tools: tools.map((tool) => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
          if (command === 'list_cli_adapters') return { registered: tools.map(descriptor), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_library_items' || command === 'list_accounts' || command === 'list_rule_placements') return [];
          if (command === 'list_mcp_definitions') return definitions;
          if (command === 'list_mcp_placements') return placements;
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          if (command === 'get_registered_tool_workspace') return {
            probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
            profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
          };
          if (command === 'save_mcp_definition') { writes.push(command); return save(args.draft); }
          if (command === 'preview_mcp_draft') {
            writes.push(command);
            const definition = save(args.draft);
            return { draft: args.draft, definition, targets: args.targets.map((target: Record<string, any>) => ({ ...target, operation: target.operation ?? 'write', status: 'ready', detail: '将写入这个 CLI', path: '/tmp/config.toml', baselineHash: 'hash-baseline', previewToken: `token-${target.toolId}`, existing: null, proposed: { command: 'npx' } })) };
          }
          if (command === 'commit_mcp_draft') {
            writes.push(command);
            commits.push(args);
            const definition = save(args.draft);
            const overrides = (window as any).__mcpCommitMode ?? {};
            const targets = args.targets.map((target: Record<string, any>) => {
              const mode = overrides[String(target.toolId)] ?? config.commits?.[String(target.toolId)] ?? 'written';
              if (target.operation !== 'remove') {
                const index = placements.findIndex((place) => place.definitionId === definition.id && place.toolId === target.toolId);
                const place = { definitionId: definition.id, toolId: target.toolId, scope: target.scope, projectPath: target.projectPath ?? null, contextId: target.contextId ?? null, enabled: target.enabled };
                if (index < 0) placements.push(place); else placements[index] = place;
              }
              return { ...target, path: '/tmp/config.toml', baselineHash: 'hash-baseline', existing: null, proposed: null, status: mode === 'failed' ? 'failed' : 'written', detail: mode === 'failed' ? '写入失败：目录不可写' : mode === 'already_matching' ? 'already_matching' : 'committed' };
            });
            return { definition, targets };
          }
          return null;
        },
      },
    });
  }, { tools, config });
}

async function openMcp(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('region', { name: '资料库内容' }).getByRole('tab', { name: 'MCP', exact: true }).click();
}

const mcpPanel = (dialog: Locator) => dialog.getByRole('status', { name: 'MCP 写入结果' });
const mcpWrites = (page: Page) => page.evaluate(() => (window as any).__mcpWrites as string[]);

test('an MCP saved without targets stays in the library and claims no native write', async ({ page }) => {
  await mockMcp(page);
  await page.goto('/');
  await openMcp(page);
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('filesystem');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('npx');
  // The pre-submit state says it is a library-only save, not a write.
  await expect(dialog.getByText('没有勾选 CLI，只保存到资料库。')).toBeVisible();
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: '已保存在资料库。' });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText('已写入');
  // Only the definition save ran: no preview and no commit were submitted.
  expect(await mcpWrites(page)).toEqual(['save_mcp_definition']);
});

test('an MCP save-and-distribute run states the target changes before it submits', async ({ page }) => {
  await mockMcp(page, { placements: [{ toolId: 'codex' }] });
  await page.goto('/');
  await openMcp(page);
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  const targets = dialog.getByRole('region', { name: '写入到 CLI' });
  await expect(targets.getByRole('listitem')).toHaveCount(2);
  await expect(targets.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  await targets.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
  await expect(targets).toContainText('将写入 Claude Code');
  await targets.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
  await expect(targets).toContainText('将写入 Claude Code');
  await expect(targets).toContainText('将从 Codex 移除');
  await targets.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await expect(targets).not.toContainText('将从');
  await dialog.locator('[data-dialog-save]').click();
  // The preview lists exactly the reviewed set before the commit is authorized.
  const preview = dialog.getByRole('group', { name: 'MCP 写入预览' });
  await expect(preview).toContainText('Codex');
  await expect(preview).toContainText('Claude Code');
  expect(await mcpWrites(page)).toEqual(['preview_mcp_draft']);
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toHaveCount(0);
  const commits = await page.evaluate(() => (window as any).__mcpCommits as Array<{ targets: Array<{ toolId: string }> }>);
  expect(commits).toHaveLength(1);
  expect(commits[0].targets.map((target) => target.toolId).sort()).toEqual(['claude_code', 'codex']);
});

test('an MCP run with one failed target keeps both rows and offers the unfinished retry', async ({ page }) => {
  await mockMcp(page, { placements: [{ toolId: 'codex' }], commits: { claude_code: 'failed' } });
  await page.goto('/');
  await openMcp(page);
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
  await dialog.locator('[data-dialog-save]').click();
  await dialog.locator('[data-dialog-save]').click();
  const panel = mcpPanel(dialog);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-tone', 'warning');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(panel.getByRole('listitem').filter({ hasText: 'Codex' })).toHaveAttribute('data-state', 'written');
  const failed = panel.getByRole('listitem').filter({ hasText: 'Claude Code' });
  await expect(failed).toHaveAttribute('data-state', 'failed');
  await expect(failed).toContainText('写入失败：目录不可写');
  await expect(dialog.getByRole('region', { name: '写入到 CLI' }).getByRole('alert')).toContainText('Claude Code：写入失败：目录不可写');
  // The failed detail stays readable inside the panel instead of widening the dialog.
  const overflow = await panel.evaluate((element) => ({ panel: element.scrollWidth - element.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  expect(overflow.panel).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(1);
  // The dialog stays open with the draft for recovery.
  await expect(page.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('npx');
  await page.evaluate(() => { (window as any).__mcpCommitMode = { claude_code: 'written' }; });
  await panel.getByRole('button', { name: '重试未完成的目标', exact: true }).click();
  // The retry re-previews the reviewed target set instead of replaying the failed commit.
  await expect(dialog.getByRole('group', { name: 'MCP 写入预览' })).toBeVisible();
  expect(await mcpWrites(page)).toEqual(['preview_mcp_draft', 'commit_mcp_draft', 'preview_mcp_draft']);
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toHaveCount(0);
  const commits = await page.evaluate(() => (window as any).__mcpCommits as Array<{ targets: unknown[] }>);
  expect(commits).toHaveLength(2);
});

test('an MCP target already matching the file is unchanged, not written', async ({ page }) => {
  await mockMcp(page, { placements: [{ toolId: 'codex' }], commits: { codex: 'already_matching' } });
  await page.goto('/');
  await openMcp(page);
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-dialog-save]').click();
  await dialog.locator('[data-dialog-save]').click();
  await expect(dialog).toHaveCount(0);
  const toast = page.getByRole('status').filter({ hasText: 'Codex 已是最新，没有重复写入。' });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText('已写入');
});

test('editing the MCP form after a run marks its rows as a previous submission', async ({ page }) => {
  await mockMcp(page, { placements: [{ toolId: 'codex' }], commits: { claude_code: 'failed' } });
  await page.goto('/');
  await openMcp(page);
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Claude Code', exact: true }).check();
  await dialog.locator('[data-dialog-save]').click();
  await dialog.locator('[data-dialog-save]').click();
  const panel = mcpPanel(dialog);
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  // The rows belong to the submission that just ran, not to an older draft.
  await expect(panel.locator('[data-stale]')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('node');
  // Editing invalidates the run: the rows stay readable but say which submission they describe.
  await expect(panel.locator('[data-stale]')).toContainText('表单已修改，这些结果来自上一次提交');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await expect(dialog.getByRole('group', { name: 'MCP 写入预览' })).toHaveCount(0);
});

/* Long-term rules: the body save, the list refresh and each target's update are reported apart. */const ruleTools = [
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
