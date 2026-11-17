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

## T4：版本化迁移与 WebDAV 本地保留

开发日期：2026-11-17，Cliora 基线 `3c2415bf`。加密 bundle 使用 snapshot schema 5，继续读取 schema 1–4。新增 repository/workspace 逻辑载体与包含独立 scope/tags 的 Prompt 载体；提示词 key 保持 `library:id`。组织按旧目录、仓库、业务项目、提示词依赖顺序恢复；只导出组织时补齐仓库依赖，不隐式纳入旧目录配置、活动绑定或原生配置应用。位置以来源 host 下的提示保存，打开前仍须本机 Git 校验，原共享清单不会自动重新关联。原 ID、成员、收藏、旧目录映射及孤立范围保留；失效引用不变 global。usage、批次回执、会话与原主机远端提示词文件不进入新组织载体。

WebDAV manifest 随写入升级到 5，使旧客户端在处理新载体前拒绝不支持版本。global 提示词保留 metadata；业务组织和非 global 提示词显式本地保留，不发布替代 global 或伪删除。有效 scope 的识别不依赖 metadata 是否已初始化；新旧提示词写入/删除入口均在原事务记录本地保留屏障，覆盖“已同步 global → 旧 project_id 改范围 → 中间未 sync/ensure 就删除”。旧正文编辑（包括 category 为空）保留已持久 scope/tags，旧接口确实无法表达的范围改写才拒绝。状态和结果有独立本地保留列表，完整成功条件纳入 localOnly，既有冲突与原生待写回队列保持。

修前 3 个真实 DB/本地 WebDAV 反例全部失败：组织/metadata 未被 bundle 收集，旧范围无 metadata 时未排除，以及支持部分上传后错误报告完整成功（`4eee4039ae605c008637bdfd6a32fd1908033d25d6caaf023cefcf3a586e2ede`）。修后首批 5/5 通过，包含旧接口未 sync 就删除的两项边界。扩大直接回归后发现两个真实相邻问题：删除逆序仍写死 `8-rank`，新依赖 rank 触发下溢；旧 category 空值重算并清掉了独立 tags。分别改为严格逆依赖序和物理 metadata 权威后，原断言保持，完整直接组通过。

| T4 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| portable 全组 | 82/82；真实加密临时 bundle、schema1–4、组织/标签 roundtrip、重复接收、孤立范围、组织-only 不写原生配置/不消费已有队列，以及本地 HTTP WebDAV 冲突、删除、账户凭据和部分失败恢复 | `07209f869de1aef8dffd0504ce22085466480d902507ca6301a30d2c8a91cf77` |
| prompts 直接回归 | 23/23，保留 T3 本地/远端旧标签与旧正文编辑边界 | `43b36255ff0b9cf1442bfe299fcca360bc928ca902bd7f58a19c5e71aee21211` |
| library CRUD/CAS | 2/2，保留独立 scope/tags、旧接口范围拒绝和重启版本检查 | `ceeb1eb77ec0bbaa677618b69657ee7cdc9279c8abef8ff2c875fa1e4a9b1a9c` |
| Node | 193/193 | `4e44fd71fd2be6d2fed1fa8fdfbc2768f6c5a3e9381884f1932f566916295391` |
| TypeScript/Vite | 通过 | `120afb6c755daf618a5814eeb80adf11a6214de4590593e2baee0c81e1846adf` |
| 同步 UI 直接回归 | 20/20，含业务项目/仓库信息/目录配置库存区分、本地保留列表和结果不声称全部同步完成 | `9707ed7feb0bd0000fa834b0e78030a44ff3ce5df6359a95cef68d3d8ee0c65c` |
| Clippy | `--all-targets -- -D warnings` 通过 | `31d56fbd8adee50f5c5e3e290a0eb6ac9b3756e43ee6012404ab8aa8523e5298` |
| 最终深浅截图 | 1360px、12 图，success=true、failures=[]；可见两个 dialog 及 backdrop opacity 均为 1，真实主题正确 | `ec3b3a5984e3bb8bb2cfa4243b3d7af24172ae8d8638de9147c45bbe87b8108c` |

截图来自现有 `scripts/capture-sync.mjs --theme all --size 1360 --only unconnected,local-only`，预览为本次独立启动的 `http://127.0.0.1:14739`，父进程最终清理 released。图集位于忽略目录 `docs/verification/multi-repository-project-workspaces-sync/`，机器清单为 `capture-sync-manifest.json`。首次结果图截在有限 opacity 动画中，已只修捕获就绪等待并重采；没有修改产品透明度。已实际查看最终 `zh-light-1360-local-only-result.png`、`zh-dark-1360-local-only-result.png`、`zh-light-1360-export-dialog.png`，结果 warning/部分同步语义和三种组织层级标签可读，无背景文字透出。

以上为开发验证。HTTP WebDAV 使用隔离本地协议服务器；截图使用 Playwright 合成 IPC，不证明真实 WebDAV 服务、已安装桌面端、系统 credential 后端或双端 scheme 往返。没有因此重跑或宣称通过无关的完整产品检查；累计正式验证与 T5 联动仍交后续阶段。

## T4-A2：跨平台位置提示校验返修

固定候选 `08a6f8ff` 的组织位置校验使用接收 OS 的 `portable::looks_absolute`，与 T1 原始位置提示合同不一致。新增 3 项反例在修前全部失败（`8a7672bc39eb8113f875d49bf3ab855f9043ba28605b48decf387373efa1b309`）：共享 fixtures 中合法 UNC/extended 被拒绝，不完整 `//`、`//server`、`//server/` 被误收；真实 T1 清单关联后的 bundle 导出，以及独立加密 schema5 包的接收均报资料无效。

最小修复只把 T1 `absolute_location_path` 提升为 `pub(crate)` 并供 organization 复用，保留原有长度、控制字符、host 和重复位置限制。没有修改旧 portable 路径编码。该验证器只判定跨平台 hint 语法，不能替代本机 host、`Path::is_absolute`、canonicalization 和 Git 执行验证。

修后 3 项覆盖共享表的 10 个 valid / 15 个 invalid 路径，以及 home token/控制符拒绝；真实加密导入、导出和再次导出保留原始路径及来源 host，不将 sender home 改写为 receiver home。所有外机位置仍不可启动、无自动目录/配置绑定，接收端原生配置哨兵字节未变。

| A2 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| portable 直接组 | 85/85，包含 3 项原失败 | `46ac58f3d087a2c76c40ed1015a1fa270e5ab9d25a6f48f6914f01824596a488` |
| workspaces 直接组 | 20/20，共用原验证器消费者保持通过 | `ff0d22309bf56c1621528b3012acba0411d00a98f459f0fd96f8fb1cd8143ece` |
| Clippy all-targets -D warnings | 通过 | `565a25eaf1cc461c0810e275442082afab069dc28032e6cb16cbe30ab07614bc` |

以上命令均退出 0、清理 released。本轮没有 UI 变更，保留 A1 Node/UI/深浅捕获证据而未重复运行。跨平台字符串和 bundle 测试在本机执行，不声称验证了 Windows/Linux 实机执行或外机目录访问；正式累计验证仍由 Delivery 负责。


## T5-A1：双端来源审查集成（开发记录）

当前结论：T5-A2 返修与开发直接回归已完成；最终双主题 12 图通过，macOS 27.0 arm64 的真实 Native IPC / 系统 scheme 双向闭环、拣选 committed 返回及下一基线推进已观察并完成恢复清理。原生证据使用隔离测试包、临时 pass-through 驱动与 fixture CLI，按文末边界解释，不替代正式累计验证或完整平台矩阵。

开发基线：Cliora `f46d0007b26af6cf1a61366ecc3349eadb27e4e9`、Twiglane `3e956c7da8fa9636492ba8869dc86ce17d5a0a20`。T1–T4 的已成立证据保留。本轮覆盖 v3 合同、按来源版本兼容 v2、多来源保留与选择、返回结果顺序，以及两项目范围提示词到原会话返回的直接消费者；没有跨仓自动 Git 写入或 Agent 编排。

双端 `docs/integrations/twiglane-review-v3.md` 和 `tests/fixtures/reviews/protocol-v3.json` 逐字相同；夹具 26 条 request、30 条 event，包含独立来源、项目 UUID/显示名、严格 v2/v3 字段交叉、大小/路径/meta/返回序号边界。夹具 SHA-256：`59749b1e3e1958225af8278344dbb063844942744c3c09eb53c7730bfd6c340f`。URL 不含名单或提示词正文。v3 returned 新增原生分配的 resultRevision，Cliora 拒绝重复/逆序结果和 returned 后迟到的接收回执；v2 不偷加字段、不自动降级。

Twiglane 来源与结果以 reviewId 隔离，A → B → A 保留基线；同一 checkout 可显式选择来源，Git 操作在开始时捕获 reviewId，迟到成功不能记入新选择。八条容量包含 pending，满时明确报错；关闭来源才释放，重启后无法恢复的来源明确失效。审阅标记沿 T2 checkoutKey 语义，POSIX 大小写与字面反斜杠不合并。Twiglane 新增 forget IPC 的 AppManifest 与 capability 源接线，权限文件按仓库惯例由 tauri-build 生成；没有手改或强制收录生成物。

Cliora 发起读取会话原登记项目/仓库身份，保留原 cwd 和远端拒绝边界。每次 v3 结果按 reviewId + resultRevision 重新读取真实 HEAD/dirty，checkout 不符为未确认。下一审查基线只消费原生复核过的提交；项目不会因一个仓库的提交而被标记完成。

已完成的开发检查：

| 检查 | 结果 | 受控回执键 |
| --- | --- | --- |
| Twiglane Svelte/TS check（第二批） | 0 errors、0 warnings | `17832bef94b69ad614412900ffb696e497b665104de6577e9e5759a888137668` |
| Twiglane integration/sources/api/review-progress 直接组 | 59/59 | `15acfe8c33565766afa202434847a50e7b588abb3ac7ededc326cea84082a0ef` |
| Cliora TypeScript + Vite build | 通过 | `e45da54fdcb37d09a6b04d23e1fcba26544892de1f655c8b7ae57330c3b41dae` |
| Cliora review-projects + workbench-twiglane Playwright | 21/21 | `6e73f4e8c5bcdb7cad1399bc23641c9167e1d1646d20962bdb4785b548a8626f` |

新增异步归属反例最初失败于测试在 Tauri 动态 import 完成前调用未安装的 resolver（`1b2837761df7cae7d4e42e695091152d05c5c6239ece0ae09b6162dabeb8d172`）。修正为等待精确 native 写入进入，再切来源和完成旧写入；同时保留新来源成功与旧来源不被改写的正反断言，上表 59/59 是修后实际结果。Rust 第二批发现本 macOS 文件卷不支持同目录仅大小写不同的两个目录（AlreadyExists），以及旧 v2 测试仍把现已合法的 v3 当未知版本；分别调整 fixture 布局和未知版本为 4，保留 POSIX 纯语义与真实字面反斜杠目录覆盖，不声称本卷是大小写敏感文件系统。

浏览器与系统 scheme 的最终实际结果将在后续本 Task 检查完成后补充；上述 Playwright/合成 IPC 不是原生平台验收，正式累计验证由 Delivery 执行。


### T5 最终冻结候选开发检查

最终开发波已通过，命令全部由 Owner 受控前台执行并 cleanup released；生产源码、测试与捕获驱动在这些检查后冻结。这里记录的是本 Task 开发验证，不能替代 Delivery 的累计正式验证。

| 检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| Cliora `twiglane::tests --lib` | 29/29；含 512 次并发 revision、立即回执与 publish 失败回滚 | `9e02c3948bc31d71af86e193f6931db382648a43740531a2fd76d0be1c885637` |
| Cliora `session_baseline::tests --lib` | 5/5 | `a78b6fc4da0f5bce1ed28b53aec5b63c4cd48a52cb986ed44fe6cdd935581c4a` |
| Twiglane `cliora --lib` | 28/28；协议、容量、失效、原生独立结果与恢复 | `30cae364dd388bcd32ccb53b9a5266479b3d2e39bfcf48f03945e533257ba034` |
| Twiglane `review_ --lib` | 24/24；明确包含失效 `.git` 不回退父仓、主检出/linked worktree 状态独立读取 | `b244e6be715029387b1eed30fa3bd750a608d4f75da6abb523fb1a27bfcf1679` |
| Cliora Clippy all-targets / `-D warnings` | 通过 | `eeed28c790a0792be6791b067b27c4cefcad8a5d3da3d52b9c5e0929c72988c4` |
| Twiglane Clippy all-targets / `-D warnings` | 通过 | `1882aaf51954b88d740dde4e8318d50f4e3421189b880eba5e571cc233ed4b34` |
| Twiglane Svelte/TS check | 0 errors、0 warnings | `9d9e8545a15495b5f890c44bcb1962b2737a58602dd6023a5a180e8355d89caa` |
| Twiglane integration/sources/api/review-progress | 65/65 | `96302beb15356c7a012464da0f685d906f09ba96515cd12d2c0c3ecef89587e9` |
| Twiglane production build | 通过 | `d1a2e9c7ccbd14dfa74efc06edbea4e7850e8029eb813664d6d5a34668bd0113` |
| Cliora Node unit | 193/193 | `935951526d55fef94d0d8f0c59294dba7632d19104ad8c64aea00101bb3b912f` |

Cliora 本 Task 前一批 TypeScript/Vite build 与 21/21 审查 UI 直接组保持有效（上表前节回执）；此后 Cliora 变化仅为原生登记/元数据与对应 Rust 回归。Twiglane 新恢复波曾出现 commit-and-push 的 `oid` 为 String 却按 Option 读取的编译错误，以及来源列表 mock 非 Promise 覆盖后端 clean/dirty/unknown 提示的测试问题；均已修正，上表 native、65 项前端及 Clippy 是修后实际通过结果，不把未执行的组冒称通过。

来源恢复以原生当前进程的八条有界记录为准，保存完整身份、baseline、协议、独立成功 Git 结果与最近返回声明。首次 bootstrap 串行过期旧 pending 后才 prepare 新链接；mutation epoch 拒绝关闭或新结果之后迟到的快照。失效的非活动来源无需打开即可在管理入口明确关闭。传输错误不把已接受来源伪造为 rejected；`lastReturn` 是返回声明，不能单独证明系统投递、Cliora 确认或 Git 复核成功。

Cliora 在公开系统 URL 前原子预登记；可控立即 accepted/returned、失败回滚、并发较新事实和连续失败链均有回归。项目名称只读 `workspace_projects.name`，保持 session 原归属及 80 字符限制，不为审查来源显示探测其它成员仓库。


### 双端浏览器捕获的首轮反例

首轮 `capture-review-roundtrip.mjs` 退出 1，没有成功 manifest；回执 `1738ecd74a2a924b293fcc983a9b4312b25acd1c16a51ffb0cdd0434af57a382`。五张浅色图和逐图 SHA 原样保存在 Cliora `docs/verification/ui-review-roundtrip-failure-1738ecd7/failure.json`，不作为完成证据。

实际查看 `light-twiglane-source-manager.png`：原生 select 的 DOM value 已是 A，实际来源说明仍为支付系统、仓库路径仍是 `/work/payments/api`，并显示正在读取仓库。驱动把 selectOption 的同步 DOM 变化当成异步仓库切换完成，存在在仍活动的 B 上提前返回的竞态；该图片证据只定位了就绪判断缺口，不能单独证明完整返回失败根因。捕获驱动现等待实际 `.cliora-chip` reviewId 和当前仓库路径均属于 A，再截取就绪任务队列并点击返回；返回投递前严格检查 v3、A 的 reviewId/sessionId 与 resultRevision=1。保留 Cliora 自动选择原会话及草稿不变断言，没有手动点选 A 或延长超时。产品源未修改，已通过的核心回归不为此重复执行。


第二轮回执 `191174ab04d29a193a65a61fa8aa902d53bbac36678a443af0f6270606890f35` 仍退出 1：新增诊断明确证明返回 URL 属于 A 的 reviewId/sessionId、v3、resultRevision=1，但 Cliora A 仍未自动选中。因此没有把 select 就绪修正冒称完整根因或成功。当前进一步以独立 light 诊断检查 DEV/React.StrictMode 下合成事件桥的注册/解除、实际入站 kind/reason 和活动会话；产品代码保持冻结。


独立 light 诊断回执 `eee8a9b12cfc8f47e8aa165b555b45e5bc6705487c974ff2a812b209de1aeae1` 明确定位完整返回失败：DEV/React.StrictMode 注册 deep-link handlers 13、14，14 已 unlisten，但合成桥仍只向最后的 14 发出三个 accepted/returned；实际 `twiglane_review_link` incoming 为空，两条来源仍 opening/revision 0、活动会话仍 B。没有 native registry 拒绝 A 的事实。这修正了前述局部就绪归因：完整问题是合成桥把已清理 effect 当活动订阅，而非产品协议或会话返回失败。

修复只改变 capture fixture 的事件模型：独立 listenerId、每事件多个订阅、按 eventId 真正解除监听，emit 仅给仍活动订阅；保留诊断及 A 自动返回/草稿/独立结果断言。另将 prepared `lastReturn` 的 UI 文案改为“已保留上次返回尝试，接收结果以 Cliora 为准”，避免把缓存声明说成已经送达；对应一条文字断言同步，协议和状态逻辑不变。


### 双端浏览器最终捕获

最终重采回执 `552d51750f43523d040fe4d760e763a35e4119f494b3380aa48bbe128abdacda` 退出 0、cleanup released。Cliora `docs/verification/ui-review-roundtrip/manifest.json` 与 `index.html` 记录浅色/深色 1360×900 共 12 图：仓库范围提示词全文预览、Twiglane A/B 来源、切回 A、显式来源管理及自动返回 Cliora 原会话。输入为两业务项目、49 个仓库成员、124 条提示词和两个来源；全部图水平溢出 0、页面错误为空。两主题均验证 A 的 reviewId/sessionId/v3/revision=1 返回，A 自动选中、B 保持 accepted、A 原草稿追加提示词后不变且没有发送操作。

实际查看最终 `dark-twiglane-source-manager.png`、`light-twiglane-switchback-a.png`、`light-cliora-returned-original-session.png`、`dark-cliora-repository-prompt.png`：来源/项目未关联标识、真实目标路径、任务基线、独立来源列表和原会话草稿清楚可读，深浅主题正确，无观察到的布局溢出。捕获使用两个真实前端和合成 IPC/链接投递，manifest 明确 `realGit=false`、`systemScheme=false`、`nativePlatform=unverified`，不能替代真实桌面联动。

“返回尝试”文案定向回执 `65d3333f62296f7366188d4626c813d18a13dfe245aa656b78e2eedc677b4dfb` 通过 1 项，其余 22 项未选；没有把定向检查写成全组通过。完整核心 65 项的既有回执与本次纯文字补验分别保留。成功捕获与三次失败/诊断回执分开记录，没有用手动选回 A、延时或更长超时掩盖失败。


### macOS 原生尝试：首轮构建前置结果

Owner 的首次独立候选构建在启动应用前被 Tauri 的版本一致性检查阻止：本机安装目录中的 updater 为 2.14.1，Rust 对应为 2.13.1；Owner 核对现有 package-lock 锁定 2.13.1，定位为 node_modules 环境漂移。受控回执 `00a11209018925b60c2e4dbc3cc089b11df20641e24e93b37e6bf48cd637697f` 的外层 child 退出 0，但业务报告为 attempt-incomplete，不能记为原生通过。该轮没有启动任何候选应用、没有修改系统 handler。

Owner 按现有锁执行 npm ci 修复环境，不改 manifest/lock，也不跳过版本一致性检查；随后重新构建私有 frontend 与隔离候选，并在锁定环境下进行后续正式累计验证。当前原生结论仍待实际 bundle/IPC/scheme 尝试补录。


锁定环境修复回执 `32ef6a3ce34b150638eb09af55b4be00d1da1dc1c755ba8e77e657af83c5ceea`：Cliora `npm ci --prefer-offline --no-audit --no-fund` 成功、cleanup released；其 Node/Rust 锁均为 updater 2.13.1，漂移的仅原 node_modules 2.14.1。Twiglane 的 Node/Rust 锁和实际安装均为 2.14.1，无需重装。两仓 manifest/lock 与产品源码没有因此改动。Owner 为候选环境一致再次执行同 12 图捕获并重建隔离 Native 候选；前一成功捕获保留为已发生观察，最终引用以锁定环境回执为准。


锁定依赖后的最终双主题捕获回执为 `fc8a611e71298078d0bbcf2889ed412c577c7a6591d256f14931ef91c3e57f43`，退出 0、cleanup released，同样为 12 图、0 页面错误/水平溢出及 A 自动返回、B 独立、草稿保留且不发送。当前 gallery/manifest 对应该锁定环境；Owner 再次实际查看浅色原会话返回与深色来源管理代表图。先前 `552d...` 成功观察保留，但以本轮作为最终浏览器候选证据。

macOS 原生 attempt 2 回执 `611b15c04e05288b62e9f04b392d0a4b70de15fcf598aca6d664ec340327c81d`：两份私有隔离 app 已实际打包（Cliora 约 164 MiB、Twiglane 约 71 MiB），宿主为 macOS 27.0 arm64。临时 probe 确认 native bridge ready，但尚未观测到两端生产根 DOM mount，因此没有 source launch、没有默认 handler 切换，也没有系统 scheme 往返成功结论。业务报告仍为 incomplete；`handlerRestored=true` 在该轮仅表示原 handler 状态未改变，所属进程已清理并 released。

Owner 保留 attempt 2 报告/日志，只在私有测试 frontend 的临时 probe 增强 error/rejection/CSP/resource 诊断并重建同源候选。当前不能把未 mount 归因于产品或平台限制；生产源与测试保持冻结，等待具体错误和实际尝试结果。


后续原生诊断已纠正“未 mount”判断：attempt 3 观察到 `#root` / `#app` 均已有实际生产 DOM，临时 probe 等待两个 requestAnimationFrame 在后台未完成才造成前轮假失败，没有证据表明产品启动故障。attempt 4 的中止点是观察脚本请求 Twiglane 未开放的 `core:path:resolve_directory`，没有为此扩产品权限；私有测试包只改用最小 `core:app:allow-identifier` 观察隔离身份，实际 Cliora AppDataDir 与 Twiglane runtime identifier 的私有隔离均已证实。

attempt 5 未能把系统默认 handler 选成候选，仍未 source launch，原 handler 已恢复。另有独立只读宿主事实 `CGSSessionScreenIsLocked=1`；这是锁屏状态与路由失败的并存观察，尚不能单凭它推定 LSSet 失败原因。Owner 继续记录 LSSet 状态码、候选注册 URL、新鲜进程读回与恢复结果，不解锁桌面或代替用户同意；在默认路由未确认时不发起会自动回执的业务来源，避免测试流量落到已安装用户应用。


Native attempt 7（受控 `3fbed857a4092960a4f5fd3b29ad996a5ae3ff1754cba4a4e1b1b3f4def78f03`）有实质进展：仅把同源候选临时复制到 `~/Applications/Sakullla Review Probe 8c6f1439/` 后，两个候选 ID 均成功注册，LSSet 状态为 0，独立读回选中了该目录内的私有 app；先前 `/tmp` 目标 URL 为 none 的范围因此缩小为安装/注册条件，不再将“默认路由不可用”视为已确定环境终点。

| 本轮实际候选 | runtime identifier | 报告 sha256 字段 |
| --- | --- | --- |
| Cliora Native Review Probe.app / 0.4.142 | `com.cliora.reviewprobe.8c6f1439` | `a480cf5eb6c30beb734d635a9a8b5d560ae53207b8d5b3b1ead71a496cc467cd` |
| Twiglane Native Review Probe.app / 0.3.23 | `app.twiglane.reviewprobe.8c6f1439` | `dec861e96b3caf9954a6214ac601e553c588d8a83e4cd387d3bccbc446d3e61d` |

真实 IPC 的自定义 CLI 路径、首选 Workbench、创建业务项目、关联临时真实 Git 仓库均成功；随后等待 `launch_workspace_cli` 40 秒超时，尚未 `start_review`，业务报告仍为 incomplete。两 handler 均恢复为 `com.cliora.desktop` / `app.twiglane.desktop`，专属临时安装目录已删除，所属进程 cleanup released。

Worker 只读核对该专属 DB：schema 33、业务项目/仓库/位置各 1，但旧目录 projects、workspace_sessions、会话 checkpoint、账号、配置绑定、Skills 操作均为空。真实调用链应先 `prepare_launch` 创建并提交旧目录上下文，再进入 CLI 版本探测与真实 PTY；故不能把该超时直接归因于 fixture cat、PTY 或锁屏。fixture 的版本输出与其余参数下常驻 cat 符合 Workbench 不等待子进程退出的约束，baseline capture 也是异步。Owner 正补临时观察脚本的 action/invoke 入口记录、owned 进程采样和安全 argv 诊断，以区分是否真正进入 Native launch；生产源继续冻结。


### 最终 macOS 真实 IPC / 系统 scheme 观测

最终受控回执 `681fe746cdd6d9234127040d17c6252f7e123789128c70f63e3b7b9c96212b8a` 退出 0、cleanup released。统一证据入口为 Cliora `docs/sakullla-workflow/2026-11-16-multi-repository-project-workspaces/evidence/native-review-runtime/index.json`；其中含原始 `report.json`、`action-results.jsonl` / `native-ipc.jsonl`、两仓 source inputs、测试 overlays、probe/driver、fixture CLI/argv 记录与构建日志，并记录逐文件 SHA。`postflight.json` 是恢复后的新进程读回。

同一冻结产品源码下，临时 probe 使用服务端长轮询，去掉对后台 JS setTimeout 的调度依赖。`action-native-enter` 与实际结果证明 `launch_workspace_cli` 约 0.16 秒建立真实 PTY 会话；之后为：Cliora `start_review` → OS 默认 Twiglane 候选 → 真实产品接收处理 → Cliora accepted；Twiglane 原生 `cliora_review_return` → OS 默认 Cliora 候选 → 原生 returned / resultRevision=1。动作记录没有直接调用 receipt/link 回填。此前第 7 轮缺入口证据的 40 秒超时在不改产品后没有复现，不将它表述为产品 PTY 或锁屏故障。

该次 reviewId 为 `924eeff4-4877-449b-976d-47c36fc59407`；业务项目 `45027af9-af87-4ac1-80a4-e83b992a7afb`、仓库 `566b74a1-875b-49c6-9572-e71f0c3b31bb`、会话 `92719b21-d4bf-42ac-852d-b675aedc8616` 在 accepted / returned 中精确一致。真实 `workbench_code_status` 为 ready，main 的 HEAD 与 baseline 同为 `6b76c0700d987a5c373797e719f012c2d8cda6f9`、未提交数 0；本例为 reviewed + clean，没有 Git 写入或项目完成结论。

| 最终候选 | 标识 / 版本 | 实际执行二进制 SHA-256 |
| --- | --- | --- |
| Cliora Native Review Probe.app | `com.cliora.reviewprobe.8c6f1439` / 0.4.142 | `ce09272b95fe0424378e38a38a31bb91d460ff5ee048d484246d07ef107a6693` |
| Twiglane Native Review Probe.app | `app.twiglane.reviewprobe.8c6f1439` / 0.3.23 | `2f3a60276aaf76090f91fdd92e401643725a9010304932c52958ccbc43b317dc` |

实际短暂安装/运行位置为 `~/Applications/Sakullla Review Probe 8c6f1439/`。清理后该安装目录不存在、两私有 identifier 的进程数均为 0，默认标识与实际物理目标分别恢复为 `com.cliora.desktop` → `/Applications/Cliora.app`、`app.twiglane.desktop` → `/Applications/Twiglane.app`。原缓存中的保留 `.app` 路径见 index 的 retainedBundle；其二进制字节 SHA 与实际短暂安装执行一致，不把已删除运行路径当作仍安装。没有为测试新建账号、连接或 Key，也没有对用户 DB 迁移；目录和 Git 输入仅为 owned fixture。

边界：宿主 macOS 27.0 arm64、观测时仍锁屏；候选是正常生产源码的隔离 identifier、ad-hoc bundles，使用临时前端 pass-through 真实 IPC / loopback 观察及最小身份元数据测试 capability。PTY 子进程是输出兼容版本并常驻 cat 的受控 fixture，不能声称真实 Codex 登录、推理或 CLI 全能力验收。键鼠、焦点、IME、签名/公证发布包完整场景矩阵和 Windows/Linux 原生行为未验证。前述真实 Git 单测、56 条协议 fixtures、65 项前端直接回归及双主题 12 图分别支撑各自层级，不拿任何一层替代另一层。正式累计验证与最终交付审查仍由 Delivery 执行。


## T5-A2：独立审查返修

基线 Cliora `f1af43b333505e7901e278526820c88ef6a42a09`、Twiglane `4de55c10c6757042b6fddf6e6dd3b5dca0a1eef9`。Cliora 固定范围审查通过的判断保留；前述 Native 8 与 12 图属于 A1 候选，不能自动转作 A2 的新源码证据。A2 只处理两项 P2 与直接安全测试合同。

修前受控结果：前端 4 项中 3 个产品反例失败、1 个负例通过（47 未选），回执 `67b77f0d1793b0ee27ce200d46af5bf7c331de7983102130cf0bb7ff52dea763`。真实 Git/IPC 六项中，拣选成功/部分冲突的源缓存为空及继续拣选误作 merged 为三项真实失败；纯冲突、纯失败两负例通过，回执 `921b460a2e86838b1790626fcb638922148beae4524e4e42092cad1cb6e3a3c2`。all-skip 初始 fixture 误用了无 parent 的 root commit，服务本来就应拒绝；仅改为普通已有 ancestor 提交后，未改生产代码单项通过 `256824b4a19197327dbbf1e9a5ed6d0e89072c0b61cdde151bf9409b29549bed`，不将它记作产品根因。原 security 精确 allowlist 失败回执 `7cf329bd70be811a5d8648a0be7ee4c50e0cc953356399583c09331ed05e5d0f`。

accepted 返修以既有 repository epoch、canonical 路径和来源 mutation epoch 判断上下文是否仍有效；过期完成只保留 A 来源，不激活、不改 B 的任务起点，也不使用长时间全局锁。Git 结果补齐实际 cherry-pick producer：created/headOid 由受控 write guard 内核实，支持已创建提交后冲突；全跳过、纯冲突/失败不制造或清空结果。complete_merge 返回 guard 实际完成的 operation，拣选/还原归 committed，merge/rebase 归 merged，不信任切仓后的前端 operation。Rust/TS DTO、preview fixtures 和双端合同同步；checkout/reset/分支切换不自动推断提交。security 仅同步 forget/sources 两项最小授权期望，保留禁止通用 shell/fs/http 的全部守卫。

修后直接验证结果见下表；正式累计验证仍交 Delivery。Native 与捕获针对冻结的 A2 重新取证，A1 原始材料保留。


A2 修后直接组均由 Owner 受控执行，退出 0、cleanup released；生产源、测试和 preview fixture 在这轮后冻结：

| 开发验证 | 实际结果 | 受控回执 |
| --- | --- | --- |
| Svelte/TS check | 0 errors、0 warnings | `63de400e942fe0eb04987873ba0ca505a8dce5b92adf8c9a22acfb9c9b071ed7` |
| integration / api / sources / review-progress | 70/70，含迟到 accepted 和拣选/继续原反例 | `a734a03878e20eebcd8ce1fd4470515378c4f1fca96bb45c84b160ab942e39c8` |
| ipc_contract | 16/16，含 8 项真实 Git 拣选：成功、全跳过、纯冲突、失败、部分冲突、继续完成及旧结果保留 | `8efcc00076cff8b98b316cb2b1fa7e8c2748a87f69b963c68d28afd304c69bb0` |
| security | 3/3，精确授权与禁止通用能力守卫均保留 | `d5841d9e60ea284ea1a8a607d3787c98e8d865a5f85b44ca65effe2ef90139a8` |
| git::resolve 直接服务组 | 48/48，覆盖拣选、还原、合并/变基及继续入口 | `10c95789d45d4816bfd5f3ada496b973ace0b39a23ba56e1713bfd508eed6893` |
| Clippy all-targets / -D warnings | 通过 | `330be09d1fbb9bff119219a4ba30a4e2fdd990521d15b8fcfabfa5f9b41f1b68` |
| production build | 通过 | `3f7b0925b8b2523dd178c5e4c7ed6ff41b467cd3e20d788bb3aa74c95c2c2151` |

producer 核对包括普通提交、提交推送、拣选、还原、修订、start_merge 的 ff/rebase 完成，以及 complete_merge 下实际 merge/rebase/cherry-pick/revert；继续拣选的 committed 分类来自原生 guard 回传的 operation。checkout/reset/分支切换和 stash 等不因 HEAD 或 Git 对象变化被推断成源提交。既有 IPC mock AppState 补齐真实 app 已有的 ReviewSources 管理，未弱化请求参数或安全断言。Cliora 产品源码未变，复用其有效固定范围审查；双端合同逐字同步，56 条 URI fixtures 的字段/字节不变。


A2 最终同源捕获回执 `5ee8141b5aa98638740c39d3faf934c99879d864ec6550504ce4d41e2cb117d2`：12 图、页面错误 0、水平溢出 0，A 自动返回、草稿保留未发送、B 仍 accepted。
A2 原生回执 `fdc89a1de898dc928edeaa0cd58adee875af8561eccd471b2c9b69a5b487c322`：真实 owned Git 拣选 created=1、HEAD=`73e08f7c82b537f66d678ac7135c0284e29217d2`，committed/clean、revision=1 返回原会话；Cliora 实际复核后下一审查 baseline 等于该 HEAD。
统一证据为 Cliora workflow 的 `evidence/native-review-runtime-a2/index.json` / `report.json`；候选路径、SHA、源码输入和外置驱动均在索引，A1 原始证据/二进制另行保留。`postflight-a2.json` 确认原 `/Applications` handlers 已恢复、owned 安装目录不存在、owned 进程为空；两次命令均退出 0、cleanup released。
边界仍为隔离 ad-hoc bundles、fixture CLI 和外置 pass-through IPC 驱动，不代表真实 Codex 登录/推理、键鼠/焦点/IME、Windows/Linux 或完整原生矩阵验收；正式累计验证交 Delivery。

## T3-A4：正式回归暴露的旧消费者合同返修

正式 run `55fe0aa143abd76e72786ae482e65241` 中的本轮派发问题分为三类，未把 Kiro、mac 默认终端、线程资源、Skill 拖选或标题截断混为同一原因。迁移夹具从最新数据库降低 `user_version` 却留下 schema32/33 的 workspace/prompt 表，导致严格 CREATE 正确报 table exists；现仅以 `cfg(test)` helper 按 FK 子先父移除目标版本之后的组织表，保留原降列、旧数据、CAS、恢复断言及真实 v1 迁移，最终版本期望同步为 33。没有将生产迁移改为 IF NOT EXISTS。

远程事务在本机缺少 GNU flock、默认 stat 为 BSD 时于 protect 前置检查退出 70，因此出现未建 journal 的 preparing/unknown；大脚本还使测试 stdin 写入遇到 BrokenPipe。mac 隔离 POSIX 夹具现使用真实 `fcntl.flock` 互斥/超时失败及 `lstat` uid/nlink/mode 适配，两个关键验证覆盖锁继承、竞争拒绝、无效 FD、硬链接、权限与缺失文件。故障 wrapper 委托本机真实 mv/sha256sum 路径，保留原故障条件；早退时保留 child 原 exit/stderr，未完整发送却 exit0 则显式失败。生产 HELPERS、CAS、持久恢复屏障及脚本故障安全条件未降级，`scripts/remote-transaction-fixtures.mjs` 无需改动。

首轮事务 8/9（`d17567a2f0d4224bacfa0e44b6231badc3b54e1ea4fe290c72cd87e1c8062463`）剩余用例经诊断确认 success/committed、两项已提交，但 shell 后置检查 exit92（`5e7a9b20d95941a3a2fa7ddadb5c5353ea3f23736d257933a561c73ef0da36d4`）。BSD `wc -l` 对零行输出 `       0`，旧字符串比较误失败；仅改为数值 `-eq 0`，仍严格要求无临时文件，原版本/备份/权限/回滚断言保留。

| A4 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| 迁移与直接夹具批次 | 15 组、16 测试通过；含 11 个原迁移失败、两项真实工具语义验证、早退保护、资源缺失/空文件及大技能清单 | `3d9e380d8e66bf2172ea93790c4adbe4a6680f528a8f9f3b3bb9ea5e5cba1e6c` |
| remote-hosts UI | 31/31；mock 返回正确空 PromptPage，仍先执行原 hold/failure 注入，保留保存失败的原 alert 断言 | `c2e1485936253514d904c182d3d52010ce27fffa7953ed170866d788233405c0` |
| 原故障用例、完整事务组与 Clippy | exact 1/1、transactions 9/9、`--all-targets -- -D warnings` 均通过 | `77be42c7efd34581a4d3022c1a1c8204ff73409f12ba492dd2e36b3f150d422a` |

以上命令均退出 0、清理 released。修改只在测试/夹具消费者及测试专用适配边界；不是 GNU/util-linux 生产环境、实际 SSH 服务或其它平台的验收。原正式失败保留，T5/Delivery 的其它已知问题和正式累计全量尚未据此宣称完成。


## T5-A3：最终集成修复与开发验证

生产最小修复为 Twiglane 三个审查控件复用实际读/写禁用原因，以及 Cliora 仅在 pathName 内让目录 head 可归零、tail 不收缩；列表布局保持原值。测试只补 Skill 字体就绪/有界连续稳定行矩形、Kiro canonical project、mac 显式 MacTerminal 和完整空 PromptPage，原选择、大小写、整文件保存及系统脚本断言保留，未改编辑器、Kiro 路径策略或产品默认终端。

Twiglane 直接 28/28（`8f4528af2b47c727663bc696ea6613168f5809efdbfb1858591c8134c52c919d`）；Cliora 原三 UI specs 39 项与 Skill 8-worker 重复 8 项通过，两个原 native fixture 及 Clippy 通过（`a7bc41146d77020f5bfee371a80d0c9b9f0d51d88ce689ea5042b4a1d137a6be`）。整数宽度曾掩盖 0.046875px 尾段收缩，首次实际残缺图保留为 intermediate-visual-failure；最终 build/标题 5/5（`ebc68d9a8f7f028e3a896b551d44b7f11c2279bdaf15501b452626a51dd0ceef`）加 Text Range 小数检查，1200×800 Desktop Chrome Windows UA 实际图完整显示 mes-fetch，文本/元素宽同为 57.984375、right 同为 648（`b70e715e42fe3180f68a51aacb6642a8e12e25b5a28b818238aadb2a544875f5`；Cliora workflow `evidence/T5-A3-titlebar-final/index.json`），已实际查看最终 crop。

最终双主题 12 图回执 `7cc53799852217d81118fb3a311c839fd45a759c0a826f51b05031388e61e98c`：页面错误/水平溢出均 0，A 返回原会话、草稿保留未发送、B 仍 accepted。新的原生回执 `7ae649ef9f8fa925b7c124445880bc1fb109d8442911cdddd21c7ec554557f4b` 观察真实 owned cherry-pick created=1、HEAD `b4b907578aa5d5601b5c72aaef8797844f962bd5`，原来源 committed/clean/revision1 经 Cliora 真 Git 复核；下一 baseline 等于该 HEAD，第二次 accepted 后才清理。统一入口为 Cliora workflow `evidence/native-review-runtime-a3/index.json`，保留 A3 源码输入与不可变候选包；`postflight-a3.json` 确认原标识/物理路径恢复至两 `/Applications` app、owned 安装不存在、进程为空。以上命令退出 0、cleanup released，旧 A1/A2 仅作历史证据。

原生范围仍是隔离 ad-hoc 包、fixture CLI 与外置 pass-through IPC 驱动，未代表真实 Codex 认证/推理、键鼠焦点/IME、Windows/Linux 或完整平台矩阵。首次全量线程 WouldBlock 来源尚未证明，隔离通过不替代正式全覆盖；最终累计验证与审查交 Delivery。

## T3-A5：终端消费者的宿主手势与输出就绪

正式第二轮的四项终端失败保留。滚轮用例只等待 `remaining=0`，也会匹配输出尚未解析的空 buffer，实际取到 `start=0`；现先等最后一行 `line-199` 和正滚动范围，再取基线，保留上下滚轮方向断言并检查不发送 CLI 输入。三个链接失败经只观察事件的诊断（`25522c1d188a25a800967a900b41e5c105fe61debfc4c28ae56a5536dbc570d5`）确认：macOS Chromium 在 Win32 navigator 模拟下仍于真实 Control 左击生成 trusted、button0/buttons1、ctrl=true/meta=false 的 contextmenu，遮住后续悬浮。测试仅在 macOS 宿主、Win32 模拟和终端内过滤此精确手势；真实 down/up、链接激活、普通/中键、完整 URL/path、来源 cwd、缺失错误和提示清理断言保留，产品逻辑未改。

右键用例先完整执行原真实右键→全选→复制/中断的全部断言，再追加 Control+button2 菜单及同形状但 untrusted 的应用 MouseEvent 守卫；后者再以无 force 的全选点击证明可操作。新增守卫曾因 `locator.dispatchEvent('contextmenu')` 使用通用 Event 而两次失败（`d9f18322160c13413edf71fcefef704d08397a20c17451f7f1751bd3bc2c436b`、`2f0a45439e164ecbb3441edc714b56136cf0eff2b508f046fc0a02ab7c28bd20`）；第二次仅补 init 坐标仍无效。本机 Playwright 构造器表和实际附件证实最终显式 MouseEvent 才具有按钮及坐标属性，未改产品定位或强制点击。诊断索引与构造器摘录在 workflow `evidence/T3-A5-diagnostics/`；原诊断源码快照已不可用，索引如实注明，不重建旧字节。

| A5 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| 原四项与关联链接 | 两次各 12 项通过；仅新增菜单守卫失败，公共手势过滤及这些用例此后未变 | `d9f18322160c13413edf71fcefef704d08397a20c17451f7f1751bd3bc2c436b`、`2f0a45439e164ecbb3441edc714b56136cf0eff2b508f046fc0a02ab7c28bd20` |
| 显式 MouseEvent 菜单守卫 | 最终顺序单例 1/1；原真实右键/全选/复制/中断先完整完成，再验证 Control 右键及应用事件菜单可操作 | `00b01680a66b607a6b646cc2530857440a75fbcced05acc4ae57d08fbbb63c5c` |
| remote-hosts 当前消费者 | 31/31；完整 `{items,total,tags,nextOffset:null}` 空页及原 hold/failure 先序保持，无需再改 mock | `82dc0a5d9d2fe9b7a6dba002fea27ef4b70bb23b38cdf3476c740a451f8fbb7d` |

本轮结论为 12+1+31 项开发证据，不记作单次 13/13。最终单例与 remote-hosts 命令退出 0、清理 released；两个中间组退出 1、清理 released。无产品改动，复用既有 T3 生产/原生与图集的适用判断，不重复截图或原生构建。证据仍为本机 Chromium 测试，不代表原生鼠标/IME、Windows/Linux 实机或正式全量终端组验收，最终累计验证交 Delivery。

## T3-A6：滚动基线与恢复队列布局就绪

正式第三轮旧四项全部通过，新增 tracking wheel 与三尺寸恢复队列四项失败仍保留。tracking 用例仅等 `remaining<3`，空 buffer 也满足，实际取到 start0 后变为173；现先等最后输出行及正滚动范围，再保留原无修饰键发送 CLI 鼠标报告/viewport 不动、Shift 及后续上下滚动全部断言。相邻阅读位置、临时查看也补各自最终 marker 与正范围；已有正确前置的普通 wheel、回放、滚动条与 footer 保持，无 scrollback 的 alternate-screen 不强加正范围。

队列观察命令 `fdd67dbad12418edda4c5bd320ed4615881d702467da1ef6ca6ea226ea427f99` 的九样本中七过、两项 1360px 初始测量失败；原 insideStage 仍使用首次同步值，未以随后采样替换。两个失败当时已 failed14/retry14、字体 loaded、无动画，但 stage/parent 高0、y36，queue 高18、y46；随后同语义状态下 stage/parent 高900、y0，queue 高890、y10。这反证了“尚未 failed、字体或动画导致”的假设，定位为测量早于父级布局空间分配，不能归为未证明的环境问题。完整初始/后续数据与观察源码存于 workflow `evidence/T3-A6-diagnostics/`。

最小修复仅在共用队列 helper 等待 failed/可重试语义，再等 stage/parent 正尺寸以及 queue/stage/parent 几何连续三次不变（按帧，有界120帧/5秒）。等待不使用 insideStage 通过作为条件；稳定溢出仍由原断言拒绝。原 insideStage、滚动范围、每行可见、Tab/Enter 到达与重试末行均保留，不增加全局等待或固定 sleep。

| A6 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| 三尺寸队列冷启动，每种三次 | 9/9；queue/stage 高仍为890/900、630/640、574/584，全部原可达性断言完成 | `da58c8078646ea1c1cf40f6f473607a0da4de9f4bd6c379fd0809e3b0fc0843c` |
| wheel、阅读与临时查看直接边界 | 7/7；tracking、阅读位置、临时查看及普通 wheel、两种 alternate-screen、SGR | `c8ae51f067773724be0dc71db67872f3c926fd59ecde487f7f999b0e672f8b38` |

修后两命令退出0、清理 released；观察命令退出1、清理 released。本轮为9个冷布局样本加7项直接边界，未宣称完整131项通过。无产品/Rust改动，既有生产、原生及图集证据按输入适用性复用，未重复截图或原生构建；真实平台与正式累计验证边界继续保留，交 Delivery 完成。

## T3-A7：状态绘制与保存通知的测试消费者

正式第四轮普通 UI 为838/840，两项失败在未改源的隔离运行仍失败；终端组因前段 `&&` 失败未执行，不能记为终端断言失败。连接范围的 state/tone 已为 project_unbound/neutral，但首次实测圆点仍是旧绿。独立临时副本的四个观察样本（`67cd7279b8c762eab82b5e0b7555daa1ec5bd935c02e273b5cec889f6c4c4275`）保留原首次断言，其中一项失败时两个 transition 仍 running/currentTime0，第一帧即变 neutral，随后20帧不再绿；原源码、完整观测与来源保存在 workflow `evidence/T3-A7-diagnostics/`。测试现仅以 expect.poll 等实际绘制颜色改变，保留原颜色不等比较及全部状态/文案断言，不改 CSS。

资料库保存成功通知与新查询 loading 的两个 role=status 合法并存，原宽泛 locator 触发严格匹配错误，成功消息实际已存在。仅按所验证的保存消息筛选 status，保留保存失败草稿/提示、dialog 关闭、零 alert、再次修改与复制失败/成功全部断言；不取 first、不吞错误。生产、mock 与 Workbench 测试字节均未改动。

| A7 开发检查 | 实际结果 | 受控回执键 |
| --- | --- | --- |
| connections-ux 与 status-copy 完整直接组 | 31/31；两项原失败及相邻业务断言全部通过 | `e8ed6245e76bc3b76405fa772fc5ca04969f09a70bdeac4dbcfcff27cdc69112` |
| 当前输入的既有终端修复独立复证 | 5/5；普通 wheel、三个换行链接、真实右键/Control右键/应用菜单及复制/中断保持有效 | `bb921fe854e26f1e4c2540e285d437e4151ab28d7412c3b85cfd8df4f8eaae37` |

以上修后命令退出0、清理 released。结论仅为31+5项开发验证，未宣称完整131项或最终八类验证通过；无产品改动，不重复截图或原生构建，既有证据按实际输入适用性复用，正式累计验证交 Delivery。
