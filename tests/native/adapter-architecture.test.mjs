import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const sources = [
  'src-tauri/src/accounts/context.rs', 'src-tauri/src/accounts/native.rs',
  'src-tauri/src/accounts/selection.rs', 'src-tauri/src/resources/plugins.rs',
  'src-tauri/src/resources/agents.rs', 'src-tauri/src/usage/providers.rs',
  'src-tauri/src/usage/official.rs', 'src-tauri/src/usage/scheduler.rs',
  'src/features/tools/PluginsWorkspace.tsx', 'src/features/tools/UsageQuota.tsx',
  'src/features/tools/AccountsPanel.tsx',
];
test('shared account, resource, quota and UI services do not dispatch on builtin IDs', async () => {
  for (const path of sources) {
    const source = (await readFile(path, 'utf8')).split('#[cfg(test)]')[0];
    assert.doesNotMatch(source, /(?:===?|!==?)\s*['"](?:codex|claude_code|grok|pi|open_code|glm|kimi|minimax|sub2api|newapi|zcode|qoder|kimi_code|deepseek|codebuddy)['"]/, path);
    assert.doesNotMatch(source, /['"](?:codex|claude_code|grok|pi|open_code|glm|kimi|minimax|sub2api|newapi|zcode|qoder|kimi_code|deepseek|codebuddy)['"]\s*=>/, path);
  }
  assert.doesNotMatch(await readFile('src-tauri/src/accounts/context.rs', 'utf8'), /['"](?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GROK_HOME|CODEX_HOME|PI_CODING_AGENT_DIR)['"]/, 'environment policy belongs to adapters');
  assert.doesNotMatch(await readFile('src/features/tools/AccountsPanel.tsx', 'utf8'), /adoptNativeCodexAccount/, 'native adoption dispatch must use the selected tool');
  const models = (await readFile('src-tauri/src/native/models.rs', 'utf8')).split('#[cfg(test)]')[0];
  assert.doesNotMatch(models, /['"](?:api\.deepseek\.com|open\.bigmodel\.cn|api\.z\.ai)['"]/, 'supplier-specific model routes belong to adapters');
});
test('adapter implementations have only the frontend and backend package roots', async () => {
  for (const legacy of ['src/features/tools/adapters', 'src-tauri/src/native/adapters', 'src-tauri/src/usage/providers']) {
    await assert.rejects(access(legacy), { code: 'ENOENT' });
  }
  for (const cli of ['codex', 'claude', 'grok', 'pi', 'opencode']) {
    await access(`src/adapters/${cli}/index.ts`);
    await access(`src-tauri/src/adapters/${cli}/accounts.rs`);
    await access(`src-tauri/src/adapters/${cli}/history.rs`);
  }
  // The five default-off additions ship backend adapters under the same
  // package root; they need no frontend package until custom controls exist.
  for (const cli of ['zcode', 'qoder_cn', 'kimi_code', 'deepseek', 'codebuddy']) {
    await access(`src-tauri/src/adapters/${cli}/mod.rs`);
  }
});
