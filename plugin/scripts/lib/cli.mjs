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
//   node scripts/lib/cli.mjs writeguard-list
//   node scripts/lib/cli.mjs writeguard-restore <snapName>
//   node scripts/lib/cli.mjs anchor-diff <path> [--json]
//
// anchor-diff <path> (loss class #54 — generational-compounding, ADVISORY
// ONLY): diffs the file's OLDEST verified CoalWash snapshot against its
// current content + every recorded bin drop since, and reports structured-
// token CANDIDATES missing from both — see anchor-diff.mjs's own doc comment.
// Never blocks, never restores; a clean lineage or a file CoalWash has never
// snapshotted both print a neutral "nothing to report" line, never an error.
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
// writeguard-list / writeguard-restore <snapName> (0p — the airbag undo door,
// same restore-by-reference law as the bins): list = metadata only (name ·
// session · bytes · path), the agent POINTS at a snapshot, never reproduces
// bytes; restore = CODE prints the byte-exact ORIGINAL to stdout (pipeable:
// `... writeguard-restore <snapName> > MEMORY.md`). An AI re-authoring a
// "recovery" from memory is the ADD-01 hallucination-twin; undo is trustworthy
// only because the bytes are the REAL bytes, model-untouched.
//
// BOTH subcommands are READ-ONLY toward CoalWash state by design: no stamp,
// no verdict cache, no crossing is written — those are the SessionStart
// conductor's session bookkeeping, and a CLI call is a measurement/read, not
// a session event (double-stamping would distort the sessions/day economics).
//
// CLI discipline (scripts-quality.md): fail LOUD — a bad subcommand, a
// missing id, or a pipeline error prints to stderr and exits non-zero.
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { recoverDangling } from './apply.mjs';
import { discoverClassB } from './class-b.mjs';
import {
  measureEntries, bandVerdict, breakEven, sessionsPerDay,
  loadState, sanitizeLeanFloor,
} from './caliper.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, listBin, restoreFromBin } from './bins.mjs';
import { listWriteguard, readWriteguardSnapshot } from './writeguard.mjs';
import { loadMergedConfig, findProjectRoot } from './config-load.mjs';
import { clampedRead } from './config-schema.mjs';
import { anchorDiff, anchorDiffLine } from './anchor-diff.mjs';

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
  const proj = loadState(projectRoot, home);
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

const USAGE = 'usage: node scripts/lib/cli.mjs gauge [--json] | restore <id> | writeguard-list | writeguard-restore <snapName> | anchor-diff <path> [--json]';

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
  } else if (cmd === 'writeguard-list') {
    try {
      const rows = listWriteguard(findProjectRoot(process.cwd(), os.homedir()), { home: os.homedir() });
      if (!rows.length) { console.log('[CoalWash] no write-guard snapshots this session.'); return; }
      // Metadata ONLY — the agent points at a snapshot, never reproduces bytes.
      for (const r of rows) console.log(`${r.name}\t${r.bytes} bytes\tsession ${r.session}\t${r.snapshotPath}`);
    } catch (e) {
      console.error(`writeguard-list failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'writeguard-restore') {
    const name = args[1];
    if (!name) { console.error(USAGE); process.exitCode = 1; return; }
    try {
      const r = readWriteguardSnapshot(findProjectRoot(process.cwd(), os.homedir()), name, { home: os.homedir() });
      if (!r) { console.error(`writeguard-restore: snapshot '${name}' not found`); process.exitCode = 1; return; }
      process.stdout.write(r.content); // the byte-exact ORIGINAL — code-moved, model-untouched
      console.error(`[CoalWash] restored write-guard snapshot ${r.name} (${r.bytes} bytes, session ${r.session}) — byte-exact original on stdout; redirect it to the file, never re-type it`);
    } catch (e) {
      console.error(`writeguard-restore failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'anchor-diff') {
    const target = args[1];
    if (!target) { console.error(USAGE); process.exitCode = 1; return; }
    try {
      const projectRoot = findProjectRoot(process.cwd(), os.homedir());
      const report = anchorDiff(target, { projectRoot, home: os.homedir() });
      if (args.includes('--json')) { console.log(JSON.stringify(report, null, 1)); return; }
      console.log(report ? (anchorDiffLine(report) || `[CoalWash] ${target}: clean lineage since its oldest snapshot — 0 candidates.`)
        : `[CoalWash] ${target}: no verified CoalWash snapshot on disk for this file yet — nothing to compare.`);
    } catch (e) {
      console.error(`anchor-diff failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
