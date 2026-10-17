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
    nameError: '名称只可用字母、数字、- 和 _，最多 80 个字符。',
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
    nameError: 'Names may use letters, digits, - and _ only, up to 80 characters.',
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
  contrast: number;
  clipped: boolean;
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

async function installReadingProbe(page: Page) {
  await page.addInitScript(() => {
    type Rgb = { r: number; g: number; b: number; a: number };
    function parseColor(value: string): Rgb | null {
      const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        const digits = hex[1].length === 3 ? hex[1].replace(/./g, (char) => char + char) : hex[1];
        return {
          r: Number.parseInt(digits.slice(0, 2), 16),
          g: Number.parseInt(digits.slice(2, 4), 16),
          b: Number.parseInt(digits.slice(4, 6), 16),
          a: 1,
        };
      }
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
      const channels = parts.slice(0, 3).map((part) => (part.endsWith('%') ? Number(part.slice(0, -1)) * 2.55 : Number(part)));
      const alphaPart = parts[3];
      const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith('%') ? Number(alphaPart.slice(0, -1)) / 100 : Number(alphaPart);
      if (channels.some((channel) => !Number.isFinite(channel)) || !Number.isFinite(alpha)) return null;
      return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
    }
    function composite(foreground: Rgb, background: Rgb): Rgb {
      return {
        r: foreground.r * foreground.a + background.r * (1 - foreground.a),
        g: foreground.g * foreground.a + background.g * (1 - foreground.a),
        b: foreground.b * foreground.a + background.b * (1 - foreground.a),
        a: 1,
      };
    }
    function wcag(text: Rgb, bg: Rgb) {
      const linear = (channel: number) => {
        const encoded = channel / 255;
        return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (rgb: Rgb) => 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
      const lighter = Math.max(luminance(text), luminance(bg));
      const darker = Math.min(luminance(text), luminance(bg));
      return (lighter + 0.05) / (darker + 0.05);
    }
    function backdrop(node: Element): Rgb {
      const layers: Rgb[] = [];
      let current: Element | null = node;
      while (current) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0) layers.push(color);
        if (color && color.a >= 0.999) break;
        current = current.parentElement;
      }
      return layers.reduceRight((bg, layer) => composite(layer, bg), { r: 255, g: 255, b: 255, a: 1 });
    }
    function outsideClip(box: { left: number; top: number; right: number; bottom: number }, node: Element, stop: Element) {
      let current: Element | null = node;
      while (current) {
        const style = getComputedStyle(current);
        const clipsX = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX);
        const clipsY = ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY);
        if (clipsX || clipsY) {
          const rect = current.getBoundingClientRect();
          if (clipsX && (box.left < rect.left - 0.5 || box.right > rect.right + 0.5)) return true;
          if (clipsY && (box.top < rect.top - 0.5 || box.bottom > rect.bottom + 0.5)) return true;
        }
        if (current === stop) break;
        current = current.parentElement;
      }
      return false;
    }
    Object.assign(window, { __readingProbe: { parseColor, wcag, backdrop, outsideClip } });
  });
}

async function openEditMcp(page: Page, language: 'zh' | 'en') {
  const text = copy[language];
  await installReadingProbe(page);
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
    const probe = (window as unknown as {
      __readingProbe?: {
        parseColor: (value: string) => { r: number; g: number; b: number; a: number } | null;
        wcag: (text: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) => number;
        backdrop: (node: Element) => { r: number; g: number; b: number; a: number };
        outsideClip: (box: { left: number; top: number; right: number; bottom: number }, node: Element, stop: Element) => boolean;
      };
    }).__readingProbe;
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return { error: 'dialog missing' };
    if (!probe) return { error: 'reading probe missing' };
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
      if (!box || !probe) return { error: `missing box for ${sample}` };
      const paint = probe.parseColor(getComputedStyle(node).color);
      const ground = probe.backdrop(node);
      if (!paint || !ground) return { error: `color missing for ${sample}` };
      const visible = paint.a < 0.999 ? {
        r: paint.r * paint.a + ground.r * (1 - paint.a),
        g: paint.g * paint.a + ground.g * (1 - paint.a),
        b: paint.b * paint.a + ground.b * (1 - paint.a),
        a: 1,
      } : paint;
      return { contrast: probe.wcag(visible, ground), clipped: probe.outsideClip(box, node, dialog), box, text: sample };
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
    const hintMarginTop = Number.parseFloat(getComputedStyle(hint).marginTop);
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
      hintMarginTop,
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
        const dialog = await openEditMcp(page, language);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const layout = await readLayout(page, language);
        expect(layout, JSON.stringify(layout)).not.toHaveProperty('error');
        if ('error' in layout) return;
        const pieces = [layout.nameLabel, layout.nameValue, layout.hint, layout.argValue];
        for (const piece of pieces) {
          expect(piece, JSON.stringify(piece)).not.toHaveProperty('error');
          if ('error' in piece) continue;
          // Size and weight are not pass conditions. Visibility, separation, and 4.5:1 are.
          expect(piece.contrast, piece.text).toBeGreaterThanOrEqual(4.5);
          expect(piece.clipped, piece.text).toBe(false);
          expect(piece.box.width, piece.text).toBeGreaterThan(0);
          expect(piece.box.height, piece.text).toBeGreaterThan(0);
          expect(piece.box.left, piece.text).toBeGreaterThanOrEqual(-0.5);
          expect(piece.box.top, piece.text).toBeGreaterThanOrEqual(-0.5);
          expect(piece.box.right, piece.text).toBeLessThanOrEqual(layout.viewport.width + 0.5);
          expect(piece.box.bottom, piece.text).toBeLessThanOrEqual(layout.viewport.height + 0.5);
        }
        expect(layout.hintMarginTop).toBeGreaterThanOrEqual(0);
        const boxes = pieces.filter((piece): piece is Reading => !('error' in piece));
        for (let index = 0; index < boxes.length; index += 1) {
          for (let next = index + 1; next < boxes.length; next += 1) {
            expect(overlaps(boxes[index].box, boxes[next].box), `${boxes[index].text} ∩ ${boxes[next].text}`).toBe(false);
          }
          for (const border of layout.borders) {
            expect(hitsBorder(boxes[index].box, border), `${boxes[index].text} border`).toBe(false);
          }
        }
        await dialog.getByRole('textbox', { name: text.nameAria, exact: true }).fill('bad name');
        const fieldError = dialog.getByText(text.nameError, { exact: true });
        await expect(fieldError).toBeVisible();
        const errorLayout = await fieldError.evaluate((node) => {
          const probe = (window as unknown as {
            __readingProbe?: {
              parseColor: (value: string) => { r: number; g: number; b: number; a: number } | null;
              wcag: (text: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) => number;
              backdrop: (node: Element) => { r: number; g: number; b: number; a: number };
              outsideClip: (box: { left: number; top: number; right: number; bottom: number }, node: Element, stop: Element) => boolean;
            };
          }).__readingProbe;
          const dialogNode = node.closest('dialog');
          const control = node.parentElement?.querySelector('input, textarea, select');
          if (!probe || !dialogNode || !control) return { error: 'field error context missing' };
          const paint = probe.parseColor(getComputedStyle(node).color);
          const ground = probe.backdrop(node);
          if (!paint || !ground) return { error: 'field error color missing' };
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
          if (!rects.length) return { error: 'field error box missing' };
          const left = Math.min(...rects.map((rect) => rect.left));
          const top = Math.min(...rects.map((rect) => rect.top));
          const right = Math.max(...rects.map((rect) => rect.right));
          const bottom = Math.max(...rects.map((rect) => rect.bottom));
          const box = { left, top, right, bottom, width: right - left, height: bottom - top };
          const controlRect = control.getBoundingClientRect();
          return {
            contrast: probe.wcag(paint.a < 0.999 ? {
              r: paint.r * paint.a + ground.r * (1 - paint.a),
              g: paint.g * paint.a + ground.g * (1 - paint.a),
              b: paint.b * paint.a + ground.b * (1 - paint.a),
              a: 1,
            } : paint, ground),
            clipped: probe.outsideClip(box, node, dialogNode),
            marginTop: Number.parseFloat(getComputedStyle(node).marginTop),
            box,
            control: {
              left: controlRect.left,
              top: controlRect.top,
              right: controlRect.right,
              bottom: controlRect.bottom,
              width: controlRect.width,
              height: controlRect.height,
            },
          };
        });
        expect(errorLayout, JSON.stringify(errorLayout)).not.toHaveProperty('error');
        if (!('error' in errorLayout)) {
          expect(errorLayout.contrast).toBeGreaterThanOrEqual(4.5);
          expect(errorLayout.clipped).toBe(false);
          expect(errorLayout.marginTop).toBeGreaterThanOrEqual(0);
          expect(overlaps(errorLayout.box, errorLayout.control), 'field error overlaps its control').toBe(false);
        }
        await context.close();
      });
    }
  }
}

function channels(color: string) {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].replace(/./g, (char) => char + char) : hex[1];
    return [0, 2, 4].map((index) => String(Number.parseInt(digits.slice(index, index + 2), 16))).join(',');
  }
  return (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => String(Math.round(Number(part)))).join(',');
}

for (const theme of ['light', 'dark'] as const) {
  test(`shared controls keep one field, one primary button, and separate hover and focus ${theme}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      baseURL,
      locale: 'zh-CN',
      viewport: { width: 1160, height: 780 },
      reducedMotion: 'reduce',
      colorScheme: theme,
    });
    const page = await context.newPage();
    await installLibrary(page, theme, 'zh');
    const dialog = await openEditMcp(page, 'zh');
    const http = dialog.getByRole('button', { name: 'HTTP', exact: true });
    const input = dialog.getByRole('textbox', { name: copy.zh.nameAria, exact: true });
    const save = dialog.locator('[data-dialog-save]');
    const background = (locator: typeof http) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
    const rest = await background(http);
    await http.hover();
    await expect.poll(() => background(http), { timeout: 1000 }).not.toBe(rest);
    await input.hover();
    await expect.poll(() => background(http), { timeout: 1000 }).toBe(rest);

    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const field = document.querySelector<HTMLElement>('dialog[open] input[aria-label="名称"]');
      const primary = document.querySelector<HTMLElement>('dialog[open] [data-dialog-save]');
      const fieldStyle = field ? getComputedStyle(field) : null;
      const primaryStyle = primary ? getComputedStyle(primary) : null;
      return {
        radius: root.getPropertyValue('--radius-sm').trim(),
        surface: root.getPropertyValue('--surface').trim(),
        accent: root.getPropertyValue('--accent').trim(),
        onAccent: root.getPropertyValue('--on-accent').trim(),
        selection: root.getPropertyValue('--selection').trim(),
        fieldRadius: fieldStyle?.borderRadius ?? '',
        fieldBg: fieldStyle?.backgroundColor ?? '',
        primaryRadius: primaryStyle?.borderRadius ?? '',
        primaryBg: primaryStyle?.backgroundColor ?? '',
        primaryColor: primaryStyle?.color ?? '',
      };
    });
    expect(tokens.selection).toMatch(/^#[0-9a-f]{6}$/i);
    expect(tokens.fieldRadius.split(' ')[0]).toBe(tokens.radius);
    expect(tokens.primaryRadius.split(' ')[0]).toBe(tokens.radius);
    expect(channels(tokens.fieldBg)).toBe(channels(tokens.surface));
    expect(channels(tokens.primaryBg)).toBe(channels(tokens.accent));
    expect(channels(tokens.primaryColor)).toBe(channels(tokens.onAccent));

    await input.click();
    const inputRing = await input.evaluate((el) => {
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
    });
    expect(inputRing.outlineStyle).toBe('solid');
    expect(inputRing.outlineWidth).toBeGreaterThanOrEqual(2);

    await save.evaluate((el) => {
      el.addEventListener('click', (event) => event.stopPropagation(), { capture: true });
    });
    await save.click();
    const pointerRing = await save.evaluate((el) => ({
      active: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: getComputedStyle(el).outlineStyle,
    }));
    expect(pointerRing.active).toBe(true);
    expect(pointerRing.focusVisible).toBe(false);
    expect(pointerRing.outlineStyle).toBe('none');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const keyRing = await save.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        active: document.activeElement === el,
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(keyRing.active).toBe(true);
    expect(keyRing.focusVisible).toBe(true);
    expect(keyRing.outlineStyle).toBe('solid');
    expect(keyRing.outlineWidth).toBeGreaterThanOrEqual(2);
    await context.close();
  });
}
