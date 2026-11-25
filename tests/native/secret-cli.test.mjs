import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSecretUsageInstructions, prepareLocalSecretPrompt, quoteArgument } from '../../src/lib/secretCommands.ts';

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

test('the usage text names the real executable, entry and installation', () => {
  const text = buildSecretUsageInstructions(input);
  assert.match(text, /\/Applications\/Cliora\.app\/Contents\/MacOS\/cliora --cliora-internal-secret-cli-v1 --installation 4c2f8c9e-6b1a-4c44-9d5b-6f0a2b7c1234 list/);
  assert.match(text, /安装标识: codex-cli/);
  // A granted pair produces one exact controlled-use command.
  assert.match(text, /use --secret 11111111-2222-4333-8444-555555555555 --executor aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
  assert.match(text, /生产部署口令 · 部署脚本/);
  // The read section documents the confirmation and warns about the model context.
  assert.match(text, /read --secret 11111111-2222-4333-8444-555555555555/);
  assert.match(text, /允许本次会话/);
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
  assert.match(text, /此连接尚无已授权操作/);
});

test('an executable with spaces stays one quoted argument in every command', () => {
  const text = buildSecretUsageInstructions({ ...input, executable: '/Users/me/Cliora Beta/cliora' });
  for (const line of text.split('\n').filter(line => line.includes('--installation'))) {
    assert.ok(line.startsWith("'/Users/me/Cliora Beta/cliora' --cliora-internal-secret-cli-v1"), line);
  }
});

test('the copied CLI guide uses list and one granted example for a large inventory', () => {
  const secrets = Array.from({ length: 350 }, (_, i) => ({ id: 'secret-' + i, alias: 'alias-' + i }));
  const grants = secrets.map(secret => ({ secretId: secret.id, executorId: input.executors[0].id }));
  const text = buildSecretUsageInstructions({ ...input, secrets, grants });
  assert.equal(text.match(/--installation /g)?.length, 3);
  assert.match(text, /alias-0 · 部署脚本/);
  assert.match(text, /executors\[\]\.id/);
  assert.doesNotMatch(text, /alias-349|secret-349/);
});

test('the English text keeps the same commands and identifiers', () => {
  const text = buildSecretUsageInstructions({ ...input, locale: 'en' });
  assert.match(text, /Cliora secret broker \(local CLI\)/);
  assert.match(text, /Installation: codex-cli/);
  assert.match(text, /use --secret 11111111-2222-4333-8444-555555555555 --executor aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/);
  assert.match(text, /Allow for this session/);
  assert.doesNotMatch(text, /别名/);
});

test('local prompts carry credential names, scoped actions and a distinct approval-only read command', async () => {
  const { id, alias } = input.secrets[0];
  const token = '{{cliora-secret:' + id + '}}';
  const body = '传递 ' + token + '\n需要时运行已授权的操作 ' + token;
  const grant = { installationId: input.installationId, secretId: id, alias, executorId: input.executors[0].id, executorLabel: '测试传递' };
  const installation = { id: input.installationId, kind: 'cli', targetId: null, revoked: false };
  const metadata = {
    cli: { executable: "C:\\Program Files\\O'Brien\\cliora.exe", entry: input.entry },
    installations: [installation, { ...installation, id: 'other-target', targetId: 'other' }, { ...installation, id: 'revoked', revoked: true }],
    grants: [grant, { ...grant, installationId: 'other-target' }, { ...grant, installationId: 'revoked' }, { ...grant, secretId: input.secrets[1].id }],
  };
  const outgoing = await prepareLocalSecretPrompt(body, async () => metadata, false);
  assert.ok(outgoing.startsWith(body.replaceAll(token, alias) + '\n'));
  assert.ok(outgoing.includes(alias + ' · ' + grant.executorLabel));
  assert.ok(!outgoing.includes(token));
  const commands = outgoing.split('\n').filter(line => line.includes('--installation'));
  assert.equal(commands.length, 2);
  assert.ok(commands.every(line => line.startsWith("& 'C:\\Program Files\\O''Brien\\cliora.exe' ")));
  assert.ok(commands.some(line => line.endsWith(' use --secret ' + id + ' --executor ' + grant.executorId + ' | Out-String -Stream')));
  assert.ok(commands.some(line => line.endsWith(' read --secret ' + id + ' | Out-String -Stream')));
  assert.ok(commands.every(line => !line.endsWith(' list | Out-String -Stream')));
  assert.doesNotMatch(outgoing, /revoked|other-target|99999999/);
  const unavailable = await prepareLocalSecretPrompt(body, async () => ({ ...metadata, grants: [] }), true);
  assert.match(unavailable, /not configured on this device/);
  assert.doesNotMatch(unavailable, /--installation/);
  assert.equal(await prepareLocalSecretPrompt('plain text', () => assert.fail('unexpected metadata lookup'), false), 'plain text');
});

test('legacy helper arguments and code samples retain references while adjacent prose shows names', { skip: process.platform === 'win32' }, async () => {
  const id = input.secrets[0].id;
  const reference = '{{cliora-secret:' + id + '}}';
  const alias = 'literal $(exit 37)';
  const command = "fixture_cli read --secret '" + reference + "'";
  const sample = '~~~sh\nprintf %s ' + reference + '\n~~~';
  const task = ['Use ' + reference, command, sample, 'Run `' + command + '` for ' + reference].join('\n');
  const out = await prepareLocalSecretPrompt(task, async selected => {
    assert.equal(selected, reference);
    return {
      cli: { executable: 'fixture_cli', entry: input.entry }, grants: [], installations: [],
      directReads: [], referenceAliases: { [id]: alias },
    };
  }, true);
  const [prose, legacy] = out.split('\n');
  assert.equal(prose, 'Use ' + alias);
  assert.equal(legacy, command);
  assert.ok(out.includes(sample) && out.includes('Run `' + command + '` for ' + alias));
  assert.doesNotMatch(out, /--installation|--format values|use_secret/);
  const stub = 'fixture_cli() { test "$1" = read && test "$2" = --secret && test "$3" = ' + quoteArgument(reference) + '; }';
  assert.equal(spawnSync('sh', ['-c', stub + '\n' + legacy]).status, 0);
  const granted = await prepareLocalSecretPrompt(task, async () => ({
    cli: { executable: 'fixture_cli', entry: input.entry }, grants: [],
    installations: [{ id: 'local', kind: 'cli', directReadOnly: true }],
    directReads: [{ installationId: 'local', secretId: id, alias }],
  }), true);
  assert.equal(granted.split('\n')[1], command);
  assert.match(granted, /--format values/);
  assert.doesNotMatch(granted, /use_secret|--executor/);
});

test('the local read example can feed a service in memory without printing a credential', { skip: process.platform === 'win32' }, async () => {
  const secret = input.secrets[0];
  const alias = "LOGIN's key";
  const canary = 'fixture-quote"\nfixture-next-line';
  const text = await prepareLocalSecretPrompt('Sign in {{cliora-secret:' + secret.id + '}}', async () => ({
    cli: { executable: 'fixture_read', entry: input.entry }, grants: [],
    installations: [{ id: 'local', kind: 'cli', directReadOnly: true }],
    directReads: [{ secretId: secret.id, installationId: 'local', alias }],
  }), true);
  const assignment = text.split('\n').at(-1);
  const check = 'const values = JSON.parse(require("fs").readFileSync(0)); if (values[' + JSON.stringify(alias) + '] !== '
    + JSON.stringify(canary) + ') process.exit(2); process.stdout.write("service-ok")';
  const consume = 'printf %s "$credentialsJson" | ' + quoteArgument(process.execPath) + ' -e ' + quoteArgument(check);
  const approved = 'fixture_read() { printf %s ' + quoteArgument(JSON.stringify({ [alias]: canary })) + '; }';
  for (const [helper, status, output] of [[approved, 0, 'service-ok'], ['fixture_read() { return 1; }', 1, '']]) {
    const script = [helper, assignment + ' || exit $?', consume].join('\n');
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, status);
    assert.equal(result.stdout, output);
    assert.equal(result.stderr, '');
  }
});

test('Windows PowerShell waits for a delayed GUI helper response and preserves its exit code', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), "cliora helper's test-"));
  const source = join(directory, 'helper.cs');
  const executable = join(directory, 'cliora.exe');
  try {
    writeFileSync(source, [
      'using System;',
      'class Helper { static int Main(string[] args) {',
      '  System.Threading.Thread.Sleep(300);',
      '  bool declined = Array.IndexOf(args, "read") >= 0;',
      '  Console.WriteLine(declined ? "{\\"code\\":\\"declined\\"}" : "{\\"code\\":\\"ok\\"}");',
      '  return declined ? 1 : 0;',
      '} }',
    ].join('\n'));
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const build = spawnSync(compiler, ['/nologo', '/target:winexe', '/out:' + executable, source], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.error?.message ?? build.stdout + build.stderr);
    const instructions = buildSecretUsageInstructions({ ...input, executable });
    const commands = instructions.split('\n').filter(line => line.startsWith('& '));
    assert.equal(commands.length, 3);
    for (const command of commands) {
      const declined = command.includes(' read --secret');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        command + "\nWrite-Output 'done'\nexit $LASTEXITCODE"], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, declined ? 1 : 0, result.error?.message ?? result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\r?\n/), [JSON.stringify({ code: declined ? 'declined' : 'ok' }), 'done']);
    }
  } finally {
    rmSync(executable, { force: true });
    rmSync(source, { force: true });
    rmdirSync(directory);
  }
});

test('one synced prompt generates only destination commands on Windows, macOS and Linux', async () => {
  const secret = input.secrets[0];
  const body = '部署 ' + '{{cliora-secret:' + secret.id + '}}';
  for (const [platform, executable] of Object.entries({
    windows: 'C:\\Cliora\\cliora.exe', mac: '/Applications/Cliora.app/Contents/MacOS/cliora', linux: '/usr/bin/cliora',
  })) {
    const installationId = 'local-' + platform;
    const out = await prepareLocalSecretPrompt(body, async () => ({
      cli: { executable, entry: input.entry },
      installations: [{ id: installationId, kind: 'cli', targetId: null, revoked: false }],
      grants: [{ secretId: secret.id, alias: secret.alias, installationId, executorId: platform, executorLabel: '部署' }],
    }), false);
    assert.ok(out.startsWith('部署 ' + secret.alias));
    assert.ok(out.includes(executable));
    assert.ok(out.includes('--installation ' + installationId));
    assert.ok(out.includes('--executor ' + platform));
    assert.equal(out.includes('Out-String'), platform === 'windows');
    assert.ok(!out.includes(input.installationId));
  }
});
