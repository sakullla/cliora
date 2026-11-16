# 多仓库项目工作区验证

日期：2026-11-16。环境：macOS，Node v26.13.0、Rust 1.98.1。

## 当前已实现范围

Cliora 增加独立业务项目、仓库成员与工作位置模型，保留旧目录配置身份。首页和新建会话入口支持项目内搜索、收藏、多选添加、限定目录扫描、主目录/附属 worktree 选择及会话归属。项目清单 v1 支持预览、关联、发布、版本检查和原子更新。本文先记录 T1 开发验证；Twiglane 消费、提示词新范围、bundle/WebDAV 和审查 v3 的结果在对应实现与验证后补充。

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
