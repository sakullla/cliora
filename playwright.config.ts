import os from 'node:os';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '14731');

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  // ADR-7: workers track the machine's logical CPUs (8 here) instead of a hardcoded number.
  // The recorded environment-class failures (net::ERR_NO_BUFFER_SPACE on page.goto) also
  // appeared with 2 workers, so lowering the count is not the fix; bounded retries for that
  // failure class live in scripts/test-ui.mjs and the specs' load helper.
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? String(Math.min(8, os.availableParallelism()))),
  // Existing specs assert Chinese copy; pin the locale so language auto-detection stays deterministic.
  use: { reducedMotion: 'reduce', baseURL: `http://127.0.0.1:${port}`, locale: 'zh-CN', ...devices['Desktop Chrome'] },
  webServer: { command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
