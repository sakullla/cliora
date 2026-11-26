/**
 * History replay is not a new session: the bytes are old output that this terminal already
 * consumed once. This filter removes the parts of that history whose only meaning is a live side
 * effect — a clipboard write, a bell — and the query halves of a palette sequence, so a rebuilt
 * screen shows the colours the program set without answering questions it asked long ago.
 *
 * Device queries (DA, DSR, DECRQM, XTVERSION, DECRQSS, window reports) are handled separately:
 * they reply through xterm's data event, which the terminal cancels while a replay is parsed.
 * Keeping this filter byte-exact means the rewritten palette sequence stays exactly where the
 * program printed it, so the rows above and below it keep their own colours.
 */

const ESC = 0x1b;
const BEL = 0x07;
const CLOSE_SQUARE = 0x5d;

/** Byte text of an ASCII protocol payload; non-ASCII bytes only ever appear in strings we keep. */
function ascii(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

function encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** End of an OSC body starting at `from`: BEL or ST terminates it. -1 when it is still incomplete. */
function oscEnd(bytes: Uint8Array, from: number): { bodyEnd: number; next: number } | null {
  for (let index = from; index < bytes.length; index += 1) {
    if (bytes[index] === BEL) return { bodyEnd: index, next: index + 1 };
    if (bytes[index] === ESC) {
      if (index + 1 >= bytes.length) return null;
      if (bytes[index + 1] === 0x5c) return { bodyEnd: index, next: index + 2 };
    }
  }
  return null;
}

/**
 * The replacement for one OSC body (already including its number), or 'drop' / null to keep the
 * original bytes. Palette settings survive a mixed sequence; a query never does.
 */
function rewriteOsc(body: string): string | 'drop' | null {
  const parts = body.split(';');
  const ident = (parts[0] ?? '').trim();
  if (ident === '52') return 'drop';
  if (ident === '10' || ident === '11' || ident === '12') {
    return parts.slice(1).some((part) => part.trim() === '?') ? 'drop' : null;
  }
  if (ident !== '4') return null;
  // `4;<index>;<value>` pairs. A pair whose value is `?` is a query; the rest are palette settings.
  if ((parts.length - 1) % 2 !== 0) return null;
  const settings: string[] = [];
  let queried = false;
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const slot = parts[index].trim();
    const value = parts[index + 1].trim();
    if (!/^\d{1,3}$/.test(slot) || !value) return null;
    if (value === '?') queried = true;
    else settings.push(slot, value);
  }
  if (!queried) return null;
  return settings.length ? `4;${settings.join(';')}` : 'drop';
}

/** History bytes without replayed clipboard writes, bells or palette queries. */
export function stripHistorySideEffects(bytes: Uint8Array): Uint8Array {
  const kept: Uint8Array[] = [];
  let copyFrom = 0;
  let changed = false;
  const drop = (start: number, end: number) => {
    changed = true;
    if (start > copyFrom) kept.push(bytes.subarray(copyFrom, start));
    copyFrom = end;
  };
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    // A bell inside history already rang when it was live; ringing again on restore is noise.
    if (byte === BEL) { drop(index, index + 1); index += 1; continue; }
    if (byte !== ESC) { index += 1; continue; }
    const next = bytes[index + 1];
    if (next !== CLOSE_SQUARE) { index += 2; continue; }
    const end = oscEnd(bytes, index + 2);
    // An incomplete sequence never reaches xterm as an OSC anyway; leave it for the parser.
    if (!end) break;
    const rewrite = rewriteOsc(ascii(bytes.subarray(index + 2, end.bodyEnd)));
    if (rewrite === 'drop') drop(index, end.next);
    else if (rewrite !== null) {
      drop(index, end.next);
      kept.push(encode(`${String.fromCharCode(ESC, CLOSE_SQUARE)}${rewrite}${String.fromCharCode(ESC, 0x5c)}`));
      copyFrom = end.next;
    }
    index = end.next;
  }
  if (!changed) return bytes;
  if (copyFrom < bytes.length) kept.push(bytes.subarray(copyFrom));
  const total = kept.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of kept) { merged.set(part, offset); offset += part.length; }
  return merged;
}

