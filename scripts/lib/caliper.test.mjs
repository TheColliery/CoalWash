import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tokensEst, tokensEstFromBytes, gzipRatio, measureEntries,
  bandVerdict, breakEven, sessionsPerDay,
  statePath, loadState, projectState, recordStamp, setLeanFloor, setSnooze,
  PLUMP_BMI, OBESE_BMI, FULL_BMI, CC_INDEX_CAP_BYTES, CC_INDEX_CAP_LINES,
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

test('bandVerdict: BMI ladder LEAN -> PLUMP -> OBESE -> FULL against a measured floor', () => {
  const floor = 1000;
  const at = (fp) => bandVerdict({ footprintTokens: fp, leanFloorTokens: floor });
  assert.strictEqual(at(Math.round(floor * (PLUMP_BMI - 0.05))).band, 'LEAN');
  assert.strictEqual(at(Math.round(floor * (PLUMP_BMI + 0.05))).band, 'PLUMP');
  assert.strictEqual(at(Math.round(floor * (OBESE_BMI + 0.05))).band, 'OBESE');
  assert.strictEqual(at(Math.round(floor * (FULL_BMI + 0.05))).band, 'FULL');
  assert.strictEqual(at(Math.round(floor * (FULL_BMI + 0.05))).reason, 'bmi');
});

test('bandVerdict bootstrap: no floor yet -> LEAN (only the absolute cap can fire)', () => {
  const v = bandVerdict({ footprintTokens: 5000, leanFloorTokens: 0 });
  assert.strictEqual(v.band, 'LEAN');
  assert.strictEqual(v.reason, 'no-floor-yet');
  assert.strictEqual(v.bmi, null);
});

test('bandVerdict absolute-cap arms FULL regardless of floor: hard ceiling, index bytes, index lines', () => {
  // hard ceiling: fullPercent(6) x capacity(200000) = 12000 tok
  const hard = bandVerdict({ footprintTokens: 12000, leanFloorTokens: 0, fullPercent: 6 });
  assert.strictEqual(hard.band, 'FULL');
  assert.strictEqual(hard.reason, 'absolute-cap');
  const bytes = bandVerdict({ footprintTokens: 10, leanFloorTokens: 10, indexBytes: CC_INDEX_CAP_BYTES });
  assert.strictEqual(bytes.band, 'FULL');
  const lines = bandVerdict({ footprintTokens: 10, leanFloorTokens: 10, indexLines: CC_INDEX_CAP_LINES });
  assert.strictEqual(lines.band, 'FULL');
});

test('a raised fullPercent raises the hard ceiling (buying a bigger SSD)', () => {
  const before = bandVerdict({ footprintTokens: 12000, leanFloorTokens: 0, fullPercent: 6 });
  const after = bandVerdict({ footprintTokens: 12000, leanFloorTokens: 0, fullPercent: 12 });
  assert.strictEqual(before.band, 'FULL');
  assert.strictEqual(after.band, 'LEAN');
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
