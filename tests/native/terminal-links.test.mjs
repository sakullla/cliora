import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalLinkCache, findTerminalLinks, oscTerminalLink, TERMINAL_LINK_TEXT_LIMIT } from '../../src/features/sessions/terminalLinkDetection.ts';

test('terminal paths retain native separators, Unicode, spaces and source locations', () => {
  const paths = ['C:\\work\\src\\main.ts:12:3', 'C:/work/readme.md', '\\\\server\\share\\file.txt', '\\\\?\\C:\\work\\file.txt', '/tmp/文档.txt', '~/project/', './src/a.ts', '../docs/guide.md', 'src/features/app.tsx(42,3)', 'src/(app)/[id]/page.tsx', 'node_modules/@types/node/index.d.ts', 'README.md', '.env', 'Dockerfile'];
  for (const path of paths) {
    const text = `output (${path}).`;
    const matches = findTerminalLinks(text);
    assert.equal(matches.length, 1, path);
    assert.equal(matches[0].kind, 'path');
    assert.equal(matches[0].value, path);
    assert.equal(text.slice(matches[0].start, matches[0].end), path);
  }
  for (const quote of ['"', "'", '`']) {
    const path = 'C:\\work space\\中文 file.txt';
    assert.equal(findTerminalLinks(`${quote}${path}${quote}`)[0].value, path);
    assert.equal(findTerminalLinks(`${quote}my file.md${quote}`)[0].value, 'my file.md');
  }
});

test('URLs retain precedence, balanced punctuation and their full query', () => {
  const url = 'https://example.test/a_(b)?q=1#result';
  const matches = findTerminalLinks(`url=${url} src/app.ts (${url}).`);
  assert.deepEqual(matches.map(({ kind, value }) => ({ kind, value })), [{ kind: 'url', value: url }, { kind: 'path', value: 'src/app.ts' }, { kind: 'url', value: url }]);
  for (const text of ['hello world', '1.2.3', 'user@example.test', 'javascript:alert(1)', 'ftp://example.test/a.txt', 'C:relative.txt']) {
    assert.deepEqual(findTerminalLinks(text), [], text);
  }
});

test('OSC links allow only document URLs and file URLs', () => {
  assert.deepEqual(oscTerminalLink('file:///C:/work/a%20b.txt'), { kind: 'path', value: 'file:///C:/work/a%20b.txt' });
  assert.equal(findTerminalLinks('file:///C:/work/a%20b.txt')[0].kind, 'path');
  for (const value of ['javascript:alert(1)', 'mailto:a@example.test', 'file:///tmp/a?exec=1', 'file:///tmp/a#hash', 'https://token@example.test', 'data:text/plain,test']) assert.equal(oscTerminalLink(value), null, value);
});

test('hover parsing is bounded and caches content without retaining stale row coordinates', () => {
  assert.deepEqual(findTerminalLinks('a'.repeat(TERMINAL_LINK_TEXT_LIMIT + 1)), []);
  assert.equal(findTerminalLinks('src/file.ts '.repeat(500)).length, 128);
  const cached = createTerminalLinkCache();
  const original = cached('src/old.ts');
  assert.equal(cached('src/old.ts'), original);
  assert.equal(cached('src/new.ts')[0].value, 'src/new.ts');
  for (let index = 0; index < 32; index++) cached(`src/${index}.ts`);
  assert.notEqual(cached('src/old.ts'), original);
});
