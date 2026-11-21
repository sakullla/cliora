import type { SecretInstallationKind } from '../types/secrets';

/**
 * The CLI usage text a user inserts into a prompt.
 *
 * It is built from local metadata only: the executable, the installation id and the
 * granted secret/executor pairs. Nothing here is guessed, so a reader can copy a
 * command without inventing a flag, an id or an argument order. A value never
 * appears: `use` hands it to the registered executor, and `read` asks the user.
 */

export type SecretUsageSecret = { id: string; alias: string };
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

function command(input: SecretUsageInput, rest: string[]): string {
  return [input.executable, input.entry, '--installation', input.installationId, ...rest].map(quoteArgument).join(' ');
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
    listNote: '输出是 JSON：每个秘密带别名、状态和可用的执行入口；状态不是 available 表示本机缺少原值。',
    useTitle: '### 2. 受控使用（原值只进入执行入口，输出里的原值会被遮蔽）',
    alias: '别名',
    executor: '执行入口',
    noGrant: '当前安装标识还没有任何已授权的秘密与执行入口，请先在资料库的“秘密引用”里授权。',
    readTitle: '### 3. 读取原值（每次都要在栖点确认）',
    readNote: '只有确认后，本次命令的 stdout 才返回原值；原值可能进入模型上下文与 CLI 会话记录。',
    readSwap: '把 {{id}} 换成第 1 步里对应秘密的标识；拒绝、超时或窗口不可用都不会返回原值。',
    exitNote: '命令失败时退出码非零，结果里只有遮蔽后的文本；不会改成别的秘密，也不会重试成别的执行入口。',
  },
  en: {
    title: '## Cliora secret broker (local CLI)',
    installation: 'Installation',
    executable: 'Executable',
    intro: 'Every command runs through the local secret broker. The value stays in the local credential store; the arguments carry identifiers only.',
    listTitle: '### 1. List the secrets you may use',
    listNote: 'The output is JSON: each secret carries its alias, status and usable executors. A status other than available means this device lacks the value.',
    useTitle: '### 2. Controlled use (the value only reaches the executor, and it is masked in the output)',
    alias: 'Alias',
    executor: 'Executor',
    noGrant: 'This installation has no granted secret and executor yet. Grant one in the library under secret references first.',
    readTitle: '### 3. Read the value (each read asks for confirmation in Cliora)',
    readNote: 'Only an accepted confirmation returns the value on this command stdout. The value may enter the model context and the CLI session history.',
    readSwap: 'Replace {{id}} with the identifier of the secret from step 1. A refused, expired or unavailable confirmation returns no value.',
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
      lines.push(command(input, ['use', '--secret', secret.id, '--executor', executor.id]));
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
