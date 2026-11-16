import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProbePath, ompMemoryEnvironment, probeOmp, probeQoder, qoderIsolatedEnvironment } from '../../scripts/verify-memory-native.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cliora-memory-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
function fakeEngine(overrides = {}) {
  const writes = [];
  const groups = [{ id: 'autoMemoryUserScopeEnabled', scope: 'global', enabled: null }, { id: 'autoMemoryEnabled', scope: 'project', enabled: null }];
  const directory = (scope, env) => path.join(env.QODERCN_CONFIG_DIR, ...(scope === 'global' ? ['memory'] : ['projects', 'synthetic', 'memory']));
  return {
    writes,
    async resolve(tool, scope, home, project, env) {
      assert.equal(tool, 'qoder_cn');
      for (const key of ['QODERCN_CLI_HOME', 'QODERCN_CONFIG_DIR_NAME', 'GEMINI_CLI_HOME', 'CLI_HOME', 'CONFIG_DIR_NAME']) assert.equal(env[key], undefined);
      return { directory: overrides.resolveOutside ?? directory(scope, env) };
    },
    async op(request, env) {
      if (request.op === 'aggregate') return { stores: overrides.nonempty ? [{}] : [], switchGroups: groups.map(group => ({ ...group })) };
      const store = directory(request.scope, env);
      const file = path.join(store, `${request.id}.md`);
      if (request.op === 'read') return { text: await fs.readFile(file, 'utf8') };
      if (request.op === 'save') {
        writes.push(file);
        await fs.mkdir(store, { recursive: true });
        await fs.writeFile(file, request.text);
        await fs.writeFile(path.join(store, 'MEMORY.md'), '- [fixture](cliora-native-fixture.md)\n');
        return { path: file, text: request.text };
      }
      if (request.op === 'delete') {
        writes.push(file);
        await fs.rm(file);
        await fs.writeFile(path.join(store, 'MEMORY.md'), '# Index\n');
        return null;
      }
      if (request.op === 'group') {
        const settings = path.join(env.QODERCN_CONFIG_DIR, 'settings.json');
        writes.push(settings);
        groups.find(group => group.id === request.group).enabled = request.enabled;
        await fs.writeFile(settings, JSON.stringify(groups));
        return null;
      }
      assert.fail(`unexpected ${request.op}`);
    },
  };
}

test('Qoder probe isolates all branded and legacy environment overrides', async t => {
  const root = await temporary(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const sentinel = path.join(outside, 'settings.json');
  await fs.writeFile(sentinel, 'do not change');
  const env = Object.fromEntries(['QODERCN_CONFIG_DIR', 'QODERCN_CLI_HOME', 'QODERCN_CONFIG_DIR_NAME', 'GEMINI_CLI_HOME', 'CLI_HOME', 'CONFIG_DIR_NAME', 'qodercn_cli_home'].map(key => [key, outside]));
  const isolated = path.join(root, 'probe');
  await fs.mkdir(isolated);
  const engine = fakeEngine();
  const result = await probeQoder(engine, 'synthetic', isolated, { env });
  assert.equal(result.result, 'unverified');
  assert.ok(result.checks.every(item => item.passed));
  assert.equal(engine.writes.length, 6);
  assert.ok(engine.writes.every(file => file.startsWith(path.join(isolated, 'qoder-home') + path.sep)));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'do not change');
  assert.equal(qoderIsolatedEnvironment('pinned', env).qodercn_cli_home, undefined);
  assert.equal(env.QODERCN_CONFIG_DIR, outside, 'must not mutate process environment');
});

test('native directory escaping the temporary root aborts before any probe write', async t => {
  const root = await temporary(t);
  const engine = fakeEngine({ resolveOutside: path.join(os.tmpdir(), 'foreign-memory') });
  await assert.rejects(probeQoder(engine, 'synthetic', root), /outside the temporary directory/);
  assert.equal(engine.writes.length, 0);
  assert.deepEqual(await fs.readdir(root), []);
});

test('a nonempty initial native state stops all memory mutations', async t => {
  const root = await temporary(t);
  const engine = fakeEngine({ nonempty: true });
  await assert.rejects(probeQoder(engine, 'synthetic', root), /refusing memory mutations/);
  assert.equal(engine.writes.length, 0);
});

test('boundary validation rejects sibling-prefix paths and junctions', async t => {
  const root = await temporary(t);
  await assert.rejects(assertProbePath(root, `${root}-sibling/file`), /outside/);
  const outside = await temporary(t);
  const link = path.join(root, 'qoder-home');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertProbePath(root, path.join(link, '.qoder-cn', 'settings.json')), /contains a link/);
  const engine = fakeEngine();
  await assert.rejects(probeQoder(engine, 'synthetic', root), /contains a link/);
  assert.equal(engine.writes.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

// ------------------------------------------------------------------- omp ----
const ompAgent = (home, env = {}) => {
  const profile = env.OMP_PROFILE || env.PI_PROFILE || '';
  const configDir = env.PI_CONFIG_DIR || '.omp';
  if (profile) return path.join(home, configDir, 'profiles', profile, 'agent');
  return (env.PI_CODING_AGENT_DIR || path.join(home, configDir, 'agent'));
};
const ompEncode = cwd => `--${(process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

function ompEnvironment(roots) {
  return { HOME: roots.home, USERPROFILE: roots.home, LOCALAPPDATA: path.join(roots.root, 'omp-localappdata'), APPDATA: path.join(roots.root, 'omp-appdata'), TEMP: path.join(roots.root, 'omp-temp'), PATH: process.env.PATH ?? '' };
}

function ompBackend(home) {
  try {
    const match = /backend:\s*(\S+)/.exec(fsSync.readFileSync(path.join(home, '.omp', 'agent', 'config.yml'), 'utf8'));
    return match ? match[1] : 'off';
  } catch { return 'off'; }
}

function ompBanks(agent) {
  return fsSync.existsSync(path.join(agent, 'memories'))
    ? fsSync.readdirSync(path.join(agent, 'memories'), { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith('--') && item.name.endsWith('--')).map(item => path.join(agent, 'memories', item.name))
    : [];
}

function ompDetail(agent, backend) {
  const banks = ompBanks(agent).length;
  const note = banks === 0 ? '；本机没有已落盘的 local Markdown 记忆' : `；本机仍有 ${banks} 个项目的 local Markdown 记忆文件，当前后端不读取，Cliora 不删除或重建`;
  if (backend === 'local') return `当前后端：local（本机 Markdown）${note}`;
  if (backend === 'off') return `当前后端：off（原生默认 off）；Cliora 不把磁盘上的旧 Markdown 文件当作当前记忆${note}`;
  if (backend === 'future-backend') return `memory.backend 为未核实值 future-backend；OMP 18.20.2 会忽略并使用默认 off，Cliora 保留原值不改写；选择“开”会被拒绝，请先在 OMP 原生配置中修复${note}`;
  return `当前后端：${backend}（原生后端）；该数据由 OMP 原生后端管理，Cliora 不展示为本地 Markdown${note}`;
}

function ompEngine() {
  const writes = [];
  return {
    writes,
    async resolve(tool, scope, home, project, env) {
      assert.equal(tool, 'omp');
      assert.equal(scope, 'project');
      return { directory: path.join(ompAgent(home, env), 'memories', ompEncode(project)) };
    },
    async request(request) {
      assert.equal(request.tool, 'omp');
      const home = request.home;
      const agent = path.join(home, '.omp', 'agent');
      const backend = ompBackend(home);
      if (request.op === 'aggregate') {
        const groups = [{ id: 'memory.backend', scope: 'project', enabled: backend === 'local', detail: ompDetail(agent, backend) }];
        if (backend !== 'local') return { toolId: 'omp', entries: [], failedSources: [], stores: [], switchShared: true, switchGroups: groups };
        const entries = [];
        const stores = ompBanks(agent).map(directory => {
          for (const id of ['MEMORY', 'learned', 'memory_summary']) {
            const file = path.join(directory, `${id}.md`);
            if (fsSync.existsSync(file)) entries.push({ id, path: file, enabled: true, fingerprint: 'fp', sourceLabel: path.basename(directory), target: { toolId: 'omp', scope: 'project', projectPath: null, storeDirectory: directory }, inUse: true, detail: '' });
          }
          return { label: path.basename(directory), directory, target: { toolId: 'omp', scope: 'project', projectPath: null, storeDirectory: directory }, inUse: true, detail: '', entryCount: 0 };
        });
        return { toolId: 'omp', entries, failedSources: [], stores, switchShared: true, switchGroups: groups };
      }
      if (request.op === 'group') {
        if (backend === 'future-backend' && request.enabled) throw new Error('memory.backend 为未核实值 future-backend；Cliora 不会覆盖未知值，请先在 OMP 原生配置中修复');
        if ((backend === 'local') === request.enabled) return null;
        const path_ = path.join(agent, 'config.yml');
        writes.push(path_);
        fsSync.mkdirSync(agent, { recursive: true });
        fsSync.writeFileSync(path_, `memory:\n  backend: ${request.enabled ? 'local' : 'off'}\n`);
        return null;
      }
      if (request.op === 'save') {
        if (backend !== 'local') throw new Error(`OMP 当前记忆后端为 ${backend}；只有 local 提供本机 Markdown 记忆`);
        const bank = path.join(agent, 'memories', ompEncode(request.project));
        const file = path.join(bank, `${request.id}.md`);
        writes.push(file);
        fsSync.mkdirSync(bank, { recursive: true });
        fsSync.writeFileSync(file, request.text);
        return { path: file };
      }
      if (request.op === 'list') {
        const bank = path.join(agent, 'memories', ompEncode(request.project));
        const entries = fsSync.existsSync(bank) ? fsSync.readdirSync(bank).filter(name => name.endsWith('.md')).map(name => ({ id: name.slice(0, -3) })) : [];
        return { entries };
      }
      throw new Error(`unexpected ${request.op}`);
    },
  };
}

function ompStub(root) {
  const source = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const env = process.env;
const home = env.HOME;
const profile = env.OMP_PROFILE || env.PI_PROFILE || '';
const configDir = env.PI_CONFIG_DIR || '.omp';
const agent = profile ? path.join(home, configDir, 'profiles', profile, 'agent') : (env.PI_CODING_AGENT_DIR || path.join(home, configDir, 'agent'));
const configFile = path.join(agent, 'config.yml');
const backend = () => {
  try { const match = /backend:\\s*(\\S+)/.exec(fs.readFileSync(configFile, 'utf8')); return match ? match[1] : 'off'; } catch { return 'off'; }
};
const encode = cwd => '--' + (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--';
if (args[0] === '--version') { console.log('omp/18.20.2'); process.exit(0); }
if (args[0] === 'config' && args[1] === 'path') { console.log(agent); process.exit(0); }
if (args[0] === 'config' && args[1] === 'get') { const value = backend(); console.log(JSON.stringify({ key: 'memory.backend', value: value === 'future-backend' ? 'off' : value })); process.exit(0); }
if (args[0] === 'config' && args[1] === 'set') { fs.mkdirSync(agent, { recursive: true }); fs.writeFileSync(configFile, 'memory:\\n  backend: ' + args[3] + '\\n'); console.log('Set memory.backend = ' + args[3]); process.exit(0); }
if (args[0] === 'read') {
  const url = args[1] || '';
  const bank = path.join(agent, 'memories', encode(process.cwd()));
  const name = url === 'memory://root' ? 'memory_summary.md' : url.replace('memory://root/', '');
  try { console.log(fs.readFileSync(path.join(bank, name), 'utf8')); } catch { console.error('Unknown protocol: memory://'); process.exit(1); }
  process.exit(0);
}
process.exit(1);
`;
  const file = path.join(root, 'omp-stub.mjs');
  fsSync.writeFileSync(file, source);
  return { command: process.execPath, wrap: args => [file, ...args] };
}

test('OMP probe isolates every relocation variable without mutating the inherited environment', async t => {
  const root = await temporary(t);
  const inherited = { OMP_PROFILE: 'work', PI_PROFILE: 'legacy', PI_CONFIG_DIR: 'alt', PI_CODING_AGENT_DIR: '/pinned', XDG_STATE_HOME: '/xdg', HOME: '/real-home', USERPROFILE: '/real-home' };
  const home = path.join(root, 'omp-home');
  const env = ompMemoryEnvironment(home, root, inherited);
  for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_STATE_HOME']) assert.equal(env[key], undefined, key);
  assert.equal(inherited.OMP_PROFILE, 'work', 'must not mutate the inherited environment');
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.TEMP, path.join(root, 'omp-temp'));
});

test('OMP probe exercises the verified local root and every backend status', async t => {
  const root = await temporary(t);
  const runner = ompStub(root);
  const engine = ompEngine();
  const result = await probeOmp(engine, 'SYNTHETIC-OMP-MARKER', root, { runners: { omp: runner } });
  assert.equal(result.result, 'passed', JSON.stringify(result.checks.filter(item => !item.passed)));
  assert.ok(result.checks.length >= 20, String(result.checks.length));
  assert.ok(result.checks.some(item => item.name.includes('18.20.2')));
  assert.ok(result.checks.some(item => item.name.includes('OMP_PROFILE')));
  assert.ok(result.checks.some(item => item.name.includes('PI_CONFIG_DIR')));
  assert.ok(result.checks.some(item => item.name.includes('unknown backend refuses')));
  assert.equal(await fs.stat(path.join(root, 'omp-home')).then(() => 'present', () => 'removed'), 'removed');
  assert.equal(await fs.stat(path.join(root, 'omp-project')).then(() => 'present', () => 'removed'), 'removed');
});
