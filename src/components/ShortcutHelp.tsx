import { GuideDialog } from './GuideDialog';
import { modLabel } from '../lib/shortcut';

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <GuideDialog open={open} title="键盘快捷键" onClose={onClose}>
    <div className="shortcut-help">
      <section><h3>全局</h3><dl>
        <div><dt><kbd>{modLabel}+K</kbd></dt><dd>快速前往页面、工具或项目</dd></div>
        <div><dt><kbd>{modLabel}+1…5</kbd></dt><dd>切换页面</dd></div>
        <div><dt><kbd>{modLabel}+\</kbd></dt><dd>折叠或展开侧栏</dd></div>
        <div><dt><kbd>/</kbd> 或 <kbd>{modLabel}+F</kbd></dt><dd>聚焦当前页搜索</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>清空搜索或关闭对话框</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>打开本面板</dd></div>
      </dl></section>
      <section><h3>编辑与对话框</h3><dl>
        <div><dt><kbd>{modLabel}+S</kbd></dt><dd>保存当前对话框</dd></div>
        <div><dt><kbd>Alt+1…6</kbd></dt><dd>工具与连接中切换任务视图</dd></div>
        <div><dt><kbd>方向键</kbd></dt><dd>在标签页与选项间移动</dd></div>
      </dl></section>
    </div>
  </GuideDialog>;
}
