import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, readFile, writeFile, unlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const retired = ['index-v022.mjs', 'index-v023.mjs', 'index-v024.mjs', 'index-v025.mjs', 'index-v026.mjs', 'index-v027.mjs', 'index-v028.mjs'];
const implementation = '../lib/index-v029.mjs';

test('all retired backend entries forward to the current implementation', async () => {
  const current = await import(implementation);
  for (const name of retired) {
    const legacy = await import('../lib/' + name);
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(current).sort());
    for (const key of Object.keys(current)) assert.equal(legacy[key], current[key], name + ': ' + key);
    const source = await readFile(new URL('../lib/' + name, import.meta.url), 'utf8');
    assert.match(source, /export \* from '\.\/index-v029\.mjs'/);
  }
});

test('a cached resolved entry remains loadable after package files are replaced', async t => {
  for (const name of retired) await t.test(name, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cpa-upgrade-'));
    // Cleanup is restricted to this test's freshly created fixture, never a real profile.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-cpa-upgrade-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const packageDirectory = join(directory, 'node_modules', 'cpa-upgrade-fixture');
    const lib = join(packageDirectory, 'lib');
    await mkdir(lib, {recursive: true});
    const manifest = version => JSON.stringify({name: 'cpa-upgrade-fixture', type: 'module', version,
      exports: version === '0.2.9' ? './lib/index-v029.mjs' : './lib/' + name});
    await writeFile(join(packageDirectory, 'package.json'), manifest('0.2.3'));
    await writeFile(join(lib, name), "export const version = 'old';\n");
    const resolverPath = join(directory, 'resolve.mjs');
    await writeFile(resolverPath, "export const entry = () => import.meta.resolve('cpa-upgrade-fixture');\n");
    const resolver = await import(pathToFileURL(resolverPath).href);
    const previousAddress = resolver.entry();
    assert.equal(basename(fileURLToPath(previousAddress)), name);

    // This models the observed 0.2.4 failure: new manifest + removed old entry.
    await writeFile(join(packageDirectory, 'package.json'), manifest('0.2.9'));
    await writeFile(join(lib, 'index-v029.mjs'), "export const version = '0.2.9';\n");
    await unlink(join(lib, name));
    await assert.rejects(readFile(new URL(previousAddress)), {code: 'ENOENT'});
    const afterUpgrade = resolver.entry();
    if (afterUpgrade === previousAddress) t.diagnostic('Node retained the old package export resolution');
    // Even if a future Node refreshes its cache, a host can still hold this old URL.
    const compatibilityEntry = await readFile(new URL('../lib/' + name, import.meta.url), 'utf8');
    await writeFile(join(lib, name), compatibilityEntry);
    assert.ok((await readFile(new URL(previousAddress), 'utf8')).includes('index-v029.mjs'));
    const loaded = await import(previousAddress);
    assert.equal(loaded.version, '0.2.9');
  });
});

test('package metadata exposes current entries without excluding compatibility files', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.2.9');
  assert.equal(manifest.main, './lib/index-v029.mjs');
  assert.equal(manifest.exports['.'], manifest.main);
  assert.equal(manifest.exports['./client'], './lib/client-v029.js');
  assert.ok(manifest.files.includes('lib'));
  // Keep the last shipped client asset available while an existing page reloads.
  await readFile(new URL('../lib/client-v024.js', import.meta.url));
  await readFile(new URL('../lib/client-v025.js', import.meta.url));
  await readFile(new URL('../lib/client-v026.js', import.meta.url));
  await readFile(new URL('../lib/client-v027.js', import.meta.url));
  await readFile(new URL('../lib/client-v028.js', import.meta.url));
  assert.equal(manifest.devDependencies['@earendil-works/pi-ai'], '1.3.0');
  assert.equal(manifest.dependencies['@resvg/resvg-wasm'], '2.6.2');
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1');
});
