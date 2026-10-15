import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import type { LaunchRequest, LaunchResult } from '../../types/launch';
import { Icon } from '../../components/Icon';

// One plain localStorage flag per fact, following the sidebar-collapse precedent (ADR-5).
// Both markers are device-local: they never join migration bundles or WebDAV sync.
const ONBOARDING_COMPLETE_KEY = 'cliora:onboarding-complete';
const ONBOARDING_LAUNCHED_KEY = 'cliora:onboarding-launched';
/** In-window notification used by App to refresh step 3 state in the same session. */
export const ONBOARDING_LAUNCHED_EVENT = 'cliora:onboarding-launched';

export function readOnboardingComplete(): boolean {
  try { return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === 'true'; } catch { return false; }
}

/** Closing the card and finishing all three steps share one completion marker. */
export function completeOnboarding() {
  try { localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true'); } catch { /* Without storage the card simply reappears next launch. */ }
}

/** The settings entry clears only the completion marker; the launch fact stays recorded. */
export function reopenOnboarding() {
  try { localStorage.removeItem(ONBOARDING_COMPLETE_KEY); } catch { /* Nothing to reopen without storage. */ }
}

export function readOnboardingLaunched(): boolean {
  try { return localStorage.getItem(ONBOARDING_LAUNCHED_KEY) === 'true'; } catch { return false; }
}

/**
 * Records the first launch made through Cliora (step 3). The backend keeps no launch
 * log or event, so the frontend owns this single fact; steps 1-2 stay derived from
 * live application data and keep no private copy.
 */
export function markOnboardingLaunched() {
  if (readOnboardingLaunched()) return;
  try { localStorage.setItem(ONBOARDING_LAUNCHED_KEY, 'true'); } catch { /* Keep at least the in-session event below. */ }
  window.dispatchEvent(new CustomEvent(ONBOARDING_LAUNCHED_EVENT));
}

// The same two commands are called from several surfaces (home tool rows, project
// launcher, tool workspace, library launches, records/palette resumes). Wrapping each
// command once here records a successful launch for every call site, without threading
// onboarding state through the callers.
type Tracked = { __clioraOnboardingTracked?: boolean };
const rawLaunchCli = native.launchCli as ((request: LaunchRequest) => Promise<LaunchResult>) & Tracked;
if (!rawLaunchCli.__clioraOnboardingTracked) {
  const trackedLaunchCli = (async (request: LaunchRequest) => {
    const result = await rawLaunchCli(request);
    markOnboardingLaunched();
    return result;
  }) as ((request: LaunchRequest) => Promise<LaunchResult>) & Tracked;
  trackedLaunchCli.__clioraOnboardingTracked = true;
  native.launchCli = trackedLaunchCli;
}
const rawResumeHistorySession = native.resumeHistorySession as ((id: string, mode: LaunchRequest['mode']) => Promise<LaunchResult>) & Tracked;
if (!rawResumeHistorySession.__clioraOnboardingTracked) {
  const trackedResumeHistorySession = (async (id: string, mode: LaunchRequest['mode']) => {
    const result = await rawResumeHistorySession(id, mode);
    markOnboardingLaunched();
    return result;
  }) as ((id: string, mode: LaunchRequest['mode']) => Promise<LaunchResult>) & Tracked;
  trackedResumeHistorySession.__clioraOnboardingTracked = true;
  native.resumeHistorySession = trackedResumeHistorySession;
}

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
      <button type="button" className="text-button" onClick={onClose}><Icon name="close" size={13} strokeWidth={2} />{t('home.onboarding.close')}</button>
    </div>
    <ol className="onboarding-steps">
      {steps.map((step, index) => <li key={step.id} data-done={step.done || undefined}>
        <span className="onboarding-check" aria-hidden="true">{step.done ? <Icon name="check" size={13} strokeWidth={2.4} /> : index + 1}</span>
        <span className="onboarding-copy"><strong>{step.label}</strong><small>{step.detail}</small></span>
        <span className="sr-only">{step.done ? t('home.onboarding.done') : t('home.onboarding.pending')}</span>
        <button type="button" className="text-button" onClick={step.run}>{step.action} <span aria-hidden="true">→</span></button>
      </li>)}
    </ol>
  </section>;
}
