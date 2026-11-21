import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkEvidenceConsistency,
  fallbackUseCommand,
  tokenize,
  validateLivePlan,
  verifyOffline,
} from '../../scripts/verify-secret-access.mjs';

// The offline verification is the only part of this gate that may run in CI: it
// starts no AI CLI and calls no model. These tests keep that promise explicit and
// keep the live gate from turning a missing observation into a pass.
const CANARY = 'canary-synthetic-access-5b1e9d';
const plan = {
  helper: '/opt/cliora-fixture/Cliora',
  installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234',
  secretId: '11111111-2222-4333-8444-555555555555',
  executorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  targets: [{
    toolId: 'claude_code',
    printCommand: ['claude', '-p'],
    printStdin: true,
    mcpConfigPath: '/tmp/cliora-live/.claude.json',
    mcpEntryName: 'cliora-secrets-claude_code',
  }],
};

test('the offline verification passes without a CLI or a model', async () => {
  const result = await verifyOffline();
  const failed = result.checks.filter(item => item.status === 'failed');
  assert.deepEqual(failed, [], JSON.stringify(failed));
  const ids = result.checks.map(item => item.id);
  assert.deepEqual(ids, ['prompt-references', 'synthetic-metadata', 'cli-fallback', 'mcp-tool-contract', 'evidence-consistency', 'executor-double', 'live-acceptance']);
  // A skipped live run is reported, never counted as a pass.
  assert.equal(result.checks.at(-1).status, 'skipped');
  assert.equal(result.mode, 'offline');
  assert.match(result.limits, /not real CLI or model acceptance/);
  // Nothing printed by the offline document may carry the synthetic value.
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('a live plan is refused unless it names synthetic values and real commands', () => {
  assert.equal(validateLivePlan(plan, CANARY), plan);
  // A realistic-looking value is refused so the gate cannot be used on a real secret.
  assert.throws(() => validateLivePlan(plan, 'correct-horse-battery'), /只用|合成/);
  assert.throws(() => validateLivePlan(plan, ''), /必须/);
  assert.throws(() => validateLivePlan({ ...plan, installationId: 'not-a-uuid' }, CANARY), /installationId/);
  assert.throws(() => validateLivePlan({ ...plan, helper: 'cliora' }, CANARY), /绝对路径/);
  assert.throws(() => validateLivePlan({ ...plan, targets: [] }, CANARY), /没有目标/);
  assert.throws(() => validateLivePlan({ ...plan, targets: [{ toolId: 'claude_code' }] }, CANARY), /printCommand/);
  assert.throws(() => validateLivePlan({ ...plan, targets: [{ toolId: 'claude_code', printCommand: [], }] }, CANARY), /printCommand/);
  // A target without the native config path cannot prove the mapping was written.
  const target = plan.targets[0];
  assert.throws(() => validateLivePlan({ ...plan, targets: [{ ...target, mcpConfigPath: undefined }] }, CANARY), /mcpConfigPath/);
  assert.throws(() => validateLivePlan({ ...plan, targets: [{ ...target, mcpConfigPath: 'relative/config.toml' }] }, CANARY), /mcpConfigPath/);
  assert.throws(() => validateLivePlan({ ...plan, targets: [{ ...target, mcpEntryName: '' }] }, CANARY), /mcpEntryName/);
});

const HEADER = '| 目标 | 映射 | 协议 | 模型 | 回退 | 平台 | 状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n';
const ANCHOR = '<a id="claude_code"></a>\n';
const row = (status, mapping = '.claude.json#mcpServers') => `| claude_code | ${mapping} | - | - | - | darwin | ${status} |\n`;
const record = (fields = {}) => {
  const values = {
    tool_id: 'claude_code',
    mapping: '.claude.json#mcpServers',
    recorded_at: '2026-11-21',
    evidence: 'docs/verification/secret-access.md#claude_code',
    ...fields,
  };
  const body = Object.entries(values).map(([key, value]) => `        ${key}: "${value}",`).join('\n');
  return `pub const ACCEPTANCES: &[SecretMcpAcceptance] = &[\n    SecretMcpAcceptance {\n${body}\n    },\n];\n`;
};

test('a documented pass without an adapter record is a failed consistency check', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cliora-secret-evidence-'));
  const docPath = path.join(directory, 'secret-access.md');
  const gatePath = path.join(directory, 'secret_access.rs');
  writeFileSync(gatePath, 'pub const ACCEPTANCES: &[SecretMcpAcceptance] = &[];\n');
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('verified')}`);
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /没有对应验收记录/);
  // A record the document does not confirm is a failure too.
  writeFileSync(gatePath, record());
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('unverified')}`);
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /不是 verified/);
  // Matching facts pass, and an unknown status word is never accepted.
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('verified')}`);
  assert.match(checkEvidenceConsistency({ docPath, gatePath }), /1 个目标行/);
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('probably')}`);
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /状态不是约定取值/);
});

test('a record is only trusted when it names the mapping the document lists', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cliora-secret-evidence-'));
  const docPath = path.join(directory, 'secret-access.md');
  const gatePath = path.join(directory, 'secret_access.rs');
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('verified')}`);
  // A mapping label that does not match the matrix row is not acceptance evidence.
  writeFileSync(gatePath, record({ mapping: '.codex/config.toml#mcp_servers' }));
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /映射标签与验收记录不一致/);
  // The remaining fields are required as well.
  writeFileSync(docPath, `${ANCHOR}${HEADER}${row('verified')}`);
  writeFileSync(gatePath, record({ mapping: undefined }));
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /缺少 mapping|映射/);
  writeFileSync(gatePath, record({ recorded_at: '2026/11/21' }));
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /日期不是 YYYY-MM-DD/);
  // An anchor that the document does not contain is not evidence either.
  writeFileSync(gatePath, record({ evidence: 'docs/verification/secret-access.md#missing' }));
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /锚点在文档中不存在/);
  writeFileSync(gatePath, record({ evidence: 'README.md' }));
  assert.throws(() => checkEvidenceConsistency({ docPath, gatePath }), /证据不是 docs\/verification\//);
});

test('the CLI fallback command is taken from the documented text, never guessed', () => {
  assert.deepEqual(tokenize("'/opt/Cliora App/Cliora' --x 'a b'"), ['/opt/Cliora App/Cliora', '--x', 'a b']);
  assert.throws(() => tokenize("'unbalanced"), /引号/);
  assert.throws(() => fallbackUseCommand('```\ncliora list\n```'), /use 命令/);
});
