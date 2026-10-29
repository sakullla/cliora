import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isShellWindowTitle, railPlace, railTaskTitle, stripPlaceSuffix } from '../../src/features/sessions/railTitle.ts';

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
