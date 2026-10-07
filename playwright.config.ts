import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? '14731');

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: true,
  workers: Number(process.env.PLAYWRIGHT_WORKERS ?? '8'),
  // Existing specs assert Chinese copy; pin the locale so language auto-detection stays deterministic.
  use: { reducedMotion: 'reduce', baseURL: `http://127.0.0.1:${port}`, locale: 'zh-CN', ...devices['Desktop Chrome'] },
  webServer: { command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
});
