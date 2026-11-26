import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripHistorySideEffects } from '../../src/features/sessions/terminalReplaySanitizer.ts';

const bytes = (text) => new TextEncoder().encode(text);
const text = (value) => new TextDecoder().decode(value);

test('history keeps its text and drops the clipboard write it already performed', () => {
  const replayed = bytes('before\x1b]52;c;Y29waWVk\x07after');
  assert.equal(text(stripHistorySideEffects(replayed)), 'beforeafter');
  // An ST-terminated copy is the same side effect.
  assert.equal(text(stripHistorySideEffects(bytes('a\x1b]52;c;Y29waWVk\x1b\\b'))), 'ab');
});

test('a replayed bell does not ring again and ordinary text is untouched', () => {
  assert.equal(text(stripHistorySideEffects(bytes('done\x07\x07!'))), 'done!');
  const plain = bytes('codex-ready\r\n> ');
  // Nothing to remove: the caller keeps its own buffer instead of a copy.
  assert.equal(stripHistorySideEffects(plain), plain);
});

test('a mixed OSC 4 keeps its settings in place and loses only the query', () => {
  assert.equal(
    text(stripHistorySideEffects(bytes('\x1b]4;1;?;2;#ff0000\x07tail'))),
    '\x1b]4;2;#ff0000\x1b\\tail',
  );
  // Several queries and several settings in one sequence.
  assert.equal(
    text(stripHistorySideEffects(bytes('\x1b]4;0;?;1;?;2;#00ff00\x07'))),
    '\x1b]4;2;#00ff00\x1b\\',
  );
  // A pure query has nothing to rebuild.
  assert.equal(text(stripHistorySideEffects(bytes('\x1b]4;3;?\x07x'))), 'x');
});

test('palette settings, resets and default colours stay in history', () => {
  for (const sequence of [
    '\x1b]4;4;#123456\x07',
    '\x1b]4;4;rgb:12/34/56\x1b\\',
    '\x1b]104;4\x07',
    '\x1b]104\x07',
    '\x1b]110\x07',
    '\x1b]111\x07',
    '\x1b]112\x07',
    '\x1b]10;#ffffff\x07',
    '\x1b]11;#000000\x07',
    '\x1b]12;#ff0000\x07',
  ]) {
    assert.equal(text(stripHistorySideEffects(bytes(`a${sequence}b`))), `a${sequence}b`, JSON.stringify(sequence));
  }
  // A default-colour query is a question, not a setting.
  assert.equal(text(stripHistorySideEffects(bytes('a\x1b]10;?\x07b'))), 'ab');
  assert.equal(text(stripHistorySideEffects(bytes('a\x1b]11;?;?\x07b'))), 'ab');
});

test('titles, links, command marks and progress survive the filter', () => {
  const kept = '\x1b]0;title\x07\x1b]133;A\x07\x1b]9;4;1;35\x07\x1b]8;;https://example.com\x07link\x1b]8;;\x07';
  assert.equal(text(stripHistorySideEffects(bytes(kept))), kept);
});

test('an incomplete OSC is left for the parser instead of being half rewritten', () => {
  const truncated = bytes('head\x1b]4;1;?');
  assert.equal(text(stripHistorySideEffects(truncated)), 'head\x1b]4;1;?');
});

test('UTF-8 text, control bytes and split sequences keep their bytes', () => {
  const mixed = new Uint8Array([...bytes('你好'), 0x0a, 0x1b, 0x5b, 0x33, 0x31, 0x6d, ...bytes('世界'), 0x1b, 0x5d, 0x34, 0x3b, 0x31, 0x3b, 0x3f, 0x07]);
  assert.equal(text(stripHistorySideEffects(mixed)), '你好\n\x1b[31m世界');
});

test('an unknown OSC number passes through untouched', () => {
  const unknown = '\x1b]999;payload with spaces\x07';
  assert.equal(text(stripHistorySideEffects(bytes(unknown))), unknown);
});
