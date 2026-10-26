import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '测试远程主机',
  host: '212.60.153.19',
  port: 22,
  user: 'root',
  authMethod: 'key',
  identityFile: '',
  sshConfig: null,
  defaultPath: '/srv/project',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const rule = {
  id: 'remote-rule-1',
  kind: 'rule',
  title: '远端规则',
  body: 'stay remote',
  category: '',
  projectId: null,
  version: 1,
  updatedAt: 1,
};

async function installRemoteRules(page: Page) {
  await page.addInitScript(({ host, rule }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code' };
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
      management: { accounts: false, mcp: true, skills: true, agents: false, plugins: false, projectPlugins: false, rules: { global: true, project: false, catalog: false, globalReason: '', projectReason: '' } },
    }));
    const calls: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __ruleCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'sync_rule_clients' || command === 'sync_remote_rule_clients' || command === 'list_remote_rule_placements' || command === 'list_rule_placements') {
            calls.push({ command, targetId: args.targetId, ruleId: args.ruleId, selection: args.selection });
          }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_library_items') return args.kind === 'rule' ? [rule] : [];
          if (command === 'list_remote_rule_placements') return [];
          if (command === 'sync_remote_rule_clients') return [{ toolId: 'codex', path: '/root/.codex/AGENTS.md', status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: '' }];
          if (command === 'list_library_items' || command === 'list_projects' || command === 'list_accounts' || command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_skill_packages' || command === 'list_remote_resource_stores') return [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  }, { host, rule });
}

test('a remote rule icon writes that host, not this computer', async ({ page }) => {
  await installRemoteRules(page);
  await page.goto('/');
  await expect(page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: /长期规则/ }).click();
  await expect(page.getByRole('button', { name: '远端规则' })).toBeVisible();
  await page.getByRole('button', { name: 'Codex · 未写入' }).click();
  await expect(page.getByText('已写入 Codex。')).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __ruleCalls: Array<{ command: string; targetId?: string; ruleId?: string; selection?: { toolIds?: string[]; scope?: string } }> }).__ruleCalls);
  expect(calls.filter((call) => call.command === 'sync_rule_clients')).toEqual([]);
  expect(calls.filter((call) => call.command === 'list_rule_placements')).toEqual([]);
  const synced = calls.filter((call) => call.command === 'sync_remote_rule_clients');
  expect(synced).toHaveLength(1);
  expect(synced[0].targetId).toBe(host.id);
  expect(synced[0].ruleId).toBe(rule.id);
  expect(synced[0].selection?.toolIds).toEqual(['codex']);
  expect(synced[0].selection?.scope).toBe('global');
});
