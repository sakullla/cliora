import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/nativeDraft.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { importedConnection } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

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
