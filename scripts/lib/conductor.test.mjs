// Hermetic spawn tests for hooks/coalwash-conductor.js (hooks-safety.md §7):
// spawn the REAL hook as a child process with a sandboxed HOME/TEMP/cwd so real
// session state, the real ~/.claude/.coalwash.json, and the real memory store
// can never leak in. Every case asserts the three observable surfaces:
//   (1) exit code 0 on every path (Phoenix #4);
//   (2) stderr silent — stdout only on a sanctioned channel: SessionStart's
//       plain context-injection console.log (self-update ONLY, post-beta.12
//       band-collapse — see below), or Stop's structured
//       `{decision:'block', reason}` JSON (mirrors rot-canary-stop.js);
//   (3) the expected state effect (stamp/crossing written, or nothing).
//
// BAND COLLAPSE (beta.12): SessionStart is now a SILENT measurement
// chokepoint for EVERY band — it never prints an ask/directive/advisory of
// its own (queue item 0, the สวัสดี-flow hole: an ask fired at session start
// raced the user's own first message). Stop is the ONLY delivery surface —
// for the ceiling ask (OBESE, or a disarmed/suppressed FULL), the FULL force
// directive, AND (new this release) the FULL(externalize) advisory, which
// used to be SessionStart-only and un-trackable (the old F1 carve) and now
// rides the SAME once-per-crossing Stop channel as everything else.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const HOOK = path.join(REPO, 'hooks', 'coalwash-conductor.js');

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwh-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwh-proj-')));
  // root the project (found by the stop-at-home walk) without overriding config
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function run(cwd, home, input) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}
function writeGlobalCfg(home, cfg) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify(cfg), 'utf8');
}
// A fresh sandbox home makes the self-update check "due" on the very first boot;
// cases asserting gauge behavior mute it (the update directive has its own case).
function muteUpdate(home, extra = {}) {
  writeGlobalCfg(home, { updateMode: 'off', ...extra });
}
function seedClassB(home, proj, { claudeMdBytes = 100, indexBytes = 60, claudeMdText = null, indexText = null } = {}) {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), claudeMdText !== null ? claudeMdText : 'a'.repeat(claudeMdBytes), 'utf8');
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  const mem = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), indexText !== null ? indexText : 'i'.repeat(indexBytes), 'utf8');
  return mem;
}
// ---------------------------------------------------------------------------
// task #4 fixture builders: the band arms on MEASURED CERTAIN FAT now (the
// gauge's own mechFat scan), never on size-vs-floor — so a fixture that wants
// a band must contain REAL certain fat (exact-duplicate substance lines), and
// a fixture that wants silence seeds DISTINCT content however large.
// FAT_LINE is 79 ASCII chars ≈ 20 tok/line; fatText(n) yields mechFat ≈
// (n-1) x 20 tok (every copy beyond the first counts).
// ---------------------------------------------------------------------------
const FAT_LINE = 'this exact line is deliberate duplicate padding for the certain-fat estimator!';
function fatText(copies) { return Array.from({ length: copies }, () => FAT_LINE).join('\n'); }
function muscleText(lines) { return Array.from({ length: lines }, (_, i) => `distinct load-bearing muscle line number ${i} carrying unique real content here`).join('\n'); }
// an index file sized OVER the RE-TIER envelope's arm mark (~4950 tok =
// ~19,800 B) but UNDER BOTH CC caps (25KB bytes AND 200 lines) — makes
// condition 2b's demotable mass real without tripping either index-cap leg.
function overEnvelopeIndex() {
  return Array.from({ length: 150 }, (_, i) =>
    `index row ${i}: a deliberately long distinct index line carrying enough unique content to make each row weigh roughly one hundred forty bytes on disk`).join('\n');
} // ~150 lines x ~145 B ≈ 21.7KB ≈ 5,400 tok — over armAt, under both caps
// stamps modelling ~4 sessions/day so the break-evens can clear the run cost
// (both proofs scale with sessionsPerDay; 1/day rarely pays on small stores).
function seedUsageStamps(state = {}, sessions = 20, days = 5) {
  const now = Date.now();
  const day = 86400000;
  return { ...state, stamps: Array.from({ length: sessions }, (_, i) => ({ t: now - days * day + i * ((days * day) / sessions) })) };
}
// task #13: per-project state lives at <home>/.claude/projects/<slug>/coalwash/
// state.json (flat, one file per project). The OLD single-file root is at
// <home>/.claude/.coalwash-state.json (a migration source only).
function projStatePath(home, proj) {
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'coalwash', 'state.json');
}
function seedState(home, proj, projState, opts = {}) {
  const schema = Object.prototype.hasOwnProperty.call(opts, 'stateSchema') ? opts.stateSchema : 1;
  if (schema === undefined) {
    // Pass { stateSchema: undefined } to model a genuinely OLD, PRE-RELOCATION
    // store at the OLD-ROOT path (no schema) — SessionStart's first loadState
    // reads it via the fallback + migrates (location + schema reset).
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', '.coalwash-state.json'), JSON.stringify({ projects: { [fs.realpathSync.native(proj)]: projState } }), 'utf8');
    return;
  }
  // Default: a store already on the current version at the NEW per-project path.
  const p = projStatePath(home, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...projState, stateSchema: schema }), 'utf8');
}
// 0g fixture helper: a big RECALL file (stat-only measured, never
// always-loaded) inflates breakEven's run cost (3x the WHOLE store) far past
// a small fat's carry, pinning a fixture in the chronic-chubby OBESE zone.
// Without it, a lean-recall store whose BMI ceiling arms is usually
// economically FULL under 0g (fat*14 > store*3 at 1 session/day), so the
// OBESE band these tests exist to pin would be unreachable.
function seedBigRecall(mem) {
  fs.writeFileSync(path.join(mem, 'recall-big.md'), 'r'.repeat(400 * 1024), 'utf8');
}
function readProjState(home, proj) {
  try {
    const raw = JSON.parse(fs.readFileSync(projStatePath(home, proj), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function assertGraceful(r) {
  assert.strictEqual(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.stderr, '', 'hook must be silent on stderr (Phoenix #13)');
  assert.strictEqual(r.signal, null, 'hook must not be killed by a signal');
}

test('coalwashMode off: fully silent even over a FULL-band store', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 60000 });
    writeGlobalCfg(home, { coalwashMode: 'off' }); // off silences update scheduling too
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('LEAN (small store, no floor yet): silent — Phoenix #13 healthy path; 0j stamps NO provisional floor under FLOOR_MIN', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 200, indexBytes: 100 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.stamps.length, 1, 'the gauge still stamps the session');
    assert.strictEqual(st.lastVerdict.band, 'LEAN');
    assert.strictEqual(st.leanFloorTokens, undefined, '0j: a tiny store (footprint < FLOOR_MIN) gets no provisional floor — ratio would be noise');
    assert.notStrictEqual(st.leanFloorProvisional, true);
  } finally { clean(home, proj); }
});

test('manual mode: gauge silent (no stamp), but the self-update scheduler still runs', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 60000 }); // would be OBESE/FULL if gauged
    writeGlobalCfg(home, { coalwashMode: 'manual' }); // updateMode defaults to ask -> due on first boot
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.ok(r.stdout.includes('[self-update due]'));
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'no stamp in manual mode');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SessionStart — band-collapse: SILENT for every band, only the cache changes.
// ---------------------------------------------------------------------------

test('SessionStart: OBESE crossing is measured+cached SILENTLY (no ask text any more — that is Stop\'s job)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4: OBESE = MEASURED certain fat over the arm mark, carry < wash.
    // fatText(60) plants ~59 duplicate substance lines (~1,180 tok of certain
    // fat >= FAT_ARM_TOKENS); the big recall store keeps carry < wash (0g) so
    // the band is OBESE, not economically FULL.
    const mem = seedClassB(home, proj, { claudeMdText: fatText(60) + '\n' + muscleText(40), indexBytes: 0 });
    seedBigRecall(mem);
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'SessionStart never prints a band ask/directive any more');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'OBESE');
    assert.strictEqual(st.lastVerdict.overCeiling, true);
    // P5/P8 wiring pin: the gauge caches the WHOLE measured store (recall
    // included — seedBigRecall dwarfs the always-loaded slice here) as the
    // bin-retention budget base; if the conductor stops passing it, the cap
    // layer goes permanently inert with no other symptom.
    assert.ok(st.lastVerdict.storeTotalBytes > st.lastVerdict.alwaysLoadedBytes, `storeTotalBytes (${st.lastVerdict.storeTotalBytes}) must include the recall tier beyond alwaysLoadedBytes (${st.lastVerdict.alwaysLoadedBytes})`);
    assert.strictEqual(st.lastCrossing.band, 'OBESE');
    assert.strictEqual(st.lastCrossing.consumed, false);
  } finally { clean(home, proj); }
});

test('SessionStart: FULL via the absolute index cap fires on day one — cached, not printed (task #4: no-certain-fat routes it externalize)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // index over the 25KB cap class
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    // task #4: with ZERO measured certain fat, an index-cap hit reads
    // 'externalize' (washing cannot shrink what the estimator proves is
    // muscle) — the old 'absolute-cap' here came from the retired bootstrap
    // heuristic, which could not tell fat from muscle on day one at all.
    assert.strictEqual(st.lastVerdict.reason, 'externalize');
    assert.strictEqual(st.lastCrossing.band, 'FULL');
  } finally { clean(home, proj); }
});

test('SessionStart: FULL with BOTH break-evens in favor caches economical:true + both proofs\' payback numbers for Stop (task #4 condition 2)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Certain fat ~10k tok (fatText 500) + the index over the RE-TIER
    // envelope's arm mark (condition 2b's demotable mass is real) + a usage
    // rate of ~4 sessions/day (stamps) so BOTH carries clear the 3x-store
    // run cost -> FULL/economic with the combined proof armed.
    seedClassB(home, proj, { claudeMdText: fatText(500) + '\n' + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'economic');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.ok(st.lastVerdict.fatTokens >= 5000, `the cached fat is the MEASURED certain fat (got ${st.lastVerdict.fatTokens})`);
    assert.ok(st.lastVerdict.demotableTokens > 0, 'condition 2b: the demotable mass is cached beside the fat proof');
    assert.ok(st.lastVerdict.perDay > 0, 'payback perDay cached for the Stop ask/force');
    assert.ok(st.lastVerdict.reorgPerDay > 0, 'the reorg proof carries its own cached numbers');
    assert.ok(Number.isFinite(st.lastVerdict.breakEvenDays));
    assert.strictEqual(st.lastCrossing.band, 'FULL');
  } finally { clean(home, proj); }
});

test('SessionStart: certain fat armed but only ONE break-even in favor stays OBESE — condition 2 refuses the wizard-ask band on a single proof', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same certain fat as the economic case, but the index sits UNDER the
    // envelope's arm mark -> demotable 0 -> condition 2b fails -> never
    // FULL/economic, however well the fat proof alone pays.
    seedClassB(home, proj, { claudeMdText: fatText(500) + '\n' + muscleText(100), indexBytes: 60 });
    seedState(home, proj, seedUsageStamps({}));
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'OBESE');
    assert.strictEqual(st.lastVerdict.economical, false, 'one proof is not two — the force/ask stays disarmed downstream');
  } finally { clean(home, proj); }
});

test('SessionStart: FULL(externalize) is cached (reason + hardCeilingTokens) and ARMS a crossing — no longer the un-trackable F1 carve', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // 0r: post-floor the wall is fatMultiple x leanFloor clamped at the TRUE
    // capacity ceiling (caliper.mjs CAPACITY_TOKENS = 600000 tok) — so
    // un-armed capHit now needs a floor near capacity itself. footprint
    // 600200 tok; floor 600000 -> bmi ~1.0003 (well under 1.5, NOT armed) but
    // the footprint clears the capacity clamp -> externalize.
    seedClassB(home, proj, { claudeMdBytes: 2400800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 600000 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'externalize is information, delivered by Stop, never printed at SessionStart');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'externalize');
    assert.strictEqual(st.lastVerdict.economical, false, 'externalize never computes/arms economical');
    assert.ok(st.lastVerdict.hardCeilingTokens > 0, 'cached for the Stop advisory to quote');
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'beta.12: externalize now ARMS a crossing (band-uniform), unlike the retired F1 carve');
  } finally { clean(home, proj); }
});

test('growable-full: a large HEALTHY floor (TheColliery-shaped, ~29k) stays LEAN, silent, and arms no crossing', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint = (116332+60)/4 = 29098 tok; floor 29054 -> bmi ~1.0015 (well
    // under the 1.5 ceiling) -> LEAN. Pins the exact live regression case
    // (MEMORY.md "THE CALIBRATION FINDING").
    seedClassB(home, proj, { claudeMdBytes: 116332, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 29054 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'a healthy large floor must never false-fire');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'LEAN');
    assert.strictEqual(st.lastCrossing, undefined);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// Hysteresis (beta.12): the ceiling's Schmitt trigger is the anti-flapping
// guard now (no more time-based snooze) — a store sitting in the dead zone
// [CEILING_REARM_BMI, CEILING_BMI) stays whatever it already was.
// ---------------------------------------------------------------------------

test('hysteresis: a store that armed OBESE and settles into the dead zone stays OBESE (no re-arm needed, no flap to LEAN)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4: the Schmitt lives on MEASURED certain fat now. First boot:
    // ~1,180 tok of duplicate-line fat (>= FAT_ARM_TOKENS 500) arms OBESE
    // (over=true cached). Big recall store keeps carry < wash both boots (0g)
    // so this stays a pure hysteresis test, never economically FULL.
    const mem = seedClassB(home, proj, { claudeMdText: fatText(60) + '\n' + muscleText(40), indexBytes: 0 });
    seedBigRecall(mem);
    const r1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r1);
    const st1 = readProjState(home, proj);
    assert.ok(st1.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st1)})`);
    assert.strictEqual(st1.lastVerdict.overCeiling, true);

    // Second boot: fat drops into the dead zone (FAT_REARM 200 < ~340 tok <
    // FAT_ARM 500). Un-armed-from-scratch this would be LEAN; armed, it must
    // STAY OBESE.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), fatText(18) + '\n' + muscleText(40), 'utf8');
    const r2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r2);
    const st2 = readProjState(home, proj);
    assert.ok(st2.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st2)})`);
    assert.strictEqual(st2.lastVerdict.band, 'OBESE', 'the dead zone holds the PRIOR armed state');
    const st2b = readProjState(home, proj);
    assert.ok(st2b.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st2b)})`);
    assert.strictEqual(st2.lastCrossing.at, st2b.lastCrossing.at, 'no new crossing (same band, no re-arm)');
  } finally { clean(home, proj); }
});

test('hysteresis: certain fat must fall to FAT_REARM_TOKENS or below to actually clear back to LEAN', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdText: fatText(60) + '\n' + muscleText(40), indexBytes: 0 });
    const r1 = run(proj, home, { hook_event_name: 'SessionStart' }); // arms OBESE
    assertGraceful(r1);
    const st1 = readProjState(home, proj);
    assert.ok(st1.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st1)})`);
    assert.strictEqual(st1.lastVerdict.overCeiling, true);

    // Drop to ~170 tok of fat — at/under the 200-tok low-water mark -> clears.
    // This is the CONTINUOUS episode reset task #4 shipped: Quick removing
    // the measured fat ends the episode by measurement, no stamp involved.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), fatText(9) + '\n' + muscleText(40), 'utf8');
    const r2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r2);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'LEAN');
    assert.strictEqual(st.lastVerdict.overCeiling, false);
    assert.strictEqual(st.lastCrossing, undefined, 'LEAN clears the crossing outright');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// STOP HOOK — the once-per-crossing ask/force/advisory channel. Output is the
// structured `{decision:'block', reason}` JSON (rot-canary's exact
// mechanism), not plain stdout.
// ---------------------------------------------------------------------------

function parseBlock(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch (e) {
    // Diagnostic wrap, not a swallow (still throws -> the test still FAILS,
    // no retry-until-green): a bare JSON.parse crash gives no way to tell
    // "the hook wrote nothing" from "the hook wrote garbage" from "the pipe
    // lost the tail" -- the exact ambiguity that made the 2026-07-25 close-
    // before-drain-class CI flake (conductor.test.mjs:885) opaque. Surfacing
    // stdout's own length + raw bytes turns the next occurrence (any cause)
    // into an immediately legible failure instead of a re-derive-from-the-
    // CI-log exercise.
    throw new Error(`parseBlock: stdout was not valid JSON (length=${(stdout || '').length}, raw=${JSON.stringify(stdout)}) -- ${e.message}`);
  }
  assert.strictEqual(j.decision, 'block', 'Stop must use the structured block decision, not plain stdout');
  return j.reason;
}

test('parseBlock: an empty or truncated stdout (the close-before-drain hazard class -- forced directly here, never raced for) throws a DIAGNOSTIC error naming its own length and raw bytes, not a bare opaque JSON.parse crash', () => {
  assert.throws(() => parseBlock(''), (e) => /length=0/.test(e.message) && /parseBlock/.test(e.message), 'empty stdout must self-report as empty, not just "Unexpected end of JSON input"');
  const truncated = '{"decision":"block","rea';
  assert.throws(() => parseBlock(truncated), (e) => e.message.includes(`length=${truncated.length}`) && e.message.includes(JSON.stringify(truncated)), 'a truncated stdout must show its own length + raw bytes so a future occurrence is legible from the failure alone');
  // still fails loud on VALID-JSON-wrong-shape too (the pre-existing assert, untouched) -- this hardening never masks a real defect into a pass.
  assert.throws(() => parseBlock(JSON.stringify({ decision: 'not-block', reason: 'x' })), /must use the structured block decision/);
});

test('0d: an unconsumed OBESE crossing with the DEFAULT (quick) exercise auto-runs — no ask, standing config authorizes it, then self-consumes', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
    });
    const r1 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r1);
    const reason = parseBlock(r1.stdout);
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('fat ~1234 tok'), reason);
    assert.ok(!reason.includes('question tool'), '0d: no ask — the exercise config itself is the standing consent');
    assert.ok(!reason.includes('ทำ'), reason);
    assert.ok(reason.includes('standing config authorizes'), reason);
    assert.ok(reason.includes('Quick pass NOW, no ask'), reason);
    assert.ok(reason.includes('oneLineResult'), 'the directive names pushing ONLY the one-line result');
    assert.ok(reason.includes('snapshot-backed and revertible'), reason);
    assert.ok(reason.includes('once per crossing, not per session'), reason);
    assert.ok(reason.includes("Answer the user's ORIGINAL message"), 'answer-first reminder present (queue item 0)');

    const r2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'consumed at emission — a second Stop for the SAME crossing stays silent');

    // 0e: Quick was auto-triggered -> quickTried is now recorded, the loop's
    // gate for a future same-band escalation once mechanical cutting proves
    // insufficient.
    assert.strictEqual(readProjState(home, proj).quickTried, true);
  } finally { clean(home, proj); }
});

test('F3: a LEGACY config carrying exercisePerBand.obese=full still auto-runs Quick silently — the per-band clamp reads it as quick; OBESE never asks, no matter what', () => {
  const { home, proj } = sandbox();
  try {
    // The pre-beta.14 escape hatch: this exact config used to route the
    // OBESE crossing to the ceilingAsk. The 0f ruling killed it (main-
    // adjudicated); safer-value-wins clamps the value at READ time — the
    // user's config file itself is never rewritten, and the other band's
    // customization would survive (config-schema.test.mjs pins that half).
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ exercisePerBand: { obese: 'full', full: 'full' } }), 'utf8');
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
    });
    const r1 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r1);
    const reason = parseBlock(r1.stdout);
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('standing config authorizes'), 'the auto-Quick directive fires, not an ask');
    assert.ok(!reason.includes('question tool'), 'OBESE never asks — the legacy full value cannot re-open the ask path');
    assert.ok(!reason.includes('ทำ'), reason);
    assert.strictEqual(readProjState(home, proj).quickTried, true, 'the auto-Quick marked the episode, same as the default path');

    const r2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'consumed at emission — a second Stop for the SAME crossing stays silent');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0f "AUTHORITATIVE 3-FLOW" (MEMORY.md, supersedes 0e "THE OBESE LOOP" — same
// growth-gated mechanism, trigger band relocated OBESE->FULL): a force-run
// already tried Quick this episode; FULL persists (or returns) -> escalate
// to the wizard's semantic tier instead of re-running the (already proven
// insufficient) mechanical pass, gated on fat having genuinely GROWN since
// the last time this was flagged (never a clock/re-nag on a static plateau).
// OBESE never escalates any more — 0d makes it auto-Quick-silent, full stop.
// ---------------------------------------------------------------------------

test('0f: an OBESE crossing NEVER routes to the wizard ask any more — even a stale escalation:true flag (old-version leftover state) degrades to the ordinary auto-Quick directive', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      quickTried: true,
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false, escalation: true },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 900, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('standing config authorizes'), '0f: OBESE is always auto-Quick-silent, regardless of any stale escalation flag');
    assert.ok(!reason.includes('question tool'), '0f: OBESE never asks any more');
    assert.ok(!reason.includes('/coalwash wizard'), 'no wizard route for OBESE');
  } finally { clean(home, proj); }
});

test('0f: FULL persisting after a force-run already ran Quick this episode escalates to the wizard ask, not another force-run (closes the endless forceAuto loop 0f fixes)', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      quickTried: true,
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false, escalation: true },
      // a plain FULL crossing would ALSO satisfy the (now unconditional)
      // force branch — proves the escalation check's priority ordering.
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 900, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('no cutter for this class of fat'), reason);
    assert.ok(reason.includes('certain fat (~900 tok'), reason);
    assert.ok(reason.includes('measured'), 'the ask names the fat as MEASURED certain fat (task #4), never a floor inference');
    assert.ok(reason.includes('question tool'), 'a REAL ask — the semantic escalation needs consent');
    assert.ok(reason.includes('ทำ'), reason);
    assert.ok(reason.includes('/coalwash'), reason);
    assert.ok(reason.includes('Fat + reorganize muscle'), reason);
    assert.ok(!reason.includes('standing config authorizes'), 'never auto-runs again — mechanical cutting already proved insufficient, and the escalation check wins priority over the force branch');
    assert.ok(reason.includes("Answer the user's ORIGINAL message"), 'answer-first reminder present');
  } finally { clean(home, proj); }
});

test('0f: FULL force-run marks quickTried too (Force always runs Quick) — the wizard-escalation leg needs this', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL band crossed'), reason); // seeded state has no wall-byte baseline -> the fallback headline
    assert.strictEqual(readProjState(home, proj).quickTried, true, 'Force running Quick counts toward the wizard-escalation leg\'s "already tried mechanically" state');
  } finally { clean(home, proj); }
});

test('round trip: a FULL force-run followed by a FULL plateau (still over cap, quickTried set) arms an escalation crossing the following Stop delivers as the wizard ask — proves FLOW 1 end-to-end through two real SessionStarts', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4: an economical FULL fixture — measured certain fat + demotable
    // index + a usage rate that pays both proofs (the same trio the
    // 'BOTH break-evens' SessionStart test pins).
    seedClassB(home, proj, { claudeMdText: fatText(500) + '\n' + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    const rs1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs1);
    const rp1 = run(proj, home, { hook_event_name: 'Stop' }); // force-fires, marks quickTried
    assertGraceful(rp1);
    // reason=economic -> the 0m break-even headline.
    assert.ok(parseBlock(rp1.stdout).includes('break-even proven'), rp1.stdout);
    assert.strictEqual(readProjState(home, proj).quickTried, true);

    // Second SessionStart: the fixture is unchanged on disk (simulates "the
    // Quick pass ran but wasn't enough" — real, e.g. a keeps-gate exclusion
    // blocked the cut) -> still FULL, same band as before (no rise) -> arms
    // the escalation branch instead of a fresh plain crossing.
    const rs2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs2);
    const st2 = readProjState(home, proj);
    assert.ok(st2.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st2)})`);
    assert.strictEqual(st2.lastCrossing.band, 'FULL');
    assert.strictEqual(st2.lastCrossing.escalation, true, 'the plateau after a tried Quick arms the wizard-escalation crossing');

    const rp2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp2);
    const reason2 = parseBlock(rp2.stdout);
    assert.ok(reason2.includes('no cutter for this class of fat'), reason2);
    assert.ok(!reason2.includes('standing config authorizes'), 'no more silent auto-force-loop — this is a real ask now');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0g "FULL = THE ECONOMIC CUT-POINT" — conductor-level: the economic FULL
// (armed ceiling + break-even, NO wall hit) drives the same force pipeline
// the wall's FULL always did, and the Q2 latch persists across real
// SessionStarts through a fresh-proof dip, ending only at the LEAN reset.
// ---------------------------------------------------------------------------

test('0g round trip: an armed store past the break-even (well under the wall) verdicts FULL/economic and the following Stop force-fires on it', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4: measured certain fat + demotable index + a paying usage rate —
    // the combined proof (conditions 2a AND 2b) arms FULL/economic, far under
    // any capacity line.
    seedClassB(home, proj, { claudeMdText: fatText(500) + '\n' + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'economic');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.strictEqual(st.lastVerdict.econLatched, true, 'the episode latch is cached for the next gauge');
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the rise (LEAN default past) armed a crossing');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    const reason = parseBlock(rp.stdout);
    assert.ok(reason.includes('FULL band + break-even proven'), reason);
    assert.strictEqual(readProjState(home, proj).quickTried, true, 'the economic FULL force marks quickTried — the wizard leg keys on it');
  } finally { clean(home, proj); }
});

test('0g Q2 round trip: the latch holds FULL across real SessionStarts through a fresh-proof dip, and the LEAN reset ends the episode', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Session 1: economic FULL arms + latches (same fixture as above).
    const mem = seedClassB(home, proj, { claudeMdText: fatText(500) + '\n' + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st1 = readProjState(home, proj);
    assert.ok(st1.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st1)})`);
    assert.strictEqual(st1.lastVerdict.reason, 'economic');
    assert.strictEqual(st1.lastVerdict.econLatched, true);
    const crossingAt = st1.lastCrossing.at;

    // Session 2: the recall store balloons -> the run cost (3x the WHOLE
    // store) now dwarfs both carries -> the FRESH combined proof dips false.
    // The fat Schmitt stays armed (the certain fat is unchanged on disk) ->
    // the latch must hold the band at FULL — no flap back to OBESE, no new
    // crossing.
    seedBigRecall(mem);
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st2 = readProjState(home, proj);
    assert.ok(st2.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st2)})`);
    assert.strictEqual(st2.lastVerdict.band, 'FULL', 'Q2: the latch holds the band through the dip');
    assert.strictEqual(st2.lastVerdict.reason, 'economic');
    assert.strictEqual(st2.lastVerdict.econLatched, true);
    assert.strictEqual(st2.lastVerdict.economical, false, 'the FORCE disarms on the dipped fresh proof (economic-dominance: numbers must hold at every fire)');
    assert.strictEqual(st2.lastCrossing.at, crossingAt, 'same band -> the pending crossing is untouched, nothing re-arms');

    // Session 3: the certain fat is REMOVED (what Quick does) -> fat falls
    // under the re-arm mark -> LEAN -> the episode ends BY MEASUREMENT: latch
    // cleared, crossing cleared. This is task #4's continuous reset — no
    // post-clean floor stamp exists or is needed.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), muscleText(100), 'utf8');
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st3 = readProjState(home, proj);
    assert.ok(st3.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st3)})`);
    assert.strictEqual(st3.lastVerdict.band, 'LEAN');
    assert.strictEqual(st3.lastVerdict.econLatched, false, 'the LEAN reset clears the latch');
    assert.strictEqual(st3.lastCrossing, undefined, 'LEAN clears the pending crossing outright');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0j "BMI ON AT INSTALL — provisional floor": the first conductor gauge of a
// never-seen store stamps floor = footprint (BMI 1.00 live day one); growth
// since install drives the whole 0f/0g flow through the provisional floor;
// the WALL keeps its day-one absolute-cap diagnosis.
// ---------------------------------------------------------------------------

test('task #4 round trip: day one is a MEASURED gauge — no floor stamp of any kind, LEAN on distinct content, no crossing', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdText: muscleText(300), indexBytes: 60 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.leanFloorTokens, undefined, 'task #4: the conductor stamps NO floor — provisional or otherwise; fat and muscle are measured fresh every gauge');
    assert.notStrictEqual(st.leanFloorProvisional, true);
    assert.strictEqual(st.lastVerdict.band, 'LEAN', 'distinct content = measured muscle = silence, from the first gauge');
    assert.strictEqual(st.lastCrossing, undefined);
  } finally { clean(home, proj); }
});

test('task #4 ACCEPTANCE round trip (the dispatch fixture, through the REAL hook): all-muscle growth across sessions NEVER arms a band — the retired growth-since-install flow was the false positive', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Replay the live false-positive sequence's footprints as DISTINCT content
    // through real SessionStarts: fat readings 36,233 -> 28,961 -> 37,499 ->
    // 39,250 against the frozen install floor were pure muscle growth. Every
    // boot must stay LEAN and silent; the old definition fired FULL here and a
    // stamp-based fix fires somewhere in the sequence too.
    // muscleText lines are ~78 B ≈ 19.5 tok; counts approximate the real footprints.
    // (seedClassB also creates the CC slug dir — without it the never-create
    // guard routes state to the coal/ fallback and readProjState finds nothing.)
    seedClassB(home, proj, { claudeMdText: muscleText(3300), indexBytes: 60 });
    // The live incident's FROZEN floor, seeded as inert history. The new
    // engine never reads it; the OLD engine turns it into a ~57,666-tok wall
    // (fatMultiple 2.0 x 28,833) that footprints 1/3/4 of this sequence
    // cross — which is exactly the red-first replay: this same test, run
    // against the pre-fix hook, goes RED at the LEAN assertion below.
    seedState(home, proj, { leanFloorTokens: 28833, leanFloorProvisional: false, leanFloorAt: Date.now() - 7 * 86400000 });
    for (const linesCount of [3300, 2950, 3400, 3480]) {
      fs.writeFileSync(path.join(proj, 'CLAUDE.md'), muscleText(linesCount), 'utf8');
      const r = run(proj, home, { hook_event_name: 'SessionStart' });
      assertGraceful(r);
      assert.strictEqual(r.stdout, '');
      const st = readProjState(home, proj);
      assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
      assert.strictEqual(st.lastVerdict.band, 'LEAN', 'muscle growth at ~' + linesCount + ' lines must stay silent');
      assert.strictEqual(st.lastCrossing, undefined, 'no crossing ever arms on muscle growth');
      const rp = run(proj, home, { hook_event_name: 'Stop' });
      assertGraceful(rp);
      assert.strictEqual(rp.stdout, '', 'Stop is silent too — no force, no ask, no advisory, the whole sequence');
    }
  } finally { clean(home, proj); }
});

test('task #4 control (non-vacuity for the acceptance): the SAME growth WITH real duplicate fat arms the band through the same hook', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const mem = seedClassB(home, proj, { claudeMdText: muscleText(2950) + '\n' + fatText(60), indexBytes: 60 });
    seedBigRecall(mem); // keeps it OBESE (carry < wash), the quiet-but-armed shape
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'OBESE', 'the silence above is the definition working, not a dead band');
    assert.strictEqual(st.lastCrossing.band, 'OBESE');
  } finally { clean(home, proj); }
});

// task #4 supersedes the 0r fixture: the old test pinned "a day-one store over
// the OLD static wall reads LEAN because the provisional floor absorbs it" —
// the same silence now holds WITHOUT any floor, because the content is
// distinct (measured muscle). The zero-cut force loop stays dead, one
// mechanism earlier.
test('0r superseded by task #4: a day-one store over every RETIRED wall reads LEAN on measured muscle — no floor needed to absorb anything', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdText: muscleText(1860), indexBytes: 0 }); // ~36k tok, over the retired 36000 static wall
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.leanFloorTokens, undefined, 'no stamp exists to absorb anything — the measurement itself is the absorber');
    assert.strictEqual(st.lastVerdict.band, 'LEAN');
    assert.strictEqual(st.lastCrossing, undefined, 'LEAN arms no crossing -> no force, no ask, no receipt');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.strictEqual(rp.stdout, '', 'silent — the exact zero-cut force loop the live bug produced is gone');
  } finally { clean(home, proj); }
});

test('task #4: a day-one store AT THE TRUE CAPACITY CLAMP with no measured fat routes FULL/externalize — the 0j provisional hedge is retired with the baseline it hedged', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // fp ~600200 tok of DISTINCT bytes ('a'-run content is one giant line —
    // no duplicate lines, and mostly past the read budget anyway: both roads
    // lead to mechFat 0 = measured muscle).
    seedClassB(home, proj, { claudeMdBytes: 2400800, indexBytes: 0 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'externalize', 'task #4: "all muscle" is MEASURED now (mechFat 0), not inferred from a day-one stamp — the externalize advice is honest immediately');
    assert.strictEqual(st.leanFloorTokens, undefined, 'no provisional stamp accompanies the verdict');
    assert.strictEqual(st.lastVerdict.economical, false, 'externalize never arms the force/ask');
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the crossing arms — Stop delivers the externalize ADVISORY once');
  } finally { clean(home, proj); }
});

test('rc.2 cross-version un-strand: an OLD-state store carrying a CONSUMED pre-0m crossing migrates (schema stamped, legacy crossing cleared, legacy floor bytes preserved) and the fresh MEASURED re-gauge re-enrolls it', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Real duplicate fat on disk so the fresh gauge has something to arm on
    // (task #4: bands need MEASURED fat; a stranded store whose content is all
    // muscle correctly re-enrolls to LEAN and stays silent).
    const mem = seedClassB(home, proj, { claudeMdText: muscleText(200) + '\n' + fatText(60), indexBytes: 0 });
    seedBigRecall(mem); // OBESE (carry < wash) — enough to prove re-enrollment
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: 500, consumed: true }, quickTried: true, quickTriedAt: 400, lastEscalationFat: 9000,
      lastVerdict: { band: 'FULL', reason: 'absolute-cap' },
      leanFloorTokens: 9000, leanFloorProvisional: false, leanFloorAt: 100, stamps: [{ t: 100, fp: 9000 }],
    }, { stateSchema: undefined });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.stateSchema, 1, 'the schema is stamped current at the relocated per-project file');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false, 'the legacy single-file store is drained + removed after the relocation');
    assert.strictEqual(st.leanFloorTokens, 9000, 'legacy floor bytes survive the migration untouched (harmless history — task #4 just stopped READING them)');
    assert.strictEqual(st.lastVerdict.band, 'OBESE', 'the fresh gauge re-measures and lands where the CONTENT says, not where the stranded cache said');
    assert.strictEqual(st.lastCrossing.band, 'OBESE');
    assert.strictEqual(st.lastCrossing.consumed, false, 'the un-strand: the legacy consumed crossing is gone; a FRESH unconsumed crossing arms — Stop can act on it');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0m "FORCE = THE FREE TIER, NO PROOF NEEDED" + "FORCE IS A DICTATOR" — the
// user's live day-one scenario, end-to-end: WALL day one → silent forced
// Quick (wall-numbers headline) → re-gauge still over → the ONE wizard ask →
// store shrinks under the wall → silence. The heavier band never again does
// less than OBESE.
// ---------------------------------------------------------------------------

test('0m round trip (the user\'s live scenario, at true capacity): over the TRUE capacity clamp WITH measured fat → forceAuto (NOT an ask) → quickTried → still-over re-gauge → wizardEscalation → shrink under wall → silence', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4: absolute-cap = capHit AND measured fat armed. The giant global
    // CLAUDE.md ('a' run, ~600k tok) carries the store past the TRUE capacity
    // clamp but is never read (over the read budget) -> counted as muscle; the
    // small project CLAUDE.md carries real duplicate fat the estimator reads.
    seedClassB(home, proj, { claudeMdText: fatText(40), indexBytes: 60 });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'a'.repeat(2400800), 'utf8');
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st1 = readProjState(home, proj);
    assert.ok(st1.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st1)})`);
    assert.strictEqual(st1.leanFloorTokens, undefined, 'task #4: no floor stamp, day one or ever');
    assert.strictEqual(st1.lastVerdict.reason, 'absolute-cap');
    assert.ok(st1.lastVerdict.fatTokens >= 500, 'the fat that arms the cap route is MEASURED, not inferred');

    // Stop #1: the force directive fires UNCONDITIONALLY — the exact point
    // the live bug missed (it asked instead).
    const rp1 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp1);
    const reason1 = parseBlock(rp1.stdout);
    assert.ok(reason1.includes('over the capacity wall'), reason1);
    assert.ok(reason1.includes('non-optional at FULL'), reason1);
    assert.ok(!reason1.includes('question tool'), 'force, not an ask');
    assert.ok(!reason1.includes('undefined') && !reason1.includes('null') && !reason1.includes('NaN'), reason1);
    assert.strictEqual(readProjState(home, proj).quickTried, true, 'the forced run marked the episode');

    // Consume-once: a second Stop on the same crossing is silent.
    const rp1b = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp1b);
    assert.strictEqual(rp1b.stdout, '', 'consume-once intact');

    // Re-gauge, store unchanged (the Quick could not shrink it under the
    // wall) -> still over + quickTried -> the ONE wizard ask arms (0f leg).
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st2 = readProjState(home, proj);
    assert.ok(st2.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st2)})`);
    assert.strictEqual(st2.lastCrossing.band, 'FULL');
    assert.strictEqual(st2.lastCrossing.escalation, true, 'still over + quickTried -> the ONE wizard ask arms');

    const rp2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp2);
    const reason2 = parseBlock(rp2.stdout);
    assert.ok(reason2.includes('no cutter for this class of fat'), reason2);
    assert.ok(reason2.includes('question tool'), 'the wizard ask is the ONE ask in the system');

    // (g) The store shrinks under everything (as if the wizard cleaned it):
    // band machinery ends the episode — silence, nothing more fires.
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'small distinct note', 'utf8');
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), muscleText(40), 'utf8');
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st3 = readProjState(home, proj);
    assert.ok(st3.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st3)})`);
    assert.strictEqual(st3.lastVerdict.band, 'LEAN');
    assert.strictEqual(st3.lastCrossing, undefined, 'LEAN clears the episode');
    const rp3 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp3);
    assert.strictEqual(rp3.stdout, '', 'below FULL after force -> silence, per the ruling: "ถ้า lean ได้หรือหดลงต่ำกว่านิยาม FULL → จบ ไม่มีอะไร"');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// WARP-HOLE (beta.13 item 3) — the Stop hook's gated re-gauge: a
// within-session spike (files changed on disk AFTER the last SessionStart,
// BEFORE Stop fires with nothing pending) is caught this turn instead of
// waiting for the next SessionStart.
// ---------------------------------------------------------------------------

test('WARP-HOLE: a within-session spike (a file grown well past REGAUGE_DELTA_TOKENS) is caught at Stop — arms a fresh crossing and delivers it the SAME turn', () => {
  const { home, proj } = sandbox();
  try {
    // Seed a LEAN baseline exactly as a prior SessionStart would have cached
    // it: small CLAUDE.md + index, a floor that makes a later grow cross the
    // OBESE ceiling (bmi 1.5 at leanFloorTokens=4000 -> footprint 6000 tok).
    // Big recall store: keeps the spiked band OBESE (carry < wash, 0g), so
    // this stays the auto-Quick-directive delivery test it always was.
    const mem = seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 60 });
    seedBigRecall(mem);
    const claudeMd = path.join(proj, 'CLAUDE.md');
    const memIndex = path.join(mem, 'MEMORY.md');
    seedState(home, proj, {
      lastVerdict: { band: 'LEAN', reason: 'fat', economical: false, fatTokens: 0, overCeiling: false, alwaysLoadedPaths: [claudeMd, memIndex], alwaysLoadedBytes: 160, at: Date.now() },
      // no lastCrossing -> the "nothing pending" path the gate exists for.
    });

    // The within-session spike: CLAUDE.md grows by ~5.5KB of REAL duplicate
    // fat (task #4: the band arms on MEASURED fat) — a paste-duplication-
    // shaped write, well past REGAUGE_DELTA_TOKENS.
    fs.writeFileSync(claudeMd, fatText(70), 'utf8');

    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    // measured fat ~1380 tok >= FAT_ARM -> OBESE (big recall: carry < wash),
    // default exercise=quick -> 0d's auto-Quick directive fires THIS turn.
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('standing config authorizes'), reason);

    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'OBESE', 'the cached verdict was refreshed by the gated re-gauge');
    assert.ok(st.lastVerdict.alwaysLoadedBytes > 160, 'the WARP-HOLE baseline was updated to the fresh measurement');
    assert.strictEqual(st.lastCrossing.consumed, true, 'delivered and consumed in the SAME Stop call');
  } finally { clean(home, proj); }
});

test('WARP-HOLE: a small/incidental change (well under REGAUGE_DELTA_TOKENS) never trips the gate — stays silent, cache untouched (the happy-path cost)', () => {
  const { home, proj } = sandbox();
  try {
    const mem = seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 60 });
    const claudeMd = path.join(proj, 'CLAUDE.md');
    const memIndex = path.join(mem, 'MEMORY.md');
    seedState(home, proj, {
      leanFloorTokens: 4000,
      lastVerdict: { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, overCeiling: false, alwaysLoadedPaths: [claudeMd, memIndex], alwaysLoadedBytes: 160, at: Date.now() },
    });
    // A tiny edit -- +50 bytes, ~12 tok, far under REGAUGE_DELTA_TOKENS (500).
    fs.writeFileSync(claudeMd, 'a'.repeat(150), 'utf8');

    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'the cheap gate did not trip -> no full re-gauge, no crossing, silent');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.alwaysLoadedBytes, 160, 'the cached baseline is UNTOUCHED — no re-gauge ran at all');
  } finally { clean(home, proj); }
});

test('WARP-HOLE: no cached alwaysLoadedPaths yet (an old state file predating this feature, or a brand-new project) degrades safely — no gate, no crash, identical to today', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 60 });
    seedState(home, proj, {
      leanFloorTokens: 4000,
      lastVerdict: { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, overCeiling: false, at: Date.now() }, // no alwaysLoadedPaths/Bytes at all
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// rc.2 LONG-SESSION growth-gate: a user who drags ONE long session (never
// opens a new one) after pressing "later" still re-offers when fat GROWS —
// via the SAME Stop warp-hole re-gauge that catches within-session spikes.
// The escalation branch (FULL + quickTried + fat > lastEscalationFat) fires
// mid-session; no new SessionStart, no timer. Grown -> re-arm; flat -> silent.
// ---------------------------------------------------------------------------
function seedPostForceFull(home, proj, { fatCopies, lastEscalationFat, escalation = false }) {
  // A long session mid-episode: a force already ran (quickTried set), the store
  // is still FULL. task #4 re-base: the FULL standing must be MEASURABLE at the
  // Stop warp re-gauge — real duplicate fat on disk (fatText) plus an index
  // past the CC line cap (capHit -> absolute-cap) — not just a cached verdict
  // CLAIMING FULL. The consumed crossing's SHAPE picks the next leg:
  //   escalation:false (plain-consumed) = a force just ran, ask pending → the
  //     next re-gauge ASKS; escalation:true = an ask already fired → the next
  //     growth FORCES first (force-then-ask). This is what the Stop warp reads.
  const mem = seedClassB(home, proj, {
    claudeMdText: fatText(fatCopies),
    indexText: Array.from({ length: 220 }, (_, i) => `row ${i}`).join(String.fromCharCode(10)), // 220 lines >= CC_INDEX_CAP_LINES
  });
  const claudeMd = path.join(proj, 'CLAUDE.md');
  const claudeMdBytes = fs.statSync(claudeMd).size;
  const lastCrossing = { band: 'FULL', at: Date.now() - 10000, consumed: true, session: 'sess-A' };
  if (escalation) lastCrossing.escalation = true;
  seedState(home, proj, {
    quickTried: true,
    lastEscalationFat,
    lastCrossing,
    lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: false, fatTokens: lastEscalationFat, overCeiling: true, alwaysLoadedPaths: [claudeMd], alwaysLoadedBytes: claudeMdBytes, at: Date.now() },
  });
  return { mem, claudeMd };
}

test('rc.2 LONG SESSION (grown): fat grows PAST lastEscalationFat within ONE session (no new SessionStart) -> the Stop warp-hole re-gauge arms the escalation + delivers the wizard ask THIS turn (the drag-one-session re-offer)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // FULL store post-force+later; fatText(1411) measures 1410x20 = 28200 fat.
    const { claudeMd } = seedPostForceFull(home, proj, { fatCopies: 1411, lastEscalationFat: 28200 });
    // MID-SESSION growth: +200 fat copies (~4000 tok) -> fat 32200 > 28200, and
    // the footprint delta clears REGAUGE_DELTA_TOKENS (500).
    fs.writeFileSync(claudeMd, fatText(1611), 'utf8');
    const r = run(proj, home, { hook_event_name: 'Stop' }); // SAME session — a Stop, never a SessionStart
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('question tool'), 'the wizard ask fired mid-session on fat growth: ' + reason);
    assert.ok(reason.includes('no cutter for this class of fat'), reason);
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.ok(st.lastEscalationFat > 28200, 'the escalation re-armed at the NEW higher fat (branch 3 fired in the Stop path), not the seeded level');
    assert.strictEqual(st.lastCrossing.escalation, true, 'a wizard-escalation crossing (0f), armed + consumed the same turn');
  } finally { clean(home, proj); }
});

test('rc.2 LONG SESSION (flat): fat does NOT move across turns in one session -> the Stop hook stays SILENT (the plateau is silent because fat did not grow, NOT because of any cooldown/timer)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedPostForceFull(home, proj, { fatCopies: 1411, lastEscalationFat: 28200 });
    // NO growth. Two consecutive Stops — both silent (flat = no delta = no
    // re-gauge = no re-arm; there is no "recently asked" suppression involved).
    const r1 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r1);
    assert.strictEqual(r1.stdout, '', 'flat fat -> silent');
    const r2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'still silent on the next turn — a plateau never re-nags');
    assert.strictEqual(readProjState(home, proj).lastEscalationFat, 28200, 'no re-arm — lastEscalationFat unchanged');
  } finally { clean(home, proj); }
});

test('rc.2 LONG SESSION (force clears it): a growth fires the FORCE; if that free sweep drops the store BELOW FULL the episode ends SILENT — NO ask (the ask follows ONLY a force that left the store over; force-then-ask, not force-then-always-ask)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // post-ask seed → the growth lands on the FORCE leg.
    const { claudeMd, mem } = seedPostForceFull(home, proj, { fatCopies: 1411, lastEscalationFat: 28200, escalation: true });
    fs.writeFileSync(claudeMd, fatText(1611), 'utf8'); // growth
    const rF = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rF);
    assert.ok(parseBlock(rF.stdout).length > 0 && !parseBlock(rF.stdout).includes('question tool'), 'the growth turn fires the FORCE, not the ask');
    // the free sweep worked: fat cut to zero AND the index brought back under
    // the CC cap (as if Quick cut the duplicates and the index was rebuilt).
    fs.writeFileSync(claudeMd, muscleText(40), 'utf8'); // distinct content, mechFat 0 -> LEAN
    fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'i'.repeat(60), 'utf8');
    const rClean = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rClean);
    assert.strictEqual(rClean.stdout, '', 'force was enough → below FULL → SILENT, no ask');
  } finally { clean(home, proj); }
});

test('rc.2 LONG SESSION (dictator / no throttle): fat growing EVERY turn re-fires FORCE→ASK alternating, one event per growth step, lastEscalationFat climbing on the ask turns — no cooldown/min-interval ever suppresses a rapid-growth re-fire (USER decision B: force-then-ask; 0e: frequency MIRRORS the fat-growth rate)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // POST-ASK seed (escalation-consumed): the first growth this session lands
    // on the FORCE leg, so the sequence is a clean force → ask → force → ask.
    const { claudeMd } = seedPostForceFull(home, proj, { fatCopies: 1411, lastEscalationFat: 28200, escalation: true });
    let prevFlagged = 28200;
    const kinds = [];
    // Each turn grows +200 fat copies (~4000 tok), well past REGAUGE_DELTA (500)
    // and the previous level — every turn MUST fire something (never silent).
    for (const copies of [1611, 1811, 2011, 2211]) {
      fs.writeFileSync(claudeMd, fatText(copies), 'utf8');
      const r = run(proj, home, { hook_event_name: 'Stop' }); // consecutive Stops, ONE session
      assertGraceful(r);
      const reason = parseBlock(r.stdout);
      assert.ok(reason.length > 0, `growth turn @${copies} fat copies must re-fire (dictator, no throttle)`);
      const isAsk = reason.includes('question tool');
      kinds.push(isAsk ? 'ASK' : 'FORCE');
      if (isAsk) {
        const flagged = readProjState(home, proj).lastEscalationFat;
        assert.ok(flagged > prevFlagged, `an ASK turn climbs lastEscalationFat (${prevFlagged} -> ${flagged})`);
        prevFlagged = flagged;
      }
    }
    // force-THEN-ask, one event per growth lump: the free Quick sweep runs on
    // each new lump BEFORE the ask (USER decision B) — never ask-only, never
    // force-only, never a silent throttled turn.
    assert.deepStrictEqual(kinds, ['FORCE', 'ASK', 'FORCE', 'ASK'], 'each growth lump = FORCE first, then its ASK on the next growth — force-then-ask, no throttle');
  } finally { clean(home, proj); }
});

test('Stop: an OBESE ask carries the break-even payback line when it is cached (queue 0c — was FULL-only before)', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 500, perDay: 200, breakEvenDays: 3.2, floorUnmeasured: false, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('~200 tok/day'), reason);
    assert.ok(reason.includes('pays back in ~4 day(s)'), reason);
  } finally { clean(home, proj); }
});

test('0m: a FULL crossing force-runs UNCONDITIONALLY — a disarmed break-even (economical:false, absolute-cap) is NOT an ask any more, the exact live bug', () => {
  const { home, proj } = sandbox();
  try {
    // Pre-0m this exact state (absolute-cap + economical:false) fell through
    // to the ceilingAsk — the heavier band did LESS than OBESE. The free
    // tier needs no economic proof.
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: false, fatTokens: 2500, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL band crossed (fat ~2500 tok)'), reason); // no cached wall bytes -> the honest fallback headline
    assert.ok(reason.includes('non-optional at FULL'), reason);
    assert.ok(reason.includes('Quick pass NOW'), reason);
    assert.ok(!reason.includes('question tool'), 'force never asks');
    assert.strictEqual(readProjState(home, proj).quickTried, true);
  } finally { clean(home, proj); }
});

test('0m: a FULL crossing emits the force directive with the payback numbers when cached — and never an ask', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, perDay: 1200, breakEvenDays: 2, floorUnmeasured: false, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL band crossed (fat ~4004 tok)'), reason);
    assert.ok(reason.includes('non-optional at FULL'), reason);
    assert.ok(reason.includes('Quick pass NOW'), reason);
    assert.ok(reason.includes('stage-only'), reason);
    assert.ok(reason.includes('snapshot-backed'), reason);
    assert.ok(reason.includes('once per crossing, not per session'), reason);
    assert.ok(reason.includes('~1200 tok/day'), 'the force directive also shows the payback numbers');
    assert.ok(!reason.includes('question tool'), 'force never asks');
  } finally { clean(home, proj); }
});

test('0m: a LEGACY config carrying forceMode:"ask" is read-tolerated and IGNORED — force still fires (the knob is dead)', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ forceMode: 'ask' }), 'utf8');
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('non-optional at FULL'), reason);
    assert.ok(!reason.includes('question tool'), 'the legacy knob cannot re-open an ask path');
    assert.strictEqual(readProjState(home, proj).quickTried, true);
  } finally { clean(home, proj); }
});

test('0m: a LEGACY config carrying forceMode:"off" is likewise IGNORED — there is NO off switch; force fires and the crossing consumes once', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ forceMode: 'off' }), 'utf8');
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('non-optional at FULL'), 'the OS-maintenance model: no veto — the only full stop is coalwashMode:off');
    assert.ok(!reason.includes('question tool'), 'force never asks');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastCrossing.consumed, true, 'consumed at emission, same as every other surfaced crossing');
    const r2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'consume-once intact — the SAME crossing never re-fires');
  } finally { clean(home, proj); }
});

test('Stop: a FULL(externalize) crossing delivers the pure-information advisory — never an ask, never force', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'externalize', economical: false, fatTokens: 200, hardCeilingTokens: 36000, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL (externalize)'), reason);
    assert.ok(reason.includes('~36000 tok'), reason);
    assert.ok(reason.includes('no reclaimable fat'), 'names WHY washing cannot help');
    assert.ok(!reason.includes('question tool'), 'externalize is information, never an ask');
    assert.ok(!reason.includes('standing config authorizes'), 'externalize never force-runs');
  } finally { clean(home, proj); }
});

test('Stop: nothing pending is silent, exit 0, and creates no state file at all', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'the silent path never writes state');
  } finally { clean(home, proj); }
});

test('main() dispatch: an unreadable/unrecognized event (readStdinJson -> {}) is SILENT, never guessed as SessionStart (Phoenix #12/#13)', () => {
  const { home, proj } = sandbox();
  try {
    // Deterministic repro of the Windows-CI stdin-race class WITHOUT racing a
    // real pipe: a Stop payload that fails to arrive intact resolves
    // readStdinJson() -> {} via the exact same JSON.parse-catch path as no
    // stdin at all, so omitting input forces the identical {} result on
    // demand. A fresh sandbox home has no update stamp yet (mode defaults to
    // 'auto', updateMode to 'ask'), so if main() mis-routed this unrecognized
    // event to handleSessionStart, updateDue() would fire and print the
    // self-update line -> the exact CI failure this pins ("Stop: nothing
    // pending is silent..." expected '' got '[CoalWash] [self-update due] ...').
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'an unrecognized event must never print the SessionStart self-update line');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', 'coal', 'coalwash', 'update-check')), false, 'handleSessionStart (and its updateDue side effect) must never have run at all');
  } finally { clean(home, proj); }
});

test('Stop: an already-consumed crossing never re-emits', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, { lastCrossing: { band: 'OBESE', at: Date.now(), consumed: true } });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('Stop: a malformed/unknown-band/LEAN-band/retired-PLUMP lastCrossing is silent, never throws', () => {
  const cases = [
    { band: 'LEAN', at: Date.now(), consumed: false }, // LEAN is never a crossing target
    { band: 'PLUMP', at: Date.now(), consumed: false }, // retired by the band collapse -> unknown
    { band: 'GARBAGE', at: Date.now(), consumed: false },
    { band: 'OBESE', at: Date.now() + 60 * 60 * 1000, consumed: false }, // future timestamp
    { band: 'OBESE' }, // missing `at`
    'just a string',
    42,
    [],
  ];
  for (const lastCrossing of cases) {
    const { home, proj } = sandbox();
    try {
      seedState(home, proj, { lastCrossing });
      const r = run(proj, home, { hook_event_name: 'Stop' });
      assertGraceful(r);
      assert.strictEqual(r.stdout, '', `case ${JSON.stringify(lastCrossing)} must stay silent`);
    } finally { clean(home, proj); }
  }
});

test('Stop: coalwashMode=off silences even a pending crossing (the master switch wins)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { coalwashMode: 'off' });
    seedState(home, proj, { lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false } });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SessionStart -> Stop round trips (recordVerdict's cache is the Stop hook's
// data source; recordCrossing/sanitizeCrossing are the once-per-crossing
// counterpart — post-0m the ONE hot-path sanitizer).
// ---------------------------------------------------------------------------

test('round trip: a FULL-economical SessionStart records a crossing the following Stop reads and force-fires on', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // task #4 economic-FULL fixture: measured certain fat + an over-envelope
    // index (condition 2b's demotable mass) + ~4 sessions/day of stamps.
    seedClassB(home, proj, { claudeMdText: fatText(500) + String.fromCharCode(10) + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');

    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the bootstrap rise (no prior verdict -> LEAN default) armed a crossing');
    assert.strictEqual(st.lastCrossing.consumed, false);

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    const reason = parseBlock(rp.stdout);
    assert.ok(reason.includes('non-optional at FULL'), reason); // the force directive fires
    assert.ok(reason.includes('break-even proven'), reason); // the ECONOMIC headline, not the wall headline
  } finally { clean(home, proj); }
});

test('round trip: a LEAN SessionStart records economical:false and no crossing, so the following Stop stays silent', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 200, indexBytes: 100 }); // LEAN
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');

    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'LEAN');
    assert.strictEqual(st.lastVerdict.economical, false);
    assert.strictEqual(st.lastCrossing, undefined, 'LEAN never arms a crossing');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.strictEqual(rp.stdout, '');
  } finally { clean(home, proj); }
});

test('round trip: two SessionStarts at the SAME band record only ONE crossing (not re-armed)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same OBESE fixture family as the standalone SessionStart OBESE test
    // (measured fat armed; big recall keeps carry < wash per 0g; the small
    // index keeps condition 2b unmet -> never economic FULL).
    const mem = seedClassB(home, proj, { claudeMdText: fatText(60) + String.fromCharCode(10) + muscleText(50), indexBytes: 60 });
    seedBigRecall(mem);
    const r1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r1);
    const stA = readProjState(home, proj);
    assert.ok(stA.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(stA)})`);
    const at1 = stA.lastCrossing.at;

    const r2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r2);
    const stB = readProjState(home, proj);
    assert.ok(stB.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(stB)})`);
    const crossing2 = stB.lastCrossing;
    assert.strictEqual(crossing2.at, at1, 'the second SessionStart at the identical band must not re-arm/overwrite the crossing');
    assert.strictEqual(crossing2.consumed, false);

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.ok(parseBlock(rp.stdout).includes('memory crossed the OBESE ceiling'), 'exactly one ask fires for the two identical-band sessions');
  } finally { clean(home, proj); }
});

test('round trip: a LEAN SessionStart clears a pending crossing left over from a prior high-band session', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedState(home, proj, { lastCrossing: { band: 'OBESE', at: Date.now() - 1000, consumed: false } });
    seedClassB(home, proj, { claudeMdBytes: 200, indexBytes: 100 }); // LEAN fixture
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(readProjState(home, proj).lastCrossing, undefined, 'LEAN clears the stale pending crossing');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.strictEqual(rp.stdout, '', 'nothing left to ask about');
  } finally { clean(home, proj); }
});

test('round trip: an externalize-FULL SessionStart arms a crossing the following Stop delivers as the pure advisory (beta.12: no longer un-trackable)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // 0r: un-armed capHit now only fires at the TRUE capacity clamp (see the
    // SessionStart externalize test above) — a floor near CAPACITY_TOKENS pins it.
    seedClassB(home, proj, { claudeMdBytes: 2400800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 600000 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');

    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.reason, 'externalize');
    assert.strictEqual(st.lastCrossing.band, 'FULL');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    const reason = parseBlock(rp.stdout);
    assert.ok(reason.includes('FULL (externalize)'), reason);
    assert.ok(!reason.includes('question tool'));
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0o "SUBAGENT BLIND SPOT" — the PostToolUse spawn meter (the TRUE-BILL
// COUNTER). NOISE RULE, absolute: the meter emits NOTHING on any path —
// write-only bookkeeping; the figure surfaces only via /stats + the FULL
// directive numbers.
// ---------------------------------------------------------------------------

test('0o: a PostToolUse Agent event silently increments the spawn counters with the CACHED parcel cost — NOTHING on stdout/stderr (the NOISE RULE)', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastVerdict: { band: 'LEAN', reason: 'bmi', alwaysLoadedBytes: 40000, at: Date.now() }, // ~10000 tok parcel
    });
    const r1 = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: 'x' } });
    assertGraceful(r1);
    assert.strictEqual(r1.stdout, '', 'the meter NEVER speaks — write-only (Phoenix #13)');
    const r2 = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Task' }); // legacy alias counts too
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.subSpawns, 2, 'N spawns = N silent increments');
    assert.strictEqual(st.subParcelTokensAccum, 20000, 'each spawn billed the cached parcel figure — no re-gauge');
  } finally { clean(home, proj); }
});

test('0o: a non-spawn tool PostToolUse event exits instantly — no state file is ever touched (the pre-import belt; hooks.json\'s matcher is the platform-level skip)', () => {
  const { home, proj } = sandbox();
  try {
    for (const tool of ['Read', 'Edit', 'Bash', 'Write']) {
      const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: tool });
      assertGraceful(r);
      assert.strictEqual(r.stdout, '');
    }
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'no state read or write on the non-match path — structurally free (the warp-gate-style structural proof, never a wall clock)');
  } finally { clean(home, proj); }
});

test('0o: a corrupt state file never breaks the meter — spawn counted at cost 0, exit clean', () => {
  const { home, proj } = sandbox();
  try {
    const sp = projStatePath(home, proj);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, '{ definitely not json', 'utf8');
    const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Agent' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.subSpawns, 1, 'self-healed over the corrupt file');
    assert.strictEqual(st.subParcelTokensAccum, 0, 'no cached verdict -> cost 0, never computed');
  } finally { clean(home, proj); }
});

test('0o: coalwashMode manual -> the meter stays off (it rides the same mode as the gauge lifecycle that resets it)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { coalwashMode: 'manual' });
    const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Agent' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false,
      'manual mode: no gauge, no session boundary, no meter — nothing is even written');
  } finally { clean(home, proj); }
});

test('0o round trip: spawns accumulate, the FULL directive carries the bill clause with real numbers, and the next session\'s gauge RESETS the counters', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Session 1: an economic-FULL store (task #4: measured fat + over-envelope
    // index + usage stamps -> both break-evens pay) + two sub spawns.
    seedClassB(home, proj, { claudeMdText: fatText(500) + String.fromCharCode(10) + muscleText(100), indexText: overEnvelopeIndex() });
    seedState(home, proj, seedUsageStamps({}));
    run(proj, home, { hook_event_name: 'SessionStart' }); // gauges FULL/economic + caches alwaysLoadedBytes
    run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Agent' });
    run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Agent' });
    const st1 = readProjState(home, proj);
    assert.strictEqual(st1.subSpawns, 2);
    assert.ok(st1.subParcelTokensAccum > 0, 'the gauged parcel is billed per spawn');

    // Stop: the force directive carries the ONE bill clause with real numbers.
    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    const reason = parseBlock(rp.stdout);
    assert.ok(reason.includes('This fat also rode 2 sub spawn(s)'), reason);
    assert.ok(/≈ \d+ tok of parcel/.test(reason), 'real numbers rendered');
    assert.ok(!reason.includes('undefined') && !reason.includes('NaN'), reason);

    // Session 2: the first gauge resets the counters (session-scoped figure).
    run(proj, home, { hook_event_name: 'SessionStart' });
    assert.strictEqual(readProjState(home, proj).subSpawns, undefined, 'reset at the session boundary (recordStamp)');
  } finally { clean(home, proj); }
});

test('0o: zero spawns -> the FULL directive carries NO bill clause (no "0 spawns" noise)', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: false, fatTokens: 2500, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(!reason.includes('sub spawn'), 'zero/absent counters render NOTHING');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// 0p WRITE-PATH SEATBELT + AIRBAG — hermetic spawn tests. The airbag
// (PreToolUse) is write-only; the seatbelt (PostToolUse Edit|Write) is
// advisory-only (plain stdout, NEVER {decision:'block'}). Clean/non-class-B
// edits stay silent.
// ---------------------------------------------------------------------------

const GOV_BODY = '# Governance\n\nSee [the guide](https://example.com/guide) and version v1.2.3 on 2026-07-11. ' + 'x'.repeat(300);
function wgDir(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }

test('0p airbag: PreToolUse Edit on a class-B file snapshots it once, silently (write-only, nothing on stdout)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r = run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'sess-1', tool_input: { file_path: gov } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'the airbag is write-only — nothing on stdout');
    const snaps = fs.readdirSync(path.join(wgDir(proj), 'sess-1')).filter((n) => n !== '.gitignore');
    assert.strictEqual(snaps.length, 1, 'one snapshot taken');
    assert.strictEqual(fs.readFileSync(path.join(wgDir(proj), 'sess-1', snaps[0]), 'utf8'), GOV_BODY, 'byte-exact orig');
  } finally { clean(home, proj); }
});

test('0p airbag: PreToolUse on a SOURCE file snapshots NOTHING and never writes the writeguard dir (the cheap-prefilter skip)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const src = path.join(proj, 'index.js');
    fs.writeFileSync(src, 'code', 'utf8');
    const r = run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: 's', tool_input: { file_path: src } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'no writeguard dir for a non-class-B write');
  } finally { clean(home, proj); }
});

test('0p seatbelt: a structured-token drop after a guarded edit injects ONE advisory line — plain stdout, FYI-framed, NEVER {decision:block}', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    // Airbag first (PreToolUse), then the drop, then the seatbelt (PostToolUse).
    run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'sess-2', tool_input: { file_path: gov } });
    fs.writeFileSync(gov, GOV_BODY.replace('[the guide](https://example.com/guide)', 'the guide'), 'utf8');
    const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 'sess-2', tool_input: { file_path: gov } });
    assertGraceful(r);
    assert.ok(r.stdout.includes('write-guard'), r.stdout);
    assert.ok(r.stdout.includes('FYI') && r.stdout.includes('not a block'), 'advisory only');
    assert.ok(r.stdout.includes('link-drop'), 'names the dropped class');
    assert.ok(r.stdout.includes('CLAUDE.md'), 'names the file + the snapshot pointer');
    assert.doesNotThrow(() => { if (r.stdout.trim().startsWith('{')) JSON.parse(r.stdout); }, 'not a JSON block decision');
    assert.ok(!r.stdout.includes('"decision"'), 'never a block decision — advisory only');
  } finally { clean(home, proj); }
});

test('0p seatbelt: a CLEAN edit (added a line, dropped nothing) stays SILENT', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 's3', tool_input: { file_path: gov } });
    fs.writeFileSync(gov, GOV_BODY + '\n\nadded, dropped nothing', 'utf8');
    const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's3', tool_input: { file_path: gov } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'clean edit -> silent (no per-edit output)');
  } finally { clean(home, proj); }
});

test('0p seatbelt: a non-class-B (source) PostToolUse edit is SILENT — the cheap-prefilter skip, no diff', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const src = path.join(proj, 'app.js');
    fs.writeFileSync(src, 'const x = 1', 'utf8');
    const r = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 's', tool_input: { file_path: src } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('0p writeGuard config: snapshot-only keeps the airbag but silences the advisory; off disables both', () => {
  const { home, proj } = sandbox();
  try {
    // WAVE-2 R2: writeGuard's schema default IS the safest tier ('on'), so a
    // PROJECT-ONLY value can no longer weaken it at all (that was the hole) --
    // this test is about the DISTINCT BEHAVIOR of each tier, not about
    // escalation, so it opts in at the GLOBAL layer once (the genuine
    // "configured system-wide" case) and lets the project move freely at or
    // below that floor for the rest of the test.
    writeGlobalCfg(home, { writeGuard: 'off', updateMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    // snapshot-only: airbag snapshots, seatbelt silent.
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ writeGuard: 'snapshot-only' }), 'utf8');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'so', tool_input: { file_path: gov } });
    assert.ok(fs.existsSync(path.join(wgDir(proj), 'so')), 'snapshot-only still snapshots (airbag on)');
    fs.writeFileSync(gov, GOV_BODY.replace('v1.2.3', 'gone'), 'utf8');
    const r1 = run(proj, home, { hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: 'so', tool_input: { file_path: gov } });
    assertGraceful(r1);
    assert.strictEqual(r1.stdout, '', 'snapshot-only silences the advisory');

    // off: no snapshot at all.
    clean(wgDir(proj));
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ writeGuard: 'off' }), 'utf8');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r2 = run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'off1', tool_input: { file_path: gov } });
    assertGraceful(r2);
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'writeGuard off -> no airbag');
  } finally { clean(home, proj); }
});

test('0p sweep: SessionStart drops a PRIOR session\'s writeguard snapshots, keeps the CURRENT session\'s', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'old', tool_input: { file_path: gov } });
    assert.ok(fs.existsSync(path.join(wgDir(proj), 'old')));
    // A new SessionStart with a different session_id sweeps the old dir.
    const r = run(proj, home, { hook_event_name: 'SessionStart', session_id: 'new' });
    assertGraceful(r);
    assert.strictEqual(fs.existsSync(path.join(wgDir(proj), 'old')), false, 'prior session swept');
  } finally { clean(home, proj); }
});

test('0p: coalwashMode off is the master kill — no airbag, no seatbelt', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { coalwashMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r1 = run(proj, home, { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 's', tool_input: { file_path: gov } });
    assertGraceful(r1);
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'coalwashMode off -> no airbag');
  } finally { clean(home, proj); }
});

test('self-update: due on first boot (default ask), stamped, then silent inside the window', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 100 }); // LEAN -> only the update line prints
    const r1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r1);
    assert.ok(r1.stdout.includes('[CoalWash] [self-update due]'));
    assert.ok(r1.stdout.includes('never assume'), 'gold no-external-assumption wording');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'coal', 'coalwash', 'update-check')), 'crash-safe stamp written to the coal/ namespace (task #13)');
    const r2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'inside the window: silent');
  } finally { clean(home, proj); }
});

// The Stop channel carries the language lock too (2026-07-25). It was the ONE
// delivery surface that never did — harmless while its directives were pure
// agent instructions, but every one of them now ends in a user-facing push (the
// one-line receipt, which must print on EVERY run), so the lock has to reach it.
test('language lock reaches the STOP channel — every directive there ends in a user-facing receipt push', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off', language: 'th' });
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
    });
    const reason = parseBlock(run(proj, home, { hook_event_name: 'Stop' }).stdout);
    assert.ok(reason.includes('(language=th'), reason);
    assert.ok(reason.includes('numbers, and units verbatim'), 'the receipt numbers/units must NOT be translated');
  } finally { clean(home, proj); }
});

test('language lock: `auto` (the factory default) adds NO clause to the Stop channel — following the conversation is baseline behaviour, not a token to spend', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home); // language defaults to auto
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
    });
    const reason = parseBlock(run(proj, home, { hook_event_name: 'Stop' }).stdout);
    assert.ok(!reason.includes('language='), reason);
  } finally { clean(home, proj); }
});

test('language lock is appended to the self-update directive (band nudges carry no text of their own to translate any more)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { language: 'th' }); // updateMode defaults to ask -> due on first boot
    seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 }); // OBESE-shaped, but SessionStart stays silent regardless
    seedState(home, proj, { leanFloorTokens: 10000 });
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.ok(r.stdout.includes('[self-update due]'), r.stdout);
    assert.ok(r.stdout.includes('(language=th'), r.stdout);
  } finally { clean(home, proj); }
});

test('a corrupt state file self-heals: the hook still gauges and exits 0 (Phoenix #12)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 200 });
    const sp = projStatePath(home, proj);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, '{ definitely not json', 'utf8');
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.strictEqual(st.stamps.length, 1, 'stamping resumed over the corrupt file');
  } finally { clean(home, proj); }
});

test('a poisoned/implausible stored leanFloor is IGNORED — task #4 reads no floor at all; the bytes survive as inert history', () => {
  // Pre-task-#4 this test pinned the read-time sanitizer (discard the poisoned
  // value, run bootstrap economics). task #4 retired the floor as an INPUT
  // entirely: fat and muscle are measured from content every gauge, so a
  // poisoned floor cannot poison a verdict that never reads it. What this test
  // pins now: (a) the verdict is the same one a floor-free store gets, and
  // (b) the stored bytes are NOT clobbered — the gauge stopped READING floors,
  // it does not delete history.
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // capHit (index bytes), no measured fat -> FULL/externalize
    seedState(home, proj, { leanFloorTokens: 999999999 }); // grossly larger than the measured footprint
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.ok(st.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(st)})`);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'externalize', 'capHit with NO measured fat routes externalize — same as a floor-free store');
    assert.strictEqual(st.leanFloorTokens, 999999999, 'the stored bytes are untouched — ignored, not clobbered');
    assert.notStrictEqual(st.leanFloorProvisional, true);
  } finally { clean(home, proj); }
});

test('G2: a corrupt, empty, or truncated state file gauges IDENTICALLY to no state file at all (conservative, never crashes)', () => {
  const runWithStateContent = (content) => {
    const { home, proj } = sandbox();
    try {
      muteUpdate(home);
      seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // capHit (index bytes), no measured fat -> FULL/externalize either way
      if (content !== undefined) {
        const sp = projStatePath(home, proj);
        fs.mkdirSync(path.dirname(sp), { recursive: true });
        fs.writeFileSync(sp, content, 'utf8');
      }
      const r = run(proj, home, { hook_event_name: 'SessionStart' });
      assertGraceful(r);
      assert.strictEqual(r.stdout, '');
      const stG2 = readProjState(home, proj);
      assert.ok(stG2.lastVerdict, `hook exited 0 but wrote no usable state (raw: ${JSON.stringify(stG2)})`);
      return stG2.lastVerdict;
    } finally { clean(home, proj); }
  };
  const baseline = runWithStateContent(undefined); // no state file at all
  assert.strictEqual(baseline.band, 'FULL');
  assert.strictEqual(baseline.reason, 'externalize');
  // `at` legitimately differs per invocation, and so does `alwaysLoadedPaths`
  // (beta.13 item 3 — each runWithStateContent() call is its OWN sandbox with
  // a unique tmpdir, so the cached absolute path LIST is necessarily
  // sandbox-specific even though the byte counts it feeds match).
  const { at: _base, alwaysLoadedPaths: _pbase, ...baselineRest } = baseline;
  for (const content of ['', '{ definitely not json', '{"projects": {"C:\\\\foo": {"leanFloorTok', '[1,2,3]', 'null']) {
    const { at: _c, alwaysLoadedPaths: _pc, ...rest } = runWithStateContent(content);
    assert.deepStrictEqual(rest, baselineRest, `state content ${JSON.stringify(content)} must gauge identically to no state file`);
  }
});

test('no class-B at all (empty project, no memory dir): silent, exit 0', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});
