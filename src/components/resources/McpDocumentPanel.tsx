import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { writeClipboard } from '../../lib/clipboard';
import { resourceError } from '../../lib/resources';
import type { FeedbackOperation } from '../../lib/notifications';
import type { AdapterDescriptor } from '../../types/native';
import type { McpDocument, McpDraft, McpTargetRequest } from '../../types/resources';
import { CodeEditor } from '../CodeEditor';
import { FeedbackRegion, useFeedback } from '../Feedback';
import styles from './ResourceList.module.css';

export function McpDocumentPanel({ target, definitionId = null, name, formDirty, onDraft, onChanged, onModeChange, onDirtyChange, onTextChange, getDraft, sourceName, validateNative }: {
  getDraft: () => McpDraft; sourceName?: string; validateNative?: () => Promise<void>; target?: McpTargetRequest; definitionId?: string | null; name: string; formDirty: boolean;
  onModeChange?: (open: boolean) => void; onDirtyChange?: (dirty: boolean) => void; onTextChange: () => void; onDraft: (draft: McpDraft, copy: boolean, enabled?: boolean) => void; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [tools, setTools] = useState<AdapterDescriptor[]>([]);
  const [toolId, setToolId] = useState(target?.toolId ?? '');
  const [document, setDocument] = useState<McpDocument | null>(null);
  const [text, setText] = useState('');
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const savedNative = useRef(false);
  useEffect(() => { onModeChange?.(open); }, [open, onModeChange]);
  useEffect(() => { onDirtyChange?.(!!document && text !== document.text); }, [document, text, onDirtyChange]);
  const live = useRef(true);
  const epoch = useRef(0);
  const latest = useRef({ getDraft, text });
  latest.current = { getDraft, text };
  const feedback = useFeedback(JSON.stringify(['mcp-document', target, definitionId, name]));
  const destination: McpTargetRequest = { ...(target ?? { scope: 'global', projectPath: null, enabled: true }), toolId };
  useEffect(() => { void native.listCliAdapters().then(value => { const entries = value.registered.filter(item => item.management?.mcp !== false && item.resources.state === 'available'); setTools(entries); if (!target) setToolId(entries[0]?.id ?? ''); }).catch(() => {}); return () => { live.current = false; epoch.current++; }; }, []);
  async function load(nextTool = toolId, reveal = false) {
    const request = ++epoch.current; const result = feedback.begin(JSON.stringify(['read', nextTool, reveal])); setBusy(true);
    try {
      const draft = getDraft(); const snapshot = JSON.stringify(draft);
      const nextTarget = { ...destination, toolId: nextTool };
      let value: McpDocument;
      if (formDirty || !definitionId && !sourceName) {
        if (sourceName && target) {
          await validateNative?.();
          const original = await native.readMcpDocument({ target, definitionId: null, name: sourceName, reveal });
          if (original.protectedValues) throw new Error(t('library.experience.maskedConversion'));
          if (original.unmappedFields.length) throw new Error(t('library.experience.unmapped', { fields: original.unmappedFields.join(', ') }));
          value = await native.renderMcpDraft(nextTarget, draft);
          if (nextTool === target.toolId) value = { ...value, source: 'native_entry', baseline: original.baseline, rawText: original.rawText, rawScope: original.rawScope, sourcePath: original.sourcePath };
        } else value = await native.renderMcpDraft(nextTarget, draft);
      } else value = sourceName && target && nextTool !== target.toolId ? await native.equivalentMcpDocument(target, sourceName, nextTarget) : await native.readMcpDocument({ target: nextTarget, definitionId, name: sourceName ?? name, reveal });

      if (live.current && request === epoch.current) {
        if (JSON.stringify(latest.current.getDraft()) !== snapshot) throw new Error(t('library.experience.draftChanged'));
        setDocument(value); setText(value.text); setOpen(true); setRaw(false);
      } result.complete();
    } catch (error) { if (live.current && request === epoch.current && document) setToolId(document.targetToolId); result.error(resourceError(error)); }
    finally { if (live.current && request === epoch.current) setBusy(false); }
  }
  async function toForm(copy: boolean) {
    if (!document) return;
    const request = ++epoch.current; const value = text;
    const result = feedback.begin(copy ? 'copy-new' : 'form'); setBusy(true);
    try {
      if (document.protectedValues) throw new Error(t('library.experience.maskedConversion'));
      const parsed = await native.parseMcpPaste(destination, document.name, value);
      if (parsed.length !== 1 || !parsed[0].draft || parsed[0].unmappedFields.length) throw new Error(parsed.flatMap(item => [...item.diagnostics, ...item.unmappedFields]).join(' · ') || t('library.experience.invalidConfig'));
      if (!target && parsed[0].enabled === false) throw new Error(t('library.experience.stateNotPortable'));
      if (live.current && request === epoch.current) {
        if (latest.current.text !== value) throw new Error(t('library.experience.draftChanged'));
        onDraft({ ...parsed[0].draft, id: null, expectedVersion: null, name: copy ? `${parsed[0].name}-copy` : parsed[0].name }, copy, parsed[0].enabled ?? undefined); setOpen(false);
      } result.complete();
    } catch (error) { result.error(resourceError(error)); }
    finally { if (live.current && request === epoch.current) setBusy(false); }
  }
  async function refresh(result: FeedbackOperation) {
    try { await onChanged(); result.success(t('tools.mcp.written')); }
    catch (error) { result.error(resourceError(error), { recovery: {
      label: t('common.feedback.retry'), valid: () => live.current,
      run: async () => { const retry = feedback.resume(result); retry.committed(t('tools.mcp.written')); setBusy(true); try { await refresh(retry); } finally { if (live.current) setBusy(false); } },
    } }); }
  }
  async function save() {
    if (!document || !target) return;
    const result = feedback.begin('save'); const value = text; setBusy(true);
    try {
      const saved = await native.saveMcpDocument(target, sourceName ?? name, document.baseline, value);
      result.committed(t('tools.mcp.written'));
      savedNative.current = true;
      if (live.current) { setDocument(saved); setText(current => current === value ? saved.text : current); }
      await refresh(result);
    } catch (error) { result.error(resourceError(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className={styles.editor}>
    <div className={styles.actions}><button type="button" disabled={busy || !toolId} onClick={() => open ? savedNative.current || document && text !== document.text ? void toForm(false) : setOpen(false) : void load()}>{open ? t('library.experience.form') : t('library.experience.configuration')}</button></div>
    {open && document && <>
      <div className={styles.actions}><label>{t('library.experience.targetFormat')} <select aria-label={t('library.experience.targetFormat')} disabled={busy || text !== document.text} value={toolId} onChange={event => { setToolId(event.target.value); void load(event.target.value); }}>{tools.map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label><strong>{document.source === 'equivalent' ? t('library.experience.equivalent') : t('library.experience.entryConfig')} · {document.format}</strong></div>
      <p>{document.sourcePath ?? t('library.experience.generated')}{document.protectedValues ? ` · ${t('library.experience.redacted')}` : ''}</p>
      {!!document.unmappedFields.length && <p>{t('library.experience.unmapped', { fields: document.unmappedFields.join(', ') })}</p>}
      {document.diagnostics.map((detail, index) => <p key={index}>{detail}</p>)}
      {document.rawText !== null && <label className={styles.check}><input type="checkbox" checked={raw} onChange={event => setRaw(event.target.checked)} />{t('library.experience.rawFile')}</label>}
      <CodeEditor label={raw ? t('library.experience.rawFile') : t('library.experience.entryConfig')} format={document.format} value={raw ? document.rawText ?? '' : text} onChange={value => { onTextChange(); setText(value); }} readOnly={raw} documentId={`${name}:${toolId}:${raw}`} />
      <div className={styles.actions}><button type="button" onClick={() => { const result = feedback.begin('copy-entry'); void writeClipboard(text).then(ok => ok ? result.success(t('library.experience.copiedEntry')) : result.error(t('library.experience.copyFailed'))); }}>{t('library.experience.copyEntry')}</button><button type="button" disabled={busy} onClick={() => void toForm(true)}>{t('library.experience.copyNew')}</button><button type="button" disabled={busy || raw} onClick={() => void toForm(false)}>{t('library.experience.useForm')}</button>{target && !raw && document.source === 'native_entry' && <button type="button" data-dialog-save disabled={busy || text === document.text} onClick={() => void save()}>{t('tools.skills.save')}</button>}{document.protectedValues && <button type="button" disabled={busy || text !== document.text} onClick={() => void load(toolId, true)}>{t('library.experience.reveal')}</button>}</div>
    </>}
    <FeedbackRegion context={feedback.context} />
  </section>;
}

