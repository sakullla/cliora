import { Component, lazy, Suspense, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';

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
      return <div role="alert" className="code-editor-failed"><span>编辑器加载失败，内容未受影响。</span><button type="button" onClick={() => { this.setState({ failed: false, detail: '' }); this.props.onRetry(); }}>重试</button>{this.props.attempt > 0 && <button type="button" title="重新加载会关闭当前弹窗，尚未保存的修改会丢失" onClick={() => window.location.reload()}>重新加载应用</button>}{this.state.detail && <small>{this.state.detail}</small>}</div>;
    }
    return this.props.children;
  }
}

export function CodeEditor(props: ComponentProps<typeof CodeEditorImpl>) {
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
    <Suspense fallback={<div role="status" aria-label={props.label}>正在准备编辑器…</div>}><Editor {...props} /></Suspense>
  </EditorErrorBoundary>;
}
