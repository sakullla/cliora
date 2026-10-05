export type AccountState = 'signed_out' | 'pending' | 'signed_in' | 'expired' | 'error' | 'unknown';
export type NativeLogin = { provider: string; authKind: 'oauth' | 'api_key'; state: AccountState; identity: AccountIdentity | null; detail: string | null; managedAccountId: string | null };
export type NativeLoginSnapshot = { toolId: string; logins: NativeLogin[]; checkedAt: number };
export type AccountIdentity = { subject: string; email: string | null; plan: string | null; source: string };
export type NativeContext = {
  id: string; toolId: string; root: string; configRoot: string; authFiles: string[];
  historyRoots: string[]; resourceRoot: string; environment: Record<string, string>;
  removeEnvironment: string[]; cliArgs: string[];
};
export type PendingLogin = {
  id: string; expiresAt: number; context: NativeContext; previousState: AccountState;
  externalTerminal: boolean; operation: 'login' | 'logout';
};
export type AuthAccount = {
  id: string; toolId: string; provider: string; label: string; version: number;
  state: AccountState; identity: AccountIdentity | null; context: NativeContext | null; retiredContexts: NativeContext[];
  pendingLogin: PendingLogin | null; checkedAt: number | null; detail: string | null;
};
export type AccountCapability = {
  browserLink?: boolean;
  toolId: string; provider: string; version: string; managedLogin: boolean; importNative: boolean;
  methods: ('browser' | 'device')[]; reason: string; identitySource: string;
  refreshOwner: 'native_cli'; acceptance: string;
};

export type AccountImpactContextKind = 'current' | 'retained' | 'pending' | 'unknown' | 'none';
export type AccountImpactContext = { id: string; kind: AccountImpactContextKind };
export type AccountImpactProfile = { id: string; name: string; toolId: string; version: number; revision: string };
export type AccountReapplyRequest = {
  accountId: string; expectedAccountVersion: number; expectedContextId: string;
  toolId: string; profileId: string; expectedProfileVersion: number; expectedProfileRevision: string;
  scope: 'global' | 'project'; projectPath: string | null; expectedBindingFingerprint: string;
};
export type AccountImpactScope = {
  /** Stable display key, never an apply authorization token. */
  bindingId: string; toolId: string; profileId: string; profileName: string | null;
  profileVersion: number; scope: 'global' | 'project' | null;
  projectPath: string | null; projectName: string | null;
  contextId: string | null; contextKind: AccountImpactContextKind;
  active: boolean; needsReapply: boolean; canReapply: boolean; reason: string | null;
  reapplyRequest: AccountReapplyRequest | null;
};
export type AccountImpactUsageReference = {
  id: string; label: string; version: number; enabled: boolean;
  accountId: string | null; contextId: string | null; profileId: string | null;
  contextKind: AccountImpactContextKind; needsRebind: boolean;
};
export type AccountImpact = {
  accountId: string; accountVersion: number; toolId: string; currentContextId: string | null;
  contexts: AccountImpactContext[]; profiles: AccountImpactProfile[];
  scopes: AccountImpactScope[]; usageReferences: AccountImpactUsageReference[];
};
