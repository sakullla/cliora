// Opt-in, read-only evidence oracle for the ignored Rust local evidence test.
// Extract only native pure decoder/projection functions into an isolated VM;
// never import/run the CLI entry point, login code, or inference loop.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const [bundlePath, sourcePath] = process.argv.slice(2);
const bundle = fs.readFileSync(bundlePath, 'utf8');
const names = ['fpe', 'etu', 'Atu', 'ntu', 'ttu', 'Ug', 'QBo', 'Fne', 'N0A', 'LRe', '_ht', 'U0A',
  'Hjn', 'ctu', 'ltu', 'utu', 'dtu', 'gtu', 'ftu', 'ptu', 'mtu', 'yBo', 'Etu', 'htu', 'Itu', 'Btu', 'Qtu', 'Jjn', 'Ctu', 'e3e', 'hgt',
  'MBo', 'IBo', 'BBo', 'Zht', 'YAu', 'VAu', 'gpe', 'qAu', 'jAu', 'KAu', 'XAu', 'ZAu', 'Mjn', 'zAu', '_Au', 'Tjn'];
const functions = names.map((name) => {
  const offset = bundle.indexOf(`function ${name}(`);
  if (offset < 0) throw new Error(`Native 1.1.74 function missing: ${name}`);
  const fragment = bundle.slice(offset, offset + 20000);
  const ast = ts.createSourceFile('native.js', fragment, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const first = ast.statements[0];
  if (!ts.isFunctionDeclaration(first) || first.name.text !== name) throw new Error(`Invalid function: ${name}`);
  return fragment.slice(0, first.end);
}).join('\n');
const nativeSet = (name) => {
  const match = bundle.match(new RegExp(`${name.replaceAll('$', '\\$')}=new Set\\((\\[[^;]*?\\])\\)`));
  if (!match) throw new Error(`Native set missing: ${name}`);
  return JSON.parse(match[1]);
};
const context = vm.createContext({
  Buffer, CBo: path, $g: (value) => value.includes('\0'),
  $Au: new Set(nativeSet('$Au')), Uw: new Set(nativeSet('Uw')),
  Xht: { includeSidechains: false, includeTeamMessages: true, includeMetaMessages: true, preferStableAssistant: true, order: 'timestamp' },
  WAu: 5000, Vjn: () => {}, oWe: Error,
  // Only diagnostic labels use this decoder in Hjn; labels are not compared.
  _$d1: (value) => value,
  input: fs.readFileSync(sourcePath, 'utf8'),
});
vm.runInContext(functions, context, { timeout: 10000 });
const result = vm.runInContext(`(() => {
  const entriesInFileOrder = []; const orderByUuid = new Map(); let active;
  for (const [order, line] of input.split(/\\r?\\n/).entries()) {
    if (!line.trim()) continue;
    const decoded = fpe(line);
    if (decoded.kind !== 'entry') continue;
    const entry = decoded.entry;
    entriesInFileOrder.push({ entry, order });
    if (e3e(entry)) orderByUuid.set(entry.uuid, order);
    if (entry.type === 'active-leaf') active = entry;
  }
  const compatible = Hjn({ entriesInFileOrder, orderByUuid, snapshot: { size: input.length } }, { retainPreCompactHistory: true });
  const leaf = MBo(compatible, active, active?.sessionId);
  return IBo(compatible, leaf).messages.filter((row) => ['user', 'assistant'].includes(row.type)
    && !row.isMeta && !row.isSidechain && !row.isCompactSummary).flatMap((row) => {
      const content = row.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\\n') : '';
      return text.trim() ? [{ id: row.uuid, text }] : [];
    });
})()`, context, { timeout: 10000 });
// Consumed privately by Rust assertions. The test prints counts only.
process.stdout.write(JSON.stringify(result));
