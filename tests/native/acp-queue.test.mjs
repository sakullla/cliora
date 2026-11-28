import assert from 'node:assert/strict';
import { test } from 'node:test';
import i18next from 'i18next';
import {
  clearAcpQueue, enqueueAcpPrompt, failAcpEntry, nextQueueAction, pauseAcpQueue, queueCopyText, queuePreview, readAcpQueue,
  resumeAcpQueue, sendAcpEntryNext, subscribeAcpQueue, takeAcpEntry,
} from '../../src/features/sessions/acp/acpQueue.ts';
import { imageFileName, userMessageIds } from '../../src/features/sessions/acp/acpImageCache.ts';
import { translationResources } from '../../src/i18n/catalog.ts';

const queued = (...flags) => flags.map((immediate) => (immediate ? { immediate: true } : {}));
const base = { paused: false, turnEnd: null, idle: true, inFlight: false, login: false, live: true };

test('a normal turn end sends the head; the next waits for its own turn', () => {
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false, false), turnEnd: 'end_turn' }), { kind: 'send' });
  // The turn end is seen before the session settles: it waits until idle.
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: 'end_turn', idle: false }), { kind: 'none' });
  // A paused queue keeps waiting.
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: 'end_turn', paused: true }), { kind: 'none' });
  assert.deepEqual(nextQueueAction({ ...base, items: [], turnEnd: 'end_turn' }), { kind: 'none' });
});

test('a cancelled turn sends only the prompt that asked to be sent now', () => {
  assert.deepEqual(nextQueueAction({ ...base, items: queued(true, false), turnEnd: 'cancelled' }), { kind: 'send' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(true), turnEnd: 'cancelled', paused: true }), { kind: 'send' });
  // A plain stop never sends the queue on its own: it stays (paused, so it is not stuck).
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false, false), turnEnd: 'cancelled' }), { kind: 'pause', reason: 'cancelled' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: 'cancelled', paused: true }), { kind: 'none' });
});

test('failed, refused, limited, disconnected and unknown turn ends pause the queue', () => {
  for (const reason of ['failed', 'refusal', 'limit', 'disconnected', 'unknown']) {
    assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: reason }), { kind: 'pause', reason }, reason);
    assert.deepEqual(nextQueueAction({ ...base, items: queued(true), turnEnd: reason }), { kind: 'pause', reason }, `${reason} (now)`);
    assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: reason, paused: true }), { kind: 'none' }, `${reason} (paused)`);
  }
});

test('a login never sends: it pauses the queue, and continuing is up to the person', () => {
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), login: true, idle: false }), { kind: 'pause', reason: 'login' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), login: true, turnEnd: 'end_turn' }), { kind: 'pause', reason: 'login' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), login: true, paused: true }), { kind: 'none' });
  // Logged in again: still paused, nothing goes out until "continue".
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), paused: true }), { kind: 'none' });
});

test('one prompt in flight at a time, and none while a turn runs or the session ended', () => {
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), turnEnd: 'end_turn', inFlight: true }), { kind: 'none' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), inFlight: true }), { kind: 'none' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), idle: false }), { kind: 'none' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), live: false, turnEnd: 'end_turn' }), { kind: 'none' });
});

test('idle and not paused, the head goes out at once: a queue is never left waiting for nothing', () => {
  // "Continue sending" on an idle session, or a session that settled without a turn end.
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false) }), { kind: 'send' });
  assert.deepEqual(nextQueueAction({ ...base, items: queued(false), paused: true }), { kind: 'none' });
  // "Send now" on a paused, idle queue sends that prompt.
  assert.deepEqual(nextQueueAction({ ...base, items: queued(true), paused: true }), { kind: 'send' });
});

test('the queue store is per session: order, send now, edit, failure, pause, resume and close', () => {
  const id = 'queue-store-1';
  const other = 'queue-store-2';
  let notified = 0;
  const stop = subscribeAcpQueue(id, () => { notified += 1; });
  const first = enqueueAcpPrompt(id, { text: '第一条', attachments: [] });
  const second = enqueueAcpPrompt(id, { text: '第二条', attachments: [{ id: 'f', type: 'file', name: 'a.ts', path: 'a.ts' }] });
  enqueueAcpPrompt(other, { text: '别的会话', attachments: [] });
  assert.deepEqual(readAcpQueue(id).items.map((item) => item.text), ['第一条', '第二条']);
  assert.equal(readAcpQueue(other).items.length, 1);
  assert.equal(notified, 2);

  // Send now moves the entry to the front as the only "now" prompt.
  sendAcpEntryNext(id, second.id);
  assert.deepEqual(readAcpQueue(id).items.map((item) => [item.text, !!item.immediate]), [['第二条', true], ['第一条', false]]);
  const now = enqueueAcpPrompt(id, { text: '更急', attachments: [] }, true);
  assert.deepEqual(readAcpQueue(id).items.map((item) => [item.text, !!item.immediate]), [['更急', true], ['第二条', false], ['第一条', false]]);

  // Pausing drops the "now" mark; resuming clears the pause and its reason.
  pauseAcpQueue(id);
  assert.equal(readAcpQueue(id).paused, true);
  assert.equal(readAcpQueue(id).items.some((item) => item.immediate), false);
  const taken = takeAcpEntry(id, now.id);
  assert.equal(taken?.text, '更急');
  failAcpEntry(id, taken, 'agent 拒绝');
  assert.deepEqual(readAcpQueue(id), { items: readAcpQueue(id).items, paused: true, error: 'agent 拒绝' });
  assert.equal(readAcpQueue(id).items[0].text, '更急');
  resumeAcpQueue(id);
  assert.equal(readAcpQueue(id).paused, false);
  assert.equal(readAcpQueue(id).error, '');

  // Emptied, the queue starts over: no leftover pause for the next prompt.
  pauseAcpQueue(id);
  for (const item of readAcpQueue(id).items) takeAcpEntry(id, item.id);
  enqueueAcpPrompt(id, { text: '新的', attachments: [] });
  assert.equal(readAcpQueue(id).paused, false);
  assert.equal(takeAcpEntry(id, first.id), null);

  clearAcpQueue(id);
  assert.equal(readAcpQueue(id).items.length, 0);
  assert.equal(readAcpQueue(other).items.length, 1);
  clearAcpQueue(other);
  stop();
});

test('queue previews are one line, and "copy all" separates prompts by a blank line', () => {
  assert.equal(queuePreview('  第一行\n第二行  '), '第一行 第二行');
  assert.equal(queuePreview('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
  assert.equal(queueCopyText([{ text: 'a\nb' }, { text: 'c' }]), 'a\nb\n\nc');
});

test('a pasted picture has no name of its own; a file name is kept', () => {
  assert.equal(imageFileName('image/png'), null);
  assert.equal(imageFileName('image'), null);
  assert.equal(imageFileName(''), null);
  assert.equal(imageFileName('photo.jpg'), 'photo.jpg');
  const ids = userMessageIds([
    { kind: 'message', id: 'u1', role: 'user', text: 'a', truncated: false, turnId: 't1', subagent: null },
    { kind: 'message', id: 'u2', role: 'user', text: 'b', truncated: false, turnId: 't2', subagent: 'sub' },
    { kind: 'message', id: 'm1', role: 'agent', text: 'c', truncated: false, turnId: 't1', subagent: null },
  ]);
  assert.deepEqual([...ids], ['u1']);
});

test('English process counts use singular and plural forms; Chinese reads the same', async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'en', fallbackLng: 'zh', resources: translationResources, interpolation: { escapeValue: false } });
  assert.equal(i18n.t('sessions.acpProcessSummary', { count: 1 }), 'Work · 1 step');
  assert.equal(i18n.t('sessions.acpProcessSummary', { count: 3 }), 'Work · 3 steps');
  assert.equal(i18n.t('sessions.acpProcessFiles', { count: 1 }), '1 file changed');
  assert.equal(i18n.t('sessions.acpProcessFiles', { count: 2 }), '2 files changed');
  assert.equal(i18n.t('sessions.acpProcessEarlier', { count: 1 }), '1 earlier step');
  assert.equal(i18n.t('sessions.acpQueueAttachments', { count: 1 }), '1 attachment');
  await i18n.changeLanguage('zh');
  assert.equal(i18n.t('sessions.acpProcessSummary', { count: 1 }), '工作过程 · 1 步');
  assert.equal(i18n.t('sessions.acpProcessFiles', { count: 2 }), '改动 2 个文件');
});
