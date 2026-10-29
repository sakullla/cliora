import { expect, test, type Page } from '@playwright/test';
import { openCli } from './cli-switcher';

// R3: one state reads the same everywhere, each Toolbar/card holds at most one primary action,
// and the first screen at 1360 shows no fewer entries than before the redesign (02 ADR-2/ADR-7).

/**
 * First-screen entry counts of the pre-redesign UI, from docs/design/ui-baseline.md (commit 450750f,
 * `capture-ui.mjs --theme all --size 1360 --measure`). docs/ is not in the repository checkout CI
 * sees, so the numbers are copied here. Usage (8) depends on the time of day in the capture fixture
 * and is compared in docs/design/ui-information-architecture.md with `--records --measure` instead.
 */
const baseline = { home: 7, tools: 2, library: 4, sessions: 5 } as const;

/**
 * A deterministic copy of the capture-ui fixture sizes: five CLIs, two projects, two profiles per
 * CLI, four prompts and one rule, three sessions. Nothing depends on the current time.
 */
async function install(page: Page) {
  await page.addInitScript(() => {
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const versions: Record<string, string> = { codex: '0.160.0', claude_code: '2.1.287', grok: '1.0.46', pi: '1.0.0', open_code: '1.18.34' };
    const ids = Object.keys(names);
    const available = { state: 'available', reason: '' };
    const projects = [
      { id: 'cliora', name: '栖点 · 桌面工具', path: 'C:\\Projects\\cliora', preferredTool: 'codex', available: true, lastOpened: 1790758800, modelOverrides: {}, selectedProfiles: { codex: 'codex-daily' }, appliedProfiles: { codex: 'codex-daily' } },
      { id: 'site', name: '个人网站', path: 'C:\\Projects\\personal-site', preferredTool: 'claude_code', available: true, lastOpened: 1790738800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} },
    ];
    const library = [
      { id: 'prompt-1', kind: 'prompt', title: '代码审查', body: '检查代码变更是否正确、安全、易于维护。', category: '开发', projectId: null, version: 1, updatedAt: 1790758800 },
      { id: 'prompt-2', kind: 'prompt', title: '整理发布说明', body: '根据变更清单写一份简洁的发布说明。', category: '写作', projectId: null, version: 1, updatedAt: 1790672400 },
      { id: 'prompt-3', kind: 'prompt', title: '排查问题', body: '从可以重复出现的现象开始，提出假设并用最小实验验证。', category: '开发', projectId: 'cliora', version: 1, updatedAt: 1790589600 },
      { id: 'prompt-4', kind: 'prompt', title: '解释一段代码', body: '用清晰的语言说明这段代码的作用、数据流与边界条件。', category: '学习', projectId: null, version: 1, updatedAt: 1790416800 },
      { id: 'rule-1', kind: 'rule', title: '项目协作约定', body: '保持变更小而明确。', category: '项目规则', projectId: 'cliora', version: 1, updatedAt: 1790503200 },
    ];
    const records = [
      { id: 's1', nativeId: '01992e52-1ac0-7387-a5e4-41067718dd93', toolId: 'codex', title: '梳理配置继承与应用流程', cwd: projects[0].path, model: 'gpt-6-astra', projectId: 'cliora', startedAt: 1790751600000, updatedAt: 1790758800000, favorite: true, partial: false, stale: false, messageCount: 8, usageCount: 2 },
      { id: 's2', nativeId: '29fbc87e', toolId: 'claude_code', title: '为网站添加文章目录', cwd: projects[1].path, model: 'claude-sonnet-4-6', projectId: 'site', startedAt: 1790748800000, updatedAt: 1790751000000, favorite: false, partial: false, stale: false, messageCount: 6, usageCount: 1 },
      { id: 's3', nativeId: null, toolId: 'pi', title: '检查本地 API 连接', cwd: null, model: null, projectId: null, startedAt: 1790718800000, updatedAt: 1790718800000, favorite: false, partial: true, stale: false, messageCount: 3, usageCount: 0 },
    ];
    const scans = ids.map((toolId) => ({ toolId, scannedAt: 1790758800, sourceCount: 4, failedCount: 0, incomplete: false, detail: '本地记录已索引' }));
    const zero = { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 };
    const usage = { generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', previous: null, timeline: [], totals: zero, byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0, partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans };
    const accounts = ids.map((toolId) => ({ id: `account-${toolId}`, toolId, provider: toolId, version: 1, label: '开发账号', state: 'signed_in', identity: { subject: `fixture-${toolId}`, email: 'developer@example.test', plan: '订阅套餐', source: 'synthetic' }, context: { id: `context-${toolId}` }, retiredContexts: [], pendingLogin: null, detail: null, checkedAt: 1790992800 }));
    const workspace = (id: string) => {
      const profile = { id: `${id}-daily`, tool: id, name: '日常开发', version: 1, revision: 'r1', inheritCommon: true, files: { settings: '{}' }, suppressed: {}, nativeCredentials: {}, connection: null };
      return {
        probe: { tool: id, selectedPath: `C:/Tools/${id}.cmd`, installations: [{ path: `C:/Tools/${id}.cmd`, version: versions[id], status: 'available', source: 'npm_shim' }], nativeFiles: [{ role: 'settings', path: `C:/Users/local/.${id}/settings.json`, format: 'json', writable: true, sensitive: false }], nativeWrites: { state: 'supported', reason: '可编辑与应用原生配置' }, interfaceFormats: ['openai_chat'], providerPresets: [], dependencies: [], installUrl: 'https://example.com', upgradeHint: '', installCommand: `npm install -g ${id}`, upgradeCommand: null, latestVersionSupported: false },
        profiles: [profile, { ...profile, id: `${id}-work`, name: '工作项目', inheritCommon: false }],
        common: { tool: id, version: 1, revision: 'c1', files: { settings: '{}' } },
        binding: { profileId: profile.id, profileVersion: 1 },
        snapshots: [{ role: 'settings', fingerprint: 'hash', error: null }], recoveryNeeded: [], customPath: null, effectiveContextId: null,
      };
    };
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ids, theme: 'light', tool_icons: {} }, tools: ids.map((id) => ({ id, name: names[id], installation: 'not_checked', configuration: 'not_checked' })) };
      if (command === 'list_cli_adapters') return { registered: ids.map((id) => ({ id, name: names[id], management: { accounts: true, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: true }, interfaceFormats: ['openai_chat'], yoloAvailable: true, nativeConfig: available, launch: available, resume: available, resources: available, history: available })), managedIds: ids, preservedUnknown: [] };
      if (command === 'list_projects') return projects;
      if (command === 'get_registered_tool_workspace') return workspace(args.toolId);
      if (command === 'get_registered_tool_context') return { effectiveContextId: null, nativeContextError: null };
      if (command === 'list_accounts') return accounts;
      if (command === 'account_capabilities') return ids.map((toolId) => ({ toolId, provider: toolId, version: versions[toolId], browserLink: false, managedLogin: true, importNative: true, methods: ['browser', 'device'], reason: 'fixture', identitySource: 'synthetic', refreshOwner: 'native_cli', acceptance: 'mock only' }));
      if (command === 'discover_native_logins') return { toolId: args.toolId, checkedAt: 1790992800, logins: [] };
      if (command === 'account_impact') return { accountId: args.id, accountVersion: 1, toolId: 'codex', currentContextId: null, contexts: [], profiles: [], scopes: [], usageReferences: [] };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }] };
      if (command === 'get_tray_status') return { available: true, error: null };
      if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
      if (command === 'refresh_history' || command === 'list_history_scans') return scans;
      if (command === 'list_history_sessions') return records;
      if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
      if (command === 'get_usage_report') return usage;
      if (command === 'get_history_session') return { session: records.find((item) => item.id === args.id), resumeReason: null, usage: [], totals: { ...zero, requests: 2, usageRecords: 2, sessions: 1, input: 1234, output: 690, total: 1924, unpricedTokens: 1924 }, messages: [
        { id: 'm1', role: 'user', timestampSource: 'native', timestamp: 1790751600000, text: '请梳理原生配置与通用配置的继承关系。' },
        { id: 'm2', role: 'assistant', timestampSource: 'native', timestamp: 1790751800000, text: '## 配置继承关系\n\n1. 保存草稿：仅更新本机资料库。\n2. 保存并应用：写入 CLI 原生文件。\n\n```typescript\nconst config = { ...common, ...profile };\n```' },
        { id: 'm3', role: 'user', timestampSource: 'native', timestamp: 1790753600000, text: '请补充项目作用域的边界。' },
      ] };
      if (command === 'list_portable_items') return [{ key: 'preferences:managed', kind: 'preferences', label: '外观与管理偏好', pendingFields: [] }, { key: 'profile:codex-daily', kind: 'profile', label: 'Codex · 日常开发', pendingFields: [] }];
      if (command === 'get_webdav_status') return { configured: true, enabled: true, endpoint: 'https://dav.example.test/cliora', lastSuccess: 1790758800, lastError: null, pendingChanges: 0, retryAfter: null, uploaded: 0, downloaded: 0, conflicts: [] };
      if (command === 'get_skill_enabled') return true;
      if (command.startsWith('list_') || command === 'usage_presets' || command === 'scan_native_skills') return [];
      return null;
    } } });
  });
}

/** The capture-ui `--measure` rule (02 ADR-0): entries fully inside the viewport and every clipping ancestor. */
function countFirstScreen() {
  const main = document.querySelector('main');
  if (!main) return 0;
  return [...main.querySelectorAll('[data-tool-row], [data-project-id], [data-profile-id], article, li, [role="row"], [role="listitem"]')].filter((el) => {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    let top = 0; let left = 0; let bottom = innerHeight; let right = innerWidth;
    for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (['auto', 'scroll', 'hidden', 'clip'].includes(parentStyle.overflowX) || ['auto', 'scroll', 'hidden', 'clip'].includes(parentStyle.overflowY)) {
        const box = parent.getBoundingClientRect();
        top = Math.max(top, box.top); left = Math.max(left, box.left); bottom = Math.min(bottom, box.bottom); right = Math.min(right, box.right);
      }
    }
    return rect.top >= top - 1 && rect.left >= left - 1 && rect.bottom <= bottom + 1 && rect.right <= right + 1;
  }).length;
}

/** Every visible Toolbar, card, project card and tool row with more than one visible primary button. */
async function primaryViolations(page: Page, where: string) {
  return page.evaluate((label) => {
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    return [...document.querySelectorAll('main [data-toolbar], main [data-card], main [data-project-id], main [data-tool-row]')]
      .filter(visible)
      .map((box) => ({ box, count: [...box.querySelectorAll('[data-variant="primary"]')].filter(visible).length }))
      .filter((item) => item.count > 1)
      .map((item) => `${label}: ${item.box.tagName.toLowerCase()}${item.box.getAttribute('aria-label') ? `[${item.box.getAttribute('aria-label')}]` : ''} "${(item.box.textContent ?? '').trim().slice(0, 40)}" has ${item.count}`);
  }, where);
}

/** data-status → tone/label pairs of the visible StatusBadges on the current page. */
async function statusBadges(page: Page) {
  return page.locator('main [data-status][data-tone]').evaluateAll((nodes) => nodes
    .filter((node) => node.getClientRects().length > 0)
    .map((node) => ({ status: node.getAttribute('data-status') ?? '', tone: node.getAttribute('data-tone') ?? '', text: (node.textContent ?? '').trim() })));
}

test('one state shares its badge across pages and each Toolbar or card has at most one primary action', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  await install(page);
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  const nav = page.getByRole('navigation', { name: '页面' });
  const violations: string[] = [];
  const badges: Array<{ page: string; status: string; tone: string; text: string }> = [];

  // 首页: a healthy install is quiet version text; badges are kept for states that need attention.
  const homeRow = page.locator('[data-tool-row]').filter({ hasText: 'Codex' });
  const homeInstalled = homeRow.locator('[data-status="managedTool.ok"]');
  await expect(homeInstalled).toHaveText('0.160.0');
  await expect(homeInstalled).not.toHaveAttribute('data-tone', /.*/);
  await expect(page.locator('[data-project-id="cliora"] [data-variant="primary"]')).toHaveCount(1);
  violations.push(...await primaryViolations(page, '首页'));
  badges.push(...(await statusBadges(page)).map((item) => ({ page: '首页', ...item })));

  // 工具与连接: the installed CLI shows a success badge and its version.
  await openCli(page, 'Codex');
  const region = page.getByRole('region', { name: '工具与连接' });
  await expect(region.getByLabel('配置列表')).toBeVisible();
  const installBadge = region.locator('details summary [data-tone]').first();
  await expect(installBadge).toHaveAttribute('data-tone', 'success');
  await expect(region.locator('details summary').first()).toContainText('0.160.0');
  await expect(region.locator('[data-status^="profile."]').first()).toBeVisible();
  violations.push(...await primaryViolations(page, '工具与连接 · 配置'));
  badges.push(...(await statusBadges(page)).map((item) => ({ page: '工具与连接', ...item })));
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  await expect(page.getByText('开发账号', { exact: true }).first()).toBeVisible();
  violations.push(...await primaryViolations(page, '工具与连接 · 账号'));
  badges.push(...(await statusBadges(page)).map((item) => ({ page: '工具与连接', ...item })));
  // While the add form is open, 添加并登录 is the panel's only primary; the header toggle steps down.
  const accountsPanel = page.getByRole('region', { name: 'OAuth 账号管理' });
  const primaries = accountsPanel.locator('[data-variant="primary"]:visible');
  await expect(accountsPanel.getByRole('button', { name: '添加账号', exact: true })).toHaveAttribute('data-variant', 'primary');
  await accountsPanel.getByRole('button', { name: '添加账号', exact: true }).click();
  const collapse = accountsPanel.getByRole('button', { name: '收起添加', exact: true });
  await expect(collapse).toBeVisible();
  await expect(collapse).not.toHaveAttribute('data-variant', 'primary');
  await expect(primaries).toHaveCount(1);
  await expect(primaries).toHaveText('添加并登录');
  await collapse.click();
  await expect(accountsPanel.getByRole('button', { name: '添加账号', exact: true })).toHaveAttribute('data-variant', 'primary');

  // 资料库: every tab.
  await nav.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.getByRole('button', { name: '代码审查', exact: true })).toBeVisible();
  for (const tab of [/^提示词/, /^长期规则/, /^MCP/, /^Skill/]) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    violations.push(...await primaryViolations(page, `资料库 · ${tab.source}`));
  }

  // 使用记录: sessions and usage.
  await nav.getByRole('button', { name: '使用记录', exact: true }).click();
  await expect(page.getByLabel('会话列表').getByRole('button').first()).toBeVisible();
  violations.push(...await primaryViolations(page, '使用记录 · 会话'));
  await page.getByRole('tab', { name: '用量', exact: true }).click();
  await expect(page.getByRole('tab', { name: '用量', exact: true })).toHaveAttribute('aria-selected', 'true');
  violations.push(...await primaryViolations(page, '使用记录 · 用量'));

  // 设置: general and migration.
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: '主题' })).toBeVisible();
  violations.push(...await primaryViolations(page, '设置 · 通用'));
  await page.getByRole('tab', { name: '迁移与同步' }).click();
  await expect(page.locator('[data-status="sync.on"]')).toBeVisible();
  violations.push(...await primaryViolations(page, '设置 · 迁移与同步'));
  badges.push(...(await statusBadges(page)).map((item) => ({ page: '设置', ...item })));

  expect(violations).toEqual([]);
  // A state key always resolves to one tone and one label, whichever page renders it.
  const byStatus = new Map<string, Set<string>>();
  for (const item of badges.filter((badge) => badge.status !== 'managedTool.ok')) {
    const set = byStatus.get(item.status) ?? new Set<string>();
    set.add(`${item.tone}|${item.text}`);
    byStatus.set(item.status, set);
  }
  expect(byStatus.size).toBeGreaterThan(0);
  for (const [status, values] of byStatus) expect([...values], status).toHaveLength(1);
});

test('first-screen entry counts at 1360 are not below the pre-redesign baseline', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await install(page);
  await page.goto('/');
  await expect(page.getByText('正在读取本机设置')).toBeHidden();
  const nav = page.getByRole('navigation', { name: '页面' });
  const counts: Record<string, number> = {};
  const settle = async () => { await page.mouse.move(0, 0); await page.waitForTimeout(100); };

  await expect(page.locator('[data-tool-row]')).toHaveCount(5);
  await expect(page.locator('[data-project-id]')).toHaveCount(2);
  await settle();
  counts.home = await page.evaluate(countFirstScreen);

  await nav.getByRole('button', { name: '工具与连接', exact: true }).click();
  await expect(page.getByRole('region', { name: '工具与连接' }).locator('[data-profile-id]')).toHaveCount(2);
  await settle();
  counts.tools = await page.evaluate(countFirstScreen);

  await nav.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.getByRole('button', { name: '代码审查', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '解释一段代码', exact: true })).toBeVisible();
  await settle();
  counts.library = await page.evaluate(countFirstScreen);

  await nav.getByRole('button', { name: '使用记录', exact: true }).click();
  await expect(page.getByLabel('会话列表').getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible();
  await settle();
  counts.sessions = await page.evaluate(countFirstScreen);

  for (const [name, value] of Object.entries(baseline)) {
    expect(counts[name], `${name}: ${JSON.stringify(counts)} vs baseline ${JSON.stringify(baseline)}`).toBeGreaterThanOrEqual(value);
  }
});
