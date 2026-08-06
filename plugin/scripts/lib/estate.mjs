// estate.mjs — class-A ESTATE layer, PHASE 1 (report tier ONLY).
// COALWASH_BLUEPRINT.md §19 is the authority for this module: class-A content
// (machine-parsed session transcripts + their per-session overflow dirs under
// ~/.claude/projects/<slug>/) fails all 4 washability tests (beta.6: not a
// local user-authored PROSE file, not ACCRETED the way a memory file is — a
// transaction log, not notes) so it NEVER joins class-B's in-place wash
// (class-b.mjs). Only whole-unit ops apply to it, and P1 is the first of
// three phases: MEASURE + ATTRIBUTE + ADVISE. ZERO MUTATION — every export
// in this file is a pure read; nothing here deletes, archives, edits, or
// moves a single byte. P2 (retention/archive) and P3 (slim-copy) are future,
// separate releases per §19 clause 4's phasing law.
//
// Safety mirrors class-b.mjs: every file candidate is realpath-resolved and
// CONTAINED to ~/.claude on BOTH sides (the candidate AND the root); an
// unresolvable or escaping path is skipped (fail-closed). A missing/absent
// directory anywhere in this module is fail-silent (empty result), never a
// thrown error — a report must never crash a session over an artifact CC
// itself may not have created yet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeBaseDir, readCleanupPeriodDays, discoverRetentionCandidateKeys } from './config-load.mjs';
import { ccProjectSlug, physicalOrNull, containedIn } from './class-b.mjs';

// Read-budget cap for the two OPTIONAL content sniffs below (topic hint +
// orphan cwd) — a multi-MB transcript is never read in full for either; both
// stop at this many bytes from the file's start.
const SNIFF_BUDGET_BYTES = 4096;
// The RAW platform-mirror value (CC's own first-party `cleanupPeriodDays`
// default, verified live, COALWASH_BLUEPRINT.md §19 U1: 30 days, mtime-based)
// — kept as an explicit-override FIXTURE constant for callers that want it,
// never as `estateReport`'s own default any more. Board #55, 2026-08-05:
// setting the reclaim horizon EQUAL to the platform's own sweep period was
// the live defect — CC's startup cleanup can claim a file before this
// project's own next run ever sees it as reclaimable, so `estate --json`
// reported `reclaim.bytes/files` stuck at effectively zero on every real
// machine (nothing survives long enough to cross an EQUAL threshold).
// `estateReport` now derives its horizon from the REAL, machine-read
// `cleanupPeriodDays` via `deriveEstateHorizonDays` below — always strictly
// below the platform period by construction, never merely mirroring it.
export const RECLAIM_HORIZON_MS = 30 * 86400000;

// board #55 AMENDMENT (owner, 2026-08-05) — "ผูกตัวแปรตาม cleanupPeriodDays เพื่อให้อัพเดต
// ตามไปมาได้" (bind the variable to cleanupPeriodDays so it tracks automatically, both
// directions). Supersedes the earlier max(7,…)/degrade formula: DERIVED FRESH on every call,
// never persisted — a CACHED horizon carries stale semantics the instant the platform value
// changes, silently, in the data-loss direction (the state-schema-guard defect by
// construction — binding means computing, not seeding). One formula, no branches:
// horizonDays = floor(cleanupPeriodDays / 2). The old max(7,…) floor and the <14 special case
// are GONE — they broke the very proportionality this amendment asks for (at cleanup=10 a
// floor of 7 left a 3-day window, TIGHTER than the ratio it was meant to protect).
export function deriveEstateHorizonDays(cleanupPeriodDays) {
  const cleanup = Number.isFinite(cleanupPeriodDays) && cleanupPeriodDays >= 1
    ? Math.floor(cleanupPeriodDays)
    : 30; // unreadable/invalid input — the platform's own documented default
  return Math.floor(cleanup / 2);
}

// Defensive cap on the machine-wide project-dir walk below — same class as
// ESTATE_FILE_CAP (a pathological machine gets a bounded, not unbounded, scan).
const ESTATE_PROJECTS_SCAN_CAP = 20000;

// board #55 AMENDMENT, ladder rung 3 — the empirical cross-check that survives a rename.
// Do not only ask the platform what its policy IS; MEASURE what it actually DOES: the age of
// the OLDEST *.jsonl transcript still on disk, MACHINE-WIDE (every project's slug dir under
// ~/.claude/projects/, not scoped to one project — the platform's own sweep is not
// per-project either, so a bigger sample is the point, per the owner's own instruction).
// Returns the age in whole days of the single oldest surviving transcript, or null when
// nothing exists anywhere to measure (a fresh install — no signal, not a zero).
export function observedRetentionFloorDays({ home = os.homedir(), now = Date.now() } = {}) {
  const base = claudeBaseDir(home);
  const claudeRoot = physicalOrNull(base);
  if (!claudeRoot) return null;
  const projectsDir = path.join(base, 'projects');
  let projectDirs;
  try { projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }

  let maxAgeMs = -Infinity;
  let seen = 0;
  outer: for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const slugPhys = physicalOrNull(path.join(projectsDir, d.name));
    if (!slugPhys || !containedIn(slugPhys, [claudeRoot])) continue; // fail-closed
    let files;
    try { files = fs.readdirSync(slugPhys, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (seen >= ESTATE_PROJECTS_SCAN_CAP) break outer;
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      seen++;
      const filePhys = physicalOrNull(path.join(slugPhys, f.name));
      if (!filePhys || !containedIn(filePhys, [claudeRoot])) continue;
      const st = statOrNull(filePhys);
      if (!st || !st.isFile()) continue;
      const ageMs = now - st.mtimeMs;
      if (ageMs > maxAgeMs) maxAgeMs = ageMs;
    }
  }
  return maxAgeMs === -Infinity ? null : Math.floor(maxAgeMs / 86400000);
}

// board #55 AMENDMENT, ladder rung 3's threshold — fires ("materially below") only when real
// evidence exists NEAR the assumed boundary. Without this floor, a FRESH install (nothing has
// had time to age past a few days) would misread "no file is old yet" as "the sweep is more
// aggressive than stated", ratcheting every new install to a tiny horizon on pure absence of
// evidence. Requiring the observed floor to reach at least half the assumed period is the line
// between genuine divergence and not-enough-history-to-say-anything-yet — a real judgment
// call, declared here rather than hidden inside an unexplained number.
const OBSERVED_FLOOR_MIN_FRACTION = 0.5;
// Rung 4's fallback when the key assumption itself just broke (see resolveEstateHorizon) — the
// owner's own proposed value, a small horizon because unknown means we do not know when the
// axe falls, so archive early and lean on the restore path.
const NOTHING_ESTABLISHABLE_HORIZON_DAYS = 7;

// board #55 AMENDMENT — THE LADDER, evaluated fresh every call, never cached:
//   1. KEY READ + SANE (readCleanupPeriodDays) — present, sane value anywhere in the
//      cascade → bind to it.
//   2. KEY ABSENT everywhere readable — the documented default (30) applies. NORMAL, not a
//      failure — this machine's actual, honest state.
//   3. OBSERVED FLOOR (observedRetentionFloorDays) — a ONE-WAY empirical cross-check: only
//      ever LOWERS the bound (an observed floor far ABOVE the assumed value is reported, never
//      used to RAISE the horizon — raising is the data-loss direction).
//   4. NOTHING ESTABLISHABLE — fires when the key was resolved on the CALLER's last run
//      (`priorKeyResolved: true`) and is unresolved THIS run: a resolved→unresolved flip is a
//      rename/removal signal, and at the exact moment that assumption breaks, trusting the
//      (possibly now-stale) documented default is not safe — a small conservative constant
//      substitutes instead.
//   5. discoverRetentionCandidateKeys runs alongside, always, report-only.
//   6. `keyResolvedNow`/`transitionJustLost` are RETURNED, never written here — this function
//      stays a pure read (estate.mjs's own "zero mutation" invariant); a caller with write
//      access (cli.mjs's `estate` command) owns persisting the tiny transition marker.
export function resolveEstateHorizon({ cwd = process.cwd(), home = os.homedir(), now = Date.now(), priorKeyResolved = null } = {}) {
  const read = readCleanupPeriodDays({ cwd, home });
  const keyResolvedNow = read.source !== 'default';
  const candidateKeys = discoverRetentionCandidateKeys({ cwd, home });
  const transitionJustLost = priorKeyResolved === true && !keyResolvedNow;
  const observedFloorDays = observedRetentionFloorDays({ home, now });

  if (transitionJustLost) {
    return {
      horizonDays: NOTHING_ESTABLISHABLE_HORIZON_DAYS, cleanupPeriodDays: null,
      rung: 'nothing-establishable', source: read.source, file: read.file,
      observedFloorDays, floorApplied: false, candidateKeys, keyResolvedNow, transitionJustLost,
    };
  }

  let cleanupPeriodDays = read.days;
  const rung = keyResolvedNow ? 'resolved' : 'documented-default';
  let floorApplied = false;
  if (observedFloorDays !== null) {
    const materialThreshold = cleanupPeriodDays * OBSERVED_FLOOR_MIN_FRACTION;
    if (observedFloorDays >= materialThreshold && observedFloorDays < cleanupPeriodDays) {
      cleanupPeriodDays = observedFloorDays;
      floorApplied = true;
    }
  }

  return {
    horizonDays: deriveEstateHorizonDays(cleanupPeriodDays), cleanupPeriodDays, rung,
    source: read.source, file: read.file, observedFloorDays, floorApplied, candidateKeys,
    keyResolvedNow, transitionJustLost,
  };
}

// Defensive cap on the per-session overflow walk (tool-results/subagents/...).
// This module runs off the SessionStart hot path (a /stats or CLI call, not
// a per-turn hook), so it can afford to be more generous than class-b.mjs's
// RULES_FILE_CAP(500) — still bounded against a pathological machine.
const ESTATE_FILE_CAP = 20000;

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Read the first `budget` bytes of a file — never the whole thing. null on
// any failure (missing/unreadable/permission) — callers treat null as
// "nothing to sniff", never a guess.
function readHead(filePath, budget = SNIFF_BUDGET_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(budget);
    const n = fs.readSync(fd, buf, 0, budget, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// A realpath-resolved, ~/.claude-contained file candidate, or null
// (fail-closed) when unresolvable, escaping, or not a regular file.
function addFile(candidate, type, claudeRoots) {
  const phys = physicalOrNull(candidate);
  if (!phys || !containedIn(phys, claudeRoots)) return null;
  const st = statOrNull(phys);
  if (!st || !st.isFile()) return null;
  return { path: phys, bytes: st.size, type, mtimeMs: st.mtimeMs };
}

// Recursively collect every file under `dir` as `type` entries, bounded by
// `budget` total entries in `out`. Dirents are type-checked before any
// join/stat (mirrors class-b.mjs's G1 finding: a symlink/junction Dirent
// reports isSymbolicLink() true and neither isDirectory() nor isFile(), so
// it is silently never traversed here — defense in depth; addFile's own
// containment check still gates every file that IS reached).
function walkDir(dir, type, claudeRoots, out, budget) {
  if (out.length >= budget) return;
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= budget) return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { walkDir(p, type, claudeRoots, out, budget); continue; }
    if (!d.isFile()) continue; // symlink/other special file — never traversed
    const entry = addFile(p, type, claudeRoots);
    if (entry) out.push(entry);
  }
}

// ---------------------------------------------------------------------------
// discovery — THIS project's own CC session estate
// ---------------------------------------------------------------------------

// Locate this project's CC session estate: the flat *.jsonl transcripts
// directly under ~/.claude/projects/<slug>/, plus every file under each
// session's own subdirectory (tool-results/ tagged distinctly; anything else
// — subagents/, workflows/, a future platform addition — is 'other', never a
// hardcoded name list, so a new CC overflow dir is caught for free). A
// directory is only descended when its name matches a KNOWN session id (one
// with a sibling .jsonl) — this is what excludes CoalWash's OWN 'coalwash/'
// state dir and the class-B 'memory/' store (already class-b.mjs's
// jurisdiction; counting it here would double it against the BMI gauge).
// Fail-silent (empty array) when the project has no CC estate here yet, or
// ~/.claude itself cannot be resolved.
export function discoverEstateCC({ projectRoot = process.cwd(), home = os.homedir() } = {}) {
  const base = claudeBaseDir(home);
  const claudeRoot = physicalOrNull(base);
  if (!claudeRoot) return [];
  const claudeRoots = [claudeRoot];

  const projDir = path.join(base, 'projects', ccProjectSlug(projectRoot));
  let names;
  try { names = fs.readdirSync(projDir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  const sessionIds = new Set();
  for (const d of names) {
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
    const entry = addFile(path.join(projDir, d.name), 'transcript', claudeRoots);
    if (entry) out.push(entry);
    sessionIds.add(d.name.slice(0, -'.jsonl'.length));
  }
  for (const d of names) {
    if (out.length >= ESTATE_FILE_CAP) break;
    if (!d.isDirectory() || !sessionIds.has(d.name)) continue; // only a KNOWN session's own dir
    const sessDir = path.join(projDir, d.name);
    let subNames;
    try { subNames = fs.readdirSync(sessDir, { withFileTypes: true }); } catch { continue; }
    for (const s of subNames) {
      if (out.length >= ESTATE_FILE_CAP) break;
      const p = path.join(sessDir, s.name);
      if (s.isDirectory()) {
        walkDir(p, s.name === 'tool-results' ? 'tool-results' : 'other', claudeRoots, out, ESTATE_FILE_CAP);
      } else if (s.isFile()) {
        const entry = addFile(p, 'other', claudeRoots);
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// orphan detection — MACHINE-WIDE (an orphan's owning project is, by
// definition, never the current project — it cannot be scoped to projectRoot)
// ---------------------------------------------------------------------------

// Best-effort: pull a real `"cwd":"..."` value out of the FIRST *.jsonl this
// slug dir has (every CC transcript line carries one — verified live against
// this machine's own projects/). Deliberately NOT a reverse of ccProjectSlug
// (that collapse is lossy/irreversible in general — a literal '-' in a
// folder name and a path separator both fold to the same '-'); reading the
// real value CC already wrote is exact where a slug-decode could only guess.
// Read-budget capped; null on anything short of a clean parse — never guess.
function sniffCwd(slugDir) {
  let names;
  try { names = fs.readdirSync(slugDir); } catch { return null; }
  const jsonl = names.find((n) => n.endsWith('.jsonl'));
  if (!jsonl) return null;
  const head = readHead(path.join(slugDir, jsonl));
  if (!head) return null;
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
}

// Slug dirs under ~/.claude/projects/ whose owning project path no longer
// exists on disk — orphan CANDIDATES (the GH #59248-shape leftover; §19
// clause 2). Report-only: nothing here is ever deleted, archived, or flagged
// for auto-anything — a caller (a future P2 op) still needs a human/gated
// decision. A slug this function cannot read a cwd for is SKIPPED, never
// guessed into either bucket (a false "orphan" claim is worse than a missed
// one on an advisory-only report).
export function detectOrphanSlugs({ home = os.homedir() } = {}) {
  const base = claudeBaseDir(home);
  const claudeRoot = physicalOrNull(base);
  if (!claudeRoot) return [];
  const projectsDir = path.join(base, 'projects');
  let names;
  try { names = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }

  const orphans = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const slugDir = path.join(projectsDir, d.name);
    const phys = physicalOrNull(slugDir);
    if (!phys || !containedIn(phys, [claudeRoot])) continue; // fail-closed
    const cwd = sniffCwd(phys);
    if (!cwd || fs.existsSync(cwd)) continue; // no readable cwd, or the project is still there
    const bytes = [];
    walkDir(phys, 'other', [claudeRoot], bytes, ESTATE_FILE_CAP);
    orphans.push({ slug: d.name, cwd, path: phys, bytes: bytes.reduce((s, e) => s + e.bytes, 0) });
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// measurement + attribution + the heuristic advisory
// ---------------------------------------------------------------------------

// Total + per-type rollup. Byte figures are deterministic stats, not an
// estimate — label anything DERIVED from them (e.g. tokens) `~est`, never
// these.
export function measureEstate(entries) {
  const perType = {};
  let totalBytes = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const bytes = Number(e && e.bytes) || 0;
    totalBytes += bytes;
    const t = (e && e.type) || 'other';
    const bucket = perType[t] || (perType[t] = { files: 0, bytes: 0 });
    bucket.files++;
    bucket.bytes += bytes;
  }
  return { files: (entries && entries.length) || 0, totalBytes, perType };
}

// The first user turn's plain-text content, IF trivially present (a plain
// string `message.content`, not an array/tool-shaped turn) — a cheap,
// OPTIONAL legibility hint, never required, never blocking. Read-budget
// capped; a partial line at the budget boundary or any non-trivial shape
// degrades to null, exactly like every other sniff in this module.
function sniffTopic(filePath) {
  const head = readHead(filePath);
  if (!head) return null;
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj && obj.message && obj.message.content;
      if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 120);
    } catch { /* partial/truncated at the budget boundary — fall through to null */ }
    return null; // first user turn found but not trivially a string — stop, per spec ("else skip")
  }
  return null;
}

// Per-transcript ATTRIBUTION (§19's "legibility service", opaque-safe): a
// human label derived from what's KNOWABLE without trusting the filename —
// age from mtime, the deterministic byte size, and an optional topic hint.
// `topic` is real user prompt text — a caller folding this into any
// shared/aggregate artifact must keep it out, same as receipt.mjs's §9b
// "metrics only, never memory-content" discipline (estateReport below never
// surfaces it for exactly this reason).
export function attributeTranscript(entry, { now = Date.now() } = {}) {
  const mtimeMs = entry && Number(entry.mtimeMs);
  const ageDays = Number.isFinite(mtimeMs) ? Math.floor((now - mtimeMs) / 86400000) : null;
  const topic = entry && entry.type === 'transcript' && entry.path ? sniffTopic(entry.path) : null;
  return { path: entry && entry.path, bytes: entry && entry.bytes, ageDays, topic };
}

// HEURISTIC ~est reclaimable: bytes belonging to entries older than
// `horizonMs` (default RECLAIM_HORIZON_MS, CC's own retention default).
// Labeled `est:true` by the same convention as caliper's tokensEst — an
// advisory number for a FUTURE P2 op, never a mutation plan; this function
// does not touch a byte.
export function reclaimableEstimate(entries, { now = Date.now(), horizonMs = RECLAIM_HORIZON_MS } = {}) {
  let bytes = 0;
  let files = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const mtimeMs = e && Number(e.mtimeMs);
    if (!Number.isFinite(mtimeMs) || now - mtimeMs < horizonMs) continue;
    bytes += Number(e.bytes) || 0;
    files++;
  }
  return { bytes, files, horizonDays: Math.round(horizonMs / 86400000), est: true };
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

// board #55 AMENDMENT — a small derived horizon is informational, never a different formula
// (point 4 of the amendment). The threshold is a judgment call, declared here rather than an
// unexplained magic number in the report text.
const SMALL_HORIZON_WARN_DAYS = 3;

// Assemble the P1 report: a plain-text block + a one-line summary. READ-ONLY
// — like every export in this module, nothing here writes, deletes, or
// moves a byte; this is measure + attribute + advise, in full. Never
// includes per-transcript topic hints (see attributeTranscript's doc) — the
// aggregate report stays metrics-only.
//
// `priorKeyResolved` (board #55 AMENDMENT, ladder rung 6): whether cleanupPeriodDays resolved
// on the CALLER's last run — this module never persists it (zero-mutation invariant), so a
// caller with write access (cli.mjs's `estate` command) reads/writes the tiny marker and
// passes it in; omitted (the default, `null`) simply means transition detection does not fire
// for that call — an honest degrade, never a false signal.
export function estateReport({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now(), priorKeyResolved = null } = {}) {
  const entries = discoverEstateCC({ projectRoot, home });
  const measured = measureEstate(entries);
  const horizon = resolveEstateHorizon({ cwd: projectRoot, home, now, priorKeyResolved });
  const reclaim = reclaimableEstimate(entries, { now, horizonMs: horizon.horizonDays * 86400000 });
  const orphans = detectOrphanSlugs({ home });
  const orphanBytes = orphans.reduce((s, o) => s + (o.bytes || 0), 0);

  const lines = [];
  lines.push('[CoalWash] class-A estate (this project) — report-only, P1');
  lines.push(`  total: ${measured.files} file(s), ${fmtBytes(measured.totalBytes)}`);
  for (const type of Object.keys(measured.perType).sort()) {
    const v = measured.perType[type];
    lines.push(`    ${type}: ${v.files} file(s), ${fmtBytes(v.bytes)}`);
  }
  lines.push(`  ~est reclaimable (older than ${reclaim.horizonDays}d): ${reclaim.files} file(s), ~${fmtBytes(reclaim.bytes)}`);

  if (horizon.rung === 'nothing-establishable') {
    lines.push(`  horizon binding: cleanupPeriodDays could not be trusted this run (see the transition warning below) -> conservative horizon ${horizon.horizonDays}d`);
  } else {
    const overrideNote = horizon.floorApplied
      ? `, OBSERVED-FLOOR OVERRIDE — the platform's own oldest surviving transcript is ${horizon.observedFloorDays}d, below the settings value`
      : '';
    lines.push(`  horizon binding: cleanupPeriodDays=${horizon.cleanupPeriodDays}d (${horizon.rung}${horizon.file ? `, ${horizon.file}` : ''}${overrideNote}) -> reclaim horizon ${horizon.horizonDays}d`);
  }
  if (horizon.observedFloorDays !== null && !horizon.floorApplied) {
    lines.push(`  observed floor (informational): the oldest surviving transcript machine-wide is ${horizon.observedFloorDays}d old`);
  }
  if (horizon.horizonDays <= SMALL_HORIZON_WARN_DAYS) {
    lines.push(`  WARN: the derived reclaim horizon (${horizon.horizonDays}d) is small — sessions may read reclaimable soon after they go idle`);
  }
  for (const c of horizon.candidateKeys) {
    lines.push(`  NOTE: an unbound retention-shaped key was found and is NOT used — "${c.key}": ${JSON.stringify(c.value)} (${c.source})`);
  }
  if (horizon.transitionJustLost) {
    lines.push('  WARN: cleanupPeriodDays resolved on the prior run and does not resolve now — possible rename/removal; the estate horizon fell back to a conservative constant');
  }

  lines.push(orphans.length
    ? `  orphan slug dir(s), machine-wide: ${orphans.length}, ~${fmtBytes(orphanBytes)} (owning project no longer on disk — candidates, not confirmed)`
    : '  orphan slug dirs, machine-wide: none found');
  lines.push('  P1 = report-only; P2 (retention/archive) rides "claude project purge" + CoalWash\'s own bins, not built yet.');

  const summary = `[CoalWash] estate: ${fmtBytes(measured.totalBytes)} this project (${measured.files} files) · ~${fmtBytes(reclaim.bytes)} ~est reclaimable · ${orphans.length} orphan slug(s) machine-wide`;
  return { summary, text: lines.join('\n'), measured, reclaim, orphans, orphanBytes, horizon };
}
