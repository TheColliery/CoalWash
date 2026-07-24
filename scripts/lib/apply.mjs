// apply.mjs — the all-or-nothing transactional apply (blueprint §14.5 + §14.11,
// gap #3): snapshot-marker -> write .tmp -> fsync -> atomic rename -> verify ->
// deletes LAST -> commit; a step failure rolls back from the snapshot. The
// strongest honest guarantee: nothing mutates until a complete, marked snapshot
// exists on disk, so the worst outcome of a crash BEFORE that marker is "the run
// did not happen". Honest ceiling (do not over-claim): if the ROLLBACK's own
// restore fails (e.g. the disk filled), the store can be left MIXED — that case
// is reported as rolledBack:'partial'/'rollback-failed', the journal + snapshot
// are KEPT as the backstop, and a cold-start recovery re-attempts rather than
// clearing over it. So: "wholesale on the common path; partial-and-flagged, with
// the snapshot retained, when a restore itself fails" — never a silent mixed state.
//
// Prior-art shape: WAL + atomic-rename (git ref updates, SQLite, dpkg) — ported,
// not invented. Honest ceiling: fsync is not stronger than the drive's write
// cache (the SQLite/Postgres caveat); the snapshot is the last backstop. On
// Windows, directory fsync is unsupported -> best-effort (wrapped, non-fatal).
//
// Safety gates enforced IN CODE here (they do not depend on agent diligence):
//   - realpath-and-contain BOTH sides on EVERY touched path; fail-closed
//     (an unresolvable or escaping path aborts before anything mutates).
//   - deletes/merges execute when the PLAN carries them — authorization is
//     PLAN-SOURCED (the adjudicated plan IS the authorization; no separate
//     approval flag); safety instead lives in UNDO: a verified snapshot
//     before the first mutation and a whole-run rollback on any failure.
//   - a `pinned: true` frontmatter file refuses delete AND rewrite (gap #1 PIN).
//   - .coalwash.lock: atomic-create + session-id + stale-timeout;
//     defer-on-doubt (an unreadable or fresh foreign lock = held -> defer).
//   - content is written VERBATIM as UTF-8 (no BOM added, no re-encoding, no
//     normalization) — the engine can never decompose Thai U+0E33 or alter
//     line endings; what the caller passed is byte-for-byte what lands.
//   - external-writer guard (the WHS KB946676 stale-commit / cloud-sync
//     co-writer class): every rewrite/delete target is re-read immediately
//     before its mutation and byte-compared against the plan's recorded
//     baseline; a mismatch aborts the whole txn via rollback, naming the file.
//   - snapshot restorability verify (the GitLab all-backups-dead class): every
//     snapshot copy is read back and byte-compared BEFORE the completion
//     marker lands or any destructive step runs.
//   - binary/unparseable sniff (the e2defrag rewrite-what-you-can't-parse
//     class): a NUL-bearing or frontmatter-unclosable rewrite target is
//     FLAGGED and excluded, never rewritten; the run continues on the rest.
//   - own-artifact retention (the ReFS thin-pool leak class): stale completed
//     snapshots are swept at preflight; a dangling txn's snapshot is NEVER
//     swept (recovery owns it).
//   - KEEPS-GATE (beta.12, the r3 "laundering channel" close): an adjudicated
//     keep carrying an anchor (keeps.mjs, project + global stores) binds the
//     EXECUTOR mechanically — a plan action that would erase the anchor from
//     its file is excluded pre-mutation (the file stays untouched) and named,
//     model-independently.
//
// This is a user-invoked engine module (CLI discipline: fail LOUD via the
// returned result object), NOT a Phoenix hook — but it still never throws
// across the API boundary; every path returns { ok, ... }.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkFidelity, inventoryDropKeys } from './fidelity-gate.mjs';
// findProjectRoot: the room's ONE trusted-anchor idiom (cli.mjs/recoverDangling
// derive projectRoot from cwd through it, never from untrusted plan/journal data).
import { claudeBaseDir, findProjectRoot } from './config-load.mjs';
// #57(d): the ONE cloud-placeholder read-poison sniff, shared with the estate
// WARM path (one helper, called at both trust points — not a second copy). A
// pure read-only metadata stat; apply keeps its OWN physicalOrNull/containedIn
// (security-audit locality), but this stub-sniff is imported to stay single-source.
import { isCloudPlaceholder, ccMemoryDir } from './class-b.mjs';
// NOTE a deliberate module cycle: keeps.mjs imports txDirFor/ensureSelfIgnore
// from THIS file. Both sides bind function declarations used only at CALL
// time, so ESM resolves the cycle safely regardless of entry order. bins.mjs
// forms the SAME shape of cycle (it imports txDirFor/ensureSelfIgnore from
// here; this file imports sweepFatBin/sweepStoreOld from there) — identical
// reasoning, identical safety.
import { loadKeepsAt, KEEPS_NAME, globalKeepsPath } from './keeps.mjs';
// beta.12 item 4: the two bins' retention sweep (fat-bin 30d / store.old 60d,
// retention.mjs's pure policy; 0i adds the store-proportional size cap)
// piggybacks on this SAME preflight touchpoint — a sibling housekeeping call
// to sweepSnapshots below, same fail-silent discipline (a bin failure must
// never block the wash it runs alongside). 0h: recordBinItem is fed from the
// COMMIT below — applyPlan is the one choke-point every cut flows through
// (Quick/Force/wizard all apply through here), so wiring it here wires every
// cut site at once.
import { sweepFatBin, sweepStoreOld, recordBinItem, FAT_BIN_NAME, STORE_OLD_NAME } from './bins.mjs';
// 0i V2: the bins' size budget is a multiple of the MEASURED STORE — read
// from the session gauge's cached verdict (caliper state; zero new I/O
// beyond one small state read). caliper imports only config-load/jsonc, so
// this adds no module cycle.
import { loadState } from './caliper.mjs';
// Wikilink-orphan advisory (the git filter-branch cross-reference lesson):
// ONE reference-detection implementation, shared with RE-TIER — never
// duplicated. NOTE the same deliberate module-cycle shape as keeps.mjs/
// bins.mjs above (retier.mjs imports applyPlan from THIS file): both sides
// bind function declarations used only at CALL time, so ESM resolves the
// cycle safely — identical reasoning, identical safety.
import { unreferencedTopics } from './retier.mjs';

export const LOCK_STALE_MS = 30 * 60 * 1000; // a lock older than 30min is presumed dead
export const KEEP_SNAPSHOTS = 3; // post-success snapshot dirs retained (backup §7.6)
const JOURNAL_NAME = 'journal.json'; // CoalHearth-visible WAL location: <project>/.claude/coalwash/journal.json
const LOCK_NAME = '.coalwash.lock';
const GLOBAL_LOCK_NAME = '.coalwash-global.lock'; // the global-slice lock, at the ~/.claude root (an inert engine primitive; task #13 moved only the per-project state + update stamp, not this lock)
const SNAP_MARKER = 'snap.complete';

// A target whose files live in the user home's GLOBAL class-B (the global
// CLAUDE.md closure — class-b.mjs's own scope:'global') additionally locks
// HERE, beside the global state file — a per-project lock alone cannot see
// TWO DIFFERENT projects both mutating the same global file (design-pass item,
// MEMORY.md "THE SHARED GLOBAL SLICE").
export function globalLockPath(home = os.homedir()) {
  return path.join(claudeBaseDir(home), GLOBAL_LOCK_NAME);
}

// ---------------------------------------------------------------------------
// small durable-write helpers
// ---------------------------------------------------------------------------
// Exported so estate-archive.mjs reuses the SAME durability primitive (H4 —
// flock-canonical strength, not a second copy). NOTE the module cycle it forms
// (estate-archive -> apply -> retier -> estate-archive): both are function
// DECLARATIONS bound at CALL time, so ESM resolves it safely — identical
// reasoning to the keeps/bins/retier cycles documented in the header.
export function writeDurable(p, data) {
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function fsyncDirBestEffort(dir) {
  // POSIX: makes the rename itself durable. Windows: opening a dir fd throws —
  // best-effort by design (honest ceiling, documented above).
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}
// Atomic replace: write sibling .tmp -> fsync -> rename over target.
// #57 FILESYSTEM-SEMANTICS-ASSUMPTION (MASTER-LOSS-TAXONOMY): rename is atomic
// ONLY within one directory on one filesystem — cross-device it throws EXDEV
// (the Claude Code #32533 class). tmp derives from target, so same-dir holds
// by construction; the assert keeps the invariant EXPLICIT against a future
// edit pointing tmp at os.tmpdir(). An EXDEV (or any rename failure) surfaces
// to applyPlan's step catch -> whole-run rollback, which also sweeps the
// `.coalwash-tmp` sibling — fail-closed, target untouched, no stranded tmp.
function atomicWrite(target, content) {
  const tmp = target + '.coalwash-tmp';
  if (path.dirname(tmp) !== path.dirname(target)) {
    throw new Error(`atomicWrite invariant: tmp must be a same-directory sibling of ${target}`);
  }
  writeDurable(tmp, content);
  fs.renameSync(tmp, target);
  fsyncDirBestEffort(path.dirname(target));
}

// 0h: what a rewrite CUT — the lines present in the gated original and
// absent from the rewritten text (blank lines skipped; set-membership, so a
// merely MOVED line is not "removed"). Line granularity is deliberate: the
// Quick rules are line-structural and the wizard shrink drops wording by the
// line; the byte-perfect whole-store undo stays the snapshot's job — the bin
// is the browsable per-item graveyard, not a second snapshot.
function removedLines(origText, newText) {
  const next = new Set(String(newText).split(/\r?\n/));
  return String(origText).split(/\r?\n/).filter((l) => l.trim() && !next.has(l));
}

// ---------------------------------------------------------------------------
// wikilink-orphan advisory (post-apply, NEVER a block) — the git
// filter-branch cross-reference lesson: RE-TIER's unreferencedTopics() keeps
// a still-referenced topic in the tree, but the ordinary Quick/Full plan path
// had no equivalent — a plan could delete a topic some SURVIVING file still
// points at ([[wikilink]] / name mention) with no signal. A deliberate delete
// is legitimate, so this only earns ONE advisory line on the receipt.
// ---------------------------------------------------------------------------
const DEADLINK_FILE_CAP = 2000; // defensive walk bound; hitting it only under-reports (advisory-safe)

// Surviving .md files under the plan's own roots. The tx dir subtree is
// excluded — its snapshots/bins CONTAIN the deleted bytes and would mark
// every delete "still referenced". Bounded, fail-silent per entry.
function collectMdFiles(root, txPhys, out) {
  if (out.length >= DEADLINK_FILE_CAP) return;
  let st = null;
  try { st = fs.statSync(root); } catch { return; }
  if (st.isFile()) { if (/\.md$/i.test(root)) out.push(root); return; }
  if (!st.isDirectory()) return;
  if (txPhys && physicalOrNull(root) === txPhys) return; // never read our own snapshots/bins
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (out.length >= DEADLINK_FILE_CAP) return;
    const p = path.join(root, d.name);
    if (d.isDirectory()) collectMdFiles(p, txPhys, out);
    else if (d.isFile() && /\.md$/i.test(d.name)) out.push(p);
  }
}

// Basenames of deleted .md topics that surviving files still reference.
// Reuses RE-TIER's reference test VERBATIM: a deleted topic modeled with
// EMPTY own-text is "unreferenced" iff no survivor mentions its basename or
// stem; everything NOT unreferenced is still pointed at -> the advisory set.
function deadLinkScan(actionable, physRoots, txDir) {
  const deleted = actionable.filter((a) => a.type === 'delete' && /\.md$/i.test(a.phys));
  if (!deleted.length) return [];
  const txPhys = physicalOrNull(txDir);
  const files = [];
  for (const root of physRoots) collectMdFiles(root, txPhys, files);
  if (!files.length) return [];
  const surviving = files
    .map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })
    .join('\n');
  const topics = deleted.map((a) => ({ path: a.phys, basename: path.basename(a.phys), text: '', mtimeMs: 0 }));
  const unref = new Set(unreferencedTopics({ topics }, surviving).map((t) => t.path));
  return topics.filter((t) => !unref.has(t.path)).map((t) => t.basename);
}

// The ONE advisory line (program-built; a caller places it on the receipt
// verbatim). null when there is nothing to say — silence is the norm.
export function deadLinkLine(deadLinks) {
  if (!Array.isArray(deadLinks) || !deadLinks.length) return null;
  const head = deadLinks.slice(0, 5).join(', ');
  return `advisory: ${deadLinks.length} deleted topic(s) still referenced by surviving files (possible dead [[link]]s): ${head}${deadLinks.length > 5 ? ', …' : ''} — a deliberate delete is fine; recovery door: cli.mjs restore <id>`;
}

function physicalOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}
function containedIn(p, roots) {
  if (!p) return false;
  for (const root of roots) {
    if (!root) continue;
    const rel = path.relative(root, p);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// Flag-not-rewrite sniff (ports e2defrag's rewrite-what-you-can't-parse; the
// NUL-sniff mirrors CoalLedger beta.5's doc-unreadable guard, flock-canonical):
// a NUL byte marks binary/undecodable content; an opening frontmatter fence
// that never closes marks a file our frontmatter tooling cannot faithfully
// parse. Either way the REWRITE is refused (flagged to the caller) — deletes
// are not sniffed, they stay behind the stricter pinned + containment gates
// (delete authorization itself is plan-sourced, below; UNDO is the safety net).
export function sniffUnrewritable(buf) {
  if (buf.includes(0)) return 'binary content (NUL byte) — flagged, not rewritten';
  const s = buf.toString('utf8');
  if (/^---\r?\n/.test(s) && !/\r?\n---[ \t]*(?:\r?\n|$)/.test(s.slice(3))) {
    return 'frontmatter opens but never closes (unparseable) — flagged, not rewritten';
  }
  return null;
}

// pinned: true in a leading frontmatter block = PIN-protected (gap #1) —
// immune to trim/delete. FAIL-CLOSED: any state we cannot verify counts as
// pinned (refuse to touch), matching the realpath/containment fail-closed
// discipline — "untouchable at all" must not degrade to fail-open on a read
// error or a frontmatter block we could not fully read.
const PIN_READ_BYTES = 65536; // covers any sane frontmatter; a block that does not close within this = unverifiable
export function isPinned(file) {
  try {
    const fd = fs.openSync(file, 'r');
    let head;
    try {
      const buf = Buffer.alloc(PIN_READ_BYTES);
      const n = fs.readSync(fd, buf, 0, PIN_READ_BYTES, 0);
      head = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
    if (!/^---\r?\n/.test(head)) return false; // no frontmatter opener = definitely not pinned
    const end = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(head.slice(3));
    // The opener exists but the block does not CLOSE within the window (a huge or
    // truncated frontmatter) -> unverifiable -> fail-closed (treat as pinned).
    if (!end) return true;
    const block = head.slice(3, 3 + end.index);
    return /^pinned\s*:\s*true\s*$/m.test(block);
  } catch {
    return true; // read error on a file we are about to mutate -> refuse (fail-closed)
  }
}

// ---------------------------------------------------------------------------
// lock — atomic-create + session-id + stale-timeout + defer-on-doubt
// ---------------------------------------------------------------------------
// NAMED ASSUMPTION (#57 FILESYSTEM-SEMANTICS): O_EXCL ('wx') exclusive-create
// is atomic on a LOCAL filesystem; a network/cloud-synced mount (NFS, sync
// clients) may break that exclusivity — the SVN BDB-on-NFS lesson. The cheap
// conservative belt: EVERY acquire (fresh and stale-steal alike) re-reads the
// lock after writing and must find its OWN token — a foreign token means the
// "win" was a lost race a broken O_EXCL let through -> defer (fail-closed;
// the stale-steal path already did this, the fresh path now matches). No
// mount-detection is attempted (over-harden).
// A per-acquire owner TOKEN so the release and the stale-takeover can prove
// ownership (never delete a lock another run now holds). hrtime.bigint() is a
// monotonic counter (not wall-clock) — distinct on every call, so two acquires
// in one process never collide; two processes differ by pid.
function ownerToken(sessionId) {
  return `${sessionId}:${process.pid}:${process.hrtime.bigint()}`;
}
function readLockToken(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')).token ?? null; } catch { return null; }
}
export function acquireLock(lockPath, { sessionId = String(process.pid), staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  const token = ownerToken(sessionId);
  const body = JSON.stringify({ sessionId, pid: process.pid, at: now, token });
  // release deletes the lock ONLY if it still carries OUR token (a slow/suspended
  // holder whose lock was stolen must not delete the new holder's lock — HIGH #4).
  const releaseIfOwner = () => { try { if (readLockToken(lockPath) === token) fs.rmSync(lockPath, { force: true }); } catch {} };
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    ensureSelfIgnore(path.dirname(lockPath));
    const fd = fs.openSync(lockPath, 'wx'); // atomic create: exactly one fresh acquirer wins
    try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // compare-after-write (the header's named-assumption belt): a foreign
    // token on re-read = O_EXCL did not actually exclude us -> defer.
    if (readLockToken(lockPath) !== token) return { acquired: false, reason: 'exclusive-create acquire lost a race (non-local filesystem?) — deferring' };
    return { acquired: true, release: releaseIfOwner };
  } catch (e) {
    if (e && e.code !== 'EEXIST') return { acquired: false, reason: `lock error: ${e.message}` };
  }
  // Lock exists — stale takeover ONLY when demonstrably old; any doubt = defer.
  try {
    const st = fs.statSync(lockPath);
    if (now - st.mtimeMs > staleMs) {
      // STEAL IN PLACE (no rm -> no missing-file window a third writer could slip
      // through). Two racing stealers overwrite the same file; whoever's write
      // lands last owns it, the other's compare-after-write fails -> it defers
      // (worst case both defer on a byte-interleave = a safe retry, never a
      // double-hold). Fixed width via truncate so a shorter write leaves no tail.
      const fd = fs.openSync(lockPath, 'r+');
      try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, body, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (readLockToken(lockPath) === token) return { acquired: true, stale: true, release: releaseIfOwner };
      return { acquired: false, reason: 'stale-lock takeover lost a race — deferring' };
    }
  } catch { /* unreadable lock = doubt = defer */ }
  return { acquired: false, reason: 'another CoalWash run (or a live session) holds the store — deferring' };
}

// ---------------------------------------------------------------------------
// the transaction
// ---------------------------------------------------------------------------
export function txDirFor(projectRoot) {
  return path.join(projectRoot, '.claude', 'coalwash');
}

// The tx dir self-ignores: a `.gitignore` containing `*` INSIDE it keeps the
// journal/snapshots (memory-content copies) out of version control even when
// the user's project tracks `.claude/` — code-enforced, not a doc promise.
// Best-effort (fail-silent): a read-only fs must never block the transaction.
export function ensureSelfIgnore(dir) {
  // Exclusive create (no exists-then-write TOCTOU): two racing writers both try
  // 'wx'; one wins, the other gets EEXIST — both harmless (the content is
  // identical). Any other error is swallowed (best-effort, must never block a tx).
  try { fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (e) { if (e && e.code !== 'EEXIST') { /* read-only fs etc — ignore */ } }
}

// plan = {
//   projectRoot: IGNORED — the transaction dir + lock + the containment trust
//     anchor come from the CALLER (opts.projectRoot, else findProjectRoot(cwd)),
//     NEVER this field (untrusted plan data; see the derivation in applyPlan). A
//     caller may still set it for documentation, but the engine does not read it.
//   roots: [abs...]            — the declared class-B roots writes may touch,
//   actions: [{ type: 'rewrite'|'create'|'delete', path, content?, expectedOrig?, scope? }],
//     expectedOrig (optional, rewrite/delete): the content the caller SCANNED
//     and gated against. When provided, the external-writer guard compares the
//     live file against it — covering the whole scan -> apply window,
//     including any wait before the mutation (a cloud-sync clobber during
//     that wait is caught). When absent, the baseline is the content staged
//     at applyPlan time (the intra-transaction window only).
//     scope (optional, 'global'|'project', def 'project'): 'global' means this
//     target lives in the user home's global class-B (e.g. the global
//     CLAUDE.md closure) — the transaction ALSO takes a lock beside the global
//     state file (globalLockPath) so two DIFFERENT projects' runs can never
//     interleave writes to the same global file, which a per-project lock
//     alone cannot see.
//   sessionId?: string,
//   origin?: 'program-cut'|'wizard-cut' (def 'program-cut') — 0h bin routing:
//     which graveyard this plan's cuts land in. Program cuts (Quick/Force
//     structural rules) ride the default -> FAT bin; a WIZARD-tier plan
//     (deletes, shrink rewrites) declares 'wizard-cut' -> the wizard bin
//     (store.old). Anything else folds to 'program-cut' (recordBinItem's own
//     rule — garbage never persists).
// }
// Delete/merge authorization is PLAN-SOURCED, not a separate flag: a delete
// action present in actions[] is authorized by having come from the
// adjudicated plan (the insider-adjudication step) — same trust boundary as
// `approvedDrops` below. There is no `deletesApproved` field to set; UNDO
// (snapshot + whole-run rollback) is the safety net instead of pre-approval.
// opts.projectRoot — the CALLER-TRUSTED project root (the containment anchor +
//   tx-dir/bins/state home). A trusted caller (cli.mjs, runRetier) passes its
//   cwd-derived findProjectRoot value here; when absent, applyPlan derives it from
//   opts.cwd || process.cwd(). This is the ONE channel that can widen containment,
//   so it must never be sourced from the (untrusted) plan.
// opts.cwd (def process.cwd()) — only feeds the findProjectRoot fallback above.
// opts.home (def os.homedir()) — where globalLockPath resolves; override for
// hermetic tests, exactly like opts.txDir/opts.now/opts.keepSnapshots.
// Returns { ok, deferred?, error?, applied?, snapshotDir?, rolledBack?, flagged? }.
export function applyPlan(plan, opts = {}) {
  const now = opts.now || Date.now();
  const home = opts.home || os.homedir();
  try {
    // ---- validate shape (fail loud, nothing touched) ----
    if (!plan || typeof plan !== 'object') return { ok: false, error: 'plan must be an object' };
    const { roots, actions } = plan;
    // THE TRUST ANCHOR is the CALLER's projectRoot, NEVER plan.projectRoot. The
    // plan is untrusted (method.md §4 runs `applyPlan(JSON.parse(PLAN.json))`),
    // so a forged plan's projectRoot is attacker-chosen — anchoring containment on
    // it is circular ONE LEVEL UP: the plan supplies BOTH the victim path AND the
    // "projectRoot" that would contain it, so the check always passes (the live
    // A1/A2 escape). Source it exactly as recoverDangling/cli.mjs do — the trusted
    // caller root via opts.projectRoot, or, absent that, findProjectRoot(cwd): the
    // agent's REAL working dir, which a forged PLAN.json cannot move. plan.projectRoot
    // is IGNORED; a forged one is then caught below because its declared roots will
    // not sit inside the real trusted set (the fail-closed the containment gate gives).
    const projectRoot = opts.projectRoot || findProjectRoot(opts.cwd || process.cwd(), home);
    // SECURITY — DERIVED-ANCHOR HOME-SWALLOW GUARD (untrusted-plan path only). When
    // the anchor is DERIVED (no trusted opts.projectRoot), findProjectRoot can collapse
    // it to home: cwd=home with no marker (returns home), OR a non-git cwd under a home
    // that itself carries ~/.git (versioned dotfiles) — the walk climbs past the
    // unmarked project to the ~/.git marker and returns home. A home-level anchor puts
    // ~ ITSELF into trustedRoots below, so the containment gate faithfully authorizes a
    // forged roots:[home] to delete ~/.ssh AND inject a hook into ~/.claude/settings.json
    // => code execution next session. Refuse fail-closed when the DERIVED anchor SWALLOWS
    // home (is home, or an ancestor of home) — realpath BOTH sides, the room's own
    // containedIn (home inside anchor === anchor contains home). A trusted opts.projectRoot
    // is the caller's own anchor and stays UNCHECKED (runRetier/cli.mjs). A derived anchor
    // BELOW home (a real project dir, git or not) stays ALLOWED — a forged roots:[home]
    // then escapes it and the gate refuses as before, blast bounded to the project +
    // snapshot-backed; non-git users keep working (no-external-assumption).
    if (!opts.projectRoot) {
      const anchorPhys = physicalOrNull(projectRoot);
      const homePhys = physicalOrNull(home);
      if (!anchorPhys || !homePhys || containedIn(homePhys, [anchorPhys])) {
        return { ok: false, error: `containment: the derived project anchor (${anchorPhys || projectRoot}) is the home directory or an ancestor of it — refusing fail-closed (a home-level anchor would authorize writes anywhere under ~, e.g. ~/.ssh or ~/.claude/settings.json); run from the actual project dir, or pass a trusted opts.projectRoot` };
      }
    }
    if (!Array.isArray(roots) || !roots.length) return { ok: false, error: 'plan needs non-empty roots[]' };
    if (!Array.isArray(actions) || !actions.length) return { ok: false, error: 'plan needs non-empty actions[]' };
    for (const a of actions) {
      if (!a || !['rewrite', 'create', 'delete'].includes(a.type)) return { ok: false, error: `unknown action type: ${a && a.type}` };
      if (!a.path || !path.isAbsolute(a.path)) return { ok: false, error: `action path must be absolute: ${a && a.path}` };
      if ((a.type === 'rewrite' || a.type === 'create') && typeof a.content !== 'string') return { ok: false, error: `${a.type} needs string content: ${a.path}` };
      if (a.expectedOrig !== undefined && typeof a.expectedOrig !== 'string') return { ok: false, error: `expectedOrig must be a string when provided: ${a.path}` };
    }

    // ---- containment: realpath-and-contain BOTH sides, fail-closed ----
    const physRoots = roots.map((r) => physicalOrNull(r)).filter(Boolean);
    if (physRoots.length !== roots.length) return { ok: false, error: 'containment: a declared root does not resolve (fail-closed)' };
    // THE TRUSTED OUTER GATE (parity with recoverDangling's C1/H1 close below):
    // plan.roots is part of the SAME plan as the actions, so anchoring containment
    // on plan.roots ALONE is CIRCULAR — a forged/injected plan supplies BOTH the
    // target AND the roots that "contain" it, and the check always passes. Anchor
    // on the CALLER-TRUSTED roots a plan cannot widen: the `projectRoot` resolved
    // ABOVE (opts.projectRoot or findProjectRoot(cwd) — NEVER plan.projectRoot, which
    // would re-open the circularity one level up) + the ONLY global-physical store
    // CoalWash washes today, ccMemoryDir — the SAME set recoverDangling uses, so the
    // two paths stay symmetric. plan.roots stays a
    // SECONDARY narrowing: a plan may restrict to a SUBSET of the trusted roots,
    // never widen beyond them; a declared root outside the trusted set fails
    // closed. ponytail: when the PENDING global-GOVERNANCE wash driver ships
    // (MEMORY "Global lock/keeps DRIVER"), add those SPECIFIC roots here too,
    // exactly as recoverDangling's trustedRoots note says — never claudeBaseDir
    // wholesale (that would let a poisoned plan target ~/.claude/settings.json).
    const trustedRoots = [physicalOrNull(projectRoot), physicalOrNull(ccMemoryDir(projectRoot, home))].filter(Boolean);
    if (!trustedRoots.length) return { ok: false, error: 'containment: no trusted root resolves (fail-closed)' };
    for (const r of physRoots) {
      if (!containedIn(r, trustedRoots)) return { ok: false, error: `containment: declared root ${r} escapes the caller-trusted roots (projectRoot + global class-B) — fail-closed refuse` };
    }
    const resolved = [];
    for (const a of actions) {
      let phys;
      if (a.type === 'create') {
        if (fs.existsSync(a.path)) return { ok: false, error: `create target already exists: ${a.path}` };
        const parent = physicalOrNull(path.dirname(a.path));
        if (!parent || !containedIn(parent, physRoots)) return { ok: false, error: `containment: ${a.path} escapes declared roots (fail-closed)` };
        phys = path.join(parent, path.basename(a.path));
      } else {
        phys = physicalOrNull(a.path);
        if (!phys || !containedIn(phys, physRoots)) return { ok: false, error: `containment: ${a.path} escapes declared roots (fail-closed)` };
      }
      resolved.push({ ...a, phys });
    }

    // ---- staging read + content sniff ----
    // Each rewrite/delete target is read ONCE as raw bytes here — the shared
    // baseline for the fidelity gate and the external-writer compare below. A
    // rewrite target that sniffs binary/unparseable is FLAGGED and excluded
    // (never rewritten — the e2defrag lesson); the run continues on the rest.
    const flagged = [];
    const isPlaceholder = opts.isPlaceholder || isCloudPlaceholder; // injectable for tests
    let actionable = []; // let: the KEEPS-GATE below may exclude entries (per-file failure, the sniff pattern)
    for (const a of resolved) {
      if (a.type === 'create') { actionable.push(a); continue; }
      // #57(d) cloud-placeholder read poison: sniff the dehydrated stub from
      // METADATA BEFORE the staging read trusts its bytes. A rewrite over a
      // placeholder writes a truncated body that clobbers the real content when
      // the file hydrates + syncs up — fail-closed (flag + skip, file untouched),
      // the estate WARM path's sibling guard (never a content read).
      if (a.type === 'rewrite' && isPlaceholder(a.phys)) {
        flagged.push({ path: a.phys, reason: 'cloud placeholder (dehydrated — 0 blocks, size>0): a plain read returns a stub, rewriting would clobber the real content on hydration — flagged, not rewritten (#57d)' });
        continue;
      }
      let origBuf;
      try { origBuf = fs.readFileSync(a.phys); } catch { return { ok: false, error: `cannot read ${a.phys} to stage it (fail-closed)` }; }
      if (a.type === 'rewrite') {
        const why = sniffUnrewritable(origBuf);
        if (why) { flagged.push({ path: a.phys, reason: why }); continue; }
      }
      // External-writer baseline: the caller's scan-time content when provided
      // (covers any wait before the mutation), else the bytes staged just now.
      actionable.push({ ...a, origBuf, baseBuf: typeof a.expectedOrig === 'string' ? Buffer.from(a.expectedOrig, 'utf8') : origBuf });
    }
    if (!actionable.length) {
      return { ok: false, flagged, error: `every action was flagged as un-rewritable — nothing applied: ${flagged.map((f) => f.path).join(', ')}` };
    }

    // ---- code-enforced outer gates ----
    // Delete/merge authorization is PLAN-SOURCED: a delete action reaching
    // here already passed shape-validation + containment above (and, for the
    // rewrite/create side of a merge, the fidelity gate below) — it is in
    // actions[] because the adjudicated plan put it there, and that IS the
    // authorization (no separate approval flag to check). UNDO — the
    // snapshot + whole-run rollback below — is where safety lives instead.
    const pinned = actionable.filter((a) => a.type !== 'create' && isPinned(a.phys));
    if (pinned.length) {
      return { ok: false, error: `PIN-protected (pinned: true) — refuse to touch: ${pinned.map((p) => p.phys).join(', ')}` };
    }

    // ---- KEEPS-GATE (beta.12 — closes the r3 "laundering channel": an
    // adjudication-level keep did not bind the executor's cuts). Every keep
    // carrying an enforcement handle (anchor + anchorFile; project AND global
    // stores) whose file this plan rewrites or deletes must still be present
    // — exact substring, or whitespace-normalized — in the transaction's
    // post-edit content (any rewrite/create content counts, so an anchor a
    // merge legitimately MOVES to its target file passes). A violating action
    // is EXCLUDED pre-mutation with a named reason: the file's on-disk state
    // IS the restored state (same end-state as write-then-restore-from-
    // snapshot, minus the mutation window), and the rest of the plan proceeds
    // (per-file failure, the sniffUnrewritable pattern). Keeps without the
    // handle (the pre-beta.12 {target, reason, date} shape) stay advisory —
    // zero behavior change for existing stores.
    const txDir = opts.txDir || txDirFor(projectRoot);
    {
      const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
      const foldPath = (p) => {
        const phys = physicalOrNull(p) || path.resolve(String(p));
        return process.platform === 'win32' ? phys.toLowerCase() : phys;
      };
      let keeps = [];
      try {
        keeps = [...loadKeepsAt(path.join(txDir, KEEPS_NAME)), ...loadKeepsAt(globalKeepsPath(home))]
          .filter((k) => typeof k.anchor === 'string' && k.anchor && typeof k.anchorFile === 'string' && k.anchorFile);
      } catch { keeps = []; } // an unreadable keeps ledger must never block an apply (it is the shield, not the gate's subject)
      // Fixpoint: excluding one violating action can remove the very text that
      // satisfied ANOTHER keep (an anchor "migrated" into a now-excluded
      // rewrite) — re-check until stable. Each pass strictly shrinks
      // `actionable`, so this terminates in <= actions.length passes.
      while (keeps.length) {
        const postTexts = actionable.filter((a) => a.type !== 'delete').map((a) => a.content);
        const normTexts = postTexts.map(norm);
        const survives = (anchor) => postTexts.some((t) => t.includes(anchor)) || normTexts.some((t) => t.includes(norm(anchor)));
        const excluded = new Set();
        for (const k of keeps) {
          const kf = foldPath(k.anchorFile);
          for (const a of actionable) {
            if (a.type === 'create' || excluded.has(a)) continue; // a create is never "the keep's file"
            if (foldPath(a.phys) !== kf) continue;
            if (survives(k.anchor)) continue;
            excluded.add(a);
            // 80 chars = display truncation only (keeps the flag line one-line
            // readable); the full anchor stays in keeps.json, nothing decided on it.
            const snip = k.anchor.length > 80 ? `${k.anchor.slice(0, 77)}...` : k.anchor;
            flagged.push({
              path: a.phys,
              reason: `keep enforcement: adjudicated keep "${snip}" (${k.date || 'undated'}${k.reason ? ` — ${k.reason}` : ''}) is missing from the plan's post-edit content — ${a.type} excluded, file left untouched; fix the rewrite or re-adjudicate the keep`,
            });
          }
        }
        if (!excluded.size) break;
        actionable = actionable.filter((a) => !excluded.has(a));
      }
      if (!actionable.length) {
        return { ok: false, flagged, error: `every action was excluded (unrewritable or keep-protected) — nothing applied: ${flagged.map((f) => f.path).join(', ')}` };
      }
    }

    // ---- FIDELITY INTERLOCK (the flagship gate, code-enforced at the mutation
    // boundary — not merely a pipeline step a caller could skip). Every rewrite
    // is diffed original-vs-new; a structured-token drop (link/date/version/
    // frontmatter key) or introduced encoding corruption ABORTS before anything
    // mutates, UNLESS the human approved that exact drop (plan.approvedDrops, a
    // list of "type:value"). No approvedDrops => strict: any drop aborts.
    // The gate baseline = expectedOrig when provided (the content the rewrite
    // was DERIVED from), else the staged bytes — the same baseline the
    // external-writer compare enforces at mutation time.
    const approvedDrops = new Set(Array.isArray(plan.approvedDrops) ? plan.approvedDrops : []);
    const unapproved = [];
    for (const a of actionable) {
      if (a.type !== 'rewrite') continue;
      const orig = typeof a.expectedOrig === 'string' ? a.expectedOrig : a.origBuf.toString('utf8');
      for (const d of checkFidelity(orig, a.content).drops) {
        if (!approvedDrops.has(`${d.type}:${d.value}`)) unapproved.push(`${a.phys} — ${d.type}: ${d.value}${d.survivor ? ` (survives only as ${d.survivor})` : ''}`);
      }
    }
    // H3: a DELETE (or a merge = delete-src + rewrite-dst) also drops the removed
    // file's structured tokens — the rewrite loop above never sees them, so a
    // merge could silently drop a link/number a rewrite would block. Account for
    // them at the SAME boundary: a deleted token is OK iff it SURVIVES in the
    // transaction's post-edit content (a same-tx merge kept it) OR is named in
    // approvedDrops (the caller declared the drop — its own external safety, e.g.
    // RE-TIER's archive+probe or a fold-merge's untouched twin, owns recovery).
    // Otherwise it is exactly the silent structured-token loss the gate claims to
    // block. (Snapshot/bins still back recovery; this closes the GATE hole.)
    const postEditKeys = inventoryDropKeys(actionable.filter((a) => a.type !== 'delete').map((a) => a.content).join('\n'));
    for (const a of actionable) {
      if (a.type !== 'delete') continue;
      const del = typeof a.expectedOrig === 'string' ? a.expectedOrig : a.origBuf.toString('utf8');
      for (const key of inventoryDropKeys(del)) {
        if (postEditKeys.has(key) || approvedDrops.has(key)) continue;
        unapproved.push(`${a.phys} (delete) — ${key.replace(':', ': ')}`);
      }
    }
    if (unapproved.length) {
      return { ok: false, error: `fidelity: unapproved fact drop(s) — apply blocked (approve them explicitly or fix the rewrite): ${unapproved.join(' | ')}` };
    }

    // ---- lock(s) — GLOBAL first, only when a declared action touches
    // global-scope class-B (see the plan-shape comment above) ----
    const touchesGlobal = actions.some((a) => a && a.scope === 'global');
    let globalLock = null;
    if (touchesGlobal) {
      globalLock = acquireLock(globalLockPath(home), { sessionId: plan.sessionId, now });
      if (!globalLock.acquired) return { ok: false, deferred: true, error: `global scope: ${globalLock.reason}` };
    }
    fs.mkdirSync(txDir, { recursive: true }); // txDir resolved once, above the KEEPS-GATE
    ensureSelfIgnore(txDir);
    const lock = acquireLock(path.join(txDir, LOCK_NAME), { sessionId: plan.sessionId, now });
    if (!lock.acquired) {
      if (globalLock) globalLock.release();
      return { ok: false, deferred: true, error: lock.reason };
    }

    const journalPath = path.join(txDir, JOURNAL_NAME);
    const snapDir = path.join(txDir, `snap-${now}`);
    const writeJournal = (j) => { writeDurable(journalPath, JSON.stringify(j, null, 2)); };

    try {
      // ---- own-artifact retention at preflight (ports the ReFS thin-pool
      // leak: maintenance that allocates but never releases). Aborted/deferred
      // runs leave snapshot dirs the commit-time sweep never reaches; reap
      // them here, inside the lock. Fail-silent housekeeping; sweepSnapshots
      // itself protects a dangling txn's snapshot (recovery owns it).
      sweepSnapshots(txDir, opts.keepSnapshots == null ? KEEP_SNAPSHOTS : opts.keepSnapshots);
      // ---- bin retention (beta.12 item 4; 0i adds the size cap) — the SAME
      // piggyback touchpoint: every real wash run is a natural,
      // already-existing place to age out bin items past their horizon AND
      // to bind the store-proportional size budget (0h-GUARD: this preflight
      // is the ONLY sweep site — run-gated, never a clock). storeBytes =
      // the session gauge's cached measurement (0i V2 — the store, never the
      // disk); a project never gauged (no cached verdict) sweeps
      // horizon-only, the keep-on-doubt direction. Both sweeps are already
      // internally fail-silent (never throw) — no extra guard needed here.
      let storeBytes = 0;
      try { storeBytes = Number(loadState(projectRoot, home)?.lastVerdict?.alwaysLoadedBytes) || 0; } catch { /* horizon-only */ }
      sweepFatBin(projectRoot, { storeBytes });
      sweepStoreOld(projectRoot, { storeBytes });

      // ---- snapshot BEFORE the first mutation, then the completion marker ----
      fs.mkdirSync(snapDir, { recursive: true });
      const manifest = [];
      let n = 0;
      for (const a of actionable) {
        if (a.type === 'create') continue; // nothing to snapshot
        const snapName = `f${n++}`;
        fs.copyFileSync(a.phys, path.join(snapDir, snapName));
        const fd = fs.openSync(path.join(snapDir, snapName), 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        manifest.push({ snap: snapName, original: a.phys });
      }
      writeDurable(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      // ---- snapshot restorability verify (ports the GitLab all-backups-dead
      // incident): prove every copy restores what is on disk RIGHT NOW, before
      // the completion marker lands and before any destructive step. The
      // marker therefore means "complete AND verified" — recovery never trusts
      // an unverified snapshot. Verify failure aborts while "nothing has
      // happened yet" is still true.
      const badSnaps = verifySnapshot(snapDir, manifest);
      if (badSnaps.length) {
        try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch {}
        return { ok: false, flagged, error: `snapshot verify failed — refusing to proceed before any change: ${badSnaps.join('; ')}` };
      }
      writeDurable(path.join(snapDir, SNAP_MARKER), String(now));
      fsyncDirBestEffort(snapDir);

      // ---- WAL: the ordered plan; creates+rewrites first, deletes LAST ----
      const ordered = [
        ...actionable.filter((a) => a.type !== 'delete'),
        ...actionable.filter((a) => a.type === 'delete'),
      ];
      const journal = {
        version: 1,
        sessionId: plan.sessionId || null,
        startedAt: now,
        snapDir,
        // The RESOLVED physical roots this transaction was allowed to touch —
        // recorded so a cold-start recoverDangling can RE-VALIDATE containment
        // (a poisoned journal must not aim a restore/delete outside these).
        roots: physRoots,
        status: 'applying',
        steps: ordered.map((a, i) => ({ i, type: a.type, path: a.phys, status: 'pending' })),
      };
      writeJournal(journal);

      // ---- execute ----
      const createdPaths = [];
      // Returns the count of snapshot restores that FAILED — a non-zero count
      // means the rollback was PARTIAL (some originals could not be restored),
      // which the caller must surface honestly instead of claiming "wholesale".
      const rollback = () => {
        let failed = 0;
        for (const m of manifest) {
          try { fs.copyFileSync(path.join(snapDir, m.snap), m.original); } catch { failed++; /* keep restoring the rest */ }
        }
        // A created file (or a stranded .coalwash-tmp sibling) the rollback CANNOT
        // remove LINGERS in the store = a mixed state, exactly like a failed
        // snapshot restore — count it (EPERM/EBUSY: AV or cloud-sync holding a
        // no-FILE_SHARE_DELETE handle, the win32 hazard) so the status below is
        // honestly rollback-failed, never a clean rolledBack:true over a lingering
        // file. force:true never throws on a missing target, so a throw here means
        // a real removal failure; the existsSync belt counts it ONLY if it lingers.
        for (const p of createdPaths) { try { fs.rmSync(p, { force: true }); } catch { if (fs.existsSync(p)) failed++; } }
        for (const a of actionable) { const tmp = a.phys + '.coalwash-tmp'; try { fs.rmSync(tmp, { force: true }); } catch { if (fs.existsSync(tmp)) failed++; } }
        // A PARTIAL rollback must NOT be marked terminal-clean, or a cold-start
        // recoverDangling would clear the journal over a mixed on-disk state.
        journal.status = failed ? 'rollback-failed' : 'rolled-back';
        try { writeJournal(journal); } catch {}
        return failed;
      };

      try {
        for (const step of journal.steps) {
          const a = ordered[step.i];
          // ---- external-writer guard (ports the WHS KB946676 stale-commit /
          // dedup-co-writer class + the owner's live cloud-sync hazard):
          // re-read the target immediately before mutating it; bytes no longer
          // matching the plan's recorded baseline = a foreign writer
          // interleaved -> abort the whole txn (the rollback below restores
          // the snapshot, so nothing of this plan is left half-applied). A
          // target that can no longer be read counts as foreign interference.
          if (a.type === 'rewrite' || a.type === 'delete') {
            let cur = null;
            try { cur = fs.readFileSync(a.phys); } catch { /* handled below */ }
            if (!cur || Buffer.compare(cur, a.baseBuf) !== 0) {
              throw new Error(`external writer detected: ${a.phys} changed after the plan was gated — aborting the transaction`);
            }
          } else if (fs.existsSync(a.phys)) {
            // create target appeared mid-txn: same foreign-writer class.
            throw new Error(`external writer detected: create target ${a.phys} appeared mid-transaction`);
          }
          if (a.type === 'rewrite' || a.type === 'create') {
            atomicWrite(a.phys, a.content);
            if (a.type === 'create') createdPaths.push(a.phys);
            // verify: what landed is byte-for-byte what the plan said (blueprint step 3 "verify")
            const back = fs.readFileSync(a.phys);
            if (Buffer.compare(back, Buffer.from(a.content, 'utf8')) !== 0) {
              throw new Error(`post-write verify mismatch: ${a.phys}`);
            }
          } else {
            fs.rmSync(a.phys); // deletes run LAST by construction (ordering above)
            fsyncDirBestEffort(path.dirname(a.phys));
          }
          step.status = 'done';
          writeJournal(journal);
        }
      } catch (e) {
        const failed = rollback();
        if (failed) return { ok: false, rolledBack: 'partial', restoreFailures: failed, error: `apply failed AND rollback left ${failed} item(s) in a mixed state (an original that could not be restored, a created file that could not be removed, or a stranded tmp) — memory may be mixed; snapshot kept at ${snapDir}: ${e.message}` };
        return { ok: false, rolledBack: true, error: `apply failed at a step — snapshot restored: ${e.message}` };
      }

      // ---- commit: mark, clear the WAL, sweep old snapshots (keep the newest N) ----
      journal.status = 'committed';
      writeJournal(journal);
      try { fs.rmSync(journalPath, { force: true }); } catch {}
      sweepSnapshots(txDir, opts.keepSnapshots == null ? KEEP_SNAPSHOTS : opts.keepSnapshots);

      // ---- bin population (0h "BIN POPULATION WIRING") — AFTER the commit,
      // so only cuts that actually LANDED are recorded (a rolled-back run cut
      // nothing; the catch above returns before reaching here). Routing per
      // plan.origin: program cuts (Quick/Force, the default) -> FAT bin;
      // wizard cuts (deletes + shrink wording) -> the wizard bin (store.old).
      // Content = the gated baseline (baseBuf — what the plan was derived
      // from AND byte-verified on disk at mutation time by the external-
      // writer guard): a delete banks the whole file, a rewrite banks its
      // removed lines (nothing removed = nothing banked). recordBinItem is
      // fail-silent by contract — a stash failure never un-commits the run.
      const binName = plan.origin === 'wizard-cut' ? STORE_OLD_NAME : FAT_BIN_NAME;
      const binOrigin = plan.origin === 'wizard-cut' ? 'wizard-cut' : 'program-cut';
      for (const a of actionable) {
        if (a.type === 'create') continue; // an addition cut nothing
        const orig = a.baseBuf.toString('utf8');
        const cut = a.type === 'delete' ? orig : removedLines(orig, a.content).join('\n');
        if (!cut) continue;
        recordBinItem(projectRoot, binName, { content: cut, original: a.phys, origin: binOrigin, now });
      }

      // ---- wikilink-orphan advisory (post-commit, advisory ONLY — see the
      // helper block above). Fail-silent: an advisory failure never
      // un-commits the run; the fields just stay empty.
      let deadLinks = [];
      try { deadLinks = deadLinkScan(actionable, physRoots, txDir); } catch { /* advisory only */ }

      return { ok: true, applied: actionable.length, snapshotDir: snapDir, flagged, deadLinks, deadLinkLine: deadLinkLine(deadLinks) };
    } finally {
      lock.release();
      if (globalLock) globalLock.release();
    }
  } catch (e) {
    return { ok: false, error: `apply: ${e.message}` };
  }
}

// Snapshot restorability verify (the GitLab all-backups-dead port): read each
// copy back and byte-compare it against a FRESH read of its source. Compares
// against disk-now (not the staged baseline) so this isolates COPY corruption;
// a foreign write is the external-writer guard's job and gets ITS label.
// Returns [] when every copy restores faithfully, else the failures.
export function verifySnapshot(snapDir, manifest) {
  const bad = [];
  for (const m of manifest) {
    try {
      const snapBuf = fs.readFileSync(path.join(snapDir, m.snap));
      const srcBuf = fs.readFileSync(m.original);
      if (Buffer.compare(snapBuf, srcBuf) !== 0) bad.push(`${m.original} (copy does not match source)`);
    } catch (e) {
      bad.push(`${m.original} (unverifiable: ${e.message})`);
    }
  }
  return bad;
}

// Keep the newest `keep` snapshot dirs, remove older ones (zero-garbage without
// discarding the recent backup). Retention NEVER reaps the snapshot a
// dangling/incomplete txn still references — recovery owns it (the ReFS
// thin-pool port's one hard rule). Fail direction: an unreadable or
// newer-schema journal freezes the whole sweep — keeping too much is safe,
// deleting a needed restore source is not.
export function sweepSnapshots(txDir, keep = KEEP_SNAPSHOTS) {
  try {
    let protect = null;
    const jp = path.join(txDir, JOURNAL_NAME);
    if (fs.existsSync(jp)) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { /* unreadable -> freeze below */ }
      if (!j || typeof j !== 'object' || Number(j.version) > 1) return; // cannot know what it references -> sweep nothing
      if (j.status !== 'committed' && j.status !== 'rolled-back') protect = path.basename(String(j.snapDir || ''));
    }
    const snaps = fs.readdirSync(txDir)
      .filter((n) => /^snap-\d+$/.test(n) && n !== protect)
      .sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    for (const old of snaps.slice(Math.max(0, keep))) {
      fs.rmSync(path.join(txDir, old), { recursive: true, force: true });
    }
  } catch { /* sweep is housekeeping — never fatal */ }
}

// Cold-start recovery (CoalHearth's SessionStart — or the next CW run — calls
// this): a dangling 'applying' journal with a complete snapshot rolls back
// wholesale; without the snap marker nothing was ever mutated (first mutation
// happens only after the marker exists) so the journal is just cleared.
// Returns { recovered: 'rolled-back'|'no-mutation'|'cleaned'|'none', restored? }.
export function recoverDangling(projectRoot, opts = {}) {
  try {
    const home = opts.home || os.homedir();
    const txDir = opts.txDir || txDirFor(projectRoot);
    const journalPath = path.join(txDir, JOURNAL_NAME);
    if (!fs.existsSync(journalPath)) return { recovered: 'none' };
    let journal;
    try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch {
      // an unreadable journal with NO readable snapDir cannot be replayed —
      // fail-closed: leave it for a human (never guess at memory state).
      return { recovered: 'none', error: 'journal unreadable — left in place for inspection' };
    }
    // Artifact schema-version (ports XP-deletes-Vista-restore-points): a
    // journal from a NEWER CoalWash schema is untouchable to this older code —
    // refuse recovery AND refuse cleanup (we cannot know what either would
    // destroy). Checked BEFORE the terminal-status branch on purpose: an older
    // tool must not even delete a newer tool's "terminal-looking" journal.
    if (journal && typeof journal === 'object' && Number(journal.version) > 1) {
      return { recovered: 'none', error: `journal schema version ${journal.version} is newer than this CoalWash understands — left untouched (for a newer version, or a human)` };
    }
    if (journal.status === 'committed' || journal.status === 'rolled-back') {
      fs.rmSync(journalPath, { force: true });
      return { recovered: 'cleaned' };
    }
    const snapDir = journal.snapDir;
    const marker = snapDir && fs.existsSync(path.join(snapDir, SNAP_MARKER));
    if (!marker) {
      // no complete snapshot => the first mutation never happened
      fs.rmSync(journalPath, { force: true });
      return { recovered: 'no-mutation' };
    }
    // CONTAINMENT (the journal is UNTRUSTED — a poisoned .claude/coalwash/journal.json
    // shipped inside a repo must not aim a restore/delete at an arbitrary absolute
    // path). A journal without recorded roots (pre-v-this or tampered) can't be
    // validated -> refuse, leave for a human.
    const jroots = Array.isArray(journal.roots) ? journal.roots.map((r) => physicalOrNull(r)).filter(Boolean) : [];
    if (!jroots.length) {
      return { recovered: 'none', error: 'journal has no verifiable roots — refusing to replay (left for inspection)' };
    }
    // THE TRUSTED OUTER GATE (C1/H1): journal.roots is attacker-controlled, so
    // anchoring containment on jroots ALONE is CIRCULAR — a poisoned journal
    // supplies both the target AND the roots that "contain" it, and the check
    // always passes. Gate every restore/delete on CALLER-TRUSTED roots the
    // journal cannot widen. The PRECISE legit set (NOT the whole ~/.claude — that
    // would still let a poisoned journal target ~/.claude/settings.json =
    // hook/permission injection):
    //   - projectRoot            — every project-scope store (project MEMORY.md,
    //                              .claude/agent-memory/<role>/, CW's own tx dir);
    //   - ccMemoryDir(...)       — the ONLY global-physical store CoalWash washes
    //                              today: ~/.claude/projects/<slug>/memory (the
    //                              'main' store in runRetier's collectStores — the
    //                              sole applyPlan caller in the engine).
    // ponytail: when the PENDING global-GOVERNANCE wash driver ships (washes the
    // global CLAUDE.md closure + ~/.claude/rules — MEMORY "Global lock/keeps
    // DRIVER"), add those SPECIFIC roots here, never claudeBaseDir wholesale.
    // jroots stays a SECONDARY narrowing; the trusted gate is the one a tamperer
    // cannot move. Fail-closed if neither trusted root resolves.
    const trustedRoots = [physicalOrNull(projectRoot), physicalOrNull(ccMemoryDir(projectRoot, home))].filter(Boolean);
    if (!trustedRoots.length) {
      return { recovered: 'none', error: 'no trusted root resolves — refusing to replay (fail-closed)' };
    }
    const snapPhys = physicalOrNull(snapDir);
    const inSnap = (p) => { const q = physicalOrNull(p); return q && snapPhys && containedIn(q, [snapPhys]); };
    const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
    let restored = 0, failed = 0, refused = 0;
    for (const m of manifest) {
      const src = path.join(snapDir, m.snap);
      const origPhys = physicalOrNull(m.original);
      // src must sit inside the snapshot dir; target must sit inside a
      // CALLER-TRUSTED root (the outer gate a poisoned journal can't widen) AND
      // the journal's own declared roots (secondary narrowing).
      if (!inSnap(src) || !origPhys || !containedIn(origPhys, trustedRoots) || !containedIn(origPhys, jroots)) { refused++; continue; }
      try { fs.copyFileSync(src, m.original); restored++; } catch { failed++; /* restore the rest */ }
    }
    // creates the interrupted run added are removed — REGARDLESS of the journal's
    // step.status. A crash BETWEEN atomicWrite and the writeJournal that would
    // stamp the step 'done' leaves the durable step 'pending' while the file
    // exists (HIGH #3); rmSync(force) is a safe no-op if it was never written, so
    // removing every create in a dangling txn cannot orphan one.
    for (const step of journal.steps || []) {
      if (step.type === 'create') {
        if (!fs.existsSync(step.path)) continue; // never written (or already gone) = nothing to undo
        const p = physicalOrNull(step.path);
        if (!p || !containedIn(p, trustedRoots) || !containedIn(p, jroots)) { refused++; continue; } // exists but out-of-(trusted∩journal)-root = refuse
        try { fs.rmSync(step.path, { force: true }); } catch {}
      }
    }
    // Only clear the WAL when the recovery was CLEAN. A partial/refused replay keeps
    // the journal + snapshot for a human (never report a mixed state as done).
    if (failed || refused) {
      return { recovered: 'partial', restored, restoreFailures: failed, refusedOutOfRoot: refused, error: `recovery incomplete — ${failed} restore failure(s), ${refused} target(s) refused as out-of-root; journal + snapshot kept at ${snapDir}` };
    }
    fs.rmSync(journalPath, { force: true });
    return { recovered: 'rolled-back', restored };
  } catch (e) {
    return { recovered: 'none', error: e.message };
  }
}
