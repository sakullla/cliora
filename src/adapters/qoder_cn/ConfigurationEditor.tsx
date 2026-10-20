import { useTranslation } from 'react-i18next';
import type { ConfigurationContentProps } from '../contract';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import styles from '../../components/configuration/configuration.module.css';

type View = { values?: Record<string, unknown>; targets?: Record<string, string>; commonFields?: { id: string; value: unknown; target: string }[] };
const english: Record<string, string> = {
  'model.name': 'Model', 'model.reasoningEffort': 'Reasoning effort',
  'general.defaultPermissionMode': 'Default permission mode', 'ui.language': 'Display language',
  autoMemoryEnabled: 'Project auto memory', autoMemoryUserScopeEnabled: 'User auto memory',
};

export function QoderConfigurationEditor(props: ConfigurationContentProps) {
  const { i18n } = useTranslation();
  const en = i18n.language.startsWith('en');
  const view = (props.draft.view ?? {}) as View;
  return <section className={styles.controls} aria-label="Qoder CN">
    <p>{en ? 'Qoder CN uses its native account login. These settings do not change account credentials.' : 'Qoder CN 使用原生账号登录。这些设置不会更改账号凭据。'}</p>
    <div className={styles.fieldGrid}>{props.descriptor.fields.map(field => {
      const common = view.commonFields?.find(item => item.id === field.id);
      const value = props.mode === 'common' ? common?.value : view.values?.[field.id];
      const target = common?.target ?? view.targets?.[field.id] ?? 'settings';
      const memory = field.kind === 'boolean';
      const on = en ? 'Enabled' : '启用';
      const off = en ? 'Disabled' : '停用';
      const run = (operation: string, value: unknown = null) => props.onAction({ version: props.descriptor.version, target, operation, field: field.id, value });
      const nativeDefault = en ? 'Native default' : '原生默认';
      return <div key={`${props.draft.sessionId}:${field.id}`}>
        <ConfigurationField field={{ ...field, label: en ? english[field.id] ?? field.label : field.label, ...(memory ? { kind: 'string', choices: [on, off] } : {}), defaultSource: nativeDefault }}
          value={memory ? value == null ? null : value === true ? on : off : value}
          resetEpoch={props.rawResetEpoch} disabled={props.disabled}
          presentation={{ origin: props.mode === 'common' ? value == null ? 'unset' : 'explicit' : field.origin, nativeField: `${target}.${field.id}` }}
          issues={props.draft.issues.filter(issue => issue.field === field.id)}
          onChange={next => run(next === '' ? 'reset' : 'set', memory ? next === on : next)} onReset={() => run('reset')}
          onValidityChange={valid => props.onValidityChange(field.id, valid)} />
        {memory && value == null && <small>{en ? 'Follows the native default; the effective state is unknown.' : '跟随原生默认，当前生效状态未知。'}</small>}
        {target === 'local_settings' && <small>{en ? 'The local project override takes precedence.' : '当前值来自项目本地覆盖，优先于项目共享设置。'}</small>}
      </div>;
    })}</div>
    <p>{en ? 'Available models and reasoning levels depend on your account and model. Memory switches apply to the project and user scopes separately; restart the CLI session after changing them.' : '可用模型与推理档位取决于账号和模型。记忆开关分别控制项目与用户范围；修改后请重新启动 CLI 会话。'}</p>
  </section>;
}
