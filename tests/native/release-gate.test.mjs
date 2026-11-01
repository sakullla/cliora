import { test } from 'node:test';
import assert from 'node:assert/strict';
import gate from '../../.github/scripts/wait-for-main-ci.cjs';

const { waitForMainCi } = gate;
const success = {
  id: 1, head_sha: 'commit', head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', html_url: 'https://example.com/run/1',
};

function fixture(pages, status = 'identical') {
  let calls = 0;
  return {
    repo: { owner: 'owner', repo: 'repo' }, sha: 'commit', attempts: pages.length,
    log() {}, async sleep(ms) { assert.equal(ms, 15_000); },
    github: { rest: {
      actions: { async listWorkflowRuns(request) {
        assert.equal(request.workflow_id, 'ci.yml');
        assert.equal(request.branch, 'main');
        assert.equal(request.event, 'push');
        assert.equal(request.head_sha, 'commit');
        return { data: { workflow_runs: pages[calls++] } };
      } },
      repos: { async compareCommitsWithBasehead(request) {
        assert.equal(request.basehead, 'commit...main');
        return { data: { status } };
      } },
    } },
  };
}

test('waits for the exact main commit to finish CI before allowing release', async () => {
  const result = await waitForMainCi(fixture([[], [{ ...success, status: 'in_progress' }], [success]]));
  assert.equal(result.id, 1);
});

test('rejects unsuccessful completed main runs', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null]) {
    await assert.rejects(waitForMainCi(fixture([[{ ...success, conclusion }]])), /did not succeed/);
  }
});

test('does not accept a different commit, branch, or PR', async () => {
  for (const overrides of [{ head_sha: 'other' }, { head_branch: 'feature' }, { event: 'pull_request' }]) {
    await assert.rejects(waitForMainCi(fixture([[{ ...success, ...overrides }]])), /Timed out/);
  }
});

test('a newer failure overrides an older successful run', async () => {
  await assert.rejects(waitForMainCi(fixture([[success, { ...success, id: 2, conclusion: 'failure' }]])), /did not succeed/);
});

test('a newer pending run must finish even when an older run succeeded', async () => {
  const pending = { ...success, id: 2, status: 'queued', conclusion: null };
  await assert.rejects(waitForMainCi(fixture([[pending, success]])), /Timed out/);
  const result = await waitForMainCi(fixture([[pending, success], [{ ...success, id: 2 }, success]]));
  assert.equal(result.id, 2);
});

test('rejects commits removed from main and accepts tested ancestors of main', async () => {
  for (const status of ['diverged', 'behind']) {
    await assert.rejects(waitForMainCi(fixture([[success]], status)), /no longer on main/);
  }
  assert.equal((await waitForMainCi(fixture([[success]], 'ahead'))).id, 1);
});

test('missing main CI times out without allowing release', async () => {
  await assert.rejects(waitForMainCi(fixture([[], []])), /Timed out/);
});

test('API errors fail closed instead of allowing release', async () => {
  const input = fixture([[success]]);
  input.github.rest.actions.listWorkflowRuns = async () => { throw new Error('API unavailable'); };
  await assert.rejects(waitForMainCi(input), /API unavailable/);
});

test("default gate allows a full 60 minutes before the final check", async () => {
  const options = fixture([...Array.from({ length: 240 }, () => []), [success]]);
  delete options.attempts;
  let elapsed = 0;
  options.sleep = async (ms) => { elapsed += ms; };
  assert.equal((await waitForMainCi(options)).id, 1);
  assert.equal(elapsed, 60 * 60 * 1000);
});
