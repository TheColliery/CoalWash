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
//   node scripts/lib/cli.mjs estate [--json]
//   node scripts/lib/cli.mjs dig-gauge <path...> [--json] [--session <id>]
//
// dig-gauge <path...> (ULTRA trigger #2 — dig-gauge.mjs, the PRE-READ
// tollgate): an agent about to DIG old history passes the candidate paths a
// search already found; dig-gauge stats them (fs.stat BYTES, NEVER a content
// read → ~est tok at 4 chars/tok) and verdicts CLEAR/CRUSHING against the
// config `estate.digCrush` priors. On CRUSHING it also surfaces the ULTRA
// offer ONCE per session (--session dedups). REPORT-ONLY — a CRUSHING verdict
// exits 0; declining proceeds with the raw dig, nothing is ever blocked. The
// gauge is ~free insurance (~0.3k tok out) against the >=150k crush a raw dig
// would re-carry every turn.
//
// estate (class-A ESTATE layer P1, COALWASH_BLUEPRINT.md §19 — REPORT ONLY,
// zero mutation): discovers this project's own CC session transcripts +
// overflow dirs, measures total/per-type bytes, flags machine-wide orphan
// slug dirs (best-effort), and prints a heuristic ~est reclaimable figure.
// Never deletes/archives/edits anything — P2/P3 are future, separate work.
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
  measureEntries, gaugeVerdict,
  loadState, armDigGauge,
} from './caliper.mjs';
import { envelopeFor } from './retier.mjs';
import { digGauge, digGaugeLine } from './dig-gauge.mjs';
import { digGaugeOffer } from './ask.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, listBin, restoreFromBin } from './tailings.mjs';
import { listWriteguard, readWriteguardSnapshot } from './writeguard.mjs';
import { loadMergedConfig, findProjectRoot } from './config-load.mjs';
import { clampedRead } from './config-schema.mjs';
import { anchorDiff, anchorDiffLine } from './anchor-diff.mjs';
import { estateReport } from './estate.mjs';
import {
  estateUltraScan, ultraBillLine, runEstate, runEstateReport,
  searchIndex, searchLines, restoreSession, resolveArchiveDir, collectTombstones,
  readEstateKeyResolvedState, writeEstateKeyResolvedState,
} from './estate-archive.mjs';
import { retierScan, retierScanLines, runRetier, runRetierReport } from './retier.mjs';

// RECOVERY-FREE measurement — the same gauge composition with the write-capable
// preflight left out. READ-ONLY: it discovers, measures, and judges; it stamps
// nothing, records nothing, and recovers nothing. Built for an unattended caller
// (the CI/Action gauge) that must never run a file-restoring path against an
// untrusted checkout.
//
// THE REFUSAL STAYS, AND HERE IS WHY — do not "simplify" it away now that the
// danger is gone. An automated caller must still REFUSE LOUDLY when a journal is
// present, rather than quietly measuring past it: the split removes the DANGER,
// the refusal keeps the SIGNAL. A journal sitting in a PR checkout is either an
// interrupted run someone committed by accident or a planted one, and a human
// wants to hear about both. Measuring silently past it would be a silent-refusal
// defect arriving through a path we built on purpose. A guard whose reason has
// been forgotten is the one that gets deleted, so the reason lives here.
export function measureOnly({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const projectRoot = findProjectRoot(cwd, home);
  const cfg = loadMergedConfig({ cwd, home });
  const managedPaths = clampedRead(cfg, 'managedPaths');

  const disc = discoverClassB({ projectRoot, home, managedPaths });
  const m = measureEntries(disc.entries, { withGzip: true });
  const proj = loadState(projectRoot, home);
  // Read-only hysteresis + latch state — the gauge CONSUMES these and never
  // stamps or records them (the conductor's SessionStart/Stop are the stamping
  // site). That is a claim about THIS composition only: the recovery preflight
  // above can still write, see the header. Without them, a probe
  // run between two SessionStarts would show the ceiling flapping LEAN in
  // the dead zone (or a latched economic FULL flapping back to OBESE, 0g Q2)
  // instead of reporting the SAME armed state the conductor is tracking.
  const wasOver = !!(proj.lastVerdict && proj.lastVerdict.overCeiling);
  const wasEconLatched = !!(proj.lastVerdict && proj.lastVerdict.econLatched);
  // task #4: fat and muscle are MEASURED by this very gauge (the certain-fat
  // scan inside measureEntries) — no stored floor is read, no fullPercent/
  // fatMultiple wall is computed (both retired). The reorg envelope resolves
  // from the same merged config, via retier's own resolver — same composition
  // as the conductor's two gauge sites.
  const gv = gaugeVerdict({
    measure: m,
    wasOver,
    wasEconLatched,
    stamps: proj.stamps,
    envelope: envelopeFor(cfg.retier),
  });
  const verdict = gv.verdict;
  const econ = {
    fatTokens: gv.fatTokens, perDay: gv.perDay, breakEvenDays: gv.breakEvenDays,
    demotableTokens: gv.demotableTokens, reorgPerDay: gv.reorgPerDay, reorgBreakEvenDays: gv.reorgBreakEvenDays,
    economical: gv.economical, muscleTokens: gv.muscleTokens, mechFatTokens: gv.mechFatTokens,
  };
  // The INHERITED-ANCESTOR tier, measured the same way and reported SEPARATELY —
  // never added into `measure`, which is what the verdict acts on. The series law
  // calls this "context-cost-not-room-fat": it is real per-session cost the reader
  // should see, and it is not this room's to wash or externalize. Same
  // measureEntries, so the number is comparable to the room's own.
  const inherited = measureEntries(disc.inherited, { withGzip: false });
  return { projectRoot, platform: disc.platform, flags: disc.flags, measure: m, inherited, verdict, breakEven: econ, roleMemories: disc.roleMemories };
}

// The full gauge = measureOnly + the recovery preflight. Importable (tests and
// /stats call it directly; the CLI main below is just argv plumbing around it).
//
// ⚠ NOT read-only: gauge() RUNS A RECOVERY PREFLIGHT THAT CAN WRITE, and it runs
// FIRST — before the config is even loaded. This comment once said "pure
// composition — no state writes", which was true of the measurement half and
// FALSE of the preflight, i.e. false about the only part that can touch your
// files. A reader deciding "is it safe to call gauge here?" reads this line and
// stops, so the wrong version of it was an incident waiting to happen.
//
// WHEN IT WRITES: only when a transaction journal exists at the project's own
// `.claude/coalwash/journal.json`. Then `recoverDangling` either finishes an
// interrupted run — restoring snapshotted files over the live ones and removing
// the creates it added — or, for a terminal/never-started journal, deletes the
// journal file. With NO journal present it writes nothing. It refuses (and still
// writes nothing) when the journal is unreadable, schema-newer, has no verifiable
// roots, names a snapDir outside the tx dir, when no trusted root resolves, or —
// the two ANCHOR-GATE refusals, which fire BEFORE the journal is even read —
// when the project anchor is the home dir or an ancestor of it, or sits inside
// (or contains) the Claude configuration directory. Those two are the reason a
// repo-shipped journal reached through this front door can no longer restore over
// ~/.claude/settings.json; the list is load-bearing, so it stays complete.
//
// AN UNATTENDED CALLER WANTS `measureOnly` INSTEAD: a CI/Action runner must NOT
// call gauge() against an untrusted checkout — an attacker-authored journal.json
// is exactly the R5/F1 vector, with no human present.
export function gauge(opts = {}) {
  // The preflight runs FIRST and is the only write in this composition. `recover`
  // is consumed by nothing in the measurement — only by the caller — which is why
  // the two separate cleanly.
  // opts.home reaches BOTH halves. It used to feed only findProjectRoot, so the
  // recovery preflight resolved its own home independently — harmless in
  // production (both land on os.homedir()) but a false-green trap in a test that
  // sandboxes HOME: recoverDangling's anchor guard would compare a sandbox anchor
  // against the REAL ~/.claude, so a config-territory case could never fire
  // through this front door and the gate would pass vacuously.
  const home = opts.home || os.homedir();
  const projectRoot = findProjectRoot(opts.cwd || process.cwd(), home);
  const recover = recoverDangling(projectRoot, { home });
  return { ...measureOnly(opts), recover };
}

// The terse one-line gauge (method.md §0's reporting shape).
export function gaugeLine(g) {
  // task #4: BMI = footprint / MEASURED muscle now (1.00 = provably-pure
  // muscle), informational only — the certain-fat figure beside it is what
  // the band actually acts on.
  const fatBit = g.breakEven && Number.isFinite(g.breakEven.fatTokens) ? ` · certain fat ~${Math.round(g.breakEven.fatTokens)} tok` : '';
  const bmi = (g.verdict.bmi ? `BMI ${g.verdict.bmi.toFixed(2)}` : 'BMI n/a') + fatBit;
  // A REFUSAL IS AN EVENT, AND SILENCE MADE IT INDISTINGUISHABLE FROM NOTHING.
  // Every refusal returns recovered:'none' + an error, so the old `!== 'none'`
  // test dropped ALL of them: a user with a poisoned journal sitting in a fresh
  // checkout saw byte-identical output to a user with no journal at all. That is
  // the same shape as the bug this recovery path just closed, where a successful
  // -looking message was the defect's cover — inverted: here the good news (we
  // found something and refused to touch it) is the thing being hidden.
  // The two cases are genuinely different and now read differently:
  //   'none' with NO error  -> nothing to do, stay silent (the common path).
  //   'none' WITH an error  -> we found a journal and REFUSED it: say so.
  // Terse by design — the reason is long (an anchor refusal names the path) and
  // belongs in --json, which the SKILL text now points at. The line's job is to
  // make the reader ASK.
  const rec = g.recover || {};
  const recovered = rec.recovered && rec.recovered !== 'none'
    ? ` · recovered dangling run: ${rec.recovered}`
    : (rec.error ? ' · dangling run REFUSED, left for inspection (--json for the reason)' : '');
  return `[CoalWash] ${g.verdict.band} — always-loaded ~${Math.round(g.measure.alwaysLoaded.tokensEst)} tok/session (~est) · ${bmi}${recovered}`;
}

// The 0-token human recovery lookup (importable, pure read): searches BOTH
// bins — fat first (the high-churn producer), then the wizard bin
// (store.old) — and returns the item's content + metadata, or found:false.
// restoreFromBin's own null-vs-empty distinction carries through: a genuinely
// empty stash is a legitimate find.
// `content` is a BUFFER (G3-3) — the recovery door moves bytes, so
// `process.stdout.write(r.content)` below pipes the ORIGINAL file, not a UTF-8
// re-encoding of a lossy decode of it. `bytes` is the real byte count for the
// same reason, not a re-measured string length.
export function restore({ id, cwd = process.cwd(), home = os.homedir() } = {}) {
  const projectRoot = findProjectRoot(cwd, home);
  for (const bin of [FAT_BIN_NAME, STORE_OLD_NAME]) {
    const content = restoreFromBin(projectRoot, bin, id);
    if (content !== null) {
      const item = listBin(projectRoot, bin).find((i) => i && i.id === id) || {};
      return { found: true, bin, id, original: item.original || null, bytes: content.length, content };
    }
  }
  return { found: false, id };
}

const USAGE = 'usage: node scripts/lib/cli.mjs gauge [--json] | restore <id> | writeguard-list | writeguard-restore <snapName> | anchor-diff <path> [--json] | estate [--json] | estate-scan [--session <id>] | estate-run [--session <id>] | estate-search <query> | estate-restore <sessionId> [--to <dir>] | retier-scan [--json] | retier-run | dig-gauge <path...> [--json] [--session <id>]';

// estate-scan / estate-run / estate-search / estate-restore (ULTRA, blueprint
// §19 P2 partial — estate-archive.mjs): estate-scan = the non-mutating bill
// (sessions per band + MB now -> ~MB after); estate-run = the wizard-consented
// ULTRA execution (RUN-GATED BY CONTRACT: the SKILL invokes it only after the
// wizard's ULTRA choice — it is never wired to a hook). --session <id> = the
// caller's own current session id, excluded from every band absolutely.
// estate-search greps the local dig-index; estate-restore decompresses one
// archived session byte-exact to a scratch dir (or --to), never the live tree.
function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
function estateOpts(args) {
  const home = os.homedir();
  const projectRoot = findProjectRoot(process.cwd(), home);
  const estate = clampedRead(loadMergedConfig({ cwd: process.cwd(), home }), 'estate');
  return { projectRoot, home, estate, currentSessionId: argAfter(args, '--session') };
}

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
  } else if (cmd === 'estate') {
    try {
      const home = os.homedir();
      const projectRoot = findProjectRoot(process.cwd(), home);
      // board #55 AMENDMENT, ladder rung 6: read the prior run's transition marker, pass it
      // into the (pure) report, then persist whatever THIS run found — the only place this
      // tiny side-channel is read or written; estate.mjs itself never touches disk for it.
      const priorKeyResolved = readEstateKeyResolvedState(home);
      const r = estateReport({ projectRoot, home, priorKeyResolved });
      writeEstateKeyResolvedState(r.horizon.keyResolvedNow, home);
      console.log(args.includes('--json') ? JSON.stringify(r, null, 1) : r.text);
    } catch (e) {
      console.error(`estate failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'estate-scan') {
    try {
      const scan = estateUltraScan(estateOpts(args));
      console.log(args.includes('--json') ? JSON.stringify(scan, null, 1) : ultraBillLine(scan));
    } catch (e) {
      console.error(`estate-scan failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'estate-run') {
    try {
      const res = runEstate(estateOpts(args));
      console.log(runEstateReport(res));
      if (!res.ok) process.exitCode = 1; // deferred/lock-held = loud, nothing touched
    } catch (e) {
      console.error(`estate-run failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'estate-search') {
    const query = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    if (!query) { console.error(USAGE); process.exitCode = 1; return; }
    try {
      const { projectRoot, home, estate } = estateOpts(args);
      // #58 tombstone cross-check: a matching row is ANNOTATED (later-removed?),
      // never dropped — the search still returns everything it found.
      const tombstones = collectTombstones({ projectRoot, home });
      const rows = searchIndex(query, { archiveDir: resolveArchiveDir(estate, home), tombstones });
      console.log(searchLines(rows, { hasDeathLog: tombstones.hasDeathLog }));
    } catch (e) {
      console.error(`estate-search failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'retier-scan') {
    // RE-TIER (wizard's FOURTH choice) — the bill AFTER the choice: envelope
    // state (band now vs target/arm/disarm), planned placement per item, #55
    // contradiction flags. REPORT-ONLY: no lock, no state, no writes.
    try {
      const home = os.homedir();
      const cfg = loadMergedConfig({ cwd: process.cwd(), home });
      const scan = retierScan({ projectRoot: findProjectRoot(process.cwd(), home), home, retier: clampedRead(cfg, 'retier') });
      console.log(args.includes('--json') ? JSON.stringify(scan, null, 1) : retierScanLines(scan));
    } catch (e) {
      console.error(`retier-scan failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'retier-run') {
    // The transactional pass (RUN-GATED BY CONTRACT: the SKILL invokes it only
    // after the wizard's RE-TIER choice — never wired to a hook). Refuses in
    // the dead zone (LEAN-stop); lock held elsewhere -> deferred, untouched.
    try {
      const home = os.homedir();
      const cfg = loadMergedConfig({ cwd: process.cwd(), home });
      const res = runRetier({
        projectRoot: findProjectRoot(process.cwd(), home), home,
        retier: clampedRead(cfg, 'retier'), estate: clampedRead(cfg, 'estate'),
      });
      console.log(runRetierReport(res));
      if (!res.ok) process.exitCode = 1; // refused/deferred/failed = loud
    } catch (e) {
      console.error(`retier-run failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'estate-restore') {
    const sessionId = args[1];
    if (!sessionId || sessionId.startsWith('--')) { console.error(USAGE); process.exitCode = 1; return; }
    try {
      const { projectRoot, home, estate } = estateOpts(args);
      const tombstones = collectTombstones({ projectRoot, home });
      const r = restoreSession(sessionId, { archiveDir: resolveArchiveDir(estate, home), to: argAfter(args, '--to'), tombstones });
      if (!r.ok) { console.error(`estate-restore: ${r.error}`); process.exitCode = 1; return; }
      console.log(`[CoalWash] restored ${r.files.length} file(s) of session ${sessionId} to ${r.dir} — byte-exact originals; nothing written into the live CC tree${argAfter(args, '--to') ? ' beyond your --to choice' : ''}`);
      for (const f of r.files) console.log(`  ${f.rel} (${f.bytes} bytes)`);
      // #58 deletion-unaware time-travel restore: label recovered content that
      // overlaps an adjudicated/cut tombstone — advisory, the restore stands.
      if (Array.isArray(r.laterRemoved) && r.laterRemoved.length) {
        const named = r.laterRemoved.slice(0, 2).map((h) => `"${h.anchor}"${h.date ? ` (${h.date})` : ''}`).join('; ');
        console.log(`  ⚠ later-removed? this recovered session matches ${r.laterRemoved.length} gate-adjudicated keep(s): ${named} — VERIFY against the CURRENT live store before treating it as current fact; it may have been deliberately removed/changed (keeps.json${tombstones.hasDeathLog ? ' + the bin death-log' : ''}).`);
      }
    } catch (e) {
      console.error(`estate-restore failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'dig-gauge') {
    // ULTRA trigger #2 (dig-gauge.mjs) — the PRE-READ tollgate. Stats the
    // candidate PATHS a search already found (NO content read), verdicts them
    // against the config `digCrush` priors, and on CRUSHING surfaces the ULTRA
    // offer ONCE per session (armDigGauge, keyed on --session). REPORT-ONLY: a
    // CRUSHING verdict still exits 0 — declining proceeds with the raw dig,
    // nothing is ever blocked. The ONE CLI subcommand that writes state (its
    // own dedup flag only, and only on a CRUSHING+armed surface — a CLEAR dig
    // writes nothing); every other subcommand's gauge/read stays state-clean.
    const session = argAfter(args, '--session');
    const paths = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] === '--session') { i++; continue; } // skip the flag AND its value
      paths.push(args[i]);
    }
    if (!paths.length) { console.error(USAGE); process.exitCode = 1; return; }
    try {
      const home = os.homedir();
      const projectRoot = findProjectRoot(process.cwd(), home);
      const thresholds = clampedRead(loadMergedConfig({ cwd: process.cwd(), home }), 'estate').digCrush;
      const verdict = digGauge(paths, thresholds);
      const surface = verdict.band === 'CRUSHING' ? armDigGauge(home, projectRoot, session).surface : false;
      if (args.includes('--json')) {
        console.log(JSON.stringify({ ...verdict, surface, offer: surface ? digGaugeOffer(verdict) : null }, null, 1));
      } else {
        console.log(digGaugeLine(verdict));
        if (surface) console.log(digGaugeOffer(verdict));
      }
    } catch (e) {
      console.error(`dig-gauge failed: ${e.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
