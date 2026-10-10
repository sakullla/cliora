import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { resourceError } from '../../lib/resources';
import type { AdapterDescriptor } from '../../types/native';
import type { McpDefinition, McpDraft, McpPasteItem, McpTargetRequest } from '../../types/resources';
import { CodeEditor } from '../CodeEditor';
import { FeedbackRegion, useFeedback } from '../Feedback';
import { ResourceBatch, type BatchJob } from './ResourceBatch';
import styles from './ResourceList.module.css';

export function McpPaste({ context, target, definitions, onDraft, onChanged, onAdded }: { context: string; target?: McpTargetRequest; definitions: McpDefinition[]; onAdded?: (item: McpDefinition) => void; onDraft: (draft: McpDraft) => void; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const feedback = useFeedback(context + ':paste');
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [tools, setTools] = useState<AdapterDescriptor[]>([]);
  const [toolId, setToolId] = useState(target?.toolId ?? '');
  const [items, setItems] = useState<McpPasteItem[]>([]);
  const [replace, setReplace] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const accepted = useRef(new Map<string, McpDefinition>());
  const live = useRef(true);
  const revision = useRef(0);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { let live = true; void native.listCliAdapters().then(value => { if (!live) return; const entries = value.registered.filter(item => item.management?.mcp !== false && item.resources.state === 'available'); setTools(entries); if (!target) setToolId(entries[0]?.id ?? ''); }).catch(() => {}); return () => { live = false; }; }, []);
  const destination = target ?? { toolId, scope: 'global' as const, projectPath: null, enabled: true };
  async function parse() {
    const result = feedback.begin('parse'); setBusy(true);
    const request = revision.current;
    try {
      const parsed = await native.parseMcpPaste({ ...destination, toolId }, name || null, text);
      if (live.current) {
        if (request !== revision.current) throw new Error(t('library.experience.draftChanged'));
        accepted.current.clear(); setItems(parsed); setReplace([]);
      }
      result.complete();
    }
    catch (error) { result.error(resourceError(error)); }
    finally { if (live.current) setBusy(false); }
  }
  const jobs: BatchJob[] = items.filter(item => item.draft && (!definitions.some(old => old.name === item.name) || replace.includes(item.name))).map(item => ({ id: item.name, name: item.name, run: async () => {
    const existing = definitions.find(old => old.name === item.name);
    const saved = accepted.current.get(item.name) ?? await native.saveMcpDefinition({ ...item.draft!, id: existing?.id ?? null, expectedVersion: existing?.version ?? null, inLibrary: !target || existing?.inLibrary === true });
    accepted.current.set(item.name, saved);
    if (!existing) onAdded?.(saved);
    if (!target) return;
    const outcome = await native.runResourceBatch(crypto.randomUUID(), [{ action: 'mcp_apply', definitionId: saved.id, target }]);
    return outcome.items[0] ?? { status: 'failed', detail: t('library.experience.invalidConfig') };
  } }));
  return <section className={styles.paste}>
    <button type="button" onClick={() => setOpen(!open)}>{t('library.experience.paste')}</button>
    {open && <div className={styles.pasteBody}><div className={styles.actions}><label>{t('library.experience.inputFormat')} <select aria-label={t('library.experience.inputFormat')} value={toolId} onChange={event => { revision.current++; setToolId(event.target.value); setItems([]); }}>{tools.map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label><label>{t('library.experience.singleName')} <input value={name} onChange={event => { revision.current++; setName(event.target.value); setItems([]); }} /></label></div><CodeEditor label={t('library.experience.paste')} value={text} onChange={value => { revision.current++; setText(value); setItems([]); }} /><button type="button" disabled={busy || !toolId || !text.trim()} onClick={() => void parse()}>{t('library.experience.validate')}</button>
      {items.map(item => <div key={item.name}><strong>{item.name}</strong>{item.diagnostics.map((detail, index) => <p key={index}>{detail}</p>)}{!!item.unmappedFields.length && <p>{t('library.experience.unmapped', { fields: item.unmappedFields.join(', ') })}</p>}{item.draft && <>{definitions.some(old => old.name === item.name) && <label><input type="checkbox" checked={replace.includes(item.name)} onChange={event => setReplace(event.target.checked ? [...replace, item.name] : replace.filter(name => name !== item.name))} />{t('library.experience.replaceNamed')}</label>}<button type="button" onClick={() => onDraft({ ...item.draft!, id: null, expectedVersion: null, name: definitions.some(old => old.name === item.name) ? `${item.name}-copy` : item.name })}>{t('library.experience.editBeforeAdd')}</button></>}</div>)}
      {!!jobs.length && <ResourceBatch context={context + ':paste-write'} jobs={jobs} action={t('library.experience.addValidated')} destructive={replace.length > 0} onChanged={onChanged} />}
    <FeedbackRegion context={feedback.context} /></div>}
  </section>;
}
