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
  // dates are canonicalized to YYYY-MM-DD in the inventory (so an ISO<->DMY
  // reformat is not a drop) -> a genuine drop reports the canonical form.
  assert.deepStrictEqual(checkFidelity(ORIG, noDmy).drops, [{ type: 'date-drop', value: '2026-06-15' }]);
});

test('a date REFORMAT between the two house formats is NOT a drop (canonicalized); a link-drop IS caught', () => {
  // 15-Jun-2026 -> 2026-06-15 (same day, endorsed reformat) must PASS.
  const reformatted = ORIG.replace('15-Jun-2026', '2026-06-15');
  assert.strictEqual(checkFidelity(ORIG, reformatted).pass, true);
  // a markdown-link destination is a fact the wikilink RE never saw — dropping it FAILS.
  const withLink = ORIG + '\nSee the [routing record](https://example.com/routing).';
  const noLink = ORIG + '\nSee the routing record.';
  assert.deepStrictEqual(checkFidelity(withLink, noLink).drops, [{ type: 'link-drop', value: 'https://example.com/routing' }]);
  // editing a wikilink's DISPLAY text (target unchanged) is NOT a drop.
  const disp1 = 'See [[coal-market-position|the position]].';
  const disp2 = 'See [[coal-market-position|our market position]].';
  assert.strictEqual(checkFidelity(disp1, disp2).pass, true);
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

test('emptying a file drops the WHOLE inventory (a real delete is a distinct action type, not this one)', () => {
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
  assert.ok(inv.dates.has('2026-06-15'), 'DD-Mon-YYYY is canonicalized to ISO in the inventory');
  assert.ok(inv.versions.has('v1.1.1'));
  assert.ok(inv.versions.has('v3.8.4'));
  assert.ok(inv.links instanceof Set, 'inventory exposes a links set');
  assert.deepStrictEqual([...inv.frontmatter].sort(), ['pinned', 'topic']);
});

test('frontmatterKeys: absent or unterminated frontmatter yields no keys (CRLF tolerated)', () => {
  assert.strictEqual(frontmatterKeys('no frontmatter here').size, 0);
  assert.strictEqual(frontmatterKeys('---\nkey: value\nno closing fence').size, 0);
  const crlf = '---\r\npinned: true\r\ntopic: x\r\n---\r\nbody';
  assert.deepStrictEqual([...frontmatterKeys(crlf)].sort(), ['pinned', 'topic']);
});

// ---------------------------------------------------------------------------
// codespan-drop
// ---------------------------------------------------------------------------

test('a dropped `code span` fails with the exact identifier named', () => {
  const orig = 'Call `checkSharedReferences` before merging.';
  const next = 'Call the checker before merging.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'codespan-drop', value: 'checkSharedReferences' }]);
});

test('a code span merely REPOSITIONED or surrounded by edited prose is not a drop', () => {
  const orig = 'Run `scan.ps1` first, then verify.';
  const next = 'First verify, then run `scan.ps1`.';
  assert.strictEqual(checkFidelity(orig, next).pass, true);
});

test('code spans are case-sensitive and exact (a renamed identifier IS a drop)', () => {
  const orig = 'See `oldName` for the helper.';
  const next = 'See `OldName` for the helper.'; // different case = a different token
  assert.deepStrictEqual(checkFidelity(orig, next).drops, [{ type: 'codespan-drop', value: 'oldName' }]);
});

// ---------------------------------------------------------------------------
// quote-drop
// ---------------------------------------------------------------------------

test('a dropped verbatim quote fails with the exact quoted text named', () => {
  const LDQ = String.fromCharCode(0x201c), RDQ = String.fromCharCode(0x201d);
  const orig = `The user said ${LDQ}ship the precise claim, never beats every tool${RDQ} verbatim.`;
  const next = 'The user gave guidance on the claim, paraphrased here.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'quote-drop', value: 'ship the precise claim, never beats every tool' }]);
});

test('a quote RESTYLED between curly and straight delimiters is NOT a drop (same precedent as date reformat)', () => {
  const LDQ = String.fromCharCode(0x201c), RDQ = String.fromCharCode(0x201d);
  const curly = `She said ${LDQ}exactly this${RDQ} and left.`;
  const straight = 'She said "exactly this" and left.';
  assert.strictEqual(checkFidelity(curly, straight).pass, true);
  assert.strictEqual(checkFidelity(straight, curly).pass, true);
});

test('straight double quotes: a dropped quoted phrase fails; a kept one (reworded around it) passes', () => {
  const orig = 'The report called it "a false-LEAN we must never allow".';
  const next = 'The report warned against it in passing.';
  assert.deepStrictEqual(checkFidelity(orig, next).drops, [{ type: 'quote-drop', value: 'a false-LEAN we must never allow' }]);
  const keep = 'As the report says, "a false-LEAN we must never allow" — noted up front.';
  assert.strictEqual(checkFidelity(orig, keep).pass, true);
});

// ---------------------------------------------------------------------------
// number-drop
// ---------------------------------------------------------------------------

test('a dropped prose count (2+ digit integer) fails', () => {
  const orig = 'The scan found 22 raw findings, 12 of them LOW.';
  const next = 'The scan found some raw findings, most of them LOW.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops.map((d) => d.value).sort(), ['12', '22']);
});

test('a dropped ratio, percent, and ~k magnitude each fail with the exact token named', () => {
  assert.deepStrictEqual(checkFidelity('Score 5/7 on the audit.', 'Scored well on the audit.').drops, [{ type: 'number-drop', value: '5/7' }]);
  assert.deepStrictEqual(checkFidelity('Coverage sits at 43%.', 'Coverage is solid.').drops, [{ type: 'number-drop', value: '43%' }]);
  assert.deepStrictEqual(checkFidelity('Workers used ~220k tokens.', 'Workers used a lot of tokens.').drops, [{ type: 'number-drop', value: '220k' }]);
});

test('a decimal (N.N) number drop is caught', () => {
  const r = checkFidelity('The ratio measured 0.92 in testing.', 'The ratio measured well in testing.');
  assert.deepStrictEqual(r.drops, [{ type: 'number-drop', value: '0.92' }]);
});

test('single bare digits are EXCLUDED as noise (deliberate: too common to be a reliable signal)', () => {
  const r = checkFidelity('This runs a 3-sub lane for the fix.', 'This runs a 4-sub lane for the fix.');
  assert.strictEqual(r.pass, true, 'a lone single-digit change is not tracked by number-drop');
});

test('single digits ARE tracked when part of a ratio or percent (the syntax disambiguates intent)', () => {
  assert.deepStrictEqual(checkFidelity('Passed 4/5 cases.', 'Passed most cases.').drops, [{ type: 'number-drop', value: '4/5' }]);
  assert.deepStrictEqual(checkFidelity('Held at 5% overhead.', 'Held at low overhead.').drops, [{ type: 'number-drop', value: '5%' }]);
});

test('number-drop does NOT re-flag digits already covered by date/version/link categories (no redundant noise)', () => {
  // A version bump: version-drop fires; number-drop must NOT also fire on the
  // "3.8"/"3.9" substrings (already precisely tracked as a version, not a bare decimal).
  const r1 = checkFidelity('CoalMine sits at v3.8.4.', 'CoalMine sits at v3.9.2.');
  assert.deepStrictEqual(r1.drops, [{ type: 'version-drop', value: 'v3.8.4' }]);
});

test('number-drop does NOT break the endorsed ISO<->DD-Mon-YYYY date reformat (masking prevents the regression)', () => {
  const orig = 'Audited 15-Jun-2026, shipped 2026-07-08.';
  const reformatted = 'Audited 2026-06-15, shipped 2026-07-08.';
  assert.strictEqual(checkFidelity(orig, reformatted).pass, true);
});

test('gateFiles carries the new categories through the batch, path-tagged', () => {
  const pairs = [
    { path: 'a.md', orig: 'keep `foo` here', next: 'keep `foo` here, trimmed' },
    { path: 'b.md', orig: 'found 22 issues', next: 'found some issues' },
  ];
  const g = gateFiles(pairs);
  assert.strictEqual(g.pass, false);
  assert.deepStrictEqual(g.drops, [{ path: 'b.md', type: 'number-drop', value: '22' }]);
});

// ---------------------------------------------------------------------------
// number-precision (class 9) + comma-grouped numbers
// ---------------------------------------------------------------------------

test('M29 shape: an exact comma-grouped count surviving only as a rounded k-form is a NAMED precision drop, survivor named', () => {
  const orig = 'The conductor stamped fp=44,192 tokens at gauge time.';
  const next = 'The conductor stamped ~44k tokens at gauge time.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'number-precision', value: '44192', survivor: '44k' }]);
});

test('M12 shape: 64.6% surviving only as ~65% is a precision drop; the exact form surviving alongside is NOT', () => {
  const orig = 'Exact agreement hit 64.6% across arms.';
  const lossy = 'Agreement hit ~65% across arms.';
  assert.deepStrictEqual(checkFidelity(orig, lossy).drops, [{ type: 'number-precision', value: '64.6%', survivor: '65%' }]);
  const keep = 'Agreement hit 64.6% (~65%) across arms.';
  assert.strictEqual(checkFidelity(orig, keep).pass, true);
});

test('a vanished number with NO rounded survivor stays a plain number-drop (class 8 unchanged)', () => {
  const r = checkFidelity('found 44,192 issues', 'found many issues');
  assert.deepStrictEqual(r.drops, [{ type: 'number-drop', value: '44192' }]);
});

test('a comma regroup of the SAME value is not a drop (keyed comma-less, the canonicalization precedent)', () => {
  assert.strictEqual(checkFidelity('count 44,192 total', 'count 44192 total').pass, true);
  assert.strictEqual(checkFidelity('count 44192 total', 'count 44,192 total').pass, true);
});

test('percent and plain counts never cross-match (a % is not a rounding of a count)', () => {
  const r = checkFidelity('scored 65 points', 'scored 65% overall');
  assert.deepStrictEqual(r.drops.map((d) => d.type), ['number-drop']);
});

test('equal value at coarser stated precision (64.0% -> 64%) is precision-labelled, not a bare vanish', () => {
  const r = checkFidelity('measured at 64.0% exactly', 'measured at 64% exactly');
  assert.deepStrictEqual(r.drops, [{ type: 'number-precision', value: '64.0%', survivor: '64%' }]);
});

test('an unrelated surviving number does not masquerade as a rounding (agreement must be within the coarser ulp)', () => {
  // 43k does not claim 44,192 (|44192-43000| >= 1000) -> a plain vanish.
  const r = checkFidelity('stamped 44,192 tokens', 'stamped ~43k tokens elsewhere');
  assert.deepStrictEqual(r.drops.map((d) => d.type), ['number-drop']);
});

// ---------------------------------------------------------------------------
// evidence-anchor (class 10)
// ---------------------------------------------------------------------------

test('M27 shape: the claim ("proven 100%") survives while its transcript id vanishes -> evidence-anchor-drop', () => {
  const orig = 'Delivery proven 100% twice (transcript c19e528b) on this machine.';
  const next = 'Delivery proven 100% twice on this machine.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'evidence-anchor-drop', value: 'c19e528b', marker: 'proven' }]);
});

test('evidence merely MOVED elsewhere in the file is kept (set semantics, like every class)', () => {
  const orig = 'Delivery proven 100% twice (transcript c19e528b) on this machine.';
  const next = 'Delivery proven 100% twice on this machine. Receipt: transcript c19e528b.';
  assert.strictEqual(checkFidelity(orig, next).pass, true);
});

test('the whole claim deleted (marker gone too) is NOT an orphaning — content adjudication owns whole-claim cuts', () => {
  const orig = 'Delivery proven 100% twice (transcript c19e528b).';
  const next = 'The delivery story was cut entirely.';
  const r = checkFidelity(orig, next);
  assert.ok(!r.drops.some((d) => d.type === 'evidence-anchor-drop'), 'no orphaning when the claim died with its evidence');
});

test('issue refs and filenames count as evidence anchors near a proof marker', () => {
  const orig = 'Fix verified against #2014 and the scan.ps1 output.';
  const next = 'Fix verified against the reported issue and the scanner output.';
  const ev = checkFidelity(orig, next).drops.filter((d) => d.type === 'evidence-anchor-drop');
  assert.deepStrictEqual(ev.map((d) => d.value).sort(), ['#2014', 'scan.ps1']);
});

test('evidence on a DIFFERENT line does not anchor a marker (the window clamps to the marker\'s own line)', () => {
  const orig = 'Delivery verified in production.\nUnrelated commit deadbee5 changed the docs.';
  const next = 'Delivery verified in production.\nUnrelated commit note.';
  assert.strictEqual(checkFidelity(orig, next).pass, true);
});

test('inventory exposes codespans/quotes/numbers alongside the original 5 categories', () => {
  const LDQ = String.fromCharCode(0x201c), RDQ = String.fromCharCode(0x201d);
  const inv = inventory(`Run \`scan.ps1\`, ${LDQ}quote this${RDQ}, found 22 issues at 5%.`);
  assert.deepStrictEqual([...inv.codespans], ['scan.ps1']);
  assert.deepStrictEqual([...inv.quotes], ['quote this']);
  assert.ok(inv.numbers.has('22'));
  assert.ok(inv.numbers.has('5%'));
});
