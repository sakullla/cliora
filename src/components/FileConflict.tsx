import { CodeEditor, type CodeFormat } from './CodeEditor';

export function FileConflict({ current, edited, format, busy, onKeep, onUse }: {
  current: string; edited: string; format: CodeFormat; busy?: boolean; onKeep: () => void; onUse: () => void;
}) {
  return <div className="file-conflict" role="group" aria-label="外部修改比较">
    <p>文件已在其他地方修改。请选择要保存的内容。</p>
    <div className="file-conflict-columns"><div><strong>当前文件</strong><CodeEditor label="当前文件内容" value={current} format={format} readOnly compact /></div>
      <div><strong>本次修改</strong><CodeEditor label="本次修改内容" value={edited} format={format} readOnly compact /></div></div>
    <div className="file-conflict-actions"><button type="button" disabled={busy} onClick={onKeep}>保留当前文件</button><button type="button" disabled={busy} onClick={onUse}>使用本次修改</button></div>
  </div>;
}
