/** Native Windows IME acceptance for the workbench terminal (R14).
 *
 * Drives nothing on its own: an operator types with the real system IME into a
 * separately built Cliora test instance while this script records, through the
 * instance's WebView2 CDP endpoint,
 *   - composition / key / input event order on the terminal helper textarea,
 *   - the textarea's screen rectangle,
 *   - every write_workbench_session payload (pass-through, nothing is mocked),
 * and, through a Win32 sampler, the top-level windows that appear while composing
 * (the system candidate window). A scenario passes only when the bytes sent equal
 * the expected text exactly once and a candidate window was seen next to the input
 * cell. Synthetic events are never recorded as native evidence.
 *
 * What the test instance does and does not separate (read before running):
 *   Separate, because they derive from the bundle identifier (com.cliora.imetest):
 *     - app data and the SQLite database (%APPDATA%\com.cliora.imetest\cliora.db),
 *     - the WebView2 profile (%LOCALAPPDATA%\com.cliora.imetest\EBWebView),
 *     - the single-instance lock, so input is never handed to the user's running app.
 *   A release build does not register cliora:// at runtime (a Windows debug build would).
 *   NOT separate (same Windows user, same machine):
 *     - the credential store namespace is the fixed service name com.cliora.desktop
 *       (src-tauri/src/credentials.rs), shared with the user's Cliora. The fresh
 *       database references no credential, but adding an account, connection, WebDAV
 *       or API key in the test instance would write into the user's namespace;
 *     - native CLI directories and configs in the user profile (~/.codex, ~/.claude, …),
 *       PATH, Git and SSH configuration. The tools/config/library screens can read and
 *       write them. Use only the workbench, in an empty scratch folder.
 *   It is a separate process and profile, not a sandbox.
 *   Workbench sessions always run an installed CLI (there is no plain shell), so the
 *   receiving session is a real CLI started by the operator in an empty folder. It
 *   uses the user's own CLI login and native directories; never press Enter on IME
 *   test text in an agent prompt.
 *
 * Preconditions (see docs/verification/ui-ux-2026-11-07/ime/manifest.json):
 *   - `node scripts/verify-ime.mjs build` (release, identifier com.cliora.imetest,
 *     private frontend and cargo target under --work, default .vite/ime-native);
 *   - `node scripts/verify-ime.mjs launch` starts it with a WebView2 CDP port
 *     (default 9333) and prints its pid;
 *   - CLIORA_IME_ISOLATED=1, CLIORA_CDP_URL=http://127.0.0.1:<port> and --pid
 *     (or CLIORA_IME_PID). preflight and record refuse to attach unless the CDP
 *     port is opened by a WebView2 browser process whose parent is --pid and whose
 *     profile lies under the test identifier, never com.cliora.desktop.
 *   - a scratch workbench session (an installed CLI started in an empty folder) as receiver.
 *
 * Usage:
 *   node scripts/verify-ime.mjs build [--work <dir>]
 *   node scripts/verify-ime.mjs launch [--work <dir>] [--port 9333]
 *   node scripts/verify-ime.mjs preflight --pid <pid>
 *   node scripts/verify-ime.mjs record --pid <pid> [--only basic,repeat] [--out <dir>]
 *   node scripts/verify-ime.mjs stop --pid <pid>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const SCENARIOS = [
  { id: 'basic', expected: '升级', steps: 'Type the pinyin "shengji" and confirm 升级 with Space.' },
  { id: 'digit', expected: '审计', steps: 'Type "shenji" and pick 审计 with its candidate digit.' },
  { id: 'enter-letters', expected: 'abc', steps: 'Type "abc" in Chinese mode and press Enter to commit the letters.' },
  { id: 'repeat', expected: '哈哈', steps: 'Type "ha", confirm 哈 with Space, then type "ha" and confirm 哈 again.' },
  { id: 'cancel', expected: '', steps: 'Type "shengji" and press Esc until the composition disappears.' },
  { id: 'english-paste-emoji', expected: null, steps: 'Switch to English, type "ok", paste a short text, then insert one emoji with Win+.; enter the expected text when asked.' },
  { id: 'output', expected: '升级', steps: 'Before starting the recording, make the scratch session print continuously (for example in Claude Code type "! ping -n 60 127.0.0.1" and press Enter). Then start the recording, type "shengji" and confirm 升级 with Space while it prints.' },
  { id: 'session-switch', expected: '', steps: 'Start "shengji" in session A, switch to session B (rail tab or Ctrl+Tab) before confirming, then return to A. Nothing may be sent.' },
  { id: 'split-focus', expected: '升级', steps: 'Open a split, click the other pane, then type "shengji" and confirm 升级 there. Only that pane may receive it.' },
  { id: 'leave-return', expected: '升级', steps: 'Go to 首页 and back to 工作台, then type "shengji" and confirm 升级.' },
  { id: 'window-blur', expected: '升级', steps: 'Alt+Tab to another window and back, then type "shengji" and confirm 升级.' },
  { id: 'resize-zoom', expected: '升级', steps: 'Make the window narrower and shorter, press Ctrl+= once, then type "shengji" and confirm 升级. Reset with Ctrl+0.' },
  // Orders only a native trace can show (review of T2-A1); `orders` in the report records them.
  { id: 'commit-then-key', expected: '升级', steps: 'Type "shengji", confirm 升级 with Space and at once type "s", then press Esc until that new composition disappears. A late repeat of 升级 after the "s" key would show as a double send.' },
  { id: 'ctrl-c-after', expected: '升级\u0003', steps: 'Type "shengji", confirm 升级 with Space, then press Ctrl+C once. The interrupt must still reach the shell after the composition.' },
  { id: 'ctrl-c-composing', expected: '\u0003', steps: 'Type "shengji" and, while the pinyin is still shown, press Ctrl+C once. Press Esc until the composition disappears, then press Ctrl+C once more. (A CLI may offer to exit on a second Ctrl+C; do not press a third.)' },
];

/** Event orders the bridge cannot settle without a native trace. Informational, not pass checks. */
export function traceOrders(events) {
  const orders = { nonImeKeyWhileComposing: [], repeatAfterKeydown: 0, endDataWithoutInsert: 0, openWithoutEnd: false };
  let composing = false;
  let ended = null;
  const settle = () => {
    if (ended && ended.data && !ended.inserted && ended.valueLength === 0) orders.endDataWithoutInsert += 1;
    ended = null;
  };
  for (const item of events) {
    if (item.type === 'compositionstart') { settle(); composing = true; }
    else if (item.type === 'compositionend') { composing = false; ended = { data: item.data ?? '', valueLength: item.valueLength ?? null, keyAfter: false, inserted: false }; }
    else if (item.type === 'keydown') {
      if (composing && item.keyCode !== 229) orders.nonImeKeyWhileComposing.push({ key: item.key, keyCode: item.keyCode, isComposing: item.isComposing });
      if (ended) ended.keyAfter = true;
    } else if (item.type === 'input' && item.inputType === 'insertText' && ended) {
      if (ended.keyAfter && item.data === ended.data) orders.repeatAfterKeydown += 1;
      ended.inserted = true;
    }
  }
  settle();
  orders.openWithoutEnd = composing;
  return orders;
}

/**
 * Refuse to attach unless the CDP port belongs to the isolated test instance: a
 * WebView2 browser process (no --type) opened that exact port, its parent is `pid`,
 * and its profile lies under the test identifier. Pure; exported for the contract test.
 */
export function checkIsolation({ pid, port, identifier, processes }) {
  const problems = [];
  const lower = (value) => String(value ?? '').toLowerCase();
  if (!identifier || lower(identifier) === 'com.cliora.desktop') problems.push(`Identifier ${identifier || '(empty)'} is the user app's identifier.`);
  const app = processes.find((item) => item.ProcessId === pid);
  if (!app) problems.push(`No process with pid ${pid}.`);
  else if (!/^cliora/i.test(app.Name ?? '')) problems.push(`Process ${pid} is ${app.Name}, not a Cliora executable.`);
  const portOf = (line) => /--remote-debugging-port=(\d+)/.exec(line ?? '')?.[1];
  const browsers = processes.filter((item) => /msedgewebview2/i.test(item.Name ?? '') && !/--type=/.test(item.CommandLine ?? '') && portOf(item.CommandLine) === String(port));
  if (!browsers.length) problems.push(`No WebView2 browser process opened CDP port ${port}.`);
  for (const browser of browsers) {
    if (browser.ParentProcessId !== pid) problems.push(`CDP port ${port} is opened by WebView2 ${browser.ProcessId} under process ${browser.ParentProcessId}, not ${pid}.`);
    const profile = lower(/--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(browser.CommandLine ?? '')?.slice(1).find(Boolean));
    if (!profile) problems.push(`WebView2 ${browser.ProcessId} has no explicit profile.`);
    else if (profile.includes('com.cliora.desktop')) problems.push(`WebView2 ${browser.ProcessId} uses the user's profile ${profile}.`);
    else if (!profile.replace(/\//g, '\\').includes(`\\${lower(identifier)}\\`)) problems.push(`WebView2 ${browser.ProcessId} profile ${profile} is not under ${identifier}.`);
  }
  return problems;
}

function listProcesses() {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'cliora*' -or $_.Name -eq 'msedgewebview2.exe' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Failed: process list ${result.stderr?.trim() || result.status}`);
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Pure evaluation of one recorded scenario; exported for the contract test. */
export function summarizeScenario(scenario, record) {
  const sent = record.writes.map((item) => item.text).join('');
  const sessions = [...new Set(record.writes.map((item) => item.sessionId))];
  const anchors = record.events.filter((item) => item.type === 'compositionstart' || item.type === 'compositionupdate').map((item) => item.screenRect).filter(Boolean);
  const candidates = record.candidates ?? [];
  const near = (window, anchor) => {
    const dx = Math.max(anchor.left - window.right, window.left - anchor.right, 0);
    const dy = Math.max(anchor.top - window.bottom, window.top - anchor.bottom, 0);
    return Math.hypot(dx, dy) <= 160;
  };
  const atOrigin = candidates.filter((window) => window.left <= 8 && window.top <= 8);
  const placed = candidates.filter((window) => anchors.some((anchor) => near(window, anchor)));
  const checks = [];
  if (scenario.expected !== null && scenario.expected !== undefined) checks.push({ name: 'bytes sent exactly once', ok: sent === scenario.expected, detail: { expected: scenario.expected, sent } });
  checks.push({ name: 'one receiving session', ok: sessions.length <= 1, detail: sessions });
  const composed = record.events.some((item) => item.type === 'compositionstart');
  if (composed) {
    checks.push({ name: 'candidate window observed', ok: candidates.length > 0, detail: candidates.length });
    checks.push({ name: 'candidate window next to the input cell', ok: placed.length > 0 && atOrigin.length === 0, detail: { placed: placed.length, atOrigin: atOrigin.length } });
  }
  return { id: scenario.id, sent, sessions, writes: record.writes.length, checks, orders: traceOrders(record.events), ok: checks.every((item) => item.ok) };
}

// Win32 sampler: visible top-level windows with class, process and rect, plus the
// isolated app's client origin. Per-monitor DPI aware so coordinates are physical.
const SAMPLER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class ImeWindows {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Pt p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  public struct Rect { public int L, T, R, B; }
  public struct Pt { public int X, Y; }
  static Dictionary<uint, string> names = new Dictionary<uint, string>();
  static string Name(uint pid) {
    string n; if (names.TryGetValue(pid, out n)) return n;
    try { n = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { n = "?"; }
    names[pid] = n; return n;
  }
  static string Q(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  public static string Snap(uint app) {
    var sb = new StringBuilder("{\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ",\"fg\":" + GetForegroundWindow().ToInt64() + ",\"w\":[");
    bool first = true; string client = "null";
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      Rect r; GetWindowRect(h, out r);
      if (r.R - r.L <= 0 || r.B - r.T <= 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (pid == app && client == "null") {
        Rect cr; GetClientRect(h, out cr); var p = new Pt(); ClientToScreen(h, ref p);
        client = "{\"left\":" + p.X + ",\"top\":" + p.Y + ",\"width\":" + cr.R + ",\"height\":" + cr.B + "}";
      }
      if (!first) sb.Append(','); first = false;
      sb.Append("{\"h\":" + h.ToInt64() + ",\"cls\":" + Q(c.ToString()) + ",\"proc\":" + Q(Name(pid)) + ",\"pid\":" + pid + ",\"left\":" + r.L + ",\"top\":" + r.T + ",\"right\":" + r.R + ",\"bottom\":" + r.B + "}");
      return true;
    }, IntPtr.Zero);
    return sb.Append("],\"client\":" + client + "}").ToString();
  }
}
'@
[ImeWindows]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
while ($true) { [Console]::Out.WriteLine([ImeWindows]::Snap([uint32]$args[0])); [Console]::Out.Flush(); Start-Sleep -Milliseconds 100 }
`;

// Installed in the isolated page. Records events and pass-through IPC writes only.
const PROBE = String.raw`(() => {
  if (window.__clioraImeProbe) return window.__clioraImeProbe.status();
  const events = [], writes = [];
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    return { left: box.left * ratio, top: box.top * ratio, right: box.right * ratio, bottom: box.bottom * ratio, css: { left: box.left, top: box.top, width: box.width, height: box.height }, ratio };
  };
  const record = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('xterm-helper-textarea')) return;
    events.push({
      t: performance.now(), type: event.type, key: event.key, keyCode: event.keyCode, isComposing: event.isComposing,
      inputType: event.inputType, data: event.data ?? null, valueLength: target.value.length,
      pane: target.closest('[data-pane-session]')?.getAttribute('data-pane-session') ?? null,
      rect: rect(target), style: { left: target.style.left, top: target.style.top, width: target.style.width, height: target.style.height },
    });
  };
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'keydown', 'keyup', 'beforeinput', 'input', 'focus', 'blur']) document.addEventListener(type, record, true);
  const internals = window.__TAURI_INTERNALS__;
  const invoke = internals.invoke.bind(internals);
  internals.invoke = (command, args, options) => {
    if (command === 'write_workbench_session' && args && typeof args.dataBase64 === 'string') {
      const raw = Uint8Array.from(atob(args.dataBase64), (c) => c.charCodeAt(0));
      writes.push({ t: performance.now(), sessionId: args.sessionId, text: new TextDecoder().decode(raw) });
    }
    return invoke(command, args, options);
  };
  const status = () => ({
    bridge: [...document.querySelectorAll('[data-ime-bridge]')].map((node) => node.getAttribute('data-ime-bridge')),
    terminals: document.querySelectorAll('.xterm-helper-textarea').length,
    userAgent: navigator.userAgent, ratio: window.devicePixelRatio, origin: location.origin,
  });
  window.__clioraImeProbe = { events, writes, status, drain: () => ({ events: events.splice(0), writes: writes.splice(0) }) };
  return status();
})()`;

async function connect(url) {
  const list = await (await fetch(`${url}/json`, { signal: AbortSignal.timeout(10000) })).json();
  const page = list.find((item) => item.type === 'page' && /^https?:\/\/tauri\.localhost\//.test(item.url ?? ''));
  if (!page) throw new Error(`Failed: no Cliora release page on the CDP endpoint (pages: ${JSON.stringify(list.filter((item) => item.type === 'page').map((item) => item.url))})`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
  };
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = () => fail(new Error('Failed: CDP connection')); });
  const send = (method, params = {}) => new Promise((done, fail) => { const call = ++id; pending.set(call, { resolve: done, reject: fail }); ws.send(JSON.stringify({ id: call, method, params })); });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Failed: page evaluation ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  return { evaluate, close: () => ws.close() };
}

export function startSampler(pid) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${SAMPLER} } ${pid}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = [];
  let buffer = '';
  child.stdout.on('data', (bytes) => {
    buffer += bytes;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('{')) try { samples.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  return { samples, stop: () => child.kill(), error: () => stderr.trim() };
}

/** Windows that were not present before the scenario and are not the app itself. */
function newWindows(baseline, samples, pid) {
  const known = new Set(baseline.w.map((item) => item.h));
  const seen = new Map();
  for (const sample of samples) {
    for (const item of sample.w) {
      if (known.has(item.h) || item.pid === pid) continue;
      if (item.right - item.left > 900 || item.bottom - item.top > 900) continue;
      // 1×1 helper windows are not candidate lists.
      if (item.right - item.left < 16 || item.bottom - item.top < 16) continue;
      seen.set(item.h, item);
    }
  }
  return [...seen.values()];
}

export const IDENTIFIER = 'com.cliora.imetest';

/** Tauri config overlay for the test build; the frontend and cargo output stay under `work`. */
export function testBuildConfig(work, root) {
  // An absolute Windows path would parse as a URL with scheme "c:"; Tauri resolves
  // frontendDist relative to src-tauri, so pass it that way.
  const dist = relative(resolve(root, 'src-tauri'), resolve(work, 'dist')).replace(/\\/g, '/');
  // Tauri passes the script to the shell as is; quotes would reach vite literally.
  const outDir = relative(root, resolve(work, 'dist')).replace(/\\/g, '/');
  if (/\s/.test(outDir)) throw new Error(`Failed: --work must not contain spaces (${outDir})`);
  return {
    identifier: IDENTIFIER,
    productName: 'Cliora IME Test',
    build: { beforeBuildCommand: { script: `npx vite build --outDir ${outDir} --emptyOutDir`, cwd: root.replace(/\\/g, '/') }, frontendDist: dist },
    bundle: { createUpdaterArtifacts: false },
    app: { windows: [{ title: 'Cliora IME Test (isolated)', width: 1160, height: 780, minWidth: 720, minHeight: 560, backgroundColor: '#f5f5f1', titleBarStyle: 'Overlay', hiddenTitle: true }] },
  };
}

const builtExecutable = (work) => ['cliora.exe', 'Cliora IME Test.exe'].map((name) => resolve(work, 'target', 'release', name)).find((file) => existsSync(file));

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const mode = args[0] ?? 'preflight';
  const root = resolve(import.meta.dirname, '..');
  const work = resolve(option('--work', resolve(root, '.vite', 'ime-native')));
  if (process.platform !== 'win32') { console.error('Failed: native IME acceptance needs Windows.'); process.exit(2); }

  if (mode === 'build') {
    mkdirSync(work, { recursive: true });
    const config = resolve(work, 'tauri.imetest.json');
    writeFileSync(config, JSON.stringify(testBuildConfig(work, root), null, 2) + '\n');
    // Release only: a Windows debug build registers cliora:// at runtime.
    const result = spawnSync('npx', ['tauri', 'build', '--no-bundle', '--config', `"${config}"`], { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: resolve(work, 'target') } });
    const exe = builtExecutable(work);
    if (result.status !== 0 || !exe) { console.error(`Failed: tauri build exited ${result.status}${exe ? '' : '; no executable under target/release'}`); process.exit(1); }
    console.log(`built: ${exe}`);
    process.exit(0);
  }

  if (mode === 'launch') {
    const exe = builtExecutable(work);
    if (!exe) { console.error(`Failed: no test executable under ${work}; run build first.`); process.exit(2); }
    const port = Number(option('--port', '9333'));
    const busy = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
    if (busy) { console.error(`Failed: something already answers on port ${port}; choose another --port.`); process.exit(2); }
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
    child.unref();
    console.log(`launched ${exe}\npid ${child.pid}\n$env:CLIORA_IME_ISOLATED='1'; $env:CLIORA_CDP_URL='http://127.0.0.1:${port}'; $env:CLIORA_IME_PID='${child.pid}'`);
    process.exit(0);
  }

  const pid = Number(option('--pid', process.env.CLIORA_IME_PID ?? '0'));
  const cdp = process.env.CLIORA_CDP_URL;
  const ownership = () => {
    const url = new URL(cdp);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return [`CDP endpoint ${cdp} is not local.`];
    return checkIsolation({ pid, port: Number(url.port), identifier: IDENTIFIER, processes: listProcesses() });
  };

  if (mode === 'stop') {
    if (!Number.isInteger(pid) || pid <= 0 || !cdp) { console.error('Failed: pass --pid and CLIORA_CDP_URL of the test instance.'); process.exit(2); }
    const problems = ownership();
    if (problems.length) { console.error(`Refused: ${problems.join(' ')}`); process.exit(2); }
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    console.log(result.status === 0 ? `stopped ${pid} and its child processes` : `Failed: taskkill exited ${result.status}`);
    process.exit(result.status === 0 ? 0 : 1);
  }

  const out = resolve(option('--out', 'docs/verification/ui-ux-2026-11-07/ime/native'));
  const report = { schemaVersion: 1, synthetic: false, mode, capturedAt: new Date().toISOString(), status: 'not_verified', environment: {}, scenarios: [], limitations: [] };
  const finish = (code) => {
    mkdirSync(out, { recursive: true });
    const file = resolve(out, `ime-native-${mode}-${report.capturedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(`${report.status}: ${file}`);
    process.exit(code);
  };
  if (process.env.CLIORA_IME_ISOLATED !== '1') { report.limitations.push('Set CLIORA_IME_ISOLATED=1 only for the separately built test instance; the user app is never driven.'); finish(2); }
  if (!cdp) { report.limitations.push('Set CLIORA_CDP_URL to the test instance WebView2 endpoint.'); finish(2); }
  if (!Number.isInteger(pid) || pid <= 0) { report.limitations.push('Pass --pid or CLIORA_IME_PID for the test cliora.exe.'); finish(2); }
  // Nothing is installed in a page before the endpoint is proven to be the test instance's.
  const problems = ownership();
  if (problems.length) { report.status = 'refused'; report.limitations.push(...problems); finish(2); }
  const page = await connect(cdp);
  report.environment = { ...(await page.evaluate(PROBE)), pid, cdp, identifier: IDENTIFIER };
  if (!report.environment.bridge.length || report.environment.bridge.some((value) => value !== 'ready')) report.limitations.push(`Terminal IME bridge is not ready: ${JSON.stringify(report.environment.bridge)}.`);
  const sampler = startSampler(pid);
  await new Promise((done) => setTimeout(done, 1500));
  if (!sampler.samples.length) report.limitations.push(`Window sampler produced nothing: ${sampler.error() || 'no output'}.`);
  else if (!sampler.samples.at(-1).client) report.limitations.push('The isolated process has no visible window; check --pid.');
  if (mode === 'preflight') {
    report.status = report.limitations.length ? 'not_verified' : 'preflight_ready';
    sampler.stop(); page.close(); finish(report.limitations.length ? 1 : 0);
  }
  const only = option('--only', '');
  const chosen = SCENARIOS.filter((item) => !only || only.split(',').includes(item.id));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Use the scratch session only. Do not type private text and never press Enter on test text in an agent prompt. Press Enter in this console to start and again to finish each scenario.');
  for (const scenario of chosen) {
    let expected = scenario.expected;
    await prompt.question(`\n[${scenario.id}] ${scenario.steps}\nFocus the terminal, then press Enter here to start recording… `);
    await page.evaluate('window.__clioraImeProbe.drain()');
    const baseline = sampler.samples.at(-1);
    const from = sampler.samples.length;
    await prompt.question('Recording. Perform the steps in Cliora, then press Enter here… ');
    const record = await page.evaluate('window.__clioraImeProbe.drain()');
    const samples = sampler.samples.slice(from);
    const client = samples.find((item) => item.client)?.client ?? baseline?.client ?? null;
    for (const item of record.events) {
      if (client && item.rect) item.screenRect = { left: client.left + item.rect.left, top: client.top + item.rect.top, right: client.left + item.rect.right, bottom: client.top + item.rect.bottom };
    }
    if (expected === null) expected = await prompt.question('Exact text you expected the terminal to receive: ');
    const candidates = baseline ? newWindows(baseline, samples, pid) : [];
    const summary = summarizeScenario({ ...scenario, expected }, { ...record, candidates });
    const note = await prompt.question('Did the candidate window stay at the input position? (y/n, optional note): ');
    summary.checks.push({ name: 'operator saw the candidate at the input position', ok: /^y/i.test(note.trim()), detail: note.trim() });
    summary.ok = summary.checks.every((item) => item.ok);
    report.scenarios.push({ ...summary, client, candidates, events: record.events, writes: record.writes });
    console.log(`${summary.ok ? 'PASS' : 'FAIL'} ${scenario.id}: sent ${JSON.stringify(summary.sent)}; ${summary.checks.filter((item) => !item.ok).map((item) => item.name).join(', ') || 'all checks passed'}`);
  }
  prompt.close();
  sampler.stop();
  page.close();
  const complete = chosen.length === SCENARIOS.length;
  if (!complete) report.limitations.push('Only part of the scenario set was recorded.');
  report.limitations.push('Records one machine, one IME version and one display configuration; it is not a cross-platform result.');
  report.status = complete && report.scenarios.every((item) => item.ok) && report.limitations.length === 1 ? 'native_verified' : 'not_verified';
  finish(report.status === 'native_verified' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error?.message?.startsWith('Failed:') ? error.message : `Failed: ${error?.message ?? error}`); process.exit(1); });
}
