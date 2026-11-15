# 工具配置、MCP 与 Skill 性能验证（2026-11-15）

基线：`93f5a476`。环境：macOS arm64，本地 Rust 测试构建、Playwright Chromium 合成 IPC。

## 配置外部修改提示

旧实现将重新投影的待应用文本传到前端，以自制 TOML/YAML 解析器比较。可复现误报：`model = 'one'` 与 `model = "one"`、`context = 200_000` 与 `context = 200000` 均返回 changed。应用会保留等价原生写法，因此重应用并不一定消除这类提示。

现在工作区返回 `appliedFileState`（unchecked / unchanged / changed / unknown）。后端根据最后成功写入的 `binding.managed` 比较实际字段，用已有原生格式解析器处理注释、引号、数值和 JSONC/YAML 写法；不重新生成候选，不对无关字段报警，不为提示读取凭据库或验证密钥摘要。解析失败保留 unknown，真实字段变化保留 changed。没有执行校验的旧宿主或摘要请求为 unchecked。

这是展示状态，不是写入授权。保存、应用、接管、预览确认、事务和凭据保护仍走原有严格路径。字段记录在检查后从工作区响应清除，原生文件正文不随状态返回。适配器继续提供 native_files 和写入字段，检查服务不按 CLI ID 分派；测试包含非内置 tool ID。

删除前端约 500 行重复格式解析器；每次工作区读取不再追加 compare_registered_application IPC。首次打开不再由两个 effect 重复加载，展示缓存由 24 份缩至 8 份，60 秒过期、后续访问/写入清除。

## MCP 与 Skill

- MCP 读取目标与草稿启用开关分离，读取回调不再依赖列表长度；首次非空列表不触发第二次扫描，草稿切换不读原生文件。
- 资料库 MCP 的排序/筛选按数据变化重算，分发位置一次建索引，避免每个条目重复扫描全表。
- Skill 列表在 SQLite 中提取 SKILL.md 与文件数量，不把所有附件的 Base64 反序列化进 Rust。
- 托管 Skill 列表按路径排序并流式计算原有摘要，保留附件变化、文件数量/大小和符号链接检查；导入、分发和写入仍校验完整包。
- 通用包摘要直接向 SHA-256 写序列化数据，避免再分配整份 JSON 缓冲。

## 合成性能测量

同一 Rust 测试二进制，独立进程，97 文件（1 个 SKILL.md、96 个 96 KiB 二进制附件，共 9 MiB 附件），循环 10 次。基线分支保留旧 collect → Base64 map → JSON Vec → SHA-256 路径；优化分支使用流式 inventory_digest。

| 指标 | 旧路径 | 流式路径 |
| --- | ---: | ---: |
| 10 次校验耗时 | 8530.02 ms | 4782.67 ms |
| 进程最大 RSS | 156205056 B（148.97 MiB） | 13860864 B（13.22 MiB） |

耗时约降低 44%，该测试进程峰值 RSS 约降低 91%。RSS 包含进程本身；结果不是整款应用的内存降幅，也不是 release 构建或用户真实文件的测量。计时受当时系统负载影响。

复现测试：`resources::skills::tests::skill_inventory_memory_benchmark`，使用 `--exact --ignored --nocapture`；设置 `CLIORA_BENCH_BASELINE=1` 选择基线，未设置选择流式路径。macOS 可用 `/usr/bin/time -l` 包裹测试二进制记录 RSS。

## 验证

- `npm run build` 通过；保留原有大 chunk 提示。
- Node：配置草稿、适配器架构、缓存测试，17 项通过。
- Playwright：config-dialog、mcp-workspace、resources、skills-manifest、skill-plugin-source、library-mcp-row，196 项通过，无重试。
- Rust：配置应用 25 项、工作区 23 项、Skill 29 项通过；2 项显式性能测试默认忽略。磁盘写满造成一次编译失败，清理过期缓存后重新编译，以上 77 项原生回归再次全部通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` 通过。
- `capture-ui.mjs`：1360px、深浅主题，MCP 34 张、Skill 18 张，failures 均为空；抽查 MCP 列表、资料库编辑目标与 Skill 编辑截图。

模拟器的 MCP 列表返回值改为独立快照，符合真实 IPC，避免测试可变数组别名破坏 memo 的依赖约定。原来的前端格式算法测试由 Rust 实际文件/解析器测试替代，包括真实应用→外部修改→重新应用，以及摘要与原包算法一致性。

未验证：安装后的桌面 WebView、用户当前 Cpa 配置及真实 CLI 会话。没有修改用户原生配置或凭据，也未在本机安装新包；发布由版本标签触发的 CI 执行。按用户清理要求，合成截图、测试临时文件和构建产物在检查后清理；本记录保留可复现方法和结果。

## 追加：切换主机、SSH 复用及远程会话稳定性

工作台原来只有一个选中会话 ID；切换主机后只会选择该主机第一个运行会话。现在按 targetId 保存各主机上次选择，切回时校验它仍属于该主机再恢复；加载中的空范围不会覆盖记忆，已移除会话只在当前主机内回退。全局会话列表不再抢先选中其他主机的会话。本机恢复后会映射旧 ID，远程选择不再覆盖旧版本的本机恢复偏好。

SSH ControlPath 原来使用完整 64 位十六进制摘要，在 macOS 常见缓存目录下已超限。新名称保留 128 位摘要，并将实际路径限制到 80 字节，为 OpenSSH 临时套接字后缀及 NUL 留出空间。无法提供安全短路径时明确关闭复用，避免连接直接因路径失败；不同认证方式、密钥、配置、端口与用户保持隔离。百分号按 OpenSSH 规则转义；缓存目录必须为普通目录且成功设置 0700。

实际本机 Unix socket 实验：旧格式临时路径 119 字节，bind 返回 AF_UNIX path too long；短格式 87 字节，bind 成功。原生测试同时验证临时 socket 的绑定与重命名、非 ASCII 路径按字节限长、连接身份隔离。没有访问用户 SSH 主机。

其他主机的隐藏终端即时释放图形渲染资源，保留已挂载终端、输出及协议回应。三个主机往返切换 3 轮的浏览器回归确认不会额外 launch、reattach、close 或 replay。

追加验证：

- workbench-host / workbench-focus / workbench-webgl：44 项通过。主机菜单悬停测试先等入场动画结束再测量位置，消除旧的动画时序误判。
- 工作台恢复、replay、隐藏终端协议回应及后台输出：16 项通过。
- 1360px 深色远程画廊 12 张，页面错误、横向溢出与动作错误均为空。
- 合成持续输出：3 会话、每会话 20480 行、36 次切换。GC 后 heap 约 8.34 MB → 13.64 MB；关闭后 9.05 MB，终端数 3 → 0，事件监听器 533 → 367。仅记录浏览器观测，不代表真实 SSH 吞吐、原生内存或长时泄漏验收。
- Node 完整运行 193 项：191 通过，2 个既有平台假设用例在 macOS 失败（`owned native fault wrappers` 依赖 Linux 命令路径，`native IME build config isolates` 依赖 Windows 路径语义）。用 `--test-skip-pattern='owned native fault wrappers|native IME build config isolates'` 排除这两项后，191 项通过。
- 发布版本为 0.4.137，package.json / package-lock.json / Cargo.toml / Cargo.lock / tauri.conf.json 已同步；前端构建通过。
- Rust 远程基础服务 37 项通过，操作调度 11 项通过，远程会话启动/重连/结束 16 项通过（另 1 项显式环境测试忽略）。远程基础服务另有 2 个既有 Linux 文件事务测试在 macOS 失败：本机没有 `flock`，且系统 `stat` 不支持脚本的 GNU `-c` 格式；其本地 shell 模拟在 protect 阶段退出，产生未确认写入或 BrokenPipe。该模拟走本地 transport，不调用本次更改的 SSH 参数生成。保留 Linux CI 完整检查，不修改事务保护。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` 通过。
- 补查 library-distribute-result / reading-layout：39 项通过；本轮工具与远程界面回归共 295 项通过。
- 0.4.137 标签触发 Release 工作流，等待同一提交的 main CI 通过后由 CI 打包发布。

## 发布阻断修复（0.4.138）

v0.4.137 的 Linux Rust 全量测试及三平台 Clippy、终端浏览器套件均通过；application 套件 822 项通过，1 项失败。失败是 library-tags 的四标签用例漏实现 `list_mcp_placements`，默认返回 null，与 Rust Vec 返回数组的契约不符。新增 MCP 位置索引会遍历这个值，从而暴露旧测试桩遗漏。

本机重复运行原用例 3 次均失败；补齐空数组返回并增加 pageerror 断言后，library-tags / library-mcp-row / mcp-workspace 共 26 项通过。未削弱主按钮或四标签断言，未跳过 CI 用例。版本文件同步升级为 0.4.138，使用新标签继续完整 CI 与三平台发布流程。
