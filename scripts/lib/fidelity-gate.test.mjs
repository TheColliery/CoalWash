import { test } from 'node:test';
import assert from 'node:assert';
import { checkFidelity, gateFiles, inventory, frontmatterKeys } from './fidelity-gate.mjs';

// Thai fixtures from char codes only — never raw composables/invisibles in source.
const SARA_AM = String.fromCharCode(0x0e33); // the CORRECT single char
const DECOMPOSED = String.fromCharCode(0x0e4d, 0x0e32); // the broken NIKHAHIT+SARA-AA split
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const THAI_JAM = String.fromCharCode(0x0e08) + SARA_AM; // "จำ" (remember)

const ORIG = [
  '---',
  'pinned: false',
  'topic: routing',
  '---',
  '# Notes',
  'See [[coal-market-position]] and [[dogfood-to-harden]] for background.',
  'CoalTipple shipped v1.1.1 on 2026-07-08; CoalMine sits at v3.8.4 (audited 15-Jun-2026).',
  `Thai note: ${THAI_JAM} everything verbatim.`,
  'Some verbose filler that a compaction would rightly trim away, at length, twice over.',
].join('\n');

test('clean compaction passes: filler trimmed, every structured token kept', () => {
  const next = ORIG.replace('Some verbose filler that a compaction would rightly trim away, at length, twice over.', 'Filler trimmed.');
  const r = checkFidelity(ORIG, next);
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(r.drops, []);
  assert.strictEqual(r.counts.wikilinks.orig, 2);
});

test('a dropped [[wikilink]] fails with the exact link named', () => {
  const next = ORIG.replace(' and [[dogfood-to-harden]]', '');
  const r = checkFidelity(ORIG, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'wikilink-drop', value: 'dogfood-to-harden' }]);
});

test('a dropped ISO date fails; a dropped DD-Mon-YYYY house date fails', () => {
  const noIso = ORIG.replace(' on 2026-07-08', '');
  assert.deepStrictEqual(checkFidelity(ORIG, noIso).drops, [{ type: 'date-drop', value: '2026-07-08' }]);
  const noDmy = ORIG.replace(' (audited 15-Jun-2026)', '');
  assert.deepStrictEqual(checkFidelity(ORIG, noDmy).drops, [{ type: 'date-drop', value: '15-Jun-2026' }]);
});

test('a dropped version string fails (with and without the v prefix, incl. pre-release)', () => {
  const noV = ORIG.replace(' v3.8.4', '');
  assert.deepStrictEqual(checkFidelity(ORIG, noV).drops, [{ type: 'version-drop', value: 'v3.8.4' }]);
  const orig2 = 'shipped 0.1.0-beta.1 then 0.1.0-beta.2';
  const r2 = checkFidelity(orig2, 'shipped 0.1.0-beta.1');
  assert.deepStrictEqual(r2.drops, [{ type: 'version-drop', value: '0.1.0-beta.2' }]);
});

test('a dropped frontmatter key fails; value edits alone do not (the semantic layer owns values)', () => {
  const noKey = ORIG.replace('topic: routing\n', '');
  assert.deepStrictEqual(checkFidelity(ORIG, noKey).drops, [{ type: 'frontmatter-key-drop', value: 'topic' }]);
  const valueEdit = ORIG.replace('topic: routing', 'topic: model-routing');
  assert.strictEqual(checkFidelity(ORIG, valueEdit).pass, true);
});

test('deduplicating a REPEATED mention of the same value is legitimate compaction (set semantics)', () => {
  const orig = 'See [[x]] here and [[x]] there, v1.2.3 twice: v1.2.3, dated 2026-01-01 and 2026-01-01.';
  const next = 'See [[x]] once, v1.2.3 once, dated 2026-01-01.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, true);
});

test('reordering/regrouping (defrag) with full inventory passes', () => {
  const reordered = [
    '---',
    'topic: routing',
    'pinned: false',
    '---',
    '# Notes (regrouped)',
    `Thai note: ${THAI_JAM} everything verbatim.`,
    'CoalMine sits at v3.8.4 (audited 15-Jun-2026); CoalTipple shipped v1.1.1 on 2026-07-08.',
    'Background: [[dogfood-to-harden]], [[coal-market-position]].',
  ].join('\n');
  assert.strictEqual(checkFidelity(ORIG, reordered).pass, true);
});

test('Thai sara-am: preserved U+0E33 passes; INTRODUCED decomposition fails', () => {
  const keep = checkFidelity(ORIG, ORIG.replace('# Notes', '# Notes v2'));
  assert.strictEqual(keep.pass, true);
  const corrupted = ORIG.replace(THAI_JAM, THAI_JAM[0] + DECOMPOSED); // same rendering, broken encoding
  const r = checkFidelity(ORIG, corrupted);
  assert.strictEqual(r.pass, false);
  assert.ok(r.drops.some((d) => d.type === 'thai-sara-am-decomposed'));
});

test('pre-existing decomposition in BOTH versions warns but does not fail (inherited state)', () => {
  const orig = 'legacy ' + DECOMPOSED + ' text';
  const next = 'legacy ' + DECOMPOSED + ' text, trimmed';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.warnings.length, 1);
});

test('an introduced BOM fails; a BOM present in both does not', () => {
  const r = checkFidelity('plain', BOM + 'plain');
  assert.ok(r.drops.some((d) => d.type === 'bom-introduced'));
  const both = checkFidelity(BOM + 'plain', BOM + 'plain trimmed');
  assert.strictEqual(both.pass, true);
});

test('an introduced zero-width space fails', () => {
  const r = checkFidelity('clean text', 'clean' + ZWSP + ' text');
  assert.strictEqual(r.pass, false);
  assert.ok(r.drops.some((d) => d.type === 'zwsp-introduced'));
});

test('emptying a file drops the WHOLE inventory (a delete must go through the human gate, not this one)', () => {
  const r = checkFidelity(ORIG, '');
  assert.strictEqual(r.pass, false);
  const types = new Set(r.drops.map((d) => d.type));
  assert.ok(types.has('wikilink-drop'));
  assert.ok(types.has('date-drop'));
  assert.ok(types.has('version-drop'));
  assert.ok(types.has('frontmatter-key-drop'));
});

test('a MERGE gates on the UNION: orig = sources concatenated', () => {
  const a = 'Alpha holds [[link-a]] at v1.0.0.';
  const b = 'Beta holds [[link-b]] dated 2026-05-05.';
  const goodMerge = 'Merged: [[link-a]] (v1.0.0) + [[link-b]] (2026-05-05).';
  assert.strictEqual(checkFidelity(a + '\n' + b, goodMerge).pass, true);
  const lossyMerge = 'Merged: [[link-a]] (v1.0.0).';
  const r = checkFidelity(a + '\n' + b, lossyMerge);
  assert.deepStrictEqual(r.drops.map((d) => d.value).sort(), ['2026-05-05', 'link-b']);
});

test('gateFiles: one failing file fails the batch; drops carry the path', () => {
  const pairs = [
    { path: 'a.md', orig: 'keep [[one]]', next: 'keep [[one]] trimmed' },
    { path: 'b.md', orig: 'keep [[two]]', next: 'lost it' },
  ];
  const g = gateFiles(pairs);
  assert.strictEqual(g.pass, false);
  assert.deepStrictEqual(g.drops, [{ path: 'b.md', type: 'wikilink-drop', value: 'two' }]);
  assert.strictEqual(g.files.length, 2);
  assert.strictEqual(g.files[0].pass, true);
});

test('inventory extraction: counts and shapes', () => {
  const inv = inventory(ORIG);
  assert.deepStrictEqual([...inv.wikilinks].sort(), ['coal-market-position', 'dogfood-to-harden']);
  assert.ok(inv.dates.has('2026-07-08'));
  assert.ok(inv.dates.has('15-Jun-2026'));
  assert.ok(inv.versions.has('v1.1.1'));
  assert.ok(inv.versions.has('v3.8.4'));
  assert.deepStrictEqual([...inv.frontmatter].sort(), ['pinned', 'topic']);
});

test('frontmatterKeys: absent or unterminated frontmatter yields no keys (CRLF tolerated)', () => {
  assert.strictEqual(frontmatterKeys('no frontmatter here').size, 0);
  assert.strictEqual(frontmatterKeys('---\nkey: value\nno closing fence').size, 0);
  const crlf = '---\r\npinned: true\r\ntopic: x\r\n---\r\nbody';
  assert.deepStrictEqual([...frontmatterKeys(crlf)].sort(), ['pinned', 'topic']);
});
