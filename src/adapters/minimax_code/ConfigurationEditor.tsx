import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigurationContentProps } from '../contract';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import { ConfigurationStep } from '../../components/configuration/ConfigurationStep';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import { useEditorAction } from '../../components/configuration/ModelEditorControls';
import shared from '../../components/configuration/configuration.module.css';
import styles from './ConfigurationEditor.module.css';

type View = {
  providerId?: string;
  providers?: string[];
  model?: string;
  baseUrl?: string;
  interfaceFormat?: string;
  addressLocked?: boolean;
  formatLocked?: boolean;
  permissionMode?: string;
};

const target = { kind: 'connection' };

export function MiniMaxCodeConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}

function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const action = useEditorAction(props, 'mcode-actions');
  const view = (props.draft.view ?? {}) as View;
  const provider = view.providerId || 'token_plan';
  const providers = view.providers ?? [];
  const blocked = props.disabled || action.pending || props.pending;
  const customNameId = useId();
  const [customName, setCustomName] = useState('');
  const field = (id: string) => props.descriptor.fields.find(item => item.id === id);
  const baseUrl = field('baseUrl');
  const model = field('model');
  const permission = field('permissionMode');
  async function commit(fieldId: string, value: unknown, operation = 'set') {
    const ok = await action.run(target, operation, value, fieldId);
    if (!ok) throw new Error(t('tools.adapters.minimaxCode.writeFailed'));
  }
  const known = provider === 'token_plan' || provider === 'minimax' || providers.includes(provider);
  return <section className={styles.editor} aria-label={t('tools.adapters.minimaxCode.label')}>
    <div hidden={props.section === 'settings'}>
      <ConfigurationStep step="connection" title={t('common.provider.title')} meta={<code>{provider}</code>}>
        <div className={shared.fieldGrid}>
          <label>{t('tools.adapters.minimaxCode.provider')}
            <select aria-label={t('tools.adapters.minimaxCode.provider')} value={known ? provider : ''} disabled={blocked} onChange={event => {
              const next = event.target.value;
              const write = next === 'token_plan' ? commit('source', 'token_plan')
                : next === 'minimax' ? commit('source', 'minimax_api_key')
                : commit('provider', next);
              void write.catch(() => undefined);
            }}>
              <option value="token_plan">{t('tools.adapters.minimaxCode.tokenPlan')}</option>
              <option value="minimax">{t('tools.adapters.minimaxCode.apiKey')}</option>
              {providers.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <div>
            <label htmlFor={customNameId}>{t('tools.adapters.minimaxCode.customName')}</label>
            <span className={styles.row}>
              <input id={customNameId} aria-label={t('tools.adapters.minimaxCode.customName')} value={customName} disabled={blocked} placeholder={t('tools.adapters.minimaxCode.customNamePlaceholder')} spellCheck={false} onChange={event => setCustomName(event.target.value)} />
              <button type="button" disabled={blocked || !customName.trim()} onClick={() => { void commit('provider', customName.trim()).catch(() => undefined); }}>{t('tools.adapters.minimaxCode.useCustom')}</button>
            </span>
          </div>
          {view.addressLocked || !baseUrl ? <label className={shared.span}>{t('common.provider.baseUrl')}<input aria-label={t('common.provider.baseUrl')} value={view.baseUrl ?? ''} disabled readOnly /></label>
            : <div className={shared.span}><ConfigurationField field={baseUrl} value={view.baseUrl ?? ''} disabled={blocked} presentation={{ placeholder: 'https://api.minimaxi.com/anthropic' }} onChange={value => commit('baseUrl', value)} onReset={() => commit('baseUrl', null, 'reset')} onValidityChange={valid => props.onValidityChange('baseUrl', valid)} /></div>}
          <label>{t('tools.adapters.minimaxCode.format')}
            <select aria-label={t('tools.adapters.minimaxCode.format')} value={view.interfaceFormat || 'anthropic_messages'} disabled={blocked || view.formatLocked} onChange={event => { void commit('interfaceFormat', event.target.value).catch(() => undefined); }}>
              <option value="anthropic_messages">Anthropic Messages</option>
              <option value="openai_completions">OpenAI Chat Completions</option>
              <option value="openai_responses">OpenAI Responses</option>
            </select>
          </label>
        </div>
        {view.addressLocked && <p className={styles.note}>{t('tools.adapters.minimaxCode.addressLocked')}</p>}
        {view.formatLocked && <p className={styles.note}>{t('tools.adapters.minimaxCode.formatLocked')}</p>}
      </ConfigurationStep>
      <ConnectionCredential />
      <ConfigurationStep step="model" title={t('common.models.title')} meta={view.model ? <code>{view.model}</code> : undefined}>
        {model && <ConfigurationField field={model} value={view.model ?? ''} disabled={blocked} presentation={{ combobox: true, placeholder: 'MiniMax-M2', catalog: props.catalog ? { supported: props.catalog.supported, busy: props.catalog.busy, fetch: props.catalog.fetch, error: props.catalog.error } : undefined }} onChange={value => commit('model', value)} onValidityChange={valid => props.onValidityChange('model', valid)} />}
        <p className={styles.note}>{t('tools.adapters.minimaxCode.modelHint')}</p>
      </ConfigurationStep>
    </div>
    <div hidden={props.section !== 'settings'}>
      <details className={shared.disclosureCard} open>
        <summary>{t('tools.adapters.minimaxCode.permissionSummary')}</summary>
        {permission && <ConfigurationField field={permission} value={view.permissionMode ?? ''} disabled={blocked} onChange={value => commit('permissionMode', value)} onReset={() => commit('permissionMode', null, 'reset')} onValidityChange={valid => props.onValidityChange('permissionMode', valid)} />}
      </details>
    </div>
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('tools.adapters.shared.cancelOperation')}</button></div>}
  </section>;
}
