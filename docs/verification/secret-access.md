# 提示词秘密引用：MCP 与 CLI 回退验收（2026-11-21）

范围：R10（模型能够发现并使用正确入口）。本记录把三类事实分开：**适配器拥有的原生配置映射**、**协议健康（`initialize` + `tools/list`）**、**真实模型的工具调用与 CLI 回退**。配置写入成功不等于协议通过，协议通过也不等于模型调用成功。

## 当前结论

矩阵列出全部声明了原生 MCP 配置映射（`CliAdapter::supports_mcp`，本仓库 19 个已注册 CLI 全部声明）的目标。「配置映射」列是验收记录 `mapping` 字段使用的标签：相对 home 的配置路径，加 `#` 顶层表（必要时再点出子表）；`[c]` 表示 `.json` 或 `.jsonc`，`XDG_CONFIG_HOME` 等原生覆盖仍由适配器拥有。标签来自适配器的 `mcp_location` 声明，不是文件契约本身，也不等于已经写入成功——原生路径与格式见 [技术参考](../reference.md)。

| 目标 | 配置映射 | 协议 | 模型调用 | CLI 回退 | 平台 | 验证状态 |
| --- | --- | --- | --- | --- | --- | --- |
| antigravity | `.gemini/config/mcp_config.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| claude_code | `.claude.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | macOS arm64（记录环境）；Windows 未验证 | unverified |
| cline | `.cline/cline_mcp_settings.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| codebuddy | `.codebuddy/.mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| codex | `.codex/config.toml#mcp_servers` | 未实机运行 | 未实机运行 | 未实机运行 | macOS arm64（记录环境）；Windows 未验证 | unverified |
| command_code | `.commandcode/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| cursor | `.cursor/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| deepseek | `.dsh/profiles/desktop/cordis.patch.yml#insert` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| devin | `.config/devin/mcp_config.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| grok | `.grok/config.toml#mcp_servers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| kimi_code | `.kimi-code/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| kiro | `.kiro/settings/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| mimo_code | `.config/mimocode/mimocode.jsonc#mcp` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| minimax_code | `.minimax/mcp.json#mcpServers`（数据目录已存在时） | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| omp | `.omp/agent/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| open_code | `.config/opencode/opencode.json[c]#mcp`（≥2.0 为 `#mcp.servers`） | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| pi | `.pi/agent/mcp.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| qoder_cn | `.qoder-cn/settings.json#mcpServers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |
| zcode | `.zcode/cli/config.json#mcp.servers` | 未实机运行 | 未实机运行 | 未实机运行 | 未验证 | unverified |

`unverified` 的含义：适配器拥有可写的 MCP 配置映射，但**真实 CLI 的 `initialize`、`tools/list` 和模型 `use_secret` 调用尚未被观察**。因此 `SecretMcpCapability` 保持 `unverified`，界面同时给出 CLI 回退说明；`supported` 只能由 `src-tauri/src/adapters/secret_access.rs` 里一条完整的验收记录发布，目前该记录列表为空。映射存在、写入成功或工具契约离线检查通过，都不升级为兼容性证据。

数据目录尚未存在的目标（`minimax_code` 需要 `~/.minimax` 已存在，`open_code` 的 `mcp` 子表形状随主版本变化）在真机验收前要先确认目录与版本：缺少目录或版本不支持时 `mcp_location` 返回空，安装步骤应报「该目标未提供配置映射」，而不是写入别处。

## 每目标要记录的四类事实

1. **原生配置写入**：该 CLI 的原生文件里存在条目 `cliora-secrets-<toolId>`，命令是当前可执行文件、参数是 `--cliora-internal-secret-mcp-v1 --installation <安装标识>`，不含任何秘密值。写入由 T3 的共享 preview/commit/CAS 流程完成，适配器拥有路径与格式。
2. **协议健康**：用真实客户端对真实 helper 完成协议协商与工具发现，必须看到 `list_secrets`、`list_secret_executors`、`use_secret`、`read_secret`。健康记录按「目标 + 安装标识」保存，写入会使其失效（`src-tauri/src/secrets/mcp.rs`）。
3. **模型调用**：在只含 `{{cliora-secret:<id>}}` 引用与执行入口标识的提示词下，模型选择 `use_secret` 并生成 `secretId`/`executorId` 参数；固定测试执行入口收到合成值，模型可见输出只有业务结果与遮蔽标记。原值读取仍触发 Cliora 逐次确认。
4. **CLI 回退**：同一提示词下，`--cliora-internal-secret-cli-v1 --installation <id> use --secret <id> --executor <id>` 让同一个测试执行入口收到同一合成值，输出同样遮蔽。

只有四类事实全部观察到的目标才能在 `src-tauri/src/adapters/secret_access.rs` 的 `ACCEPTANCES` 增加验收记录并发布 `supported`。记录必须写明 `tool_id`、`mapping`、日期（`YYYY-MM-DD`）、平台、CLI 版本、协议、模型调用、CLI 回退和证据锚点；证据锚点必须位于 `docs/verification/` 下，`mapping` 必须与上表该目标的映射标签逐字一致（`node scripts/verify-secret-access.mjs` 的 `evidence-consistency` 检查会比对）。缺任何一项时 `published()` 仍返回 `unverified`；未声明映射的适配器即使被记录也发布 `unsupported`。当前 `ACCEPTANCES` 为空，所以任何目标都不能以 `supported` 发布。

## 验证命令

离线（确定性、零费用，不启动 AI CLI、不调用模型）：

```sh
node scripts/verify-secret-access.mjs
node scripts/verify-secret-access.mjs --json
```

离线检查覆盖：提示词只有合成引用；合成元数据没有取值字段；CLI 回退文本由本机元数据生成且 `use` 命令可直接执行；工具契约（`tests/fixtures/secret-access/mcp-tools.json`，由 Rust 测试与真实 rmcp 服务对齐）不接受取值类输入；本地测试替身经环境变量与标准输入收到合成值、回执只保存摘要、缺少值时失败关闭；本文档的逐目标状态与适配器验收记录一致。

实机（显式启用，可能产生推理费用）：

```sh
export CLIORA_LIVE_SECRET_TESTS=1
export CLIORA_LIVE_SECRET_PLAN=/abs/path/secret-access-plan.json
export CLIORA_LIVE_SECRET_TOOLS=claude_code,codex     # 可选：限定本次运行的目标
export CLIORA_LIVE_SECRET_CANARY=canary-<synthetic>   # 只接受 canary- 前缀
node scripts/verify-secret-access.mjs --live
```

计划文件由操作者按目标提供，脚本不复制适配器的原生路径或启动命令：

```json
{
  "helper": "/Applications/Cliora.app/Contents/MacOS/Cliora",
  "installationId": "<安装标识 uuid>",
  "secretId": "<秘密标识 uuid>",
  "executorId": "<执行入口 uuid>",
  "receiptPath": "/tmp/cliora-secret-receipt.json",
  "targets": [
    {
      "toolId": "claude_code",
      "cliVersion": "2.x.y",
      "versionCommand": ["claude", "--version"],
      "printCommand": ["claude", "-p"],
      "printStdin": true,
      "mcpConfigPath": "/Users/<user>/.claude.json",
      "mcpEntryName": "cliora-secrets-claude_code"
    }
  ]
}
```

退出码：`0` 全部通过；`1` 有检查或目标失败；`2` 用法错误；`3` 请求了 `--live` 但没有 `CLIORA_LIVE_SECRET_TESTS=1` 或计划不可用。`CLIORA_SECRET_EVIDENCE_OUT` 可指定写入的机器可读结果路径；结果只含目标、步骤、平台、状态与原因，不含合成值。

运行实机前置（均在真实桌面环境完成，不在普通单元或浏览器测试里）：

1. 在资料库「秘密引用」创建**合成**秘密，值形如 `canary-...`；登记 `tests/fixtures/secret-access/executor-double.mjs` 为执行入口（`node <绝对路径> --channel env --env-name CLIORA_TEST_SECRET --receipt <receiptPath>`），并把该秘密绑定到该入口。
2. 在工具工作区为该 CLI 写入秘密 MCP 条目并建立安装标识，把两者写入计划文件。
3. 让该 CLI 使用带该 MCP 条目的配置启动一次交互会话，确认 `initialize`/`tools/list`；随后按上面的命令运行 `--live`。
4. 把结果填进上表，并把通过的目标写进 `src-tauri/src/adapters/secret_access.rs` 的 `ACCEPTANCES`，同时在 `docs/verification/` 附加原始观察（命令、退出码、涉及的工具名与遮蔽标记，不粘贴原值）。

## 本次实际执行（2026-11-21，macOS arm64 开发机）

| 命令 | 结果 | 能证明什么 |
| --- | --- | --- |
| `node scripts/verify-secret-access.mjs` | 6 项通过、实机项 skipped、退出码 0 | 离线契约：引用语法、合成元数据、回退命令、工具契约、文档一致性、测试替身两条通道与失败关闭 |
| `node --test tests/native/secret-access.test.mjs` | 5 个测试通过 | 离线检查不需要 CLI 或模型；实机计划只接受 `canary-` 合成值与绝对路径；文档与记录不一致会失败 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- secrets:: --test-threads=1` | 63 个通过 | 秘密引用、执行入口、审批、审计、代理与本机 IPC 的既有行为 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- adapter_contract_tests` | 22 个通过 | 能力闸门、工具契约 fixture 与真实 helper 一致、本文档矩阵与注册表一致 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 无告警 | 新增/修改 Rust 代码 |
| `npm run build` | 通过（仅既有 chunk 体积提示） | 前端类型与构建未被文档或类型改动破坏 |

`--live` 驱动本身只在本地合成替身（假 MCP helper、假 CLI、临时配置目录）上跑通过一次：通过时退出码 0，缺 `CLIORA_LIVE_SECRET_TESTS` 或非 `canary-` 取值时退出码 3，合成值进入模型可见输出时判为失败、退出码 1 且证据文件里没有原值。**这是脚本分支的管道验证，不是任何真实 CLI 或模型的验收**，因此上表仍全部是 `unverified`。

## 限制

- 本记录只有代码事实与合成验证；**没有任何真实 CLI 或真实模型的通过证据**，包括 macOS。Windows 与 Linux 的原生配置写入、CLI 启动与协议均未验证。
- 模型可能选择其他工具、改写参数或在输出里复述别的内容；一次成功不能证明稳定可用，失败也不自动等于适配器缺陷，需要按目标重复观察。
- 遮蔽是文本层面的保护，不阻止获授权脚本主动外发（R9）。工具发现不等于授权：每次执行仍受绑定与授权约束，原值读取仍逐次确认（R3、R4）。
- 矩阵按当前注册表的 19 个 CLI 统计（全部声明 `supports_mcp`）。新增适配器只要声明 MCP 映射，默认能力就是 `unverified`，必须另有一条完整验收记录才能发布 `supported`；`tests/adapter/sixth.rs` 的 `the_verification_document_lists_exactly_the_targets_that_declare_a_mapping` 会要求本表与注册表同步增删。
- 本记录不包含真实密钥、私有原生配置或会话内容；所有标识与别名均为合成值。
