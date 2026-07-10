#!/usr/bin/env node
// cli.mjs — the ONE front door to the engine's measurement pipeline.
//
// Born of the DEMO HARVEST (MEMORY.md, 2026-07-10): a room agent AND the
// coordinator's own stats probe independently fumbled the lib API 4x each
// composing the same five calls by hand — two independent fumbles = the API
// wants a single entrypoint. `/coalwash:stats` and the method.md preflight
// ride this instead of hand-assembled inline snippets.
//
//   node scripts/lib/cli.mjs gauge [--json]
//
// One call = recoverDangling (heals a dangling prior txn — its no-op path
// touches nothing) + discoverClassB + measureEntries + bandVerdict +
// breakEven. Output: the terse one-line gauge (default) or the full JSON
// (--json). READ-ONLY toward CoalWash state by design: no stamp, no verdict
// cache, no snooze, no crossing is written — those are the SessionStart
// conductor's session bookkeeping, and a CLI gauge is a measurement, not a
// session event (double-stamping would distort the sessions/day economics).
//
// CLI discipline (scripts-quality.md): fail LOUD — a bad subcommand or a
// pipeline error prints to stderr and exits non-zero.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoverDangling } from './apply.mjs';
import { discoverClassB } from './class-b.mjs';
import {
  measureEntries, bandVerdict, breakEven, sessionsPerDay,
  loadState, projectState, sanitizeLeanFloor,
} from './caliper.mjs';
import { loadMergedConfig, findProjectRoot } from './config-load.mjs';
import { clampedRead } from './config-schema.mjs';

// The full gauge, importable (tests and /stats call it directly; the CLI main
// below is just argv plumbing around it). Pure composition — no state writes.
export function gauge({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const projectRoot = findProjectRoot(cwd, home);
  const recover = recoverDangling(projectRoot);
  const cfg = loadMergedConfig({ cwd, home });
  const fullPercent = clampedRead(cfg, 'fullPercent');

  const disc = discoverClassB({ projectRoot, home });
  const m = measureEntries(disc.entries, { withGzip: true });
  const proj = projectState(loadState(home), projectRoot);
  // Same floor hygiene as the conductor: never trust the raw stored value.
  const leanFloorTokens = sanitizeLeanFloor(proj.leanFloorTokens, m.alwaysLoaded.tokensEst);
  const verdict = bandVerdict({
    footprintTokens: m.alwaysLoaded.tokensEst,
    leanFloorTokens,
    fullPercent,
    indexBytes: m.index.bytes,
    indexLines: m.index.lines,
  });
  const econ = breakEven({
    footprintTokens: m.alwaysLoaded.tokensEst,
    leanFloorTokens,
    totalStoreTokens: m.totalTokensEst,
    sessionsPerDay: sessionsPerDay(proj.stamps),
  });
  return { projectRoot, recover, platform: disc.platform, flags: disc.flags, measure: m, verdict, breakEven: econ };
}

// The terse one-line gauge (method.md §0's reporting shape).
export function gaugeLine(g) {
  const bmi = g.verdict.bmi ? `BMI ${g.verdict.bmi.toFixed(2)}` : 'no floor yet';
  const recovered = g.recover && g.recover.recovered && g.recover.recovered !== 'none'
    ? ` · recovered dangling run: ${g.recover.recovered}` : '';
  return `[CoalWash] ${g.verdict.band} — always-loaded ~${Math.round(g.measure.alwaysLoaded.tokensEst)} tok/session (~est) · ${bmi}${recovered}`;
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd !== 'gauge') {
    console.error('usage: node scripts/lib/cli.mjs gauge [--json]');
    process.exitCode = 1;
    return;
  }
  try {
    const g = gauge();
    console.log(args.includes('--json') ? JSON.stringify(g, null, 1) : gaugeLine(g));
  } catch (e) {
    console.error(`gauge failed: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
