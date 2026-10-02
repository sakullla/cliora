import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder as editorPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { javascript, json as jsonWithComments } from '@codemirror/legacy-modes/mode/javascript';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { tags } from '@lezer/highlight';
import './CodeEditor.css';

export type CodeFormat = 'json' | 'jsonc' | 'toml' | 'markdown' | 'text' | 'javascript';
const highlighting = HighlightStyle.define([
  { tag: tags.comment, class: 'code-comment' },
  { tag: [tags.propertyName, tags.definition(tags.variableName)], class: 'code-property' },
  { tag: [tags.string, tags.url], class: 'code-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.keyword], class: 'code-literal' },
  { tag: tags.heading, class: 'code-heading' },
  { tag: tags.strong, class: 'code-strong' },
]);
function language(format: CodeFormat) {
  switch (format) {
    case 'javascript': return StreamLanguage.define(javascript);
    case 'json': return json();
    case 'jsonc': return StreamLanguage.define(jsonWithComments);
    case 'toml': return StreamLanguage.define(toml);
    case 'markdown': return markdown();
    default: return [];
  }
}

/** A format-driven editor shared by native files, structured previews and library text. */
export function CodeEditor({ value, onChange, format = 'text', label, readOnly = false, placeholder = '', compact = false, errorLine }: {
  value: string; onChange?: (value: string) => void; format?: CodeFormat; label: string;
  readOnly?: boolean; placeholder?: string; compact?: boolean; errorLine?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [menuError, setMenuError] = useState('');
  const menuHost = useRef<HTMLDivElement>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  const configuration = useRef(new Compartment());
  const initialValue = useRef(value);
  const extensions = () => [language(format), EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', 'aria-readonly': String(readOnly), spellcheck: 'false' }), editorPlaceholder(placeholder)];
  useLayoutEffect(() => {
    if (!host.current) return;
    // Tauri gives this bundled anchor a fresh style nonce for each document.
    const nonce = (document.getElementById('cliora-editor-nonce') as HTMLStyleElement | null)?.nonce ?? '';
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initialValue.current, extensions: [
      configuration.current.of(extensions()), EditorView.cspNonce.of(nonce), lineNumbers(), history(), drawSelection(),
      highlightActiveLine(), bracketMatching(), indentOnInput(), EditorState.tabSize.of(2), EditorView.lineWrapping,
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]), syntaxHighlighting(highlighting),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(Transaction.addToHistory) === false)) callback.current?.(update.state.doc.toString());
      }),
    ] }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, []);
  useLayoutEffect(() => { editor.current?.dispatch({ effects: configuration.current.reconfigure(extensions()) }); }, [format, readOnly, label, placeholder]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
  }, [value]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && errorLine && errorLine <= view.state.doc.lines) {
      const line = view.state.doc.line(errorLine);
      view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    }
  }, [errorLine]);
  useLayoutEffect(() => {
    if (!menu || !menuHost.current) return;
    const element = menuHost.current;
    element.style.left = `${Math.max(6, Math.min(menu.x, innerWidth - element.offsetWidth - 6))}px`;
    element.style.top = `${Math.max(6, Math.min(menu.y, innerHeight - element.offsetHeight - 6))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!menuHost.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); editor.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);
  async function action(kind: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'all') {
    const view = editor.current; setMenu(null); setMenuError('');
    if (!view) return;
    try {
      if (kind === 'undo') undo(view);
      else if (kind === 'redo') redo(view);
      else if (kind === 'all') selectAll(view);
      else if (kind === 'paste') {
        const text = await navigator.clipboard.readText();
        if (editor.current !== view || readOnly) return;
        view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
      } else {
        const state = view.state;
        await navigator.clipboard.writeText(state.selection.ranges.map(range => state.sliceDoc(range.from, range.to)).join('\n'));
        if (kind === 'cut' && editor.current === view && view.state === state && !readOnly) view.dispatch(state.replaceSelection(''), { userEvent: 'delete.cut' });
      }
      view.focus();
    } catch { setMenuError('系统剪贴板暂不可用，请使用键盘快捷键。'); }
  }
  const state = editor.current?.state;
  const hasSelection = state?.selection.ranges.some(range => !range.empty) ?? false;
  return <><div className={`code-editor${compact ? ' code-editor-compact' : ''}`} data-format={format} ref={host} onContextMenu={event => { event.preventDefault(); setMenu({ x:event.clientX, y:event.clientY }); }} />
    {menuError && <small className="code-menu-error" role="status">{menuError}</small>}
    {menu && createPortal(<div ref={menuHost} className="code-menu" role="menu" aria-label="编辑菜单" onContextMenu={event => event.preventDefault()}>
      <button role="menuitem" type="button" disabled={readOnly || !state || !undoDepth(state)} onClick={() => void action('undo')}>撤销<span>Ctrl+Z</span></button>
      <button role="menuitem" type="button" disabled={readOnly || !state || !redoDepth(state)} onClick={() => void action('redo')}>重做<span>Ctrl+Y</span></button>
      <hr /><button role="menuitem" type="button" disabled={readOnly || !hasSelection} onClick={() => void action('cut')}>剪切<span>Ctrl+X</span></button>
      <button role="menuitem" type="button" disabled={!hasSelection} onClick={() => void action('copy')}>复制<span>Ctrl+C</span></button>
      <button role="menuitem" type="button" disabled={readOnly} onClick={() => void action('paste')}>粘贴<span>Ctrl+V</span></button>
      <hr /><button role="menuitem" type="button" onClick={() => void action('all')}>全选<span>Ctrl+A</span></button>
    </div>, document.body)}</>;
}
