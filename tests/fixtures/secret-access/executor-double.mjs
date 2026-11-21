#!/usr/bin/env node
// Fixed test executable for secret access acceptance. It is the only target a
// synthetic canary may reach.
//
// It never writes the value: the optional receipt holds the channel, the byte
// count and the SHA-256 digest. The raw value goes to stdout and stderr on purpose,
// so a run proves the broker masks both streams before a model sees them.
//
// Registration (library → secret references) uses:
//   executable: node
//   args:       <absolute path to this file> --channel env --env-name CLIORA_TEST_SECRET --receipt <absolute receipt path>
//   channel:    env, environment name CLIORA_TEST_SECRET
// `stdin` replaces `--channel env --env-name ...`; the receipt argument is optional.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const SENTINEL = 'CLIORA_TEST_EXECUTOR_OK';
const MISSING = 'CLIORA_TEST_EXECUTOR_MISSING';

function parse(argv) {
  const options = { channel: '', envName: '', receipt: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--channel' && value) { options.channel = value; index += 1; }
    else if (flag === '--env-name' && value) { options.envName = value; index += 1; }
    else if (flag === '--receipt' && value) { options.receipt = value; index += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (options.channel !== 'env' && options.channel !== 'stdin') throw new Error('--channel must be env or stdin');
  if (options.channel === 'env' && !options.envName) throw new Error('--channel env needs --env-name');
  return options;
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

let options;
try {
  options = parse(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${MISSING} reason=usage\n`);
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

// The value arrives through exactly one registered channel; "" is a missing value,
// not an empty secret, so the target never pretends it received something.
const value = options.channel === 'env' ? (process.env[options.envName] ?? '') : readStdin().replace(/\r?\n$/, '');
if (!value) {
  process.stdout.write(`${MISSING} channel=${options.channel}\n`);
  process.exit(3);
}

const digest = createHash('sha256').update(value).digest('hex');
if (options.receipt) {
  writeFileSync(options.receipt, `${JSON.stringify({ kind: 'synthetic-executor-receipt', channel: options.channel, bytes: Buffer.byteLength(value), sha256: digest, sentinel: SENTINEL })}\n`, { mode: 0o600 });
}
// Both streams echo the raw value on purpose: masking is what the acceptance run checks.
process.stdout.write(`${SENTINEL} channel=${options.channel} bytes=${Buffer.byteLength(value)} raw=${value}\n`);
process.stderr.write(`CLIORA_TEST_EXECUTOR_ECHO channel=${options.channel} raw=${value}\n`);
