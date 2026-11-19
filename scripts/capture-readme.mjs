/**
 * README screenshots: four curated product views from synthetic native IPC (no real accounts, keys or sessions).
 * Start a frontend first (`npm run dev -- --port 14736`), then `node scripts/capture-readme.mjs`.
 * Writes docs/screenshots/{workbench,home,sessions,usage}.png (override with CLIORA_CAPTURE_OUT).
 * These images illustrate the UI; they are not native platform acceptance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { mock } from './capture-ui-mock.mjs';
import { installCaptureConfigurationProtocol } from './capture-configuration.mjs';
import { installPromptFixtureBridge } from './capture-prompt-fixtures.mjs';
import { settleCapture } from './capture-ready.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.CLIORA_CAPTURE_OUT ?? path.join(root, 'docs/screenshots');
const url = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
// The fixtures are dated around 2026-10-03; a fixed clock keeps "today", relative times and quota freshness coherent.
const now = new Date('2026-10-03T12:08:00+08:00');
fs.mkdirSync(out, { recursive: true });

// Workbench: reuse the workbench capture with its replay padding removed, at 2x.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cliora-readme-'));
execFileSync(process.execPath, [path.join(root, 'scripts/capture-workbench.mjs'), '--only', 'workbench-active-dark-1360'], {
  stdio: 'inherit',
  env: { ...process.env, CLIORA_CAPTURE_OUT: scratch, CLIORA_CAPTURE_CLEAN: '1', CLIORA_CAPTURE_SCALE: '2', CLIORA_PREVIEW_URL: url },
});
fs.copyFileSync(path.join(scratch, 'workbench-active-dark-1360.png'), path.join(out, 'workbench.png'));
fs.rmSync(scratch, { recursive: true, force: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' });
page.on('pageerror', error => console.error('pageerror', error.message));
await page.clock.setFixedTime(now);
await page.addInitScript(mock, 'light');
await installCaptureConfigurationProtocol(page);
await page.addInitScript(installPromptFixtureBridge);
await page.goto(url);
await page.getByText('正在读取本机设置').waitFor({ state: 'hidden' });
const nav = page.getByRole('navigation', { name: '页面' });
async function shot(name) {
  await settleCapture(page);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('wrote', name);
}

await page.getByRole('heading', { name: '受管理工具' }).waitFor();
await shot('home');
await nav.getByRole('button', { name: '记录' }).click();
await page.getByRole('button', { name: '复制代码', exact: true }).waitFor();
await shot('sessions');
await page.getByRole('tab', { name: '用量', exact: true }).click();
await page.getByRole('radio', { name: '近 7 天', exact: true }).click();
await page.getByRole('region', { name: '消耗最多的会话' }).waitFor();
await shot('usage');

await browser.close();
