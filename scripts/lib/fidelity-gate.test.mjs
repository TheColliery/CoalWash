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

test('version-superversion: a dropped standalone version is CAUGHT even when its 4-part superstring survives — the greedy whole-run regex keeps them distinct in the set-based inventory (pre-fix the 3-part-exact regex extracted `1.2.3` from `1.2.3.4`, collapsing both to one set entry, so a genuine `1.2.3` drop was SILENTLY PASSED through the deterministic floor)', () => {
  // plain: drop the standalone 1.2.3, keep 1.2.3.4 elsewhere -> the drop must be caught
  const plain = checkFidelity('shipped 1.2.3 and later 1.2.3.4 too', 'shipped and later 1.2.3.4 too');
  assert.strictEqual(plain.pass, false, 'the standalone 1.2.3 drop must fail the gate');
  assert.deepStrictEqual(plain.drops, [{ type: 'version-drop', value: '1.2.3' }]);
  // v-prefixed: V_SHORT_VERSION_RE must NOT re-manufacture the truncated v1.2.3 from the surviving v1.2.3.4
  const vpref = checkFidelity('shipped v1.2.3 and later v1.2.3.4 too', 'shipped and later v1.2.3.4 too');
  assert.strictEqual(vpref.pass, false, 'the standalone v1.2.3 drop must fail the gate');
  assert.deepStrictEqual(vpref.drops, [{ type: 'version-drop', value: 'v1.2.3' }]);
  // the whole superversion is inventoried as itself, never the shorter fragment
  const inv = inventory('build 1.2.3.4 and v10.0.26200.1 here');
  assert.ok(inv.versions.has('1.2.3.4') && !inv.versions.has('1.2.3'), '1.2.3.4 inventoried whole, no 1.2.3 fragment');
  assert.ok(inv.versions.has('v10.0.26200.1') && !inv.versions.has('v10.0.26200'), 'v10.0.26200.1 whole, no v10.0.26200 fragment');
  // no regression: v-prefixed 2-part (V_SHORT's own purpose) still caught; a no-drop wash still passes
  assert.ok(inventory('pin v1.2 here').versions.has('v1.2'), 'a v-prefixed 2-part version is still inventoried');
  assert.strictEqual(checkFidelity('keep 1.2.3 and 1.2.3.4', 'keep 1.2.3 and 1.2.3.4').pass, true, 'a no-drop wash still passes');
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

test('frontmatterKeys: a non-[A-Za-z0-9_-] top-level key (dotted/$/path/unicode) IS caught as a drop — the silent-miss this fix closes', () => {
  const orig = ['---', 'coalwash.updateMode: auto', 'title: x', '---', 'body'].join('\n');
  const dropped = ['---', 'title: x', '---', 'body'].join('\n');
  const r = checkFidelity(orig, dropped);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'frontmatter-key-drop', value: 'coalwash.updateMode' }]);
  const shapes = frontmatterKeys(['---', '$ref: a', 'a.b.c: b', '/path/key: c', '---', 'body'].join('\n'));
  assert.deepStrictEqual([...shapes].sort(), ['$ref', '/path/key', 'a.b.c']);
  // no regression on the plain word-shaped keys the old regex already caught
  const plain = ['---', 'title: a', 'version-transition: b', 'my_key: c', 'name: d', 'description: e', 'metadata: f', 'type: g', '---', 'body'].join('\n');
  assert.deepStrictEqual([...frontmatterKeys(plain)].sort(), ['description', 'metadata', 'my_key', 'name', 'title', 'type', 'version-transition']);
});

test('frontmatterKeys: an embedded-colon key (a:b) is distinct from bare a — dropping a:b while a survives is now CAUGHT (was a silent miss: the old [^:]*? capture stopped at the first colon and collapsed a:b/a:c/bare-a all down to "a")', () => {
  const orig = ['---', 'a:b: 1', 'a:c: 2', 'coalwash.a:x: 3', 'a: 4', 'title: 5', 'desc: see http://x.com', '---', 'body'].join('\n');
  assert.deepStrictEqual([...frontmatterKeys(orig)].sort(), ['a', 'a:b', 'a:c', 'coalwash.a:x', 'desc', 'title']);
  const dropped = ['---', 'a: 4', 'title: 5', 'desc: see http://x.com', '---', 'body'].join('\n');
  const r = checkFidelity(orig, dropped);
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [
    { type: 'frontmatter-key-drop', value: 'a:b' },
    { type: 'frontmatter-key-drop', value: 'a:c' },
    { type: 'frontmatter-key-drop', value: 'coalwash.a:x' },
  ]);
});

test('frontmatterKeys: an indented/nested key stays excluded (top-level-only, by design); a body-prose colon after the closing fence is never a phantom key', () => {
  const withNested = ['---', 'title: x', '  nested: y', '---', 'Note: see below'].join('\n');
  assert.deepStrictEqual([...frontmatterKeys(withNested)], ['title']);
  const next = ['---', 'title: x', '---', 'Note: see below, trimmed'].join('\n');
  assert.strictEqual(checkFidelity(withNested, next).pass, true, 'dropping a never-tracked nested key + editing body prose must not fail the gate');
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
// H2 — sign capture (a sign flip is a genuine drop, not a silent pass)
// ---------------------------------------------------------------------------

test('H2: a sign FLIP is a drop — "-43%" -> "43%" fails (the sign is part of the token)', () => {
  const r = checkFidelity('Compaction moved -43% overall.', 'Compaction moved 43% overall.');
  assert.strictEqual(r.pass, false, 'a dropped negative sign must fail the gate');
  assert.deepStrictEqual(r.drops, [{ type: 'number-drop', value: '-43%' }]);
});

test('H2: a negative comma-grouped count losing its sign fails ("-44,192" -> "44,192")', () => {
  const r = checkFidelity('Net change was -44,192 tokens.', 'Net change was 44,192 tokens.');
  assert.strictEqual(r.pass, false);
  assert.deepStrictEqual(r.drops, [{ type: 'number-drop', value: '-44192' }]);
});

test('H2: a genuine negative that SURVIVES is not a drop (no false positive on a kept sign)', () => {
  assert.strictEqual(checkFidelity('delta -3.8 today', 'the delta was -3.8 today').pass, true);
});

test('H2: an inter-digit hyphen is a RANGE separator, never a sign ("15-20" reflow, no fabricated -20 drop)', () => {
  assert.strictEqual(checkFidelity('ran 15-20 cases', 'ran 15 to 20 cases').pass, true);
});

// ---------------------------------------------------------------------------
// MED — Trojan-Source bidi / zero-width tripwire (introduced-only)
// ---------------------------------------------------------------------------

test('MED: an INTRODUCED RLO bidi override (Trojan-Source) fails the gate', () => {
  const RLO = String.fromCharCode(0x202e);
  const r = checkFidelity('transfer to alice', 'transfer ' + RLO + 'to alice');
  assert.strictEqual(r.pass, false, 'a hidden bidi override must fail');
  assert.ok(r.drops.some((d) => d.type === 'bidi-control-introduced' && /RLO/.test(d.value)), JSON.stringify(r.drops));
});

test('MED: introduced ZWJ and a MID-STRING BOM both fail; an inherited one is not punished', () => {
  const ZWJ = String.fromCharCode(0x200d), BOM = String.fromCharCode(0xfeff);
  assert.strictEqual(checkFidelity('clean', 'cl' + ZWJ + 'ean').pass, false, 'introduced ZWJ fails');
  assert.strictEqual(checkFidelity('clean', 'cl' + BOM + 'ean').pass, false, 'introduced mid-string BOM fails');
  assert.strictEqual(checkFidelity('cl' + ZWJ + 'ean was here', 'cl' + ZWJ + 'ean is here').pass, true, 'inherited ZWJ (present in BOTH) is not a NEW corruption');
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

// ---------------------------------------------------------------------------
// BREAK 1 — fence-awareness (fenced code blocks) + v-prefixed short versions
// (blind-IC: the IDENTICAL token FAILED inline but PASSED inside a ```fence```).
// ---------------------------------------------------------------------------

test('BREAK-1: a command/flag altered INSIDE a ```fenced``` block fails (the inline gate was blind to it)', () => {
  const orig = ['Deploy steps:', '```bash', 'deploy --env=prod --dry-run', 'rollback --to v1.0.0', '```'].join('\n');
  const next = orig.replace('deploy --env=prod --dry-run', 'deploy --env=prod'); // dropped --dry-run INSIDE the fence
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false, 'a changed fenced command line must fail the gate');
  assert.ok(r.drops.some((d) => d.type === 'fenced-line-drop' && /--dry-run/.test(d.value)), JSON.stringify(r.drops));
  // DECISIVE parity: the IDENTICAL token inline already failed — fence parity restored
  assert.strictEqual(checkFidelity('Run `deploy --env=prod --dry-run` now.', 'Run `deploy --env=prod` now.').pass, false);
});

test('BREAK-1 no-FP: a fenced block preserved through a whitespace reindent / reorder still PASSES; an inline codespan drop is still caught', () => {
  const orig = ['```', '  git checkout --force main', '```'].join('\n');
  const reindented = ['```', 'git checkout --force main', '```'].join('\n'); // leading whitespace collapsed only
  assert.strictEqual(checkFidelity(orig, reindented).pass, true, 'a whitespace-only reflow inside a fence is not a drop');
  const a = ['```', 'line one', 'line two', '```'].join('\n');
  const b = ['```', 'line two', 'line one', '```'].join('\n');
  assert.strictEqual(checkFidelity(a, b).pass, true, 'reordering fenced content lines is not a drop (set semantics)');
  assert.deepStrictEqual(checkFidelity('call `foo` here', 'call the helper here').drops, [{ type: 'codespan-drop', value: 'foo' }]);
});

test('BREAK-1 LOW: a dropped v-prefixed 2-part version (v1.2) is caught (it escaped both VERSION_RE and the number class)', () => {
  const r = checkFidelity('Requires runtime v1.2 for the plugin.', 'Requires the runtime for the plugin.');
  assert.strictEqual(r.pass, false, 'a dropped v1.2 must fail');
  assert.deepStrictEqual(r.drops, [{ type: 'version-drop', value: 'v1.2' }]);
  // no-FP: a bare decimal stays a NUMBER, never misfiled as a version (the `v` is required)
  assert.deepStrictEqual(checkFidelity('waited 1.2 seconds', 'waited a moment').drops, [{ type: 'number-drop', value: '1.2' }]);
  // a 3-part version is unaffected (regression guard)
  assert.deepStrictEqual(checkFidelity('shipped v1.2.3 today', 'shipped today').drops, [{ type: 'version-drop', value: 'v1.2.3' }]);
});
