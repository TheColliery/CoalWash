#!/usr/bin/env node
'use strict';
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
//                   config, never an ask), or the FULL(externalize)
//                   pure-information advisory — never an ask, since washing
//                   cannot help ~all-muscle over capacity. Mirrors
//                   rot-canary-stop.js's exact output mechanism — a
//                   structured `{decision:'block', reason}` JSON write, not
//                   plain console.log — because THAT is what makes Stop a
//                   blocking channel the agent must address, unlike a
//                   passive context injection it was always free to ignore
//                   (beta.10 "ROUND 4 POSTMORTEM").
//
// BANDS (0g "FULL = THE ECONOMIC CUT-POINT" + 0g-RESOLUTION + 0m, MEMORY.md
// — refines the beta.12 band collapse): purely economic, nested LEAN <
// OBESE < FULL. OBESE = the hysteresis-gated BMI ceiling armed but carry <
// wash (auto-Quick-silent); FULL = the ceiling armed AND
// breakEven.economical (Q1: FULL ⊂ OBESE), LATCHED per episode (Q2 —
// cleared by the LEAN reset); the WALL (fullPercent x capacity) keeps its
// three roles (Q3): pre-floor bootstrap cap, wash-first when armed,
// externalize when ~all-muscle. FORCE AT FULL IS NON-OPTIONAL (0m "FORCE IS
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
// work is already in budget (~100ms total wall budget). The Stop path stays
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
const STDIN_BUDGET_MS = 30; // never let an absent/stalled stdin block the hook past this
const DAY_MS = 86400000;

function lib(name) {
  return pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', name)).href;
}

// Read this invocation's hook JSON from stdin ({session_id, hook_event_name,
// ...} per the CC hook contract) — this is how main() tells the SessionStart
// and Stop branches apart. Fail-safe: an absent/short/malformed/
// never-closing stdin resolves to {} within STDIN_BUDGET_MS rather than ever
// blocking the hook (Phoenix #3/#4) — an unrecognized/missing event name just
// falls through to the SessionStart gauge (its existing default).
function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
      // Release stdin so a still-open pipe can't keep the event loop alive past
      // the budget (the promise resolved, but a flowing stdin would otherwise
      // hold the process to EOF — observed 3.05s vs 0.125s; Phoenix #3/#4).
      try { if (process.stdin.unref) process.stdin.unref(); process.stdin.destroy(); } catch { /* fail-silent */ }
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      const t = setTimeout(finish, STDIN_BUDGET_MS);
      if (t.unref) t.unref();
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
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, classB, caliper] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('class-b.mjs')),
    import(lib('caliper.mjs')),
  ]);

  const cfg = loadMergedConfig();
  const mode = clampedRead(cfg, 'coalwashMode');
  if (mode === 'off') return; // fully silent
  const language = clampedRead(cfg, 'language');
  const fullPercent = clampedRead(cfg, 'fullPercent');

  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  const out = [];

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
  const disc = mode === 'auto' ? classB.discoverClassB({ projectRoot, home, managedPaths }) : { entries: [] };
  if (disc.entries.length) {
    const m = caliper.measureEntries(disc.entries, { readBudgetBytes: READ_BUDGET_BYTES, withGzip: false });
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
    // 0j "BMI ON AT INSTALL": a never-seen store gets a PROVISIONAL floor =
    // this very footprint (BMI 1.00 live from day one); an existing floor —
    // real or provisional — passes through UNTOUCHED (never ratchets; only
    // a gate-passed clean's setLeanFloor overwrites it). Same state file the
    // stamp/verdict writes on this path already touch — not a new mutation
    // class (Phoenix #10).
    const floorInfo = caliper.ensureProvisionalFloor(home, projectRoot, m.alwaysLoaded.tokensEst, now);
    // gaugeVerdict (shared with the Stop hook's gated re-gauge, beta.13 item
    // 3) does the floor-sanitize -> economics -> bandVerdict glue in ONE
    // place (0g Q4: economics now run BEFORE the band, because the band IS
    // the break-even) — see caliper.mjs for why this is factored out rather
    // than re-derived by hand at a second call site.
    const gv = caliper.gaugeVerdict({ measure: m, rawLeanFloorTokens: floorInfo.floorTokens, floorProvisional: floorInfo.provisional, fullPercent, wasOver, wasEconLatched, stamps: proj.stamps });
    const { verdict, fatTokens, economical, perDay, breakEvenDays, floorUnmeasured } = gv;

    // WARP-HOLE (beta.13 item 3): the always-loaded path list + byte total —
    // the Stop hook's cheap re-stat baseline for catching a within-session
    // spike without paying for a full re-gauge on every turn.
    const alwaysLoadedPaths = disc.entries.filter((e) => e.alwaysLoaded).map((e) => e.path);

    // Cache everything the Stop hook needs to act WITHOUT re-measuring
    // (Phoenix #3): the verdict itself, the ceiling's hysteresis bit
    // (`overCeiling`, read back next time as `wasOver`), the payback
    // numbers (now available to ANY ask, not just FULL's — queue 0c), and
    // the WARP-HOLE re-stat baseline.
    caliper.recordVerdict(home, projectRoot, {
      band: verdict.band, reason: verdict.reason, economical, fatTokens,
      overCeiling: verdict.over, econLatched: verdict.econLatched,
      perDay, breakEvenDays, floorUnmeasured,
      hardCeilingTokens: verdict.hardCeilingTokens,
      alwaysLoadedPaths, alwaysLoadedBytes: m.alwaysLoaded.bytes,
    }, now);
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
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, caliper, ask, classB] = await Promise.all([
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
  const fullPercent = clampedRead(cfg, 'fullPercent');
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
    // MEASURED ad-hoc before shipping (not a flaky in-suite ms-assertion — the
    // WARP-HOLE BEHAVIOR itself is pinned in conductor.test.mjs): an
    // UNCONDITIONAL full re-gauge
    // (discoverClassB+measureEntries) costs ~7-18ms on real repos — BLOWS
    // the Phoenix #3 <=5ms happy-path budget if paid on EVERY Stop call
    // (Stop fires every turn). The cheap half: an ALWAYS-ON stat-only gate
    // (re-stat the paths already discovered at the last gauge — no
    // directory walk, no content read; measured ~0.15-0.3ms on the SAME
    // repos) decides whether the expensive full re-gauge (rare, and well
    // under the <=100ms including-a-scan cap) is worth paying for THIS turn.
    const cachedPaths = Array.isArray(lastVerdict.alwaysLoadedPaths) ? lastVerdict.alwaysLoadedPaths : null;
    const cachedBytes = Number(lastVerdict.alwaysLoadedBytes);
    if (cachedPaths && cachedPaths.length && Number.isFinite(cachedBytes)) {
      const freshBytes = caliper.statOnlyFootprintBytes(cachedPaths);
      const deltaTokens = caliper.tokensEstFromBytes(Math.abs(freshBytes - cachedBytes));
      if (deltaTokens > caliper.REGAUGE_DELTA_TOKENS) {
        const disc = classB.discoverClassB({ projectRoot, home, managedPaths });
        const m = caliper.measureEntries(disc.entries, { readBudgetBytes: READ_BUDGET_BYTES, withGzip: false });
        // 0j: the SAME provisional-floor door as SessionStart — covers a
        // store that only grew past FLOOR_MIN mid-session (was too tiny to
        // stamp at SessionStart, spiked before this Stop).
        const floorInfo = caliper.ensureProvisionalFloor(home, projectRoot, m.alwaysLoaded.tokensEst, now);
        const gv = caliper.gaugeVerdict({ measure: m, rawLeanFloorTokens: floorInfo.floorTokens, floorProvisional: floorInfo.provisional, fullPercent, wasOver: !!lastVerdict.overCeiling, wasEconLatched: !!lastVerdict.econLatched, stamps: proj.stamps });
        const alwaysLoadedPaths = disc.entries.filter((e) => e.alwaysLoaded).map((e) => e.path);
        caliper.recordVerdict(home, projectRoot, {
          band: gv.verdict.band, reason: gv.verdict.reason, economical: gv.economical, fatTokens: gv.fatTokens,
          overCeiling: gv.verdict.over, econLatched: gv.verdict.econLatched,
          perDay: gv.perDay, breakEvenDays: gv.breakEvenDays, floorUnmeasured: gv.floorUnmeasured,
          hardCeilingTokens: gv.verdict.hardCeilingTokens, alwaysLoadedPaths, alwaysLoadedBytes: m.alwaysLoaded.bytes,
        }, now);
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
    floorUnmeasured: !!lastVerdict.floorUnmeasured,
  };
  // 0o: the session's accumulated sub-spawn parcel bill — rides the FULL
  // directive numbers as ONE clause (absent at zero; the meter itself never
  // speaks, this is one of the pre-existing voices).
  const spawns = { subSpawns: proj.subSpawns, subParcelTokens: proj.subParcelTokensAccum };

  let reason;
  if (crossing.band === 'FULL' && lastVerdict.reason === 'externalize') {
    // Pure information — never an ask, never force: washing cannot help
    // ~all-muscle over capacity (the growable-full invariant's forbidden
    // "wash harder on muscle" move). Re-emitted once per NEW session while
    // still over (the session-id re-arm reaches externalize too, and it has
    // no lastEscalationFat to growth-gate) — a recurring "externalize your
    // store" reminder, the Windows low-disk-warning model; safe by
    // construction (reason==='externalize' is checked FIRST, so it can only
    // ever route here — never a force, never a wizard ask, muscle untouched).
    reason = ask.externalizeAdvisory({ hardCeilingTokens: lastVerdict.hardCeilingTokens });
  } else if (crossing.band === 'FULL' && crossing.escalation) {
    // case (c) — 0f "AUTHORITATIVE 3-FLOW": a force-run already tried Quick
    // this episode and the store is STILL over FULL — only the wizard's
    // semantic tier can help now; this IS a real ask, the ONE ask site in
    // the whole system (0d: OBESE is auto-Quick-silent, it never asks).
    // Checked BEFORE the force branch below so an armed escalation crossing
    // can never be re-swallowed into another silent force-Quick loop.
    reason = ask.wizardEscalation({ fatTokens, breakEven, spawns });
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
  return handleSessionStart(input);
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
