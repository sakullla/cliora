/** Long-term rule save/distribution result captures with synthetic IPC; never native acceptance evidence.
 *
 * Starts its own Vite preview of an existing build on a free local port, walks the rule result
 * states (partial failure, retry, declined replacement, pending readback, stale list, changed rule)
 * in light/dark × 1360/900/640, checks page errors and horizontal overflow, and writes its own gallery.
 *
 *   node scripts/capture-library-rule-results.mjs [--theme all|light|dark] [--size 1360,900,640] [--only partial,retried]
 *
 * CLIORA_RULE_CAPTURE_BUILD_OUT: build directory to preview (default dist; run npm run build first).
 * CLIORA_RULE_CAPTURE_OUT: output directory (default docs/verification/library-rule-results).
 */
import fs from 'node:fs';
import { settleCapture, previousCaptureCleanup } from './capture-ready.mjs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const option = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1] ?? fallback; };
const themeOption = option('--theme', 'all');
const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
const sizeOption = option('--size', 'all');
const widths = sizeOption === 'all' ? [1360, 900, 640] : sizeOption.split(',').map(Number);
if (themes.some(theme => theme !== 'light' && theme !== 'dark') || widths.some(width => !Number.isFinite(width) || width <= 0)) {
  console.error('--theme accepts all|light|dark and --size accepts all or comma-separated widths');
  process.exit(2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(process.env.CLIORA_RULE_CAPTURE_OUT ?? path.join(root, 'docs/verification/library-rule-results'));
const buildDirectory = path.resolve(root, process.env.CLIORA_RULE_CAPTURE_BUILD_OUT ?? 'dist');
if (!fs.existsSync(path.join(buildDirectory, 'index.html'))) {
  console.error(`No build at ${buildDirectory}. Run npm run build first, or set CLIORA_RULE_CAPTURE_BUILD_OUT.`);
  process.exit(2);
}
// Never write into another tool's gallery: a non-empty directory must already be this script's own.
if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'capture-rule-results-manifest.json'))) {
  console.error(`${out} already holds other files. Choose an empty directory with CLIORA_RULE_CAPTURE_OUT.`);
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const prunePrevious = previousCaptureCleanup(out, 'capture-rule-results-manifest.json');

const tools = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude_code', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kiro', name: 'Kiro' },
];

function installMock(seed) {
  const rule = { id: 'rule-1', kind: 'rule', title: '提交前先运行完整测试，并在说明中写清楚每项改动的原因与验证结果', body: '先跑测试再提交', category: '团队约定', projectId: null, version: 1, updatedAt: Math.floor(Date.now() / 1000) };
  const state = { bound: seed.tools.map(tool => tool.id), failing: [...(seed.failing ?? [])], conflicts: [...(seed.conflicts ?? [])], written: {}, listFails: false, listFailsAfterSave: !!seed.listFailsAfterSave, readbackFails: false, readbackFailsAfterSync: !!seed.readbackFailsAfterSync };
  const descriptor = tool => ({
    id: tool.id, name: tool.name, interfaceFormats: [], projectModelOverride: false, yoloAvailable: false,
    launchForm: 'terminal', nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' },
    resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false, rules: { global: true, project: false, catalog: false, globalReason: '', projectReason: '' } },
  });
  const pathOf = toolId => `C:/Users/developer/AppData/Roaming/a-very-long-configuration-directory-for-rules/${toolId}/nested/settings/AGENTS.md`;
  Object.assign(window, {
    isTauri: true,
    __rules: state,
    __bumpRule: () => { rule.version += 1; },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: async (command, args = {}) => {
        if (command === 'get_bootstrap' || command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: seed.tools.map(tool => tool.id), theme: seed.theme, tool_icons: {} }, tools: seed.tools.map(tool => ({ id: tool.id, name: tool.name, installation: 'not_checked', configuration: 'not_checked' })) };
        if (command === 'list_cli_adapters') return { registered: seed.tools.map(descriptor), managedIds: seed.tools.map(tool => tool.id), preservedUnknown: [] };
        if (command === 'list_library_items') {
          if (args.kind !== 'rule') return [];
          if (state.listFails) throw { message: '资料列表读取失败' };
          return [{ ...rule }];
        }
        if (command === 'save_library_item') {
          Object.assign(rule, args.draft, { version: rule.version + 1, updatedAt: Math.floor(Date.now() / 1000) });
          if (state.listFailsAfterSave) state.listFails = true;
          return { ...rule };
        }
        if (command === 'list_rule_placements') {
          if (state.readbackFails) throw { message: 'placement read denied' };
          return state.bound.map(toolId => ({ ruleId: rule.id, toolId, scope: 'global', projectPath: null, state: 'current' }));
        }
        if (command === 'sync_rule_clients') {
          if (args.expectedVersion !== rule.version) throw { message: '规则正文已变化，请重新保存' };
          const wanted = args.selection.toolIds;
          const conflicts = wanted.filter(toolId => state.conflicts.includes(toolId));
          if (!args.selection.allowReplace && conflicts.length) return conflicts.map(toolId => ({ toolId, path: pathOf(toolId), status: 'conflict', detail: '这个规则文件有资料库之外的修改。确认后才会用拼接结果替换。', existing: 'outside', proposed: rule.body }));
          const rows = wanted.map(toolId => {
            if (state.failing.includes(toolId)) return { toolId, path: pathOf(toolId), status: 'failed', detail: '写入失败：目标文件被其它进程占用，请关闭占用后重试', existing: '', proposed: rule.body };
            if (state.written[toolId] === rule.version) return { toolId, path: pathOf(toolId), status: 'unchanged', detail: '拼接结果与当前文件一致', existing: rule.body, proposed: rule.body };
            state.written[toolId] = rule.version;
            return { toolId, path: pathOf(toolId), status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: rule.body };
          });
          if (state.readbackFailsAfterSync) state.readbackFails = true;
          return rows;
        }
        if (command === 'list_projects' || command === 'list_accounts' || command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_skill_packages') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'get_registered_tool_workspace' || command === 'get_registered_tool_context') return { effectiveContextId: null, probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], installUrl: '', upgradeHint: '', dependencies: [], installCommand: null, upgradeCommand: null, providerPresets: [] }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      },
    },
  });
}

const retry = page => page.locator('[data-rule-result]').getByRole('button', { name: '重试未完成的目标', exact: true }).click();
const scenarios = [
  { name: 'partial', note: '2 of 4 targets fail; every target keeps its own row and the retry is offered', seed: { failing: ['opencode', 'kiro'] } },
  { name: 'retried', note: 'the retry sends the full target set; failed targets are updated, the rest stay current', seed: { failing: ['opencode', 'kiro'] }, after: async page => { await page.evaluate(() => { window.__rules.failing = []; }); await retry(page); await page.locator('[data-rule-result]:not([data-tone])').waitFor(); } },
  { name: 'conflict-kept', note: 'a declined replacement writes nothing and keeps the conflict visible', seed: { conflicts: ['claude_code'] }, onConfirm: '取消' },
  { name: 'readback-pending', note: 'the write returned but the placement readback failed: state pending, read-only recovery', seed: { readbackFailsAfterSync: true } },
  { name: 'list-stale-distributed', note: 'the list read after saving failed; the verified targets were still updated', seed: { listFailsAfterSave: true } },
  { name: 'outdated', note: 'the rule changed elsewhere before the retry; nothing is replayed', seed: { failing: ['kiro'] }, after: async page => { await page.evaluate(() => { window.__rules.failing = []; window.__bumpRule(); }); await retry(page); await page.locator('[data-rule-result]').getByText('规则已在别处更新或删除', { exact: false }).waitFor(); } },
];
const selected = option('--only', '').split(',').filter(Boolean);
const unknown = selected.filter(name => !scenarios.some(scenario => scenario.name === name));
if (unknown.length) { console.error(`--only accepts ${scenarios.map(scenario => scenario.name).join(',')}`); process.exit(2); }

async function walk(page, scenario) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  await library.getByRole('button', { name: 'Codex · 已生效', exact: true }).waitFor();
  await library.locator('[data-card-title]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '资料正文', exact: true }).fill('先运行完整测试，再提交；提交说明写清楚原因和验证结果。');
  await dialog.locator('[data-dialog-save]').click();
  if (scenario.onConfirm) await page.getByRole('dialog', { name: '替换规则文件？' }).getByRole('button', { name: scenario.onConfirm, exact: true }).click();
  await page.locator('[data-rule-result]').waitFor();
  await scenario.after?.(page);
  await settleCapture(page);
}

// The ephemeral port is released before preview binds it; strictPort refuses an unrelated server.
const port = await new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', () => {
    const address = reservation.address();
    reservation.close(error => error ? reject(error) : resolve(address.port));
  });
});
const shots = [];
const problems = [];
const firstLine = error => String(error?.message ?? error).split('\n')[0];
let server = null;
let browser = null;
let stopped = false;
const closeServer = async () => {
  if (!server) return;
  const current = server;
  server = null;
  current.httpServer.closeAllConnections?.();
  await new Promise(resolve => current.httpServer.close(() => resolve()));
};
const stop = () => { stopped = true; void browser?.close().catch(() => {}); void closeServer(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  server = await preview({ root, logLevel: 'warn', build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port, strictPort: true, open: false } });
  const url = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  for (const theme of themes) for (const width of widths) for (const scenario of scenarios.filter(item => !selected.length || selected.includes(item.name))) {
    if (stopped) break;
    const label = `${scenario.name}/${theme}/${width}`;
    const shot = { file: `${scenario.name}-${theme}-${width}.png`, scenario: scenario.name, theme, width, pageErrors: [], overflow: false, resultOverflow: false, actionError: null };
    let page = null;
    let stage = 'page';
    try {
      page = await browser.newPage({ viewport: { width, height: 940 }, colorScheme: theme, locale: 'zh-CN', reducedMotion: 'reduce' });
      page.on('pageerror', error => shot.pageErrors.push(error.message));
      await page.addInitScript(installMock, { tools, theme, ...scenario.seed });
      stage = 'navigation';
      await page.goto(url);
      stage = 'action';
      try { await walk(page, scenario); } catch (error) { shot.actionError = firstLine(error); }
      stage = 'overflow check';
      const overflow = await page.evaluate(() => {
        const result = document.querySelector('[data-rule-result]');
        return { page: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, result: !!result && result.scrollWidth > result.clientWidth + 1 };
      });
      shot.overflow = overflow.page;
      shot.resultOverflow = overflow.result;
      stage = 'screenshot';
      await page.screenshot({ path: path.join(out, shot.file) });
      shots.push(shot);
    } catch (error) {
      problems.push(`${label}: ${stage}: ${firstLine(error)}`);
    } finally {
      await page?.close().catch(() => {});
    }
    for (const message of shot.pageErrors) problems.push(`${label}: page error: ${message}`);
    if (shot.overflow) problems.push(`${label}: horizontal page overflow`);
    if (shot.resultOverflow) problems.push(`${label}: rule result panel overflow`);
    if (shot.actionError) problems.push(`${label}: action: ${shot.actionError}`);
  }
} catch (error) {
  problems.push(`setup: ${firstLine(error)}`);
} finally {
  await browser?.close().catch(() => {});
  await closeServer().catch(() => {});
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
if (stopped) problems.push('interrupted');
const acceptance = { kind: 'playwright-synthetic-ipc', nativePlatform: 'unverified' };
if (!problems.length) prunePrevious(shots.map(shot => shot.file));
const notes = Object.fromEntries(scenarios.map(scenario => [scenario.name, scenario.note]));
fs.writeFileSync(path.join(out, 'capture-rule-results-manifest.json'), JSON.stringify({ acceptance, build: buildDirectory, themes, widths, count: shots.length, problems, scenarios: notes, shots }, null, 2));
fs.writeFileSync(path.join(out, 'README.md'), `# Rule save and distribution result captures\n\nSynthetic IPC only; native platform behavior is unverified. Generated by \`node scripts/capture-library-rule-results.mjs\`.\n\n${shots.length} screenshots; ${problems.length} problems (page errors, horizontal overflow, failed actions).\n\n${scenarios.map(scenario => `- \`${scenario.name}\`: ${scenario.note}`).join('\n')}\n${problems.length ? `\n## Problems\n\n${problems.map(problem => `- ${problem}`).join('\n')}\n` : ''}`);
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Rule result captures</title><style>body{font:14px system-ui;background:#222;color:#eee;margin:24px}figure{display:inline-block;margin:12px;vertical-align:top}img{max-width:680px;border:1px solid #555}</style><h1>Rule result captures</h1><p>合成 IPC 界面证据，原生平台行为未验证。${problems.length ? ` ${problems.length} 个问题，见 README。` : ''}</p>${shots.map(shot => `<figure><img src="${shot.file}" alt="${shot.scenario} ${shot.theme} ${shot.width}"><figcaption>${shot.file}${shot.actionError || shot.overflow || shot.resultOverflow || shot.pageErrors.length ? ' · problem' : ''}</figcaption></figure>`).join('')}</html>`);
console.log(JSON.stringify({ out, count: shots.length, problems }, null, 2));
if (problems.length) process.exitCode = 1;
