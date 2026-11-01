import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/adapters/attachments.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { attachmentPastes, quoteAttachmentPath } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('attachment formatting extends through a capability, without a shared CLI switch', () => {
  const paths = ['/project/a.png', '/project/b.png'];
  const adapter = { id: 'future-cli', attachmentPastes: paths => paths.map(path => `@${path}`) };
  assert.deepEqual(attachmentPastes(adapter, paths), ['@/project/a.png', '@/project/b.png']);
  assert.deepEqual(attachmentPastes({ id: 'unknown' }, paths), ['/project/a.png /project/b.png']);
});

test('attachment paths preserve spaces and Windows paths while rejecting terminal controls', () => {
  assert.equal(quoteAttachmentPath('C:\\work\\图 片.png'), '"C:/work/图 片.png"');
  assert.equal(quoteAttachmentPath('/project/图 片.png'), '"/project/图 片.png"');
  assert.equal(quoteAttachmentPath('/tmp/$(id).png'), '"/tmp/\\$(id).png"');
  for (const path of ['', '/tmp/a\nenter', '/tmp/\x1b[201~', '/tmp/a\0.png']) {
    assert.throws(() => attachmentPastes({ id: 'future-cli', attachmentPastes: () => ['unsafe'] }, [path]));
  }
});
