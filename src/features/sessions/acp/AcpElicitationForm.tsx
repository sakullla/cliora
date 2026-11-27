import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpElicitation, AcpElicitationField } from '../../../types/acp';
import { fieldChoices, initialFormValues, validateForm, type FormErrors, type FormValue } from './composerModel';
import { visibleControls } from './acpView';
import styles from './acpComposer.module.css';
import cardStyles from './acp.module.css';

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

function inputType(field: AcpElicitationField): string {
  if (field.type === 'number' || field.type === 'integer') return 'number';
  switch (field.format) {
    case 'email': return 'email';
    case 'uri': return 'url';
    case 'date': return 'date';
    default: return 'text';
  }
}

/**
 * A structured question the agent asked, as a form. Every field follows its schema
 * (text with its format, numbers, a switch, a single or multiple choice); a value
 * that does not fit is marked and nothing is sent. Decline and cancel each send
 * their own answer. The answer is sent once; the card closes when the host confirms.
 */
export function AcpElicitationForm({ item, toolName, answerable, onRespond }: {
  item: AcpElicitation;
  toolName: string;
  answerable: boolean;
  onRespond: (requestId: string, action: ElicitationAction, content: Record<string, unknown> | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const schema = item.requestedSchema ?? { properties: {} };
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialFormValues(schema));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {});
  const disabled = !answerable || !!busy || !item.requestId;

  function update(name: string, value: FormValue) {
    setValues((current) => ({ ...current, [name]: value }));
    if (errors[name]) setErrors((current) => { const next = { ...current }; delete next[name]; return next; });
  }

  async function respond(action: ElicitationAction) {
    if (disabled || !item.requestId) return;
    let content: Record<string, unknown> | null = null;
    if (action === 'accept') {
      const checked = validateForm(schema, values);
      setErrors(checked.errors);
      if (!checked.content) return;
      content = checked.content;
    }
    setBusy(action);
    setFailure('');
    try { await onRespond(item.requestId, action, content); }
    catch (value) { setFailure(String((value as { message?: string })?.message ?? value)); }
    finally { setBusy(''); }
  }

  const errorCount = Object.keys(errors).length;

  function fieldView(name: string, field: AcpElicitationField) {
    const id = `${formId}-${name}`;
    const label = field.title || name;
    const error = errors[name];
    const describedBy = [field.description ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
    const value = values[name];
    const head = <span className={styles.fieldHead}>{label}{required.has(name) && <span className={styles.fieldRequired} aria-hidden="true">*</span>}</span>;
    const hint = field.description ? <span id={`${id}-hint`} className={styles.fieldHint}>{visibleControls(field.description)}</span> : null;
    const message = error ? <span id={`${id}-error`} className={styles.fieldError}>{t(error.key, error.values)}</span> : null;
    if (field.type === 'boolean') {
      return <div key={name} className={styles.field} data-field={name}>
        <label className={styles.fieldInline}>
          <input type="checkbox" role="switch" checked={value === true} disabled={disabled} aria-describedby={describedBy} onChange={(event) => update(name, event.currentTarget.checked)} />
          {head}
        </label>
        {hint}{message}
      </div>;
    }
    if (field.type === 'array') {
      const choices = fieldChoices(field.items ?? {});
      const list = Array.isArray(value) ? value : [];
      return <fieldset key={name} className={styles.field} data-field={name} aria-invalid={!!error || undefined} aria-describedby={describedBy}>
        <legend>{head}</legend>
        <div className={styles.fieldChoices}>
          {choices.map((choice) => <label key={choice.value} className={styles.fieldInline}>
            <input type="checkbox" checked={list.includes(choice.value)} disabled={disabled} onChange={(event) => update(name, event.currentTarget.checked ? [...list, choice.value] : list.filter((entry) => entry !== choice.value))} />
            <span>{choice.title}</span>
          </label>)}
        </div>
        {hint}{message}
      </fieldset>;
    }
    const choices = fieldChoices(field);
    if (choices.length) {
      return <div key={name} className={styles.field} data-field={name}>
        <label htmlFor={id}>{head}</label>
        <span className={`${styles.selectWrap} ${styles.fieldSelect}`}><select id={id} className={styles.fieldInput} value={typeof value === 'string' ? value : ''} disabled={disabled} aria-required={required.has(name) || undefined} aria-invalid={!!error || undefined} aria-describedby={describedBy} onChange={(event) => update(name, event.currentTarget.value)}>
          <option value="">{t('sessions.acpFormChoose')}</option>
          {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.title}</option>)}
        </select></span>
        {hint}{message}
      </div>;
    }
    return <div key={name} className={styles.field} data-field={name}>
      <label htmlFor={id}>{head}</label>
      <input id={id} className={styles.fieldInput} type={inputType(field)} inputMode={field.type === 'integer' ? 'numeric' : field.type === 'number' ? 'decimal' : undefined}
        step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
        value={typeof value === 'string' ? value : ''} disabled={disabled} aria-required={required.has(name) || undefined} aria-invalid={!!error || undefined} aria-describedby={describedBy}
        onChange={(event) => update(name, event.currentTarget.value)} />
      {hint}{message}
    </div>;
  }

  return <form className={`${cardStyles.card} ${styles.form}`} data-item-id={item.id} data-card="elicitation" data-decision={item.decision} data-request-id={item.requestId ?? undefined}
    aria-label={t('sessions.acpElicitationTitle', { tool: toolName })} noValidate onSubmit={(event) => { event.preventDefault(); void respond('accept'); }}>
    <div className={cardStyles.cardHead}>
      <strong className={cardStyles.cardTitle}><Icon name="info" size={13} />{t('sessions.acpElicitationTitle', { tool: toolName })}</strong>
      <span className={cardStyles.cardTag}>{t('sessions.acpCardElicitation')}</span>
    </div>
    <p className={cardStyles.plainText}>{visibleControls(item.message)}</p>
    {fields.map(([name, field]) => fieldView(name, field))}
    {errorCount > 0 && <p className={styles.error} role="alert">{t('sessions.acpFormInvalid', { count: errorCount })}</p>}
    {failure && <p className={styles.error} role="alert">{failure}</p>}
    <div className={cardStyles.cardActions}>
      <button type="submit" className={cardStyles.action} data-variant="primary" disabled={disabled}>{t('sessions.acpFormSubmit')}</button>
      <button type="button" className={cardStyles.action} disabled={disabled} onClick={() => void respond('decline')}>{t('sessions.acpFormDecline')}</button>
      <button type="button" className={cardStyles.action} data-variant="quiet" disabled={disabled} onClick={() => void respond('cancel')}>{t('sessions.acpFormCancel')}</button>
    </div>
  </form>;
}
