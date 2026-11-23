import type { ScriptAccessOptions, SecretInstallationKind } from '../types/secrets';

/**
 * The CLI usage text a user inserts into a prompt.
 *
 * It is built from local metadata only: the executable, the installation id and the
 * granted secret/executor pairs. Nothing here is guessed, so a reader can copy a
 * command without inventing a flag, an id or an argument order. A value never
 * appears: `use` hands it to the registered executor, and `read` asks the user.
 */

export type SecretUsageSecret = { id: string; alias: string };
export function grantedSecretAliases(grants: Array<{ secretId: string; alias: string }>): SecretUsageSecret[] {
  const aliases = new Map(grants.map(grant => [grant.secretId, grant.alias]));
  return [...aliases].map(([id, alias]) => ({ id, alias }));
}
export type SecretUsageExecutor = { id: string; label: string };
export type SecretUsageGrant = { secretId: string; executorId: string };

export type SecretUsageInput = {
  executable: string;
  entry: string;
  installationId: string;
  installationLabel: string;
  kind: SecretInstallationKind;
  secrets: SecretUsageSecret[];
  executors: SecretUsageExecutor[];
  grants: SecretUsageGrant[];
  locale?: 'zh' | 'en';
};

const SAFE_ARGUMENT = /^[A-Za-z0-9._/:=@+-]+$/;

/** One shell argument. Only values a shell would reinterpret are quoted. */
export function quoteArgument(value: string): string {
  if (value && SAFE_ARGUMENT.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type CliCommandContext = Pick<SecretUsageInput, 'executable' | 'entry' | 'installationId'>;

// PowerShell otherwise detaches a Windows GUI executable before the broker
// answers. An output pipeline waits for it and captures its JSON on stdout.
const POWERSHELL_OUTPUT = ' | Out-String -Stream';

export function grantedScriptCommand(context: CliCommandContext, grant: SecretUsageGrant): string {
  return command(context, ['use', '--secret', grant.secretId, '--executor', grant.executorId]);
}

function command(input: CliCommandContext, rest: string[]): string {
  const argv = [input.executable, input.entry, '--installation', input.installationId, ...rest];
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(input.executable)) {
    return '& ' + argv.map(arg => SAFE_ARGUMENT.test(arg) ? arg : "'" + arg.replaceAll("'", "''") + "'").join(' ') + POWERSHELL_OUTPUT;
  }
  return argv.map(quoteArgument).join(' ');
}

export function promptSecretTokens(body: string): string[] {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/\{\{cliora-secret:(?:urn:uuid:)?(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\}\}/g)) {
    tokens.add(match[0]);
    if (tokens.size === 256) break;
  }
  return [...tokens];
}

/** Only the outgoing local message receives commands. No credential is fetched here. */
export async function prepareLocalSecretPrompt(
  body: string, load: () => Promise<Pick<ScriptAccessOptions, 'cli' | 'installations' | 'grants'>>,
  english: boolean,
): Promise<string> {
  const tokens = promptSecretTokens(body);
  if (!tokens.length) return body;
  const { cli, installations, grants } = await load();
  const live = installations.filter(item => item.kind === 'cli' && !item.targetId && !item.revoked);
  const lines: string[] = [];
  const seen = new Set<string>();
  const listCommands = new Set<string>();
  const readOptions = new Map<string, Set<string>>();
  for (const token of tokens) {
    const compact = token.slice('{{cliora-secret:'.length, -2).replace(/^urn:uuid:/, '').replaceAll('-', '').toLowerCase();
    if (seen.has(compact)) continue;
    seen.add(compact);
    const matching = grants.filter(grant => grant.secretId.replaceAll('-', '').toLowerCase() === compact
      && live.some(item => item.id === grant.installationId));
    if (!matching.length) {
      lines.push(english ? token + ' has no authorized local CLI action. If list_secrets is available, check its granted actions. Otherwise ask the user to set up this reference on this device and authorize the requested action in Secret references.' : token + ' 尚无本机 CLI 操作授权。若当前提供 list_secrets，可查询已授权的 MCP 操作；否则请用户在「秘密引用」中为此引用配置本机值，并授权所需操作。');
      continue;
    }
    lines.push(matching[0].alias + ' ' + token);
    for (const grant of matching) {
      const context = { ...cli, installationId: grant.installationId };
      listCommands.add(command(context, ['list']));
      const ids = readOptions.get(grant.installationId) ?? new Set<string>();
      ids.add(grant.secretId);
      readOptions.set(grant.installationId, ids);
      const use = grantedScriptCommand(context, grant);
      if (!body.includes(use) && !body.includes(use.replace(/^& /, ''))) lines.push(grant.executorLabel, use);
    }
  }
  // Prefer the installation covering the most references, so an overlapping
  // grant does not split a request that one installation can handle together.
  const assigned = new Set<string>();
  for (const [installationId, ids] of [...readOptions].sort((a, b) => b[1].size - a[1].size)) {
    const group = [...ids].filter(id => !assigned.has(id));
    if (!group.length) continue;
    for (const id of group) assigned.add(id);
    const read = command({ ...cli, installationId }, ['read', ...group.flatMap(id => ['--secret', id])]);
    if (!body.includes(read)) lines.push(english ? 'Read requested values (omit references you do not need)' : '查看所需原值（请删去未请求的引用）', read);
  }
  if (listCommands.size) {
    lines.push(english ? 'Find a reference by alias. Use its reference field directly.' : '按名称查找引用时，直接使用返回的 reference 字段。', ...listCommands);
  }
  const guidance = english
    ? 'Keep literal references when quoting or passing them on. If the Cliora secret MCP tools are available, call list_secrets and use_secret with the matching granted secretId and executorId. Otherwise use the matching authorized CLI command below. Return the action result. If no action matches, ask the user to grant one. Only read the values the user explicitly asks to see. Group those references in one CLI read or in the secretIds array of MCP read_secret when available. Stop if approval is declined or unavailable.'
    : '转述或传递引用时，原样保留占位符。当前会话提供栖点秘密 MCP 工具时，调用 list_secrets 查找授权，再把对应的 secretId 和 executorId 传给 use_secret。否则使用下方匹配的已授权 CLI 命令。只返回操作结果。缺少合适的操作时，请用户授权。只读取用户明确要求查看的原值，多个引用可合并到一次 CLI read，或在提供 MCP read_secret 时一起传入 secretIds。被拒绝或无法确认时停止读取。';
  return [body, '', guidance, ...lines].join('\n');
}

/** The executors granted for one secret, in registry order. */
export function grantedExecutors(input: SecretUsageInput, secretId: string): SecretUsageExecutor[] {
  const allowed = new Set(input.grants.filter(grant => grant.secretId === secretId).map(grant => grant.executorId));
  return input.executors.filter(executor => allowed.has(executor.id));
}

/** One live installation as the native registry lists it. No value is involved. */
export type SecretUsageInstallation = { id: string; label: string; kind: SecretInstallationKind; revoked: boolean };
/** A grant as the registry stores it: one installation, one secret, one executor. */
export type SecretUsageInstallationGrant = { installationId: string; secretId: string; executorId: string };

/**
 * The installation an instruction block names.
 *
 * A caller may pin one (the secret MCP panel pins the installation its native
 * entry already carries). Otherwise the first live installation with a grant wins,
 * so the text holds real use/read commands, and a live installation with no grant
 * still produces the list command instead of a guessed one.
 */
export function preferredInstallation(
  installations: SecretUsageInstallation[],
  grants: SecretUsageInstallationGrant[],
  preferredId?: string | null,
): SecretUsageInstallation | undefined {
  const live = installations.filter(installation => !installation.revoked);
  return live.find(installation => installation.id === preferredId)
    ?? live.find(installation => grants.some(grant => grant.installationId === installation.id))
    ?? live[0];
}

export type SecretUsageMetadata = {
  context: { executable: string; entry: string };
  installations: SecretUsageInstallation[];
  secrets: SecretUsageSecret[];
  executors: SecretUsageExecutor[];
  grants: SecretUsageInstallationGrant[];
  preferredId?: string | null;
  locale?: 'zh' | 'en';
};

/**
 * The CLI fallback text from local metadata. It is the same text for a CLI and an
 * MCP installation: the fallback runs the CLI helper, so a missing or unverified
 * MCP entry still leaves a documented path. `null` means no live installation.
 */
export function buildSecretUsageFromMetadata(metadata: SecretUsageMetadata): string | null {
  const installation = preferredInstallation(metadata.installations, metadata.grants, metadata.preferredId);
  if (!installation) return null;
  return buildSecretUsageInstructions({
    executable: metadata.context.executable,
    entry: metadata.context.entry,
    installationId: installation.id,
    installationLabel: installation.label,
    kind: installation.kind,
    locale: metadata.locale,
    secrets: metadata.secrets,
    executors: metadata.executors,
    grants: metadata.grants
      .filter(grant => grant.installationId === installation.id)
      .map(grant => ({ secretId: grant.secretId, executorId: grant.executorId })),
  });
}

const text = {
  zh: {
    title: '## 栖点秘密代理（本机 CLI）',
    installation: '安装标识',
    executable: '可执行文件',
    intro: '所有命令都通过本机秘密代理执行；原值只在本机凭据库，参数里只有秘密标识。',
    listTitle: '### 1. 列出可用秘密',
    listNote: '按别名找到秘密后，可直接复用 reference 字段。执行任务时用对应的已授权入口，只有用户明确要求查看原值时才执行 read。',
    useTitle: '### 2. 受控使用（原值只进入执行入口，输出里的原值会被遮蔽）',
    alias: '别名',
    executor: '执行入口',
    noGrant: '当前安装标识还没有任何已授权的秘密与执行入口，请先在资料库的“秘密引用”里授权。',
    readTitle: '### 3. 读取原值',
    readNote: '读取多个原值时，为每个所需引用添加一个 --secret，一起在栖点确认。工作台 CLI 和 MCP 可选择「允许本次会话」，外部终端每次请求都要确认。原值可能进入模型上下文与 CLI 会话记录。',
    readSwap: '把 {{id}} 换成第 1 步里用户要求查看的秘密标识。MCP read_secret 可用 secretIds 一次请求多个引用。',
    exitNote: '命令失败时退出码非零，结果里只有遮蔽后的文本；不会改成别的秘密，也不会重试成别的执行入口。',
  },
  en: {
    title: '## Cliora secret broker (local CLI)',
    installation: 'Installation',
    executable: 'Executable',
    intro: 'Every command runs through the local secret broker. The value stays in the local credential store; the arguments carry identifiers only.',
    listTitle: '### 1. List the secrets you may use',
    listNote: 'Find the alias and reuse its reference field directly. Use a granted executor for tasks. Only call read if the user explicitly asks to see the value.',
    useTitle: '### 2. Controlled use (the value only reaches the executor, and it is masked in the output)',
    alias: 'Alias',
    executor: 'Executor',
    noGrant: 'This installation has no granted secret and executor yet. Grant one in the library under secret references first.',
    readTitle: '### 3. Read raw values',
    readNote: 'Repeat --secret for each requested reference to approve them together in Cliora. The workbench CLI and MCP offer “Allow for this session”. An external terminal asks for confirmation in Cliora on each request. Values may enter the model context and the CLI session history.',
    readSwap: 'Replace {{id}} with the identifier from step 1 that the user asked to read. MCP read_secret accepts multiple references in secretIds.',
    exitNote: 'A failed command exits non-zero and its output is masked. It never falls back to another secret or executor, and never retries.',
  },
} as const;

export function buildSecretUsageInstructions(input: SecretUsageInput): string {
  const copy = text[input.locale === 'en' ? 'en' : 'zh'];
  const lines: string[] = [
    copy.title,
    '',
    `${copy.installation}: ${input.installationLabel} (${input.installationId})`,
    `${copy.executable}: ${input.executable}`,
    '',
    copy.intro,
    '',
    copy.listTitle,
    '```',
    command(input, ['list']),
    '```',
    copy.listNote,
  ];

  const usable = input.secrets.filter(secret => grantedExecutors(input, secret.id).length > 0);
  if (!usable.length) {
    lines.push('', copy.noGrant);
    return lines.join('\n');
  }

  lines.push('', copy.useTitle);
  usable.forEach(secret => {
    grantedExecutors(input, secret.id).forEach(executor => {
      lines.push(`${copy.alias} ${secret.alias} · ${copy.executor} ${executor.label}:`);
      lines.push('```');
      lines.push(grantedScriptCommand(input, { secretId: secret.id, executorId: executor.id }));
      lines.push('```');
    });
  });

  lines.push(
    '',
    copy.readTitle,
    copy.readNote,
    '```',
    command(input, ['read', '--secret', usable[0].id]),
    '```',
    copy.readSwap.replace('{{id}}', usable[0].id),
    '',
    copy.exitNote,
  );
  return lines.join('\n');
}
