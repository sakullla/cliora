/**
 * Renders the macOS app tile and rebuilds src-tauri/icons/icon.icns from it.
 *
 * macOS expects an app icon to fill the standard rounded-square tile; a bare
 * mark on transparency is placed on a grey system plate in the Dock, which
 * reads as a dimmed icon. Windows and Linux keep the transparent leaf, so only
 * the .icns (plus its 1024px source, icons/macos-tile-1024.png) changes here.
 *
 * Usage: node scripts/render-macos-icon.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const icons = `${root}src-tauri/icons`;
const leaf = fs.readFileSync(`${icons}/source-1024.png`).toString('base64');

// Same chunk set the previous bundle icon carried: PNG payloads only.
const chunks = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="tile" width="1024" height="1024"></canvas>
<script>
const canvas = document.getElementById('tile');
const ctx = canvas.getContext('2d');
// Apple macOS icon grid: an 824px rounded square centered on a 1024px canvas.
const x = 100, y = 100, size = 824, radius = 185;
const tile = () => { ctx.beginPath(); ctx.roundRect(x, y, size, size, radius); };
ctx.save();
ctx.shadowColor = 'rgba(8, 28, 16, 0.28)';
ctx.shadowBlur = 28;
ctx.shadowOffsetY = 12;
tile();
const fill = ctx.createLinearGradient(0, y, 0, y + size);
fill.addColorStop(0, '#ffffff');
fill.addColorStop(1, '#e2f0e6');
ctx.fillStyle = fill;
ctx.fill();
ctx.restore();
// A hairline keeps the light tile defined on a light Dock.
tile();
ctx.lineWidth = 2;
ctx.strokeStyle = 'rgba(14, 60, 34, 0.10)';
ctx.stroke();
window.render = (sizes) => new Promise(resolve => {
  const image = new Image();
  image.onload = () => {
    const mark = 560;
    ctx.drawImage(image, (1024 - mark) / 2 + 8, (1024 - mark) / 2 + 4, mark, mark);
    resolve(sizes.map(side => {
      const out = document.createElement('canvas');
      out.width = out.height = side;
      const small = out.getContext('2d');
      small.imageSmoothingEnabled = true;
      small.imageSmoothingQuality = 'high';
      small.drawImage(canvas, 0, 0, side, side);
      return out.toDataURL('image/png');
    }));
  };
  image.src = 'data:image/png;base64,${leaf}';
});
</script></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(html);
const sides = [...new Set(chunks.map(([, side]) => side))];
const urls = await page.evaluate((list) => window.render(list), sides);
await browser.close();
const pngs = new Map(sides.map((side, index) => [side, Buffer.from(urls[index].split(',')[1], 'base64')]));
fs.writeFileSync(`${icons}/macos-tile-1024.png`, pngs.get(1024));

const entry = (type, data) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
};
const bodies = chunks.map(([type, side]) => entry(type, pngs.get(side)));
const toc = entry('TOC ', Buffer.concat(chunks.map(([type, side]) => {
  const item = Buffer.alloc(8);
  item.write(type, 0, 'ascii');
  item.writeUInt32BE(pngs.get(side).length + 8, 4);
  return item;
})));
const payload = Buffer.concat([toc, ...bodies]);
const header = Buffer.alloc(8);
header.write('icns', 0, 'ascii');
header.writeUInt32BE(payload.length + 8, 4);
fs.writeFileSync(`${icons}/icon.icns`, Buffer.concat([header, payload]));
console.log(`${icons}/icon.icns`);
