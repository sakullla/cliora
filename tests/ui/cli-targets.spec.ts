import { expect, test, type Locator, type Page } from '@playwright/test';

const tools = [
  ['codex', 'Codex'],
  ['claude_code', 'Claude Code'],
  ['grok', 'Grok'],
  ['pi', 'Pi'],
  ['open_code', 'OpenCode'],
  ['zcode', 'ZCode'],
  ['qoder_cn', 'Qoder CN'],
  ['kimi_code', 'Kimi Code'],
  ['deepseek', 'DeepSeek Harness'],
  ['codebuddy', 'CodeBuddy'],
  ['mimo_code', 'MiMo Code'],
  ['cline', 'Cline'],
  ['devin', 'Devin'],
  ['command_code', 'Command Code'],
  ['antigravity', 'Antigravity'],
  ['kiro', 'Kiro'],
] as const;

async function mockLibrary(page: Page) {
  await page.addInitScript((catalog) => {
    const skillPackages = [{ id: 'skill-1', name: 'alpha', description: 'fixture', source: 'local', digest: 'fixture', fileCount: 1, inLibrary: true }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme: 'system' }, tools: [] };
        if (command === 'list_cli_adapters') return {
          registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } })),
          managedIds: catalog.map((item) => item[0]),
          preservedUnknown: [],
        };
        if (command === 'list_projects') return [{ id: 'second-project', name: 'Second project', path: '/tmp/second-project', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
        if (command === 'list_library_items') return [];
        if (command === 'get_registered_tool_workspace') {
          if (args.toolId === 'claude_code') throw { message: '账号绑定不可读' };
          return { probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null };
        }
        if (command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_native_mcp' || command === 'list_skill_installations' || command === 'list_skill_recovery_issues') return [];
        if (command === 'list_skill_packages') return skillPackages;
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_accounts') return [];
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  }, tools);
}

async function chipMetrics(dialog: Locator) {
  return dialog.getByRole('checkbox', { name: /^(Codex|Claude Code|Grok|Pi|OpenCode|ZCode|Qoder CN|Kimi Code|DeepSeek Harness|CodeBuddy|MiMo Code|Cline|Devin|Command Code|Antigravity|Kiro)$/ }).evaluateAll((nodes) => nodes.map((node) => {
    const label = node.parentElement as HTMLElement;
    const name = [...label.querySelectorAll('span')].find((item) => !item.classList.contains('tool-logo')) as HTMLElement;
    const icon = label.querySelector('.tool-logo') as HTMLElement;
    const labelBox = label.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      name: name.textContent ?? '',
      width: Math.round(labelBox.width),
      height: Math.round(labelBox.height),
      x: Math.round(labelBox.x),
      y: Math.round(labelBox.y),
      right: labelBox.right,
      checkboxAfterName: box.left >= nameBox.right - 1,
      color: getComputedStyle(name).color,
      opacity: getComputedStyle(label).opacity,
      icon: Math.round(icon.getBoundingClientRect().width),
      clipped: name.scrollWidth > name.clientWidth + 1,
      disabled: (node as HTMLInputElement).disabled,
      checked: (node as HTMLInputElement).checked,
    };
  }));
}

function expectEvenGrid(metrics: Awaited<ReturnType<typeof chipMetrics>>, dialogRight: number) {
  expect(metrics).toHaveLength(tools.length);
  expect(new Set(metrics.map((item) => item.width)).size).toBe(1);
  expect(new Set(metrics.map((item) => item.height)).size).toBe(1);
  expect(metrics.every((item) => item.checkboxAfterName && item.icon === 22 && item.height === 40)).toBe(true);
  expect(Math.max(...metrics.map((item) => item.right))).toBeLessThanOrEqual(dialogRight + 1);
}

test('tiled CLI targets share one grid in the skill and MCP dialogs', async ({ page }) => {
  await mockLibrary(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox', { name: 'DeepSeek Harness', exact: true })).toBeEnabled();
  await dialog.getByRole('checkbox', { name: 'Codex', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Kiro', exact: true }).check();
  const skillBox = await dialog.boundingBox();
  const skill = await chipMetrics(dialog);
  expectEvenGrid(skill, skillBox!.x + skillBox!.width);
  expect(new Set(skill.map((item) => item.x)).size).toBe(3);
  expect(skill.every((item) => !item.clipped)).toBe(true);
  const checked = skill.find((item) => item.name === 'Codex')!;
  const idle = skill.find((item) => item.name === 'Pi')!;
  expect(checked.checked).toBe(true);
  expect(checked.color).toBe(idle.color);

  await page.setViewportSize({ width: 720, height: 800 });
  const narrowBox = await dialog.boundingBox();
  const narrow = await chipMetrics(dialog);
  expectEvenGrid(narrow, narrowBox!.x + narrowBox!.width);
  expect(new Set(narrow.map((item) => item.x)).size).toBeGreaterThanOrEqual(2);
  expect(new Set(narrow.map((item) => item.x)).size).toBeLessThan(4);
  await page.setViewportSize({ width: 1280, height: 720 });

  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: 'Claude Code', exact: true })).toBeDisabled();
  const installBox = await dialog.boundingBox();
  const install = await chipMetrics(dialog);
  expectEvenGrid(install, installBox!.x + installBox!.width);
  expect(install.find((item) => item.name === 'Claude Code')!.opacity).toBe('0.7');
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: 'Claude Code', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'OpenCode', exact: true }).check();
  const mcpBox = await dialog.boundingBox();
  const mcp = await chipMetrics(dialog);
  expectEvenGrid(mcp, mcpBox!.x + mcpBox!.width);
  expect(mcp.find((item) => item.name === 'OpenCode')!.color).toBe(mcp.find((item) => item.name === 'Grok')!.color);
  expect(mcp.find((item) => item.name === 'Claude Code')!.opacity).toBe('0.7');
});
