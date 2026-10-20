import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertProbePath, probeQoder, qoderIsolatedEnvironment } from '../../scripts/verify-memory-native.mjs';

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
