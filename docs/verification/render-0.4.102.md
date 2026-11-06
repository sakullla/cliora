# 0.4.102 持续终端重绘优化

## 原生现场与 CodeBuddy 线索

2026-11-06 22:55，已安装的 Cliora 0.4.100 运行约 3 小时 50 分钟。WebView2 156.0.4314.58 的渲染进程 private bytes 约 640 MiB，合成线程约占满一个核心。160 次指令指针采样有 104 次落在 `DestroyTrackers`、52 次落在 `FinishImplFrame` 的集合扫描循环；103 秒间待移除 tracker 由 388,505 增至 394,117。128 个分布样本中有 127 个等待终止、1 个可终止。这是 0.4.100 上的真实复现，不以之前的浏览器缓存测试替代。

当前两个 CLI 会话分别为 CodeBuddy 与 Codex。CodeBuddy 20:20 启动，Codex 22:00 启动；一次采样中 CodeBuddy 仍有活动，Codex 接近空闲。这些关联不能独立证明 CodeBuddy 是唯一触发源。

本机安装的 CodeBuddy 2.181.0 发布包明确使用默认 `maxFps ?? 30`，并以 `CSI ?2026h` / `CSI ?2026l` 包裹终端同步更新，更新中包含擦行、光标移动和显隐。压力输入依据这个协议形态合成，不包含用户的项目、提示或终端内容。没有在共享服务中按 CodeBuddy ID 分流，也没有更改 CLI 配置或登录。

## 原生 WebView2 对照

使用 Microsoft.Web.WebView2 1.0.4314.35 的独立 WinForms 测试宿主，运行本机 WebView2 156.0.4314.58；加载生产 Vite 构建和工作台合成 IPC。用户的 Cliora 与 CLI 会话保持运行。

测试窗口位于屏幕之外，关闭原生遮挡节流，document visibility 为 visible，渲染器为真实 WebView2/WebGL。通过仅测试进程的本机 CDP 端口采集 `Performance.getMetrics` 和动画帧请求。每轮 30 秒，每 33 ms 发送一次同步更新，擦除并重写两行状态区。四轮均使用相同负载，未运行实际 CodeBuddy 任务。

| 配置 | 更新次数 | requestAnimationFrame 请求 | 活动 CSS 动画 | 样式重算 | 主线程 TaskDuration |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.4.100 WebGL 基线 | 909 | 5,408 | 6 | 2,286 | 3.872154 s |
| 0.4.100 强制 DOM | 909 | 5,365 | 7 | 2,668 | 4.921145 s |
| 0.4.100，仅临时关闭 CSS 动画 | 910 | 5,333 | 0 | 2 | 2.335523 s |
| 本次优化，保留 WebGL | 911 | 1,893 | 0 | 16 | 1.218332 s |

优化轮动画帧请求约减少 65%，TaskDuration 约减少 69%。这是该负载下的主线程工作量，不是整机 CPU 或总内存下降比例；测试没有证明 WebView2 的长期原生 tracker 积压已完全消失。DOM 对照额外产生 1,747 次 layout，基线仅 5 次，因此没有将 DOM 作为默认替代方案。

## 改动

- 输出以 16 ms 定时器合并后交给 xterm，绘制帧交由 xterm 自己调度，避免每批输出再启动一层 RAF。隐藏时继续解析和回复终端协议。
- 已处于末行时不再为每次状态重绘安排延迟滚动跟随；真实视口偏移仍执行纠正，用户回看历史仍保留位置。
- 滚动条仅在 buffer 类型、滚动范围、当前位置、终端行数或视口高度变化时触发 React 更新。
- 隐藏终端不再安排最终会被可见性检查跳过的输入法定位帧；可见终端保留定位与中文输入处理。
- 运行、输出、通知状态使用固定图标、颜色和文字；移除侧栏呼吸、状态闪烁、顶栏扫光等持续动画。保留终端光标偏好、加载指示与短暂界面过渡。

## 验证与边界

新增真实 WebGL 回归以 30 FPS 同步更新发送 90 次重绘，检查帧请求预算、无持续装饰动画、最新内容可查找，以及 DSR 回复仍正常。已有中文组合输入、页内回看、鼠标协议、恢复、滚动条、远程会话及 WebGL 生命周期回归一起验证。

本轮改动降低了有证据的重复渲染开销；首次导致原生 tracker 无法终止的条件仍未隔离。需要升级后的实际桌面持续运行验证。已经积压的旧进程不会因源代码修改自动清空，未强制重启用户的窗口或会话。

原生清理机制参考：[Chromium FrameSequenceTrackerCollection](https://chromium.googlesource.com/chromium/src/+/HEAD/cc/metrics/frame_sequence_tracker_collection.cc)。测试宿主依据 [Microsoft WebView2 WinForms 文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)搭建。
