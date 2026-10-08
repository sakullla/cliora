import { createContext, useContext, type ReactNode } from 'react';

const Slot = createContext<ReactNode>(null);

/** Login belongs to the provider connection. Editors render it after the address and before the model. */
export function ConnectionCredentialProvider({ value, children }: { value: ReactNode; children: ReactNode }) {
  return <Slot.Provider value={value}>{children}</Slot.Provider>;
}

export function ConnectionCredential() {
  return useContext(Slot);
}
