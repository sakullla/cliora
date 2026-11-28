import os from 'node:os';
import { defineConfig, devices } from '@playwright/test';

// Vite binds port 0 atomically. Playwright takes the actual URL from its ready
// line before launching workers, including when several suites start together.
const configuredPort = process.env.PLAYWRIGHT_PORT;
const port = configuredPort === undefined ? 0 : Number(configuredPort);
if (configuredPort !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
  throw new Error('PLAYWRIGHT_PORT must be an integer from 0 to 65535');
}

// workbench-terminal.spec.ts is the longest file (about a seventh of the suite's test time).
// It used to run as one serial group behind every other file, so it became the tail of the run.
// Its projects are listed first so the dispatcher queues them ahead of the rest. Only its WebGL
// groups need Chromium's software GPU (terminal-gpu, one worker); the DOM-rendered remainder
// runs on at most PLAYWRIGHT_TERMINAL_WORKERS workers (3 by default) so the renderers sharing
// the CPU cannot starve each other's rendering assertions.
const terminalSuite = /workbench-terminal\.spec\.ts$/;
const webglGroups = /product WebGL input integration|session switching with the production renderer/;
const softwareGpu = { launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } };
const terminalWorkers = Number(process.env.PLAYWRIGHT_TERMINAL_WORKERS ?? '3');
if (!Number.isInteger(terminalWorkers) || terminalWorkers < 1) throw new Error('PLAYWRIGHT_TERMINAL_WORKERS must be a positive integer');

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  projects: [
    { name: 'terminal-gpu', testMatch: terminalSuite, grep: webglGroups, use: softwareGpu, workers: 1 },
    { name: 'terminal', testMatch: terminalSuite, grepInvert: webglGroups, workers: terminalWorkers },
    { name: 'ui', testIgnore: terminalSuite },
  ],
  // ADR-7: workers track the machine's logical CPUs (8 here) instead of a hardcoded number.
  // The recorded environment-class failures (net::ERR_NO_BUFFER_SPACE on page.goto) also
  // appeared with 2 workers, so lowering the count is not the fix; bounded retries for that
  // failure class live in scripts/test-ui.mjs and the specs' load helper.
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? String(Math.min(8, os.availableParallelism()))),
  // Existing specs assert Chinese copy; pin the locale so language auto-detection stays deterministic.
  use: { reducedMotion: 'reduce', locale: 'zh-CN', ...devices['Desktop Chrome'] },
  webServer: { command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
    wait: { stdout: /Local:\s*(?<PLAYWRIGHT_TEST_BASE_URL>http:\/\/127\.0\.0\.1:\d+)\// },
    reuseExistingServer: false, timeout: 30000 },
});
