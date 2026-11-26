# ACP 接入与逐 agent 验收（2026-11-26）

范围：R2（按 agent 适配实际安装和能力）与 R8（逐 agent 记录与限制）。本记录把三类事实分开：

1. **入口可核对**（documented）：上游 ACP 注册表、官方文档或本机 `--help` 给出实际程序与参数。
2. **握手可用**（handshake）：本机实际启动该程序，向 stdio 写一帧 `initialize`（`protocolVersion: 1`）并收到 `result`。
3. **真实交互**（interactive）：在会话里跑完一轮含工具调用的对话，并观察授权、停止与恢复。

本次只做到第 2 步，第 3 步**未运行**（会产生真实推理费用与账号操作），所以 19 项的 `state` 全部是 `unverified`，没有任何一项写成 `supported`。适配器声明在各 `src-tauri/src/adapters/*/mod.rs` 的 `fn acp`，共享契约在 `src-tauri/src/adapters/contract.rs`。

采集环境：Windows 10.0.26300（x64），2026-11-26；命令来自 PATH 与本机安装目录，未启动模型、未读取账号凭据。上游依据取自当日 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（46 项注册表）与各项目 README。

## 结论矩阵

「来源」区分本机可执行文件（native）、厂商单独分发的组件（vendor）与第三方桥接（bridge）。「证据」列即 `AcpCapability::evidence`。能力列对应该轮握手中 agent 声明的项（`sessionCapabilities` / `loadSession` / `authMethods`）；停止（`session/cancel`）是协议必备项，未单独声明。

| Agent | 接入路径 | 来源 | 实际命令与参数 | 平台 | 会话 | 授权 | 停止 | 恢复 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | 原生 | native | `opencode acp` | Windows（2.3.0） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Codex | 桥接 | bridge | `codex-acp` | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| Claude Code | 桥接 | bridge | `claude-agent-acp` | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| Grok | 原生 | native | `grok agent stdio` | Windows（1.0.77） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Pi | 桥接 | bridge | `pi-acp`（运行 PATH 上的 `pi`） | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| oh-my-pi | 原生 | native | `omp acp` | Windows（19.2.1） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Cursor | 原生 CLI | native | `cursor-agent acp` | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| Kimi Code | 原生 | native | `kimi acp`（仅 2.x） | Windows（2.7.0） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Qoder CN | 原生 | native | `qoderclicn --acp` | Windows（1.1.94） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| ZCode | 社区桥接 | bridge | `zcode-acp`（PyPI，Python 3.9+） | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| DeepSeek Harness | 原生 | native | `dsh acp` | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| CodeBuddy | 原生 | native | `codebuddy --acp` | Windows（2.187.0） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| MiMo Code | 原生 | native | `mimo acp` | Windows（0.1.15） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| MiniMax Code | 原生 | native | `mcode acp` | Windows（0.6.13） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Cline | 原生 | native | `cline --acp` | 未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| Devin | 原生 | native | `devin acp` | Windows（3000.12.57） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Command Code | 原生 | native | `cmdc acp`（Windows）/ `cmd acp` | Windows（1.88.0） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |
| Antigravity | 厂商组件 | vendor | `agy_acp_server` | 组件未安装 | 未验证 | 未验证 | 未验证 | 未验证 | documented | unverified |
| Kiro | 原生 | native | `kiro-cli acp` | Windows（3.5.0） | 声明 | 声明 | 声明 | loadSession 声明 | handshake | unverified |

**「会话／授权／停止／恢复」四列记录的是来源，不是已核实的行为。** 只有 handshake 行的前三列写了「声明」，意思是本轮握手确实收到了对应能力声明；documented 行全部是「未验证」，只来自上游注册表与文档。「恢复」列任何一行都**没有**写成「是」或「已核实」：`loadSession 声明` 只说明该 agent 在握手时报告了加载能力，本机从未真正加载过一个原生会话，恢复结果、恢复后的首轮与失败文案都还没有实证记录（T3 复核也指出恢复失败文案与实际关闭新会话的行为不一致，见文末限制）。把这些声明当成「已核实的恢复」会直接违反 R8 的记录要求。

MiniMax Code 与 Devin 的握手返回 `loadSession: true` 但 `sessionCapabilities` 未列出 `resume`；适配器按「声明了才记账」处理，恢复能力仍要在真实会话里确认。

## 逐项记录

### OpenCode

- 入口：`opencode acp`（原生）。本机 `opencode v2.3.0`，PATH 上 `AppData/Roaming/npm/opencode`。
- 握手（2026-11-26，Windows）：`protocolVersion 1`、`agentInfo` = OpenCode 2.3.0、`loadSession: true`、`sessionCapabilities` 含 list/resume/fork/close/delete/additionalDirectories、`authMethods` = `opencode-login`（提示在终端跑 `opencode auth login`）、`_meta.steering.supported = true`。首帧约 0.7 秒。
- 能力：会话、工具授权、停止、恢复（`loadSession`）。
- 限制：握手不含任何模型调用，真实对话、授权弹窗、停止与恢复未验证；`opencode acp` 使用所选目录与 provider 配置，属于第 3 步验证范围。
- 终端回退：`opencode` 交互式启动照旧可用。

### Codex

- 入口：`codex-acp`（桥接），本机**未安装**；本机有 `codex-cli 0.172.0`，但 Codex CLI 本身不提供 ACP。
- 上游依据：ACP 注册表 `codex-acp` = `@agentclientprotocol/codex-acp@2.12.1`；README 说明它启动 Codex App Server，并**自带一份兼容的 `@openai/codex`**，`CODEX_PATH` 可改为运行指定的 Codex 可执行文件。
- 环境策略：`bind_installation = ["CODEX_PATH"]`。共享宿主必须把用户选中的 codex 安装路径写入该变量，否则 ACP 会运行桥接自带的那份 Codex，与终端启动的身份不一致；未解析到安装时解析直接失败（`identity-unresolved`），不会静默改用另一份。
- 限制：桥接未安装，无握手、无真实对话；配置目录与沙箱模式沿用所选 Codex 安装，未验证。
- 恢复方式：`npm install -g @agentclientprotocol/codex-acp` 后重试；仍失败时用终端在同一目录启动。

### Claude Code

- 入口：`claude-agent-acp`（桥接），本机**未安装**；本机有 `claude 2.1.332`。
- 上游依据：注册表 `claude-acp` = `@agentclientprotocol/claude-agent-acp@0.112.0`；README 说明独立发布包内含 `claude-agent-acp` 与一份 Claude Code，`CLAUDE_CODE_EXECUTABLE` 可指向别的 Claude 可执行文件。
- 环境策略：`bind_installation = ["CLAUDE_CODE_EXECUTABLE"]`，理由同上；账号环境沿用 Claude 账号适配器声明的移除清单。
- 限制：无握手、无真实对话；OAuth 与 API key 两种登录在 ACP 下的表现未验证。

### Grok

- 入口：`grok agent stdio`（原生）。本机 `grok 1.0.77`（`~/.grok/bin/grok`）。
- 握手：`protocolVersion 1`、`loadSession: true`、`sessionCapabilities` 含 list/resume/close、`authMethods` = `grok.com`，并有 `x.ai/*` 扩展。首帧约 2.1 秒；stderr 提示有 1.0.92 可升级。
- **同名陷阱**：`~/.grok/bin/agent` 也是 grok 的程序，但裸跑 `agent stdio` 会进入全屏 TUI（本次实测收到 `ESC[?1049h` 等屏幕序列，12 秒内无 JSON-RPC 响应）。入口必须写成 `grok agent stdio`。
- 限制：真实对话未验证；`grok agent stdio` 复用 `GROK_HOME` 的登录，受管账号在 ACP 下能否保留所选账号未验证。

### Pi

- 入口：`pi-acp`（桥接），本机**未安装**；本机有 `pi 1.6.1`。
- 上游依据：注册表 `pi-acp` = `pi-acp@0.0.35`；README 说明桥接自己运行 PATH 上的 `pi`（要求 0.81.0 起），把请求转成 `pi --mode rpc`，会话映射写 `~/.pi/pi-acp/session-map.json`。
- 依赖检查：`dependency.program = "pi"`，解析器在同一批目录里确认 `pi` 在场，缺失时报桥接缺失原因而不是启动后失败。
- 限制：无握手、无真实对话；Pi 会话目录在 ACP 下的归属未验证。

### oh-my-pi

- 入口：`omp acp`（原生，独立于 Pi）。本机 `omp 19.2.1`。
- 握手：`agentInfo` = omp 19.2.1、`loadSession: true`、`sessionCapabilities` 含 list/fork/resume/close、`authMethods` = `agent`（复用 `~/.omp` 已有凭据）、`_meta.steering.supported = true`。首帧约 1.3 秒。
- 限制：工具请求与交互式提问未在真实会话验证。

### Cursor

- 入口：`cursor-agent acp`（原生 CLI）。本机**未安装** `cursor-agent`；适配器的 `cursor` 是桌面编辑器，两者不是同一个程序，探测也不回退到 `agent`。
- 上游依据：注册表 `cursor` 2026.11.22 按平台分发 `dist-package/cursor-agent`，参数 `acp`；Windows 为 `cursor-agent.cmd`。
- 限制：无握手、无真实对话；本机 CLI 实际入口与登录态未验证。
- 恢复方式：装 Cursor CLI 后重试；否则用终端启动桌面编辑器或 CLI。

### Kimi Code

- 入口：`kimi acp`（原生）。本机 `kimi 2.7.0`，`kimi --help` 明确写着 "Run kimi-code as an ACP server over stdio"。
- **同名可执行**：已归档的旧版 Kimi CLI（1.x，注册表 `kimi` = 1.52.0）也提供 `kimi acp`，但配置根与会话格式不同。适配器声明 `version_range = ("2.0.0","3.0.0")`，1.x 直接拒绝并说明这是旧版；3.x 未核对。
- 握手：`agentInfo` = Kimi Code CLI 2.7.0、`loadSession: true`、`sessionCapabilities` 含 list/resume/close/delete/fork/additionalDirectories、`authMethods` = `login`（terminal 类型，参数 `--login`）。首帧约 1.0 秒。
- 限制：真实对话未验证；`kimi --version` 只输出裸 semver，无法只凭版本串确认产品，需结合 `~/.kimi-code` 配置根与安装渠道。

### Qoder CN

- 入口：`qoderclicn --acp`（原生，中国版）。本机 `qoderclicn 1.1.94`；同机另有 `qodercn` 的 npm shim，两者同一程序，适配器统一用 `self.command`（`qoderclicn`）。
- 握手：`agentInfo` = `qoder-cli-cn` / Qoder CLI CN 1.1.94、`loadSession: true`、`authMethods` = `qoderclicn-login`。首帧 12–16 秒，明显慢于其它 agent，初始化超时不能设得太短。
- **地区**：国际版注册项是 `qoder --acp`（`@qoder-ai/qodercli`）。中国版适配器声明自己的命令，不会回退到国际版。
- 限制：`qoderclicn --help` 未列出 `--acp`（靠握手确认）；真实对话、权限模式以及所需的客户端文件/终端能力未验证。

### ZCode

- 入口：`zcode-acp`（社区桥接，PyPI，Python 3.9 起）。本机**未安装**。
- 上游依据：README 说明它把 ZCode 私有 app-server 协议翻成 ACP，驱动已安装并登录的 ZCode 引擎，不代理 API；会话支持 create/list/resume/fork/close，授权走 `session/request_permission`（fail closed）。
- 环境策略：`remove = ["ZCODE_ACP_APPROVAL_BRIDGE","ZCODE_ACP_APPROVAL_DIR"]`。这两个变量会把授权改成文件桥、绕开 ACP 客户端；不移除的话工具授权不会出现在 Cliora 的待处理入口。
- 依赖：需要 Python 3.9+、`pipx install zcode-acp`、以及已登录的 ZCode 应用；缺任一项启动失败。
- 限制：无握手、无真实对话；Python 版本与引擎包路径（`ZCODE_CJS`）未验证。

### DeepSeek Harness

- 入口：`dsh acp`（原生）。本机**未安装** `dsh`。
- 上游依据：官方 `docs/cli-help.md` 的 `dsh acp` 段落写明等价于 `dsh --profile acp`，在 stdio 上提供 ACP 直到客户端断开。
- 限制：无握手、无真实对话；配置沿用 Harness 的 profile 层，未验证。

### CodeBuddy

- 入口：`codebuddy --acp`（原生）。本机 `codebuddy 2.187.0`。
- 握手：`protocolVersion 1`、`loadSession: true`。首帧约 4.2 秒。`codebuddy --help` 明确 `--acp` 走 stdin/stdout ndjson，并说明不带 `--acp` 时 `--serve` 的 ACP 不走 stdio。
- 限制：真实对话未验证；腾讯地区发行包与登录态对 ACP 的影响未验证。
- 注意：本轮首次探测用 12 秒超时曾误判为无响应，实际 4 秒内有应答；初始化超时需按 agent 放宽。

### MiMo Code

- 入口：`mimo acp`（原生）。本机 `mimo 0.1.15`。
- 握手：`agentInfo` 自报 **OpenCode 0.1.15**、`authMethods` = `opencode-login`（MiMo 是 OpenCode 派生，自报身份不带 MiMo 名字）、`loadSession: true`、`sessionCapabilities` 含 fork/list/resume。首帧约 3.4 秒。
- 限制：**模型选择**未验证。上游 issue 记录了默认模型选择偏差，选中会话前应确认实际型号，避免意外计费；真实对话未运行。身份判定依赖安装渠道（`@mimo-ai/cli`）与可执行名，而不是握手自报的名字。

### MiniMax Code

- 入口：`mcode acp`（原生）。本机 `mcode 0.6.13`。
- 握手：`agentInfo` = `minimax-code` / MiniMax Code 0.6.13、`loadSession: true`、`sessionCapabilities` 含 list/fork/resume/close、`authMethods` 为空数组（没有登录方式，凭据来自既有配置）、`_meta` 里带 `mcode/session/*` 扩展。首帧约 3.0 秒。
- 备选：注册表另有独立的 `@minimax-ai/code-acp@0.7.10` 分发（参数 `acp`）。本机 CLI 直接提供入口时优先本地 CLI，不回退到独立包。
- 限制：真实对话、地区与登录未验证。

### Cline

- 入口：`cline --acp`（原生）。本机**未安装** CLI。
- 上游依据：注册表 `cline` = `cline@3.0.75`，npx 参数 `--acp`。
- 限制：无握手、无真实对话；工具许可粒度未验证。

### Devin

- 入口：`devin acp`（原生）。本机 `devin 3000.12.57`（`AppData/Local/devin/cli/bin/devin`）。
- 握手：`agentInfo` = `affogato` / Devin Agent 0.0.0-dev、`loadSession: true`、`authMethods` = `devin-browser`，`_meta` 里带大量 `cognition.ai/*` 扩展（多根工作区、会话列表、分享等）。首帧约 0.07 秒。
- 限制：真实对话与账号/项目归属未验证；`devin acp --cloud` 会把同一协议中继到 Devin 云端（需要账号），本期不使用。

### Command Code

- 入口：`cmdc acp`（Windows）/ `cmd acp`（其它平台），原生。本机 `cmdc 1.88.0`。
- **Windows 身份**：命令解析在本机把 `cmd` 落到 `C:\WINDOWS\system32\cmd`（系统命令解释器），而产品 shim 是 `cmdc`。适配器因此把入口声明为 `cmdc` 并标记 `rejects_system_program`：解析时拒绝落在 `SystemRoot%\System32` / `SysWOW64` 下的同名候选（有测试覆盖）。`cmdc --help` 确认 `cmd acp  Run as an ACP agent over stdio`。
- 握手：`agentInfo` = Command Code 1.88.0、`loadSession: true`、`sessionCapabilities` 含 list/resume/close、`authMethods` = `command-code-cli`（复用终端 `cmd login` 的账号）。首帧约 2.4 秒。
- 限制：真实对话未验证；其它平台的 `cmd` 名称冲突由同一拒绝规则覆盖。

### Antigravity

- 入口：`agy_acp_server`（厂商单独分发的组件）。本机装了 `agy 1.5.9`，但**没有** `agy_acp_server`。
- 上游依据：注册表 `antigravity-acp` 1.5.2 按平台分发 `agy_acp_server`（Windows/Linux 为可执行文件，Linux 需要 `--uid=` 参数，macOS/Linux 另有 `.par` 形式）。
- 依赖语义：`origin = vendor`，缺组件时报的是「缺 ACP 组件」而不是「缺 CLI」；两者要分别识别。
- 限制：无握手、无真实对话；`--uid=` 参数与平台差异未验证。

### Kiro

- 入口：`kiro-cli acp`（原生）。本机 `kiro-cli 3.5.0`（`AppData/Local/Kiro-Cli/kiro-cli`）。
- 握手：`loadSession: true`、`sessionCapabilities` 含 list/close/delete/fork、`authMethods` = `aws-builder-id` / `aws-iam-identity-center`、`_meta.kiro` 声明 `executionTargets` 等扩展。首帧约 1.5 秒。
- 限制：注册表 3.6.2 只列 macOS/Linux 包，本机 Windows 3.5.0 握手可用但未列入注册表；真实对话与 AWS 登录在多账号下的表现未验证。

## 适配器契约与共享服务

- `CliAdapter::acp()` 返回 `AcpCapability { state, evidence, reason, entry }`；`entry` 携带入口程序、参数、来源、依赖、环境策略、版本线与能力标记。`CliAdapter::acp_for_version()` 用适配器自己的 `version_range` 判断；未解析到版本时版本型入口不可用，不做猜测。
- `CliAdapter::acp_command(home, installation, version)` 解析出 `AcpCommand { program, args, environment, remove_environment, origin }`：先按适配器安装目录（含 `native_installations` 的父目录与 `extra_binary_candidates`）再按 PATH 搜索；桥接的 `dependency.program` 必须同时在场；`bind_installation` 需要已选定的 `installation`，否则报 `identity-unresolved`；`remove_environment` 是入口自身移除项与账号适配器 `remove_environment()` 的并集，所以 ACP 的账号环境隔离与终端启动一致。
- 失败原因用闭环 code：`unsupported` / `not-installed` / `dependency-missing` / `version-unsupported` / `system-program` / `identity-unresolved`，都带可读原因与帮助链接；UI 据此显示具体缺口并保留终端回退。
- 注册表描述符新增 `acp` 字段，19 个适配器共用同一形状；共享设置与会话界面按字段渲染，不新增产品 ID 分支。

## 开发验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| ACP 契约与失败样例 | `cargo test --manifest-path src-tauri/Cargo.toml --lib acp` | 9 passed（本次新增） |
| 全量 Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | 1734 passed / 12 failed，失败项集中在 `remote::uploads`、`remote::transactions`、`remote::twiglane_trust` 与 `external::tests::twiglane_workspace_handoff_url_is_validated`，需要本机 WSL/SSH/SFTP，或与本次改动无关的 Windows 路径断言，非本次引入 |
| Lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | 无警告、无错误 |

新增测试（`tests/adapter/acp-agents.rs`，由 `src-tauri/src/adapters/registry.rs` 以 `#[path]` 引入）：

1. 19 个已注册适配器逐个声明入口、来源、版本线原因、能力与状态；注册表数量与清单一致，新增适配器漏声明会失败。
2. 入口程序与参数对照本记录的表（含 `grok agent stdio` 与 Windows 上的 `cmdc`）。
3. **注册表扩展**：测试注册一个 `acp_fixture`，只靠它自己的声明就能读出描述符里的 `acp` 并解析出程序、参数与环境，证明共享路径不依赖产品 ID。
4. 失败样例：缺桥接宿主（`dependency-missing` 与安装提示）、缺入口程序、越界版本（`version-unsupported` 带版本线与原因）、桥接缺已选定安装（`identity-unresolved`）。
5. 环境策略：字面量变量、`bind_installation` 绑定所选安装、专用移除项与账号适配器移除清单的合并。
6. Windows 系统程序保护：`C:\Windows\System32\cmd.exe` 与 `SysWOW64` 下的同名程序永远不被接受；目录只提供系统 shell 时返回 `system-program`。
7. 搜索顺序：适配器安装目录排在 PATH 之前。

## 未完成与限制

- **真实交互（第 3 步）全部未做**：T1 只做到握手，T3/T4 只做到合成帧与离线界面验证，没有一项是 `supported`；授权弹窗、停止、恢复、多轮增量与工具结果仍要在真实会话里逐项补齐。
- **桥接未安装**：codex-acp、claude-agent-acp、pi-acp、zcode-acp、agy_acp_server 在本机都不在场，只有上游文档与注册表依据；安装并握手后应把 evidence 升级为 `handshake`。
- **仅 Windows**：macOS/Linux 的入口、`agy_acp_server.par`、`--uid=` 参数与 Kiro 的平台包均未验证。
- **等待时长**：Qoder CN 12–16 秒、CodeBuddy 约 4 秒才回第一帧；共享宿主的初始化超时不能按毫秒级假设设置。
- **身份边界**：Codex / Claude 桥接必须绑定所选安装（`CODEX_PATH` / `CLAUDE_CODE_EXECUTABLE`），否则会运行桥接自带的那份引擎；解析器已强制这一点，真实运行下的身份一致性仍待实测。
- **已知限制（T3 复核，非阻断）**：ACP 恢复失败时，界面文案写的是「恢复失败」，但宿主实际已经关闭了原记录并新建了一个会话——文案与真实行为不一致，用户需要按「已新建会话」理解，并会在 T4 之后单独修正。
- **已知限制（T3 复核，非阻断）**：工作目录预检发生在 ACP 子进程 spawn 之后，而不是之前，因此一个不可用的目录会先留下一次失败的进程启动再报错；这不会误判成功，但诊断顺序与「预检在前」的期望不同。
- 本记录不含任何凭据、账号或提示词内容；握手只发送 `initialize`，不加载文件、不执行工具。

## 工作台接线与 T4 验收（2026-11-26）

本轮把 T3 的共享宿主接到界面上，只做**离线合成验证**：没有启动任何真实 agent，也没有运行模型对话，因此矩阵里的 19 项状态仍然全部是 `unverified`，下面的记录不是原生平台验收。

### 实际接线

- 设置 → 「终端与启动模式」新增「启动方式」（终端／ACP 对话），与终端类型、普通／YOLO、启动偏好各自独立。行里显示后端返回的实际值；保存失败显示真实原因并给出「重试」，重试仍用同一个选择；后端报告无法识别的已存值按终端显示并给出说明，且读取不会回写。切换只影响之后新建的会话，改回终端仍保留原来的外部终端与自定义命令。
- 工作台会话是原生对话面板而不是终端（`src/features/sessions/AcpConversation.tsx`）：消息流、流式增量、按 `toolCallId` 归并的工具卡片、绑定本次请求的授权卡、停止（`stopping`）与轮次结果（可继续／限额／拒绝／取消／断开／失败／未知）。侧栏、标题、任务状态与「等你处理」入口都由共享列表给出：待授权按 `approval` 计入需要人处理，运行中的轮次算工作，结束的会话没有退出码可显示。
- 会话状态由 `src/features/sessions/acpSession.ts` 的纯函数折叠：快照整体替换，增量按消息 id 追加，工具按调用 id 合并，授权按 `requestId` 增删，序号已在视图中应用过的事件不会重放；通知有界且不进入消息流。切换标签、分屏与重新挂载时用 `list_acp_sessions` / `acp_session` 补齐切换期间的输出，两个会话的内容互不串台。
- 首条提示只发一次：原生宿主在会话建立后提交 `initial_prompt`，界面从不再调用 `acp_prompt` 重发首条（用例直接断言 `acp_prompt` 未被调用）。
- 快捷输入与中断按会话类型路由：选中的是对话时，工作台输入框把文本交给 `acp_prompt`（不走 PTY 写入、不包装 bracketed paste、不准备终端秘密引用），中断按钮调用 `acp_cancel`；终端会话仍走原来的写入路径。
- 启动入口：工具、项目卡片、工作台新建与托盘最近项目都走同一选择；`workbenchSessionId` 现在同时识别 `session_started` 与 `acp_started`，因此从首页或托盘打开的对话会聚焦到同一个工作台会话。历史恢复与旧记录仍按原方式（终端）继续。新建会话对话框在 ACP 时显示所选 CLI 与实际工作目录，并停用该入口无法表达的 YOLO 选项（后端同样会拒绝）。
- 失败恢复：对话框与面板都显示适配器的具体原因（缺桥接、YOLO 不可表达、Agent／会话参数不支持、项目模型覆盖等），并提供「新开一个对话」与「改用终端在此目录启动」两条明确路径，后者复用已创建的工作树与目录。

### 离线验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查与构建 | `npm run build` | 通过 |
| Node 单测（含新增折叠测试） | `npm run test:unit` | 303 tests / 297 passed / 6 skipped / 0 failed |
| 新增折叠测试 | `node --test tests/native/acp-session.test.mjs` | 8 passed |
| 合成 IPC 界面用例 | `node scripts/test-ui.mjs workbench-acp.spec.ts` | 6 passed |
| 工作台截图 | `node scripts/verify-ui-captures.mjs --skip-build --only workbench` | 见「截图」一节 |

新增界面用例在 `tests/ui/workbench-acp.spec.ts`，合成 IPC 在 `tests/ui/acpMock.ts`，覆盖：设置里选择 ACP（含保存失败与无法识别的已存值）、从工作台新建以 ACP 启动、首条提示只发一次、流式增量与重复序号去重、工具卡片按调用 id 归并、授权卡只回答自己的请求、停止与 `stopping`、失败原因与同目录终端回退、两个会话切换时的内容隔离、760px 窄窗口无横向溢出。

### 截图

工作台 ACP 对话面板与设置行由 `scripts/capture-product-ux.mjs`（`scripts/verify-ui-captures.mjs` 批量入口）生成，是浏览器合成 IPC 的图库，不是原生窗口。这些 PNG 按仓库现有约定不纳入版本控制，重跑同一条命令即可再生成：

- 设置「启动方式」（深/浅两套）：`docs/verification/product-ui-ux/pages/settings-launch-{light,dark}-1360.png`，命令 `node scripts/verify-ui-captures.mjs --skip-build --only pages`
- ACP 对话（默认图库里的一张）：`docs/verification/product-ui-ux/workbench/workbench-acp-conversation-dark-1360.png`，命令 `node scripts/verify-ui-captures.mjs --skip-build --only workbench`
- ACP 对话、授权卡、停止中与 720px 窄窗口的完整一组：`docs/verification/product-ui-ux/workbench-acp/`，命令 `CLIORA_CAPTURE_OUT=docs/verification/product-ui-ux/workbench-acp node scripts/capture-workbench.mjs --only 'workbench-acp-*' --size all --theme all`（需要先运行 `npm run dev -- --port 14736`）

抓图不移动也不遮挡 Cliora 窗口；脚本自带的检查确认无横向溢出、无页面错误，这些图片仍不是本机原生验收。

抓图不移动也不遮挡 Cliora 窗口；这些图片不是本机原生验收。

### 未实证

- **真实 agent 对话仍未运行**：上面所有面板行为都由合成帧驱动，没有一个真实 ACP 会话被启动过。授权弹窗的实际文案、停止后 agent 的真实反应、工具结果的实际形态都还只有协议侧依据。
- **恢复未实证**：原生会话加载、恢复失败后的关闭行为、恢复后再发首轮都还没有实测（另见文末限制）。
- **仅 Windows**：合成验证在 Windows 上用 Chromium 跑；macOS/Linux 的界面与宿主行为未验证。