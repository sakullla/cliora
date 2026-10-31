/** Isolated native transaction faults. Helpers contain no product fault bypass. */
import { createHash, randomUUID } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Error payloads may include CLI output or configuration text. Persist only
 * protocol labels, known product messages and hash-only receipt metadata. */
export function transactionOutcomeDiagnostic(result) {
  const error = result?.error;
  const remote = error?.remote;
  const label = value => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : null;
  const safeMessages = new Set([
    '远程目标不是可安全替换的普通文件，或无法核查版本',
    '远程文件版本已变化，请保留草稿并刷新后比较',
    '远程写入未确认完成；请核查持久回执，保留草稿，不要直接重试',
    '无效或重复的远程请求身份',
    '远程写入超过事务上限',
  ]);
  const message = remote?.message ?? error?.message;
  const receipt = remote?.receipt;
  return {
    ok: result?.ok === true, code: label(error?.code), stage: label(remote?.stage), reason: label(remote?.reason), outcome: label(remote?.outcome),
    message: result?.ok ? null : safeMessages.has(message) ? message : 'Native IPC error details omitted (unrecognized message).',
    receipt: receipt ? {
      id: typeof receipt.id === 'string' && /^[a-f0-9-]{36}$/.test(receipt.id) ? receipt.id : null,
      outcome: label(receipt.outcome), itemCount: Array.isArray(receipt.items) ? receipt.items.length : null,
      states: Array.isArray(receipt.items) ? receipt.items.map(item => label(item.state)) : [],
    } : null,
  };
}

export function transactionToolWrapper(tool, home, control) {
  assert(['mv', 'cp'].includes(tool), 'Unknown fixture tool.');
  return `#!/bin/sh
expected=${quote(home)}
control=${quote(control)}
[ "$HOME" = "$expected" ] && [ -f "$control/enabled" ] || exec /usr/bin/${tool} "$@"
mode=$(cat "$control/mode" 2>/dev/null)
source=''
for argument in "$@"; do
  case "$argument" in "$expected/"*.cliora-*.tmp|"$expected/"*.cliora-*-restore) source="$argument"; break;; esac
done
${tool === 'cp' ? `if [ "$mode" = prepare-failure ]; then
  for argument in "$@"; do case "$argument" in "$expected/.cliora/transactions/"*.backup) exit 51;; esac; done
fi` : `case "$source" in
  *.tmp)
    count=$(cat "$control/count" 2>/dev/null || printf 0)
    count=$((count + 1)); printf '%s' "$count" > "$control/count"
    if [ "$count" = 2 ]; then
      case "$mode" in replace-failure|rollback-failure) exit 52;;
        pause-replace)
          : > "$control/paused"
          waited=0
          while [ ! -f "$control/release" ] && [ "$waited" -lt 300 ]; do sleep 0.1; waited=$((waited+1)); done
          [ -f "$control/release" ] || exit 53;;
      esac
    fi;;
  *-restore) [ "$mode" != rollback-failure ] || exit 54;;
esac`}
exec /usr/bin/${tool} "$@"
`;
}

export async function runTransactionAcceptance({ config, targetId, invoke, evaluate, observe, report, check }) {
  const settings = config.transactions;
  assert(settings && typeof settings.home === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(settings.home)
    && settings.home.includes('cliora-remote-test') && !settings.home.includes('..'), 'Supply the exact dedicated transactions.home.');
  assert(config.toolId === 'codex', 'This fixture uses the explicitly selected Codex TOML mapping; no CLI installation is needed.');
  const home = settings.home;
  const control = `${home}/.cliora-t6-${config.testRunId}-${randomUUID()}`;
  report.transactionFixture = { home, control };
  const wrapperHashes = {};
  let installed = false;
  const installedTools = new Set();
  const createdReceipts = new Set();
  const settledReceipts = new Set();
  const originalReceipts = new Set();
  let savedTarget;
  let nativePath;
  let nativeOriginalHash;
  let managementPath;
  let managementOriginalHash;
  let externalHash;
  const op = (kind, expectedFiles = {}) => ({ requestId: randomUUID(), cancelToken: randomUUID(), targetId, targetRevision: savedTarget.updatedAt, kind, priority: 'interactive', deadlineUnixMs: Date.now() + 120000, refresh: true, expectedFiles });
  const outcome = (name, args) => evaluate(`(async()=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})};}catch(error){return {ok:false,error};}})()`);
  const read = async () => {
    const operation = op('read');
    const value = await invoke('get_remote_tool_store', { targetId, toolId: config.toolId, scope: 'global', projectPath: null, operation });
    const versions = await invoke('get_remote_write_snapshot', { requestId: operation.requestId });
    assert(Object.keys(versions).length >= 2, 'The actual read must bind management and native file versions.');
    return { value, versions };
  };
  const receipts = async () => invoke('list_remote_write_receipts', { targetId, operation: op('read') });
  const inspect = async (id, rollback) => invoke('inspect_remote_write', { targetId, receiptId: id, rollback, operation: op(rollback ? 'write' : 'read') });
  const mode = async value => observe(`printf '%s' ${quote(value)} > ${quote(control + '/mode')}; printf 0 > ${quote(control + '/count')}; rm -f -- ${quote(control + '/paused')} ${quote(control + '/release')}`);
  const relay = async offline => {
    const url = offline ? settings.relay?.offlineUrl : settings.relay?.onlineUrl;
    assert(typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url), 'A loopback POST relay URL is required for disconnect acceptance.');
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000) });
    assert(response.ok, 'Relay control failed.');
  };
  try {
    check('observer sees the exact isolated HOME', (await observe('printf %s "$HOME"')).trim() === home);
    const targets = await invoke('list_remote_targets');
    savedTarget = targets.find(item => item.id === targetId);
    assert(savedTarget?.enabled, 'Run create/preflight target setup before transactions.');
    assert(['host', 'port', 'user', 'authMethod', 'identityFile', 'sshConfig'].every(key => (savedTarget[key] ?? null) === (config.target[key] ?? null)), 'Existing target does not match this isolated transaction configuration.');
    const catalog = await invoke('list_cli_adapters');
    const descriptor = catalog.registered.find(item => item.id === config.toolId);
    const document = descriptor?.remoteNativeFiles?.find(item => item.scope === 'global' && item.role === 'settings' && item.format === 'toml');
    assert(document && /^[a-zA-Z0-9_./-]+$/.test(document.relative) && !document.relative.includes('..'), 'Actual adapter must declare the fixture native path.');
    nativePath = `${home}/${document.relative}`;
    const initial = await read();
    nativeOriginalHash = initial.versions[`$HOME/${document.relative}`];
    assert(nativeOriginalHash && nativeOriginalHash !== 'missing', 'The fixed fixture must contain a native document.');
    const management = Object.keys(initial.versions).filter(path => path.startsWith('$HOME/.cliora/registered-tools/'));
    assert(management.length === 1 && initial.versions[management[0]] !== 'missing', 'The rollback-failure fixture requires an existing isolated management document as well as the native document. Seed and fingerprint both externally; restore both original states after this runner.');
    managementPath = `${home}/${management[0].slice('$HOME/'.length)}`;
    managementOriginalHash = initial.versions[management[0]];
    report.transactionOriginalVersions = { native: nativeOriginalHash, management: managementOriginalHash };
    for (const receipt of await receipts()) {
      originalReceipts.add(receipt.id);
      assert(['committed', 'rolled_back', 'prepare_failed', 'conflict_before_commit'].includes(receipt.outcome), 'Existing unresolved transaction must be inspected before this fixture.');
    }
    await observe(`[ ! -L "$HOME/bin" ] && [ ! -e "$HOME/bin/mv" ] && [ ! -L "$HOME/bin/mv" ] && [ ! -e "$HOME/bin/cp" ] && [ ! -L "$HOME/bin/cp" ] || exit 81; umask 077; mkdir -p "$HOME/bin"; mkdir ${quote(control)}; chmod 700 ${quote(control)}; /usr/bin/cp -- ${quote(nativePath)} ${quote(control + '/native.before')}; chmod 600 ${quote(control + '/native.before')}`);
    installed = true;
    for (const tool of ['mv', 'cp']) {
      const script = transactionToolWrapper(tool, home, control);
      wrapperHashes[tool] = hash(script);
      installedTools.add(tool);
      await observe(`umask 077; set -C; printf '%s' ${quote(Buffer.from(script).toString('base64'))} | base64 -d > "$HOME/bin/${tool}"; chmod 700 "$HOME/bin/${tool}"`);
    }
    installed = true;
    await observe(`: > ${quote(control + '/enabled')}`);
    for (const fault of ['success', 'prepare-failure', 'replace-failure', 'rollback-failure', ...(settings.relay ? ['pause-replace'] : [])]) {
      await mode(fault);
      const baseline = await read();
      const candidate = structuredClone(baseline.value);
      candidate.currentFiles.settings += `\n# isolated-t6-${config.testRunId}-${fault}\n`;
      const submission = outcome('save_remote_tool_store', { targetId, toolId: config.toolId, store: candidate, scope: 'global', projectPath: null, operation: op('write', baseline.versions) });
      if (fault === 'pause-replace') {
        const deadline = Date.now() + 20000;
        let paused = false;
        while (Date.now() < deadline) { if ((await observe(`[ -f ${quote(control + '/paused')} ] && printf yes || printf no`)).trim() === 'yes') { paused = true; break; } await sleep(100); }
        assert(paused, 'Owned wrapper did not reach the second real replacement.');
        await relay(true);
        await observe(`: > ${quote(control + '/release')}`);
      }
      const result = await submission;
      (report.transactionOutcomes ??= []).push({ fault, ...transactionOutcomeDiagnostic(result) });
      if (fault === 'pause-replace') await relay(false);
      check(`${fault}: actual IPC outcome`, fault === 'success' ? result.ok : !result.ok);
      if (fault === 'pause-replace') check('disconnect returns unknown and does not claim undo', result.error?.remote?.outcome === 'unknown');
      const current = await receipts();
      const added = current.filter(item => !originalReceipts.has(item.id) && !createdReceipts.has(item.id));
      assert(added.length === 1, 'Exactly one durable transaction must correspond to the submission.');
      const receipt = added[0]; createdReceipts.add(receipt.id);
      check(`${fault}: management and native per-file receipt`, receipt.items.length === 2);
      check(`${fault}: receipt exposes hashes without snapshots`, receipt.items.every(item => /^[a-f0-9]{64}$|^missing$/.test(item.before) && /^[a-f0-9]{64}$|^missing$/.test(item.after) && !('contents' in item)));
      if (fault === 'rollback-failure') check('real rollback failure remains recoverable', receipt.items[0]?.before !== 'missing' && receipt.outcome === 'recovery_required' && receipt.items[0]?.state === 'rollback_failed');
      await mode('off');
      const inspected = await inspect(receipt.id, false);
      check(`${fault}: each actual version was inspected`, inspected.items.every(item => ['before', 'after'].includes(item.observed)));
      const restored = await inspect(receipt.id, true);
      check(`${fault}: explicit recovery restores original versions`, restored.outcome === 'rolled_back' && restored.items.every(item => item.observed === 'before'));
      const after = await read();
      check(`${fault}: independent post-recovery versions match`, Object.entries(baseline.versions).every(([file, version]) => after.versions[file] === version));
      settledReceipts.add(receipt.id);
    }
    // Completed history must remain completed while newer legitimate writes
    // own the current versions. Explicit old-backup restore must be a no-op.
    await mode('off');
    const history = [];
    for (const suffix of ['A', 'B', 'C']) {
      const baseline = await read();
      if (suffix === 'C') {
        const old = await inspect(history[0].id, false);
        check('historical inspection preserves completed outcome after a later write', old.outcome === 'committed' && old.items.some(item => item.observed === 'conflict'));
        const refused = await inspect(history[0].id, true);
        check('historical restore preserves newer files and completed outcome', refused.outcome === 'committed' && refused.items.some(item => item.observed === 'conflict'));
        const unchanged = await read();
        check('historical restore changes no newer file', Object.entries(baseline.versions).every(([path, version]) => unchanged.versions[path] === version));
      }
      const candidate = structuredClone(baseline.value);
      candidate.currentFiles.settings += `\n# isolated-history-${config.testRunId}-${suffix}\n`;
      const result = await outcome('save_remote_tool_store', { targetId, toolId: config.toolId, store: candidate, scope: 'global', projectPath: null, operation: op('write', baseline.versions) });
      (report.transactionOutcomes ??= []).push({ fault: `history-${suffix}`, ...transactionOutcomeDiagnostic(result) });
      check(`history-${suffix}: normal save reaches actual commit`, result.ok);
      const added = (await receipts()).filter(item => !originalReceipts.has(item.id) && !createdReceipts.has(item.id));
      assert(added.length === 1, 'Exactly one journal must correspond to each history submission.');
      createdReceipts.add(added[0].id); history.push(added[0]);
    }
    for (const receipt of history.reverse()) {
      const restored = await inspect(receipt.id, true);
      check('restore consecutive owned history in reverse order', restored.outcome === 'rolled_back' && restored.items.every(item => item.observed === 'before'));
      settledReceipts.add(receipt.id);
    }
    // A stale user draft is rejected before any managed/native mutation. The
    // observer removes only its own precisely fingerprinted appended comment.
    await mode('off');
    const baseline = await read();
    const suffix = `\n# isolated-external-change-${config.testRunId}\n`;
    externalHash = hash(baseline.value.currentFiles.settings + suffix);
    await observe(`printf '%s' ${quote(suffix)} >> ${quote(nativePath)}`);
    const rejected = await outcome('save_remote_tool_store', { targetId, toolId: config.toolId, store: baseline.value, scope: 'global', projectPath: null, operation: op('write', baseline.versions) });
    (report.transactionOutcomes ??= []).push({ fault: 'stale-native-version', ...transactionOutcomeDiagnostic(rejected) });
    check('stale native version rejects whole write without replay', !rejected.ok && rejected.error?.remote?.outcome !== 'unknown');
    const changed = await read();
    check('external change survives rejected write', changed.versions[`$HOME/${document.relative}`] === externalHash);
    await observe(`[ "$(sha256sum -- ${quote(nativePath)} | cut -d ' ' -f 1)" = ${quote(externalHash)} ] && /usr/bin/cp -- ${quote(control + '/native.before')} ${quote(nativePath)} && chmod 600 ${quote(nativePath)}`);
    externalHash = null;
    check('protected backup policy on real filesystem', (await observe(`stat -c '%a' "$HOME/.cliora/transactions"; find "$HOME/.cliora/transactions" -name '*.backup' -type f -printf '%m\n' | sort -u`)).trim().split(/\r?\n/).every(value => ['700', '600'].includes(value)));
    report.status = settings.relay ? 'transaction_checks_passed' : 'transaction_disconnect_not_verified';
    if (!settings.relay) { report.limitations.push('No configured relay: real post-commit disconnect is not verified.'); process.exitCode = 2; }
  } finally {
    if (settings.relay) await relay(false).catch(() => { report.limitations.push('Relay restore failed; inspect isolated test environment.'); process.exitCode = 1; });
    if (installed) {
      let recovered = false;
      try {
        await mode('off');
        await observe(`: > ${quote(control + '/release')}`);
        if (externalHash && nativePath) await observe(`[ "$(sha256sum -- ${quote(nativePath)} | cut -d ' ' -f 1)" = ${quote(externalHash)} ] && /usr/bin/cp -- ${quote(control + '/native.before')} ${quote(nativePath)}`).catch(() => { process.exitCode = 1; });
        for (const receipt of await receipts()) if (!originalReceipts.has(receipt.id)) createdReceipts.add(receipt.id);
        // Earlier completed cases were already independently checked. Recover
        // only this run's outstanding work, newest first, never an older
        // snapshot over the files belonging to a later transaction.
        for (const id of [...createdReceipts].reverse().filter(id => !settledReceipts.has(id))) {
          const receipt = await inspect(id, false);
          if (receipt.outcome !== 'rolled_back') {
            const restored = await inspect(id, true);
            assert(restored.outcome === 'rolled_back', 'Fixture recovery remains incomplete; preserve protected backup.');
          }
        }
        const nativeFinal = (await observe(`sha256sum -- ${quote(nativePath)} | cut -d ' ' -f 1`)).trim();
        const managementFinal = (await observe(`sha256sum -- ${quote(managementPath)} | cut -d ' ' -f 1`)).trim();
        report.transactionFinalVersions = { native: nativeFinal, management: managementFinal };
        check('finally restored actual native original hash', nativeFinal === nativeOriginalHash);
        check('finally restored actual management original hash', managementFinal === managementOriginalHash);
        recovered = true;
      } finally {
        for (const tool of installedTools) await observe(`[ "$(sha256sum -- "$HOME/bin/${tool}" | cut -d ' ' -f 1)" = ${quote(wrapperHashes[tool])} ] && rm -f -- "$HOME/bin/${tool}"`);
        if (recovered) await observe(`rm -f -- ${['enabled', 'mode', 'count', 'paused', 'release', 'native.before'].map(name => quote(control + '/' + name)).join(' ')}; rmdir -- ${quote(control)}`);
        if (!recovered) report.limitations.push(`Recovery incomplete; protected original remains at ${control}/native.before. Owned wrappers were fingerprint-checked for cleanup.`);
      }
    }
  }
}
