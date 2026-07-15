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
import { claudeBaseDir } from './config-load.mjs';
import { ccProjectSlug, physicalOrNull, containedIn } from './class-b.mjs';

// Read-budget cap for the two OPTIONAL content sniffs below (topic hint +
// orphan cwd) — a multi-MB transcript is never read in full for either; both
// stop at this many bytes from the file's start.
const SNIFF_BUDGET_BYTES = 4096;
// Mirrors CC's own first-party `cleanupPeriodDays` default (verified live,
// COALWASH_BLUEPRINT.md §19 U1: 30 days, mtime-based) — an honest anchor
// borrowed from the platform's own retention convention, not an invented one.
export const RECLAIM_HORIZON_MS = 30 * 86400000;
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

// Assemble the P1 report: a plain-text block + a one-line summary. READ-ONLY
// — like every export in this module, nothing here writes, deletes, or
// moves a byte; this is measure + attribute + advise, in full. Never
// includes per-transcript topic hints (see attributeTranscript's doc) — the
// aggregate report stays metrics-only.
export function estateReport({ projectRoot = process.cwd(), home = os.homedir(), now = Date.now() } = {}) {
  const entries = discoverEstateCC({ projectRoot, home });
  const measured = measureEstate(entries);
  const reclaim = reclaimableEstimate(entries, { now });
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
  lines.push(orphans.length
    ? `  orphan slug dir(s), machine-wide: ${orphans.length}, ~${fmtBytes(orphanBytes)} (owning project no longer on disk — candidates, not confirmed)`
    : '  orphan slug dirs, machine-wide: none found');
  lines.push('  P1 = report-only; P2 (retention/archive) rides "claude project purge" + CoalWash\'s own bins, not built yet.');

  const summary = `[CoalWash] estate: ${fmtBytes(measured.totalBytes)} this project (${measured.files} files) · ~${fmtBytes(reclaim.bytes)} ~est reclaimable · ${orphans.length} orphan slug(s) machine-wide`;
  return { summary, text: lines.join('\n'), measured, reclaim, orphans, orphanBytes };
}
