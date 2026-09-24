#!/usr/bin/env node
'use strict';
// ponytail: 806 lines at declaration — FOUR hook events share ONE file
// by construction: hooks.json wires a single command and the branch on
// hook_event_name is the first thing the body does. Splitting means either four
// entry files, each re-paying the whole Phoenix-13 preamble (fail-silent wrap,
// stdin read, config cascade, state paths) and re-reading the same state, or a
// shared lib this CJS hook can only reach through await import() — a second
// module-resolution failure mode on the one surface that must never crash the
// host. The cohesion unit here is the hook CONTRACT, not the line count.
// CoalWash conductor (Phoenix-13 hook: fail-silent, zero-dep, no network, no
// spawn, never process.exit — hooks-safety.md). FOUR events share this one
// file (hooks.json), branching on hook_event_name (+ tool_name) from stdin:
//   PreToolUse(Edit|Write|MultiEdit) -> the 0p AIRBAG: snapshot-on-first-write
//                   to a class-B governance/memory file (the undo net for the
//                   gitignored MEMORY.md/CLAUDE.md). Write-only, emits nothing.
//   PostToolUse(Agent|Task|Workflow) -> the 0o spawn meter (write-only).
//   PostToolUse(Edit|Write|MultiEdit) -> the 0p SEATBELT: on a structured-token
//                   drop vs the airbag snapshot, ONE advisory line (never a
//                   block). Both PostToolUse matchers dispatch by tool_name.
//   SessionStart -> the SILENT measurement chokepoint (discovery +
//                   measurement + the ceiling verdict). beta.12 band collapse
//                   (queue item 0, "ASK ORDER = ANSWER-FIRST"): SessionStart
//                   emits NO band-related ask/directive/advisory text of its
//                   own any more — every such surface fired BEFORE the agent
//                   ever addresses the user's own first message for the
//                   turn, which is exactly the observed "สวัสดี-flow hole"
//                   (prompt -> announce+ask -> user picks -> the original
//                   prompt died unanswered). SessionStart now only measures,
//                   caches the verdict + the ceiling's hysteresis bit, and
//                   arms/clears the once-per-crossing edge state; the Stop
//                   hook is the ONLY delivery surface.
//   Stop         -> the ENFORCEMENT/delivery channel: an unconsumed
//                   edge-crossing surfaces as ONE of (per 0d/0f/0g/0m,
//                   MEMORY.md): the wizard-escalation ask (FULL after a
//                   force-run's Quick proved insufficient — the SOLE ask
//                   site, 0f), the UNCONDITIONAL FULL force directive (0m —
//                   economic AND absolute-cap, no proof gate, no off
//                   switch), the OBESE auto-Quick directive (0d — standing
//                   config, never an ask), or ONE OF THE TWO capacity
//                   outcomes (CWK-081): after a Full-tier pass REMOVED
//                   something this episode, the FULL(externalize)
//                   pure-information advisory — never an ask, since washing
//                   cannot help ~all-muscle over capacity, and the advisory
//                   reports only what that pass did, never a verdict over the
//                   rest of the store (round-2 F1); BEFORE one, the Full-tier
//                   consent instead, because "muscle" is then a claim nothing
//                   has measured. Either way, at most ONCE per session.
//                   Mirrors
//                   rot-canary-stop.js's exact output mechanism — a
//                   structured `{decision:'block', reason}` JSON write, not
//                   plain console.log — because THAT is what makes Stop a
//                   blocking channel the agent must address, unlike a
//                   passive context injection it was always free to ignore
//                   (beta.10 "ROUND 4 POSTMORTEM").
//
// BANDS (task #4, superseding the beta.12 BMI-floor Schmitt AND 0r's
// floor-multiple wall — see caliper.mjs's top block for the ruling): purely
// economic, nested LEAN < OBESE < FULL, driven by MEASURED CERTAIN FAT
// (mechFatFromText at every gauge), never a stamped floor. OBESE = the
// fat-Schmitt armed but carry < wash (auto-Quick-silent); FULL/economic =
// armed AND BOTH break-evens hold (2a certain fat + 2b the RE-TIER envelope's
// demotable muscle — the wizard tier is "Fat + reorganize muscle", both
// halves must pay), LATCHED per episode (Q2 — cleared by the LEAN reset,
// which is now CONTINUOUS: whatever actually cuts the fat — a hand edit,
// the wizard, never Quick itself, which has no cutter — drops the next
// gauge's re-measured fat under the disarm mark); the
// WALL is the REAL capacity line only (capacityTokens -- DISCOVERED per machine
// where the platform exposes a window, else the derived conservative default,
// CWK-081 -- plus the CC index caps): wash-first when armed; when ~all-muscle,
// the externalize advice only AFTER a Full-tier pass removed something this
// episode, otherwise the Full-tier consent first. FORCE AT FULL IS NON-OPTIONAL (0m "FORCE IS
// A DICTATOR"): every FULL crossing force-runs the FREE Quick pass under
// the same standing consent as OBESE's auto-Quick — no economic proof
// needed for the free tier (the break-even proof governs the PAID wizard;
// it also still DEFINES the economic band + backs the wizard ask's shown
// numbers), and no forceMode knob exists (the Windows critical-space-
// maintenance model — the only stop is coalwashMode:off, the whole-skill
// power switch). DELETE/MERGE authorization is plan-sourced (the
// adjudicated plan IS the authorization) — safety is UNDO: every cut is
// snapshot-backed and revertible (whole-run rollback), never a human
// pre-approval; the receipt is the surfacing.
//
// TEMPLATE ASKS (beta.12 item 3, ../scripts/lib/ask.mjs): every ask/directive/
// advisory string is built by CODE from numbers alone — the hook never
// composes prose (the RESIDENT-ASK CONTAMINATION incident: an agent-composed
// ask once quoted the store's own design backlog as its rationale, a closed
// loop). Every template embeds the ANSWER-FIRST reminder clause.
//
// CHEAP caliper only on the SessionStart path: file sizes + stamps; content is
// read only for the small always-loaded set; gzip only when informational
// work is already in budget. (This clause used to end "(~100ms total wall
// budget)" — the RETIRED cap board #24 says never to restore; the sibling
// citation at the Stop re-gauge was removed by CWK-082 F5 and this one was
// left standing in the same batch, which is the class-vs-instance failure this
// room bans by name. The author-controllable gate is Phoenix #3's <=5ms of
// ADDED work; a total wall-clock figure is an ENVIRONMENT property.) The Stop path stays
// cheaper still on the COMMON case (Phoenix #3) — one state read, no
// discovery, no measureEntries, no gzip. beta.13 item 3 (WARP-HOLE) adds ONE
// more cheap step when nothing is pending: a stat-only re-check of the
// already-known always-loaded paths (~0.2ms, measured) that GATES a rare,
// conditional full discovery+measure pass — see handleStop below.
//
// NAMED divergence from hooks-safety.md §10 (whose read exception names project
// CONFIG only): this hook also READS project class-B memory/governance CONTENT
// — measuring that content IS the product; reads stay read-only + size-budgeted,
// writes still touch only the two sandbox roots.
//
// The engine lives in ../scripts/lib/*.mjs (ESM) — dynamically imported so this
// CJS hook and the agent-invoked scripts share ONE implementation (a hook that
// reimplements config-load silently diverged once in a sibling; never again).
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const READ_BUDGET_BYTES = 262144; // max always-loaded content read on the hook path
// The stdin budget is an IDLE gap, armed on the FIRST BYTE and re-armed on every
// chunk after it -- NOT a total deadline, and NOT armed at t=0. The retired total
// deadline (STDIN_BUDGET_MS = 30, measured from process start) failed as a function
// of how LATE the FIRST byte arrived, which is a property of host contention rather
// than of anything this hook does: under concurrent spawners the parent's write to
// our pipe slips past 30 ms and a well-formed payload was dropped, so the hook exited
// 0 having done nothing (CWK-072). Measured here at K=40 spawners, 4000 invocations:
// the first byte lands after 30 ms on 25% of invocations (p50 19.5 ms, max 141.9 ms).
// "Idle" therefore means silence since the last PROGRESS -- before the first byte
// there is no progress to measure, and arming this timer at t=0 reproduces the total
// deadline exactly (measured: 31/4000 dropped, against the deadline's own 34/4000).
const STDIN_IDLE_MS = 30;
// ANTI-HANG BACKSTOP -- NOT a delivery-latency threshold, and never to be read as the
// retired 30 ms deadline in a larger costume. It bounds two pathologies only: a writer
// that trickles one byte per idle window forever, and a pipe that is opened, never
// written and never closed. A fail-silent hook that hangs blocks the user's session,
// so the bound must exist.
// WHY THIS NUMBER -- argued from what two independent instruments AGREE on, never from
// a safety factor they do not. Both timed end-of-payload at K=40 with a timer-free
// child, and their worst cases are ~6x apart: the BUILDER's probe (clock started at
// the top of the child script, N=4000) read max 180.8 ms; the REVIEWER's independent
// rebuild (its own origin and its own self-load, N=2000) read max 1189 ms, p99 760 ms.
// Both were AL-1 scratch instruments and are named by ROLE, not by path -- they lived
// under an untracked scratchpad and are in no clean checkout, so the numbers here are
// the durable half. Neither is the other's error -- a latency
// measured from a different origin under a different load is a different quantity --
// so NO multiple derived from either instrument survives the other, and none is
// claimed here. What both DO agree on is the only property this number needs:
// nothing crossed 1500 ms in any cell either of them ran (0/4000 and 0/2000 in the
// timing cells; 0 losses across 4000 post-fix real-hook invocations). The ceiling has
// never cut a real payload -- and THAT, not a headroom factor, is why it must never be
// tuned downward to "tighten" the read: tightening it is the retired deadline rebuilt,
// and on one of the two instruments the measured worst case already sits close enough
// to 1500 ms that a smaller number would begin cutting real payloads.
// WHAT THIS COSTS, stated rather than buried: an absent stdin still resolves at once
// (the pipe is closed, so "end" fires) and a TTY stdin resolves at once (see below),
// but a pipe held open in silence now costs this ceiling where it once cost 30 ms.
// That case has never been observed from Claude Code; the 30 ms version of it was
// dropping real payloads roughly 1% of the time under contention.
const STDIN_HANG_CEILING_MS = 1500;
const DAY_MS = 86400000;

function lib(name) {
  return pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', name)).href;
}

// Read this invocation's hook JSON from stdin ({session_id, hook_event_name,
// ...} per the CC hook contract) — this is how main() tells the SessionStart
// and Stop branches apart. Fail-safe: an absent/short/malformed/
// never-closing stdin resolves to {} within STDIN_IDLE_MS of the last byte (and
// within STDIN_HANG_CEILING_MS overall) rather than ever blocking the hook
// (Phoenix #3/#4) — an unrecognized/missing event name is
// then silently skipped by main() (Phoenix #12/#13: a read failure must
// never be guessed as the loudest branch; see main()'s closing comment).
function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let idle = null;
    let ceiling = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (idle) clearTimeout(idle);
      if (ceiling) clearTimeout(ceiling);
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
      // Release stdin so a still-open pipe can't keep the event loop alive past
      // the budget (the promise resolved, but a flowing stdin would otherwise
      // hold the process to EOF — observed 3.05s vs 0.125s; Phoenix #3/#4).
      try { if (process.stdin.unref) process.stdin.unref(); process.stdin.destroy(); } catch { /* fail-silent */ }
    };
    // Armed by the data handler only — never here, never at t=0 (see STDIN_IDLE_MS).
    const armIdle = () => {
      if (done) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, STDIN_IDLE_MS);
      if (idle.unref) idle.unref();
    };
    try {
      process.stdin.setEncoding('utf8');
      // A TTY stdin carries no hook payload and never ends, so waiting out the
      // anti-hang ceiling would buy nothing — that is a hand-run of this file, never
      // an invocation by the agent, which always pipes.
      if (process.stdin.isTTY) { finish(); return; }
      process.stdin.on('data', (c) => { data += c; armIdle(); });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      ceiling = setTimeout(finish, STDIN_HANG_CEILING_MS);
      if (ceiling.unref) ceiling.unref();
    } catch { finish(); }
  });
}

// Self-update scheduling (series-standard kind-1, the CoalMine/CoalHearth GOLD
// shape): the HOOK only SCHEDULES via a throttled crash-safe stamp — written
// BEFORE the directive prints so a crash never re-nags; no network ever. The
// AGENT verifies + offers, consent-gated.
function updateDue(cfg, clampedRead, caliper) {
  try {
    if (clampedRead(cfg, 'updateMode') === 'off') return false;
    const days = clampedRead(cfg, 'updateCheckDays');
    const home = os.homedir();
    // task #13 pt 3: the GLOBAL update stamp lives at ~/.claude/coal/coalwash/
    // now — read-new/fallback-old, write-new/delete-old (caliper owns the path +
    // migration so the OS-citizen namespace is single-sourced).
    const last = caliper.readUpdateStamp(home);
    const now = Date.now();
    if (last && now - last < days * DAY_MS) return false;
    caliper.writeUpdateStamp(now, home); // written BEFORE the directive prints (crash-safe throttle)
    return true;
  } catch { return false; }
}

async function handleSessionStart(input) {
  const [{ loadMergedConfigReport, unreadableNotice, findProjectRoot, discoverIgnoredConfigs }, { clampedRead, envelopeForConfig }, classB, caliper] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('class-b.mjs')),
    import(lib('caliper.mjs')),
  ]);

  const { cfg, unreadable } = loadMergedConfigReport();
  // UMB-174 (b) + CWK-135 (a): a config that EXISTS where the walk reads but could not be used is REPORTED, once,
  // on this sanctioned channel (Phoenix #13) -- the walk's SELECTION is unchanged, only the silence goes. ONE flock
  // string, built by the lib (the global tier names its own path). Only the two paths the merge already read.
  const notices = unreadable.map((u) => `[CoalWash] ${unreadableNotice(u)}`);
  const mode = clampedRead(cfg, 'coalwashMode');
  if (mode === 'off') {
    // 'off' from an UNREADABLE GLOBAL config is the fail-safe reading of an unknown stance (config-load's W2-3),
    // never the user's own off: staying fully silent then would hide the very reason the skill went quiet. A
    // readable `off` stays fully silent, and so does an unreadable PROJECT config beneath it (nothing to report to
    // someone who switched the skill off).
    const failSafe = unreadable.filter((u) => u.tier === 'global').map((u) => `[CoalWash] ${unreadableNotice(u)}`);
    if (failSafe.length) console.log(failSafe.join('\n')); // sanctioned SessionStart context-injection channel (Phoenix #13)
    return;
  }
  const language = clampedRead(cfg, 'language');
  // task #4: fullPercent/fatMultiple are no longer read — both walls they fed
  // are retired (read-tolerated in config, ignored). The reorg break-even
  // (condition 2b) reads the RE-TIER ENVELOPE instead, resolved by
  // config-schema's envelope resolver — moved there from the RE-TIER module so no
  // hook ever references that module (the "RE-TIER is wizard-only" grep-rail
  // stays strict; the demotion machinery stays unreachable from hooks).
  const envelope = envelopeForConfig(cfg);

  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  const out = [];
  for (const n of notices) out.push(n);

  // UMB-133 hole (1) ONLY, fail-silent by construction (a pure read over the
  // walk this hook already pays for once per SessionStart; throwing is a
  // no-op here, same as every other advisory line below). Hole (2)'s
  // migration notice is DELIBERATELY NOT wired here -- see cli.mjs's
  // `config-status` subcommand for why: this room's own hermetic conductor
  // tests default every sandbox project to the ROOT LEGACY shape, and a real
  // install commonly does too, so an unconditional per-SessionStart notice
  // for it is a nag on the ordinary case, not a rare stray file. Hole (1) has
  // no such collision -- planting a bare dotfile under .agents/.gemini is
  // genuinely rare, so it stays on this sanctioned channel.
  // The resolved root goes IN rather than being derived a third time: this hook
  // already holds `projectRoot` from the line above, and the probe would
  // otherwise walk the marker chain twice more per SessionStart (UMB-133
  // INSPECT F2 -- measured 30 existsSync before, 0 after).
  try {
    for (const p of discoverIgnoredConfigs(process.cwd(), home, projectRoot)) {
      out.push(`[CoalWash] IGNORED: ${p} is not a config path; canonical = .claude/coal/coalwash.json`);
    }
  } catch { /* fail-silent, per hooks-safety.md Phoenix #4 */ }

  // rc.2 SCHEMA MIGRATION + task #13 LOCATION MIGRATION are both LAZY now (in
  // caliper.loadState/saveState): the first gauge read below returns the
  // schema-migrated view (version-stale crossing/verdict reset, leanFloor
  // baseline preserved → prevBand reads LEAN so the store re-enrolls via the
  // qualifying-past rise), and the first gauge WRITE relocates the old-root
  // state to the per-project path + drops the legacy file. No explicit migrate
  // pass needed — the read-purity that used to force a separate step is now the
  // lazy default (a reinstall/upgrade never strands nor false-FULLs the store).

  // 0p writeguard cleanup — run-gated at SessionStart (event, NEVER a clock;
  // 0h-GUARD spirit): drop every prior session's airbag snapshots, keep this
  // session's. NOT a bin sweep / no retention.mjs — the same keep-current
  // discipline as the spawn-meter counter reset. Rides the writeGuard key
  // independently of the gauge mode (the undo net protects manual-mode users
  // too); cheap (readdir + rm of stale dirs), fail-silent.
  if (clampedRead(cfg, 'writeGuard') !== 'off') {
    try {
      const { sweepWriteguard } = await import(lib('writeguard.mjs'));
      sweepWriteguard(projectRoot, input && input.session_id, { home });
    } catch { /* fail-silent */ }
  }

  // The gauge runs only in auto; manual keeps it silent but the self-update
  // scheduler below still runs (its own off-switch is updateMode — standard
  // system #3 is orthogonal to the gauge).
  const managedPaths = clampedRead(cfg, 'managedPaths');
  // CWK-057: read ONCE here, in handleSessionStart's own scope. BOTH consumers
  // sit in different blocks -- recordVerdict inside the gauge block below, the
  // disclosure after it -- and a declaration inside the gauge block would be a
  // ReferenceError for the second one on an empty store, which on a fail-silent
  // hook kills the whole gauge in silence. Hoisting is about SCOPE only: it
  // never decides whether the disclosure fires (see its own gate below).
  const scanEverything = clampedRead(cfg, 'scanEverything') === true;
  const disc = mode === 'auto' ? classB.discoverClassB({ projectRoot, home, managedPaths }) : { entries: [] };
  if (disc.entries.length) {
    // CWK-057: ON lifts the read budget on the gauge path too. Phoenix #3 is
    // NOT breached and is not being quietly stretched: the LETTER of #3 binds
    // PostToolUse to <=5ms of ADDED work (hooks-safety §6 row 3), and this is
    // the SessionStart gauge, which already
    // does a full discoverClassB + a 256KB read by design. ON deliberately
    // costs more than that, which is why it is a user-set opt-in that discloses
    // itself below, never a default. Withholding it from the hook would make
    // the key silently partial on its own primary consumer -- the "guard that
    // looks covered" failure hooks-safety §9 exists to stop.
    const m = caliper.measureEntries(disc.entries, { readBudgetBytes: caliper.readBudgetFor(scanEverything, READ_BUDGET_BYTES), withGzip: false });
    const proj = caliper.recordStamp(home, projectRoot, m.alwaysLoaded.tokensEst) || {};
    // Read BEFORE recordVerdict below overwrites it — the band + hysteresis
    // ("overCeiling") this project was in as of the LAST recorded verdict. No
    // prior verdict (a brand-new project) -> LEAN/un-armed defaults, so a
    // first-ever scan that already lands above the ceiling fires immediately
    // (the "qualifying past" case, the Modloader-shaped scenario).
    const prevBand = (proj.lastVerdict && proj.lastVerdict.band) || 'LEAN';
    const wasOver = !!(proj.lastVerdict && proj.lastVerdict.overCeiling);
    // 0g Q2: the per-episode economic latch, cached/read exactly like the
    // ceiling's own hysteresis bit above.
    const wasEconLatched = !!(proj.lastVerdict && proj.lastVerdict.econLatched);
    // 0d/0f (supersedes 0e "THE OBESE LOOP"): read BEFORE this session's own
    // state changes — whether a mechanical Quick pass was already
    // auto-triggered this episode (see caliper.recordCrossing's
    // escalation-arm branch below).
    const quickTried = !!proj.quickTried;

    const now = Date.now();
    // task #4: no floor stamp of any kind — fat and muscle are MEASURED at
    // this very gauge (measureEntries' certain-fat scan), so the numbers are
    // current by construction; nothing has to have happened first (the 0j
    // provisional-floor install stamp this block used to write is retired
    // with the floor-driven band).
    // gaugeVerdict (shared with the Stop hook's gated re-gauge, beta.13 item
    // 3) does the economics -> bandVerdict glue in ONE place (0g Q4:
    // economics run BEFORE the band, because the band IS the break-even) —
    // see caliper.mjs for why this is factored out rather than re-derived by
    // hand at a second call site.
    // CWK-081: the capacity ADAPTER runs HERE and only here on this path —
    // SessionStart already pays for a full discovery+measure, so one small
    // in-sandbox JSON read rides along free; the Stop hot path never calls it
    // (Phoenix #3), it renders the cached number instead.
    const gv = caliper.gaugeVerdict({ measure: m, wasOver, wasEconLatched, stamps: proj.stamps, envelope, capacity: caliper.discoverCapacity({ home }) });
    const { verdict, fatTokens, economical, perDay, breakEvenDays } = gv;

    // WARP-HOLE (beta.13 item 3): the always-loaded path list + byte total —
    // the Stop hook's cheap re-stat baseline for catching a within-session
    // spike without paying for a full re-gauge on every turn.
    const alwaysLoadedPaths = disc.entries.filter((e) => e.alwaysLoaded).map((e) => e.path);
    // CWK-082 L2: computed HERE, where the entries and their sizes already exist,
    // so the Stop path can NAME the residue off the cache instead of re-walking
    // the store (Phoenix #3). One implementation, and it lives in the lib. The
    // gated re-gauge below threads it too — a fix at one of two caching sites
    // would let the OTHER one blank the list it is about to render.
    const externalizable = caliper.externalizableResidue(disc.entries);

    // Cache everything the Stop hook needs to act WITHOUT re-measuring
    // (Phoenix #3): the verdict itself, the ceiling's hysteresis bit
    // (`overCeiling`, read back next time as `wasOver`), the payback
    // numbers (now available to ANY ask, not just FULL's — queue 0c), and
    // the WARP-HOLE re-stat baseline.
    caliper.recordVerdict(home, projectRoot, {
      band: verdict.band, reason: verdict.reason, economical, fatTokens,
      overCeiling: verdict.over, econLatched: verdict.econLatched,
      perDay, breakEvenDays,
      // task #4 — the new measured pair + the reorg proof's numbers, cached
      // for the Stop hook's ask rendering (additive fields, no schema bump:
      // lastVerdict is a per-gauge cache overwritten fresh at every gauge).
      muscleTokens: gv.muscleTokens, demotableTokens: gv.demotableTokens,
      reorgPerDay: gv.reorgPerDay, reorgBreakEvenDays: gv.reorgBreakEvenDays,
      hardCeilingTokens: verdict.hardCeilingTokens, capacitySource: gv.capacitySource,
      alwaysLoadedPaths, alwaysLoadedBytes: m.alwaysLoaded.bytes, externalizable,
      storeTotalBytes: m.totalBytes, // the WHOLE measured store — the bin-retention budget base (P5/P8)
    }, now, { scanEverything }); // CWK-057: ON lifts the 200-path cap on the Stop re-stat baseline
    // Uniform once-per-crossing arming on the band itself — no more
    // reason-based carve for externalize (beta.10's old F1 rule): Stop now
    // dispatches on the CACHED reason within the FULL band (see handleStop),
    // so a rise into FULL/externalize is delivered exactly once, the same
    // guarantee every other crossing already gets, instead of being silently
    // un-trackable. quickTried/fatTokens (0f, supersedes 0e) additionally
    // arm a same-band FULL "escalation" crossing (the wizard ask) once a
    // force-run already tried Quick this episode and fat has genuinely
    // grown since — see recordCrossing. OBESE never arms this any more (0d:
    // auto-Quick-silent only).
    caliper.recordCrossing(home, projectRoot, verdict.band, prevBand, now, { quickTried, fatTokens, session: input && input.session_id });
  }

  // CWK-057 rot-canary MEDIUM (self-found, shipped in 2c6cad0, fixed here):
  // `disc.entries.length` is REQUIRED, not decoration. Gated on the flag alone
  // this line fired on two paths where NO SCAN RAN AT ALL -- coalwashMode
  // 'manual' (the gauge is deliberately silent, so disc is {entries: []}) and
  // auto with an empty class-B store -- and said "were bypassed this run" about
  // an event that did not occur. CoalMine's own LOW here (ee15ade) over-stated a
  // SCOPE; this over-stated an EVENT, on the one surface whose whole job is
  // telling a user what this tool just did to their memory. The gauge block
  // above is the only thing that bypasses anything, so the disclosure states
  // what it did, never what the config would have allowed.
  if (scanEverything && disc.entries.length) {
    // Bounded on BOTH sides: what was lifted, and what stays out of reach.
    // Second over-claim caught in the same pass: this used to say "every
    // always-loaded entry is actually read", which is false whenever a read
    // THROWS -- measureEntries catches it and that entry contributes 0 certain
    // fat, the same fail-toward-silence path the budget takes. What the bypass
    // actually guarantees is that nothing is skipped FOR BUDGET, so that is
    // what it now claims.
    out.push('[CoalWash] Scan scope: scanEverything is ON — both SCAN-scope cuts were bypassed for the gauge that just ran: (1) the always-loaded READ BUDGET (262144 B) is lifted, so no always-loaded entry is skipped for budget and its certain fat is measured instead of counting as muscle by default (an entry whose read FAILS still contributes nothing — that path is unchanged); (2) the 200-path cap on the Stop hook\'s cheap re-stat baseline is not applied. It widens only what is SEEN: keeps.json, the KEEPS-GATE, every other delete gate, localOnly and every consent gate are untouched — nothing is deleted, merged or mutated that would not have been. Still narrower than "everything": recall-tier entries are sized from stat bytes and never read, and a file the platform never surfaced as class-B is not here. Costs more than a normal gauge by design. Set scanEverything to false to restore the normal scan scope.');
  }

  if (updateDue(cfg, clampedRead, caliper)) {
    out.push('[CoalWash] [self-update due] Offer the /coalwash:update check: web-check the latest CoalWash tag vs the installed plugin.json version; if newer, OFFER `claude plugin update coalwash@coalwash`; if current, say "up to date"; if git/network is unavailable, say so and suggest updating manually later (never assume). Consent-gated; the hook only scheduled it.');
  }

  if (out.length) {
    if (language !== 'auto') out.push(`[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, and paths verbatim)`);
    console.log(out.join('\n')); // sanctioned SessionStart context-injection channel (Phoenix #13)
  }
}

// Stop conductor branch — the ONLY ask/directive/advisory delivery surface
// (beta.12 band collapse). HOT-PATH BUDGET (Phoenix #3): a config read (2
// small JSON files, no discovery/measureEntries) + ONE state read
// (loadState — one per-project file) — the TRUE happy case (nothing pending AND the
// WARP-HOLE stat-only gate below finds no meaningful drift) exits at ~0.2ms
// extra, still no discovery/measureEntries. A pending crossing, or a
// gate-tripped within-session spike (beta.13 item 3), is the only path that
// does more — and even then every ask/directive is a pure string builder
// (ask.mjs) over already-cached (or just-refreshed) numbers, never a
// re-measurement beyond the one gated discovery+measure pass.
//
// OUTPUT MECHANISM (deliberately NOT plain console.log, unlike SessionStart):
// mirrors rot-canary-stop.js exactly — a structured
// `{decision:'block', reason}` JSON write to stdout. That structure is what
// makes Claude Code hold the stop and hand `reason` back to the agent as
// something it must address, instead of a passive context line it can ignore.
// `stop_hook_active` is checked first, same as rot-canary, so CC re-invoking
// Stop after the agent responds to a block decision can never loop.
//
// CONSUME-AT-EMISSION (ponytail, full rationale in caliper.mjs on
// consumeCrossing): the crossing is marked consumed the instant this function
// surfaces it — never on a later "the user picked X" signal, since no CLI
// exists for the agent to report that back. Every pending crossing SURFACES
// (ask, force, or the externalize advisory) — there is no silent branch: a
// silent FULL would be the forbidden third "dismiss and keep growing" path
// (the saving-guarantee floor). Post-0m the FULL surfacing is the forced
// run's own receipt numbers (oneLineResult) — the user always sees what
// happened; the wizard-escalation ask remains the only question ever asked.
async function handleStop(input) {
  if (input && input.stop_hook_active) return; // avoid the block-decision retrigger loop
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead, envelopeForConfig }, caliper, ask, classB] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('caliper.mjs')),
    import(lib('ask.mjs')),
    import(lib('class-b.mjs')),
  ]);
  const cfg = loadMergedConfig();
  // coalwashMode:off = the skill's whole power switch — and the ONLY stop
  // (0m: force itself has no off switch; a legacy forceMode key in a config
  // is read-tolerated and ignored, see config-schema.mjs RETIRED_KEYS).
  if (clampedRead(cfg, 'coalwashMode') === 'off') return; // fully silent
  const managedPaths = clampedRead(cfg, 'managedPaths');

  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  let proj = caliper.loadState(projectRoot, home);
  const now = Date.now();
  let lastVerdict = (proj.lastVerdict && typeof proj.lastVerdict === 'object') ? proj.lastVerdict : {};
  let crossing = caliper.sanitizeCrossing(proj.lastCrossing);

  if (!crossing) {
    // WARP-HOLE (beta.13 item 3, MEMORY.md "WARP-HOLE + WARM COST"): a
    // within-session spike (e.g. a MEMORY.md crystallize write) sits
    // uncaught under the pure-cache read above until the NEXT SessionStart.
    // CWK-082 findings-back F5 — this paragraph and the SessionStart one above
    // used to read hooks-safety Phoenix #3 two OPPOSITE ways in one file: there
    // as PostToolUse-only, here as binding this Stop path. Settled, and the
    // reading is the conservative one rather than a licence: the LETTER of #3
    // is PostToolUse (§6 row 3). Stop is not PostToolUse, so #3 does not bind
    // it — this path holds the SAME <=5ms discipline BY CHOICE, because Stop
    // fires every turn and is the same hot class §2 says to grade by what a
    // hook ADDS. Never cite #3 as if it compelled this budget.
    // MEASURED ad-hoc before shipping (not a flaky in-suite ms-assertion — the
    // WARP-HOLE BEHAVIOR itself is pinned in conductor.test.mjs): an
    // UNCONDITIONAL full re-gauge (discoverClassB+measureEntries) costs
    // ~7-18ms on real repos, which is why it is not paid on EVERY Stop call.
    // ⚠ THAT FIGURE IS RETIRED AS A LIVE CLAIM (CWK-082 F4): re-measured on
    // the real call at this box, discoverClassB alone runs far slower than
    // 7-18ms on a real store — the numbers and their n live in the findings-
    // back record, never pinned here where they rot. The DESIGN is unchanged
    // and the re-measurement only strengthens it: the full re-gauge is even
    // more worth gating than the old figure suggested. The cheap half: an
    // ALWAYS-ON stat-only gate (re-stat the paths already discovered at the
    // last gauge — no directory walk, no content read; measured ~0.15-0.3ms on
    // the SAME repos) decides whether the expensive full re-gauge is worth
    // paying for THIS turn.
    // The old text closed by calling the re-gauge "well under the <=100ms
    // including-a-scan cap". That cap is RETIRED (board #24: a total wall-clock
    // figure is an ENVIRONMENT property, not one the author controls — never
    // restore one), so citing it as live was a second defect in the same
    // paragraph. Removed rather than re-worded.
    const cachedPaths = Array.isArray(lastVerdict.alwaysLoadedPaths) ? lastVerdict.alwaysLoadedPaths : null;
    const cachedBytes = Number(lastVerdict.alwaysLoadedBytes);
    if (cachedPaths && cachedPaths.length && Number.isFinite(cachedBytes)) {
      const freshBytes = caliper.statOnlyFootprintBytes(cachedPaths);
      const deltaTokens = caliper.tokensEstFromBytes(Math.abs(freshBytes - cachedBytes));
      if (deltaTokens > caliper.REGAUGE_DELTA_TOKENS) {
        const disc = classB.discoverClassB({ projectRoot, home, managedPaths });
        const scanEverything = clampedRead(cfg, 'scanEverything') === true; // CWK-057, same clamped cascade
        const m = caliper.measureEntries(disc.entries, { readBudgetBytes: caliper.readBudgetFor(scanEverything, READ_BUDGET_BYTES), withGzip: false });
        // task #4: same measured-not-stamped gauge as SessionStart — fat and
        // muscle come from THIS measure's certain-fat scan; the 0j
        // provisional-floor door this block used to share is retired with
        // the floor-driven band. The reorg envelope resolves via
        // config-schema's envelope resolver (see the SessionStart site's
        // comment for why it does NOT live in the RE-TIER module).
        const gv = caliper.gaugeVerdict({ measure: m, wasOver: !!lastVerdict.overCeiling, wasEconLatched: !!lastVerdict.econLatched, stamps: proj.stamps, envelope: envelopeForConfig(cfg), capacity: caliper.discoverCapacity({ home }) }); // CWK-081: the gated re-gauge is the OTHER full-measure site, so the adapter rides it too
        const alwaysLoadedPaths = disc.entries.filter((e) => e.alwaysLoaded).map((e) => e.path);
        const externalizable = caliper.externalizableResidue(disc.entries); // CWK-082 L2, same as the SessionStart gauge
        caliper.recordVerdict(home, projectRoot, {
          band: gv.verdict.band, reason: gv.verdict.reason, economical: gv.economical, fatTokens: gv.fatTokens,
          overCeiling: gv.verdict.over, econLatched: gv.verdict.econLatched,
          perDay: gv.perDay, breakEvenDays: gv.breakEvenDays,
          muscleTokens: gv.muscleTokens, demotableTokens: gv.demotableTokens,
          reorgPerDay: gv.reorgPerDay, reorgBreakEvenDays: gv.reorgBreakEvenDays,
          hardCeilingTokens: gv.verdict.hardCeilingTokens, capacitySource: gv.capacitySource, alwaysLoadedPaths, alwaysLoadedBytes: m.alwaysLoaded.bytes, externalizable,
          storeTotalBytes: m.totalBytes, // same base as SessionStart (P5/P8)
        }, now, { scanEverything }); // CWK-057, same clamped flag as the gauge above
        caliper.recordCrossing(home, projectRoot, gv.verdict.band, lastVerdict.band || 'LEAN', now, { quickTried: !!proj.quickTried, fatTokens: gv.fatTokens, session: input && input.session_id });
        proj = caliper.loadState(projectRoot, home); // re-read what we just (maybe) armed
        lastVerdict = (proj.lastVerdict && typeof proj.lastVerdict === 'object') ? proj.lastVerdict : {};
        crossing = caliper.sanitizeCrossing(proj.lastCrossing);
      }
    }
    if (!crossing) return; // still nothing pending -> silent (Phoenix #13)
  }

  const fatTokens = Number.isFinite(lastVerdict.fatTokens) ? Math.round(lastVerdict.fatTokens) : 0;
  const breakEven = {
    perDay: Number.isFinite(lastVerdict.perDay) ? lastVerdict.perDay : 0,
    breakEvenDays: Number.isFinite(lastVerdict.breakEvenDays) ? lastVerdict.breakEvenDays : null,
  };
  // task #4 condition 2b — the reorg proof's own numbers, cached by the gauge
  // beside the fat proof's (absent on a pre-task-#4 cache -> zeros, which the
  // ask template renders as "no reorg case", never undefined artifacts).
  const reorg = {
    demotableTokens: Number.isFinite(lastVerdict.demotableTokens) ? Math.round(lastVerdict.demotableTokens) : 0,
    perDay: Number.isFinite(lastVerdict.reorgPerDay) ? lastVerdict.reorgPerDay : 0,
    breakEvenDays: Number.isFinite(lastVerdict.reorgBreakEvenDays) ? lastVerdict.reorgBreakEvenDays : null,
  };
  // 0o: the session's accumulated sub-spawn parcel bill — rides the FULL
  // directive numbers as ONE clause (absent at zero; the meter itself never
  // speaks, this is one of the pre-existing voices).
  const spawns = { subSpawns: proj.subSpawns, subParcelTokens: proj.subParcelTokensAccum };

  let reason;
  if (crossing.band === 'FULL' && lastVerdict.reason === 'externalize') {
    // CWK-081 (1) — ELIGIBILITY, checked before the advisory can speak. The
    // capacity branch used to assert "muscle, not bloat" off a MECHANICAL
    // lower-bound reading and steer the user into relocating content that
    // nothing had judged. The semantic pass is the instrument that turns
    // unknown text into known muscle, so: no Full-tier pass removed anything
    // this episode -> this is the Full-tier CONSENT, not an advisory. (owner
    // ruling 2026-09-06 — decide delete/shrink/stand BEFORE moving things.)
    // The flag is per-TRANSACTION, not per-store (round-2 F1), so it gates only
    // WHICH text speaks; the advisory itself disclaims what the pass did not
    // touch rather than this branch pretending to know the coverage.
    const fullCleaned = Number.isFinite(Number(proj.fullCleanAt));
    // CWK-081 (3) — and either way this surface speaks at most ONCE per
    // session. Measured: 4 consecutive Stops during one live wizard run,
    // because a consumed FULL crossing can be re-armed inside the same session
    // and this branch is checked first, so consume-at-emission does not bound
    // it. Suppressed => consume the crossing and stay silent (Phoenix #13):
    // the crossing must not dangle, and repeating pure information is the
    // defect being closed.
    if (!caliper.armExternalize(home, projectRoot, input && input.session_id, now).surface) {
      caliper.consumeCrossing(home, projectRoot, now);
      return;
    }
    reason = fullCleaned
      ? ask.externalizeAdvisory({ hardCeilingTokens: lastVerdict.hardCeilingTokens, capacitySource: lastVerdict.capacitySource, residue: lastVerdict.externalizable, judgedFiles: proj.fullCleanFiles })
      : ask.wizardEscalation({
        cause: 'capacity-unmeasured',
        fatTokens, breakEven, reorg, spawns,
        hardCeilingTokens: lastVerdict.hardCeilingTokens,
        capacitySource: lastVerdict.capacitySource,
      });
    // Neither outcome is a force and neither touches muscle: the ELIGIBLE side
    // is pure information (a wash cannot shrink muscle — the growable-full
    // invariant's forbidden "wash harder on muscle" move), the INELIGIBLE side
    // is a two-button consent. reason==='externalize' is still checked FIRST,
    // so this branch remains the only route either can take.
  } else if (crossing.band === 'FULL' && crossing.escalation) {
    // case (c) — 0f "AUTHORITATIVE 3-FLOW": a force-run already tried Quick
    // this episode and the store is STILL over FULL — only the wizard's
    // semantic tier can help now; this IS a real ask, the ONE ask site in
    // the whole system (0d: OBESE is auto-Quick-silent, it never asks).
    // Checked BEFORE the force branch below so an armed escalation crossing
    // can never be re-swallowed into another silent force-Quick loop.
    reason = ask.wizardEscalation({ fatTokens, breakEven, reorg, spawns });
  } else if (crossing.band === 'FULL') {
    // case (b) — 0m "FORCE = THE FREE TIER, NO PROOF NEEDED" + "FORCE IS A
    // DICTATOR, NO OFF SWITCH": every FULL crossing (economic AND
    // absolute-cap; externalize already routed above) force-runs the FREE
    // mechanical Quick pass UNCONDITIONALLY — the same standing consent as
    // OBESE's auto-Quick (the misapplied economic-dominance proof gate is
    // gone: that proof governs the PAID wizard, not a ~0-cost undo-backed
    // code sweep; the old fresh-`economical` requirement made the heavier
    // band do LESS than OBESE on a day-one over-wall store, the live bug).
    // No forceMode knob exists any more (the Windows critical-space-
    // maintenance model — safety lives in UNDO: snapshot + rollback + bins;
    // the receipt numbers are the surfacing, so no-silent-branch holds).
    // Force always runs Quick -> markQuickTried arms 0f's wizard-escalation
    // leg above for the next still-over gauge.
    const footprintTokens = Number.isFinite(Number(lastVerdict.alwaysLoadedBytes))
      ? caliper.tokensEstFromBytes(Number(lastVerdict.alwaysLoadedBytes)) : null;
    reason = ask.forceAuto({
      fatTokens, breakEven, reason: lastVerdict.reason,
      footprintTokens, hardCeilingTokens: lastVerdict.hardCeilingTokens,
      spawns,
    });
    caliper.markQuickTried(home, projectRoot, now);
  } else {
    // case (d) — OBESE (the only other band sanitizeCrossing admits) — 0d
    // "OBESE AUTO-QUICK, NO ASK" + F3: UNCONDITIONAL standing-consent
    // auto-Quick (the schema admits only 'quick' for obese; a legacy 'full'
    // clamps to 'quick' at read). No ask, run the free mechanical pass now.
    reason = ask.obeseAutoQuick({ fatTokens, breakEven });
    caliper.markQuickTried(home, projectRoot, now);
  }

  // LANGUAGE (series standard system #2) — the Stop channel was the ONE
  // delivery surface that never carried the locked-language clause the
  // SessionStart and seatbelt channels both emit; every directive above ends in
  // a user-facing push (the one-line receipt at minimum), so the lock has to
  // reach here too. `auto` stays silent by design: following the conversation's
  // language is baseline agent behaviour and costs no tokens to ask for.
  const language = clampedRead(cfg, 'language');
  if (language !== 'auto') {
    reason += `\n[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, paths, numbers, and units verbatim)`;
  }

  caliper.consumeCrossing(home, projectRoot, now); // once per crossing (consume-at-emission)
  process.stdout.write(JSON.stringify({ decision: 'block', reason })); // sanctioned Stop blocking-feedback channel (Phoenix #13; mirrors rot-canary-stop.js)
}

// 0o "SUBAGENT BLIND SPOT" — the TRUE-BILL COUNTER (spawn meter). The
// sub-agent spawn tools per the CoalHearth Incident-E precedent: `Agent`
// (legacy alias `Task`) + `Workflow`. hooks.json's PostToolUse matcher
// ("Agent|Task|Workflow") is the platform-level skip — every other tool
// never even invokes this process; this Set is the in-code belt for
// platforms/versions that ignore matchers, checked BEFORE any import so the
// non-match path costs ~nothing.
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);

// PostToolUse(Agent) -> one silent counter increment at the SPAWN SITE
// (main — the only place the parcel cost is actually incurred; hooks never
// fire inside subs, the named platform constraint 0o ships honestly).
// NOISE RULE (0o, pinned, absolute): this branch emits NOTHING on any path —
// write-only bookkeeping (Phoenix #13); N spawns = N silent increments = one
// louder NUMBER at the surfaces that already speak (/coalwash:stats · the
// FULL force/wizard directive numbers). Cost source = the CACHED verdict's
// alwaysLoadedBytes only (recordSubSpawn reads it — one small state
// read+write, no discovery, no re-gauge, no content I/O: the Phoenix #3
// match-path budget is the markQuickTried cost class, structurally proven
// in the hermetic tests the way the warp-gate structural test is — never a
// wall-clock CI assertion). Note: PostToolUse fires for a SUB's own tool
// calls too, so a sub spawning a sub-sub is counted by this same meter.
async function handleSpawnMeter(input) {
  if (!input || !SPAWN_TOOLS.has(input.tool_name)) return; // belt: pre-import, ~free
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, caliper] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('caliper.mjs')),
  ]);
  const cfg = loadMergedConfig();
  // Meter rides the same mode as the gauge lifecycle that resets it
  // (recordStamp fires only in auto): manual/off = no gauge, no session
  // boundary, no meter — the stats line stays an honest SESSION figure.
  if (clampedRead(cfg, 'coalwashMode') !== 'auto') return;
  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  caliper.recordSubSpawn(home, projectRoot);
  // NOTHING is emitted here, ever (the NOISE RULE) — not on success, not on
  // the 10th spawn, not at any threshold.
}

// The write tools the 0p seatbelt/airbag ride (hooks.json matchers
// "Edit|Write|MultiEdit"). This Set is the in-code belt for platforms/versions
// that ignore matchers — checked BEFORE any import so a non-write tool never
// pays anything.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// The touched file path from an Edit/Write/MultiEdit tool_input (the stable CC
// arg key, confirmed vs rot-canary/CoalHearth's shipped hooks).
//
// RESIDUE, BY DESIGN, NAMED SO IT IS NOT RE-DERIVED (CWK-082 L3): this is the
// exact reason the airbag cannot cover a SHELL-mediated write.
//
// WHAT DECIDES IT IS COST, AND THE NUMBER IS HERE (INSPECT F-B2 — this note
// used to LEAD with the parser argument below, which a reader can answer, so
// the note invited exactly the re-derivation it exists to prevent). A
// PreToolUse(Bash) matcher puts ONE conductor PROCESS SPAWN on EVERY shell
// call. Measured through this real hook file, spawned the way the platform
// spawns it, n=25, arms ALTERNATED, hermetic sandboxed HOME/TEMP:
//
//   Bash payload            min  79.547  median  88.730  max 110.528  ms
//   Edit payload (CONTROL)  min  95.346  median 107.245  max 124.604  ms
//
// The control is what makes the figure mean SPAWN rather than payload: same
// order, and it is not a no-op — the Edit arm really fired the airbag and wrote
// 3 snapshot files. Instrument: scratchpad/r31/probe-fb2-spawn.mjs. INSPECT
// measured the same arm on its own separate instrument (78.804 / 82.106 /
// 103.652, n=25) and agrees; two harnesses, same order of magnitude, cited as
// two rather than merged into one — and the figure is quoted as the SPAN the
// two produced, 82-89 ms at the median, never a midpoint neither of them
// measured. Roughly eighty-odd milliseconds on EVERY shell call, to cover a
// narrow case, is the trade this refuses — Phoenix #3, the hottest path in a
// session. The exact per-arm distributions are the tables above; do not
// re-round them into one number.
//
// THE PARSER ARGUMENT IS TRUE AND IS *NOT* WHAT DECIDES IT. A Bash payload
// carries a command STRING, not a file_path, so this function has nothing to
// read and no correct answer to give, and a parser that half-works would
// produce an airbag that fires SOMETIMES — worse than one that admits it is
// absent (a user told "protected" who is protected part of the time stops
// taking their own precautions). BUT an airbag on Bash NEED NOT PARSE ANYTHING:
// the guarded set is small and already enumerable, so it could snapshot THE
// WHOLE SET unconditionally on the first Bash call and early-return, and
// writeguard.mjs's own first-write-only check already makes that O(1)
// afterwards. That shape defeats the parser objection cleanly and still pays
// the spawn above on every shell call — which is why the answer does not move.
// So the LIMIT is disclosed in the externalize template instead (ask.mjs),
// which steers the move toward the channel the airbag genuinely covers. Do not
// "fix" this by adding a shell parser here, and do not re-open the question on
// the parser argument alone — it was already answered above.
function touchedPath(input) {
  const inp = input && input.tool_input;
  return inp && typeof inp.file_path === 'string' ? inp.file_path : '';
}

// AIRBAG (0p) — PreToolUse(Edit|Write|MultiEdit): snapshot-on-first-write to a
// guarded class-B file. WRITE-ONLY, emits NOTHING (fail-silent; the airbag's
// own failure must never block the write). The cheap prefilter
// (isGuardedTarget) runs inside snapshotOnFirstWrite so a source-code edit
// skips after one realpath — no discovery walk EVER on the write path.
async function handleAirbag(input) {
  try {
    if (!input || !WRITE_TOOLS.has(input.tool_name)) return; // belt: pre-import, ~free
    const p = touchedPath(input);
    if (!p) return;
    const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, writeguard] = await Promise.all([
      import(lib('config-load.mjs')),
      import(lib('config-schema.mjs')),
      import(lib('writeguard.mjs')),
    ]);
    const cfg = loadMergedConfig();
    if (clampedRead(cfg, 'coalwashMode') === 'off') return; // master kill
    if (clampedRead(cfg, 'writeGuard') === 'off') return;   // its own off switch
    const home = os.homedir();
    const projectRoot = findProjectRoot(process.cwd(), home);
    writeguard.snapshotOnFirstWrite(projectRoot, input.session_id, p, { home });
    // NOTHING emitted (airbag is write-only) — Phoenix #13.
  } catch { /* fail-silent — never block a write */ }
}

// SEATBELT (0p) — PostToolUse(Edit|Write|MultiEdit): after a guarded write,
// diff {airbag snapshot, current disk} through the wash's fidelity gate and
// inject ONE advisory line on a structured-token drop (or the oversize note).
// ADVISORY ONLY — plain stdout context injection (a sanctioned channel, the
// same class as the conductor's own SessionStart injection), NEVER
// {decision:'block'}, NEVER exit nonzero. Clean edits = silent. writeGuard
// 'snapshot-only'/'off' silences the advisory (the airbag still ran).
async function handleSeatbelt(input) {
  try {
    if (!input || !WRITE_TOOLS.has(input.tool_name)) return; // belt: pre-import, ~free
    const p = touchedPath(input);
    if (!p) return;
    const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, writeguard, ask] = await Promise.all([
      import(lib('config-load.mjs')),
      import(lib('config-schema.mjs')),
      import(lib('writeguard.mjs')),
      import(lib('ask.mjs')),
    ]);
    const cfg = loadMergedConfig();
    if (clampedRead(cfg, 'coalwashMode') === 'off') return;   // master kill
    if (clampedRead(cfg, 'writeGuard') !== 'on') return;      // snapshot-only/off = no advisory
    const home = os.homedir();
    const projectRoot = findProjectRoot(process.cwd(), home);
    const r = writeguard.seatbeltCheck(projectRoot, input.session_id, p, { home });
    if (!r) return;                                    // not guarded / no baseline / clean-read miss -> silent
    if (!r.oversize && (!r.classes || !r.classes.length)) return; // clean edit -> silent
    const language = clampedRead(cfg, 'language');
    const out = ask.seatbeltAdvisory({ file: r.file, classes: r.classes, snapshotPath: r.snapshotPath, oversize: r.oversize });
    const langLine = language !== 'auto' ? `\n[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, and paths verbatim)` : '';
    console.log(out + langLine); // sanctioned advisory context-injection channel (Phoenix #13; advisory only, never a block)
  } catch { /* fail-silent */ }
}

async function main() {
  const input = await readStdinJson();
  const event = (input && (input.hook_event_name || input.hookEventName)) || '';
  if (event === 'Stop') return handleStop(input);
  if (event === 'PreToolUse') return handleAirbag(input);
  if (event === 'PostToolUse') {
    // Two matchers share PostToolUse: the 0o spawn meter (Agent|Task|Workflow)
    // and the 0p seatbelt (Edit|Write|MultiEdit). A tool is one or the other,
    // never both — dispatch by tool_name.
    if (input && SPAWN_TOOLS.has(input.tool_name)) return handleSpawnMeter(input);
    return handleSeatbelt(input);
  }
  if (event === 'SessionStart') return handleSessionStart(input);
  // Phoenix #12/#13: an unrecognized event — including '' from a stdin read
  // that failed/timed out (readStdinJson() resolves {} on any parse error,
  // never throws) — must never be GUESSED as SessionStart. The four checks
  // above are hooks.json's entire wired vocabulary; defaulting the unknown
  // case to the loudest branch (SessionStart can print the self-update-due
  // line) turned a rare stdin race on ANY event into spurious noise during
  // e.g. a Stop turn. Silence is the fail-safe response to "we don't know
  // what this invocation is", matching Stop's own "nothing pending -> return"
  // shape. (Formerly an unconditional `return handleSessionStart(input);`.)
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
