import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { nativeAvailable } from './native';

export type UpdateOffer = { version: string; notes: string | null };

// ADR-4: the Rust side runs a delayed automatic check at startup and emits the
// result. One module-level subscription lets the sidebar badge and the settings
// card share the same offer, whichever page is open when it arrives.
let offer: UpdateOffer | null = null;
const listeners = new Set<() => void>();

export function setUpdateOffer(next: UpdateOffer | null) {
  if (offer === next || (offer && next && offer.version === next.version && offer.notes === next.notes)) return;
  offer = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUpdateOffer() {
  return useSyncExternalStore(subscribe, () => offer, () => offer);
}

if (nativeAvailable) {
  // Browser fixtures only provide invoke; listen rejects there without transformCallback.
  void listen<UpdateOffer>('cliora:update-available', (event) => setUpdateOffer(event.payload)).catch(() => {});
}
