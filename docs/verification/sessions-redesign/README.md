# 会话库与阅读区改版

2026-10-02。截图使用合成数据，不包含真实用户历史。

左侧集中搜索、工具/收藏/日期/项目/模型筛选，支持最近活跃、最早活跃、消息最多三种排序。列表显示工具、时间、项目和消息数，收藏与日期分组保留，键盘顺序跟随排序。

右侧突出会话标题和继续会话入口，恢复命令默认折叠，复制失败时自动展开供手动选择。阅读区支持 Markdown 标题、列表、表格、代码块复制、原文切换、长消息展开、只看提问、会话内查找与匹配消息跳转。查找期间显示原文并高亮匹配。外部图片仅显示描述；链接点击复制地址。Markdown 不执行嵌入 HTML。

窄窗口使用列表与详情切换，打开详情与返回列表时移动键盘焦点。会话读取失败提供原位重试，不持续显示加载骨架。

## 验证

- `npm run verify`：16 项 Node 测试、65 项 Playwright 测试、TypeScript/Vite 构建通过。
- 新增阅读器回归覆盖 Markdown、代码复制、原文与全文、查找/提问过滤/最新消息、排序与读取失败重试。
- 浅色与深色，1360、900、640 px 宽度、1000 px 高度：截图脚本未发现页面错误或横向越界。
- 本机 Windows 开发版 `src-tauri/target/debug/cliora.exe` 已实际打开会话页，并确认真实索引列表、筛选区、会话详情与正文显示正常。真实记录截图仅用于临时检查，未纳入仓库；此观察不代表原生恢复、导出或其他平台验收。
- Markdown 按需加载为独立代码块；构建仍有既存主包大于 500 KB 的提示。

## 预览

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 会话库 | [1360](sessions-light-1360.png) · [900](sessions-light-900.png) · [640](sessions-light-640.png) | [1360](sessions-dark-1360.png) · [900](sessions-dark-900.png) · [640](sessions-dark-640.png) |
| 阅读区 | [1360](session-reading-light-1360.png) · [900](session-reading-light-900.png) · [640](session-reading-light-640.png) | [1360](session-reading-dark-1360.png) · [900](session-reading-dark-900.png) · [640](session-reading-dark-640.png) |
| 窄窗口详情 | [640](session-detail-light-640.png) | [640](session-detail-dark-640.png) |

先启动 `npm run tauri dev` 或 `npm run dev`，再运行：

```powershell
$env:CLIORA_PREVIEW_URL = 'http://127.0.0.1:1420'
$env:CLIORA_CAPTURE_OUT = 'docs/verification/sessions-redesign'
node scripts/capture-ui.mjs --sessions
```
