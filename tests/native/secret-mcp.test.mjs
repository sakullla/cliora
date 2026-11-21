import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSecretUsageFromMetadata, preferredInstallation } from '../../src/lib/secretCommands.ts';

// The CLI fallback the secret MCP panel offers. It is built from local metadata:
// the executable, one installation id, the secrets and the granted pairs. A value
// is never part of an instruction, so it cannot appear here either.
const CANARY = 'canary-synthetic-mcp-51fa7c';

const context = {
  executable: '/Applications/Cliora.app/Contents/MacOS/cliora',
  entry: '--cliora-internal-secret-cli-v1',
};

const mcpInstallation = { id: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234', label: '秘密 MCP · pi', kind: 'mcp', revoked: false };
const cliInstallation = { id: '9a1d3f57-2b8c-4e6a-8f01-3c5d7e9b1a22', label: 'codex-cli', kind: 'cli', revoked: false };
const revoked = { id: '00000000-1111-4222-8333-444444444444', label: '旧安装', kind: 'mcp', revoked: true };

const secrets = [
  { id: '11111111-2222-4333-8444-555555555555', alias: '生产部署口令' },
  { id: '99999999-8888-4777-8666-555555555555', alias: '未授权' },
];
const executors = [
  { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', label: '部署脚本' },
  { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', label: '未使用入口' },
];
const grants = [
  { installationId: mcpInstallation.id, secretId: secrets[0].id, executorId: executors[0].id },
  { installationId: cliInstallation.id, secretId: secrets[1].id, executorId: executors[1].id },
];

test('a pinned live installation wins over the registry order', () => {
  assert.equal(preferredInstallation([cliInstallation, mcpInstallation], grants, mcpInstallation.id)?.id, mcpInstallation.id);
  // A revoked pin is not reusable: the text must not name a dead identity.
  assert.equal(preferredInstallation([revoked, cliInstallation], grants, revoked.id)?.id, cliInstallation.id);
});

test('without a pin the first installation with a grant is used', () => {
  assert.equal(preferredInstallation([mcpInstallation, cliInstallation], grants)?.id, mcpInstallation.id);
  assert.equal(preferredInstallation([mcpInstallation], grants)?.id, mcpInstallation.id);
  // No grant anywhere still leaves a list command instead of a broken use command.
  assert.equal(preferredInstallation([cliInstallation], [])?.id, cliInstallation.id);
  assert.equal(preferredInstallation([], grants), undefined);
  assert.equal(preferredInstallation([revoked], grants), undefined);
});

test('the fallback for an MCP installation runs the CLI helper with that installation', () => {
  const text = buildSecretUsageFromMetadata({ context, installations: [mcpInstallation], secrets, executors, grants, preferredId: mcpInstallation.id });
  assert.ok(text);
  assert.match(text, /--cliora-internal-secret-cli-v1 --installation 4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234 list/);
  assert.match(text, /安装标识: 秘密 MCP · pi \(4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234\)/);
  assert.match(text, /use --secret 11111111-2222-4333-8444-555555555555 --executor aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
  // The read section documents the confirmation and the model-context warning.
  assert.match(text, /read --secret 11111111-2222-4333-8444-555555555555/);
  assert.match(text, /每次都要在栖点确认/);
  assert.match(text, /模型上下文/);
});

test('a grant of another installation is not offered', () => {
  const text = buildSecretUsageFromMetadata({ context, installations: [mcpInstallation], secrets, executors, grants, preferredId: mcpInstallation.id });
  assert.ok(text);
  assert.doesNotMatch(text, new RegExp(cliInstallation.id));
  assert.doesNotMatch(text, new RegExp(secrets[1].id));
  assert.doesNotMatch(text, /未使用入口/);
});

test('the text holds identifiers and aliases only, never a value', () => {
  const text = buildSecretUsageFromMetadata({ context, installations: [mcpInstallation], secrets, executors, grants, preferredId: mcpInstallation.id });
  assert.ok(text);
  assert.doesNotMatch(text, new RegExp(CANARY));
  assert.doesNotMatch(text, /--value|CLIORA_SECRET=|secretValue/);
  // The entry this text documents is the CLI helper, not the internal MCP entry.
  assert.doesNotMatch(text, /--cliora-internal-secret-mcp-v1/);
});

test('an installation with no grant gets instructions instead of a guessed command', () => {
  const text = buildSecretUsageFromMetadata({ context, installations: [mcpInstallation], secrets, executors, grants: [], preferredId: mcpInstallation.id });
  assert.ok(text);
  assert.match(text, /list/);
  assert.doesNotMatch(text, /use --secret/);
  assert.doesNotMatch(text, /read --secret/);
  assert.match(text, /还没有任何已授权的秘密与执行入口/);
});

test('no live installation leaves no text at all', () => {
  assert.equal(buildSecretUsageFromMetadata({ context, installations: [revoked], secrets, executors, grants }), null);
  assert.equal(buildSecretUsageFromMetadata({ context, installations: [], secrets, executors, grants }), null);
});

test('the english fallback states the same facts', () => {
  const text = buildSecretUsageFromMetadata({ context, installations: [mcpInstallation], secrets, executors, grants, preferredId: mcpInstallation.id, locale: 'en' });
  assert.ok(text);
  assert.match(text, /## Cliora secret broker \(local CLI\)/);
  assert.match(text, /Installation: 秘密 MCP · pi/);
  assert.match(text, /asks for confirmation in Cliora/);
  assert.match(text, /model context and the CLI session history/);
});
