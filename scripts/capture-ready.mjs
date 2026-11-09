import fs from 'node:fs';
import path from 'node:path';

/** Only prune PNGs owned by the previous gallery, after a successful replacement. */
export function previousCaptureCleanup(directory, manifestName) {
  const root = path.resolve(directory);
  let previous = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'));
    previous = (manifest.captures ?? manifest.shots ?? []).map(shot => typeof shot === 'string' ? shot : shot.file ?? `${shot.name}.png`);
  } catch { /* A first run has no owned screenshots to remove. */ }
  return files => {
    if (!files.length) return;
    const keep = new Set(files);
    for (const file of previous) {
      if (typeof file !== 'string' || !file.endsWith('.png') || path.basename(file) !== file || keep.has(file)) continue;
      const target = path.resolve(root, file);
      if (path.dirname(target) !== root) continue;
      try { if (fs.lstatSync(target).isFile()) fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
}

/** Wait for paint/font work after a scenario has reached its observable UI state. */
export async function settleCapture(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
