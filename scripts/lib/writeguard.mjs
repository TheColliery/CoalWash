// writeguard.mjs — the WRITE-PATH SEATBELT + AIRBAG (ruling 0p). The gate
// follows the KNIFE: CoalWash's zero-fact-loss guarantee is enforced only on
// CW's own wash today, but the governance store is edited by every hand (main,
// subs, other tools) — "zero fact loss on CW's knife alone is HALF a
// constraint". Two advisory-grade nets for those OTHER hands:
//
//   AIRBAG (PreToolUse, snapshot-on-first-write) — MEMORY.md/CLAUDE.md are
//   gitignored = zero undo net when any agent misedits them. On the FIRST
//   write to a guarded file this session, ms-copy it once into
//   .claude/coalwash/writeguard/<session>/ (the existing sandbox root,
//   self-ignored) = the orig baseline. Subsequent writes to the same file
//   skip (already snapshotted). Write-only, no output.
//
//   SEATBELT (PostToolUse, advisory drop-detector) — after a guarded write,
//   diff {airbag-snapshot orig, current disk} through the wash's own
//   fidelity gate (gateFiles); on a structured-token drop, emit ONE advisory
//   line. ADVISORY ONLY — never blocks, never {decision:'block'} (a deliberate
//   delete/crystallize is legitimate; an ambient gate has no approvedDrops
//   channel, so blocking = sabotage). FP DECISION (0p prereq, option ii):
//   the advisory ALWAYS fires on any structured drop, FYI-framed + a snapshot
//   pointer — NO deliberate-vs-careless heuristic (which would misclassify);
//   an FP costs ONE ignorable line, never a blocked edit, and every fire is a
//   usable undo hint. Reaches subs natively (tool hooks fire in subs — proven
//   by the 0o spawn meter). Clean edits = silent (no per-edit output).
//
// PHOENIX: the cheap path-shape prefilter (isGuardedTarget) runs first, so
// near-all Edit/Write calls (source code, configs) skip FREE — no discovery
// walk EVER on the write path (unlike SessionStart's gauge), just one realpath
// + string checks. Fail-silent throughout (a guard failure must never block a
// write). 0h-GUARD untouched: writeguard is NOT a bin — no retention.mjs, no
// bin sweep; stale session dirs are cleaned run-gated at SessionStart (event,
// never a clock), keeping only the current session's.
//
// NAMED divergence (one-flock: name it where it lives): this module re-inlines
// txDir + the self-ignore drop rather than importing them from apply.mjs, to
// stay OFF apply.mjs's heavy WAL/bins/keeps import graph on the PreToolUse
// hot path (the airbag fires on every governance write). physicalOrNull/
// containedIn come from class-b.mjs (pure, light); gateFiles from
// fidelity-gate.mjs (zero-dep).
import fs from 'node:fs';
import path from 'node:path';
import { physicalOrNull, containedIn } from './class-b.mjs';
import { claudeBaseDir } from './config-load.mjs';
import { gateFiles } from './fidelity-gate.mjs';

// The root governance basenames, guarded anywhere in the trees. Memory-store
// and rules markdown are caught by the ".md under a .claude tree" clause below.
const GOV_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'MEMORY.md']);

// Birth certificate (0p perf prereq + the no-undeclared-default rule): the
// SEATBELT diff (gateFiles' inventory scans) scales with file size; over this
// cap the airbag still snapshots but the diff is SKIPPED (degrade to a
// "snapshot taken, diff skipped, oversize" note, never an inline scan of a
// pathological file). 256KB = the READ_BUDGET_BYTES scale already used on the
// gauge hot path; a governance file over it is pathological (CW's own whale
// measured 157KB in the estate-wash finding). Not measured-in-CI (the
// warp-gate lesson: a perf DECISION is recorded data, never a wall-clock
// assertion) — the STRUCTURAL claim (non-guarded path does zero work; oversize
// skips the diff) is what the hermetic tests pin.
export const SEATBELT_MAX_BYTES = 262144;

function txDir(projectRoot) { return path.join(projectRoot, '.claude', 'coalwash'); }
function writeguardRoot(projectRoot) { return path.join(txDir(projectRoot), 'writeguard'); }
function sanitizeSession(sessionId) {
  // Traversal-safe (the CoalMine session-id lesson): a hostile session_id like
  // '../../x' can never escape the writeguard root.
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'nosession';
}
function sessionDir(projectRoot, sessionId) {
  return path.join(writeguardRoot(projectRoot), sanitizeSession(sessionId));
}
// djb2 — a tiny deterministic hash so two distinct governance paths never
// collide on a snapshot filename (basename alone can; the hash disambiguates).
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function snapName(phys) {
  const base = path.basename(phys).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  return `${base}--${hash(phys)}`;
}
// Self-ignore (re-inlined, see the named divergence above): keep the snapshots
// out of VCS even when the project tracks .claude/. Best-effort, fail-silent.
function selfIgnore(dir) {
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (e) { if (e && e.code !== 'EEXIST') { /* read-only fs etc — ignore */ } }
}

// The cheap class-B shape prefilter + realpath-and-contain, fail-closed.
// Returns the guarded file's PHYSICAL path, or null (skip free). Honest
// ceiling (0l undercount-is-safe): covers the governance/memory-markdown
// shapes (the 4 live header-clobber incidents were all MEMORY/CLAUDE .md); a
// user's exotic custom @import living OUTSIDE a .claude tree with a
// non-governance basename is NOT caught by this cheap prefilter — the
// full-discovery version would be, at a per-edit budget we deliberately refuse
// to pay (unseen = unguarded = safe; the airbag/seatbelt are a best-effort
// net, not a correctness guarantee).
export function isGuardedTarget(touchedPath, { projectRoot, home } = {}) {
  if (typeof touchedPath !== 'string' || !touchedPath || !projectRoot) return null;
  const phys = physicalOrNull(touchedPath);
  if (!phys) return null; // unresolvable / missing -> fail-closed
  const base = claudeBaseDir(home);
  const roots = [physicalOrNull(home), physicalOrNull(projectRoot), physicalOrNull(base)].filter(Boolean);
  if (!roots.length || !containedIn(phys, roots)) return null; // realpath-and-contain, both sides physical
  // NEVER guard CW's OWN sandbox (snapshots / bins / writeguard / state) —
  // 0h-GUARD: the write guard must never operate on a bin, and snapshotting
  // our own snapshots would recurse. discoverClassB already excludes
  // .claude/coalwash/ from class-B; mirror that here.
  const tx = physicalOrNull(txDir(projectRoot)) || txDir(projectRoot);
  if (containedIn(phys, [tx])) return null;
  // Admit: a root governance basename anywhere, OR any markdown under a
  // .claude tree (global governance/rules + the per-project memory store).
  if (GOV_BASENAMES.has(path.basename(phys))) return phys;
  if (/\.md$/i.test(phys)) {
    const trees = [physicalOrNull(base), physicalOrNull(path.join(projectRoot, '.claude'))].filter(Boolean);
    if (containedIn(phys, trees)) return phys;
  }
  return null;
}

// AIRBAG — snapshot-on-FIRST-write per file per session. Returns the snapshot
// path (or the existing one), or null (not guarded / new file with no orig /
// guard failure). Fail-silent: the airbag's own failure never blocks the write.
export function snapshotOnFirstWrite(projectRoot, sessionId, touchedPath, { home } = {}) {
  try {
    const phys = isGuardedTarget(touchedPath, { projectRoot, home });
    if (!phys) return null;
    if (!fs.existsSync(phys)) return null; // a Write CREATING a new file: no orig to snapshot
    const dir = sessionDir(projectRoot, sessionId);
    const snap = path.join(dir, snapName(phys));
    if (fs.existsSync(snap)) return snap; // FIRST-write only — already snapshotted this session
    fs.mkdirSync(dir, { recursive: true });
    selfIgnore(txDir(projectRoot));
    selfIgnore(writeguardRoot(projectRoot));
    selfIgnore(dir);
    fs.copyFileSync(phys, snap); // the ms-copy
    return snap;
  } catch { return null; }
}

// Read the airbag baseline for the seatbelt's diff. Returns { phys,
// snapshotPath, orig } or null (no baseline — not guarded, new file, or the
// airbag was off/failed → the seatbelt stays silent).
export function readSnapshot(projectRoot, sessionId, touchedPath, { home } = {}) {
  try {
    const phys = isGuardedTarget(touchedPath, { projectRoot, home });
    if (!phys) return null;
    const snap = path.join(sessionDir(projectRoot, sessionId), snapName(phys));
    if (!fs.existsSync(snap)) return null;
    return { phys, snapshotPath: snap, orig: fs.readFileSync(snap, 'utf8') };
  } catch { return null; }
}

// SEATBELT — diff the airbag baseline against the current (post-edit) disk
// through the wash's fidelity gate. Returns:
//   null                                    — silent (not guarded / no baseline / clean edit)
//   { file, snapshotPath, oversize:true }   — snapshot stands, diff skipped (file over the cap)
//   { file, snapshotPath, classes:[...] }   — structured-token drop(s) detected (advise)
// A clean edit returns { classes: [] } which the caller treats as silent.
// READ-ONLY: reads the snapshot + the current disk, writes NOTHING.
export function seatbeltCheck(projectRoot, sessionId, touchedPath, { home } = {}) {
  const b = readSnapshot(projectRoot, sessionId, touchedPath, { home });
  if (!b) return null;
  let cur;
  try { cur = fs.readFileSync(b.phys, 'utf8'); } catch { return null; } // gone/unreadable -> silent
  if (Buffer.byteLength(b.orig, 'utf8') > SEATBELT_MAX_BYTES || Buffer.byteLength(cur, 'utf8') > SEATBELT_MAX_BYTES) {
    return { file: b.phys, snapshotPath: b.snapshotPath, oversize: true, classes: [] };
  }
  const { drops } = gateFiles([{ path: b.phys, orig: b.orig, next: cur }]);
  const classes = [...new Set(drops.map((d) => d.type))].sort();
  return { file: b.phys, snapshotPath: b.snapshotPath, oversize: false, classes };
}

// Bare-id allowlist (the F1 restore-door lesson: allowlist the shape, never
// segment-scan) — a snapshot name is a flat token; anything else is a plain
// not-found before a path is ever built.
function isBareId(id) {
  return typeof id === 'string' && !!id && id !== '.' && id !== '..' && path.basename(id) === id;
}

// PULL-ONLY listing — METADATA ONLY, never content (the 0p recovery-by-
// reference law): the agent POINTS at a snapshot by this metadata (name /
// session / bytes / mtime / original path), it never reproduces the bytes.
// Every writeguard snapshot currently on disk. Fail-silent -> [].
export function listWriteguard(projectRoot, { home: _home } = {}) {
  const out = [];
  try {
    const root = writeguardRoot(projectRoot);
    if (!fs.existsSync(root)) return out;
    for (const session of fs.readdirSync(root)) {
      const sdir = path.join(root, session);
      let st; try { st = fs.statSync(sdir); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const name of fs.readdirSync(sdir)) {
        if (name === '.gitignore') continue;
        try {
          const p = path.join(sdir, name);
          const fst = fs.statSync(p);
          if (fst.isFile()) out.push({ session, name, snapshotPath: p, bytes: fst.size, mtimeMs: fst.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* fail-silent */ }
  return out;
}

// Read ONE snapshot's ORIGINAL bytes by its bare snapName. THE RECOVERY DOOR
// (0p law, USER-reaffirmed "ต้องทำให้ ai ลงไปเก็บกู้ ห้ามเสกของใหม่เข้า"):
// CODE moves the bytes — they never pass through an agent's context; the AI
// only names WHICH snapshot, code copies the REAL bytes. An AI re-authoring a
// "recovery" from memory is the ADD-01 hallucination-twin (a fake that looks
// original); undo is trustworthy ONLY because the bytes are the real bytes,
// model-untouched. isBareId-contained (F1); searches every session dir and
// returns the NEWEST match (post-sweep only the current session survives, so a
// cross-session name collision is the exception). null on a non-bare id / miss.
export function readWriteguardSnapshot(projectRoot, snapName, { home } = {}) {
  if (!isBareId(snapName)) return null;
  const rows = listWriteguard(projectRoot, { home }).filter((r) => r.name === snapName);
  if (!rows.length) return null;
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const pick = rows[0];
  try { return { ...pick, content: fs.readFileSync(pick.snapshotPath, 'utf8') }; }
  catch { return null; }
}

// Run-gated cleanup (SessionStart, event-driven — NEVER a clock; 0h-GUARD
// spirit): drop every writeguard session dir except the current one. NOT a bin
// sweep, NOT retention.mjs — a plain keep-current-drop-prior fs cleanup, the
// same discipline as the spawn-meter's per-session counter reset. Fail-silent.
export function sweepWriteguard(projectRoot, currentSessionId, { home: _home } = {}) {
  try {
    const root = writeguardRoot(projectRoot);
    if (!fs.existsSync(root)) return;
    const keep = sanitizeSession(currentSessionId);
    for (const name of fs.readdirSync(root)) {
      if (name === keep || name === '.gitignore') continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* leftover waits for the next pass */ }
    }
  } catch { /* fail-silent */ }
}
