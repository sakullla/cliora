# 配置工作区改造验证

## 可重复的原生配置入口

从仓库根目录运行：

```sh
node scripts/verify-configuration-native.mjs --output /tmp/cliora-configuration-native.json
```

入口先离线构建当前 Rust 产品库，再编译临时公共 API harness。harness 从 `Registry::builtins()` 获取声明验证能力的适配器，加载各自目录内的 `native_verification.mjs` 合成数据，通过产品的 `configuration::open/edit`、`save_registered_profile/get_registered_profile`、`apply_registered_validated` 生成真实候选文件。路径来自产品 `native_files`，额外检查所有文件位于新建的隔离目录。命名配置保存后先检查原生文件仍不存在，随后才显式应用并读取结果。

CLI 专属路径、动作和离线验证协议归属相应 Rust 适配器目录；共享脚本没有第二份 CLI ID 清单，也不生成独立 Cargo/npm workspace。扩展适配器在 `ConfigurationAdapter::native_verification_module()` 声明其仓库相对模块，模块导出 `fixture`、`verify(context)` 和可选的 `environment(application)`。

所有凭据均为合成标记，使用临时内存 CredentialStore 和 SQLite；不会读取系统凭据库、用户原生登录目录、真实账号或凭据。CLI 子进程只获得明确列出的环境变量及隔离的 home/XDG 目录，不继承认证变量或执行模型请求。代理指向本机关闭端口作为辅助保护；安全依据是适配器只调用已确认的离线加载或校验入口，代理并非网络沙箱。脚本保留临时目录便于检查，不改变真实 CLI 配置。

Codex 的当前探针另要求 macOS `sandbox-exec` 的默认拒绝策略，只允许读取公开系统依赖、当前 Node 安装和临时目录，只允许写入临时目录；没有私有 home、系统／企业配置、凭据库 IPC 或网络权限。无法启用时标为未验证，不在缺乏隔离的主机上启动此加载探针。该策略归属 Codex 验证模块。

## 证据等级与退出码

报告分别记录产品保存／应用结果和目标 CLI 校验。每个文件附内容 SHA-256；CLI 记录可执行入口、版本命令原始结果、安装包版本、平台、方法和进程输出。当前产品源码及 fixture 内容清单、源码指纹和实际链接的产品库 SHA-256 用于定位候选；运行期间源码变化使结果失效并退出 1，不能将旧构建验收归到新候选。

| 等级 | 实际证明的范围 |
| --- | --- |
| `native_loader` | 调用目标版本实际配置读取入口并检查读到的结果，或目标 CLI 严格加载配置；仍不证明认证、推理、热更新或其它平台 |
| `official_schema` | 目标安装版本的官方 schema/section registry 接受应用文件；不等同启动引擎或解析全部模型关联 |
| `syntax_only` | 产品解析和适配器校验通过；目标 CLI 接受状态仍为 `unverified` |
| `unavailable` | 无可确认的安全离线入口、公开模块或安装发现；保留原因，不把未在 PATH 找到当成已证实缺失 |

正常入口允许明确标注未验证组合：实际配置被拒绝、产品应用失败或源码变化返回 1；存在未验证组合但已执行项成功返回 0，报告为 `completed_with_unverified`。需要全体原生组合验证时增加 `--strict`，存在未验证组合返回 2。`--help` 与 `--version` 仅作说明或安装发现，永不作为加载成功。loader/schema 探针带无效候选负对照，避免把仅正常退出误判为有效读取。

## 本次开发观测

2026-10-06 01:13:13（Asia/Shanghai，报告 UTC 为 `2026-10-05T17:13:13.029Z`），在 macOS arm64、Node v24.13.1 执行上述入口，输出 `/tmp/cliora-workspace-native-development.json`，退出 0、报告为 `completed_with_unverified`。运行内源码稳定；源码指纹为 `dc73a7e860f622fdbeec03ad4d7a81f665c55e53a18d23fc3441fd5f92f82070`，产品库 SHA-256 为 `8cde8f8d9cbffe2f840e13cdfac0eb40798a6e5bb331a11dd4970440aca048f8`。此时工作区后台整合尚在继续，这些哈希标识本次开发观测输入，不能归到后续修改或最终交付候选。

| CLI | 本机真实版本 | 产品合成保存／应用 | 目标版本实际方法与结果 |
| --- | --- | --- | --- |
| Pi | 1.0.2，`@earendil-works/pi-coding-agent` | 通过；应用 `settings.json` 与 `models.json` | `native_loader` 通过：实际 `ModelConfig.load` 读取 first、second；`SettingsManager.create` 读到供应商 `cliora_synthetic`、默认模型 second 和思考档位 high；邻界有效值 `{high:"high",off:null}` 接受，无效 `high:42` 对照被拒 |
| npm Kimi Code | 2.1.1，`@moonshot-ai/kimi-code` | 通过；应用 `.kimi-code/config.toml` | `official_schema` 通过：`kimi doctor config <应用文件>` 明确回报目标文件 OK、退出 0；`models = "not-a-model-map"` 对照回报 models 应为 record、退出 1。未启动引擎，不声明运行时关联加载通过 |
| Codex | codex-cli 0.160.0 | 通过；应用 `.codex/config.toml` | `syntax_only`；原生未验证。所需 sandbox 启用校准 `/usr/bin/true` 被 SIGABRT 中止，没有运行 `features list`；未退回无隔离执行 |
| Claude Code | 2.1.289 | 通过；应用 `.claude/settings.json` | `syntax_only`；缺少已确认能避免私有凭据及启动副作用的独立离线入口，原生加载未验证 |
| OpenCode | 未验证 | 通过；应用 `.config/opencode/opencode.json` | `syntax_only`；PATH 未发现 `opencode`，没有穷尽其它安装路径，不声明本机不存在；原生加载未验证 |

五项均在新建临时目录使用产品能力，检查仅保存没有创建原生文件，再显式应用、读取解析并记录字节哈希；该事实与目标 CLI 的接受证据分别列出。Pi loader SHA-256 为 `24a0e0f98672766e16e00d9f61587f50f9481915581156ae71a14e48ee912e4c`；正式执行时报告保存完整 CLI 输出、输入路径及所有文件哈希。

开发过程中首次 harness 链接因误把产品产物目录当依赖目录失败；已改用 Cargo 返回的 serde_json 依赖目录，随后真实产品链接和执行成功。之后 Pi create 探针因额外 `cost` 不属于当前已声明的新模型字段而被产品拒绝；fixture 改为适配器允许的创建动作，再由实际公开 loader 验证输出接受。没有修改产品约束来绕过失败，也没有将两次失败报告为原生通过。

正式 Delivery 须针对最终稳定候选重新运行执行计划中的验证入口；本开发记录不替代 Delivery 验收。未执行 Windows、Linux、真实账号、模型推理或热更新。

## 页面尺寸与截图

UI worker 已在更新后的界面重新捕获三张模型详情 PNG，并新增默认首屏 PNG，报告集中 79 条 UI 回归及最终首屏相关 7 条回归通过。截图对应 `tests/ui/config-dialog.spec.ts` 中的 `Kimi default first screen shows connection and compact model list` 与 `unified Kimi editor keeps required fields and main controls reachable` 的 minimum、default、wide 案例。本 helper 核对当前四个文件及 PNG 实际像素尺寸，与对应 viewport 一致；没有重跑该 UI 套件。

| 场景 | 浏览器 viewport／PNG 尺寸 | 实际截图 |
| --- | --- | --- |
| 默认窗口首屏 | 1160×780 | [Kimi 连接摘要与模型列表首屏](configuration-redesign-ui/kimi-first-screen-1160x780.png) |
| 最小窗口 | 720×560 | [Kimi 模型详情与主操作](configuration-redesign-ui/kimi-minimum-720x560.png) |
| 默认窗口模型详情 | 1160×780 | [Kimi 默认窗口模型详情](configuration-redesign-ui/kimi-default-1160x780.png) |
| 宽窗口 | 1600×960 | [Kimi 宽窗口](configuration-redesign-ui/kimi-wide-1600x960.png) |

首屏截图展示配置名称、密钥保存摘要、折叠的密钥操作与供应商摘要、紧凑模型列表以及底部保存操作；模型参数详情默认不展开。首屏案例检查配置名称与保存按钮可见、上下文详情未展开。三张详情截图展示打开单个模型后的必填上下文上限与底部保存操作；对应案例检查必填字段可见、保存按钮位于 viewport 内、dialog 无横向滚动，并检查返回列表后另一模型重新可见。测试使用合成 IPC，这些截图和交互断言只建立浏览器界面行为，不证明原生配置加载、账号认证或平台接受，也不等于正式 Delivery 对最终候选的验收。

本次核对的当前 PNG 字节 SHA-256 如下；前三张模型详情已重新生成，先前 `/tmp/cliora-workspace-native-doc-a1-result.json` 的旧哈希保留其当时观测身份，不代表此版图像。

| PNG | SHA-256 |
| --- | --- |
| kimi-first-screen-1160x780.png | `585377e918571fe4daaee81bc3379b78e508589830c89982e0320437ecc6a8ed` |
| kimi-minimum-720x560.png | `293cc19533b5b76d5a97d0f449b5091806ff9590bd62e13a76763da60fa805bc` |
| kimi-default-1160x780.png | `a3d0b3db16f7803f11c14354d176c313dfd68f4c212621a3d548e58e8b0df14f` |
| kimi-wide-1600x960.png | `4373bbc1c9fd4cc0298d18371bfac6ee99af76db133a0dae2433b72f6f190338` |

Git 忽略例外仅允许本文件和上述四个精确 PNG，仍忽略其它验证日志、通用 UI 截图目录、需求与 workflow 运行材料。原生开发观测的中间源码指纹及三项原生未验证事实保留，正式 Owner Delivery 会对最终稳定候选重跑原生入口。

## 跨平台边界

Windows、Linux 和未执行的安装形式、版本或 CLI 方法均未验证。普通兼容版本更新的产品策略继续由适配器控制；此报告的实测版本不是精确版本锁。其它独立资源、插件、历史与额度流程的验证仍由执行计划统一交付检查覆盖。
