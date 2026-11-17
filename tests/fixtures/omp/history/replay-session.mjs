#!/usr/bin/env node
/**
 * Replay the real OMP session evidence without a paid provider.
 *
 * The tool uses an isolated HOME and a local OpenAI-compatible SSE endpoint:
 * real `omp -p` writes a session, then `omp --resume <id>` appends to it. It
 * prints the generated slot/header/usage values and keeps the temporary tree so
 * the observation can be inspected. It never reads or writes the user's own
 * `~/.omp` or `~/.bun`, and it never installs OMP.
 *
 * Usage:
 *   node tests/fixtures/omp/history/replay-session.mjs --omp <path-to-omp>
 *     [--output <raw-session.jsonl>] [--keep]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--omp') options.omp = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--keep') options.keep = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function isolatedEnvironment(root) {
  const home = path.join(root, 'home');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    NO_COLOR: '1',
    CI: '1',
  };
}

function startEndpoint(root) {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      fs.appendFileSync(path.join(root, 'requests.log'), `${request.method} ${request.url}\n${body}\n---\n`);
      if (!request.url.endsWith('/chat/completions')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({
        id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
      })}\n\n`;
      response.write(chunk({ role: 'assistant' }, null));
      response.write(chunk({ content: 'Fixture reply from the local replay endpoint.' }, null));
      response.write(chunk({}, 'stop', { usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540, prompt_tokens_details: { cached_tokens: 200 } } }));
      response.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function sessionFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
    }
  }
  await walk(path.join(root, 'home/.omp/agent/sessions'));
  return files.sort();
}

function titleSlot(bytes) {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0 || newline !== 255) throw new Error('the first line is not a 256-byte title slot');
  return { bytes: newline + 1, slot: JSON.parse(bytes.toString('utf8', 0, newline)), body: bytes.subarray(newline + 1).toString('utf8') };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('node tests/fixtures/omp/history/replay-session.mjs --omp <omp executable> [--output <raw-session.jsonl>] [--keep]');
    return 0;
  }
  if (!options.omp) throw new Error('--omp <path-to-omp> is required');
  if (!fs.existsSync(options.omp)) throw new Error(`OMP executable not found: ${options.omp}`);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cliora-omp-history-replay-'));
  await fsp.mkdir(path.join(root, 'home'), { recursive: true });
  await fsp.mkdir(path.join(root, 'project'), { recursive: true });
  await fsp.mkdir(path.join(root, 'tmp'), { recursive: true });
  const environment = isolatedEnvironment(root);
  const server = await startEndpoint(root);
  const port = server.address().port;
  const agent = path.join(root, 'home/.omp/agent');
  await fsp.mkdir(agent, { recursive: true });
  await fsp.writeFile(path.join(agent, 'config.yml'), 'modelRoles:\n  default: fixture/fixture-model\n', 'utf8');
  await fsp.writeFile(path.join(agent, 'models.yml'), [
    'providers:',
    '  fixture:',
    '    api: openai-completions',
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    '    auth: none',
    '    models:',
    '      - id: fixture-model',
    '        name: Fixture Model',
    '        input:',
    '          - text',
    '        supportsTools: false',
    '        contextWindow: 32000',
    '        maxTokens: 4096',
    '        cost:',
    '          input: 1',
    '          output: 2',
    '          cacheRead: 0.1',
    '          cacheWrite: 0.2',
    '',
  ].join('\n'), 'utf8');

  const base = ['-p', '--model', 'fixture/fixture-model', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-lsp', '--offline'];
  const first = await run(options.omp, [...base, 'Explain the fixture project in one sentence.'], { cwd: path.join(root, 'project'), env: environment });
  if (first.code !== 0) throw new Error(`first omp run failed (${first.code}): ${first.stderr.slice(-2000)}`);
  const before = await sessionFiles(root);
  if (before.length !== 1) throw new Error(`expected one generated session, found ${before.length}`);
  const initial = titleSlot(await fsp.readFile(before[0]));
  const header = JSON.parse(initial.body.split('\n').find(Boolean));
  if (header.type !== 'session' || typeof header.id !== 'string') throw new Error('generated file has no session header');
  const resumed = await run(options.omp, [...base, '--resume', header.id, 'Second fixture turn.'], { cwd: path.join(root, 'project'), env: environment });
  if (resumed.code !== 0) throw new Error(`resume failed (${resumed.code}): ${resumed.stderr.slice(-2000)}`);
  const after = await sessionFiles(root);
  const final = titleSlot(await fsp.readFile(after[0]));
  const rows = final.body.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const messages = rows.filter(row => row.type === 'message');
  const assistant = messages.find(row => row.message?.role === 'assistant');
  console.log(JSON.stringify({
    isolatedRoot: root,
    session: after[0],
    titleSlotBytes: final.bytes,
    title: final.slot.title,
    titleSource: final.slot.source ?? null,
    header: { version: header.version, id: header.id, cwd: header.cwd },
    messageCount: messages.length,
    usage: assistant?.message?.usage ?? null,
    sessionFileCountBeforeResume: before.length,
    sessionFileCountAfterResume: after.length,
    firstRun: { code: first.code, stdout: first.stdout.trim(), stderr: first.stderr.trim() },
    resume: { code: resumed.code, stdout: resumed.stdout.trim(), stderr: resumed.stderr.trim() },
  }, null, 2));
  if (options.output) await fsp.copyFile(after[0], path.resolve(options.output));
  server.close();
  return 0;
}

main()
  .then(code => { process.exitCode = code; })
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
