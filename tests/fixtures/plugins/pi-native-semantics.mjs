// Invoked by the Rust regression with its actual pi_disabled output. This only
// calls Pi's discovery/parser methods; it never imports or executes a plugin.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
const [piRoot, fixtureRoot, declarationsFile, rootsFile] = process.argv.slice(2);
assert.ok(['0.99.2', '1.0.0', '1.0.2', '1.0.4'].includes(JSON.parse(readFileSync(join(piRoot, 'package.json'))).version), 'native acceptance must use a tested published reference');
const { DefaultPackageManager } = await import(pathToFileURL(join(piRoot, 'dist/core/package-manager.js')).href);
const packageRoot = join(fixtureRoot, 'package');
mkdirSync(join(packageRoot, 'extensions'), { recursive: true });
writeFileSync(join(packageRoot, 'extensions/fixture.ts'), '// Never executed.');
const manager = new DefaultPackageManager({ cwd: fixtureRoot, agentDir: join(fixtureRoot, 'agent'), settingsManager: { isProjectTrusted: () => true } });
const { original, disabled } = JSON.parse(readFileSync(declarationsFile));
function enabled(project) {
  const selected = manager.dedupePackages([{ pkg: project, scope: 'project' }, { pkg: packageRoot, scope: 'user' }]);
  const accumulator = manager.createAccumulator();
  for (const { pkg, scope } of selected) manager.collectPackageResources(packageRoot, accumulator, typeof pkg === 'object' ? pkg : undefined, { source: packageRoot, scope, origin: 'package', baseDir: fixtureRoot });
  return [...accumulator.extensions.values()].some(value => value.enabled);
}
assert.equal(enabled(original), false, 'original project delta excludes extension');
const broken = { ...disabled, autoload: false };
assert.equal(enabled(broken), true, 'old empty delta reproduced unintended global load');
assert.equal(enabled(disabled), false, 'Rust disabled replacement prevents global load');
assert.equal(enabled(original), false, 'restored declaration retains original semantics');
for (const { source, scope, expected } of JSON.parse(readFileSync(rootsFile))) assert.equal(manager.getInstalledPath(source, scope), normalize(expected), source);
process.stdout.write('Pi 0.99.2 native delta/replacement and installed path regressions passed\n');
