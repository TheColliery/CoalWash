// Hermetic tests for retention.mjs — the pure bin-destruction policy.
// Zero lab tokens by design (the USER's testing ruling): the REPLAY fixture
// encodes the 2026-07-10 campaign's own 6 real restore events, and property
// tests pin the four guarantees on synthetic timelines.
import { test } from 'node:test';
import assert from 'node:assert';
import { retentionPlan, TIER1_KEEP_ALL_MS, TIER2_LAST_PER_DAY_MS, HORIZON_MS } from './retention.mjs';

const HOUR = 3600000;
const DAY = 86400000;
const T0 = Date.UTC(2026, 6, 1); // fixed epoch anchor — deterministic slots

function items(ats) {
  return ats.map((at, i) => ({ id: `s${i}`, at }));
}

// --- the NAMED must-recover case -------------------------------------------

test('wash-on-wash (the rejected depth-1 proposal\'s fatal case): all tier-1 snapshots kept, the pre-wound restore point survives wash-3', () => {
  // wash-1 snapshots the pristine state at t1; wash-2 cuts something precious
  // (its pre-state snapshot lands at t2); wash-3 arrives BEFORE anyone notices
  // (t3). Under new-replaces-old depth-1 the only surviving snapshot would
  // already contain wash-2's wound — the t1 snapshot must still be alive.
  const t1 = T0, t2 = T0 + 5 * HOUR, t3 = T0 + 9 * HOUR;
  const snaps = items([t1, t2, t3]);
  const { keep, destroy } = retentionPlan(snaps, t3 + HOUR);
  assert.strictEqual(destroy.length, 0, 'inside the 48h keep-all tier NOTHING is destroyed');
  assert.ok(keep.some((s) => s.at === t1), 'the pre-wound (pre-wash-2) restore point survives');
  assert.strictEqual(keep.length, 3, 'full undo depth inside tier 1');
});

// --- the REPLAY fixture: the campaign's own 6 restore events ---------------

test('replay fixture: 6 real restore events (depths 1-4, all inside tier-1) — the policy passes its own history', () => {
  // The 2026-07-10 lab campaign, encoded: snapshots born hourly (pristine +
  // rounds r1..r7), then the recorded restores — r3 restored 3 items from the
  // r2 snapshot (depth 1, x3) · r4's M17 reached 4 generations back (depth 4)
  // · the retirement sweep restored at depths 2 and 3. Every event must find
  // its snapshot alive at the moment it fired.
  const births = Array.from({ length: 8 }, (_, i) => T0 + i * HOUR); // idx 0 = pristine, idx k = round k
  const events = [
    { at: T0 + 3 * HOUR + 1, depth: 1 }, // r3 restore #1 (from the r2 snapshot)
    { at: T0 + 3 * HOUR + 2, depth: 1 }, // r3 restore #2
    { at: T0 + 3 * HOUR + 3, depth: 1 }, // r3 restore #3
    { at: T0 + 4 * HOUR + 1, depth: 4 }, // r4: M17's 4-generation reach
    { at: T0 + 7 * HOUR + 1, depth: 2 }, // retirement sweep
    { at: T0 + 7 * HOUR + 2, depth: 3 }, // retirement sweep
  ];
  for (const ev of events) {
    const existing = items(births.filter((b) => b <= ev.at));
    const { keep } = retentionPlan(existing, ev.at);
    const byNewest = [...existing].sort((a, b) => b.at - a.at);
    const wanted = byNewest[ev.depth - 1]; // depth d = the d-th most recent snapshot
    assert.ok(wanted, `fixture self-check: a depth-${ev.depth} snapshot exists`);
    assert.ok(keep.includes(wanted), `the depth-${ev.depth} snapshot is alive at its restore moment`);
  }
});

// --- the four guarantees on synthetic timelines -----------------------------

test('no item outlives its horizon (fat 30d and store.old 60d both enforced)', () => {
  // Deterministic pseudo-random timeline (seeded LCG — no Math.random).
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const now = T0 + 90 * DAY;
  const ats = Array.from({ length: 500 }, () => now - Math.floor(rnd() * 80 * DAY));
  for (const [bin, horizonMs] of Object.entries(HORIZON_MS)) {
    const { keep, destroy } = retentionPlan(items(ats), now, { horizonMs });
    assert.strictEqual(keep.length + destroy.length, ats.length, `${bin}: partition is total`);
    for (const s of keep) assert.ok(now - s.at <= horizonMs, `${bin}: kept item within horizon`);
    for (const s of ats.filter((at) => now - at > horizonMs)) {
      assert.ok(destroy.some((d) => d.at === s), `${bin}: over-horizon item destroyed`);
    }
  }
  // The horizons genuinely differ per bin: a 45-day-old item dies in the fat
  // bin (30d = 1 burst gap) and survives thinned in store.old (60d = 2 gaps).
  const old45 = items([now - 45 * DAY]);
  assert.strictEqual(retentionPlan(old45, now, { horizonMs: HORIZON_MS.fat }).destroy.length, 1);
  assert.strictEqual(retentionPlan(old45, now, { horizonMs: HORIZON_MS['store.old'] }).keep.length, 1);
});

test('>= 1 restore point per day survives across the 14-day recall band', () => {
  // One snapshot every day for 20 days; now = the last birth. Every epoch-day
  // slot inside (48h, 14d] that had an item must still have one after thinning.
  const now = T0 + 20 * DAY;
  const ats = Array.from({ length: 20 }, (_, i) => now - i * DAY - 3 * HOUR);
  const { keep } = retentionPlan(items(ats), now);
  for (const at of ats) {
    const age = now - at;
    if (age <= TIER1_KEEP_ALL_MS || age > TIER2_LAST_PER_DAY_MS) continue;
    const slot = Math.floor(at / DAY);
    assert.ok(keep.some((s) => Math.floor(s.at / DAY) === slot), `day slot ${slot} retains a restore point`);
  }
});

test('overflow-bounded: a chatty producer (48/day for 60 days) thins to tier-1 + ~14 dailies + ~9 weeklies, never accumulates', () => {
  const now = T0 + 60 * DAY;
  const ats = [];
  for (let d = 0; d < 60; d++) for (let k = 0; k < 48; k++) ats.push(now - d * DAY - k * (DAY / 48));
  const { keep, destroy } = retentionPlan(items(ats), now, { horizonMs: HORIZON_MS['store.old'] });
  const tier1 = ats.filter((at) => now - at <= TIER1_KEEP_ALL_MS).length;
  // Bound: keep-all tier + one per day-slot across 14d + one per week-slot to
  // the horizon (+2 slack for boundary-straddling slots). 2880 items in, ~120 out.
  assert.ok(keep.length <= tier1 + 15 + 10 + 2, `bounded: kept ${keep.length} of ${ats.length} (tier1=${tier1})`);
  assert.strictEqual(keep.length + destroy.length, ats.length);
  // Chatty rounds self-accelerate destruction: most of the flood dies.
  assert.ok(destroy.length > ats.length * 0.9, 'the flood thins');
});

test('idle producer: a lone monthly snapshot is never thinned before its horizon', () => {
  const now = T0 + 29 * DAY;
  const lone = items([T0]);
  const r = retentionPlan(lone, now, { horizonMs: HORIZON_MS.fat });
  assert.strictEqual(r.keep.length, 1, 'nothing to thin against — the lone restore point lives to the horizon');
});

// --- density axis + fail direction ------------------------------------------

test('intra-slot new-replaces-old: within one day slot only the newest survives; a same-timestamp tie keeps the later-listed (newer write)', () => {
  const now = T0 + 10 * DAY;
  const slotBase = now - 5 * DAY; // squarely in tier 2
  const a = { id: 'older', at: slotBase };
  const b = { id: 'newer', at: slotBase + 2 * HOUR };
  const r1 = retentionPlan([a, b], now);
  assert.deepStrictEqual(r1.keep.map((s) => s.id), ['newer']);
  assert.deepStrictEqual(r1.destroy.map((s) => s.id), ['older']);
  const t1 = { id: 'first-write', at: slotBase };
  const t2 = { id: 'second-write', at: slotBase };
  const r2 = retentionPlan([t1, t2], now);
  assert.deepStrictEqual(r2.keep.map((s) => s.id), ['second-write'], 'tie -> the later-listed (append order = newer) wins');
});

test('tier 3 thins per WEEK slot; tier boundaries use age, slots use fixed epoch buckets', () => {
  const now = T0 + 25 * DAY;
  // Two items 2 days apart, both aged ~3 weeks (tier 3), same epoch week.
  const w = Math.floor((now - 20 * DAY) / (7 * DAY));
  const inWeek = [now - 20 * DAY, now - 18 * DAY].filter((at) => Math.floor(at / (7 * DAY)) === w);
  if (inWeek.length === 2) {
    const r = retentionPlan(items(inWeek), now);
    assert.strictEqual(r.keep.length, 1, 'one survivor per week slot');
    assert.strictEqual(r.keep[0].at, inWeek[1], 'the newer one');
  } else {
    // The two straddle an epoch-week boundary: both survive (one per slot) —
    // still bounded, still deterministic.
    const r = retentionPlan(items([now - 20 * DAY, now - 18 * DAY]), now);
    assert.strictEqual(r.keep.length, 2);
  }
});

test('doubt keeps, never destroys: corrupt and future timestamps are kept (broom asymmetry)', () => {
  const now = T0;
  const weird = [{ id: 'nan', at: NaN }, { id: 'none' }, { id: 'future', at: now + DAY }];
  const r = retentionPlan(weird, now);
  assert.strictEqual(r.destroy.length, 0);
  assert.strictEqual(r.keep.length, 3);
  // and a non-array input degrades to an empty partition, never a throw
  assert.deepStrictEqual(retentionPlan(null, now), { keep: [], destroy: [] });
});
