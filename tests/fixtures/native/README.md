# Desensitized native configuration fixtures

These files model the CLI versions installed on the Windows development host on 2026-09-29: Codex 0.158.0, Claude Code 2.1.283, Grok Build 1.0.41, Pi 0.87.1, and OpenCode 1.18.33. The 2026-10 default-off additions add sanitized native fixtures for ZCode 3.14.4 (`zcode-3.14.4.json`, `setting.json` shape), Qoder 1.1.63 (`qoder-1.1.63.json`), Kimi Code 0.31.1 (`kimi-code-0.31.1.toml`, desensitized from the real `config.toml` with the model list trimmed), DeepSeek Harness 0.2.0-rc.2 (`dsh-0.2.0-rc.2.yml`, the machine-verified sequence-shaped `cordis.patch.yml`; MCP insertion follows the bundled dsh-app-boot reader) and CodeBuddy 2.161.1 (`codebuddy-2.161.1.json`, OAuth user-level `settings.json` shape). None contain real credentials or user paths. The ignored live version-probe test can be run on that host without reading its private configuration.

The native fields and file roles are based on primary documentation:

- [Codex configuration](https://developers.openai.com/codex/config-reference)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Grok Build settings](https://docs.x.ai/build/settings)
- [Pi custom models](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [Pi startup model settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- ZCode desktop sources: [zai-org/ZCode](https://github.com/zai-org/ZCode) (paths and `setting.json` shape)
- [Qoder CLI settings reference](https://docs.qoder.com/cli/settings-reference)
- [Kimi Code configuration](https://www.kimi.com/code/docs/configuration/config-files)
- DeepSeek Harness desktop sources: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`cordis.patch.yml` patch layer)
- [CodeBuddy CLI reference](https://www.codebuddy.ai/docs/zh/cli/codebuddy-dir)
- MiMo Code open sources: [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) 0.1.15 (`mimocode.jsonc`/`tui.json` shapes, `mcp`/`agent`/`skills` config keys)
- Cline open sources: [cline/cline](https://github.com/cline/cline) @main 2026-10-07 (`global-settings.json`, `cline_mcp_settings.json` top-level `mcpServers`; `providers.json` plaintext keys are cited as the reason that file never enters the managed surface)
- Devin 3000.11.3: local verified install (`--help`, config/transcript layout inspection; `mcp_config.json` shape probed via `devin mcp add` with native state restored)
- Command Code 1.73.4: locally verified npm `command-code` install plus shipped-bundle constants (`config.json`/`settings.json`/`mcp.json`; Windows resolves the `cmdc` alias shim)
- Antigravity 1.3.1: local read-only probes (`agy --version`/`--help`, on-machine `config/mcp_config.json`); settings/data layout otherwise third-party reverse-engineered (codeburn against agy 1.2.x)
- Kiro: official docs (cli.kiro.dev command surface) plus community reverse engineering (agentsview/threadle) and a real local `kiro-cli` data root (`%LOCALAPPDATA%\kiro-cli`)

Fixtures verify parsing and preservation of unrelated fields/comments. They do not prove that every CLI version accepts every generated provider combination; live CLI behavior needs separate versioned integration evidence. The `cordis.patch.yml` fixture was constructed from the official plugin documentation without a machine sample; its list-shaped `insert` items are rejected fail-closed by validation until a real sample verifies them.

The 2026-10-07 default-off additions add native fixtures for six clients with per-client evidence levels: `mimo-code-0.1.15.json` and `cline-3.0.json` are synthetic per the source-derived schemas ([src] official open-source repos above — neither CLI is installed locally, so unpinned shapes stay conservative read-only); `devin-3000.json`, `command-code-1.73.json`, `antigravity-cli-1.3.json` and `kiro-cli.json` follow the locally verified/official-doc/[RE] evidence mix recorded in the bullet list. None contain credential material: `auth.json`, `credentials.toml`, `providers.json` and keyring state are product-owned and never fixture-captured.
