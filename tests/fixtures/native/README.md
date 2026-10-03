# Desensitized native configuration fixtures

These files model the CLI versions installed on the Windows development host on 2026-09-29: Codex 0.158.0, Claude Code 2.1.283, Grok Build 1.0.41, Pi 0.87.1, and OpenCode 1.18.33. The 2026-10 default-off additions add sanitized native fixtures for ZCode 3.14.4 (`zcode-3.14.4.json`, `setting.json` shape), Qoder 1.1.63 (`qoder-1.1.63.json`), Kimi Code 0.31.1 (`kimi-code-0.31.1.toml`, desensitized from the real `config.toml` with the model list trimmed), DeepSeek Harness 0.2.1 (`dsh-0.2.1.yml`, the desktop profile `cordis.patch.yml` patch layer) and CodeBuddy 2.161.1 (`codebuddy-2.161.1.json`, OAuth user-level `settings.json` shape). None contain real credentials or user paths. The ignored live version-probe test can be run on that host without reading its private configuration.

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

Fixtures verify parsing and preservation of unrelated fields/comments. They do not prove that every CLI version accepts every generated provider combination; live CLI behavior needs separate versioned integration evidence. The `cordis.patch.yml` fixture was constructed from the official plugin documentation without a machine sample; its list-shaped `insert` items are rejected fail-closed by validation until a real sample verifies them.
