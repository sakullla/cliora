import { createContext, useContext, useState } from 'react';
import { uiAdapterFor } from '../adapters';
import type { FilterSelectOption } from './FilterSelect';
import { Icon } from './Icon';

export const ToolIconsContext = createContext<Record<string, string>>({});

export function toolOptions(tools: Array<{ id: string; name: string }>, size = 16): FilterSelectOption[] {
  return tools.map((tool) => ({ value: tool.id, label: tool.name, icon: <ToolIcon toolId={tool.id} size={size} /> }));
}

/** Adapter declarations and portable user overrides share a single renderer. */
export function ToolIcon({ toolId, size = 30 }: { toolId: string; size?: number }) {
  const overrides = useContext(ToolIconsContext);
  const declaration = uiAdapterFor(toolId).icon;
  const source = overrides[toolId] || declaration?.light;
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={`tool-logo ${!overrides[toolId] && declaration?.tile === 'light' ? 'tool-logo-pale' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
    {source && failed !== source ? <>
      <img className="tool-logo-light" src={source} alt="" style={{ objectFit: overrides[toolId] ? 'contain' : declaration?.fit ?? 'contain', transform: `scale(${overrides[toolId] ? 1 : declaration?.scale ?? 1})` }} onError={() => setFailed(source)} />
      {declaration?.dark && !overrides[toolId] && <img className="tool-logo-dark" src={declaration.dark} alt="" onError={() => setFailed(source)} />}
    </> : <Icon name="tool" size={Math.max(16, size - 10)} />}
  </span>;
}
