/** Synthetic memory screens (工具与连接 → 记忆) for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const option = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; };
const themeOption = option('--theme', 'all');
const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
const sizeOption = option('--size', 'all');
const widths = sizeOption === 'all' ? [1360, 900, 640] : sizeOption.split(',').map(Number);
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const out = process.env.CLIORA_CAPTURE_OUT ?? `${root}/docs/verification/ui-memory`;
const previewUrl = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
fs.mkdirSync(out, { recursive: true });

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const doc = (name, description, type, daysAgo, body) => `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  node_type: memory\n  type: ${type}\n  originSessionId: 0f6c2a5e-8f0b-4f61-9a43-2d1b6f0c11aa\n  modified: ${iso(daysAgo)}\n---\n\n${body}\n`;
const fixtures = {
  qoder_cn: {
    name: 'Qoder CN', switchShared: false, nativeFileNames: true,
    switchGroups: [{ id: 'autoMemoryUserScopeEnabled', scope: 'global', enabled: null, detail: '跟随原生默认，当前生效状态未知' }, { id: 'autoMemoryEnabled', scope: 'project', enabled: null, detail: '跟随原生默认，当前生效状态未知' }],
    management: { scope: { global: true, project: true }, targets: ['project'], operations: ['list', 'open', 'create', 'edit', 'delete', 'master_switch'], limitation: '用户和项目记忆分别使用用户设置中的原生开关；项目设置及非交互环境可能覆盖，运行中的会话需重新加载。原生不支持单条启停。' },
    stores: [
      { label: '用户记忆', scope: 'global', directory: 'C:/Users/dev/.qoder-cn/memory', inUse: false, entries: { preferences: doc('用户偏好', '简洁回答，使用中文', 'user', 1, '项目说明与提交记录采用中文。') } },
      { label: 'C--Users-dev-project-cliora', scope: 'project', directory: 'C:/Users/dev/.qoder-cn/projects/C--Users-dev-project-cliora/memory', inUse: false, entries: { architecture: doc('项目架构', '原生适配器与共享服务边界', 'project', 2, '配置、记忆目录和协议由适配器提供，共享事务服务负责安全写入。') } },
    ],
  },
  claude: {
    name: 'Claude Code', switchShared: true,
    management: { scope: { global: false, project: true }, targets: ['project'], operations: ['list', 'open', 'create', 'edit', 'delete', 'master_switch'], limitation: 'Claude Code 无单条记忆启停；总开关映射用户级 settings.json 的 autoMemoryEnabled，项目目录 .claude 下的同名键覆盖不在此处改写' },
    stores: [
      { label: 'C:\\Users\\dev\\project\\cliora', directory: 'C:/Users/dev/.claude/projects/C--Users-dev-project-cliora/memory', entries: {
        user_profile: doc('user-profile', 'User works in Chinese, terse directives, expects autonomous end-to-end problem solving', 'user', 2, 'The user communicates in Chinese with short, high-level directives.\n\n- Prefers **autonomous decisions** over clarifying questions\n- Expects verification evidence with every change\n- Reviews UI changes through screenshots'),
        'release-ritual': doc('release-ritual', '五处版本文件→chore 提交→push main→vX.Y.Z tag；已发布 tag 不移动', 'project', 5, '## 发布流程\n\n1. 同步五处版本文件：`package.json`、`Cargo.toml`、`tauri.conf.json`…\n2. 提交 `chore: release vX.Y.Z`\n3. 推送 main 后打 tag\n\n> 已发布的 tag 永远不移动；修复走下一个补丁版本。\n\nRelated: [[linux-build-server]] · [[missing-note]]'),
        feedback_requirement_docs: doc('requirement-docs-new-not-revise', '延续已关闭 workflow 的需求时新建独立需求文档，不修订旧文档', 'feedback', 1, '对已关闭 workflow 交付的需求做后续强化时，新建 `docs/requirements/<日期>-<主题>.md`，不修订旧需求文档。\n\n**Why:** 旧文档是已验收交付的依据。\n\n**How to apply:** 新需求引用旧文档路径即可。'),
        'linux-build-server': doc('linux-build-server', 'Debian 13 构建机；无 GitHub 访问（scp 中转）；GUI 冒烟需要 DBus+Xvfb', 'reference', 12, '构建机 `192.168.0.109`，Debian 13。\n\n```bash\nscp target/release/bundle/deb/*.deb build:/tmp/\nxvfb-run -a dbus-run-session ./cliora\n```'),
      } },
      { label: 'C:\\Users\\dev\\IdeaProjects\\SampleApp', directory: 'C:/Users/dev/.claude/projects/C--Users-dev-IdeaProjects-SampleApp/memory', entries: {
        project_sample-app_playback: doc('project-sample-app-playback', '播放器使用 mpv 嵌入；字幕与音轨切换走 IPC 命令', 'project', 9, '播放链路：mpv 嵌入窗口 → IPC 命令切换字幕与音轨。'),
        user_profile: doc('user-profile', 'Prefers Kotlin, compact code, and Chinese commit messages', 'user', 30, 'Kotlin first; compact code; Chinese commit summaries.'),
      } },
      { label: 'C:\\Users\\dev\\project\\empty-store', directory: 'C:/Users/dev/.claude/projects/C--Users-dev-project-empty-store/memory', entries: {} },
      { label: 'C:\\Users\\dev\\IdeaProjects\\sample-proxy', directory: 'C:/Users/dev/.claude/projects/C--Users-dev-IdeaProjects-sample-proxy/memory', entries: {
        'ui-permission-controls-in-composer': '# Composer permission controls\n\nPermission toggles live in the composer footer, not in a modal.', } },
    ],
  },
  alpha: {
    name: 'Alpha', switchShared: false,
    management: { scope: { global: true, project: true }, targets: ['project'], operations: ['list', 'open', 'create', 'edit', 'delete', 'master_switch', 'item_enable'] },
    stores: [
      { label: '全局', directory: 'C:/Users/dev/.alpha/memory', scope: 'global', entries: { 'coding-style': '# Coding style\n\nTwo-space indentation, single quotes.', 'commit-format': 'Use `fix:` and `feat:` prefixes.' } },
      { label: '项目 · 栖点', directory: 'C:/Users/dev/.alpha/projects/cliora', projectPath: 'C:/Projects/cliora', inUse: false, entries: { 'adapter-rules': 'Adapters stay under the two adapter roots.' } },
    ],
    disabled: ['commit-format'],
  },
  beta: {
    name: 'Beta', switchShared: false,
    management: { scope: { global: true, project: false }, targets: [], operations: ['list', 'open'], limitation: '只读存储，不能新建、编辑、删除或启停' },
    stores: [{ label: '全局', directory: 'C:/Users/dev/.beta/memory', scope: 'global', entries: { 'beta-note': '# Beta note\n\nRead-only memory written by the CLI.' } }],
  },
  delta: {
    name: 'Delta', switchShared: true,
    management: { scope: { global: false, project: true }, targets: ['project'], operations: ['list', 'open', 'create', 'edit', 'delete', 'master_switch'] },
    stores: [],
  },
};

function installMock(seed) {
  const state = { ...seed, off: seed.off ?? false };
  const tools = Object.keys(state.fixtures);
  const registered = tools.map(id => ({ id, name: state.fixtures[id].name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false, launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'planned', reason: '' }, resume: { state: 'planned', reason: '' }, resources: { state: 'planned', reason: '' }, history: { state: 'planned', reason: '' }, management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, memory: state.fixtures[id].management } }));
  const targetOf = (toolId, store) => ({ toolId, scope: store.scope ?? 'project', projectPath: store.projectPath ?? null, storeDirectory: store.directory });
  const aggregate = (toolId) => {
    const fixture = state.fixtures[toolId];
    const entries = []; const stores = [];
    for (const store of (state.emptyQoder && toolId === 'qoder_cn' ? [] : fixture.stores)) {
      const inUse = state.off && fixture.switchShared ? false : store.inUse ?? true;
      const detail = inUse ? '' : '记忆当前未使用';
      const target = targetOf(toolId, store);
      stores.push({ label: store.label, directory: store.directory, target, inUse, detail, entryCount: Object.keys(store.entries).length });
      for (const id of Object.keys(store.entries)) entries.push({ id, path: `${store.directory}/${id}.md`, enabled: !(fixture.disabled ?? []).includes(id), fingerprint: state.unreadable === id ? '' : `fp-${id}`, readError: state.unreadable === id ? '文件暂时被其它进程独占，请重试' : undefined, sourceLabel: store.label, target, inUse, detail });
    }
    return { toolId, entries, failedSources: [], stores, switchShared: fixture.switchShared, switchGroups: fixture.switchGroups, nativeFileNames: fixture.nativeFileNames };
  };
  const find = (target, id) => state.fixtures[target.toolId].stores.find(store => store.directory === target.storeDirectory)?.entries[id];
  Object.assign(window, {
    isTauri: true,
    __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
      if (command === 'get_bootstrap' || command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: tools, theme: state.theme, tool_icons: {} }, tools: registered.map(item => ({ id: item.id, name: item.name, installation: 'not_checked', configuration: 'not_checked' })) };
      if (command === 'list_cli_adapters') return { registered, managedIds: tools, preservedUnknown: [] };
      if (command === 'list_projects') return [{ id: 'cliora', name: '栖点', path: 'C:\\Users\\dev\\project\\cliora', available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }, { id: 'site', name: '个人网站', path: 'C:\\Users\\dev\\project\\site', available: true, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
      if (command === 'get_registered_tool_workspace' || command === 'get_registered_tool_context') return { effectiveContextId: null, probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [] }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'list_all_memories') return aggregate(args.toolId);
      if (command === 'read_memories') return args.requests.map(({ target, id }) => state.unreadable === id ? { document: null, error: '文件暂时被其它进程独占，请重试' } : ({ document: { id, path: `${target.storeDirectory}/${id}.md`, text: find(target, id) ?? '', fingerprint: `fp-${id}`, enabled: true, inUse: true, detail: '' }, error: null }));
      if (command === 'read_memory') { const text = find(args.target, args.id) ?? ''; return { id: args.id, path: `${args.target.storeDirectory}/${args.id}.md`, text, fingerprint: `fp-${args.id}`, enabled: true, inUse: true, detail: '' }; }
      if (command === 'save_memory' || command === 'delete_memory' || command === 'set_memory_enabled') return null;
      if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
      return null;
    } },
  });
}

const scenarios = [
  { name: 'qoder-partial-read', tool: 'Qoder CN', seed: { unreadable: 'architecture' } },
  { name: 'qoder-native-default', tool: 'Qoder CN', run: async page => { await page.getByRole('button', { name: /preferences.md/ }).click(); } },
  { name: 'qoder-empty', tool: 'Qoder CN', seed: { emptyQoder: true } },
  { name: 'qoder-create', tool: 'Qoder CN', seed: { emptyQoder: true }, run: async page => { await page.getByRole('button', { name: '新建记忆' }).first().click(); await page.getByRole('textbox', { name: '文件名' }).fill('project-notes'); } },
  { name: 'claude-overview', tool: 'Claude Code' },
  { name: 'claude-read', tool: 'Claude Code', run: async page => { await page.getByRole('button', { name: /Release ritual/ }).click(); } },
  { name: 'claude-properties', tool: 'Claude Code', run: async page => { await page.getByRole('button', { name: /Linux build server/ }).click(); await page.getByRole('button', { name: /^属性/ }).click(); } },
  { name: 'claude-edit', tool: 'Claude Code', run: async page => { await page.getByRole('button', { name: /User profile/ }).first().click(); await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.getByRole('textbox', { name: '记忆正文' }).click(); await page.keyboard.press('End'); await page.keyboard.type(' 已编辑'); } },
  { name: 'claude-create', tool: 'Claude Code', run: async page => { await page.getByRole('button', { name: '新建记忆' }).first().click(); await page.getByRole('textbox', { name: '文件名' }).fill('coding-style'); } },
  { name: 'claude-filter', tool: 'Claude Code', run: async page => { await page.getByRole('button', { name: '反馈', exact: true }).click(); } },
  { name: 'claude-no-match', tool: 'Claude Code', run: async page => { await page.getByRole('searchbox', { name: '搜索记忆' }).fill('不存在的内容'); } },
  { name: 'claude-off', tool: 'Claude Code', seed: { off: true } },
  { name: 'engine-switches', tool: 'Alpha', run: async page => { await page.getByRole('button', { name: /Commit format/i }).click(); } },
  { name: 'read-only', tool: 'Beta', run: async page => { await page.getByRole('button', { name: /Beta note|beta-note/i }).first().click(); } },
  { name: 'empty', tool: 'Delta' },
];

const browser = await chromium.launch();
const shots = [];
const problems = [];
const selected = option('--only', '').split(',').filter(Boolean);
for (const theme of themes) for (const width of widths) for (const scenario of scenarios.filter(item => !selected.length || selected.includes(item.name))) {
  const page = await browser.newPage({ viewport: { width, height: 940 }, colorScheme: theme });
  page.on('pageerror', error => problems.push(`${scenario.name}/${theme}/${width}: ${error.message}`));
  await page.addInitScript(installMock, { fixtures, theme, ...(scenario.seed ?? {}) });
  await page.goto(previewUrl);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  if (scenario.tool !== 'Claude Code') await page.getByRole('tab', { name: scenario.tool, exact: true }).click();
  else await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.waitForTimeout(700);
  try { await scenario.run?.(page); } catch (error) { problems.push(`${scenario.name}/${theme}/${width}: ${error.message.split('\n')[0]}`); }
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push(`${scenario.name}/${theme}/${width}: horizontal overflow`);
  const file = `${scenario.name}-${theme}-${width}.png`;
  await page.screenshot({ path: `${out}/${file}` });
  shots.push(file);
  await page.close();
}
await browser.close();
fs.writeFileSync(`${out}/capture-memory-manifest.json`, JSON.stringify({ out, count: shots.length, problems, shots }, null, 2));
fs.writeFileSync(`${out}/README.md`, `# Memory captures\n\nSynthetic native IPC; not native acceptance.\n\n${shots.length} screenshots; ${problems.length} page errors/overflow/action failures.\n`);
fs.writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Memory captures</title><style>body{font:14px system-ui;background:#222;color:#eee}figure{display:inline-block;margin:12px;vertical-align:top}img{max-width:680px;border:1px solid #555}</style>${shots.map((file) => `<figure><img src="${file}"><figcaption>${file}</figcaption></figure>`).join('')}`);
console.log(JSON.stringify({ out, count: shots.length, problems }, null, 2));
if (problems.length) process.exitCode = 1;
