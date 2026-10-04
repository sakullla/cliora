import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const list = await (await fetch(`${process.env.CLIORA_CDP_URL ?? 'http://localhost:9222'}/json`, { signal: AbortSignal.timeout(10000) })).json();
const page = list.find((item) => item.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const call = ++id;
  const timer = setTimeout(() => { pending.delete(call); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
  pending.set(call, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: call, method, params }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
};
ws.onclose = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP connection closed')); } pending.clear(); };
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 10000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }; });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const shot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name, Buffer.from(result.data, 'base64'));
  console.log('saved', name);
};

const mode = process.argv[2] || 'sessions';
if (!['sessions', 'usage', 'tools'].includes(mode)) throw new Error('mode must be sessions, usage or tools');
if (mode === 'tools') {
  const out = resolve(process.env.CLIORA_NATIVE_CAPTURE_OUT ?? 'docs/verification/native-ui');
  mkdirSync(out, { recursive: true });
  const waitFor = async (expression) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the native tools UI');
  };
  await evaluate(`(() => { const button = [...document.querySelectorAll('nav[aria-label="页面"] button')].find(item => item.textContent.trim() === '工具与连接'); button?.click(); })()`);
  await waitFor(`!!document.querySelector('[role="tablist"][aria-label="当前任务"]')`);
  const tool = process.env.CLIORA_CAPTURE_TOOL ?? null;
  if (tool) {
    const selected = await evaluate(`(() => { const button = [...document.querySelectorAll('[role="tab"]')].find(item => item.textContent.trim() === ${JSON.stringify(tool)}); if (!button) return false; button.click(); return true; })()`);
    if (!selected) throw new Error(`Native CLI tab is unavailable: ${tool}`);
    await waitFor(`[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some(item => item.textContent.trim() === ${JSON.stringify(tool)})`);
    await waitFor(`![...document.querySelectorAll('[role="status"]')].some(item => /正在读取/.test(item.textContent))`);
  }
  const captures = [], skipped = [];
  // Read-only navigation: no login, extension operation or file-editor actions.
  for (const [tab, label, name] of [
    ['配置', '工具与连接', 'profile-quotas'], ['账号', 'OAuth 账号管理', 'oauth-accounts'],
    ['MCP', null, 'mcp'], ['Agents', '原生 Agent 定义管理', 'native-agents'],
    ['插件', '原生插件管理', 'native-plugins'],
  ]) {
    const present = await evaluate(`(() => { const button = [...document.querySelectorAll('[role="tablist"][aria-label="当前任务"] [role="tab"]')].find(item => item.textContent.trim() === ${JSON.stringify(tab)}); if (!button) return false; button.click(); return true; })()`);
    if (!present) { skipped.push(tab); continue; }
    await waitFor(`[...document.querySelectorAll('[role="tablist"][aria-label="当前任务"] [role="tab"][aria-selected="true"]')].some(item => item.textContent.trim() === ${JSON.stringify(tab)})`);
    if (label) await waitFor(`!!document.querySelector('[aria-label=${JSON.stringify(label)}]')`);
    await waitFor(`![...document.querySelectorAll('[role="status"]')].some(item => /正在读取|正在处理|正在核对/.test(item.textContent))`);
    const path = resolve(out, `${name}.png`);
    await shot(path); captures.push({ tab, path });
    if (tab === '配置') {
      const expanded = await evaluate(`(() => { const details = [...document.querySelectorAll('section[aria-label="套餐额度"] details')]; for (const item of details) item.open = true; return details.length; })()`);
      if (expanded) { await new Promise(resolve => setTimeout(resolve, 150)); const detailPath = resolve(out, 'profile-quota-details.png'); await shot(detailPath); captures.push({ tab, state: 'quota-details', path: detailPath }); }
      await evaluate(`(() => { for (const item of document.querySelectorAll('section[aria-label="套餐额度"] details')) item.open = false; })()`);
    }
  }
  await evaluate(`(() => { const button = [...document.querySelectorAll('[role="tablist"][aria-label="当前任务"] [role="tab"]')].find(item => item.textContent.trim() === '配置'); button?.click(); })()`);
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), synthetic: false, tool, origin: await evaluate('location.origin'), candidateSha256: process.env.CLIORA_CANDIDATE_SHA256 ?? null, captures, skipped, note: 'Local native UI capture only; not full CLI/platform acceptance.' }, null, 2) + '\n');
} else if (mode === 'sessions') {
  await evaluate(`(() => { const b = [...document.querySelectorAll('[role="tab"]')].find(x => x.textContent.startsWith('会话')); b && b.click(); return true; })()`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await evaluate(`(() => {
    const fav = document.querySelector('[aria-label="收藏会话"], [aria-label="取消收藏"]');
    const command = document.querySelector('[aria-label="原生恢复命令"]');
    const head = document.querySelector('[class*="detailHead"]');
    return {
      favoriteVisible: fav ? fav.getBoundingClientRect().right <= (head?.getBoundingClientRect().right ?? 0) + 1 : null,
      favoriteText: fav?.textContent ?? null,
      commandFullWidth: command ? command.getBoundingClientRect().width : null,
      listItems: document.querySelectorAll('[aria-label="会话列表"] > button').length,
    };
  })()`);
  console.log(JSON.stringify(state));
  await shot('records-sessions.png');
} else {
  await evaluate(`(() => { const b = [...document.querySelectorAll('[role="tab"]')].find(x => x.textContent.trim() === '用量'); b && b.click(); return true; })()`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await shot('records-usage.png');
}
process.exit(0);
