import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSecretUsageInstructions, grantedExecutors, quoteArgument } from '../../src/lib/secretCommands.ts';

const input = {
  executable: '/Applications/Cliora.app/Contents/MacOS/cliora',
  entry: '--cliora-internal-secret-cli-v1',
  installationId: '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234',
  installationLabel: 'codex-cli',
  kind: 'cli',
  secrets: [
    { id: '11111111-2222-4333-8444-555555555555', alias: '生产部署口令' },
    { id: '99999999-8888-4777-8666-555555555555', alias: '未授权' },
  ],
  executors: [
    { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', label: '部署脚本' },
    { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', label: '未使用入口' },
  ],
  grants: [{ secretId: '11111111-2222-4333-8444-555555555555', executorId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
};

test('one argument is quoted only when a shell would reinterpret it', () => {
  assert.equal(quoteArgument('/usr/bin/env'), '/usr/bin/env');
  assert.equal(quoteArgument('4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234'), '4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234');
  assert.equal(quoteArgument('/Applications/Cliora.app/Contents/MacOS/cliora'), '/Applications/Cliora.app/Contents/MacOS/cliora');
  assert.equal(quoteArgument('/Users/me/Cliora Beta/cliora'), "'/Users/me/Cliora Beta/cliora'");
  assert.equal(quoteArgument("it's"), "'it'\\''s'");
  assert.equal(quoteArgument(''), "''");
});

test('only granted executors are offered for a secret', () => {
  assert.deepEqual(grantedExecutors(input, input.secrets[0].id).map(executor => executor.label), ['部署脚本']);
  assert.deepEqual(grantedExecutors(input, input.secrets[1].id), []);
});

test('the usage text names the real executable, entry and installation', () => {
  const text = buildSecretUsageInstructions(input);
  assert.match(text, /\/Applications\/Cliora\.app\/Contents\/MacOS\/cliora --cliora-internal-secret-cli-v1 --installation 4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234 list/);
  assert.match(text, /安装标识: codex-cli \(4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234\)/);
  // A granted pair produces one exact controlled-use command.
  assert.match(text, /use --secret 11111111-2222-4333-8444-555555555555 --executor aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
  assert.match(text, /别名 生产部署口令 · 执行入口 部署脚本/);
  // The read section documents the confirmation and warns about the model context.
  assert.match(text, /read --secret 11111111-2222-4333-8444-555555555555/);
  assert.match(text, /每次都要在栖点确认/);
  assert.match(text, /模型上下文/);
});

test('an ungranted secret and unused executor never appear as a command', () => {
  const text = buildSecretUsageInstructions(input);
  assert.doesNotMatch(text, /99999999-8888-4777-8666-555555555555/);
  assert.doesNotMatch(text, /bbbbbbbb-cccc-4ddd-8eee-ffffffffffff/);
  assert.doesNotMatch(text, /未使用入口/);
});

test('an installation without grants gets instructions instead of a guessed command', () => {
  const text = buildSecretUsageInstructions({ ...input, grants: [] });
  assert.match(text, /list/);
  assert.doesNotMatch(text, /use --secret/);
  assert.doesNotMatch(text, /read --secret/);
  assert.match(text, /还没有任何已授权的秘密与执行入口/);
});

test('an executable with spaces stays one quoted argument in every command', () => {
  const text = buildSecretUsageInstructions({ ...input, executable: '/Users/me/Cliora Beta/cliora' });
  for (const line of text.split('\n').filter(line => line.includes('--installation'))) {
    assert.ok(line.startsWith("'/Users/me/Cliora Beta/cliora' --cliora-internal-secret-cli-v1"), line);
  }
});

test('the English text keeps the same commands and identifiers', () => {
  const text = buildSecretUsageInstructions({ ...input, locale: 'en' });
  assert.match(text, /Cliora secret broker \(local CLI\)/);
  assert.match(text, /Installation: codex-cli/);
  assert.match(text, /use --secret 11111111-2222-4333-8444-555555555555 --executor aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
  assert.match(text, /each read asks for confirmation/);
  assert.doesNotMatch(text, /别名/);
});
