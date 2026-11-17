import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureCases, isolatedEnvironment } from '../../scripts/verify-omp-native.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const locale = async (language) => (await import(`../../src/i18n/locales/${language}/tools.ts`)).default;

const cases = await fixtureCases(repository);

test('every OMP fixture is a declaration owned by its capability directory', () => {
  assert.ok(cases.length >= 5, 'OMP 生命周期用例应随适配器骨架一起交付');
  for (const { ref, directory, fixture } of cases) {
    assert.equal(fixture.capability, directory, `${ref} 的 capability 必须与目录一致`);
    assert.ok(fixture.case && typeof fixture.case === 'object', `${ref} 缺少 case 声明`);
    assert.ok(typeof fixture.name === 'string' && fixture.name.trim(), `${ref} 缺少名称`);
  }
  const lifecycle = cases.filter(item => item.directory === 'lifecycle');
  assert.ok(lifecycle.some(item => item.fixture.case.kind === 'channels'));
  assert.ok(lifecycle.some(item => item.fixture.case.kind === 'version-policy'));
  assert.ok(lifecycle.some(item => item.fixture.case.kind === 'launch'));
});

test('version fixtures stay wide: newer ordinary releases accepted, invalid versions unverified', () => {
  const policy = cases.find(item => item.fixture.case.kind === 'version-policy').fixture.case;
  for (const version of ['19.0.0', '20.0.0', 'v20.3.1', '18.20.2']) {
    assert.ok(policy.accepted.includes(version), `${version} 应默认接受`);
  }
  for (const version of ['invalid', '20', '19.0.0-beta.1']) {
    assert.ok(policy.rejected.includes(version), `${version} 不应被识别为已验证版本`);
  }
});

test('launch fixtures use OMP resume arguments and never Pi --session', () => {
  const launch = cases.find(item => item.fixture.case.kind === 'launch').fixture.case;
  const session = launch.cases.find(item => item.session === 'ses_01H');
  assert.deepEqual(session.args, ['--resume', 'ses_01H']);
  for (const item of launch.cases) {
    assert.ok(!(item.args ?? []).includes('--session'), 'OMP 不得使用 Pi 的 --session');
  }
  assert.deepEqual(launch.cases.find(item => item.latest).args, ['--continue']);
});

test('source and maintenance fixtures name Bun while the precompiled installer stays undeclared', () => {
  const channels = cases.find(item => item.fixture.case.kind === 'channels').fixture.case;
  const bun = channels.cases.find(item => item.channel === 'bun');
  const standalone = channels.cases.find(item => item.channel === 'standalone');
  assert.ok(bun && bun.native === false, 'Bun 来源不得同时是 native');
  assert.ok(standalone && standalone.native === true, '独立二进制对应 native');
  const maintenance = cases.find(item => item.fixture.case.kind === 'maintenance').fixture.case.expect;
  assert.equal(maintenance.install, 'bun add -g @oh-my-pi/pi-coding-agent');
  assert.equal(maintenance.upgradeBun, 'bun update -g @oh-my-pi/pi-coding-agent');
  assert.equal(maintenance.upgradeNative, 'omp update');
  assert.equal(maintenance.uninstallBun, 'bun remove -g @oh-my-pi/pi-coding-agent');
  assert.equal(maintenance.nativeInstallWindows, 'irm https://omp.sh/install.ps1 | iex');
  assert.equal(maintenance.nativeInstallNull, true);
  assert.equal(maintenance.npmInstallNull, true);
});

test('the isolated environment keeps Bun and OMP state inside the temporary tree', () => {
  const temporary = path.join(repository, 'tests', 'fixtures', 'omp', 'synthetic-temporary');
  const home = path.join(temporary, 'home');
  const bunRoot = path.join(temporary, 'bun');
  const environment = isolatedEnvironment(home, temporary, bunRoot);
  assert.equal(environment.HOME, home);
  assert.equal(environment.USERPROFILE, home);
  assert.equal(environment.BUN_INSTALL, bunRoot);
  for (const key of ['HOME', 'USERPROFILE', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'XDG_CONFIG_HOME', 'APPDATA']) {
    assert.ok(environment[key].startsWith(temporary), `${key} 必须留在隔离目录内`);
  }
  assert.equal(environment.PATH, process.env.PATH, '只使用宿主 PATH 查找已安装的 Bun，不写宿主目录');
  assert.ok(!('https_proxy' in environment), '隔离安装需要真实包来源，不注入黑洞代理');
});

test('OMP registers in both composition roots without sharing another CLI package', async () => {
  const frontend = await readFile(path.join(repository, 'src/adapters/index.ts'), 'utf8');
  assert.match(frontend, /import \{ ompUiAdapter \} from '\.\/omp'/);
  assert.match(frontend, /\[ompUiAdapter\.id, ompUiAdapter\]/);
  const adapter = await readFile(path.join(repository, 'src/adapters/omp/index.ts'), 'utf8');
  assert.match(adapter, /id: 'omp'/);
  assert.match(adapter, /omp\.svg/);
  assert.match(adapter, /configuration: \{ Editor: OmpConfigurationEditor \}/);
  const backend = await readFile(path.join(repository, 'src-tauri/src/adapters/omp/mod.rs'), 'utf8');
  for (const module of ['accounts', 'agents', 'configuration', 'history', 'mcp', 'memory', 'plugins', 'skills']) {
    assert.match(backend, new RegExp(`pub\\(crate\\) mod ${module};`), `缺少 ${module} 模块声明`);
  }
  assert.match(backend, /pub\(crate\) const ID: &str = "omp"/);
  assert.match(backend, /@oh-my-pi\/pi-coding-agent/);
  assert.match(backend, /--resume/);
  const production = backend.split('#[cfg(test)]')[0];
  assert.ok(!production.includes('--session'), 'OMP 组合根不得复制 Pi 的恢复参数');
  await access(path.join(repository, 'src/assets/tools/omp.svg'));
});

test('shared services never dispatch on the OMP id', async () => {
  for (const relative of [
    'src-tauri/src/accounts/context.rs',
    'src-tauri/src/resources/plugins.rs',
    'src-tauri/src/usage/providers.rs',
    'src-tauri/src/native/adapter.rs',
    'src/features/tools/ToolWorkspace.tsx',
  ]) {
    const source = (await readFile(path.join(repository, relative), 'utf8')).split('#[cfg(test)]')[0];
    assert.doesNotMatch(source, /(?:===?|!==?)\s*['"]omp['"]/, relative);
    assert.doesNotMatch(source, /['"]omp['"]\s*=>/, relative);
  }
});

test('resource fixtures use the resources capability and kind dispatch', async () => {
  const verifySource = await readFile(path.join(repository, 'src-tauri/src/adapters/omp/verify.rs'), 'utf8');
  const verify = verifySource.split('#[cfg(test)]')[0];
  assert.match(verify, /"resources" => match case\.get\("kind"\)/);
  for (const kind of ['mcp', 'skills', 'rules', 'agents']) {
    assert.ok(verify.includes(`Some("${kind}")`), `缺少 ${kind} 分派`);
  }
  assert.ok(!verify.includes('"resources-mcp"'), '不得保留 T4 无法落盘的 capability 名');
  assert.ok(!verify.includes('"resources-skills"'), '不得保留 T4 无法落盘的 capability 名');
  const readme = await readFile(path.join(repository, 'tests/fixtures/omp/lifecycle/README.md'), 'utf8');
  assert.match(readme, /resources\/.*mcp.*skills.*rules.*agents/s);
});

test('OMP copy exists in both languages while capabilities stay explicit', async () => {
  const zh = await locale('zh');
  const en = await locale('en');
  assert.ok(zh.adapters.omp.label.length > 0);
  assert.ok(en.adapters.omp.label.length > 0);
  assert.notEqual(zh.adapters.omp.label, en.adapters.omp.label);
});
