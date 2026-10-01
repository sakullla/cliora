import { writeFileSync } from 'node:fs';

const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((item) => item.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const call = ++id;
  pending.set(call, { resolve, reject });
  ws.send(JSON.stringify({ id: call, method, params }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
};
await new Promise((resolve) => { ws.onopen = resolve; });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const shot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name, Buffer.from(result.data, 'base64'));
  console.log('saved', name);
};

const mode = process.argv[2] || 'sessions';
if (mode === 'sessions') {
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
