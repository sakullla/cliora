import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureCases } from '../../scripts/verify-omp-native.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const historyDirectory = path.join(repository, 'tests/fixtures/history');
const historySource = await readFile(path.join(repository, 'src-tauri/src/adapters/omp/history.rs'), 'utf8');

async function sessionFiles(prefix = 'omp-') {
  return (await readdir(historyDirectory))
    .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort();
}

function lines(bytes) {
  return bytes.toString('utf8').split('\n').filter(Boolean);
}

test('OMP history fixtures are declared in the history capability directory', async () => {
  const cases = (await fixtureCases(repository)).filter(item => item.directory === 'history');
  assert.ok(cases.length >= 5, '历史用例应覆盖真实 wire、分支、损坏、版本和恢复');
  const actions = new Set(cases.map(item => item.fixture.case.action));
  assert.deepEqual([...actions].sort(), ['resume', 'session', 'unsupported']);
  for (const item of cases) {
    assert.equal(item.fixture.capability, 'history', item.ref);
    assert.ok(item.fixture.name.trim(), item.ref);
  }
  const names = cases.filter(item => item.fixture.case.fixture).map(item => item.fixture.case.fixture);
  assert.ok(names.includes('omp-18.20.2-v3.jsonl'));
  assert.ok(names.includes('omp-v3-branch-compaction.jsonl'));
});

test('the title slot is one physical 256-byte JSONL line', async () => {
  for (const name of await sessionFiles()) {
    const bytes = await readFile(path.join(historyDirectory, name));
    const newline = bytes.indexOf(0x0a);
    if (bytes.subarray(0, 1).toString() !== '{' || !bytes.toString('utf8', 0, 40).startsWith('{"type":"title"')) continue;
    assert.equal(newline, 255, `${name} 的标题槽必须恰好 256 字节`);
    const slot = JSON.parse(bytes.toString('utf8', 0, 255));
    assert.equal(slot.type, 'title');
    assert.equal(slot.v, 1);
    assert.equal(typeof slot.title, 'string');
    assert.equal(typeof slot.pad, 'string');
    assert.ok(slot.pad.length > 0);
    if (slot.source !== undefined) assert.ok(['auto', 'user'].includes(slot.source));
    assert.ok(bytes.toString('utf8', 256).includes('"type":"session"'), `${name} 槽后必须是 session 头`);
  }
});

test('the real 18.20.2 fixture keeps the observed wire fields and resume append', async () => {
  const bytes = await readFile(path.join(historyDirectory, 'omp-18.20.2-v3.jsonl'));
  const rows = lines(bytes.subarray(256)).map(line => JSON.parse(line));
  const header = rows[0];
  assert.equal(header.type, 'session');
  assert.equal(header.version, 3);
  assert.equal(header.cwd, '/fixture/project');
  const messages = rows.filter(row => row.type === 'message');
  assert.equal(messages.length, 4, '同一 id 的会话包含 --resume 追加的第二轮');
  assert.equal(messages.filter(message => message.message.role === 'user').length, 2);
  const assistant = messages.find(message => message.message.role === 'assistant');
  assert.deepEqual(
    Object.keys(assistant.message.usage).sort(),
    ['cacheRead', 'cacheWrite', 'cost', 'input', 'output', 'totalTokens'],
  );
  assert.equal(assistant.message.usage.input, 1000);
  assert.equal(assistant.message.usage.cacheRead, 200);
  assert.equal(assistant.message.usage.input + assistant.message.usage.cacheRead, 1200, 'input 不含缓存读取');
  assert.ok(Math.abs(assistant.message.usage.cost.total - 0.0017) < 1e-12);
  assert.equal(rows.filter(row => row.type === 'session').length, 1, '恢复不创建第二个会话头');
  assert.ok(rows.some(row => row.type === 'custom' && row.customType === 'session_exit'));
});

test('branch, compaction, model_usage and interruption are declared in the tree fixture', async () => {
  const bytes = await readFile(path.join(historyDirectory, 'omp-v3-branch-compaction.jsonl'));
  const rows = lines(bytes.subarray(256)).map(line => JSON.parse(line));
  const byId = new Map(rows.filter(row => row.id).map(row => [row.id, row]));
  const last = rows.at(-1);
  const pathIds = [];
  let current = last.id;
  while (current) {
    pathIds.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  assert.ok(pathIds.includes('c2'), '活动分支在父链上');
  assert.ok(!pathIds.includes('b1') && !pathIds.includes('b2'), '放弃的分支不在父链上');
  assert.ok(rows.some(row => row.type === 'compaction' && row.summary));
  assert.ok(rows.some(row => row.type === 'branch_summary' && row.summary));
  assert.ok(rows.some(row => row.type === 'model_usage' && row.purpose === 'title'));
  const interrupted = rows.find(row => row.type === 'message' && row.message.stopReason === 'aborted');
  assert.ok(interrupted?.message.content.some(part => part.type === 'text' && part.text.length > 0));
  assert.ok(rows.some(row => row.type === 'custom' && row.customType === 'session_exit' && row.data.kind === 'signal'));
});

test('every committed OMP session fixture is exercised by a product test', async () => {
  const verifyCases = (await fixtureCases(repository))
    .filter(item => item.directory === 'history')
    .map(item => item.fixture.case.fixture)
    .filter(Boolean);
  const referenced = new Set([...verifyCases]);
  for (const name of await sessionFiles()) {
    assert.ok(
      referenced.has(name) || historySource.includes(name),
      `${name} 必须在 Rust 模块测试或 verify-omp-native 用例中被读取`,
    );
    const text = await readFile(path.join(historyDirectory, name), 'utf8');
    assert.doesNotMatch(text, /C:\\Users\\|12976/, `${name} 不得保留本机路径`);
  }
});

test('the OMP parser is read-only, reuses the profile resolver and keeps Pi arguments out', () => {
  const source = historySource.split('#[cfg(test)]')[0].split('fn verify_case')[0];
  assert.match(source, /super::configuration::resolve_root/);
  assert.match(source, /crate::accounts::selection::history_root/);
  assert.match(source, /discover_jsonl_controlled/);
  assert.doesNotMatch(source, /fs::write|OpenOptions|File::create|write_all/, '历史解析不得写原生 JSONL');
  assert.doesNotMatch(source, /--session/, 'OMP 不使用 Pi 的 --session');
  assert.match(source, /--resume/);
  assert.match(historySource, /--continue/);
  assert.match(source, /cost_total/);
  assert.doesNotMatch(source, /native_usage: Some/, '原生 cost 不伪装成共享 token/单位用量');
});

test('the descriptor publishes history only after the module supports it', async () => {
  const adapter = await readFile(path.join(repository, 'src-tauri/src/adapters/omp/mod.rs'), 'utf8');
  assert.match(adapter, /history::facet\(\)/);
  assert.match(adapter, /history::sources\(home\)/);
  assert.match(adapter, /history::parse\(source\)/);
  assert.match(adapter, /history::supported\(\)/);
  assert.doesNotMatch(adapter, /history::UNAVAILABLE_REASON/);
});
