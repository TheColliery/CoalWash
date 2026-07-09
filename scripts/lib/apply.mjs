// apply.mjs — the all-or-nothing transactional apply (blueprint §14.5 + §14.11,
// gap #3): snapshot-marker -> write .tmp -> fsync -> atomic rename -> verify ->
// deletes LAST -> commit; ANY failure restores the snapshot wholesale. The
// strongest honest guarantee: the worst realistic outcome of ANY crash is "the
// run did not happen", NEVER "memory is corrupted" — nothing mutates until a
// complete, marked snapshot exists on disk.
//
// Prior-art shape: WAL + atomic-rename (git ref updates, SQLite, dpkg) — ported,
// not invented. Honest ceiling: fsync is not stronger than the drive's write
// cache (the SQLite/Postgres caveat); the snapshot is the last backstop. On
// Windows, directory fsync is unsupported -> best-effort (wrapped, non-fatal).
//
// Safety gates enforced IN CODE here (they do not depend on agent diligence):
//   - realpath-and-contain BOTH sides on EVERY touched path; fail-closed
//     (an unresolvable or escaping path aborts before anything mutates).
//   - deletes execute ONLY with plan.deletesApproved === true (the OUTER human
//     gate sets that flag; this engine never prompts and never assumes).
//   - a `pinned: true` frontmatter file refuses delete AND rewrite (gap #1 PIN).
//   - .coalwash.lock: atomic-create + session-id + stale-timeout;
//     defer-on-doubt (an unreadable or fresh foreign lock = held -> defer).
//   - content is written VERBATIM as UTF-8 (no BOM added, no re-encoding, no
//     normalization) — the engine can never decompose Thai U+0E33 or alter
//     line endings; what the caller passed is byte-for-byte what lands.
//
// This is a user-invoked engine module (CLI discipline: fail LOUD via the
// returned result object), NOT a Phoenix hook — but it still never throws
// across the API boundary; every path returns { ok, ... }.
import fs from 'node:fs';
import path from 'node:path';
import { checkFidelity } from './fidelity-gate.mjs';

export const LOCK_STALE_MS = 30 * 60 * 1000; // a lock older than 30min is presumed dead
export const KEEP_SNAPSHOTS = 3; // post-success snapshot dirs retained (backup §7.6)
const JOURNAL_NAME = 'journal.json'; // CoalHearth-visible WAL location: <project>/.claude/coalwash/journal.json
const LOCK_NAME = '.coalwash.lock';
const SNAP_MARKER = 'snap.complete';

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
function ensureSelfIgnore(dir) {
  try {
    const p = path.join(dir, '.gitignore');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '*\n');
  } catch {}
}

// plan = {
//   projectRoot: abs path (transaction dir + lock live under it),
//   roots: [abs...]            — the declared class-B roots writes may touch,
//   actions: [{ type: 'rewrite'|'create'|'delete', path, content? }],
//   deletesApproved: bool      — the OUTER human gate's flag; false blocks deletes,
//   sessionId?: string,
// }
// Returns { ok, deferred?, error?, applied?, snapshotDir?, rolledBack? }.
export function applyPlan(plan, opts = {}) {
  const now = opts.now || Date.now();
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

    // ---- code-enforced outer gates ----
    const deletes = resolved.filter((a) => a.type === 'delete');
    if (deletes.length && plan.deletesApproved !== true) {
      return { ok: false, error: `deletes not approved (human gate): ${deletes.map((d) => d.phys).join(', ')}` };
    }
    const pinned = resolved.filter((a) => a.type !== 'create' && isPinned(a.phys));
    if (pinned.length) {
      return { ok: false, error: `PIN-protected (pinned: true) — refuse to touch: ${pinned.map((p) => p.phys).join(', ')}` };
    }

    // ---- FIDELITY INTERLOCK (the flagship gate, code-enforced at the mutation
    // boundary — not merely a pipeline step a caller could skip). Every rewrite
    // is diffed original-vs-new; a structured-token drop (link/date/version/
    // frontmatter key) or introduced encoding corruption ABORTS before anything
    // mutates, UNLESS the human approved that exact drop (plan.approvedDrops, a
    // list of "type:value"). No approvedDrops => strict: any drop aborts.
    const approvedDrops = new Set(Array.isArray(plan.approvedDrops) ? plan.approvedDrops : []);
    const unapproved = [];
    for (const a of resolved) {
      if (a.type !== 'rewrite') continue;
      let orig;
      try { orig = fs.readFileSync(a.phys, 'utf8'); } catch { return { ok: false, error: `fidelity: cannot read ${a.phys} to gate it (fail-closed)` }; }
      for (const d of checkFidelity(orig, a.content).drops) {
        if (!approvedDrops.has(`${d.type}:${d.value}`)) unapproved.push(`${a.phys} — ${d.type}: ${d.value}`);
      }
    }
    if (unapproved.length) {
      return { ok: false, error: `fidelity: unapproved fact drop(s) — apply blocked (approve them explicitly or fix the rewrite): ${unapproved.join(' | ')}` };
    }

    // ---- lock ----
    const txDir = opts.txDir || txDirFor(projectRoot);
    fs.mkdirSync(txDir, { recursive: true });
    ensureSelfIgnore(txDir);
    const lock = acquireLock(path.join(txDir, LOCK_NAME), { sessionId: plan.sessionId, now });
    if (!lock.acquired) return { ok: false, deferred: true, error: lock.reason };

    const journalPath = path.join(txDir, JOURNAL_NAME);
    const snapDir = path.join(txDir, `snap-${now}`);
    const writeJournal = (j) => { writeDurable(journalPath, JSON.stringify(j, null, 2)); };

    try {
      // ---- snapshot BEFORE the first mutation, then the completion marker ----
      fs.mkdirSync(snapDir, { recursive: true });
      const manifest = [];
      let n = 0;
      for (const a of resolved) {
        if (a.type === 'create') continue; // nothing to snapshot
        const snapName = `f${n++}`;
        fs.copyFileSync(a.phys, path.join(snapDir, snapName));
        const fd = fs.openSync(path.join(snapDir, snapName), 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        manifest.push({ snap: snapName, original: a.phys });
      }
      writeDurable(path.join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      writeDurable(path.join(snapDir, SNAP_MARKER), String(now));
      fsyncDirBestEffort(snapDir);

      // ---- WAL: the ordered plan; creates+rewrites first, deletes LAST ----
      const ordered = [
        ...resolved.filter((a) => a.type !== 'delete'),
        ...resolved.filter((a) => a.type === 'delete'),
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
        for (const a of resolved) { try { fs.rmSync(a.phys + '.coalwash-tmp', { force: true }); } catch {} }
        // A PARTIAL rollback must NOT be marked terminal-clean, or a cold-start
        // recoverDangling would clear the journal over a mixed on-disk state.
        journal.status = failed ? 'rollback-failed' : 'rolled-back';
        try { writeJournal(journal); } catch {}
        return failed;
      };

      try {
        for (const step of journal.steps) {
          const a = ordered[step.i];
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

      return { ok: true, applied: resolved.length, snapshotDir: snapDir };
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, error: `apply: ${e.message}` };
  }
}

// Keep the newest `keep` snapshot dirs, remove older ones (zero-garbage without
// discarding the recent backup).
export function sweepSnapshots(txDir, keep = KEEP_SNAPSHOTS) {
  try {
    const snaps = fs.readdirSync(txDir)
      .filter((n) => /^snap-\d+$/.test(n))
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
