import { test } from 'node:test';
import assert from 'node:assert';
import { sweepResidue, stripEmptyTables, flagEmptyHeadings, flagEmptyTables } from './quick.mjs';

// ---------------------------------------------------------------------------
// (1) sweepResidue — RETIRED as a text-mutator (IC-PIN wave-6, a blind re-IC
// over wave-5): a heading TITLE is always content, so this is now an
// unconditional (origText, newText) -> newText pass-through for EVERY
// heading shape, whether pre-existing-empty or emptied by this run.
// flagEmptyHeadings (below) picks up the just-emptied case for free once
// nothing deletes it.
// ---------------------------------------------------------------------------

test('sweepResidue: never mutates -- a heading emptied BY THIS EDIT keeps its title (wave-6: was previously auto-cut, the exact bug this wave fixes)', () => {
  const orig = '## Intro\ntext\n\n## Commits\n- commit one\n- commit two\n\n## Outro\nbye\n';
  const newText = '## Intro\ntext\n\n## Commits\n\n## Outro\nbye\n';
  assert.strictEqual(sweepResidue(orig, newText), newText, 'the heading title is content -- never auto-deleted, even when its body is provably emptied this run');
});

test('sweepResidue: a heading that was ALREADY empty before this edit is (still) never touched', () => {
  const orig = '## Placeholder\n\n## Real Section\ncontent\n';
  const newText = '## Placeholder\n\n## Real Section\ncontent trimmed\n';
  assert.strictEqual(sweepResidue(orig, newText), newText);
});

test('sweepResidue: a heading whose body byte-duplicated a block elsewhere (exact-dedup) is (still) never touched -- the wave-4 dedup-only guard is now subsumed by the blanket no-cut rule', () => {
  const orig = '## Snapshot rule\nAlways snapshot before any delete.\n\n## Reminder for reviewers\nAlways snapshot before any delete.\n';
  const afterDedup = '## Snapshot rule\nAlways snapshot before any delete.\n\n## Reminder for reviewers\n';
  assert.strictEqual(sweepResidue(orig, afterDedup), afterDedup);
});

test('sweepResidue: a heading whose body SURVIVES (non-empty in new) is untouched', () => {
  const orig = '## Notes\nsomething long\n';
  const newText = '## Notes\nsomething short\n';
  assert.strictEqual(sweepResidue(orig, newText), newText);
});

test('sweepResidue: byte-exact round-trip incl. no-headings, empty strings, CRLF, and no-trailing-newline shapes', () => {
  assert.strictEqual(sweepResidue('plain prose, no headings\n', 'plain prose, no headings\n'), 'plain prose, no headings\n');
  assert.strictEqual(sweepResidue('', ''), '');
  const crlf = '## Intro\r\ntext\r\n\r\n## Commits\r\n\r\n## Outro\r\nbye\r\n';
  assert.strictEqual(sweepResidue('## Intro\r\ntext\r\n\r\n## Commits\r\n- one\r\n\r\n## Outro\r\nbye\r\n', crlf), crlf);
  const noTrailingNl = '## Commits\n\n## Outro\nbye';
  assert.strictEqual(sweepResidue('## Commits\n- one\n\n## Outro\nbye', noTrailingNl), noTrailingNl);
});

test('REGRESSION (the reported bug, verbatim shape): an instructive heading whose title IS the rule ("## Do not delete the audit log without sign-off") survives having its body emptied -- previously silently deleted', () => {
  const orig = '## Do not delete the audit log without sign-off\nkeep this rule verbatim\n\n## Keep\nx\n';
  const next = '## Do not delete the audit log without sign-off\n\n## Keep\nx\n';
  const out = sweepResidue(orig, next);
  assert.strictEqual(out, next);
  assert.ok(out.includes('Do not delete the audit log without sign-off'), 'the instruction survives verbatim');
  // and flagEmptyHeadings picks it up for human review -- the "flag" half of "preserved+flagged"
  const flags = flagEmptyHeadings(out);
  assert.ok(flags.some((f) => f.title === 'Do not delete the audit log without sign-off'), 'the just-emptied heading is surfaced for review, never silently dropped');
});

test('0d ship condition: duplicate headings (same title+level) never crash or get removed -- trivially true now that sweepResidue never mutates, kept as a shape-safety regression', () => {
  const orig = '## Dup\n\n## Dup\nreal content\n';
  const newText = '## Dup\n\n## Dup\n\n';
  const out = sweepResidue(orig, newText);
  assert.strictEqual(out, newText);
  assert.strictEqual((out.match(/## Dup/g) || []).length, 2);
});

test('0d ship condition: a heading whose LEVEL changed (same title, different #-depth) is never touched', () => {
  const orig = '## Notes\nreal content\n';
  const newText = '### Notes\n\n';
  assert.strictEqual(sweepResidue(orig, newText), newText);
});

test('0d ship condition: a heading title containing markdown emphasis/formatting round-trips unmodified', () => {
  const orig = '## **Bold** Section\ndetail here\n';
  const newText = '## **Bold** Section\nshorter\n';
  assert.strictEqual(sweepResidue(orig, newText), newText);
});

// ---------------------------------------------------------------------------
// (2) stripEmptyTables — RETIRED as a text-mutator (USER decision 2026-07-24,
// safety-over-yield, after SIX consecutive blind-IC waves on its provenance/
// identity mechanism -- see quick.mjs's own top-of-file note (2)). Every test
// below that used to prove a CUT now proves the opposite: the text round-
// trips byte-identical and the empty table (if any) is surfaced only via
// flagEmptyTables. Recognition-boundary regressions (what even COUNTS as a
// table candidate -- forEachTableCandidate, shared with flagEmptyTables) are
// repointed to flagEmptyTables further below, since stripEmptyTables no
// longer touches that logic at all.
// ---------------------------------------------------------------------------

test('stripEmptyTables: a table emptied this run (had a body row in origText, none now) is PRESERVED byte-identical, not removed -- genuine residue, but nothing cuts it now', () => {
  const orig = 'before\n\n| Col1 | Col2 |\n| --- | --- |\n| a | b |\n\nafter\n';
  const text = 'before\n\n| Col1 | Col2 |\n| --- | --- |\n\nafter\n'; // an earlier op removed the one body row
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text, 'byte-identical -- stripEmptyTables never removes anything');
  const flags = flagEmptyTables(out);
  assert.strictEqual(flags.length, 1, 'the empty table is surfaced via flagEmptyTables instead');
  assert.strictEqual(flags[0].header, 'Col1 | Col2');
});

test('REGRESSION (the reported bug, multi-column schema shape): a table that was header-only in origText -- never had a body row -- is PRESERVED, not cut (the CoalTipple/dogfood/PROMPT.md real loss)', () => {
  const text = 'Pick one:\n\n| model (+ variant) | tier | available? | เหตุผล |\n|---|---|---|---|\n\nFilled in per-invocation.\n';
  assert.strictEqual(stripEmptyTables(text, text), text, 'a schema table with no history of body rows is user-authored content, never removed');
});

test('REGRESSION (the reported bug, single prose-cell shape): a header-only single-cell "callout" table is PRESERVED, not cut', () => {
  const text = '## Wash policy\n\n| Never wash a file the user marked as a keep — ask first |\n| --- |\n\nMore policy text below.\n';
  assert.strictEqual(stripEmptyTables(text, text), text, 'a one-cell prose callout is content with zero structured token -- preserved regardless');
});

test('stripEmptyTables: multiple tables in one document are ALL preserved regardless of origText provenance -- only flagEmptyTables distinguishes the empty ones from the one with data', () => {
  const orig = [
    '| A | B |', '| --- | --- |', '| p | q |', '',
    '| C | D |', '| --- | --- |', '| x | y |', '',
    '| E | F |', '| --- | --- |', '| r | s |',
  ].join('\n');
  const text = [
    '| A | B |', '| --- | --- |', '',        // A|B: had a row in orig, now 0 -- preserved
    '| C | D |', '| --- | --- |', '| x | y |', '', // C|D: still has its row
    '| E | F |', '| --- | --- |',              // E|F: had a row in orig, now 0 -- preserved
  ].join('\n');
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text, 'byte-identical -- nothing is ever removed, provenance or not');
  const flags = flagEmptyTables(out);
  assert.deepStrictEqual(flags.map((f) => f.header), ['A | B', 'E | F'], 'the two empty tables are flagged; the one with data is not');
});

test('stripEmptyTables: a duplicate-keyed header-only table (the SAME header shape appears more than once) is trivially preserved now that provenance/ambiguity no longer decides anything -- kept as a shape-safety regression, mirrors sweepResidue\'s own duplicate-heading guard', () => {
  const orig = '| Area | Owner |\n| --- | --- |\n\n' // occurrence 1: always header-only
    + 'later:\n\n| Area | Owner |\n| --- | --- |\n| billing | alice |\n'; // occurrence 2: has a row
  const text = '| Area | Owner |\n| --- | --- |\n\n' + 'later:\n\n| Area | Owner |\n| --- | --- |\n'; // occurrence 2's row now gone too
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text);
  assert.strictEqual(flagEmptyTables(out).length, 2, 'both same-keyed occurrences are independently flagged -- flagEmptyTables never needed the old uniqueness gate');
});

test('stripEmptyTables: a table absent from origText entirely (brand new in newText) is trivially preserved -- shape-safety regression', () => {
  const orig = 'intro\n';
  const text = 'intro\n\n| New | Table |\n| --- | --- |\n';
  assert.strictEqual(stripEmptyTables(orig, text), text);
});

test('stripEmptyTables: an empty table at end-of-file (no trailing content), even one PROVEN emptied from a row in origText, is now PRESERVED and flagged, not removed', () => {
  const orig = 'intro\n\n| H |\n| --- |\n| v |';
  const text = 'intro\n\n| H |\n| --- |';
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text);
  assert.strictEqual(flagEmptyTables(out).length, 1);
});

test('stripEmptyTables: text with no tables at all round-trips unchanged', () => {
  const text = 'just some prose\nwith multiple lines\nand a | pipe | in it that is not a table\n';
  assert.strictEqual(stripEmptyTables(text, text), text);
});

test('stripEmptyTables: byte-exact round-trip incl. CRLF, mixed CRLF/LF, and no-trailing-newline shapes -- with no cut mechanism left, EOL-preservation-across-a-removal (the old wave-4/5 test class) is structurally impossible, folded into one invariant', () => {
  assert.strictEqual(stripEmptyTables('', ''), '');
  const crlfOrig = 'before\r\n\r\n| A | B |\r\n| --- | --- |\r\n| x | y |\r\n\r\nafter\r\n';
  const crlfNow = 'before\r\n\r\n| A | B |\r\n| --- | --- |\r\n\r\nafter\r\n';
  assert.strictEqual(stripEmptyTables(crlfOrig, crlfNow), crlfNow);
  const mixedOrig = 'before line one\n' + 'before line two\r\n' + '\r\n'
    + '| A | B |\r\n' + '| --- | --- |\r\n' + '| x | y |\r\n' + '\r\n' + 'after line\n';
  const mixedNow = 'before line one\n' + 'before line two\r\n' + '\r\n'
    + '| A | B |\r\n' + '| --- | --- |\r\n' + '\r\n' + 'after line\n';
  assert.strictEqual(stripEmptyTables(mixedOrig, mixedNow), mixedNow);
  const noTrailingOrig = 'intro\n\n| A |\n| --- |\n| v |';
  const noTrailingNow = 'intro\n\n| A |\n| --- |';
  assert.strictEqual(stripEmptyTables(noTrailingOrig, noTrailingNow), noTrailingNow);
});

// ---------------------------------------------------------------------------
// (3) flagEmptyHeadings — GENERAL case, single-snapshot, FLAG ONLY (never
// mutates) — unchanged by wave-6, but now the ONLY place a just-emptied
// heading's title gets surfaced.
// ---------------------------------------------------------------------------

test('flagEmptyHeadings: reports every empty heading, never mutates the text', () => {
  const text = '## Placeholder\n\n## Real\ncontent\n\n### Empty Sub\n';
  const flags = flagEmptyHeadings(text);
  assert.strictEqual(flags.length, 2);
  assert.deepStrictEqual(flags.map((f) => f.title), ['Placeholder', 'Empty Sub']);
  assert.strictEqual(flags[0].level, 2);
  assert.strictEqual(flags[1].level, 3);
});

test('flagEmptyHeadings: a heading with real content is never flagged', () => {
  assert.deepStrictEqual(flagEmptyHeadings('## Real\nstuff\n'), []);
});

test('flagEmptyHeadings: no headings at all -> []', () => {
  assert.deepStrictEqual(flagEmptyHeadings('just prose\n'), []);
});

// ---------------------------------------------------------------------------
// (4) flagEmptyTables — NEW at wave-6, the table's counterpart to
// flagEmptyHeadings: GENERAL case, single-snapshot, FLAG ONLY. Since
// stripEmptyTables's cut mechanism was retired (2026-07-24), this is the
// ONLY surface an empty table ever gets surfaced through.
// ---------------------------------------------------------------------------

test('flagEmptyTables: reports every header-only table, never mutates the text', () => {
  const text = 'a\n\n| A | B |\n| --- | --- |\n\nb\n\n| C |\n| --- |\n| x |\n\nc\n';
  const flags = flagEmptyTables(text);
  assert.strictEqual(flags.length, 1);
  assert.strictEqual(flags[0].header, 'A | B');
  assert.strictEqual(text, 'a\n\n| A | B |\n| --- | --- |\n\nb\n\n| C |\n| --- |\n| x |\n\nc\n', 'flagEmptyTables never mutates its input');
});

test('flagEmptyTables: a table with real data rows is never flagged', () => {
  assert.deepStrictEqual(flagEmptyTables('| A |\n| --- |\n| x |\n'), []);
});

test('flagEmptyTables: no tables at all -> []', () => {
  assert.deepStrictEqual(flagEmptyTables('just prose\n'), []);
});

test('flagEmptyTables: catches the table stripEmptyTables preserved (source header-only, deferred)', () => {
  const text = 'Pick one:\n\n| model (+ variant) | tier | available? | เหตุผล |\n|---|---|---|---|\n\nFilled in per-invocation.\n';
  const afterStrip = stripEmptyTables(text, text); // preserved, per the REGRESSION test above
  const flags = flagEmptyTables(afterStrip);
  assert.strictEqual(flags.length, 1);
  assert.ok(flags[0].header.includes('model'));
});

// ---------------------------------------------------------------------------
// Pipeline: sweepResidue then stripEmptyTables, matching the intended agent
// usage. Both are retired no-ops now -- the pipeline's job is entirely
// flagEmptyHeadings/flagEmptyTables surfacing what neither mutator touches.
// ---------------------------------------------------------------------------

test('pipeline: sweepResidue leaves the heading title in place while stripEmptyTables leaves the table in place too -- both retired mutators, the genuinely-emptied table is now flagged instead of cut', () => {
  const orig = '## Commits\n- one\n- two\n\n## Table\n| A |\n| --- |\n| x |\n\n## Keep\nsurvives\n';
  const afterAgentCut = '## Commits\n\n## Table\n| A |\n| --- |\n\n## Keep\nsurvives\n'; // the agent removed the list AND the one data row
  const afterSweep = sweepResidue(orig, afterAgentCut);
  const out = stripEmptyTables(orig, afterSweep);
  assert.strictEqual(out, afterAgentCut, 'both stages are pure pass-throughs now');
  assert.ok(out.includes('## Commits'), 'the heading title survives -- a title is content, never auto-cut');
  assert.ok(out.includes('| A |'), 'the genuinely-emptied table ALSO survives now -- flagged, not cut');
  assert.ok(out.includes('## Keep'));
  assert.ok(out.includes('survives'));
  const tableFlags = flagEmptyTables(out);
  assert.strictEqual(tableFlags.length, 1, 'the emptied table is surfaced via flagEmptyTables');
  const headingFlags = flagEmptyHeadings(out);
  assert.ok(headingFlags.some((f) => f.title === 'Commits'), 'the emptied heading is surfaced via flagEmptyHeadings');
});

// ---------------------------------------------------------------------------
// 0d SHIP CONDITION (beta.13 item 1) — table-CANDIDATE-RECOGNITION
// regressions (forEachTableCandidate, shared logic). Repointed to
// flagEmptyTables 2026-07-24: stripEmptyTables no longer calls
// forEachTableCandidate at all, so exercising these shapes through it would
// prove nothing; flagEmptyTables is now the only consumer of this logic.
// ---------------------------------------------------------------------------

test('0d ship condition: a table row with BLANK-LOOKING cells (structurally present, content-empty) still counts as "has data" -- never flagged as empty', () => {
  const text = 'before\n\n| Col1 | Col2 |\n| --- | --- |\n|  |  |\n\nafter\n';
  assert.deepStrictEqual(flagEmptyTables(text), [], 'a present-but-blank-celled row is conservatively treated as real data — row COUNT, never cell content, decides');
  assert.strictEqual(stripEmptyTables(text, text), text, 'and stripEmptyTables preserves it regardless, like everything else');
});

test('0d ship condition: a table separated from its header by a blank line (NOT immediately adjacent) is never treated as a candidate -- adjacency is required', () => {
  const text = '| Col1 | Col2 |\n\n| --- | --- |\n';
  assert.deepStrictEqual(flagEmptyTables(text), [], 'a non-adjacent separator can never pair with a header — no accidental match');
  assert.strictEqual(stripEmptyTables(text, text), text);
});

// ---------------------------------------------------------------------------
// BREAK 2 — table-candidate recognition must never mistake a loose
// pipe+`---` pair (a setext heading / thematic break / prose) for a real GFM
// table. Repointed to flagEmptyTables 2026-07-24 (see the 0d note above);
// the "proven emptied -- still cut" half is retired to "preserved + flagged".
// ---------------------------------------------------------------------------

test('BREAK-2: a setext / prose line with a pipe over a NON-matching delimiter is never flagged as an empty table (was deleted as a phantom empty table)', () => {
  const setext = 'Tier | Effort matrix\n---\nThe two-knob routing model follows here.\n';
  assert.deepStrictEqual(flagEmptyTables(setext), [], 'a bare `---` has no pipe -> not a delimiter; the setext heading is not a table at all');
  assert.strictEqual(stripEmptyTables(setext, setext), setext);
  const mismatch = 'A | B | C\n| --- | --- |\nprose row here\n';
  assert.deepStrictEqual(flagEmptyTables(mismatch), [], '3-col header vs 2-col delimiter = not a table');
  assert.strictEqual(stripEmptyTables(mismatch, mismatch), mismatch);
  const schema = 'TIER | EFFORT | GRADE\n---\nfilled in below\n';
  assert.deepStrictEqual(flagEmptyTables(schema), []);
  assert.strictEqual(stripEmptyTables(schema, schema), schema);
});

test('BREAK-2 no-FP: a REAL empty GFM table proven emptied from origText is now preserved and flagged (not cut); a table WITH a body row is never flagged', () => {
  const orig = 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n';
  const text = 'intro\n\n| A | B |\n| --- | --- |\n\nafter\n';
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text, 'byte-identical, nothing cut');
  assert.strictEqual(flagEmptyTables(out).length, 1, 'and the empty table is surfaced instead');
  const withRow = '| A | B |\n| --- | --- |\n| x | y |\n';
  assert.strictEqual(stripEmptyTables(withRow, withRow), withRow, 'a genuine table with a body row is never touched');
  assert.deepStrictEqual(flagEmptyTables(withRow), [], 'and never flagged either');
});

// ---------------------------------------------------------------------------
// BREAK 4 — forEachTableCandidate's lazy-continuation walk must never let a
// genuine DATA row get re-examined as a candidate "header" and mistaken for
// a phantom empty table. Repointed to flagEmptyTables 2026-07-24 (see the 0d
// note above) -- historically this guarded stripEmptyTables's own cut, now
// it guards what gets reported.
// ---------------------------------------------------------------------------

test('REGRESSION (footer-row data loss): a real table\'s LAST data row is never mistaken for an empty table just because a dash-shaped row follows it', () => {
  const text = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| --- | --- |\n';
  assert.deepStrictEqual(flagEmptyTables(text), [], 'the real "3 | 4" data row (and the dash-row after it) are body rows of the SAME table, never a phantom empty one');
  assert.strictEqual(stripEmptyTables(text, text), text);
});

test('REGRESSION (footer-row data loss, blank-terminated variant): same shape but the file continues after the dash-footer', () => {
  const text = 'intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| --- | --- |\n\nafter\n';
  assert.deepStrictEqual(flagEmptyTables(text), [], 'nothing here is empty -- the whole block is one real table');
  assert.strictEqual(stripEmptyTables(text, text), text);
});

test('REGRESSION (non-idempotent double-pass): two single-row header-shaped tables glued with no blank line between them are recognized as ONE real table -- never flagged, and a second stripEmptyTables pass changes nothing', () => {
  const text = '| A | B |\n| --- | --- |\n| C | D |\n| --- | --- |\n';
  assert.deepStrictEqual(flagEmptyTables(text), [], 'per GFM this is ONE table (header + 2 body rows) -- nothing is actually empty');
  const once = stripEmptyTables(text, text);
  assert.strictEqual(once, text);
  assert.strictEqual(stripEmptyTables(once, once), once, 'a second pass is a no-op -- trivially idempotent now');
});

// ---------------------------------------------------------------------------
// IC-PIN wave 4 (blind re-IC over the shipped 0d/BREAK-1/BREAK-2/BREAK-4
// fixes): 3 defects, since further narrowed by wave-6 above.
// ---------------------------------------------------------------------------

test('IC-PIN wave-4 FIX 1 (superseded by wave-6): a UNIQUE heading emptied because its body byte-duplicated a block elsewhere (exact-dedup) is still never swept -- wave-6 now preserves EVERY emptied heading unconditionally, so the narrower dedup-only guard is subsumed', () => {
  const orig = '## Snapshot rule\nAlways snapshot before any delete.\n\n## Reminder for reviewers\nAlways snapshot before any delete.\n';
  const afterDedup = '## Snapshot rule\nAlways snapshot before any delete.\n\n## Reminder for reviewers\n';
  assert.strictEqual(sweepResidue(orig, afterDedup), afterDedup, 'the heading is left in place -- flagEmptyHeadings, not sweepResidue, owns any empty-bodied heading now');
  const trueResidueOrig = '## Commits\n- one\n- two\n\n## Keep\nx\n';
  const trueResidueNew = '## Commits\n\n## Keep\nx\n';
  assert.strictEqual(sweepResidue(trueResidueOrig, trueResidueNew), trueResidueNew, 'and this is unconditional -- even unambiguous true residue is preserved now, not just the dedup case');
});

test('IC-PIN wave-4 FIX 2 (indented-code guard): a header|delimiter shape inside a >=4-space or tab indented block is never flagged as a phantom empty table; a 2-space indent still is (by design, once genuinely empty) -- and stripEmptyTables preserves all of them regardless', () => {
  const indented = 'Example of the table layout we plan to use:\n\n    | Region | Owner |\n    | --- | --- |\n\nWe will fill it in next sprint.\n';
  assert.deepStrictEqual(flagEmptyTables(indented), [], 'a >=4-space indent is CommonMark literal code, not provably a table');
  assert.strictEqual(stripEmptyTables(indented, indented), indented);
  const tabIndented = 'plan:\n\n\t| Region | Owner |\n\t| --- | --- |\n\ndone\n';
  assert.deepStrictEqual(flagEmptyTables(tabIndented), [], 'a leading-tab indent is the same CommonMark code threshold');
  assert.strictEqual(stripEmptyTables(tabIndented, tabIndented), tabIndented);
  const origTwoSpace = 'x\n\n  | Left | Right |\n  | --- | --- |\n  | a | b |\n\ny\n';
  const twoSpace = 'x\n\n  | Left | Right |\n  | --- | --- |\n\ny\n';
  const outTS = stripEmptyTables(origTwoSpace, twoSpace);
  assert.strictEqual(outTS, twoSpace, 'a 2-space indent is NOT the code threshold -- but nothing cuts it even once genuinely empty');
  assert.strictEqual(flagEmptyTables(outTS).length, 1, 'it IS flagged though -- a real empty table at a non-code indent');
});

// ---------------------------------------------------------------------------
// IC-PIN wave 5 FIX 2 (blind re-IC over wave 4): the indented-code guard must
// check BOTH header and delimiter indent. (wave 5 FIX 1, EOL-normalization
// across a cut, is retired along with the cut itself -- folded into the
// byte-exact round-trip test in section (2) above.) Repointed to
// flagEmptyTables 2026-07-24 (see the 0d note above).
// ---------------------------------------------------------------------------

test('IC-PIN wave 5 FIX 2: a header at column 0 paired with a >=4-space-indented delimiter is never flagged', () => {
  const doc = '| Server | Owner |\n    | --- | --- |\n\nreal tail content.\n';
  assert.deepStrictEqual(flagEmptyTables(doc), []);
  assert.strictEqual(stripEmptyTables(doc, doc), doc);
});

test('IC-PIN wave 5 FIX 2: a header + tab-indented delimiter is never flagged', () => {
  const doc = '| Server | Owner |\n\t| --- | --- |\n\nreal tail content.\n';
  assert.deepStrictEqual(flagEmptyTables(doc), []);
  assert.strictEqual(stripEmptyTables(doc, doc), doc);
});

test('IC-PIN wave 5 FIX 2: an indent MISMATCH between header and delimiter, both individually under the 4-space/tab code threshold, is never flagged', () => {
  const doc = '| A | B |\n  | --- | --- |\n\ntail.\n';
  assert.deepStrictEqual(flagEmptyTables(doc), []);
  assert.strictEqual(stripEmptyTables(doc, doc), doc);
});

// ---------------------------------------------------------------------------
// IC-PIN wave 7 (blind re-IC over wave 6's stripEmptyTables provenance fix):
// the residue key was itself lossy (`headerCells.join(' ')`), collapsing two
// structurally different headers onto the same string, AND computed on the
// MUTATED newText header then looked up in the pre-mutation origText
// inventory -- so a header a prior mechanical op in the same pass had
// already edited (canonically: stripping a dead [[link]] out of a header
// cell) could drift onto an unrelated live table's key and get deleted as
// that table's "residue". Fix (at the time): anchor the match to the
// table's IDENTITY (its verbatim header LINE) + a same-document uniqueness
// gate on newText itself. The tests below still hold post-retirement
// (2026-07-24) -- every "never cut" assertion is now unconditionally true --
// kept as shape-safety regressions; the one assertion that used to prove a
// real cut still happened is flipped below. A SIXTH wave (lazy-continuation-
// consumption, the final straw) closes the section.
// ---------------------------------------------------------------------------

test('IC-PIN wave-7 (the reported bug, live repro): a dead-link strip that mutates a template box\'s header onto a live table\'s header no longer deletes the box -- both survive (now unconditionally, not just on identity-collision)', () => {
  const orig = '## Repo status (live)\n\n| Repo | Status |\n| --- | --- |\n| CoalMine | live |\n| CoalWash | rc |\n\n'
    + '## New-repo template (fill per launch — KEEP)\n\n| Repo | Status [[launch-checklist]] |\n| --- | --- |\n\n'
    + '[[launch-checklist]] is the canonical 8-mark list.\n';
  const afterDeadLink = orig.replace('| Repo | Status [[launch-checklist]] |', '| Repo | Status |');
  const out = stripEmptyTables(orig, afterDeadLink);
  assert.strictEqual(out, afterDeadLink, 'byte-identical -- stripEmptyTables never inspects identity/ambiguity anymore, no cut at all');
  assert.ok(out.includes('CoalMine') && out.includes('CoalWash'), 'the live status table keeps its rows');
  assert.ok(out.includes('New-repo template'), 'the template box heading survives');
  assert.strictEqual((out.match(/\| Repo \| Status \|/g) || []).length, 2, 'both the live header and the (now-mutated) box header remain -- box not deleted');
  const flags = flagEmptyTables(out);
  assert.strictEqual(flags.length, 1, 'the surviving header-only box is surfaced for human review');
});

test('IC-PIN wave-7: a DIFFERENT-column-count join-collision (`| a b | c |` rows-table vs `| a | b c |` header-only) is never touched -- both survive byte-identical regardless of any lossy join key', () => {
  const orig = '| a b | c |\n| --- | --- |\n| 1 | 2 |\n';
  const text = '| a | b c |\n| --- | --- |\n';
  assert.strictEqual(stripEmptyTables(orig, text), text);
});

test('IC-PIN wave-7: a 3-col live table and a 2-col box mutated by a dead-link strip onto the SAME lossy join key ("Model Tier Note") both survive -- neither is ever touched', () => {
  const orig = '## Model routing\n\n| Model | Tier | Note |\n| --- | --- | --- |\n| opus | top | deep reasoning |\n| haiku | low | cheap bulk |\n\n'
    + '## Legacy reference (KEEP THIS BOX — load-bearing)\n\n| Model | Tier Note [[legacy-spec]] |\n| --- | --- |\n\n'
    + 'Migration is tracked in [[legacy-spec]] until the next major.\n';
  const afterDeadLink = orig.replace('| Model | Tier Note [[legacy-spec]] |', '| Model | Tier Note |');
  const out = stripEmptyTables(orig, afterDeadLink);
  assert.strictEqual(out, afterDeadLink);
  assert.ok(out.includes('Model | Tier Note'), 'the box header survives');
  assert.ok(out.includes('deep reasoning'), 'the real routing table is untouched');
});

test('IC-PIN wave-7: unambiguous in origText (one match, had rows) but AMBIGUOUS in newText (two same-keyed candidates) is preserved -- as is everything else now', () => {
  const orig = '| X | Y |\n| --- | --- |\n| 1 | 2 |\n';
  const text = '| X | Y |\n| --- | --- |\n\n| X | Y |\n| --- | --- |\n'; // the table emptied, PLUS a second same-header candidate now present
  assert.strictEqual(stripEmptyTables(orig, text), text);
});

test('IC-PIN wave-7: a genuinely emptied-this-run table with a UNIQUE, unmutated header is now preserved and flagged too -- the retirement covers even the cleanest, most unambiguous residue case', () => {
  const orig = 'before\n\n| Uniquely Named Col |\n| --- |\n| a value |\n\nafter\n';
  const text = 'before\n\n| Uniquely Named Col |\n| --- |\n\nafter\n';
  const out = stripEmptyTables(orig, text);
  assert.strictEqual(out, text);
  assert.ok(out.includes('Uniquely Named Col'));
  assert.ok(out.includes('before') && out.includes('after'));
  assert.strictEqual(flagEmptyTables(out).length, 1, 'even the cleanest unambiguous case is flag-only now, never cut');
});

// ---------------------------------------------------------------------------
// IC-PIN wave 8 (lazy-continuation-consumption, the 6th and final blind-IC
// leak -- the one that tipped the USER decision to retire the whole
// mechanism 2026-07-24 rather than patch a 7th time). A dead-link strip
// (schema collision, same shape as wave-7) COMBINED with a blank-collapsing
// dedup (an earlier duplicate paragraph -- and its surrounding blank line --
// removed by the broom's OTHER, still-live exact-dedup cut) can glue a
// header-only box directly onto a live table with no blank line between
// them. forEachTableCandidate's lazy-continuation rule then swallows the
// box's own header+delimiter into the LIVE table's body-row count -- the box
// never gets its own candidate callback, so it is invisible to
// flagEmptyTables too (a PRE-EXISTING, unrelated sharp edge of the shared
// recognition walk, not something this retirement introduces or is asked to
// fix). What matters: PRESERVATION holds regardless -- stripEmptyTables
// inspects none of this, so the box's bytes survive perfectly intact even in
// this worst-case detection failure.
// ---------------------------------------------------------------------------

test('IC-PIN wave-8 (lazy-continuation-collision): a dead-link strip + a blank-collapsing dedup glue a header-only box directly onto a live table with a now-matching header -- the box (and the live table) survive BYTE-IDENTICAL because stripEmptyTables inspects none of it, even though the gluing hides the box from flagEmptyTables too', () => {
  const orig = '## Live routing (KEEP)\n\n'
    + '| Model | Note [[legacy-ref]] |\n| --- | --- |\n| opus | deep reasoning |\n\n'
    + '## Legacy box (KEEP THIS BOX)\n'
    + '| Model | Note |\n| --- | --- |\n';
  // dead-link strip makes the two headers identical, AND the blank line that
  // used to separate the two blocks collapses away entirely (a duplicate
  // paragraph that used to occupy it was exact-deduped, taking its
  // surrounding blank with it) -- table1 and the box are now directly glued.
  const mutated = '## Live routing (KEEP)\n\n'
    + '| Model | Note |\n| --- | --- |\n| opus | deep reasoning |\n'
    + '## Legacy box (KEEP THIS BOX)\n'
    + '| Model | Note |\n| --- | --- |\n';
  const out = stripEmptyTables(orig, mutated);
  assert.strictEqual(out, mutated, 'byte-identical -- stripEmptyTables never inspects any of this, so a collision/gluing shape that used to feed the old provenance mechanism can no longer touch anything');
  assert.ok(out.includes('Legacy box (KEEP THIS BOX)'), 'the box heading survives');
  assert.ok(out.includes('opus') && out.includes('deep reasoning'), 'the live table survives verbatim');
  // known, pre-existing, out-of-scope limitation of the shared recognition
  // walk: the gluing swallows the box into the live table's body-row count,
  // so it is NOT independently flagged here either -- neither cut NOR
  // flagged, but never lost. Pinned so a future forEachTableCandidate change
  // that silently starts flagging (or, worse, starts cutting) this shape is
  // caught either way.
  assert.deepStrictEqual(flagEmptyTables(out), [], 'the box is swallowed into the live table\'s body-row count -- a pre-existing recognition gap, unrelated to this retirement, but preservation never depends on it');
});
