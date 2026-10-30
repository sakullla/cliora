/** Drive an explicitly isolated native Cliora over its WebView2 CDP endpoint.
 * No IPC is mocked. The create/resume phases deliberately span an app restart.
 * A missing environment or an unfinished phase is never reported as acceptance.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const phase = option('--phase', 'preflight');
const configPath = option('--config', process.env.CLIORA_REMOTE_TEST_CONFIG);
const output = path.resolve(option('--out', 'docs/verification/remote-workflow/native'));
const report = { schemaVersion: 1, synthetic: false, phase, capturedAt: new Date().toISOString(), status: 'not_verified', checks: [], measurements: [], limitations: [] };
let socket;
const pending = new Map();
let sequence = 0;
let config;
const hash = value => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const remoteInspect = async command => {
  // This is an independent observer, never a substitute for product IPC. Use
  // exactly the explicitly configured key/config and strict host verification.
  const result = await execFileAsync('ssh', ['-T', '-F', config.target.sshConfig, '-i', config.target.identityFile,
    '-p', String(config.target.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', `${config.target.user}@${config.target.host}`,
    `export PATH="$HOME/.local/bin:$HOME/bin:$PATH"; ${command}`], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return result.stdout;
};
const muxNames = async () => {
  const stdout = await remoteInspect(`command -v tmux >/dev/null 2>&1 || exit 42; names=$(LC_ALL=C tmux -u list-sessions -F '#{session_name}' 2>&1); rc=$?; if [ "$rc" -eq 0 ]; then printf '%s\\n' "$names"; else case "$names" in *'no server running'*|*'no sessions'*) ;; *) printf '%s' "$names" >&2; exit 46 ;; esac; fi`);
  return stdout.trim().split(/\r?\n/).filter(Boolean);
};
const captureRemote = async remoteId => {
  requireThat(/^cliora-[a-zA-Z0-9_-]+$/.test(remoteId), 'Invalid checkpoint remote identity.');
  return remoteInspect(`command -v tmux >/dev/null 2>&1 || exit 42; tmux -u capture-pane -p -J -t ${shellQuote(`=${remoteId}:`)}`);
};
const awaitRemoteInput = async (remoteId, expected) => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if ((await captureRemote(remoteId)).includes(expected)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Failed: expected input absent from actual tmux screen.');
};
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const check = (name, condition) => { requireThat(condition, `Failed: ${name}`); report.checks.push(name); };
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  requireThat(!result.exceptionDetails, 'Native invocation failed; inspect the isolated app for diagnostics.');
  return result.result.value;
};
const invoke = async (command, data = {}) => {
  const start = performance.now();
  const result = await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(data)})`);
  report.measurements.push({ operation: command, elapsedMs: performance.now() - start });
  return result;
};
const checkpointPath = path.join(output, 'checkpoint.json');
const readCheckpoint = async () => {
  const value = JSON.parse(await readFile(checkpointPath, 'utf8'));
  requireThat(value.appIdentifier === config.appIdentifier && value.testRunId === config.testRunId, 'Checkpoint belongs to another test environment.');
  return value;
};
const readReplay = async id => {
  const replay = await invoke('replay_workbench_session', { sessionId: id });
  return Buffer.from(typeof replay === 'string' ? replay : replay.dataBase64, 'base64').toString('utf8');
};
const awaitOutput = async (id, text) => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if ((await readReplay(id)).includes(text)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Expected test output was not observed in its session.');
};
const awaitConnected = async (id, remoteId) => {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const current = (await invoke('list_workbench_sessions')).find(item => item.id === id && item.remoteSessionId === remoteId);
    if (current?.running && current.connectionState === 'connected') return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Failed: current native attachment did not report remote readiness.');
};
const awaitUi = async (expression, message) => {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Failed: ${message}`);
};
const navigate = async pageNumber => {
  const selector = `#main-navigation button[aria-keyshortcuts$="+${pageNumber}"]`;
  await awaitUi(`!!document.querySelector(${JSON.stringify(selector)})`, 'native page navigation available');
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await awaitUi(`!!document.querySelector('.shell[data-page="${pageNumber === 1 ? 'home' : 'sessions'}"]')`, 'native page navigation completed');
};
const prepareWorkbench = async () => {
  // Refresh bootstrap/host data after native configuration changes. Select the
  // host through the real UI so remote terminals receive usable layout space.
  await send('Page.enable');
  let finishLoad;
  const loaded = new Promise(resolve => { finishLoad = resolve; });
  const loadTimer = setTimeout(() => finishLoad(false), 10000);
  const onLoad = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') finishLoad(true); };
  socket.addEventListener('message', onLoad);
  try {
    await send('Page.reload', { ignoreCache: true });
    requireThat(await loaded, 'Native frontend reload timed out.');
  } finally {
    clearTimeout(loadTimer);
    socket.removeEventListener('message', onLoad);
  }
  await awaitUi(`!!document.querySelector('.sidebar-host .host-switcher-trigger')`, 'native host switcher available');
  await evaluate(`document.querySelector('.sidebar-host .host-switcher-trigger').click()`);
  const target = `[...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.querySelector('strong')?.textContent === 'Isolated SSH acceptance')`;
  await awaitUi(`!!(${target})`, 'isolated SSH host available in native UI');
  await evaluate(`(${target}).click()`);
  await awaitUi(`document.querySelector('.sidebar-host .host-switcher-trigger strong')?.textContent === 'Isolated SSH acceptance'`, 'isolated SSH host selected in native UI');
  await navigate(1);
};
const showWorkbench = async id => {
  // Visiting the page refreshes its product session list; no IPC or terminal
  // protocol response is mocked or synthesized by this runner.
  await navigate(2);
  if (!id) return;
  const tab = `[role="tab"][data-session-id=${JSON.stringify(id)}]`;
  await awaitUi(`!!document.querySelector(${JSON.stringify(tab)})`, 'launched session listed in native workbench');
  await evaluate(`document.querySelector(${JSON.stringify(tab)}).click()`);
  const terminal = `[data-pane-session=${JSON.stringify(id)}] .xterm`;
  await awaitUi(`(() => { const terminal = document.querySelector(${JSON.stringify(terminal)}); return !!terminal && terminal.clientWidth > 0 && terminal.clientHeight > 0; })()`, 'real terminal mounted with layout space');
};

try {
  requireThat(['preflight', 'create', 'resume', 'measure', 'directories', 'cleanup'].includes(phase), 'Unknown phase.');
  requireThat(configPath, 'Set CLIORA_REMOTE_TEST_CONFIG or --config to an explicitly isolated test configuration.');
  config = JSON.parse(await readFile(path.resolve(configPath), 'utf8'));
  requireThat(config.isolated === true, 'Configuration must acknowledge an isolated app and remote test directory.');
  requireThat(/^dev\.cliora\.remoteacceptance(?:\.[a-z0-9]+)*$/.test(config.appIdentifier ?? ''), 'Use a dedicated dev.cliora.remoteacceptance app identifier.');
  requireThat(/^[a-z0-9-]{1,40}$/.test(config.testRunId ?? ''), 'testRunId must be a portable test identity.');
  requireThat(typeof config.toolId === 'string' && config.toolId.length > 0, 'Specify the installed CLI adapter under test.');
  requireThat(config.target?.authMethod === 'key' && config.target.identityFile && config.target.sshConfig, 'Supply external key and SSH config paths; this runner never accepts raw credentials.');
  requireThat(!config.target.password && !config.target.privateKey, 'Raw credentials are not accepted.');
  requireThat(typeof config.testDirectory === 'string' && config.testDirectory.startsWith('/') && config.testDirectory.includes('cliora-remote-test'), 'testDirectory must be a dedicated cliora-remote-test POSIX directory.');
  requireThat(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(config.cdpUrl ?? ''), 'A local native CDP endpoint is required.');
  const pages = await (await fetch(`${config.cdpUrl}/json`, { signal: AbortSignal.timeout(10000) })).json();
  const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  requireThat(page, 'The native CDP endpoint has no page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(new Error(`CDP error: ${message.error.code}`)) : call.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native CDP connection timed out.')), 10000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Native CDP unavailable.')); };
  });
  const identifier = await invoke('plugin:app|identifier');
  check('isolated native application identifier', identifier === config.appIdentifier);
  report.appIdentifier = identifier;
  report.targetFingerprint = hash(`${config.target.user}@${config.target.host}:${config.target.port}`);
  report.toolId = config.toolId;
  const targetId = `remote-acceptance-${config.testRunId}`;
  await mkdir(output, { recursive: true });
  if (phase === 'preflight') {
    await invoke('set_remote_ssh_enabled', { enabled: true });
    const result = await invoke('test_remote_target', { target: { ...config.target, id: targetId, name: 'Isolated SSH acceptance', enabled: true, createdAt: 0, updatedAt: 0, defaultPath: config.testDirectory }, password: null });
    check('strict native SSH connectivity', result.reachable === true);
    const tools = await invoke('list_cli_adapters');
    check('registered CLI capability', tools.registered.some(item => item.id === config.toolId && item.launch?.state !== 'unsupported'));
    report.status = 'preflight_passed';
    report.limitations.push('Preflight verifies connectivity only, not independent sessions or application restart.');
  } else if (phase === 'create') {
    requireThat(config.inputProbe?.input && config.inputProbe?.expected, 'Provide a harmless explicit inputProbe for the CLI fixture; no inference prompt is generated automatically.');
    requireThat(typeof config.readyOutput === 'string' && config.readyOutput.length > 0, 'Supply readyOutput from the actual CLI startup screen.');
    await invoke('set_remote_ssh_enabled', { enabled: true });
    const target = await invoke('save_remote_target', { target: { ...config.target, id: targetId, name: 'Isolated SSH acceptance', enabled: true, createdAt: 0, updatedAt: 0, defaultPath: config.testDirectory }, password: null });
    const project = await invoke('save_remote_project', { project: { id: `remote-acceptance-project-${config.testRunId}`, targetId: target.id, name: 'Independent sessions acceptance', path: config.testDirectory, preferredTool: config.toolId, updatedAt: 0 } });
    await invoke('set_preferred_terminal', { terminal: 'workbench' });
    await prepareWorkbench();
    const sessions = [];
    for (let index = 0; index < 3; index++) {
      await navigate(1);
      const opened = await invoke('launch_cli', { request: { toolId: config.toolId, projectId: `remote:${project.id}`, sessionId: null, remoteIntent: { kind: 'new' }, mode: 'normal', resumeLatest: false } });
      requireThat(opened.sessionId && opened.remoteSessionId, 'Native launch returned no session identity.');
      sessions.push({ localId: opened.sessionId, remoteId: opened.remoteSessionId });
      await writeFile(checkpointPath, JSON.stringify({ schemaVersion: 1, appIdentifier: identifier, testRunId: config.testRunId, projectId: project.id, targetId, sessions, createdAt: new Date().toISOString() }, null, 2));
      await showWorkbench(opened.sessionId);
      await awaitOutput(opened.sessionId, config.readyOutput);
      report.checks.push(`actual CLI ready output observed for launch ${index + 1}`);
    }
    report.observations = { requestedSessions: sessions.length, distinctRemoteIdentities: new Set(sessions.map(item => item.remoteId)).size };
    check('three actual remote identities differ', report.observations.distinctRemoteIdentities === 3);
    const index = await invoke('list_remote_sessions');
    check('same-directory identities all persisted', sessions.every(item => index.some(entry => entry.remoteSessionId === item.remoteId && entry.projectId === project.id)));
    const actualNames = await muxNames();
    check('independent SSH observer sees all three tmux sessions', sessions.every(item => actualNames.includes(item.remoteId)));
    await invoke('write_workbench_session', { sessionId: sessions[1].localId, dataBase64: Buffer.from(config.inputProbe.input).toString('base64') });
    await awaitRemoteInput(sessions[1].remoteId, config.inputProbe.expected);
    check('input remains in selected remote process', !(await captureRemote(sessions[0].remoteId)).includes(config.inputProbe.expected) && !(await captureRemote(sessions[2].remoteId)).includes(config.inputProbe.expected));
    report.limitations.push('Independent screen/absence observation requires tmux; screen fallback needs separate native evidence. Raw ANSI replay is not treated as a rendered input oracle.');
    report.status = 'restart_pending';
    report.limitations.push('Exit and restart the isolated desktop, then run --phase resume. This phase is not complete acceptance.');
  } else if (phase === 'resume') {
    requireThat(typeof config.readyOutput === 'string' && config.readyOutput.length > 0, 'Supply readyOutput from the actual CLI startup screen.');
    const checkpoint = await readCheckpoint();
    const index = await invoke('list_remote_sessions');
    check('restart retained all indexed identities', checkpoint.sessions.every(item => index.some(entry => entry.remoteSessionId === item.remoteId && entry.projectId === checkpoint.projectId)));
    let listed = await invoke('list_workbench_sessions');
    check('desktop local attachments changed after restart', !listed.some(item => checkpoint.sessions.some(saved => saved.localId === item.id)));
    await prepareWorkbench();
    await showWorkbench();
    // Exercise the product's automatic restoration. Manually launching missing
    // rows here would hide a broken workbench restore and race its requests.
    const restoreDeadline = performance.now() + 30000;
    do {
      listed = await invoke('list_workbench_sessions');
      if (checkpoint.sessions.every(item => listed.some(entry => entry.remoteSessionId === item.remoteId && entry.projectId === `remote:${checkpoint.projectId}`))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (performance.now() < restoreDeadline);
    const resumed = [];
    for (const item of checkpoint.sessions) {
      const session = listed.find(entry => entry.remoteSessionId === item.remoteId && entry.projectId === `remote:${checkpoint.projectId}`);
      check('saved identity automatically restored in native workbench', !!session);
      await showWorkbench(session.id);
      await awaitOutput(session.id, config.readyOutput);
      resumed.push(await awaitConnected(session.id, item.remoteId));
    }
    check('restored exact identities', resumed.every((item, index) => item.remoteSessionId === checkpoint.sessions[index].remoteId));
    check('restored connections report remote readiness', resumed.every(item => item.connectionState === 'connected'));
    await invoke('close_workbench_session', { sessionId: resumed[1].id });
    listed = await invoke('list_workbench_sessions');
    check('ending B leaves A and C connected', [resumed[0], resumed[2]].every(item => listed.some(entry => entry.id === item.id && entry.running)));
    const remaining = await invoke('list_remote_sessions');
    check('only B removed from durable index', !remaining.some(item => item.remoteSessionId === resumed[1].remoteSessionId) && [resumed[0], resumed[2]].every(item => remaining.some(entry => entry.remoteSessionId === item.remoteSessionId)));
    const actualNames = await muxNames();
    check('independent SSH observer confirms B absent and A/C present', !actualNames.includes(resumed[1].remoteSessionId) && [resumed[0], resumed[2]].every(item => actualNames.includes(item.remoteSessionId)));
    report.status = 'session_checks_passed';
    report.limitations.push('This report covers the listed session checks. Network fault, all platform and performance acceptance require their own evidence.');
  } else if (phase === 'directories') {
    // Both targets must reach the same dedicated test filesystem. The key is
    // an independent observer; password IPC uses only the system secret store.
    requireThat(config.passwordTarget?.authMethod === 'password' && config.passwordFile, 'Provide passwordTarget and an external passwordFile for both authentication paths.');
    requireThat(!config.passwordTarget.password && !config.passwordTarget.privateKey, 'Raw credentials are not accepted in passwordTarget.');
    requireThat(config.passwordTarget.host === config.target.host && config.passwordTarget.user === config.target.user, 'Directory targets must use the same isolated host and user.');
    requireThat(config.readyOutput && config.inputProbe?.input, 'Provide the actual harmless CLI fixture and readyOutput.');
    const secretFile = JSON.parse(await readFile(path.resolve(config.passwordFile), 'utf8'));
    requireThat(typeof secretFile.password === 'string' && secretFile.password.length > 0, 'External passwordFile must contain a password field.');
    const root = `${config.testDirectory}/directory-${config.testRunId}`;
    const paths = { empty: `${root}/empty`, denied: `${root}/denied`, readonly: `${root}/readonly`, file: `${root}/file` };
    const leaves = ['key-created', 'password-created'].map(name => `${root}/${name}`);
    const projects = [];
    const sessions = [];
    let fixtureOwned = false;
    const read = (target, parent) => invoke('list_remote_directories', { targetId: target.id, parent, operation: {
      requestId: randomUUID(), cancelToken: randomUUID(), targetId: target.id, targetRevision: target.updatedAt,
      kind: 'read', priority: 'interactive', refresh: true, deadlineUnixMs: Date.now() + 40000,
    } });
    const outcome = (command, data) => evaluate(`(async () => { try { await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(data)}); return {ok:true}; } catch (error) { return {ok:false,stage:error.remote?.stage,reason:error.remote?.reason,outcome:error.remote?.outcome}; } })()`);
    try {
      await invoke('set_remote_ssh_enabled', { enabled: true });
      // mkdir without -p makes a collision a hard failure, never somebody
      // else's directory to clean up.
      await remoteInspect(`mkdir -- ${shellQuote(root)}`);
      fixtureOwned = true;
      await remoteInspect(`mkdir -- ${Object.values(paths).filter(value => value !== paths.file).map(shellQuote).join(' ')} && : > ${shellQuote(paths.file)} && chmod 000 ${shellQuote(paths.denied)} && chmod 500 ${shellQuote(paths.readonly)}`);
      for (const [index, auth] of ['key', 'password'].entries()) {
        const source = auth === 'key' ? config.target : config.passwordTarget;
        const target = await invoke('save_remote_target', { target: { ...source, id: targetId, name: 'Isolated SSH acceptance', enabled: true, createdAt: 0, updatedAt: 0, defaultPath: root }, password: auth === 'password' ? secretFile.password : null });
        const listed = await read(target, root);
        check(`${auth}: real directory listing includes fixture`, listed.parent === root && listed.items.includes(paths.empty) && !listed.truncated);
        const empty = await read(target, paths.empty);
        check(`${auth}: empty directory is a successful empty result`, empty.parent === paths.empty && empty.items.length === 0 && !empty.truncated);
        for (const [parent, stage] of [[`${root}/missing`, 'directory_missing'], [paths.file, 'directory_type'], [paths.denied, 'permission']]) {
          const result = await outcome('list_remote_directories', { targetId, parent });
          check(`${auth}: directory failure preserves ${stage}`, !result.ok && result.stage === stage);
        }
        for (const [path, stage] of [[`${root}/missing/child`, 'directory_missing'], [`${paths.file}/child`, 'directory_type']]) {
          const result = await outcome('create_remote_directory', { targetId, path });
          check(`${auth}: creation failure preserves ${stage}`, !result.ok && result.stage === stage);
        }
        check(`${auth}: missing creation parent was not implicitly created`, (await remoteInspect(`[ ! -e ${shellQuote(`${root}/missing`)} ] && printf yes`)).trim() === 'yes');
        const denied = await outcome('create_remote_directory', { targetId, path: `${paths.readonly}/refused` });
        check(`${auth}: creation denied without losing permission stage`, !denied.ok && denied.stage === 'permission');
        await invoke('create_remote_directory', { targetId, path: leaves[index] });
        const refreshed = await read(target, root);
        check(`${auth}: refresh observes created directory`, refreshed.parent === root && refreshed.items.includes(leaves[index]));
        check(`${auth}: independent SSH observer confirms creation`, (await remoteInspect(`[ -d ${shellQuote(leaves[index])} ] && printf yes`)).trim() === 'yes');
        const project = await invoke('save_remote_project', { project: { id: `directory-project-${config.testRunId}-${auth}`, targetId, name: 'Directory launch acceptance', path: leaves[index], preferredTool: config.toolId, updatedAt: 0 } });
        projects.push(project.id);
        await invoke('set_preferred_terminal', { terminal: 'workbench' });
        await prepareWorkbench();
        const launched = await invoke('launch_cli', { request: { toolId: config.toolId, projectId: `remote:${project.id}`, sessionId: null, remoteIntent: { kind: 'new' }, mode: 'normal', resumeLatest: false } });
        requireThat(launched.sessionId && launched.remoteSessionId, 'Native directory launch returned no identity.');
        sessions.push(launched.sessionId);
        await showWorkbench(launched.sessionId);
        await awaitOutput(launched.sessionId, config.readyOutput);
        await awaitConnected(launched.sessionId, launched.remoteSessionId);
        const cwd = await remoteInspect(`tmux -u display-message -p -t ${shellQuote(`=${launched.remoteSessionId}:`)} '#{pane_current_path}'`);
        check(`${auth}: real CLI starts from the created directory`, cwd.trim() === leaves[index]);
        await invoke('close_workbench_session', { sessionId: launched.sessionId });
        check(`${auth}: created-directory CLI ended`, !(await muxNames()).includes(launched.remoteSessionId));
        sessions.pop();
      }
      const bad = await outcome('test_remote_target', { target: { ...config.passwordTarget, id: `${targetId}-invalid`, name: 'Invalid password fixture', enabled: true, createdAt: 0, updatedAt: 0 }, password: `${secretFile.password}-invalid` });
      check('password: authentication failure remains distinct', !bad.ok && bad.stage === 'authentication');
      report.status = 'directory_checks_passed';
    } finally {
      // Cleanup is explicit and limited to this run's known leaves. If a CLI
      // writes unexpected files, rmdir fails and the report remains unverified.
      for (const id of sessions) await invoke('close_workbench_session', { sessionId: id });
      for (const id of projects) await invoke('delete_remote_project', { id });
      await invoke('delete_remote_target', { id: targetId });
      if (fixtureOwned) await remoteInspect(`for entry in ${[paths.denied, paths.readonly].map(shellQuote).join(' ')}; do if [ -d "$entry" ]; then chmod 700 "$entry" || exit 49; fi; done; rm -f -- ${shellQuote(paths.file)} || exit 49; for entry in ${[...leaves, paths.empty, paths.denied, paths.readonly].map(shellQuote).join(' ')}; do if [ -d "$entry" ]; then rmdir -- "$entry" || exit 49; fi; done; rmdir -- ${shellQuote(root)} || exit 49`);
      report.cleanupComplete = true;
    }
  } else if (phase === 'measure') {
    // Baseline builds may fail the independent-session scenario. Read timings
    // must remain runnable without a successful lifecycle checkpoint.
    await invoke('set_remote_ssh_enabled', { enabled: true });
    const target = await invoke('save_remote_target', { target: { ...config.target, id: targetId, name: 'Isolated SSH acceptance', enabled: true, createdAt: 0, updatedAt: 0, defaultPath: config.testDirectory }, password: null });
    const project = await invoke('save_remote_project', { project: { id: `remote-acceptance-project-${config.testRunId}`, targetId: target.id, name: 'Remote measurement dataset', path: config.testDirectory, preferredTool: config.toolId, updatedAt: 0 } });
    for (let sample = 0; sample < 3; sample++) {
      await invoke('list_remote_directories', { targetId, parent: config.testDirectory });
      await invoke('probe_remote_clis', { targetId, toolIds: [config.toolId] });
      await invoke('get_remote_tool_store', { targetId, toolId: config.toolId, scope: 'global', projectPath: null });
      await invoke('list_remote_sessions');
    }
    report.sampleProject = project.id;
    report.status = 'measurement_complete';
    report.limitations.push('Elapsed IPC samples alone do not establish CPU/memory or network connection-count improvement; compare identical old/new environments.');
  } else {
    const checkpoint = await readCheckpoint();
    const listed = await invoke('list_workbench_sessions');
    for (const item of listed.filter(entry => checkpoint.sessions.some(saved => saved.remoteId === entry.remoteSessionId))) {
      await invoke('close_workbench_session', { sessionId: item.id });
    }
    await invoke('delete_remote_project', { id: checkpoint.projectId });
    await invoke('delete_remote_target', { id: checkpoint.targetId });
    report.status = 'cleanup_complete';
  }
  console.log(`${phase}: ${report.status}`);
  // Incomplete lifecycle phases cannot accidentally become a green acceptance check.
  if (phase === 'create') process.exitCode = 2;
} catch (error) {
  report.status = 'not_verified';
  // Do not serialize arbitrary native errors, input probes or connection config.
  report.failure = error?.message?.startsWith('Failed:') || error?.message?.startsWith('Set CLIORA_') ? error.message : 'Precondition or native verification failed; inspect the isolated environment.';
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Verifier finished.')); }
  pending.clear();
  socket?.close();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `${phase}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
}
