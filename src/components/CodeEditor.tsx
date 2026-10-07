import { Component, lazy, Suspense, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

const loadEditor = () => import('./CodeEditorImpl').then((module) => ({ default: module.CodeEditor }));
export function preloadCodeEditor() { void loadEditor().catch(() => {}); }
export type { CodeFormat } from './CodeEditorImpl';
import type { CodeEditor as CodeEditorImpl } from './CodeEditorImpl';

// Browsers cache module load failures in the module map, so re-importing the
// same URL never re-fetches; recover through a cache-busting query instead.
function moduleUrlOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /dynamically imported module[:\s]+(\S+)/i.exec(message);
  return match?.[1] ?? null;
}

class EditorErrorBoundary extends Component<{ attempt: number; onRetry: () => void; children: ReactNode }, { failed: boolean; detail: string }> {
  state = { failed: false, detail: '' };
  static getDerivedStateFromError(error: unknown) { return { failed: true, detail: error instanceof Error ? error.message : String(error ?? '') }; }
  componentDidCatch(error: unknown) { console.error('Code editor failed', error); }
  render() {
    if (this.state.failed) {
      // A repeated failure usually means a stale bundle; a reload fetches a fresh one.
      return <div role="alert" className="code-editor-failed"><span>{i18n.t('common.editor.loadFailed')}</span><button type="button" onClick={() => { this.setState({ failed: false, detail: '' }); this.props.onRetry(); }}>{i18n.t('common.editor.retry')}</button>{this.props.attempt > 0 && <button type="button" title={i18n.t('common.editor.reloadTitle')} onClick={() => window.location.reload()}>{i18n.t('common.editor.reload')}</button>}{this.state.detail && <small>{this.state.detail}</small>}</div>;
    }
    return this.props.children;
  }
}

export function CodeEditor(props: ComponentProps<typeof CodeEditorImpl>) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const retryUrl = useRef<string | null>(null);
  // A fresh lazy instance per attempt so the retry re-imports the chunk.
  const Editor = useMemo(() => lazy(async () => {
    if (attempt > 0 && retryUrl.current) {
      const module = await import(/* @vite-ignore */ `${retryUrl.current}?retry=${attempt}`) as { CodeEditor: typeof CodeEditorImpl };
      return { default: module.CodeEditor };
    }
    try {
      return await loadEditor();
    } catch (error) {
      retryUrl.current = moduleUrlOf(error) ?? retryUrl.current;
      throw error;
    }
  }), [attempt]);
  return <EditorErrorBoundary attempt={attempt} onRetry={() => setAttempt(value => value + 1)}>
    <Suspense fallback={<div role="status" aria-label={props.label}>{t('common.editor.preparing')}</div>}><Editor {...props} /></Suspense>
  </EditorErrorBoundary>;
}
