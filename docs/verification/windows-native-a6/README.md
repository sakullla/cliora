# Windows 现场记录的范围

这些是 Windows 11 Pro 10.0.26200、AMD64、150% DPI 上的实际 Tauri/WebView2、SQLite、system keyring 和原生对话框观察。它们属于部分 UI/管道证据，不是 `native-platform-observation` 的完整六项组合，不计入平台矩阵通过数。

`initial/` 保留最初 A6 候选 `6274f53ccb165cf880be2a4f1175f6f7d34b30ae81e2f83c3e64725c065778f0` 的历史记录：五 CLI 临时配置新建/命名/继承/保存/重新打开、真实 1160×780/900×650/720×560 明暗五页面边界、保存/取消导出、CLI 上下文切换、真实目录选择与无副作用 CLI shim 的启动/恢复 argv。对应用户全局原生文件的前后哈希一致。背景版本探测观察到零个新可见控制台窗口，原版本的相同观察曾记录十二个。

`refinement/` 的简化界面记录绑定隔离候选 `95969f2ee3f81ff5ab62b33da5efab3364f9fce1681ad8e84307bf7737912ff0`、identifier `dev.cliora.verification.a6`。它验证了生产 CSP nonce、动态 CodeMirror 样式表和光标图层几何；真实模型目录 GET 200/107、输入 key 保存后重新获取；Pi 默认 models 文件与文件切换；真实本地 ZIP picker 的单包/多包及完整资源；项目下拉和当前原文直接保存。这个 identifier 的数据目录与用户普通应用分离，不能冒充普通 candidate 的已写入验收。

每份 JSON 保留其实际时间、candidate hash、检查结果及限制。历史报告中的 Temp 路径是当时现场位置；不把已退出的 PID 描述为仍在运行。`history-read-timing.json` 只记录索引数量与 IPC/SQL 耗时，不含用户会话文本。没有复制导出内容、私人历史截图或 API key。

`helpers/` 保留现场使用的编辑器几何/鼠标菜单检查、Win32 原生对话框操作、可见控制台采样以及 harmless 终端 cwd/argv/TTY/color 记录器。脚本里的 fixture 版本字符串只是 shim 身份，不能当作供应商 CLI 行为；它们保留当时 Temp/Node 路径，需要在其它机器上明确替换本机路径，并且只能操作自己创建的验证实例。

后续 UI 和行为修复使这些候选早于最终源码：它们支持对应修复的现场因果，不代表最终外观、最终 hash 或完整发布验收。尤其最初 `native-ui-after.json` 的 token/nonce 检查不证明空编辑器光标和鼠标选区；后续几何及真实 pointer 操作独立验证这些边界。

`pre-confirm/` 保留普通 `8b5019…` 和隔离 `3d1d8c…` 的构建输入与真实输出，以及修复前的现场结果。隔离壳九个功能检查通过，但末尾存在原生 confirm ACL 错误，整份报告保持失败。CSP 初次失败与来源诊断也保留：实际违反发生于 Playwright 的 contenteditable `fill` 操作，改用真实键盘输入后没有新增事件；产品 CSP 没有放宽。`native-final-records-stop-failure.json` 记录停止扫描后后台仍 running，失败结尾未记录当时 progress，具体工具/阶段保持未知；之后的 `native-final-records-layout-after.json` 只核布局并通过，没有复验扫描停止。`native-final-color-after.json` 绑定更早的 `b69efb…` 壳，不能重新标成最终 hash。

`pre-sdk-confirm/` 记录普通 `c0fcff…` 与隔离 `866dce…` 的相同输入源码 `725dce…`。实机七项功能通过后规则开关因 injected confirm 命令错误未执行，失败原样保留。独立 records/cache/stop 与窗口布局 32 项通过：缓存首屏 268.9ms，794 Codex 会话/7 模型分组，list 247.1ms、usage 312ms，停止扫描 52.2ms，缓存 IDs 完整保留。最初 helper 缺必需 `favoriteOnly` 字段的失败另存，修正 helper 后完整通过；没有因此放宽生产 DTO。后续 SDK/CSS 修复仍需新候选绑定的实机结果。

完整 native CLI 接受配置、真实供应商会话恢复、完整托盘生命周期、安装、三平台与真实第三方 WebDAV 尚未验收。[平台矩阵](../platform-evidence.json) 保持 0/15。

`pre-application-confirmation/` 保存普通 `e7ec98…` 与隔离 `190914…`、源码输入 `449669…` 的真实构建记录。隔离壳七项功能通过后，系统确认驱动未完成规则停用，报告保持失败；当时窗口采样没有检测到确认窗口，无法据此确证 SDK 产品错误。用户随后明确要求应用内确认，因此共用 Promise 服务改由 `ConfirmationHost` 承接，不再调用 SDK 或 `window.confirm`，无需系统确认权限。`application-confirmation-browser/` 是带 native IPC fixture 的真实浏览器截图与边界记录，明暗 × 640/1160 均默认聚焦取消，Escape 不发送移除请求。既有 24 项 UI 流程通过实际弹层按钮复验，不能把这批浏览器结果冒充生产 WebView 或平台六项组合通过。

最终 [普通构建](final/production-build.json) 的稳定 EXE 摘要为 `9d3922b1f7b5cbee4c49f5d0c820acefe6c1834c3cabb6d67d6d2d8478427dcc`；[隔离构建](final/isolated-build.json) 为 `185849811117743d3ba60315b7578a31ea168137cf5cb4e34af911cd0479f2c9`，二者均为 25,832,960 bytes / PE x64，exit 0、sourceUnchanged。相同的构建输入 [source-worktree.json](final/source-worktree.json) 摘要为 `cf9d402ab99a708fa758e921d7dc13a3a7a204e9713e23ca1a50507c9efc2c26`，已逐文件核对输入及稳定工件 bytes。它是工作树输入记录，不能用旧 HEAD 冒充当前源码 checkpoint。普通 identifier `com.cliora.desktop` 未启动，以免触碰用户正在编辑的既有窗口；隔离 identifier `dev.cliora.verification.a6final` 的现场检查只能绑定其自身 hash。真实 stdout/stderr 已从构建进程输出解码为 UTF-8/LF，原有链接器输出警告保留；这些是 Worker/Owner 协作开发构建，不是下一次正式 Delivery 验证。

最终隔离壳的 [产品检查](final/native-final-product-after.json) 10/10 通过：真实选目录自动命名、当前文件直接保存、真实鼠标跨行选区/双击与六项菜单的撤销/重做/全选/Escape、外改比较与加密备份恢复、Claude 六角色应用后取消默认 1M、Codex 双 Skill 交错开关、Claude/OpenCode/Pi 原生或完整存档开关、MCP 停用重选、规则原始 bytes 恢复，以及应用内项目移除的 Escape/取消/接受。真实 WebView CSP 事件和 pageerror 均为零。没有覆盖剪切/复制/粘贴实机操作，以保护用户系统剪贴板。

[记录与布局](final/native-final-records-layout-after.json) 32/32 通过，含 150% DPI 的 1160×780、900×650、720×560 × 明暗 × 五页三十组边界。缓存首屏 198.1ms，796 个 Codex 会话、7 个模型分组；后台扫描 23,009.6ms，不能写成首次全量扫描只需 198.1ms。单独刷新后取消在 49.8ms 内完成，记录当时 phase 为 Codex，缓存 IDs 保留；这不回推早期失败时未知的阶段。两个 [交互终端检查](final/native-final-color-after.json) 2/2 通过：首页 Windows Terminal 与直开 PowerShell 均 stdin/stdout TTY、hasColors true，继承 NO_COLOR/TERM=dumb 被清除；本次报告 colorDepth 为 4，不能用更早壳的 24 覆盖这个观察。运行的是无网络的身份认证 shim，没有供应商会话或付费模型请求。明暗 [应用内弹层](final/final-application-confirmation-light.png)、[深色弹层](final/final-application-confirmation-dark.png) 及 [规则编辑](final/final-native-rule-editor.png) 已实际目视核对，样式、文件名、选项高度与文本无溢出。

[清理记录](final/process-cleanup.json) 证明只关闭验证实例 PID 20340，未操作用户窗口。测试 shim 退出后曾留下独有标题的 WT 标签，Root 用 UIA 仅关闭该标题并复查没有残留；这是验证工具收尾，没有改产品源码。`helpers/native-final-product-check.mjs`、`native-final-records-layout-check.mjs` 与 `editor-interaction.mjs` 保留可复现的实际交互方式；helper 后续补了终端 finally 收尾，不能声称这个新增收尾分支已随上述功能整套重新执行。系统文件 picker helper 与旧系统确认驱动的历史边界分别保留，不把它们作为最终应用内确认验收。
