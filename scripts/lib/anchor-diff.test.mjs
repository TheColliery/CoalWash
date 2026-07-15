// Hermetic tests for anchor-diff.mjs — the class-#54 (generational-compounding)
// cumulative-loss detector. Sandbox fixtures only (never the live repo).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPlan } from './apply.mjs';
import { computeCandidates, anchorDiff, anchorDiffLine } from './anchor-diff.mjs';

function sandbox() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwad-proj-')));
  const store = path.join(proj, 'memory');
  fs.mkdirSync(store, { recursive: true });
  return { proj, store };
}
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
function write(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, 'utf8'); }
function planFor(proj, store, actions, extra = {}) {
  return { projectRoot: proj, roots: [store], actions, sessionId: 't-session', ...extra };
}

const ORIGINAL = '[[Foo]] anchor link.\nVersion v1.2.3 shipped.\nCount 44192 requests.\n';

// ---------------------------------------------------------------------------
// computeCandidates — the pure function, no filesystem
// ---------------------------------------------------------------------------

test('computeCandidates: a token gone from both current and approved is a candidate; a token in either is not', () => {
  const anchorText = '[[Foo]] link, v1.2.3, and 44192 requests.';
  const currentText = '[[Foo]] link only.'; // v1.2.3 and 44192 both gone from the live text
  const approvedTexts = ['the v1.2.3 line, cut on purpose']; // covers the version, not the number
  const { candidates, counts } = computeCandidates({ anchorText, currentText, approvedTexts });
  assert.deepStrictEqual(candidates, [{ type: 'numbers', value: '44192' }]);
  assert.strictEqual(counts.numbers.candidates, 1);
  assert.strictEqual(counts.versions.candidates, 0);
  assert.strictEqual(counts.wikilinks.candidates, 0);
});

test('computeCandidates: identical anchor and current -> zero candidates in every class', () => {
  const { candidates } = computeCandidates({ anchorText: ORIGINAL, currentText: ORIGINAL, approvedTexts: [] });
  assert.deepStrictEqual(candidates, []);
});

// ---------------------------------------------------------------------------
// anchorDiff — the filesystem-driven report
// ---------------------------------------------------------------------------

test('clean lineage: 0 candidates when the live file still carries every anchor token', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'notes.md');
    write(f, ORIGINAL);
    // Content-preserving rewrite (adds a line, drops nothing) — snapshots the
    // pristine ORIGINAL as f0, no approvedDrops needed (nothing dropped).
    const r1 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: ORIGINAL + 'Extra note.\n' }]), { now: 1000 });
    assert.strictEqual(r1.ok, true, r1.error);

    const report = anchorDiff(f, { projectRoot: proj });
    assert.ok(report, 'a verified snapshot exists for this file');
    assert.deepStrictEqual(report.candidates, []);
    assert.strictEqual(anchorDiffLine(report), '', 'a clean report renders as the empty string');
  } finally { clean(proj); }
});

test('planted cumulative loss: a token dropped OUT-OF-BAND (never through applyPlan) is flagged', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'notes.md');
    write(f, ORIGINAL);
    const r1 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: ORIGINAL + 'Extra note.\n' }]), { now: 1000 });
    assert.strictEqual(r1.ok, true, r1.error);

    // Simulate a hand-edit / ad hoc LLM pass that bypasses CoalWash entirely —
    // no plan, no gate, no bin record. Drops the wikilink line.
    write(f, 'Version v1.2.3 shipped.\nCount 44192 requests.\nExtra note.\n');

    const report = anchorDiff(f, { projectRoot: proj });
    assert.ok(report);
    assert.deepStrictEqual(report.candidates, [{ type: 'wikilinks', value: 'Foo' }]);
    assert.match(anchorDiffLine(report), /1 structured-token candidate/);
    assert.match(anchorDiffLine(report), /never assume lost/);
  } finally { clean(proj); }
});

test('approved-drop excluded: a token CW itself cut (and recorded to a bin) is not flagged; an out-of-band drop still is', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'notes.md');
    write(f, ORIGINAL);
    const r1 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: ORIGINAL + 'Extra note.\n' }]), { now: 1000 });
    assert.strictEqual(r1.ok, true, r1.error);

    // A SECOND, legitimate CoalWash-driven cut: removes the version line,
    // approved via approvedDrops (exactly as a real Quick/wizard cut would) —
    // this records the removed line into the fat bin.
    const afterCut = '[[Foo]] anchor link.\nCount 44192 requests.\nExtra note.\n';
    const r2 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: afterCut }], { approvedDrops: ['version-drop:v1.2.3'] }), { now: 2000 });
    assert.strictEqual(r2.ok, true, r2.error);

    // THEN an out-of-band edit (never through applyPlan) also drops the number line.
    write(f, '[[Foo]] anchor link.\nExtra note.\n');

    const report = anchorDiff(f, { projectRoot: proj });
    assert.ok(report);
    assert.strictEqual(report.approvedCount >= 1, true, 'the fat-bin record from the CW-driven cut was picked up');
    // The version is covered by the recorded bin drop -> NOT a candidate.
    assert.strictEqual(report.candidates.some((c) => c.type === 'versions' && c.value === 'v1.2.3'), false);
    // The number was dropped OUTSIDE CW's pipeline -> IS a candidate.
    assert.strictEqual(report.candidates.some((c) => c.type === 'numbers' && c.value === '44192'), true);
  } finally { clean(proj); }
});

test('no-snapshot no-op: null when the file has no verified snapshot yet, and when the path escapes the project root', () => {
  const { proj, store } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwad-out-')));
  try {
    const untouched = path.join(store, 'never-washed.md');
    write(untouched, ORIGINAL);
    assert.strictEqual(anchorDiff(untouched, { projectRoot: proj }), null, 'no .claude/coalwash tx dir at all yet');

    // Now create a real snapshot for a DIFFERENT file, to prove the tx dir
    // existing is not itself enough — the report is per-file, keyed by manifest.
    const other = path.join(store, 'other.md');
    write(other, 'x');
    applyPlan(planFor(proj, store, [{ type: 'rewrite', path: other, content: 'xx' }]), { now: 1000 });
    assert.strictEqual(anchorDiff(untouched, { projectRoot: proj }), null, 'a tx dir exists, but never named THIS file');

    const strayFile = path.join(outside, 'stray.md');
    write(strayFile, ORIGINAL);
    assert.strictEqual(anchorDiff(strayFile, { projectRoot: proj }), null, 'a path outside projectRoot is fail-closed, not resolved');
  } finally { clean(proj, outside); }
});
