import { test } from 'node:test';
import assert from 'node:assert';
import { checkFidelity, gateFiles, inventory, frontmatterKeys, readFrontmatter, frontmatterBlockParse } from './fidelity-gate.mjs';

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

test('SUPERSEDED by MULTISET (board disposition 2): deduplicating repeated mentions now FLAGS, approvable by name', () => {
  // This test used to assert pass===true under the original set semantics —
  // "deduplicating a REPEATED mention is legitimate compaction". The board
  // overturned that premise: the gate cannot tell an information-free repeat
  // from an information-bearing one, so a mention collapse is REPORTED and
  // adjudicated (same `${type}:${value}` approval key — no new grammar).
  const orig = 'See [[x]] here and [[x]] there, v1.2.3 twice: v1.2.3, dated 2026-01-01 and 2026-01-01.';
  const next = 'See [[x]] once, v1.2.3 once, dated 2026-01-01.';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false, 'a mention collapse is a reported drop, not a silent pass');
  for (const [type, value] of [['wikilink-drop', 'x'], ['version-drop', 'v1.2.3'], ['date-drop', '2026-01-01']]) {
    const d = r.drops.find((x) => x.type === type && x.value === value);
    assert.deepStrictEqual(d && d.occurrences, { orig: 2, kept: 1 }, `${type}:${value} carries honest mention counts`);
  }
  // and the adjudication channel clears it with the existing key shape
  const approved = new Set(r.drops.map((d) => `${d.type}:${d.value}`));
  assert.ok(approved.has('wikilink-drop:x'), 'approval key unchanged');
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

// ── THE ENCODING-PREAMBLE INVENTORY BLINDNESS (2026-07-27) ─────────────────
// A UTF-8 BOM in front of the fence made frontmatterKeys return an EMPTY set,
// so every frontmatter key in the original became silently droppable and the
// gate passed a rewrite that erased all of them. Same one-line lexical anchor
// as the pin bypass; fixed at the shared readFrontmatter primitive.
test('frontmatterKeys reads through a UTF-8 BOM — a BOM must not empty the inventory', () => {
  const body = '---\nowner: me\nstatus: live\n---\n# doc\n';
  const withBom = String.fromCharCode(0xfeff) + body;
  assert.deepStrictEqual([...frontmatterKeys(body)].sort(), ['owner', 'status'], 'control: no BOM');
  assert.deepStrictEqual([...frontmatterKeys(withBom)].sort(), ['owner', 'status'], 'a BOM must not hide the keys');
  // and the gate must therefore SEE the drop it was blind to
  const stripped = String.fromCharCode(0xfeff) + '# doc\n';
  const r = checkFidelity(withBom, stripped);
  assert.strictEqual(r.pass, false, 'dropping every frontmatter key must fail the gate');
  assert.ok(r.drops.some((d) => d.type === 'frontmatter-key-drop'), `expected frontmatter-key-drop, got ${JSON.stringify(r.drops)}`);
});

test('frontmatterKeys on an UNDECODABLE head yields no keys and does not throw (state is unverifiable, not closed)', () => {
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('---\nowner: me\n---\nbody', 'utf16le')]).toString('utf8');
  assert.deepStrictEqual([...frontmatterKeys(u16)], []);
});

// One legal strip, then a residual U+FEFF at the head is an ENCODING PREAMBLE
// (a double-encode artifact), not a second signature — the tri-state doctrine's
// "I could not tell" case, never 'none' (which reads as unpinned = deletable;
// station-3 ran that delete on rc.6+fix bytes and it succeeded).
test('DOUBLE BOM: a residual U+FEFF after the one legal strip is unverifiable, never "none"', () => {
  const BOM = String.fromCharCode(0xfeff);
  const body = '---\npinned: true\n---\nbody';
  assert.strictEqual(readFrontmatter(BOM + body).state, 'closed', 'control: ONE BOM is a legal signature — stripped and parsed');
  assert.strictEqual(readFrontmatter(BOM + BOM + body).state, 'unverifiable', 'two BOMs: the residue is a preamble, refuse to claim "no frontmatter"');
  assert.strictEqual(readFrontmatter(BOM + BOM + BOM + body).state, 'unverifiable', 'any N>=2 collapses to the same answer');
  // A mid-content ZWNBSP (same code point, NOT at the head) is legal text and
  // must not be dragged into the refuse set — position 0 only.
  assert.strictEqual(readFrontmatter(BOM + '---\nowner: a' + BOM + 'b\n---\nx').state, 'closed', 'ZWNBSP inside content is content, not a preamble');
});

// ── THE FENCE-SHAPE BYPASS (graduation-lab round 2, N1) ────────────────────
// The primitive CONTRADICTED ITSELF: its closing fence has accepted trailing
// [ \t]* since it was written, and its opening fence did not — so `--- \n`
// (ONE invisible byte, which Markdown editors deliberately preserve: two
// trailing spaces are a hard break, so trim-on-save is commonly off for .md)
// read as state 'none' = "genuinely no frontmatter". One space switched off
// the pin refusal on delete, the pin refusal on the unattended rewrite, AND
// the unclosed-fence refusal. Same class as the encoding preamble (284e7c6):
// a lexical NO on decoded text read as a confident claim about the file.
// The parameter space is enumerated here, not just the reported byte.
test('FENCE SHAPE: trailing whitespace after the opening --- parses, symmetric with the closing fence', () => {
  const body = 'pinned: true\n---\ncontent';
  for (const [name, opener] of [
    ['one space', '--- \n'],
    ['one tab', '---\t\n'],
    ['three spaces', '---   \n'],
    ['mixed space/tab run', '--- \t \n'],
    ['space then CRLF', '--- \r\n'],
  ]) {
    const r = readFrontmatter(opener + body);
    assert.strictEqual(r.state, 'closed', `${name}: opening-fence tolerance must match the closing fence`);
    assert.match(r.block, /pinned: true/, `${name}: the block must carry the keys`);
  }
  // parity pin — the closing fence's pre-existing tolerance still holds
  assert.strictEqual(readFrontmatter('---\npinned: true\n--- \ncontent').state, 'closed', 'closing-fence trailing space (pre-existing)');
  // and the key inventory flows through the shared primitive
  assert.deepStrictEqual([...frontmatterKeys('--- \npinned: true\n---\nx')], ['pinned']);
});

test('FENCE SHAPE: a lone-CR (classic-Mac) fence head is UNVERIFIABLE, never "none"', () => {
  // fence-SHAPED, but a line discipline this tooling cannot faithfully parse —
  // "I could not tell" is not "no" (the tri-state doctrine).
  assert.strictEqual(readFrontmatter('---\rpinned: true\r---\rcontent').state, 'unverifiable');
  assert.strictEqual(readFrontmatter('--- \rpinned: true\r---\rcontent').state, 'unverifiable', 'trailing space + lone CR');
});

// N1 ROUND 3 — the SAME hole, reopened by every byte the last fix did not list.
// `[ \t]` was an ENUMERATION, so the next unlisted invisible byte walked back
// through it. The proof needs no external standard: the SAME byte on the
// CLOSING fence already answers 'unverifiable', so 'none' at the opener is the
// primitive contradicting itself — and 'none' is the answer that ends in a
// delete. The parameter space is therefore the COMPLEMENT of visible content,
// spelled with Unicode properties, not a longer byte list.
test('FENCE SHAPE: any invisible NON-[ \t] byte after the opening --- is UNVERIFIABLE, never "none"', () => {
  // Built from char codes, never raw literals in source: the module under test
  // states that house rule, and it binds a FIXTURE hardest - an editor or tool
  // round-trip silently rewrites an invisible literal, and the fixture then
  // stops testing the byte it names while still passing (measured here: the
  // first draft of this very test was written with \u escapes and landed as ten
  // raw control characters).
  const ch = (c) => String.fromCharCode(c);
  for (const [name, c] of [
    // the five measured at station 3
    ['NBSP U+00A0', 0x00a0],
    ['IDEOGRAPHIC SPACE U+3000', 0x3000],
    ['VT U+000B', 0x000b],
    ['FF U+000C', 0x000c],
    ['ZWSP U+200B', 0x200b],
    // and the rest of the CLASS, so the fix cannot be another byte list:
    // Cc (control), Cf (format) and Zs/White_Space all mean 'no visible glyph'
    ['NEL U+0085', 0x0085],
    ['SOFT HYPHEN U+00AD', 0x00ad],
    ['WORD JOINER U+2060', 0x2060],
    ['SOH U+0001', 0x0001],
    // ROUND 4 - station 3's ten, and NOT ONE of them is White_Space, Cf or
    // Cc. That is the point: the round-3 fix was a fourth ENUMERATION, and
    // these walked through it exactly as NBSP walked through `[ @BS@t]`.
    ['COMBINING GRAPHEME JOINER U+034F', 0x034f],
    ['HANGUL FILLER U+3164', 0x3164],
    ['HANGUL CHOSEONG FILLER U+115F', 0x115f],
    ['HANGUL JUNGSEONG FILLER U+1160', 0x1160],
    ['VARIATION SELECTOR-16 U+FE0F', 0xfe0f],
    ['KHMER VOWEL INHERENT AQ U+17B4', 0x17b4],
    ['MONGOLIAN FREE VARIATION SELECTOR ONE U+180B', 0x180b],
    ['HALFWIDTH HANGUL FILLER U+FFA0', 0xffa0],
    ['BRAILLE PATTERN BLANK U+2800', 0x2800],
    ['COMBINING TILDE U+0303', 0x0303],
  ]) {
    const b = ch(c);
    assert.strictEqual(
      readFrontmatter(`---
pinned: true
---${b}
content`).state, 'unverifiable',
      `${name}: parity anchor - the CLOSING fence already refuses this byte`,
    );
    assert.strictEqual(
      readFrontmatter(`---${b}
pinned: true
---
content`).state, 'unverifiable',
      `${name}: the opening fence must refuse it too, or the primitive contradicts itself`,
    );
  }
  // a run mixing tolerated and untolerated whitespace is still untolerated - the
  // tolerance is for the ordinary editor artifact, not for whatever resembles it
  assert.strictEqual(readFrontmatter(`--- ${ch(0x00a0)}${ch(0x09)}
pinned: true
---
x`).state, 'unverifiable', 'mixed [ \t] + NBSP run');
});

// ── MULTISET (board disposition 2, 2026-07-27) ─────────────────────────────
// The old set semantics let occurrence collapse pass silently: `878` stated on
// three DIFFERENT lines surviving on one reported 0 drops — a token DROPPED,
// inside the gate's existing promise. Occurrences are counted once per
// DISTINCT line, so an exact-duplicate-line cut (the broom's own charter:
// an identical line survives, information-free BY SPEC) stays green by
// construction while cross-line collapse goes red.
test('MULTISET: occurrence collapse across DISTINCT lines is a drop (878 x3 -> x1)', () => {
  const orig = 'run A: pass 878 today\nrun B: baseline 878 noted\nrun C: retest 878 again\n';
  const next = 'run A: pass 878 today\n';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false, 'collapsing 3 mentions to 1 must not pass silently');
  const d = r.drops.find((x) => x.type === 'number-drop' && x.value === '878');
  assert.ok(d, `expected an occurrence-grade number-drop for 878, got ${JSON.stringify(r.drops)}`);
  assert.deepStrictEqual(d.occurrences, { orig: 3, kept: 1 }, 'the record names the honest mention counts');
  // the full-drop shape is unchanged (no occurrences field on a vanished value)
  const gone = checkFidelity(orig, 'no numbers left\n');
  assert.ok(gone.drops.some((x) => x.type === 'number-drop' && x.value === '878' && !x.occurrences), 'a vanished value stays the plain full drop');
});

test('MULTISET controls: an exact-duplicate LINE cut, and a value MOVED between lines, both stay green', () => {
  // dup-line cut — Quick's charter: an identical line survives
  const dupOrig = 'alpha [[Target]] 42%\nalpha [[Target]] 42%\nother line\n';
  const dupNext = 'alpha [[Target]] 42%\nother line\n';
  const dup = checkFidelity(dupOrig, dupNext);
  assert.strictEqual(dup.pass, true, `removing an exact duplicate line is information-free BY SPEC: ${JSON.stringify(dup.drops)}`);
  // a value moved to a differently-worded line keeps its occurrence
  const move = checkFidelity('the run scored 64.6% on retry\n', '64.6% (retry score)\n');
  assert.strictEqual(move.pass, true, `a moved value is not an occurrence drop: ${JSON.stringify(move.drops)}`);
  // an md-link restyled to a bare link is ONE occurrence on both sides (the
  // extractor overlap must not double-count `[t](url)` as link+bare)
  const restyle = checkFidelity('see [docs](https://example.com/a) here\n', 'see https://example.com/a here\n');
  assert.strictEqual(restyle.pass, true, `a link restyle must not double-count: ${JSON.stringify(restyle.drops)}`);
});

test('MULTISET spans the single-line classes: a wikilink mentioned on two lines surviving on one is a drop', () => {
  const orig = 'see [[Alpha]] here\nand [[Alpha]] again elsewhere\n';
  const next = 'see [[Alpha]] here\n';
  const r = checkFidelity(orig, next);
  assert.strictEqual(r.pass, false);
  const d = r.drops.find((x) => x.type === 'wikilink-drop' && x.value === 'Alpha');
  assert.deepStrictEqual(d && d.occurrences, { orig: 2, kept: 1 });
  // approval key stays `${type}:${value}` — the wizard/RE-TIER channels need
  // no new grammar (an occurrence drop is approvable under the same name)
});

test('FENCE SHAPE controls: what must NOT become frontmatter (no over-refusal)', () => {
  // a pasted diff header is prose, not a fence — must stay washable
  assert.strictEqual(readFrontmatter('--- a/file.txt\n+++ b/file.txt\ncontext').state, 'none');
  // 4+ dashes at line 1 = a thematic break, not a fence
  assert.strictEqual(readFrontmatter('----\nprose').state, 'none');
  // a leading blank line = not frontmatter BY CONVENTION (a position-0
  // construct — the BOM addendum's "position 0 only" ruling, same axis).
  // DECIDED and pinned here so the choice is visible, not accidental; the
  // lab called it a room judgment call and this row is the room's answer.
  assert.strictEqual(readFrontmatter('\n---\npinned: true\n---\nx').state, 'none');
  // the third consequence: an unclosed fence whose OPENER carries trailing
  // whitespace is still "opens but never closes" = unverifiable, not 'none'
  assert.strictEqual(readFrontmatter('--- \nkey: v\nnever closes').state, 'unverifiable');
});
// ROUND 4 - THE RULING: the defect was never the list, it was the POLARITY.
// `'none'` is the answer that ends in a DELETE, and it was the FALLTHROUGH, so
// every codepoint nobody had classified landed on the dangerous side by
// default - which is why one line took four repairs. `'none'` must now be
// EARNED by proving a visible glyph; everything else refuses. This test states
// the contract as a SWEEP rather than a list, because a list is exactly the
// thing that has failed four times.
test('FENCE POLARITY: no codepoint above ASCII can reach the deleting answer (BMP sweep, not an enumeration)', () => {
  const leaks = [];
  for (let cp = 0xa0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogate is not a character
    if (readFrontmatter('---' + String.fromCharCode(cp) + '\npinned: true\n---\nx').state === 'none') {
      leaks.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
      if (leaks.length > 12) break;
    }
  }
  assert.deepStrictEqual(leaks, [], `a fence tail must EARN 'none'; these reached it: ${leaks.join(' ')}`);
  // an astral codepoint arrives as two surrogate code units, neither of which
  // is printable ASCII, so it takes the refusing branch by the same rule
  assert.strictEqual(readFrontmatter('---\u{1F600}\npinned: true\n---\nx').state, 'unverifiable', 'astral tail refuses');
});

// THE PRICE OF THE POLARITY, PINNED SO IT IS A DECISION AND NOT A SURPRISE:
// a tail of legitimately VISIBLE non-ASCII prose is now refused too. That is a
// YIELD loss (the file is not washed), never a SAFETY loss (it is not deleted
// either), and it is the honest cost of an allowlist whose every member can be
// pointed at. Do not 'fix' this by widening to a Unicode category: U+3164
// HANGUL FILLER is `Lo`, exactly like ordinary Hangul, and renders as nothing.
test('FENCE POLARITY residual: a VISIBLE non-ASCII tail is refused as well — yield lost, safety kept', () => {
  assert.strictEqual(readFrontmatter('---\u0E01\nkey: v\n---\nx').state, 'unverifiable', 'Thai tail: refused, not washed');
  assert.strictEqual(readFrontmatter('---\u6F22\nkey: v\n---\nx').state, 'unverifiable', 'CJK tail: refused, not washed');
  // and the ASCII controls that MUST stay washable are unaffected
  assert.strictEqual(readFrontmatter('--- a/file.txt\n+++ b\nctx').state, 'none', 'pasted diff header stays washable');
  assert.strictEqual(readFrontmatter('----\nprose').state, 'none', 'thematic break stays washable');
  assert.strictEqual(readFrontmatter('Title\n---\nbody').state, 'none', 'setext heading stays washable');
  assert.strictEqual(readFrontmatter('\n---\npinned: true\n---\nx').state, 'none', 'leading blank line stays washable');
  assert.strictEqual(readFrontmatter('--- some prose here\nmore').state, 'none', 'ASCII prose tail stays washable');
});

// ── G3-1: the block now has ONE reader, and the GATE's half must not move ────
// isPinned stopped running its own regex over the block and now reads the same
// parse frontmatterKeys does. That refactor is only safe if the inventory is
// byte-identical: frontmatterKeys feeds checkFidelity, so a key appearing or
// vanishing here is a false drop or a missed one on every washed file.
// This is a CHARACTERIZATION test — it passed before the change, and its RED
// proof is the mutation (routing frontmatterKeys through the loose entries too
// makes `pinned:true` a key and this goes red).
test('G3-1: frontmatterKeys inventories exactly the STRICT mapping shape — unchanged by the shared parser', () => {
  const keys = (inner) => [...frontmatterKeys('---\n' + inner + '\n---\nbody')].sort();
  assert.deepStrictEqual(keys('pinned:true'), [], 'no space after the colon is NOT a YAML mapping — never was a key, still is not');
  assert.deepStrictEqual(keys('a:b c: d'), ['a:b c'], 'the lookahead backtracks to the colon that IS followed by space — key is `a:b c`, not `a`');
  assert.deepStrictEqual(keys('pinned: true'), ['pinned']);
  assert.deepStrictEqual(keys('"pinned": true'), ['"pinned"'], 'quotes are part of the raw key, as before');
  assert.deepStrictEqual(keys('pinned:'), ['pinned'], 'a valueless key is still a key');
  // ROUND 7 — THIS ASSERTION ENCODED THE DEFECT and is corrected by name, not
  // quietly relaxed. It read `[]` with the reason "indented -> not top level",
  // which is the exact false premise that let an indented `pinned: true` be
  // DELETED (G4-2) and the whole indented-key class go uninventoried (G4-3):
  // COLUMN 0 IS NOT THE DEFINITION OF TOP LEVEL. A block mapping may sit at any
  // consistent indentation, so a block whose only line is `  nested: x` has its
  // root column at 2 and `nested` IS its top-level key. The nested case the old
  // reason meant is still excluded and still tested — one line below, and in
  // its own G4-3 test, where the parent key makes the nesting real.
  assert.deepStrictEqual(keys('  nested: x'), ['nested'], 'a uniformly-indented block is a ROOT mapping — its key is top level');
  assert.deepStrictEqual(keys('parent:\n  nested: x'), ['parent'], 'nesting is relative to the block root: THIS is the case the old assertion meant');
  assert.deepStrictEqual(keys('- item: x'), [], 'a sequence item is not a key');
  assert.deepStrictEqual(keys('# comment: x'), [], 'a comment is not a key');
  assert.deepStrictEqual(keys('https://example.com'), [], 'a bare URL is not a key');
});

// G3-2 at the primitive: `$` means END OF FILE for whole text and END OF THE
// WINDOW for a prefix somebody else cut. Only the caller knows which it handed
// over, so the caller declares it — the same "each caller declares its own safe
// direction" discipline the tri-state itself is built on.
test('G3-2: a close that relies on end-of-STRING is not a close when the text is a truncated prefix', () => {
  const whole = '---\npinned: true\n---';       // a real file that ends without a trailing newline
  assert.strictEqual(readFrontmatter(whole).state, 'closed', 'end of FILE is a legitimate close');
  assert.strictEqual(readFrontmatter(whole, { truncated: true }).state, 'unverifiable', 'end of the WINDOW proves nothing — the block may continue');
  const closed = '---\npinned: true\n---\nbody';
  assert.strictEqual(readFrontmatter(closed, { truncated: true }).state, 'closed', 'a real terminator after the fence still closes, truncated or not');
  assert.strictEqual(readFrontmatter('no fence here', { truncated: true }).state, 'none', 'truncation never turns a non-fence into a refusal');
});

// ---------------------------------------------------------------------------
// G4-3 (round 7) — "TOP LEVEL" IS THE BLOCK'S OWN ROOT COLUMN, NOT COLUMN 0.
// Both readers of the block anchored on `^[^\s...]`, so ONE leading space made a
// line stop being an entry at all: the gate inventoried nothing and the pin gate
// (apply.mjs) saw no pin and deleted the file. A YAML block mapping may sit at
// any consistent indentation, so a uniformly-indented block IS a root mapping.
// The discriminator that keeps this from degenerating into "inventory
// everything" is the nested control: a key indented BELOW a root key must stay
// out, or the fix over-refuses into uselessness.
// ---------------------------------------------------------------------------
const g4keys = (inner) => [...frontmatterKeys('---\n' + inner + '\n---\nbody')].sort();

test('G4-3: a uniformly-indented block is a root mapping — its keys ARE inventoried', () => {
  assert.deepStrictEqual(g4keys(' alpha: 1\n beta: 2'), ['alpha', 'beta'], 'one leading space is still a root-level block mapping');
  assert.deepStrictEqual(g4keys('  alpha: 1\n  beta: 2'), ['alpha', 'beta'], 'two spaces likewise');
  assert.deepStrictEqual(g4keys('# lead comment\n  alpha: 1'), ['alpha'], 'a comment does not set the root column (YAML ignores it for indentation)');
});

test('G4-3: a key nested UNDER a root key stays excluded — nesting is relative to the block root, not to column 0', () => {
  assert.deepStrictEqual(g4keys('meta:\n  alpha: 1'), ['meta'], 'the classic nested case is unchanged');
  assert.deepStrictEqual(g4keys('  meta:\n    alpha: 1'), ['meta'], 'the same nesting, whole block indented');
  assert.deepStrictEqual(g4keys('title: x\nlist:\n  - a\n  - b\ndesc: |\n  alpha: 1'), ['desc', 'list', 'title'], 'sequence items and block-scalar content are not keys');
});

// MONOTONE GUARD. Round 5 shipped a regression because a merge was assumed to be
// a widening and was not measured in both directions. Here the two readings
// (column 0, and the block's root column) disagree on a mixed-indent block, so
// the inventory takes the UNION: neither reading may LOSE a key the other saw.
// Its RED proof is mutation M-U (drop the `|| e.indent === 0` clause).
test('G4-3: on a mixed-indentation block the inventory is the UNION of both readings, and nothing wider', () => {
  assert.deepStrictEqual(g4keys('  alpha: 1\npinned: true'), ['alpha', 'pinned'], 'root column 2 sees alpha; the old column-0 anchor saw pinned; keep both');
  // THE OTHER HALF, and it exists because a mutation found it missing: a key at
  // a column that is NEITHER the root NOR 0 is in neither reading, so the union
  // must not sweep it in. Without this line, mutating `top` to a constant `true`
  // changed NO test result — a flag nobody had exercised on its only
  // discriminating slice, which is a guard that reads as load-bearing and is not.
  assert.deepStrictEqual(g4keys('    alpha: 1\n  beta: 2'), ['alpha'], 'column 2 is neither the root (4) nor 0 — in neither reading, so not inventoried');
});

// ---------------------------------------------------------------------------
// G4 (round 7) — THE QUESTION IS INVERTED. Not "did we find a pin?" but "can we
// prove this block is safe to touch?" A block is provably readable only when
// EVERY line is one of: blank · a comment · a `key:`-shaped line · a sequence
// item · content indented deeper than the root. Anything else refuses the whole
// file, because "no marker found" is an answer a wrong parse always produces and
// "every line accounted for" is not.
// ---------------------------------------------------------------------------
test('G4: ordinary frontmatter is provably readable — nested map, sequence, block scalar and comments all understood', () => {
  for (const inner of [
    'title: x',
    'title: x\nnested:\n  a: 1\nlist:\n  - a\n  - b\ndesc: |\n  pinned: true\n  more',
    ' title: x\n owner: bob',
    '# note\ntitle: x\n\n# trailing note',
    '- a\n- b',
    'title: ' + String.fromCharCode(0x0e01, 0x0e02) + ' (a Thai VALUE is ordinary)',
    'https://example.com',
  ]) {
    assert.strictEqual(frontmatterBlockParse(inner).unreadable, null, `${JSON.stringify(inner)} must stay readable — over-refusal is a yield loss and must stay a DECISION`);
  }
  assert.strictEqual(frontmatterBlockParse('').unreadable, null, 'an empty block is trivially readable');
});

test('G4: a line the block-reader cannot account for refuses the whole block, with a reason', () => {
  const CH = String.fromCharCode;
  for (const [label, inner] of [
    ['a TAB in the indentation (illegal YAML indentation — no column to compute)', CH(9) + 'pinned: true'],
    ['NBSP used as indentation', CH(160) + 'pinned: true'],
    ['IDEOGRAPHIC SPACE used as indentation', CH(0x3000) + 'pinned: true'],
    ['a ZERO WIDTH SPACE glued to the key', CH(0x200b) + 'pinned: true'],
    ['a flow mapping at the root', '{pinned: true}'],
    ['a key line shallower than the block root', '  alpha: 1\n%YAML 1.2'],
    ['a key split across two lines', ' pinned\n : true'],
    ['a document-end marker inside the block', 'title: x\n...'],
  ]) {
    const r = frontmatterBlockParse(inner);
    assert.ok(r.unreadable, `${label} must refuse: ${JSON.stringify(inner)}`);
    assert.strictEqual(typeof r.unreadable, 'string', 'the refusal carries a reason a user can act on');
  }
});

// ---------------------------------------------------------------------------
// THE REPLACEMENT ORACLE (round 7). G3-1's oracle was the DISAGREEMENT between
// two readers of the block; collapsing them to one reader removed it, and round
// 6 then showed that a hand-written list standing in for it is not an oracle at
// all ("a test cannot protect a file"). So the expectation here comes from a
// CONSTRUCTION PLAN: the generator WRITES the block and therefore KNOWS which
// keys are top level — it never reads one. That is independent of the parser in
// the only way that matters, and unlike a second parser it cannot drift into
// agreement with the first.
//
// ITS BOUND — THREE THINGS IT DOES NOT COVER, listed because the first version
// of this paragraph named only the first and that is how a bound becomes a
// slogan:
//   1. YAML CONFORMANCE. It proves the reader agrees with the CONSTRUCTION; if
//      generator and parser share a misconception they are wrong together. The
//      independent check was an external parser (js-yaml) run in the LAB — it
//      cannot ship, zero-dependency is binding (Phoenix #2).
//   2. THE PIN VALUE SEMANTICS. See the ⚠ below: the pin reading here is a
//      deliberately dumb third implementation, and 54 of the 400 blocks
//      disagree with the shipped `isPinned` by design.
//   3. THE LINE BASIS. Every block is joined with `\n`, so the bare-CR
//      refusal at `frontmatterBlockParse`'s split (the closed round-7
//      residual) is invisible to this generator — it cannot exercise a
//      shape it never emits; the LINE BASIS tests below own that axis.
// So: this oracle owns the top-level/nested DISCRIMINATION and nothing else.
// ---------------------------------------------------------------------------
test('ORACLE: over 400 generated blocks the reader reports exactly the keys the GENERATOR placed at the root', () => {
  let s = 20260728 >>> 0;
  // HIGH bits, not `% n`. The first draft took the low bits of an LCG, whose
  // low-order period is famously short: `rnd(2)` never returned 0 and the sweep
  // generated ZERO top-level pins — a fully green run over 400 blocks that
  // tested nothing. The vacuity assertions at the bottom are what caught it.
  const rnd = (n) => (((s = (s * 1664525 + 1013904223) >>> 0) >>> 16) % n);
  const NAMES = ['pinned', 'title', 'owner', 'topic', 'a.b', '$ref', 'my_key', 'version-transition'];
  let cases = 0, withPin = 0, withDecoy = 0;
  for (let i = 0; i < 400; i++) {
    const root = rnd(5);                 // the block's own root column, 0..4
    const pad = ' '.repeat(root);
    const lines = [];
    const planned = new Set();           // GROUND TRUTH: what the generator put at the root
    let plannedPin = false;
    if (rnd(3) === 0) lines.push(' '.repeat(rnd(7)) + '# a comment sits at any column');
    if (rnd(4) === 0) lines.push('');
    const n = 1 + rnd(4);
    for (let k = 0; k < n; k++) {
      const name = NAMES[rnd(NAMES.length)];
      if (planned.has(name)) continue;   // a duplicate key is a different question
      const pin = name === 'pinned' && rnd(2) === 0;
      planned.add(name);
      if (pin) plannedPin = true;
      lines.push(pad + name + ': ' + (pin ? 'true' : 'value' + k));
      // a NESTED child, or a block scalar carrying a DECOY pin — both must be
      // invisible to both consumers, and both are only ever DEEPER by YAML rule
      if (rnd(3) === 0) lines.push(pad + '  ' + (rnd(2) ? 'nested' : 'pinned') + ': true');
      if (rnd(5) === 0) {
        lines.push(pad + '  - list item');
        withDecoy++;
      }
    }
    if (rnd(4) === 0) { lines.push(pad + 'desc: |'); planned.add('desc'); lines.push(pad + '  pinned: true'); withDecoy++; }
    const block = lines.join('\n');
    const parsed = frontmatterBlockParse(block);
    assert.strictEqual(parsed.unreadable, null, `the generator only builds readable blocks; got ${parsed.unreadable} for\n${block}`);
    assert.deepStrictEqual(
      [...frontmatterKeys('---\n' + block + '\n---\nbody')].sort(), [...planned].sort(),
      `the inventory must equal the keys the generator placed at column ${root}:\n${block}`,
    );
    // ⚠ THIS IS DELIBERATELY *NOT* `isPinned`, AND THE ASSERT BELOW SAYS SO.
    // It is a THIRD, deliberately dumb reading of a pin — no `pinKey`, no
    // `pinValueClears`, no `unquote`, no `RETIRED_PIN_FLOOR` — because the axis
    // under test here is PLACEMENT (is this key at the root?), not the value
    // semantics that `apply.mjs` owns. Measured: **54 of these 400 blocks
    // disagree with the shipped predicate** — a generated `pinned: value0` is
    // PINNED by the product (an unrecognised value is fail-safe) and unpinned by
    // this line. That direction is safe and there is no live hole, but the
    // mismatch must be NAMED here, because the obvious "improvement" — swapping
    // in the real `isPinned` — goes RED on those 54 and reads as a product bug.
    // IT IS NOT. If you make that swap, the fixture's value pool is what needs
    // changing, never `PIN_CLEARED`.
    const readsPinned = parsed.entries.some((e) => e.top && e.key === 'pinned' && e.value.trim() === 'true');
    assert.strictEqual(readsPinned, plannedPin, `the ROOT-COLUMN placement of a literal \`pinned: true\` must match the plan — this is not the shipped isPinned verdict (root column ${root}):\n${block}`);
    cases++;
    if (plannedPin) withPin++;
  }
  // A generator that never generated the interesting case is a green test that
  // proves nothing — vacuity shape (3), which this room has now paid for twice.
  assert.strictEqual(cases, 400);
  assert.ok(withPin > 40, `the space must actually contain top-level pins; got ${withPin}`);
  assert.ok(withDecoy > 40, `and decoys that must NOT count as pins; got ${withDecoy}`);
});

// ---------------------------------------------------------------------------
// THE LINE BASIS (rc.9 station-3 MED, the round-7 residual closed). "Every line
// accounted for" inherits the correctness of the LINE SPLIT it counts over:
// `split(/\r?\n/)` does not break on a lone CR, YAML 1.2 does (`b-break ::=
// CRLF | CR | LF`), so a MIXED-ending block joined `  title: x<CR>  pinned:
// true` into ONE line and reported it fully accounted for over a WRONG BASIS —
// and the hidden top-level pin was deletable. The fix is AT the split's owner:
// a block containing a bare CR refuses as unreadable (the same reason string
// discipline as readFrontmatter's `cr` fence branch), because no per-line
// verdict can be trusted when the lines themselves are mis-cut.
// ---------------------------------------------------------------------------
test('LINE BASIS: a block containing a bare CR refuses — the split basis cannot be trusted', () => {
  const CR = String.fromCharCode(13);
  for (const [label, block] of [
    ['the measured shape: a lone CR hiding a top-level pin', `  title: x${CR}  pinned: true`],
    ['a lone CR mid-value', `title: a${CR}b: c`],
    ['a lone CR at block end', `title: x${CR}`],
  ]) {
    const r = frontmatterBlockParse(block);
    assert.ok(r.unreadable, `${label} must refuse: ${JSON.stringify(block)}`);
    assert.match(String(r.unreadable), /CR|line/i, 'the reason names the line-discipline problem');
  }
});

// ---------------------------------------------------------------------------
// KEY-LINE PARSE COST (rc.9 station-3 LOW). The retired KEY_STRICT/KEY_LOOSE
// regexes re-scanned the whitespace run once per lazy start position, so one
// line of `a` + 60 KiB of spaces cost ~5.4 s (quadratic) — and round 7 doubled
// the EXPOSURE by calling the parser from sniffUnrewritable too. The scan
// replacement is linear; the bound below is ~1000x the fixed cost and ~4x
// under the measured quadratic, so it can only trip if the quadratic returns.
// Semantics are pinned by the RETIRED-REGEX ORACLE test underneath, not here.
// ---------------------------------------------------------------------------
test('KEY-LINE COST: a 60 KiB pathological line parses in bounded time (was ~5.4 s quadratic)', () => {
  const shapes = [
    'a' + ' '.repeat(61440),          // no colon at all — both retired regexes went quadratic
    'a' + ' '.repeat(61440) + ':x',   // a colon that fails the strict lookahead — strict went quadratic
  ];
  for (const line of shapes) {
    const t0 = process.hrtime.bigint();
    frontmatterBlockParse(line);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `parsing ${line.length} chars took ${ms.toFixed(0)}ms — the quadratic is back`);
  }
});

// ---------------------------------------------------------------------------
// GATE COST ON THE DROPS PATH (#36). `roundedSurvivor` parsed every surviving
// candidate once per dropped number — O(drops x candidates) regex parses; the
// reviewer's curve: 128 KB 0.28 s -> 1.04 MB 15.4 s (2x input = ~4x time), on
// the no-drop path linear. Every second of gate time sits inside applyPlan's
// window between the staging read and the external-writer compare, so gate
// time is exposure, not just latency. The candidates are now parsed ONCE per
// checkFidelity call; the bound below is ~10x the fixed cost and ~2x under
// the measured quadratic at this size, so it only trips if the quadratic
// returns. Semantics are pinned by the survivor-order control underneath and
// by the old-vs-new corpus differential recorded in the CHANGELOG.
// ---------------------------------------------------------------------------
function dropHeavyPair(targetBytes) {
  // ~64-byte lines, one distinct number each; next keeps alternate lines, so
  // half the numbers DROP and half survive as candidates. The numbers are ODD
  // (no trailing zeros -> ulp 1 for every token) so NO candidate is ever
  // "strictly coarser" and every dropped number scans the WHOLE candidate set
  // — the worst shape. (A first fixture used consecutive integers; their
  // trailing-zero ulps let the very first candidate match, the loop
  // short-circuited, and the quadratic never fired — a green perf test that
  // measured nothing.)
  const lines = [];
  for (let i = 0; lines.length * 64 < targetBytes; i++) {
    lines.push(`metric entry ${1111111 + 2 * i} holds steady across the window`);
  }
  const next = lines.filter((_, i) => i % 2 === 0);
  return { orig: lines.join('\n'), next: next.join('\n') };
}
test('GATE COST: a drop-heavy 512 KB pair gates in bounded time (was ~4.8 s quadratic at this size)', () => {
  const { orig, next } = dropHeavyPair(512 * 1024);
  const t0 = process.hrtime.bigint();
  const r = checkFidelity(orig, next);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(r.drops.length > 1000, `the fixture must actually be drop-heavy; got ${r.drops.length}`);
  assert.ok(ms < 2000, `gating ${orig.length} chars with ${r.drops.length} drops took ${ms.toFixed(0)}ms — the quadratic is back`);
});

// The SECOND quadratic term in the same function (found while closing #36,
// controlled-pair proven: `verified` -> `notedxx` collapses 721 ms -> 48 ms at
// 512 KB): the evidence-anchor loop ran `next.includes(tok)` — a full-text
// scan — once per SURVIVING orig evidence token. Our own MEMORY.md house style
// is exactly this marker-heavy shape. The fix: extract next's own evidence
// tokens ONCE; extraction-match implies substring, so set membership
// short-circuits the scan without changing any branch outcome. THE NAMED
// RESIDUAL: a GENUINELY ABSENT token still pays one full `includes` scan (the
// exact-substring semantics require it), so a file dropping thousands of
// evidence anchors at once still scales super-linearly — that plan is about
// to be refused wholesale anyway, and the honest bound is stated rather than
// papered over.
test('GATE COST: a marker-heavy LOW-DROP 1 MB pair gates in bounded time (the typical wash shape — most tokens survive)', () => {
  const lines = [];
  for (let i = 0; lines.length * 80 < 1024 * 1024; i++) {
    lines.push(`finding ${i} verified in commit abc${(1000000 + i).toString(16)}def against results-${i}.md`);
  }
  const orig = lines.join('\n');
  const next = lines.filter((_, k) => k % 16 !== 15).join('\n'); // ~6% dropped, 94% survive
  const t0 = process.hrtime.bigint();
  const r = checkFidelity(orig, next);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(r.drops.length > 100, `the fixture must still drop something; got ${r.drops.length}`);
  assert.ok(ms < 2000, `gating 1 MB marker-heavy with ${r.drops.length} drops took ${ms.toFixed(0)}ms — the surviving-token scan is back`);
});

test('GATE COST control: the FIRST coarser survivor in inventory order is still the one named — the tie-break is pinned', () => {
  // 44192 drops; two candidates both qualify as strictly-coarser matches
  // (44.19k and 44000: |44192-44190|=2 < 100? no — 44.19k ulp=10, |44192-44190|=2 <10 yes;
  // 44000 ulp=1000, |44192-44000|=192 < 1000 yes). Inventory order = extraction
  // order (magnitude before bare integer), so 44.19k must be the named survivor
  // — an "optimization" that reorders candidates changes receipts and fails here.
  const orig = 'exact 44192 measured';
  const next = 'rounded 44.19k and 44000 both mentioned';
  const r = checkFidelity(orig, next);
  const p = r.drops.find((d) => d.type === 'number-precision' && d.value === '44192');
  assert.ok(p, `44192 must be a number-precision drop: ${JSON.stringify(r.drops)}`);
  assert.strictEqual(p.survivor, '44.19k', 'the first qualifying candidate in inventory order is the named survivor');
});

// THE RETIRED REGEXES ARE THE ORACLE — test-local copies of the exact retired
// spec, run on SHORT bodies where their quadratic cost is invisible. The rule
// is round 6's, in its legitimate role: generate the space the OLD parser
// admitted and demand the NEW one answers identically — match/no-match, key,
// value, and strict tier, every body. (This oracle is a SPEC for equivalence,
// not a safety floor — the floor lives in apply.mjs; do not move this into
// the engine.) BOUND: the oracle covers the per-LINE language only; the block
// layer above it (root column, CR refusal, indicators) has its own tests.
test('KEY-LINE ORACLE: the scan parser answers exactly like the retired KEY_STRICT/KEY_LOOSE on every enumerated shape', () => {
  const OLD_STRICT = /^([^\s:#-][^\n]*?)\s*:(?=\s|$)([^\n]*)$/; // retired spec, verbatim
  const OLD_LOOSE = /^([^\s:#-][^\n]*?)\s*:([^\n]*)$/;          // retired spec, verbatim
  const CR = String.fromCharCode(13);
  const NBSP = String.fromCharCode(0xa0);
  const bodies = [
    'a: b', 'a:b', 'a :b', 'a : b', 'a  : b', 'a\t: b', 'a:', 'a: ', 'a',
    'a:b c: d', 'a:b: c', 'a :x b: c', 'a b:c d: e', 'key  : v',
    ':leading', '#comment: x', '- item: x', ' indented: x',
    'a' + CR + ': v', 'a' + CR + ':b', 'title: x' + CR + '  pinned: true',
    'k' + NBSP + ': v', NBSP + 'k: v', 'k: v' + NBSP, 'k' + NBSP + 'x: v',
    'https://example.com', 'a: b: c', 'a::b', 'a:: b', '\u0e01\u0e02: thai key', 'e\u00e9: v',
    'a ' + ' '.repeat(40) + ': v', 'a' + ' '.repeat(40) + ':x',
    'a:\tb', 'a\t\t: b', 'x'.repeat(200) + ': v', 'k:' + CR, 'k: v' + CR,
  ];
  let strictHits = 0, looseOnly = 0, misses = 0;
  for (const body of bodies) {
    const os = OLD_STRICT.exec(body);
    const ol = os || OLD_LOOSE.exec(body);
    const parsed = frontmatterBlockParse(body);
    // Project the single-line parse back out of the block reader: exactly one
    // non-blank line, no comment/seq/indent interference for these bodies is
    // NOT guaranteed (some ARE comments/seq/indented) — so compare through the
    // entries the block reader emits, which is the shipped surface.
    const entry = parsed.entries.length === 1 ? parsed.entries[0] : null;
    if (ol && !/^[#\-\s]/.test(body[0]) && body.trim()) {
      assert.ok(entry, `old parser matched ${JSON.stringify(body)} — the scan must too`);
      assert.strictEqual(entry.key, ol[1], `key must match the retired spec for ${JSON.stringify(body)}`);
      assert.strictEqual(entry.value, ol[2], `value must match the retired spec for ${JSON.stringify(body)}`);
      assert.strictEqual(entry.strict, !!os, `strict tier must match the retired spec for ${JSON.stringify(body)}`);
      if (os) strictHits++; else looseOnly++;
    } else if (!ol && !/^[#\-\s]/.test(body[0] || '#') && body.trim()) {
      assert.strictEqual(entry, null, `old parser refused ${JSON.stringify(body)} — the scan must too`);
      misses++;
    }
  }
  // Vacuity: the enumeration must actually exercise all three answer classes.
  assert.ok(strictHits >= 10, `strict matches exercised: ${strictHits}`);
  assert.ok(looseOnly >= 3, `loose-only matches exercised: ${looseOnly}`);
  assert.ok(misses >= 2, `refusals exercised: ${misses}`);
});

test('LINE BASIS controls: CRLF and LF blocks are unaffected, and the inventory on a refused block is unchanged', () => {
  const CR = String.fromCharCode(13);
  // CRLF pairs are a legal break for both YAML and the splitter — never refused.
  assert.strictEqual(frontmatterBlockParse(`title: x${CR}\npinned: true`).unreadable, null, 'a CRLF block stays readable');
  assert.strictEqual(frontmatterBlockParse('title: x\npinned: true').unreadable, null, 'an LF block stays readable');
  // The inventory (frontmatterKeys ignores `unreadable` by contract) keeps
  // exactly what it always read on the joined basis — the fix adds the refusal,
  // it does not change the entries.
  const doc = `---\n  title: x${CR}  pinned: true\n---\nbody`;
  assert.deepStrictEqual([...frontmatterKeys(doc)], ['title'], 'inventory byte-identical to the pre-fix joined-basis reading');
});
