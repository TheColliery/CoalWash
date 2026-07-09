// Hermetic spawn tests for hooks/coalwash-conductor.js (hooks-safety.md §7):
// spawn the REAL hook as a child process with a sandboxed HOME/TEMP/cwd so real
// session state, the real ~/.claude/.coalwash.json, and the real memory store
// can never leak in. Every case asserts the three observable surfaces:
//   (1) exit code 0 on every path (Phoenix #4);
//   (2) stderr silent — stdout only on the sanctioned SessionStart channel;
//   (3) the expected state effect (stamp/snooze written, or nothing).
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
// PERSISTENT PER-TURN FULL BAR (beta.8 item #2) — the UserPromptSubmit branch.
// Replaces the beta.7 Notification hand-off (lab-measured dead on this
// machine — 142 transcripts, 0 Notification events ever; removed above).
// ---------------------------------------------------------------------------

test('UserPromptSubmit: a cached FULL+economical verdict fires the standing per-turn directive', () => {
  const { home, proj } = sandbox();
  try {
    seedState(home, proj, { lastVerdict: { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: Date.now() } });
    const r = run(proj, home, { hook_event_name: 'UserPromptSubmit' });
    assertGraceful(r);
    assert.ok(r.stdout.includes('[CoalWash] FULL band standing directive'), r.stdout);
    assert.ok(r.stdout.includes('SPAWN the free mechanical Quick pass as a BACKGROUND subagent'), 'background-spawn, never inline-before-the-task');
    assert.ok(r.stdout.includes('never delay the user\'s request'), r.stdout);
    assert.ok(r.stdout.includes('repeats every turn'), r.stdout);
    assert.ok(r.stdout.includes('CoalBoard or CoalTipple conductor directive also fired'), 'yields to a sibling conductor, lowest priority');
    assert.ok(r.stdout.includes('arbitrate silently, never surface the overlap'), 'mirrors the CB/CT shipped arbitration-cue shape');
  } finally { clean(home, proj); }
});

test('UserPromptSubmit: LEAN, no verdict, a disarmed FULL, an externalize FULL, and a stale FULL+economical all stay silent', () => {
  const cases = [
    undefined, // no state file at all
    { band: 'LEAN', reason: 'bmi', economical: false, fatTokens: 0, at: Date.now() },
    { band: 'FULL', reason: 'fat-budget', economical: false, fatTokens: 5000, at: Date.now() }, // disarmed (break-even against)
    { band: 'FULL', reason: 'externalize', economical: false, fatTokens: 100, at: Date.now() }, // all-muscle, never arms
    { band: 'FULL', reason: 'fat-budget', economical: true, fatTokens: 4004, at: Date.now() - 25 * 60 * 60 * 1000 }, // stale, >24h
  ];
  for (const lastVerdict of cases) {
    const { home, proj } = sandbox();
    try {
      if (lastVerdict) seedState(home, proj, { lastVerdict });
      const r = run(proj, home, { hook_event_name: 'UserPromptSubmit' });
      assertGraceful(r);
      assert.strictEqual(r.stdout, '', `case ${JSON.stringify(lastVerdict)} must stay silent`);
    } finally { clean(home, proj); }
  }
});

test('verdict-recording round-trip: a FULL-economical SessionStart records an armed verdict the very next UserPromptSubmit reads and fires on', () => {
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
    assert.ok(st.lastVerdict.at > 0);

    const rp = run(proj, home, { hook_event_name: 'UserPromptSubmit' });
    assertGraceful(rp);
    assert.ok(rp.stdout.includes('FULL band standing directive'), rp.stdout);
  } finally { clean(home, proj); }
});

test('verdict-recording round-trip: a LEAN SessionStart records economical:false, so the following UserPromptSubmit stays silent', () => {
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

    const rp = run(proj, home, { hook_event_name: 'UserPromptSubmit' });
    assertGraceful(rp);
    assert.strictEqual(rp.stdout, '');
  } finally { clean(home, proj); }
});

test('UserPromptSubmit hot path: the silent case never runs discovery/measurement (no state file created) and completes fast', () => {
  const { home, proj } = sandbox();
  try {
    // A store that WOULD be FULL via the absolute cap if the full gauge ran —
    // proves the branch never calls discoverClassB/measureEntries/recordStamp
    // (Phoenix #3): if it did, this fixture would produce a state file same
    // as the SessionStart tests above do.
    seedClassB(home, proj, { claudeMdBytes: 100, indexBytes: 26 * 1024 });
    const t0 = Date.now();
    const r = run(proj, home, { hook_event_name: 'UserPromptSubmit' });
    const elapsedMs = Date.now() - t0;
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'no cached verdict yet -> silent');
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false, 'the hot path never stamps/discovers/measures — no state file created at all');
    assert.ok(elapsedMs < 2000, `UserPromptSubmit silent path should be fast (node-startup-dominated); took ${elapsedMs}ms`);
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
