import { useEffect, useRef } from 'react';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import type { ConfigurationEditorProps } from '../../types/configuration';
import styles from './ConfigurationEditor.module.css';

type View = { values?: Record<string, unknown>; defaultAddressReason?: string | null; effortChoices?: string[]; capabilitySource?: string };
export function CodexConfigurationEditor({ draft, descriptor, disabled, onAction, onValidityChange }: ConfigurationEditorProps) {
  const view = draft.view as View | null;
  const values = view?.values ?? {};
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  useEffect(() => () => { for (const field of descriptor.fields) validity.current(field.id, true); }, [draft.sessionId, descriptor]);
  const render = (id: string) => {
    const field = descriptor.fields.find(field => field.id === id);
    if (!field) return null;
    const target = id === 'base_url' ? String(values.model_provider ?? 'openai') : 'configuration';
    const action = (operation: string, value: unknown = null) => onAction({ version: descriptor.version, target, operation, field: id, value });
    const metadata = id === 'model_reasoning_effort' ? { ...field, choices: view?.effortChoices ?? [] } : field;
    const builtinAddress = id === 'base_url' && ['openai', 'ollama', 'lmstudio'].includes(target);
    return <ConfigurationField key={`${draft.sessionId}:${id}:${target}`} field={builtinAddress ? { ...metadata, unavailableReason: '内置供应商使用 Codex 原生地址；自定义连接请填写独立供应商 ID' } : metadata}
      value={values[id]} disabled={disabled} issues={draft.issues.filter(issue => issue.field === id)}
      onChange={value => value === '' ? action('reset') : action('set', value)} onReset={() => action('reset')}
      onValidityChange={valid => onValidityChange(id, valid)} />;
  };
  return <section className={styles.editor} aria-label="Codex 专属配置">
    {render('model')}
    <details><summary>供应商连接</summary><div className={styles.fields}>{render('model_provider')}{render('base_url')}{view?.defaultAddressReason && <p className={styles.note}>{view.defaultAddressReason}</p>}</div></details>
    <details><summary>模型参数</summary><p className={styles.note}>{view?.capabilitySource}。这些参数作用于当前配置，不为每个模型单独生成记录。</p>
      <div className={styles.fields}>{['model_reasoning_effort', 'model_context_window', 'model_reasoning_summary', 'model_verbosity'].map(render)}</div>
    </details>
  </section>;
}
