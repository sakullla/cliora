async function waitForMainCi({
  github,
  repo,
  sha,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 241,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo,
      workflow_id: 'ci.yml',
      branch: 'main',
      event: 'push',
      head_sha: sha,
      per_page: 100,
    });
    // A successful PR or an older run must not bypass the latest main run.
    const run = data.workflow_runs
      .filter((item) => item.head_sha === sha && item.head_branch === 'main' && item.event === 'push')
      .sort((a, b) => b.id - a.id)[0];
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Error(`Main CI did not succeed (${run.conclusion}): ${run.html_url}`);
      }
      const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
        ...repo,
        basehead: `${sha}...main`,
      });
      if (!['ahead', 'identical'].includes(comparison.status)) {
        throw new Error(`Release commit ${sha} is no longer on main.`);
      }
      log(`Main CI passed for ${sha}: ${run.html_url}`);
      return run;
    }
    log(`Waiting for main CI for ${sha} (${attempt + 1}/${attempts})`);
    if (attempt + 1 < attempts) await sleep(15_000);
  }
  throw new Error(`Timed out waiting for main CI for ${sha}; rerun release after CI succeeds.`);
}

module.exports = { waitForMainCi };
