import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache } from '../../src/lib/boundedCache.ts';

test('presentation caches evict least recently used entries and replace without growing', () => {
  const cache = new BoundedCache(2);
  cache.set('a', 1); cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  cache.set('a', 4);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 4);
  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
});

test('reads do not renew TTL and writes prune expired entries across keys', t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const cache = new BoundedCache(3, 20);
  cache.set('a', 1); cache.set('b', 2);
  now = 119;
  assert.equal(cache.get('a'), 1);
  now = 120;
  assert.equal(cache.get('a'), undefined);
  cache.set('c', 3);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('b'), undefined);
});
