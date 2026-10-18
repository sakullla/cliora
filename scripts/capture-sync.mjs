/** Synthetic WebDAV sync and backup screens for visual inspection; never platform acceptance evidence. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const option = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; };
const themeOption = option('--theme', 'all');
const themes = themeOption === 'all' ? ['light', 'dark'] : [themeOption];
const sizeOption = option('--size', 'all');
const widths = sizeOption === 'all' ? [1360, 900, 640] : sizeOption.split(',').map(Number);
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const out = process.env.CLIORA_CAPTURE_OUT ?? `${root}/docs/verification/ui-sync`;
const previewUrl = process.env.CLIORA_PREVIEW_URL ?? 'http://127.0.0.1:14736';
fs.mkdirSync(out, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const transfers = [
  { direction: 'download', key: 'library:1', label: '代码审查', kind: 'library', deleted: false },
  { direction: 'download', key: 'profile:1', label: 'Codex · 日常开发', kind: 'profile', deleted: false },
  { direction: 'download', key: 'skill:1', label: 'code-review', kind: 'skill', deleted: false },
  { direction: 'upload', key: 'account:1', label: '工作账号', kind: 'account', deleted: false },
  { direction: 'upload', key: 'mcp:1', label: 'filesystem', kind: 'mcp', deleted: false },
  { direction: 'upload', key: 'library:2', label: '', kind: 'library', deleted: true },
];
const project = (id, name, path, available) => ({ id, name, path, available, preferredTool: null, lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} });
const scenarios = {
  unconnected: { configured: false },
  healthy: { configured: true, lastSuccess: now - 180, receipt: { at: now - 180, compared: 42, uploaded: 3, downloaded: 3, transfers }, projects: [project('p1', '栖点', 'C:/Projects/cliora', true)] },
  attention: {
    configured: true, lastSuccess: now - 7200, pending: 3,
    receipt: { at: now - 7200, compared: 42, uploaded: 0, downloaded: 0, transfers: [] },
    projects: [project('p-missing', '个人网站', 'D:/Projects/site', false)],
    blockers: [
      { key: 'binding:codex', label: 'Codex 活动配置', action: 'install', detail: '未发现可执行文件' },
      { key: 'account:a1', label: '工作账号', action: 'relogin', detail: '登录被拒绝，材料已保留' },
    ],
    conflicts: [{ key: 'profile:9', label: 'Codex · 日常开发', localPresent: true, localDigest: 'aa', remoteVersions: 1, remoteDeleted: false, versions: [{ id: 'v1abcdef12', digest: 'bb', deleted: false }] }],
  },
  failing: { configured: true, lastSuccess: now - 86400 * 3, lastError: 'WebDAV 无法连接：connection refused (sync.example.com:443)' },
  paused: { configured: true, enabled: false, lastSuccess: now - 86400 },
};

function installMock(seed) {
  const control = { configured: false, enabled: true, lastSuccess: null, lastError: null, pending: 0, receipt: null, projects: [], blockers: [], conflicts: [], ...seed };
  const status = () => ({ configured: control.configured, enabled: control.enabled, endpoint: control.configured ? 'https://dav.jianguoyun.com/dav/cliora/' : null, lastSuccess: control.lastSuccess, lastError: control.lastError, retryAfter: null, uploaded: 0, downloaded: 0, pendingChanges: control.pending, conflicts: control.conflicts, blockers: control.blockers, transfers: [], compared: 0, receipt: control.receipt });
  const items = [
    { key: 'preferences:1', kind: 'preferences', label: '外观与管理偏好', status: 'available', pendingFields: [] },
    { key: 'profile:1', kind: 'profile', label: 'Codex · 日常开发', status: 'available', pendingFields: [] },
    { key: 'profile:2', kind: 'profile', label: 'Claude · 评审', status: 'available', pendingFields: [] },
    { key: 'library:1', kind: 'library', label: '代码审查', status: 'available', pendingFields: [] },
    { key: 'account:1', kind: 'account', label: '工作账号', status: 'available', pendingFields: [] },
    { key: 'project:1', kind: 'project', label: '栖点', status: 'available', pendingFields: [] },
  ];
  Object.assign(window, {
    isTauri: true,
    __sync: control,
    __TAURI_INTERNALS__: { invoke: async (command, args = {}) => {
      if (command === 'get_bootstrap' || command === 'set_language' || command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: control.theme, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], projectModelOverride: false, yoloAvailable: true, nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'list_projects') return control.projects;
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal' };
      if (command === 'get_tray_status') return { available: true, error: null };
      if (command === 'list_portable_items') return items;
      if (command === 'get_webdav_status' || command === 'set_webdav_enabled') return status();
      if (command === 'preview_webdav_conflict') return { key: args.key, localSummary: 'model = "gpt-6-astra"\nreasoning = "medium"', versions: [{ id: 'v1abcdef12', summary: 'model = "gpt-6-sol"\nreasoning = "high"', deleted: false }] };
      if (command === 'sync_webdav_now') {
        if (control.hang) await new Promise(() => {});
        control.receipt = { at: Math.floor(Date.now() / 1000), compared: 42, uploaded: 3, downloaded: 3, transfers: control.sampleTransfers ?? [] };
        return { ...status(), receipt: control.receipt };
      }
      if (command === 'plugin:event|listen') { control.listener = args.handler; return 1; }
      if (command === 'plugin:event|unlisten') return 1;
      return null;
    } },
  });
}

const browser = await chromium.launch();
const shots = [];
for (const theme of themes) for (const width of widths) {
  for (const [name, seed] of Object.entries(scenarios)) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: theme });
    await page.addInitScript(installMock, { ...seed, theme, sampleTransfers: transfers });
    await page.goto(previewUrl);
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '迁移与同步' }).click();
    await page.waitForTimeout(1000);
    const shot = async (label) => { const file = `${theme}-${width}-${label}.png`; await page.screenshot({ path: `${out}/${file}`, fullPage: true }); shots.push(file); };
    await shot(name);
    if (width === 1360 || width === 640) {
      if (name === 'unconnected') {
        await page.getByRole('button', { name: '配置 WebDAV' }).first().click();
        await page.waitForTimeout(700); await shot('connect-dialog');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '导出加密配置包' }).first().click();
        await page.waitForTimeout(700); await shot('export-dialog');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '从配置包恢复' }).first().click();
        await page.waitForTimeout(700); await shot('import-dialog');
        await page.keyboard.press('Escape');
      }
      if (name === 'attention') {
        const choose = page.getByRole('button', { name: '选择冲突版本' });
        if (await choose.count()) { await choose.first().click(); await page.waitForTimeout(700); await shot('conflict-open'); }
      }
      if (name === 'healthy') {
        await page.evaluate(() => { window.__sync.hang = true; });
        await page.getByRole('button', { name: '立即同步' }).first().click();
        await page.waitForTimeout(400); await shot('sync-running');
        await page.evaluate(() => { window.__sync.hang = false; });
        await page.reload();
        await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('tab', { name: '迁移与同步' }).click();
        await page.getByRole('button', { name: '立即同步' }).first().click();
        await page.waitForTimeout(900); await shot('sync-result');
      }
    }
    await page.close();
  }
}
await browser.close();
fs.writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Sync captures</title><style>body{font:14px system-ui;background:#222;color:#eee}figure{display:inline-block;margin:12px;vertical-align:top}img{max-width:640px;border:1px solid #555}</style>${shots.map((file) => `<figure><img src="${file}"><figcaption>${file}</figcaption></figure>`).join('')}`);
console.log(JSON.stringify({ out, count: shots.length }));
