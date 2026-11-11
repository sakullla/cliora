import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isShellWindowTitle, placeParts, railPlace, railTaskTitle, splitActivityGlyph, stripPlaceSuffix } from '../../src/features/sessions/railTitle.ts';

test('shell window titles and paths are not task titles', () => {
  for (const title of ['Windows PowerShell', '管理员: Windows PowerShell', 'pwsh', 'PowerShell 7.5', 'cmd.exe', '命令提示符', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '~/project', '/usr/bin/bash']) {
    assert.equal(isShellWindowTitle(title), true, title);
  }
  for (const title of ['优化启动至 CLI 完整加载的速度', 'Fix the login flow', 'Kiro']) {
    assert.equal(isShellWindowTitle(title), false, title);
  }
});

test('a trailing folder name is dropped only when it repeats the session folder', () => {
  assert.equal(stripPlaceSuffix('优化启动至 CLI 完整加载的速度 | cliora', ['C:\\Users\\me\\IdeaProjects\\cliora']), '优化启动至 CLI 完整加载的速度');
  assert.equal(stripPlaceSuffix('Review PR - cliora', ['cliora']), 'Review PR');
  assert.equal(stripPlaceSuffix('Review PR - other', ['cliora']), 'Review PR - other');
  assert.equal(stripPlaceSuffix('a-b-c', ['c:\\x\\y']), 'a-b-c');
});

test('a hyphenated folder name is dropped whole, and a hyphen inside a word is not a separator', () => {
  const place = '/Users/me/project/qsyn/e6-ms-tms-base-new-mes-fetch';
  assert.equal(stripPlaceSuffix('创建 support worktree 并编写接口 | e6-ms-tms-base-new-mes-fetch', [place]), '创建 support worktree 并编写接口');
  assert.equal(stripPlaceSuffix('Fix login · acme-svc-orders', ['C:\\Projects\\acme-svc-orders']), 'Fix login');
  assert.equal(stripPlaceSuffix('Fix login — acme-svc-orders', ['acme-svc-orders']), 'Fix login');
  // The repository name of a linked worktree counts as well as its own folder.
  assert.equal(stripPlaceSuffix('Ship it | acme-svc', ['/w/acme-svc-fetch', 'acme-svc']), 'Ship it');
  assert.equal(stripPlaceSuffix('Ship my-acme-svc', ['acme-svc']), 'Ship my-acme-svc');
  assert.equal(stripPlaceSuffix('Ship it | my-acme-svc', ['acme-svc']), 'Ship it | my-acme-svc');
  assert.equal(stripPlaceSuffix('acme-svc', ['acme-svc']), 'acme-svc');
});

test('the rail falls back to the tool name when the title adds nothing', () => {
  assert.equal(railTaskTitle('Windows PowerShell', 'Kiro', ['C:\\Users\\me\\project\\cliora']), '');
  assert.equal(railTaskTitle('Codex', 'Codex', []), '');
  assert.equal(railTaskTitle('实现文章目录 | site', 'Claude Code', ['', '/home/me/site']), '实现文章目录');
});

test('the rail place is the project name or the folder name', () => {
  assert.equal(railPlace('栖点 · 桌面工具', 'C:\\Projects\\cliora'), '栖点 · 桌面工具');
  assert.equal(railPlace(undefined, 'C:\\Users\\me\\IdeaProjects\\cliora\\'), 'cliora');
  assert.equal(railPlace(undefined, '/srv/api-service'), 'api-service');
  assert.equal(railPlace(undefined, null), '');
});

test('a title that only names the session folder falls back to the tool name', () => {
  assert.equal(railTaskTitle('fixture-user', 'Codex', ['', 'C:\\Users\\fixture-user']), '');
  assert.equal(railTaskTitle('cliora', 'Codex', ['栖点', '/home/me/cliora/']), '');
  assert.equal(railTaskTitle('Fix cliora build', 'Codex', ['', '/home/me/cliora']), 'Fix cliora build');
});

test('the animated status glyph is split from the stable task text', () => {
  // Claude Code cycles half circles and stars; Codex prefixes braille spinner frames; Gemini uses diamonds.
  for (const frame of ['◐', '◓', '◑', '◒', '✳', '✶', '✻', '✽', '✢', '·', '*', '⠋']) {
    assert.deepEqual(splitActivityGlyph(`${frame} Claude Code`), { glyph: frame, text: 'Claude Code' }, frame);
  }
  assert.deepEqual(splitActivityGlyph('◑ ✶ 修复登录'), { glyph: '◑ ✶', text: '修复登录' });
  assert.deepEqual(splitActivityGlyph('◇  Ready (cliora)'), { glyph: '◇', text: 'Ready (cliora)' });
  assert.deepEqual(splitActivityGlyph('✋️ Action Required'), { glyph: '✋️', text: 'Action Required' });
  assert.deepEqual(splitActivityGlyph('✨ 远端修复'), { glyph: '✨', text: '远端修复' });
  // Ordinary titles have no glyph.
  for (const title of ['#123 fix login', 'Fix the login flow', '优化启动速度', '(draft) notes', '⠀⠁']) {
    assert.deepEqual(splitActivityGlyph(title), { glyph: '', text: title }, title);
  }
});

test('sibling folders with a shared prefix keep their distinguishing tail visible', () => {
  const parts = placeParts(['acme-svc-orders', 'acme-svc-billing', 'notes', 'acme-svc-orders']);
  assert.deepEqual(parts.get('acme-svc-orders'), { head: 'acme-svc-', tail: 'orders' });
  assert.deepEqual(parts.get('acme-svc-billing'), { head: 'acme-svc-', tail: 'billing' });
  assert.deepEqual(parts.get('notes'), { head: '', tail: 'notes' });
  // Matching ignores case, and a label that is itself a sibling's prefix stays whole.
  assert.deepEqual(placeParts(['Acme-Svc-Orders', 'acme-svc-billing']).get('Acme-Svc-Orders'), { head: 'Acme-Svc-', tail: 'Orders' });
  assert.deepEqual(placeParts(['app', 'app-web']).get('app'), { head: '', tail: 'app' });
  assert.deepEqual(placeParts(['app', 'app-web']).get('app-web'), { head: '', tail: 'app-web' });
});

test('a long lone folder name folds its head and keeps a readable end', () => {
  assert.deepEqual(placeParts(['warehouse-inventory-sync']).get('warehouse-inventory-sync'), { head: 'warehouse-', tail: 'inventory-sync' });
  assert.deepEqual(placeParts(['example_payment_gateway']).get('example_payment_gateway'), { head: 'example_', tail: 'payment_gateway' });
  // Short heads are not worth an ellipsis; short or unsplittable labels stay whole.
  assert.deepEqual(placeParts(['ab-cd', 'ab-ef']).get('ab-cd'), { head: '', tail: 'ab-cd' });
  assert.deepEqual(placeParts(['栖点 · 桌面工具']).get('栖点 · 桌面工具'), { head: '', tail: '栖点 · 桌面工具' });
  assert.deepEqual(placeParts(['averyveryverylongfoldername']).get('averyveryverylongfoldername'), { head: '', tail: 'averyveryverylongfoldername' });
});
