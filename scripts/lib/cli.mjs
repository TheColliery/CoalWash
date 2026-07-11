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
//   node scripts/lib/cli.mjs restore <id>
//
// gauge = one call: recoverDangling (heals a dangling prior txn — its no-op
// path touches nothing) + discoverClassB + measureEntries + bandVerdict +
// breakEven. Output: the terse one-line gauge (default) or the full JSON
// (--json).
//
// restore <id> (0h — the 0-token human recovery door, pull-only): looks the
// id up in BOTH bins (fat first, then the wizard bin store.old), prints the
// item's CONTENT to stdout (pipeable: `... restore <id> > recovered.md`)
// and ONE summary line (id · bin · bytes · source file) to stderr — the
// classic data/diagnostics split, so redirection captures pure content. It
// NEVER writes to the store: re-inserting recovered content is the human's
// (or a gated plan's) decision, never this command's — a write here would
// be a mutation outside applyPlan's gates.
//
// BOTH subcommands are READ-ONLY toward CoalWash state by design: no stamp,
// no verdict cache, no crossing is written — those are the SessionStart
// conductor's session bookkeeping, and a CLI call is a measurement/read, not
// a session event (double-stamping would distort the sessions/day economics).
//
// CLI discipline (scripts-quality.md): fail LOUD — a bad subcommand, a
// missing id, or a pipeline error prints to stderr and exits non-zero.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recoverDangling } from './apply.mjs';
import { discoverClassB } from './class-b.mjs';
import {
  measureEntries, bandVerdict, breakEven, sessionsPerDay,
  loadState, projectState, sanitizeLeanFloor,
} from './caliper.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, listBin, restoreFromBin } from './bins.mjs';
import { loadMergedConfig, findProjectRoot } from './config-load.mjs';
import { clampedRead } from './config-schema.mjs';

// The full gauge, importable (tests and /stats call it directly; the CLI main
// below is just argv plumbing around it). Pure composition — no state writes.
export function gauge({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const projectRoot = findProjectRoot(cwd, home);
  const recover = recoverDangling(projectRoot);
  const cfg = loadMergedConfig({ cwd, home });
  const fullPercent = clampedRead(cfg, 'fullPercent');
  const managedPaths = clampedRead(cfg, 'managedPaths');

  const disc = discoverClassB({ projectRoot, home, managedPaths });
  const m = measureEntries(disc.entries, { withGzip: true });
  const proj = projectState(loadState(home), projectRoot);
  // Same floor hygiene as the conductor: never trust the raw stored value.
  // 0j note: this READ-ONLY gauge never stamps the provisional floor (the
  // conductor's gauges are the stamping site); it CONSUMES the stored floor
  // — real or provisional — identically to them.
  const leanFloorTokens = sanitizeLeanFloor(proj.leanFloorTokens, m.alwaysLoaded.tokensEst);
  const floorProvisional = proj.leanFloorProvisional === true;
  // Read-only hysteresis + latch state (never written here — this CLI
  // stamps/records nothing, per its own doc comment): without them, a probe
  // run between two SessionStarts would show the ceiling flapping LEAN in
  // the dead zone (or a latched economic FULL flapping back to OBESE, 0g Q2)
  // instead of reporting the SAME armed state the conductor is tracking.
  const wasOver = !!(proj.lastVerdict && proj.lastVerdict.overCeiling);
  const wasEconLatched = !!(proj.lastVerdict && proj.lastVerdict.econLatched);
  // 0g Q4: economics BEFORE the band — the band depends on the break-even.
  const econ = breakEven({
    footprintTokens: m.alwaysLoaded.tokensEst,
    leanFloorTokens,
    totalStoreTokens: m.totalTokensEst,
    sessionsPerDay: sessionsPerDay(proj.stamps),
  });
  const verdict = bandVerdict({
    footprintTokens: m.alwaysLoaded.tokensEst,
    leanFloorTokens,
    fullPercent,
    indexBytes: m.index.bytes,
    indexLines: m.index.lines,
    wasOver,
    economical: econ.economical,
    wasEconLatched,
    floorProvisional,
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

// The 0-token human recovery lookup (importable, pure read): searches BOTH
// bins — fat first (the high-churn producer), then the wizard bin
// (store.old) — and returns the item's content + metadata, or found:false.
// restoreFromBin's own null-vs-'' distinction carries through: a genuinely
// empty stash is a legitimate find.
export function restore({ id, cwd = process.cwd(), home = os.homedir() } = {}) {
  const projectRoot = findProjectRoot(cwd, home);
  for (const bin of [FAT_BIN_NAME, STORE_OLD_NAME]) {
    const content = restoreFromBin(projectRoot, bin, id);
    if (content !== null) {
      const item = listBin(projectRoot, bin).find((i) => i && i.id === id) || {};
      return { found: true, bin, id, original: item.original || null, bytes: Buffer.byteLength(content, 'utf8'), content };
    }
  }
  return { found: false, id };
}

const USAGE = 'usage: node scripts/lib/cli.mjs gauge [--json] | restore <id>';

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'gauge') {
    try {
      const g = gauge();
      console.log(args.includes('--json') ? JSON.stringify(g, null, 1) : gaugeLine(g));
    } catch (e) {
      console.error(`gauge failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'restore') {
    const id = args[1];
    if (!id) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    try {
      const r = restore({ id });
      if (!r.found) {
        console.error(`restore: id '${id}' not found in ${FAT_BIN_NAME} or ${STORE_OLD_NAME}`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(r.content); // the payload — pipeable, verbatim
      console.error(`[CoalWash] restored ${r.id} from ${r.bin} (${r.bytes} bytes${r.original ? `, cut from ${r.original}` : ''}) — content on stdout; nothing was written to the store`);
    } catch (e) {
      console.error(`restore failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
