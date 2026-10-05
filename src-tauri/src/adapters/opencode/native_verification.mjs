const action = (operation, kind, id, value) => ({ version: 1, target: { kind, provider: 'cliora_synthetic', id }, operation, field: null, value });
export const fixture = {
  managedSecret: true,
  actions: [
    action('configure_provider', 'provider', '', { baseUrl: 'http://127.0.0.1:9/v1', interfaceFormat: 'openai_completions' }),
    ...['first', 'second'].map(id => action('create', 'model', id, { name: `Synthetic ${id}`, limit: { context: 64000, output: 128 }, reasoning: true, modalities: { input: ['text', 'image'], output: ['text'] } })),
    action('default', 'model', 'second', null),
    action('small_default', 'model', 'first', null),
  ],
};
export async function verify({ candidate }) {
  return { level: 'syntax_only', result: 'unverified', method: 'Cliora parses the exact applied JSON/JSONC and validates its supported adapter fields.', reason: candidate ? 'OpenCode binary found; no offline public native loader protocol has been established for this installation.' : 'No opencode command found on PATH; other install directories/packages have not been exhausted, so absence is not established.', limits: ['Product adapter/schema checks do not establish actual OpenCode loading.'] };
}
