# Cursor IDE sanitized format fixtures

Observed installed Windows release: 3.24.9, commit cd6d2a1f2e56e9841f0ed9c7c24542087b4e69b0, x64. Fixtures contain only desktop product identity fields and invented IDE settings/MCP values. `Cursor.exe` in tests is a synthetic non-executable marker. No credential, private user configuration or IDE database was copied.

References read during implementation: https://cursor.com/docs/context/mcp and https://cursor.com/docs/context/skills; installed public resources/app/product.json, package.json, out/main.js and out/vs/workbench/workbench.desktop.main.js. The IDE implementation resolves user/project .cursor/mcp.json and a mcpServers object; private disabledMcpServers/disabledGlobalMcpServers are not file flags. Settings use VS Code-style User/settings.json and project .vscode/settings.json. See the verification document for platform evidence and limitations.
