# 会话与刷新性能验证

2026-10-02，Windows，本地 Rust test profile。合成数据为 240 个 Codex JSONL 会话，每个包含 40 条约 4 KiB 正文和 40 条用量记录。每次测试使用独立临时数据库，原生日志和用户数据库不参与写入。下表是同一环境各一次运行的观察值，不是跨平台性能承诺。

| 操作 | 调整前 | 调整后 |
| --- | ---: | ---: |
| 首次刷新并建立索引 | 2874.02 ms | 1362.00 ms |
| 首次查询会话列表 | 34.06 ms | 0.75 ms |
| 未变化刷新 | 16.94 ms | 16.92 ms |
| 再次未变化刷新 | 16.86 ms | 16.41 ms |
| 未变化后列表查询 | 30.51 ms | 0.63 ms |
| 单会话正文读取 | 1.84 ms | 1.83 ms |

改动：数据库版本 13 增加会话元数据和文件指纹覆盖索引；无关键词时查询不引用大型正文列；JSON 序列化移到解析线程，在数据库事务开始前完成；流式日志使用 memchr 查找换行，并在复制完整行前判断是否跳过。保留文件 change-time 判断，因此同大小、恢复 mtime 的改写仍会重建索引。

页面减少重复列表请求，列表行使用浏览器可见性优化；长会话只对首屏及接近可见区的助手消息渲染 Markdown，其他消息保留文本。查找仍覆盖完整已索引正文，跳到最新消息后会渲染目标 Markdown。刷新后同步更新已打开的会话正文。

Codex 适配器识别项目说明和环境块，保留文本并标记统一消息类型。前端不识别 CLI 特有字符串。Codex 指纹包含解析版本，使旧记录在下一次刷新时重建一次；这次升级刷新会比后续未变化刷新慢。其他适配器和收藏保持原有语义。

复现：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib history_performance_probe -- --ignored --nocapture
```

回归覆盖：适配器分类、普通提问不误折叠、旧索引升级与收藏保留、同大小文件改写、损坏来源隔离、未变化刷新、正文查找、远处 Markdown 延迟渲染与跳转。实际用户库耗时取决于源文件体积、变化量和存储介质；本次没有 macOS 原生性能结果。


## 2026-10-04：新增工具与首页

Windows 本机只读诊断，原生日志和用户配置没有写入；统计写入独立临时 SQLite 数据库。`history::performance_readonly_local` 为默认忽略的显式诊断测试，会输出耗时及计数，不输出会话正文、路径或凭据。以下是 Rust test profile 单次观测，不是发布版本性能承诺。

- ZCode 会话指纹从整个数据库改为每段会话的元数据、用量行与 rollout 指纹；同一个只读事务读取 WAL，其他会话更新不触发全量重建。
- DeepSeek 仅发现 sessions 树，逐行解压 zstd；Kimi 在分配完整 JSON 前跳过重复请求快照，并从 profile/config 事件补充模型名。
- 会话与统计查询使用独立 SQLite 只读快照，扫描写入可继续进行。会话列表首批 80 行，滚动增量展开，键盘跳转和统计跳转仍定位完整列表。
- 首页未打开的页面不挂载，编辑器按需加载。入口 JS 从 1162.07 kB（gzip 373.89 kB）降至约 302 kB（gzip 96 kB）；这是构建产物变化，不等同于原生首页启动时间。
- CodeBuddy 改读已验证的 v2 插件索引及 enabledPlugins，8 条记录的版本、路径、启停结果与本机 CLI 输出一致。原 CLI 初次查询 6254 ms，本地扫描约 504 ms。
- Qoder CN 独立注册为 qoder_cn，默认关闭，在设置中启用；使用 .qoder-cn 与 qoderclicn，包括 version.txt 指定的非空版本化可执行文件。不会回退到国际版账号、目录或 npm 包。CN 插件读取 v2 索引，旧格式显式报告错误。
- Agent 页仅枚举插件拥有的资源并校验 Agent 定义；插件变更仍比较完整包内容与配置基线。只读插件不做无用的整包摘要。

兼容性修复：Kimi 2.1.1 实测支持现有会话与恢复契约；ZCode、DeepSeek 通过桌面安装标记识别，避免启动 GUI 执行 --version；DeepSeek 按原生 YAML 补丁序列管理 MCP，保留兄弟补丁，序列重排会阻止冲突写入。DeepSeek 不再用产品版本白名单拒绝更新，配置与会话 schema 仍严格检查。带额外覆盖补丁的 MCP 明确提示原生管理。

适配器扩展：CliAdapter 的 native_installations/extra_binary_candidates 声明安装证据；PluginAdapter.discovery_only/discover 声明无进程只读发现；CliAdapter.mcp_entries/mcp_entry_view/mcp_change 对逻辑条目、显示结构和字段事务做映射。共享层负责缓存、进程、安全读写、冲突与备份。Qoder CN 的注册隔离测试和 DeepSeek 经共享 MCP 服务的往返测试覆盖这些扩展，无新增 IPC 字段。

本机首轮结果：ZCode 51 个来源冷扫描 458 ms、重复 36 ms；Kimi 25 个来源冷扫描 157 ms、重复 11 ms；DeepSeek 2 个来源冷扫描 25 ms、重复 1 ms，均无失败。1545 条会话列表 41 ms，全量统计报告 2374 ms。首次发现大型旧工具日志仍可能耗时；未声称消除此项成本。

macOS/Linux 原生行为及桌面 GUI 端到端验收未执行；浏览器测试使用 mock，只证明交互回归。DeepSeek MCP 写入测试仅使用脱敏 fixture 和临时文件，不改用户实际配置。


### 标题与测试时限补充

原生标题优先于首条消息：Codex 读取当前账号的 session_index.jsonl，缺失时读取线程数据库；Claude 读取 ai-title/custom-title，Pi 读取 session_info；已有 Kimi、CodeBuddy、ZCode、OpenCode、Grok、DeepSeek 的原生标题读取继续使用。Codex 每条会话的指纹包含对应标题，其他会话改名不导致它重建。损坏的索引行跳过，标题缺失时仍回退到首条用户消息。无 IPC 字段变化，HistorySource 新增内部 native_title 提示字段。

Windows 文件/账号目录的保护通过 Windows 安全 API 设置完整、受保护的 DACL，仅授予当前进程用户和 SYSTEM 权限；避免反复启动 whoami/icacls。现有独立 icacls 检查（继承权限、显式宽松授权移除、敏感文件写入与恢复）仍保留并已通过。

测试预算按用户确认的“缓存就绪后的命令耗时”。保留所有未忽略的 Rust 用例；短时网络/计算失败用例使用可注入预算，生产默认 compute=5s/wall=30s/http=10s 不变。Rust 与 Node 并行，Rust 最多 16 个线程处理隔离 IO。合并 UI 的主题与快捷保存重复覆盖，删除固定 400/500ms 等待，修复依赖开发 StrictMode 调用次数的存储故障 mock；动态样式检查用条件等待。

本机一次缓存就绪验收：npm run test:unit:all 最终完整命令 10.83s（Rust 405 passed/9 ignored，执行 9.86s，Node 20 passed）；npm run test:integration 的 5 条核心流程通过，完整命令 5.23s（Playwright 执行 4.7s）。test:quick 最终完整命令 13.95s，与全量单元命令运行相同完整集合，test:unit 为 Node 快速检查。完整浏览器回归单独保留，101 条均通过；它比 5 条核心集成慢，不将它计入 10s 目标，也不将 mock 结果标记为原生平台验收。


长会话“最新”定位回归：先显式渲染最后消息再即时定位，避免平滑滚动期间延迟 Markdown 改变高度而停在中途。最终完整浏览器回归 101 passed，命令 35.53s；核心集成是其中显式标记的五条流程，完整浏览器集合没有为了时限删除高价值用例。

Qoder CN 本机 v2 安装索引包含 5 个存在的插件目录，原生 plugins list --json 返回其中 3 条。当前只读发现展示安装索引中的记录；另外两条的原生 CLI 管理操作没有实测，不将索引发现结果等同于原生列表完全一致。


## 2026-10-04：0.2.7 配置、规则与插件补充

只保留 Qoder CN 注册与适配器，国际版 Qoder 的旧管理记录保留为不支持项，不自动迁移到 CN。CN Agent 页显示本机 1.1.65 已核对的五个只读内置参考定义；同名用户定义可以覆盖参考条目，不读取或伪造内置提示词。

原生配置只读编辑不再启动安装/版本探测，保存仍保留新鲜能力检查、文件基线比较与加密备份。编辑器悬停预加载，切换文件复用 EditorView 并隔离撤销历史；异步读取与粘贴拒绝已切换的文档。Kimi 增加 config.toml / tui.toml，ZCode 增加 setting.json / provider_config.json；模型文件按原生 schemaVersion 1 校验，未虚构其他 CLI 的文件角色。

规则增加 Kimi、Qoder CN、DeepSeek、ZCode 的已确认默认 AGENTS.md 路径，Kimi 优先已有项目内嵌规则。作用域可用性由注册表声明。Qoder CN 的自定义规则文件名与 DeepSeek profile 禁用/定制指令仍由原生设置决定，当前管理默认路径；CodeBuddy 项目规则未确认，界面保留不可用原因。

Kimi Windows MCP 将 npx shim 映射为绝对 node.exe 与 npm npx-cli.js，参数和环境变量按字面保留，不拼 shell 命令。settings 应用时迁移 loop_control.max_retries_per_step，已有 max_attempts_per_step 优先。本机现有一个 npx MCP 条目与旧字段通过共享加密事务修复，创建恢复备份；实际 kimi doctor 退出 0，未出现旧字段或 spawn npx ENOENT 提示。doctor 不等同于完整 MCP 工具调用验收。

Claude Code 插件读取原生 v2 安装索引与作用域启停配置，避免 CLI 启动。Codex 保留原生列表与策略，不伪造文件索引；复用安装探测缓存。插件页面按工具/作用域/项目/账号缓存 30 秒，重新扫描绕过缓存，操作仍重新核对基线。ZCode 通过安装包内 zcode.cjs 管理原生插件；安装注册表改用共享 Windows 只读 API，避免 reg.exe 全表进程扫描。DSH 支持 desktop profile 内已安装用户 bundle 的启停，保留依赖、插件文件与官方层；安装、更新、卸载继续通过 DSH 原生页。

实际 Windows 本机只读扫描，Rust debug profile、独立临时数据库，以下各两次观测不作为发布 GUI 耗时承诺：

| 插件扫描 | 首次 | 再次 | 条目 |
| --- | ---: | ---: | ---: |
| Claude Code | 282 ms | 268 ms | 1 |
| Codex | 1230 ms | 963 ms | 1 |
| ZCode | 4258 ms | 3522 ms | 14 |
| DeepSeek | 472 ms | 407 ms | 1 |
| Qoder CN | 1294 ms | 935 ms | 5 |

ZCode 注册表调整前同一调试诊断首次 7799 ms、再次 3704 ms；大插件内容摘要仍有成本。Kimi settings/tui 与 ZCode settings/models 的直接只读文件读取为 154–207 µs，不包含 IPC 与编辑器显示。

资料页成功提示四秒自动消失，错误继续保留恢复入口；刷新记录按钮统一图标、悬停与忙碌状态。CLI 会话来源删除后，下一次完整成功刷新删除索引与级联用量，并重新计算统计；失败或取消的发现不会清理旧索引。扩展已有删除回归，校验会话数及所有 token 总量归零。

界面回归 104 passed，完整浏览器命令约 50.09s；五条核心集成 5 passed，Playwright 5.1s、脚本 5.78s。浏览器使用 mock，实际原生读/诊断另列；没有新增 macOS/Linux 本机验收。

最终缓存就绪验收：全量单元命令 9.40s，快速单元命令 9.26s；两者均运行相同完整集合，Rust 410 passed / 9 ignored，Node 20 passed。Rust 实际执行分别 8.00s / 7.80s，均未过滤新增回归。cargo clippy --all-targets 退出 0，保留已有警告；新增注册表范围判断警告已消除。TypeScript 检查与生产前端构建通过。

本机 npm run tauri build -- --no-bundle 成功。已启动 Windows 原生 0.2.7 并检查进程响应；可执行文件 SHA-256 为 B7EB3BD8EF188D1E0E54EE5105D4BBAC3A90A14FC82BD6CD504A5DAED6AE5316。本条仅记录构建/启动，不升级完整平台验收矩阵。


## 2026-10-04：0.2.8 ZCode 插件首屏

0.2.7 发布版在实际 WebView2 内直接调用扫描 IPC，两次完整扫描 1664 / 1572 ms，均为 14 条插件。单独执行安装包内 zcode.cjs plugins list --json 为 1344 / 1338 ms；排除调试构建散列成本后，主要等待仍是原生命令。未将目录读取当作原生策略核验结果。

增加可选 PluginAdapter.preview 端口及同步 Rust/TypeScript preview_native_plugins IPC。ZCode 仅读取本机版本 1 bundled-marketplace.json 原生目录并过滤全局 suppressedBuiltins，先展示目录里的名称、版本与位置；它是部分只读目录，不枚举或伪造全部用户插件，也不判断默认启停。共享服务清空预览动作与操作基线、设为未知状态；完整原生扫描继续并替换列表，失败保留错误与重新扫描入口。未经核对的预览不能安装、启停或卸载，后端也拒绝空基线。

插件页按工具/作用域/项目/账号合并正在进行的扫描，切走再返回不重复启动命令，完整成功结果才进入 30 秒缓存。预览晚于完整结果时丢弃，失败扫描清除旧缓存。现有原生命令、文件内容摘要、账号上下文、版本策略和事务保护保留。

Rust fixture 验证原生目录读取、删除抑制、未知启停、预览无操作基线、未知目录协议拒绝；浏览器新增受控慢扫描验证先出现可搜索列表、未核对前无操作入口、切页共享请求与完成后恢复动作。105 条完整浏览器回归通过（脚本 52.65s），其中插件页 6 条针对性测试通过。浏览器 mock 与实际原生耗时分开记录。


首页截图中的“未确认安装”无法从截图确定原始探测错误。实际原生 IPC 可确认 Codex 0.160.0、Claude Code 2.1.289、Qoder CN 1.1.65、Kimi Code 2.1.1、CodeBuddy 2.161.1、Pi 1.0.2、OpenCode 1.18.34；不据此声称原因为 PATH 或版本不兼容。代码确认失败摘要被首页无限期记忆、没有重试入口，且 summary 请求忽略 fresh。现修复强制刷新、成功缓存 60 秒到期、失败不跨页记忆、初始探测最大并行 3；有候选但版本失败或 IPC 错误时最多自动重试两次，每次间隔 8.5 秒，未发现安装不自动循环。新增每行重新检测；过期请求不覆盖正在应用的配置，退出页面清理重试计时器。

新增受控时钟回归，验证瞬时探测失败自动恢复启动、新安装通过手动 fresh 摘要发现、真实未安装没有重试循环。首页与插件针对性 17 passed；最终完整界面回归 107 passed（脚本 39.08s）。实际发布原生 IPC 目录预览 20ms / 14 条；当时完整扫描 10621ms，正在进行其他编译/验证，不能和空闲基线直接比较，也没有将预览当作完整状态核验。


最终原生 0.2.8 点击到 ZCode 首条目录可见 108ms（14 条，同时显示正在核对），完整核对 2010ms。首页实际窗口的 10 个 CLI 均显示版本且启动按钮可用，Tauri app version 返回 0.2.8。该验收为只读导航，没有启动各个 CLI 或改写其私人配置。

用户指出 0.2.7 的 CI run 37180565221 在 Rust Test 步骤等待超过 42 分钟；已提交取消与 force-cancel。修改 CI 为任务最长 30 分钟、Test 步骤 15 分钟、cargo test 本身由 GNU timeout 在 12 分钟终止（15 秒后强制结束）；Clippy 最长 10 分钟。限时包含冷编译，不采用本机缓存就绪的 15 秒验收口径。另有本地测试在高负载下停于 response_limit_and_network_timeout：HTTP fixture 的无界 accept/join 可在客户端先超时后永久等待。fixture 已改为连接、读、写均有 3 秒边界，缺少预期请求明确失败；没有跳过这些回归或提高客户端超时来掩盖失败。远端具体卡住测试尚待日志确认，不能将本地复现当作远端已确认根因。


最终缓存就绪的整个 npm 命令：test:unit:all 10.08s、test:quick 9.66s（Rust 411 passed / 9 ignored、Node 20 passed）；核心集成 5 passed，test:integration 6.28s。限时 fixture 的 12 条 runtime 回归通过，执行 0.48s。Clippy --all-targets 通过，保留原有 47 条 warning。

0.2.7 旧 CI 已确认为 completed/cancelled。GitHub 返回的归档只包含已完成的 frontend/macOS job，被终止的 Rust job log 尚未提供，未据此宣称远端具体卡住测试已确认。

追加截图修复：侧栏顶部增加可键盘操作的折叠/展开按钮，折叠后为 68px 图标导航，保留页面名称、悬停快捷键与主题入口，并记忆本机布局偏好。使用记录解除主区 1240px 上限，列表宽度限制在 280–360px，剩余空间用于会话详情；正文保留便于阅读的行宽。2560×1440 宽屏、重载保持折叠和 640px 窄屏无水平溢出的回归通过；针对性 shell/reader 17 passed。

折叠与宽屏布局加入后的最终完整 UI：108 passed，脚本 36.69s。用户随后确认停止 MCP 排查，本版本未修改 MCP 配置或加载行为。

最终布局后的原生构建成功（2m41s），实际 0.2.8 WebView 中侧栏 212px→68px，使用记录主区与内容同为 1082px、无水平溢出。最终集成命令 5.20s / 5 passed。原生 exe SHA-256：5EA3A6A389052F001FD552013A82050526BCC7211C1B721B2D0307F2FE789CD5。检查完成后已移除临时调试参数，重新启动本地原生应用。
