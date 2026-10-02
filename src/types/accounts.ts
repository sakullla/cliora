export type AccountState = 'signed_out' | 'pending' | 'signed_in' | 'expired' | 'error' | 'unknown';
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
  toolId: string; provider: string; version: string; managedLogin: boolean; importNative: boolean;
  methods: ('browser' | 'device')[]; reason: string; identitySource: string;
  refreshOwner: 'native_cli'; acceptance: string;
};
