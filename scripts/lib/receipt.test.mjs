import { test } from 'node:test';
import assert from 'node:assert';
import { buildReceipt, oneLineResult } from './receipt.mjs';

const BASE = {
  when: '2026-07-09',
  beforeBytes: 226 * 1024,
  afterBytes: 150 * 1024,
  alwaysBeforeTokens: 10300,
  alwaysAfterTokens: 7000,
  oneTimeCostTokens: 12000,
  breakEvenSessions: 3.7,
  removed: 3,
  trimmed: 5,
  kept: 42,
  flaggedKept: 2,
  gatePass: true,
};

test('receipt is terse plain text: deterministic KB, ~est-labelled tokens, no box-art', () => {
  const r = buildReceipt(BASE);
  assert.ok(r.includes('226.0 KB -> 150.0 KB'));
  assert.ok(r.includes('(~est)'), 'token numbers must be labelled ~est');
  assert.ok(r.includes('saves ~3.3k tok/session'));
  assert.ok(r.includes('break-even: ~4 session(s)'));
  assert.ok(r.includes('removed 3 · trimmed 5 · kept 42 · flagged-kept 2'));
  assert.ok(r.includes('fidelity gate: PASS (0 facts lost'));
  assert.ok(!/[┌│└═╔]/.test(r), 'no box-drawing decoration');
  assert.ok(r.split('\n').length <= 7, 'stays a dense numbers block');
});

test('a failing gate is loud and names the block', () => {
  const r = buildReceipt({ ...BASE, gatePass: false, gateDrops: 2 });
  assert.ok(r.includes('fidelity gate: FAIL — 2 drop(s)'));
  assert.ok(r.includes('BLOCKED'));
});

test('wikilink-orphan advisory rides the receipt as ONE optional line — absent by default', () => {
  assert.ok(!buildReceipt(BASE).includes('advisory'), 'no advisory field -> no advisory line');
  const line = 'advisory: 1 deleted topic(s) still referenced by surviving files (possible dead [[link]]s): gone.md — a deliberate delete is fine; recovery door: cli.mjs restore <id>';
  const r = buildReceipt({ ...BASE, deadLinkLine: line });
  assert.ok(r.includes(line), 'the applyPlan-built line lands verbatim');
});

test('dry-run is labelled and zero-saving/edge inputs stay well-formed', () => {
  const r = buildReceipt({
    when: '2026-07-09', dryRun: true,
    beforeBytes: 0, afterBytes: 0,
    alwaysBeforeTokens: 0, alwaysAfterTokens: 0,
    removed: 0, trimmed: 0, kept: 0, gatePass: true,
  });
  assert.ok(r.includes('(dry-run — nothing touched)'));
  assert.ok(r.includes('saves ~0 tok/session'));
  assert.ok(!r.includes('NaN'));
  assert.ok(!r.includes('Infinity'));
});

test('break-even n/a when not finite; one-time line absent when cost not given', () => {
  const r1 = buildReceipt({ ...BASE, breakEvenSessions: Infinity });
  assert.ok(r1.includes('break-even: n/a'));
  const r2 = buildReceipt({ ...BASE, oneTimeCostTokens: undefined, breakEvenSessions: undefined });
  assert.ok(!r2.includes('one-time cost'));
});

test('a receipt built with missing gate fields degrades to "unknown" — never a false FAIL without data', () => {
  const r1 = buildReceipt({ ...BASE, gatePass: undefined, gateDrops: undefined });
  assert.ok(r1.includes('fidelity gate: unknown (fields not provided)'));
  assert.ok(!r1.includes('FAIL'));
  const r2 = buildReceipt({ ...BASE, gatePass: null });
  assert.ok(r2.includes('fidelity gate: unknown (fields not provided)'));
  // explicit true/false are unaffected by the degrade
  assert.ok(buildReceipt({ ...BASE, gatePass: true }).includes('fidelity gate: PASS'));
  assert.ok(buildReceipt({ ...BASE, gatePass: false, gateDrops: 1 }).includes('fidelity gate: FAIL'));
});

// ---------------------------------------------------------------------------
// oneLineResult (beta.12 item 2 — the ONE-SENTENCE ambient surface: a big
// clean, a small clean, and the autonomous broom all speak the SAME template,
// only the numbers differ; cutting nothing is SILENCE).
// ---------------------------------------------------------------------------

test('oneLineResult: cuts fat, one line, exactly TWO numbers, no box-art/receipt narration', () => {
  const r = oneLineResult({ cutTokens: 12345, cutPercent: 23.7 });
  assert.strictEqual(r, '[CoalWash] cut ~12.3k tok (−24%)');
  assert.strictEqual(r.split('\n').length, 1, 'exactly one line');
});

// RE-BASED 2026-07-25 by USER order (กฎเหล็ก: EVERY run prints the receipt).
// This test used to pin the OPPOSITE — "cutting nothing is SILENCE (null)".
// The reversal is the point: with the OBESE sweep re-firing on every new fat
// inflow, a silent zero-cut run is indistinguishable from a run that never
// happened, so the zero line IS the proof of life.
test('oneLineResult: EVERY run speaks — a zero cut prints the same one-line receipt, never null (no silent runs)', () => {
  assert.strictEqual(oneLineResult({ cutTokens: 0, cutPercent: 0 }), '[CoalWash] cut ~0 tok (−0%)');
  assert.strictEqual(oneLineResult({ cutTokens: -5 }), '[CoalWash] cut ~0 tok (−0%)', 'a nonsensical negative cut clamps to a clean zero, never a garbled line');
  assert.strictEqual(oneLineResult(), '[CoalWash] cut ~0 tok (−0%)', 'missing input still speaks, never throws');
  assert.doesNotThrow(() => oneLineResult(null));
  assert.strictEqual(oneLineResult(null), '[CoalWash] cut ~0 tok (−0%)');
});

test('oneLineResult: one template for every path — Auto-Quick, Force-Quick and the Full Pass differ ONLY in the numbers', () => {
  const shape = /^\[CoalWash\] cut ~\S+ tok \(−\d+%\)$/;
  for (const [label, o] of [
    ['auto-quick, nothing found', { cutTokens: 0, cutPercent: 0 }],
    ['auto-quick, small cut', { cutTokens: 400, cutPercent: 5 }],
    ['force-quick', { cutTokens: 8000, cutPercent: 12 }],
    ['full pass', { cutTokens: 120000, cutPercent: 41 }],
  ]) assert.match(oneLineResult(o), shape, label);
});

test('oneLineResult: a small cut under 1000 tok renders as a bare number (ktok\'s own convention), never "0.1k"', () => {
  assert.strictEqual(oneLineResult({ cutTokens: 400, cutPercent: 5 }), '[CoalWash] cut ~400 tok (−5%)');
});

test('oneLineResult: malformed percent degrades to a safe zero, never NaN/Infinity/a negative percent', () => {
  const r = oneLineResult({ cutTokens: 1000, cutPercent: NaN });
  assert.ok(!r.includes('NaN'));
  assert.ok(!r.includes('Infinity'));
  assert.strictEqual(r, '[CoalWash] cut ~1.0k tok (−0%)');
  assert.strictEqual(oneLineResult({ cutTokens: 1000, cutPercent: -30 }), '[CoalWash] cut ~1.0k tok (−0%)', 'a negative percent clamps — never renders "(−-30%)"');
  assert.strictEqual(oneLineResult({ cutTokens: 1000, cutPercent: Infinity }), '[CoalWash] cut ~1.0k tok (−0%)');
});
