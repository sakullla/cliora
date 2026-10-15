// First-run onboarding facts (R5). One plain localStorage flag per fact, following the
// sidebar-collapse precedent; both markers are device-local and never join migration
// bundles or WebDAV sync. Steps 1-2 derive from live application data, not copies.

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
 * Records the first launch made through Cliora (step 3). The backend keeps no launch log
 * or event, so the frontend owns this single fact; native.ts marks it inside the two
 * launch commands so every call site is covered without per-surface plumbing.
 */
export function markOnboardingLaunched() {
  if (readOnboardingLaunched()) return;
  try { localStorage.setItem(ONBOARDING_LAUNCHED_KEY, 'true'); } catch { /* Keep at least the in-session event below. */ }
  window.dispatchEvent(new CustomEvent(ONBOARDING_LAUNCHED_EVENT));
}
