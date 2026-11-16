# 多仓库项目工作区验证

日期：2026-11-16。更新：2026-11-17。环境：macOS，Node v26.13.0、Rust 1.98.1。

## 当前已实现范围

Cliora 增加独立业务项目、仓库成员与工作位置模型，保留旧目录配置身份。首页和新建会话入口支持项目内搜索、收藏、多选添加、限定目录扫描、主目录/附属 worktree 选择及会话归属。项目清单 v1 支持预览、关联、发布、版本检查和原子更新。本文记录 T1 和 T3 开发验证；Twiglane 消费、bundle/WebDAV 和审查 v3 的结果由对应实现与验证补充。

## T1 初版开发检查

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| TypeScript 与 Vite 构建 | 通过；后续最终 UI 回归也重新构建通过 | controlled command `84d282f24d3f2909d7305b59ff07f8f047518eea8215db8f2e0b5dd206a8d3fe`、`d6501af7e2eff0617acf6e78f3519288fee48a67c94d0b1e652bd6349a1c5ea5` |
| 新 workspaces 原生回归 | 14 通过，0 失败；真实临时 Git/SQLite/文件锁 | `0b352463db347b7815c6d7ff24ba1d08ff958591524f818e336d4b4a3f32955c` |
| 既有 projects / git_context / workbench_restore 回归 | 分别 2 / 11 / 7 通过 | `a072da33a185e80651a2e4ffe721ed60ce8c95c6b5753b6af828858a37e3a71f`、`5e52c06b4fcf5389125beaea5c4fc2e7348eff399d05608551317d46af655a84`、`44b057c19a9d24fe22fb2254c43ca26af7684a122fc9895cdf5d04a1dbd7dce4` |
| home-tools 与 workspace-projects 浏览器回归 | 40 通过，包含新建会话完整选择、48 仓搜索、失败重试与取消 | `d6501af7e2eff0617acf6e78f3519288fee48a67c94d0b1e652bd6349a1c5ea5` |
| Rust Clippy | `--all-targets -- -D warnings` 通过 | `8822532d91c76084b0f8ea9617c4f6f85b15414019ddeef6b486a352271b2cac` |
| 项目 UI 捕获 | 1360px，浅深两主题共 10 张；无页面错误或横向溢出 | `92dda8c905ca45571af0487948f325eb2bf5e1374743ed46a91416acd10e05c0` |

上述命令的原始 stdout/stderr 在本机 `~/.sakullla/runtime/controlled-commands/<证据键>/`。所有列出的通过命令均正常退出，受控清理状态为 released。截图与 gallery 位于本机忽略目录 `docs/verification/multi-repository-project-workspaces-ui/`，manifest 为 `capture-ui-projects-manifest.json`。已实际查看浅色多仓列表、暗色批量预览与浅色清单预览；新业务项目和旧目录配置入口具有不同标题，暗色弹窗在动画完成后可读。

## T1 独立审查后的返修检查

独立审查对初版候选 `0345f15e` 提出四项阻断：退役路径误归并仓库身份、可预测关联冲突发生在清单发布之后、深链预览未消费，以及 Windows drive-relative 路径误判。返修前先在原实现上运行反例，原生新增 4 项全部失败（原有 14 项通过），取消/接受预览后导航往返的 2 项 UI 反例也均失败，证据为 `abb9c3ba60d5e2bd2994b8e1539aa3f4290ec1ee86f53c35f066b0e635c8f435` 与 `5124a224ee2be3275a20f727b80c365b9dff84e1983dfaffcdb2ba77d09491ad`。

返修仅保留有成员引用的位置作为身份依据，退役无引用位置但保留历史目录上下文；在同一 SQLite 写事务内先完成可预知校验再发布清单；交接到预览组件后消费父级深链请求；校验完整 POSIX/drive/UNC 语法并对本机目录再次检查绝对路径。共享路径样本为 `tests/fixtures/workspaces/path-cases-v1.json`，供 Twiglane 同样消费。

| 返修后检查 | 实际结果 | 证据键 |
| --- | --- | --- |
| workspaces 原生 | 20 通过，包含四项原失败与真实发布后存储故障恢复、外平台路径限制 | `084580df844eb530e5f9d49a2b6eb7f81d924190ff5b9e01d41f9448d3c6db9b` |
| workspace-projects UI | 6 通过，含取消/接受后导航返回；该命令先重新完成 TypeScript/Vite 构建 | `a84b0ae2e5027cd59bc9c477f5f41d96be850ddb057897f7af3fc89969c1479c` |
| Clippy | `--all-targets -- -D warnings` 通过 | `cae686ddfc7bda7dcc53fda4e1a73b74f3aed00cbfd12f2a7ba75e58a2040719` |

以上返修命令均退出 0、清理 released。返修未改变布局，初版 capture2 的布局观察继续适用；旧 40 项 UI 记录属于初版开发验证，本轮仅重跑直接受影响的 6 项，正式累计候选验证仍由最终交付执行。此处测试结果不代替独立返修审查结论。

## 修复与结果边界

- 一次并行原生回归暴露 export 后紧接 rename 的暂时 busy。原锁仅在 File 关闭时释放；显式 unlock 的 RAII guard 与“副本描述符仍打开时释放锁”的确定性回归已补齐，最终 14 项包含该场景。不是通过盲目重跑认定修复。
- 已验证清单变更后仅替换该项目的位置引用、不误移除其他项目引用；旧主目录和附属 worktree 共用仓库身份，同时保留各自原生配置上下文。
- 已验证选择具体 checkout 时优先精确目录配置，清单 refresh 拒绝版本倒退与同版本内容替换，submodule 不展示 Git 管理目录作为可用工作位置。
- 首轮截图截到弹窗 opacity 动画中间，后续捕获设置禁用有限动画并重新生成当前截图，未因此修改产品背景样式。

浏览器检查使用合成 IPC，不证明桌面 WebView、真实 CLI 登录/启动或双端系统 deep link 已通过。当前安装的 `/Applications/Cliora.app` 为 0.4.140、`/Applications/Twiglane.app` 为 0.3.21，均不是本轮候选。双端候选与真实 scheme 往返由最终集成阶段另行取得证据，未执行平台不声称已验证。当前尚未运行最终全套交付验证，也未作整款应用性能收益声明。


## T3 项目提示词与快速填充（2026-11-17）

Cliora 增加 prompt 专用范围、标签、使用记录与批次回执，正文继续沿用共享 library_items，规则的原生分发保持原路径。旧目录项目只通过 workspace_legacy_map 精确解析，无法解析的范围保留为 unresolved。资料库提供分页全文搜索、范围/标签筛选、批量 JSON/Markdown/文本导入、逐项预览与失败重试、批量归类；工作台和新建会话共用查询与正文读取接口，插入保留草稿、不发送，并明确插入后的焦点归属。

远端以同一主机的 library.json 与 prompts-v1.json 保存正文及范围/回执。基于共享事务的不可变 expected_files 约束，远端在一个快照内逐条校验与生成回执，再一次提交文件对；只有实际提交成功才返回 saved。本地仍逐项数据库事务。新接口已接入实际读基线、版本化读取及已有写入恢复，不使用空基线绕过 CAS。导入读取同时检查实际字节数，远端不存在与目录/不可读/无效 JSON 被分别处理。

| 开发检查 | 实际结果与证据键 |
| --- | --- |
| prompt 原生 | 12 项适用检查：末轮先有 11 通过、1 失败（`bdead2870f3f3611af62716694ca737a777d51bdf4b5ef791229d819c9bd0ef6`）；修正只读脚本后，该失败项通过（`62b4fbd293722ccb7195093daf5e37d23ee8a07e73fde59a9984e539b229f36d`）。包含真实 SQLite、临时 UTF-8 文件、scope/CAS/幂等重试和本机 POSIX 只读传输。 |
| 旧 library 原生 | 1 项通过：`f4162ea06e400789878799e8b81b001b6f7b0686e62f11b526f3c0fcd9b97f90`。 |
| 相关非终端 UI | 212 项集先有 210 通过、2 失败（`4bdb3ba987e96a085c7747cdc38232c0b51b8e95e100a7dd6f1924fe3cc3c603`）；修正插入焦点及保存后错误文案后，两原失败均定向通过（`2ddbf8708cf9f048bf1365b096f13dea5ef749265617352176090771d63ee1fb`）。其它已通过结果保留，未将原失败整轮改写为全过。 |
| 终端最小复验 | 显式 Windows 风格 fixture、单 worker 的 6 项通过，覆盖粘贴、查找、字号、OSC 链接、分屏、WebGL 恢复：`e7145f07ccc02d46f7a1bd4139e13529830d57e60fcbba07930d760500938267`。 |
| Node 门禁 | 初轮 189/193，修复后 193/193：`473e1ca6a54634a47b0a3828b705ac98b3739c190a7db22ce1a8190599ceb1b7`。未排除失败检查。 |
| 最终前端构建 | TypeScript/Vite 通过：`2c25801a6042ee988ecf8e512eb3ba8e86bdb7c19c8406c1779f28fd1a334b37`。 |
| Clippy 开发检查 | `--all-targets -- -D warnings` 通过：`d1dbf4a83bdf62e29788012d961ceebbf2fe195817951b7cef5971b583a759e9`；后续只读脚本常量修正已进行定向编译测试，累计候选仍由 Delivery 正式复验。 |
| 最终提示词截图 | 1360px 深浅主题共 14 张，failures 为空；证据 `012f987c66ad7b38bc57dcdb34b9d0bf5b6bfefa523c213756408ba4cc5e6783`。 |

原始失败和后续验证的区别：早期 UI 大集记录为 429 通过、28 失败（`ef5a10a67aa4c65ed227fb3d1869398a1429f10a850cdd137e19d3080de12f55`），其中 terminal 测试原本写死 Control，而本机产品正确采用 macOS Meta；fixture 现在明确声明其 Windows 键盘合同，生产修饰键处理未改。兼容旧资料库的 fixture 不再默认推导业务项目，避免改变无关首页与终端布局。真实遗漏则补回了复制/副本/编辑、4 秒通知、保存后列表失败保留已确认版本、同主机同范围跨入口的 stale 快照，以及不同范围不能互相替代的回归。

只读远端脚本首次实际运行被共享命令输入 guard 拒绝：918 字节并未超过长度上限，真正原因是字面换行控制字符。固定脚本改为单行后原用例通过，未提高或绕过共享保护。Node 初轮缺键来自测试硬编码旧 namespace 清单，现应用和测试读取同一个纯 resources catalog；spacing 使用已有等值 tokens；两处旧平台夹具分别解析 /usr/bin 或 /bin 的真实工具、使用当前平台绝对路径，保留故障注入和输出隔离断言。

截图在忽略目录 `docs/verification/project-prompts-ui/`，manifest 为 `capture-ui-prompts-manifest.json`。输入含 124 条合成提示词，覆盖正文摘要之后的匹配、项目范围、编辑、同名导入预览、工作台全文预览及草稿插入；原生分页测试另使用 130 条。已实际查看最终浅色列表、暗色导入预览和浅色全文 picker，标题左对齐、正文和范围可读。未据这些输入或耗时宣称整款应用性能提升。

本机没有远端写入脚本要求的 GNU flock/stat；两个 Linux 专用的文件对事务测试已加入，但未在此 macOS 主机运行。POSIX 只读 fixture 与浏览器合成 IPC 不证明真实 SSH 写入、桌面 WebView 或其它平台已验收。T4 应通过 prompts::export_metadata / restore_metadata 迁移范围与标签；usage 和批次回执保持本机/原主机，不随正文迁移。正式累计验证与双端原生联动仍由后续 Delivery/T5 承担。

## T3 独立审查后的返修检查（A2）

候选 `3d7c958a` 的三项阻断先以反例复现。原生 16 项中原有 12 项通过，新增 4 项分别失败：批内重复没有独立提示数据、合法旧分类的 33 个标签使全库初始化报错、活动写锁期间读到混合文件对，以及进程中断后未完成回执未阻止混合快照进入成功缓存。原生失败证据为 `cdf363a564cb903882ad175edf73f4f3e797b63cf2bfede95af94ef4028c4089`。空库批内重复的 UI 反例预期两条警告、实际零条，证据为 `c91062d75955b84f98da59a7fe458ee78b47ba03ff752f60409a64e31f7fd38e`。这些失败命令已退出且清理 released；未把失败轮次改记为通过。

返修后的读取通过共享 transaction 服务持有同一 `transactions/lock`，并在读取前检查持久回执。活动写入期间等待锁；锁因进程终止而释放后，未终结回执仍阻止读取，错误提示先打开写入恢复。`committed`、`rolled_back`、`conflict_before_commit`、`prepare_failed` 与现有恢复消费者的终态保持一致；未知、损坏和恢复中的回执拒绝读取。失败不会成为成功缓存，终态恢复后可重新读取。无未完成回执的真实旧资料仍允许缺少 side metadata。脚本使用现有 `sh -s` stdin 通道，未放宽命令长度或控制字符保护。

导入预览为批内匹配增加独立 `batchMatches`，不伪造已有条目的 ID/version，因此不能作为替换目标。原生按标题与正文分组，最多返回每行八个匹配示例，2000 条相同输入不会产生数百万条匹配明细。界面根据当前选中且未跳过的可编辑输入重算提示；修改标题或正文、取消后重选和跳过都会更新，用户仍可明确保存副本或跳过。

旧分类初始化不套用新标签数量规则；33 个单字汉字加逗号共 65 字符的合法旧分类可读取、继续编辑正文、导出/恢复并整理标签，不阻断其它条目的保存。只有与原条目完全相同、可由旧 80 字符分类无损表示的 tags 可随编辑保留；新建或扩张仍使用每项 80 字符、总计 32 项等新写校验。`restore_metadata` 接受此类旧表示供 T4 迁移，不改变新建和导入的校验边界，远端编辑采用相同保留规则。

| A2 开发检查 | 实际结果与证据键 |
| --- | --- |
| TypeScript/Vite | 通过：`823568dfc680715180d2f6abac0ee339ba074252d7e3ee25d728540ef5f4df2d`。 |
| prompts 原生 | 19/19 通过，含四项原失败、远端旧标签、终态/未终态读取和 2000 条同输入有界提示：`1fefefd35df1ad3b6f172dbb0403c257a780877e7c9fc5f59c7724ae32f97d5c`。 |
| prompt UI | 7/7 通过，包含批内重复显示、编辑后产生新重复、取消/重选/跳过、替换不可用与只保存保留项：`3f965467a269584d96573424cfd945b91a5a6a09efe971fb54d3490d9e1da619`。 |
| Node 门禁 | 193/193 通过，含远端故障 fixture、主机身份及 i18n：`0c3c3ea35f88abc669cdab8730f5dfa8cae501fa48dcdcc08d86e2d0a8ad319b`。 |
| 相邻恢复合同 | 回执身份与 schema 跨主机恢复拒绝检查 1/1 通过：`e8ab91c09cd3ccd354a7b04c721b9a35be1126f04bc3f40f465bec15b504a698`。 |
| Clippy | `--all-targets -- -D warnings` 通过：`d7d92398a1273a15a90990f7aaebb922c28ef1da9b3721417fa568fd7b65fa71`。 |
| 更新截图 | 1360px 深浅两主题 14 图，failures 为空：`61f22baec5b60575cbdaf4c8b954b6af0a1c680b93208c0b02bff332d7d55d25`。 |

以上 A2 修后命令均退出 0，清理 released。Owner 实际查看更新后的深浅两张导入预览，已有库匹配与本批次重复提醒可区分；图集仍为 `docs/verification/project-prompts-ui/`。合成 IPC 图集只说明这些界面状态，开发检查不代替独立返修审查或正式累计交付验证。

新增远端读取回归使用隔离临时目录和真实 OS 文件锁。macOS 的 fixture 用 Python `fcntl.flock` 提供继承 FD9 的测试命令，验证活动锁互斥及释放后的回执屏障；这不等于 util-linux/GNU 写入脚本、真实 SSH 或 Linux 平台已验收。共享写入/恢复全套仍需要 GNU 工具，未用此 fixture 宣称该全套通过。

## T3 远端旧分类边界补修（A3）

A2 复审确认读取屏障、批内重复及本地旧标签问题已闭合，但发现旧远端 `save_library` 的分类上限为 400 个 UTF-8 字节，不能复用本地 80 字符边界。候选 `d6766066` 上先运行新增反例：81 ASCII 字符、恰好 400 ASCII 字节、恰好 400 多字节内容的三项保留编辑检查均失败；新建/导入/新增/扩张、本地恢复及超 400 字节拒绝检查通过。原失败证据 `41d39bfe85b5d6248d25c756c2ba7d861c353e9e3aa0ba51f32d2a0ad6d49e6f`，退出 101、清理 released。

补修仅为私有归一化策略增加明确的 Local/Remote 来源：本地及其恢复仍使用 80 字符旧表示，远端使用 400 字节旧表示；只有与原条目完全相同的标签可保留。回归连续验证修改正文后再归类，确保已保存的 metadata 也能保留旧标签。新建、导入及新增/扩张标签继续走原新写校验，401 ASCII 字节和 402 多字节旧表示不获兼容例外。本轮没有 UI 改动，不重复界面、Node 或截图验证；A2 已有证据与原生平台限制继续保留。

修后完整 prompts 原生组 23/23 通过，退出 0、清理 released，证据 `3c553eb48d1ac9b4a0a3f7933151fd7ae274864a4ea4fece68a86a30d37dcb19`。这包含三项原失败及本地、远端新输入的拒绝边界。Clippy `--all-targets -- -D warnings` 通过，退出 0、清理 released，证据 `3d3526d1e406f8cc83922b460921cfbc5ab1c8e2d94159d7a3818edc3210367f`。
