# ACP 接入与逐 agent 验收（2026-11-26）

范围：R2（按 agent 适配实际安装和能力）与 R8（逐 agent 记录与限制）。本记录把四类事实分开，任何一列都不把后一类写成已核实：

1. **命令可发现**（documented）：上游 ACP 注册表、官方文档或本机 `--help` 给出实际程序、参数与安装渠道。本机没装该程序时只做到这一步。
2. **握手可用**（handshake）：本机实际启动该程序，向 stdio 写一帧 `initialize`（`protocolVersion: 1`）并收到 `result`，因此能看到它自报的能力。
3. **能力声明**（declared）：适配器的静态入口表（`src-tauri/src/adapters/*/mod.rs` 的 `fn acp`，19 项都写了 session/authorization/cancel/resume = true）与握手自报（`loadSession`、`sessionCapabilities`、`authMethods`）。**声明不等于已核实**：它只说明这一方说它支持，没有一次真实调用被观察过。
4. **真实会话验证**（interactive）：在会话里真正加载一个原生会话、跑完一轮含工具调用的对话，并观察授权、停止与恢复的实际结果。

> 2026-11-27 更新：用户确认推理费用后，对本机可解析的 9 个 agent 做了第 4 步的最小抽样（每个 agent 两个极短提示），结果见文末「真实 agent 抽样（2026-11-27）」。抽样不改变下表与适配器声明：19 项仍是 `unverified`，抽样记录是本轮证据，不是 `supported` 判定。

2026-11-26 那一轮没有任何一项到第 4 步（会产生真实推理费用与账号操作），所以 19 项的 `state` 全部是 `unverified`，没有任何一项写成 `supported`。握手没有保留原始帧转储，下面的逐项摘要就是本轮证据本身；共享契约在 `src-tauri/src/adapters/contract.rs`。

采集环境：Windows 10.0.26300（x64），2026-11-26；命令来自 PATH 与本机安装目录，未启动模型、未读取账号凭据。上游依据取自当日 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`（46 项注册表）与各项目 README。

## 结论矩阵

「接入路径」列区分本机可执行文件（native）、厂商单独分发的组件（vendor）与第三方桥接（bridge）。「证据」列即 `AcpCapability::evidence`。「未装/不支持时原因」列是解析器在该状态下会返回的闭环 code。三列能力（对话／授权／停止）与「恢复」只记录声明级别，见矩阵后的图例。

| Agent | 接入路径 | 入口与版本 | 平台 | 目录/配置 | 对话 | 授权 | 停止 | 恢复 | 未装/不支持时原因 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | 原生（native） | `opencode acp` · 2.3.0 | Windows | `~/.config/opencode`、`~/.local/share` | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | — | handshake | unverified |
| Codex | 桥接（bridge） | `codex-acp` · 未安装（本机 `codex-cli 0.172.0` 不提供 ACP） | 未安装 | 未核对（`~/.codex`） | 未验证 | 未验证 | 未验证 | 未验证 | dependency-missing（桥接本身缺失）；未绑定所选安装时 identity-unresolved | documented | unverified |
| Claude Code | 桥接（bridge） | `claude-agent-acp` · 未安装（本机 `claude 2.1.332`） | 未安装 | 未核对（`~/.claude`） | 未验证 | 未验证 | 未验证 | 未验证 | dependency-missing（桥接本身缺失）；未绑定所选安装时 identity-unresolved | documented | unverified |
| Grok | 原生（native） | `grok agent stdio` · 1.0.77 | Windows | `~/.grok`（bin、sessions） | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | — | handshake | unverified |
| Pi | 桥接（bridge） | `pi-acp` · 未安装（本机 `pi 1.6.1`） | 未安装 | 未核对（`~/.pi`、`pi-acp/session-map.json`） | 未验证 | 未验证 | 未验证 | 未验证 | 缺宿主 pi 时 dependency-missing | documented | unverified |
| oh-my-pi | 原生（native） | `omp acp` · 19.2.1 | Windows | `~/.omp`（凭据根）、`~/.bun/bin` | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | — | handshake | unverified |
| Cursor | 原生 CLI（native） | `cursor-agent acp` · 未安装 | 未安装 | 未核对（`~/.cursor`） | 未验证 | 未验证 | 未验证 | 未验证 | not-installed（不回退到 `agent`） | documented | unverified |
| Kimi Code | 原生（native） | `kimi acp` · 2.7.0（仅 2.x） | Windows | `~/.kimi-code` | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | 1.x 报 version-unsupported | handshake | unverified |
| Qoder CN | 原生（native） | `qoderclicn --acp` · 1.1.94 | Windows | `~/.qoder-cn` | 握手声明 | 握手声明 | 协议必备 | loadSession（`sessionCapabilities` 未记录） | 不回退国际版 `qoder` | handshake | unverified |
| ZCode | 社区桥接（bridge） | `zcode-acp` · 未安装（Python 3.9+） | 未安装 | 未核对（`~/.zcode`、ZCODE_CJS） | 未验证 | 未验证 | 未验证 | 未验证 | dependency-missing（桥接 zcode-acp 缺失）；桥接在场但缺 Python/ZCode 引擎时启动失败并回传宿主原因 | documented | unverified |
| DeepSeek Harness | 原生（native） | `dsh acp` · 未安装 | 未安装 | 未核对（`~/.dsh`，沿用 profile 层） | 未验证 | 未验证 | 未验证 | 未验证 | not-installed | documented | unverified |
| CodeBuddy | 原生（native） | `codebuddy --acp` · 2.187.0 | Windows | `~/.codebuddy` | 握手声明 | 握手声明 | 协议必备 | loadSession（`sessionCapabilities` 未记录） | — | handshake | unverified |
| MiMo Code | 原生（native） | `mimo acp` · 0.1.15 | Windows | `~/.config`、`~/.local`（`@mimo-ai/cli`） | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | — | handshake | unverified |
| MiniMax Code | 原生（native） | `mcode acp` · 0.6.13 | Windows | `~/.minimax-code`、`~/.minimax`（sqlite 运行态） | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | — | handshake | unverified |
| Cline | 原生（native） | `cline --acp` · 未安装 | 未安装 | 未核对（`~/.cline`） | 未验证 | 未验证 | 未验证 | 未验证 | not-installed | documented | unverified |
| Devin | 原生（native） | `devin acp` · 3000.12.57 | Windows | `AppData/Local/devin/cli` | 握手声明 | 握手声明 | 协议必备 | loadSession（`sessionCapabilities` 未记录） | — | handshake | unverified |
| Command Code | 原生（native） | `cmdc acp`（Windows）/ `cmd acp` · 1.88.0 | Windows | `~/.commandcode` | 握手声明 | 握手声明 | 协议必备 | loadSession + resume 已声明 | 命中系统 shell 时 system-program | handshake | unverified |
| Antigravity | 厂商组件（vendor） | `agy_acp_server` · 组件未安装 | 未安装 | 未核对（组件目录；本机只有 `agy 1.5.9`） | 未验证 | 未验证 | 未验证 | 未验证 | 缺 ACP 组件时报 dependency-missing，不报缺 CLI | documented | unverified |
| Kiro | 原生（native） | `kiro-cli acp` · 3.5.0 | Windows | `~/.kiro` | 握手声明 | 握手声明 | 协议必备 | loadSession（`sessionCapabilities` 无 `resume`） | — | handshake | unverified |

**图例：声明 ≠ 已核实。**

- 「握手声明」= 本轮握手确实收到对应能力；documented 行全部「未验证」，只有上游注册表与文档。
- 停止（`session/cancel`）是协议必备项，握手只证明连接与初始化可用，本机没有真正取消过一轮。
- 「恢复」列只有两种声明级别，**没有任何一行写「是」或「已核实」**：
  - `loadSession + resume 已声明`：握手返回 `loadSession: true`，且 `sessionCapabilities` 也列出 `resume`（7 项：OpenCode、Grok、oh-my-pi、Kimi、MiMo、MiniMax、Command Code）。
  - `loadSession（…）`：握手只报告 `loadSession: true`；Kiro 的 `sessionCapabilities` 明确只列 list/close/delete/fork 而不含 `resume`，Qoder CN、CodeBuddy、Devin 的握手记录没有记下 `sessionCapabilities`，因此这几项只有 `loadSession` 一条依据。
  - `未验证`：本机没装，只有上游文档。
- **适配器静态声明与握手是两件事**：19 个适配器都写了 `capabilities.resume = true`（入口静态声明），其中 11 项在本机握手过、8 项没有。真实会话加载 0 项：没有一次 `session/load` 被观察，恢复后的首轮、原记录归属与失败文案都没有实证。把声明当成「已核实的恢复」会直接违反 R8 的记录要求。

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
- 重试方式（这里的「恢复」指把启动修好，不是 `session/load`）：`npm install -g @agentclientprotocol/codex-acp` 后重试；仍失败时用终端在同一目录启动。

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
- 重试方式（这里的「恢复」指把启动修好，不是 `session/load`）：装 Cursor CLI 后重试；否则用终端启动桌面编辑器或 CLI。

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
- 能力：只有 `loadSession: true` 一条依据；本轮握手记录没有记下 `sessionCapabilities`，因此 `resume` 是否在能力清单里出现未被观察，恢复仍需真实会话确认。
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
- 失败原因用闭环 code：`unsupported` / `not-installed` / `dependency-missing` / `version-unsupported` / `system-program` / `identity-unresolved`，每条都带可读原因。帮助链接只出现在依赖项与 identity 类（`AcpFailure::help` 取入口 `dependency.help_url`）；`unsupported` 与 `version-unsupported` 只有原因文本，`help` 为空。UI 据此显示具体缺口并保留终端回退。
- 注册表描述符新增 `acp` 字段，19 个适配器共用同一形状；共享设置与会话界面按字段渲染，不新增产品 ID 分支。
- **接线状态（T4 已接线）**：前端读取描述符的 `acp` 字段（`src/types/native.ts:129` 的 `AcpCapability`），不再按产品 ID 判断：
  - 新建会话对话框按 `acp.state` 渲染「启动方式」摘要：`supported` 照常显示「ACP 对话 · <工具>」与工作目录；`unverified` 仍可尝试，但另起一行写明「入口已声明，尚未完成真实会话验证」，并把入口的 `dependency`（如 `acp-bridge`）与实际安装提示一起显示；`unsupported` 或描述符没有 `acp` 时不声称可以对话，显示该适配器自己的 `reason`，禁用主启动按钮与 `Ctrl+Enter` 启动，只保留「改用终端启动」。
  - 设置行的启动方式是全局偏好，因此不按单个工具禁用；选中「ACP 对话」时读注册表统计并提示「可用性取决于所选工具：N 款工具可用 ACP 入口（其中 M 款入口已声明、尚未完成真实会话验证），K 款不支持，仍可用终端启动」。
  - 以上由 `tests/ui/workbench-acp.spec.ts` 的三条 fixture 驱动用例覆盖（`tests/ui/acpMock.ts` 的 `acp` 声明可按状态构造，与 T1 的 `acp_fixture` 语义一致，不按产品 ID 分支）：unsupported 显示原因且不宣称 ACP、可改终端；unverified 允许尝试并标注未验证；settings 行提示随注册表变化。

## 开发验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| ACP 契约与失败样例 | `cargo test --manifest-path src-tauri/Cargo.toml --lib acp` | 29 passed（`acp::tests` 20 项（当时模块名为 `acp_host`）+ 适配器 `acp_tests` 9 项，后者为 T1 新增） |
| 全量 Rust 测试（不排除） | `cargo test --manifest-path src-tauri/Cargo.toml` | 1761 passed / 12 failed / 36 ignored，12 项失败全部落在 `remote::uploads`（7）、`remote::transactions`（3）、`remote::twiglane_trust`（1）与 `external::tests::twiglane_workspace_handoff_url_is_validated`（1），见下一小节 |
| 交付原生命令（含排除） | 见「原生命令实际排除的用例」 | 库测试 1746 passed / 0 failed / 36 ignored / 27 filtered out，`twiglane_bridge` 集成二进制 0 passed / 1 filtered / 0 failed |
| Lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | 无警告、无错误 |

### 原生命令实际排除的用例

交付原生命令（见 `03-execution-plan.md#delivery_verification/native`）用 `--skip` 按模块前缀排除了 27 项（其中 12 项本机失败）和 1 条集成用例。它们都依赖本机不具备的环境前提，且不在本需求的改动路径上：

- `remote::uploads::tests`（7 项，含 `upload_files_moves_through_sftp_temp_and_atomic_claim`、`upload_session_files_records_claimed_paths_for_the_active_session`、`pending_upload_sweep_recovers_only_confirmed_absent_sessions`）：需要可用的 SFTP／远端上传通道。
- `remote::transactions::tests`（3 项：`failed_restore_can_retry_through_public_inspection_after_the_fault_is_removed`、`interrupted_partial_restore_keeps_a_durable_barrier_between_files_and_can_finish_later`、`restore_rejects_wrong_staging_hash_symlink_hardlink_and_destination_changes_without_overwrite`）：依赖远端事务目录与符号链接／硬链接语义。
- `remote::twiglane_trust::tests::windows_openssh_default_known_hosts_are_absolute_snapshot_operands`：本机 OpenSSH 配置给出多个 trust 候选，实测报 `ambiguous_known_hosts_paths`。
- `external::tests::twiglane_workspace_handoff_url_is_validated`：本机 Windows 绝对路径断言（`项目清单链接需使用本机绝对路径`）。
- `src-tauri/tests/twiglane_bridge.rs::desktop_exit_mode_resolves_only_current_enabled_targets_and_rejects_untrusted_uploads`：同一类 known_hosts 环境依赖（临时 `known_hosts` 带空格与多个 trust 文件时，本机解析为 `ambiguous_known_hosts_paths`，未排除时实测 FAILED），交付命令对这一条单独 `--skip`。同文件的 `missing_and_cancelled_session_passwords_do_not_connect` 是 `#[cfg(unix)]`，Windows 下不编译，所以该集成二进制在排除后显示 0 passed / 1 filtered。

本机没有 WSL、没有可用的 SFTP 目标，也没有一份干净的 OpenSSH 配置，因此这些用例只能在具备条件的目标上复核；本候选对 `src-tauri/src/remote`、`src-tauri/src/external.rs` 与 `src-tauri/tests/twiglane_bridge.rs` 零改动。两次运行各自的总数可以对上：库测试共 1809 项。不排除时 1761 passed / 12 failed / 36 ignored / 0 filtered out；交付命令的 `--skip` 按模块前缀过滤 27 项，其中 12 项是本机实测失败的用例、15 项是随同模块前缀一起被排除（整模块排除的范围大于单次失败清单，因此会带走同模块内本机本可通过的用例），1782 项进入运行，其中 1746 passed / 0 failed / 36 ignored，集成二进制 0 passed / 1 filtered。排除只改变了跑哪些用例，没有跳过任何本需求改动的模块（`launch`、`acp`（原 `acp_host`）、`workbench_restore`、`session_host`、`adapters`、`accounts`）。

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
- **恢复失败的实际行为（当前代码，未在真实会话实证）**：ACP 恢复先按协议 `session/load` 接回原会话；当 agent 报不支持、加载失败或没有协商出结果时，恢复流程保留**原记录**，关闭并移除**这次尝试新建的会话**（`crate::acp::close` + `forget`），再把失败原因写进恢复结果——面板显示恢复失败，用户可稍后重试，或从原目录新开一个对话。原记录不会被关闭，也不会被新会话顶替。
- **已知限制（P2，T3 范围内本轮未修）**：恢复失败的说明文案仍写「已在原目录新开一段会话（新会话 id）；原记录已保留，可稍后重试」，而同一分支随即关闭并移除了该会话，界面上给出的新会话编号已不存在。实际结果是「原记录保留、这次尝试的会话不存在」。位置：`src-tauri/src/workbench_restore.rs` 的 `conversation_resume_failure` 与 `restore_conversation_items` 失败分支。文案与行为与代码一致化不在 T1 范围。
- **ACP 对话中的秘密引用（T4 已统一，非终端路径）**：对话路径**都不做**终端的秘密准备。`src/lib/native.ts` 的 `launchCli` 只在 `request.interaction !== 'acp'` 时对 `initialPrompt` 调用 `localSessionPrompt`；新建会话对话框与资料库启动都显式带上解析后的 `interaction`，因此 ACP 首条提示不再走终端准备。工作台后续提示在对话分支同样跳过准备、原样发送（`src/features/sessions/SessionWorkbench.tsx` 的 `submitComposer`，对话时 `local = false`）。结果是：ACP 对话内 `{{cliora-secret:…}}` 原样发给 agent，宿主当前不解析它（`crate::acp` 的本地会话不带授权项），也不会泄露原值；终端路径完全不受影响。
- **ACP 宿主无秘密授权（T3 复核，P3）**：`src-tauri/src/acp/mod.rs`（原 `src-tauri/src/acp_host.rs`）的模块注释仍按设计意图描述「agent 通过本地会话令牌像终端一样访问 broker」，实际 `spawn_io` 用 `LocalSession::new()`（空授权表），子进程只得到会话令牌、不带授权。注释与行为的对齐属 T3 范围，本轮未改代码。
- **已知限制（T3 复核，非阻断）**：工作目录预检发生在 ACP 子进程 spawn 之后，而不是之前，因此一个不可用的目录会先留下一次失败的进程启动再报错；这不会误判成功，但诊断顺序与「预检在前」的期望不同。
- 本记录不含任何凭据、账号或提示词内容；握手只发送 `initialize`，不加载文件、不执行工具。

## 工作台接线与 T4 验收（2026-11-26）

本轮把 T3 的共享宿主接到界面上，只做**离线合成验证**：没有启动任何真实 agent，也没有运行模型对话，因此矩阵里的 19 项状态仍然全部是 `unverified`，下面的记录不是原生平台验收。

### 实际接线

- 设置 → 「终端与启动模式」新增「启动方式」（终端／ACP 对话），与终端类型、普通／YOLO、启动偏好各自独立。行里显示后端返回的实际值；保存失败显示真实原因并给出「重试」，重试仍用同一个选择；后端报告无法识别的已存值按终端显示并给出说明，且读取不会回写。切换只影响之后新建的会话，改回终端仍保留原来的外部终端与自定义命令。
- 工作台会话是原生对话面板而不是终端（`src/features/sessions/AcpConversation.tsx`）：消息流、流式增量、按 `toolCallId` 归并的工具卡片、绑定本次请求的授权卡、停止（`stopping`）与轮次结果（可继续／限额／拒绝／取消／断开／失败／未知）。侧栏、标题、任务状态与「等你处理」入口都由共享列表给出：待授权按 `approval` 计入需要人处理，运行中的轮次算工作，结束的会话没有退出码可显示。
- 会话状态由 `src/features/sessions/acpSession.ts` 的纯函数折叠：快照整体替换，增量按消息 id 追加，工具按调用 id 合并，授权按 `requestId` 增删，序号已在视图中应用过的事件不会重放；通知有界且不进入消息流。切换标签、分屏与重新挂载时用 `list_acp_sessions` / `acp_session` 补齐切换期间的输出，两个会话的内容互不串台。
- 首条提示只发一次：原生宿主在会话建立后提交 `initial_prompt`，界面从不再调用 `acp_prompt` 重发首条（用例直接断言 `acp_prompt` 未被调用）。
- 快捷输入与中断按会话类型路由：选中的是对话时，工作台输入框把文本交给 `acp_prompt`（不走 PTY 写入、不包装 bracketed paste；对话分支不做终端的秘密引用准备，首条提示也不再走该路径，见上文「未完成与限制」），中断按钮调用 `acp_cancel`；终端会话仍走原来的写入路径。
- 启动入口：工具、项目卡片、工作台新建与托盘最近项目都走同一选择；`workbenchSessionId` 现在同时识别 `session_started` 与 `acp_started`，因此从首页或托盘打开的对话会聚焦到同一个工作台会话。历史恢复按记录自身的类型分流：ACP 记录走协议的 `session/load`（失败行为见上文「未完成与限制」），终端记录仍按原来匹配终端输出的方式恢复。新建会话对话框在 ACP 时显示所选 CLI 与实际工作目录，并停用该入口无法表达的 YOLO 选项（后端同样会拒绝）。
- 失败恢复：对话框与面板都显示适配器的具体原因（缺桥接、YOLO 不可表达、Agent／会话参数不支持、项目模型覆盖等），并提供「新开一个对话」与「改用终端在此目录启动」两条明确路径，后者复用已创建的工作树与目录。

### 离线验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型检查与构建 | `npm run build` | 通过 |
| Node 单测（含新增折叠测试） | `npm run test:unit` | 303 tests / 297 passed / 6 skipped / 0 failed |
| 新增折叠测试 | `node --test tests/native/acp-session.test.mjs` | 8 passed |
| 合成 IPC 界面用例 | `node scripts/test-ui.mjs workbench-acp.spec.ts` | 9 passed |
| 相关终端回归 | `node scripts/test-ui.mjs terminal-settings.spec.ts workbench-terminal.spec.ts` | 149 passed（T4 本轮复跑，含设置行与工作台终端全部用例） |
| 工作台截图 | `node scripts/verify-ui-captures.mjs --skip-build --only workbench` | 见「截图」一节 |

新增界面用例在 `tests/ui/workbench-acp.spec.ts`，合成 IPC 在 `tests/ui/acpMock.ts`（`acp` 声明可构造为三种状态），覆盖：设置里选择 ACP（含保存失败与无法识别的已存值）；**按描述符能力渲染**——`unsupported` 显示适配器原因、不宣称 ACP、禁用主启动并可从同一对话框改用终端，`unverified` 允许尝试但标注未验证与入口依赖，设置行在「ACP 对话」下给出注册表统计的可用性提示；从工作台新建以 ACP 启动、首条提示只发一次、流式增量与重复序号去重、工具卡片按调用 id 归并、授权卡只回答自己的请求、停止与 `stopping`、失败原因与同目录终端回退、两个会话切换时的内容隔离、760px 窄窗口无横向溢出。

### 截图

工作台 ACP 对话面板与设置行由 `scripts/capture-product-ux.mjs`（`scripts/verify-ui-captures.mjs` 批量入口）生成，是浏览器合成 IPC 的图库，不是原生窗口。这些 PNG 按仓库现有约定不纳入版本控制，重跑同一条命令即可再生成：

- 设置「启动方式」（深/浅两套）：`docs/verification/product-ui-ux/pages/settings-launch-{light,dark}-1360.png`，命令 `node scripts/verify-ui-captures.mjs --skip-build --only pages`
- ACP 对话（默认图库里的一张）：`docs/verification/product-ui-ux/workbench/workbench-acp-conversation-dark-1360.png`，命令 `node scripts/verify-ui-captures.mjs --skip-build --only workbench`
- ACP 对话、授权卡（agent 发起）、审批卡（Cliora 发起，目录外访问）、停止中与 720px 窄窗口的完整一组：`docs/verification/product-ui-ux/workbench-acp/`，命令 `CLIORA_CAPTURE_OUT=docs/verification/product-ui-ux/workbench-acp node scripts/capture-workbench.mjs --only 'workbench-acp-*' --size all --theme all`（需要先运行 `npm run dev -- --port 14736`）

抓图不移动也不遮挡 Cliora 窗口；脚本自带的检查确认无横向溢出、无页面错误，但这些图片仍不是本机原生验收。

**T4 返修后沿用旧图的原因**：本轮只改新建会话对话框的「启动方式」摘要与设置行的 ACP 可用性提示。抓图脚本的 `get_launch_settings` 合成返回值不带 `interaction`（按终端处理），因此设置行的提示不出现、对话框的 ACP 摘要也不渲染，`settings-launch-*` 与 `workbench-acp-*` 的画面与旧图一致；把抓图覆盖改成 `interaction: 'acp'` 属于新一轮抓图范围，本轮未重跑，沿用现有图库并在此说明。

### 未实证

- **真实 agent 对话仍未运行**：上面所有面板行为都由合成帧驱动，没有一个真实 ACP 会话被启动过。授权弹窗的实际文案、停止后 agent 的真实反应、工具结果的实际形态都还只有协议侧依据。
- **恢复未实证**：原生会话加载、恢复失败后的关闭行为、恢复后再发首轮都还没有实测（另见上文「未完成与限制」）。
- **仅 Windows**：合成验证在 Windows 上用 Chromium 跑；macOS/Linux 的界面与宿主行为未验证。

## 客户端能力、YOLO 与真实 agent 抽样（2026-11-27）

本节记录「ACP 对话体验与客户端能力」一期（T1–T6）交付后的状态。宿主代码已从 `src-tauri/src/acp_host.rs` 拆到 `src-tauri/src/acp/`（`mod.rs`、`timeline.rs`、`capabilities.rs`、`client_fs.rs`、`terminal.rs`、`access.rs`、`elicitation.rs`、`prompt.rs`、`files.rs`、`history.rs`），调用方使用 `crate::acp::*`；目录边界判定是 `src-tauri/src/safe_fs.rs` 的 `safe_fs::resolve_target`（及 `resolve_target_protected`）。上文 2026-11-26 的记录保留原样，只把旧路径改成了现在的位置。

### 新增的客户端能力

`initialize` 现在发送 `clientInfo`，并在 `clientCapabilities` 中声明（`src-tauri/src/acp/capabilities.rs`）：

| 能力 | 声明 | 实现 |
| --- | --- | --- |
| 文件 | `fs.readTextFile`、`fs.writeTextFile` = true | `acp/client_fs.rs` 经共享 `safe_fs` 读取（行号与行数）与原子替换写入；目录内写入在时间线记一条带 diff 的 access 记录；目录外读写先出审批卡（允许一次 / 本会话都允许 / 拒绝）；Cliora 自身的应用数据目录在任何授权（含 YOLO）下都拒绝 |
| 终端 | `terminal` = true | `acp/terminal.rs`：create → output → wait_for_exit → kill / release，输出按 `outputByteLimit` 截断并置 `truncated`；带 `args` 或只给一个程序名时不经过 shell、直接启动解析出的程序；`args` 为空且 `command` 是含空白的整行命令（且整体不是一个可解析的程序路径）时经系统 shell 运行（见下文「ADR-9 修订」）；会话结束时结束进程树（Windows job object，Unix 进程组）；每会话终端数有上限 |
| 结构化提问 | `elicitation.form`（不声明 url） | `acp/elicitation.rs`：表单进入 pending，accept / decline / cancel 只回答一次；停止、断开或轮次结束后表单失效并回 cancel |
| 子 agent | `subagents` | `subagent_update` 登记子会话，子会话的更新、授权与客户端请求归属到该子会话 |

`mcpServers` 仍固定为 `[]`（需求 R12 排除项）。

### ADR-9 修订（用户决定 2026-11-27）

原 ADR-9 规定终端命令一律不经过 shell。真实抽样（见下文 F1）显示 Grok、CodeBuddy、Kiro、Devin 都把整行命令放在 `terminal/create.command`、`args` 为空，于是全部被拒。用户决定修订为：

- `args` 为空、`command` 含空白，且 `command` 整体不能解析为一个程序（含空格的完整路径仍按程序直接启动）时，经系统 shell 运行：Windows 复用既有命令解释器包装 `cmd /D /V:OFF /S /C "<整行>"`（`%COMSPEC%`），宿主只加最外层一对引号，`/S` 恰好去掉这一对，整行原样交给 cmd 解析一次，宿主不再做第二层转义；Unix 为 `/bin/sh -c <整行>`。整行含控制字符（换行等）时拒绝。
- 其余保持不变：带 `args` 的调用与单个程序名仍不经过 shell（`找不到要运行的程序` 的拒绝保留）；ACP 入口的 `rejects_system_program` 判定不变；目录外工作目录照常先出 execute 审批卡（YOLO 照常自动批准并记录）；环境规则（agent 自身的隔离环境、`CLIORA_SECRET_SESSION` 固定为本会话）、`outputByteLimit` 截断、kill / release 与会话关闭时结束进程树（shell 及其子进程同在 job object / 进程组内）、输出的代码页回退都不变。
- 时间线与审批卡显示 agent 发来的原始整行。
- 测试：`tests/launch/acp_client.rs` 的 `a_whole_command_line_without_args_runs_through_the_shell`（`echo cliora-acp-ok` 退出码 0 且输出含标记）、`a_command_with_args_never_goes_through_the_shell`、`a_shell_line_outside_the_directory_still_needs_an_execute_approval`（拒绝后不启动、允许一次后运行），以及按平台 `cfg` 的 `a_shell_line_on_windows_is_parsed_by_cmd_once`（`&` 串联、引号原样到达 echo、`exit /b 3` 的退出码）与 `a_shell_line_on_unix_runs_through_sh`（管道与 `exit 3`；本机为 Windows，Unix 用例只编译未运行）。

### 轮次内的协议错误（F2 修复）

`session/prompt` 的回应线程（`src-tauri/src/acp/mod.rs` 的 `begin_turn`）现在区分三种结局：

- agent 回了 JSON-RPC 错误（`RpcError.reply = true`）：轮次以 `failed` 结束，时间线加一条 `prompt_failed` 错误提示，内容为 agent 给出的原因（经 `redact`），会话保持 `ready`，可继续发送。
- 错误码为 ACP 的 auth_required（`-32000`）：先转入 `auth_required`（与 session/new 的路径同一个 `require_auth`，出现登录面板与 `auth_required` 提示），再以 `failed` 结束该轮；此时会话已经建立，登录成功后保留原协议会话，不再重新 `session/new`。
- 只有通道关闭或 agent 进程退出（本地错误）仍记为 `disconnected`。
- 前端：`acpTurnFailed` 文案改为「agent 返回了错误，本轮未完成，原因见上方提示；可以修改提示后再次发送。」；输入区在本轮以 `failed` 结束且输入框为空时放回本轮的提示与附件；登录面板出现时输入区只隐藏不卸载，草稿在登录后仍在。
- 测试：`tests/launch/acp_session_ops.rs` 的 `a_prompt_the_agent_answers_with_an_error_fails_the_turn_and_the_session_stays_ready`、`a_prompt_answered_with_auth_required_waits_for_a_login_that_keeps_the_session`；`tests/ui/workbench-acp-composer.spec.ts` 的 “a turn the agent answers with an error ends as failed …”。

### YOLO：19 个适配器均为 Client 型

适配器契约新增 `AcpEntry.yolo`（`AcpYolo::Client | Args | Mode`，`src-tauri/src/adapters/contract.rs`，TS 侧同步）。19 个 `fn acp` 全部声明 `AcpYolo::Client`（`grep "yolo: Some(AcpYolo::Client)" src-tauri/src/adapters/*/mod.rs` 为 19 处）：YOLO 不改变 agent 的启动参数或模式，由 Cliora 作为客户端自动批准——目录外访问直接放行并记录；`session/request_permission` 只自动选择 `allow_once`；**不回退到 `allow_always`**——请求里没有 `allow_once`（只有 `allow_always`，或没有任何允许类选项）时，YOLO 不替用户作答，照常出授权卡等用户选择（`src-tauri/src/acp/access.rs` 的 `yolo_option`；测试 `tests/launch/acp_client.rs` 的 `yolo_approves_outside_access_and_allow_once_and_still_shows_cards_without_one`，断言「YOLO 不回退到 allow_always」）。`launch.rs` 不再拒绝 ACP + YOLO。

### 分散的安全文件实现未迁移

本期只新增共享 `safe_fs` 供 ACP 使用。下列 4 处既有实现（祖先目录符号链接 / reparse 检查、有界读取、包含检查、原子写入）**没有迁移**，仍各自维护，迁移列为后续收敛项（避免顺带改动凭据和事务路径）：

- `src-tauri/src/resources/memory.rs`（reparse 检查、`read_entry_bytes_limited`、词法包含检查）
- `src-tauri/src/native/transaction.rs`（reparse 检查、非普通文件拒绝、原子写入）
- `src-tauri/src/accounts/context.rs`（reparse 检查）
- `src-tauri/src/history/mod.rs`（reparse 检查）

（`plugin_contents.rs` 的 canonicalize + starts_with 包含检查同样未改。）

### 真实 agent 抽样（2026-11-27）

用户确认可以产生少量推理费用后执行。抽样由仓库内的 Rust 测试驱动真实宿主 `crate::acp`：适配器解析入口 → 宿主 spawn → `initialize` → `session/new` → 真实 `session/prompt`；测试在 agent 的 stdio 两侧挂了只记方法名与选项类别的探针，不改变宿主行为。

- 测试：`tests/launch/acp_live.rs`（由 `src-tauri/src/acp/mod.rs` 以 `#[path]` 引入为 `acp::live_tests`），`#[ignore]`，且只在 `CLIORA_LIVE_ACP_TESTS=1` 时运行。
- 命令：`CLIORA_LIVE_ACP_TESTS=1 CLIORA_LIVE_ACP_AGENTS=all CLIORA_LIVE_ACP_REPORT=<临时目录>/cliora-live-acp-2026-11-27.json cargo test --manifest-path src-tauri/Cargo.toml --lib acp::live_tests -- --ignored --nocapture`（1 passed，100.5 s）；随后对并行运行时未解析到安装的 `qoder_cn,mimo_code,command_code` 串行补跑一次（24 s）。两次运行的 JSON 报告合并保存在 `docs/verification/acp-live-2026-11-27.json`（`agents` 为全量运行，`rerun` 为补跑）。
- 默认模式：`cargo test … --lib acp::live_tests` 显示 `ignored`；带 `--ignored` 但不设开关时输出 `live ACP sampling skipped: CLIORA_LIVE_ACP_TESTS is not 1` 并直接通过，不启动任何 agent。
- 每个 agent 两段会话、各一个极短提示，均在新建的临时目录（只含一个 `README.md`）里运行，从不在仓库里运行：
  1. 普通会话：「读取 README.md 第一行并原样回复」——出现授权卡时测试按用户的方式回答「允许一次」；
  2. YOLO 会话：「运行 `echo cliora-acp-ok` 并只回复输出」——由宿主自动批准。
- 报告只保留协议事实（方法名、更新类别、选项类别、≤240 字的回复摘录），不读取、不打印任何凭据；未登录或启动失败的 agent 只记录事实，没有替它登录。
- 环境：Windows 10.0.26300 x64，Rust 1.99.1，候选基于 `946e75b2`。

#### 结果

「fs 经客户端」「终端经客户端」指 agent 是否向 Cliora 发出 `fs/read_text_file`、`terminal/create`（探针计数），而不是 agent 自己读文件或开进程。「读 / echo」列是回复是否包含期望文本。

| Agent | 版本 | initialize 声明（loadSession · sessionCapabilities · image/embeddedContext · authMethods） | 模式 / 配置项 | session/new | 读 README | echo | 工具卡 / 计划 | fs 经客户端 | 终端经客户端 | 授权请求 | YOLO 自动批准 | 失败与协议不一致 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| oh-my-pi (`omp acp`) | 19.2.1 | true · list/resume/close · ✓/✓ · `agent` | default/plan · mode, model, thinking | 成功（8.2 s） | ✓ | ✓ | 有 / 无 | 是（1 次读取） | 是：create→output×4→wait_for_exit→release，经 `bash.exe -l -c` 退出码 0 | YOLO 1 次 | 1/1 选 `allow_once`（提供 allow_once/allow_always/reject_*） | 无 |
| Grok (`grok agent stdio`) | 1.0.92 | true · list/resume/close · ✓/✓ · `cached_token`、`grok.com` | 无模式 · model, reasoning_effort | 成功（6.6 s） | ✓ | 回复含 `cliora-acp-ok`，但 6 张执行卡全部失败，**回复没有执行依据** | 有 / 无 | 是（1 次） | 6 次，全部被拒：`command` 是整行命令（`echo cliora-acp-ok`、`pwsh -Command …`），执行器不经 shell | YOLO 2 次 | 2/2 选 `allow_once`（`allow_always` 排在第一位也未被选） | 终端不经 shell 不兼容；`agentInfo` 为空；大量 `_x.ai/*` 通知未处理（仅诊断） |
| CodeBuddy (`codebuddy --acp`) | 2.187.0 | true · 全部 false · ✓/✓ · `iOA`、`external`、`internal`、`selfhosted` | 7 种模式 · mode, model, thought_level, sandbox, multitask | 成功（20.3 s） | ✓ | ✓（客户端终端被拒后由 agent 自行执行） | 有 / 无 | 是（1 次） | 1 次，被拒（整行命令） | YOLO 1 次 | 1/1 选 `allow_once`（`allow_always` 在前） | 终端不经 shell 不兼容；`agentInfo` 为空 |
| Kiro (`kiro-cli acp`) | 3.5.0 | true · list/delete/close · ✓/✓ · `aws-builder-id`、`aws-iam-identity-center` | 10 种模式 · mode, model 等 6 项 | 成功（15.2 s） | ✓（终端被拒后改走 fs） | ✗：回复如实说明命令没有运行 | 有 / 无 | 是（1 次） | 普通 1 次、YOLO 2 次，全部被拒（`head -n 1 README.md`、`cmd /c echo …`） | 普通 1 次（测试答「允许一次」）、YOLO 2 次 | 2/2 选 `allow_once` | 终端不经 shell 不兼容；扩展请求 `_kiro/terminal/shell_type` 按未声明能力拒绝 |
| Devin (`devin acp`) | 3000.12.57 | true · list/delete/close（无 resume）· ✓/✓ · `devin-browser` | accept-edits 等 5 种 · mode, model, thought_level, speed | 成功（2.9 s） | ✓（终端被拒后改用搜索工具） | 回复含 `cliora-acp-ok`，但 4 张执行卡全部失败，**回复没有执行依据** | 有 / 无 | 否 | 普通 2 次、YOLO 4 次，全部被拒（整行命令） | 无 | 未触发（agent 默认模式不询问） | 终端不经 shell 不兼容 |
| OpenCode (`opencode acp`) | 2.3.0 | true · list/resume/delete/close · ✓/✓ · `opencode-login` | 无模式 · model, effort, mode | 成功（13.5 s） | ✓ | ✓ | 有 / 无 | 否（自行读取） | 否（自行执行） | 无 | 未触发 | 无 |
| MiniMax Code (`mcode acp`) | 0.6.13 | true · list/resume/close · ✓/✗ · 无 | default/plan · permissionMode, model, thinkingEffort | 成功（14.4 s） | ✓ | ✓ | 有 / 无 | 否 | 否 | 无 | 未触发 | 无 |
| Kimi Code (`kimi acp`) | 2.7.0 | true · list/resume/delete/close · ✓/✓ · `login` | default/plan/auto/yolo · model, thinking, mode | 成功（4.7 s） | ✗ | ✗ | 无 | 否 | 否 | 无 | 未触发 | 两个提示都被 `session/prompt` 以 “Authentication required: The API Key appears to be invalid or may have expired” 拒绝（本机凭据失效，未替它登录）；宿主把该轮记为 `disconnected`，会话仍为 `ready`，没有转入登录面板（见后续项 F2） |
| MiMo Code (`mimo acp`) | 0.1.15 | true · list/resume · ✓/✓ · `opencode-login`（自报 OpenCode 0.1.15） | build/plan/compose · model, mode（16 个模型） | 成功（10.7 s） | ✗ | ✗ | 无 | 否 | 否 | 无 | 未触发 | 两轮都立即以 `end_turn` 结束、没有任何回复或工具（只收到 usage 更新）；原因未查明（推测未配置可用模型/提供方），未改动其配置 |

上表是修复前（候选 `946e75b2`）的结果，保留原样；修复后的复测见下方「修复后复测」。

所有成功回复的会话都出现了工具卡；**9 个 agent 都没有为这两个小任务发送 `plan`**，计划的真实形态仍只有合成验证。标题（`session_info_update` 带 title）出现在 Kimi、CodeBuddy、Kiro、Devin；用量出现在除 Grok、Kiro 外的 7 个。

未进入会话的 10 个适配器（启动前由适配器解析给出的原因）：

| Agent | 结果 |
| --- | --- |
| Codex 0.172.0 | `dependency-missing`：未找到 `codex-acp` |
| Claude Code 2.1.332 | `dependency-missing`：未找到 `claude-agent-acp` |
| Pi 1.6.1 | `dependency-missing`：未找到 `pi-acp` |
| ZCode 3.19.1 | `dependency-missing`：未找到 `zcode-acp` |
| DeepSeek Harness | `not-installed`：未找到 `dsh` |
| Cursor 3.30.14 | `not-installed`：未找到 `cursor-agent` |
| Cline、Antigravity | 启动探测未发现可用安装 |
| Qoder CN、Command Code | 启动探测（`probe_registered_launch`，未带自定义路径）两次都报告没有可用安装，而 `qoderclicn --version`（1.1.94）与 `cmdc --version`（1.88.0）单独执行 2–3 s 即返回；MiMo 在 19 路并行时同样未解析、串行补跑时解析成功。原因未查明，列为后续项 F5 |

#### 修复后复测（2026-11-27，修复后）

ADR-9 修订与 F2 修复之后，只对受影响的 5 个 agent 复测一次（用户已确认推理费用）：`CLIORA_LIVE_ACP_TESTS=1 CLIORA_LIVE_ACP_AGENTS=grok,codebuddy,kiro,devin,kimi_code CLIORA_LIVE_ACP_REPORT=<临时目录>/cliora-live-acp-2026-11-27-after-fix.json cargo test --manifest-path src-tauri/Cargo.toml --lib acp::live_tests -- --ignored --nocapture`（1 passed，37.9 s；Kimi 的适配器 id 是 `kimi_code`）。报告并入 `docs/verification/acp-live-2026-11-27.json` 的 `afterFix`（`agents`、`rerun` 仍是修复前的记录，`note` 字段说明了区别）。基线为 `f0cbc019` 加本轮工作区改动。

| Agent（修复后） | 读 README | echo | 客户端终端（命令 → 退出码） | 授权 / YOLO | 结论 |
| --- | --- | --- | --- | --- | --- |
| Grok | ✓（fs 读取 1 次） | ✓，有执行依据 | YOLO：`echo cliora-acp-ok` → 0，输出含标记 | 无授权请求 | 终端可用；修复前 6 次全部被拒 |
| CodeBuddy | ✓（fs 读取 1 次） | ✓ | YOLO：`echo cliora-acp-ok` → 0，输出含标记 | YOLO 1 次，选 `allow_once`（`allow_always` 在前） | 终端可用 |
| Kiro | ✓（`head` 失败后改走 fs） | ✓ | 普通：`head -n 1 README.md` → 1（Windows 的 cmd 没有 `head`，经 shell 正常运行并如实返回退出码）；YOLO：`echo cliora-acp-ok` → 0，输出含标记 | 普通 1 次（测试答「允许一次」）、YOLO 1 次选 `allow_once` | 终端可用；`_kiro/terminal/shell_type` 仍按未声明能力拒绝 |
| Devin | ✓ | ✓ | 普通：`head -n 1 README.md` → 1，随后 `powershell -Command "Get-Content README.md -TotalCount 1"` → 0；YOLO：`echo cliora-acp-ok` → 0，输出含标记 | 普通 1 次，测试答「允许一次」 | 终端可用；回复有执行依据 |
| Kimi Code | ✗ | ✗ | 未调用 | 无 | 两段会话的 `session/prompt` 都回 auth_required（“The API Key appears to be invalid or may have expired”）：轮次原因为 `failed`、会话转入 `auth_required`、出现 `auth_required` 提示（登录面板），不再记为 `disconnected`；仍未替它登录 |

#### 抽样得到的问题与后续项

- **F1 已修复（修复后）**：见上文「ADR-9 修订」与「修复后复测」；Grok、CodeBuddy、Kiro、Devin 的整行命令均经 shell 运行，`echo` 均退出码 0。以下为修复前的原始记录。
- **F1 终端不经 shell，与多数 agent 的用法不兼容（P1 级发现）**：Grok、CodeBuddy、Kiro、Devin 都把整行命令放在 `terminal/create` 的 `command` 字段（`args` 为空），执行器按「不经过 shell」把整行当成程序名，回复「找不到要运行的程序：…（不经过 shell，请给出程序名或完整路径）」。只有 oh-my-pi 显式包了 `bash.exe -l -c`，完整走通。结果是 4/9 个 agent 的客户端终端实际不可用（agent 要么自行执行、要么放弃，Grok 与 Devin 甚至在执行全部失败时给出了期望文本）。是否改为在 `args` 为空时经平台 shell 运行，涉及 ADR-9 的安全取舍，需要单独决定，本期未改。
- **F2 已修复（修复后）**：见上文「轮次内的协议错误」；Kimi 复测转入 `auth_required`，轮次原因为 `failed`。以下为修复前的原始记录。
- **F2 轮次内的协议错误被记成「连接断开」**：`session/prompt` 返回 JSON-RPC 错误时（Kimi 凭据失效），宿主把轮次原因记为 `disconnected`，界面会显示「与 agent 的连接已断开」，而会话实际仍为 `ready`；轮次内的 auth_required 也没有转到登录面板。应区分 `failed` 与断开，并把认证错误引到登录流程。
- **F3 回复没有执行依据**：Grok、Devin 在所有执行卡失败时仍回复了期望输出。宿主如实显示失败的工具卡，这是 agent 行为，记录在案。
- **F4 厂商扩展**：`_x.ai/*`、`_cognition.ai/*`、`_kiro/*`、`_codebuddy.ai/*` 通知只进诊断；`_kiro/terminal/shell_type` 请求按未声明能力拒绝。功能未受影响。
- **F5 启动探测**：Qoder CN、Command Code 本机可执行但启动探测未发现可用安装；并行时 MiMo 也未解析。需要检查这三个适配器的候选路径与版本身份判定。
- **F6 MiMo 无回复**：两轮均立即 `end_turn` 且无内容。
- **YOLO 只用 `allow_once`（已实证）**：6 次自动批准全部选择 `allow_once`，其中 3 次 `allow_always` 排在选项首位也没有被选；没有出现缺少 `allow_once` 的请求，因此「只有 `allow_always` 时不自动选择、照常出授权卡」与「没有允许项时照常出卡」两条分支仍只有单元测试证据（YOLO 不回退到 `allow_always`）。
- **授权卡（普通会话）**：只有 Kiro 在普通会话里发了授权请求，测试按「允许一次」答复后轮次正常完成；Cliora 的目录外审批卡（access）本轮没有触发（任务都在会话目录内），其真实形态只有合成验证与截图。

### 已知限制与后续项

1. **已经是 UTF-8 的输出不再二次解码**：终端输出按 UTF-8 增量解码；在 Windows 上遇到第一个非法 UTF-8 序列后，其余部分改按控制台（OEM）代码页解码，但切换前已按 UTF-8 读出的文本保持原样、不再回头重解（`src-tauri/src/acp/terminal.rs`）。一段输出若前半恰好是合法 UTF-8 的代码页字节，这部分会显示为错误字符。
2. **登录后首个提示失败时，原生会话 id 只在下一次 checkpoint 刷新**：认证成功后建立的原生会话若紧接着的提示失败，`workbench_restore` 记录中的 native id 要到下一次 checkpoint 才更新；在此之前重启恢复会用旧值。
3. **Unix 路径未在原生平台运行**：safe_fs 的 Unix 设备路径判定与终端按进程组结束只有 `#[cfg(unix)]` 测试，本期只在 Windows 上编译与运行，没有在 macOS/Linux 上实际执行这些测试。
4. **02 方案文档与代码命名不一致**：`02-technical-solution.md` 仍写 `resolve_within` 与旧的 `acp_host`（以及 `acp_terminal`、`acp_client_fs`）路径；实际代码是 `safe_fs::resolve_target`（`resolve_target_protected`）与 `crate::acp`（`src-tauri/src/acp/`）。本文档已改用实际名称。
5. **输入法组字与原生拖放只用合成事件验证**：组字期间 Enter 不发送、原生拖入图片与文件都只在 Playwright（Chromium）中以合成事件测试，没有在真实 WebView2 / WKWebView 中验证。
6. **读图期间刷新会留下 pending 卡**（T5 复核 P3）：拖入目录外图片、审批卡仍在等待时重新加载页面，该卡保持 pending；`withdrawAbandoned` 在 IPC 失败后不重试撤回。
7. **「手动改名的标题保持不变」无法验证**（R3）：工作台没有对任何会话手动改名的功能，侧栏标题取 `titles.get(id) ?? conversation.info.title`，这一项只因不存在手动名称而成立，验收无从执行。
8. **`remote::*` 与 `external::twiglane` 的 12 项环境失败与本次改动无关**：见上文「原生命令实际排除的用例」，本期对这些模块零改动。
9. 真实抽样暴露的 F1–F6 见上一小节，其中 F1、F2 已修复（修复后），F3–F6 仍为后续项。另外，`acp::tests` 中的 `the_child_receives_its_own_secret_session_token` 与 `frames_split_across_writes_are_reassembled_and_coalesced` 在 `--lib acp::` 并行运行时偶发失败；在未改动的 `946e75b2` 上 5 次运行复现 1 次，单独运行 `acp::tests::` 3 次均通过，属既有的并发脆弱性。
10. **子 agent 条目只有宿主侧测试**（R3）：子会话的更新、授权与客户端请求归属只有 Rust 宿主测试；时间线里可展开的子 agent 条目（`AcpTimeline` 的 `details[data-state]`）有渲染，但没有 Playwright 用例。
11. **秘密原值的桌面审批没有 ACP 端到端验证**（R10）：ACP 终端只把本会话自己的 `CLIORA_SECRET_SESSION` 令牌传给子进程，取原值仍经未改动的秘密 broker 与其桌面审批；YOLO 不触达 broker。这一结论依赖 broker 与会话令牌的既有设计，本期没有针对 ACP 会话的端到端检查。

### 截图

ACP 场景由 `scripts/capture-workbench.mjs` 生成（Playwright + 合成 IPC，不是原生验收）。此前已有对话、授权、停止中、窄窗口、输入区、slash、附件、拖入、登录、表单、历史（含不支持）等场景；本期新增：

- 空会话（`empty`）；
- 长对话（`long`，含代码块、表格、列表与链接）；
- 工具与 diff（`tools`：读取、搜索、编辑、目录内写入记录、失败的获取、内嵌终端输出与「终止」、进行中的计划与用量；`diff` 展开编辑卡的 diff，并出现「回到最新」）；
- YOLO 徽标与自动批准记录（`yolo`）；
- 断开（`disconnected`：agent 退出、轮次原因为断开、诊断与只读输入框）；
- 审批卡（`access`，T6 返工新增）：本轮仍在运行（`waiting_permission`、显示「停止」、没有轮次结束条目），一次读取会话目录外文件 `D:\shared\tokens.css` 的 Cliora 审批卡等待「允许一次 / 本会话都允许读取 / 拒绝」，会话栏显示一个已授予、可点击撤销的「本会话已放行写入」徽标，时间线里保留对应的「已允许（本会话）」写入记录与 diff。

两种卡片要分开看：**授权卡**是 agent 通过 `session/request_permission` 发起的，按钮来自 agent 给出的选项（`permission` 场景：允许一次 / 总是允许 / 拒绝）；**审批卡**是 Cliora 作为客户端对会话目录外的读、写或执行发起的，按钮固定为允许一次 / 本会话都允许 / 拒绝（`access` 场景）。此前图库只有授权卡；`permission` 场景也不再在等待中的授权卡下方显示「本轮结束」。

| 图库 | 命令 | 结果 |
| --- | --- | --- |
| 默认工作台图库（含 `workbench-acp-conversation`、`workbench-acp-tools`） | `node scripts/verify-ui-captures.mjs --only workbench` | passed，12 张，0 项失败（无横向溢出、无页面错误），输出 `docs/verification/product-ui-ux/workbench/` |
| ACP 全部场景，深浅两套 × 1360 / 720 | 先 `npm run build` 并启动 `vite preview`，再 `CLIORA_PREVIEW_URL=<预览地址> CLIORA_CAPTURE_OUT=docs/verification/product-ui-ux/workbench-acp node scripts/capture-workbench.mjs --only 'workbench-acp-*' --size 1360,720 --theme all` | 74 张（19 个场景 × 深浅 × 两种宽度，窄窗口场景只在 720），0 项横向溢出、0 项页面错误、0 项动作失败，输出 `docs/verification/product-ui-ux/workbench-acp/`（`index.html` 为图库）。T6 返工重跑时第一次有 1 项动作超时（`workbench-acp-attach-light-1360` 的 `locator.click`，其余 3 张 attach 正常），立即整组重跑全部通过，图库与清单取自重跑 |

人工抽查了 tools、diff、yolo、empty、long、disconnected、permission、login、slash、attach 在两种主题、1360 与 720 下的画面：长路径和 diff 不撑宽窗格；720 下计划、授权卡与输入区完整可见；T6 返工另外人工查看了 `access` 的四张图（深浅 × 1360 / 720）：审批卡的三个按钮「允许一次」「本会话都允许读取」「拒绝」、「本会话已放行写入」徽标、「1 项等你处理」与「停止」均完整可见，720 下没有横向溢出；断开后输入框显示「对话已结束，不能再输入」。

**这两个图库（`product-ui-ux/workbench/` 的 12 张与 `product-ui-ux/workbench-acp/` 的 74 张 PNG）只保存在本地，不入库**：`docs/verification/*` 按 `.gitignore` 默认忽略，本期没有为它们放行，提交里没有这些图片；需要查看时用上表的命令重新生成。真实抽样报告 `docs/verification/acp-live-2026-11-27.json` 已在 `.gitignore` 中显式放行（`!docs/verification/acp-live-2026-11-27.json`），随提交保存；该报告只含协议事实，不含凭据。
