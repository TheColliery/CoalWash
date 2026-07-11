import { test } from 'node:test';
import assert from 'node:assert';
import { sweepResidue, stripEmptyTables, flagEmptyHeadings } from './quick.mjs';

// ---------------------------------------------------------------------------
// (1) sweepResidue — scoped to OUR OWN knife's residue (orig-vs-new), the r1
// #11 / r3 "## Commits" lab finding.
// ---------------------------------------------------------------------------

test('sweepResidue: a heading emptied BY THIS EDIT (had content in orig, none in new) is removed, plus one trailing blank line', () => {
  const orig = '## Intro\ntext\n\n## Commits\n- commit one\n- commit two\n\n## Outro\nbye\n';
  const newText = '## Intro\ntext\n\n## Commits\n\n## Outro\nbye\n';
  const out = sweepResidue(orig, newText);
  assert.ok(!out.includes('## Commits'), out);
  assert.ok(out.includes('## Intro'));
  assert.ok(out.includes('## Outro'));
});

test('sweepResidue: a heading that was ALREADY empty before this edit is NEVER touched (zero-FP by scope — flagEmptyHeadings\' job, not this one)', () => {
  const orig = '## Placeholder\n\n## Real Section\ncontent\n';
  const newText = '## Placeholder\n\n## Real Section\ncontent trimmed\n';
  const out = sweepResidue(orig, newText);
  assert.ok(out.includes('## Placeholder'), 'a pre-existing empty heading is left alone — never assumed to be residue');
});

test('sweepResidue: a heading present in newText but NOT in orig (brand new) is never touched even if empty', () => {
  const orig = '## Intro\ntext\n';
  const newText = '## Intro\ntext\n\n## New Section\n';
  const out = sweepResidue(orig, newText);
  assert.ok(out.includes('## New Section'), 'a heading with no orig counterpart is out of residue scope by construction');
});

test('sweepResidue: a heading whose body SURVIVES (non-empty in new) is untouched', () => {
  const orig = '## Notes\nsomething long\n';
  const newText = '## Notes\nsomething short\n';
  assert.strictEqual(sweepResidue(orig, newText), newText);
});

test('sweepResidue: nested headings — an emptied sub-heading is removed without disturbing its still-content-bearing parent', () => {
  const orig = '# Top\nintro\n\n## Sub\ndetail\n\n## Sub2\nmore\n';
  const newText = '# Top\nintro\n\n## Sub\n\n## Sub2\nmore\n';
  const out = sweepResidue(orig, newText);
  assert.ok(!out.includes('## Sub\n'));
  assert.ok(out.includes('# Top'));
  assert.ok(out.includes('## Sub2'));
  assert.ok(out.includes('more'));
});

test('sweepResidue: no headings at all is a harmless no-op; identical text round-trips', () => {
  assert.strictEqual(sweepResidue('plain prose, no headings\n', 'plain prose, no headings\n'), 'plain prose, no headings\n');
  assert.strictEqual(sweepResidue('', ''), '');
});

// ---------------------------------------------------------------------------
// (2) stripEmptyTables — UNCONDITIONAL (no orig needed): "nothing survives
// because nothing exists".
// ---------------------------------------------------------------------------

test('stripEmptyTables: a header+separator with ZERO data rows is removed whole', () => {
  const text = 'before\n\n| Col1 | Col2 |\n| --- | --- |\n\nafter\n';
  const out = stripEmptyTables(text);
  assert.ok(!out.includes('Col1'), out);
  assert.ok(!out.includes('---'), out);
  assert.ok(out.includes('before'));
  assert.ok(out.includes('after'));
});

test('stripEmptyTables: a table WITH data rows is left completely untouched', () => {
  const text = '| Col1 | Col2 |\n| --- | --- |\n| a | b |\n';
  assert.strictEqual(stripEmptyTables(text), text);
});

test('stripEmptyTables: multiple empty tables in one file are all removed; a non-empty one among them survives', () => {
  const text = [
    '| A | B |', '| --- | --- |', '',
    '| C | D |', '| --- | --- |', '| x | y |', '',
    '| E | F |', '| --- | --- |',
  ].join('\n');
  const out = stripEmptyTables(text);
  assert.ok(!out.includes('| A | B |'));
  assert.ok(out.includes('| C | D |'), 'the non-empty table survives');
  assert.ok(out.includes('| x | y |'));
  assert.ok(!out.includes('| E | F |'));
});

test('stripEmptyTables: text with no tables at all round-trips unchanged', () => {
  const text = 'just some prose\nwith multiple lines\nand a | pipe | in it that is not a table\n';
  assert.strictEqual(stripEmptyTables(text), text);
});

test('stripEmptyTables: an empty table at end-of-file (no trailing content) is still removed', () => {
  const text = 'intro\n\n| H |\n| --- |';
  const out = stripEmptyTables(text);
  assert.ok(!out.includes('| H |'));
  assert.ok(out.includes('intro'));
});

// ---------------------------------------------------------------------------
// (3) flagEmptyHeadings — GENERAL case, single-snapshot, FLAG ONLY (never
// mutates) — the named non-graduate.
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
// Pipeline: sweepResidue then stripEmptyTables, matching the intended agent
// usage ("finish the sweep in the SAME run").
// ---------------------------------------------------------------------------

test('pipeline: sweepResidue -> stripEmptyTables handles a mixed cut (heading residue AND an emptied table) in one pass', () => {
  const orig = '## Commits\n- one\n- two\n\n## Table\n| A |\n| --- |\n| x |\n\n## Keep\nsurvives\n';
  const afterAgentCut = '## Commits\n\n## Table\n| A |\n| --- |\n\n## Keep\nsurvives\n'; // the agent removed the list AND the one data row
  const out = stripEmptyTables(sweepResidue(orig, afterAgentCut));
  assert.ok(!out.includes('## Commits'));
  assert.ok(!out.includes('| A |'));
  assert.ok(out.includes('## Keep'));
  assert.ok(out.includes('survives'));
});

// ---------------------------------------------------------------------------
// 0d SHIP CONDITION (beta.13 item 1, MEMORY.md "KILL-RATE": "before shipping
// 0d, add a regression: auto-Quick over a trap-laced corpus proving 0 trap
// touched"). Quick is now auto-run WITHOUT an ask (queue 0d) — a NEW surface;
// the lab campaign ran Quick agent-supervised, never unattended. sweepResidue
// and stripEmptyTables are the ONLY two Quick ops that auto-CUT (not merely
// flag) without a human/outsider in the loop, so THEY are what this
// regression targets: near-miss shapes engineered to LOOK like residue/
// empty-table candidates but are load-bearing content, proving the
// structural scope holds even under adversarial-shaped input (never a full
// semantic trap-suite — that needs an LLM agent, out of a hermetic
// node:test's reach; this is the CODE-layer equivalent: 0 trap touched by
// the two mechanically-auto-cutting rules).
// ---------------------------------------------------------------------------

test('0d ship condition: a heading with SHORT-but-real surviving content ("still here", a one-word near-miss) is never swept as residue', () => {
  const orig = '## Notes\nsomething long and detailed\n\n## Keep\nother\n';
  const newText = '## Notes\nstill here\n\n## Keep\nother\n'; // heavily trimmed, but NOT empty
  assert.strictEqual(sweepResidue(orig, newText), newText, 'a trimmed-but-nonempty body is never mistaken for residue');
});

test('0d ship condition: duplicate headings (same title+level) — the ambiguous orig-pairing degrades SAFELY: never over-sweeps a still-meaningful heading', () => {
  // FIRST "## Dup" is a pre-existing empty placeholder; SECOND had real
  // content and was JUST emptied by this edit. orig.heads.findIndex always
  // resolves to the FIRST match (an inherent ambiguity for same-title/level
  // duplicates) -- verified behavior: this MISSES the second's genuine
  // residue-sweep opportunity (recall = best-effort) rather than risking a
  // wrong match (precision = 1.0 mandatory, the broom asymmetry).
  const orig = '## Dup\n\n## Dup\nreal content\n';
  const newText = '## Dup\n\n## Dup\n\n';
  const out = sweepResidue(orig, newText);
  assert.strictEqual(out, newText, 'the ambiguous pairing under-sweeps (safe), never over-sweeps');
  assert.strictEqual((out.match(/## Dup/g) || []).length, 2, 'both duplicate headings survive — neither is wrongly destroyed');
});

test('0d ship condition: a heading whose LEVEL changed (same title, different #-depth) never cross-matches its old self, even when now empty', () => {
  const orig = '## Notes\nreal content\n';
  const newText = '### Notes\n\n'; // same title text, promoted to a sub-heading, now empty
  assert.strictEqual(sweepResidue(orig, newText), newText, 'a level change is treated as a BRAND-NEW heading, never matched to the old one');
});

test('0d ship condition: a table row with BLANK-LOOKING cells (structurally present, content-empty) still counts as "has data" — the table is never stripped', () => {
  const text = 'before\n\n| Col1 | Col2 |\n| --- | --- |\n|  |  |\n\nafter\n';
  assert.strictEqual(stripEmptyTables(text), text, 'a present-but-blank-celled row is conservatively treated as real data — row COUNT, never cell content, decides');
});

test('0d ship condition: a table separated from its header by a blank line (NOT immediately adjacent) is never treated as a candidate — adjacency is required', () => {
  const text = '| Col1 | Col2 |\n\n| --- | --- |\n';
  assert.strictEqual(stripEmptyTables(text), text, 'a non-adjacent separator can never pair with a header — no accidental match');
});

test('0d ship condition: a heading title containing markdown emphasis/formatting round-trips through sweepResidue unmodified when its body survives', () => {
  const orig = '## **Bold** Section\ndetail here\n';
  const newText = '## **Bold** Section\nshorter\n';
  assert.strictEqual(sweepResidue(orig, newText), newText, 'formatting in a title is opaque to the matcher — exact-string match, no markdown-aware parsing needed for safety');
});
