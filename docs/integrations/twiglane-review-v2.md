# cliora ↔ Twiglane 审查协议 v2

本文件是两端（cliora 发起端、Twiglane 接收端）唯一的合同来源，替代已废止的 v1。任何一端改变字段、校验规则、错误码或结果语义，都必须先改这里，再同时改两端的解析与测试。协议只使用系统 deep link，不引入常驻端口、共享数据库或内嵌 WebView。

两端同步升级到 v2：v2 不兼容 v1，也不提供回退。收到 `v=1` 或其他任何版本都按 `unsupported_version` 拒绝，不按 v2 猜测处理，也不为同一次审查发送两种版本的事件。

## 1. 角色与方向

| 方向 | scheme | host | 用途 |
| --- | --- | --- | --- |
| cliora → Twiglane | `twiglane` | `review` | 请求打开指定 worktree 进行审查 |
| Twiglane → cliora | `cliora` | `review` | 接收回执（accepted / rejected）与原会话返回（returned） |

两端各自静态注册自己唯一的 scheme。`cliora` 只由 Twiglane 用来回送事件，`twiglane` 只由 cliora 用来发起审查；任一端收到不属于自己方向的消息都按无效输入丢弃，不写 Git、不改会话。

## 2. 通用编码与限制

- 查询串使用 `application/x-www-form-urlencoded` 的百分号编码：未保留字符 `A-Z a-z 0-9 - _ . ~` 原样出现，其余字节按 UTF-8 编码为 `%XX`（大写十六进制）。空格编码为 `%20`，不使用 `+`；解析端遇到 `+` 按字面加号处理，不当作空格。
- 每个参数名最多出现一次。重复参数、未知参数、空参数名都是无效输入。唯一的扩展形式是第 4 节 `returned` 的 `meta.<namespace>.<name>`；它也受同一条“不得重复”的规则约束。
- 参数顺序不参与语义，解析端不得依赖顺序。
- URL 是普通字符串，不做通用 URL 规范化后再比较：scheme、host 必须精确等于上表的小写形式；不接受 userinfo、端口、fragment。host 之后只允许两种等价写法：紧跟 `?` 查询串，或恰好一个 `/` 再紧跟 `?`。第二种是操作系统对无路径 URL 的等价规范化（Windows 会把 `twiglane://review?v=2...` 交给应用时变成 `twiglane://review/?v=2...`），因此两端都必须接受；而 `//`（双斜杠）、`review/anything?` 这类多余路径段仍然无效。生成端使用不带尾斜杠的写法。
- 整个 URL 长度上限 2048 个 UTF-8 字节。URL 中出现 `\u0000`–`\u001F`、`\u007F` 等控制字符或裸空白（未编码空格）即无效。
- URL 不含任何凭据、令牌、代码正文、命令或 Git 输出；两端日志不得记录完整 query，只记录长度、reviewId 和错误码。
- `reviewId`、`sessionId`：十六进制的 RFC 4122 连字符形式 `8-4-4-4-12`，共 36 字符；不做版本位语义校验。
- `headOid`、`baseline`：恰好 40 位小写十六进制（完整对象 ID）。不接受短 OID、大写或 `HEAD~` 之类表达式。
- `worktreePath`：绝对路径，解码后 1–1000 个字符，必须是某个 Git 工作树的根目录（主检出或附属 worktree 的根），打开前由接收端重新 canonicalize。相对路径、以 `~` 开头的路径、只给仓库子目录的路径都属于无效目标。

## 3. cliora → Twiglane：`twiglane://review`

### 字段

| 参数 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- |
| `v` | 是 | 恰好 `2` | 协议主版本；其他值（包括 `1`）一律拒绝 |
| `reviewId` | 是 | UUID 形式 | 本次审查的关联标识，由 cliora 生成；每次发起或重新发起都是新值 |
| `sessionId` | 是 | UUID 形式 | 发起审查的 cliora 会话标识；Twiglane 只原样带回，不用它做任何仓库判定 |
| `worktreePath` | 是 | 绝对路径 | 目标工作树根目录 |
| `baseline` | 否 | 40 位小写十六进制 | 发起审查的会话在该 worktree 启动时的 HEAD；同一会话已有经复核的 committed/merged 结果时取那次结果的 HEAD；始终是当前 HEAD 的祖先（历史被改写时取共同祖先）；没有启动记录时为发起时的 HEAD；空仓库读不到时省略 |

请求不接受 `meta.*` 或任何其他参数：任务身份只由上表字段决定。

```
twiglane://review?v=2&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0&worktreePath=C%3A%2FUsers%2Fme%2Fwork%2F%E4%BB%A3%E7%A0%81%20demo&baseline=4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0
```

### 接收行为

1. 解析并校验；任何失败在 Git 写入之前结束，不打开仓库、不回退主仓库、不记录最近仓库。
2. 只打开 `worktreePath` 指向的目录。子目录、父仓库、同名仓库都不能替代；打开失败时不得改用主检出。
3. 打开成功后建立内存态来源上下文（reviewId、sessionId、worktreePath、baseline），回送 accepted。
4. 打开失败回送 rejected，并给出稳定错误码；本地 UI 同时显示同一原因的本地错误。

   协议解析本身失败（缺字段、版本不对、ID/OID 格式、超长、重复或未知参数）时没有可信的 `reviewId`/`sessionId`，Twiglane **不伪造回执**，只在本地说明原因；这种情况 cliora 等不到 accepted/rejected，按第 6 节的 10 秒未确认处理。因此 `unsupported_version`/`malformed_request` 只在本地作为原因出现，不通过 rejected 回送。
5. 启动时的冷启动链接与运行中的热启动链接行为一致；重复的同一 reviewId 只处理一次，后到的链接按第 7 节串行处理。
6. 系统 deep link 是不可信输入：链接只能请求打开仓库、更新审查 UI、选择已有会话，绝不直接触发暂存、提交、合入、推送、删除、文件写入或 Agent 操作。

## 4. Twiglane → cliora：`cliora://review`

### 公共字段

| 参数 | 必填 | 约束 |
| --- | --- | --- |
| `v` | 是 | 恰好 `2` |
| `event` | 是 | `accepted` \| `rejected` \| `returned` |
| `reviewId` | 是 | UUID 形式，必须是收到的请求里的同一个值 |
| `sessionId` | 是 | UUID 形式，必须是收到的请求里的同一个值 |

### `event=accepted`

只有目标 worktree 已经成功打开、来源上下文已建立后才发送。不得携带 `reason`、`outcome`、`headOid`、`worktreeState` 或 `meta.*`。

```
cliora://review?v=2&event=accepted&reviewId=6f1a2b3c-...&sessionId=0b1c2d3e-...
```

### `event=rejected`

必须带 `reason`，取值只能是下表中的稳定错误码；不携带原始 Git 错误文本、令牌或完整日志。不得同时携带 `outcome`、`headOid`、`worktreeState` 或 `meta.*`。

| `reason` | 含义 |
| --- | --- |
| `unsupported_version` | 预留给解析失败的可回送场景；解析阶段失败通常不回执（见第 3 节接收行为） |
| `malformed_request` | 同上，作为本地原因码使用 |
| `invalid_path` | `worktreePath` 相对、越界或无法 canonicalize |
| `not_a_worktree` | 路径存在但不是 Git 工作树根目录（含子目录、普通目录） |
| `open_failed` | 目标有效但打开失败（被占用、读取失败、用户保留未保存草稿而取消等） |

### `event=returned`

Twiglane 的内存态来源上下文仍存在时，用户点击“返回 cliora”才发送。返回动作本身不执行任何 Git 写入，也不清除任何草稿。

| 参数 | 必填 | 约束 |
| --- | --- | --- |
| `outcome` | 是 | `reviewed` \| `committed` \| `merged` |
| `headOid` | 视 `outcome` | committed/merged 必填，reviewed 不得携带 |
| `worktreeState` | 是 | `clean` \| `dirty` \| `unknown` |
| `meta.<namespace>.<name>` | 否 | 见下文“有界扩展元数据” |

**Git outcome** 只描述本次审查期间在 Twiglane 里真实完成的 Git 操作：

| `outcome` | 含义 | `headOid` |
| --- | --- | --- |
| `reviewed` | 本次审查期间**没有**提交或合入。它不再表示“只做了浏览”：工作区可能有未提交修改 | 不得携带 |
| `committed` | 本次审查期间成功创建的本地提交（`commit_changes`，或 `commit_and_push` 中 `committed=true` 的阶段） | 必填，取该次成功操作的提交对象 ID |
| `merged` | `start_merge` 的快进或变基完成，或 `complete_merge` 成功 | 必填，取完成后的 HEAD |

**工作区状态** `worktreeState` 描述返回时 Twiglane 读取到的工作区，与 outcome 正交：

| `worktreeState` | 含义 |
| --- | --- |
| `clean` | Twiglane 返回前重新读取真实 Git 状态，没有未提交文件（含未跟踪文件） |
| `dirty` | 同一次读取发现至少一个未提交文件（暂存、未暂存、未跟踪或冲突） |
| `unknown` | 返回前没有读到真实状态；不得当作 clean |

因此 `reviewed + dirty`（只编辑未提交）、`committed + dirty`（提交后仍有其他修改）、`merged + dirty` 都是合法且需要如实展示的组合。Twiglane 中普通文件保存只写工作区文件：它不改变 outcome，不产生 `edited`、批准或测试通过之类的结果；审阅标记数量也不进入协议。

失败、取消、过期响应、仅产生冲突草稿的合并都不记录结果，也不得回送 `committed`/`merged`。推送失败不影响已完成的提交声明，但也不得声称推送成功。新结果替代旧结果；同一来源只保留最新一次结果。

```
cliora://review?v=2&event=returned&reviewId=6f1a2b3c-...&sessionId=0b1c2d3e-...&outcome=reviewed&worktreeState=dirty&meta.twiglane.version=0.3.3
```

### 声明与复核

`headOid` 与 `worktreeState` 都只是“待复核声明”。cliora 对**每一个** returned（包括 reviewed）都重新读取目标 worktree 的真实分支、HEAD 与未提交文件数，并按下列规则展示：

1. 真实状态读取失败：显示“结果未确认 / 状态未知”，不展示成 0 个文件，也不展示提交或合入成功。
2. committed/merged：返回 OID 必须与发起基线不同，且等于当前 HEAD；否则显示未确认。
3. `worktreeState` 为 clean/dirty 时，必须与真实未提交文件数是否为 0 一致；不一致显示未确认。`unknown` 只表示声明未知，最终以 cliora 的真实读取为准。
4. 通过复核后：真实有未提交文件时显示真实数量（不说“只浏览”）；真实干净时只说“没有提交或合入”或已核实的提交/合入。

Twiglane 的保存、审阅标记或 meta 都不映射为批准、测试通过或 AI 修复完成。

### 有界扩展元数据

`returned` 可以携带说明性元数据，用于在不升级主版本的前提下增加短文本事实（例如 Twiglane 版本）。规则：

- 参数名形如 `meta.<namespace>.<name>`，只在 `returned` 中出现。`namespace` 匹配 `[a-z][a-z0-9-]{0,31}`，`name` 匹配 `[A-Za-z][A-Za-z0-9_-]{0,31}`；参数名必须原样出现（不得把 `.` 或字母写成百分号编码）。缺段、多段、空段、大写 namespace 或其他字符都是无效事件。
- 值解码后 1–128 个字符，不得包含控制字符（含换行、制表符）。同一 URL 最多 8 个 meta 参数，且整条 URL 仍受 2048 字节上限约束。
- 元数据只承载短文本事实，不得携带代码、文件内容、凭据、令牌、命令、日志或任何可执行内容。接收端可以保存元数据用于诊断，但不得执行、打开、作为路径或命令使用，也不得据此改变界面上的 Git 结论。
- 核心身份（reviewId、sessionId）、outcome、headOid、worktreeState 的校验与 Git 复核都不依赖 meta；未知 namespace 的合法 meta 被保留而不解释。
- meta 不是兼容层：它不让当前版本接受新的事件、新的核心参数或其他主版本。任何不符合上述形状的 meta、不以 `meta.` 开头的未知参数、任何重复参数，都使整个事件无效。

## 5. 结果展示边界

- cliora 收到有效的 returned 后，只定位并选择原 `sessionId` 对应、仍在本机工作台中的会话；不创建替代会话、不发送提示词、不启动 CLI、不执行修复，也不写 Git。
- 用户在原会话中自行继续修复。再次审查是一次新的发起：新的 `reviewId`；`baseline` 仍从这个会话的起点算起，若上一次审查已经核实提交或合入，则从那次结果的 HEAD 算起，已审查过的提交不再重复出现。

## 6. 关联与失效

- cliora 按 `reviewId` 维护内存态注册表（sessionId、worktreePath、基线 HEAD、最新状态与结果、工作区声明与 meta）；每个 session 只认最新 reviewId，显式重新发起的新 reviewId 使旧结果失效。
- 注册表不持久化。应用重启后旧链接到达视为“来源审查已失效”：不创建替代会话、不修改现有会话、不写 Git。
- Twiglane 的内存态上下文绑定 canonical 仓库路径。独立打开其他仓库会清除当前来源展示，但不清除任何仓库已有草稿；返回 cliora 之后来源与最新结果仍保留在当前会话里，直到独立打开别的仓库。
- 迟到的 returned（reviewId 不是当前最新的）必须被丢弃，不得覆盖更新结果。
- 超过 10 秒未收到 accepted/rejected，cliora 显示“打开结果未知，可能未安装或版本不兼容”，提供重试与安装说明；系统接受 URL 不等于 Twiglane 已打开。

## 7. 并发与幂等

- 同一 `reviewId` 的重复 accepted/rejected 按最后一次状态处理；重复 returned 只保留最新一次。
- 多个链接连续到达时，接收端按串行处理，较新的请求不会因为旧请求的打开结果后到而被回退：旧请求的结果只作用于它自己的 reviewId。
- 任一参数超限、超时或读取失败都失败为“未知”，不伪造空状态或成功。

## 8. 合同夹具

两端测试共用下面这些字符串形态（实现里不硬编码同一份常量，但必须得到相同判定）：

| 场景 | 期望 |
| --- | --- |
| `twiglane://review?v=2&reviewId=<uuid>&sessionId=<uuid>&worktreePath=C%3A%2Fw%2Fa%20b&baseline=<oid>` | 接受，路径解码为 `C:/w/a b` |
| `worktreePath` 含 Unicode 目录（`%E4%BB%A3%E7%A0%81`） | 接受，解码后为原字符 |
| `v=1`、`v=3` 或缺少 `v`（请求与事件两个方向） | 拒绝，`unsupported_version`；不回退、不发送第二个事件 |
| `twiglane://review/?v=2&...`、`cliora://review/?v=2&...`（host 后恰好一个尾斜杠） | 接受，与无斜杠形式同一语义 |
| `twiglane://review//?...`、`twiglane://review/a/b?...` | 拒绝，`malformed_request` |
| 带端口或 userinfo、`http://review?...`、`twiglane://other?...`、带 fragment | 拒绝，`malformed_request` |
| 同一参数出现两次（含同一 meta 键） | 拒绝，`malformed_request` |
| 未知核心参数 `foo=1`；请求里出现 `meta.x.y=1` | 拒绝，`malformed_request` |
| `reviewId`/`sessionId` 非 UUID、`baseline` 短 OID 或大写 | 拒绝，`malformed_request` |
| `worktreePath` 相对路径、`~` 开头、超过 1000 字符 | 拒绝，`invalid_path` |
| 整体长度超过 2048 字节、含裸空格或控制字符 | 拒绝，`malformed_request` |
| 路径是仓库子目录 | 拒绝，`not_a_worktree` |
| `event=returned&outcome=reviewed&worktreeState=dirty` | 接受：没有提交或合入，工作区声明有未提交修改 |
| `event=returned&outcome=committed&headOid=<oid>&worktreeState=dirty` | 接受：提交后仍有剩余修改 |
| `event=returned&outcome=reviewed&worktreeState=clean&meta.twiglane.version=0.3.3` | 接受；meta 被保留，不改变核心解析与 Git 复核 |
| `event=returned` 缺 `worktreeState`，或取值不是 clean/dirty/unknown | 无效事件，cliora 忽略且不写状态 |
| `event=returned&outcome=committed` 缺 `headOid`；`outcome=reviewed&headOid=<oid>` | 无效事件，cliora 忽略 |
| `accepted`/`rejected` 携带 `worktreeState` 或 `meta.*` | 无效事件 |
| meta 键缺段/多段/空段（`meta.x`、`meta.x.y.z`、`meta..y`）、大写 namespace、非法字符、百分号编码的键、值为空、值超过 128 字符、值含控制字符、超过 8 个 meta | 无效事件，cliora 忽略且不写状态 |
| 未知或已被取代 `reviewId` 的 returned | 忽略，不创建会话、不写 Git |

## 9. 平台与验证边界

- Windows 与 Linux 的静态 scheme 由 Tauri deep-link 插件在安装/注册时写入；Windows 开发构建与 Linux 需要 `register_all`，macOS 只能以安装到 `/Applications` 的 bundled app 验证。
- Linux AppImage 的系统集成取决于 launcher 或运行期注册，构建成功不等于系统联动已验证。
- Vitest、Playwright、Rust 单测与安装包构建成功都不等于双端实机联动已验证；真实联动证据见 Twiglane 的 `docs/verification/cliora-integration.json`，由 `scripts/verify-cliora-integration.mjs` 按 v2 场景校验。历史 v1 报告只作先例，不代表当前候选通过；未实际执行的平台必须写为 limitation。
