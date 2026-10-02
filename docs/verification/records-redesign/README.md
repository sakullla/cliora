# 使用记录与用量 UI 改版

2026-10-02。本目录截图使用合成的 native IPC 数据，不包含真实会话或密钥；不作为 Tauri 原生平台验收证据。

- 用量：四张核心指标卡、趋势与 Token 构成、模型/工具/项目分布、重点会话入口；费用趋势的峰值和平均值跟随所选指标。
- 会话：收藏和时间分组、双栏阅读、突出当前选中项、改善正文留白；640 px 窗口使用列表与详情切换。
- 日期：会话与用量共用范围日历，支持反向日期归一化、跨月键盘选择、取消还原、确认后原子更新统计范围，包含起止日。
- 交互：页签切换保留用量筛选；用量跳转会话时清除冲突的会话筛选；加载错误可保留条件重试；时间和页签支持方向键及 Home/End。

验证：`npm run verify` 通过，包含 16 项 Node 测试、70 项 Playwright 测试及 TypeScript/Vite 构建。构建仍提示主包大于 500 KB。会话类型与性能相关 Rust 变更见 [性能验证](../history-performance.md)；macOS 原生行为未在本机验收。

截图覆盖浅色/深色，宽度 1360、900、640 px，高度 1000 px。捕获脚本检查页面错误和元素横向越界，结果为空。

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 用量总览 | [1360](usage-light-1360.png) · [900](usage-light-900.png) · [640](usage-light-640.png) | [1360](usage-dark-1360.png) · [900](usage-dark-900.png) · [640](usage-dark-640.png) |
| 用量明细 | [1360](usage-details-light-1360.png) · [900](usage-details-light-900.png) · [640](usage-details-light-640.png) | [1360](usage-details-dark-1360.png) · [900](usage-details-dark-900.png) · [640](usage-details-dark-640.png) |
| 日期筛选 | [1360](usage-dates-light-1360.png) · [640](usage-dates-light-640.png) | [1360](usage-dates-dark-1360.png) · [640](usage-dates-dark-640.png) |
| 会话 | [1360](sessions-light-1360.png) · [900](sessions-light-900.png) · [640](sessions-light-640.png) | [1360](sessions-dark-1360.png) · [900](sessions-dark-900.png) · [640](sessions-dark-640.png) |
| 窄窗口详情 | [640](session-detail-light-640.png) | [640](session-detail-dark-640.png) |

复现（先启动 Vite，再在另一终端捕获）：

```powershell
npm run dev -- --port 14739
```

```powershell
$env:CLIORA_PREVIEW_URL = 'http://127.0.0.1:14739'
$env:CLIORA_CAPTURE_OUT = 'docs/verification/records-redesign'
node scripts/capture-ui.mjs --records
```
