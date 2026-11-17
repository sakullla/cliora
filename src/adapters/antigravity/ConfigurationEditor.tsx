import { useTranslation } from 'react-i18next';
import type { ConfigurationContentProps } from '../contract';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import styles from '../../components/configuration/configuration.module.css';

// Backend-proven view shape: typed values of the verified persisted keys plus
// the session-only launch flags (1.5.9 evidence), which never persist and are
// presented as reference data instead of settings fields.
type LaunchParameter = { id: string; flag: string; values: string[]; channel: string };
type View = { values?: Record<string, unknown>; launchParameters?: LaunchParameter[]; typedSettings?: boolean };
const english: Record<string, string> = {
  model: 'Model display name',
  trustedWorkspaces: 'Trusted workspaces',
};
const descriptions: Record<string, { zh: string; en: string }> = {
  model: {
    zh: '原生 /model 面板持久化的模型显示名（如 Gemini 4 Carbon (Medium)）；未设置时跟随 agy 默认。',
    en: 'Display name the native /model panel persists (for example Gemini 4 Carbon (Medium)); unset follows the agy default.',
  },
  trustedWorkspaces: {
    zh: '文件夹信任提示写入的路径列表（JSON 字符串数组，每项一个工作区路径）。',
    en: 'Folder-trust prompt path list (a JSON array of workspace path strings).',
  },
};

export function AntigravityConfigurationEditor(props: ConfigurationContentProps) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith('en');
  const view = (props.draft.view ?? {}) as View;
  const launchParameters = view.launchParameters ?? [];
  // The typed keys are verified on the 1.5 line only. 1.3.x and unverified
  // installations keep the raw JSON editor and never see a typed write.
  const typed = view.typedSettings === true;
  if (!typed) {
    return <section className={styles.controls} aria-label="Antigravity">
      <p>{en
        ? 'This installation is not a verified agy 1.5 build, so the typed settings fields are disabled. Edit settings.json in the raw tab; unsupported and unverified keys are never rebuilt.'
        : '当前安装未核验为 agy 1.5，类型化设置字段已停用。请在“原生文本”中编辑 settings.json；不会重建未支持或未核验的键。'}</p>
    </section>;
  }
  const channelCopy = (parameter: LaunchParameter) => {
    if (parameter.channel === 'project_model') {
      return en
        ? 'Set through the project model preference; Cliora passes it as --model on every launch of that project.'
        : '在项目的模型偏好中设置后，Cliora 每次启动该项目会话都会以 --model 传入所选值。';
    }
    if (parameter.channel === 'launch_dialog') {
      return en
        ? 'Pick the agent in the launch dialog; only roster (main) agents are selectable.'
        : '在启动对话框选择；仅主 Agent（roster）名单可选。';
    }
    return en
      ? 'Verified flag with no Cliora launch channel yet; use it natively inside an agy session when needed.'
      : '已实证的原生参数，暂无 Cliora 启动通道；需要时请在 agy 会话内原生使用。';
  };
  return <section className={styles.controls} aria-label="Antigravity">
    <p>{en
      ? 'Antigravity signs in through its native browser login. These settings never touch account credentials; unsupported native keys stay in the raw JSON editor.'
      : 'Antigravity 使用原生浏览器登录。这些设置不会更改账号凭据；未支持的原生键仍可在原生 JSON 编辑中修改。'}</p>
    <div className={styles.fieldGrid}>{props.descriptor.fields.map(field => {
      const value = view.values?.[field.id];
      const target = 'settings';
      const run = (operation: string, value: unknown = null) => props.onAction({ version: props.descriptor.version, target, operation, field: field.id, value });
      const description = descriptions[field.id];
      return <ConfigurationField
        key={`${props.draft.sessionId}:${field.id}`}
        field={{ ...field, label: en ? english[field.id] ?? field.label : field.label }}
        value={value}
        resetEpoch={props.rawResetEpoch}
        disabled={props.disabled}
        presentation={{ origin: field.origin, nativeField: `${target}.${field.id}`, ...(description ? { description: en ? description.en : description.zh } : {}) }}
        issues={props.draft.issues.filter(issue => issue.field === field.id)}
        onChange={next => (field.kind !== 'json' && next === '' ? run('reset') : run('set', next))}
        onReset={() => run('reset')}
        onValidityChange={valid => props.onValidityChange(field.id, valid)}
      />;
    })}</div>
    <details className={styles.disclosureCard}>
      <summary>{en ? 'Session-only launch parameters (never written to settings.json)' : '会话启动参数（仅当前会话，不写入 settings.json）'}</summary>
      <p>{en
        ? 'Verified on agy 1.5.9: these flags apply to the current session only and the native /config panel never saves them, so they are kept clearly apart from the persisted fields above.'
        : '以下参数已在 agy 1.5.9 实证：仅对当次会话生效，原生 /config 面板不会保存它们，因此与上方持久化设置明确区分。'}</p>
      <ul>{launchParameters.map(parameter => <li key={parameter.flag}>
        <code>{parameter.flag}</code>{parameter.values.length ? ` ${parameter.values.join(' | ')}` : ' <id-or-name>'}
        <small>{channelCopy(parameter)}</small>
      </li>)}</ul>
    </details>
  </section>;
}
