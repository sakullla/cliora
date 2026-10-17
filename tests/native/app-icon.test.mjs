import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

const root = new URL('../../', import.meta.url);

const productPngs = [
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/64x64.png',
  'src-tauri/icons/icon.png',
  'src-tauri/icons/source-1024.png',
  'src-tauri/icons/Square30x30Logo.png',
  'src-tauri/icons/Square44x44Logo.png',
  'src-tauri/icons/Square71x71Logo.png',
  'src-tauri/icons/Square89x89Logo.png',
  'src-tauri/icons/Square107x107Logo.png',
  'src-tauri/icons/Square142x142Logo.png',
  'src-tauri/icons/Square150x150Logo.png',
  'src-tauri/icons/Square284x284Logo.png',
  'src-tauri/icons/Square310x310Logo.png',
  'src-tauri/icons/StoreLogo.png',
];

function read(path) {
  return readFileSync(new URL(path, root));
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  if (upDistance <= diagonal) return up;
  return upLeft;
}

function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.subarray(0, 8).equals(signature), 'not a png');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, 'png bit depth');
  assert.equal(interlace, 0, 'png interlace');
  const channels = { 2: 3, 6: 4 }[colorType];
  assert.ok(channels, `png color type ${colorType}`);
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (stride + 1), 'png inflated size');
  const rgba = new Uint8Array(width * height * 4);
  let source = 0;
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? row[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      const value = raw[source + index];
      if (filter === 0) row[index] = value;
      else if (filter === 1) row[index] = (value + left) & 255;
      else if (filter === 2) row[index] = (value + up) & 255;
      else if (filter === 3) row[index] = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) row[index] = (value + paeth(left, up, upLeft)) & 255;
      else assert.fail(`png filter ${filter}`);
    }
    source += stride;
    previous.set(row);
    for (let x = 0; x < width; x += 1) {
      const input = x * channels;
      const output = (y * width + x) * 4;
      if (channels === 4) {
        rgba[output] = row[input];
        rgba[output + 1] = row[input + 1];
        rgba[output + 2] = row[input + 2];
        rgba[output + 3] = row[input + 3];
      } else {
        rgba[output] = row[input];
        rgba[output + 1] = row[input + 1];
        rgba[output + 2] = row[input + 2];
        rgba[output + 3] = 255;
      }
    }
  }
  return { width, height, rgba, mask: false };
}

function decodeIcoBitmap(chunk, width, height) {
  assert.ok(chunk.readUInt32LE(0) >= 40, 'ico bitmap header');
  const bitCount = chunk.readUInt16LE(14);
  assert.equal(bitCount, 32, `ico bitmap ${bitCount}bpp`);
  const compression = chunk.readUInt32LE(16);
  let pixelOffset = chunk.readUInt32LE(0);
  if (compression === 3) pixelOffset += 16;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = pixelOffset + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 4;
      const output = (y * width + x) * 4;
      rgba[output] = chunk[source + 2];
      rgba[output + 1] = chunk[source + 1];
      rgba[output + 2] = chunk[source];
      rgba[output + 3] = chunk[source + 3];
    }
  }
  const maskOffset = pixelOffset + width * height * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  if (maskOffset + maskStride * height <= chunk.length) {
    for (let y = 0; y < height; y += 1) {
      const row = maskOffset + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x += 1) {
        const transparent = (chunk[row + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (transparent) rgba[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  return { width, height, rgba, mask: false };
}

function imagesFromIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  const count = buffer.readUInt16LE(4);
  assert.ok(count >= 4, 'ico frames');
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256;
    const height = buffer[entry + 1] || 256;
    const bytes = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    const chunk = buffer.subarray(offset, offset + bytes);
    if (chunk.length >= 8 && chunk[0] === 0x89) images.push(decodePng(chunk));
    else images.push(decodeIcoBitmap(chunk, width, height));
  }
  return images;
}

function maskImage(payload) {
  const side = Math.round(Math.sqrt(payload.length));
  if (side * side !== payload.length || side < 1) return null;
  const rgba = new Uint8Array(side * side * 4);
  for (let index = 0; index < payload.length; index += 1) rgba[index * 4 + 3] = payload[index];
  return { width: side, height: side, rgba, mask: true };
}

function imagesFromIcns(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'icns');
  assert.equal(buffer.readUInt32BE(4), buffer.length, 'icns length');
  const images = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32BE(offset + 4);
    assert.ok(size >= 8 && offset + size <= buffer.length, `icns chunk ${type}`);
    const payload = buffer.subarray(offset + 8, offset + size);
    if (type === 'TOC ' || type === 'icnV') {
      offset += size;
      continue;
    }
    if (payload.length >= 8 && payload[0] === 0x89 && payload.toString('ascii', 1, 4) === 'PNG') {
      images.push(decodePng(payload));
    } else if (type.endsWith('mk')) {
      const image = maskImage(payload);
      assert.ok(image, `icns mask ${type}`);
      images.push(image);
    } else {
      assert.fail(`unreadable icns chunk ${type}`);
    }
    offset += size;
  }
  assert.equal(offset, buffer.length, 'icns trailing bytes');
  assert.ok(images.length >= 4, 'icns images');
  return images;
}

function inspect(image) {
  const { width, height, rgba } = image;
  const count = width * height;
  let light = 0;
  let green = 0;
  let dark = 0;
  const cornerAlpha = [
    rgba[3],
    rgba[(width - 1) * 4 + 3],
    rgba[(height - 1) * width * 4 + 3],
    rgba[(count - 1) * 4 + 3],
  ];
  for (let index = 0; index < count; index += 1) {
    const pixel = index * 4;
    const red = rgba[pixel];
    const greenChannel = rgba[pixel + 1];
    const blue = rgba[pixel + 2];
    const alpha = rgba[pixel + 3];
    // The removed tile was an opaque near-white plate, not a leaf highlight.
    if (alpha > 200 && red > 220 && greenChannel > 220 && blue > 210) light += 1;
    if (alpha > 128 && greenChannel > red + 8 && greenChannel > blue + 4 && greenChannel > 40 && greenChannel < 180) {
      green += 1;
    }
    if (alpha > 128 && red < 60 && greenChannel < 90 && blue < 80) dark += 1;
  }
  return { light, green, dark, cornerAlpha };
}

function assertTransparentLeaf(image, label) {
  const seen = inspect(image);
  seen.cornerAlpha.forEach((alpha, index) => {
    assert.equal(alpha, 0, `${label} corner ${index} is opaque`);
  });
  assert.equal(seen.light, 0, `${label} still has an opaque light plate`);
  if (!image.mask) {
    assert.ok(seen.green > 0, `${label} lost the green leaf`);
    assert.ok(seen.dark > 0, `${label} lost the dark vein`);
  }
}

test('product marks are the leaf on a transparent canvas', () => {
  for (const path of productPngs) assertTransparentLeaf(decodePng(read(path)), path);
  imagesFromIco(read('src-tauri/icons/icon.ico')).forEach((image, index) => {
    assertTransparentLeaf(image, `icon.ico#${index} ${image.width}x${image.height}`);
  });
  imagesFromIcns(read('src-tauri/icons/icon.icns')).forEach((image, index) => {
    assertTransparentLeaf(image, `icon.icns#${index} ${image.width}x${image.height}`);
  });
});

test('tray template stays a monochrome leaf on transparency', () => {
  const image = decodePng(read('src-tauri/icons/tray-template.png'));
  const seen = inspect(image);
  seen.cornerAlpha.forEach((alpha) => assert.equal(alpha, 0));
  assert.equal(seen.light, 0);
  assert.equal(seen.green, 0);
  let mono = 0;
  let colored = 0;
  const count = image.width * image.height;
  for (let index = 0; index < count; index += 1) {
    const pixel = index * 4;
    const red = image.rgba[pixel];
    const greenChannel = image.rgba[pixel + 1];
    const blue = image.rgba[pixel + 2];
    const alpha = image.rgba[pixel + 3];
    if (alpha <= 16) continue;
    const max = Math.max(red, greenChannel, blue);
    const min = Math.min(red, greenChannel, blue);
    if (max <= 32 && max - min <= 8) mono += 1;
    else colored += 1;
  }
  assert.ok(mono > count * 0.2, 'tray leaf shrank');
  assert.equal(colored, 0, 'tray leaf is no longer monochrome');
});

test('dark brandmark does not dim the leaf', () => {
  const css = read('src/style.css').toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.brandmark\s*\{/);
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].includes('.brandmark')) continue;
    assert.doesNotMatch(match[2], /brightness\s*\(/i, match[1].trim());
  }
});
