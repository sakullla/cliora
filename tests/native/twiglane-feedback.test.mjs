/**
 * feedback-v1 合同回归：这套断言独立于 Rust 实现，只读两端共用的夹具。
 *
 * 目的是让一份夹具同时约束两侧：canonical digest 按协议第 6 节的字段顺序重算，URL 语法按
 * 第 5 节逐条判定，失败批次必须停在它声明的阶段。任何一侧改了字段顺序、字符集或上限，
 * 这里都会先失败，而不是等真实交接时才发现两端不一致。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = path.join(root, 'tests/fixtures/reviews/protocol-feedback-v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

/** 协议第 6 节：去掉 digest 后的紧凑序列化，字段顺序固定。 */
const BATCH_ORDER = ['v', 'feedbackId', 'reviewId', 'sessionId', 'resultRevision', 'worktreePath', 'rangeVersion', 'baselineOid', 'headOid', 'comments'];
const COMMENT_ORDER = ['id', 'path', 'hunkIndex', 'kind', 'oldNo', 'newNo', 'body'];

function canonical(file) {
  const body = {};
  for (const key of BATCH_ORDER) body[key] = key === 'comments'
    ? file.comments.map((comment) => Object.fromEntries(COMMENT_ORDER.map((name) => [name, comment[name]])))
    : file[key];
  return JSON.stringify(body);
}

function digestOf(file) {
  return crypto.createHash('sha256').update(canonical(file), 'utf8').digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OID = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function relativeRepoPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

/** 只看 schema 层面（额外/缺失字段），与 Rust 的 deny_unknown_fields 对齐。 */
function schemaOk(file) {
  const keys = Object.keys(file).sort();
  const expected = [...BATCH_ORDER, 'digest'].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** 协议第 4 节的约束，返回失败阶段或 null。 */
function validate(file) {
  if (!schemaOk(file)) return 'schema';
  if (file.v !== 1) return 'validation';
  if (![file.feedbackId, file.reviewId, file.sessionId].every((value) => UUID.test(value))) return 'validation';
  if (!Number.isSafeInteger(file.resultRevision) || file.resultRevision < 0) return 'validation';
  if (typeof file.worktreePath !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(file.worktreePath)) return 'validation';
  if (typeof file.rangeVersion !== 'string' || !file.rangeVersion) return 'validation';
  if (!OID.test(file.baselineOid) || !OID.test(file.headOid)) return 'validation';
  if (!Array.isArray(file.comments) || file.comments.length < 1 || file.comments.length > 64) return 'validation';
  const ids = new Set();
  for (const comment of file.comments) {
    if (!UUID.test(comment.id) || ids.has(comment.id)) return 'validation';
    ids.add(comment.id);
    if (!relativeRepoPath(comment.path)) return 'validation';
    if (!['add', 'del', 'context'].includes(comment.kind)) return 'validation';
    if (comment.oldNo == null && comment.newNo == null) return 'validation';
    if (typeof comment.body !== 'string' || !comment.body.trim()) return 'validation';
    if (Buffer.byteLength(comment.body, 'utf8') > 16 * 1024) return 'validation';
  }
  if (!HEX64.test(file.digest)) return 'validation';
  if (digestOf(file) !== file.digest) return 'digest';
  return null;
}

/** 协议第 5 节的入站 URL 规则。 */
function urlValid(url) {
  if (Buffer.byteLength(url, 'utf8') > 2048) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  if (!url.startsWith('cliora://')) return false;
  const rest = url.slice('cliora://'.length);
  const index = rest.indexOf('?');
  if (index < 0) return false;
  const authority = rest.slice(0, index);
  const query = rest.slice(index + 1);
  if (authority.replace(/\/$/, '') !== 'review-feedback') return false;
  if (query.includes('#') || query.includes('?')) return false;
  const params = new Map();
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    if (at < 0) return false;
    const name = part.slice(0, at);
    const value = part.slice(at + 1);
    if (!['v', 'feedbackId', 'reviewId', 'sessionId', 'resultRevision', 'digest'].includes(name)) return false;
    if (!/^[A-Za-z0-9\-_.~]+$/.test(value)) return false;
    if (params.has(name)) return false;
    params.set(name, value);
  }
  if (params.size !== 6) return false;
  if (params.get('v') !== '1') return false;
  if (![params.get('feedbackId'), params.get('reviewId'), params.get('sessionId')].every((value) => UUID.test(value))) return false;
  if (!HEX64.test(params.get('digest'))) return false;
  const revision = params.get('resultRevision');
  if (!/^(0|[1-9]\d*)$/.test(revision)) return false;
  return Number(revision) <= Number.MAX_SAFE_INTEGER;
}

test('the shared fixture uses the documented canonical digest order', () => {
  const valid = fixture.batches.filter((batch) => batch.valid);
  assert.ok(valid.length >= 3);
  for (const batch of valid) assert.equal(digestOf(batch.file), batch.file.digest, batch.name);
});

test('every reject batch fails at the stage the fixture declares', () => {
  for (const batch of fixture.batches.filter((entry) => !entry.valid)) {
    assert.equal(validate(batch.file), batch.reject, batch.name);
  }
});

test('the fixture URL cases agree with the inbound grammar', () => {
  for (const entry of fixture.urls) assert.equal(urlValid(entry.url), entry.valid, entry.name);
});

test('a received batch is consumed once and a duplicate id cannot be staged again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cliora-feedback-test-'));
  const batch = fixture.batches.find((entry) => entry.name === 'valid-two-comments').file;
  const file = path.join(directory, batch.feedbackId + '.json');
  fs.writeFileSync(file, JSON.stringify(batch));

  const seen = new Set();
  const stage = () => {
    if (seen.has(batch.feedbackId)) return 'duplicate';
    // 只有读到了文件才算接收成功；删除失败就不暂存。
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    if (validate(parsed)) return 'invalid';
    seen.add(batch.feedbackId);
    fs.unlinkSync(file);
    return 'staged';
  };

  assert.equal(stage(), 'staged');
  assert.equal(fs.existsSync(file), false);
  assert.equal(stage(), 'duplicate');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the Cliora and Twiglane copies of the fixture stay byte identical', (t) => {
  const sibling = path.resolve(root, '..', 'Twiglane-lightweight-task-workbench/tests/fixtures/reviews/protocol-feedback-v1.json');
  if (!fs.existsSync(sibling)) {
    t.skip('the Twiglane worktree is not next to this checkout');
    return;
  }
  assert.equal(fs.readFileSync(sibling, 'utf8'), fs.readFileSync(fixturePath, 'utf8'));
});
