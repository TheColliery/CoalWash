import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tokensEst, tokensEstFromBytes, gzipRatio, measureEntries,
  bandVerdict, breakEven, sessionsPerDay,
  statePath, loadState, projectState, recordStamp, setLeanFloor, setSnooze,
  sanitizeLeanFloor, LEAN_FLOOR_MAX_MULTIPLE,
  recordVerdict, sanitizeVerdict, VERDICT_MAX_AGE_MS,
  PLUMP_BMI, OBESE_BMI, FAT_BUDGET_TOKENS, CAPACITY_TOKENS, CC_INDEX_CAP_BYTES, CC_INDEX_CAP_LINES,
  RUN_COST_MULTIPLIER, ECON_HORIZON_DAYS, STAMP_RING_MAX,
} from './caliper.mjs';

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

test('bandVerdict: BMI ladder LEAN -> PLUMP -> OBESE against a measured floor; FULL is fat-budget-gated (growable-full)', () => {
  const floor = 1000;
  const at = (fp) => bandVerdict({ footprintTokens: fp, leanFloorTokens: floor });
  assert.strictEqual(at(Math.round(floor * (PLUMP_BMI - 0.05))).band, 'LEAN');
  assert.strictEqual(at(Math.round(floor * (PLUMP_BMI + 0.05))).band, 'PLUMP');
  assert.strictEqual(at(Math.round(floor * (OBESE_BMI + 0.05))).band, 'OBESE');
  // FULL no longer fires on a raw BMI ratio post-floor — exactly at the fat
  // budget it is still OBESE (not yet OVER); one token past it, FULL.
  assert.strictEqual(at(floor + FAT_BUDGET_TOKENS).band, 'OBESE', 'at the budget line exactly, still OBESE');
  const over = at(floor + FAT_BUDGET_TOKENS + 1);
  assert.strictEqual(over.band, 'FULL');
  assert.strictEqual(over.reason, 'fat-budget');
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
// Growable-full (beta.7 #1 — the USER's three-layer invariant): FULL is
// judged on ABSOLUTE fat above the measured floor, never the raw ratio, so a
// large legitimate floor never false-fires. Pins the exact live dogfood cases
// that exposed the bug (MEMORY.md "THE CALIBRATION FINDING").
// ---------------------------------------------------------------------------

test('growable-full (a): TheColliery post-clean (floor 29054, footprint ~29098) verdicts LEAN, not FULL', () => {
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
});

test('growable-full: fat strictly above FAT_BUDGET_TOKENS fires FULL even far below the hard cap, at realistic scale', () => {
  const floor = 29054;
  const v = bandVerdict({ footprintTokens: floor + FAT_BUDGET_TOKENS + 1, leanFloorTokens: floor });
  assert.strictEqual(v.band, 'FULL');
  assert.strictEqual(v.reason, 'fat-budget');
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

test('state: recordStamp persists and ring-caps; floor + snooze round-trip; corrupt file self-heals', () => {
  const { home, proj } = sandbox();
  try {
    for (let i = 0; i < STAMP_RING_MAX + 5; i++) recordStamp(home, proj, 100 + i, 1000 + i);
    const st = loadState(home);
    const ps = projectState(st, proj);
    assert.strictEqual(ps.stamps.length, STAMP_RING_MAX, 'ring-capped');
    assert.strictEqual(ps.stamps[ps.stamps.length - 1].fp, 100 + STAMP_RING_MAX + 4);

    assert.strictEqual(setLeanFloor(home, proj, 777), true);
    assert.strictEqual(setSnooze(home, proj, 123456789), true);
    const ps2 = projectState(loadState(home), proj);
    assert.strictEqual(ps2.leanFloorTokens, 777);
    assert.strictEqual(ps2.snoozeUntil, 123456789);
    assert.strictEqual(ps2.stamps.length, STAMP_RING_MAX, 'floor/snooze writes keep the stamps');

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

test('orphan prune: fires from setLeanFloor and setSnooze too (every write path, not just recordStamp)', () => {
  const { home, proj } = sandbox();
  const dead1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-lf-')));
  const dead2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-dead-sn-')));
  try {
    recordStamp(home, dead1, 50);
    fs.rmSync(dead1, { recursive: true, force: true });
    setLeanFloor(home, proj, 500);
    assert.deepStrictEqual(projectState(loadState(home), dead1), {}, 'setLeanFloor prunes too');

    recordStamp(home, dead2, 50);
    fs.rmSync(dead2, { recursive: true, force: true });
    setSnooze(home, proj, Date.now() + 1000);
    assert.deepStrictEqual(projectState(loadState(home), dead2), {}, 'setSnooze prunes too');
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
// G2: state-file corruption always lands on the conservative path (never
// throws, never trusts partial content) — file-level counterpart to
// sanitizeLeanFloor's value-level guard above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cached verdict (beta.8 #2 — the UserPromptSubmit hot-path gate)
// ---------------------------------------------------------------------------

test('sanitizeVerdict: only a fresh FULL+economical verdict is armed; every other band/state is null', () => {
  const now = Date.now();
  const fresh = (over = {}) => ({ band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: now, ...over });
  assert.deepStrictEqual(sanitizeVerdict(fresh(), now), { band: 'FULL', reason: 'fat-budget', fatTokens: 4004, at: now });

  assert.strictEqual(sanitizeVerdict(fresh({ band: 'LEAN' }), now), null, 'LEAN never arms');
  assert.strictEqual(sanitizeVerdict(fresh({ band: 'PLUMP' }), now), null, 'PLUMP never arms');
  assert.strictEqual(sanitizeVerdict(fresh({ band: 'OBESE' }), now), null, 'OBESE never arms');
  assert.strictEqual(sanitizeVerdict(fresh({ band: 'FULL', reason: 'externalize', economical: false }), now), null, 'externalize never arms (muscle, not the force-run case)');
  assert.strictEqual(sanitizeVerdict(fresh({ economical: false }), now), null, 'a disarmed FULL (break-even against) never arms');
  assert.strictEqual(sanitizeVerdict(fresh({ economical: 'true' }), now), null, 'a non-boolean-true economical is not trusted');
});

test('sanitizeVerdict: malformed/missing input collapses to null, never throws', () => {
  for (const bad of [null, undefined, {}, [], 'FULL', 42, { band: 'FULL', economical: true }]) {
    assert.doesNotThrow(() => sanitizeVerdict(bad));
    assert.strictEqual(sanitizeVerdict(bad), null, `${JSON.stringify(bad)} must not arm`);
  }
});

test('sanitizeVerdict: staleness — just inside VERDICT_MAX_AGE_MS survives, just past it is discarded; a future timestamp is discarded', () => {
  const now = Date.now();
  const at = (ms) => ({ band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 100, at: now - ms });
  assert.notStrictEqual(sanitizeVerdict(at(VERDICT_MAX_AGE_MS - 1), now), null, 'just inside the window is armed');
  assert.strictEqual(sanitizeVerdict(at(VERDICT_MAX_AGE_MS + 1), now), null, 'just past the window is stale -> null');
  assert.strictEqual(sanitizeVerdict({ band: 'FULL', economical: true, at: now + 60000 }, now), null, 'a future timestamp is never trusted');
});

test('recordVerdict: round-trips through state and overwrites the previous session (LEAN clears a stale FULL immediately, not just eventually)', () => {
  const { home, proj } = sandbox();
  try {
    const t1 = Date.now();
    recordVerdict(home, proj, { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004 }, t1);
    const armedAfterFull = sanitizeVerdict(projectState(loadState(home), proj).lastVerdict, t1);
    assert.deepStrictEqual(armedAfterFull, { band: 'FULL', reason: 'fat-budget', fatTokens: 4004, at: t1 });

    const t2 = t1 + 1000;
    recordVerdict(home, proj, { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0 }, t2);
    assert.strictEqual(sanitizeVerdict(projectState(loadState(home), proj).lastVerdict, t2), null, 'the new LEAN verdict overwrote the stale FULL — no lingering arm');
  } finally { clean(home, proj); }
});

test('recordVerdict: orphan-prune still runs on this write path (consistent with setLeanFloor/setSnooze)', () => {
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
