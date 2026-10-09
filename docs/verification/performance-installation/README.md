# 使用记录、版本查询与安装可靠性验证

验证日期：2026-10-09。环境：Windows、Node.js、本机 npm 11.17.0、Rust debug 测试构建。所有真实历史仅只读访问，统计索引写入临时目录；未更新用户已有全局客户端。

## 全部注册客户端调查

公开版本号为当日查询结果，不作为兼容性锁定。

| 客户端 | 查询版本 | 来源与安装结论 |
| --- | --- | --- |
| Codex | 0.162.0 | npm `@openai/codex`，平台二进制为可选依赖，必须保留 |
| Claude Code | 2.1.295 | npm `@anthropic-ai/claude-code`，`postinstall: node install.cjs`，平台二进制为可选依赖 |
| Grok | 1.0.50 | npm `@xai-official/grok`，postinstall 与平台可选依赖 |
| Pi | 1.1.0 | npm `@earendil-works/pi-coding-agent`，根包无安装脚本，依赖链含 esbuild；兼容样本 1.0.4 还含 @google/genai、protobufjs 生命周期脚本 |
| OpenCode | 1.18.35 | npm `opencode-ai`，postinstall 与平台可选依赖 |
| ZCode | 3.14.4 | [官方下载页](https://zcode.z.ai/cn)中 CN CDN 的版本化安装链接；桌面安装继续走官方渠道 |
| Qoder CN | 1.1.66 | [官方安装文档](https://docs.qoder.cn/cli/installation)推荐原生；旧 npm `@qodercn-ai/qoderclicn` 有 postinstall 和 ripgrep 可选依赖；使用 CN 专用原生清单查询 |
| Kimi Code | 2.1.1 | npm `@moonshot-ai/kimi-code`，postinstall、可选 node-pty 安装脚本；原生方式保持独立 |
| DeepSeek | 0.2.0-rc.2 | [生产 Windows 更新源](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml)，保留预发布版本后缀；桌面安装走官方渠道 |
| CodeBuddy | 2.163.0 | npm `@tencent-ai/codebuddy-code`；@lydell/node-pty 本体无脚本，平台二进制为可选依赖 |
| MiMo Code | 0.1.15 | npm `@mimo-ai/cli`；`bun ./postinstall.mjs \|\| node ./postinstall.mjs`，含平台可选依赖 |
| Cline | 3.0.70 | npm `cline`；`node ./postinstall.mjs \|\| true` 可能吞掉安装错误，因此还需验证命令可运行 |
| Command Code | 1.79.2 | npm `command-code`，ripgrep 可选依赖、Node >=22；Windows 使用 cmdc，避开系统 cmd.exe |
| Antigravity | 1.3.2 | [官方 Windows manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json)，原生安装继续使用官方渠道 |
| Kiro | 2.28.0 | [官方 stable manifest](https://prod.download.cli.kiro.dev/stable/latest/manifest.json)，原生安装继续使用官方渠道 |
| Devin | 3000.11.3 | [官方 manifest](https://static.devin.ai/cli/current/manifest.json)，修复把非 npm CLI 发往空包 npm URL 的问题 |

其他证据：

- [npm 配置文档](https://docs.npmjs.com/cli/v11/using-npm/config/)：`include`、`ignore-scripts`、`foreground-scripts`、`allow-scripts` 和 `strict-allow-scripts`。
- npm 包证据均来自 `https://registry.npmjs.org/<上表包名>/latest` 的 scripts、optionalDependencies、bin、engines 字段。
- [Qoder CN 原生清单](https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json)由官方 PowerShell 安装脚本引用。修正仓库原来“CN 只有内置 CLI”的假设；原生安装和 npm 更新保持各自渠道，不切换至国际版。
- [DeepSeek 更新源配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/scripts/desktop-auto-update-environment.mjs)确认 nightly 命名为该桌面产品当前生产源，不凭版本名猜测渠道。

## 性能结果

同一 Windows 机器、debug 构建、1838 条会话，临时索引与本机只读来源。数值是单次测量，受操作系统文件缓存和后台负载影响；不代表所有机器上的固定提升比例。

| 路径 | 修改前 | 修改后 |
| --- | ---: | ---: |
| ZCode 未变化历史扫描（133 个来源） | 637 ms | 3 ms |
| 全量使用统计报告 | 1718 ms | 1419 ms |
| 会话列表（1838 条） | 22 ms | 18 ms |
| Command Code 未变化历史扫描（5 个来源） | 2 ms | 1 ms |

Command Code 1.79.1 的实际 `cmdc --version` 曾耗时 11583 ms；其 SDK 在 Commander 处理版本参数前初始化，并在退出时等待遥测。适配器只为探测进程设置 `OTEL_SDK_DISABLED=true` 后，直接执行测得 2651 ms。共享缓存进一步避免再次打开页面时重复启动客户端。没有把包元数据当作“命令可运行”的替代证据。

最终通过共享服务测得的首次/再次探测：Command Code 3891/52 ms、Qoder CN 749/4 ms、Kimi Code 2208/75 ms、Devin 210/6 ms、Pi 364/52 ms，均识别为可运行。这里统计的是版本与依赖探测，不是包含插件/配置加载的完整页面渲染。MiMo、Cline、Kiro 在本机未发现可运行安装，不以空探测耗时声称启动性能。

首次重建历史索引仍需要解析正文；本次主要减少未变化数据的重复读取，不能从 warm 数值推导首次导入耗时。额外的一次并行编译/UI 测试期间，报告曾测得 2357 ms，因此最终比较使用后台任务完成后的复测数据。

## 行为验证

安装策略显式包含可选依赖并执行安装脚本，输出在应用内显示。单个包管理操作可取消、失败后直接重试；退出码非零、超时、安装后命令不可运行都不会报成功。运行中点击关闭或 Escape 也触发取消。取消不保证恢复包管理器已经写入的文件，重试会重新执行安装。

Windows 后台进程使用 `CREATE_NO_WINDOW`。真实后台进程测试覆盖 stdout/stderr、失败退出码、超时、取消后重试；版本探测覆盖大量 stderr、取消、并发合并及文件替换失效。

真实 npm 集成：合成包由 loopback HTTP 提供，安装到临时 global prefix；强制环境配置 `ignore-scripts=true`、`omit=optional`、`strict-allow-scripts=true`。实际适配器安装参数成功覆盖前两项，显式许可覆盖生命周期脚本；postinstall 依赖可选包并写出可运行 CLI，最终执行 shim 返回 `fixture-ready`。本地文件 tarball 在 npm 严格许可下按 resolved 来源匹配，不能拿 registry 包名许可直接证明文件包可安装。

公开联网查询测试覆盖全部 16 个注册客户端，全部成功（包含 Qoder CN 和 Devin）。

最终检查：

- Rust 库测试：638 通过、15 个按设计忽略；Pi 原生协议测试使用临时安装的受测 1.0.4 参考包（当前本机全局 1.1.0 超出该验收夹具版本）。
- 适配器扩展测试：14 通过，包含新增探测环境、版本来源、脚本许可的注册扩展证明。
- Node 单元测试：33 通过。
- 使用记录、工具切换、配置与安装 UI 回归：首轮 78 通过；后续安装/配置 71 通过，最后新增预发布版本比较后的安装专项 4 通过。
- `npm run build`、`cargo clippy --all-targets`、`git diff --check` 通过；Clippy 有仓库现存警告。
- 忽略的 npm 实装测试、16 客户端公开版本查询和两组本机只读性能测试均单独执行通过。

数据库发现缓存覆盖 DB/WAL 提交与 checkpoint、失败重试、取消，以及 Cline 数据库聚合用量变化。没有本机历史样本的 MiMo、Cline、Antigravity、Kiro 只报告合成夹具验证，不推断真实平台性能。

## UI 检查

按仓库要求运行 `scripts/capture-ui.mjs --connections --theme light --size 1360,640`：20 张连接与配置截图，页面错误和横向溢出均为 0。完整临时画廊在 `.git/cliora-performance-ui/`。

安装对话框另由 Playwright 合成 IPC 覆盖版本失败重试、后台日志、取消、重试完成，并检查两种宽度。截图不是原生平台验收。

- [1360 宽安装对话框](maintenance-1360.png)
- [640 宽安装对话框](maintenance-640.png)

macOS/Linux 原生安装、每个真实客户端的实际升级，以及真实 Tauri 窗口中的完整安装交互尚未执行。本次没有为了验收而替换用户全局客户端或修改用户 npm 配置。
