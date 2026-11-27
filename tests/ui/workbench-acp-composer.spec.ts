import { expect, test, type Locator, type Page } from '@playwright/test';
import { agentMessage, installAcpMock, openWorkbench, snapshot } from './acpMock';

/**
 * The conversation's input and session-level controls (T5): Enter and input-method
 * composition, `/` commands, `@` files, image and file attachments, prompt history,
 * mode and configuration selectors, the login panel, elicitation forms and the
 * history dialog. Everything runs on the synthetic host in acpMock.ts; no CLI or
 * model is involved.
 */

const panelOf = (page: Page, id = 'a1') => page.locator(`[data-acp="true"][data-pane-session="${id}"]`);
const inputOf = (panel: Locator) => panel.getByRole('textbox', { name: '给 Codex 的消息', exact: true });
const testState = (page: Page) => page.evaluate(() => (window as any).__acpTest);
const userMessage = (id: string, text: string) => ({ kind: 'message' as const, id, role: 'user' as const, text, truncated: false, turnId: 'turn-0', subagent: null });
const textAgent = { protocolVersion: 1, agentInfo: null, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { list: false, resume: false, delete: false, close: false }, loadSession: false, authMethods: [] };
const imageAgent = { ...textAgent, promptCapabilities: { image: true, audio: false, embeddedContext: true } };

/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Paste image files (and nothing else) into an input, as a clipboard paste does. */
async function pasteImages(target: Locator, names: string[], bytes = 0) {
  await target.evaluate((node, { names, data, bytes }) => {
    const transfer = new DataTransfer();
    for (const name of names) {
      const body = bytes > 0 ? new Uint8Array(bytes) : Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      transfer.items.add(new File([body], name, { type: 'image/png' }));
    }
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { names, data: PNG, bytes });
}

async function dropImage(target: Locator, name: string) {
  await target.evaluate((node, { name, data }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], name, { type: 'image/png' }));
    node.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    node.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name, data: PNG });
}

test('Enter waits for the input method, Shift+Enter adds a line, a running turn keeps the draft, a failed send keeps everything and history comes back', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', agent: imageAgent, timeline: [userMessage('u0', '先读 README'), agentMessage('m0', '读完了。')] })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();

  // While an input method composes, Enter belongs to the composition and sends nothing.
  await input.click();
  await input.evaluate((node) => node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
  await input.fill('你好');
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true, isComposing: true })));
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
  expect((await testState(page)).prompts).toEqual([]);
  // The composition ends; the next Enter sends exactly once.
  await input.evaluate((node) => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' })));
  await input.press('Enter');
  await expect.poll(async () => (await testState(page)).prompts).toEqual([['a1', '你好']]);
  await expect(input).toHaveValue('');

  // Shift+Enter is a new line, not a send.
  await input.pressSequentially('第一行');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('第一行\n第二行');
  expect((await testState(page)).prompts).toHaveLength(1);
  await input.press('Enter');
  await expect.poll(async () => (await testState(page)).prompts.at(-1)).toEqual(['a1', '第一行\n第二行']);

  // A running turn: the draft stays editable, Enter does not send, the main button stops.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'running', seq: 5 }));
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await expect(input).toBeEnabled();
  await input.fill('下一步：跑单测');
  await input.press('Enter');
  expect((await testState(page)).prompts).toHaveLength(2);
  await panel.getByRole('button', { name: '停止', exact: true }).click();
  expect((await testState(page)).cancels).toEqual(['a1']);
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'ready', seq: 6 }));
  await expect(input).toHaveValue('下一步：跑单测');

  // A refused send keeps the draft and its attachment and says why.
  await pasteImages(input, ['shot.png']);
  await expect(panel.getByRole('img', { name: '图片 shot.png' })).toBeVisible();
  await page.evaluate(() => { (window as any).__acpTest.failPrompt = 'agent 拒绝：上一轮还没结束'; });
  await input.press('Enter');
  await expect(panel.getByRole('alert').filter({ hasText: 'agent 拒绝：上一轮还没结束' })).toBeVisible();
  await expect(input).toHaveValue('下一步：跑单测');
  await expect(panel.getByRole('img', { name: '图片 shot.png' })).toBeVisible();
  await page.evaluate(() => { (window as any).__acpTest.failPrompt = null; });
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await testState(page)).prompts.at(-1)).toEqual(['a1', '下一步：跑单测']);
  const sent = (await testState(page)).attachments.at(-1);
  expect(sent).toEqual(['a1', [{ type: 'image', mimeType: 'image/png', dataBase64: PNG }]]);
  await expect(input).toHaveValue('');
  await expect(panel.getByRole('img', { name: '图片 shot.png' })).toHaveCount(0);

  // Up and down on an empty input walk the earlier prompts, newest first, then back to empty.
  await input.press('ArrowUp');
  await expect(input).toHaveValue('下一步：跑单测');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('第一行\n第二行');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('你好');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('先读 README');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('你好');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');
});

test('a prompt that waits for an approval stays stoppable, and a stop keeps the draft and its attachments', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', agent: imageAgent })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();
  await page.evaluate(() => { (window as any).__acpTest.holdPrompt = true; });
  await input.fill('读一下 D:/outside/notes.md');
  await pasteImages(input, ['shot.png']);
  await input.press('Enter');
  // Sending: no second send, the draft is still there.
  await expect(panel.getByRole('button', { name: '正在发送…', exact: true })).toBeDisabled();
  // The host opens the turn while the attachment waits for its card: the main button stops it.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'running', seq: 2 }));
  const stop = panel.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeEnabled();
  await stop.click();
  expect((await testState(page)).cancels).toEqual(['a1']);
  // The host refuses the prompt and removes its provisional message; nothing is lost here.
  await page.evaluate(() => (window as any).__acpReleasePrompt('本轮已停止，提示词没有发送'));
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'ready', seq: 3 }));
  await expect(panel.getByRole('alert').filter({ hasText: '本轮已停止，提示词没有发送' })).toBeVisible();
  await expect(input).toHaveValue('读一下 D:/outside/notes.md');
  await expect(panel.getByRole('img', { name: '图片 shot.png' })).toBeVisible();
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await testState(page)).prompts).toEqual([['a1', '读一下 D:/outside/notes.md']]);
});

test('/ opens the declared commands with keyboard completion, plain / stays text, and @ attaches a file from the session directory', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', files: ['src/main.ts', 'src/lib/native.ts', 'README.md'], conversations: [snapshot({ id: 'a1' })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();

  // No declared commands: `/` is an ordinary character.
  await input.pressSequentially('/tmp');
  await expect(panel.getByRole('listbox')).toHaveCount(0);
  await expect(input).toHaveValue('/tmp');
  await input.fill('');

  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 2, kind: 'commands', commands: [
    { name: 'review', description: '审查当前改动', hint: null },
    { name: 'init', description: '生成 AGENTS.md', hint: '目录' },
  ] }));
  await input.pressSequentially('/');
  const commands = panel.getByRole('listbox', { name: '命令', exact: true });
  await expect(commands).toBeVisible();
  await expect(commands.getByRole('option')).toHaveCount(2);
  await expect(commands.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown');
  await expect(commands.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue('/init ');
  await expect(commands).toHaveCount(0);
  expect((await testState(page)).prompts).toEqual([]);
  // Typing narrows the list; Escape closes it and leaves the text alone.
  await input.fill('');
  await input.pressSequentially('/rev');
  await expect(commands.getByRole('option')).toHaveCount(1);
  await expect(commands.getByRole('option')).toContainText('审查当前改动');
  await input.press('Escape');
  await expect(commands).toHaveCount(0);
  await expect(input).toHaveValue('/rev');
  await input.fill('');

  // `@` looks up files through acp_list_files; the chosen one becomes a file attachment.
  await input.pressSequentially('看看 @nat');
  const files = panel.getByRole('listbox', { name: '会话目录内的文件', exact: true });
  await expect(files.getByRole('option')).toHaveCount(1);
  await expect(files.getByRole('option')).toHaveText('src/lib/native.ts');
  expect((await testState(page)).fileQueries.at(-1)).toEqual(['a1', 'nat', 50]);
  await input.press('Enter');
  await expect(input).toHaveValue('看看 @src/lib/native.ts ');
  await expect(files).toHaveCount(0);
  await expect(panel.getByRole('list', { name: '附件' }).getByRole('listitem')).toHaveText('src/lib/native.ts');
  await input.pressSequentially('的导出');
  await input.press('Enter');
  await expect.poll(async () => (await testState(page)).prompts).toEqual([['a1', '看看 @src/lib/native.ts 的导出']]);
  expect((await testState(page)).attachments).toEqual([['a1', [{ type: 'file', path: 'src/lib/native.ts' }]]]);
  await expect(panel.getByRole('list', { name: '附件' })).toHaveCount(0);
});

test('images follow the agent: refused with a reason for a text-only agent, previewed, removable, sent and bounded otherwise', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', agent: textAgent })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();

  // Text only: a pasted or dropped image is refused and the reason is shown.
  await pasteImages(input, ['shot.png']);
  const notice = panel.locator('[data-acp-attach-notice]');
  await expect(notice).toContainText('Codex 没有声明图片能力');
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await dropImage(input, 'dropped.png');
  await expect(notice).toContainText('Codex 没有声明图片能力');
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);

  // The agent declares images: previews appear, one can be removed, the rest are sent.
  await page.evaluate((agent) => (window as any).__acpSessionState('a1', { agent, seq: 3 }), imageAgent);
  await pasteImages(input, ['a.png']);
  await dropImage(input, 'b.png');
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(2);
  await expect(panel.getByRole('img', { name: '图片 a.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await panel.getByRole('button', { name: '移除附件 a.png', exact: true }).click();
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(1);
  await input.fill('看这张截图');
  await input.press('Enter');
  await expect.poll(async () => (await testState(page)).attachments).toEqual([['a1', [{ type: 'image', mimeType: 'image/png', dataBase64: PNG }]]]);
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);

  // Past the limits: more than eight images, and one over 5 MiB, are refused with a reason.
  await pasteImages(input, Array.from({ length: 9 }, (_, index) => `many-${index}.png`));
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(8);
  await expect(notice).toContainText('最多附加 8 张图片');
  await panel.getByRole('button', { name: '移除附件 many-0.png', exact: true }).click();
  await pasteImages(input, ['huge.png'], 5 * 1024 * 1024 + 1);
  await expect(notice).toContainText('图片 huge.png 超过 5 MiB 上限');
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(7);
});

test('declared modes and options get selectors that send, show the new value and roll back on refusal; undeclared ones are absent; narrow panes fold them', async ({ page }) => {
  const config = {
    modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: '提问', description: null }, { id: 'code', name: '写代码', description: '可以改文件' }] },
    options: [{ id: 'effort', name: '思考强度', description: null, category: 'thought_level', type: 'select' as const, currentValue: 'low', options: [{ value: 'low', name: '低', description: null, group: null }, { value: 'high', name: '高', description: null, group: null }] }],
    models: null,
  };
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', config }), snapshot({ id: 'a2', timeline: [agentMessage('m2', '没有设置项')] })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  const mode = panel.getByRole('combobox', { name: '模式', exact: true });
  const effort = panel.getByRole('combobox', { name: '思考强度', exact: true });
  await expect(mode).toHaveValue('ask');
  await expect(effort).toHaveValue('low');

  await mode.selectOption('code');
  await expect.poll(async () => (await testState(page)).modes).toEqual([['a1', 'code']]);
  await expect(mode).toHaveValue('code');

  // A refusal returns to the value it had and names the reason.
  await page.evaluate(() => { (window as any).__acpTest.failSetting = 'agent 拒绝切换思考强度'; });
  await effort.selectOption('high');
  await expect.poll(async () => (await testState(page)).configs).toEqual([['a1', 'effort', 'high']]);
  await expect(effort).toHaveValue('low');
  await expect(panel.getByRole('alert').filter({ hasText: '思考强度 没有切换，已恢复原值：agent 拒绝切换思考强度' })).toBeVisible();

  // The host's own config update is what stays.
  await page.evaluate((config) => (window as any).__acpEvent({ sessionId: 'a1', seq: 4, kind: 'config', config: { ...config, modes: { ...config.modes, currentModeId: 'ask' } } }), config);
  await expect(mode).toHaveValue('ask');

  // A conversation that declared nothing shows no selector.
  await page.locator('[data-session-id="a2"]').first().click();
  await expect(panelOf(page, 'a2')).toBeVisible();
  await expect(panelOf(page, 'a2').locator('[data-acp-settings]')).toHaveCount(0);
  await expect(panelOf(page, 'a2').getByRole('combobox')).toHaveCount(0);

  // A narrow pane folds the selectors into the "⋯" menu.
  await page.locator('[data-session-id="a1"]').first().click();
  await page.setViewportSize({ width: 720, height: 720 });
  const settings = panel.locator('[data-acp-settings]');
  await expect(settings).toHaveAttribute('data-acp-settings', 'menu');
  await expect(mode).toHaveCount(0);
  const more = panel.getByRole('button', { name: '会话设置', exact: true });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(mode).toBeVisible();
  await mode.selectOption('code');
  await expect.poll(async () => (await testState(page)).modes.at(-1)).toEqual(['a1', 'code']);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('a login replaces the input: methods log in, a failure says why and retries, the terminal login opens a terminal in the same directory', async ({ page }) => {
  const agent = { ...textAgent, authMethods: [
    { id: 'oauth', name: '浏览器', description: '在浏览器里完成登录', type: 'agent' },
    { id: 'cli', name: '命令行', description: null, type: 'terminal' },
  ] };
  await installAcpMock(page, { interaction: 'acp', failAuth: 'token 已过期', conversations: [snapshot({ id: 'a1', state: 'auth_required', authError: 'agent 要求先登录', agent })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const login = panel.getByRole('region', { name: 'Codex 需要登录', exact: true });
  await expect(login).toBeVisible();
  await expect(login).toContainText('agent 要求先登录');
  await expect(login).toContainText('命令行：需要在终端里完成');
  await expect(inputOf(panel)).toHaveCount(0);

  const method = login.getByRole('button', { name: '用 浏览器 登录', exact: true });
  await method.click();
  await expect(login.getByRole('alert')).toContainText('登录没有完成：token 已过期');
  await expect(method).toBeEnabled();
  await page.evaluate(() => { (window as any).__acpTest.failAuth = null; });
  await method.click();
  await expect.poll(async () => (await testState(page)).authentications).toEqual([['a1', 'oauth'], ['a1', 'oauth']]);

  // The host reports the login; the input comes back.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'ready', authError: null, seq: 3 }));
  await expect(login).toHaveCount(0);
  await expect(inputOf(panel)).toBeEnabled();
});

test('the terminal login starts a terminal session in the conversation directory', async ({ page }) => {
  const agent = { ...textAgent, authMethods: [{ id: 'cli', name: '命令行', description: null, type: 'terminal' }] };
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'auth_required', directory: 'C:/work/app', agent })] });
  await openWorkbench(page);
  const login = panelOf(page).getByRole('region', { name: 'Codex 需要登录', exact: true });
  await expect(login).toContainText('Codex 没有声明可以在对话里完成的登录方式');
  await login.getByRole('button', { name: '用终端登录', exact: true }).click();
  await expect.poll(async () => (await testState(page)).launches.at(-1)).toMatchObject({ toolId: 'codex', interaction: 'terminal', directory: 'C:/work/app', sessionId: null });
});

test('an elicitation form checks its schema, sends nothing invalid, and declines or cancels with their own answers', async ({ page }) => {
  const requestedSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: '名称', minLength: 2 },
      email: { type: 'string', title: '邮箱', format: 'email' },
      count: { type: 'integer', title: '数量', minimum: 1, maximum: 5 },
      color: { type: 'string', title: '颜色', oneOf: [{ const: 'red', title: '红' }, { const: 'blue', title: '蓝' }] },
      tags: { type: 'array', title: '标签', items: { enum: ['ui', 'api', 'docs'] }, minItems: 1 },
      notify: { type: 'boolean', title: '完成后通知', default: true },
    },
    required: ['name', 'color', 'tags'],
  };
  const form = (id: string, requestId: string) => ({ kind: 'elicitation', id, message: '补充发布信息', requestedSchema, toolCallId: null, decision: 'pending', requestId, turnId: 'turn-1', subagent: null });
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'waiting_permission', timeline: [form('e1', 'q1'), form('e2', 'q2'), form('e3', 'q3')] as any, pending: ['q1', 'q2', 'q3'] })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const first = panel.locator('[data-item-id="e1"]');
  await expect(first).toBeVisible();

  await first.getByRole('textbox', { name: '名称' }).fill('a');
  await first.getByRole('textbox', { name: '邮箱' }).fill('not-an-email');
  await first.getByRole('spinbutton', { name: '数量' }).fill('9');
  await first.getByRole('button', { name: '提交', exact: true }).click();
  await expect(first.getByRole('alert')).toContainText('有 5 项需要修改后才能提交');
  await expect(first.getByText('至少 2 个字符')).toBeVisible();
  await expect(first.getByText('请输入有效的邮箱地址')).toBeVisible();
  await expect(first.getByText('不能大于 5')).toBeVisible();
  // Required choices left empty are marked too.
  await expect(first.locator('[data-field="color"]')).toContainText('请填写或选择这一项');
  await expect(first.locator('[data-field="tags"]')).toContainText('请填写或选择这一项');
  await expect(first.getByRole('textbox', { name: '名称' })).toHaveAttribute('aria-invalid', 'true');
  expect((await testState(page)).elicitationAnswers).toEqual([]);

  await first.getByRole('textbox', { name: '名称' }).fill('发布 2.0');
  await first.getByRole('textbox', { name: '邮箱' }).fill('dev@example.com');
  await first.getByRole('spinbutton', { name: '数量' }).fill('3');
  await first.getByRole('combobox', { name: '颜色' }).selectOption('blue');
  await first.getByRole('checkbox', { name: 'api' }).check();
  await first.getByRole('checkbox', { name: 'docs' }).check();
  await first.getByRole('button', { name: '提交', exact: true }).click();
  await expect.poll(async () => (await testState(page)).elicitationAnswers).toEqual([
    ['a1', 'q1', 'accept', { name: '发布 2.0', email: 'dev@example.com', count: 3, color: 'blue', tags: ['api', 'docs'], notify: true }],
  ]);

  await panel.locator('[data-item-id="e2"]').getByRole('button', { name: '拒绝回答', exact: true }).click();
  await panel.locator('[data-item-id="e3"]').getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(async () => (await testState(page)).elicitationAnswers.slice(1)).toEqual([['a1', 'q2', 'decline', null], ['a1', 'q3', 'cancel', null]]);

  // The host closes an answered form; it then reads as a record.
  await page.evaluate((item) => (window as any).__acpEvent({ sessionId: 'a1', seq: 5, kind: 'item', item }), { ...form('e2', 'q2'), decision: 'declined', requestId: null });
  await expect(panel.locator('[data-item-id="e2"]')).toContainText('已拒绝回答');
  await expect(panel.locator('[data-item-id="e2"]').getByRole('button')).toHaveCount(0);
});

test('the history dialog lists, pages, resumes in a new pane and deletes only after a second confirmation', async ({ page }) => {
  const sessions = [
    { nativeId: 'n1', title: '当前这次', updatedAt: '2026-11-27T08:00:00Z', cwd: 'C:/work', current: true },
    { nativeId: 'n2', title: '修复登录', updatedAt: '2026-11-26T08:00:00Z', cwd: 'C:/work', current: false },
    { nativeId: 'n3', title: '重构终端', updatedAt: '2026-11-25T08:00:00Z', cwd: 'C:/work', current: false },
  ];
  const agent = { ...textAgent, sessionCapabilities: { list: true, resume: true, delete: true, close: false } };
  await installAcpMock(page, { interaction: 'acp', nativeSessions: [sessions, [{ nativeId: 'n4', title: null, updatedAt: null, cwd: null, current: false }]], conversations: [snapshot({ id: 'c1', agent, timeline: [agentMessage('m1', '已有对话')] })] });
  await openWorkbench(page);
  const panel = panelOf(page, 'c1');
  await panel.getByRole('button', { name: '历史会话…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 的历史会话' });
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('[data-native-id]');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('当前对话');
  await dialog.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toContainText('未命名会话');
  await expect(dialog.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  expect((await testState(page)).historyQueries).toEqual([['c1', null], ['c1', 'page-1']]);

  // Delete asks first; cancelling sends nothing.
  const second = dialog.locator('[data-native-id="n2"]');
  await second.getByRole('button', { name: '删除', exact: true }).click();
  await expect(second).toContainText('删除后无法恢复');
  await second.getByRole('button', { name: '取消', exact: true }).click();
  expect((await testState(page)).deletions).toEqual([]);
  await second.getByRole('button', { name: '删除', exact: true }).click();
  await second.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect.poll(async () => (await testState(page)).deletions).toEqual([['c1', 'n2']]);
  await expect(dialog.locator('[data-native-id="n2"]')).toHaveCount(0);
  // The current conversation cannot be deleted or resumed from here.
  await expect(rows.first().getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
  await expect(rows.first().getByRole('button', { name: '恢复', exact: true })).toBeDisabled();

  // Resume opens a new pane that continues the chosen native session.
  await dialog.locator('[data-native-id="n3"]').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await testState(page)).launches.at(-1)).toMatchObject({ toolId: 'codex', interaction: 'acp', resumeNativeId: 'n3', sessionId: null, initialPrompt: null });
  await expect(panelOf(page, 'a1')).toBeVisible();
  await expect(panelOf(page, 'a1')).toContainText('已续接上次的原生会话');
});

test('an agent without session listing explains why instead of listing', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', agent: textAgent })] });
  await openWorkbench(page);
  await panelOf(page).getByRole('button', { name: '历史会话…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 的历史会话' });
  await expect(dialog.locator('[data-acp-history-unsupported]')).toContainText('Codex 没有声明会话列表能力');
  expect((await testState(page)).historyQueries).toEqual([]);
});

test('the shared quick input routes a pasted image to the conversation and sends it with the text', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', agent: imageAgent })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: '快捷输入', exact: true }).click();
  const quick = page.getByRole('textbox', { name: /提示词/ }).last();
  await expect(quick).toBeVisible();
  await pasteImages(quick, ['clip.png']);
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(1);
  await quick.fill('这张图里的报错');
  await quick.press('Enter');
  await expect.poll(async () => (await testState(page)).prompts).toEqual([['a1', '这张图里的报错']]);
  expect((await testState(page)).attachments).toEqual([['a1', [{ type: 'image', mimeType: 'image/png', dataBase64: PNG }]]]);
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
});

test('allow always is secondary to allow once, the pane shows one state, and a finished plan folds to its progress', async ({ page }) => {
  const permission = { requestId: 'r1', turnId: 'turn-1', options: [
    { optionId: 'once', name: '允许一次', kind: 'allow_once' },
    { optionId: 'always', name: '总是允许', kind: 'allow_always' },
    { optionId: 'no', name: '拒绝', kind: 'reject_once' },
  ] };
  const tool = { kind: 'tool', id: 'tool:c1', callId: 'c1', title: '写入 a.ts', toolKind: 'edit', status: 'pending', content: [], locations: [], rawInput: null, turnId: 'turn-1', subagent: null, permission };
  const done = [{ content: '读代码', priority: 'medium', status: 'completed' }, { content: '改代码', priority: 'high', status: 'completed' }];
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'waiting_permission', timeline: [tool] as any, pending: ['r1'], plan: done as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const card = panel.getByRole('group', { name: '写入 a.ts' });
  await expect(card.getByRole('button', { name: '允许一次', exact: true })).toHaveAttribute('data-variant', 'primary');
  await expect(card.getByRole('button', { name: '总是允许', exact: true })).toHaveAttribute('data-variant', 'secondary');
  await expect(card.getByRole('button', { name: '拒绝', exact: true })).toHaveAttribute('data-variant', 'quiet');

  // The conversation row keeps its state for assistive tech only; the stage bar shows it.
  const state = panel.locator('[data-acp-bar] [data-acp-state]');
  await expect(state).toHaveText('等你处理');
  expect(await state.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);

  // Every entry done: one line with n/n, the list folded until opened.
  const plan = panel.locator('[data-acp-plan]');
  await expect(plan).toContainText('计划 · 2/2');
  await expect(plan).not.toHaveAttribute('open', '');
  await expect(plan.locator('li').first()).toBeHidden();
  await plan.locator('summary').click();
  await expect(plan.locator('li').first()).toBeVisible();
  await plan.locator('summary').click();
  await expect(plan.locator('li').first()).toBeHidden();
  // An update with unfinished work opens it again.
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 2, kind: 'plan', entries: [
    { content: '读代码', priority: 'medium', status: 'completed' }, { content: '跑测试', priority: 'high', status: 'in_progress' },
  ] }));
  await expect(plan).toContainText('计划 · 1/2');
  await expect(plan.locator('li').nth(1)).toBeVisible();

  // A session waiting for a login has its own state wording.
  await page.evaluate(() => (window as any).__acpSessionState('a1', { state: 'auth_required', pending: [], seq: 3 }));
  await expect(state).toHaveText('需要登录');
});

/** A desktop drop: the webview delivers paths at a physical position over the pane. */
async function dropPaths(page: Page, panel: Locator, paths: string[]) {
  const box = await panel.boundingBox();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.evaluate(({ point, paths }) => {
    const scale = window.devicePixelRatio || 1;
    (window as any).__acpDrop(paths, { x: point.x * scale, y: point.y * scale });
  }, { point, paths });
}

test('a desktop drop of an image path is read by the host, previewed, removable and sent as an image; a refused read says why', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', images: {
    'C:/work/shot.png': { mimeType: 'image/png', dataBase64: PNG },
    'C:/work/later.png': { mimeType: 'image/png', dataBase64: PNG },
    'C:/work/fake.png': '文件内容与扩展名不符，不是有效的图片',
  }, conversations: [snapshot({ id: 'a1', agent: textAgent })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();
  const notice = panel.locator('[data-acp-attach-notice]');

  // Text only: the dropped picture is refused before anything is read.
  await dropPaths(page, panel, ['C:/work/shot.png']);
  await expect(notice).toContainText('Codex 没有声明图片能力');
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
  expect((await testState(page)).imageReads).toEqual([]);

  // Images declared: the host reads the file; meanwhile the tray says so and nothing is sent.
  await page.evaluate((agent) => (window as any).__acpSessionState('a1', { agent, seq: 3 }), imageAgent);
  await page.evaluate(() => { (window as any).__acpTest.holdImage = true; });
  await dropPaths(page, panel, ['C:/work/shot.png', 'C:/work/notes.md']);
  const reading = panel.locator('[data-attachment="reading"]');
  await expect(reading).toHaveCount(1);
  await expect(reading.getByRole('status', { name: '正在读取图片 shot.png…' })).toBeAttached();
  await expect(panel.locator('[data-attachment="file"]')).toHaveText('notes.md');
  expect((await testState(page)).imageReads).toEqual([['a1', 'C:/work/shot.png']]);
  await input.fill('对照这张截图');
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await input.press('Enter');
  expect((await testState(page)).prompts).toEqual([]);
  await page.evaluate(() => (window as any).__acpReleaseImage());
  await expect(reading).toHaveCount(0);
  await expect(panel.getByRole('img', { name: '图片 shot.png' })).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
  // The same file dropped again is not read twice.
  await dropPaths(page, panel, ['C:/work/shot.png']);
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(1);
  expect((await testState(page)).imageReads).toHaveLength(1);

  // A refused read names the reason instead of attaching a plain file.
  await dropPaths(page, panel, ['C:/work/fake.png']);
  await expect(notice).toContainText('无法附加图片 fake.png：文件内容与扩展名不符，不是有效的图片');
  await expect(panel.locator('[data-attachment]')).toHaveCount(2);

  // A read removed while it runs leaves nothing behind.
  await page.evaluate(() => { (window as any).__acpTest.holdImage = true; });
  await dropPaths(page, panel, ['C:/work/later.png']);
  await expect(reading).toHaveCount(1);
  await panel.getByRole('button', { name: '移除附件 later.png', exact: true }).click();
  await expect(reading).toHaveCount(0);
  await page.evaluate(() => (window as any).__acpReleaseImage());
  await expect(panel.locator('[data-attachment="image"]')).toHaveCount(1);

  // Sent as an image block next to the file.
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await testState(page)).prompts).toEqual([['a1', '对照这张截图']]);
  expect((await testState(page)).attachments).toEqual([['a1', [{ type: 'file', path: 'C:/work/notes.md' }, { type: 'image', mimeType: 'image/png', dataBase64: PNG }]]]);
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
});

test('Enter while the @ lookup is still running waits for it instead of sending the bare text', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', files: ['src/lib/native.ts'], conversations: [snapshot({ id: 'a1' })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const input = inputOf(panel);
  await expect(input).toBeVisible();
  await page.evaluate(() => { (window as any).__acpTest.holdFiles = true; });
  await input.pressSequentially('看看 @nat');
  const files = panel.getByRole('listbox', { name: '会话目录内的文件', exact: true });
  await expect(files).toContainText('正在查找文件…');
  await expect.poll(async () => (await testState(page)).fileQueries.length).toBeGreaterThan(0);
  await input.press('Enter');
  await expect(input).toHaveValue('看看 @nat');
  expect((await testState(page)).prompts).toEqual([]);
  await page.evaluate(() => (window as any).__acpReleaseFiles());
  await expect(files.getByRole('option')).toHaveText('src/lib/native.ts');
  await input.press('Enter');
  await expect(input).toHaveValue('看看 @src/lib/native.ts ');
  expect((await testState(page)).prompts).toEqual([]);
});

test('without session listing the history dialog offers a new conversation in the same directory', async ({ page }) => {
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'c1', agent: textAgent, directory: 'C:/work/app', timeline: [agentMessage('m1', '已有对话')] })] });
  await openWorkbench(page);
  await panelOf(page, 'c1').getByRole('button', { name: '历史会话…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Codex 的历史会话' });
  await expect(dialog.locator('[data-acp-history-unsupported]')).toContainText('Codex 没有声明会话列表能力');
  await dialog.getByRole('button', { name: '新开一个对话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await testState(page)).launches.at(-1)).toMatchObject({ toolId: 'codex', interaction: 'acp', directory: 'C:/work/app', sessionId: null, initialPrompt: null });
  expect((await testState(page)).launches.at(-1).resumeNativeId ?? null).toBeNull();
  expect((await testState(page)).historyQueries).toEqual([]);
});

test('the plan keeps the reader\'s fold while the host republishes the same plan, and decides afresh when it changes', async ({ page }) => {
  const plan = [{ content: '读代码', priority: 'medium', status: 'completed' }, { content: '改代码', priority: 'high', status: 'in_progress' }];
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', plan: plan as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  const planBox = panel.locator('[data-acp-plan]');
  const first = planBox.locator('li').first();
  await expect(first).toBeVisible();
  // The reader folds an unfinished plan; snapshots with the same plan (a new array each
  // time, as the host publishes them) leave it folded.
  await planBox.locator('summary').click();
  await expect(first).toBeHidden();
  await page.evaluate((plan) => (window as any).__acpSessionState('a1', { state: 'running', plan: JSON.parse(JSON.stringify(plan)), seq: 2 }), plan);
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.evaluate((plan) => (window as any).__acpSessionState('a1', { state: 'ready', plan: JSON.parse(JSON.stringify(plan)), seq: 3 }), plan);
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(first).toBeHidden();
  // A change of the plan opens it again.
  await page.evaluate(() => (window as any).__acpEvent({ sessionId: 'a1', seq: 4, kind: 'plan', entries: [
    { content: '读代码', priority: 'medium', status: 'completed' }, { content: '改代码', priority: 'high', status: 'completed' }, { content: '跑测试', priority: 'high', status: 'pending' },
  ] }));
  await expect(planBox).toContainText('计划 · 2/3');
  await expect(first).toBeVisible();

  // A finished plan the reader opened stays open through the same republished plan.
  const done = [{ content: '读代码', priority: 'medium', status: 'completed' }, { content: '改代码', priority: 'high', status: 'completed' }];
  await page.evaluate((done) => (window as any).__acpEvent({ sessionId: 'a1', seq: 5, kind: 'plan', entries: done }), done);
  await expect(planBox).toContainText('计划 · 2/2');
  await expect(first).toBeHidden();
  await planBox.locator('summary').click();
  await expect(first).toBeVisible();
  await page.evaluate((done) => (window as any).__acpSessionState('a1', { state: 'running', plan: JSON.parse(JSON.stringify(done)), seq: 6 }), done);
  await expect(panel.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.evaluate((done) => (window as any).__acpSessionState('a1', { state: 'ready', plan: JSON.parse(JSON.stringify(done)), seq: 7 }), done);
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(first).toBeVisible();
});

test('a form select is as wide as the text field above it', async ({ page }) => {
  const requestedSchema = { type: 'object', properties: {
    name: { type: 'string', title: '名称' },
    color: { type: 'string', title: '颜色', oneOf: [{ const: 'red', title: '红' }, { const: 'blue', title: '蓝' }] },
  } };
  const form = { kind: 'elicitation', id: 'e1', message: '补充信息', requestedSchema, toolCallId: null, decision: 'pending', requestId: 'q1', turnId: 'turn-1', subagent: null };
  await installAcpMock(page, { interaction: 'acp', conversations: [snapshot({ id: 'a1', state: 'waiting_permission', timeline: [form] as any, pending: ['q1'] })] });
  await openWorkbench(page);
  const card = panelOf(page).locator('[data-item-id="e1"]');
  const text = await card.getByRole('textbox', { name: '名称' }).boundingBox();
  const select = await card.getByRole('combobox', { name: '颜色' }).boundingBox();
  expect(Math.abs(text!.width - select!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(text!.x - select!.x)).toBeLessThanOrEqual(1);
});

test('a dropped outside image waits on its own card without hiding Stop, offers only once or deny, and removing it withdraws the card', async ({ page }) => {
  const outside = 'D:/outside/shot.png';
  const later = 'D:/outside/later.png';
  const card = (id: string, path: string) => ({ kind: 'access', id, accessKind: 'read', path, detail: null, decision: 'pending', requestId: `${id}-request`, diff: null, turnId: '', subagent: null, userPath: path });
  const running = [userMessage('u1', '跑一会儿'), { ...agentMessage('m1', '正在处理…'), turnId: 'turn-1' }];
  await installAcpMock(page, { interaction: 'acp', images: {
    [outside]: { mimeType: 'image/png', dataBase64: PNG },
    [later]: { mimeType: 'image/png', dataBase64: PNG },
  }, conversations: [snapshot({ id: 'a1', agent: imageAgent, state: 'running', timeline: running as any })] });
  await openWorkbench(page);
  const panel = panelOf(page);
  await expect(inputOf(panel)).toBeVisible();
  const stop = panel.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeVisible();

  // The drop during the running turn opens a card of the user's own; the host keeps
  // the turn running, so the main button still stops it.
  await page.evaluate(() => { (window as any).__acpTest.holdImage = true; });
  await dropPaths(page, panel, [outside]);
  await expect(panel.locator('[data-attachment="reading"]')).toHaveCount(1);
  await page.evaluate(({ timeline }) => (window as any).__acpSessionState('a1', { state: 'running', timeline, pending: ['access-9-request'], seq: 3 }), { timeline: [...running, card('access-9', outside)] });
  const approval = panel.locator('[data-card="access"][data-request-id="access-9-request"]');
  await expect(approval).toBeVisible();
  await expect(approval).toHaveAttribute('data-by-user', 'true');
  await expect(approval.getByRole('button', { name: '允许一次', exact: true })).toBeVisible();
  await expect(approval.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();
  await expect(approval.getByRole('button')).toHaveCount(2);
  await expect(approval).toContainText('不会让 Codex 获得目录外的读取权限');
  await expect(panel.getByText('1 项等你处理')).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);

  // Removing the picture withdraws its card, so nothing is left waiting.
  await panel.getByRole('button', { name: '移除附件 shot.png', exact: true }).click();
  await expect(panel.locator('[data-attachment="reading"]')).toHaveCount(0);
  await expect.poll(async () => (await testState(page)).accessAnswers).toEqual([['a1', 'access-9-request', 'deny']]);
  await page.evaluate(() => (window as any).__acpReleaseImage());
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(async () => (await testState(page)).cancels).toEqual(['a1']);

  // A card published only after its picture was removed is withdrawn too.
  await page.evaluate(({ timeline }) => (window as any).__acpSessionState('a1', { state: 'ready', timeline, pending: [], seq: 4 }), { timeline: [...running, { ...card('access-9', outside), decision: 'denied', requestId: null }] });
  await expect(panel.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__acpTest.holdImage = true; });
  await dropPaths(page, panel, [later]);
  await expect(panel.locator('[data-attachment="reading"]')).toHaveCount(1);
  await panel.getByRole('button', { name: '移除附件 later.png', exact: true }).click();
  await page.evaluate(({ timeline }) => (window as any).__acpSessionState('a1', { state: 'ready', timeline, pending: ['access-10-request'], seq: 5 }), { timeline: [...running, card('access-10', later)] });
  await expect.poll(async () => (await testState(page)).accessAnswers).toEqual([['a1', 'access-9-request', 'deny'], ['a1', 'access-10-request', 'deny']]);
  await page.evaluate(() => (window as any).__acpReleaseImage());
  await expect(panel.locator('[data-attachment]')).toHaveCount(0);
});
