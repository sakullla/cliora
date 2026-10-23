import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
const security = config.app.security;
const directives = Object.fromEntries(security.csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
  const [name, ...values] = part.split(/\s+/);
  return [name, values];
}));

// xterm.js's DOM renderer injects <style> elements for font, colors, row metrics and the cursor.
// Without them the workbench terminal renders as unstyled proportional text with no cursor.
test('workbench terminal styles are allowed by the desktop CSP', () => {
  assert.ok(directives['style-src']?.includes("'unsafe-inline'"), 'style-src must allow xterm injected <style> elements');
  // Tauri appends a nonce to style-src unless told not to; a nonce makes browsers ignore 'unsafe-inline'.
  const disabled = security.dangerousDisableAssetCspModification;
  assert.ok(disabled === true || (Array.isArray(disabled) && disabled.includes('style-src')), 'Tauri must not add a style-src nonce');
});

test('script policy stays strict', () => {
  const scripts = directives['script-src'] ?? directives['default-src'];
  assert.ok(!scripts.includes("'unsafe-inline'") && !scripts.includes("'unsafe-eval'"));
  assert.notEqual(security.dangerousDisableAssetCspModification, true);
});
