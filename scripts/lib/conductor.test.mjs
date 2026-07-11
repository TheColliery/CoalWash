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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwh-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwh-proj-')));
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
function seedClassB(home, proj, { claudeMdBytes = 100, indexBytes = 60 } = {}) {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(claudeMdBytes), 'utf8');
  const slug = fs.realpathSync(proj).replace(/[^A-Za-z0-9]/g, '-');
  const mem = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'i'.repeat(indexBytes), 'utf8');
  return mem;
}
function seedState(home, proj, projState) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const key = fs.realpathSync(proj);
  fs.writeFileSync(path.join(home, '.claude', '.coalwash-state.json'), JSON.stringify({ projects: { [key]: projState } }), 'utf8');
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
  const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.coalwash-state.json'), 'utf8'));
  return (raw.projects || {})[fs.realpathSync(proj)] || {};
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
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('LEAN (small store, no floor yet): silent — Phoenix #13 healthy path; 0j stamps NO provisional floor under FLOOR_MIN', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 200, indexBytes: 100 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
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
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('[self-update due]'));
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false, 'no stamp in manual mode');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SessionStart — band-collapse: SILENT for every band, only the cache changes.
// ---------------------------------------------------------------------------

test('SessionStart: OBESE crossing is measured+cached SILENTLY (no ask text any more — that is Stop\'s job)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint ~= (60080 + 0)/4 = 15020 tok; floor 10000 -> bmi 1.502 (>= 1.5,
    // ceiling arms), well under the 36000 hard cap; the big recall store keeps
    // carry < wash (0g) so the band is OBESE, not economically FULL.
    const mem = seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 });
    seedBigRecall(mem);
    seedState(home, proj, { leanFloorTokens: 10000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'SessionStart never prints a band ask/directive any more');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'OBESE');
    assert.strictEqual(st.lastVerdict.overCeiling, true);
    assert.strictEqual(st.lastCrossing.band, 'OBESE');
    assert.strictEqual(st.lastCrossing.consumed, false);
  } finally { clean(home, proj); }
});

test('SessionStart: FULL via the absolute index cap fires even with no floor measured (bootstrap backstop) — cached, not printed', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // index over the 25KB cap class
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'absolute-cap');
    assert.strictEqual(st.lastCrossing.band, 'FULL');
  } finally { clean(home, proj); }
});

test('SessionStart: FULL with the break-even in favor caches economical:true + the payback numbers for Stop', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // floor 20000; footprint 36200 (>= the 36000 hard cap AND bmi 1.81 >= 1.5) -> FULL/absolute-cap.
    // fat 16200/day (1 stamp -> sessionsPerDay=1); runCost = max(36200,36200)*3 = 108600;
    // horizonCarry = 16200*14 = 226800 > 108600 -> economical.
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 20000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'absolute-cap');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.strictEqual(st.lastVerdict.fatTokens, 16200);
    assert.ok(st.lastVerdict.perDay > 0, 'payback perDay cached for the Stop ask/force');
    assert.ok(Number.isFinite(st.lastVerdict.breakEvenDays));
    assert.strictEqual(st.lastCrossing.band, 'FULL');
  } finally { clean(home, proj); }
});

test('SessionStart: FULL band but break-even NOT in favor caches economical:false (force stays disarmed downstream)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same FULL-band footprint as the armed case, but a huge recall store
    // inflates the run cost (3x total) far past the 14-day carry.
    const mem = seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    fs.writeFileSync(path.join(mem, 'recall-big.md'), 'r'.repeat(400 * 1024), 'utf8');
    seedState(home, proj, { leanFloorTokens: 20000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.economical, false);
  } finally { clean(home, proj); }
});

test('SessionStart: FULL(externalize) is cached (reason + hardCeilingTokens) and ARMS a crossing — no longer the un-trackable F1 carve', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint 36200 tok; floor 36000 -> bmi ~1.0056 (well under 1.5, NOT
    // armed) but the footprint clears the hard ceiling (36000 = 6% of
    // CAPACITY_TOKENS) -> externalize.
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 36000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'externalize is information, delivered by Stop, never printed at SessionStart');
    const st = readProjState(home, proj);
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
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'a healthy large floor must never false-fire');
    const st = readProjState(home, proj);
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
    const floor = 10000;
    // First boot: bmi 1.502 -> arms OBESE (over=true cached). Big recall
    // store keeps carry < wash both boots (0g) so this stays a pure
    // BMI-hysteresis test, never economically FULL.
    const mem = seedClassB(home, proj, { claudeMdBytes: floor * 1.502 * 4, indexBytes: 0 });
    seedBigRecall(mem);
    seedState(home, proj, { leanFloorTokens: floor });
    const r1 = run(proj, home);
    assertGraceful(r1);
    assert.strictEqual(readProjState(home, proj).lastVerdict.overCeiling, true);

    // Second boot: bmi drops to 1.35 — inside the dead zone (>1.2, <1.5).
    // Un-armed-from-scratch this would be LEAN; armed, it must STAY OBESE.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(Math.round(floor * 1.35 * 4)), 'utf8');
    const r2 = run(proj, home);
    assertGraceful(r2);
    const st2 = readProjState(home, proj);
    assert.strictEqual(st2.lastVerdict.band, 'OBESE', 'the dead zone holds the PRIOR armed state');
    assert.strictEqual(st2.lastCrossing.at, readProjState(home, proj).lastCrossing.at, 'no new crossing (same band, no re-arm)');
  } finally { clean(home, proj); }
});

test('hysteresis: a store must fall to CEILING_REARM_BMI or below to actually clear back to LEAN', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    const floor = 10000;
    seedClassB(home, proj, { claudeMdBytes: Math.round(floor * 1.502 * 4), indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: floor });
    run(proj, home); // arms OBESE
    assert.strictEqual(readProjState(home, proj).lastVerdict.overCeiling, true);

    // Drop to bmi 1.1 — at/under the 1.2 low-water mark -> clears.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(Math.round(floor * 1.1 * 4)), 'utf8');
    run(proj, home);
    const st = readProjState(home, proj);
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
  const j = JSON.parse(stdout);
  assert.strictEqual(j.decision, 'block', 'Stop must use the structured block decision, not plain stdout');
  return j.reason;
}

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
      // economical:true + forceMode default 'auto' would ALSO satisfy the
      // plain force branch — proves the escalation check's priority ordering.
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 900, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('STILL over the FULL capacity ceiling'), reason);
    assert.ok(reason.includes('fat ~900 tok'), reason);
    assert.ok(reason.includes('mechanical Quick pass already ran'), reason);
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
    assert.ok(reason.includes('FULL band + break-even proven'), reason);
    assert.strictEqual(readProjState(home, proj).quickTried, true, 'Force running Quick counts toward the wizard-escalation leg\'s "already tried mechanically" state');
  } finally { clean(home, proj); }
});

test('round trip: a FULL force-run followed by a FULL plateau (still over cap, quickTried set) arms an escalation crossing the following Stop delivers as the wizard ask — proves FLOW 1 end-to-end through two real SessionStarts', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same economical FULL/absolute-cap fixture as the existing 'round trip:
    // a FULL-economical SessionStart...' test below.
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 20000 });
    const rs1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs1);
    const rp1 = run(proj, home, { hook_event_name: 'Stop' }); // force-fires, marks quickTried
    assertGraceful(rp1);
    assert.ok(parseBlock(rp1.stdout).includes('FULL band + break-even proven'), rp1.stdout);
    assert.strictEqual(readProjState(home, proj).quickTried, true);

    // Second SessionStart: the fixture is unchanged on disk (simulates "the
    // Quick pass ran but wasn't enough") -> still FULL, same band as before
    // (no rise) -> arms the escalation branch instead of a fresh plain crossing.
    const rs2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs2);
    const st2 = readProjState(home, proj);
    assert.strictEqual(st2.lastCrossing.band, 'FULL');
    assert.strictEqual(st2.lastCrossing.escalation, true, 'the plateau after a tried Quick arms the wizard-escalation crossing');

    const rp2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp2);
    const reason2 = parseBlock(rp2.stdout);
    assert.ok(reason2.includes('STILL over the FULL capacity ceiling'), reason2);
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
    // footprint 15020 tok (bmi 1.502, armed), far under the 36000 wall; lean
    // recall store -> carry 5020*14 = 70280 > runCost ~45k -> economical.
    seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 10000 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');
    const st = readProjState(home, proj);
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
    const mem = seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 10000 });
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st1 = readProjState(home, proj);
    assert.strictEqual(st1.lastVerdict.reason, 'economic');
    assert.strictEqual(st1.lastVerdict.econLatched, true);
    const crossingAt = st1.lastCrossing.at;

    // Session 2: the recall store balloons -> the run cost (3x the WHOLE
    // store) now dwarfs the carry -> the FRESH proof dips false. The BMI
    // ceiling stays armed (footprint unchanged, bmi 1.502) -> the latch must
    // hold the band at FULL — no flap back to OBESE, no new crossing.
    seedBigRecall(mem);
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st2 = readProjState(home, proj);
    assert.strictEqual(st2.lastVerdict.band, 'FULL', 'Q2: the latch holds the band through the dip');
    assert.strictEqual(st2.lastVerdict.reason, 'economic');
    assert.strictEqual(st2.lastVerdict.econLatched, true);
    assert.strictEqual(st2.lastVerdict.economical, false, 'the FORCE disarms on the dipped fresh proof (economic-dominance: numbers must hold at every fire)');
    assert.strictEqual(st2.lastCrossing.at, crossingAt, 'same band -> the pending crossing is untouched, nothing re-arms');

    // Session 3: the store shrinks to the floor (bmi ~1.0, at/under the
    // low-water mark) -> LEAN -> the episode ends: latch cleared, crossing
    // cleared.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(40000), 'utf8');
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st3 = readProjState(home, proj);
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

test('0j round trip: day-one BMI live — a fresh store above FLOOR_MIN gets the provisional floor stamped and verdicts LEAN at BMI 1.00, no crossing', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 40000, indexBytes: 60 }); // fp = 10000 + 15 = 10015 tok
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.leanFloorTokens, 10015, 'provisional floor = the first-gauge footprint');
    assert.strictEqual(st.leanFloorProvisional, true);
    assert.strictEqual(st.lastVerdict.band, 'LEAN', 'BMI 1.00 on day one — no sleeping bootstrap mode');
    assert.strictEqual(st.lastVerdict.floorUnmeasured, false, 'economics run against a measured baseline, not the bootstrap upper-bound');
    assert.strictEqual(st.lastCrossing, undefined);
  } finally { clean(home, proj); }
});

test('0j round trip: growth-since-install arms the economic FULL through the provisional floor — which itself never ratchets', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Session 1: install — provisional floor 10015 stamped (as above).
    seedClassB(home, proj, { claudeMdBytes: 40000, indexBytes: 60 });
    run(proj, home, { hook_event_name: 'SessionStart' });
    assert.strictEqual(readProjState(home, proj).leanFloorTokens, 10015);

    // Session 2: the store grows to fp 15065 (bmi 1.504 >= 1.5 arms; fat
    // ~5050 over a lean recall store -> economical) -> FULL/economic, the
    // full 0f/0g flow live from a provisional baseline.
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(60200), 'utf8');
    run(proj, home, { hook_event_name: 'SessionStart' });
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'economic');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the rise armed a crossing — force/wizard reachable from day-one enrollment-free');
    assert.strictEqual(st.leanFloorTokens, 10015, 'the provisional floor did NOT ratchet up to the grown footprint');
    assert.strictEqual(st.leanFloorProvisional, true, 'still provisional until a gate-passed clean');
  } finally { clean(home, proj); }
});

test('0j round trip: an already-over-wall store on day one still routes FULL/absolute-cap AND gets the provisional floor (BMI live in parallel)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 }); // fp 36200 >= the 36000 wall
    const r = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'absolute-cap', '0j: never externalize off a provisional baseline — pre-existing fat may be baked in');
    assert.strictEqual(st.leanFloorTokens, 36200, 'the provisional floor stamps IN PARALLEL with the wall verdict');
    assert.strictEqual(st.leanFloorProvisional, true);
    assert.strictEqual(st.lastVerdict.floorUnmeasured, false, 'BMI/economics live against the day-one baseline (fat-since-install ~0, so no force on day one — manual /coalwash stays the door)');
    assert.strictEqual(st.lastVerdict.economical, false);
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the crossing still arms — Stop delivers the FULL awareness (ask, since force is disarmed)');
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
      leanFloorTokens: 4000,
      lastVerdict: { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, overCeiling: false, alwaysLoadedPaths: [claudeMd, memIndex], alwaysLoadedBytes: 160, at: Date.now() },
      // no lastCrossing -> the "nothing pending" path the gate exists for.
    });

    // The within-session spike: CLAUDE.md grows to ~24400 bytes (~6100 tok)
    // -- a MEMORY-crystallize-shaped write, well past REGAUGE_DELTA_TOKENS.
    fs.writeFileSync(claudeMd, 'a'.repeat(24400), 'utf8');

    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    // bmi ~1.525 >= 1.5 -> OBESE, default exercise=quick -> 0d's auto-Quick
    // directive fires THIS turn, not next SessionStart.
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('standing config authorizes'), reason);

    const st = readProjState(home, proj);
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
    assert.ok(reason.includes('~200 tok/session'), reason);
    assert.ok(reason.includes('pays back in ~4 session(s)'), reason);
  } finally { clean(home, proj); }
});

test('Stop: an unconsumed FULL(absolute-cap) crossing offers the config-mapped exercise (default: full) when the ask degrades', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ forceMode: 'ask' }), 'utf8');
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 2500, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('memory crossed the FULL ceiling'), reason);
    assert.ok(reason.includes('run the full wash now'), 'FULL defaults to the full exercise (factory exercisePerBand)');
  } finally { clean(home, proj); }
});

test('Stop: a FULL+economical crossing with forceMode=auto (the default) emits the standing-consent force directive, not an ask', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'absolute-cap', economical: true, fatTokens: 4004, perDay: 1200, breakEvenDays: 2, floorUnmeasured: false, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL band + break-even proven'), reason);
    assert.ok(reason.includes('fat ~4004 tok'), reason);
    assert.ok(reason.includes('standing config authorizes'), reason);
    assert.ok(reason.includes('Quick pass NOW'), reason);
    assert.ok(reason.includes('stage-only'), reason);
    assert.ok(reason.includes('snapshot-backed'), reason);
    assert.ok(reason.includes('once per crossing, not per session'), reason);
    assert.ok(reason.includes('~1200 tok/session'), 'the force directive also shows the payback numbers');
    assert.ok(!reason.includes('question tool'), 'force never asks');
  } finally { clean(home, proj); }
});

test('Stop: forceMode=ask degrades a FULL+economical crossing to the same ask template used by OBESE', () => {
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
    assert.ok(reason.includes('memory crossed the FULL ceiling'), reason);
    assert.ok(reason.includes('question tool'), 'ask-degraded, not auto-run');
    assert.ok(!reason.includes('standing config authorizes'), 'the auto-run authorization is suppressed');
  } finally { clean(home, proj); }
});

test('Stop: forceMode=off emits the ask too — never silent (suppresses only the auto-run, never FULL awareness) — and consumes the crossing', () => {
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
    assert.ok(reason.includes('memory crossed the FULL ceiling'), 'a silent FULL would be the forbidden "dismiss and keep growing" third path');
    assert.ok(reason.includes('question tool'), 'off degrades to the ask, same as ask');
    assert.ok(!reason.includes('standing config authorizes'), 'the auto-run authorization is suppressed');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastCrossing.consumed, true, 'consumed at emission, same as every other surfaced crossing');
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
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false, 'the silent path never writes state');
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
// SessionStart -> Stop round trips (recordVerdict/sanitizeVerdict stay live as
// the Stop hook's data source; recordCrossing/sanitizeCrossing are the
// once-per-crossing counterpart).
// ---------------------------------------------------------------------------

test('round trip: a FULL-economical SessionStart records a crossing the following Stop reads and force-fires on', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 }); // same economical FULL fixture as above
    seedState(home, proj, { leanFloorTokens: 20000 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');

    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.economical, true);
    assert.strictEqual(st.lastCrossing.band, 'FULL', 'the bootstrap rise (no prior verdict -> LEAN default) armed a crossing');
    assert.strictEqual(st.lastCrossing.consumed, false);

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.ok(parseBlock(rp.stdout).includes('FULL band + break-even proven'), rp.stdout);
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
    // Same OBESE fixture as the standalone SessionStart OBESE test (bmi
    // ~1.502, big recall keeping it out of economic FULL per 0g).
    const mem = seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 });
    seedBigRecall(mem);
    seedState(home, proj, { leanFloorTokens: 10000 });
    const r1 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r1);
    const at1 = readProjState(home, proj).lastCrossing.at;

    const r2 = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(r2);
    const crossing2 = readProjState(home, proj).lastCrossing;
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
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 36000 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.strictEqual(rs.stdout, '');

    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.reason, 'externalize');
    assert.strictEqual(st.lastCrossing.band, 'FULL');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    const reason = parseBlock(rp.stdout);
    assert.ok(reason.includes('FULL (externalize)'), reason);
    assert.ok(!reason.includes('question tool'));
  } finally { clean(home, proj); }
});

test('self-update: due on first boot (default ask), stamped, then silent inside the window', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 100 }); // LEAN -> only the update line prints
    const r1 = run(proj, home);
    assertGraceful(r1);
    assert.ok(r1.stdout.includes('[CoalWash] [self-update due]'));
    assert.ok(r1.stdout.includes('never assume'), 'gold no-external-assumption wording');
    assert.ok(fs.existsSync(path.join(home, '.claude', '.coalwash-update-check')), 'crash-safe stamp written');
    const r2 = run(proj, home);
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'inside the window: silent');
  } finally { clean(home, proj); }
});

test('language lock is appended to the self-update directive (band nudges carry no text of their own to translate any more)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { language: 'th' }); // updateMode defaults to ask -> due on first boot
    seedClassB(home, proj, { claudeMdBytes: 60080, indexBytes: 0 }); // OBESE-shaped, but SessionStart stays silent regardless
    seedState(home, proj, { leanFloorTokens: 10000 });
    const r = run(proj, home);
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
    fs.writeFileSync(path.join(home, '.claude', '.coalwash-state.json'), '{ definitely not json', 'utf8');
    const r = run(proj, home);
    assertGraceful(r);
    const st = readProjState(home, proj);
    assert.strictEqual(st.stamps.length, 1, 'stamping resumed over the corrupt file');
  } finally { clean(home, proj); }
});

test('a poisoned/implausible stored leanFloor is discarded at read — bootstrap semantics, and 0j never re-stamps over a floor on file', () => {
  // Pre-0j this test compared poisoned-vs-no-floor for byte-identical
  // verdicts. 0j legitimately SPLIT those two states: a NEVER-SEEN store now
  // stamps a provisional baseline (BMI live day one — the 0j tests below pin
  // it), while a store with a floor ON FILE — even a poisoned one — is never
  // re-stamped (ensureProvisionalFloor's "any existing floor wins" rule:
  // overwriting a floor is setLeanFloor's job alone). What this test pins
  // now: the poisoned value is DISCARDED at read (the sanitizer unchanged),
  // so the gauge runs bootstrap semantics, and the raw poisoned value
  // survives in state un-clobbered until a real clean.
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // absolute-cap FULL
    seedState(home, proj, { leanFloorTokens: 999999999 }); // grossly larger than the measured footprint
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.band, 'FULL');
    assert.strictEqual(st.lastVerdict.reason, 'absolute-cap');
    assert.strictEqual(st.lastVerdict.floorUnmeasured, true, 'the poisoned floor was discarded at read — bootstrap economics (fat = an upper bound)');
    assert.strictEqual(st.leanFloorTokens, 999999999, '0j never re-stamps over a floor on file — poisoned or not, only setLeanFloor overwrites');
    assert.notStrictEqual(st.leanFloorProvisional, true, 'no provisional flag appears on a store that already had a floor');
  } finally { clean(home, proj); }
});

test('G2: a corrupt, empty, or truncated state file gauges IDENTICALLY to no state file at all (conservative, never crashes)', () => {
  const runWithStateContent = (content) => {
    const { home, proj } = sandbox();
    try {
      muteUpdate(home);
      seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // absolute-cap FULL either way
      if (content !== undefined) {
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(home, '.claude', '.coalwash-state.json'), content, 'utf8');
      }
      const r = run(proj, home);
      assertGraceful(r);
      assert.strictEqual(r.stdout, '');
      return readProjState(home, proj).lastVerdict;
    } finally { clean(home, proj); }
  };
  const baseline = runWithStateContent(undefined); // no state file at all
  assert.strictEqual(baseline.band, 'FULL');
  assert.strictEqual(baseline.reason, 'absolute-cap');
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
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});
