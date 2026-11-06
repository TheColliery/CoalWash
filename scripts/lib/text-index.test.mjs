// Hermetic tests for text-index.mjs — the shared prefix index behind exact
// substring counting. Pure functions, no filesystem.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildPrefixIndex, countNonOverlapping, hasNeedle, PREFIX_K } from './text-index.mjs';

// The reference: the indexOf loop the index must reproduce exactly.
function refCount(text, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  return n;
}

// Deterministic generator (no Math.random): a 32-bit LCG on Math.imul.
function lcg(seed) {
  let x = seed | 0;
  return () => { x = (Math.imul(x, 1103515245) + 12345) | 0; return (x >>> 8) / 16777216; };
}

test('PREFIX_K is 4: the prefix length the index keys on', () => {
  assert.strictEqual(PREFIX_K, 4);
});

test('buildPrefixIndex: each k-character prefix maps to its ascending start positions, overlaps included', () => {
  const index = buildPrefixIndex('aaaaa', 4);
  assert.deepStrictEqual(index.get('aaaa'), [0, 1]);
  assert.strictEqual(index.get('bbbb'), undefined);
});

test('countNonOverlapping: a long needle counts the same as the indexOf loop, overlaps skipped (aaa in aaaaa is 1)', () => {
  const index = buildPrefixIndex('aaaaa', 4);
  assert.strictEqual(countNonOverlapping(index, 'aaaaa', 'aaa'), 1);
  assert.strictEqual(refCount('aaaaa', 'aaa'), 1);
});

test('countNonOverlapping: a needle shorter than k falls back to the indexOf loop', () => {
  const text = 'ab ab ab x';
  const index = buildPrefixIndex(text, 4);
  assert.strictEqual(countNonOverlapping(index, text, 'ab'), refCount(text, 'ab'));
  assert.strictEqual(countNonOverlapping(index, text, 'ab'), 3);
});

test('countNonOverlapping: an empty needle counts 0 and never loops', () => {
  const text = 'abcd';
  assert.strictEqual(countNonOverlapping(buildPrefixIndex(text, 4), text, ''), 0);
});

test('hasNeedle: true exactly when the needle occurs, long or short, and an empty needle is found like String includes', () => {
  const text = 'the quick brown fox';
  const index = buildPrefixIndex(text, 4);
  assert.strictEqual(hasNeedle(index, text, 'brown'), true);
  assert.strictEqual(hasNeedle(index, text, 'browx'), false);
  assert.strictEqual(hasNeedle(index, text, 'fo'), true);
  assert.strictEqual(hasNeedle(index, text, ''), text.includes(''));
});

test('differential: countNonOverlapping equals the indexOf loop over random texts and needles, overlaps included', () => {
  const rnd = lcg(619);
  const alphabet = 'ab-_ c';
  for (let round = 0; round < 300; round++) {
    let text = '';
    const len = 1 + Math.floor(rnd() * 120);
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    const index = buildPrefixIndex(text, PREFIX_K);
    // needles cut from the text itself (so they occur, often overlapping) plus random ones
    for (let j = 0; j < 12; j++) {
      const a = Math.floor(rnd() * text.length);
      const size = 1 + Math.floor(rnd() * 7);
      const needle = rnd() < 0.7 ? text.slice(a, a + size) : Array.from({ length: size }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      assert.strictEqual(countNonOverlapping(index, text, needle), refCount(text, needle), `text=${JSON.stringify(text)} needle=${JSON.stringify(needle)}`);
      assert.strictEqual(hasNeedle(index, text, needle), text.includes(needle), `text=${JSON.stringify(text)} needle=${JSON.stringify(needle)}`);
    }
  }
});

test('counted: a needle whose prefix never occurs visits no positions, however long the text', () => {
  // the shared prefix sits in twenty places, so its bucket is under the hot-bucket gate and is walked
  const text = 'xxxx'.repeat(20) + 'z'.repeat(200000);
  const index = buildPrefixIndex(text, 4);
  const c = { visits: 0 };
  assert.strictEqual(countNonOverlapping(index, text, 'xxxy', c), 0);
  assert.strictEqual(c.visits, 0);
  const d = { visits: 0 };
  assert.strictEqual(countNonOverlapping(index, text, 'xxxxxy', d), 0);
  assert.ok(d.visits > 0, 'the shared prefix is walked, so the counter is wired');
});

test('counted: the walk is bounded by the positions of one prefix, not by the text length', () => {
  const filler = 'filler text '.repeat(20000);
  const text = filler + 'needle here' + filler;
  const index = buildPrefixIndex(text, 4);
  const c = { visits: 0 };
  assert.strictEqual(countNonOverlapping(index, text, 'needle here', c), 1);
  assert.ok(c.visits <= 2, `only the one 'need' position is examined, got ${c.visits}`);
});

test('counted: a bucket past the hot gate takes the indexOf loop, and the answers are the same', () => {
  const text = 'x'.repeat(200000);
  const index = buildPrefixIndex(text, 4);
  const c = { visits: 0 };
  assert.strictEqual(countNonOverlapping(index, text, 'xxxxy', c), 0);
  assert.strictEqual(hasNeedle(index, text, 'xxxxy', c), false);
  assert.strictEqual(countNonOverlapping(index, text, 'xxxx', c), 50000);
  assert.strictEqual(c.visits, 0, 'the bucket was not walked');
});
