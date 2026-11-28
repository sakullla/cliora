/** Synthetic workbench fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { settleCapture, previousCaptureCleanup, sceneTheme } from './capture-ready.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const previewUrl = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
const acceptanceNote = 'Playwright 与合成 IPC 截图仅用于浏览器界面检查，不是 WebView2、真实桌面主题/焦点/键盘或原生 CLI/文件写入验收；未执行的平台行为均为未验证。';
const acceptance = { kind: 'playwright-synthetic-ipc', nativePlatform: 'unverified', webview2: 'unverified', desktopThemeFocusKeyboard: 'unverified', nativeCliAndFileWrites: 'unverified', note: acceptanceNote };
const locale = process.env.CLIORA_CAPTURE_LOCALE ?? 'zh-CN';
const english = locale.toLowerCase().startsWith('en');
const copy = (zh, en) => english ? en : zh;
const out = process.env.CLIORA_CAPTURE_OUT ?? root + '/docs/verification/ui-workbench' + (english ? '-en' : '');
fs.mkdirSync(out, { recursive: true });
const prunePrevious = previousCaptureCleanup(out, 'capture-workbench-manifest.json');

let previewReady = false;
for (let attempt = 0; attempt < 50; attempt += 1) {
  try { const response = await fetch(previewUrl, { signal: AbortSignal.timeout(1000) }); if (response.ok) { previewReady = true; break; } } catch { /* preview not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!previewReady) console.error('预览服务未就绪：' + previewUrl + '。请先构建并启动 Vite preview，再运行捕获。');

const transcript = [
  '\u001b[2m  Codex CLI \u001b[0m\u001b[2m·\u001b[0m v0.160.0 \u001b[2m·\u001b[0m model \u001b[1mgpt-6-astra\u001b[0m',
  '',
  '\u001b[36m╭──────────────────────────────────────────────────────────────╮\u001b[0m',
  '\u001b[36m│\u001b[0m  \u001b[1m工作目录\u001b[0m  C:\\Projects\\cliora                              \u001b[36m│\u001b[0m',
  '\u001b[36m│\u001b[0m  \u001b[1m沙盒\u001b[0m      workspace-write · 网络已关闭                    \u001b[36m│\u001b[0m',
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
  '\u001b[1m› 汇总 acme-svc-order-gateway 里的接口与鉴权方式\u001b[0m',
  '',
  '\u001b[32m●\u001b[0m 检索 \u001b[1mroutes/*.ts\u001b[0m \u001b[2m·\u001b[0m 12 个路由',
  '\u001b[32m●\u001b[0m 鉴权走 \u001b[1mBearer\u001b[0m + 项目级 scope',
  '\u001b[32m●\u001b[0m 写入 \u001b[1mdocs/api-overview.md\u001b[0m',
  '',
  '\u001b[2m等待下一条输入\u001b[0m',
].join('\r\n');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

const chromeAgents = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

/** Window metadata makes the app detect a desktop window; macOS gets painted stand-ins for its lights. */
async function installWindowChrome(page, chrome) {
  await page.addInitScript((platform) => {
    const internals = window.__TAURI_INTERNALS__;
    if (internals) internals.metadata = { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } };
    if (platform !== 'macos') return;
    // trafficLightPosition { x: 18, y: 25 }: three 12px buttons, 20px apart, centred near 25px.
    addEventListener('DOMContentLoaded', () => {
      const lights = document.createElement('div');
      lights.setAttribute('aria-hidden', 'true');
      lights.style.cssText = 'position:fixed;z-index:2147483646;top:19px;left:18px;display:flex;gap:8px;pointer-events:none';
      for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
        const dot = document.createElement('span');
        dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 .5px rgb(0 0 0 / 18%)`;
        lights.append(dot);
      }
      document.body.append(lights);
    });
  }, chrome);
}

async function install(page, initialTheme, empty = false, remoteState = null, promptFailure = null, directoryMode = null, writeRecovery = false, acpMode = null) {
  await page.addInitScript(({ theme, transcripts, blank, language, remoteState, promptFailure, directoryMode, writeRecovery, acpMode }) => {
    try { localStorage.setItem('cliora:language', language); } catch { /* the first document may not expose storage yet */ }
    const names = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', pi: 'Pi', open_code: 'OpenCode' };
    const facet = { state: 'available', reason: '' };
    const clockNow = Date.now; let clockOffset = 0; Date.now = () => clockNow() + clockOffset;
    const promptFixture = { fail: promptFailure === 'failed', reads: 0, failures: 0 };
    const now = Date.now();
    const projects = [
      { id: 'cliora', name: '栖点 · 桌面工具', path: 'C:\\Projects\\cliora', available: true, preferredTool: 'codex', lastOpened: 1790758800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
      { id: 'site', name: '个人网站', path: 'C:\\Projects\\personal-site', available: true, preferredTool: 'claude_code', lastOpened: 1790738800, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} },
    ];
    const remoteTargets = [{ id: 'remote-prod', name: '测试远程主机', host: '212.60.153.19', port: 22, user: 'root', authMethod: 'key', identityFile: 'C:/Users/demo/.ssh/id_ed25519', sshConfig: null, defaultPath: '/srv', enabled: true, createdAt: now, updatedAt: now }];
    if (writeRecovery) localStorage.setItem('cliora:remote-writes:v1', JSON.stringify([{ id: '6754f794-3c8a-4cb3-aec1-5f5dcb197b36', targetId: 'remote-prod', targetRevision: now, identity: 'synthetic', outcome: 'recovering', items: [{ path: '$HOME/.codex/config.toml', before: 'a'.repeat(64), after: 'b'.repeat(64), state: 'applying', observed: null }] }]));
    if (directoryMode === 'password') remoteTargets[0].authMethod = 'password';
    const directoryFixture = { failure: false, creates: 0, release: () => {} };
    const directoryReceipts = [];
    const remoteProjects = [{ id: 'remote-project', targetId: 'remote-prod', name: '远程 CLI 项目', path: '/srv/project', preferredTool: 'pi', updatedAt: now }];
    const sessions = blank ? [] : [
      { id: 's1', toolId: 'codex', projectId: 'cliora', directory: 'C:\\Projects\\cliora', mode: 'normal', running: true, exitCode: null, startedAt: now - 14 * 60 * 1000 },
      { id: 's2', toolId: 'claude_code', projectId: 'site', directory: 'C:\\Projects\\personal-site', mode: 'yolo', running: true, exitCode: null, startedAt: now - 3 * 60 * 1000 },
      { id: 's3', toolId: 'grok', projectId: null, directory: 'C:\\Projects\\acme-svc-order-billing', mode: 'normal', running: false, exitCode: 0, startedAt: now - 46 * 60 * 1000 },
      { id: 's4', toolId: 'open_code', projectId: null, directory: 'C:\\Projects\\acme-svc-order-gateway', mode: 'normal', running: true, exitCode: null, startedAt: now - 52 * 1000 },
    ];
    if (remoteState) {
      localStorage.setItem('cliora:remote-target', 'remote-prod');
      sessions.splice(0, sessions.length, ...['a', 'b', 'c'].map((letter, index) => ({
        id: `r${index + 1}`, toolId: 'pi', projectId: 'remote:remote-project', directory: '/srv/project',
        mode: 'normal', running: index > 0 || remoteState === 'connected' || remoteState === 'connecting',
        exitCode: index > 0 || remoteState === 'connected' || remoteState === 'connecting' ? null : remoteState === 'disconnected' ? 255 : 46,
        connectionState: index === 0 ? remoteState : 'connected', reattachable: index === 0 && ['unknown', 'disconnected'].includes(remoteState),
        remoteSessionId: `cliora-same-directory-${letter}`, startedAt: now - (index + 1) * 60000,
        remoteEndResult: index === 0 && remoteState === 'unknown' ? { outcome: 'unknown', stage: 'timeout', exitCode: null } : null,
      })));
      localStorage.setItem('cliora:workbench-selected', 'r1');
    }
    const bridge = { handlers: [], listens: {} };
    // The restore scenes are set from the test body, so they survive the reload that re-runs
    // this init script: the fixture lives in storage, not in a global.
    let restoreFixture = null;
    try { restoreFixture = JSON.parse(localStorage.getItem('capture:restore') ?? 'null'); } catch { /* optional */ }
    // One ACP conversation fixture. It is a snapshot plus ordered increments, exactly the
    // shape the shared host publishes (an ordered timeline); nothing here spawns an agent.
    const acpMessage = (id, role, text) => ({ kind: 'message', id, role, text, truncated: false, turnId: 'turn-1', subagent: null });
    const acpTool = (callId, title, toolKind, status, extra = {}) => ({
      kind: 'tool', id: 'tool:' + callId, callId, title, toolKind, status, content: [], locations: [], rawInput: null,
      turnId: 'turn-1', subagent: null, permission: null, ...extra,
    });
    const acpStyles = 'C:\\Projects\\cliora\\src\\features\\sessions\\SessionWorkbench.module.css';
    // T5 input scenes: 'composer' declares commands, modes, options, images and history;
    // 'login' waits for a login; 'form' waits on an elicitation form.
    // T6 scenes: 'empty' has not been asked anything yet; 'long' is a many-turn
    // conversation with Markdown; 'tools' shows each tool shape (diff, embedded terminal,
    // locations, a failure); 'yolo' runs in YOLO with its automatic approvals recorded;
    // 'disconnected' is a conversation whose agent process went away mid-turn.
    // 'access' waits on Cliora's own approval card for a read outside the session
    // directory, while an earlier session grant for writes shows as a revocable badge.
    // Timeline reading scenes: 'startup' folds what the agent said before the first
    // prompt into one line and names the agent once in the round; 'process' is a turn
    // still at work (compact steps, older ones folded, the current action on its last
    // line); 'process-done' is the same turn ended, folded into its summary with a failed
    // step listed and the reply after it.
    // Queue and picture scenes: 'queue' is a turn at work that prompts are queued behind
    // (the scene steps type them and push the host's later snapshots); 'images' is a
    // ready conversation whose earlier message was replayed without its picture data.
    const acpState = acpMode === 'starting' ? 'starting' : acpMode === 'stopping' ? 'stopping' : acpMode === 'permission' || acpMode === 'form' || acpMode === 'access' ? 'waiting_permission' : acpMode === 'login' ? 'auth_required'
      : acpMode === 'disconnected' ? 'closed' : acpMode === 'tools' || acpMode === 'process' || acpMode === 'queue' ? 'running' : 'ready';
    const acpNativeId = acpMode === 'login' ? null : 'native-acp-1';
    const acpAuthError = acpMode === 'login' ? 'agent 要求先登录：没有找到有效的凭据' : null;
    const acpEnd = (turnId, reason = 'end_turn') => ({ kind: 'turn', id: turnId + '-end', turnId, reason });
    const acpTurnMessage = (id, role, text, turnId) => ({ ...acpMessage(id, role, text), turnId });
    const acpLong = () => {
      const topics = [
        ['工具栏的按钮间距从哪里来？', '来自 `SessionWorkbench.module.css` 里两处固定像素值：\n\n- 工具栏内边距 `padding: 6px 10px`\n- 按钮之间的 `gap: 6px`\n\n两处都没有走共享令牌。'],
        ['换成令牌之后会怎样？', '改成 `--space-1` 与 `--space-2` 相加：\n\n```css\n.toolbar {\n  padding: var(--space-1) calc(var(--space-1) + var(--space-2));\n  gap: calc(var(--space-1) + var(--space-0_5));\n}\n```\n\n深浅主题共用同一组令牌，不需要分别调整。'],
        ['窄窗口会不会溢出？', '| 宽度 | 改前 | 改后 |\n| --- | --- | --- |\n| 1360 | 正常 | 正常 |\n| 900 | 正常 | 正常 |\n| 720 | 横向溢出 4px | 正常 |\n\n720px 下原来多出的 4px 来自 gap 叠加。'],
        ['样式检查要怎么跑？', '运行 `node --test tests/native/style-tokens.test.mjs`。它会扫描所有 `*.module.css`，报告没有使用令牌的像素值。参考 [样式令牌说明](https://example.com/tokens)。'],
        ['顺便看看图标按钮的圆角？', '图标按钮用的是 `--radius-sm`，和输入框一致，这次不用改。'],
        ['最后汇总一下改动。', '1. 工具栏内边距与 gap 改为令牌相加；\n2. 样式检查通过，没有新的像素值；\n3. 720px 下不再横向溢出。\n\n可以提交了。'],
      ];
      return topics.flatMap(([question, answer], index) => {
        const turn = 'turn-' + (index + 1);
        return [acpTurnMessage('u' + index, 'user', question, turn), acpTurnMessage('a' + index, 'agent', answer, turn), acpEnd(turn)];
      });
    };
    const acpStartup = () => [
      { ...acpMessage('s1', 'agent', '## Context\n\n- AGENTS.md\n- docs/requirements\n\n## Extensions\n\n- pi-acp-bridge 0.0.35\n- git-worktrees'), turnId: '' },
      acpMessage('m1', 'user', 'hi'),
      acpMessage('m2', 'thought', '用户在打招呼，简单回应并询问要做什么。'),
      acpMessage('m3', 'agent', '你好！要处理哪一部分？\n\n### 可以帮你\n\n- 修改工具栏样式\n- 跑一次样式检查'),
      acpEnd('turn-1'),
    ];
    const acpProcess = (done) => [
      acpMessage('m1', 'user', '把 R13 补进需求，然后跑一遍检查和构建。'),
      acpMessage('p0', 'thought', '先看需求文档的结构，确认 R13 放在哪里。'),
      acpTool('x0', 'git status --short', 'execute', 'completed', { rawInput: '{"command":"git status --short"}' }),
      acpMessage('p1', 'thought', '需要确认 R13 的编号没有被占用。'),
      acpTool('r0', '读取 docs/requirements/2026-11-28-ACP对话界面体验优化.md', 'read', 'completed', { locations: [{ path: 'docs/requirements/2026-11-28-ACP对话界面体验优化.md', line: 186 }] }),
      acpTool('x1', 'rg -n "R13" docs/requirements', 'execute', 'completed'),
      acpMessage('p2', 'thought', '编号没有冲突，可以直接追加。'),
      acpTool('e0', '编辑 docs/requirements/2026-11-28-ACP对话界面体验优化.md', 'edit', 'completed', { content: [{ type: 'diff', path: 'docs/requirements/2026-11-28-ACP对话界面体验优化.md', oldText: '### R14', newText: '### R13 超大会话的性能与内存\n\n### R14', truncated: false }] }),
      acpMessage('p3', 'agent', 'Now I\'ll add R13 to the requirement and run the checks.'),
      acpMessage('p4', 'thought', '写完后跑检查。'),
      acpTool('x2', 'node --test tests/native/acp-ui-model.test.mjs', 'execute', done ? 'failed' : 'completed', { content: done ? [{ type: 'text', text: '✖ buildSegments counts steps (2ms)\nℹ fail 1', truncated: false }] : [] }),
      acpTool('x3', 'npm run lint', 'execute', 'completed'),
      acpMessage('p5', 'thought', '最后构建一次。'),
      acpTool('x4', 'npm run build', 'execute', done ? 'completed' : 'in_progress', { rawInput: '{"command":"npm run build"}' }),
      ...(done ? [acpMessage('m9', 'agent', 'R13 已补进需求。构建通过，但 `acp-ui-model` 有 1 个用例失败，原因见上方失败的步骤。'), acpEnd('turn-1')] : []),
    ];
    const acpTools = () => [
      acpMessage('m1', 'user', '把工具栏间距改成令牌，跑一次样式检查，再看看还有哪些地方写死了像素。'),
      acpTool('t1', '读取 SessionWorkbench.module.css', 'read', 'completed', { locations: [{ path: acpStyles, line: 86 }, { path: 'D:\\shared\\tokens.css', line: 12 }] }),
      acpTool('t2', '搜索固定像素值', 'search', 'completed', { content: [{ type: 'text', text: 'src/features/sessions/SessionWorkbench.module.css:86  gap: 6px;\nsrc/features/sessions/SessionWorkbench.module.css:91  padding: 6px 10px;', truncated: false }] }),
      acpTool('t3', '编辑 SessionWorkbench.module.css', 'edit', 'completed', { locations: [{ path: acpStyles, line: 86 }], content: [{ type: 'diff', path: acpStyles,
        oldText: '.toolbar {\n  display: flex;\n  padding: 6px 10px;\n  gap: 6px;\n}', newText: '.toolbar {\n  display: flex;\n  padding: var(--space-1) calc(var(--space-1) + var(--space-2));\n  gap: calc(var(--space-1) + var(--space-0_5));\n}', truncated: false }] }),
      { kind: 'access', id: 'access-w1', accessKind: 'write', path: acpStyles, detail: null, decision: 'inside', requestId: null, turnId: 'turn-1', subagent: null, userPath: null,
        diff: { path: 'src/features/sessions/SessionWorkbench.module.css', oldText: '  gap: 6px;\n', newText: '  gap: calc(var(--space-1) + var(--space-0_5));\n', truncated: false, previousOmitted: false } },
      acpTool('t4', '获取样式令牌说明', 'fetch', 'failed', { rawInput: '{"url":"https://example.com/tokens"}', content: [{ type: 'text', text: '请求超时：30 秒内没有响应', truncated: false }] }),
      acpTool('t5', '运行样式检查', 'execute', 'completed', { rawInput: '{"command":"node --test tests/native/style-tokens.test.mjs"}', content: [{ type: 'terminal', terminalId: 'term-1' }] }),
      acpMessage('m2', 'agent', '样式检查通过。还剩 `AcpConversation.module.css` 里一处 `margin: 3px`，接着处理。'),
      acpTool('t6', '运行 npm run build', 'execute', 'in_progress', { rawInput: '{"command":"npm run build"}', content: [{ type: 'terminal', terminalId: 'term-2' }] }),
    ];
    const acpTerminals = acpMode === 'tools' ? [
      { terminalId: 'term-1', command: 'node --test tests/native/style-tokens.test.mjs', cwd: 'C:\\Projects\\cliora', output: '✔ tokens are used for spacing (12ms)\n✔ no raw pixel values (8ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n', truncated: false, exitStatus: { exitCode: 0, signal: null }, released: true, subagent: null, agentOwned: false },
      { terminalId: 'term-2', command: 'npm run build', cwd: 'C:\\Projects\\cliora', output: '> cliora@0.5.0 build\n> tsc -b && vite build\n\nvite v6 building for production...\ntransforming (812) src/features/sessions/AcpConversation.tsx\n', truncated: false, exitStatus: null, released: false, subagent: null, agentOwned: false },
    ] : [];
    const acpYolo = () => [
      acpMessage('m1', 'user', '在 D:\\shared 下生成一份令牌报告，然后跑一次测试。'),
      acpTool('y1', '写入 D:\\shared\\tokens-report.md', 'edit', 'completed', { locations: [{ path: 'D:\\shared\\tokens-report.md', line: null }] }),
      { kind: 'access', id: 'access-y1', accessKind: 'write', path: 'D:\\shared\\tokens-report.md', detail: null, decision: 'yolo', requestId: null, diff: { path: 'D:\\shared\\tokens-report.md', oldText: null, newText: '# 令牌报告\n\n- 间距：全部使用令牌\n', truncated: false, previousOmitted: false }, turnId: 'turn-1', subagent: null, userPath: null },
      acpTool('y2', '运行 npm test', 'execute', 'completed', { rawInput: '{"command":"npm test"}' }),
      { kind: 'notice', id: 'n-yolo', level: 'info', code: 'yolo_allowed', text: '已自动允许：运行 npm test（允许一次）', turnId: 'turn-1' },
      { kind: 'access', id: 'access-y2', accessKind: 'read', path: 'D:\\shared\\tokens.css', detail: null, decision: 'yolo', requestId: null, diff: null, turnId: 'turn-1', subagent: null, userPath: null },
      acpMessage('m2', 'agent', '报告已写到 `D:\\shared\\tokens-report.md`，测试全部通过。'),
      acpEnd('turn-1'),
    ];
    const acpDisconnected = () => [
      acpMessage('m1', 'user', '把终端工具栏的间距改成令牌相加，并跑一次样式检查。'),
      acpMessage('m3', 'agent', '我先读工具栏样式和令牌定义，确认间距现在来自哪里。'),
      acpTool('c1', 'read_file', 'read', 'completed', { locations: [{ path: acpStyles, line: 86 }] }),
      acpTool('c3', 'run_command', 'execute', 'failed', { rawInput: '{"command":"node --test tests/native/style-tokens.test.mjs"}' }),
      { kind: 'notice', id: 'n-exit', level: 'error', code: '', text: 'agent 进程已退出（退出码 1），连接已断开', turnId: 'turn-1' },
      acpEnd('turn-1', 'disconnected'),
    ];
    // The turn is still running: the approval card waits for an answer, so no turn end yet.
    const acpAccess = () => [
      acpMessage('m1', 'user', '对照 D:\\shared 里的共享令牌，把工具栏间距改成令牌相加，并写一份改动说明到 D:\\shared。'),
      acpMessage('m3', 'agent', '先把改动说明写到共享目录，再读取共享令牌定义核对间距。'),
      { kind: 'access', id: 'access-w1', accessKind: 'write', path: 'D:\\shared\\toolbar-notes.md', detail: null, decision: 'allowed_session', requestId: null, turnId: 'turn-1', subagent: null, userPath: null,
        diff: { path: 'D:\\shared\\toolbar-notes.md', oldText: null, newText: '# 工具栏间距\n\n- 改为 --space-1 与 --space-2 相加\n', truncated: false, previousOmitted: false } },
      acpTool('c1', 'read_file', 'read', 'completed', { locations: [{ path: acpStyles, line: 86 }] }),
      acpTool('c5', '读取 D:\\shared\\tokens.css', 'read', 'in_progress', { locations: [{ path: 'D:\\shared\\tokens.css', line: null }] }),
      { kind: 'access', id: 'access-r1', accessKind: 'read', path: 'D:\\shared\\tokens.css', detail: null, decision: 'pending', requestId: 'access-r1-request', diff: null, turnId: 'turn-1', subagent: null, userPath: null },
    ];
    const acpImages = () => [
      { ...acpTurnMessage('i0', 'user', '照着这张截图调整工具栏的间距。', 'turn-0'), attachments: [{ type: 'image', name: 'image/png', delivery: null }, { type: 'file', name: 'src/features/sessions/SessionWorkbench.module.css', delivery: 'link' }] },
      acpTurnMessage('i1', 'agent', '截图里按钮之间的间距是 6px，和令牌不一致。我改成 `--space-1_5`。', 'turn-0'),
      acpEnd('turn-0'),
    ];
    const acpTimeline = acpMode === 'empty' || acpMode === 'starting' ? [] : acpMode === 'long' ? acpLong() : acpMode === 'startup' ? acpStartup()
      : acpMode === 'process' || acpMode === 'process-done' || acpMode === 'queue' ? acpProcess(acpMode === 'process-done') : acpMode === 'tools' ? acpTools() : acpMode === 'yolo' ? acpYolo() : acpMode === 'disconnected' ? acpDisconnected() : acpMode === 'access' ? acpAccess()
        : acpMode === 'images' ? acpImages() : null;
    const acpFixture = acpMode ? [{
      id: 'acp1', toolId: 'codex', projectId: 'cliora', directory: 'C:\\Projects\\cliora', mode: acpMode === 'yolo' ? 'yolo' : 'normal', interaction: 'acp',
      state: acpState,
      nativeSessionId: acpNativeId, resume: 'none', authError: acpAuthError,
      timeline: acpTimeline ?? [
        acpMessage('m1', 'user', '把终端工具栏的间距改成令牌相加，并跑一次样式检查。'),
        acpMessage('m2', 'thought', '先确认工具栏当前的间距来源，再改令牌，避免再写死像素值。'),
        acpMessage('m3', 'agent', '我先读工具栏样式和令牌定义，确认间距现在来自哪里。'),
        acpTool('c1', 'read_file', 'read', 'completed', { locations: [{ path: acpStyles, line: 86 }] }),
        acpTool('c2', 'edit_file', 'edit', 'completed', { content: [{ type: 'diff', path: acpStyles, oldText: 'gap: 6px;', newText: 'gap: var(--space-1_5);', truncated: false }] }),
        acpTool('c3', 'run_command', 'execute', acpMode === 'stopping' ? 'in_progress' : 'completed', { rawInput: '{"command":"node --test tests/native/style-tokens.test.mjs"}' }),
        // The reply follows the turn's last tool call, after its folded work process.
        acpMessage('m4', 'agent', '间距来自两处固定像素值：工具栏内边距和按钮之间的 gap。改成 --space-1 与 --space-2 相加后，深浅主题与 760px 窄窗口都不再溢出。'),
        ...(acpMode === 'permission' ? [acpTool('c4', '运行 npm run verify', 'execute', 'pending', {
          rawInput: '{"command":"npm run verify","cwd":"C:\\\\Projects\\\\cliora"}',
          permission: {
            requestId: 'r1', turnId: 'turn-1',
            options: [
              { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
              { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
              { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
            ],
          },
        })] : []),
        // A turn still waiting on a card or stopping has not ended.
        ...(acpMode === 'stopping' || acpMode === 'form' || acpMode === 'permission' ? [] : [{ kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'end_turn' }]),
        ...(acpMode === 'form' ? [{
          kind: 'elicitation', id: 'e1', message: '发布前请补充版本信息。', toolCallId: null, decision: 'pending', requestId: 'q1', turnId: 'turn-1', subagent: null,
          requestedSchema: { type: 'object', required: ['version', 'channel'], properties: {
            version: { type: 'string', title: '版本号', description: '例如 0.5.0', minLength: 5 },
            channel: { type: 'string', title: '发布渠道', oneOf: [{ const: 'stable', title: '稳定版' }, { const: 'beta', title: '测试版' }] },
            notes: { type: 'array', title: '附带内容', items: { enum: ['更新日志', '迁移说明'] } },
            notify: { type: 'boolean', title: '完成后通知', default: true },
          } },
        }] : []),
      ],
      pending: acpMode === 'permission' ? ['r1'] : acpMode === 'form' ? ['q1'] : acpMode === 'access' ? ['access-r1-request'] : [],
      grants: acpMode === 'access' ? ['write'] : [],
      terminals: acpTerminals,
      omittedTerminalIds: [],
      plan: acpMode === 'empty' || acpMode === 'starting' || acpMode === 'long' || acpMode === 'yolo' || acpMode === 'startup' || acpMode === 'process' || acpMode === 'process-done' || acpMode === 'queue' || acpMode === 'images' ? [] : acpMode === 'tools' ? [
        { content: '读取工具栏样式与令牌', priority: 'high', status: 'completed' },
        { content: '把固定像素换成令牌相加', priority: 'high', status: 'completed' },
        { content: '运行样式检查', priority: 'medium', status: 'completed' },
        { content: '处理剩余的写死像素', priority: 'medium', status: 'in_progress' },
        { content: '重新构建并截图核对', priority: 'low', status: 'pending' },
      ] : acpMode === 'access' ? [
        { content: '写改动说明到共享目录', priority: 'medium', status: 'completed' },
        { content: '读取共享令牌定义', priority: 'high', status: 'in_progress' },
        { content: '把固定像素换成令牌相加', priority: 'high', status: 'pending' },
      ] : [
        { content: '读取工具栏样式与令牌', priority: 'high', status: 'completed' },
        { content: '把固定像素换成令牌相加', priority: 'high', status: 'completed' },
        { content: '运行样式检查', priority: 'medium', status: acpMode === 'stopping' ? 'in_progress' : 'completed' },
      ],
      commands: acpMode === 'composer' ? [
        { name: 'review', description: '审查当前改动', hint: null },
        { name: 'init', description: '生成 AGENTS.md', hint: '目录' },
        { name: 'compact', description: '压缩上下文，保留要点', hint: null },
      ] : [],
      config: acpMode === 'composer' ? {
        modes: { currentModeId: 'code', availableModes: [{ id: 'ask', name: '提问', description: null }, { id: 'code', name: '写代码', description: '可以改文件' }] },
        options: [
          { id: 'effort', name: '思考强度', description: null, category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low', name: '低', description: null, group: null }, { value: 'medium', name: '中', description: null, group: null }, { value: 'high', name: '高', description: null, group: null }] },
          { id: 'web', name: '联网搜索', description: null, category: null, type: 'boolean', currentValue: true, options: [] },
        ],
        models: { currentModelId: 'gpt-5-codex', availableModels: [{ modelId: 'gpt-5-codex', name: 'GPT-5 Codex', description: null }, { modelId: 'gpt-5-mini', name: 'GPT-5 mini', description: null }] },
      } : { modes: null, options: [], models: null },
      info: acpMode === 'empty' ? { title: null, updatedAt: null, usage: null }
        : { title: '工具栏间距改用令牌', updatedAt: null, usage: acpMode === 'tools' || acpMode === 'long' ? { used: 48200, size: 200000, cost: acpMode === 'tools' ? { amount: 0.0412, currency: 'USD' } : null } : null },
      agent: {
        protocolVersion: 1, agentInfo: { name: 'codex-acp', title: 'Codex', version: '0.1.0' },
        promptCapabilities: { image: acpMode === 'composer' || acpMode === 'images', audio: false, embeddedContext: acpMode === 'composer' },
        sessionCapabilities: { list: acpMode === 'composer', resume: acpMode === 'composer', delete: acpMode === 'composer', close: false }, loadSession: false,
        authMethods: acpMode === 'login' ? [
          { id: 'chatgpt', name: 'ChatGPT 账号', description: '在浏览器里完成登录', type: 'agent' },
          { id: 'api-key', name: 'API 密钥', description: '设置 OPENAI_API_KEY 后重试', type: 'env_var' },
        ] : [],
      },
      diagnostics: acpMode === 'stopping' ? ['agent 标准错误：正在结束本轮（已脱敏）'] : acpMode === 'disconnected' ? ['agent 标准错误：unexpected EOF on stdin（已脱敏）'] : [],
      lastTurnReason: acpMode === 'starting' || acpMode === 'stopping' || acpMode === 'empty' || acpMode === 'tools' || acpMode === 'permission' || acpMode === 'access' || acpMode === 'process' || acpMode === 'queue' ? '' : acpMode === 'disconnected' ? 'disconnected' : 'end_turn',
      seq: 24,
    }, ...(acpMode === 'split' ? [{
      id: 'acp2', toolId: 'claude_code', projectId: 'site', directory: 'C:\\Projects\\personal-site', mode: 'yolo', interaction: 'acp',
      state: 'ready', nativeSessionId: 'native-acp-2', resume: 'none', authError: null,
      timeline: acpYolo(), pending: [], grants: [], terminals: [], plan: [], commands: [],
      config: { modes: null, options: [], models: null },
      info: { title: '分屏 YOLO 对比会话', updatedAt: null, usage: { used: 24100, size: 200000, cost: null } },
      agent: {
        protocolVersion: 1, agentInfo: { name: 'claude-acp', title: 'Claude Code', version: '0.2.0' },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [],
      },
      diagnostics: [], lastTurnReason: 'end_turn', seq: 12,
    }] : [])] : null;
    if (acpMode) {
      localStorage.setItem('cliora:workbench-selected', 'acp1');
      localStorage.setItem('cliora:remote-target', 'local');
    }
    Object.assign(window, {
      isTauri: true,
      __releaseRestore: null,
      __promptFixture: promptFixture,
      __directoryFixture: directoryFixture,
      __failRemotePrompts: () => { promptFixture.fail = true; clockOffset += 31000; },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback) => { bridge.handlers.push(callback); return bridge.handlers.length - 1; },
        invoke: async (command, args = {}) => {
          if (command === 'get_bootstrap' || command === 'set_theme' || command === 'set_language') {
            return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: command === 'set_theme' ? args.theme : theme, tool_icons: {}, remote_ssh_enabled: true, language }, tools: [] };
          }
          if (command === 'list_cli_adapters') return {
            registered: Object.keys(names).map((id) => ({ id, name: names[id], interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: true, projectModelOverride: false, launchForm: 'terminal', nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet })),
            managedIds: Object.keys(names), preservedUnknown: [],
          };
          if (command === 'list_projects') return projects;
          if (command === 'list_remote_targets') return remoteTargets;
          if (command === 'list_remote_projects') return remoteProjects;
          if (command === 'probe_remote_cli') return { targetId: args.targetId, toolId: args.toolId, executable: args.toolId === 'pi' ? 'pi' : args.toolId, installed: true, version: '0.164.0', detail: null };
          // Receipts are the SQLite side of a remote mkdir; this fixture keeps the same contract in memory.
          if (command === 'list_remote_directory_receipts') return directoryReceipts.map((item) => ({ ...item }));
          if (command === 'save_remote_directory_receipt') {
            const receipt = args.receipt;
            const index = directoryReceipts.findIndex((item) => item.id === receipt.id);
            if (index >= 0) directoryReceipts.splice(index, 1, receipt); else directoryReceipts.push(receipt);
            return null;
          }
          if (command === 'list_remote_directories') {
            if (directoryMode === 'loading') await new Promise(() => {});
            if (directoryFixture.failure) throw { message: 'Permission denied: directory requires read and search access', action: '检查远端目标目录和文件权限。' };
            return { parent: args.parent, items: ['/srv/project', '/srv/services', '/srv/tools'], truncated: false };
          }
          if (command === 'create_remote_directory') {
            directoryFixture.creates++;
            if (directoryMode?.startsWith('receipt-')) {
              await new Promise(resolve => { directoryFixture.release = resolve; });
              throw { code: 'remote_unknown', message: '远端可能已执行；结果尚未确认。', action: '核查原路径后再操作。', remote: { outcome: 'unknown' } };
            }
            return null;
          }
          if (command === 'save_remote_project') { const saved = { ...args.project, id: args.project.id || 'remote-created', updatedAt: Date.now() }; remoteProjects.splice(0, remoteProjects.length, ...remoteProjects.filter((item) => item.id !== saved.id), saved); return saved; }
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal', interaction: acpMode ? 'acp' : 'terminal' };
          // ACP conversations come from the shared host, not from the PTY list.
          if (command === 'list_acp_sessions') return acpFixture ? acpFixture.map((item) => ({ ...item })) : [];
          if (command === 'acp_session') return acpFixture?.find((item) => item.id === args.sessionId) ?? null;
          if (command === 'acp_dependency_installed') return true;
          if (command === 'acp_prompt' || command === 'acp_cancel' || command === 'acp_respond_permission' || command === 'acp_respond_access' || command === 'acp_revoke_grants' || command === 'acp_kill_terminal' || command === 'acp_set_mode' || command === 'acp_set_config' || command === 'acp_close'
            || command === 'acp_authenticate' || command === 'acp_respond_elicitation' || command === 'acp_delete_native_session') return null;
          // A dropped picture: a tiny PNG the tray previews; one named "reading" stays
          // in the host's hands so the tray's reading state can be captured.
          if (command === 'acp_read_image' && String(args.path).includes('reading')) return new Promise(() => {});
          if (command === 'acp_read_image') return { name: String(args.path).split(/[\\/]/).pop(), mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', size: 70 };
          if (command === 'acp_list_files') return { files: ['src/features/sessions/SessionWorkbench.module.css', 'src/features/sessions/AcpConversation.tsx'], truncated: false, source: 'git' };
          if (command === 'acp_native_sessions') return acpMode === 'composer' ? { sessions: [
            { nativeId: 'native-acp-1', title: '工具栏间距改用令牌', updatedAt: '2026-11-27T08:00:00Z', cwd: 'C:\\Projects\\cliora', current: true },
            { nativeId: 'native-acp-0', title: '修复登录后的恢复提示', updatedAt: '2026-11-26T09:30:00Z', cwd: 'C:\\Projects\\cliora', current: false },
            { nativeId: 'native-acp-x', title: null, updatedAt: '2026-11-20T16:05:00Z', cwd: 'C:\\Projects\\cliora', current: false },
          ], nextCursor: 'page-1' } : { sessions: [], nextCursor: null };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_workbench_sessions') return sessions.map((item) => ({ ...item }));
          // Saved records for the per-record restore scenes; absent means "nothing to restore".
          if (command === 'list_workbench_restore_sessions') return restoreFixture?.saved ?? [];
          if (command === 'restore_workbench_sessions') {
            const restored = {};
            const failures = [];
            const emit = (payload) => bridge.handlers[bridge.listens['cliora:workbench-restore']]?.({ payload: { restoreId: 'capture-restore', detail: null, candidates: [], session: null, ...payload } });
            for (const step of restoreFixture?.script ?? []) {
              if (step.event) {
                if (step.event.stage === 'restored') {
                  sessions.push(step.event.session);
                  restored[step.event.savedSessionId] = step.event.session.id;
                } else if (step.event.stage === 'failed') {
                  const saved = (restoreFixture?.saved ?? []).find((item) => item.id === step.event.savedSessionId);
                  failures.push({ session: saved, detail: step.event.detail ?? '', candidates: step.event.candidates ?? [] });
                }
                emit(step.event);
              }
              if (step.hold) await new Promise((resolve) => { window.__releaseRestore = resolve; });
            }
            return { restored, failures };
          }
          if (command === 'replay_workbench_session') return transcripts[args.sessionId] ?? transcripts.s1;
          if (command === 'workbench_git_context') return args.sessionId === 's1' ? { branch: 'feature/workbench-polish', commit: null, worktree: 'cliora-polish', repository: 'cliora' } : { branch: 'main', commit: null, worktree: null, repository: 'cliora' };
          if (command === 'git_worktrees') {
            if (window.__captureWorktreeReadFails) throw { message: '无法读取工作树列表：git status 失败', action: '检查仓库后重试。' };
            if (window.__captureManyWorktrees) return Array.from({ length: window.__captureManyWorktrees }, (_, index) => index === 1
              ? { name: 'cliora-polish', branch: 'feature/workbench-polish', path: '/repo/cliora-polish', current: true }
              : { name: 'cliora-wt-' + String(index).padStart(3, '0'), branch: (index % 3 ? 'feat/task-' : 'fix/issue-') + index, path: '/repo/worktrees/cliora-wt-' + String(index).padStart(3, '0'), current: false });
            return [
              { name: 'cliora', branch: 'main', path: '/repo/cliora', current: false },
              { name: 'cliora-polish', branch: 'feature/workbench-polish', path: '/repo/cliora-polish', current: true },
              { name: 'cliora-long', branch: 'feature/workbench-polish-with-a-long-branch-name', path: '/repo/cliora-long', current: false },
            ];
          }
          if (command === 'worktree_base_preview' || command === 'worktree_base_update') {
            if (command === 'worktree_base_update' && window.__captureBaseUpdateFails) throw { message: '更新远程基点失败：网络不可用', action: '重试或使用缓存基点。' };
            const base = args.base ?? null;
            const reference = base && base.kind === 'reference' ? base.reference : 'origin/main';
            const taskLine = String(args.taskText ?? '').trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean);
            return { kind: (base && base.kind) || 'default', reference, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', shortCommit: 'a1b2c3d',
              remote: 'origin', branch: reference.split('/').slice(1).join('/'), degraded: null, candidates: [], available: true, reason: null,
              // Same rule as native: the first task line, else the repository name.
              proposedBranch: taskLine ? taskLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'cliora' };
          }
          if (command === 'worktree_status') {
            if ((window.__captureStatusFails ?? []).includes(args.directory)) throw { message: '无法读取工作树状态：git 返回非零退出码' };
            const preset = (window.__captureStatus ?? {})[args.directory];
            if (preset) return preset;
            if (args.directory === '/repo/cliora') return { worktreePath: args.directory, managed: false, environment: null, branch: 'main', headOid: null, uncommittedFiles: 2, state: 'ready', reason: null };
            return { worktreePath: args.directory, managed: true, environment: 'unprepared', branch: 'feature/workbench-polish', headOid: null, uncommittedFiles: 0, state: 'ready', reason: null };
          }
          if (command === 'list_worktree_ledger') return window.__captureLedger ?? [];
          if (command === 'worktree_prepare') return window.__capturePrepare ?? null;
          if (command === 'save_worktree_prepare') { window.__capturePrepare = args.command; return { mainCheckout: args.directory, command: args.command }; }
          if (command === 'cleanup_worktree') return { removed: false, needsConfirmation: false, detail: '' };
          if (command === 'launch_cli') {
            const request = args.request ?? {};
            const operationId = request.worktree && request.worktree.operationId;
            const stage = (name, extra = {}) => {
              if (!operationId) return;
              bridge.handlers[bridge.listens['cliora:worktree-launch']]?.({ payload: { operationId, stage: name, worktreePath: null, branch: null, sessionId: null, error: null, ...extra } });
            };
            const directory = (request.worktree && request.worktree.retryDirectory) || 'C:\\Projects\\cliora-polish';
            for (const step of window.__worktreeScript ?? []) {
              if (step.event) stage(step.event.stage, { worktreePath: step.event.worktreePath ?? null, branch: step.event.branch ?? null, error: step.event.error ?? null });
              if (step.hold) await new Promise((resolve) => { window.__releaseWorktree = resolve; });
            }
            if (window.__worktreeScriptFail) throw { message: window.__worktreeScriptFail, action: '修正环境准备命令后重试。' };
            const id = 'launched-worktree';
            sessions.unshift({ id, toolId: request.toolId ?? 'codex', projectId: request.projectId ?? 'cliora', directory, mode: request.mode ?? 'normal', running: true, exitCode: null, startedAt: now });
            stage('succeeded', { worktreePath: directory, sessionId: id });
            return { toolId: request.toolId ?? 'codex', projectId: request.projectId ?? 'cliora', mode: request.mode ?? 'normal', terminal: 'workbench', status: 'session_started', sessionId: id };
          }
          if (command === 'write_workbench_session' || command === 'resize_workbench_session' || command === 'close_workbench_session') return null;
          if (command === 'list_remote_library_items') {
            if (args.kind !== 'prompt') return [];
            promptFixture.reads++;
            if (promptFixture.fail) { promptFixture.failures++; throw { message: 'Synthetic prompt permission failure' }; }
            return [{ id: 'remote-prompt', kind: 'prompt', title: '远程代码审查', body: '检查远程项目的改动并保留未提交内容。', category: '开发', projectId: null, version: 1, updatedAt: 1 }];
          }
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
      __output: (sessionId, text) => {
        const bytes = new TextEncoder().encode(text);
        const data = btoa(String.fromCharCode(...bytes));
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId, dataBase64: data } });
      },
      /** The host publishes a later snapshot of the first conversation (the queue and
       *  picture scenes): `patch` replaces fields, `items` are appended to its timeline. */
      __acpPush: (patch = {}, items = []) => {
        const conversation = acpFixture?.[0];
        if (!conversation) return;
        Object.assign(conversation, patch, { timeline: [...conversation.timeline, ...items], seq: conversation.seq + 1 });
        bridge.handlers[bridge.listens['cliora:acp-event']]?.({ payload: { sessionId: conversation.id, seq: conversation.seq, kind: 'snapshot', snapshot: JSON.parse(JSON.stringify(conversation)) } });
      },
      /** A native (desktop) drop of paths at a CSS-pixel point. */
      __drop: (paths, point) => {
        const scale = window.devicePixelRatio || 1;
        bridge.handlers[bridge.listens['tauri://drag-drop']]?.({ payload: { type: 'drop', paths, position: { x: point.x * scale, y: point.y * scale } } });
      },
      __bell: (sessionId = 's4') => {
        const data = btoa('\u0007');
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId, dataBase64: data } });
      },
    });
  }, { theme: initialTheme, transcripts: {
    s1: b64((process.env.CLIORA_CAPTURE_CLEAN === '1' ? [] : Array.from({ length: 70 }, (_, index) => '  \u001b[2m历史输出 ' + String(index + 1).padStart(2, '0') + ' · session replay preserved\u001b[0m')).join('\r\n') + '\r\n\u001b]0;⠋ 重构终端工作区与多会话交互体验\u0007' + transcript),
    s2: b64('\u001b]0;实现文章目录与移动端折叠\u0007' + claudeTranscript),
    s3: b64(finished),
    s4: b64(openCodeTranscript),
    r1: b64('\u001b]0;远程项目 · 独立会话 A\u0007\u001b[36mPi · synthetic SSH terminal\u001b[0m\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-a\r\n\r\n  同一目录的其他会话独立运行，输入属于当前选中会话。\r\n\r\n> '),
    r2: b64('\u001b]0;远程项目 · 独立会话 B\u0007Pi · synthetic SSH terminal\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-b\r\n\r\n> '),
    r3: b64('\u001b]0;远程项目 · 独立会话 C\u0007Pi · synthetic SSH terminal\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-c\r\n\r\n> '),
  }, blank: empty, language: english ? 'en' : 'zh', remoteState, promptFailure, directoryMode, writeRecovery, acpMode });
}

const manifest = [];
// Run-level failures (preview not ready, browser launch) are recorded here instead of crashing, so
// the manifest, gallery and README are always written and the exit code is 1.
const runErrors = [];
let browser = null;
async function shot(name, theme, width, run, empty = false, remoteState = null, promptFailure = null, directoryMode = null, writeRecovery = false, chrome = null, acpMode = null) {
  if (curated && !name.startsWith('workbench-remote-stream-')) {
    const scene = name.slice(0, -`-${theme}-${width}`.length);
    const index = defaultScenes.indexOf(scene);
    if (index === -1 || theme !== sceneTheme(themes, widths, width, index)) return;
  }
  if (!onlyPatterns.some((pattern) => pattern.test(name))) return;
  const errors = [];
  let actionError = null;
  let overflow = null;
  let page = null;
  let resourceObservation = null;
  try {
    page = await browser.newPage({ viewport: { width, height: Math.max(720, Math.round(width * 0.66)) }, deviceScaleFactor: Number(process.env.CLIORA_CAPTURE_SCALE ?? 1), locale: process.env.CLIORA_CAPTURE_LOCALE ?? 'zh-CN', colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce', ...(chrome ? { userAgent: chromeAgents[chrome] } : {}) });
    page.on('pageerror', (error) => errors.push(String(error)));
    await install(page, theme, empty, remoteState, promptFailure, directoryMode, writeRecovery, acpMode);
    if (chrome) await installWindowChrome(page, chrome);
    await page.goto(previewUrl);
    await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
    if (acpMode) {
      // A conversation is a native panel, not an xterm: wait for its own content.
      const panel = page.locator('[data-acp="true"][data-pane-session="acp1"]');
      await panel.waitFor();
      await panel.locator(acpMode === 'empty' || acpMode === 'starting' ? '[data-acp-empty]' : '[data-role="agent"], [data-acp-process]').first().waitFor();
      // The input, the login panel, or the ended recovery banner standing in for it.
      await panel.locator('[data-acp-composer], [data-acp-auth], [data-acp-ended]').first().waitFor();
    } else if (remoteState) {
      const tab = page.locator('[role="tab"][data-session-id="r1"]');
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      if (remoteState === 'connected') await page.locator('.xterm-rows').filter({ hasText: 'synthetic SSH terminal' }).first().waitFor();
    } else if (empty) await page.locator('[data-empty="true"]').first().waitFor();
    else {
      // A narrow viewport may wrap and scroll the final prompt below the visible rows.
      // The test summary is printed near the end of the replay and stays in view.
      const transcript = width <= 760 ? /Playwright\s+61 passed/ : /等待下一条输入/;
      await expect(page.locator('.xterm-rows:visible').first()).toContainText(transcript, { timeout: 10000 });
    }
    if (run) resourceObservation = await run(page) ?? null;
    await settleCapture(page);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    overflow = size.scroll > size.client ? size : null;
    await page.screenshot({ path: out + '/' + name + '.png', fullPage: false, animations: 'disabled' });
  } catch (error) {
    actionError = String(error?.message ?? error).split('\n')[0];
    console.error(name + ': ' + (error?.message ?? error));
  } finally { await page?.close().catch(() => {}); }
  manifest.push({ name, theme, width, locale, pageErrors: errors, overflow, actionError, resourceObservation });
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
const sizeOption = option('--size', '1360');
const compat640 = process.env.CLIORA_CAPTURE_640 === '1' || process.argv.includes('--compat-640');
const defaultWidths = compat640 ? [1360, 900, 720, 640] : [1360, 900, 720];
const widths = sizeOption === 'all' ? defaultWidths : [...new Set(sizeOption.split(',').map(Number))];
if (!widths.length || widths.some((width) => ![1360, 900, 720, 640].includes(width))) throw new Error('Invalid --size; use all|1360,900,720; 640 requires an explicit width or CLIORA_CAPTURE_640=1');

const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
// Routine desktop review: one example of each distinct primary surface. The
// exhaustive platform/error/large-list variants remain opt-in via --full/--only.
const defaultScenes = ['workbench-active', 'workbench-acp-conversation', 'workbench-acp-tools', 'workbench-worktrees-many', 'workbench-ended', 'workbench-composer',
  'workbench-dialog', 'workbench-task-dialog', 'workbench-task-states', 'workbench-restore-mixed',
  'workbench-remote-disconnected', 'workbench-empty'];
const curated = !process.argv.includes('--full') && !process.argv.includes('--only');
const onlyPatterns = option('--only', '*').split(',').map((pattern) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
try {
if (!previewReady) throw new Error('预览服务未就绪：' + previewUrl);
browser = await chromium.launch();
for (const theme of themes) {
for (const width of widths) {
  // The remote folder picker replaced the old "choose remote directory" form; these scenarios
  // drive the picker the workbench actually opens: long paths, permission failure, a slow
  // listing, and unresolved creation receipts.
  for (const directoryMode of ['key', 'password', 'permission', 'loading', 'receipt-unknown', 'receipt-inspected', 'receipt-multiple-top', 'receipt-multiple-end']) {
    await shot(`workbench-t5-directory-${directoryMode}-${theme}-${width}`, theme, width, async page => {
      const longName = index => index + '-' + 'long-unbroken-segment'.repeat(16);
      const session = page.getByRole('dialog', { name: copy('新建工作台会话', 'New workbench session') });
      const picker = page.getByRole('dialog', { name: copy('选择远程文件夹', 'Choose a remote folder') });
      const receipt = picker.getByRole('region', { name: copy('目录创建结果', 'Directory creation results') });
      await page.getByRole('button', { name: copy('新建会话', 'New session'), exact: true }).first().click();
      await session.getByRole('button', { name: copy('工作目录 / 项目', 'Working directory / project'), exact: true }).click();
      await page.getByRole('button', { name: copy('选择其他文件夹…', 'Choose another folder…'), exact: true }).click();
      const typedPath = picker.getByRole('textbox', { name: copy('远程路径', 'Remote path'), exact: true });
      const goTo = async value => {
        await picker.getByRole('button', { name: copy('输入路径', 'Type a path'), exact: true }).click();
        await typedPath.fill(value);
        await typedPath.press('Enter');
      };
      const folders = picker.getByRole('listbox', { name: copy('已有目录', 'Existing directory') });
      const createFolder = async (name, expected) => {
        const input = picker.getByLabel(copy('新文件夹名称', 'New folder name'), { exact: true });
        if (!await input.isVisible()) await picker.getByRole('button', { name: copy('新建文件夹', 'New folder'), exact: true }).click();
        await input.fill(name);
        await picker.getByRole('button', { name: copy('在远端新建目录', 'Create directory remotely'), exact: true }).click();
        // Cancel the in-flight request, then let the fixture answer: the receipt must stay unresolved.
        await picker.getByRole('button', { name: copy('取消当前操作', 'Cancel current operation') }).click();
        await page.evaluate(() => window.__directoryFixture.release());
        await receipt.locator('article[data-outcome="unknown"]').nth(expected - 1).filter({ hasText: copy('结果不确定', 'Outcome unknown') }).waitFor();
      };
      const chosenTitle = async expected => {
        const trigger = session.getByRole('button', { name: copy('工作目录 / 项目', 'Working directory / project'), exact: true });
        const title = await trigger.getAttribute('title');
        if (!title || !title.includes(expected)) throw new Error('The chosen remote folder must stay in the launch summary: ' + title);
      };
      if (directoryMode === 'permission') {
        // A failed refresh keeps the last listing and states the reason.
        await page.evaluate(() => { window.__directoryFixture.failure = true; });
        await picker.getByRole('button', { name: copy('刷新目录', 'Refresh directories'), exact: true }).click();
        await picker.getByRole('status').filter({ hasText: 'Permission denied' }).waitFor();
        return null;
      }
      if (directoryMode === 'loading') {
        // A listing still in flight offers its own cancel instead of a frozen list.
        await picker.getByRole('button', { name: copy('取消当前操作', 'Cancel current operation') }).waitFor();
        return null;
      }
      if (directoryMode === 'key') {
        await folders.getByRole('option', { name: 'project' }).click();
        await picker.getByRole('button', { name: copy('选择此文件夹', 'Choose this folder'), exact: true }).click();
        await chosenTitle('/srv/project');
        return null;
      }
      // A long unbroken path has to stay editable and readable.
      await goTo('/srv/' + longName(0));
      if (directoryMode === 'password') {
        await folders.getByRole('option', { name: 'services' }).click();
        await picker.getByRole('button', { name: copy('选择此文件夹', 'Choose this folder'), exact: true }).click();
        await chosenTitle('/srv/services');
        return null;
      }
      if (directoryMode === 'receipt-unknown' || directoryMode === 'receipt-inspected') {
        await createFolder(longName(1), 1);
        if (directoryMode === 'receipt-inspected') {
          await receipt.getByRole('button', { name: copy('核查原路径', 'Inspect original path'), exact: true }).click();
          await receipt.getByText(copy('原路径当前是目录', 'The original path is currently a directory')).waitFor();
        }
        return null;
      }
      // Four unresolved receipts: the dialog scrolls, never widens, and never replays a create.
      for (let index = 1; index <= 4; index++) await createFolder(longName(index), index);
      const unknown = receipt.locator('article[data-outcome="unknown"]');
      if (await unknown.count() !== 4) throw new Error('Every cancelled create must keep an unresolved receipt');
      const last = unknown.last();
      await last.getByRole('button', { name: copy('核查原路径', 'Inspect original path'), exact: true }).click();
      await last.getByText(copy('原路径当前是目录', 'The original path is currently a directory')).waitFor();
      // Inspecting does not unlock the same path: it may already exist on the host.
      await picker.getByLabel(copy('新文件夹名称', 'New folder name'), { exact: true }).fill(longName(4));
      if (!await picker.getByRole('button', { name: copy('在远端新建目录', 'Create directory remotely'), exact: true }).isDisabled()) throw new Error('An unresolved path must stay blocked after inspection');
      if (!await session.locator('[data-dialog-save]').isEnabled()) throw new Error('Existing receipts must not block the session action');
      const observation = await picker.evaluate(element => {
        const body = element.querySelector('.guide-dialog-body');
        // A long unbroken path must wrap inside its receipt instead of widening the dialog.
        const clipped = [...element.querySelectorAll('section article code')].filter((code) => code.scrollWidth > code.clientWidth + 1).length;
        const before = body.scrollTop;
        body.scrollTop = body.scrollHeight;
        const scrollable = body.scrollHeight > body.clientHeight;
        const reachedEnd = body.scrollTop > before;
        body.scrollTop = before;
        return { horizontalOverflow: body.scrollWidth > body.clientWidth, scrollable, reachedEnd, clipped, writes: window.__directoryFixture.creates };
      });
      if (observation.horizontalOverflow || observation.clipped || observation.writes !== 4) throw new Error('Long receipts must wrap without overflow or replay: ' + JSON.stringify(observation));
      if (observation.scrollable && !observation.reachedEnd) throw new Error('Receipts below the fold must be reachable by scrolling: ' + JSON.stringify(observation));
      await (directoryMode === 'receipt-multiple-end' ? last : receipt.locator('article').first()).scrollIntoViewIfNeeded();
      return observation;
    }, true, 'connected', null, directoryMode);
  }
  for (const failure of ['stale', 'failed']) for (const surface of ['composer', 'dialog']) {
    await shot(`workbench-remote-prompts-${surface}-${failure}-${theme}-${width}`, theme, width, async (page) => {
      const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
      if (surface === 'composer' || failure === 'stale') {
        await stage.getByRole('button', { name: copy('快捷输入', 'Quick input'), exact: true }).click();
      }
      if (failure === 'stale') {
        await stage.getByRole('button', { name: '远程代码审查', exact: true }).waitFor();
        await page.evaluate(() => window.__failRemotePrompts());
        if (surface === 'composer') {
          await stage.getByRole('region', { name: copy('多行输入与提示词投递', 'Multi-line input & library prompts') }).getByRole('textbox').fill('保留当前会话的输入草稿');
          const navigation = page.getByRole('navigation', { name: copy('页面', 'Pages') });
          await navigation.getByRole('button', { name: copy('首页', 'Home'), exact: true }).click();
          await navigation.getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
        }
      }
      let area = stage.getByRole('region', { name: copy('多行输入与提示词投递', 'Multi-line input & library prompts') });
      if (surface === 'dialog') {
        await page.getByRole('button', { name: copy('新建会话', 'New session'), exact: true }).first().click();
        area = page.getByRole('dialog', { name: copy('新建工作台会话', 'New workbench session') });
        await area.getByRole('textbox', { name: copy('初始提示词（可选）', 'Initial prompt (optional)') }).fill('保留新会话的初始提示词草稿');
      }
      await (failure === 'stale' ? area.getByTitle(copy('提示词刷新失败，当前显示上次成功读取的内容。', 'Prompt refresh failed. Showing the last successful prompts.'), { exact: true }) : area.getByText(copy('暂时无法读取此位置的提示词。', 'Could not read prompts from this location.'), { exact: true })).waitFor();
      await area.getByRole('button', { name: copy('重试提示词', 'Retry prompts'), exact: true }).waitFor();
      return page.evaluate(() => ({ ...window.__promptFixture }));
    }, false, 'connected', failure);
  }
  for (const state of ['connecting', 'connected', 'disconnected', 'unknown', 'remote_ended']) {
    await shot(`workbench-remote-${state}-${theme}-${width}`, theme, width, null, false, state);
  }
  await shot(`workbench-remote-write-recovery-${theme}-${width}`, theme, width, async page => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('写入恢复', 'Write recovery'), exact: true }).first().waitFor();
    await stage.getByRole('button', { name: copy('继续会话', 'Resume session'), exact: true }).waitFor();
  }, false, 'disconnected', null, null, true);
  // Stress measurements are independent of theme/viewport; opt in once.
  if (process.argv.includes('--performance') && theme === themes[0] && width === widths[0]) await shot(`workbench-remote-stream-${theme}-${width}`, theme, width, async page => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const snapshot = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      return { ...(await cdp.send('Memory.getDOMCounters')), metrics: Object.fromEntries(metrics.filter(item => ['JSHeapUsedSize', 'TaskDuration'].includes(item.name)).map(item => [item.name, item.value])),
        terminalCount: await page.locator('.xterm').count(), canvasCount: await page.locator('.xterm canvas').count() };
    };
    const before = await snapshot();
    const samples = [];
    for (let round = 0; round < 4; round++) {
      await page.evaluate(async round => {
        for (let batch = 0; batch < 40; batch++) {
          for (const id of ['r1', 'r2', 'r3']) window.__output(id, Array.from({ length: 128 }, (_, line) => `stream-${round}-${batch}-${line} ${'bounded terminal output '.repeat(5)}`).join('\r\n') + '\r\n');
          await new Promise(resolve => setTimeout(resolve, 16));
        }
      }, round);
      for (let index = 0; index < 9; index++) await page.locator(`[role="tab"][data-session-id="r${index % 3 + 1}"]`).click();
      await page.waitForTimeout(200);
      samples.push(await snapshot());
    }
    for (const id of ['r1', 'r2', 'r3']) {
      await page.locator(`[role="tab"][data-session-id="${id}"]`).click();
      await page.getByRole('region', { name: copy('当前会话', 'Current session') }).getByRole('button', { name: copy('结束此会话', 'End this session'), exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: copy('结束进程', 'End process'), exact: true }).click();
    }
    await page.waitForTimeout(200);
    const afterClosed = await snapshot();
    await cdp.detach();
    return { synthetic: true, kind: 'browser-sustained-output', batches: 160, sessions: 3, rowsPerSession: 20480, switches: 36, before, samples, afterClosed,
      nativePlatform: 'unverified', note: 'Fixed workload observations; browser GC/DOM counters are not native CPU/memory or long-duration leak acceptance.' };
  }, false, 'connected');
  await shot('workbench-active-' + theme + '-' + width, theme, width);
  // An ACP conversation is a native chat pane, not a terminal: streaming text, tool cards
  // merged by call id, the turn's own result, and a stop that reports "stopping".
  // T6 adds a fresh session, a long Markdown conversation, the tool shapes, YOLO and a
  // disconnected agent.
  for (const mode of ['conversation', 'permission', 'stopping', 'starting', 'empty', 'long', 'tools', 'yolo', 'disconnected', 'startup', 'process', 'process-done']) {
    await shot('workbench-acp-' + mode + '-' + theme + '-' + width, theme, width, null, false, null, null, null, false, null, mode);
  }
  await shot('workbench-acp-find-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('查找对话内容', 'Find in conversation'), exact: true }).click();
    await stage.getByRole('searchbox', { name: copy('在对话内容中查找…', 'Find in conversation…'), exact: true }).fill('令牌');
    await page.locator('[data-acp="true"][data-pane-session="acp1"] mark').first().waitFor();
  }, false, null, null, null, false, null, 'long');
  if (width >= 1360) await shot('workbench-acp-split-' + theme + '-' + width, theme, width, async (page) => {
    await page.locator('[data-session-id="acp2"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: copy('与 Codex 并排显示', 'Show beside Codex'), exact: true }).click();
    await page.locator('[data-acp="true"][data-pane-session="acp1"]').waitFor({ state: 'visible' });
    await page.locator('[data-acp="true"][data-pane-session="acp2"]').waitFor({ state: 'visible' });
  }, false, null, null, null, false, null, 'split');
  // Cliora's own approval card (not the agent's authorization card): a read outside the
  // session directory waits on 允许一次 / 本会话都允许 / 拒绝, and a write category already
  // granted for this session shows as a revocable shield in the input card.
  await shot('workbench-acp-access-' + theme + '-' + width, theme, width, async (page) => {
    const panel = page.locator('[data-acp="true"][data-pane-session="acp1"]');
    const card = panel.locator('[data-card="access"][data-decision="pending"]');
    await card.waitFor();
    await panel.locator('[data-badge="grant"][data-grant="write"]').waitFor();
    await card.scrollIntoViewIfNeeded();
  }, false, null, null, null, false, null, 'access');
  // The edit card's diff sits above the live terminal: scroll back to it, which also
  // shows "back to latest" while the turn keeps running.
  await shot('workbench-acp-diff-' + theme + '-' + width, theme, width, async (page) => {
    const card = page.locator('[data-acp="true"][data-pane-session="acp1"] [data-item-id="tool:t3"]');
    // A completed call is folded; open it the way a user would.
    await card.locator('button[aria-expanded]').first().click();
    await card.locator('[data-op="insert"]').first().waitFor();
    await card.scrollIntoViewIfNeeded();
  }, false, null, null, null, false, null, 'tools');
  // The conversation keeps its composer and message order at the narrowest supported width.
  if (width <= 720) await shot('workbench-acp-narrow-' + theme + '-' + width, theme, width, null, false, null, null, null, false, null, 'conversation');
  // The input and session controls: selectors (folded into "⋯" when narrow), the `/`
  // menu, an attached image with the `@` file menu, the login panel, a form and history.
  const acpPanel = (page) => page.locator('[data-acp="true"][data-pane-session="acp1"]');
  const acpInput = (page) => acpPanel(page).getByRole('textbox', { name: copy('给 Codex 的消息', 'Message to Codex'), exact: true });
  await shot('workbench-acp-composer-' + theme + '-' + width, theme, width, async (page) => {
    if (width <= 720) {
      await acpPanel(page).getByRole('button', { name: copy('会话设置', 'Session settings'), exact: true }).click();
      await acpPanel(page).getByRole('combobox', { name: copy('模式', 'Mode'), exact: true }).waitFor();
    }
  }, false, null, null, null, false, null, 'composer');
  await shot('workbench-acp-slash-' + theme + '-' + width, theme, width, async (page) => {
    await acpInput(page).click();
    await acpInput(page).pressSequentially('/');
    await acpPanel(page).locator('[data-acp-menu="commands"]').waitFor();
  }, false, null, null, null, false, null, 'composer');
  await shot('workbench-acp-attach-' + theme + '-' + width, theme, width, async (page) => {
    const input = acpInput(page);
    await input.click();
    await input.evaluate((node) => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], 'toolbar.png', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    await acpPanel(page).locator('[data-attachment="image"]').waitFor();
    await input.pressSequentially(copy('对照截图检查 @Sess', 'Compare with the screenshot @Sess'));
    await acpPanel(page).locator('[data-acp-menu="files"] [role="option"]').first().waitFor();
  }, false, null, null, null, false, null, 'composer');
  // A desktop drop delivers paths: the image is read by the host and previewed like a
  // pasted one, a text file becomes a file chip, and a slow read shows as reading. A
  // native drop needs the desktop webview, so this scene uses the Windows frame.
  await shot('workbench-acp-drop-' + theme + '-' + width, theme, width, async (page) => {
    await acpPanel(page).waitFor();
    const box = await acpPanel(page).boundingBox();
    await page.evaluate((point) => window.__drop(['C:/Projects/cliora/docs/toolbar.png', 'C:/Projects/cliora/notes.md', 'C:/Projects/cliora/docs/reading-layout.png'], point),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await acpPanel(page).locator('[data-attachment="image"]').waitFor();
    await acpPanel(page).locator('[data-attachment="reading"]').waitFor();
  }, false, null, null, null, false, 'windows', 'composer');
  // The queue (R11): prompts typed while a turn works wait above the input card, the one
  // sent with Ctrl+Enter first ("next after stop"); a failed turn pauses the queue until
  // "continue sending"; prompts still queued when the conversation ends stay readable.
  const queuePrompts = async (page, texts) => {
    const input = acpInput(page);
    await acpPanel(page).locator('[data-acp-composer]').waitFor();
    for (const text of texts) {
      await input.fill(text);
      await input.press('Enter');
    }
    await acpPanel(page).locator('[data-acp-queue-item]').nth(texts.length - 1).waitFor();
  };
  await shot('workbench-acp-queue-' + theme + '-' + width, theme, width, async (page) => {
    await queuePrompts(page, [copy('构建通过后，把 R13 的验收也补进测试计划。', 'Once the build passes, add the R13 acceptance to the test plan.'), copy('顺便检查一下 720px 下的输入卡。', 'Also check the input card at 720px.')]);
    await acpInput(page).fill(copy('先停一下，R13 的编号写错了，应当是 R12。', 'Stop for a moment: R13 is misnumbered, it should be R12.'));
    await acpInput(page).press('ControlOrMeta+Enter');
    await acpPanel(page).locator('[data-acp-queue-item][data-immediate]').waitFor();
  }, false, null, null, null, false, null, 'queue');
  await shot('workbench-acp-queue-paused-' + theme + '-' + width, theme, width, async (page) => {
    await queuePrompts(page, [copy('构建通过后，把 R13 的验收也补进测试计划。', 'Once the build passes, add the R13 acceptance to the test plan.')]);
    await page.evaluate(() => window.__acpPush({ state: 'ready', lastTurnReason: 'failed' }, [{ kind: 'turn', id: 'turn-1-end', turnId: 'turn-1', reason: 'failed' }]));
    await acpPanel(page).locator('[data-acp-queue-paused]').waitFor();
  }, false, null, null, null, false, null, 'queue');
  await shot('workbench-acp-queue-unsent-' + theme + '-' + width, theme, width, async (page) => {
    await queuePrompts(page, [copy('构建通过后，把 R13 的验收也补进测试计划。', 'Once the build passes, add the R13 acceptance to the test plan.'), copy('顺便检查一下 720px 下的输入卡。', 'Also check the input card at 720px.')]);
    await page.evaluate(() => window.__acpPush({ state: 'closed', lastTurnReason: 'disconnected' }));
    await acpPanel(page).locator('[data-acp-unsent]').waitFor();
    await acpPanel(page).locator('[data-acp-ended]').waitFor();
  }, false, null, null, null, false, null, 'queue');
  // Pictures in the person's messages (R12): a sent pasted PNG and a dropped photo.jpg
  // as thumbnails; the earlier, replayed message has no picture data and shows a named
  // placeholder instead of the media type.
  await shot('workbench-acp-images-' + theme + '-' + width, theme, width, async (page) => {
    const input = acpInput(page);
    await acpPanel(page).locator('[data-acp-image-placeholder]').waitFor();
    await input.click();
    await input.evaluate((node) => {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const pasted = new DataTransfer();
      pasted.items.add(new File([bytes], '', { type: 'image/png' }));
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasted, bubbles: true, cancelable: true }));
      const dropped = new DataTransfer();
      dropped.items.add(new File([bytes], 'photo.jpg', { type: 'image/jpeg' }));
      node.dispatchEvent(new DragEvent('dragover', { dataTransfer: dropped, bubbles: true, cancelable: true }));
      node.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
    });
    await acpPanel(page).locator('[data-attachment="image"]').nth(1).waitFor();
    await input.fill(copy('这两张是改完后的效果，对比一下。', 'These two show the result; compare them.'));
    await input.press('Enter');
    await acpPanel(page).locator('[data-attachment="image"]').first().waitFor({ state: 'detached' });
    await page.evaluate((text) => window.__acpPush({ state: 'running' }, [{ kind: 'message', id: 'turn-2-user', role: 'user', text, truncated: false, turnId: 'turn-2', subagent: null,
      attachments: [{ type: 'image', name: 'image/png', delivery: null }, { type: 'image', name: 'image/jpeg', delivery: null }] }]), copy('这两张是改完后的效果，对比一下。', 'These two show the result; compare them.'));
    const thumbs = acpPanel(page).locator('[data-item-id="turn-2-user"] [data-acp-image-thumb] img');
    await thumbs.nth(1).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-acp-image-thumb] img')].every((node) => node.complete && node.naturalWidth > 0));
  }, false, null, null, null, false, null, 'images');
  await shot('workbench-acp-login-' + theme + '-' + width, theme, width, async (page) => {
    await acpPanel(page).locator('[data-acp-auth]').waitFor();
  }, false, null, null, null, false, null, 'login');
  await shot('workbench-acp-form-' + theme + '-' + width, theme, width, async (page) => {
    const form = acpPanel(page).locator('[data-card="elicitation"]');
    await form.waitFor();
    await form.getByRole('button', { name: copy('提交', 'Submit'), exact: true }).click();
    await form.getByRole('alert').first().waitFor();
    await form.scrollIntoViewIfNeeded();
  }, false, null, null, null, false, null, 'form');
  // History opens from the pane's "⋯" menu; the conversation itself has no entry for it.
  const openAcpHistory = async (page) => {
    await acpPanel(page).locator('[data-acp-composer]').waitFor();
    await page.getByRole('button', { name: copy('更多终端操作', 'More terminal actions') }).click();
    await page.getByRole('menuitem', { name: copy('历史会话…', 'Session history…'), exact: true }).click();
  };
  await shot('workbench-acp-history-' + theme + '-' + width, theme, width, async (page) => {
    await openAcpHistory(page);
    await page.locator('[data-acp-history] [data-native-id]').first().waitFor();
  }, false, null, null, null, false, null, 'composer');
  // An agent without session listing: the reason, and a new conversation instead.
  await shot('workbench-acp-history-unsupported-' + theme + '-' + width, theme, width, async (page) => {
    await openAcpHistory(page);
    await page.locator('[data-acp-history-unsupported]').waitFor();
  }, false, null, null, null, false, null, 'conversation');
  // The task comes first; the context it will use is a compact summary under it, and the
  // worktree base, branch and setup command stay folded until they are needed.
  await shot('workbench-task-dialog-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('button', { name: copy('新建会话', 'New session'), exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: copy('新建工作台会话', 'New workbench session') });
    await dialog.getByRole('button', { name: copy('工作目录 / 项目', 'Working directory / project'), exact: true }).click();
    await page.getByRole('option', { name: /栖点/ }).click();
    await dialog.getByRole('textbox', { name: copy('初始提示词（可选）', 'Initial prompt (optional)') }).fill('feat: 结算流程');
    await dialog.getByRole('radiogroup', { name: copy('启动位置', 'Start in') }).getByRole('radio', { name: copy('新建工作树', 'New worktree') }).click();
    await dialog.getByRole('button', { name: new RegExp('^' + copy('高级选项', 'Advanced options')) }).waitFor();
  });
  // Four task states from real evidence: an approval screen, a marked round, background work
  // and a row the user moved out of the way. Nothing here is a completion claim.
  await shot('workbench-task-states-' + theme + '-' + width, theme, width, async (page) => {
    const rail = page.getByRole('complementary', { name: copy('会话列表', 'Session list') });
    await rail.locator('[role="tab"][data-session-id="s2"]').click();
    await page.evaluate(() => window.__output('s1', '\x1b[2J\x1b[H' + '\r\n'.repeat(40) + [
      'Would you like to run the following command?',
      '',
      '  $ npm run build',
      '',
      '\u203a 1. Yes, proceed (y)',
      '  2. Yes, and do not ask again',
      '  3. No, and tell Codex what to do differently (esc)',
    ].join('\r\n')));
    await page.locator('[data-drag-id="s1"][data-task="needsYou"]').waitFor();
    // Marking and moving to the background arrange the list, so they live on the row's menu.
    const taskMenu = async (id) => {
      await page.locator(`[data-drag-id="${id}"] [data-session-id="${id}"]`).click({ button: 'right' });
      return page.getByRole('menu', { name: new RegExp(copy('会话操作', 'session actions')) });
    };
    await page.locator('[data-drag-id="s2"] [data-session-id="s2"]').click();
    await (await taskMenu('s2')).getByRole('menuitem', { name: copy('标记待审阅', 'Mark for review'), exact: true }).click();
    await page.locator('[data-drag-id="s2"][data-task="readyReview"]').waitFor();
    await page.locator('[data-drag-id="s4"] [data-session-id="s4"]').click();
    await (await taskMenu('s4')).getByRole('menuitem', { name: copy('收起为后台', 'Move to background'), exact: true }).click();
    // A narrow window draws the rail as a horizontal strip, so the section only has to exist.
    await page.locator('[data-group="collapsed"]').waitFor({ state: 'attached' });
  });
  await shot('workbench-worktrees-' + theme + '-' + width, theme, width, async (page) => {
    // One git chip in the status line; its menu opens a new session in another checkout.
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: new RegExp(copy('在工作树中新开会话', 'Open a session in a worktree')) }).click();
    await page.getByRole('menu', { name: copy('在工作树中新开会话', 'Open a session in a worktree') }).waitFor();
  });
  const openWorktreeDialog = async (page) => {
    await page.getByRole('button', { name: copy('新建会话', 'New session'), exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: copy('新建工作台会话', 'New workbench session') });
    await dialog.getByRole('button', { name: copy('工作目录 / 项目', 'Working directory / project'), exact: true }).click();
    await page.getByRole('option', { name: /栖点/ }).click();
    await dialog.getByRole('radiogroup', { name: copy('启动位置', 'Start in') }).getByRole('radio', { name: copy('新建工作树', 'New worktree') }).click();
    // The base, branch and setup command are the folded advanced options now.
    await dialog.getByRole('button', { name: copy('高级选项', 'Advanced options'), exact: true }).click();
    await dialog.locator('#new-session-advanced').waitFor({ state: 'visible' });
    return dialog;
  };
  // A new worktree: the repository default and its short commit are visible, and the
  // base, branch and setup command are edited in place.
  await shot('workbench-worktree-new-' + theme + '-' + width, theme, width, async page => {
    const dialog = await openWorktreeDialog(page);
    await dialog.locator('code').filter({ hasText: 'origin/main' }).first().waitFor();
    // The branch the creation will allocate is visible with the advanced panel closed.
    await dialog.getByRole('textbox', { name: copy('初始提示词（可选）', 'Initial prompt (optional)') }).fill('feat: 结算流程');
    await dialog.locator('code[data-source="proposed"]').filter({ hasText: 'feat' }).first().waitFor();
    await dialog.getByRole('button', { name: copy('更改基点', 'Change base'), exact: true }).click();
    await dialog.getByLabel(copy('基点 ref', 'Base ref'), { exact: true }).fill('origin/develop');
    await dialog.getByLabel(copy('基点 ref', 'Base ref'), { exact: true }).press('Enter');
    await dialog.locator('code').filter({ hasText: 'origin/develop' }).first().waitFor();
    await dialog.getByLabel(copy('准备命令', 'Setup command'), { exact: true }).fill('npm ci');
  });
  // Environment setup failed: the worktree is kept and the retry stays in that directory.
  await shot('workbench-worktree-preparing-failed-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => {
      window.__worktreeScript = [
        { event: { stage: 'creating' } },
        { event: { stage: 'preparing', worktreePath: 'C:\\Projects\\cliora-polish', branch: 'feat/checkout-flow' } },
        { event: { stage: 'failed', worktreePath: 'C:\\Projects\\cliora-polish', branch: 'feat/checkout-flow', error: '环境准备失败：npm ci 退出码 1' } },
      ];
      window.__worktreeScriptFail = '环境准备失败：npm ci 退出码 1';
      window.__capturePrepare = 'npm ci';
    });
    const dialog = await openWorktreeDialog(page);
    await dialog.locator('code').filter({ hasText: 'origin/main' }).first().waitFor();
    await dialog.getByRole('textbox', { name: copy('初始提示词（可选）', 'Initial prompt (optional)') }).fill('feat: 结算流程');
    await dialog.getByRole('button', { name: copy('启动会话', 'Start session'), exact: true }).click();
    await page.locator('[data-worktree-op][data-stage="failed"]').waitFor();
    await page.getByRole('button', { name: copy('重试准备', 'Retry setup'), exact: true }).waitFor();
  });
  // Menu status: real changes and an unread status kept unknown.
  await shot('workbench-worktree-status-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => { window.__captureStatusFails = ['/repo/cliora-long']; });
    await page.getByRole('button', { name: new RegExp(copy('在工作树中新开会话', 'Open a session in a worktree')) }).click();
    const menu = page.getByRole('menu', { name: copy('在工作树中新开会话', 'Open a session in a worktree') });
    await menu.waitFor();
    await menu.getByRole('menuitem', { name: copy('重试状态', 'Retry status'), exact: true }).waitFor();
  });
  // A failed list read is an error with a retry, not an empty repository.
  await shot('workbench-worktree-list-failed-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => { window.__captureWorktreeReadFails = true; });
    await page.getByRole('button', { name: new RegExp(copy('在工作树中新开会话', 'Open a session in a worktree')) }).click();
    const menu = page.getByRole('menu', { name: copy('在工作树中新开会话', 'Open a session in a worktree') });
    await menu.getByRole('alert').waitFor();
    await menu.getByRole('menuitem', { name: copy('重试读取', 'Read again'), exact: true }).waitFor();
  });
  // Worktree management is a dialog: cleanup first, then the repository setup command.
  const openWorktreeSetup = async (page) => {
    await page.getByRole('button', { name: copy('更多终端操作', 'More terminal actions') }).click();
    await page.getByRole('menu', { name: copy('终端操作', 'Terminal actions') }).getByRole('menuitem', { name: new RegExp(copy('管理工作树', 'Manage worktrees')) }).click();
    const setup = page.getByRole('dialog', { name: copy('管理工作树', 'Manage worktrees') });
    await setup.waitFor();
    return setup;
  };
  await shot('workbench-worktree-setup-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => {
      window.__captureLedger = [
        { mainCheckout: 'C:\\Projects\\cliora', worktreePath: 'C:\\Projects\\cliora-checkout-flow', branch: 'feat/checkout-flow', environment: 'prepared' },
        { mainCheckout: 'C:\\Projects\\cliora', worktreePath: 'C:\\Projects\\cliora-very-long-worktree-folder-name-for-layout', branch: 'fix/a-very-long-branch-name-that-should-truncate-cleanly', environment: 'unprepared' },
      ];
    });
    await openWorktreeSetup(page);
  });
  // Hundreds of worktrees: the menu filters and shows a bounded slice; the dialog opens on this
  // project, pages its list and groups every project by repository.
  await shot('workbench-worktrees-many-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => { window.__captureManyWorktrees = 240; });
    await page.getByRole('button', { name: new RegExp(copy('在工作树中新开会话', 'Open a session in a worktree')) }).click();
    const menu = page.getByRole('menu', { name: copy('在工作树中新开会话', 'Open a session in a worktree') });
    await menu.getByRole('searchbox').fill('fix 12');
    await menu.getByRole('menuitemradio').nth(1).waitFor();
  });
  const manyLedger = () => {
    const rows = [];
    for (let index = 0; index < 140; index++) rows.push({ mainCheckout: 'C:\\Projects\\cliora', worktreePath: 'C:\\Projects\\.worktrees\\cliora-' + index, branch: (index % 4 ? 'feat/task-' : 'fix/issue-') + index, environment: index % 2 ? 'prepared' : 'unprepared' });
    for (let index = 0; index < 90; index++) rows.push({ mainCheckout: index % 2 ? 'C:\\Projects\\personal-site' : 'D:\\work\\acme-svc-order', worktreePath: 'C:\\Projects\\.worktrees\\other-' + index, branch: 'feat/other-' + index, environment: 'prepared' });
    return rows;
  };
  await shot('workbench-worktree-setup-many-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate((rows) => { window.__captureLedger = rows; }, manyLedger());
    const setup = await openWorktreeSetup(page);
    await setup.getByRole('radio', { name: new RegExp(copy('栖点', 'Cliora')) }).waitFor();
  });
  await shot('workbench-worktree-setup-all-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate((rows) => { window.__captureLedger = rows; }, manyLedger());
    const setup = await openWorktreeSetup(page);
    await setup.getByRole('radio', { name: new RegExp(copy('全部项目', 'All projects')) }).click();
    await setup.getByRole('searchbox').fill('other-1');
  });
  // Cleanup refused because a running session still uses that checkout.
  await shot('workbench-worktree-cleanup-running-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => {
      window.__captureLedger = [{ mainCheckout: 'C:\\Projects\\cliora', worktreePath: 'C:\\Projects\\cliora', branch: 'feature/workbench-polish', environment: 'unprepared' }];
    });
    const setup = await openWorktreeSetup(page);
    await setup.getByRole('button', { name: /清理 feature\/workbench-polish|Remove feature\/workbench-polish/ }).click();
    await setup.getByRole('alert').waitFor();
  });
  // Saved records come first: their own rows and the new-session entry are on screen before
  // any session exists, and each finished record replaces only its own row.
  const savedRestores = [
    { id: 'saved-codex', toolId: 'codex', projectId: 'cliora', directory: 'C:\\Projects\\cliora', mode: 'normal', startedAt: Date.now() - 3 * 60000, stoppedAt: Date.now() - 60000, nativeId: 'native-codex', accountId: null, contextId: null },
    { id: 'saved-claude', toolId: 'claude_code', projectId: 'site', directory: 'C:\\Projects\\personal-site', mode: 'normal', startedAt: Date.now() - 9 * 60000, stoppedAt: Date.now() - 4 * 60000, nativeId: 'native-claude', accountId: null, contextId: null },
    { id: 'saved-grok', toolId: 'grok', projectId: null, directory: 'C:\\Projects\\acme-svc-order-billing', mode: 'normal', startedAt: Date.now() - 26 * 60000, stoppedAt: Date.now() - 12 * 60000, nativeId: null, accountId: null, contextId: null },
  ];
  const openRestoreScene = async (page, script) => {
    await page.evaluate(({ saved, script }) => localStorage.setItem('capture:restore', JSON.stringify({ saved, script })), { saved: savedRestores, script });
    // The fixture is read by the init script, so the reload is what installs it.
    await page.reload();
    await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
    await page.locator('[data-restore-row]').first().waitFor();
  };
  // Objective layout evidence for the rows: each row stays inside the stage, its actions keep a
  // real target size, and no copy is clipped by the row.
  const measureRestoreRows = (page) => page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-restore-row]')];
    const queue = document.querySelector('[data-restore-queue]');
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    };
    const clippedCopy = rows.flatMap((row) => {
      const stage = row.querySelectorAll('p');
      const copy = row.querySelector('[class*="restoreRowCopy"]');
      const rowRect = row.getBoundingClientRect();
      return [
        ...[...stage].filter((node) => node.scrollHeight > node.clientHeight + 1).map(() => 'stage-text'),
        ...(copy && copy.getBoundingClientRect().right > rowRect.right + 1 ? ['copy-past-row'] : []),
      ];
    });
    // Vertical evidence: the queue box stays inside the stage and its own scroll reaches the last
    // row, so no record is permanently cut off however many are saved.
    let vertical = null;
    if (queue && rows.length) {
      const queueRect = queue.getBoundingClientRect();
      const stageRect = queue.closest('section').getBoundingClientRect();
      const hiddenBeforeScroll = rows.filter((row) => row.getBoundingClientRect().bottom > queueRect.bottom + 1).length;
      const before = queue.scrollTop;
      queue.scrollTop = queue.scrollHeight;
      const lastRect = rows[rows.length - 1].getBoundingClientRect();
      const scrolledRect = queue.getBoundingClientRect();
      vertical = {
        records: rows.length,
        clientHeight: queue.clientHeight,
        scrollHeight: queue.scrollHeight,
        scrollRange: queue.scrollHeight - queue.clientHeight,
        hiddenBeforeScroll,
        reachedEnd: queue.scrollTop > 0,
        lastRowVisibleAtEnd: lastRect.bottom <= scrolledRect.bottom + 1 && lastRect.top >= scrolledRect.top - 1,
        insideStage: queueRect.bottom <= stageRect.bottom + 1 && queueRect.top >= stageRect.top - 1,
        focusable: queue.tabIndex >= 0,
      };
      queue.scrollTop = before;
    }
    return {
      rows: rows.map((row) => ({ stage: row.getAttribute('data-stage'), size: box(row) })),
      actions: rows.flatMap((row) => [...row.querySelectorAll('button')].map((button) => ({ label: button.textContent?.trim() ?? '', size: box(button) }))),
      clippedCopy,
      vertical,
      page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    };
  });
  await shot('workbench-restore-queue-' + theme + '-' + width, theme, width, async (page) => {
    await openRestoreScene(page, [
      { event: { savedSessionId: 'saved-claude', stage: 'discovering' } },
      { event: { savedSessionId: 'saved-grok', stage: 'starting' } },
      { hold: true },
    ]);
    return measureRestoreRows(page);
  }, true);
  // 14 saved records: more than fits, so the queue must scroll instead of cutting the last rows.
  const manyRestores = Array.from({ length: 14 }, (_, index) => ({
    id: 'saved-' + (index + 1), toolId: 'codex', projectId: null, directory: 'C:\\Projects\\workspace-' + (index + 1),
    mode: 'normal', startedAt: Date.now() - (index + 1) * 60000, stoppedAt: Date.now() - index * 60000, nativeId: null, accountId: null, contextId: null,
  }));
  await shot('workbench-restore-many-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(({ saved }) => localStorage.setItem('capture:restore', JSON.stringify({
      saved,
      // Every record failed, so even the last row carries its own retry.
      script: saved.map((item) => ({ event: { savedSessionId: item.id, stage: 'failed', detail: '原会话已被删除，无法继续' } })),
    })), { saved: manyRestores });
    await page.reload();
    await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
    await page.locator('[data-restore-row="saved-14"]').waitFor({ state: 'attached' });
    return measureRestoreRows(page);
  }, true);
  await shot('workbench-restore-mixed-' + theme + '-' + width, theme, width, async (page) => {
    await openRestoreScene(page, [
      { event: { savedSessionId: 'saved-codex', stage: 'restored', session: { id: 'back-codex', toolId: 'codex', projectId: 'cliora', directory: 'C:\\Projects\\cliora', mode: 'normal', running: true, exitCode: null, startedAt: Date.now() } } },
      { event: { savedSessionId: 'saved-claude', stage: 'failed', detail: copy('原会话已被删除，无法继续', 'The original session was deleted.'), candidates: [] } },
      { event: { savedSessionId: 'saved-grok', stage: 'starting' } },
      { hold: true },
    ]);
    await page.locator('[data-session-id="back-codex"]').waitFor();
    return measureRestoreRows(page);
  }, true);
  await shot('workbench-ended-' + theme + '-' + width, theme, width, async page => {
    // Objective layout evidence: clipped text, toolbar overflow, muted-copy contrast and the
    // ended state's affordances.
    const stageLabel = copy('当前会话', 'Current session');
    const measure = () => page.evaluate((stageLabel) => {
      const size = (element) => element ? { w: Math.round(element.getBoundingClientRect().width), h: Math.round(element.getBoundingClientRect().height) } : null;
      const fits = (element) => ({ partial: element.scrollWidth > element.clientWidth + 1, scroll: element.scrollWidth, client: element.clientWidth });
      const channel = (value) => {
        const match = value.match(/^rgba?\(([^)]+)\)$/);
        if (!match) return null;
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return parts.length >= 3 ? { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 } : null;
      };
      // Walk up to the first surface that actually paints, so a transparent row still resolves.
      const backdrop = (element) => {
        for (let node = element; node; node = node.parentElement) {
          const paint = channel(getComputedStyle(node).backgroundColor);
          if (paint && paint.alpha > 0.55) return paint.rgb;
        }
        return [255, 255, 255];
      };
      const luminance = (rgb) => {
        const [r, g, b] = rgb.map((value) => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (label, element) => {
        if (!element) return { label, ratio: null };
        const paint = channel(getComputedStyle(element).color);
        if (!paint) return { label, ratio: null };
        const front = luminance(paint.rgb);
        const back = luminance(backdrop(element));
        return { label, ratio: Math.round(((Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)) * 100) / 100, size: getComputedStyle(element).fontSize };
      };
      const tabs = [...document.querySelectorAll('[role="tab"][data-session-id]')];
      const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0] ?? null;
      const plain = tabs.find((tab) => tab !== selected) ?? null;
      const rail = document.querySelector('aside[aria-label]');
      const stage = document.querySelector('section[aria-label="' + stageLabel + '"]');
      const toolbar = stage ? stage.querySelector('[role="toolbar"]') : null;
      const bar = toolbar ? toolbar.closest('header') : null;
      const barBox = bar ? bar.getBoundingClientRect() : null;
      const buttons = toolbar ? [...toolbar.querySelectorAll('button')] : [];
      const outside = barBox ? buttons.filter((button) => { const box = button.getBoundingClientRect(); return box.width > 0 && (box.right > barBox.right + 1 || box.left < barBox.left - 1 || box.top < barBox.top - 1 || box.bottom > barBox.bottom + 1); }).length : null;
      const status = stage ? stage.querySelector('footer') : null;
      const rows = tabs.map((tab) => {
        const title = tab.querySelector('strong');
        const meta = [...tab.querySelectorAll('[data-tone]')]
          .flatMap((node) => [...node.querySelectorAll('span')])
          .filter((span) => span.children.length === 0 && /[\u4e00-\u9fa5A-Za-z]/.test(span.textContent))[0];
        return {
          id: tab.dataset.sessionId,
          title: title ? fits(title) : null,
          state: meta ? { text: meta.textContent.trim(), ...fits(meta) } : null,
          row: size(tab),
        };
      });
      return {
        page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
        rail: size(rail),
        header: size(bar),
        toolbarButtons: buttons.length,
        toolbarClipped: outside,
        statusOverflow: status ? status.scrollWidth > status.clientWidth + 1 : null,
        rows,
        contrast: [
          contrast('rail-title-selected', selected?.querySelector('strong') ?? null),
          contrast('rail-title', plain?.querySelector('strong') ?? null),
          contrast('rail-place', plain?.querySelector('[class*="sessionPlace"]') ?? null),
          contrast('rail-meta', plain?.querySelector('[class*="sessionMeta"] span') ?? null),
          contrast('stage-title', stage?.querySelector('h2') ?? null),
          contrast('stage-sub', stage?.querySelector('header p, header span') ?? null),
          contrast('status-bar', status ?? null),
        ].filter((item) => item.ratio != null),
      };
    }, stageLabel);
    const running = await measure();
    // A confirmed-ended session keeps a recovery action and offers no input surface.
    await page.locator('[role="tab"][data-session-id="s3"]').click();
    await page.getByRole('button', { name: copy('重新启动', 'Restart'), exact: true }).waitFor();
    const ended = await page.evaluate(({ label, stageLabel }) => {
      const visible = (element) => element.getBoundingClientRect().height > 0;
      const stage = document.querySelector('section[aria-label="' + stageLabel + '"]');
      const buttons = stage ? [...stage.querySelectorAll('button')] : [];
      const restart = buttons.filter((button) => button.textContent.trim() === label);
      return {
        restartVisible: restart.some(visible),
        visibleButtons: buttons.filter(visible).length,
        labels: buttons.filter(visible).map((button) => button.textContent.trim()).filter(Boolean).slice(0, 12),
        endedBar: (stage ? [...stage.querySelectorAll('footer')].map((footer) => (footer.innerText ?? '').replace(/\s+/g, ' ').slice(0, 80)) : []),
      };
    }, { label: copy('重新启动', 'Restart'), stageLabel: copy('当前会话', 'Current session') });
    return { running, ended };
  });
  await shot('workbench-activity-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => window.__output('s1', 'live output contrast\r\n'));
    await page.locator('[data-activity-slot="status"][data-activity-icon="live"]').waitFor();
    await page.locator('[data-activity-slot="rail"][data-activity-icon="idle"]').first().waitFor();
  });
  await shot('workbench-scrolled-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    const screenBox = await stage.locator('.xterm-screen:visible').boundingBox();
    await page.mouse.move(screenBox.x + screenBox.width / 2, screenBox.y + screenBox.height / 2);
    await page.mouse.wheel(0, -480);
    await stage.getByRole('button', { name: copy('回到最新输出', 'Jump to latest output'), exact: true }).waitFor({ state: 'visible' });
    const box = await stage.locator('.xterm-scrollable-element:visible').boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  });
  await shot('workbench-appearance-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('终端显示', 'Terminal appearance'), exact: true }).click();
  });
  await shot('workbench-composer-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('快捷输入', 'Quick input'), exact: true }).click();
    await stage.getByRole('textbox', { name: /编写多行内容|Compose multi-line/ }).fill('review the diff and summarise the risk in one paragraph');
    await stage.getByRole('button', { name: copy('查找输出', 'Find in output'), exact: true }).click();
    await stage.getByRole('searchbox', { name: copy('在终端输出中查找…', 'Find in terminal output…') }).fill('SessionWorkbench');
  });
  // Pre-edit text only: the system candidate list is drawn by the OS IME and never appears in a browser capture.
  await shot('workbench-preedit-' + theme + '-' + width, theme, width, async (page) => {
    const input = page.locator('.xterm-helper-textarea:visible');
    await input.waitFor({ state: 'attached', timeout: 20000 });
    await input.focus();
    await input.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      node.value += 'sheng ji';
      node.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'sheng ji', bubbles: true }));
    });
  });
  await shot('workbench-dialog-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('complementary', { name: copy('会话列表', 'Sessions') }).getByRole('button', { name: copy('新建会话', 'New session') }).click();
  });
  await shot('workbench-remote-dialog-' + theme + '-' + width, theme, width, async (page) => {
    const host = page.getByRole('button', { name: new RegExp('^' + copy('运行位置', 'Runs on')) }).first();
    if (await host.count()) {
      await host.click();
      await page.getByRole('menuitemradio', { name: /测试远程主机/ }).click();
    }
    // A host without sessions shows the launchpad instead of the rail.
    const railNew = page.getByRole('complementary', { name: copy('会话列表', 'Sessions') }).getByRole('button', { name: copy('新建会话', 'New session') });
    const newSession = await railNew.isVisible() ? railNew : page.getByRole('region', { name: copy('当前会话', 'Current session') }).getByRole('button', { name: copy('新建会话', 'New session') }).first();
    await newSession.click();
    await page.getByRole('dialog').first().waitFor();
  });
  await shot('workbench-attention-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => window.__bell());
    await page.getByRole('tab', { name: /Claude Code/ }).click();
  });
  // The temporary look over a waiting session: the cover names the session, its CLI and its state.
  await shot('workbench-peek-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => window.__bell('s2'));
    // The look opens from the row menu; the stage bar keeps only the compact waiting jump.
    await page.locator('[data-drag-id="s2"]').hover();
    await page.getByRole('button', { name: copy('Claude Code 会话操作', 'Claude Code session actions'), exact: true }).click();
    await page.getByRole('menu', { name: copy('Claude Code 会话操作', 'Claude Code session actions'), exact: true })
      .getByRole('menuitem', { name: copy('临时查看', 'Peek'), exact: true }).click();
    await page.getByRole('dialog', { name: copy('临时查看', 'Peek') }).waitFor();
  });
  await shot('workbench-focus-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('region', { name: copy('当前会话', 'Current session') }).getByRole('button', { name: copy('专注模式（隐藏侧栏）', 'Focus mode (hide sidebar)') }).click();
  });
  if (width >= 1360) await shot('workbench-split-' + theme + '-' + width, theme, width, async (page) => {
    const stage = page.getByRole('region', { name: copy('当前会话', 'Current session') });
    await stage.getByRole('button', { name: copy('分屏', 'Split view'), exact: true }).click();
    await page.getByRole('tab', { name: /Claude Code/ }).click();
    await page.evaluate(() => window.__output('s1', 'live split output\r\n'));
    await page.locator('[data-activity-slot="pane"][data-activity-icon="live"]').waitFor();
    await page.locator('[data-activity-slot="pane"][data-activity-icon="idle"]').waitFor();
  });
  if (width >= 1360) await shot('workbench-slim-' + theme + '-' + width, theme, width, async (page) => {
    // The session list lives in the app sidebar; folding the sidebar leaves one icon rail.
    await page.getByRole('button', { name: copy('折叠侧栏', 'Collapse sidebar'), exact: true }).click();
    await page.evaluate(() => window.__output('s1', 'live compact output\r\n'));
    await page.locator('[data-activity-slot="rail"][data-activity-icon="live"]').waitFor();
    await page.evaluate(() => window.__bell());
  });
  // Desktop window frames. A per-shot platform makes the app draw its native title bar: the caption
  // buttons on Windows and Linux, the band and brand row beside the traffic lights on macOS (the
  // lights are native, so the capture paints stand-ins at the configured trafficLightPosition).
  if (width >= 900) for (const chrome of ['windows', 'linux', 'macos']) {
    await shot(`workbench-chrome-${chrome}-` + theme + '-' + width, theme, width, async (page) => {
      await page.locator('[data-window-titlebar]').waitFor();
    }, false, null, null, null, false, chrome);
    await shot(`workbench-chrome-${chrome}-slim-` + theme + '-' + width, theme, width, async (page) => {
      await page.getByRole('button', { name: copy('折叠侧栏', 'Collapse sidebar'), exact: true }).click();
    }, false, null, null, null, false, chrome);
    await shot(`workbench-chrome-${chrome}-home-` + theme + '-' + width, theme, width, async (page) => {
      await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('首页', 'Home'), exact: true }).click();
    }, false, null, null, null, false, chrome);
    await shot(`workbench-chrome-${chrome}-empty-` + theme + '-' + width, theme, width, async () => {}, true, null, null, null, false, chrome);
  }
  // macOS overlay title bar: the folded sidebar sits under the traffic lights (drawn natively, so
  // only the band and the column width show here) and stays as narrow as on other platforms.
  if (width >= 1360) await shot('workbench-slim-macos-' + theme + '-' + width, theme, width, async (page) => {
    await page.evaluate(() => { document.documentElement.dataset.native = 'macos'; });
    await page.getByRole('button', { name: copy('折叠侧栏', 'Collapse sidebar'), exact: true }).click();
    await page.evaluate(() => window.__output('s1', 'live compact output\r\n'));
    await page.locator('[data-activity-slot="rail"][data-activity-icon="live"]').waitFor();
  });
  await shot('workbench-shortcuts-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('region', { name: copy('当前会话', 'Current session') }).getByRole('button', { name: copy('键盘快捷键', 'Keyboard shortcuts') }).click();
  });
  await shot('workbench-empty-' + theme + '-' + width, theme, width, null, true);
}
}
} catch (error) {
  runErrors.push(String(error?.message ?? error).split('\n')[0]);
  console.error(runErrors[runErrors.length - 1]);
} finally {
  await browser?.close().catch(() => {});
}

const failed = manifest.filter((item) => item.pageErrors.length || item.overflow || item.actionError);
fs.writeFileSync(out + '/capture-workbench-manifest.json', JSON.stringify({ generatedAt: new Date().toISOString(), synthetic: true, acceptance, previewUrl, locale, imageCount: manifest.length, success: failed.length === 0 && runErrors.length === 0, runErrors, shots: manifest }, null, 2));

const cards = manifest.map((item) => '    <figure><a href="' + item.name + '.png"><img src="' + item.name + '.png" loading="lazy" alt="' + item.name + '"></a><figcaption>' + item.name + '</figcaption></figure>').join('\n');
fs.writeFileSync(out + '/index.html', [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Cliora 工作台捕获</title><style>',
  'body{margin:0;padding:24px;background:#0f1511;color:#e8f0e9;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}',
  'h1{font-size:18px;margin:0 0 4px}p{margin:0 0 20px;color:#9aa89f}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}',
  'figure{margin:0;background:#161f19;border:1px solid #26332a;border-radius:12px;overflow:hidden}',
  'img{display:block;width:100%;height:auto}figcaption{padding:8px 10px;font-family:Consolas,monospace;font-size:11px;color:#9aa89f}',
  '</style></head><body><h1>Cliora 工作台捕获</h1><p>合成 IPC 数据，仅用于界面检查，不构成原生平台验收。共 ' + manifest.length + ' 张。</p><p>' + acceptanceNote + '</p><div class="grid">',
  cards,
  '</div></body></html>',
].join('\n'));

const rows = manifest.map((item) => '| ' + item.name + ' | ' + item.theme + ' | ' + item.width + ' | ' + (item.pageErrors.length ? '页面错误' : '—') + ' | ' + (item.overflow ? '横向溢出' : '—') + ' | ' + (item.actionError ? '步骤失败' : '—') + ' |').join('\n');
fs.writeFileSync(out + '/README.md', [
  '# 工作台捕获',
  '',
  '[浏览图片画廊](index.html) · [机器可读清单](capture-workbench-manifest.json)',
  '',
  '捕获工作台的长标题会话栏、Git 分支与工作树切换菜单、live/idle 活动图标对照、分屏与精简栏、终端画布与滚动条、显示偏好、快捷输入与查找、已结束提示、新建会话对话框、远程主机与远程文件夹选择器（长路径、权限失败、读取中、未决创建回执）和空状态。workbench-ended 场景同时记录标题截断宽度、工具条裁切、对比度与已结束会话的恢复入口。覆盖浅色与深色主题、1360 / 900 / 640 三档宽度，并以减少动效检查静态形状差异。',
  '',
  '执行：',
  '',
  '```sh',
  'CLIORA_PREVIEW_URL=http://127.0.0.1:14736 node scripts/capture-workbench.mjs',
  '```',
  '',
  '`--theme all|light|dark`、`--size all|1360,900,720`（640 需显式指定或 CLIORA_CAPTURE_640=1）和 `--only "workbench-remote-*"` 可缩小范围；`CLIORA_CAPTURE_OUT` 指定输出目录，`CLIORA_CAPTURE_LOCALE=en-US` 捕获英文界面并写入独立目录。预览服务器需运行当前 frontend build。远程连接状态覆盖连接中、已连接、断开、未知和远端结束；`--only "workbench-remote-prompts-*"` 捕获快捷输入与新建会话提示词读取失败、旧成功陈旧标记及重试入口，保留输入草稿；`--performance` 仅在首个主题/尺寸执行一次 stream 压力场景，在三会话持续输出和切换后记录 GC 后 heap、DOM/listener、CPU task duration 等浏览器观察，不构成原生或长时间泄漏验收。',
  '',
  '终端文本、项目与提示词均为合成数据。' + acceptanceNote + '真实登录与计费也未验证。',
  '',
  '| 图片 | 主题 | 宽度 | 页面错误 | 溢出 | 步骤 |',
  '| --- | --- | --- | --- | --- | --- |',
  rows,
  '',
].join('\n'));
console.log(JSON.stringify({ shots: manifest.length, failed, runErrors, acceptance }, null, 2));
if (failed.length || runErrors.length) process.exitCode = 1;

if (!failed.length && !runErrors.length) prunePrevious(manifest.map(item => item.name + '.png'));
