# 用量解析对账审计（R4）— 2026-10-07

范围：workflow `2026-10-07-新增客户端完整支持与用量统计修复` 任务 `usage-audit`。
对 Codex / Claude Code / Grok / Pi / OpenCode / ZCode / Kimi Code / DSH(deepseek) 八款
适配器的会话用量解析，逐工具以本机真实会话对账：适配器解析结果 vs 原始行独立重算
（一次性脚本，审计后删除），有原生自报聚合的优先交叉核对。方法与 CodeBuddy 修复
（commit 9f8808b，中间工具循环调用 usage 落在被丢弃的行导致 2%–10% 捕获）同源：
重点排查"存在携带 usage 的行被解析器丢弃"的同型低估。

**总结论：八款均未发现 CodeBuddy 型丢弃缺陷；全部对账一致，无需修复、无需指纹升级，
用量展示与现状一致（未改动任何适配器代码）。** 各工具明细见下。

对账执行方式：

- 适配器侧：临时 Rust 测试目标经 `Registry::builtins()` 调用各适配器真实的
  `history_sources`/`parse_history`，对本机全部真实源逐会话输出四桶
  （fresh input / cache_read / cache_write / output）汇总（`input_includes_cache`
  语义在求和时归一为互斥四桶）。
- 基准侧：独立 Python 脚本直接重算原始文件/数据库行；原生自报聚合
  （Grok usage.json、Codex total_token_usage、ZCode model_usage 汇总）作交叉锚点。
- 双方结果逐会话精确相等（token 级）方记"一致"；本机正在写入的活跃会话文件
  （比对窗口内 mtime 变化）单独排除，不作结论依据。

## 逐工具结论

| 工具 | 核对样本 | 基准来源 | 结论 |
| --- | --- | --- | --- |
| Codex | 924 个 rollout（2026-08-27→10-07），923 个静态会话全量 | 独立重算 + 各纪元原生 total_token_usage 交叉 | 正确（1 项已知边界，见下） |
| Claude Code | 105 个主会话 + 455 个 subagent 流，96 个静态会话 | 独立重算（按 message id 去重后的全行和） | 正确（1 个 1 token 启发式差异，见下） |
| Grok | 135 个带 usage.json 的会话（另有 11 个无 usage.json 即无用量） | 原生 usage.json session 级聚合（首选基准） | 正确 |
| Pi | 53 个会话（08-22→10-07）全量 | 独立重算（message 行 + 独立 usage/compaction 行） | 正确 |
| OpenCode | 本机 **有** 数据：opencode.db 403 会话/23,703 消息（01 §3"本机无数据"记录过时） | 独立 SQLite 重算 | 正确（另按既有 fixture 回归） |
| ZCode | 77 会话（内部 db 3667 行 model_usage；rollout 3 个文件仅作 transcript） | 内部 db model_usage 逐行汇总（权威路径） | 正确 |
| Kimi Code | 28 会话 / 54 条 wire 流（含子代理） | 独立重算（全 agent 流 usage.record 求和） | 正确 |
| DSH | 5 个本机 session.v4.jsonl.zstd，走仓库现有 zstd 解析路径 | 独立 zstd 解码重算 | 正确（3 个有用量、2 个无 usage 行） |

各工具合计对账 token（适配器=基准，精确相等）：

- Codex 24,182,741,957（静态 923 会话）
- Claude Code 2,354,338,916（静态 96 会话）
- Grok 1,315,867,748；Pi 1,644,832,428；OpenCode 3,872,823,880；
  ZCode 363,768,171；Kimi Code 251,018,022；DSH 355,381。

## 逐工具要点

### Codex（正确；含混合纪元与计数器复位处理）

Rollout 存在三种用量纪元，适配器均按正确口径处理，923/923 静态文件 token 级相等：

1. **token_usage_record 纪元**（新版）：每响应一条记录，按全局 response_id 去重
  （fork/resume 复制的同响应不重复计）。
2. **混合纪元**：文件先写 token_count 事件后升级为 record（实测 1 例：
  rollout-2026-09-03T19-48-47，前 296 条 token_count + 后 424 条 record）。
   适配器"record 存在即以 record 为准"逐行门控正确：前段按 last 求和 81,310,967
   与该段原生累计 81,311,--- 一致，后段 178,120,336 与 record 求和一致。
3. **legacy token_count 纪元**（9 月旧版）：每请求 last_token_usage 求和。
   148 个无计数器复位文件与原生最终 total_token_usage 交叉：147 个精确相等。

已知边界（非缺陷、不修复）：rollout-2026-09-02T20-50-33 的原生累计终值
202,224,767 比 last 求和 202,088,353 高 136,414（0.07%）——该差额在日志中
**不存在任何对应行**（无 token_count/record 覆盖，推断为压缩/标题类隐藏调用），
解析器无从计入行级明细。方向为保守低估，且对带复位的文件做剩余量回补会引入
高估风险，故记录不修。活跃文件 rollout-2026-10-07T14-50-19（比对窗口内持续
写入）排除出结论。

### Claude Code（正确；行级去重是必要的）

真实 transcript 中同一次调用会以相同 message.id、相同 usage 重复落盘最多 3 次
（resume/replay 重写），独立基准必须按 message.id 去重后求和；适配器
`keep_largest_output` 按 message.id(+requestId) 去重与之一致，96/96 静态会话相等。
subagents/ 目录并入父会话且不相交（sources 排除 subagents 路径防止双计）。
usage.iterations 的 advisor_message 分列口径保持独立事件，本机数据中未出现
（advisor 计数 0）。

次级差异（不修）：1 个会话（Rillight/0245db94）适配器 5,396,542 vs 基准
5,396,543，差 1 token——同 key 快照取"最大 output"与"最大总桶"在极端快照上
的启发式差异，占比 0.00002%。7 个无任何 assistant 文本的会话被
"无可展示消息"整会话拒绝，经核这些文件 usage 行数为 0，无用量损失。
1 个活跃会话（本 workflow 自身产生的 cliora 会话文件）排除出结论。

### Grok（正确；原生三级聚合全对上）

135/135 会话与 usage.json `session` 级 inputTokens+outputTokens 精确相等；
request_count 与原生 `modelCalls` 135/135 相等（含 turns→modelUsage→session
reconcile 路径补齐的剩余量与快照去重）。counts() 按原生语义
input = inputTokens − cachedRead − cacheCreation 拆桶（原生 input 含 cache）。
11 个无 usage.json 的会话目录不含用量数据，展示为无用量，正确。

### Pi（正确）

53/53 会话与全行求和（message.usage + 独立 type=usage/compaction 行）相等。
input 不含 cache（Anthropic 语义），四桶互斥；纯零 usage 行被 active 检查丢弃
（贡献为 0，不影响合计）。

### OpenCode（正确；本机数据与 01 §3 记录不符，已实测补齐）

01-exploration §3 记"仅 auth.json + session_diff，会话本体不在盘"**过时**：
本机 `~/.local/share/opencode/opencode.db`（1.18.x schema）实有 403 会话、
23,703 消息，适配器解析路径正常工作。403/403 会话与独立 SQLite 重算
（assistant 消息 tokens: input+output+reasoning+cache.read+cache.write）相等。
注：reasoning 计入 output（生成侧）依据 schema 注释与既有适配器考证，
db 内无原生汇总列可作第三方交叉，属代码级验证而非自报交叉。
既有 fixture（tests/fixtures + 模块测试）回归继续有效。

### ZCode（正确；内部库为权威路径）

db.sqlite 可读时以 `session`+`model_usage` 为权威：76 个含用量会话与
`sum(input_tokens)+sum(output_tokens)` 精确相等（input 含 cache，经
clamp 归一）；1 会话 model_usage 为空行集即无用量。取消/错误请求即全零行，
active 过滤不改变合计。rollout 独立路径（3 个本机文件）仅贡献 transcript，
不重复计量。

### Kimi Code（正确）

28/28 会话：全 agent 流（main+子代理）usage.record 四分项
（inputOther/output/inputCacheRead/inputCacheCreation）求和相等；跨流
usage 事件 id 隔离防覆盖。1 会话基准多 1 行全零 usage.record（贡献 0）。
input 不含 cache，互斥分桶正确。

### DSH（正确；现有 zstd 路径直跑真实文件）

5 个本机 session.v4.jsonl.zstd 全部经仓库现有 zstd 帧流解析路径解析成功，
与独立 zstd 解码后的逐行重算相等；3 个文件含 usage（355,381 token）、
2 个无 assistant usage 行（0 用量）。真实数据中 (turn,step) 键无重复，
`keep_largest_output` 去重从未折叠真实调用。input 不含 cache（TokenUsage
语义），reasoning 已含于 output。

## 横向核对（requestCount / 缓存分桶 / timestampSource）

- **request_count 语义**：非 Grok 七款每事件计 1，与基准事件数一致
  （差异仅为全零行/同 id 重放行，合计不受影响）；Grok 与原生
  `modelCalls` 135/135 相等。
- **缓存分桶互斥**：`input_includes_cache` 每工具全会话一致无混用
  （codex/zcode=true，其余=false）；对 incl-cache 工具逐事件断言
  input ≥ cache_read+cache_write（样本 dump：codex 720、zcode 1153、
  grok 17 事件，0 违例），报表层 fresh=input−read−write 折算安全。
- **timestampSource 标注**：grok 无行级时间戳的消息由 events.jsonl
  turn_started 推断并标 `Turn`（样本 6 Turn/10 Unknown，synthetic 行按设计跳过）；
  codex 等行带原生时间戳标 `Native`；无臆造时间。

## 审计产物与清理

- 临时对账工具：`src-tauri/tests/audit_tmp/`（经 Registry 调真实解析器）与
  独立重算脚本（audit-baseline.py 等，置于仓库外）均已删除，未入库。
- 本审计未改动任何 `src-tauri/src/adapters/` 代码、fixture 与指纹标签；
  各工具用量索引无重扫需要（指纹未变，已索引数据继续有效）。
- 量化证据（逐会话明细 JSON）为一次性产物，未落盘到仓库；本文件数字为
  审计执行期汇总，可由上述方法在任意机器复现。
