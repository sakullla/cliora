import type { ChangeEvent } from 'react';
import { ToolIcon } from '../../components/ToolIcon';

export function ToolIconSettings({ tools, icons, busy, onChange, onError }: { tools: { id: string; name: string }[]; icons: Record<string, string>; busy: boolean; onChange: (id: string, data: string | null) => Promise<void>; onError: (message: string) => void }) {
  async function pick(id: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 128 * 1024) { onError('请选择不超过 128 KB 的 PNG、JPEG 或 WebP 图标。'); return; }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => null);
    if (!data) { onError('无法读取图标，请重新选择。'); return; }
    await onChange(id, data);
  }
  return <details className="icon-settings"><summary>自定义工具图标</summary><p>选择本地图片，随管理偏好迁移。PNG、JPEG 或 WebP，最大 128 KB。</p>
    {tools.map((tool) => <div className="icon-setting-row" key={tool.id}><span className="tool-identity"><ToolIcon toolId={tool.id} size={26} />{tool.name}</span><label className="button icon-file">选择图标<input aria-label={`${tool.name} 自定义图标`} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void pick(tool.id, event)} /></label><button className="text-button" type="button" disabled={busy || !icons[tool.id]} onClick={() => void onChange(tool.id, null)}>恢复默认</button></div>)}
  </details>;
}
