import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingTerminalOutput } from '../../src/features/sessions/pendingOutput.ts';

test('late output across closed or unmounted sessions cannot retain unbounded tails', () => {
  const pending = new PendingTerminalOutput(4, 40, 20, 3);
  for (let index = 0; index < 1000; index++) {
    pending.push(`closed-${index}`, { data: 'abcdefghijkl', offset: index * 9 });
    assert.ok(pending.size <= 4);
    assert.ok(pending.byteLength <= 40);
  }
  assert.deepEqual(pending.drain('closed-0'), []);
  assert.deepEqual(pending.drain('closed-999'), [{ data: 'abcdefghijkl', offset: 8991 }]);
  pending.clear();
  assert.equal(pending.size, 0);
  assert.equal(pending.byteLength, 0);
});

test('pending output keeps ordered complete chunks and offsets while bounding bytes and chunk objects', () => {
  const pending = new PendingTerminalOutput(4, 100, 16, 2);
  pending.push('a', { data: 'AAAA', offset: 0 });
  pending.push('a', { data: 'BBBB', offset: 3 });
  pending.push('a', { data: 'CCCC', offset: 6 });
  pending.push('b', { data: '1234567890123456', offset: 0 });
  pending.push('b', { data: 'DDDD', offset: 12 });
  assert.deepEqual(pending.drain('a'), [{ data: 'BBBB', offset: 3 }, { data: 'CCCC', offset: 6 }]);
  assert.deepEqual(pending.drain('b'), [{ data: 'DDDD', offset: 12 }]);
  assert.equal(pending.byteLength, 0);
  pending.push('oversized', { data: 'x'.repeat(17) });
  pending.push('empty', { data: '' });
  assert.equal(pending.size, 0);
});

test('recent output survives session-count eviction and deletion releases its accounting', () => {
  const pending = new PendingTerminalOutput(2, 100, 50, 4);
  pending.push('a', { data: 'AAAA' });
  pending.push('b', { data: 'BBBB' });
  pending.push('a', { data: 'CCCC' });
  pending.push('c', { data: 'DDDD' });
  assert.deepEqual(pending.drain('b'), []);
  assert.deepEqual(pending.drain('a').map(chunk => chunk.data), ['AAAA', 'CCCC']);
  pending.delete('c');
  pending.delete('c');
  assert.equal(pending.byteLength, 0);
  assert.equal(pending.size, 0);
});
