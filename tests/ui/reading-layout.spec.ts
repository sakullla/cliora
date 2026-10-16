import { expect, test, type Page } from '@playwright/test';

const nameValue = 'chrome-devtools-mcp';
const argValue = 'chrome-devtools-mcp@latest';

const copy = {
  zh: {
    locale: 'zh-CN',
    nav: '页面',
    library: '资料库',
    edit: '修改',
    dialog: '修改 MCP',
    loading: '正在读取本机设置',
    nameLabel: 'MCP 服务器名称',
    nameAria: '名称',
    hint: 'CLI 会运行这条命令，通过标准输入输出通信。适合 npx、uvx 或本机程序。',
    argRow: '参数，每行一项 第 1 行',
  },
  en: {
    locale: 'en-US',
    nav: 'Pages',
    library: 'Library',
    edit: 'Edit',
    dialog: 'Edit MCP',
    loading: 'Loading local settings',
    nameLabel: 'MCP server name',
    nameAria: 'Name',
    hint: 'The CLI runs this command and talks to it over standard input/output. Suits npx, uvx, or local programs.',
    argRow: 'Arguments, one per line row 1',
  },
} as const;

const viewports = [
  { width: 1160, height: 780, scale: 1 },
  { width: 720, height: 560, scale: 1 },
  { width: 720, height: 560, scale: 1.5 },
] as const;

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Reading = {
  fontSize: number;
  fontWeight: number;
  box: Box;
  text: string;
};

async function installLibrary(page: Page, theme: 'light' | 'dark', language: 'zh' | 'en') {
  await page.addInitScript((stored) => {
    localStorage.setItem('cliora:language', stored);
  }, language);
  await page.addInitScript((themeName) => {
    const definitions: Array<Record<string, unknown>> = [{
      id: 'mcp-chrome',
      name: 'placeholder-server',
      transport: 'stdio',
      command: 'npx',
      args: ['--help'],
      url: '',
      env: {},
      headers: {},
      inLibrary: true,
      version: 1,
    }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: themeName }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [{ id: 'second-project', name: 'Second project', path: '/tmp/second-project', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
        if (command === 'list_library_items') return [];
        if (command === 'list_mcp_definitions') return definitions;
        if (command === 'list_mcp_placements') return [];
        if (command === 'list_native_mcp') return [];
        if (command === 'list_skill_packages') return [];
        if (command === 'list_accounts') return [];
        if (command === 'list_history_sessions') return [];
        if (command === 'list_portable_items') return [];
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
          profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'set_theme') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: args.theme }, tools: [{ id: 'codex', name: 'Codex' }] };
        return null;
      } },
    });
  }, theme);
}

async function openEditMcp(page: Page, language: 'zh' | 'en') {
  const text = copy[language];
  await page.goto('/');
  await expect(page.getByText(text.loading)).toBeHidden();
  await page.getByRole('navigation', { name: text.nav }).getByRole('button', { name: text.library, exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: text.edit, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: text.dialog });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'stdio', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('textbox', { name: text.nameAria, exact: true }).fill(nameValue);
  await dialog.getByRole('textbox', { name: text.argRow, exact: true }).fill(argValue);
  await dialog.locator('.guide-dialog-body').evaluate((node) => { node.scrollTop = 0; });
  return dialog;
}

async function readLayout(page: Page, language: 'zh' | 'en') {
  const text = copy[language];
  return page.evaluate(({ text, nameValue, argValue }) => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return { error: 'dialog missing' };
    function weightOf(value: string) {
      if (value === 'normal') return 400;
      if (value === 'bold') return 700;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    function union(rects: DOMRect[]) {
      const visible = rects.filter((rect) => rect.width > 0 && rect.height > 0);
      if (!visible.length) return null;
      const left = Math.min(...visible.map((rect) => rect.left));
      const top = Math.min(...visible.map((rect) => rect.top));
      const right = Math.max(...visible.map((rect) => rect.right));
      const bottom = Math.max(...visible.map((rect) => rect.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    }
    function reading(node: Element, box: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null, sample: string): Reading | { error: string } {
      if (!box) return { error: `missing box for ${sample}` };
      const style = getComputedStyle(node);
      return { fontSize: parseFloat(style.fontSize), fontWeight: weightOf(style.fontWeight), box, text: sample };
    }
    const label = [...dialog.querySelectorAll('label')].find((node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').includes(text.nameLabel)));
    if (!label) return { error: 'name label missing' };
    const labelNode = [...label.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').includes(text.nameLabel));
    if (!labelNode?.textContent) return { error: 'name label text missing' };
    const start = labelNode.textContent.indexOf(text.nameLabel);
    const labelRange = document.createRange();
    labelRange.setStart(labelNode, start);
    labelRange.setEnd(labelNode, start + text.nameLabel.length);
    const hint = [...dialog.querySelectorAll('p')].find((node) => node.textContent?.trim() === text.hint);
    if (!hint) return { error: 'transport hint missing' };
    const hintRange = document.createRange();
    hintRange.selectNodeContents(hint);
    const nameInput = dialog.querySelector<HTMLInputElement>(`input[aria-label="${text.nameAria}"]`);
    const argInput = [...dialog.querySelectorAll<HTMLInputElement>('input')].find((node) => node.value === argValue);
    if (!nameInput || nameInput.value !== nameValue || !argInput) return { error: 'inputs missing' };
    function valueBox(input: HTMLInputElement) {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.font = style.font;
      const metrics = context.measureText(input.value);
      const rect = input.getBoundingClientRect();
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderBottom = parseFloat(style.borderBottomWidth) || 0;
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const padBottom = parseFloat(style.paddingBottom) || 0;
      const ascent = metrics.actualBoundingBoxAscent || parseFloat(style.fontSize) * 0.8;
      const descent = metrics.actualBoundingBoxDescent || parseFloat(style.fontSize) * 0.2;
      const textHeight = ascent + descent;
      const contentTop = rect.top + borderTop + padTop;
      const contentHeight = rect.height - borderTop - borderBottom - padTop - padBottom;
      const top = contentTop + Math.max(0, (contentHeight - textHeight) / 2);
      const left = rect.left + borderLeft + padLeft;
      return { left, top, right: left + metrics.width, bottom: top + textHeight, width: metrics.width, height: textHeight };
    }
    const borders = [...dialog.querySelectorAll<HTMLInputElement>('input, textarea, select')].map((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        borderLeft: parseFloat(style.borderLeftWidth) || 0,
        borderRight: parseFloat(style.borderRightWidth) || 0,
        borderTop: parseFloat(style.borderTopWidth) || 0,
        borderBottom: parseFloat(style.borderBottomWidth) || 0,
      };
    });
    return {
      nameLabel: reading(label, union([...labelRange.getClientRects()]), text.nameLabel),
      nameValue: reading(nameInput, valueBox(nameInput), nameValue),
      hint: reading(hint, union([...hintRange.getClientRects()]), text.hint),
      argValue: reading(argInput, valueBox(argInput), argValue),
      borders,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, { text, nameValue, argValue });
}

function overlaps(a: Box, b: Box) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
}

function hitsBorder(text: Box, border: { left: number; top: number; right: number; bottom: number; borderLeft: number; borderRight: number; borderTop: number; borderBottom: number }) {
  const inside = text.left >= border.left + border.borderLeft - 0.5
    && text.right <= border.right - border.borderRight + 0.5
    && text.top >= border.top + border.borderTop - 0.5
    && text.bottom <= border.bottom - border.borderBottom + 0.5;
  if (inside) return false;
  return overlaps(text, border);
}

for (const theme of ['light', 'dark'] as const) {
  for (const language of ['zh', 'en'] as const) {
    for (const viewport of viewports) {
      test(`edit MCP reading ${theme} ${language} ${viewport.width}x${viewport.height} @${viewport.scale}`, async ({ browser, baseURL }) => {
        const text = copy[language];
        const context = await browser.newContext({
          baseURL,
          locale: text.locale,
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.scale,
          reducedMotion: 'reduce',
          colorScheme: theme,
        });
        const page = await context.newPage();
        await installLibrary(page, theme, language);
        await openEditMcp(page, language);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const layout = await readLayout(page, language);
        expect(layout, JSON.stringify(layout)).not.toHaveProperty('error');
        if ('error' in layout) return;
        const pieces = [layout.nameLabel, layout.nameValue, layout.hint, layout.argValue];
        for (const piece of pieces) {
          expect(piece, JSON.stringify(piece)).not.toHaveProperty('error');
          if ('error' in piece) continue;
          expect(piece.fontSize, piece.text).toBeGreaterThanOrEqual(14);
          expect(piece.fontWeight, piece.text).toBeGreaterThanOrEqual(400);
          expect(piece.box.width, piece.text).toBeGreaterThan(0);
          expect(piece.box.height, piece.text).toBeGreaterThan(0);
          expect(piece.box.left, piece.text).toBeGreaterThanOrEqual(-0.5);
          expect(piece.box.top, piece.text).toBeGreaterThanOrEqual(-0.5);
          expect(piece.box.right, piece.text).toBeLessThanOrEqual(layout.viewport.width + 0.5);
          expect(piece.box.bottom, piece.text).toBeLessThanOrEqual(layout.viewport.height + 0.5);
        }
        const boxes = pieces.filter((piece): piece is Reading => !('error' in piece));
        for (let index = 0; index < boxes.length; index += 1) {
          for (let next = index + 1; next < boxes.length; next += 1) {
            expect(overlaps(boxes[index].box, boxes[next].box), `${boxes[index].text} ∩ ${boxes[next].text}`).toBe(false);
          }
          for (const border of layout.borders) {
            expect(hitsBorder(boxes[index].box, border), `${boxes[index].text} border`).toBe(false);
          }
        }
        await context.close();
      });
    }
  }
}
