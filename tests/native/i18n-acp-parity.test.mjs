import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { translationResources } from '../../src/i18n/catalog.ts';

// The conversation's own copy: every `sessions.acp*` key exists in both languages,
// with the same interpolation placeholders, and every key the conversation code
// names is defined.
const zh = translationResources.zh.translation.sessions;
const en = translationResources.en.translation.sessions;
const acpKeys = (bundle) => Object.keys(bundle).filter((key) => key.startsWith('acp')).sort();
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]).sort();

test('zh and en declare the same sessions.acp* keys', () => {
  const zhKeys = acpKeys(zh);
  const enKeys = acpKeys(en);
  assert.ok(zhKeys.length > 0);
  assert.deepEqual(zhKeys.filter((key) => !enKeys.includes(key)), [], 'zh 有而 en 缺少的 acp 文案');
  assert.deepEqual(enKeys.filter((key) => !zhKeys.includes(key)), [], 'en 有而 zh 缺少的 acp 文案');
});

test('each sessions.acp* key uses the same placeholders in both languages', () => {
  for (const key of acpKeys(zh)) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `sessions.${key} 的插值参数不一致`);
  }
});

test('every sessions.acp* key the conversation code names is defined', () => {
  const root = new URL('../../src/features/sessions/', import.meta.url);
  const files = [
    ...readdirSync(new URL('acp/', root)).filter((name) => /\.tsx?$/.test(name)).map((name) => new URL(`acp/${name}`, root)),
    new URL('AcpConversation.tsx', root),
    new URL('acpSession.ts', root),
  ];
  const named = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/'sessions\.(acp[A-Za-z]+)'/g)) named.add(match[1]);
  }
  assert.ok(named.size > 20, '应当从对话代码中找到文案键');
  const missing = [...named].filter((key) => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
  assert.deepEqual(missing, []);
});
