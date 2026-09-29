# Desensitized native configuration fixtures

These files model the CLI versions installed on the Windows development host on 2026-09-29: Codex 0.158.0, Claude Code 2.1.283, Grok Build 1.0.41, Pi 0.87.1, and OpenCode 1.18.33. They contain no real credentials or user paths. The ignored live version-probe test can be run on that host without reading its private configuration.

The native fields and file roles are based on primary documentation:

- [Codex configuration](https://developers.openai.com/codex/config-reference)
- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Grok Build settings](https://docs.x.ai/build/settings)
- [Pi custom models](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)
- [Pi startup model settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md)
- [OpenCode providers](https://opencode.ai/docs/providers/)

Fixtures verify parsing and preservation of unrelated fields/comments. They do not prove that every CLI version accepts every generated provider combination; live CLI behavior needs separate versioned integration evidence.
