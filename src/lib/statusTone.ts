/** Visual tone shared by Badge and StatusBadge. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface StatusPresentation {
  tone: Tone;
  /** Existing i18n key of the visible label. */
  labelKey: string;
}

const status = (tone: Tone, labelKey: string): StatusPresentation => ({ tone, labelKey });

/**
 * One table for the domain states pages show as badges, so the same state reads the same
 * on every page. Keys reuse the labels the pages already render.
 */
export const statusTable = {
  // Configuration rows: the applied profile, a saved profile waiting to apply, a saved one.
  profile: {
    active: status('success', 'tools.workspace.stateActive'),
    pending: status('warning', 'tools.workspace.statePending'),
    saved: status('neutral', 'tools.workspace.stateSaved'),
  },
  // Managed tool rows on the home page (data-state ok / warn / error / loading).
  managedTool: {
    ok: status('success', 'home.tools.statusInstalled'),
    warn: status('warning', 'home.tools.statusProbeFailed'),
    error: status('danger', 'home.tools.statusFailed'),
    loading: status('info', 'home.tools.statusChecking'),
    missing: status('neutral', 'home.tools.statusNotFound'),
  },
  account: {
    signed_in: status('success', 'tools.accounts.state.signed_in'),
    pending: status('info', 'tools.accounts.state.pending'),
    signed_out: status('neutral', 'tools.accounts.state.signed_out'),
    expired: status('warning', 'tools.accounts.state.expired'),
    error: status('danger', 'tools.accounts.state.error'),
    unknown: status('neutral', 'tools.accounts.state.unknown'),
  },
  plugin: {
    installed_load_unknown: status('success', 'tools.plugins.state.installed_load_unknown'),
    configured_load_unknown: status('info', 'tools.plugins.state.configured_load_unknown'),
    discovered_load_unknown: status('info', 'tools.plugins.state.discovered_load_unknown'),
    disabled: status('neutral', 'tools.plugins.state.disabled'),
    state_unknown: status('warning', 'tools.plugins.state.state_unknown'),
    inventory_pending: status('info', 'tools.plugins.state.inventory_pending'),
    not_installed: status('neutral', 'tools.plugins.state.not_installed'),
  },
  skill: {
    installed: status('success', 'tools.skills.stateInstalled'),
    update: status('info', 'tools.skills.stateUpdate'),
    conflict: status('warning', 'tools.skills.stateConflict'),
    disabled: status('neutral', 'tools.skills.stateDisabled'),
    missing: status('danger', 'tools.skills.stateMissing'),
    not_installed: status('neutral', 'tools.skills.stateNotInstalled'),
    external: status('neutral', 'tools.skills.stateExternal'),
    read_only: status('neutral', 'tools.skills.stateReadOnly'),
    unreadable: status('warning', 'tools.skills.stateUnreadable'),
  },
  session: {
    working: status('accent', 'sessions.stateWorking'),
    streaming: status('accent', 'sessions.stateStreaming'),
    idle: status('neutral', 'sessions.stateIdle'),
    error: status('danger', 'sessions.stateError'),
  },
  // The sync pill in 迁移与同步.
  sync: {
    on: status('success', 'settings.webdav.syncOn'),
    off: status('neutral', 'settings.webdav.syncOff'),
    error: status('danger', 'settings.webdav.statusError'),
    not_connected: status('neutral', 'settings.webdav.notConnected'),
  },
  quota: {
    stale: status('warning', 'tools.quota.stale'),
  },
} as const satisfies Record<string, Record<string, StatusPresentation>>;

export type StatusDomain = keyof typeof statusTable;
export type StatusState<D extends StatusDomain> = keyof (typeof statusTable)[D] & string;

export function statusTone<D extends StatusDomain>(domain: D, state: StatusState<D>): StatusPresentation {
  return (statusTable[domain] as Record<string, StatusPresentation>)[state];
}
