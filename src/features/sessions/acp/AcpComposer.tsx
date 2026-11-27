import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { highlightRuns } from '../../../components/CommandPalette';
import { Icon } from '../../../components/Icon';
import type { AcpAttachment, AcpFileList, AcpImageFile, AcpSessionSnapshot } from '../../../types/acp';
import { AcpSettings } from './AcpSettings';
import {
  ACP_IMAGE_BYTES, ACP_IMAGE_LIMIT, ACP_IMAGE_TYPES, attachmentPayload, baseName, insertMention, isImagePath, matchCommands, mentionQuery,
  promptHistory, readBase64, slashQuery, type ComposerAttachment,
} from './composerModel';
import styles from './acpComposer.module.css';

/** Below this pane width (one half of a split), or in a window this narrow, the
 *  selectors fold into the "⋯" menu. */
const COMPACT_WIDTH = 560;
const COMPACT_WINDOW = 760;

export type AcpComposerHandle = {
  /** Attach pasted or dropped file objects (images; other files are refused with a reason). */
  addFiles: (files: File[]) => void;
  /** Attach files by path, as a native drop delivers them. An image path, when the
   *  agent accepts images, is read by the host and becomes an image like a pasted one. */
  addPaths: (paths: string[]) => void;
  /** Send text from another input (the shared quick input) with the tray's attachments.
   *  Rejects with the host's reason; the tray stays as it was. */
  submitText: (text: string) => Promise<void>;
  focus: () => void;
};

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

let attachmentSeq = 0;
const nextAttachmentId = () => `attachment-${Date.now().toString(36)}-${(attachmentSeq += 1)}`;

type FileState = { query: string; files: string[]; truncated: boolean; loading: boolean; error: string };
/** A dropped image the host is still reading. */
type ReadingImage = { id: string; name: string; path: string };

/**
 * The conversation's input. Enter sends and Shift+Enter adds a line; while an input
 * method is composing, Enter belongs to the composition. `/` at the start opens the
 * agent's declared commands, `@` looks up files in the session directory and attaches
 * the chosen one. Images are attached by paste or drop only when the agent declared
 * it accepts them; a desktop drop delivers paths, so the host reads the picture
 * (with the session directory's approval rules) and it joins the tray like a pasted
 * one, shown as reading until then. Up and down on an empty input bring back earlier prompts. While a
 * turn runs the draft stays editable and the main button stops the turn; a send that
 * fails keeps the draft and its attachments.
 */
export const AcpComposer = forwardRef<AcpComposerHandle, {
  snapshot: AcpSessionSnapshot;
  toolName: string;
  live: boolean;
  /** A turn is in flight: the main button stops it instead of sending. */
  turnBusy: boolean;
  /** Something else (a stop, a close) is in flight. */
  busy: boolean;
  canSend: boolean;
  onSend: (text: string, attachments: AcpAttachment[]) => Promise<void>;
  onStop: () => void;
  onClose: () => void;
  onListFiles: (query: string) => Promise<AcpFileList>;
  /** Reads a dropped image file for its preview (see native acp.readImage). */
  onReadImage: (path: string) => Promise<AcpImageFile>;
  onSetMode: (modeId: string) => Promise<void>;
  onSetConfig: (configId: string, value: string | boolean) => Promise<void>;
}>(function AcpComposer({ snapshot, toolName, live, turnBusy, busy, canSend, onSend, onStop, onClose, onListFiles, onReadImage, onSetMode, onSetConfig }, ref) {
  const { t } = useTranslation();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [reading, setReading] = useState<ReadingImage[]>([]);
  const readingRef = useRef<ReadingImage[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [menuIndex, setMenuIndex] = useState(0);
  /** The token the person dismissed with Escape; its menu stays closed until it changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [fileState, setFileState] = useState<FileState>({ query: '', files: [], truncated: false, loading: false, error: '' });
  const fileSeq = useRef(0);
  const [sent, setSent] = useState<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const [compact, setCompact] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const imageAllowed = !!snapshot.agent?.promptCapabilities?.image;
  const commands = snapshot.commands ?? [];

  // Auto-grow up to a bound, then scroll inside.
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const height = Math.min(200, Math.max(56, node.scrollHeight + 2));
    node.style.height = `${height}px`;
    node.style.overflowY = node.scrollHeight + 2 > height ? 'auto' : 'hidden';
  }, [draft]);

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => { if (node.clientWidth > 0) setCompact(node.clientWidth < COMPACT_WIDTH || window.innerWidth <= COMPACT_WINDOW); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const slash = commands.length ? slashQuery(draft, caret) : null;
  const slashMatches = useMemo(() => (slash == null ? [] : matchCommands(commands, slash)), [commands, slash]);
  const mention = slash == null && live ? mentionQuery(draft, caret) : null;
  const slashKey = slash != null ? `slash:${slash}` : null;
  const mentionKey = mention ? `mention:${mention.start}` : null;
  const slashOpen = slash != null && slashMatches.length > 0 && dismissed !== slashKey;
  const mentionOpen = !!mention && dismissed !== mentionKey;
  const menuItems = slashOpen ? slashMatches.length : mentionOpen && fileState.query === mention?.query ? fileState.files.length : 0;
  const menuOpen = slashOpen || mentionOpen;
  const activeIndex = menuItems ? Math.min(menuIndex, menuItems - 1) : 0;

  // Look up files for the `@` being typed; a stale answer never replaces a newer one.
  const mentionText = mentionOpen ? mention!.query : null;
  useEffect(() => {
    if (mentionText == null) return;
    const id = (fileSeq.current += 1);
    setFileState((current) => ({ ...current, loading: true, error: '' }));
    const timer = window.setTimeout(() => {
      onListFiles(mentionText)
        .then((list) => { if (fileSeq.current === id) setFileState({ query: mentionText, files: list.files ?? [], truncated: !!list.truncated, loading: false, error: '' }); })
        .catch((value) => { if (fileSeq.current === id) setFileState({ query: mentionText, files: [], truncated: false, loading: false, error: errorText(value) }); });
    }, 120);
    return () => window.clearTimeout(timer);
    // onListFiles is a fresh closure on every render; the query alone decides a lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionText]);

  useEffect(() => { setMenuIndex(0); }, [slashKey, mentionKey, fileState.query]);

  const timelineUsers = useMemo(() => snapshot.timeline
    .filter((item) => item.kind === 'message' && item.role === 'user' && !item.subagent)
    .map((item) => (item.kind === 'message' ? item.text : '')), [snapshot.timeline]);
  const history = useMemo(() => promptHistory(timelineUsers, sent), [timelineUsers, sent]);

  function setText(text: string, at = text.length) {
    setDraft(text);
    setCaret(at);
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(at, at);
    });
  }

  async function addFiles(files: File[]) {
    if (!files.length) return;
    const reasons: string[] = [];
    let images = imageCount();
    let tooMany = false;
    const added: ComposerAttachment[] = [];
    for (const file of files) {
      const name = file.name || file.type || 'image';
      if (!file.type.startsWith('image/')) { reasons.push(t('sessions.acpFileUnsupported', { name })); continue; }
      if (!imageAllowed) { reasons.push(t('sessions.acpImageUnsupported', { tool: toolName })); continue; }
      if (!ACP_IMAGE_TYPES.includes(file.type)) { reasons.push(t('sessions.acpImageType')); continue; }
      if (file.size > ACP_IMAGE_BYTES) { reasons.push(t('sessions.acpImageTooLarge', { name })); continue; }
      if (images >= ACP_IMAGE_LIMIT) { tooMany = true; continue; }
      try {
        const dataBase64 = await readBase64(file);
        images += 1;
        added.push({ id: nextAttachmentId(), type: 'image', name, mimeType: file.type, dataBase64, size: file.size });
      } catch { reasons.push(t('sessions.acpImageReadFailed', { name })); }
    }
    if (tooMany) reasons.push(t('sessions.acpImageTooMany', { count: ACP_IMAGE_LIMIT }));
    setNotices([...new Set(reasons)]);
    if (added.length) setAttachments((current) => [...current, ...added]);
  }

  /** Images in the tray, counting those still being read. */
  function imageCount(): number {
    return attachmentsRef.current.filter((item) => item.type === 'image').length + readingRef.current.length;
  }

  function setReadingImages(next: ReadingImage[]) {
    readingRef.current = next;
    setReading(next);
  }

  function addPaths(paths: string[]) {
    const reasons: string[] = [];
    const known = new Set([
      ...attachmentsRef.current.flatMap((item) => (item.type === 'file' ? [item.path] : item.source ? [item.source] : [])),
      ...readingRef.current.map((item) => item.path),
    ]);
    const added: ComposerAttachment[] = [];
    const toRead: ReadingImage[] = [];
    let images = imageCount();
    let tooMany = false;
    for (const path of paths) {
      if (!path.trim() || known.has(path)) continue;
      known.add(path);
      if (isImagePath(path)) {
        // A dropped picture is still a picture: without the image capability it is
        // refused for the same reason a pasted one is; with it, the host reads it
        // and it is previewed and sent as an image.
        if (!imageAllowed) { reasons.push(t('sessions.acpImageUnsupported', { tool: toolName })); continue; }
        if (images >= ACP_IMAGE_LIMIT) { tooMany = true; continue; }
        images += 1;
        toRead.push({ id: nextAttachmentId(), name: baseName(path), path });
        continue;
      }
      added.push({ id: nextAttachmentId(), type: 'file', name: baseName(path), path });
    }
    if (tooMany) reasons.push(t('sessions.acpImageTooMany', { count: ACP_IMAGE_LIMIT }));
    setNotices([...new Set(reasons)]);
    if (added.length) setAttachments((current) => [...current, ...added]);
    if (toRead.length) {
      setReadingImages([...readingRef.current, ...toRead]);
      for (const item of toRead) void readImage(item);
    }
  }

  /** Read one dropped image through the host; a failure says why instead of
   *  attaching the path as a plain file. Removed from the tray meanwhile, the
   *  result is dropped. */
  async function readImage(item: ReadingImage) {
    let image: ComposerAttachment | null = null;
    let reason = '';
    try {
      const file = await onReadImage(item.path);
      if (!ACP_IMAGE_TYPES.includes(file.mimeType)) reason = t('sessions.acpImageType');
      else if (file.size > ACP_IMAGE_BYTES) reason = t('sessions.acpImageTooLarge', { name: item.name });
      else image = { id: item.id, type: 'image', name: file.name || item.name, mimeType: file.mimeType, dataBase64: file.dataBase64, size: file.size, source: item.path };
    } catch (value) {
      reason = t('sessions.acpImageReadFailedReason', { name: item.name, reason: errorText(value) });
    }
    if (!readingRef.current.some((entry) => entry.id === item.id)) return;
    setReadingImages(readingRef.current.filter((entry) => entry.id !== item.id));
    if (image) {
      const added = image;
      attachmentsRef.current = [...attachmentsRef.current, added];
      setAttachments((current) => [...current, added]);
    }
    if (reason) setNotices((current) => [...new Set([...current, reason])]);
  }

  function attachFile(path: string) {
    if (attachmentsRef.current.some((item) => item.type === 'file' && item.path === path)) return;
    setAttachments((current) => [...current, { id: nextAttachmentId(), type: 'file', name: path, path }]);
  }

  /** Send, then clear only what was sent: text typed meanwhile stays. */
  async function send(text: string, fromDraft: boolean) {
    const items = attachmentsRef.current;
    if (!text && !items.length && !readingRef.current.length) return;
    // A picture still being read would silently miss the prompt.
    if (readingRef.current.length) {
      if (fromDraft) return;
      throw new Error(t('sessions.acpImageReadingBusy'));
    }
    if (sendingRef.current) {
      if (fromDraft) return;
      throw new Error(t('sessions.acpSendBusy'));
    }
    sendingRef.current = true;
    setSending(true);
    setError('');
    const sentDraft = draft;
    try {
      await onSend(text, attachmentPayload(items));
      const ids = new Set(items.map((item) => item.id));
      setAttachments((current) => current.filter((item) => !ids.has(item.id)));
      setNotices([]);
      if (text) setSent((current) => [...current, text].slice(-100));
      historyIndex.current = null;
      if (fromDraft) setDraft((current) => (current === sentDraft ? '' : current));
    } catch (value) {
      if (fromDraft) setError(errorText(value));
      throw value;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function submit() {
    if (!canSend || turnBusy) return;
    void send(draft.trim(), true).catch(() => {});
  }

  useImperativeHandle(ref, () => ({
    addFiles: (files) => { void addFiles(files); },
    addPaths,
    submitText: (text) => send(text.trim(), false),
    focus: () => inputRef.current?.focus(),
  }));

  function choose(index: number) {
    if (slashOpen) {
      const command = slashMatches[index];
      if (!command) return;
      const rest = draft.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
      const text = `/${command.name} ${rest}`;
      setText(text, command.name.length + 2);
      return;
    }
    if (mentionOpen && mention) {
      const path = fileState.files[index];
      if (!path) return;
      const next = insertMention(draft, mention.start, caret, path);
      attachFile(path);
      setText(next.text, next.caret);
    }
  }

  function composing(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    return event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229;
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (composing(event)) return;
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!menuItems) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((activeIndex + step + menuItems) % menuItems);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        if (menuItems) {
          event.preventDefault();
          choose(activeIndex);
          return;
        }
        // The file lookup has not answered yet: Enter waits for it instead of
        // sending the bare `@query` without its file.
        if (mentionOpen && (fileState.loading || fileState.query !== mention?.query) && !fileState.error) {
          event.preventDefault();
          return;
        }
        if (event.key === 'Tab') return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(slashOpen ? slashKey : mentionKey);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      submit();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && history.length) {
      const index = historyIndex.current;
      const browsing = index != null && draft === history[index];
      if (event.key === 'ArrowUp' && (draft === '' || browsing)) {
        event.preventDefault();
        const next = index == null || !browsing ? history.length - 1 : Math.max(0, index - 1);
        historyIndex.current = next;
        setText(history[next]);
        return;
      }
      if (event.key === 'ArrowDown' && browsing) {
        event.preventDefault();
        if (index! >= history.length - 1) { historyIndex.current = null; setText(''); return; }
        historyIndex.current = index! + 1;
        setText(history[index! + 1]);
      }
    }
  }

  const sendable = canSend && !turnBusy && !sending && !reading.length && (!!draft.trim() || attachments.length > 0);
  const activeId = menuItems ? `${listId}-option-${activeIndex}` : undefined;

  return <div ref={rootRef} className={styles.composer} data-acp-composer="" data-drag={dragOver || undefined}
    onDragOver={(event) => {
      if (!live || !event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      setDragOver(true);
    }}
    onDragLeave={(event) => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
    onDrop={(event) => {
      setDragOver(false);
      if (!live) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      void addFiles(files);
    }}>
    {menuOpen && <div className={styles.menu} data-acp-menu={slashOpen ? 'commands' : 'files'}>
      <p className={styles.menuHead}>
        <Icon name={slashOpen ? 'command' : 'file'} size={12} />
        <span>{slashOpen ? t('sessions.acpCommandsLabel') : t('sessions.acpFilesLabel')}</span>
        {!slashOpen && fileState.truncated && <span className={styles.menuNote}>{t('sessions.acpFilesTruncated')}</span>}
      </p>
      {slashOpen ? <div id={listId} role="listbox" aria-label={t('sessions.acpCommandsLabel')} className={styles.menuList}>
        {slashMatches.map((command, index) => <div key={command.name} id={`${listId}-option-${index}`} role="option" aria-selected={index === activeIndex} className={styles.menuOption}
          onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setMenuIndex(index)} onClick={() => choose(index)}>
          <span className={styles.menuLabel}>/{highlightRuns(command.name, slash ?? '').map((run, key) => run.hit ? <mark key={key}>{run.text}</mark> : run.text)}</span>
          {command.description && <span className={styles.menuDetail}>{command.description}</span>}
          {command.hint && <span className={styles.menuHint}>{command.hint}</span>}
        </div>)}
      </div> : <div id={listId} role="listbox" aria-label={t('sessions.acpFilesLabel')} aria-busy={fileState.loading || undefined} className={styles.menuList}>
        {fileState.query === mention?.query && fileState.files.map((path, index) => <div key={path} id={`${listId}-option-${index}`} role="option" aria-selected={index === activeIndex} className={styles.menuOption}
          onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setMenuIndex(index)} onClick={() => choose(index)}>
          <span className={`${styles.menuLabel} ${styles.menuPath}`}>{highlightRuns(path, mention?.query ?? '').map((run, key) => run.hit ? <mark key={key}>{run.text}</mark> : run.text)}</span>
        </div>)}
        {fileState.error ? <p className={styles.menuEmpty} role="alert">{t('sessions.acpFilesFailed', { reason: fileState.error })}</p>
          : fileState.loading || fileState.query !== mention?.query ? <p className={styles.menuEmpty}>{t('sessions.acpFilesLoading')}</p>
            : !fileState.files.length ? <p className={styles.menuEmpty}>{t('sessions.acpFilesEmpty')}</p> : null}
      </div>}
    </div>}
    {(attachments.length > 0 || reading.length > 0) && <ul className={styles.tray} aria-label={t('sessions.acpAttachments')} aria-busy={reading.length > 0 || undefined}>
      {attachments.map((item) => <li key={item.id} className={styles.trayItem} data-attachment={item.type}>
        {item.type === 'image'
          ? <img className={styles.trayPreview} src={`data:${item.mimeType};base64,${item.dataBase64}`} alt={t('sessions.acpAttachmentImage', { name: item.name })} />
          : <Icon name="file" size={12} />}
        <span className={styles.trayName} title={item.type === 'file' ? item.path : item.name}>{item.name}</span>
        <button type="button" className={styles.trayRemove} aria-label={t('sessions.acpAttachmentRemove', { name: item.name })} title={t('sessions.acpAttachmentRemove', { name: item.name })} onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}>
          <Icon name="close" size={10} />
        </button>
      </li>)}
      {reading.map((item) => <li key={item.id} className={styles.trayItem} data-attachment="reading" title={t('sessions.acpImageReading', { name: item.name })}>
        <span className={styles.trayReading} role="status" aria-label={t('sessions.acpImageReading', { name: item.name })} />
        <span className={styles.trayName}>{item.name}</span>
        <button type="button" className={styles.trayRemove} aria-label={t('sessions.acpAttachmentRemove', { name: item.name })} title={t('sessions.acpAttachmentRemove', { name: item.name })} onClick={() => setReadingImages(readingRef.current.filter((entry) => entry.id !== item.id))}>
          <Icon name="close" size={10} />
        </button>
      </li>)}
    </ul>}
    {notices.length > 0 && <div className={styles.notice} role="alert" data-acp-attach-notice="">
      <Icon name="info" size={12} />
      <span>{notices.join(' ')}</span>
      <button type="button" className={styles.trayRemove} aria-label={t('sessions.acpNoticeDismiss')} title={t('sessions.acpNoticeDismiss')} onClick={() => setNotices([])}><Icon name="close" size={10} /></button>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {dragOver && <p className={styles.dropHint} aria-hidden="true"><Icon name="upload" size={12} />{t('sessions.acpDropHint')}</p>}
    <textarea
      ref={inputRef}
      className={styles.input}
      aria-label={t('sessions.acpMessageLabel', { tool: toolName })}
      aria-autocomplete={commands.length ? 'list' : undefined}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={activeId}
      placeholder={live ? t('sessions.acpPlaceholder') : t('sessions.acpEndedPlaceholder')}
      value={draft}
      rows={2}
      disabled={!live}
      onChange={(event) => {
        setDraft(event.target.value);
        setCaret(event.target.selectionStart ?? event.target.value.length);
        setDismissed(null);
        setError('');
      }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onBlur={() => {
        composingRef.current = false;
        // Leaving the input closes its menu; options keep focus on the input while clicked.
        if (menuOpen) setDismissed(slashOpen ? slashKey : mentionKey);
      }}
      onPaste={(event) => {
        const data = event.clipboardData;
        if (!data || data.getData('text/plain')) return;
        const files = Array.from(data.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        void addFiles(files);
      }}
      onKeyDown={onKeyDown}
    />
    <div className={styles.actions}>
      <AcpSettings config={snapshot.config} compact={compact} disabled={!live || snapshot.state === 'starting'} onSetMode={onSetMode} onSetConfig={onSetConfig} />
      <span className={styles.hint}>{!live ? t('sessions.acpEnded') : turnBusy ? t('sessions.acpBusyHint') : reading.length ? t('sessions.acpImageReadingBusy') : t('sessions.acpSendHint')}</span>
      {!live && <button type="button" className={styles.button} data-variant="quiet" disabled={busy} onClick={onClose}>{t('sessions.acpClose')}</button>}
      {turnBusy && live
        ? <button type="button" className={styles.button} data-variant="stop" disabled={busy || snapshot.state === 'stopping'} onClick={onStop}><Icon name="square" size={12} />{snapshot.state === 'stopping' ? t('sessions.acpStopping') : t('sessions.acpStop')}</button>
        : <button type="button" className={styles.button} data-variant="primary" disabled={!sendable} onClick={submit}><Icon name="arrowUp" size={13} />{sending ? t('sessions.acpSending') : t('sessions.acpSend')}</button>}
    </div>
  </div>;
});
