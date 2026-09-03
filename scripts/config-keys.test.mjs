import test from 'node:test';
import assert from 'node:assert';
import { checkConfigKeys, noticeKeys, builderKeys, scanLiterals, tableKeys, dottedKeys, configProseKeys, schemaKeyNames, BLIND_KEYS, NOT_CONFIG } from './config-keys.mjs';

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

test('schemaKeyNames recurses to THREE levels -- the live schema nests that deep', () => {
  // The live schema really is three deep: estate.digCrush.singleFileTok and
  // estate.runBudget.maxSessionsPerRun. Nothing else pins it -- a rot-canary
  // mutation flattening walk() to one level left all other tests GREEN and the
  // real gate PASSING, because those leaves are not candidates in today's docs.
  // The day one is documented in the README key table, a flattened walk would
  // FAIL on a real key. This is the test that goes red instead.
  const deep = [{
    key: 'estate',
    type: 'object',
    fields: {
      indexEnabled: { type: 'bool', def: true },
      digCrush: { type: 'object', fields: { singleFileTok: { type: 'int', def: 1 } }, def: { singleFileTok: 1 } },
    },
  }];
  const names = schemaKeyNames(deep);
  assert.ok(names.has('estate'), 'level 1');
  assert.ok(names.has('digCrush'), 'level 2');
  assert.ok(names.has('singleFileTok'), 'level 3 -- the leaf a one-level walk drops');
});

test('schemaKeyNames reads a bandmap leaf out of its `def`, not a `fields` block', () => {
  // The shape the dispatch's own enumeration missed: exercisePerBand is a
  // bandmap, so its leaves live in def{} and an object-only walk skips them.
  const names = schemaKeyNames([{ key: 'exercisePerBand', type: 'bandmap', def: { obese: 'quick', full: 'full' } }]);
  assert.deepStrictEqual([...names].sort(), ['exercisePerBand', 'full', 'obese']);
});

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

test('L5 reads the SECOND sanctioned channel: a key named in a notice-BUILDER literal is a candidate', () => {
  // The conductor has two sanctioned channels. L4 reads console.log(out.join());
  // the {decision:'block', reason} channel's text is built in ask.mjs, so the
  // builder file IS the notice surface for it.
  const src = 'export function forceAuto() { return ' + TICK + 'set turboMode to off' + TICK + '; }';
  assert.deepStrictEqual([...builderKeys(src).keys], ['turboMode']);
});

test('L5 strips comments FIRST -- a quote in prose must not desync literal parsing', () => {
  // Load-bearing, not hygiene, and the mechanism is precise: TWO apostrophes in
  // prose ("the hook's ... the user's") delimit a FAKE string literal spanning
  // the text between them, so anything camelCase in there is harvested as if it
  // had been quoted. That is what made a naive scan of ask.mjs measure 38 false
  // positives. The fixture puts an identifier BETWEEN the two apostrophes: with
  // comments stripped only the real literal is read; without, someInternalName
  // is harvested too.
  const Q = String.fromCharCode(39);
  const src = '// the hook' + Q + 's someInternalName is the user' + Q + 's problem\n'
    + 'export const A = ' + TICK + 'real coalwashMode text' + TICK + ';';
  assert.deepStrictEqual([...builderKeys(src).keys], ['coalwashMode']);

  // Both comment forms, or the block branch is unpinned -- the sabotage ledger
  // caught exactly that: disabling the /* */ skip reddened nothing.
  const block = '/* the hook' + Q + 's someInternalName is the user' + Q + 's problem */\n'
    + 'export const B = ' + TICK + 'real quickVsFull text' + TICK + ';';
  assert.deepStrictEqual([...builderKeys(block).keys], ['quickVsFull']);
});

test('L5 does NOT truncate a literal containing // or /* -- the fail-OPEN direction', () => {
  // The mirror of the comment test above, and the more dangerous half: strip
  // comments BEFORE parsing literals and a `//` inside real notice prose reads
  // as a comment, silently dropping everything after it. Measured on a probe of
  // the pre-scanner version, `ratio a // b then set quickVsFull` yielded NOTHING
  // -- the gate under-detects and reports clean.
  const withSlashes = 'export const A = ' + TICK + 'ratio a // b then set quickVsFull' + TICK + ';';
  assert.deepStrictEqual([...builderKeys(withSlashes).keys], ['quickVsFull']);
  const withBlock = 'export const B = ' + TICK + 'glob /* not a comment */ then localOnly' + TICK + ';';
  assert.deepStrictEqual([...builderKeys(withBlock).keys], ['localOnly']);
});

test('scanLiterals: an ESCAPED quote does not close the literal early', () => {
  const Q = String.fromCharCode(39), B = String.fromCharCode(92);
  // 'it\'s coalwashMode' -- the escaped quote must not end the string, or the
  // rest of the notice text is lost and the key with it.
  const src = 'const A = ' + Q + 'it' + B + Q + 's coalwashMode' + Q + ';';
  assert.deepStrictEqual([...builderKeys(src).keys], ['coalwashMode']);
});

test('L5 strips ${...} interpolations -- an interpolated expression is CODE, not notice text', () => {
  // L4 has its own interpolation test; this one pins L5's separate call site,
  // which a mutation of L4 alone leaves untouched.
  const D = String.fromCharCode(36), L = String.fromCharCode(123), R = String.fromCharCode(125);
  const src = 'export const A = ' + TICK + 'store ' + D + L + 'Math.round(m.someInternalName)' + R
    + ' -- set coalwashMode to off' + TICK + ';';
  assert.deepStrictEqual([...builderKeys(src).keys], ['coalwashMode']);
});

test('L5 MIS-PORTED LOCATOR GUARD: a builder file with no string literal FAILs, never reports clean', () => {
  const r = checkConfigKeys({
    schema: SCHEMA, retiredKeys: RETIRED, mdFiles: [], hookFiles: [],
    builderFiles: ['scripts/lib/ask.mjs'],
    read: () => 'export const N = 1; // nothing quoted here at all',
    pending: {}, notConfig: {}, blind: BLIND_KEYS,
  });
  assert.ok(fails(r).some((m) => m.includes('ZERO string literals')), 'a silent locator must fail loud');
});

test('a builder file naming a key the schema does not have FAILs, and the FAIL names the file', () => {
  const r = run({
    'README.md': '## Configure\n\n',
    'hooks/c.js': HOOK_OK,
    'scripts/lib/ask.mjs': 'export const A = ' + TICK + 'raise turboMode to fix it' + TICK + ';',
  }, { builderFiles: ['scripts/lib/ask.mjs'], hookFiles: ['hooks/c.js'] });
  const f = fails(r);
  assert.ok(f.some((m) => m.includes("'turboMode'") && m.includes('ask.mjs')), JSON.stringify(f));
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
