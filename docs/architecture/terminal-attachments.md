# CLI 工作台附件粘贴

## 传输与输入边界

剪贴板 `paste` 事件和用户点选的粘贴菜单提供内容，快捷键不决定 CLI 协议。文字继续使用 xterm 的普通粘贴；文件进入共享队列。PNG 解码验证后复用原始字节，其他剪贴板图片转 PNG，普通文件保留名称和字节。失败后复用已编码数据。

远端文件以最多 8 个文件、约 16 MiB base64 的批次传输（单个较大文件独立传输），复用已有 SFTP 批处理、临时文件、原子名称认领与回收记录。上传只显式重试；成功批次的路径被保留，后续批次失败不会重新上传前面已确认的批次。失败会暂停该会话的后续队列，直到重试或关闭错误。单个失败批次仍可能留下已传文件，保持原有记录及回收语义，不自动重放不确定写入。

共享 SSH/SFTP 参数使用 `-o Port=<port>`：SSH 的 `-p <port>` 不能直接传给 SFTP，后者的 `-p` 表示保留属性。密码 askpass、配置文件、主机密钥验证、取消及 600 秒上传期限保持原有边界。上传和结束会话的回收操作共用会话锁，避免上传尚未登记就先完成回收。

本地图片也不模拟 Ctrl+V：`stage_session_paste_files` 接收与远端一致的 `{name, bytesBase64}` 文件条目，返回实际临时路径；临时目录由本地会话持有并在关闭时回收。相同文件名使用不同暂存子目录，避免互相覆盖。本地拖放复用已有路径，按同一适配器输入策略投递；菜单粘贴读取图片内容，富剪贴板 API 不可用时回退读取文字。

上传完成后，工作台通过 `uiAdapterFor(toolId).attachmentPastes` 获取输入片段；终端在 CLI 已开启 bracketed paste 时，将每个片段分别封装为 `ESC[200~...ESC[201~`，一次有序 PTY 写入，不追加 Enter。未开启时退回带空格分隔的字面路径输入。上传完成不会切换会话或抢焦点；PTY 写入失败保留已传路径供重试。

## 适配器扩展与支持边界

CLI 特有格式只在 `src/adapters/<cli>/` 注册。新增 CLI 可实现 `ToolUiAdapter.attachmentPastes(paths): string[]`，无需修改共享工作台、上传服务或终端的 ID 分支。共享层拒绝路径中的终端控制字符，并处理引用和 Windows 分隔符。未注册此能力的适配器只接收字面路径，不承诺生成图片附件。

当前 15 个终端 CLI 均有明确策略；ZCode、DeepSeek 桌面和 Cursor 桌面不在终端粘贴范围内。

| CLI | 输入策略 | 协议证据 / 限制 |
| --- | --- | --- |
| Codex | 图片路径逐个 paste，其余路径合并 | 上游 [paste_input.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer/paste_input.rs) 的图片路径检测 |
| Claude Code | 路径引用 | 官方 [图片工作流](https://code.claude.com/docs/en/common-workflows#work-with-images) |
| Grok | 路径逐个 paste | 官方 [图片拖放说明](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md) |
| Pi | 路径引用 | 本机 `@earendil-works/pi-coding-agent` 1.4.0 `handleClipboardPaste` 保存图片后插入路径；不是伪造附件标记 |
| OpenCode | 路径逐个 paste | 上游 [pasteInputText / resolvePastedAttachments](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/component/prompt/index.tsx) |
| MiMo Code | 路径逐个 paste | 上游 [pastePlainText](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/cli/src/cli/cmd/tui/component/prompt/index.tsx)；所选模型无图片能力时由 CLI 保留路径并提示 |
| Qoder CN | `@` 文件引用 | 文件上下文；不使用其 [Alt+V 图片快捷键](https://docs.qoder.com/cli/interface) |
| Kimi Code | `@` 文件引用 | 本机 `@moonshot-ai/kimi-code` 2.4.1 `toMentionItem`；旧版 [文件引用说明](https://moonshotai.github.io/kimi-cli/en/guides/interaction.html) |
| CodeBuddy | 路径引用 | 官方 [处理图片](https://www.codebuddy.ai/docs/zh/cli/common-workflows) |
| Cline | `@` 文件引用 | 上游 [Include images in tasks](https://github.com/cline/cline/blob/main/docs/usage/cli-overview.mdx) |
| Devin | `@` 文件引用 | 官方 [CLI 文件上下文](https://devin.ai/cli)；本次未验证其图片附件显示 |
| Command Code | 路径逐个 paste | 官方 [Interactive Mode](https://commandcode.ai/docs/interactive-mode) 支持图片路径、引号及文件 URI |
| Antigravity | `@` 文件引用 | 官方 [文件引用与媒体输入](https://antigravity.google/docs/cli/prompting/) |
| Kiro | 路径引用 | 官方 [Working with images](https://kiro.dev/docs/cli/chat/images/) |
| MiniMax Code | `@` 文件引用 | 本机 `@minimax-ai/code` 0.6.13 的剪贴板失败提示明确建议使用 `@` 文件引用 |

`@` 引用、路径读取和 CLI 原生附件卡片不是同一保证。上述资料说明输入方式；实际模型是否接收图片、文件访问权限和 CLI 的 UI 展示由 CLI 决定。本次自动化验证覆盖所有策略的路由和字节，不把浏览器 mock 当作 15 个真实 CLI 或远端模型的接受证据。

## 输入法

xterm 6 的 CompositionHelper 和 emoji `insertText` 补偿可能同时发送同一次中文确认。终端容器在组合输入及其提交事件轮次拦住第二条 `insertText` 路径，保留浏览器对 textarea 的更新，让 CompositionHelper 独占提交。没有按字符串或时间阈值去重，因此用户连续输入相同词语仍保留。回归测试关闭 webdriver 专用的屏幕阅读模式，实际覆盖普通渲染路径。

## 验证

- Windows 原始 `sftp -p 22 -b - root@127.0.0.1` 在连接前复现 usage；修复参数的 Rust 回归检查包含非默认端口、密码/密钥、SSH 配置和 batch destination。
- Windows OpenSSH 使用 `-o Port=2222`，以 `-D` 连接本机 WSL `/usr/lib/openssh/sftp-server`：含空格文件名的 1 MiB 二进制上传成功，返回 0，字节一致，单次观测 2.75 秒。此项验证真实 SFTP 客户端与服务端，不包含用户远端网络或认证验收，也不是性能基准。
- Rust 上传测试覆盖临时传输、名称冲突、失败残留、记录、回收及禁止自动重放；暂存测试覆盖同名文件、非法名称和失败清理。
- Playwright 覆盖 15 个终端适配器、图片协议边界、普通文件原始字节、失败重试、分屏与后台会话、PTY 写入失败、中文重复提交。
- Node 测试覆盖适配器能力扩展与路径安全边界。
- 本次执行：157 项 Node 测试通过；工作台、上传及粘贴三组 Playwright 共 86 项通过，补充菜单/拖放用例后的附件两组 34 项通过，最终本地路径和 IME 复查 6 项通过；前端构建通过。
- Windows 原生会话生命周期测试 12 项通过，覆盖本地暂存保留/释放、上传与回收锁、结束状态拒绝上传及原有会话重连/关闭行为。
- 最终远端模块回归 95 项通过，新增回收锁测试复查通过，`cargo clippy --all-targets` 通过。Windows 上未配置 `CLIORA_TEST_WSL_DISTRO` 的非特权 POSIX 目录权限分支未执行。
- `capture-workbench.mjs --theme all --size 1360 --only 'workbench-active-*'`：浅色、深色 2 张，无页面错误或横向溢出。完整画廊中的目录选择场景出现步骤超时，未将这些场景计为通过；截图均为合成 IPC，不构成原生平台验收。
