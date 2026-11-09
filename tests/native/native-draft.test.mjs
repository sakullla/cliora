import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importedConnection } from '../../src/lib/nativeDraft.ts';

const current = { providerId: 'anthropic', interfaceFormat: 'anthropic_messages', baseUrl: 'https://api.anthropic.com', model: 'old-model', secretRef: 'old-key', authEnvVar: null };
const inspection = (connection) => ({ providerId: 'anthropic', model: null, connection, reasoningEffort: null });

test('a key-only native import does not reactivate a previous explicit account', () => {
  assert.equal(importedConnection({ inspection: inspection(null), migratedSecret: true }, current), null);
  assert.equal(importedConnection({ inspection: inspection(null), migratedSecret: false }, current), current);
});

test('edited native connection key wins, while an unchanged same account can retain its key', () => {
  const found = { ...current, model: 'edited-model', secretRef: 'native-key' };
  assert.equal(importedConnection({ inspection: inspection(found), migratedSecret: true }, current).secretRef, 'native-key');
  assert.equal(importedConnection({ inspection: inspection({ ...found, secretRef: null }), migratedSecret: false }, current).secretRef, 'old-key');
  assert.equal(importedConnection({ inspection: inspection({ ...found, providerId: 'other', secretRef: null }), migratedSecret: false }, current).secretRef, null);
});
