/** A reference is available, confirmed absent, unknown to this device, or unreadable. */
export type PromptSecretStatus = 'available' | 'missing' | 'unknown' | 'unreadable';
export type PromptSecret = {
  id: string;
  alias: string;
  reference: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  status: PromptSecretStatus;
};
export type PromptSecretReference = {
  id: string;
  reference: string;
  alias: string | null;
  status: PromptSecretStatus;
};