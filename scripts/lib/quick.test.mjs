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
