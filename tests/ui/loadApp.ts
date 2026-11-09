import type { Page } from '@playwright/test';

/** Retry only the documented network failure; a missing app shell is a test failure. */
export async function loadApp(page: Page) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto('/');
    } catch (error) {
      if (!/net::ERR_NO_BUFFER_SPACE/.test(String(error)) || attempt >= 3) throw error;
      process.stdout.write(`\n[env-retry] page.goto net::ERR_NO_BUFFER_SPACE, load attempt ${attempt + 1}/3\n`);
      continue;
    }
    await page.getByRole('navigation', { name: '页面' }).waitFor({ state: 'attached', timeout: 8000 });
    return;
  }
}
