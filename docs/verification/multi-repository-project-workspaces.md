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
