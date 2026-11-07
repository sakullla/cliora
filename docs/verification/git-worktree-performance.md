# Git / worktree 性能验证（2026-11-07）

工作台 Git 菜单改为按需读取，减少后台扫描、进程启动和文件列表的内存驻留。IPC 结构保持不变。

## 改动与边界

- 分支提示继续读取小型 `.git` 元数据；worktree 列表仅在菜单打开时刷新。如果分支提示缺失或读取失败，额外探测一次列表，保留已有工作树入口。
- 完整 Git 状态在菜单打开或审查结果返回时读取；连续刷新和会话切换串行执行，过时的排队请求与响应被丢弃。返回结果必须经过本次 HEAD 校验才生成通知。
- 状态读取保留根目录校验，把分支、HEAD 和文件计数合并为 `status --porcelain=v2 --branch --no-ahead-behind --untracked-files=all`。Git 进程数由 4 个减少为 2 个；不计算未展示的 ahead/behind。格式依据 [Git 官方 status 文档](https://git-scm.com/docs/git-status#_porcelain_format_version_2)。
- 文件路径流式计数，不累计完整 stdout 或额外复制为字符串。读缓冲为 8 KiB，单条头部最多 4 KiB，另外保留分支、OID 和计数；总输出仍限制为 8 MiB，超限明确返回未知，不截断文件数。
- 前端只保留一个工作树列表，切换目标时释放；Git 和审查状态随会话移除清理，已通知的旧审查 ID 随最新记录替换清理。
- 新建工作树、读写环境准备配置直接解析主检出路径，不再为取得一个路径而遍历所有 worktree 的 HEAD/gitdir。原有创建锁和清理确认流程保留。

## Windows 命令链采样

环境：本机 Windows、Git 2.52.0.windows.1、当前 Cliora 仓库。两组先各预热一次，然后交替执行，各采样 9 次。两组均使用 `GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`，禁用全局及系统 Git 配置。

旧链：`rev-parse --show-toplevel` → `status --porcelain=v1 --untracked-files=all` → `symbolic-ref --short -q HEAD` → `rev-parse --verify HEAD`。

新链：`rev-parse --show-toplevel` → `status --porcelain=v2 --branch --no-ahead-behind --untracked-files=all`。

| 命令链 | 中位耗时 | 9 次采样（ms） |
| --- | ---: | --- |
| 旧 | 682.89 ms | 486.09, 390.79, 682.89, 780.50, 769.26, 669.82, 1046.88, 775.54, 596.30 |
| 新 | 339.11 ms | 428.72, 201.83, 397.17, 434.09, 339.11, 260.82, 317.71, 362.51, 219.95 |

该次命令链中位耗时下降约 50%。采样期间存在其他编译负载；这是本机命令启动及执行成本的对比，不是完整 IPC、界面延迟或应用总 RSS 的基准。未测量桌面进程整体内存下降比例。

## 回归验证

- TypeScript / Vite 生产构建通过；仍有既有的大 chunk 提示。
- `npm run test:unit`：163 项通过。
- 工作台 focus 与 Twiglane Playwright 用例：16 项通过，包括关闭菜单无状态扫描、连续刷新只有一个在途请求、菜单关闭后的审查结果校验。
- 工作台 terminal 套件首轮 75/76 通过；缺少分支提示时的 worktree 入口回归已修复，该失败项及创建、清理、准备命令相关用例定向复跑通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib git_ -- --test-threads=4`：23 项通过，包含 Git 元数据、worktree 创建/清理及启动边界。
- 同次构建生成的 `cliora_lib-47decea19233b443.exe twiglane::tests --test-threads=4`：22 项通过。直接执行已编译测试程序，避免等待其他项目占用的共享 Cargo 构建锁。包含真实 Git 空仓库、detached HEAD、linked worktree、重命名、冲突、完整计数，以及跨块解析和不保留长路径的测试。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`：通过。
- `scripts/capture-workbench.mjs --theme light --size 1360`：36 张截图，页面错误、横向溢出和步骤失败均为 0；已目视检查 worktree 菜单。[本机截图画廊](ui-git-worktree-performance/index.html)使用合成 IPC，图片不纳入版本控制。

Windows Git 测试实际启动 Git 并操作临时测试仓库；Playwright 使用合成 IPC。未验证 macOS/Linux 或真实桌面 WebView2 的整机内存、焦点及布局表现。
