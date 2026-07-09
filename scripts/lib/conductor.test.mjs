// Hermetic spawn tests for hooks/coalwash-conductor.js (hooks-safety.md §7):
// spawn the REAL hook as a child process with a sandboxed HOME/TEMP/cwd so real
// session state, the real ~/.claude/.coalwash.json, and the real memory store
// can never leak in. Every case asserts the three observable surfaces:
//   (1) exit code 0 on every path (Phoenix #4);
//   (2) stderr silent — stdout only on a sanctioned channel: SessionStart's
//       plain context-injection console.log, or Stop's structured
//       `{decision:'block', reason}` JSON (beta.10, mirrors rot-canary-stop.js);
//   (3) the expected state effect (stamp/snooze/crossing written, or nothing).
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

test('LEAN (small store, no floor yet): silent — Phoenix #13 healthy path', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 200, indexBytes: 100 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    const st = readProjState(home, proj);
    assert.strictEqual(st.stamps.length, 1, 'the gauge still stamps the session');
  } finally { clean(home, proj); }
});

test('manual mode: gauge silent (no stamp), but the self-update scheduler still runs', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj, { claudeMdBytes: 60000 }); // would be FULL if gauged
    writeGlobalCfg(home, { coalwashMode: 'manual' }); // updateMode defaults to ask -> due on first boot
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('[self-update due]'));
    assert.ok(!r.stdout.includes('memory gauge'), 'no gauge output in manual mode');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false, 'no stamp in manual mode');
  } finally { clean(home, proj); }
});

test('PLUMP: emits the ask nudge once and self-snoozes; the snoozed boot is silent', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint ~= (4000 ascii + index 60)/4 tok ~= 1015; floor 750 -> BMI ~1.35 (PLUMP)
    seedClassB(home, proj, { claudeMdBytes: 4000, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 750 });
    const r1 = run(proj, home);
    assertGraceful(r1);
    assert.ok(r1.stdout.includes('[CoalWash] memory gauge: PLUMP'), r1.stdout);
    assert.ok(r1.stdout.includes('question tool'), 'the ask rides the agent question-box');
    assert.ok(r1.stdout.includes('human approval'), 'deletes stay human-gated in the text');
    const st = readProjState(home, proj);
    assert.ok(st.snoozeUntil > Date.now(), 'self-snoozed');
    const r2 = run(proj, home);
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'snoozed boot is silent');
  } finally { clean(home, proj); }
});

test('OBESE: strong-ask with the shorter snooze window', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint ~= 1715 tok; floor 1000 -> BMI ~1.7 (OBESE)
    seedClassB(home, proj, { claudeMdBytes: 6800, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 1000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('memory gauge: OBESE'), r.stdout);
    assert.ok(r.stdout.includes('STRONGLY RECOMMEND'));
    const st = readProjState(home, proj);
    const days = (st.snoozeUntil - Date.now()) / 86400000;
    assert.ok(days > 1 && days < 3, `OBESE snooze ~2 days, got ~${days.toFixed(1)}`);
  } finally { clean(home, proj); }
});

test('FULL via fat-budget (growable-full) with the break-even in favor: the deterministic numbers are SHOWN and the run is directed', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint = 5004 tok; floor 1000 -> fat 4004 (just over the 4000 fat
    // budget, growable-full); run ~= 3x store ~= 15k < 14-day carry ~= 56k
    // -> economical.
    seedClassB(home, proj, { claudeMdBytes: 20016, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 1000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('memory gauge: FULL (fat-budget)'), r.stdout);
    assert.ok(r.stdout.includes('fat ~'), 'numbers shown');
    assert.ok(/one run \S+ \d+ tok/.test(r.stdout), 'run cost shown');
    assert.ok(r.stdout.includes('break-even ~'), 'break-even shown');
    assert.ok(r.stdout.includes('RUN the CoalWash pipeline now'), 'economic force directive');
    assert.ok(r.stdout.includes('economic-dominance'), 'the named exception is cited');
    assert.ok(r.stdout.includes('human gate'), 'deletes stay human-gated even under force');
    assert.ok(r.stdout.includes('SURFACE this line to the user verbatim'), 'the last-hop agent directive is present (beta.7 #2)');
  } finally { clean(home, proj); }
});

test('FULL via the absolute index cap fires even with no floor measured (bootstrap backstop)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // index over the 25KB cap class
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('memory gauge: FULL (absolute-cap)'), r.stdout);
    if (r.stdout.includes('fat ~')) {
      assert.ok(r.stdout.includes('floor unmeasured'), 'a never-cleaned store must label its fat figure an upper bound');
    }
  } finally { clean(home, proj); }
});

test('FULL band but break-even NOT in favor: the force stays DISARMED (strong-ask + snooze, no run directive)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same FULL-band footprint as the armed case (floor 1000, fat 5000 > the
    // 4000 fat budget) but a huge recall store inflates the run cost (3x
    // total) far past the 14-day carry.
    const mem = seedClassB(home, proj, { claudeMdBytes: 23940, indexBytes: 60 });
    fs.writeFileSync(path.join(mem, 'recall-big.md'), 'r'.repeat(400 * 1024), 'utf8');
    seedState(home, proj, { leanFloorTokens: 1000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('memory gauge: FULL'), r.stdout);
    assert.ok(r.stdout.includes('does NOT yet favor a run'), 'disarm wording present');
    assert.ok(r.stdout.includes('force-run stays disarmed'), 'force explicitly disarmed');
    assert.ok(!r.stdout.includes('RUN the CoalWash pipeline now'), 'no run directive when uneconomical');
    const st = readProjState(home, proj);
    assert.ok(st.snoozeUntil > Date.now(), 'disarmed FULL snoozes like a strong-ask');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// Growable-full (beta.7 item #1) — regression tests pinning the live cases.
// ---------------------------------------------------------------------------

test('growable-full: a large HEALTHY floor (TheColliery-shaped, ~29k) stays LEAN and silent even though the raw footprint is large', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint = (116332+60)/4 = 29098 tok; floor 29054 -> fat 44 (well under
    // the fat budget), bmi ~1.0015 (well under PLUMP) -> LEAN. Pins the exact
    // live regression case (MEMORY.md "THE CALIBRATION FINDING").
    seedClassB(home, proj, { claudeMdBytes: 116332, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 29054 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'a healthy large floor must never false-fire FULL');
  } finally { clean(home, proj); }
});

test('growable-full: post-floor all-muscle over the hard cap gets the EXTERNALIZE advisory, never "wash harder" (regression c)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // footprint 36200 tok; floor 36000 -> fat 200 (well under the fat budget)
    // but the footprint clears the recalibrated hard ceiling (36000 = 6% of
    // the recalibrated CAPACITY_TOKENS) -> externalize, not a wash directive.
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    seedState(home, proj, { leanFloorTokens: 36000 });
    const r = run(proj, home);
    assertGraceful(r);
    assert.ok(r.stdout.includes('memory gauge: FULL (externalize)'), r.stdout);
    assert.ok(r.stdout.includes('EXTERNALIZE'), 'advises externalizing/splitting');
    assert.ok(r.stdout.includes('no reclaimable fat'), 'names WHY washing cannot help');
    assert.ok(!r.stdout.includes('RUN the CoalWash pipeline now'), 'never directs a wash on an all-muscle store');
    assert.ok(r.stdout.includes('SURFACE this line to the user verbatim'), 'the last-hop agent directive is present (beta.7 #2)');
    const st = readProjState(home, proj);
    assert.ok(st.snoozeUntil > Date.now(), 'externalize snoozes like a strong-ask (nothing new to say until the store shrinks)');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// STOP HOOK — the once-per-crossing ask/force channel (beta.10, REPLACES the
// beta.8/9 UserPromptSubmit per-turn bar; MEMORY.md "ROUND 4 POSTMORTEM").
// Output is the structured `{decision:'block', reason}` JSON (rot-canary's
// exact mechanism), not plain stdout — asserted explicitly below since that
// structure is the whole point of the beta.10 move.
// ---------------------------------------------------------------------------

function parseBlock(stdout) {
  const j = JSON.parse(stdout);
  assert.strictEqual(j.decision, 'block', 'Stop must use the structured block decision, not plain stdout');
  return j.reason;
}

test('Stop: an unconsumed PLUMP crossing emits the ask (ทำ/later) via the structured block decision, then self-consumes', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'PLUMP', at: Date.now(), consumed: false },
      lastVerdict: { band: 'PLUMP', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
    });
    const r1 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r1);
    const reason = parseBlock(r1.stdout);
    assert.ok(reason.includes('memory crossed the PLUMP ceiling'), reason);
    assert.ok(reason.includes('fat ~1234 tok'), reason);
    assert.ok(reason.includes('question tool'), 'rides the agent question-box');
    assert.ok(reason.includes('ทำ'), reason);
    assert.ok(reason.includes('later (dismiss; the offer returns at the next ceiling crossing)'), 'the later option tells the consume-at-emission truth');
    assert.ok(!reason.includes('snooze'), 'no snooze promise — the code never re-fires until the next crossing');
    assert.ok(reason.includes('run the quick wash now'), 'PLUMP defaults to the quick exercise');
    assert.ok(reason.includes('deletes remain human-gated'), reason);

    const r2 = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '', 'consumed at emission — a second Stop for the SAME crossing stays silent');
  } finally { clean(home, proj); }
});

test('Stop: an unconsumed OBESE crossing offers the config-mapped exercise (default: full)', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
      lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 2500, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('memory crossed the OBESE ceiling'), reason);
    assert.ok(reason.includes('run the full wash now'), 'OBESE defaults to the full exercise (factory exercisePerBand)');
  } finally { clean(home, proj); }
});

test('Stop: a FULL+economical crossing with forceMode=auto (the default) emits the standing-consent force directive, not an ask', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: Date.now() },
    });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('FULL band + break-even proven'), reason);
    assert.ok(reason.includes('fat ~4004 tok'), reason);
    assert.ok(reason.includes('standing config authorizes'), reason);
    assert.ok(reason.includes('Quick pass NOW'), reason);
    assert.ok(reason.includes('stage-only'), reason);
    assert.ok(reason.includes('human gate'), reason);
    assert.ok(reason.includes('once per crossing, not per session'), reason);
    assert.ok(!reason.includes('question tool'), 'force never asks');
  } finally { clean(home, proj); }
});

test('Stop: forceMode=ask degrades a FULL+economical crossing to the same ask template used by PLUMP/OBESE', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ forceMode: 'ask' }), 'utf8');
    seedState(home, proj, {
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
      lastVerdict: { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: Date.now() },
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
      lastVerdict: { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: Date.now() },
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
    seedState(home, proj, { lastCrossing: { band: 'PLUMP', at: Date.now(), consumed: true } });
    const r = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('Stop: a malformed/unknown-band/LEAN-band lastCrossing is silent, never throws', () => {
  const cases = [
    { band: 'LEAN', at: Date.now(), consumed: false }, // LEAN is never a crossing target
    { band: 'GARBAGE', at: Date.now(), consumed: false },
    { band: 'PLUMP', at: Date.now() + 60 * 60 * 1000, consumed: false }, // future timestamp
    { band: 'PLUMP' }, // missing `at`
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
// the Stop hook's data source; recordCrossing/sanitizeCrossing are the new
// once-per-crossing counterpart).
// ---------------------------------------------------------------------------

test('round trip: a FULL-economical SessionStart records a crossing the following Stop reads and force-fires on', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    seedClassB(home, proj, { claudeMdBytes: 20016, indexBytes: 0 }); // fat-budget FULL, economical (same fixture as the FULL suite above)
    seedState(home, proj, { leanFloorTokens: 1000 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.ok(rs.stdout.includes('memory gauge: FULL (fat-budget)'), rs.stdout);

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
    // Same PLUMP fixture as the existing PLUMP gauge test (BMI ~1.35).
    seedClassB(home, proj, { claudeMdBytes: 4000, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 750 });
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
    assert.ok(parseBlock(rp.stdout).includes('memory crossed the PLUMP ceiling'), 'exactly one ask fires for the two identical-band sessions');
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

test('round trip (F1): an externalize-FULL SessionStart never arms a crossing AND clears a pending one — the following Stop is silent', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home);
    // Same all-muscle-over-the-hard-cap fixture as the externalize gauge test
    // above (footprint ~36200 tok, floor 36000 = 6% of CAPACITY_TOKENS), plus
    // a stale pending PLUMP crossing from an earlier session: the store's
    // truth changed to not-washable, so the externalize scan must supersede
    // it — a Stop ask saying "run the full wash now" here would steer the
    // user into washing legitimate muscle (the growable-full invariant's
    // forbidden move; SessionStart's externalize advisory is the only
    // correct surface).
    seedState(home, proj, {
      leanFloorTokens: 36000,
      lastCrossing: { band: 'PLUMP', at: Date.now() - 1000, consumed: false },
    });
    seedClassB(home, proj, { claudeMdBytes: 144800, indexBytes: 0 });
    const rs = run(proj, home, { hook_event_name: 'SessionStart' });
    assertGraceful(rs);
    assert.ok(rs.stdout.includes('memory gauge: FULL (externalize)'), rs.stdout);

    const st = readProjState(home, proj);
    assert.strictEqual(st.lastVerdict.reason, 'externalize', 'the verdict cache still records the truth');
    assert.strictEqual(st.lastCrossing, undefined, 'externalize counts as LEAN for edge detection: no crossing armed, the pending PLUMP crossing cleared');

    const rp = run(proj, home, { hook_event_name: 'Stop' });
    assertGraceful(rp);
    assert.strictEqual(rp.stdout, '', 'Stop stays silent on an all-muscle store');
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

test('language lock is appended to emitted directives (prose adapts, terms stay verbatim)', () => {
  const { home, proj } = sandbox();
  try {
    muteUpdate(home, { language: 'th' });
    seedClassB(home, proj, { claudeMdBytes: 4000, indexBytes: 60 });
    seedState(home, proj, { leanFloorTokens: 750 }); // PLUMP
    const r = run(proj, home);
    assertGraceful(r);
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

test('a poisoned/implausible stored leanFloor is discarded — behaves IDENTICALLY to no-floor-yet', () => {
  // Same absolute-cap FULL setup either way (band is unaffected by the floor —
  // the cap check runs before bmi). What's at risk if the floor were TRUSTED
  // raw is the break-even messaging: fat ~= footprint - hugeFloor <= 0 would
  // read "not economical" and wrongly DISARM the force-run even though the
  // hard ceiling is already breached. Rather than pin a specific branch
  // outcome (fragile to token-arithmetic drift), prove the stronger property
  // the fix guarantees: a grossly-implausible floor must be INDISTINGUISHABLE
  // from no floor at all (both sanitize to 0, so every downstream number is
  // computed identically — same stdout, byte for byte).
  const seedAndRun = (leanFloorTokens) => {
    const { home, proj } = sandbox();
    try {
      muteUpdate(home);
      seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 }); // absolute-cap FULL
      if (leanFloorTokens != null) seedState(home, proj, { leanFloorTokens });
      const r = run(proj, home);
      assertGraceful(r);
      return r.stdout;
    } finally { clean(home, proj); }
  };
  const noFloor = seedAndRun(null);
  const poisonedFloor = seedAndRun(999999999); // grossly larger than the measured footprint
  assert.ok(noFloor.includes('memory gauge: FULL (absolute-cap)'), noFloor);
  assert.strictEqual(poisonedFloor, noFloor, 'a grossly-implausible stored floor must be discarded exactly like no floor at all');
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
      return r.stdout;
    } finally { clean(home, proj); }
  };
  const baseline = runWithStateContent(undefined); // no state file at all
  assert.ok(baseline.includes('memory gauge: FULL (absolute-cap)'), baseline);
  for (const content of ['', '{ definitely not json', '{"projects": {"C:\\\\foo": {"leanFloorTok', '[1,2,3]', 'null']) {
    assert.strictEqual(runWithStateContent(content), baseline, `state content ${JSON.stringify(content)} must gauge identically to no state file`);
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
