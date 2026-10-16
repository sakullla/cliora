# 0.4.17 后配置读取与用量采集性能优化

日期：2026-10-12。环境：Windows，本仓库 Cargo test 配置。

## 对比范围

- 版本基线：`4cef894`（`v0.4.17`，发布复核时获取远端标签并确认一致）。目标发布版本：`0.4.18`。
- 优化前代码：`27361a4`。后续新增功能主要包括 Cursor、MiniMax Code 及相关账户、资源和启动能力。
- `history/report.rs` 的用量聚合、`UsageQuota.tsx` 的配额轮询与版本基线一致。此次定位到的新增用量开销在 MiniMax 会话采集，而非聚合算法。
- 下表比较 **27361a4 与本次工作区修改**。MiniMax 在版本基线尚未接入，不能把其采集数据称为相对 0.4.17 的耗时改善。

## 修改

1. MiniMax 会话发现和解析复用共享 `RevisionCache`。数据库和 WAL 的版本共同决定缓存是否有效；`Arc` 共享已脱敏元数据，避免每个会话重新查询、清洗或复制整张表。失败读取不缓存，取消仍传播。数据库路径、查询和字段解释保留在适配器内。
2. 配置列表使用共享文件状态检查，验证存在、普通文件、非符号链接和可打开性，不再将整个配置读入内存后丢弃。受保护文件继续不打开。原文编辑仍使用完整读取和原有冲突检查；无效 UTF-8 的解码错误在打开编辑器时显示。
3. 配置模型摘要直接检查已解析、合并的文档，省去序列化、再次解析和无关模型目录投影。沿用适配器的字段与连接文档声明，包括 MiniMax YAML；未增加 CLI ID 分支、IPC 字段或数据库迁移。

## 合成基准

临时目录内生成固定数据，前后各运行三次。以下是每次耗时，单位 ms；不包含编译、夹具生成或进程启动。

| 场景 | 优化前 | 优化后 | 中位耗时变化 |
| --- | --- | --- | --- |
| 300 个 MiniMax 会话发现与解析，每个会话含一条用量记录 | 714.19 / 635.62 / 607.65 | 212.09 / 210.75 / 178.23 | 635.62 → 210.75，下降 66.8% |
| 16 MiB 配置文件，读取列表状态 40 次 | 331.78 / 314.95 / 321.95 | 8.09 / 2.04 / 1.81 | 321.95 → 2.04，下降 99.4% |

MiniMax 基准校验发现 300 个源、解析出 300 条用量记录。每轮主动解析全部会话，用于测量冷索引的采集工作；实际未变化的会话仍由原有增量索引跳过。文件状态基准是大文件压力场景，不代表典型小配置或整个配置页面的加载时间。

模型摘要的优化以消除重复工作和行为回归测试验证，未单独声明耗时收益。在线配额接口、真实桌面端到端时间、macOS/Linux 尚未测量。

复现命令：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib performance_minimax_history -- --ignored --nocapture --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --lib performance_configuration_snapshot -- --ignored --nocapture --test-threads=1
```

优化前基准需要将这两个仅生成临时夹具的测试应用到 `27361a4` 后执行。

## 验证

- Node：`npm run test:unit`，33 项通过，含适配器架构约束。
- Clippy：`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` 通过；仓库现有告警仍存在。
- 初轮 Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4`，709 项通过、17 项忽略、0 失败。新增 WAL 复用测试显式建立 WAL 后检查共享快照，随后验证写入和 checkpoint 的失效行为。
- 发布复核补齐单条元数据类型损坏的回归：保留其他有效行的标题和可见性过滤；数据库读取失败仍不缓存。
- `0.4.18` 完整 Rust 测试：`cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=4`，710 项通过、17 项忽略、0 失败；二进制目标和 doc-tests 也通过。
- 浏览器发布复核发现记录页旧夹具缺少 `history` 能力声明，已补齐 `records.spec.ts` 与 `session-reader.spec.ts`，保留原有断言。
- `0.4.18` 浏览器全量复跑：`npm test -- --workers=4`，252 项全部通过。首轮高并发编译期间发生的一项启动超时，单独复跑及本轮全量均通过。
- `0.4.18` 前端构建与 Clippy 全目标检查通过；构建保留原有大 chunk 提示，Clippy 保留仓库现有告警。
- 回归覆盖数据库/WAL 更新、checkpoint、缓存复用、失败恢复、取消、配置列表不解码正文、受保护文件与目录，以及 JSON/JSONC/TOML/YAML 模型身份一致性。
- 全程没有 UI 布局修改；合成基准不构成真实桌面或跨平台验收。

## 2026-10-16：0.4.26 Skill 列表读取

基线为 `f5aad23`。原生 Skill 列表对每个目录递归读取附件、Base64 编码并计算完整包摘要，包括只读捆绑目录。现在未托管目录与只读观察目录仅读取 `SKILL.md`；托管安装仍完整校验附件。导入预览、覆盖、删除与恢复的完整包检查保持不变。列表的 `digest: null` 可以表示只读文档扫描，前端通过 `state` 判定可读性。资料库包元数据由每次解析两遍改为一次。

同一台 Windows 机器、Cargo test debug 构建、本机 Grok 23 个 Skill，前后各连续扫描三次。计时只包含后端 `scan_native`，不含编译、数据库初始化、IPC 或页面渲染。测试使用临时数据库，未读取用户数据库或执行用户恢复日志，未修改本机 Skill。未清空操作系统文件缓存，不代表冷启动或完整桌面加载耗时。

| 扫描 | 优化前（ms） | 优化后（ms） |
| --- | ---: | ---: |
| 1 | 1477.46 | 13.72 |
| 2 | 2037.52 | 10.63 |
| 3 | 966.86 | 9.76 |

复现命令（显式指定待只读扫描的 home 和注册 CLI ID）：

```powershell
$env:CLIORA_SKILL_BENCH_HOME = $env:USERPROFILE
$env:CLIORA_SKILL_BENCH_TOOL = 'grok'
cargo test --manifest-path src-tauri/Cargo.toml --lib native_skill_scan_timing -- --ignored --nocapture
```

验证：15 项 Rust Skill 测试通过；资源、Agents、插件的 54 项 Playwright 测试及新增的 2 项空摘要文档测试通过；`npm run build` 通过。新增回归覆盖大附件不拖入列表扫描、导入仍拒绝超限包、托管附件变化仍阻止删除，以及空摘要条目的编辑和只读状态。MCP 已直接读取配置，Agents 已跳过插件包摘要，插件页已有目录预览与范围缓存，本次未修改这些实现。未进行桌面窗口端到端或 macOS/Linux 验收。
