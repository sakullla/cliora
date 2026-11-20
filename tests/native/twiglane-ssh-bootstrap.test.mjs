import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const setup = fileURLToPath(new URL('../../src-tauri/src/remote/twiglane_agent_setup.py', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

test('remote bootstrap probes without installing, verifies uploads, preserves the last installation and streams stdio', {skip: process.platform === 'win32'}, t => {
  const home = mkdtempSync(path.join(tmpdir(), 'twiglane-bridge-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, '.local/share/twiglane/agent/v1');
  const agent = path.join(directory, 'agent');
  const raw = (args, input = '') => spawnSync('python3', ['-I', setup, ...args], {
    input, encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 5000,
  });
  const run = (args, input = '') => {
    if (args[0] === 'probe') return raw(args, input);
    const result = raw(args, 'G' + input);
    assert.ok(result.stdout.startsWith('twiglane-peer/1\n'));
    return { ...result, stdout: result.stdout.slice('twiglane-peer/1\n'.length) };
  };
  assert.equal(raw(['install', hash('fixture'), 'test-proof']).status, 2);
  assert.equal(existsSync(directory), false);
  const probe = () => {
    const result = run(['probe']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(probe().agentSha256, null);
  assert.equal(existsSync(directory), false);
  const fixture = '#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n';
  const expected = hash(fixture);
  const result = run(['install', expected, 'test-proof'], fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)),
    [{receivedBytes: Buffer.byteLength(fixture)}, {installed: true, agentSha256: expected}]);
  assert.equal(probe().agentSignature, 'test-proof');
  assert.equal(statSync(agent).mode & 0o777, 0o700);
  const short = run(['install', hash('complete'), 'other-proof'], 'interrupted');
  assert.equal(short.status, 2);
  assert.equal(probe().agentSha256, expected);
  assert.equal(probe().agentSignature, 'test-proof');
  assert.equal(run(['connect', expected], 'agent stdio\n').stdout, 'agent stdio\n');
  writeFileSync(agent, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(run(['connect', expected]).status, 2);
  rmSync(agent);
  const outside = path.join(home, 'untouched');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, agent);
  assert.equal(run(['connect', expected]).status, 2);
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  chmodSync(directory, 0o777);
  assert.equal(run(['install', expected, 'test-proof'], fixture).status, 2);
});
