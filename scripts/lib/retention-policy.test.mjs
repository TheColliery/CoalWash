// Hermetic tests for retention.mjs — the pure bin-destruction policy.
// Zero lab tokens by design (the USER's testing ruling): the REPLAY fixture
// encodes the 2026-07-10 campaign's own 6 real restore events, and property
// tests pin the four guarantees on synthetic timelines.
import { test } from 'node:test';
import assert from 'node:assert';
import { retentionPlan, TIER1_KEEP_ALL_MS, TIER2_LAST_PER_DAY_MS, HORIZON_MS, BIN_BUDGET_STORE_MULTIPLE } from './retention.mjs';

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

// ---------------------------------------------------------------------------
// 0i SIZE-CAP layer — journald SystemMaxUse beside MaxRetentionSec: BOTH
// limits on every bin, whichever binds first. Default budget (omitted) =
// Infinity = every test above runs the pre-0i behavior byte-identically.
// ---------------------------------------------------------------------------

test('0i size-cap: over-budget evicts OLDEST first until under; under-budget touches nothing', () => {
  const now = T0 + 10 * HOUR;
  // Four young (tier-1 keep-all) items, 100 bytes each — time layers keep ALL.
  const four = [0, 1, 2, 3].map((i) => ({ id: `i${i}`, at: T0 + i * HOUR, bytes: 100 }));
  const under = retentionPlan(four, now, { budgetBytes: 400 });
  assert.strictEqual(under.destroy.length, 0, 'at/under budget: the cap layer is silent');

  const over = retentionPlan(four, now, { budgetBytes: 250 });
  // 400 -> need <= 250: evict i0 (oldest, -100 => 300), then i1 (-100 => 200).
  assert.deepStrictEqual(over.destroy.map((s) => s.id).sort(), ['i0', 'i1'], 'oldest evicted first, exactly until under budget');
  assert.deepStrictEqual(over.keep.map((s) => s.id).sort(), ['i2', 'i3']);
  // This is the "before items even age" catch: all four were inside the 48h
  // keep-all tier — only size pressure could thin them.
});

test('0i size-cap: era-preserving phase — the last survivor of an old epoch-week is skipped while thinning multi-item weeks suffices', () => {
  const now = T0 + 20 * DAY;
  // One lone item in an old week (tier-3 survivor) + three items in the
  // current keep-all window. Budget forces eviction; the lone old-era item
  // must survive phase 1 because the young week has spare density.
  const oldEra = { id: 'old-era', at: now - 16 * DAY, bytes: 100 }; // sole survivor of its week
  const young = [0, 1, 2].map((i) => ({ id: `y${i}`, at: now - 2 * HOUR + i * (HOUR / 2), bytes: 100 }));
  const r = retentionPlan([oldEra, ...young], now, { budgetBytes: 250 });
  // 400 -> <= 250: phase 1 skips old-era (last of its week), evicts y0 then y1.
  assert.ok(r.keep.some((s) => s.id === 'old-era'), 'V1: old eras thin but stay recoverable — the era\'s last survivor outranks younger spare density');
  assert.deepStrictEqual(r.destroy.map((s) => s.id).sort(), ['y0', 'y1']);
});

test('0i size-cap: the cap is a hard promise — when era protection cannot reach the budget, phase 2 evicts oldest regardless; the newest item overall ALWAYS survives', () => {
  const now = T0 + 30 * DAY;
  // Three items, each the lone survivor of its own week — era protection
  // alone can free nothing.
  const a = { id: 'wk-old', at: now - 20 * DAY, bytes: 100 };
  const b = { id: 'wk-mid', at: now - 10 * DAY, bytes: 100 };
  const c = { id: 'wk-new', at: now - 1 * HOUR, bytes: 100 };
  const r = retentionPlan([a, b, c], now, { budgetBytes: 150 });
  // 300 -> <= 150: phase 1 frees nothing (all last-of-week), phase 2 evicts
  // wk-old then wk-mid; wk-new (newest overall) is untouchable even though
  // 100 < 150 leaves it the sole survivor.
  assert.deepStrictEqual(r.destroy.map((s) => s.id).sort(), ['wk-mid', 'wk-old'], 'journald hard cap: oldest whole eras go when thinning cannot bind');
  assert.deepStrictEqual(r.keep.map((s) => s.id), ['wk-new'], 'a bin never self-empties: the most recent cut survives any budget');

  // Even a budget SMALLER than the newest item cannot evict it.
  const tiny = retentionPlan([a, b, c], now, { budgetBytes: 10 });
  assert.ok(tiny.keep.some((s) => s.id === 'wk-new'), 'the newest overall is never size-evicted');
});

test('0i size-cap fail direction: weightless (no/zero bytes) and doubt (future at) items are NEVER size-evicted', () => {
  const now = T0 + 10 * HOUR;
  const legacy = { id: 'legacy', at: T0, bytes: undefined }; // pre-0i index entry, no weight
  const zero = { id: 'zero', at: T0 + HOUR, bytes: 0 };
  const future = { id: 'future', at: now + DAY, bytes: 500 }; // doubt -> kept by the time layer, ineligible for size eviction
  const heavy = { id: 'heavy', at: T0 + 2 * HOUR, bytes: 400 };
  const newest = { id: 'newest', at: T0 + 3 * HOUR, bytes: 400 };
  const r = retentionPlan([legacy, zero, future, heavy, newest], now, { budgetBytes: 100 });
  // Only `heavy` is evictable (newest is protected): total 800+500-doubt...
  // weight sums finite positives = 400+400+500(future counts weight but is
  // not evictable) — the layer evicts what it MAY until under or exhausted.
  for (const s of r.destroy) assert.strictEqual(s.id, 'heavy', `only the evictable weighted non-newest item may die (got ${s.id})`);
  assert.ok(r.keep.some((s) => s.id === 'legacy') && r.keep.some((s) => s.id === 'zero') && r.keep.some((s) => s.id === 'future'), 'doubt/weightless all survive');
});

test('0i: BIN_BUDGET_STORE_MULTIPLE is a positive, sane placeholder constant', () => {
  assert.ok(Number.isFinite(BIN_BUDGET_STORE_MULTIPLE) && BIN_BUDGET_STORE_MULTIPLE > 0);
});
