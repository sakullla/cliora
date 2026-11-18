import { useTranslation } from 'react-i18next';
import type { ConfigurationContentProps } from '../contract';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import styles from '../../components/configuration/configuration.module.css';

// Backend-proven view shape: typed values of the verified persisted keys plus
// the typed-form flag. Session-only launch parameters are selected in the
// project launch surface, never as settings fields.
type View = { values?: Record<string, unknown>; typedSettings?: boolean };
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
    <p>{en
      ? 'Execution mode and reasoning effort are session launch parameters: choose them in the project launch selectors; they apply to that launch only and are never written to settings.json.'
      : '执行模式与推理强度是会话启动参数：在项目卡的启动选择器中选择，仅对当次启动生效，不会写入 settings.json。'}</p>
  </section>;
}
