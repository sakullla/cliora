import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';

type OnboardingStep = { id: string; label: string; detail: string; action: string; done: boolean; run: () => void };

/** Non-modal first-run checklist (R5): completion is detected, never blocking or overlaying. */
export function OnboardingCard({ doneTools, doneConfig, doneLaunch, onManageTools, onCreateConfig, onGoLaunch, onClose }: {
  doneTools: boolean;
  doneConfig: boolean;
  doneLaunch: boolean;
  onManageTools: () => void;
  onCreateConfig: () => void;
  onGoLaunch: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const steps: OnboardingStep[] = [
    { id: 'tools', label: t('home.onboarding.stepTools'), detail: t('home.onboarding.stepToolsDetail'), action: t('home.onboarding.goTools'), done: doneTools, run: onManageTools },
    { id: 'config', label: t('home.onboarding.stepConfig'), detail: t('home.onboarding.stepConfigDetail'), action: t('home.onboarding.goConfig'), done: doneConfig, run: onCreateConfig },
    { id: 'launch', label: t('home.onboarding.stepLaunch'), detail: t('home.onboarding.stepLaunchDetail'), action: t('home.onboarding.goLaunch'), done: doneLaunch, run: onGoLaunch },
  ];
  return <section className="onboarding-card" aria-label={t('home.onboarding.label')}>
    <div className="onboarding-head">
      <div>
        <h2>{t('home.onboarding.title')}</h2>
        <p>{t('home.onboarding.hint')}</p>
      </div>
      <Button size="sm" variant="ghost" icon={<Icon name="close" size={14} />} onClick={onClose}>{t('home.onboarding.close')}</Button>
    </div>
    <ol className="onboarding-steps">
      {steps.map((step, index) => <li key={step.id} data-done={step.done || undefined}>
        <span className="onboarding-check" aria-hidden="true">{step.done ? <Icon name="check" size={14} /> : index + 1}</span>
        <span className="onboarding-copy"><strong>{step.label}</strong><small>{step.detail}</small></span>
        <span className="sr-only">{step.done ? t('home.onboarding.done') : t('home.onboarding.pending')}</span>
        <Button size="sm" variant="ghost" className="onboarding-action" onClick={step.run}>{step.action} <span aria-hidden="true">→</span></Button>
      </li>)}
    </ol>
  </section>;
}
