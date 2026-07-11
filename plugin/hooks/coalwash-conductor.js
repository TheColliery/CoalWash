#!/usr/bin/env node
'use strict';
// CoalWash conductor (Phoenix-13 hook: fail-silent, zero-dep, no network, no
// spawn, never process.exit — hooks-safety.md). Two events share this one
// file (hooks.json), branching on hook_event_name from stdin:
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
//                   edge-crossing surfaces as a blocking ask (OBESE, or a
//                   FULL crossing whose auto-run is suppressed), the
//                   standing-consent FULL force directive (forceMode=auto),
//                   or the FULL(externalize) pure-information advisory —
//                   never an ask, since washing cannot help ~all-muscle over
//                   capacity. Mirrors rot-canary-stop.js's exact output
//                   mechanism — a structured `{decision:'block', reason}`
//                   JSON write, not plain console.log — because THAT is what
//                   makes Stop a blocking channel the agent must address,
//                   unlike a passive context injection it was always free to
//                   ignore (beta.10 "ROUND 4 POSTMORTEM").
//
// BAND COLLAPSE (beta.12, MEMORY.md "THE BAND COLLAPSE"): LEAN/PLUMP/OBESE
// die as SEPARATE behavior drivers — ONE hysteresis-gated ceiling (OBESE)
// plus the SEPARATE, person-independent machine-capacity line (FULL) are the
// only two non-silent states. FULL's economic force fires ONLY on the
// deterministic break-even proof computed in CODE, numbers SHOWN every fire
// (the series' one named consent exception, "economic-dominance"). DELETE/
// MERGE authorization is plan-sourced (the adjudicated plan IS the
// authorization) — safety is UNDO: every cut is snapshot-backed and
// revertible (whole-run rollback), never a human pre-approval.
//
// TEMPLATE ASKS (beta.12 item 3, ../scripts/lib/ask.mjs): every ask/directive/
// advisory string is built by CODE from numbers alone — the hook never
// composes prose (the RESIDENT-ASK CONTAMINATION incident: an agent-composed
// ask once quoted the store's own design backlog as its rationale, a closed
// loop). Every template embeds the ANSWER-FIRST reminder clause.
//
// CHEAP caliper only on the SessionStart path: file sizes + stamps; content is
// read only for the small always-loaded set; gzip only when informational
// work is already in budget (~100ms total wall budget). The Stop path is
// cheaper still (Phoenix #3) — one state read, no discovery, no
// measureEntries, no gzip — see handleStop below.
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
const fs = require('node:fs');
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
function updateDue(cfg, clampedRead) {
  try {
    if (clampedRead(cfg, 'updateMode') === 'off') return false;
    const days = clampedRead(cfg, 'updateCheckDays');
    const stamp = path.join(os.homedir(), '.claude', '.coalwash-update-check');
    let last = 0;
    try { last = Number(String(fs.readFileSync(stamp, 'utf8')).trim()) || 0; } catch {}
    const now = Date.now();
    if (last && now - last < days * DAY_MS) return false;
    try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, String(now)); } catch {}
    return true;
  } catch { return false; }
}

async function handleSessionStart() {
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
    // Never trust the raw stored value: sanitizeLeanFloor discards a
    // non-finite/non-positive or grossly-implausible floor (conservative —
    // treats it as floor-unmeasured rather than risk a false-LEAN silence).
    const leanFloorTokens = caliper.sanitizeLeanFloor(proj.leanFloorTokens, m.alwaysLoaded.tokensEst);
    const verdict = caliper.bandVerdict({
      footprintTokens: m.alwaysLoaded.tokensEst,
      leanFloorTokens,
      fullPercent,
      indexBytes: m.index.bytes,
      indexLines: m.index.lines,
      wasOver,
    });

    const now = Date.now();
    const fatTokens = Math.max(0, Math.round(m.alwaysLoaded.tokensEst - leanFloorTokens));
    // Break-even is only meaningful where a wash could actually help (never
    // for externalize — a wash cannot shrink muscle, the growable-full
    // invariant's forbidden move) and never for LEAN (nothing to pay back).
    let economical = false;
    let perDay = 0, breakEvenDays = null, floorUnmeasured = false;
    if (verdict.band !== 'LEAN' && verdict.reason !== 'externalize') {
      const econ = caliper.breakEven({
        footprintTokens: m.alwaysLoaded.tokensEst,
        leanFloorTokens,
        totalStoreTokens: m.totalTokensEst,
        sessionsPerDay: caliper.sessionsPerDay(proj.stamps),
      });
      perDay = econ.perDay;
      breakEvenDays = econ.breakEvenDays;
      floorUnmeasured = econ.floorUnmeasured;
      if (verdict.band === 'FULL') economical = econ.economical; // arms the Stop hook's force case via recordVerdict below
    }

    // Cache everything the Stop hook needs to act WITHOUT re-measuring
    // (Phoenix #3): the verdict itself, the ceiling's hysteresis bit
    // (`overCeiling`, read back next time as `wasOver`), and the payback
    // numbers (now available to ANY ask, not just FULL's — queue 0c).
    caliper.recordVerdict(home, projectRoot, {
      band: verdict.band, reason: verdict.reason, economical, fatTokens,
      overCeiling: verdict.over, perDay, breakEvenDays, floorUnmeasured,
      hardCeilingTokens: verdict.hardCeilingTokens,
    }, now);
    // Uniform once-per-crossing arming on the band itself — no more
    // reason-based carve for externalize (beta.10's old F1 rule): Stop now
    // dispatches on the CACHED reason within the FULL band (see handleStop),
    // so a rise into FULL/externalize is delivered exactly once, the same
    // guarantee every other crossing already gets, instead of being silently
    // un-trackable.
    caliper.recordCrossing(home, projectRoot, verdict.band, prevBand, now);
  }

  if (updateDue(cfg, clampedRead)) {
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
// (loadState + projectState) — the common case (no pending crossing) exits
// right there; only an unconsumed crossing does anything more, and even then
// every template is a pure string builder (ask.mjs) over already-cached
// numbers — no re-measurement, ever.
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
// (the saving-guarantee floor); forceMode 'ask'/'off' suppress only the
// AUTO-RUN authorization, never the user's awareness of FULL.
async function handleStop(input) {
  if (input && input.stop_hook_active) return; // avoid the block-decision retrigger loop
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, caliper, ask] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('caliper.mjs')),
    import(lib('ask.mjs')),
  ]);
  const cfg = loadMergedConfig();
  if (clampedRead(cfg, 'coalwashMode') === 'off') return; // fully silent
  const forceMode = clampedRead(cfg, 'forceMode');
  const exercisePerBand = clampedRead(cfg, 'exercisePerBand');

  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  const proj = caliper.projectState(caliper.loadState(home), projectRoot);
  const crossing = caliper.sanitizeCrossing(proj.lastCrossing);
  if (!crossing) return; // nothing pending -> silent, one read only (Phoenix #13)

  const now = Date.now();
  const lastVerdict = (proj.lastVerdict && typeof proj.lastVerdict === 'object') ? proj.lastVerdict : {};
  const fatTokens = Number.isFinite(lastVerdict.fatTokens) ? Math.round(lastVerdict.fatTokens) : 0;
  const breakEven = {
    perDay: Number.isFinite(lastVerdict.perDay) ? lastVerdict.perDay : 0,
    breakEvenDays: Number.isFinite(lastVerdict.breakEvenDays) ? lastVerdict.breakEvenDays : null,
    floorUnmeasured: !!lastVerdict.floorUnmeasured,
  };

  let reason;
  if (crossing.band === 'FULL' && lastVerdict.reason === 'externalize') {
    // Pure information — never an ask, never force: washing cannot help
    // ~all-muscle over capacity (the growable-full invariant's forbidden
    // "wash harder on muscle" move). Delivered exactly once per rise, same
    // as every other crossing.
    reason = ask.externalizeAdvisory({ hardCeilingTokens: lastVerdict.hardCeilingTokens });
  } else {
    // sanitizeVerdict is non-null ONLY for a fresh FULL+economical
    // (never-externalize) verdict — the exact gate the force case needs.
    const verdict = caliper.sanitizeVerdict(lastVerdict, now);
    const isForceCrossing = crossing.band === 'FULL' && !!verdict;
    if (isForceCrossing && forceMode === 'auto') {
      // case (b): force — standing consent, no ask, mirrors rot-canary's own auto-scan.
      reason = ask.forceAuto({ fatTokens: verdict.fatTokens, breakEven });
    } else {
      // case (a): ask ทำ/later — OBESE, a FULL crossing that never armed
      // (economical:false), or a FULL crossing whose AUTO-RUN authorization
      // is suppressed (forceMode 'ask'/'off' — both land HERE, never in silence).
      const bandKey = crossing.band.toLowerCase();
      const exercise = (exercisePerBand && exercisePerBand[bandKey]) || 'quick';
      reason = ask.ceilingAsk({ band: crossing.band, fatTokens, exercise, breakEven });
    }
  }

  caliper.consumeCrossing(home, projectRoot, now); // once per crossing (consume-at-emission)
  process.stdout.write(JSON.stringify({ decision: 'block', reason })); // sanctioned Stop blocking-feedback channel (Phoenix #13; mirrors rot-canary-stop.js)
}

async function main() {
  const input = await readStdinJson();
  const event = (input && (input.hook_event_name || input.hookEventName)) || '';
  if (event === 'Stop') return handleStop(input);
  return handleSessionStart();
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
