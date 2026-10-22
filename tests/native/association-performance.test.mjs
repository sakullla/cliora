import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

async function load(path) {
  const source = readFileSync(new URL(`../../src/features/${path}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const { childSummary, timelineRows } = await load('records/sessionTimeline.ts');
const { memoryLinks } = await load('memory/memoryLinks.ts');

const message = (id, role, text, timestamp = null, kind = 'conversation') => ({ id, role, text, timestamp, kind });
const child = (key, messages) => ({ key, messages, readable: true, children: [] });

test('child previews keep first task, last nonempty reply and earliest timestamp', () => {
  const node = child('review', [
    message('context', 'user', 'Project context', 40, 'project_context'),
    message('env', 'user', 'Environment', 30, 'environment_context'),
    message('task', 'user', '  Review\n this  ', 20),
    message('early', 'assistant', 'Earlier reply', 10),
    message('task2', 'user', 'Second task'),
    message('reply', 'assistant', 'Final\n reply ' + 'x'.repeat(200)),
    message('empty', 'assistant', '   '),
  ]);
  const summary = childSummary(node);
  assert.equal(summary.at, 10);
  assert.equal(summary.ask, 'Review this');
  assert.equal(summary.reply, ('Final reply ' + 'x'.repeat(200)).slice(0, 180) + '…');
  assert.deepEqual(childSummary(child('empty', [])), { at: null, ask: '', reply: '' });
  assert.equal(childSummary(child('blank-task', [message('a', 'user', ''), message('b', 'user', 'Later')])).ask, '');
});

test('repeated parent/child navigation reuses previews and refreshed transcripts invalidate them', () => {
  let visits = 0;
  const messages = Array.from({ length: 1000 }, (_, index) => {
    const item = message(`${index}`, index % 2 ? 'assistant' : 'user', `Message ${index}`, index);
    return new Proxy(item, { get(target, key) { if (key === 'timestamp') visits++; return Reflect.get(target, key); } });
  });
  const node = child('review', messages);
  const first = childSummary(node);
  const scanned = visits;
  assert.ok(scanned >= messages.length);
  for (let i = 0; i < 40; i++) {
    assert.equal(childSummary(node), first);
    timelineRows([], [node]);
  }
  assert.equal(visits, scanned, 'cached navigation must not scan the transcript again');
  const refreshed = child('review', [...messages, message('new', 'assistant', 'Fresh reply', -1)]);
  assert.deepEqual(childSummary(refreshed), { at: -1, ask: 'Message 0', reply: 'Fresh reply' });
  assert.equal(childSummary(node), first, 'old snapshots remain unchanged');
});

test('timeline keeps equal-time child order, unknown timestamps and parent message order', () => {
  const children = [child('unknown', []), child('equal-a', [message('a', 'assistant', 'A', 20)]), child('early', [message('b', 'assistant', 'B', 10)]), child('equal-b', [message('c', 'assistant', 'C', 20)])];
  const messages = [message('unknown-parent', 'user', 'Unknown'), message('p15', 'user', 'Between', 15), message('p20', 'assistant', 'Equal', 20)];
  const rows = timelineRows(messages, children);
  assert.deepEqual(rows.map(row => row.kind === 'child' ? row.child.key : row.item.id), ['unknown-parent', 'early', 'p15', 'equal-a', 'equal-b', 'p20', 'unknown']);
  assert.deepEqual(rows.map(row => row.at), [null, 10, 15, 20, 20, 20, null]);
  assert.deepEqual(children.map(node => node.key), ['unknown', 'equal-a', 'early', 'equal-b']);
  assert.deepEqual(timelineRows([], children).map(row => row.child.key), ['early', 'equal-a', 'equal-b', 'unknown']);
});

const row = (id, store, name) => ({ entry: { id }, store, parsed: name === undefined ? null : { properties: [{ key: 'NAME', value: name }] } });

test('memory links normalize aliases and preserve same-store and first-match precedence', () => {
  const global = row('release_ritual', 'global', 'Shared name');
  const local = row('local', 'project', 'Release ritual');
  const duplicate = row('duplicate', 'project', 'release_ritual');
  const idCollision = row('SHARED_NAME', 'project');
  const resolve = memoryLinks([global, local, duplicate, idCollision]);
  assert.equal(resolve(' RELEASE_RITUAL.md ', 'project'), local);
  assert.equal(resolve('release ritual', 'global'), global);
  assert.equal(resolve('release-ritual', 'other'), global);
  assert.equal(resolve('shared name', 'project'), idCollision);
  assert.equal(resolve('SHARED_NAME', 'other'), global);
  assert.equal(resolve('missing', 'project'), null);
  assert.equal(resolve('toString', 'project'), null);
});

test('large memory link resolution does not revisit rows and a rebuilt index drops old aliases', () => {
  let visits = 0;
  const rows = Array.from({ length: 3000 }, (_, index) => ({
    entry: { id: `note-${index}` }, store: `store-${index % 5}`,
    get parsed() { visits++; return { properties: [{ key: 'name', value: `Memory ${index}` }] }; },
  }));
  const resolve = memoryLinks(rows);
  assert.equal(visits, rows.length);
  for (let render = 0; render < 5; render++) {
    for (let i = 0; i < 500; i++) assert.equal(resolve(`Memory ${i * 5}`, 'store-0'), rows[i * 5]);
  }
  assert.equal(visits, rows.length, 'links must resolve without rescanning entries');
  const refreshed = memoryLinks([row('note-0', 'store-0', 'Renamed')]);
  assert.equal(refreshed('Memory 0', 'store-0'), null);
  assert.equal(refreshed('Memory 5', 'store-0'), null);
  assert.equal(refreshed('Renamed', 'store-0').entry.id, 'note-0');
  assert.equal(refreshed('note-0', 'store-0').entry.id, 'note-0');
});
