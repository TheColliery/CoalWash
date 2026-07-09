#!/usr/bin/env node
'use strict';
// CoalWash SessionStart conductor (Phoenix-13 hook: fail-silent, zero-dep, no
// network, no spawn, never process.exit — hooks-safety.md). The chokepoint
// gauge (SKILL-REPO-PATTERN Layer 8): memory is LOADED every session anyway,
// so a session-start caliper sees the accumulated past, measures the present,
// and inescapably catches everything written later — the gauge rides ~free.
//
// 4-band model (2026-07-08 amendment, supersedes the blueprint's info-only
// full-signal): LEAN = silent · PLUMP = ask (question-box; decline = snooze) ·
// OBESE = strong-ask (shorter snooze) · FULL = economic force-run of the
// PROCESS — armed ONLY by the deterministic break-even proof computed in CODE,
// with the numbers SHOWN every fire (the series' one named consent exception,
// "economic-dominance"). DELETE/MERGE always stays behind the human gate.
//
// CHEAP caliper only on this path: file sizes + stamps; content is read only
// for the small always-loaded set; gzip only when a nudge will actually be
// emitted AND the elapsed/size budget still holds (~100ms total wall budget).
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
// LAST-HOP VISIBILITY (beta.7 #2, MEMORY.md evidence chain): a SessionStart
// hook's stdout is context-injection ONLY — it is never shown to the user, only
// to the agent (source-grounded against code.claude.com/docs/en/hooks,
// 2026-07-09). A live dogfood proved a busy/mid-tier agent can silently drop
// that injected line and never surface it. This file is ALSO registered for
// the `Notification` hook event (a documented, USER-visible channel via a
// `terminalSequence` OS notification/bell — no matcher restriction, so it
// fires on every Notification CC sends) — best-effort, ADDITIVE to the context
// injection, never a replacement for it: a FULL-band announce with a session_id
// available hands off a short summary to a session-scoped temp marker; the
// Notification-event branch below reads + consumes it at most once. No
// session_id (older platform, or no stdin provided) just skips the hand-off —
// the context injection remains the primary, always-attempted channel.
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
// ...} per the CC hook contract). Fail-safe: an absent/short/malformed/
// never-closing stdin resolves to {} within STDIN_BUDGET_MS rather than ever
// blocking the hook (Phoenix #3/#4) — everything downstream that depends on it
// (session_id for the Notification hand-off) just degrades to "unavailable",
// never affecting the sanctioned context-injection path.
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

function sessionSlug(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
}
// Session-scoped hand-off marker (Phoenix #6: state lives in temp files keyed
// by session_id) — SessionStart writes a short summary here only for the two
// "must reach the user" FULL variants (economical run-now, externalize); the
// Notification branch reads + deletes it at most once per session.
function fullMarkerPath(sessionId) {
  return path.join(os.tmpdir(), `coalwash-full-${sessionSlug(sessionId)}.txt`);
}

// ponytail: no TTL/orphan-sweep on stale markers — each is tiny, sits in the
// OS temp dir, and is scoped to a session_id that (per CC's contract) is never
// reused, so a marker that's never consumed just self-cleans with the OS's own
// temp-dir housekeeping. Add a sweep only if leftover temp litter ever proves
// to be a real problem.

async function handleNotification(input) {
  const sessionId = input && input.session_id;
  if (!sessionId) return; // nothing to correlate — silent (Phoenix #13)
  const p = fullMarkerPath(sessionId);
  let body;
  try { body = fs.readFileSync(p, 'utf8'); } catch { return; } // no pending announce
  try { fs.rmSync(p, { force: true }); } catch { /* best-effort cleanup */ }
  if (!body) return;
  // OSC 777 "notify" (iTerm2-style; unsupported terminals just ignore the
  // escape sequence — harmless). Sanitize against anything that could break
  // the sequence's own delimiters; the body is metrics-only, never memory
  // content (same "receipt = metrics only" rule as receipt.mjs).
  const safeBody = String(body).replace(/[;\r\n\x1b\x07]/g, ' ').slice(0, 200);
  const seq = `\x1b]777;notify;CoalWash;${safeBody}\x07`;
  console.log(JSON.stringify({ terminalSequence: seq }));
}

// Push a FULL-band line to the context injection (the primary, always-run
// channel) and, best-effort, hand a short summary to the Notification channel
// via the session-scoped marker above (skipped without a session_id).
function announceFull(input, notifyBody, contextLine, out) {
  out.push(contextLine);
  const sessionId = input && input.session_id;
  if (!sessionId) return;
  try { fs.writeFileSync(fullMarkerPath(sessionId), String(notifyBody).slice(0, 200), 'utf8'); } catch { /* best-effort only */ }
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

async function handleSessionStart(input) {
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
      // its remedy is externalize, never wash). Gets the same last-hop
      // treatment as the economical case below (both are "must reach the
      // user" FULL variants — MEMORY.md beta.7 #2).
      if (!snoozed) {
        caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
        announceFull(input,
          `FULL (externalize) — ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session, no reclaimable fat`,
          `[CoalWash] memory gauge: FULL (externalize) — class-B always-loaded ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session (~est), ${bmiTxt}, ~no reclaimable fat (this is muscle, not bloat). SURFACE this line to the user verbatim. CoalWash cannot help further by washing — the store has outgrown this machine's working capacity (hard ceiling ~${verdict.hardCeilingTokens} tok, a rough placeholder). EXTERNALIZE or split older content out of the always-loaded set, or consciously raise fullPercent (the "bigger SSD" choice).`,
          out);
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
        announceFull(input,
          `FULL (${verdict.reason}) — ~${Math.round(m.alwaysLoaded.tokensEst)} tok/session, clean recommended`,
          `[CoalWash] memory gauge: FULL (${verdict.reason}) — deterministic break-even (all tokens ~est): ${numbers}. The run costs LESS than carrying the fat -> SURFACE this line to the user verbatim, then RUN the CoalWash pipeline now (economic-dominance rule; numbers shown above): start with the free mechanical Quick pass; escalate to the paid semantic Full pass only with a separate consent. DELETE/MERGE actions still require the human gate — nothing is deleted without explicit approval.`,
          out);
      } else if (!snoozed) {
        caliper.setSnooze(home, projectRoot, now + caliper.OBESE_SNOOZE_DAYS * DAY_MS);
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) but the break-even does NOT yet favor a run (${numbers}) — the force-run stays disarmed. STRONGLY RECOMMEND a manual /coalwash review; deletes always require explicit human approval.`);
      }
    }
    // LEAN (or snoozed) -> silent: Phoenix #13, no output on the healthy path.
  }

  if (updateDue(cfg, clampedRead)) {
    out.push('[CoalWash] [self-update due] Offer the /coalwash:update check: web-check the latest CoalWash tag vs the installed plugin.json version; if newer, OFFER `claude plugin update coalwash@coalwash`; if current, say "up to date"; if git/network is unavailable, say so and suggest updating manually later (never assume). Consent-gated; the hook only scheduled it.');
  }

  if (out.length) {
    if (language !== 'auto') out.push(`[CoalWash] (language=${language} — deliver user-facing prose in that language; keep technical terms, commands, and paths verbatim)`);
    console.log(out.join('\n')); // sanctioned SessionStart context-injection channel (Phoenix #13)
  }
}

async function main() {
  // ponytail: coalwashMode is NOT re-checked on the Notification path — a
  // marker only ever gets WRITTEN while mode==='auto' (handleSessionStart
  // gates the whole gauge on it), so the narrow edge case of the user
  // flipping mode mid-session before the next Notification event just means
  // one harmless already-decided OS notification still fires; add a re-check
  // only if that edge case ever proves to matter in practice.
  const input = await readStdinJson();
  if (input && input.hook_event_name === 'Notification') return handleNotification(input);
  return handleSessionStart(input);
}

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
