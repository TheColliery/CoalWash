import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tokensEst, tokensEstFromBytes, gzipRatio, measureEntries, statOnlyFootprintBytes,
  bandVerdict, breakEven, sessionsPerDay, gaugeVerdict,
  statePath, loadState, projectState, recordStamp, setLeanFloor, ensureProvisionalFloor,
  sanitizeLeanFloor, LEAN_FLOOR_MAX_MULTIPLE,
  recordVerdict, markQuickTried, recordSubSpawn,
  BAND_RANK, recordCrossing, sanitizeCrossing, consumeCrossing,
  CEILING_BMI, CEILING_REARM_BMI, FLOOR_MIN_TOKENS, CAPACITY_TOKENS, CC_INDEX_CAP_BYTES, CC_INDEX_CAP_LINES,
  RUN_COST_MULTIPLIER, ECON_HORIZON_DAYS, STAMP_RING_MAX, REGAUGE_DELTA_TOKENS, ALWAYS_LOADED_PATHS_CAP,
} from './caliper.mjs';
import { discoverClassB } from './class-b.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: sandbox home only

// Thai fixture built from char codes (never raw invisibles/composables in source):
// "ทำงาน" = 0E17 0E33 0E07 0E32 0E19 — 5 non-ASCII chars.
const THAI_WORD = String.fromCharCode(0x0e17, 0x0e33, 0x0e07, 0x0e32, 0x0e19);

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('tokensEst: ~4 chars/token ASCII, ~1.5 chars/token non-ASCII, mixed adds up', () => {
  assert.strictEqual(tokensEst('a'.repeat(4000)), 1000);
  assert.strictEqual(tokensEst(THAI_WORD.repeat(300)), 1000); // 1500 non-ASCII chars / 1.5
  assert.strictEqual(tokensEst('a'.repeat(400) + THAI_WORD.repeat(30)), 100 + 100);
  assert.strictEqual(tokensEst(''), 0);
});

test('tokensEstFromBytes is the ASCII heuristic on raw size', () => {
  assert.strictEqual(tokensEstFromBytes(400), 100);
  assert.strictEqual(tokensEstFromBytes(0), 0);
});

test('gzipRatio: repetitive text compresses far below unique text; empty -> 1', () => {
  const repetitive = 'same line over and over\n'.repeat(200);
  let unique = '';
  for (let i = 0; i < 200; i++) unique += `line ${i} ${(i * 2654435761 % 997).toString(36)} ${Math.sin(i)}\n`;
  assert.ok(gzipRatio(repetitive) < gzipRatio(unique));
  assert.ok(gzipRatio(repetitive) < 0.2);
  assert.strictEqual(gzipRatio(''), 1);
});

test('measureEntries: always-loaded content-read (non-ASCII aware), recall stat-based, index captured', () => {
  const { home, proj } = sandbox();
  try {
    const idx = path.join(home, 'MEMORY.md');
    const gov = path.join(home, 'CLAUDE.md');
    const rec = path.join(home, 'lesson.md');
    fs.writeFileSync(idx, 'line one\nline two\nline three', 'utf8'); // 3 lines
    fs.writeFileSync(gov, THAI_WORD.repeat(300), 'utf8'); // 1000 tok by content, MORE by byte-heuristic
    fs.writeFileSync(rec, 'a'.repeat(4000), 'utf8');
    const entries = [
      { path: idx, bytes: fs.statSync(idx).size, scope: 'project', kind: 'memory-index', alwaysLoaded: true },
      { path: gov, bytes: fs.statSync(gov).size, scope: 'project', kind: 'governance', alwaysLoaded: true },
      { path: rec, bytes: fs.statSync(rec).size, scope: 'project', kind: 'memory', alwaysLoaded: false },
    ];
    const m = measureEntries(entries, { withGzip: true });
    assert.strictEqual(m.files, 3);
    assert.strictEqual(m.alwaysLoaded.files, 2);
    assert.strictEqual(m.index.lines, 3);
    assert.strictEqual(m.index.bytes, fs.statSync(idx).size);
    // Thai content measured by CONTENT (1000), not the byte heuristic (4500/4≈1125)
    const idxTok = tokensEst('line one\nline two\nline three');
    assert.strictEqual(m.alwaysLoaded.tokensEst, 1000 + idxTok);
    assert.strictEqual(m.totalTokensEst, 1000 + idxTok + 1000, 'recall file uses bytes/4');
    assert.ok(m.gzipRatio > 0 && m.gzipRatio <= 1);
    assert.strictEqual(m.est, true, 'token numbers are estimates');
  } finally { clean(home, proj); }
});

test('measureEntries respects the read budget (over-budget always-loaded falls back to bytes)', () => {
  const { home, proj } = sandbox();
  try {
    const big = path.join(home, 'big.md');
    fs.writeFileSync(big, THAI_WORD.repeat(300), 'utf8'); // content 1000 tok, bytes/4 heuristic differs
    const entries = [{ path: big, bytes: fs.statSync(big).size, scope: 'project', kind: 'governance', alwaysLoaded: true }];
    const m = measureEntries(entries, { readBudgetBytes: 10 });
    assert.strictEqual(m.alwaysLoaded.tokensEst, tokensEstFromBytes(fs.statSync(big).size));
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// bandVerdict — beta.12 BAND COLLAPSE: ONE ceiling (CEILING_BMI/CEILING_REARM_BMI,
// hysteresis-gated) replaces the old PLUMP/OBESE ladder + FAT_BUDGET_TOKENS
// growable-full mechanism. BMI is now FRACTAL/universal — the ceiling itself
// grows with the floor by construction (a ratio), so no separate additive
// fat-budget layer is needed.
// ---------------------------------------------------------------------------

test('bandVerdict: below the ceiling (un-armed) is LEAN; at/above CEILING_BMI (un-armed) arms OBESE', () => {
  const floor = 10000; // well above FLOOR_MIN_TOKENS
  const at = (fp, wasOver = false) => bandVerdict({ footprintTokens: fp, leanFloorTokens: floor, wasOver });
  assert.strictEqual(at(Math.round(floor * (CEILING_BMI - 0.05))).band, 'LEAN');
  const armed = at(Math.round(floor * CEILING_BMI));
  assert.strictEqual(armed.band, 'OBESE');
  assert.strictEqual(armed.reason, 'bmi');
  assert.strictEqual(armed.over, true);
});

test('bandVerdict: hysteresis — once armed, BMI must fall to CEILING_REARM_BMI (not just under CEILING_BMI) to disarm', () => {
  const floor = 10000;
  const midZone = Math.round(floor * ((CEILING_BMI + CEILING_REARM_BMI) / 2)); // squarely inside the dead zone
  const stillArmed = bandVerdict({ footprintTokens: midZone, leanFloorTokens: floor, wasOver: true });
  assert.strictEqual(stillArmed.band, 'OBESE', 'a previously-armed ceiling stays armed inside the dead zone');
  const neverArmed = bandVerdict({ footprintTokens: midZone, leanFloorTokens: floor, wasOver: false });
  assert.strictEqual(neverArmed.band, 'LEAN', 'the SAME bmi never arms fresh from an un-armed state (needs the high mark)');

  const atRearm = bandVerdict({ footprintTokens: Math.round(floor * CEILING_REARM_BMI), leanFloorTokens: floor, wasOver: true });
  assert.strictEqual(atRearm.band, 'LEAN', 'exactly at the low mark disarms (bmi <= CEILING_REARM_BMI clears it)');
  const justAboveRearm = bandVerdict({ footprintTokens: Math.round(floor * CEILING_REARM_BMI) + 1, leanFloorTokens: floor, wasOver: true });
  assert.strictEqual(justAboveRearm.band, 'OBESE', 'one token above the low mark stays armed');
});

test('bandVerdict: a floor too small to trust (< FLOOR_MIN_TOKENS) never measures a ratio — reason floor-too-small', () => {
  const v = bandVerdict({ footprintTokens: 5000, leanFloorTokens: FLOOR_MIN_TOKENS - 1 });
  assert.strictEqual(v.band, 'LEAN');
  assert.strictEqual(v.reason, 'floor-too-small');
  assert.strictEqual(v.bmi, null);
  // exactly at the minimum IS trusted
  const trusted = bandVerdict({ footprintTokens: Math.round(FLOOR_MIN_TOKENS * CEILING_BMI), leanFloorTokens: FLOOR_MIN_TOKENS });
  assert.strictEqual(trusted.band, 'OBESE');
});

test('bandVerdict bootstrap: no floor yet -> LEAN (only the absolute cap can fire)', () => {
  const v = bandVerdict({ footprintTokens: 5000, leanFloorTokens: 0 });
  assert.strictEqual(v.band, 'LEAN');
  assert.strictEqual(v.reason, 'no-floor-yet');
  assert.strictEqual(v.bmi, null);
});

test('bandVerdict absolute-cap arms FULL regardless of floor: hard ceiling, index bytes, index lines', () => {
  // hard ceiling: fullPercent(6) x the recalibrated CAPACITY_TOKENS
  const ceiling = Math.round(CAPACITY_TOKENS * 6 / 100);
  const hard = bandVerdict({ footprintTokens: ceiling, leanFloorTokens: 0, fullPercent: 6 });
  assert.strictEqual(hard.band, 'FULL');
  assert.strictEqual(hard.reason, 'absolute-cap');
  const bytes = bandVerdict({ footprintTokens: 10, leanFloorTokens: 10, indexBytes: CC_INDEX_CAP_BYTES });
  assert.strictEqual(bytes.band, 'FULL');
  const lines = bandVerdict({ footprintTokens: 10, leanFloorTokens: 10, indexLines: CC_INDEX_CAP_LINES });
  assert.strictEqual(lines.band, 'FULL');
});

test('a raised fullPercent raises the hard ceiling (buying a bigger SSD)', () => {
  const ceiling = Math.round(CAPACITY_TOKENS * 6 / 100);
  const before = bandVerdict({ footprintTokens: ceiling, leanFloorTokens: 0, fullPercent: 6 });
  const after = bandVerdict({ footprintTokens: ceiling, leanFloorTokens: 0, fullPercent: 12 });
  assert.strictEqual(before.band, 'FULL');
  assert.strictEqual(after.band, 'LEAN');
});

// ---------------------------------------------------------------------------
// Growable-full (beta.7 #1, RE-DERIVED under the fractal-BMI ceiling — the
// USER's three-layer invariant still holds: BMI = ratio, so it grows WITH a
// legitimately large floor by construction; no separate fat-budget layer is
// needed any more). Pins the exact live dogfood cases.
// ---------------------------------------------------------------------------

test('growable-full (a): TheColliery post-clean (floor 29054, footprint ~29098) verdicts LEAN, not FULL/OBESE', () => {
  const v = bandVerdict({ footprintTokens: 29098, leanFloorTokens: 29054 });
  assert.strictEqual(v.band, 'LEAN');
});

test('growable-full (b): a bootstrap store (no floor, ~44k) still verdicts FULL via the absolute cap (unchanged pre-floor heuristic)', () => {
  const v = bandVerdict({ footprintTokens: 44000, leanFloorTokens: 0 });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'absolute-cap');
});

test('growable-full (c): post-floor, all-muscle, over the hard cap -> the externalize variant (never "wash harder" on muscle)', () => {
  const ceiling = Math.round(CAPACITY_TOKENS * 6 / 100);
  const v = bandVerdict({ footprintTokens: ceiling + 200, leanFloorTokens: ceiling });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'externalize');
  assert.strictEqual(v.over, false, 'externalize means the ceiling itself is NOT armed — ~all muscle');
});

test('growable-full: a large legitimate floor still ARMS the ceiling once BMI itself reaches it, at realistic scale (never a flat token budget)', () => {
  // A floor well under the hard capacity ceiling, so this pins the BMI path
  // in isolation (a floor near 29054 would ALSO trip the absolute-cap at
  // 1.5x, conflating the two triggers).
  const floor = 10000;
  const v = bandVerdict({ footprintTokens: Math.round(floor * CEILING_BMI) + 1, leanFloorTokens: floor });
  assert.strictEqual(v.band, 'OBESE');
  assert.strictEqual(v.reason, 'bmi');
});

test('breakEven: deterministic numbers; economical iff horizon carry exceeds the run cost', () => {
  const e = breakEven({ footprintTokens: 2000, leanFloorTokens: 1000, totalStoreTokens: 3000, sessionsPerDay: 2 });
  assert.strictEqual(e.fatTokens, 1000);
  assert.strictEqual(e.perDay, 2000);
  assert.strictEqual(e.runCostTokens, 3000 * RUN_COST_MULTIPLIER);
  assert.strictEqual(e.horizonCarryTokens, 2000 * ECON_HORIZON_DAYS);
  assert.strictEqual(e.breakEvenDays, (3000 * RUN_COST_MULTIPLIER) / 2000);
  assert.strictEqual(e.economical, 2000 * ECON_HORIZON_DAYS > 3000 * RUN_COST_MULTIPLIER);
  assert.strictEqual(e.economical, true);
});

test('breakEven with zero fat: never economical, break-even infinite', () => {
  const e = breakEven({ footprintTokens: 1000, leanFloorTokens: 1000, totalStoreTokens: 1000, sessionsPerDay: 5 });
  assert.strictEqual(e.fatTokens, 0);
  assert.strictEqual(e.breakEvenDays, Infinity);
  assert.strictEqual(e.economical, false);
});

test('sessionsPerDay: bootstrap 1/day under 2 stamps; measured rate; clamped [0.1, 20]', () => {
  const now = Date.now();
  const day = 86400000;
  assert.strictEqual(sessionsPerDay([], now), 1);
  assert.strictEqual(sessionsPerDay([{ t: now }], now), 1);
  const tenOverFive = Array.from({ length: 10 }, (_, i) => ({ t: now - 5 * day + i * ((5 * day) / 10) }));
  assert.strictEqual(sessionsPerDay(tenOverFive, now), 2);
  const burst = Array.from({ length: 50 }, () => ({ t: now }));
  assert.strictEqual(sessionsPerDay(burst, now), 20, 'clamped high');
  const sparse = [{ t: now - 400 * day }, { t: now }];
  assert.ok(sessionsPerDay(sparse, now) >= 0.1, 'clamped low');
});

test('state: recordStamp persists and ring-caps; floor round-trips; corrupt file self-heals', () => {
  const { home, proj } = sandbox();
  try {
    for (let i = 0; i < STAMP_RING_MAX + 5; i++) recordStamp(home, proj, 100 + i, 1000 + i);
    const st = loadState(home);
    const ps = projectState(st, proj);
    assert.strictEqual(ps.stamps.length, STAMP_RING_MAX, 'ring-capped');
    assert.strictEqual(ps.stamps[ps.stamps.length - 1].fp, 100 + STAMP_RING_MAX + 4);

    assert.strictEqual(setLeanFloor(home, proj, 777), true);
    const ps2 = projectState(loadState(home), proj);
    assert.strictEqual(ps2.leanFloorTokens, 777);
    assert.strictEqual(ps2.stamps.length, STAMP_RING_MAX, 'the floor write keeps the stamps');

    fs.writeFileSync(statePath(home), '{ corrupt', 'utf8');
    assert.deepStrictEqual(loadState(home), {}, 'corrupt state self-heals to empty');
    const after = recordStamp(home, proj, 42, 999);
    assert.strictEqual(after.stamps.length, 1, 'recording resumes cleanly after corruption');
  } finally { clean(home, proj); }
});

test('state isolation: two projects under one home do not mix', () => {
  const { home, proj } = sandbox();
  const proj2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-proj2-')));
  try {
    recordStamp(home, proj, 100, 1);
    recordStamp(home, proj2, 200, 2);
    const st = loadState(home);
    assert.strictEqual(projectState(st, proj).stamps[0].fp, 100);
    assert.strictEqual(projectState(st, proj2).stamps[0].fp, 200);
  } finally { clean(home, proj, proj2); }
});

// ---------------------------------------------------------------------------
// sanitizeLeanFloor (floor-sanity at read — the #1 poison-point guard)
// ---------------------------------------------------------------------------

test('sanitizeLeanFloor: non-finite/zero/negative/non-numeric is discarded to 0 (floor-unmeasured)', () => {
  assert.strictEqual(sanitizeLeanFloor(NaN, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(Infinity, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(-Infinity, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(0, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(-500, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor('garbage', 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(undefined, 1000), 0);
  assert.strictEqual(sanitizeLeanFloor(null, 1000), 0);
});

test('sanitizeLeanFloor: a plausible floor relative to the current footprint is trusted as-is', () => {
  assert.strictEqual(sanitizeLeanFloor(1000, 1500), 1000, 'ordinary post-clean floor below a grown footprint');
  assert.strictEqual(sanitizeLeanFloor(2000, 1000), 2000, 'footprint dipping below the floor is not BY ITSELF implausible');
  assert.strictEqual(sanitizeLeanFloor('1500', 1000), 1500, 'a numeric string coerces cleanly');
});

test('sanitizeLeanFloor: a floor GROSSLY exceeding the footprint is discarded — poisoned/stale, never trusted', () => {
  assert.strictEqual(sanitizeLeanFloor(1_000_000, 1000), 0);
  // exactly at the multiple is still plausible; one token past it is not
  assert.strictEqual(sanitizeLeanFloor(1000 * LEAN_FLOOR_MAX_MULTIPLE, 1000), 1000 * LEAN_FLOOR_MAX_MULTIPLE);
  assert.strictEqual(sanitizeLeanFloor(1000 * LEAN_FLOOR_MAX_MULTIPLE + 1, 1000), 0);
});

test('sanitizeLeanFloor: without a usable footprint to compare against, basic sanity alone governs', () => {
  assert.strictEqual(sanitizeLeanFloor(500, 0), 500, 'footprint 0 (nothing measured) cannot itself invalidate a floor');
  assert.strictEqual(sanitizeLeanFloor(500, NaN), 500);
  assert.strictEqual(sanitizeLeanFloor(500, undefined), 500);
});

// ---------------------------------------------------------------------------
// state orphan prune (#21)
// ---------------------------------------------------------------------------

test('orphan prune: a project whose path no longer exists is dropped on the next state write; the live project is untouched', () => {
  const { home, proj } = sandbox();
  const deadProj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-')));
  try {
    recordStamp(home, deadProj, 50);
    recordStamp(home, proj, 100);
    assert.ok(projectState(loadState(home), deadProj).stamps, 'dead project tracked before its folder is removed');

    fs.rmSync(deadProj, { recursive: true, force: true }); // the project folder is now gone
    recordStamp(home, proj, 101); // ANY project's next state write triggers the lazy prune

    const st = loadState(home);
    assert.deepStrictEqual(projectState(st, deadProj), {}, 'the dead entry is pruned');
    assert.strictEqual(projectState(st, proj).stamps.length, 2, 'the live project entry is untouched');
  } finally { clean(home, proj); }
});

test('orphan prune: fires from setLeanFloor too (every write path, not just recordStamp)', () => {
  const { home, proj } = sandbox();
  const dead1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-lf-')));
  try {
    recordStamp(home, dead1, 50);
    fs.rmSync(dead1, { recursive: true, force: true });
    setLeanFloor(home, proj, 500);
    assert.deepStrictEqual(projectState(loadState(home), dead1), {}, 'setLeanFloor prunes too');
  } finally { clean(home, proj); }
});

test('orphan prune: a still-existing project is NEVER pruned, and nothing on disk is touched beyond the stat', () => {
  const { home, proj } = sandbox();
  const liveProj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-live-')));
  const sentinel = path.join(liveProj, 'still-here.txt');
  try {
    fs.writeFileSync(sentinel, 'untouched');
    recordStamp(home, liveProj, 50);
    recordStamp(home, proj, 100); // a second write, the prune runs again
    assert.ok(projectState(loadState(home), liveProj).stamps, 'a still-existing project survives the prune');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'untouched', 'the prune never touches project disk contents');
  } finally { clean(home, proj, liveProj); }
});

// ---------------------------------------------------------------------------
// cached verdict (beta.8 #2 — the Stop-hook cache; beta.12 adds overCeiling +
// the payback fields). 0m note: the old `sanitizeVerdict` FULL+economical
// force gate is GONE with the forceMode knob — force at FULL is
// unconditional, keyed on the sanitized CROSSING + the cached reason; the
// conductor tests pin that dispatch end-to-end.
// ---------------------------------------------------------------------------

test('recordVerdict: round-trips through state (incl. overCeiling + payback + hardCeilingTokens fields) and overwrites the previous session', () => {
  const { home, proj } = sandbox();
  try {
    const t1 = Date.now();
    recordVerdict(home, proj, { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, overCeiling: true, perDay: 500, breakEvenDays: 3.2, floorUnmeasured: false, hardCeilingTokens: 36000 }, t1);
    const proj1 = projectState(loadState(home), proj);
    assert.strictEqual(proj1.lastVerdict.band, 'FULL');
    assert.strictEqual(proj1.lastVerdict.reason, 'absolute-cap');
    assert.strictEqual(proj1.lastVerdict.economical, true);
    assert.strictEqual(proj1.lastVerdict.fatTokens, 4004);
    assert.strictEqual(proj1.lastVerdict.at, t1);
    assert.strictEqual(proj1.lastVerdict.overCeiling, true);
    assert.strictEqual(proj1.lastVerdict.perDay, 500);
    assert.strictEqual(proj1.lastVerdict.breakEvenDays, 3.2);
    assert.strictEqual(proj1.lastVerdict.floorUnmeasured, false);
    assert.strictEqual(proj1.lastVerdict.hardCeilingTokens, 36000);

    const t2 = t1 + 1000;
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, overCeiling: false }, t2);
    const proj2 = projectState(loadState(home), proj);
    assert.strictEqual(proj2.lastVerdict.band, 'LEAN', 'the new LEAN verdict overwrote the stale FULL — nothing lingers');
    assert.strictEqual(proj2.lastVerdict.overCeiling, false, 'the hysteresis bit clears with the band');
  } finally { clean(home, proj); }
});

test('recordVerdict: missing/non-finite payback/hardCeilingTokens fields degrade to safe defaults, never throw', () => {
  const { home, proj } = sandbox();
  try {
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi' });
    const st = projectState(loadState(home), proj).lastVerdict;
    assert.strictEqual(st.overCeiling, false);
    assert.strictEqual(st.perDay, 0);
    assert.strictEqual(st.breakEvenDays, null);
    assert.strictEqual(st.floorUnmeasured, false);
    assert.strictEqual(st.hardCeilingTokens, 0);
  } finally { clean(home, proj); }
});

test('recordVerdict: orphan-prune still runs on this write path (consistent with setLeanFloor)', () => {
  const { home, proj } = sandbox();
  const dead = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-verdict-')));
  try {
    recordStamp(home, dead, 50);
    fs.rmSync(dead, { recursive: true, force: true });
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0 });
    assert.deepStrictEqual(projectState(loadState(home), dead), {}, 'recordVerdict prunes too');
  } finally { clean(home, proj); }
});

test('G2: every corrupt/truncated/empty/wrong-shaped state file self-heals to {} — never throws', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
    const cases = [
      '', // empty file
      '{"projects": {"C:\\\\foo": {"leanFloorTok', // truncated mid-token
      '[1,2,3]', // valid JSON, wrong top-level shape (array)
      '"just a string"',
      '42',
      'null',
      'not json at all { [ garbage',
      JSON.stringify({ projects: 'not an object' }),
    ];
    for (const content of cases) {
      fs.writeFileSync(statePath(home), content, 'utf8');
      assert.doesNotThrow(() => loadState(home), `must not throw on: ${JSON.stringify(content)}`);
      const ps = projectState(loadState(home), proj);
      assert.strictEqual(sanitizeLeanFloor(ps.leanFloorTokens, 5000), 0, 'no case yields a trusted floor');
    }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// edge-crossing state (beta.10 — the Stop hook's once-per-crossing gate;
// beta.12 shrinks BAND_RANK to LEAN/OBESE/FULL — the mechanism itself is
// unchanged, band-string-agnostic)
// ---------------------------------------------------------------------------

test('BAND_RANK orders LEAN < OBESE < FULL', () => {
  assert.ok(BAND_RANK.LEAN < BAND_RANK.OBESE);
  assert.ok(BAND_RANK.OBESE < BAND_RANK.FULL);
  assert.strictEqual(BAND_RANK.PLUMP, undefined, 'PLUMP is retired by the band collapse');
});

test('recordCrossing: a rise arms an unconsumed crossing at the new band', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'LEAN', 1000);
    const st = projectState(loadState(home), proj);
    assert.deepStrictEqual(st.lastCrossing, { band: 'OBESE', at: 1000, consumed: false });
  } finally { clean(home, proj); }
});

test('recordCrossing: the "qualifying past" case — no prior band on record defaults to LEAN, so an already-high first scan fires immediately', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', undefined, 1000); // prevBand undefined -> rank 0 (LEAN)
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing.band, 'FULL');
  } finally { clean(home, proj); }
});

test('recordCrossing: same-or-falling band does nothing — an existing pending crossing is left exactly as it was (two SessionStarts, one crossing)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'LEAN', 1000);
    recordCrossing(home, proj, 'OBESE', 'OBESE', 2000); // same band again
    let st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.at, 1000, 'the crossing is not re-armed/overwritten by a same-band repeat');

    recordCrossing(home, proj, 'OBESE', 'FULL', 3000); // falling (FULL -> OBESE) also does nothing
    st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.at, 1000, 'a falling band never re-arms either');
  } finally { clean(home, proj); }
});

test('recordCrossing: LEAN clears any pending crossing outright', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'LEAN', 1000);
    assert.ok(projectState(loadState(home), proj).lastCrossing);
    recordCrossing(home, proj, 'LEAN', 'OBESE', 2000);
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing, undefined);
  } finally { clean(home, proj); }
});

test('recordCrossing: orphan-prune still runs on this write path', () => {
  const { home, proj } = sandbox();
  const dead = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-crossing-')));
  try {
    recordStamp(home, dead, 50);
    fs.rmSync(dead, { recursive: true, force: true });
    recordCrossing(home, proj, 'OBESE', 'LEAN');
    assert.deepStrictEqual(projectState(loadState(home), dead), {}, 'recordCrossing prunes too');
  } finally { clean(home, proj); }
});

test('sanitizeCrossing: a fresh, non-LEAN, unconsumed crossing is trusted as-is', () => {
  const now = Date.now();
  assert.deepStrictEqual(sanitizeCrossing({ band: 'OBESE', at: now, consumed: false }, now), { band: 'OBESE', at: now });
  assert.deepStrictEqual(sanitizeCrossing({ band: 'FULL', at: now, consumed: false }, now), { band: 'FULL', at: now });
});

test('sanitizeCrossing: any doubt collapses to null — consumed, LEAN, unknown band (incl. the retired PLUMP), malformed shape, or a future timestamp', () => {
  const now = Date.now();
  assert.strictEqual(sanitizeCrossing({ band: 'OBESE', at: now, consumed: true }, now), null, 'consumed never re-emits');
  assert.strictEqual(sanitizeCrossing({ band: 'LEAN', at: now, consumed: false }, now), null, 'LEAN is never a crossing target');
  assert.strictEqual(sanitizeCrossing({ band: 'PLUMP', at: now, consumed: false }, now), null, 'the retired PLUMP band is now unknown -> null');
  assert.strictEqual(sanitizeCrossing({ band: 'GARBAGE', at: now, consumed: false }, now), null);
  assert.strictEqual(sanitizeCrossing({ band: 'OBESE', at: now + 60000, consumed: false }, now), null, 'a future timestamp is never trusted');
  assert.strictEqual(sanitizeCrossing({ band: 'OBESE', consumed: false }, now), null, 'a missing/non-finite at is discarded');
  for (const bad of [null, undefined, {}, [], 'FULL', 42]) {
    assert.doesNotThrow(() => sanitizeCrossing(bad));
    assert.strictEqual(sanitizeCrossing(bad), null, `${JSON.stringify(bad)} must not arm`);
  }
});

test('consumeCrossing: marks a pending crossing consumed; a project with no crossing at all is a harmless no-op', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'LEAN', 1000);
    assert.strictEqual(consumeCrossing(home, proj, 2000), true);
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.consumed, true);
    assert.strictEqual(st.lastCrossing.consumedAt, 2000);
    assert.strictEqual(st.lastCrossing.band, 'OBESE', 'the band/at fields survive consumption');
    assert.strictEqual(sanitizeCrossing(st.lastCrossing), null, 'a consumed crossing never re-arms');

    assert.doesNotThrow(() => consumeCrossing(home, proj)); // no lastCrossing at all -> no-op, never throws
  } finally { clean(home, proj); }
});

test('consumeCrossing: orphan-prune still runs on this write path', () => {
  const { home, proj } = sandbox();
  const dead = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-consume-')));
  try {
    recordStamp(home, dead, 50);
    fs.rmSync(dead, { recursive: true, force: true });
    consumeCrossing(home, proj);
    assert.deepStrictEqual(projectState(loadState(home), dead), {}, 'consumeCrossing prunes too');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// statOnlyFootprintBytes + the WARP-HOLE STRUCTURAL GATE (beta.13 item 3).
// The design claim ("the stat-only gate is fundamentally cheaper than a full
// re-gauge") is proven STRUCTURALLY below — zero content reads on the cheap
// path vs real content reads on the full path — never by a stopwatch: the
// original PERF-GATE version of this test timed the LIVE REPO as its fixture
// and asserted a >=3x wall-clock ratio, which failed deterministically on
// every CI leg (the dev box's class-B store is gitignored MEMORY.md/CLAUDE.md
// — absent on a CI checkout, so the "full" gauge was as cheap as the stat)
// — a double violation of our own rules: a hermetic-isolation leak (fixture
// = untracked dev-machine state) AND a real-clock ratio in a unit test.
// The measured dev-box numbers stay ON RECORD as engineering data, not a CI
// gate: statOnlyFootprintBytes ~0.13-0.32ms · discoverClassB+measureEntries
// ~6.6-17.9ms on the real CoalWash room (11 always-loaded files), recorded
// 2026-07-11 (see MEMORY.md "WARP-HOLE + WARM COST" / the beta.14 CHANGELOG);
// caliper.mjs's own statOnlyFootprintBytes comment carries the reproduce
// recipe — "the timing itself is deliberately NOT a flaky in-suite
// ms-assertion", which this file now finally conforms to.
// ---------------------------------------------------------------------------

test('statOnlyFootprintBytes: sums current byte sizes for existing paths; a missing path contributes 0 (a legitimate shrink signal, never a throw)', () => {
  const { home, proj } = sandbox();
  try {
    const f1 = path.join(proj, 'a.md');
    const f2 = path.join(proj, 'b.md');
    fs.writeFileSync(f1, 'a'.repeat(100), 'utf8');
    fs.writeFileSync(f2, 'b'.repeat(250), 'utf8');
    assert.strictEqual(statOnlyFootprintBytes([f1, f2]), 350);
    assert.strictEqual(statOnlyFootprintBytes([f1, path.join(proj, 'gone.md')]), 100, 'a gone file contributes 0, never throws');
    assert.strictEqual(statOnlyFootprintBytes([]), 0);
    assert.strictEqual(statOnlyFootprintBytes(null), 0, 'malformed input degrades to 0, never throws');
    assert.strictEqual(statOnlyFootprintBytes(undefined), 0);
  } finally { clean(home, proj); }
});

test('WARP-HOLE STRUCTURAL GATE: statOnlyFootprintBytes opens ZERO file content (stat only) while the full discoverClassB+measureEntries re-gauge DOES read content — the machine-independent reason the full pass is delta-gated', () => {
  const { home, proj } = sandbox();
  const realReadFileSync = fs.readFileSync;
  try {
    // Hermetic fixture store — never the live repo (its class-B files are
    // gitignored and absent on CI). A project-level CLAUDE.md is an
    // always-loaded class-B entry on any machine; the home/.claude dir is
    // the platform marker discoverClassB's detection needs (the cli.test
    // sandbox idiom).
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(4096), 'utf8');
    const disc = discoverClassB({ projectRoot: proj, home });
    const alwaysPaths = disc.entries.filter((e) => e.alwaysLoaded).map((e) => e.path);
    assert.ok(alwaysPaths.length > 0, 'fixture self-check: the sandbox store has an always-loaded set');
    const expectedBytes = alwaysPaths.reduce((s, p) => s + fs.statSync(p).size, 0);

    // Instrument content reads: node:fs's default export is a shared
    // singleton, so counting through it observes caliper.mjs/class-b.mjs's
    // own calls. The wrapper still delegates — nothing can break under it.
    let contentReads = 0;
    fs.readFileSync = (...args) => { contentReads++; return realReadFileSync(...args); };

    // The CHEAP half: the stat-only gate must produce the correct byte total
    // WITHOUT a single content read — that absence is the structural core of
    // the ">=Nx cheaper" claim (stat = metadata; the full pass pays file
    // opens + content decode), valid on any machine, no clock involved.
    contentReads = 0;
    const bytes = statOnlyFootprintBytes(alwaysPaths);
    assert.strictEqual(contentReads, 0, 'the stat-only gate NEVER opens content — this is what keeps it inside the Phoenix #3 per-turn budget');
    assert.strictEqual(bytes, expectedBytes, 'and it still returns the correct byte total from stats alone');

    // The EXPENSIVE half: the full re-gauge genuinely reads content on the
    // SAME fixture — the cost class the WARP-HOLE delta gate exists to avoid
    // paying unconditionally on every Stop tick.
    contentReads = 0;
    const d2 = discoverClassB({ projectRoot: proj, home });
    measureEntries(d2.entries, { readBudgetBytes: 262144, withGzip: false });
    assert.ok(contentReads > 0, `the full discoverClassB+measureEntries pass DOES read content (observed ${contentReads} reads) — structurally heavier than the stat gate on the same store`);
  } finally {
    fs.readFileSync = realReadFileSync;
    clean(home, proj);
  }
});

// ---------------------------------------------------------------------------
// gaugeVerdict — the shared "measurement -> verdict + economics" composition
// (beta.13 item 3): SessionStart and the Stop hook's gated re-gauge both call
// this instead of re-deriving the sanitize->bandVerdict->breakEven glue by
// hand at a second call site.
// ---------------------------------------------------------------------------

test('gaugeVerdict: LEAN never computes payback numbers (matches the pre-refactor SessionStart gating exactly)', () => {
  const measure = { alwaysLoaded: { tokensEst: 200, bytes: 800 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 200 };
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 10000, fullPercent: 6 });
  assert.strictEqual(gv.verdict.band, 'LEAN');
  assert.strictEqual(gv.economical, false);
  assert.strictEqual(gv.perDay, 0);
  assert.strictEqual(gv.breakEvenDays, null);
  assert.strictEqual(gv.floorUnmeasured, false);
});

test('gaugeVerdict: FULL+economical computes the payback numbers and arms economical:true; OBESE computes payback but never arms economical', () => {
  // floor 20000; footprint 36200 (>= the 36000 hard cap at fullPercent=6 of
  // CAPACITY_TOKENS AND bmi 1.81 >= 1.5) -> FULL/absolute-cap, same fixture
  // shape as the conductor's own economical-FULL test.
  const measure = { alwaysLoaded: { tokensEst: 36200, bytes: 144800 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 36200 };
  // No stamps (< 2 -> sessionsPerDay's own bootstrap default of 1/day) —
  // matches the conductor's own economical-FULL fixture ("1 stamp -> sessionsPerDay=1").
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 20000, fullPercent: 6 });
  assert.strictEqual(gv.verdict.band, 'FULL');
  assert.strictEqual(gv.verdict.reason, 'absolute-cap');
  assert.strictEqual(gv.economical, true);
  assert.strictEqual(gv.fatTokens, 16200);
  assert.ok(gv.perDay > 0);
  assert.ok(Number.isFinite(gv.breakEvenDays));

  // OBESE: bmi armed, under the hard cap, carry < wash -> payback computed,
  // economical stays false (only FULL may arm the force case). 0g fixture
  // note: the recall-heavy totalTokensEst (120000, so runCost = 360k dwarfs
  // the 84k carry) is what keeps this store in the chronic-chubby zone — the
  // SAME footprint over a lean recall store would be economically FULL now
  // (pinned by the economic-FULL tests below).
  const obeseMeasure = { alwaysLoaded: { tokensEst: 16000, bytes: 64000 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 120000 };
  const gvObese = gaugeVerdict({ measure: obeseMeasure, rawLeanFloorTokens: 10000, fullPercent: 6 });
  assert.strictEqual(gvObese.verdict.band, 'OBESE');
  assert.strictEqual(gvObese.economical, false, 'OBESE never arms economical, even though payback IS computed');
  assert.ok(gvObese.perDay > 0, 'payback numbers ARE computed for OBESE (queue 0c)');
});

test('gaugeVerdict: FULL(externalize) never computes payback numbers (a wash cannot help ~all-muscle over capacity)', () => {
  const measure = { alwaysLoaded: { tokensEst: 36200, bytes: 144800 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 36200 };
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 36000, fullPercent: 6 });
  assert.strictEqual(gv.verdict.band, 'FULL');
  assert.strictEqual(gv.verdict.reason, 'externalize');
  assert.strictEqual(gv.economical, false);
  assert.strictEqual(gv.perDay, 0);
  assert.strictEqual(gv.breakEvenDays, null);
});

test('gaugeVerdict: a poisoned leanFloor is sanitized exactly like the raw sanitizeLeanFloor call would', () => {
  const measure = { alwaysLoaded: { tokensEst: 100, bytes: 400 }, index: { bytes: 26 * 1024, lines: 0 }, totalTokensEst: 100 };
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 999999999, fullPercent: 6 });
  assert.strictEqual(gv.leanFloorTokens, 0, 'grossly-implausible floor discarded');
  assert.strictEqual(gv.verdict.band, 'FULL', 'the index-byte absolute cap still fires');
  assert.strictEqual(gv.verdict.reason, 'absolute-cap');
});

// ---------------------------------------------------------------------------
// 0g "FULL = THE ECONOMIC CUT-POINT" + 0g-RESOLUTION (MEMORY.md): FULL ⊂
// OBESE (Q1 — the economic test fires only with the BMI ceiling armed),
// LATCHED per episode (Q2 — no flap on boundary drift, no second Schmitt),
// the wall's three roles preserved (Q3), economics computed before the band
// (Q4). All pre-0g bandVerdict tests above pass economical/wasEconLatched
// as their default false, so the pre-0g behavior is pinned unchanged there.
// ---------------------------------------------------------------------------

test('0g Q1: crossing the economic line while the ceiling is armed lands FULL/economic and sets the latch', () => {
  const floor = 10000;
  const v = bandVerdict({ footprintTokens: 15020, leanFloorTokens: floor, economical: true });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'economic');
  assert.strictEqual(v.over, true, 'FULL ⊂ OBESE: the ceiling itself is armed');
  assert.strictEqual(v.econLatched, true, 'the per-episode latch sets at the arm');
});

test('0g Q1: the economic test alone NEVER fires un-armed — no LEAN→FULL jump for a tiny-fat-heavy-use store', () => {
  const floor = 10000;
  // Under the arm mark entirely.
  const under = bandVerdict({ footprintTokens: 11000, leanFloorTokens: floor, economical: true });
  assert.strictEqual(under.band, 'LEAN');
  assert.strictEqual(under.econLatched, false);
  // In the dead zone but never previously armed (wasOver false).
  const deadZoneUnarmed = bandVerdict({ footprintTokens: 13500, leanFloorTokens: floor, wasOver: false, economical: true });
  assert.strictEqual(deadZoneUnarmed.band, 'LEAN', 'the dead zone never arms fresh, economics notwithstanding');
  // Bootstrap (no floor): bmi null -> the ceiling cannot be armed -> only the wall can fire.
  const bootstrap = bandVerdict({ footprintTokens: 5000, leanFloorTokens: 0, economical: true });
  assert.strictEqual(bootstrap.band, 'LEAN');
  assert.strictEqual(bootstrap.reason, 'no-floor-yet');
  assert.strictEqual(bootstrap.econLatched, false, 'pre-floor can never latch (Q1: economic FULL needs the armed ceiling)');
});

test('0g: the OBESE zone is armed-but-not-economical (chronic-chubby is CORRECT — carry < wash)', () => {
  const v = bandVerdict({ footprintTokens: 15020, leanFloorTokens: 10000, economical: false });
  assert.strictEqual(v.band, 'OBESE');
  assert.strictEqual(v.reason, 'bmi');
  assert.strictEqual(v.econLatched, false);
});

test('0g Q2: the latch holds FULL through an armed session whose fresh proof dipped (boundary drift never flaps the band)', () => {
  const floor = 10000;
  // Dead zone (bmi 1.35, over held by wasOver) + fresh economics false + the latch -> still FULL.
  const held = bandVerdict({ footprintTokens: 13500, leanFloorTokens: floor, wasOver: true, economical: false, wasEconLatched: true });
  assert.strictEqual(held.band, 'FULL');
  assert.strictEqual(held.reason, 'economic');
  assert.strictEqual(held.econLatched, true, 'the latch persists through the dip');
  // Same store WITHOUT the latch is the control: plain OBESE.
  const control = bandVerdict({ footprintTokens: 13500, leanFloorTokens: floor, wasOver: true, economical: false, wasEconLatched: false });
  assert.strictEqual(control.band, 'OBESE', 'without the latch the same dip would drop the band — the latch is the anti-flap');
});

test('0g Q2: the latch falls with the ceiling — LEAN (the episode reset) clears it, a stale latch can never hold an un-armed store FULL', () => {
  const floor = 10000;
  // BMI at/under the low-water mark disarms regardless of latch or fresh economics.
  const v = bandVerdict({ footprintTokens: 11000, leanFloorTokens: floor, wasOver: true, economical: true, wasEconLatched: true });
  assert.strictEqual(v.band, 'LEAN');
  assert.strictEqual(v.over, false);
  assert.strictEqual(v.econLatched, false, 'LEAN writes the latch false — the episode is over');
});

test('0g Q3: capHit+over stays FULL/absolute-cap (wash-first) and still carries the latch when the economic condition holds', () => {
  const v = bandVerdict({ footprintTokens: 36200, leanFloorTokens: 20000, fullPercent: 6, economical: true });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'absolute-cap', 'the wall keeps reason-precedence over economic');
  assert.strictEqual(v.econLatched, true, 'the episode latch still sets — shrinking back under the wall mid-episode must not drop the band');
  // ...and the follow-on session under the wall rides the latch into FULL/economic.
  const after = bandVerdict({ footprintTokens: 35000, leanFloorTokens: 20000, fullPercent: 6, wasOver: true, economical: false, wasEconLatched: true });
  assert.strictEqual(after.band, 'FULL');
  assert.strictEqual(after.reason, 'economic');
});

test('0g Q3: externalize (capHit while un-armed, ~all-muscle) never latches, even against a mistakenly-true economical', () => {
  const v = bandVerdict({ footprintTokens: 36200, leanFloorTokens: 36000, fullPercent: 6, economical: true });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'externalize');
  assert.strictEqual(v.econLatched, false);
});

test('0g gaugeVerdict: a lean-recall armed store past the break-even is FULL/economic end-to-end (economical armed, payback computed, latch out)', () => {
  // fat 6000, store 16000: carry 6000*14 = 84000 > runCost 16000*3 = 48000.
  const measure = { alwaysLoaded: { tokensEst: 16000, bytes: 64000 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 16000 };
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 10000, fullPercent: 6 });
  assert.strictEqual(gv.verdict.band, 'FULL');
  assert.strictEqual(gv.verdict.reason, 'economic');
  assert.strictEqual(gv.economical, true);
  assert.strictEqual(gv.verdict.econLatched, true);
  assert.ok(gv.perDay > 0);
  assert.ok(Number.isFinite(gv.breakEvenDays));
});

test('0g gaugeVerdict: a LATCHED session whose fresh proof dipped keeps the BAND but not the FORCE — economical reflects the fresh numbers only', () => {
  // fat 2500, store 12500: carry 35000 < runCost 37500 -> fresh economics
  // false; bmi 1.25 sits in the dead zone held armed by wasOver.
  const measure = { alwaysLoaded: { tokensEst: 12500, bytes: 50000 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 12500 };
  const gv = gaugeVerdict({ measure, rawLeanFloorTokens: 10000, fullPercent: 6, wasOver: true, wasEconLatched: true });
  assert.strictEqual(gv.verdict.band, 'FULL', 'Q2: the latch holds the band');
  assert.strictEqual(gv.verdict.reason, 'economic');
  assert.strictEqual(gv.verdict.econLatched, true);
  assert.strictEqual(gv.economical, false, 'the FORCE arms on the fresh deterministic proof only (economic-dominance: numbers must hold at every fire) — a pending crossing degrades to the plain ask, never a forced run');
  assert.ok(gv.perDay > 0, 'payback numbers still shown on whatever surfaces');
});

test('0g: recordVerdict round-trips econLatched, and a LEAN overwrite clears it (the episode reset in state)', () => {
  const { home, proj } = sandbox();
  try {
    recordVerdict(home, proj, { band: 'FULL', reason: 'economic', economical: true, fatTokens: 6000, overCeiling: true, econLatched: true }, 1000);
    assert.strictEqual(projectState(loadState(home), proj).lastVerdict.econLatched, true);
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, overCeiling: false, econLatched: false }, 2000);
    const st = projectState(loadState(home), proj).lastVerdict;
    assert.strictEqual(st.econLatched, false, 'LEAN writes the latch false');
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi' }, 3000);
    assert.strictEqual(projectState(loadState(home), proj).lastVerdict.econLatched, false, 'a missing econLatched degrades to false, never undefined/throw');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0j "BMI ON AT INSTALL — provisional floor" (MEMORY.md): the first gauge of
// a never-seen store stamps a PROVISIONAL floor = the current footprint, so
// BMI is live from day one; it never ratchets; only setLeanFloor (a
// gate-passed clean) overwrites it; FLOOR_MIN and the WALL are unchanged.
// ---------------------------------------------------------------------------

test('0j ensureProvisionalFloor: a never-seen store stamps floor = footprint with the provisional flag; day-one BMI = 1.00 through gaugeVerdict', () => {
  const { home, proj } = sandbox();
  try {
    const r = ensureProvisionalFloor(home, proj, 10000, 1000);
    assert.deepStrictEqual(r, { floorTokens: 10000, provisional: true });
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.leanFloorTokens, 10000);
    assert.strictEqual(st.leanFloorProvisional, true);
    assert.strictEqual(st.leanFloorAt, 1000);

    const measure = { alwaysLoaded: { tokensEst: 10000, bytes: 40000 }, index: { bytes: 0, lines: 0 }, totalTokensEst: 10000 };
    const gv = gaugeVerdict({ measure, rawLeanFloorTokens: r.floorTokens, floorProvisional: r.provisional, fullPercent: 6 });
    assert.strictEqual(gv.verdict.band, 'LEAN');
    assert.strictEqual(gv.verdict.bmi, 1, 'BMI live at exactly 1.00 on day one');
    assert.strictEqual(gv.floorUnmeasured, false, 'a provisional floor IS a measured baseline — no upper-bound labeling');
  } finally { clean(home, proj); }
});

test('0j: the provisional floor NEVER ratchets — a later, bigger gauge returns the original stamp untouched', () => {
  const { home, proj } = sandbox();
  try {
    ensureProvisionalFloor(home, proj, 10000, 1000);
    const later = ensureProvisionalFloor(home, proj, 25000, 2000); // store grew — the baseline must not follow
    assert.deepStrictEqual(later, { floorTokens: 10000, provisional: true });
    assert.strictEqual(projectState(loadState(home), proj).leanFloorTokens, 10000);
  } finally { clean(home, proj); }
});

test('0j: an existing REAL floor passes through untouched (no stamp, no flag) — and a poisoned raw floor is likewise never clobbered', () => {
  const { home, proj } = sandbox();
  try {
    setLeanFloor(home, proj, 8000, 500);
    const r = ensureProvisionalFloor(home, proj, 12000, 1000);
    assert.deepStrictEqual(r, { floorTokens: 8000, provisional: false });
    assert.notStrictEqual(projectState(loadState(home), proj).leanFloorProvisional, true);

    // Poisoned floor on file: read-time sanitizing discards it downstream,
    // but the STAMPING site must not overwrite it (setLeanFloor's job alone).
    setLeanFloor(home, proj, 999999999, 600);
    const p = ensureProvisionalFloor(home, proj, 12000, 1100);
    assert.strictEqual(p.floorTokens, 999999999, 'returned raw — sanitizeLeanFloor handles trust at read');
    assert.strictEqual(p.provisional, false);
  } finally { clean(home, proj); }
});

test('0j: setLeanFloor (a gate-passed clean) overwrites the provisional floor AND clears the flag', () => {
  const { home, proj } = sandbox();
  try {
    ensureProvisionalFloor(home, proj, 10000, 1000);
    setLeanFloor(home, proj, 7000, 2000);
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.leanFloorTokens, 7000);
    assert.strictEqual(st.leanFloorProvisional, undefined, 'the real clean cleared the provisional flag');
    // ...and the now-real floor is passthrough for every later gauge.
    assert.deepStrictEqual(ensureProvisionalFloor(home, proj, 30000, 3000), { floorTokens: 7000, provisional: false });
  } finally { clean(home, proj); }
});

test('0j: a footprint under FLOOR_MIN_TOKENS stamps nothing — the tiny-store guard unchanged', () => {
  const { home, proj } = sandbox();
  try {
    const r = ensureProvisionalFloor(home, proj, FLOOR_MIN_TOKENS - 1, 1000);
    assert.deepStrictEqual(r, { floorTokens: 0, provisional: false });
    assert.strictEqual(projectState(loadState(home), proj).leanFloorTokens, undefined, 'nothing written');
    // exactly at the minimum IS stamped (mirrors bandVerdict's own boundary)
    assert.deepStrictEqual(ensureProvisionalFloor(home, proj, FLOOR_MIN_TOKENS, 2000), { floorTokens: FLOOR_MIN_TOKENS, provisional: true });
  } finally { clean(home, proj); }
});

test('0j bandVerdict: capHit with a PROVISIONAL floor stays FULL/absolute-cap (wash first) — a provisional baseline can never certify externalize', () => {
  // Day-one over-wall store: floor = footprint (provisional), bmi 1.0, un-armed.
  const v = bandVerdict({ footprintTokens: 36200, leanFloorTokens: 36200, fullPercent: 6, floorProvisional: true });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'absolute-cap', '0j: pre-existing fat may be baked into the provisional baseline — never diagnose "all muscle" from it');
  // The identical numbers with a REAL floor = the all-muscle externalize case (0g Q3, unchanged).
  const real = bandVerdict({ footprintTokens: 36200, leanFloorTokens: 36200, fullPercent: 6, floorProvisional: false });
  assert.strictEqual(real.reason, 'externalize');
});

// ---------------------------------------------------------------------------
// 0o "SUBAGENT BLIND SPOT" — recordSubSpawn (the TRUE-BILL COUNTER) + the
// recordStamp session-boundary reset. Write-only bookkeeping; the cost is
// the CACHED verdict's alwaysLoadedBytes only, never a re-gauge.
// ---------------------------------------------------------------------------

test('0o recordSubSpawn: increments the counter and accumulates the CACHED parcel cost; a never-gauged project counts the spawn at cost 0', () => {
  const { home, proj } = sandbox();
  try {
    // Never gauged: no lastVerdict -> spawn counted, cost 0 (never compute).
    recordSubSpawn(home, proj, 1000);
    let st = projectState(loadState(home), proj);
    assert.strictEqual(st.subSpawns, 1);
    assert.strictEqual(st.subParcelTokensAccum, 0);

    // Gauge caches the parcel baseline -> later spawns bill it.
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', alwaysLoadedBytes: 40000 }, 2000); // ~10000 tok
    recordSubSpawn(home, proj, 3000);
    recordSubSpawn(home, proj, 4000);
    st = projectState(loadState(home), proj);
    assert.strictEqual(st.subSpawns, 3, 'N spawns = N silent increments');
    assert.strictEqual(st.subParcelTokensAccum, 20000, 'two billed spawns x 10000 tok cached parcel (the first was cost-0)');
    assert.strictEqual(st.lastSubSpawnAt, 4000);
  } finally { clean(home, proj); }
});

test('0o session boundary: recordStamp (the once-per-session gauge heartbeat) RESETS the spawn counters — a session figure, never a lifetime ledger', () => {
  const { home, proj } = sandbox();
  try {
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', alwaysLoadedBytes: 4000 }, 500);
    recordSubSpawn(home, proj, 1000);
    recordSubSpawn(home, proj, 1100);
    assert.strictEqual(projectState(loadState(home), proj).subSpawns, 2);

    recordStamp(home, proj, 1000, 2000); // the next session's first gauge
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.subSpawns, undefined, 'counters cleared at the session boundary');
    assert.strictEqual(st.subParcelTokensAccum, undefined);
    assert.ok(st.stamps.length >= 1, 'the stamp itself still lands');

    // ...and the new session accumulates fresh.
    recordSubSpawn(home, proj, 3000);
    assert.strictEqual(projectState(loadState(home), proj).subSpawns, 1);
  } finally { clean(home, proj); }
});

test('0o recordSubSpawn: corrupt counter values self-heal (non-numeric -> restart from 0+1), never throw', () => {
  const { home, proj } = sandbox();
  try {
    recordStamp(home, proj, 100, 500); // create the project entry
    const raw = loadState(home);
    const key = Object.keys(raw.projects)[0];
    raw.projects[key].subSpawns = 'garbage';
    raw.projects[key].subParcelTokensAccum = null;
    fs.writeFileSync(statePath(home), JSON.stringify(raw), 'utf8');
    assert.doesNotThrow(() => recordSubSpawn(home, proj, 1000));
    const after = projectState(loadState(home), proj);
    assert.strictEqual(after.subSpawns, 1, 'garbage collapses to a fresh count');
    assert.strictEqual(after.subParcelTokensAccum, 0);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// markQuickTried (0e "THE OBESE LOOP")
// ---------------------------------------------------------------------------

test('markQuickTried: sets quickTried + quickTriedAt, persists, and prunes orphans on this write path too', () => {
  const { home, proj } = sandbox();
  const dead = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-quicktried-')));
  try {
    recordStamp(home, dead, 50);
    fs.rmSync(dead, { recursive: true, force: true });
    markQuickTried(home, proj, 1234);
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.quickTried, true);
    assert.strictEqual(st.quickTriedAt, 1234);
    assert.deepStrictEqual(projectState(loadState(home), dead), {}, 'markQuickTried prunes too');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// recordCrossing's escalation-arm branch (0f "AUTHORITATIVE 3-FLOW",
// MEMORY.md — SUPERSEDES 0e "THE OBESE LOOP": same growth-gated mechanism,
// trigger band relocated OBESE->FULL. OBESE never arms an escalation any
// more — 0d makes it auto-Quick-silent, full stop). Additive to the existing
// rise-arm behavior above, which stays byte-for-byte unchanged (every
// pre-existing recordCrossing/sanitizeCrossing test above still passes
// UNMODIFIED — quickTried defaults false, so the branch is inert unless
// explicitly opted into).
// ---------------------------------------------------------------------------

test('recordCrossing: OBESE persisting (same band, no rise) with quickTried+growth NEVER escalates any more — 0f moved the trigger band to FULL (0d: OBESE is auto-Quick-silent only)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'OBESE', 1000, { quickTried: true, fatTokens: 500 });
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing, undefined, 'OBESE never arms an escalation crossing, no matter quickTried/growth');
  } finally { clean(home, proj); }
});

test('recordCrossing: OBESE reached again on a FALL (e.g. settling back from FULL) with quickTried+growth also never escalates — 0f', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'OBESE', 'FULL', 1000, { quickTried: true, fatTokens: 700 }); // a FALL, not a rise
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing, undefined);
  } finally { clean(home, proj); }
});

test('recordCrossing: FULL persisting (same band, no rise) with quickTried+growth arms an ESCALATION crossing (extra key, only when true) — 0f\'s sole ask site', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 500 });
    const st = projectState(loadState(home), proj);
    assert.deepStrictEqual(st.lastCrossing, { band: 'FULL', at: 1000, consumed: false, escalation: true });
    assert.strictEqual(st.lastEscalationFat, 500);
  } finally { clean(home, proj); }
});

test('recordCrossing: FULL persisting WITHOUT quickTried stays inert — the wizard leg cannot arm until a force-run has actually tried Quick first', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: false, fatTokens: 500 });
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing, undefined);
  } finally { clean(home, proj); }
});

test('recordCrossing: FULL persisting with quickTried but NO growth past the last flagged fat level stays SILENT — never a clock/re-nag on an unchanged plateau', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 500 }); // first escalation
    recordCrossing(home, proj, 'FULL', 'FULL', 2000, { quickTried: true, fatTokens: 500 }); // same fat, later tick
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.at, 1000, 'flat fat never re-arms a new escalation');
    recordCrossing(home, proj, 'FULL', 'FULL', 3000, { quickTried: true, fatTokens: 480 }); // fat SHRANK slightly
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing.at, 1000, 'a shrink never re-arms either');
  } finally { clean(home, proj); }
});

test('0m: the FIRST escalation of an episode arms on quickTried alone — fat 0 included (the day-one over-wall store: provisional floor = footprint, fat ≡ 0; the ledger sequence "force → still over → the ONE wizard ask" is unconditional)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 0 });
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.escalation, true, 'never flagged before -> arms at any fat level, 0 included');
    assert.strictEqual(st.lastEscalationFat, 0, 'the flagged level is recorded, 0 included');
    // ...and the no-nag rule guards RE-asks exactly as before: consumed, then
    // an unchanged fat-0 plateau never re-arms.
    consumeCrossing(home, proj, 1500);
    recordCrossing(home, proj, 'FULL', 'FULL', 2000, { quickTried: true, fatTokens: 0 });
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing.at, 1000, 'a fat-0 plateau after the first ask stays silent — growth (past 0) is the only re-arm');
    // Real growth past the flagged 0 re-arms.
    recordCrossing(home, proj, 'FULL', 'FULL', 3000, { quickTried: true, fatTokens: 50 });
    assert.strictEqual(projectState(loadState(home), proj).lastCrossing.at, 3000, 'genuine growth past the flagged level re-arms');
  } finally { clean(home, proj); }
});

test('recordCrossing: fat GROWING past the last flagged escalation level re-arms a fresh escalation (the growth-rate frequency rule)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 500 });
    // consumed at emission (the Stop hook's own discipline) — otherwise a
    // still-PENDING escalation must never be clobbered by a second arm.
    consumeCrossing(home, proj, 1500);
    recordCrossing(home, proj, 'FULL', 'FULL', 2000, { quickTried: true, fatTokens: 900 }); // genuinely more fat
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.at, 2000, 'growth past the last flagged level arms a fresh escalation');
    assert.strictEqual(st.lastCrossing.consumed, false);
    assert.strictEqual(st.lastEscalationFat, 900);
  } finally { clean(home, proj); }
});

test('recordCrossing: a still-PENDING (unconsumed) escalation is never clobbered by a later same-band check', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 500 });
    recordCrossing(home, proj, 'FULL', 'FULL', 5000, { quickTried: true, fatTokens: 9000 }); // huge growth, but never consumed yet
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing.at, 1000, 'a pending, undelivered escalation is left exactly as it is — the existing "never re-arm a pending crossing" rule extends here');
  } finally { clean(home, proj); }
});

test('recordCrossing: LEAN clears quickTried + lastEscalationFat too (the episode reset — a future rise gets a fresh, unconditional auto-Quick attempt)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'FULL', 1000, { quickTried: true, fatTokens: 500 });
    markQuickTried(home, proj, 1000);
    recordCrossing(home, proj, 'LEAN', 'FULL', 2000);
    const st = projectState(loadState(home), proj);
    assert.strictEqual(st.lastCrossing, undefined);
    assert.strictEqual(st.quickTried, undefined);
    assert.strictEqual(st.lastEscalationFat, undefined);
  } finally { clean(home, proj); }
});

test('recordCrossing: a plain rise-arm keeps the EXACT pre-existing 2-key shape even when quickTried happens to be true (rise takes priority; not conflated with escalation)', () => {
  const { home, proj } = sandbox();
  try {
    recordCrossing(home, proj, 'FULL', 'OBESE', 1000, { quickTried: true, fatTokens: 4000 }); // a genuine rise
    assert.deepStrictEqual(projectState(loadState(home), proj).lastCrossing, { band: 'FULL', at: 1000, consumed: false });
  } finally { clean(home, proj); }
});

test('sanitizeCrossing: escalation:true passes through; escalation absent/false keeps the EXACT pre-existing 2-key shape', () => {
  const now = Date.now();
  assert.deepStrictEqual(sanitizeCrossing({ band: 'OBESE', at: now, consumed: false, escalation: true }, now), { band: 'OBESE', at: now, escalation: true });
  assert.deepStrictEqual(sanitizeCrossing({ band: 'OBESE', at: now, consumed: false, escalation: false }, now), { band: 'OBESE', at: now });
  assert.deepStrictEqual(sanitizeCrossing({ band: 'OBESE', at: now, consumed: false }, now), { band: 'OBESE', at: now });
});

test('REGAUGE_DELTA_TOKENS / ALWAYS_LOADED_PATHS_CAP are positive, sane placeholder constants', () => {
  assert.ok(REGAUGE_DELTA_TOKENS > 0);
  assert.ok(ALWAYS_LOADED_PATHS_CAP > 0);
});
