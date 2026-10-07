import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);

function moduleFrom(source) {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

function lookup(bundle, key) {
  let node = bundle;
  for (const part of key.split('.')) node = node?.[part];
  return typeof node === 'string' ? node : key;
}

const tools = { tools: (await moduleFrom(readFileSync(new URL('src/i18n/locales/zh/tools.ts', root), 'utf8'))).default };
globalThis.__clioraUsageI18n = {
  language: 'zh',
  t(key, options) {
    const text = lookup(tools, key);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => (options && options[name] != null ? String(options[name]) : ''));
  },
};
const source = readFileSync(new URL('src/features/tools/usageDisplay.ts', root), 'utf8')
  .replace("import i18n from '../../i18n';", 'const i18n = globalThis.__clioraUsageI18n;');
const { usagePercent, usageReset, usageUnit } = await moduleFrom(source);
const metric = { used: null, remaining: null, total: null, sourcePercent: null, unlimited: false, unit: { kind: 'credits' }, window: null };
test('missing, zero, overage and unlimited remain distinct', () => {
  assert.equal(usagePercent(metric), null);
  assert.equal(usagePercent({ ...metric, used: 0, total: 100 }), 0);
  assert.equal(usagePercent({ ...metric, remaining: -25, total: 100 }), 125);
  assert.equal(usagePercent({ ...metric, used: 200, total: 100 }), 200);
  assert.equal(usagePercent({ ...metric, total: 0, used: 0 }), null);
  assert.equal(usagePercent({ ...metric, unlimited: true }), null);
  assert.equal(usagePercent({ ...metric, sourcePercent: 37 }), 37);
  assert.equal(usageUnit({ ...metric, unit: { kind: 'custom', label: 'quota' } }), 'quota');
});
test('expiry is never a reset and elapsed windows wait for fresh data', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(usageReset({ ...metric, expiresAt: '2026-10-02T12:00:00Z' }, now), '');
  assert.match(usageReset({ ...metric, window: { recovery: 'rolling', resetsAt: '2026-10-02T11:00:00Z' } }, now), /滚动恢复时间已到，待刷新/);
  assert.equal(usageReset({ ...metric, window: { recovery: 'rolling', resetsAt: null } }, now), '滚动恢复');
});
