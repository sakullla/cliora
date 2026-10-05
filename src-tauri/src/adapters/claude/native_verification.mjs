export const fixture = {
  documents: { settings: { model: 'claude-sonnet-4-6', effortLevel: 'high', env: { ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_DEFAULT_SONNET_MODEL: 'synthetic-sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5', CLAUDE_CODE_SUBAGENT_MODEL: 'synthetic-subagent', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic' } } },
  actions: [{ version: 1, target: 'configuration', operation: 'set', field: 'sonnet.model', value: 'synthetic-sonnet-edited' }],
};
export async function verify({ candidate }) {
  return { level: 'syntax_only', result: 'unverified', method: 'Cliora parses the exact applied settings JSON and validates its supported adapter fields.', reason: candidate ? 'Installed Claude has no established standalone offline settings loader that avoids private credentials and startup side effects; native runtime loading is unverified.' : 'No claude command found on PATH; native settings loading is unverified.', limits: ['JSON parsing and product adapter validation do not establish Claude settings acceptance.', 'Version discovery is not native loading evidence.'] };
}
