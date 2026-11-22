# Cliora ↔ Twiglane 审查协议 v3

本文件是新版协议的唯一合同；两端独立实现并消费相同的 `tests/fixtures/reviews/protocol-v3.json`。v2 仅按 [兼容合同](twiglane-review-v2.md) 读取和回送，不能混用字段。新发起固定 v3；未安装、未确认或版本不兼容时明确说明，禁止自动重发为 v2。deep link 不执行 Git 写入或 Agent 操作。

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
- URL 是普通字符串，不做通用 URL 规范化后再比较：scheme、host 必须精确等于上表的小写形式；不接受 userinfo、端口、fragment。host 之后只允许两种等价写法：紧跟 `?` 查询串，或恰好一个 `/` 再紧跟 `?`。第二种是操作系统对无路径 URL 的等价规范化（Windows 会把 `twiglane://review?v=3...` 交给应用时变成 `twiglane://review/?v=3...`），因此两端都必须接受；而 `//`（双斜杠）、`review/anything?` 这类多余路径段仍然无效。生成端使用不带尾斜杠的写法。
- 整个 URL 长度上限 2048 个 UTF-8 字节。URL 中出现 `\u0000`–`\u001F`、`\u007F` 等控制字符或裸空白（未编码空格）即无效。
- URL 不含任何凭据、令牌、代码正文、命令或 Git 输出；两端日志不得记录完整 query，只记录长度、reviewId 和错误码。
- `reviewId`、`sessionId`：十六进制的 RFC 4122 连字符形式 `8-4-4-4-12`，共 36 字符；不做版本位语义校验。
- `headOid`、`baseline`：恰好 40 位小写十六进制（完整对象 ID）。不接受短 OID、大写或 `HEAD~` 之类表达式。
- `worktreePath`：绝对路径，解码后 1–1000 个字符，必须是某个 Git 工作树的根目录（主检出或附属 worktree 的根），打开前由接收端重新 canonicalize。相对路径、以 `~` 开头的路径、只给仓库子目录的路径都属于无效目标。

## 3. cliora → Twiglane：`twiglane://review`

### 字段

| 参数 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- |
| `v` | 是 | 恰好 `3` | 协议主版本；合法 `2` 进入独立兼容分支，其他值拒绝 |
| `reviewId` | 是 | UUID 形式 | 本次审查的关联标识，由 cliora 生成；每次发起或重新发起都是新值 |
| `sessionId` | 是 | UUID 形式 | 发起审查的 cliora 会话标识；Twiglane 只原样带回，不用它做任何仓库判定 |
| `worktreePath` | 是 | 绝对路径 | 目标工作树根目录 |
| `baseline` | 否 | 40 位小写十六进制 | 发起审查的会话在该 worktree 启动时的 HEAD；同一会话已有经复核的 committed/merged 结果时取那次结果的 HEAD；始终是当前 HEAD 的祖先（历史被改写时取共同祖先）；没有启动记录时为发起时的 HEAD；空仓库读不到时省略 |

另外允许以下可选来源字段：

| 参数 | 约束 | 语义 |
| --- | --- | --- |
| `workspaceId` | UUID | 发起会话保存的业务项目身份 |
| `repositoryId` | UUID | 发起会话保存的仓库身份；可独立于项目存在 |
| `workspaceName` | 解码后 1–80 Unicode 字符，无控制字符；必须同时有 workspaceId | 仅显示，不用于路径、成员映射或 Git 判定 |

来源字段全部缺省表示独立仓库。项目名称在发起时截取最多 80 字符，URL 仍须通过 2048 字节总长检查，不能悄悄丢弃来源字段来凑长度。不携带完整项目名单、提示词正文、凭据或配置。接收端未关联该 workspaceId 时显示“项目未关联”，仍可打开已验证工作树，不按名称猜测项目。UUID 不能替代 worktreePath；返回仅使用 Cliora 原登记的项目/仓库/会话。

请求不接受 `meta.*` 或任何其他参数。

```
twiglane://review?v=3&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0&worktreePath=C%3A%2FUsers%2Fme%2Fwork%2F%E4%BB%A3%E7%A0%81%20demo&baseline=4f3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0
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
| `v` | 是 | 恰好 `3` |
| `event` | 是 | `accepted` \| `rejected` \| `returned` |
| `reviewId` | 是 | UUID 形式，必须是收到的请求里的同一个值 |
| `sessionId` | 是 | UUID 形式，必须是收到的请求里的同一个值 |

### `event=accepted`

只有目标 worktree 已经成功打开、来源上下文已建立后才发送。不得携带 `reason`、`outcome`、`headOid`、`worktreeState` 或 `meta.*`。

```
cliora://review?v=3&event=accepted&reviewId=6f1a2b3c-...&sessionId=0b1c2d3e-...
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
| `resultRevision` | 是 | 解码后正十进制整数 1–9007199254740991，不允许符号或前导零 |
| `meta.<namespace>.<name>` | 否 | 见下文“有界扩展元数据” |

**Git outcome** 只描述本次审查期间在 Twiglane 里真实完成的 Git 操作：

| `outcome` | 含义 | `headOid` |
| --- | --- | --- |
| `reviewed` | 本次审查期间**没有**提交或合入。它不再表示“只做了浏览”：工作区可能有未提交修改 | 不得携带 |
| `committed` | 本次审查期间已核实创建的本地提交：普通提交、commit-and-push 的已提交阶段、拣选、还原、修订，以及拣选/还原的继续完成；部分批次在后续冲突前已创建的提交单独计入 | 必填，取该次成功操作的提交对象 ID |
| `merged` | `start_merge` 的快进或变基完成，或实际 merge/rebase 的 `complete_merge` 成功；拣选/还原继续完成归 committed | 必填，取完成后的 HEAD |

**工作区状态** `worktreeState` 描述返回时 Twiglane 读取到的工作区，与 outcome 正交：

| `worktreeState` | 含义 |
| --- | --- |
| `clean` | Twiglane 返回前重新读取真实 Git 状态，没有未提交文件（含未跟踪文件） |
| `dirty` | 同一次读取发现至少一个未提交文件（暂存、未暂存、未跟踪或冲突） |
| `unknown` | 返回前没有读到真实状态；不得当作 clean |

因此 `reviewed + dirty`（只编辑未提交）、`committed + dirty`（提交后仍有其他修改）、`merged + dirty` 都是合法且需要如实展示的组合。Twiglane 中普通文件保存只写工作区文件：它不改变 outcome，不产生 `edited`、批准或测试通过之类的结果；审阅标记数量也不进入协议。

全跳过、未核实创建提交的失败/取消、过期响应和纯冲突草稿不制造结果，也不抹去该来源已有的真实结果。已由受控写操作核实的提交阶段即使后续批次遇到冲突仍保留；不从 checkout/reset 等单纯 HEAD 位移推断提交。推送失败不影响已完成的提交声明，但也不得声称推送成功。Twiglane 原生按 reviewId 在返回请求进入时、异步 Git 读取之前分配严格递增 resultRevision，不由前端指定。较慢的旧请求仍携带较小序号，不能因较晚完成变成新结果。允许再次返回更新结果；发送失败可留下序号间隙。Cliora 仅接受比该来源已收到序号更大的 returned，重复或逆序忽略；同一来源只保留最新结果。accepted/rejected 不允许 resultRevision，returned 后迟到的接收回执不能把结果退回 accepted/rejected。v2 不允许此字段。

```
cliora://review?v=3&event=returned&reviewId=6f1a2b3c-...&sessionId=0b1c2d3e-...&outcome=reviewed&worktreeState=dirty&resultRevision=1&meta.twiglane.version=0.3.3
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
- Twiglane 的内存态上下文绑定 canonical 仓库路径。新版运行时按 reviewId 保留来源；切仓只改变活动展示，切回可恢复并显式选择。最多保留 8 条（含待接受），满时明确报错；用户关闭来源才释放，不淘汰活动来源。已明确关闭或拒绝的 reviewId 在本次运行保留失效标记，旧 URL 不能复活或占据不可见待定位置；失效记录最多 256 条，满时明确要求重新启动并重新发起，不淘汰当前来源。运行中 WebView 重载通过有界原生列表恢复已接受来源、各自实际成功的 Git 结果与最近返回声明；未接受的旧打开明确失效并释放容量。源数据只在内存，整个应用进程重启后重新发起。v2 结果没有递增序号，因此 v2 的重复返回仍按原“最新接收替代”兼容语义处理。
- 迟到的 returned（reviewId 不是当前最新的）必须被丢弃，不得覆盖更新结果。
- 超过 10 秒未收到 accepted/rejected，cliora 显示“打开结果未知，可能未安装或版本不兼容”，提供重试与安装说明；系统接受 URL 不等于 Twiglane 已打开。

## 7. 并发与幂等

- 同一 reviewId 的重复 accepted/rejected 在尚未 returned 时幂等处理；returned 后忽略迟到回执。重复/逆序 returned 按 resultRevision 忽略，不改变新结果。与登记来源版本不符的事件忽略。
- 多个链接连续到达时，接收端按串行处理，较新的请求不会因为旧请求的打开结果后到而被回退：旧请求的结果只作用于它自己的 reviewId。
- 任一参数超限、超时或读取失败都失败为“未知”，不伪造空状态或成功。

## 8. 合同夹具

两端 `tests/fixtures/reviews/protocol-v3.json` 必须逐字一致。request/event 两组包含 v2 和 v3、独立仓库、有界来源、Unicode/字面反斜杠、来源/版本字段交叉、重复/未知参数、路径与 OID、meta 与 resultRevision 边界。Rust 测试读取同一文件；有效 v3 返回必须带 resultRevision。来源选择、容量和逆序隔离另由真实状态/界面测试验证，不能只验证解析。

## 9. 平台与验证边界

- Windows 与 Linux 的静态 scheme 由 Tauri deep-link 插件在安装/注册时写入；Windows 开发构建与 Linux 需要 `register_all`。macOS 必须使用真实 bundled app 注册和投递，记录具体 bundle 路径、identifier 与实际 handler；构建本身不证明注册。独立候选的临时 handler 变更必须完整恢复。
- Linux AppImage 的系统集成取决于 launcher 或运行期注册，构建成功不等于系统联动已验证。
- Vitest、Playwright、Rust 单测与安装包构建成功都不等于双端实机联动已验证；真实联动证据见 Twiglane 的 `docs/verification/cliora-integration.json`，由 `scripts/verify-cliora-integration.mjs` 按 v3 场景校验。历史 v1 报告只作先例，不代表当前候选通过；未实际执行的平台必须写为 limitation。


## 10. 原生来源边界

Cliora 在把 URL 交给系统之前登记来源，以接受运行中 peer 的立即回执。系统明确拒绝打开时，只回滚本次仍未确认的登记并恢复前一 latest；已经收到的 accepted/returned/rejected 和并发较新来源不被回滚。版本、latest、阶段和结果序号的检查与更新必须在同一原子临界区。

Twiglane 的 `cliora_review_sources({resetPending})` 返回有界的 `{sources, expiredPending}`。每项包含 `source`（协议版本、UUID、canonical worktree、baseline 与可选项目来源）、`result`（原生既有 Git 写入成功边界保存的 committed/merged、headOid、recordedAt）和 `lastReturn`（revision 与最近返回声明）。首次 WebView 恢复明确过期旧 pending 并报告数量；入站 prepare 排在恢复 Promise 之后，不能误清当前新请求。普通列表刷新不清 pending；前端 mutation epoch 拒绝迟到快照覆盖新来源、关闭或结果。内存列表不读取另一产品数据库、不包含凭据，不代表进程重启后恢复。

提交/整合入口 commit_changes、commit_and_push、cherry_pick_commits、revert_commits、amend_commit、start_merge、complete_merge 携带可选的起始 reviewId 归属，始终走原 GitScheduler/写锁/generation 与失败保护。成功仅记录给操作开始时选择且 canonical 路径相符的来源；没有来源时不产生记录；未核实完成提交阶段的失败、取消、预览和纯冲突不产生结果，已有结果仍保留。拣选的 created/headOid 来自该受控写操作内的验证；继续操作的 operation 来自实际 write guard 完成结果，不能由切仓后的前端状态指定。返回声明必须与原生成功缓存一致，之后仍需 Cliora 复核真实 HEAD/dirty；缓存或快照不是测试、批准或项目完成结论。显式释放来源不要求该路径还能打开，也不关闭当前仓库或删除草稿。


接收 accepted 的等待只决定来源登记，不授权迟到回调改当前阅读上下文。Twiglane 保留已经接受的来源；repository epoch、路径或显式来源选择已经变化时，仅登记该来源，不激活它、不把其 baseline 写入当前仓库。用户之后可显式选择该来源继续审查。

## Twiglane 远端审查与连接器 v1

### 审查来源

Cliora 通过 `twiglane://remote-review?v=1` 发送 `reviewId`、`sessionId`、`targetId`、`targetRevision`、`peerRevision`、`peerIdentity`、`worktreePath` 和 `worktreeIdentity`。启动时可用的完整提交 ID 通过可选的 `baseline` 发送。首次启动产生的记录绑定工作树，重复读取或重新打开同一记录不会移动基线。源会话更换主机、工作树被替换或已无可核实的来源时，需要从正确的远端工作树发起新审查。

启动时确实没有基线的会话可以省略该字段。已记录的基线无法在当前历史中核实时，读取明确返回 `invalid_baseline`。用户可恢复原基线后重试，或在正确的工作树重新开启会话。

POSIX 继续发送绝对路径。Windows 发送盘符大写、使用 `/` 分隔的规范路径，例如 `C:/项目 with spaces/repository`。Windows 工作树指纹是紧凑 ASCII JSON 的 SHA-256。数组包含小写物理 DNS 主机名、工作树根目录信息和该工作树的 Git 目录信息。每项目录信息包含规范路径、卷序列号和 64 位文件索引。POSIX 指纹仍使用原路径、设备号和 inode。

Windows OpenSSH 的 Cliora 工作台使用前台会话，运行目录来自盘符项目。该主机需要能在 OpenSSH 命令路径找到 Git、Python 3 和原生 CLI 可执行文件。正常退出会回传结束标记，连接中断后可重新启动会话。POSIX 会话继续由 tmux 或 screen 管理。

### 返回和持久确认

Twiglane 发送 `cliora://remote-review?v=1&event=returned`，并带原 `reviewId`、`sessionId`、正整数 `resultRevision`、`outcome` 和 `worktreeState`。结果阶段依次为 `reviewed`、`committed`、`merged`。后两种结果必须带完整 `headOid`。接收端同时接受系统规范化后的 `cliora://remote-review/?`。

Cliora 在打开 Twiglane 之前持久保存当前审查来源。返回时按原协议身份、远端会话、项目、主机和工作树重新核验，也适用于 Cliora 进程重启或工作台重新附着后更换本地标签的情况。成功复核 HEAD、基线和工作区状态后写入收据。旧来源和逆序结果不会覆盖新结果。未确认的结果允许重送同一序号和完全相同的载荷，已保存的重送不再次写入。

`cliora --twiglane-remote-v1 version` 的 `capabilities` 包含 `reviewReceipt` 时，Twiglane 可调用以下只读确认。

```text
cliora --twiglane-remote-v1 review-receipt <reviewId> <sessionId> <resultRevision>
```

只有该来源和序号已落库时才返回 `{"stored":true}`。其他有效查询返回 `{"stored":false}`。启动深链接本身不会生成回执。

### 通过 Cliora 主机簿打开 agent v2

`cliora --twiglane-remote-v1 version` 的 `capabilities` 包含 `agentV2` 时，Twiglane 可用以下固定命令连接已启用且受信任的 Cliora SSH 目标。

```text
cliora --twiglane-remote-v1 probe-v2 <targetId> <targetRevision>
cliora --twiglane-remote-v1 install-v2 <targetId> <peerRevision> <sha256> <digestSignature>
cliora --twiglane-remote-v1 connect-v2 <targetId> <peerRevision> <sha256> <digestSignature>
```

探测返回 `system`、`architecture`、`peerRevision`、`peerIdentity` 及可用的 `gitVersion`、`agentSha256`。安装从标准输入读取组件字节，输出 `installed` 与 `agentSha256`。连接将标准输入输出用于 v2 帧。远端写入和启动在已冻结的 SSH 设置及主机密钥通过验证后才开始，凭据由 Cliora 管理。

`digestSignature` 是 Twiglane 发布方对 UTF-8 字节 `twiglane-agent-v2 sha256:<64 个小写十六进制字符>\n` 的 Tauri 签名。连接器使用发布公钥核对该证明，远端按摘要核对实际组件。v1 的签名和命令继续沿用原协议。开发构建可在显式设置 `CLIORA_TWIGLANE_TEST_DB` 的夹具进程内通过 `CLIORA_TWIGLANE_TEST_V2_PUBLISHER` 选择测试公钥。发行构建始终使用内置发布公钥。
