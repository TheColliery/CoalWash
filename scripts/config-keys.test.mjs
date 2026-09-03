import test from 'node:test';
import assert from 'node:assert';
import { checkConfigKeys, noticeKeys, tableKeys, dottedKeys, configProseKeys, BLIND_KEYS, NOT_CONFIG } from './config-keys.mjs';

// A miniature schema with the same SHAPES the real one has: a plain camelCase
// key, an all-lowercase key (blind), an object container, and a bandmap.
const SCHEMA = [
  { key: 'coalwashMode', type: 'enum', def: 'auto' },
  { key: 'language', type: 'enum', def: 'auto' },
  { key: 'exercisePerBand', type: 'bandmap', def: { obese: 'quick', full: 'full' } },
  { key: 'estate', type: 'object', fields: { deleteCold: { type: 'bool', def: false } } },
  { key: 'retier', type: 'object', fields: { armPct: { type: 'int', def: 20 } } },
];
// The real BLIND_KEYS must cover this fixture's blind names or the PRECONDITION
// fires; these are exactly the five the live schema declares.
const RETIRED = ['forceMode'];
const TICK = String.fromCharCode(96);
const bt = (s) => TICK + s + TICK;

// The fixture schema is not the real one, so the LIVE allowlists cannot apply:
// a NOT_CONFIG entry naming a real-doc identifier would read as stale against
// every fixture. Tests that exercise the LOCATORS inject empty lists; the two
// tests that exercise the LISTS pass the real ones explicitly.
function run(files, opts = {}) {
  return checkConfigKeys({
    schema: SCHEMA,
    retiredKeys: RETIRED,
    mdFiles: Object.keys(files).filter((f) => f.endsWith('.md')),
    hookFiles: Object.keys(files).filter((f) => !f.endsWith('.md')),
    read: (p) => { if (files[p] === null) throw new Error('ENOENT'); return files[p]; },
    pending: {}, notConfig: {}, blind: BLIND_KEYS,
    ...opts,
  });
}
const fails = (r) => r.findings.filter((f) => f.level === 'FAIL').map((f) => f.msg);
// Every fixture that must not FAIL still needs the notice locator to match, or
// its own guard fires; this is the minimum viable conductor stand-in.
const HOOK_OK = 'function h(){ out.push(' + TICK + '[CoalWash] nothing to say' + TICK + '); }';

test('RED-FIRST (SYNTHETIC): ship-text naming a key the schema does not have FAILs', () => {
  // Synthetic BY NECESSITY, and stated as such: a 54-commit sweep of this
  // room's own history found ZERO genuine instances of this defect. Every
  // historical hit was a locator false positive (another tool's key, or an
  // internal identifier, named inside our config prose), not ship-text
  // inventing a key. So there is no real red to reproduce -- this constructs
  // the class instead.
  const r = run({
    'README.md': '## Configure\n\n| Key | Default |\n|---|---|\n| ' + bt('turboMode') + ' | ' + bt('on') + ' |\n',
    'hooks/c.js': HOOK_OK,
  });
  const f = fails(r);
  assert.ok(f.some((m) => m.includes("'turboMode'")), `expected a FAIL naming turboMode, got: ${JSON.stringify(f)}`);
  assert.ok(f.some((m) => m.includes('README.md')), 'the FAIL must name the file that carries it');
  assert.deepStrictEqual(r.coverage.unknown, ['turboMode']);
});

test('CONTROL: the same table row with a REAL key does not FAIL', () => {
  const r = run({
    'README.md': '## Configure\n\n| Key | Default |\n|---|---|\n| ' + bt('coalwashMode') + ' | ' + bt('auto') + ' |\n',
    'hooks/c.js': HOOK_OK,
  });
  assert.deepStrictEqual(fails(r), [], 'a real key must not FAIL');
  assert.deepStrictEqual(r.coverage.unknown, []);
});

test('a RETIRED key named in ship-text does not FAIL -- RETIRED_KEYS is its author, no allowlist entry', () => {
  // This is the live `forceMode` case: README documents it as deliberately
  // absent. The schema's own RETIRED_KEYS names it, so the gate needs no
  // hand-written allowlist entry for it at all.
  const r = run({
    'README.md': '## Configure\n\nDeliberately no ' + bt('forceMode') + ' key -- FULL runs unconditionally.\n',
    'hooks/c.js': HOOK_OK,
  });
  assert.deepStrictEqual(fails(r), []);
  assert.deepStrictEqual(r.coverage.retiredSeen, ['forceMode']);
});

test('a nested leaf resolves BARE, without its parent', () => {
  const r = run({
    'README.md': '## Configure\n\n| Key |\n|---|\n| ' + bt('deleteCold') + ' |\n| ' + bt('armPct') + ' |\n',
    'hooks/c.js': HOOK_OK,
  });
  assert.deepStrictEqual(fails(r), [], 'docs write a leaf both dotted and bare; both must resolve');
});

test('the dotted locator reads `estate.deleteCold` and REFUSES a module filename', () => {
  const containers = ['estate', 'retier', 'exercisePerBand'];
  assert.deepStrictEqual([...dottedKeys('see ' + bt('estate.deleteCold') + ' now', containers)], ['deleteCold']);
  // `retier.mjs` is the LIVE case (our docs name that module), but it is a WEAK
  // test on its own: `mjs` is all-lowercase, so the shape rule rejects it even
  // with the extension guard removed -- it passes for the wrong reason.
  assert.deepStrictEqual([...dottedKeys('see ' + bt('retier.mjs') + ' now', containers)], []);
  // This is the shape that actually EXERCISES the guard: a camelCase segment in
  // front of the extension, which the shape rule would happily accept. Our own
  // modules are kebab/lowercase so this is precautionary, not a live defect --
  // but it is the only input under which the guard is load-bearing, and the
  // sabotage ledger goes RED here when it is removed.
  assert.deepStrictEqual([...dottedKeys('see ' + bt('estate.someHelper.mjs') + ' now', containers)], [],
    'a dotted token ending in a file extension is a MODULE, never a key path');
});

test('PRECONDITION: a schema key failing KEY_SHAPE that is NOT declared blind is a hard FAIL', () => {
  const r = checkConfigKeys({
    schema: [...SCHEMA, { key: 'newlowercase', type: 'bool', def: false }],
    retiredKeys: RETIRED, mdFiles: [], hookFiles: ['hooks/c.js'],
    read: () => HOOK_OK,
  });
  assert.ok(fails(r).some((m) => m.includes("'newlowercase'") && m.includes('BLIND_KEYS')),
    'acquiring a blind spot must never be silent');
});

test('SELF-CLEANING: a BLIND_KEYS entry that left the schema FAILs as stale', () => {
  const r = checkConfigKeys({
    schema: [{ key: 'coalwashMode', type: 'enum', def: 'auto' }], // language/estate/retier/obese/full all gone
    retiredKeys: RETIRED, mdFiles: [], hookFiles: ['hooks/c.js'],
    read: () => HOOK_OK,
  });
  const f = fails(r);
  for (const k of Object.keys(BLIND_KEYS)) {
    assert.ok(f.some((m) => m.includes(`BLIND_KEYS names '${k}'`)), `expected a stale-entry FAIL for ${k}`);
  }
});

test('SELF-CLEANING: a NOT_CONFIG entry no surface mentions FAILs -- but only on a COMPLETE scan', () => {
  const key = Object.keys(NOT_CONFIG)[0];
  const live = { notConfig: NOT_CONFIG }; // exercise the REAL list, not the empty fixture one
  const complete = run({ 'README.md': '## Configure\n\nnothing here\n', 'hooks/c.js': HOOK_OK }, live);
  assert.ok(fails(complete).some((m) => m.includes(`NOT_CONFIG names '${key}'`)),
    'a stale allowlist entry must be reported when the scan saw everything');

  const partial = run({ 'README.md': null, 'hooks/c.js': HOOK_OK }, live);
  const pf = fails(partial);
  assert.ok(pf.some((m) => m.includes('cannot read README.md')), 'an unreadable surface is REPORTED, never silently dropped');
  assert.ok(!pf.some((m) => m.includes(`NOT_CONFIG names '${key}'`)),
    'an INCOMPLETE scan cannot prove an entry stale -- it must degrade to SKIP');
  assert.ok(partial.findings.some((x) => x.level === 'SKIP' && x.msg.includes(key)));
});

test('MIS-PORTED LOCATOR GUARD: a hook with no out.push( site FAILs rather than reporting clean', () => {
  // The exemplar's noticeRegion assumes a TRANSLATIONS block we do not have.
  // A locator that matches nothing is indistinguishable from a clean file, so
  // matching zero sites is itself the finding.
  const r = run({ 'README.md': '## Configure\n\n', 'hooks/c.js': 'const A = 1; // no notice channel here' });
  assert.ok(fails(r).some((m) => m.includes('ZERO out.push(')), 'a silent locator must fail loud');
});

test('the notice locator strips ${...} interpolations -- they are CODE, not user-facing text', () => {
  // Regression from the historical sweep: without this, three internal field
  // names (alwaysLoaded, tokensEst, bmiTxt) were harvested out of beta-era
  // notice lines as if the docs had invented config keys.
  const D = String.fromCharCode(36), L = String.fromCharCode(123), R = String.fromCharCode(125);
  const line = 'out.push(' + TICK + 'gauge ' + D + L + 'Math.round(m.alwaysLoaded.tokensEst)' + R
    + ', ' + D + L + 'bmiTxt' + R + '. Set coalwashMode to off.' + TICK + ');';
  assert.deepStrictEqual([...noticeKeys(line).keys], ['coalwashMode']);
});

test('the notice locator REPORTS what it covered (lines/chars/total), so a silent miss is visible', () => {
  const src = 'a\nb\nout.push(' + TICK + 'hi coalwashMode' + TICK + ');\nc\n';
  const r = noticeKeys(src);
  assert.strictEqual(r.lines, 1);
  assert.strictEqual(r.total, 5);
  assert.ok(r.chars > 0);
});

test('L1 reads the FIRST table cell only -- a key named in a description cell is not a claim', () => {
  // The live shape this protects: README's forceMode row mentions CoalMine's
  // `autoFixMode` in its THIRD cell. That is a cross-tool reference, not a
  // claim that this tool has the key.
  const row = '| ' + bt('coalwashMode') + ' | ' + bt('auto') + ' | modelled on ' + bt('autoFixMode') + ' |';
  assert.deepStrictEqual([...tableKeys(row)].sort(), ['coalwashMode']);
});

test('L3 fires only in a config CONTEXT, not in arbitrary prose', () => {
  assert.deepStrictEqual([...configProseKeys('Some prose about ' + bt('someFunction') + '.')], []);
  assert.deepStrictEqual([...configProseKeys('Edit .coalwash.json and set ' + bt('coalwashMode') + '.')], ['coalwashMode']);
  assert.deepStrictEqual([...configProseKeys('## Configure\n\nSet ' + bt('coalwashMode') + '.')], ['coalwashMode']);
  assert.deepStrictEqual([...configProseKeys('## Configure\n\n## Other\n\nSet ' + bt('someFunction') + '.')], [],
    'the config section must END at the next heading');
});
