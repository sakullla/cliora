// Pi owns its native schema, settings directory and public offline loader protocol.
import fs from 'node:fs/promises';
import path from 'node:path';
const action = (operation, kind, id, value, field = null) => ({ version: 1, target: { kind, provider: 'cliora_synthetic', id }, operation, field, value });
export const fixture = {
  managedSecret: true,
  actions: [
    action('configure_provider', 'provider', '', { baseUrl: 'http://127.0.0.1:9/v1', interfaceFormat: 'openai_responses' }),
    ...['first', 'second'].map(id => action('create', 'model', id, { name: `Synthetic ${id}`, contextWindow: 64000, maxTokens: 128, reasoning: true, input: ['text', 'image'] })),
    action('default', 'model', 'second', null),
    action('set', 'model', 'second', { high: 'high', off: null }, 'thinkingLevelMap'),
    { version: 1, target: { kind: 'settings' }, operation: 'set', field: 'defaultThinkingLevel', value: 'high' },
  ],
};
export const environment = application => ({ PI_CODING_AGENT_DIR: path.dirname(application.files.find(file => file.role === 'models').path) });
export async function verify(context) {
  const { application, packageInfo, run, temporary, sha256 } = context;
  if (!packageInfo) return { level: 'unavailable', result: 'unverified', reason: 'No installed Pi npm package reachable from its PATH entry; other installation types have not been searched.' };
  const loader = path.join(packageInfo.root, 'dist/core/model-config.js');
  const settingsLoader = path.join(packageInfo.root, 'dist/core/settings-manager.js');
  try { await fs.access(loader); await fs.access(settingsLoader); } catch { return { level: 'unavailable', result: 'unverified', reason: 'Installed Pi has no confirmed public ModelConfig/SettingsManager loader at this module layout.' }; }
  const models = application.files.find(file => file.role === 'models');
  const settings = application.files.find(file => file.role === 'settings');
  const probe = path.join(temporary, 'pi-public-loader.mjs');
  await fs.writeFile(probe, `
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { ModelConfig } = await import(pathToFileURL(process.argv[2]));
const { SettingsManager } = await import(pathToFileURL(process.argv[3]));
const loaded = await ModelConfig.load(process.argv[4]);
const settings = SettingsManager.create(process.argv[5], process.argv[6]);
const provider = loaded.getProvider('cliora_synthetic');
const observations = { error: loaded.getError() ?? null, modelIds: provider?.models?.map(model => model.id) ?? [], thinkingLevelMap: provider?.models?.find(model => model.id === 'second')?.thinkingLevelMap, defaultProvider: settings.getDefaultProvider(), defaultModel: settings.getDefaultModel(), thinking: settings.getDefaultThinkingLevel() };
const invalid = JSON.parse(await fs.readFile(process.argv[4], 'utf8'));
invalid.providers.cliora_synthetic.models[0].thinkingLevelMap = { high: 42 };
await fs.writeFile(process.argv[7], JSON.stringify(invalid));
const rejected = await ModelConfig.load(process.argv[7]);
observations.invalidHighNumberRejected = Boolean(rejected.getError());
observations.invalidHighNumberError = rejected.getError() ?? null;
console.log(JSON.stringify(observations));
if (observations.error || !observations.invalidHighNumberError?.includes('thinkingLevelMap.high') || observations.thinkingLevelMap?.high !== 'high' || observations.thinkingLevelMap?.off !== null || observations.modelIds.length !== 2 || observations.defaultProvider !== 'cliora_synthetic' || observations.defaultModel !== 'second' || observations.thinking !== 'high') process.exitCode = 1;
`);
  const execution = await run(process.execPath, [probe, loader, settingsLoader, models.path, application.project, path.dirname(settings.path), path.join(temporary, 'pi-invalid-control.json')]);
  let observed; try { observed = JSON.parse(execution.stdout); } catch { observed = null; }
  return { level: 'native_loader', result: execution.exitCode === 0 ? 'passed' : 'failed', method: 'Installed ModelConfig.load(applied models.json), SettingsManager.create(isolated project, applied agent directory), inspect model identities/defaults and reject high:42 control.', loaderSha256: sha256(await fs.readFile(loader)), settingsLoaderSha256: sha256(await fs.readFile(settingsLoader)), observed, process: execution, limits: ['SettingsManager reads settings but does not enforce a complete settings schema; recorded values are observed getters.', 'No auth store, CLI session or provider inference is used.'] };
}
