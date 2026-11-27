// The ACP contract is written four times: the Rust host (src-tauri/src/acp), the
// TypeScript types and IPC wrapper (src/types/acp.ts, src/lib/native.ts), the browser
// mock (tests/ui/acpMock.ts) and the capture fixture (scripts/capture-workbench.mjs).
// This test reads all of them as source and fails when an event kind, a field name or
// a command name drifts in one place only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const rust = ['mod', 'timeline', 'capabilities', 'access', 'client_fs', 'terminal', 'elicitation', 'prompt', 'files', 'history']
  .map((name) => read(`src-tauri/src/acp/${name}.rs`)).join('\n');
const commandsRs = read('src-tauri/src/commands.rs');
const libRs = read('src-tauri/src/lib.rs');
const typesTs = read('src/types/acp.ts');
const nativeTs = read('src/lib/native.ts');
const mockTs = read('tests/ui/acpMock.ts');
const captureMjs = read('scripts/capture-workbench.mjs');

const camel = (name) => name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());
const sorted = (values) => [...new Set(values)].sort();

/** The body between the brace that follows `start` and its matching close. */
function block(source, start) {
  const at = source.indexOf(start);
  assert.notEqual(at, -1, `missing ${start}`);
  const open = source.indexOf('{', at + start.length - 1);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced ${start}`);
}

/** Keys written at the top level of an object literal or type body. */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let quote = null;
  let token = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; token = ''; continue; }
    if (char === '/' && body[index + 1] === '/') { index = body.indexOf('\n', index); if (index < 0) break; token = ''; continue; }
    if (char === '/' && body[index + 1] === '*') { index = body.indexOf('*/', index) + 1; token = ''; continue; }
    if ('{[('.includes(char)) { depth += 1; token = ''; continue; }
    if ('}])'.includes(char)) { depth -= 1; token = ''; continue; }
    if (depth === 0 && /[A-Za-z0-9_]/.test(char)) { token += char; continue; }
    if (depth === 0 && (char === ':' || (char === '?' && body[index + 1] === ':')) && token) {
      const before = body.slice(0, index - token.length).trimEnd();
      if (!before.endsWith('.') && !before.endsWith('?')) keys.push(token);
    }
    // A shorthand property: `{ id, toolId: ... }`.
    if (depth === 0 && char === ',' && token) {
      const before = body.slice(0, index - token.length).trimEnd();
      if (before === '' || before.endsWith(',')) keys.push(token);
    }
    if (!/\s/.test(char)) token = '';
  }
  return sorted(keys);
}

/** Every serialized Rust struct: its camelCase field names. */
function rustStructs() {
  const structs = new Map();
  const pattern = /#\[derive\(([^)]*)\)\]\s*(?:#\[serde\(([^)]*)\)\]\s*)?pub struct (\w+) \{/g;
  for (const match of rust.matchAll(pattern)) {
    if (!match[1].includes('Serialize')) continue;
    assert.ok(match[2]?.includes('rename_all = "camelCase"'), `${match[3]} must serialize camelCase`);
    const body = block(rust, match[0]);
    const fields = [];
    const lines = body.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const field = lines[index].match(/^\s*pub (\w+):/);
      if (!field) continue;
      const attribute = lines[index - 1]?.match(/#\[serde\(rename = "(\w+)"\)\]/);
      if (lines[index - 1]?.includes('#[serde(flatten)]')) continue;
      fields.push(attribute ? attribute[1] : camel(field[1]));
    }
    structs.set(match[3], sorted(fields));
  }
  return structs;
}

/** A serialized Rust enum: variant name in camelCase → field names, or the wrapped struct. */
function rustEnum(name) {
  const body = block(rust, `pub enum ${name} {`);
  const variants = new Map();
  for (const line of body.split('\n')) {
    const struct = line.match(/^\s*(\w+) \{(.*)\},?\s*$/);
    if (struct) {
      variants.set(camel(struct[1].charAt(0).toLowerCase() + struct[1].slice(1)), sorted([...struct[2].matchAll(/(\w+):/g)].map((field) => camel(field[1]))));
      continue;
    }
    const wrapped = line.match(/^\s*(\w+)\((\w+)\),?\s*$/);
    if (wrapped) variants.set(wrapped[1].charAt(0).toLowerCase() + wrapped[1].slice(1), wrapped[2]);
  }
  return variants;
}

/** Every TypeScript object type alias: its keys. */
function tsObjectTypes() {
  const types = new Map();
  for (const match of typesTs.matchAll(/export type (\w+) = \{/g)) {
    types.set(match[1], topLevelKeys(block(typesTs, match[0])));
  }
  return types;
}

/** The members of a TypeScript union written one per line: `| { kind: 'x'; a: ...; b: ... }`. */
function tsUnion(name, tag) {
  const at = typesTs.indexOf(`export type ${name} =`);
  assert.notEqual(at, -1, `missing TS ${name}`);
  const end = typesTs.indexOf(';\n\n', at);
  const source = typesTs.slice(at, end === -1 ? undefined : end + 1);
  const members = new Map();
  for (const line of source.split('\n')) {
    const object = line.match(new RegExp(`^\\s*\\| \\{ ${tag}: '(\\w+)';?(.*)\\}\\s*;?\\s*$`));
    if (object) {
      members.set(object[1], sorted([...object[2].matchAll(/(\w+)\??:/g)].map((field) => field[1])));
      continue;
    }
    const wrapped = line.match(new RegExp(`^\\s*\\| \\(\\{ ${tag}: '(\\w+)' \\} & (\\w+)\\)`));
    if (wrapped) members.set(wrapped[1], wrapped[2]);
  }
  return members;
}

test('every serialized Rust struct has a TypeScript type with the same field names', () => {
  const structs = rustStructs();
  const types = tsObjectTypes();
  assert.ok(structs.size >= 20, `found only ${structs.size} Rust structs`);
  for (const [name, fields] of structs) {
    if (name === 'AcpEvent') {
      // The update is flattened into the event: only the envelope fields stay.
      assert.deepEqual(fields, ['seq', 'sessionId']);
      assert.match(typesTs, /export type AcpEvent = \{ sessionId: string; seq: number \} & AcpUpdate;/);
      continue;
    }
    assert.ok(types.has(name), `src/types/acp.ts lacks ${name}`);
    assert.deepEqual(types.get(name), fields, `${name} fields differ between Rust and TypeScript`);
  }
});

test('event kinds and their fields match between the Rust host and the TypeScript union', () => {
  const rustKinds = rustEnum('AcpUpdate');
  const tsKinds = tsUnion('AcpUpdate', 'kind');
  assert.deepEqual(sorted(tsKinds.keys()), sorted(rustKinds.keys()), 'event kinds differ');
  for (const [kind, fields] of rustKinds) assert.deepEqual(tsKinds.get(kind), fields, `event ${kind} fields differ`);
});

test('timeline item kinds and tool content types match', () => {
  const rustItems = rustEnum('AcpTimelineItem');
  const tsItems = tsUnion('AcpTimelineItem', 'kind');
  assert.deepEqual(sorted(tsItems.keys()), sorted(rustItems.keys()), 'timeline kinds differ');
  for (const [kind, struct] of rustItems) assert.equal(tsItems.get(kind), struct, `timeline ${kind} wraps another type`);
  // A wrapped struct must never carry the tag's own name as a field.
  const structs = rustStructs();
  for (const struct of rustItems.values()) assert.ok(!structs.get(struct).includes('kind'), `${struct} collides with the kind tag`);

  const rustContent = rustEnum('AcpToolContent');
  const tsContent = tsUnion('AcpToolContent', 'type');
  assert.deepEqual(sorted(tsContent.keys()), sorted(rustContent.keys()), 'tool content types differ');
  for (const [type, fields] of rustContent) assert.deepEqual(tsContent.get(type), fields, `tool content ${type} fields differ`);
});

test('the event channel and the legacy model id are the same constant on both sides', () => {
  assert.equal(rust.match(/pub const EVENT: &str = "([^"]+)"/)[1], nativeTs.match(/acpEventName = '([^']+)'/)[1]);
  assert.equal(rust.match(/LEGACY_MODEL_CONFIG_ID: &str = "([^"]+)"/)[1], typesTs.match(/ACP_LEGACY_MODEL_CONFIG = '([^']+)'/)[1]);
});

test('every ACP command exists in the host, its registration, the IPC wrapper, the mock and the capture fixture', () => {
  const isAcp = (name) => /(^|_)acp(_|$)/.test(name);
  const rustCommands = sorted([...commandsRs.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(/g)].map((match) => match[1]).filter(isAcp));
  const registered = sorted([...libRs.matchAll(/commands::(\w+),/g)].map((match) => match[1]).filter(isAcp));
  const wrapped = sorted([...nativeTs.matchAll(/command<[^>]*>\('(\w+)'/g)].map((match) => match[1]).filter(isAcp));
  const mocked = sorted([...mockTs.matchAll(/command === '(\w+)'/g)].map((match) => match[1]).filter(isAcp));
  const captured = sorted([...captureMjs.matchAll(/command === '(\w+)'/g)].map((match) => match[1]).filter(isAcp));
  assert.ok(rustCommands.includes('acp_set_mode') && rustCommands.includes('acp_set_config'), rustCommands.join(', '));
  for (const name of ['acp_respond_access', 'acp_revoke_grants', 'acp_kill_terminal', 'acp_authenticate', 'acp_respond_elicitation',
    'acp_list_files', 'acp_read_image', 'acp_native_sessions', 'acp_delete_native_session']) assert.ok(rustCommands.includes(name), `missing ${name}`);
  assert.deepEqual(registered, rustCommands, 'lib.rs registration differs from commands.rs');
  assert.deepEqual(wrapped, rustCommands, 'src/lib/native.ts differs from commands.rs');
  assert.deepEqual(mocked, rustCommands, 'tests/ui/acpMock.ts differs from commands.rs');
  assert.deepEqual(captured, rustCommands, 'scripts/capture-workbench.mjs differs from commands.rs');

  // The wrapper sends exactly the arguments the command takes (Tauri camel-cases them).
  for (const name of rustCommands) {
    const signature = commandsRs.match(new RegExp(`pub (?:async )?fn ${name}\\(([^)]*)\\)`))[1];
    const params = sorted([...signature.matchAll(/(?:^|,)\s*(\w+):/g)].map((match) => camel(match[1])).filter((param) => param !== 'app' && param !== 'state'));
    const call = nativeTs.match(new RegExp(`command<[^>]*>\\('${name}'(?:, \\{ ([^}]*) \\})?\\)`));
    assert.ok(call, `native.ts does not call ${name}`);
    const sent = sorted((call[1] ?? '').split(',').map((part) => part.split(':')[0].trim()).filter(Boolean));
    assert.deepEqual(sent, params, `${name} arguments differ`);
  }
});

test('a prompt attachment has the same variants and fields on both sides', () => {
  const rustVariants = rustEnum('AcpAttachment');
  const at = typesTs.indexOf('export type AcpAttachment =');
  assert.notEqual(at, -1, 'missing TS AcpAttachment');
  const source = typesTs.slice(at, typesTs.indexOf(';\n\n', at) + 1);
  const tsVariants = new Map([...source.matchAll(/\| \{ type: '(\w+)';([^}]*)\}/g)]
    .map((match) => [match[1], sorted([...match[2].matchAll(/(\w+)\??:/g)].map((field) => field[1]))]));
  assert.deepEqual(sorted(tsVariants.keys()), sorted(rustVariants.keys()), 'attachment types differ');
  for (const [type, fields] of rustVariants) assert.deepEqual(tsVariants.get(type), fields, `attachment ${type} fields differ`);
});

test('the launch request carries resumeNativeId in Rust and TypeScript', () => {
  const launchRs = read('src-tauri/src/launch.rs');
  const launchTs = read('src/types/launch.ts');
  assert.match(block(launchRs, 'pub struct LaunchEnvelope {'), /pub resume_native_id: Option<String>/);
  assert.match(launchTs, /resumeNativeId\?: string \| null/);
});

test('the mock and the capture fixture build snapshots with exactly the host fields', () => {
  const fields = tsObjectTypes().get('AcpSessionSnapshot');
  assert.deepEqual(fields, rustStructs().get('AcpSessionSnapshot'));
  const factory = mockTs.slice(mockTs.indexOf('export function snapshot('));
  assert.deepEqual(topLevelKeys(block(factory, 'return {')).concat('id').sort(), fields, 'acpMock snapshot() differs');
  const launched = mockTs.slice(mockTs.indexOf('const snapshot: Snapshot = {'));
  assert.deepEqual(topLevelKeys(block(launched, 'const snapshot: Snapshot = {')), fields, 'acpMock launch snapshot differs');
  const fixture = captureMjs.slice(captureMjs.indexOf('const acpFixture = acpMode ? [{'));
  assert.deepEqual(topLevelKeys(block(fixture, '[{')), fields, 'capture-workbench ACP fixture differs');
});
