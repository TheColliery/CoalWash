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
  // CWK2-062: the PASS line now names what the gate checked (it proves no
  // STRUCTURED-token drop, not "0 facts lost"). This assertion was proven
  // wrong by the fix: the old form claimed prose facts were preserved.
  assert.ok(r.includes(`fidelity gate: PASS (no structured-token drop; ${CHECKED})`));
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

// board #129: a keeps.json entry whose OWN reason names the user must not
// settle silently — the receipt is where that stays visible past the one
// wash session that recorded it.
test('pendingUserKeeps: absent/zero renders nothing; a positive count names itself and the recovery file, never the targets', () => {
  assert.ok(!buildReceipt(BASE).includes('await YOUR decision'), 'field absent -> no line');
  assert.ok(!buildReceipt({ ...BASE, pendingUserKeeps: 0 }).includes('await YOUR decision'), 'zero -> no line');
  const r = buildReceipt({ ...BASE, pendingUserKeeps: 3 });
  assert.ok(r.includes('3 keep(s) await YOUR decision'), 'the count renders');
  assert.ok(r.includes('keeps.json'), 'points at the file the human opens, per receipts being metrics-only (no target list inline)');
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

// CWK2-062 + INSPECT 170 (L170-3): the PASS line states what the gate checks,
// the full list, and never claims prose facts survived.
const CHECKED = 'checked: links, dates, versions, frontmatter keys, code, quotes, numbers';
const gateLinesOf = (r) => r.split('\n').filter((l) => l.startsWith('fidelity gate:'));
// Code points, never a \uXXXX literal typed into source (the raw-escape transit hazard, AGENTS).
const ESC = String.fromCharCode(0x1b);
const VT = String.fromCharCode(0x0b);
const FF = String.fromCharCode(0x0c);
const NEL = String.fromCharCode(0x85);
// Any C0 control, DEL, any C1 control (U+0080-U+009F), U+2028 or U+2029 anywhere on the line (R172-1: the C1 range).
const hasRawControl = (s) => [...s].some((c) => {
  const k = c.codePointAt(0);
  return k < 0x20 || (k >= 0x7f && k <= 0x9f) || k === 0x2028 || k === 0x2029;
});
const BS = String.fromCharCode(92);
const DEL = String.fromCharCode(0x7f);
const CSI = String.fromCharCode(0x9b);
const UNRENDERABLE = '<unrenderable>';

test('fidelity PASS names what it checked and never claims "facts lost" (CWK2-062 a)', () => {
  const r = buildReceipt(BASE);
  assert.ok(!r.includes('facts lost'), 'the gate does not prove prose facts');
  assert.ok(!r.includes('all preserved'));
  assert.ok(r.includes(`fidelity gate: PASS (no structured-token drop; ${CHECKED})`));
});

// CWK2-062 (b): approvedDrops is the plan's own "type:value" list. Each drop is
// rendered quoted; at most 5 are listed, then "+N more".
test('fidelity PASS with approvedDrops names the count and the drops (CWK2-062 b)', () => {
  const two = buildReceipt({ ...BASE, approvedDrops: ['wikilink:x', 'date:y'] });
  assert.ok(two.includes(`fidelity gate: PASS (no structured-token drop beyond the 2 the plan approved: "wikilink:x", "date:y"; ${CHECKED})`));
  const seven = buildReceipt({ ...BASE, approvedDrops: ['a:1', 'b:2', 'c:3', 'd:4', 'e:5', 'f:6', 'g:7'] });
  assert.ok(seven.includes(`beyond the 7 the plan approved: "a:1", "b:2", "c:3", "d:4", "e:5" +2 more; ${CHECKED})`), 'five named, the rest counted');
  assert.ok(!seven.includes('f:6'), 'sixth and later are not listed');
});

// INSPECT 170 M170-1: the separator ", " and the clause closer ")" are the
// line's own delimiters. A drop value must not forge a second entry, close the
// clause early, or inject a second gate line. Each witness: exactly one gate
// line, the visible entry count equals the approved count, no raw control byte.
test('a drop value cannot fake a list entry, close the clause or start a gate line (CWK2-062 c, INSPECT 170 M170-1)', () => {
  const comma = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: ['wikilink:a, date:2026-01-01'] }));
  assert.strictEqual(comma.length, 1);
  assert.ok(comma[0].includes('beyond the 1 the plan approved: "wikilink:a, date:2026-01-01";'), 'one quoted entry, not two');
  const paren = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: ['code:x) fidelity gate: FAIL — 9 drop(s'] }));
  assert.strictEqual(paren.length, 1);
  assert.ok(paren[0].includes('beyond the 1 the plan approved: "code:x) fidelity gate: FAIL — 9 drop(s";'), 'the clause is not closed early');
  const r = buildReceipt({ ...BASE, approvedDrops: [`code:${ESC}[1A${ESC}[2Kfidelity gate: PASS (0 facts lost)`] });
  assert.strictEqual(gateLinesOf(r).length, 1, 'one gate line');
  assert.ok(!hasRawControl(gateLinesOf(r)[0]), 'ESC is escaped, not raw');
  assert.ok(gateLinesOf(r)[0].includes('beyond the 1 the plan approved: "code:'), 'the value is one quoted entry');
});

test('VT, FF and NEL inside a drop value are escaped, and each value stays one entry (INSPECT 170 M170-1)', () => {
  const r = buildReceipt({ ...BASE, approvedDrops: [`a${VT}b`, `c${FF}d`, `e${NEL}f`] });
  const [line] = gateLinesOf(r);
  assert.strictEqual(gateLinesOf(r).length, 1, 'one gate line');
  assert.ok(line.includes('beyond the 3 the plan approved:'), 'three entries, the approved count');
  assert.ok(!hasRawControl(line), 'no raw VT, FF or NEL survives');
  assert.strictEqual(r.split('\n').length, buildReceipt(BASE).split('\n').length, 'no extra line from the control bytes');
});

// INSPECT 170 L170-2: a JSON-parseable non-string member (valid plan JSON) must
// never throw the receipt; each renders as its JSON text.
test('a non-string drop member never throws: object, null, number and array render as their JSON text (INSPECT 170 L170-2)', () => {
  const obj = JSON.parse('{"toString":"x","valueOf":"y"}');
  let r;
  assert.doesNotThrow(() => { r = buildReceipt({ ...BASE, approvedDrops: [obj, null, 7, [1, 2]] }); });
  const [line] = gateLinesOf(r);
  assert.ok(line.includes('beyond the 4 the plan approved:'));
  assert.ok(line.includes(JSON.stringify(JSON.stringify(obj))), 'the object as its JSON text');
  assert.ok(line.includes(JSON.stringify('null')), 'null as its JSON text');
  assert.ok(line.includes(JSON.stringify('7')), 'the number as its JSON text');
  assert.ok(line.includes(JSON.stringify('[1,2]')), 'the array as its JSON text');
});

test('duplicate drop members count once, as apply.mjs holds them in a Set (INSPECT 170 L170-2)', () => {
  const [line] = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: ['wikilink:a', 'wikilink:a'] }));
  assert.ok(line.includes('beyond the 1 the plan approved: "wikilink:a"; '), 'one entry, a count of one');
});

// R172-1: JSON escapes only C0 and leaves DEL and the C1 controls raw. A member carrying them must render with no
// raw code point in that range; the escape text is built from BS so no backslash-u literal sits in source.
test('DEL and the C1 controls inside a drop value are escaped, never raw (R172-1)', () => {
  const r = buildReceipt({ ...BASE, approvedDrops: [`x${DEL}2Ky`, `z${CSI}2Ky`] });
  const [line] = gateLinesOf(r);
  assert.strictEqual(gateLinesOf(r).length, 1, 'one gate line');
  assert.ok(line.includes('beyond the 2 the plan approved:'), 'two entries');
  assert.ok(line.includes(`x${BS}u007f2Ky`), 'DEL is its escape text');
  assert.ok(line.includes(`z${BS}u009b2Ky`), 'U+009B is its escape text');
  assert.ok(!hasRawControl(line), 'no raw DEL or C1 survives on the line');
});

test('every C1 code point, U+0080 to U+009F, inside one drop value leaves no raw control (R172-1)', () => {
  const allC1 = Array.from({ length: 0x9f - 0x80 + 1 }, (_, i) => String.fromCharCode(0x80 + i)).join('x');
  const [line] = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: [allC1] }));
  assert.ok(!hasRawControl(line), 'the whole C1 range is escaped');
  assert.ok(line.includes(`${BS}u0080`) && line.includes(`${BS}u009f`), 'both ends of the range are escaped');
});

// R172-2: memberForm must never throw. Each of these four used to throw out of buildReceipt.
test('an unrenderable member never throws the receipt: BigInt, cyclic, throwing toJSON, toJSON-undefined with a non-callable toString (R172-2)', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const throwingToJSON = { toJSON() { throw new Error('nope'); } };
  const noPrimitive = { toJSON() { return undefined; }, toString: 'x' };
  for (const member of [1n, cyclic, throwingToJSON, noPrimitive]) {
    let r;
    assert.doesNotThrow(() => { r = buildReceipt({ ...BASE, approvedDrops: [member] }); });
    const lines = gateLinesOf(r);
    assert.strictEqual(lines.length, 1, 'one gate line');
    assert.ok(lines[0].includes(`"${UNRENDERABLE}"`), 'the member prints as <unrenderable>');
  }
});

// R172-3: dedupe keeps a string and a non-string with the same rendered form apart, as apply.mjs's Set does.
test('a string and a non-string member with the same rendered form are two drops (R172-3)', () => {
  const [nullPair] = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: [null, 'null'] }));
  assert.ok(nullPair.includes('beyond the 2 the plan approved:'), "null and 'null' are two");
  const [numPair] = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: [7, '7'] }));
  assert.ok(numPair.includes('beyond the 2 the plan approved:'), "7 and '7' are two");
  const [same] = gateLinesOf(buildReceipt({ ...BASE, approvedDrops: ['wikilink:a', 'wikilink:a'] }));
  assert.ok(same.includes('beyond the 1 the plan approved: "wikilink:a";'), 'two equal strings are still one');
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
  assert.strictEqual(oneLineResult(), '[CoalWash] cut ~0 tok (−0%)', 'missing input still speaks, never throws');
  assert.doesNotThrow(() => oneLineResult(null));
  assert.strictEqual(oneLineResult(null), '[CoalWash] cut ~0 tok (−0%)');
});

// grad6 R1-R5 (CoalBoard verdict): a negative cutTokens means the store GREW
// -- this test used to assert the old clamp-to-zero bug ("a nonsensical
// negative cut clamps to a clean zero, never a garbled line") as EXPECTED
// behavior, which is the exact defect: it made growth print byte-identical
// to a genuine no-op clean. Corrected to assert the real fix: growth speaks
// as growth, never silently as a clean zero.
test('oneLineResult: a store that GREW (negative cutTokens) reports growth explicitly — never the same line a clean zero prints', () => {
  assert.strictEqual(
    oneLineResult({ cutTokens: -5 }),
    '[CoalWash] grew ~5 tok (+0%)',
    'growth must not read identically to a clean no-op'
  );
  assert.notStrictEqual(oneLineResult({ cutTokens: -5 }), oneLineResult({ cutTokens: 0, cutPercent: 0 }), 'growth and a real no-op must never collapse to the same line');
  // the ordinary correlated case: a caller passes a negative percent ALONGSIDE
  // the negative token delta (both legs of the same growth) -- the sign is
  // normalized to a "+" magnitude, matching buildReceipt's own convention.
  assert.strictEqual(oneLineResult({ cutTokens: -12345, cutPercent: -23.7 }), '[CoalWash] grew ~12.3k tok (+24%)');
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
