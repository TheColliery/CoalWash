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
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const READ_BUDGET_BYTES = 262144; // max always-loaded content read on the hook path
const GZIP_BUDGET_BYTES = 131072; // gzip the always-loaded set only under this size
const GZIP_BUDGET_MS = 60; // ...and only when the run is still inside this wall-clock
const DAY_MS = 86400000;

function lib(name) {
  return pathToFileURL(path.join(__dirname, '..', 'scripts', 'lib', name)).href;
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

async function main() {
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
        out.push(`[CoalWash] memory gauge: FULL (${verdict.reason}) — deterministic break-even (all tokens ~est): ${numbers}. The run costs LESS than carrying the fat -> RUN the CoalWash pipeline now (economic-dominance rule; numbers shown above): start with the free mechanical Quick pass; escalate to the paid semantic Full pass only with a separate consent. DELETE/MERGE actions still require the human gate — nothing is deleted without explicit approval.`);
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

main().catch(() => {
  // Phoenix #4: fail-silent, never throw, never crash the parent agent.
});
// No process.exit() — Phoenix #4 (would truncate the sanctioned stdout write above).
