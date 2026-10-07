import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { ToolIcon } from './ToolIcon';
import { withMod } from '../lib/shortcut';

export type CommandItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: IconName;
  toolId?: string;
  run: () => void;
};

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: CommandItem[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const chosen = useRef(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((item) => `${item.label} ${item.group} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(needle));
  }, [commands, query]);
  const index = shown.length ? Math.min(active, shown.length - 1) : 0;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    chosen.current = false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    input.current?.focus();
    return () => {
      if (element.open) element.close();
      const target = returnFocus.current;
      if (!chosen.current && target?.isConnected) requestAnimationFrame(() => target.focus());
    };
  }, [open]);

  useEffect(() => { setQuery(''); setActive(0); }, [open]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`command-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, index, query]);

  if (!open) return null;

  function choose(item: CommandItem | undefined) {
    if (!item) return;
    chosen.current = true;
    onClose();
    item.run();
  }

  return <dialog ref={dialog} className="command-dialog" aria-labelledby="command-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (withMod(event) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(shown.length ? (index + 1) % shown.length : 0); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(shown.length ? (index - 1 + shown.length) % shown.length : 0); return; }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, shown.length - 1)); return; }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(shown[index]); }
  }}>
    <h2 id="command-dialog-title" className="sr-only">快速前往</h2>
    <div className="command-input-row">
      <Icon name="search" size={16} />
      <input ref={input} role="combobox" aria-expanded="true" aria-controls="command-list" aria-autocomplete="list" aria-activedescendant={shown.length ? `command-option-${index}` : undefined} aria-label="搜索页面、工具或项目" placeholder="搜索页面、工具或项目" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
    </div>
    <div id="command-list" className="command-list" role="listbox" aria-label="可前往的位置">
      {shown.length ? shown.map((item, itemIndex) => {
        const previous = shown[itemIndex - 1];
        return <div key={item.id} role="presentation">
          {previous?.group !== item.group && <div className="command-group">{item.group}</div>}
          <button type="button" id={`command-option-${itemIndex}`} role="option" aria-selected={itemIndex === index} className="command-option" onMouseMove={() => setActive(itemIndex)} onClick={() => choose(item)}>
            <span className="command-glyph" aria-hidden="true">{item.toolId ? <ToolIcon toolId={item.toolId} size={18} /> : item.icon ? <Icon name={item.icon} size={16} /> : null}</span>
            <span className="command-label">{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </button>
        </div>;
      }) : <p className="command-empty" role="status">没有匹配「{query.trim()}」的页面、工具或项目。</p>}
    </div>
    <div className="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Esc</kbd> 关闭</span></div>
  </dialog>;
}
