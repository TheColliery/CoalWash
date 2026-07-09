#!/usr/bin/env node
'use strict';
// CoalWash conductor (Phoenix-13 hook: fail-silent, zero-dep, no network, no
// spawn, never process.exit — hooks-safety.md). Two events share this one
// file (hooks.json), branching on hook_event_name from stdin:
//   SessionStart -> the full gauge (discovery + measurement + the 4-band
//                   verdict). The chokepoint (SKILL-REPO-PATTERN Layer 8):
//                   memory is LOADED every session anyway, so a
//                   session-start caliper rides ~free. beta.10 adds
//                   edge-crossing detection alongside the existing verdict
//                   cache (see "LAST-HOP VISIBILITY" below) — the Stop
//                   branch's data source.
//   Stop         -> (beta.10, REPLACES the retired UserPromptSubmit per-turn
//                   bar) the ENFORCEMENT channel: an unconsumed edge-crossing
//                   surfaces as a blocking ทำ/later ask; a fresh
//                   FULL+economical verdict (forceMode=auto) surfaces as a
//                   standing-consent force-run directive. Mirrors
//                   rot-canary-stop.js's exact output mechanism — a
//                   structured `{decision:'block', reason}` JSON write, not
//                   plain console.log — because THAT is what makes Stop a
//                   blocking channel the agent must address, unlike a passive
//                   context injection it was always free to ignore.
//
// 4-band model (2026-07-08 amendment, supersedes the blueprint's info-only
// full-signal): LEAN = silent · PLUMP = ask (question-box; decline = snooze) ·
// OBESE = strong-ask (shorter snooze) · FULL = economic force-run of the
// PROCESS — armed ONLY by the deterministic break-even proof computed in CODE,
// with the numbers SHOWN every fire (the series' one named consent exception,
// "economic-dominance"). DELETE/MERGE authorization is plan-sourced (the
// adjudicated plan IS the authorization) — safety is UNDO: every cut is
// snapshot-backed and revertible (whole-run rollback), never a human pre-approval.
//
// CHEAP caliper only on the SessionStart path: file sizes + stamps; content is
// read only for the small always-loaded set; gzip only when a nudge will
// actually be emitted AND the elapsed/size budget still holds (~100ms total
// wall budget). The Stop path is cheaper still (Phoenix #3) — one state read,
// no discovery, no measureEntries — see handleStop below.
//
// NAMED divergence from hooks-safety.md §10 (whose read exception names project
// CONFIG only): this hook also READS project class-B memory/governance CONTENT
// — measuring that content IS the product; reads stay read-only + size-budgeted,
// writes still touch only the two sandbox roots.
//
// The engine lives in ../scripts/lib/*.mjs (ESM) — dynamically imported so this
// CJS hook and the agent-invoked scripts share ONE implementation (a hook that
// reimplements config-load silently diverged once in a sibling; never again).
//
// LAST-HOP VISIBILITY, the short history (full detail: MEMORY.md):
//   beta.7  a SessionStart marker + `Notification`-event OS announce —
//           LAB-MEASURED DEAD (142-transcript sweep, zero Notification events
//           ever fired on this desktop-app surface). Ripped at beta.8.
//   beta.8  replaced it with a persistent per-turn UserPromptSubmit bar
//           (adjacency to the user's own message, matching CB/CT's proven
//           shipped pattern).
//   beta.9  fixed the bar's blanket sibling-yield clause (a structural mute:
//           CT fires every turn, CB fires on every Thai prompt) so the bar
//           actually yields to user ACTIVITY, not a sibling's mere presence.
//   beta.10 "ROUND 4 POSTMORTEM": delivery was STILL 100%
//           (proven in-transcript, twice) yet a sonnet main ignored the bar
//           on a no-tool prompt. Root cause: UserPromptSubmit context is a
//           REQUEST channel — advisory, the agent is free to ignore it,
//           especially a weaker tier on a no-tool turn. rot-canary's Stop
//           hook lands every time on this same machine because Stop has
//           BLOCKING semantics (the harness holds the stop until the reason
//           is addressed) + question-box form (a human presses a button, no
//           model-discipline dependence). CONSEQUENCE: the per-turn
//           UserPromptSubmit bar is RETIRED OUTRIGHT (not throttled further —
//           removed); Stop becomes the one and only enforcement surface.
//           Force rides standing config (the rot-canary autoFixMode model:
//           numbers still shown, every cut snapshot-backed); PLUMP/OBESE/
//           FULL-disarmed crossings ride the SAME Stop channel via the
//           question-box, ONCE per edge-crossing rather than every turn (see
//           the "edge-crossing state" section of caliper.mjs).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const READ_BUDGET_BYTES = 262144; // max always-loaded content read on the hook path
const GZIP_BUDGET_BYTES = 131072; // gzip the always-loaded set only under this size
const GZIP_BUDGET_MS = 60; // ...and only when the run is still inside this wall-clock
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
  const t0 = Date.now();
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
  const disc = mode === 'auto' ? classB.discoverClassB({ projectRoot, home }) : { entries: [] };
  if (disc.entries.length) {
    const m = caliper.measureEntries(disc.entries, { readBudgetBytes: READ_BUDGET_BYTES, withGzip: false });
    const proj = caliper.recordStamp(home, projectRoot, m.alwaysLoaded.tokensEst) || {};
    // beta.10: read BEFORE recordVerdict below overwrites it — the band this
    // project was in as of the LAST recorded verdict, for edge-crossing
    // detection (recordCrossing). No prior verdict (a brand-new project) ->
    // 'LEAN', so a first-ever scan already above LEAN counts as a rise too
    // (the "qualifying past" case, MEMORY.md).
    const prevBand = (proj.lastVerdict && proj.lastVerdict.band) || 'LEAN';
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
    });

    const now = Date.now();
    const snoozed = Number(proj.snoozeUntil) > now;
    const bmiTxt = verdict.bmi ? `${verdict.bmi.toFixed(2)}x the lean floor` : 'lean floor not measured yet';
    // gzip redundancy: informational, only when a nudge will print + within budget
    const gz = () => {
      try {
        if (m.alwaysLoaded.bytes > GZIP_BUDGET_BYTES || Date.now() - t0 > GZIP_BUDGET_MS) return '';
        const text = disc.entries.filter((e) => e.alwaysLoaded).map((e) => { try { return fs.readFileSync(e.path, 'utf8'); } catch { return ''; } }).join('\n');
        return ` · gzip-redundancy ${caliper.gzipRatio(text).toFixed(2)}`;
      } catch { return ''; }
    };

    // beta.10: feed the Stop hook's cached read (Phoenix #3 — no discovery
    // there); only a FULL+economical verdict arms the force case — recordVerdict
    // below is the write side, sanitizeVerdict (caliper.mjs) is the read-side gate.
    let economical = false;
    const fatTokens = Math.max(0, Math.round(m.alwaysLoaded.tokensEst - leanFloorTokens));

    if (verdict.band === 'PLUMP' && !snoozed) {
      caliper.setSnooze(home, projectRoot, now + caliper.PLUMP_SNOOZE_DAYS * DAY_MS); // self-throttle: at most one ask per window
      out.push(`[CoalWash] memory gauge: PLUMP — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}${gz()}. OFFER the user a /coalwash clean via your question tool (options: run the free mechanical Quick pass now / not now). Declining is fine — this nudge snoozes ${caliper.PLUMP_SNOOZE_DAYS} days either way. Every cut is snapshot-backed and revertible (whole-run rollback).`);
    } else if (verdict.band === 'OBESE' && !snoozed) {
      caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
      out.push(`[CoalWash] memory gauge: OBESE — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}${gz()}. STRONGLY RECOMMEND a /coalwash clean — ask via your question tool (run Quick now / not now); a decline snoozes only ${caliper.OBESE_SNOOZE_DAYS} days. Every cut is snapshot-backed and revertible (whole-run rollback).`);
    } else if (verdict.band === 'FULL' && verdict.reason === 'externalize') {
      // Post-floor, all-muscle, over the hard machine ceiling: ~no fat to
      // reclaim, so washing again cannot help — advise externalizing/
      // splitting, never "wash harder" on legitimate muscle (the growable-full
      // invariant: only the machine-capacity gate is person-independent, and
      // its remedy is externalize, never wash). Context-injection is the
      // guaranteed-delivery channel (beta.8 #0); this reason never arms the
      // Stop hook's force case (recordVerdict below) — force is for the
      // economical FULL case only, and washing cannot help all-muscle.
      if (!snoozed) {
        caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
        out.push(`[CoalWash] memory gauge: FULL (externalize) — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}, ~no reclaimable fat (this is muscle, not bloat). SURFACE this line to the user verbatim. CoalWash cannot help further by washing — the store has outgrown this machine's working capacity (hard ceiling ~${verdict.hardCeilingTokens} tok, a rough placeholder). EXTERNALIZE or split older content out of the always-loaded set, or consciously raise fullPercent (the "bigger SSD" choice).`);
      }
    } else if (verdict.band === 'FULL') {
      const econ = caliper.breakEven({
        footprintTokens: m.alwaysLoaded.tokensEst,
        leanFloorTokens,
        totalStoreTokens: m.totalTokensEst,
        sessionsPerDay: caliper.sessionsPerDay(proj.stamps),
      });
      const fatLabel = econ.floorUnmeasured ? ' (floor unmeasured — an upper bound, the whole footprint counts as fat until a first clean stamps the lean floor)' : '';
      const numbers = `fat ~${econ.fatTokens} tok${fatLabel} loads every session ≈ ${econ.perDay} tok/day at the stamped session rate · one run ≈ ${econ.runCostTokens} tok · carrying it ${econ.horizonDays} days ≈ ${econ.horizonCarryTokens} tok · break-even ~${Number.isFinite(econ.breakEvenDays) ? econ.breakEvenDays.toFixed(1) : '∞'} days`;
      if (econ.economical) {
        economical = true; // arms the Stop hook's force case via recordVerdict below
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) — deterministic break-even (all tokens ~est): ${numbers}. The run costs LESS than carrying the fat -> SURFACE this line to the user verbatim, then RUN the CoalWash pipeline now (economic-dominance rule; numbers shown above): start with the free mechanical Quick pass; escalate to the paid semantic Full pass only with a separate consent. DELETE/MERGE actions ride the adjudicated plan — every cut is snapshot-backed and revertible, nothing silent.`);
      } else if (!snoozed) {
        caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) but the break-even does NOT yet favor a run (${numbers}) — the force-run stays disarmed. STRONGLY RECOMMEND a manual /coalwash review; every cut is snapshot-backed and revertible.`);
      }
    }
    // LEAN (or snoozed) -> silent: Phoenix #13, no output on the healthy path.

    // Record this session's verdict for the Stop hook's cached read (a plain
    // state write, same cost class as recordStamp above). Runs every time
    // regardless of band/snooze, so it OVERWRITES whatever a prior session
    // left — a store that goes LEAN after a clean stops arming the force case
    // on the very next SessionStart, not just eventually.
    caliper.recordVerdict(home, projectRoot, { band: verdict.band, reason: verdict.reason, economical, fatTokens }, now);
    // beta.10: edge-crossing detection, alongside the verdict cache above —
    // the Stop hook's OTHER data source (the once-per-crossing ask/force gate;
    // see caliper.mjs "edge-crossing state"). F1: an externalize-FULL verdict
    // counts as LEAN here — arming a crossing would put a "run the full wash
    // now" Stop ask on legitimate all-muscle, the exact steer the growable-
    // full invariant forbids (never wash-harder on muscle; the SessionStart
    // externalize advisory above is the only correct surface). Mapping to
    // LEAN also CLEARS any pending crossing: the store's truth changed to
    // not-washable, so a stale PLUMP/OBESE ask would lie. Parallel to
    // sanitizeVerdict, which already excludes externalize from the force case.
    const crossingBand = verdict.reason === 'externalize' ? 'LEAN' : verdict.band;
    caliper.recordCrossing(home, projectRoot, crossingBand, prevBand, now);
  }

  if (updateDue(cfg, clampedRead)) {
    out.push('[CoalWash] [self-update due] Offer the /coalwash:update check: web-check the latest CoalWash tag vs the installed plugin.json version; if newer, OFFER `claude plugin update coalwash@coalwash`; if current, say "up to date"; if git/network is unavailable, say so and suggest updating manually later (never assume). Consent-gated; the hook only scheduled it.');
  }

  if (out.length) {
    if (language !== 'auto') out.push(`[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, and paths verbatim)`);
    console.log(out.join('\n')); // sanctioned SessionStart context-injection channel (Phoenix #13)
  }
}

// Stop conductor branch (beta.10 — REPLACES handleUserPromptSubmit; see the
// file header "ROUND 4 POSTMORTEM"). HOT-PATH BUDGET (Phoenix #3): a config
// read (2 small JSON files, no discovery/measureEntries) + ONE state read
// (loadState + projectState) — the same cost class handleSessionStart already
// pays for its own config+state reads. The common case (no pending crossing)
// exits right there; only an unconsumed crossing does anything more.
//
// OUTPUT MECHANISM (deliberately NOT plain console.log, unlike SessionStart):
// mirrors rot-canary-stop.js exactly — a structured
// `{decision:'block', reason}` JSON write to stdout. That structure is what
// makes Claude Code hold the stop and hand `reason` back to the agent as
// something it must address, instead of a passive context line it can ignore
// (the ROUND 4 finding this version exists to fix). `stop_hook_active` is
// checked first, same as rot-canary, so CC re-invoking Stop after the agent
// responds to a block decision can never loop.
//
// CONSUME-AT-EMISSION (ponytail, full rationale in caliper.mjs on
// consumeCrossing): the crossing is marked consumed the instant this function
// surfaces it — never on a later "the user picked X" signal, since no CLI
// exists for the agent to report that back. Every pending crossing SURFACES
// (ask or force) — there is no silent branch: a silent FULL would be the
// forbidden third "dismiss and keep growing" path (the saving-guarantee
// floor); forceMode 'ask'/'off' suppress only the AUTO-RUN authorization,
// never the user's awareness of FULL.
// This is also why handleStop never touches setSnooze: that mechanism is
// SessionStart's own, unrelated self-throttle for its periodic gauge messages
// — reusing it here would let a SessionStart snooze silently consume a
// crossing before Stop ever gets a chance to surface it.
async function handleStop(input) {
  if (input && input.stop_hook_active) return; // avoid the block-decision retrigger loop
  const [{ loadMergedConfig, findProjectRoot }, { clampedRead }, caliper] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('config-schema.mjs')),
    import(lib('caliper.mjs')),
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
  // sanitizeVerdict is non-null ONLY for a fresh FULL+economical verdict — the
  // exact gate the force case (b) needs; the ask case (a) below reads the raw
  // cached fatTokens directly since it must display a number for PLUMP/OBESE
  // too, which sanitizeVerdict deliberately never arms for.
  const verdict = caliper.sanitizeVerdict(proj.lastVerdict, now);
  const isForceCrossing = crossing.band === 'FULL' && !!verdict;

  let reason;
  if (isForceCrossing && forceMode === 'auto') {
    // case (b): force — standing consent, no ask, mirrors rot-canary's own auto-scan.
    reason = `[CoalWash] FULL band + break-even proven (numbers: fat ~${verdict.fatTokens} tok): standing config authorizes the free mechanical Quick pass NOW — run it (stage-only; every cut is snapshot-backed — one command rolls the whole run back), then note the receipt path to the user in one line. This fires once per crossing, not per session.`;
  } else {
    // case (a): ask ทำ/later — PLUMP, OBESE, a FULL crossing that never armed
    // (economical:false), or a FULL crossing whose AUTO-RUN authorization is
    // suppressed (forceMode 'ask'/'off' — both land HERE, never in silence).
    const fatTokens = Number.isFinite(proj.lastVerdict && proj.lastVerdict.fatTokens) ? Math.round(proj.lastVerdict.fatTokens) : 0;
    const bandKey = crossing.band.toLowerCase();
    const exercise = (exercisePerBand && exercisePerBand[bandKey]) || 'quick';
    reason = `[CoalWash] memory crossed the ${crossing.band} ceiling (fat ~${fatTokens} tok). Offer the user via your question tool, exactly two options: ทำ (run the ${exercise} wash now — the configured exercise for this ceiling) / later (dismiss; the offer returns at the next ceiling crossing). If the user picks ทำ: run the pipeline per the coalwash skill (every cut is snapshot-backed and revertible). This crossing is marked consumed the moment this ask fires — it will not repeat until the next rise.`;
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
