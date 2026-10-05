import fs from 'node:fs/promises';
import path from 'node:path';
export const fixture = {
  documents: { settings: { model: 'gpt-6.1-sol', model_provider: 'cliora_synthetic', model_reasoning_effort: 'high', model_context_window: 64000, model_reasoning_summary: 'auto', model_verbosity: 'medium', model_providers: { cliora_synthetic: { name: 'Offline synthetic provider', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses', env_key: 'CLIORA_SYNTHETIC_KEY' } } } },
  actions: [{ version: 1, target: 'configuration', operation: 'set', field: 'model_context_window', value: 128000 }],
};
export const environment = application => ({ CODEX_HOME: path.dirname(application.files.find(file => file.role === 'settings').path), CLIORA_SYNTHETIC_KEY: 'synthetic-offline-native-verification' });
export async function verify({ candidate, application, temporary, environment, run, sha256 }) {
  if (!candidate) return { level: 'unavailable', result: 'unverified', reason: 'No codex command on PATH; other installation types are unverified.' };
  if (process.platform !== 'darwin') return { level: 'syntax_only', result: 'unverified', reason: 'The established Codex strict-loader probe currently requires the macOS deny-by-default sandbox; other platforms are unverified.' };
  const sandbox = '/usr/bin/sandbox-exec';
  try { await fs.access(sandbox, fs.constants.X_OK); } catch { return { level: 'syntax_only', result: 'unverified', reason: 'macOS sandbox-exec is unavailable; Codex private/native and network boundaries cannot be established.' }; }
  const publicNode = path.dirname(path.dirname(await fs.realpath(process.execPath)));
  const allowed = ['/System', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/dev', publicNode, await fs.realpath(temporary)];
  const profile = `(version 1)\n(deny default)\n(allow process-exec process-fork signal sysctl-read)\n(allow file-read* ${allowed.map(ref => `(subpath ${JSON.stringify(ref)})`).join(' ')} (literal ${JSON.stringify(candidate)}))\n(allow file-write* (subpath ${JSON.stringify(await fs.realpath(temporary))}))\n(allow mach-lookup (global-name "com.apple.system.logger"))\n`;
  const profilePath = path.join(temporary, 'codex-offline.sb'); await fs.writeFile(profilePath, profile);
  const calibration = await run(sandbox, ['-f', profilePath, '/usr/bin/true']);
  if (calibration.exitCode !== 0) return { level: 'syntax_only', result: 'unverified', reason: 'Cannot activate the required Codex offline sandbox.', process: calibration };
  // No HOME/system/enterprise config, keychain IPC or network permission is granted.
  const isolatedRun = (args, options) => run(sandbox, ['-f', profilePath, candidate, ...args], options);
  const accepted = await isolatedRun(['--strict-config', '--no-daemon', 'features', 'list']);
  if (/unexpected argument.*(?:strict-config|no-daemon)/s.test(accepted.stderr)) return { level: 'syntax_only', result: 'unverified', reason: 'Installed Codex does not expose the confirmed strict offline features configuration path.', process: accepted };
  const invalidHome = path.join(temporary, 'codex-invalid-control'); await fs.mkdir(invalidHome);
  const original = await fs.readFile(application.files.find(file => file.role === 'settings').path, 'utf8');
  await fs.writeFile(path.join(invalidHome, 'config.toml'), `${original}\n[cliora_invalid_unknown_section]\ninvalid = true\n`);
  const rejected = await isolatedRun(['--strict-config', '--no-daemon', 'features', 'list'], { env: { ...environment, CODEX_HOME: invalidHome } });
  return { level: 'native_loader', result: accepted.exitCode === 0 && rejected.exitCode !== 0 && /unknown|unrecognized|unsupported/i.test(rejected.stderr) ? 'passed' : 'failed', method: 'Installed codex --strict-config --no-daemon features list reads isolated CODEX_HOME/config.toml under deny-by-default sandbox; unknown-section negative control must fail.', sandboxProfileSha256: sha256(profile), processes: [accepted, rejected], limits: ['Sandbox allows public OS/Node files and the synthetic directory only; system/enterprise/private configuration, keychain IPC and networking receive no permission.', 'Features listing proves strict configuration loading, not provider authentication, model catalog access or inference.'] };
}
