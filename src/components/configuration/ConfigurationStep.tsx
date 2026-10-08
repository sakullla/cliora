import type { ReactNode } from 'react';
import i18n from '../../i18n';
import styles from './configuration.module.css';

/** Connection editors share one numbered order: connection → sign-in → model. */
export type ConfigurationStepKey = 'connection' | 'login' | 'model';
export const configurationStepOrder: readonly ConfigurationStepKey[] = ['connection', 'login', 'model'];

export function StepHead({ step, title, meta, actions }: { step: ConfigurationStepKey; title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return <div className={styles.stepHead}>
    <span className={styles.stepIndex} aria-hidden="true">{configurationStepOrder.indexOf(step) + 1}</span>
    <span className={styles.stepHeading}>
      <strong className={styles.sectionTitle}>{title}</strong>
      {meta ? <span className={styles.stepMeta}>{meta}</span> : null}
    </span>
    {actions ? <span className={styles.stepActions}>{actions}</span> : null}
  </div>;
}

/** Compact provider · address summary for a step header. Empty values fall back to the native default. */
export function connectionMeta(provider: unknown, baseUrl: unknown, empty = i18n.t('common.provider.metaNative')): ReactNode {
  const id = typeof provider === 'string' ? provider.trim() : '';
  const url = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!id && !url) return empty;
  return <>{id && <code>{id}</code>}{id && url ? ' · ' : ''}{url}</>;
}

/** A numbered card. `label` names the region for assistive technology only when it does not collide with a field label. */
export function ConfigurationStep({ step, title, meta, actions, label, className, hidden, children }: {
  step: ConfigurationStepKey; title: ReactNode; meta?: ReactNode; actions?: ReactNode; label?: string; className?: string; hidden?: boolean; children?: ReactNode;
}) {
  return <section data-config-step={step} aria-label={label} hidden={hidden} className={`${styles.step}${className ? ` ${className}` : ''}`}>
    <StepHead step={step} title={title} meta={meta} actions={actions} />
    {children}
  </section>;
}
