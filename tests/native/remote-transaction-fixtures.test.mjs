import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { transactionOutcomeDiagnostic, transactionToolWrapper } from '../../scripts/remote-transaction-fixtures.mjs';

test('native transaction diagnostics retain failure stage/outcome without arbitrary message bodies or credentials', () => {
  const known = '远程目标不是可安全替换的普通文件，或无法核查版本';
  const diagnostic = transactionOutcomeDiagnostic({ ok: false, error: { code: 'remote_command', message: known, remote: { stage: 'remote_command', outcome: 'failed', reason: 'command' } } });
  assert.equal(diagnostic.message, known);
  assert.equal(diagnostic.stage, 'remote_command');
  assert.equal(diagnostic.outcome, 'failed');
  const unsafe = transactionOutcomeDiagnostic({ ok: false, error: { message: 'private config body secret-value', password: 'secret-value', remote: { stage: 'stage with secret-value', receipt: { id: 'private', items: [{ state: 'applying', contents: 'secret-value', path: '/private' }] } } } });
  assert.ok(!JSON.stringify(unsafe).includes('secret-value'));
  assert.ok(!JSON.stringify(unsafe).includes('/private'));
  assert.deepEqual(unsafe.receipt.states, ['applying']);
});

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
test('owned native fault wrappers affect only adjacent transaction replacement and protected backups', t => {
  const probe = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'sh', process.platform === 'win32' ? ['--exec', 'sh', '-c', 'printf ready'] : ['-c', 'printf ready'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return t.skip('No POSIX shell; native acceptance is still required.');
  // Fixed paths are confined to a fresh isolated /tmp directory created here.
  const scripts = ['mv', 'cp'].map(tool => `printf %s ${quote(Buffer.from(transactionToolWrapper(tool, '/tmp/placeholder', '/tmp/control')).toString('base64'))} | base64 -d > "$task_root/${tool}.template"`).join('\n');
  const shell = `set -eu
 task_root=$(mktemp -d /tmp/cliora-remote-test-wrappers-XXXXXX)
 case "$task_root" in /tmp/cliora-remote-test-wrappers-*) ;; *) exit 90;; esac
 trap 'rm -rf -- "$task_root"' EXIT
 export HOME="$task_root/home"
 mkdir -p "$HOME/bin" "$HOME/.cliora/transactions/owned" "$task_root/control"
 ${scripts}
 for tool in mv cp; do sed -e "s|/tmp/placeholder|$HOME|g" -e "s|/tmp/control|$task_root/control|g" "$task_root/$tool.template" > "$HOME/bin/$tool"; chmod 700 "$HOME/bin/$tool"; done
 export PATH="$HOME/bin:$PATH"
 : > "$task_root/control/enabled"
 printf replace-failure > "$task_root/control/mode"
 printf normal > "$HOME/.cliora/transactions/owned/receipt.next"
 mv "$HOME/.cliora/transactions/owned/receipt.next" "$HOME/.cliora/transactions/owned/receipt"
 [ ! -f "$task_root/control/count" ]
 printf first > "$HOME/a.cliora-owned-0.tmp"; mv "$HOME/a.cliora-owned-0.tmp" "$HOME/a"
 printf second > "$HOME/b.cliora-owned-1.tmp"
 if mv "$HOME/b.cliora-owned-1.tmp" "$HOME/b"; then exit 91; fi
 [ "$(cat "$HOME/a")" = first ]; [ ! -e "$HOME/b" ]
 printf rollback-failure > "$task_root/control/mode"
 printf restore > "$HOME/a.cliora-owned-restore"
 if mv "$HOME/a.cliora-owned-restore" "$HOME/a"; then exit 92; fi
 printf prepare-failure > "$task_root/control/mode"
 if cp "$HOME/a" "$HOME/.cliora/transactions/owned/0.backup"; then exit 93; fi
 cp "$HOME/a" "$HOME/ordinary-copy"
 [ "$(cat "$HOME/ordinary-copy")" = first ]
 printf passed
`;
  const result = spawnSync(process.platform === 'win32' ? 'wsl.exe' : 'sh', process.platform === 'win32' ? ['--exec', 'sh', '-s'] : ['-s'], { input: shell, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'passed');
});
