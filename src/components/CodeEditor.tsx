import { lazy, Suspense, type ComponentProps } from 'react';

const loadEditor = () => import('./CodeEditorImpl').then((module) => ({ default: module.CodeEditor }));
const Editor = lazy(loadEditor);
export function preloadCodeEditor() { void loadEditor().catch(() => {}); }
export type { CodeFormat } from './CodeEditorImpl';

export function CodeEditor(props: ComponentProps<typeof Editor>) {
  return <Suspense fallback={<div role="status" aria-label={props.label}>加载编辑器…</div>}><Editor {...props} /></Suspense>;
}
