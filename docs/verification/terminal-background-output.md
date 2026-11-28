# 后台终端输出的主线程开销（R16）

结论：隐藏窗格中的终端每滚动一行，xterm 都会安排一次「选区重绘」。这次重绘绕过了 xterm 的可见性暂停，每帧把隐藏窗格的全部行用 DOM 渲染器重画一遍。`display:none` 下字符宽度无法缓存，每个字符都触发一次同步样式计算。修复后，隐藏窗格只记下最新的选区，重新显示时重绘一次。合成场景中后台输出期间的主线程时间从约 7.8 s 降到约 0.35 s（约为改动前的 4.5%），长任务从 4–5 个（最长约 3 s）降到 0 个。

以下数字都是**浏览器预览加合成 IPC**（`vite preview` 加 `tests/ui` 的 workbench mock，Playwright 1.63.0 自带的 Chromium headless shell）的结果。原生 WebView2 没有验证。测试环境下 `navigator.webdriver` 为 true，应用不加载 WebGL，所有终端都使用 xterm 的 DOM 渲染器；产品中可见窗格使用 WebGL，隐藏窗格释放 WebGL 后同样使用 DOM 渲染器，所以隐藏窗格的路径与测试环境一致。

环境：Intel i7-9700F（8 核）、32 GB、Windows 10.0.26300；基线为 `ffe07655`，xterm 6.0.0。测量期间机器上还有其他负载，按 Owner 要求 Playwright 限制为 2 个 worker，同一时间只运行一个 Playwright。

## 触发点

### 已知（T8 的 CPU profile）

`docs/verification/test-suite-performance.md`「40 个终端」一节：从注入输出到 40 个终端全部回复共 28.4 s，`WidthCache._measure` 的 self time 为 26.1 s。调用栈从 rAF 开始：

`SelectionService._refresh` → `onRequestRedraw` 监听 → `RenderService.handleSelectionChanged` → `DomRenderer.handleSelectionChanged` → `DomRenderer.renderRows(0, rows - 1)` → `DomRendererRowFactory.createRow` → `WidthCache.get` → `WidthCache._measure`

CPU profile 中 rAF 回调的栈从 `_refresh` 开始，看不到是谁安排了这一帧，所以 T8 没有确定来源。

### 确认来源（本次）

在临时构建中包装每个终端的 `SelectionService.refresh`、`RenderService.handleSelectionChanged/handleBlur/handleFocus/handleCursorMove/handleResize` 和 DOM 渲染器的 `renderRows`，按调用栈和「窗格是否隐藏」计数。场景与「40 个后台终端」用例相同（40 个会话，39 个隐藏，每个 1600 行加 DSR）。只统计注入输出之后的调用：

| 调用 | 隐藏窗格 | 可见窗格 |
| --- | ---: | ---: |
| `SelectionService.refresh`，来自滚动事件 | 61,542 | 1,573 |
| `RenderService.handleSelectionChanged`（rAF 合并后） | 239 | 11 |
| `DomRenderer.renderRows`，来自 `handleSelectionChanged` | **239** | 11 |
| `DomRenderer.renderRows`，来自正常的 `_renderRows` | 0 | 11 |
| `SelectionService.refresh`，来自 `clearSelection`、`_handleTrim` | 0 | 0 |

所有 `refresh` 都来自同一个调用点，即 `CoreBrowserTerminal.open` 中注册的滚动监听（`@xterm/xterm/src/browser/CoreBrowserTerminal.ts` 第 535–541 行）：

```ts
this._register(Event.any(this._onScroll.event, this._inputHandler.onScroll)(() => {
  this._selectionService!.refresh();
  this._viewport?.queueSync();
}));
```

输出到达底部后，每个换行都使缓冲区滚动一行并触发这个监听，与有没有选区无关。`SelectionService.refresh` 用 rAF 合并，每帧最多一次（`SelectionService.ts` 第 279–283 行）。这一帧调用 `RenderService.handleSelectionChanged`，后者直接转给渲染器，没有检查 IntersectionObserver 设置的 `_isPaused`（`RenderService.ts` 第 303–307 行；对比 `refreshRows` 第 142–146 行会检查）。`DomRenderer.handleSelectionChanged` 不论有没有选区都重画全部行（`DomRenderer.ts` 第 339–343 行）。隐藏窗格的 `offsetWidth` 为 0，而 `WidthCache.get` 只缓存大于 0 的宽度（`WidthCache.ts` 第 134–165 行），所以每个单元格都重新测量。

T8 列出的两个候选都已排除：`clearSelection`（行数变化时的 `onResize`）在输出期间没有被调用；`_handleTrim` 只在选区移出缓冲区时才请求重绘，没有选区时不调用。

其余绕过暂停的路径在输出期间没有渲染隐藏窗格的行：`handleCursorMove` 在 DOM 渲染器中是空操作；`handleBlur` 只在窗格隐藏的那一刻发生一次（产品中这时 WebGL 渲染器还在）；`handleResize` 在暂停时由 `RenderService` 推迟。

用 CDP `Performance.getMetrics` 看，这段时间几乎全部计在 `RecalcStyleDuration`（下表约 7.2 s / 7.8 s），布局（`LayoutDuration`）只有几毫秒：`display:none` 的元素不参与布局，但每次读取 `offsetWidth` 前都要重新计算刚被修改的测量元素的样式。

## 修复

`src/features/sessions/terminalRenderPause.ts` 的 `TerminalRenderPause` 包装该终端 `RenderService` 实例的 `handleSelectionChanged`：

- 暂停时只保存最新一次的参数，不调用渲染器；
- 恢复时用保存的参数调用一次原方法（DOM 渲染器因此只重画一次，可见后宽度可以缓存）；
- `dispose` 恢复原方法。找不到这个内部服务时不做任何事，保持 xterm 的默认行为。

`SessionTerminal.tsx` 在创建终端后安装它。暂停与否只看窗格是否隐藏，即 `hidden={!active && !peeking}` 的同一条件，不按 CLI 区分：挂载时若隐藏就立即暂停，之后在 `useLayoutEffect([active, peeking])` 中切换。layout effect 在 React 改变 `hidden` 之后、下一帧之前执行，所以已经排队的选区帧也不会画到隐藏的窗格上。预览（peek）的窗格是可见的，不暂停。

不变的部分：解析、DSR/DA 等协议应答（仍由隐藏终端的 `onData` 发出）、选区模型（`getSelection`、复制、查找）、正常的 `refreshRows`（仍由 xterm 的 IntersectionObserver 暂停并在显示时整屏刷新）、`fitNow` 与 PTY 尺寸、WebGL 生命周期、输入法、链接、空闲后裁剪 scrollback。

xterm 的公开 API 没有可以挂接的点，所以使用了私有字段 `_core._renderService`。依赖集中在这个小模块，已针对 xterm 6.0.0 核对。`tests/native/terminal-render-pause.test.mjs` 覆盖暂停、恢复、只保留最新选区、`dispose` 还原和缺少内部服务时不生效；同一文件还检查已安装的 xterm 版本为 6.0.0，并检查 `lib/xterm.mjs` 中 `RenderService.handleSelectionChanged` 仍然不检查 `_isPaused`、滚动仍然调用 `_selectionService.refresh()`。升级 xterm 时这条测试会失败，提示重新核对。

## 主线程时间（改动前后各 3 次）

场景尽量小：1 个可见会话（不输出）加 9 个隐藏会话，每个隐藏会话写入 800 行（`row-N` 加 64 个 `x`）和一个 DSR。窗口从注入输出开始，到 9 个会话都回复 DSR 后再等 500 ms 结束。主线程时间为 `Performance.getMetrics` 的 `TaskDuration` 差值；长任务来自页面内的 `PerformanceObserver('longtask')`。改动前为基线 `ffe07655` 的 `SessionTerminal.tsx`，改动后为本次版本，其余文件相同，各自 `vite build` 后用同一条命令运行（`--project=terminal --repeat-each=3 --workers=1`）。

| | 次序 | 墙钟（注入→全部回复） | 主线程时间 | 其中样式计算 | 脚本 | 长任务数 | 最长长任务 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 改动前 | 1 | 7,362 ms | 7,767 ms | 7,181 ms | 493 ms | 5 | 2,697 ms |
| 改动前 | 2 | 7,182 ms | 7,708 ms | 7,191 ms | 467 ms | 4 | 3,056 ms |
| 改动前 | 3 | 7,459 ms | 7,924 ms | 7,385 ms | 488 ms | 4 | 2,932 ms |
| 改动后 | 1 | 313 ms | 307 ms | 73 ms | 147 ms | 0 | — |
| 改动后 | 2 | 266 ms | 391 ms | 151 ms | 138 ms | 0 | — |
| 改动后 | 3 | 346 ms | 353 ms | 66 ms | 157 ms | 0 | — |

主线程时间均值：改动前 7,800 ms，改动后 350 ms，约为 4.5%，满足「不超过改动前一半」。改动后的最大值（391 ms）也只有改动前最小值（7,708 ms）的 5%。

测量用的临时用例（运行后已从 spec 中删除），步骤如下：

1. 页面初始化脚本增加 9 个运行中的会话，并用 `PerformanceObserver({ type: 'longtask' })` 记录长任务。
2. `openWorkbench`，等 9 个隐藏窗格的 `.xterm-screen` 都出现，再等 1.5 s 让挂载工作结束。
3. `Performance.enable`，清空长任务记录，读取一次 `Performance.getMetrics`。
4. 向 `load-0` 到 `load-8` 各写入 800 行和 `\x1b[6n`。
5. `expect.poll`（100 ms 间隔）直到 9 个会话都回复 CPR，再等 500 ms，读取 `getMetrics` 和长任务，输出差值。

## 用例

- 「forty live terminals keep background output within the workbench memory budget」：去掉 `test.slow()`，轮询时限从 75 s 恢复为 T8 之前的 20 s，测试本身使用默认时限；输入数据（40 × 1600 行）和堆预算（< 48 MB）不变。
  - `--repeat-each=5`（terminal 项目，2 个 worker）：5/5 通过，共 16.2 s；GC 后 `usedSize` 19.9–21.6 MB。
  - 全量运行：按 Owner 要求不跑整个 Playwright 全量，用 `workbench-terminal.spec.ts` 的 terminal 与 terminal-gpu 两个项目的完整运行代替（`PLAYWRIGHT_WORKERS=2`）：147 个用例全部通过（terminal 133、terminal-gpu 14），共 3.5 min；这个用例用时 4.0 s（T8 记录的全量中约 64 s）。
  - 探针场景（40 个会话，加了计数包装）：从注入到全部回复，改动前 95 s，改动后 3.4 s。
- 新增「a hidden pane parses heavy output and answers DSR/DA without redrawing rows, then draws it once revealed」：窗格隐藏后写入 1200 行和 DSR、DA；隐藏期间收到两种应答，隐藏窗格的行内容不变；重新显示后可见行包含最后一行、旧内容已滚出、只有一个光标，滚动位置在底部且有完整的 scrollback，该会话没有 PTY resize。在基线代码上这条用例失败（隐藏期间行内容被重画成 `hidden-row-1172…1199`），在改动后通过。
- 新增「a temporary look renders live output in the otherwise hidden pane」：临时查看另一个会话时，分三次写入输出，每次都立即出现在预览窗格的行中。
- 已有的「switching sessions preserves a reading position while background output keeps arriving」继续覆盖隐藏期间的阅读位置保持；「hidden live terminals answer cursor queries without accepting keyboard input」继续覆盖隐藏时的 CPR。

## 清理

改动前的构建通过临时把工作区中的 `SessionTerminal.tsx` 换成基线版本得到，测量后已恢复，`dist` 已按改动后的代码重新构建；没有创建临时 worktree。探针包装和测量用例都已删除。
