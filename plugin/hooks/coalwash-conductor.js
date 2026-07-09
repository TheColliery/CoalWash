#!/usr/bin/env node
'use strict';
// CoalWash conductor (Phoenix-13 hook: fail-silent, zero-dep, no network, no
// spawn, never process.exit — hooks-safety.md). Two events share this one
// file (hooks.json), branching on hook_event_name from stdin:
//   SessionStart     -> the full gauge (discovery + measurement + the 4-band
//                       verdict). The chokepoint (SKILL-REPO-PATTERN Layer 8):
//                       memory is LOADED every session anyway, so a
//                       session-start caliper rides ~free.
//   UserPromptSubmit -> the persistent per-turn FULL bar (beta.8 #2, below).
//
// 4-band model (2026-07-08 amendment, supersedes the blueprint's info-only
// full-signal): LEAN = silent · PLUMP = ask (question-box; decline = snooze) ·
// OBESE = strong-ask (shorter snooze) · FULL = economic force-run of the
// PROCESS — armed ONLY by the deterministic break-even proof computed in CODE,
// with the numbers SHOWN every fire (the series' one named consent exception,
// "economic-dominance"). DELETE/MERGE always stays behind the human gate.
//
// CHEAP caliper only on the SessionStart path: file sizes + stamps; content is
// read only for the small always-loaded set; gzip only when a nudge will
// actually be emitted AND the elapsed/size budget still holds (~100ms total
// wall budget). The UserPromptSubmit path is cheaper still — see below.
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
// LAST-HOP VISIBILITY (beta.7 #2 -> RIPPED at beta.8 #0, MEMORY.md): beta.7
// shipped a SessionStart-written temp marker + a `Notification`-event OS
// notification, reasoning that a SessionStart hook's stdout (context-injection
// only, never shown to the user) needed a user-visible carrier. LAB-MEASURED
// DEAD on this machine: a fresh dogfood session ran the FULL branch (marker
// written, confirmed) but the marker was never consumed — a 142-transcript
// sweep found ZERO `Notification` hookEvents ever fired here (the mechanism is
// real, it simply never fires on this desktop-app surface). Removed: the
// marker path, the Notification handler, and the `Notification` hooks.json
// registration.
//
// THE REPLACEMENT (beta.8 #2): the blueprint's own original answer — a
// persistent, un-dismissable per-turn bar — on the channel that demonstrably
// works instead. The sibling conductors (CoalBoard/CoalTipple) inject on
// UserPromptSubmit every turn and are observably obeyed: adjacency to the
// user's own message, not a separate carrier event, is what works. Plain
// stdout on exit 0 (the same mechanism SessionStart already uses, below) —
// verified against CB's and CT's shipped, dogfooded `hooks/*-conductor.js`
// (both plain-stdout on UserPromptSubmit; MEMORY.md: "demonstrably obeyed" in
// production). The CC hooks reference (code.claude.com/docs/en/hooks)
// documents a structured `hookSpecificOutput.additionalContext` JSON form for
// this event and was internally inconsistent (two fetches, one flat
// contradiction) on whether plain stdout also qualifies — matching the two
// siblings' proven-live shipped behavior here (one-flock, one-color; a
// working sibling implementation outranks an ambiguous doc summary).
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
// and UserPromptSubmit branches apart. Fail-safe: an absent/short/malformed/
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

    // beta.8 #2: feed the UserPromptSubmit hot path's cached read (Phoenix #3
    // — no discovery there); only a FULL+economical verdict arms the per-turn
    // bar — recordVerdict below is the write side, sanitizeVerdict (caliper.mjs)
    // is the read-side gate.
    let economical = false;
    const fatTokens = Math.max(0, Math.round(m.alwaysLoaded.tokensEst - leanFloorTokens));

    if (verdict.band === 'PLUMP' && !snoozed) {
      caliper.setSnooze(home, projectRoot, now + caliper.PLUMP_SNOOZE_DAYS * DAY_MS); // self-throttle: at most one ask per window
      out.push(`[CoalWash] memory gauge: PLUMP — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}${gz()}. OFFER the user a /coalwash clean via your question tool (options: run the free mechanical Quick pass now / not now). Declining is fine — this nudge snoozes ${caliper.PLUMP_SNOOZE_DAYS} days either way. Deletes always require explicit human approval.`);
    } else if (verdict.band === 'OBESE' && !snoozed) {
      caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
      out.push(`[CoalWash] memory gauge: OBESE — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}${gz()}. STRONGLY RECOMMEND a /coalwash clean — ask via your question tool (run Quick now / not now); a decline snoozes only ${caliper.OBESE_SNOOZE_DAYS} days. Deletes always require explicit human approval.`);
    } else if (verdict.band === 'FULL' && verdict.reason === 'externalize') {
      // Post-floor, all-muscle, over the hard machine ceiling: ~no fat to
      // reclaim, so washing again cannot help — advise externalizing/
      // splitting, never "wash harder" on legitimate muscle (the growable-full
      // invariant: only the machine-capacity gate is person-independent, and
      // its remedy is externalize, never wash). Context-injection is the
      // guaranteed-delivery channel (beta.8 #0); this reason never arms the
      // UserPromptSubmit per-turn bar (recordVerdict below) — the per-turn bar
      // is for the force-run case only, and washing cannot help all-muscle.
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
        economical = true; // arms the UserPromptSubmit per-turn bar via recordVerdict below
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) — deterministic break-even (all tokens ~est): ${numbers}. The run costs LESS than carrying the fat -> SURFACE this line to the user verbatim, then RUN the CoalWash pipeline now (economic-dominance rule; numbers shown above): start with the free mechanical Quick pass; escalate to the paid semantic Full pass only with a separate consent. DELETE/MERGE actions still require the human gate — nothing is deleted without explicit approval.`);
      } else if (!snoozed) {
        caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) but the break-even does NOT yet favor a run (${numbers}) — the force-run stays disarmed. STRONGLY RECOMMEND a manual /coalwash review; deletes always require explicit human approval.`);
      }
    }
    // LEAN (or snoozed) -> silent: Phoenix #13, no output on the healthy path.

    // Record this session's verdict for the UserPromptSubmit hot path (a
    // plain state write, same cost class as recordStamp above). Runs every
    // time regardless of band/snooze, so it OVERWRITES whatever a prior
    // session left — a store that goes LEAN after a clean stops arming the
    // per-turn bar on the very next SessionStart, not just eventually.
    caliper.recordVerdict(home, projectRoot, { band: verdict.band, reason: verdict.reason, economical, fatTokens }, now);
  }

  if (updateDue(cfg, clampedRead)) {
    out.push('[CoalWash] [self-update due] Offer the /coalwash:update check: web-check the latest CoalWash tag vs the installed plugin.json version; if newer, OFFER `claude plugin update coalwash@coalwash`; if current, say "up to date"; if git/network is unavailable, say so and suggest updating manually later (never assume). Consent-gated; the hook only scheduled it.');
  }

  if (out.length) {
    if (language !== 'auto') out.push(`[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, and paths verbatim)`);
    console.log(out.join('\n')); // sanctioned SessionStart context-injection channel (Phoenix #13)
  }
}

// UserPromptSubmit conductor branch (beta.8 #2 — see the file header). HOT-
// PATH BUDGET (Phoenix #3): no config load, no discovery, no measureEntries —
// reads ONLY the cached verdict handleSessionStart already recorded (one
// state-file read via loadState + projectState). The common case (LEAN, no
// verdict, or a stale one) exits right there; only a FULL+economical cached
// verdict does anything more (one console.log).
//
// PRIORITY (coordinator amendment): CoalBoard and CoalTipple already ride
// UserPromptSubmit every turn with a shipped arbitration cue between the two
// of them; CoalWash joins that frame as the LOWEST priority — maintenance
// yields to the user's actual task the way Windows Automatic Maintenance
// yields to active use. The directive text below asks for a BACKGROUND spawn
// (never inline-before-the-task) and explicitly defers to a sibling
// conductor's directive when one also fires this turn — the wash is free to
// wait a turn because the bar itself is persistent (it returns next turn at
// zero extra cost).
//
// ponytail: no coalwashMode re-check here (the same accepted edge the removed
// Notification branch used to note) — flipping mode to off/manual mid-session,
// before the next SessionStart re-stamps, can leave one stale nag firing for
// up to VERDICT_MAX_AGE_MS; the staleness guard bounds it and the next
// SessionStart always corrects it. Add a config re-read only if this narrow
// edge ever proves to matter in practice.
async function handleUserPromptSubmit() {
  const [{ findProjectRoot }, caliper] = await Promise.all([
    import(lib('config-load.mjs')),
    import(lib('caliper.mjs')),
  ]);
  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  const proj = caliper.projectState(caliper.loadState(home), projectRoot);
  const armed = caliper.sanitizeVerdict(proj.lastVerdict);
  if (!armed) return; // LEAN / no verdict / disarmed / stale -> silent, one read only

  // sanctioned UserPromptSubmit context-injection channel (Phoenix #13)
  console.log('[CoalWash] FULL band standing directive (break-even proven at session start, numbers there): SPAWN the free mechanical Quick pass as a BACKGROUND subagent (one tool call), then serve this turn\'s task normally — never delay the user\'s request for the wash. Escalate to Full only with the user\'s separate consent. This line repeats every turn until the store is cleaned or fullPercent is raised. If a CoalBoard or CoalTipple conductor directive also fired this turn, THEY take precedence — arbitrate silently, never surface the overlap; the wash yields this turn (this bar returns next turn at zero cost).');
}

async function main() {
  const input = await readStdinJson();
  const event = (input && (input.hook_event_name || input.hookEventName)) || '';
  if (event === 'UserPromptSubmit') return handleUserPromptSubmit();
  return handleSessionStart();
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
