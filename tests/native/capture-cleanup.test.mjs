import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { previousCaptureCleanup } from '../../scripts/capture-ready.mjs';

test('replacing a gallery removes only obsolete PNGs owned by its previous manifest', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cliora-capture-cleanup-'));
  const gallery = path.join(root, 'gallery');
  fs.mkdirSync(gallery);
  try {
    for (const file of ['keep.png', 'obsolete.png', 'unrelated.png']) fs.writeFileSync(path.join(gallery, file), 'fixture');
    const outside = path.join(root, 'outside.png');
    fs.writeFileSync(outside, 'outside');
    fs.writeFileSync(path.join(gallery, 'manifest.json'), JSON.stringify({ shots: [
      { name: 'keep' }, { file: 'obsolete.png' }, { file: '../outside.png' }, { file: outside }, { file: 'manifest.json' },
    ] }));
    const cleanup = previousCaptureCleanup(gallery, 'manifest.json');
    cleanup([]);
    assert.ok(fs.existsSync(path.join(gallery, 'obsolete.png')), 'reading the previous manifest does not delete anything');
    cleanup(['keep.png']);
    assert.deepEqual(fs.readdirSync(gallery).sort(), ['keep.png', 'manifest.json', 'unrelated.png']);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    cleanup(['keep.png']); // Already pruned files do not fail the next capture.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
