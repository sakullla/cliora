/** Synthetic workbench fixtures for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const previewUrl = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
const acceptanceNote = 'Playwright 与合成 IPC 截图仅用于浏览器界面检查，不是 WebView2、真实桌面主题/焦点/键盘或原生 CLI/文件写入验收；未执行的平台行为均为未验证。';
const acceptance = { kind: 'playwright-synthetic-ipc', nativePlatform: 'unverified', webview2: 'unverified', desktopThemeFocusKeyboard: 'unverified', nativeCliAndFileWrites: 'unverified', note: acceptanceNote };
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

async function install(page, initialTheme, empty = false, remoteState = null, promptFailure = null, directoryMode = null, writeRecovery = false) {
  await page.addInitScript(({ theme, transcripts, blank, language, remoteState, promptFailure, directoryMode, writeRecovery }) => {
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
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
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
            return { kind: (base && base.kind) || 'default', reference, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', shortCommit: 'a1b2c3d',
              remote: 'origin', branch: reference.split('/').slice(1).join('/'), degraded: null, candidates: [], available: true, reason: null };
          }
          if (command === 'worktree_status') {
            if ((window.__captureStatusFails ?? []).includes(args.directory)) throw { message: '无法读取工作树状态：git 返回非零退出码' };
            const preset = (window.__captureStatus ?? {})[args.directory];
            if (preset) return preset;
            if (args.directory === '/repo/cliora') return { worktreePath: args.directory, managed: false, environment: null, branch: 'main', headOid: null, uncommittedFiles: 2, state: 'ready', reason: null };
            return { worktreePath: args.directory, managed: true, environment: 'unprepared', branch: 'feature/workbench-polish', headOid: null, uncommittedFiles: 0, state: 'ready', reason: null };
          }
          if (command === 'list_worktree_ledger') return window.__captureLedger ?? [];
          if (command === 'worktree_prepare') return null;
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
      __bell: () => {
        const data = btoa('\u0007');
        bridge.handlers[bridge.listens['cliora:session-output']]?.({ payload: { sessionId: 's4', dataBase64: data } });
      },
    });
  }, { theme: initialTheme, transcripts: {
    s1: b64(Array.from({ length: 70 }, (_, index) => '  \u001b[2m历史输出 ' + String(index + 1).padStart(2, '0') + ' · session replay preserved\u001b[0m').join('\r\n') + '\r\n\u001b]0;⠋ 重构终端工作区与多会话交互体验\u0007' + transcript),
    s2: b64('\u001b]0;实现文章目录与移动端折叠\u0007' + claudeTranscript),
    s3: b64(finished),
    s4: b64(openCodeTranscript),
    r1: b64('\u001b]0;远程项目 · 独立会话 A\u0007\u001b[36mPi · synthetic SSH terminal\u001b[0m\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-a\r\n\r\n  同一目录的其他会话独立运行，输入属于当前选中会话。\r\n\r\n> '),
    r2: b64('\u001b]0;远程项目 · 独立会话 B\u0007Pi · synthetic SSH terminal\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-b\r\n\r\n> '),
    r3: b64('\u001b]0;远程项目 · 独立会话 C\u0007Pi · synthetic SSH terminal\r\n\r\n  工作目录 /srv/project\r\n  远端身份 cliora-same-directory-c\r\n\r\n> '),
  }, blank: empty, language: english ? 'en' : 'zh', remoteState, promptFailure, directoryMode, writeRecovery });
}

const manifest = [];
// Run-level failures (preview not ready, browser launch) are recorded here instead of crashing, so
// the manifest, gallery and README are always written and the exit code is 1.
const runErrors = [];
let browser = null;
async function shot(name, theme, width, run, empty = false, remoteState = null, promptFailure = null, directoryMode = null, writeRecovery = false) {
  if (!onlyPatterns.some((pattern) => pattern.test(name))) return;
  const errors = [];
  let actionError = null;
  let overflow = null;
  let page = null;
  let resourceObservation = null;
  try {
    page = await browser.newPage({ viewport: { width, height: Math.max(720, Math.round(width * 0.66)) }, deviceScaleFactor: 1, locale: process.env.CLIORA_CAPTURE_LOCALE ?? 'zh-CN', colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
    page.on('pageerror', (error) => errors.push(String(error)));
    await install(page, theme, empty, remoteState, promptFailure, directoryMode, writeRecovery);
    await page.goto(previewUrl);
    await page.getByRole('navigation', { name: copy('页面', 'Pages') }).getByRole('button', { name: copy('工作台', 'Workbench'), exact: true }).click();
    await page.waitForTimeout(900);
    if (remoteState) await page.locator('[role="tab"][data-session-id="r1"]').click();
    if (run) resourceObservation = await run(page) ?? null;
    await page.waitForTimeout(500);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    overflow = size.scroll > size.client ? size : null;
    await page.screenshot({ path: out + '/' + name + '.png', fullPage: false });
  } catch (error) {
    actionError = String(error?.message ?? error).split('\n')[0];
    console.error(name + ': ' + actionError);
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
const sizeOption = option('--size', 'all');
const widths = sizeOption === 'all' ? [1360, 900, 640] : [...new Set(sizeOption.split(',').map(Number))];
if (!widths.length || widths.some((width) => ![1360, 900, 640].includes(width))) throw new Error('Invalid --size; use 1360,900,640');

const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
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
      await area.getByText(failure === 'stale' ? copy('提示词刷新失败，当前显示上次成功读取的内容。', 'Prompt refresh failed. Showing the last successful prompts.') : copy('暂时无法读取此位置的提示词。', 'Could not read prompts from this location.'), { exact: true }).waitFor();
      await area.getByRole('button', { name: copy('重试提示词', 'Retry prompts'), exact: true }).waitFor();
      return page.evaluate(() => ({ ...window.__promptFixture }));
    }, false, 'connected', failure);
  }
  for (const state of ['connecting', 'connected', 'disconnected', 'unknown', 'remote_ended']) {
    await shot(`workbench-remote-${state}-${theme}-${width}`, theme, width, null, false, state);
  }
  await shot(`workbench-remote-write-recovery-${theme}-${width}`, theme, width, async page => {
    const toolbar = page.getByRole('toolbar', { name: copy('终端操作', 'Terminal actions') });
    await toolbar.getByRole('button', { name: copy('写入恢复', 'Write recovery'), exact: true }).waitFor();
    await toolbar.getByRole('button', { name: copy('重新附着远程会话', 'Reattach remote session'), exact: true }).waitFor();
  }, false, 'disconnected', null, null, true);
  await shot(`workbench-remote-stream-${theme}-${width}`, theme, width, async page => {
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
    return dialog;
  };
  // A new worktree: the repository default and its short commit are visible, and the
  // advanced ref plus branch name stay optional.
  await shot('workbench-worktree-new-' + theme + '-' + width, theme, width, async page => {
    const dialog = await openWorktreeDialog(page);
    await dialog.locator('code').filter({ hasText: 'origin/main' }).first().waitFor();
    await dialog.getByRole('button', { name: copy('高级选项', 'Advanced'), exact: true }).click();
    await dialog.getByLabel(copy('基点 ref', 'Base ref'), { exact: true }).fill('origin/develop');
    await dialog.getByRole('button', { name: copy('使用此 ref', 'Use this ref'), exact: true }).click();
    await dialog.locator('code').filter({ hasText: 'origin/develop' }).first().waitFor();
    await dialog.getByLabel(copy('分支名', 'Branch name'), { exact: true }).fill('feat/checkout-flow');
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
    });
    const dialog = await openWorktreeDialog(page);
    await dialog.locator('code').filter({ hasText: 'origin/main' }).first().waitFor();
    await dialog.getByRole('textbox', { name: copy('初始提示词（可选）', 'Initial prompt (optional)') }).fill('feat: 结算流程');
    await dialog.getByRole('button', { name: copy('启动会话', 'Start session'), exact: true }).click();
    await page.locator('[data-worktree-op][data-stage="failed"]').waitFor();
    await page.getByRole('button', { name: copy('重试准备', 'Retry setup'), exact: true }).waitFor();
  });
  // Menu status: real changes, unprepared environment, and an unread status kept unknown.
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
  // Cleanup refused because a running session still uses that checkout.
  await shot('workbench-worktree-cleanup-running-' + theme + '-' + width, theme, width, async page => {
    await page.evaluate(() => {
      window.__captureLedger = [{ mainCheckout: 'C:\\Projects\\cliora', worktreePath: 'C:\\Projects\\cliora', branch: 'feature/workbench-polish', environment: 'unprepared' }];
    });
    await page.getByRole('button', { name: copy('更多终端操作', 'More terminal actions') }).click();
    const menu = page.getByRole('menu', { name: copy('终端操作', 'Terminal actions') });
    await menu.getByRole('menuitem', { name: /清理 feature\/workbench-polish|Remove feature\/workbench-polish/ }).click();
    await menu.getByRole('alert').waitFor();
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
  await shot('workbench-metrics-' + theme + '-' + width, theme, width, async page => {
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
    await page.waitForTimeout(250);
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
    const screen = stage.locator('.xterm-screen:visible');
    await screen.waitFor({ timeout: 20000 });
    await screen.click({ force: true });
    await page.keyboard.press('Control+Shift+M');
    await stage.getByRole('textbox', { name: /编写多行内容|Compose multi-line/ }).fill('review the diff and summarise the risk in one paragraph');
    await page.keyboard.press('Control+Shift+F');
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
  await shot('workbench-ended-' + theme + '-' + width, theme, width, async (page) => {
    await page.getByRole('tab', { name: /Grok/ }).click();
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
  '捕获工作台的长标题会话栏、Git 分支与工作树切换菜单、live/idle 活动图标对照、分屏与精简栏、终端画布与滚动条、显示偏好、快捷输入与查找、已结束提示、新建会话对话框、远程主机与远程文件夹选择器（长路径、权限失败、读取中、未决创建回执）和空状态。workbench-metrics 场景另记录标题截断宽度、工具条裁切、对比度与已结束会话的恢复入口。覆盖浅色与深色主题、1360 / 900 / 640 三档宽度，并以减少动效检查静态形状差异。',
  '',
  '执行：',
  '',
  '```sh',
  'CLIORA_PREVIEW_URL=http://127.0.0.1:14736 node scripts/capture-workbench.mjs',
  '```',
  '',
  '`--theme all|light|dark`、`--size all|1360,900,640` 和 `--only "workbench-remote-*"` 可缩小范围；`CLIORA_CAPTURE_OUT` 指定输出目录，`CLIORA_CAPTURE_LOCALE=en-US` 捕获英文界面并写入独立目录。预览服务器需运行当前 frontend build。远程连接状态覆盖连接中、已连接、断开、未知和远端结束；`--only "workbench-remote-prompts-*"` 捕获快捷输入与新建会话提示词读取失败、旧成功陈旧标记及重试入口，保留输入草稿；stream 场景在三会话持续输出和切换后记录 GC 后 heap、DOM/listener、CPU task duration 等浏览器观察，不构成原生或长时间泄漏验收。',
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
