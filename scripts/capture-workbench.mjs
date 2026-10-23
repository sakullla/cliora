/** Synthetic workbench fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const previewUrl = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
const locale = process.env.CLIORA_CAPTURE_LOCALE ?? 'zh-CN';
const english = locale.toLowerCase().startsWith('en');
const copy = (zh, en) => english ? en : zh;
const out = process.env.CLIORA_CAPTURE_OUT ?? root + '/docs/verification/ui-workbench' + (english ? '-en' : '');
fs.mkdirSync(out, { recursive: true });

let previewReady = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try { const response = await fetch(previewUrl, { signal: AbortSignal.timeout(1000) }); if (response.ok) { previewReady = true; break; } } catch { /* preview not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!previewReady) throw new Error('预览服务未就绪：' + previewUrl + '。请先构建并启动 Vite preview，再运行捕获。');

const transcript = [
  '\u001b[2m  Codex CLI \u001b[0m\u001b[2m·\u001b[0m v0.160.0 \u001b[2m·\u001b[0m model \u001b[1mgpt-6-astra\u001b[0m',
  '',
  '\u001b[36m╭──────────────────────────────────────────────────────────────╮\u001b[0m',
  '\u001b[36m│\u001b[0m  \u001b[1m工作目录\u001b[0m  C:\\Projects\\cliora                                  \u001b[36m│\u001b[0m',
  '\u001b[36m│\u001b[0m  \u001b[1m沙盒\u001b[0m      workspace-write · 网络已关闭                        \u001b[36m│\u001b[0m',
  '\u001b[36m╰──────────────────────────────────────────────────────────────╯\u001b[0m',
  '',
  '\u001b[1m› 请梳理当前项目的模块结构，并运行单元测试确认没有回归。\u001b[0m',
  '',
  '\u001b[32m●\u001b[0m 读取 \u001b[1msrc/features/sessions/SessionWorkbench.tsx\u001b[0m',
  '\u001b[32m●\u001b[0m 读取 \u001b[1msrc/App.tsx\u001b[0m \u001b[2m·\u001b[0m \u001b[2m312 行\u001b[0m',
  '\u001b[32m●\u001b[0m 检索 \u001b[1mworkbench*\u001b[0m \u001b[2m·\u001b[0m 14 处匹配',
  '',
  '\u001b[2m正在修改\u001b[0m \u001b[1msrc/features/sessions/SessionWorkbench.module.css\u001b[0m',
  '\u001b[31m-\u001b[0m .rail { padding: 10px; }',
  '\u001b[32m+\u001b[0m .rail { padding: 12px 10px 10px; gap: 2px; }',
  '',
  '\u001b[32m●\u001b[0m 运行 \u001b[1mnpm run verify\u001b[0m',
  '  \u001b[2m✓ Node tests\u001b[0m      42 passed \u001b[2m(3.1s)\u001b[0m',
  '  \u001b[2m✓ Playwright\u001b[0m       61 passed \u001b[2m(28.4s)\u001b[0m',
  '  \u001b[2m✓ TypeScript\u001b[0m       no errors',
  '',
  '\u001b[32m✓\u001b[0m 构建与检查已完成，等待下一条输入\u001b[2m▌\u001b[0m',
].join('\r\n');

const finished = [
  '\u001b[2m  Grok CLI \u001b[0m\u001b[2m·\u001b[0m v1.0.46',
  '',
  '\u001b[1m› 这个目录下有哪些可用的脚本？\u001b[0m',
  '',
  '\u001b[32m●\u001b[0m 读取 \u001b[1mpackage.json\u001b[0m',
  '\u001b[32m●\u001b[0m 找到 6 个脚本：dev · build · verify · test:unit:all · capture · drive',
  '',
  '\u001b[2m会话已结束，输出仍可阅读。\u001b[0m',
].join('\r\n');

const claudeTranscript = [
  '\u001b[2m  Claude Code \u001b[0m\u001b[2m·\u001b[0m claude-sonnet-4-6',
  '',
  '\u001b[35m✻\u001b[0m 正在读取项目结构…',
  '',
  '\u001b[1m❯ 帮我把个人网站的文章页加上目录，并保持移动端可折叠。\u001b[0m',
  '',
  '\u001b[36m⏺\u001b[0m 我先看现有文章页的结构。',
  '  \u001b[2mRead\u001b[0m  src/pages/article.astro',
  '  \u001b[2mRead\u001b[0m  src/components/Prose.astro',
  '  \u001b[32mEdit\u001b[0m  src/components/Toc.astro  \u001b[2m+42 −0\u001b[0m',
  '',
  '\u001b[36m⏺\u001b[0m 目录已加入文章页：',
  '  · 桌面端固定在右侧，滚动时高亮当前小节',
  '  · 移动端折叠为顶部按钮，点击展开',
  '  · 使用 nav + aria-label 保留无障碍语义',
  '',
  '\u001b[1m❯ 跑一下构建\u001b[0m',
  '  \u001b[2mBash\u001b[0m  npm run build',
  '  \u001b[32m✓\u001b[0m built in 1.28s',
  '',
  '\u001b[2m按 Esc 打断，输入继续\u001b[0m',
].join('\r\n');

const openCodeTranscript = [
  '\u001b[2m  OpenCode \u001b[0m\u001b[2m·\u001b[0m v1.18.34 \u001b[2m·\u001b[0m deepseek-v4.1-flash',
  '',
  '\u001b[1m› 汇总 api-service 里的接口与鉴权方式\u001b[0m',
  '',
  '\u001b[32m●\u001b[0m 检索 \u001b[1mroutes/*.ts\u001b[0m \u001b[2m·\u001b[0m 12 个路由',
  '\u001b[32m●\u001b[0m 鉴权走 \u001b[1mBearer\u001b[0m + 项目级 scope',
  '\u001b[32m●\u001b[0m 写入 \u001b[1mdocs/api-overview.md\u001b[0m',
  '',
  '\u001b[2m等待下一条输入\u001b[0m',
].join('\r\n');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function install(page, initialTheme, empty = false) {
  await page.addInitScript(({ theme, transcripts, blank, language }) => {
    try { localStorage.setItem('cliora:language', language); } catch { /* the first document may not expose storage yet */ }
    const names = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const facet = { state: 'available', reason: '' };
    const now = Date.now();
    const projects = [
      { id: 'cliora', name: '栖点 · 桌面工具', path: 'C:\\Projects\\cliora', available: true, preferredTool: 'codex', lastOpened: 1790758800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
      { id: 'site', name: '个人网站', path: 'C:\\Projects\\personal-site', available: true, preferredTool: 'claude_code', lastOpened: 1790738800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
    ];
    const sessions = blank ? [] : [
      { id: 's1', toolId: 'codex', projectId: 'cliora', directory: 'C:\\Projects\\cliora', mode: 'normal', running: true, exitCode: null, startedAt: now - 14 * 60 * 1000 },
      { id: 's2', toolId: 'claude_code', projectId: 'site', directory: 'C:\\Projects\\personal-site', mode: 'yolo', running: true, exitCode: null, startedAt: now - 3 * 60 * 1000 },
      { id: 's3', toolId: 'grok', projectId: null, directory: 'C:\\Projects\\playground', mode: 'normal', running: false, exitCode: 0, startedAt: now - 46 * 60 * 1000 },
      { id: 's4', toolId: 'open_code', projectId: null, directory: 'C:\\Projects\\api-service', mode: 'normal', running: true, exitCode: null, startedAt: now - 52 * 1000 },
    ];
    const bridge = { handlers: [], listens: {} };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command, args = {}) => {
          if (command === 'get_bootstrap' || command === 'set_theme') {
            return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: command === 'set_theme' ? args.theme : theme, tool_icons: {} }, tools: [] };
          }
          if (command === 'list_cli_adapters') return {
            registered: Object.keys(names).map((id) => ({ id, name: names[id], interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: true, projectModelOverride: false, launchForm: 'terminal', nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet })),
            managedIds: Object.keys(names), preservedUnknown: [],
          };
          if (command === 'list_projects') return projects;
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          if (command === 'replay_workbench_session') return transcripts[args.sessionId] ?? transcripts.s1;
          if (command === 'write_workbench_session' || command === 'resize_workbench_session' || command === 'close_workbench_session') return null;
          if (command === 'list_library_items') return args.kind === 'prompt' ? [
            { id: 'p1', kind: 'prompt', title: '代码审查', body: '检查代码变更是否正确、安全、易于维护。', category: '开发', projectId: null, version: 1, updatedAt: 1 },
            { id: 'p2', kind: 'prompt', title: '整理发布说明', body: '根据变更清单写一份简洁的发布说明。', category: '写作', projectId: null, version: 1, updatedAt: 1 },
            { id: 'p3', kind: 'prompt', title: '排查问题', body: '从可以重复出现的现象开始，提出假设并用最小实验验证。', category: '开发', projectId: null, version: 1, updatedAt: 1 },
          ] : [];
          if (command === 'plugin:event|listen') { bridge.listens[args.event] = args.handler; return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'list_history_sessions' || command === 'list_history_prices' || command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_rule_placements' || command === 'list_portable_items' || command === 'list_accounts') return [];
          return null;
        },
      },
      __bell: () => {
        const data = btoa('\u0007');
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's4', dataBase64: data } });
      },
    });
  }, { theme: initialTheme, transcripts: { s1: b64(transcript), s2: b64(claudeTranscript), s3: b64(finished), s4: b64(openCodeTranscript) }, blank: empty, language: english ? 'en' : 'zh' });
}

const manifest = [];
const browser = await chromium.launch();
async function shot(name, theme, width, run, empty = false) {
  const page = await browser.newPage({ viewport: { width, height: Math.max(720, Math.round(width * 0.66)) }, deviceScaleFactor: 1, locale: process.env.CLIORA_CAPTURE_LOCALE ?? 'zh-CN', colorScheme: theme === 'dark' ? 'dark' : 'light' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await install(page, theme, empty);
  await page.goto(previewUrl);
  await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
  await page.waitForTimeout(900);
  if (run) await run(page);
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  await page.screenshot({ path: out + '/' + name + '.png', fullPage: false });
  manifest.push({ name, theme, width, pageErrors: errors, overflow: overflow.scroll > overflow.client ? overflow : null });
  await page.close();
}

const option = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
  return value;
};
const themeOption = option('--theme', 'all');
if (!['all', 'light', 'dark'].includes(themeOption)) throw new Error('Invalid --theme; use all, light or dark');
const sizeOption = option('--size', 'all');
const widths = sizeOption === 'all' ? [1360, 900, 640] : [...new Set(sizeOption.split(',').map(Number))];
if (!widths.length || widths.some((width) => ![1360, 900, 640].includes(width))) throw new Error('Invalid --size; use 1360,900,640');

const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
for (const theme of themes) {
for (const width of widths) {
  await shot('workbench-active-' + theme + '-' + width, theme, width);
  await shot('workbench-composer-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('打开快捷输入面板', 'Open quick input drawer') }).click();
    await stage.getByRole('textbox', { name: /编写多行内容|Compose multi-line/ }).fill('review the diff and summarise the risk in one paragraph');
    await stage.getByRole('button', { name: copy('查找输出', 'Find in output') }).click();
    await stage.getByRole('searchbox', { name: copy('在终端输出中查找…', 'Find in terminal output…') }).fill('SessionWorkbench');
  });
  await shot('workbench-dialog-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('complementary', { name: copy('会话列表', 'Sessions') }).getByRole('button', { name: copy('新建会话', 'New session') }).click();
  });
  await shot('workbench-attention-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => window.__bell());
    await page.getByRole('tab', { name: /Claude Code/ }).click();
  });
  await shot('workbench-ended-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('tab', { name: /Grok/ }).click();
  });
  await shot('workbench-focus-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('region', { name: copy('当前会话', 'Current session') }).getByRole('button', { name: copy('专注模式（隐藏侧栏）', 'Focus mode (hide sidebar)') }).click();
  });
  await shot('workbench-empty-' + theme + '-' + width, theme, width, null, true);
}
}

await browser.close();
const failed = manifest.filter((item) => item.pageErrors.length || item.overflow);
fs.writeFileSync(out + '/capture-workbench-manifest.json', JSON.stringify({ generatedAt: new Date().toISOString(), previewUrl, shots: manifest }, null, 2));

const cards = manifest.map((item) => '    <figure><a href="' + item.name + '.png"><img src="' + item.name + '.png" loading="lazy" alt="' + item.name + '"></a><figcaption>' + item.name + '</figcaption></figure>').join('\n');
fs.writeFileSync(out + '/index.html', [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Cliora 工作台捕获</title><style>',
  'body{margin:0;padding:24px;background:#0f1511;color:#e8f0e9;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}',
  'h1{font-size:18px;margin:0 0 4px}p{margin:0 0 20px;color:#9aa89f}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}',
  'figure{margin:0;background:#161f19;border:1px solid #26332a;border-radius:12px;overflow:hidden}',
  'img{display:block;width:100%;height:auto}figcaption{padding:8px 10px;font-family:Consolas,monospace;font-size:11px;color:#9aa89f}',
  '</style></head><body><h1>Cliora 工作台捕获</h1><p>合成 IPC 数据，仅用于界面检查，不构成原生平台验收。共 ' + manifest.length + ' 张。</p><div class="grid">',
  cards,
  '</div></body></html>',
].join('\n'));

const rows = manifest.map((item) => '| ' + item.name + ' | ' + item.theme + ' | ' + item.width + ' | ' + (item.pageErrors.length ? '页面错误' : '—') + ' | ' + (item.overflow ? '横向溢出' : '—') + ' |').join('\n');
fs.writeFileSync(out + '/README.md', [
  '# 工作台捕获',
  '',
  '[浏览图片画廊](index.html) · [机器可读清单](capture-workbench-manifest.json)',
  '',
  '捕获工作台的会话栏、终端画布、快捷输入与查找、已结束提示、新建会话对话框和空状态，覆盖浅色与深色主题以及 1360 / 900 / 640 三档宽度。',
  '',
  '执行：',
  '',
  '```sh',
  'CLIORA_PREVIEW_URL=http://127.0.0.1:14736 node scripts/capture-workbench.mjs',
  '```',
  '',
  '`--theme all|light|dark` 与 `--size all|1360,900,640` 可缩小范围；`CLIORA_CAPTURE_OUT` 指定输出目录，`CLIORA_CAPTURE_LOCALE=en-US` 捕获英文界面并写入独立目录。预览服务器需运行当前 frontend build。',
  '',
  '终端文本、项目与提示词均为合成数据，仅用于界面检查，不构成真实登录、计费或原生平台验收。',
  '',
  '| 图片 | 主题 | 宽度 | 页面错误 | 溢出 |',
  '| --- | --- | --- | --- | --- |',
  rows,
  '',
].join('\n'));
console.log(JSON.stringify({ shots: manifest.length, failed }, null, 2));
