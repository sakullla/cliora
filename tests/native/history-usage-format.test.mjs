import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/features/records/usageFormat.ts', import.meta.url), 'utf8')
  .replace("import i18n from '../../i18n';", "const i18n = { language: 'en', t: key => key === 'records.native.unknown' ? 'Unknown' : key };");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { compactNativeValue, formatNativeValue, formatTotalTokens, usageDetail, usageSummary } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('unknown token records stay distinct from known zero and partial known totals', () => {
  assert.equal(formatTotalTokens({ usageRecords: 2, unknownTokenRecords: 2, total: 0 }), 'Unknown');
  assert.equal(formatTotalTokens({ usageRecords: 2, unknownTokenRecords: 0, total: 0 }), '0');
  assert.equal(formatTotalTokens({ usageRecords: 2, unknownTokenRecords: 1, total: 50 }), '50+');
});

test('native fractions remain nonzero and unrelated units are not added', () => {
  assert.equal(formatNativeValue(0.000000001), '0.000000001');
  assert.equal(compactNativeValue(0.000000001), '0.000000001');
  assert.equal(compactNativeValue(3.14159265358), '3.142');
  assert.equal(compactNativeValue(12345.6), '12,346');
  const mixed = { usageRecords: 3, unknownTokenRecords: 3, total: 0, nativeUsage: [
    { unit: 'credits', value: 1.25, billable: false }, { unit: 'credits', value: 0.75, billable: true },
    { unit: 'work_units', value: 4, billable: null },
  ] };
  // Lists show a short count; the full per-unit values are kept for the tooltip, never summed across units.
  assert.equal(usageSummary(mixed), 'records.native.unitsCount');
  assert.equal(usageDetail(mixed), 'Unknown token · 2 Credits · 4 Work_units');
  assert.equal(usageSummary({ ...mixed, nativeUsage: mixed.nativeUsage.slice(0, 2) }), '2 Credits');
  // A row with known tokens leads with tokens even when it also carries native units.
  assert.equal(usageSummary({ ...mixed, unknownTokenRecords: 1, total: 1500 }), '1.5K+');
});
