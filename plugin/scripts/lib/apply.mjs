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
import { checkFidelity } from './fidelity-gate.mjs';
import { claudeBaseDir } from './config-load.mjs';
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
function writeDurable(p, data) {
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function fsyncDirBestEffort(dir) {
  // POSIX: makes the rename itself durable. Windows: opening a dir fd throws —
  // best-effort by design (honest ceiling, documented above).
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}
// Atomic replace: write sibling .tmp -> fsync -> rename over target.
function atomicWrite(target, content) {
  const tmp = target + '.coalwash-tmp';
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
//   projectRoot: abs path (transaction dir + lock live under it),
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
// opts.home (def os.homedir()) — where globalLockPath resolves; override for
// hermetic tests, exactly like opts.txDir/opts.now/opts.keepSnapshots.
// Returns { ok, deferred?, error?, applied?, snapshotDir?, rolledBack?, flagged? }.
export function applyPlan(plan, opts = {}) {
  const now = opts.now || Date.now();
  const home = opts.home || os.homedir();
  try {
    // ---- validate shape (fail loud, nothing touched) ----
    if (!plan || typeof plan !== 'object') return { ok: false, error: 'plan must be an object' };
    const { projectRoot, roots, actions } = plan;
    if (!projectRoot || !Array.isArray(roots) || !roots.length) return { ok: false, error: 'plan needs projectRoot and non-empty roots[]' };
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
    let actionable = []; // let: the KEEPS-GATE below may exclude entries (per-file failure, the sniff pattern)
    for (const a of resolved) {
      if (a.type === 'create') { actionable.push(a); continue; }
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
        for (const p of createdPaths) { try { fs.rmSync(p, { force: true }); } catch {} }
        for (const a of actionable) { try { fs.rmSync(a.phys + '.coalwash-tmp', { force: true }); } catch {} }
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
        if (failed) return { ok: false, rolledBack: 'partial', restoreFailures: failed, error: `apply failed AND ${failed} original(s) could not be restored — memory may be mixed; snapshot kept at ${snapDir}: ${e.message}` };
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

      return { ok: true, applied: actionable.length, snapshotDir: snapDir, flagged };
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
    // path). Re-validate every target against the roots the transaction RECORDED,
    // realpath-and-contain both sides, fail-closed. A journal without recorded roots
    // (pre-v-this or tampered) can't be validated -> refuse, leave for a human.
    const jroots = Array.isArray(journal.roots) ? journal.roots.map((r) => physicalOrNull(r)).filter(Boolean) : [];
    if (!jroots.length) {
      return { recovered: 'none', error: 'journal has no verifiable roots — refusing to replay (left for inspection)' };
    }
    const snapPhys = physicalOrNull(snapDir);
    const inSnap = (p) => { const q = physicalOrNull(p); return q && snapPhys && containedIn(q, [snapPhys]); };
    const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'));
    let restored = 0, failed = 0, refused = 0;
    for (const m of manifest) {
      const src = path.join(snapDir, m.snap);
      const origPhys = physicalOrNull(m.original);
      // src must sit inside the snapshot dir; target must sit inside a recorded root.
      if (!inSnap(src) || !origPhys || !containedIn(origPhys, jroots)) { refused++; continue; }
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
        if (!p || !containedIn(p, jroots)) { refused++; continue; } // exists but out-of-root = refuse
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
