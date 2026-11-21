#!/usr/bin/env node
/**
 * Secret access verification for the prompt secret references feature.
 *
 * Default mode is offline, deterministic and free: it checks the synthetic
 * fixtures, the CLI fallback text, the tool contract and the local test double.
 * It never starts an AI CLI and never calls a model.
 *
 * `--live` records real acceptance for the CLIs named by the operator. It only runs
 * with `CLIORA_LIVE_SECRET_TESTS=1` plus an explicit plan, because a real CLI prompt
 * may consume paid inference. A target is reported `verified` only after the native
 * entry, the protocol handshake, a model tool call and the CLI fallback were all
 * observed; a missing tool or an unobserved step stays `unverified` or `failed`
 * instead of passing.
 *
 * Results name the target, the step and the gap. A secret value is never written to
 * this process' output, an argument, a log or the evidence file: only lengths and
 * SHA-256 digests are compared.
 *
 * Exit codes: 0 every requested check passed, 1 a check failed, 2 usage error,
 * 3 `--live` was requested without the enable flag or a usable plan.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSecretUsageFromMetadata } from '../src/lib/secretCommands.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests/fixtures/secret-access');
const EVIDENCE_DOC = 'docs/verification/secret-access.md';
const GATE_ENV = 'CLIORA_LIVE_SECRET_TESTS';
const TOOLS_ENV = 'CLIORA_LIVE_SECRET_TOOLS';
const PLAN_ENV = 'CLIORA_LIVE_SECRET_PLAN';
const CANARY_ENV = 'CLIORA_LIVE_SECRET_CANARY';
const EVIDENCE_OUT_ENV = 'CLIORA_SECRET_EVIDENCE_OUT';

const MCP_ARGUMENT = '--cliora-internal-secret-mcp-v1';
const CLI_ARGUMENT = '--cliora-internal-secret-cli-v1';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const REQUIRED_TOOLS = ['list_secret_executors', 'list_secrets', 'read_secret', 'use_secret'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE = /\{\{cliora-secret:([^}]*)\}\}/g;
const VALUE_KEYS = new Set(['value', 'secretValue', 'rawValue', 'password', 'token', 'apiKey', 'secret']);

/** A document a consumer can read without guessing what was checked. */
export function document(mode, checks, targets = []) {
  return {
    kind: 'secret-access-verification',
    mode,
    recordedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    evidence: EVIDENCE_DOC,
    checks,
    targets,
    limits: 'Offline checks cover synthetic fixtures, the CLI fallback text, the tool contract and the local test double. They are not real CLI or model acceptance. macOS and Windows native behavior, installed CLIs and paid model calls are recorded separately by the live run in ' + EVIDENCE_DOC + '.',
  };
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function check(id, run) {
  try {
    const detail = run();
    return { id, status: 'passed', detail: detail ?? '' };
  } catch (error) {
    return { id, status: 'failed', detail: String(error?.message ?? error) };
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Tokenizes one generated command line. Quoting is the fallback text' own rule. */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const character of line) {
    if (character === "'") {
      quoted = !quoted;
      continue;
    }
    if (character === ' ' && !quoted) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quoted) throw new Error('命令行引号未闭合');
  if (current) tokens.push(current);
  return tokens;
}

/** The `use` command the fallback text documents, as argv. */
export function fallbackUseCommand(text) {
  const line = text.split('\n').map(value => value.trim()).find(value => value.includes(' use --secret '));
  expect(line, '回退说明没有可直接执行的 use 命令');
  return tokenize(line);
}

function fixtureMetadata() {
  return readJson(path.join(FIXTURES, 'synthetic-metadata.json'));
}

function usageInput(metadata, extra = {}) {
  return {
    context: metadata.context,
    installations: [metadata.installation],
    secrets: metadata.secrets.map(secret => ({ id: secret.id, alias: secret.alias })),
    executors: metadata.executors.map(executor => ({ id: executor.id, label: executor.label })),
    grants: metadata.grants,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Offline checks
// ---------------------------------------------------------------------------

function checkPrompt(metadata) {
  const text = readFileSync(path.join(FIXTURES, metadata.prompt.file), 'utf8');
  const references = [...text.matchAll(REFERENCE)].map(match => match[1]);
  expect(references.length >= 2, '提示词应只含两条合成引用');
  for (const id of references) expect(UUID.test(id), `引用里的秘密标识不是 UUID：${id}`);
  const known = new Set(metadata.secrets.map(secret => secret.id));
  for (const id of references) expect(known.has(id), `提示词引用了元数据里没有的秘密：${id}`);
  expect(text.includes(metadata.canary) === false, '提示词出现了合成 canary，应只有引用');
  expect(!/\bsk-[A-Za-z0-9]/.test(text), '提示词出现了形似真实密钥的文本');
  expect(!/-----BEGIN [A-Z ]+-----/.test(text), '提示词出现了私钥块');
  expect(!/\bBearer\s+[A-Za-z0-9._-]+/.test(text), '提示词出现了 bearer 凭据');
  const documented = new Set(metadata.prompt.references);
  for (const reference of documented) expect(text.includes(reference), `元数据声明的引用不在提示词里：${reference}`);
  return `${references.length} 条引用，只有标识与别名`;
}

function checkMetadata(metadata) {
  for (const secret of metadata.secrets) {
    expect(UUID.test(secret.id), `秘密标识不是 UUID：${secret.id}`);
    expect(secret.reference === `{{cliora-secret:${secret.id}}}`, `秘密 ${secret.id} 的引用形状不对`);
  }
  for (const executor of metadata.executors) expect(UUID.test(executor.id), `执行入口标识不是 UUID：${executor.id}`);
  expect(UUID.test(metadata.installation.id), '安装标识不是 UUID');
  for (const grant of metadata.grants) {
    expect(metadata.installation.id === grant.installationId, '授权不属于这个安装标识');
    expect(metadata.secrets.some(secret => secret.id === grant.secretId), `授权指向未知秘密：${grant.secretId}`);
    expect(metadata.executors.some(executor => executor.id === grant.executorId), `授权指向未登记执行入口：${grant.executorId}`);
  }
  const unbound = metadata.executors.find(executor => executor.id === metadata.ungranted.executorId);
  expect(unbound, '未授权的执行入口应已登记');
  expect(!metadata.grants.some(grant => grant.executorId === unbound.id), '未授权的执行入口不应有绑定');
  const visit = (value, key = '') => {
    if (Array.isArray(value)) return value.forEach(item => visit(item, key));
    if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        // The fixture names the synthetic canary once so a check can compare against
        // it; no metadata field may hold it under any other name.
        if (key === '' && name === 'canary') continue;
        expect(!VALUE_KEYS.has(name), `元数据出现了取值字段：${name}`);
        visit(child, name);
      }
      return;
    }
    if (typeof value === 'string') expect(value !== metadata.canary, `元数据出现了 canary（${key}）`);
  };
  visit(metadata);
  return '标识、别名、引用与授权一致，无取值字段';
}

function checkFallback(metadata) {
  const text = buildSecretUsageFromMetadata(usageInput(metadata));
  expect(text, '回退说明应有内容');
  const use = fallbackUseCommand(text);
  const expected = [
    metadata.context.executable,
    metadata.context.entry,
    '--installation',
    metadata.installation.id,
    'use',
    '--secret',
    metadata.secrets[0].id,
    '--executor',
    metadata.grants[0].executorId,
  ];
  expect(JSON.stringify(use) === JSON.stringify(expected), `use 命令与已登记绑定不一致：${use.join(' ')}`);
  expect(text.includes(`${metadata.context.entry} --installation ${metadata.installation.id} list`), '回退说明缺少 list 命令');
  expect(text.includes(`read --secret ${metadata.secrets[0].id}`), '回退说明缺少 read 命令');
  expect(!text.includes(metadata.canary), '回退说明出现了 canary');
  expect(!text.includes(metadata.secrets[1].id), '回退说明列出了未授权的秘密');
  expect(!text.includes(metadata.ungranted.executorId), '回退说明列出了未绑定的执行入口');
  expect(!/--value|CLIORA_SECRET=|secretValue/.test(text), '回退说明出现了取值参数');
  expect(!text.includes(MCP_ARGUMENT), '回退说明应指向 CLI helper，而不是内部 MCP 入口');
  const english = buildSecretUsageFromMetadata(usageInput(metadata, { locale: 'en' }));
  expect(english.includes('## Cliora secret broker (local CLI)'), '英文回退说明缺少标题');
  expect(!english.includes(metadata.canary), '英文回退说明出现了 canary');
  return `list/use/read 命令可直接执行，含 ${use.length} 个参数`;
}

function checkToolContract(metadata) {
  const contract = readJson(path.join(FIXTURES, 'mcp-tools.json'));
  const tools = contract.tools;
  const names = tools.map(tool => tool.name).sort();
  expect(JSON.stringify(names) === JSON.stringify(REQUIRED_TOOLS), `工具集合与验收要求不一致：${names.join(', ')}`);
  for (const tool of tools) {
    expect(tool.descriptionContains.length > 0, `${tool.name} 需要说明何时使用`);
    expect(new Set(tool.properties).size === tool.properties.length, `${tool.name} 的输入重复`);
    for (const forbidden of contract.noInputNamed) {
      expect(!tool.properties.includes(forbidden), `${tool.name} 不能接受 ${forbidden} 输入`);
    }
    for (const required of tool.required) {
      expect(tool.properties.includes(required), `${tool.name} 的必填输入 ${required} 未声明`);
    }
  }
  const byName = name => tools.find(tool => tool.name === name);
  expect(JSON.stringify(byName('use_secret').properties.slice().sort()) === JSON.stringify(['executorId', 'secretId']), 'use_secret 的输入结构不对');
  expect(JSON.stringify(byName('read_secret').properties) === JSON.stringify(['secretId']), 'read_secret 只接受秘密标识');
  // A model can build both calls from the prompt reference plus the schema.
  const use = metadata.expected.useCall;
  const read = metadata.expected.readCall;
  expect(use.tool === 'use_secret' && read.tool === 'read_secret', '期望调用应指向受控使用与原值读取');
  expect(JSON.stringify(Object.keys(use.arguments).sort()) === JSON.stringify(byName('use_secret').properties.slice().sort()), '受控使用调用参数与工具结构不一致');
  expect(JSON.stringify(Object.keys(read.arguments)) === JSON.stringify(byName('read_secret').properties), '原值读取调用参数与工具结构不一致');
  expect(metadata.prompt.references.includes(`{{cliora-secret:${use.arguments.secretId}}}`), '受控使用调用的秘密标识与提示词引用不一致');
  const printed = JSON.stringify(tools);
  expect(!printed.includes(metadata.canary), '工具契约出现了 canary');
  for (const token of contract.noMetadataSubstring) expect(!printed.includes(token), `工具元数据出现了不允许的片段：${token}`);
  return `${tools.length} 个工具，输入结构可由引用直接生成调用`;
}

async function checkExecutorDouble(metadata) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cliora-secret-access-'));
  const receipt = path.join(directory, 'receipt.json');
  const double = path.join(FIXTURES, 'executor-double.mjs');
  const run = args => new Promise((resolve, reject) => {
    const channel = args[args.indexOf('--channel') + 1];
    const child = spawn(process.execPath, [double, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLIORA_TEST_SECRET: metadata.canary } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(channel === 'stdin' ? `${metadata.canary}\n` : '');
  });
  try {
    const viaEnv = await run(['--channel', 'env', '--env-name', 'CLIORA_TEST_SECRET', '--receipt', receipt]);
    expect(viaEnv.code === 0, `测试替身经环境变量应成功，实际退出码 ${viaEnv.code}`);
    expect(viaEnv.stdout.includes(metadata.expected.executorSentinel), '测试替身没有返回哨兵');
    // The double deliberately echoes the value so a live run has a real masking case.
    expect(viaEnv.stdout.includes(metadata.canary) && viaEnv.stderr.includes(metadata.canary), '测试替身应在两条流上故意回显原值，以验证遮蔽');
    const record = readJson(receipt);
    expect(record.sha256 === sha256(metadata.canary), '测试替身的回执摘要与合成值不一致');
    expect(record.channel === 'env' && record.bytes === Buffer.byteLength(metadata.canary), '测试替身的回执字段不对');
    expect(!readFileSync(receipt, 'utf8').includes(metadata.canary), '回执不能写入原值');
    const viaStdin = await run(['--channel', 'stdin']);
    expect(viaStdin.code === 0 && viaStdin.stdout.includes(metadata.expected.executorSentinel), '测试替身经标准输入应成功');
    const missing = await run(['--channel', 'env', '--env-name', 'CLIORA_TEST_SECRET_ABSENT']);
    expect(missing.code === 3, `缺少原值时测试替身应失败关闭，实际退出码 ${missing.code}`);
    expect(missing.stdout.includes(metadata.expected.missingValueSentinel), '缺少原值时应有可识别结果');
    return '两条通道都收到合成值，回执只有摘要，缺少原值时失败关闭';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The doc matrix and the recorded acceptances have to describe the same targets. */
function documentAnchorExists(text, anchor) {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:id|name)\\s*=\\s*["']${escaped}["']`).test(text)) return true;
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/)?.[1];
    if (!heading) continue;
    const slug = heading
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    if (slug === anchor.toLowerCase()) return true;
  }
  return false;
}

export function checkEvidenceConsistency({ docPath = path.join(ROOT, EVIDENCE_DOC), gatePath = path.join(ROOT, 'src-tauri/src/adapters/secret_access.rs') } = {}) {  const text = readFileSync(docPath, 'utf8');
  const rows = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'))
    .map(line => line.split('|').map(cell => cell.trim()).filter(Boolean))
    // Only the per-target matrix starts a row with a stable tool id.
    .filter(cells => cells.length >= 3 && /^[a-z0-9_]+$/.test(cells[0]));
  expect(rows.length > 0, '验收文档缺少逐目标矩阵');
  const statuses = rows.map(cells => ({ tool: cells[0], mapping: cells[1].replace(/^`+|`+$/g, ''), status: cells[cells.length - 1] }));
  const allowed = new Set(['verified', 'unverified', 'not-installed', 'unsupported', 'not-run']);
  for (const row of statuses) {
    expect(allowed.has(row.status), `${row.tool} 的状态不是约定取值：${row.status}`);
    expect(row.mapping && row.mapping !== '—', `${row.tool} 的配置映射列不能为空`);
  }
  const gate = readFileSync(gatePath, 'utf8');
  const list = gate.slice(gate.indexOf('pub const ACCEPTANCES'));
  const recorded = [...list.matchAll(/SecretMcpAcceptance\s*\{([^}]*)\}/g)].map(match => {
    const fields = match[1];
    const field = name => fields.match(new RegExp(`${name}:\\s*"([^"]*)"`))?.[1];
    return { tool: field('tool_id'), mapping: field('mapping'), recordedAt: field('recorded_at'), evidence: field('evidence') };
  });
  for (const [index, record] of recorded.entries()) {
    expect(record.tool, `第 ${index + 1} 条验收记录缺少 tool_id`);
    expect(record.mapping, `已记录的验收目标缺少 mapping：${record.tool}`);
    expect(record.evidence && record.evidence.startsWith('docs/verification/') && record.evidence.includes('#'), `已记录的验收目标证据不是 docs/verification/ 下的锚点：${record.tool}`);
    const anchor = record.evidence?.split('#')[1] ?? '';
    expect(anchor, `已记录的验收目标证据缺少锚点：${record.tool}`);
    if (path.basename(record.evidence.split('#')[0]) === path.basename(docPath)) {
      expect(documentAnchorExists(text, anchor), `已记录的验收目标证据锚点在文档中不存在：${record.tool}#${anchor}`);
    }
    expect(/^\d{4}-\d{2}-\d{2}$/.test(record.recordedAt ?? ''), `已记录的验收目标日期不是 YYYY-MM-DD：${record.tool}`);
    const row = statuses.find(entry => entry.tool === record.tool);
    expect(row, `已记录的验收目标缺少文档行：${record.tool}`);
    expect(row.mapping === record.mapping, `${record.tool} 的文档映射标签与验收记录不一致：${row.mapping} ≠ ${record.mapping}`);
    expect(row.status === 'verified', `已记录的验收目标在文档里不是 verified：${record.tool}`);
  }
  for (const row of statuses.filter(entry => entry.status === 'verified')) {
    expect(recorded.some(record => record.tool === row.tool), `文档声明 ${row.tool} 已通过，但适配器没有对应验收记录`);
  }
  return `${statuses.length} 个目标行，${recorded.length} 条已记录验收`;
}

/** Every offline check. Nothing here starts a CLI or calls a model. */
export async function verifyOffline() {
  const metadata = fixtureMetadata();
  const checks = [
    check('prompt-references', () => checkPrompt(metadata)),
    check('synthetic-metadata', () => checkMetadata(metadata)),
    check('cli-fallback', () => checkFallback(metadata)),
    check('mcp-tool-contract', () => checkToolContract(metadata)),
    check('evidence-consistency', () => checkEvidenceConsistency()),
  ];
  checks.push(await checkAsync('executor-double', () => checkExecutorDouble(metadata)));
  checks.push({ id: 'live-acceptance', status: 'skipped', detail: `未请求实机验收；设置 ${GATE_ENV}=1 与 ${PLAN_ENV} 后运行 --live` });
  const documentValue = document('offline', checks);
  // The document is printed, so a value must not reach it even if a fixture regresses.
  if (JSON.stringify(documentValue).includes(metadata.canary)) {
    return document('offline', [{ id: 'value-hygiene', status: 'failed', detail: '离线结果包含合成值，已拒绝输出' }]);
  }
  return documentValue;
}

async function checkAsync(id, run) {
  try {
    return { id, status: 'passed', detail: await run() };
  } catch (error) {
    return { id, status: 'failed', detail: String(error?.message ?? error) };
  }
}

// ---------------------------------------------------------------------------
// Live acceptance
// ---------------------------------------------------------------------------

/** The operator's plan. Per-target invocation is supplied, so this script never
 * owns an adapter's native mapping, executable or MCP configuration path. */
export function validateLivePlan(plan, canary) {
  expect(canary, `${CANARY_ENV} 必须给出这次使用的合成值`);
  expect(/^canary-[a-z0-9-]+$/.test(canary), `${CANARY_ENV} 只接受形如 canary-… 的合成值，拒绝真实秘密`);
  expect(plan && typeof plan === 'object', `${PLAN_ENV} 指向的 JSON 不是对象`);
  expect(typeof plan.helper === 'string' && path.isAbsolute(plan.helper), '计划里的 helper 需为绝对路径');
  expect(UUID.test(plan.installationId ?? ''), '计划里的 installationId 不是 UUID');
  expect(UUID.test(plan.secretId ?? ''), '计划里的 secretId 不是 UUID');
  expect(UUID.test(plan.executorId ?? ''), '计划里的 executorId 不是 UUID');
  expect(Array.isArray(plan.targets) && plan.targets.length > 0, '计划里没有目标');
  for (const target of plan.targets) {
    expect(typeof target.toolId === 'string' && target.toolId, '目标缺少 toolId');
    expect(Array.isArray(target.printCommand) && target.printCommand.length > 0, `${target.toolId}: printCommand 必须是可执行文件加参数`);
    expect(target.printCommand.every(value => typeof value === 'string' && value), `${target.toolId}: printCommand 只能包含字符串`);
    expect(Array.isArray(target.versionCommand ?? []) && (target.versionCommand ?? []).every(value => typeof value === 'string'), `${target.toolId}: versionCommand 只能包含字符串`);
    expect(typeof target.mcpConfigPath === 'string' && path.isAbsolute(target.mcpConfigPath), `${target.toolId}: mcpConfigPath 需为绝对路径`);
    expect(typeof target.mcpEntryName === 'string' && target.mcpEntryName, `${target.toolId}: mcpEntryName 不能为空`);
  }
  return plan;
}

function runCommand(argv, { input, timeout = 30000, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** `initialize` and `tools/list` against the real helper. Protocol only. */
function protocolProbe(helper, installationId, canary, timeout = 20000) {
  return new Promise(resolve => {
    const child = spawn(helper, [MCP_ARGUMENT, '--installation', installationId], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let initialized = false;
    let tools = null;
    let leaked = false;
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ ok, detail, initialized, tools: tools ?? [], leaked });
    };
    const timer = setTimeout(() => finish(false, '协议检查超时'), timeout);
    const send = payload => child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.on('error', error => finish(false, `无法启动 helper：${error.message}`));
    child.stderr.on('data', chunk => { stderr += chunk; if (canary && chunk.includes(canary)) leaked = true; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (canary && chunk.includes(canary)) leaked = true;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          initialized = typeof message.result.protocolVersion === 'string';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        }
        if (message.id === 1 && message.error) finish(false, `initialize 失败：${message.error.message ?? '未知错误'}`);
        if (message.id === 2 && message.error) finish(false, `tools/list 失败：${message.error.message ?? '未知错误'}`);
        if (message.id === 2 && message.result) {
          tools = (message.result.tools ?? []).map(tool => tool.name);
          const missing = REQUIRED_TOOLS.filter(name => !tools.includes(name));
          finish(missing.length === 0, missing.length ? `未公开工具：${missing.join('、')}` : `initialize + tools/list 通过（${tools.length} 个工具）`);
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'cliora-verify-secret-access', version: '1.0.0' } } });
  });
}

function configObservation(target, plan, canary) {
  if (!target.mcpConfigPath || !target.mcpEntryName) {
    return { written: false, detail: '计划缺少原生配置路径或条目名，不能证明写入' };
  }
  let text;
  try { text = readFileSync(target.mcpConfigPath, 'utf8'); } catch (error) {
    return { written: false, detail: `无法读取原生配置：${error.code ?? error.message}` };
  }
  const written = text.includes(target.mcpEntryName) && text.includes(plan.helper) && text.includes(plan.installationId);
  if (text.includes(canary)) return { written, detail: '原生配置出现了合成值', leaked: true };
  return { written, detail: written ? '原生条目已写入，只有 helper 与安装标识' : '原生条目缺失或与计划不一致' };
}

function runtimePlatform() {
  return `${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`;
}

async function liveTarget(target, plan, canary) {
  const platform = runtimePlatform();
  const result = {
    toolId: target.toolId,
    status: 'unverified',
    installed: null,
    cliVersion: '',
    configWritten: false,
    initialize: false,
    toolsList: [],
    modelUse: false,
    cliFallback: false,
    valueDelivered: null,
    masked: null,
    platform,
    reason: '',
    evidence: EVIDENCE_DOC,
  };
  const reasons = [];
  if (target.platform && target.platform !== platform) {
    reasons.push(`计划声明的平台 ${target.platform} 与运行平台 ${platform} 不一致`);
  }
  const versionCommand = target.versionCommand?.length ? target.versionCommand : null;
  if (versionCommand) {
    const version = await runCommand(versionCommand, { timeout: 20000 });
    result.installed = version.code === 0;
    result.cliVersion = version.stdout.trim().split('\n')[0] ?? '';
    if (!result.installed) reasons.push('版本探测失败');
    if (target.cliVersion && !version.stdout.includes(target.cliVersion)) reasons.push(`版本输出不含计划声明的 ${target.cliVersion}`);
  } else {
    result.installed = null;
    reasons.push('未提供 versionCommand，安装状态未验证');
  }

  const config = configObservation(target, plan, canary);
  result.configWritten = config.written;
  if (config.leaked) reasons.push(config.detail);
  if (config.written === false) reasons.push(config.detail);

  const protocol = await protocolProbe(plan.helper, plan.installationId, canary);
  result.initialize = protocol.initialized;
  result.toolsList = protocol.tools;
  if (!protocol.ok) reasons.push(protocol.detail);
  if (protocol.leaked) reasons.push('协议响应出现了合成值');

  const prompt = readFileSync(path.resolve(ROOT, plan.prompt ?? path.join('tests/fixtures/secret-access', fixtureMetadata().prompt.file)), 'utf8');
  const timeout = Number(process.env.CLIORA_LIVE_SECRET_MODEL_TIMEOUT_MS ?? 180000);
  const printArgv = [...target.printCommand];
  let modelInput;
  if (target.printStdin === false) printArgv.push(prompt);
  else modelInput = prompt;
  if (plan.receiptPath) rmSync(plan.receiptPath, { force: true });
  const model = await runCommand(printArgv, { input: modelInput, timeout });
  const modelText = `${model.stdout}${model.stderr}`;
  if (modelText.includes(canary)) reasons.push('模型可见输出出现了合成值');
  const sentinel = fixtureMetadata().expected.executorSentinel;
  const maskedMarker = fixtureMetadata().expected.maskedMarker;
  result.masked = modelText.includes(maskedMarker);
  // A prompt that names the sentinel could be echoed without any tool call, so the
  // same model-visible text must carry the broker's masking marker too.
  result.modelUse = modelText.includes(sentinel) && result.masked;
  if (!result.modelUse) reasons.push('模型可见输出缺少执行入口哨兵或遮蔽标记，工具调用未完成');
  if (plan.receiptPath) result.valueDelivered = receiptMatches(plan.receiptPath, canary);
  else if (result.modelUse) reasons.push('未提供 receiptPath，执行入口是否收到原值未验证');
  if (result.valueDelivered === false) reasons.push('执行入口回执与计划中的合成值不一致');

  if (plan.receiptPath) rmSync(plan.receiptPath, { force: true });
  const fallbackText = buildSecretUsageFromMetadata({
    context: plan.context ?? { executable: plan.helper, entry: CLI_ARGUMENT },
    installations: [{ id: plan.installationId, label: plan.installationLabel ?? 'live', kind: 'cli', revoked: false }],
    secrets: [{ id: plan.secretId, alias: plan.secretAlias ?? 'live' }],
    executors: [{ id: plan.executorId, label: plan.executorLabel ?? 'live' }],
    grants: [{ installationId: plan.installationId, secretId: plan.secretId, executorId: plan.executorId }],
    preferredId: plan.installationId,
  });
  const fallbackArgv = fallbackUseCommand(fallbackText);
  const fallback = await runCommand(fallbackArgv, { timeout });
  const fallbackTextOutput = `${fallback.stdout}${fallback.stderr}`;
  result.cliFallback = fallback.code === 0 && fallbackTextOutput.includes(sentinel) && !fallbackTextOutput.includes(canary);
  if (!result.cliFallback) {
    const why = !fallbackTextOutput.includes(sentinel) ? '没有哨兵' : fallbackTextOutput.includes(canary) ? '输出出现合成值' : `退出码 ${fallback.code}`;
    reasons.push(`CLI 回退未通过（${why}）`);
  }
  if (plan.receiptPath) {
    const delivered = receiptMatches(plan.receiptPath, canary);
    if (delivered === false) reasons.push('CLI 回退没有让执行入口收到同一个合成值');
    result.valueDelivered = result.valueDelivered === null ? delivered : result.valueDelivered && delivered;
  }
  result.reason = reasons.join('；');
  // Any recorded gap, including a value that reached model-visible text, keeps the
  // target out of `verified`; a shorter success cannot override it.
  const complete = result.installed === true && protocol.ok && result.modelUse && result.cliFallback && result.valueDelivered === true && result.configWritten === true && result.masked === true;
  result.status = complete && reasons.length === 0 ? 'verified' : 'failed';
  return result;
}

function receiptMatches(receipt, canary) {
  if (!existsSync(receipt)) return false;
  try {
    const record = readJson(receipt);
    return record.sha256 === sha256(canary) && record.bytes === Buffer.byteLength(canary);
  } catch {
    return false;
  }
}

/** Real acceptance for the named targets. Requires the explicit enable flag. */
export async function verifyLive(environment = process.env) {
  if (environment[GATE_ENV] !== '1') {
    return { status: 'not-enabled', documentValue: document('live', [{ id: 'live-acceptance', status: 'skipped', detail: `需要显式设置 ${GATE_ENV}=1，真实 CLI 可能产生推理费用` }]) };
  }
  const planFile = environment[PLAN_ENV];
  if (!planFile) {
    return { status: 'not-enabled', documentValue: document('live', [{ id: 'live-plan', status: 'skipped', detail: `需要设置 ${PLAN_ENV}，指向逐目标调用计划` }]) };
  }
  let plan;
  let canary;
  try {
    plan = readJson(path.resolve(ROOT, planFile));
    canary = environment[CANARY_ENV] ?? '';
    validateLivePlan(plan, canary);
  } catch (error) {
    return { status: 'invalid', documentValue: document('live', [{ id: 'live-plan', status: 'failed', detail: String(error?.message ?? error) }]) };
  }
  const wanted = (environment[TOOLS_ENV] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const selected = wanted.length ? plan.targets.filter(target => wanted.includes(target.toolId)) : plan.targets;
  if (!selected.length) {
    return { status: 'invalid', documentValue: document('live', [{ id: 'live-plan', status: 'failed', detail: `${TOOLS_ENV} 没有匹配计划里的任何目标` }]) };
  }
  const skipped = plan.targets.filter(target => !selected.includes(target));
  const targets = [];
  for (const target of selected) targets.push(await liveTarget(target, plan, canary));
  for (const target of skipped) {
    targets.push({ toolId: target.toolId, status: 'not-run', installed: null, cliVersion: '', configWritten: false, initialize: false, toolsList: [], modelUse: false, cliFallback: false, valueDelivered: null, masked: null, platform: runtimePlatform(), reason: `不在 ${TOOLS_ENV} 里，本次未运行`, evidence: EVIDENCE_DOC });
  }
  const documentValue = document('live', [
    { id: 'live-plan', status: 'passed', detail: `${targets.length} 个目标，计划完成校验` },
    { id: 'value-hygiene', status: 'passed', detail: '真实调用只使用合成值，输出只比较长度与 SHA-256' },
  ], targets);
  const serialized = JSON.stringify(documentValue);
  if (serialized.includes(canary)) {
    return { status: 'leaked', documentValue: document('live', [{ id: 'value-hygiene', status: 'failed', detail: '结果文档包含合成值，已拒绝写出' }], targets) };
  }
  if (environment[EVIDENCE_OUT_ENV]) writeFileSync(path.resolve(ROOT, environment[EVIDENCE_OUT_ENV]), `${JSON.stringify(documentValue, null, 2)}\n`);
  // An explicit subset reports the other targets as not-run; only a selected
  // target that failed can fail the command.
  const failed = targets.some(target => target.status !== 'verified' && target.status !== 'not-run');
  return { status: failed ? 'failed' : 'verified', documentValue };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function print(documentValue) {
  if (documentValue.mode === 'offline') {
    for (const item of documentValue.checks) console.log(`${item.status === 'passed' ? 'PASS' : item.status === 'skipped' ? 'SKIP' : 'FAIL'} ${item.id}: ${item.detail}`);
    const failed = documentValue.checks.filter(item => item.status === 'failed');
    console.log(`secret access offline: ${failed.length ? `${failed.length} 项失败` : '全部通过'}（未启动 AI CLI，未调用模型）`);
    return;
  }
  for (const item of documentValue.checks) console.log(`${item.status === 'passed' ? 'PASS' : item.status === 'skipped' ? 'SKIP' : 'FAIL'} ${item.id}: ${item.detail}`);
  for (const target of documentValue.targets) {
    console.log(`${target.status === 'verified' ? 'VERIFIED' : target.status === 'not-run' ? 'NOT-RUN' : 'FAILED'} ${target.toolId}: installed=${target.installed} config-written=${target.configWritten} initialize=${target.initialize} tools=${target.toolsList.length} model-use=${target.modelUse} cli-fallback=${target.cliFallback} value-delivered=${target.valueDelivered} masked=${target.masked} platform=${target.platform}${target.reason ? ` — ${target.reason}` : ''}`);
  }
}

async function main() {
  const unknown = process.argv.slice(2).filter(value => value !== '--live' && value !== '--json');
  if (unknown.length) {
    console.error(`secret access: 未知参数 ${unknown.join(' ')}；只接受 --live 和 --json`);
    process.exitCode = 2;
    return;
  }
  const live = process.argv.includes('--live');
  if (live) {
    const result = await verifyLive();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result.documentValue, null, 2));
    else print(result.documentValue);
    if (result.status === 'not-enabled' || result.status === 'invalid') process.exitCode = 3;
    else process.exitCode = result.status === 'verified' ? 0 : 1;
    return;
  }
  const documentValue = await verifyOffline();
  if (process.argv.includes('--json')) console.log(JSON.stringify(documentValue, null, 2));
  else print(documentValue);
  process.exitCode = documentValue.checks.some(item => item.status === 'failed') ? 1 : 0;
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  main().catch(error => {
    console.error(`secret access: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
