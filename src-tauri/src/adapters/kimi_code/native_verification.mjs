import fs from 'node:fs/promises';
import path from 'node:path';
const action = (operation, kind, id, value) => ({ version: 1, target: { kind, provider: 'cliora_synthetic', id }, operation, field: null, value });
export const fixture = {
  managedSecret: true,
  actions: [
    action('configure_provider', 'provider', '', { baseUrl: 'http://127.0.0.1:9/v1', interfaceFormat: 'openai_responses' }),
    ...['first', 'second'].map(id => action('create', 'model', id, { provider: 'cliora_synthetic', model: `request-${id}`, display_name: `Synthetic ${id}`, max_context_size: 64000, capabilities: ['image_in', 'thinking'] })),
    action('default', 'model', 'second', null),
  ],
};
export const environment = application => ({ KIMI_CODE_HOME: path.dirname(application.files.find(file => file.role === 'settings').path) });
export async function verify({ candidate, packageInfo, application, temporary, run }) {
  if (!candidate) return { level: 'unavailable', result: 'unverified', reason: 'No kimi command found on PATH; this is not proof that Kimi is absent.' };
  if (!packageInfo || packageInfo.name !== '@moonshot-ai/kimi-code') return { level: 'unavailable', result: 'unverified', reason: 'Offline doctor protocol has only been established for npm Kimi Code; this installation identity is unverified.' };
  const file = application.files.find(file => file.role === 'settings');
  const accepted = await run(candidate, ['doctor', 'config', file.path]);
  const invalidPath = path.join(temporary, 'kimi-invalid-control.toml');
  await fs.writeFile(invalidPath, 'models = "not-a-model-map"\n');
  const rejected = await run(candidate, ['doctor', 'config', invalidPath]);
  const valid = accepted.exitCode === 0 && accepted.stdout.includes(file.path) && rejected.exitCode === 1 && rejected.stderr.includes(invalidPath) && /models:.*expected record/i.test(rejected.stderr);
  return { level: 'official_schema', result: valid ? 'passed' : 'failed', method: 'Installed kimi doctor config <exact applied TOML>: official v2 section registry validation, with invalid models type control.', processes: [accepted, rejected], limits: ['Doctor validates syntax and registered section schemas; it does not start the engine or prove default-model/provider runtime resolution.', 'Warnings about unknown/deprecated settings remain in process output.'] };
}
