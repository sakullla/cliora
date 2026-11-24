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

const promptCopy = {
  zh: {
    use: '转述时保留占位符。有秘密 MCP 时用 list_secrets 查找授权，向 use_secret 传入匹配的 secretId 和 executorId；否则运行匹配的本机命令。只返回操作结果。',
    missing: '传递测试只验证脚本收到凭据。若需自己登录或调用服务，请用户为所需密码点击「让 AI 使用」，或提供脱敏结果。',
    direct: '任务需要以下凭据时，用本机 read 命令只申请所需项。获准后自行登录或调用指定服务，只回复结果，勿回显或记录密码。拒绝或无法确认即停止。',
    unbound: '以下引用尚无本机 CLI 操作授权',
    sameAction: '同一操作可用于以下密码，仅替换上条命令的 --secret',
    read: '以下脚本授权的引用：仅当用户明确要求查看原值，才用 read_secret（secretIds）或下方的 CLI read。仅保留被点名的 --secret；拒绝或无法确认即停止。',
  },
  en: {
    use: 'Keep placeholders when quoting. If the secret MCP is available, use list_secrets and pass the matching secretId and executorId to use_secret. Otherwise run the matching local command. Return the action result.',
    missing: 'A delivery test only checks that a script receives the credential. To sign in or call a service directly, ask the user to choose “Let AI use” for the credential, or request sanitized results.',
    direct: 'Request only the credentials this task needs with the local read command. After approval, sign in or call the intended service yourself. Return the result without echoing or logging credentials. Stop if approval is denied or unavailable.',
    unbound: 'No local CLI action granted for',
    sameAction: 'Same action for these secrets. Replace only --secret in the command above',
    read: 'For the script-bound references below, use read_secret (secretIds) or CLI read only if the user explicitly asks to see the values. Keep only the requested --secret arguments. Stop if approval is denied or unavailable.',
  },
} as const;

function compactId(id: string) {
  return id.replace(/^urn:uuid:/, '').replaceAll('-', '').toLowerCase();
}

/** Only the outgoing local message receives commands. No credential is fetched here. */
export async function prepareLocalSecretPrompt(
  body: string, load: () => Promise<Pick<ScriptAccessOptions, 'cli' | 'installations' | 'grants' | 'directReads'>>,
  english: boolean,
): Promise<string> {
  const tokens = promptSecretTokens(body);
  if (!tokens.length) return body;
  const { cli, installations, grants, directReads = [] } = await load();
  const copy = promptCopy[english ? 'en' : 'zh'];
  const live = new Set(installations.filter(item => item.kind === 'cli' && !item.targetId && !item.revoked).map(item => item.id));
  // Index just the requested references, retaining their order in the prompt.
  const requested = new Map<string, { spelling: string; grants: typeof grants }>();
  for (const token of tokens) {
    const spelling = token.slice('{{cliora-secret:'.length, -2);
    const id = compactId(spelling);
    if (!requested.has(id)) requested.set(id, { spelling, grants: [] });
  }
  for (const grant of grants) {
    if (live.has(grant.installationId)) requested.get(compactId(grant.secretId))?.grants.push(grant);
  }

  const lines = [body, ''];
  const directInstallations = new Set(installations.filter(item => item.directReadOnly && !item.revoked).map(item => item.id));
  const byInstallation = new Map<string, typeof directReads>();
  const directIds = new Set<string>();
  for (const item of directReads) {
    const id = compactId(item.secretId);
    const reference = requested.get(id);
    if (!directInstallations.has(item.installationId) || !reference) continue;
    directIds.add(id);
    if (!reference.grants.length) requested.delete(id);
    const group = byInstallation.get(item.installationId);
    if (group) group.push(item);
    else byInstallation.set(item.installationId, [item]);
  }
  if (byInstallation.size) {
    lines.push(copy.direct);
    for (const [installationId, items] of byInstallation) {
      lines.push(items.map(item => items.length === 1 ? item.alias : item.alias + ' · ' + item.secretId).join('\n'));
      lines.push(command({ ...cli, installationId }, ['read', ...items.flatMap(item => ['--secret', item.secretId])]));
    }
    if (!requested.size) return lines.join('\n');
  }
  lines.push(copy.use);
  if ([...requested.keys()].some(id => !directIds.has(id))) lines.push(copy.missing);
  const unbound: string[] = [];
  const actions = new Map<string, typeof grants>();
  const readOptions = new Map<string, Set<string>>();
  for (const reference of requested.values()) {
    if (!reference.grants.length) unbound.push(reference.spelling);
    for (const grant of reference.grants) {
      if (!directIds.has(compactId(grant.secretId))) {
        const ids = readOptions.get(grant.installationId) ?? new Set<string>();
        ids.add(grant.secretId);
        readOptions.set(grant.installationId, ids);
      }
      const key = grant.installationId + '/' + grant.executorId;
      const group = actions.get(key);
      if (group) group.push(grant);
      else actions.set(key, [grant]);
    }
  }
  for (const group of actions.values()) {
    const [first, ...others] = group;
    const use = grantedScriptCommand({ ...cli, installationId: first.installationId }, first);
    // Shared actions need one exact invocation. Each alternative below is a
    // verified pair for that same installation and executor.
    if (others.length || (!body.includes(use) && !body.includes(use.replace(/^& /, '')))) {
      lines.push(first.alias + ' · ' + first.executorLabel, use);
    }
    if (others.length) lines.push(copy.sameAction, ...others.map(grant => grant.alias + ' · ' + grant.secretId));
  }
  if (unbound.length) lines.push(copy.unbound + ' · ' + unbound.join(', '));
  if (readOptions.size) lines.push(copy.read);
  // Prefer the installation covering the most references, so an overlapping
  // grant does not split a request that one installation can handle together.
  const assigned = new Set<string>();
  for (const [installationId, ids] of [...readOptions].sort((a, b) => b[1].size - a[1].size)) {
    const group = [...ids].filter(id => !assigned.has(id));
    if (!group.length) continue;
    for (const id of group) assigned.add(id);
    const read = command({ ...cli, installationId }, ['read', ...group.flatMap(id => ['--secret', id])]);
    if (!body.includes(read)) lines.push(read);
  }
  return lines.join('\n');
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

const fallbackCopy = {
  zh: {
    title: '## 栖点秘密代理（本机 CLI）',
    list: '查找可用操作。按名称找到秘密后，可直接转发 reference。',
    use: '仅执行符合任务的操作。以下是一个已授权示例；其他操作使用 list 返回的秘密 id 和对应的 executors[].id。',
    installation: '安装标识',
    noGrant: '此连接尚无已授权操作。可在提示词的「秘密引用」中点「让 AI 使用」，再从本机工作台发送引用。',
    read: '仅当用户明确要求查看原值，用下方示例中的 --secret 指定所需引用；多条一起提交。',
    risk: '调用方可能将原值写入模型上下文或 CLI 记录。工作台 CLI 和 MCP 可选「允许本次会话」，外部终端每次请求都要确认。拒绝或无法确认即停止。',
  },
  en: {
    title: '## Cliora secret broker (local CLI)',
    list: 'Find granted actions by alias. Use the reference field to share a placeholder.',
    use: 'Run an action only if it matches the task. The example uses a granted pair. For other actions use the secret id and its executors[].id from list.',
    installation: 'Installation',
    noGrant: 'This connection has no granted action. Choose “Let AI use” for the credential in Secret references and send the reference from the local workbench.',
    read: 'Only when the user explicitly asks to see values, set --secret to each requested reference in the example below. Submit them together.',
    risk: 'Values may enter the model context and the CLI session history. Workbench CLI and MCP offer “Allow for this session”. External terminals ask each time. Stop if approval is denied or unavailable.',
  },
} as const;

export function buildSecretUsageInstructions(input: SecretUsageInput): string {
  const locale = input.locale === 'en' ? 'en' : 'zh';
  const copy = fallbackCopy[locale];
  const lines = [
    copy.title,
    `${copy.installation}: ${input.installationLabel}`,
    '',
    copy.list,
    '```',
    command(input, ['list']),
    '```',
  ];
  // A general-purpose guide stays compact even when this installation has
  // hundreds of grants. The list command remains the source of all valid pairs.
  const secrets = new Map(input.secrets.map(secret => [secret.id, secret]));
  const executors = new Map(input.executors.map(executor => [executor.id, executor]));
  const example = input.grants.find(grant => secrets.has(grant.secretId) && executors.has(grant.executorId));
  if (!example) return [...lines, '', copy.noGrant].join('\n');
  lines.push(
    '',
    copy.use,
    `${secrets.get(example.secretId)!.alias} · ${executors.get(example.executorId)!.label}`,
    '```',
    grantedScriptCommand(input, example),
    '```',
    promptCopy[locale].missing,
    '',
    copy.read,
    '```',
    command(input, ['read', '--secret', example.secretId]),
    '```',
    copy.risk,
  );
  return lines.join('\n');
}
