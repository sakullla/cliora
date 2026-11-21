import type { ComponentType } from 'react';
import type { ConfigurationEditorProps } from '../types/configuration';
import type { Connection } from '../types/native';

export type ReasoningControl = {
  label: string;
  choices: readonly [string, string][];
  /** Value stored in the draft file, not a separate inspection result. */
  read: (text: string) => string | null;
  update: (text: string, value: string | null) => Promise<string>;
};

export type ModelRoleValue = { model: string; name: string; longContext: boolean };
export type CatalogControls = { models: string[]; supported: boolean; busy: boolean; fetch: () => void; error?: string | null };
export type ConfigurationContentProps = ConfigurationEditorProps & { section?: 'models' | 'settings'; mode?: 'profile' | 'current' | 'common'; pending?: boolean; rawResetEpoch?: number; catalog?: CatalogControls };
export type ModelMappingControl = {
  fileRole: string;
  primaryRole?: string;
  decodeModel?: (model: string) => ModelRoleValue;
  encodeModel?: (value: ModelRoleValue) => string;
  roles: readonly { id: string; label: string; displayName: boolean; longContext: boolean }[];
  read: (text: string) => Record<string, ModelRoleValue>;
  update: (text: string, role: string, value: ModelRoleValue) => Promise<string>;
  useModelForAll: (text: string, model: string, longContext?: boolean) => Promise<string>;
};
/**
 * One screen's evidence, read by the CLI's own adapter. Absent or null fields mean unknown:
 * shared UI must not infer an interface, an approval or a finished turn from these fields.
 */
export type TerminalSemantics = {
  /** An interface that waits for a person: a question, an approval or another input request. */
  attention?: 'question' | 'approval' | null;
  /** The recognized screen accepts typed input (a composer), so a prompt may be delivered. */
  inputReady?: boolean;
  /** Identity of this screen; a changed key invalidates evidence read from an older one. */
  screenKey?: string | null;
};

export type ToolUiAdapter = {
  id: string;
  /** Native TUI evidence after escape sequences are parsed. null means unknown;
      shared terminal activity then falls back to changing screen content. */
  terminalActivity?: (view: { title: string; lines: readonly string[] }) => boolean | null;
  /** Optional screen semantics for the shared task state: whether this interface waits for a
      person and whether it accepts typed input. Registered per CLI; shared code never parses. */
  terminalSemantics?: (view: { title: string; lines: readonly string[] }) => TerminalSemantics | null;
  /** Prompt payloads, each delivered as a separate paste event. Owns native
      image-path parsing differences; never returns keyboard shortcuts. */
  attachmentPastes?: (paths: string[]) => string[];
  /** Presentation only: native capability remains the authority for actions. */
  accounts?: {
    description: string;
    nativeDescription: string;
    managedDescription: string;
    defaultLabel: string;
    methods?: Partial<Record<'browser' | 'device', string>>;
  };
  configuration?: {
    Editor: ComponentType<ConfigurationContentProps>;
  };
  remoteAgent?: { root: string; extension: 'md' | 'toml' };
  primaryRole?: string;
  plugins?: { installLabel?: string; projectTrust?: boolean; projectUpdate?: boolean };
  officialUsage?: { accountRequired: boolean; automaticRefresh: boolean };
  icon?: { light: string; dark?: string; fit?: 'contain' | 'cover'; tile?: 'light'; scale?: number; source: string };
  authEnvName?: (connection: Connection) => string;
  incompleteConnectionText?: string;
  reasoning?: ReasoningControl;
  modelMapping?: ModelMappingControl;
};