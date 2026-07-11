import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, recoverDangling, acquireLock, sweepSnapshots, isPinned, txDirFor, LOCK_STALE_MS, verifySnapshot, sniffUnrewritable, globalLockPath } from './apply.mjs';
import { recordKeep, recordGlobalKeep } from './keeps.mjs';
import { FAT_BIN_NAME, recordBinItem, listBin } from './bins.mjs';
import { HORIZON_MS } from './retention.mjs';

function sandbox() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-proj-')));
  const store = path.join(proj, 'memory');
  fs.mkdirSync(store, { recursive: true });
  return { proj, store };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function planFor(proj, store, actions, extra = {}) {
  return { projectRoot: proj, roots: [store], actions, sessionId: 't-session', ...extra };
}

test('happy path: rewrite + create + approved delete, all-or-nothing artifacts correct', () => {
  const { proj, store } = sandbox();
  try {
    const f1 = path.join(store, 'f1.md');
    const f2 = path.join(store, 'f2.md');
    const f3 = path.join(store, 'f3.md');
    write(f1, 'original one');
    write(f2, 'to be deleted');
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: f1, content: 'rewritten one' },
      { type: 'delete', path: f2 },
      { type: 'create', path: f3, content: 'brand new' },
    ])); // no deletesApproved anywhere — the delete's presence in the plan IS its authorization
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.applied, 3);
    assert.strictEqual(fs.readFileSync(f1, 'utf8'), 'rewritten one');
    assert.strictEqual(fs.existsSync(f2), false);
    assert.strictEqual(fs.readFileSync(f3, 'utf8'), 'brand new');
    // snapshot kept (the backup), WAL cleared, lock released
    assert.ok(fs.existsSync(path.join(r.snapshotDir, 'snap.complete')));
    assert.ok(fs.existsSync(path.join(r.snapshotDir, 'manifest.json')));
    const txDir = txDirFor(proj);
    assert.strictEqual(fs.existsSync(path.join(txDir, 'journal.json')), false, 'WAL cleared on commit');
    assert.strictEqual(fs.existsSync(path.join(txDir, '.coalwash.lock')), false, 'lock released');
  } finally { clean(proj); }
});

test('content lands VERBATIM: UTF-8, no BOM added, CRLF and Thai U+0E33 preserved byte-for-byte', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'thai.md');
    write(f, 'old');
    const SARA_AM = String.fromCharCode(0x0e33);
    const content = '\tline one\r\n\tThai ' + String.fromCharCode(0x0e08) + SARA_AM + ' kept\r\n';
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content }]));
    assert.strictEqual(r.ok, true, r.error);
    const bytes = fs.readFileSync(f);
    assert.strictEqual(Buffer.compare(bytes, Buffer.from(content, 'utf8')), 0, 'byte-for-byte verbatim');
    assert.notStrictEqual(bytes[0], 0xef, 'no BOM introduced');
  } finally { clean(proj); }
});

test('mid-transaction failure rolls back EVERYTHING (mutated files restored, creates removed, no tmp litter)', () => {
  const { proj, store } = sandbox();
  try {
    const f1 = path.join(store, 'f1.md');
    write(f1, 'original one');
    // rewrite f1, create f9, then delete f1 TWICE: the second delete throws
    // ENOENT mid-transaction -> the whole run must roll back.
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: f1, content: 'rewritten one' },
      { type: 'create', path: path.join(store, 'f9.md'), content: 'should vanish' },
      { type: 'delete', path: f1 },
      { type: 'delete', path: f1 },
    ])); // no deletesApproved — rollback-on-delete-path holds without it (item c)
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, true);
    assert.strictEqual(fs.readFileSync(f1, 'utf8'), 'original one', 'mutated file restored from snapshot');
    assert.strictEqual(fs.existsSync(path.join(store, 'f9.md')), false, 'created file removed');
    assert.strictEqual(fs.readdirSync(store).some((n) => n.includes('.coalwash-tmp')), false, 'no tmp litter');
    assert.strictEqual(fs.existsSync(path.join(txDirFor(proj), '.coalwash.lock')), false, 'lock released after rollback');
  } finally { clean(proj); }
});

test('deletes execute on the PLAN alone — no separate approval flag (the knife-move: authorization is plan-sourced)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'gone.md');
    write(f, 'no longer needed');
    const r = applyPlan(planFor(proj, store, [{ type: 'delete', path: f }])); // no deletesApproved anywhere
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(fs.existsSync(f), false);
    // UNDO is still the safety net: snapshot kept, WAL cleared, lock released — same as any other apply.
    assert.ok(fs.existsSync(path.join(r.snapshotDir, 'snap.complete')));
    assert.strictEqual(fs.existsSync(path.join(txDirFor(proj), 'journal.json')), false, 'WAL cleared on commit');
  } finally { clean(proj); }
});

test('the knife-move did not touch the fidelity gate: a delete bundled with an UNAPPROVED rewrite drop still refuses the WHOLE plan (no-silent-drop interlock lives)', () => {
  const { proj, store } = sandbox();
  try {
    const keep = path.join(store, 'source.md');
    const gone = path.join(store, 'obsolete.md');
    write(keep, 'See [[keep-this]] and the record.');
    write(gone, 'old content to remove');
    // The delete needs no approval flag now — but a sibling rewrite in the
    // SAME plan silently drops a wikilink (no approvedDrops) -> the fidelity
    // gate must still abort EVERYTHING, delete included (all-or-nothing).
    const r = applyPlan(planFor(proj, store, [
      { type: 'delete', path: gone },
      { type: 'rewrite', path: keep, content: 'See the record.' },
    ]));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /fidelity: unapproved fact drop/);
    assert.strictEqual(fs.existsSync(gone), true, 'the bundled delete must NOT proceed when the plan fails fidelity');
    assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'See [[keep-this]] and the record.', 'nothing mutated');
  } finally { clean(proj); }
});

test('PIN protection: pinned: true refuses BOTH delete and rewrite (gap #1)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'pinned.md');
    write(f, '---\npinned: true\n---\ncritical directive');
    assert.strictEqual(isPinned(f), true);
    const del = applyPlan(planFor(proj, store, [{ type: 'delete', path: f }])); // no deletesApproved — PIN still refuses
    assert.strictEqual(del.ok, false);
    assert.ok(del.error.includes('PIN-protected'));
    const rw = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'trimmed' }]));
    assert.strictEqual(rw.ok, false);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '---\npinned: true\n---\ncritical directive');
    // pinned: false is not pinned
    const f2 = path.join(store, 'unpinned.md');
    write(f2, '---\npinned: false\n---\nbody');
    assert.strictEqual(isPinned(f2), false);
  } finally { clean(proj); }
});

test('containment is realpath-and-contain, fail-closed: a path outside the declared roots aborts untouched', () => {
  const { proj, store } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-out-')));
  try {
    const victim = path.join(outside, 'victim.md');
    write(victim, 'safe');
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: victim, content: 'pwned' }]));
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('containment'));
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'safe');
    // an unresolvable target is equally fail-closed
    const r2 = applyPlan(planFor(proj, store, [{ type: 'delete', path: path.join(store, 'ghost.md') }])); // no deletesApproved — containment still refuses
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.error.includes('containment'));
  } finally { clean(proj, outside); }
});

test('a held (fresh) lock defers — never runs concurrently with another session', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'v1');
    const txDir = txDirFor(proj);
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, '.coalwash.lock'), JSON.stringify({ sessionId: 'other', at: Date.now() }));
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'v2' }]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.deferred, true);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v1');
  } finally { clean(proj); }
});

test('a stale lock is taken over (dead-session recovery)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'v1');
    const txDir = txDirFor(proj);
    fs.mkdirSync(txDir, { recursive: true });
    const lockPath = path.join(txDir, '.coalwash.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ sessionId: 'dead', at: 1 }));
    const old = new Date(Date.now() - LOCK_STALE_MS - 60000);
    fs.utimesSync(lockPath, old, old);
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'v2' }]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v2');
  } finally { clean(proj); }
});

test('acquireLock unit: exclusive while held, reusable after release', () => {
  const { proj } = sandbox();
  try {
    const lockPath = path.join(proj, '.coalwash.lock');
    const a = acquireLock(lockPath, { sessionId: 'a' });
    assert.strictEqual(a.acquired, true);
    const b = acquireLock(lockPath, { sessionId: 'b' });
    assert.strictEqual(b.acquired, false);
    a.release();
    const c = acquireLock(lockPath, { sessionId: 'c' });
    assert.strictEqual(c.acquired, true);
    c.release();
  } finally { clean(proj); }
});

test('lock release is OWNER-VERIFIED: a stale-stolen holder cannot delete the new holder\'s lock (formal HIGH #4)', () => {
  const { proj } = sandbox();
  try {
    const lockPath = path.join(proj, '.coalwash.lock');
    const a = acquireLock(lockPath, { sessionId: 'a' });
    assert.strictEqual(a.acquired, true);
    // age the lock file past the stale window (mtime-based staleness) so B takes over.
    const old = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);
    const b = acquireLock(lockPath, { sessionId: 'b' });
    assert.strictEqual(b.acquired, true, 'B takes over the stale lock');
    // A (resumed, unaware) calls release — it MUST NOT delete B's lock.
    a.release();
    assert.strictEqual(fs.existsSync(lockPath), true, "A's release must not remove B's lock (owner check)");
    // A fresh acquirer still defers to B (B's lock is fresh now).
    const c = acquireLock(lockPath, { sessionId: 'c' });
    assert.strictEqual(c.acquired, false, 'B still holds — a fresh acquire defers');
    b.release();
    assert.strictEqual(fs.existsSync(lockPath), false, "B (the owner) can release its own lock");
  } finally { clean(proj); }
});

test('recoverDangling REFUSES an out-of-root target from a poisoned journal (empirical A / containment bypass)', () => {
  const { proj, store } = sandbox();
  try {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-victim-')));
    const victim = path.join(outside, 'victim.md');
    write(victim, 'ORIGINAL VICTIM CONTENT');
    const txDir = txDirFor(proj);
    const snapDir = path.join(txDir, 'snap-999');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'f0'), 'ATTACKER PAYLOAD'); // would overwrite victim
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: victim }]));
    fs.writeFileSync(path.join(snapDir, 'snap.complete'), '999');
    // roots declares only the in-project store; the manifest aims OUTSIDE it.
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({
      version: 1, status: 'applying', snapDir, roots: [store],
      steps: [{ i: 0, type: 'rewrite', path: victim, status: 'done' }],
    }));
    const r = recoverDangling(proj);
    assert.strictEqual(r.recovered, 'partial', 'an out-of-root target is refused, not replayed');
    assert.ok(r.refusedOutOfRoot >= 1);
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL VICTIM CONTENT', 'the outside file must be UNTOUCHED');
    assert.strictEqual(fs.existsSync(path.join(txDir, 'journal.json')), true, 'a refused recovery keeps the journal for a human');
    clean(outside);
  } finally { clean(proj); }
});

test('recoverDangling refuses a journal with NO recorded roots (unverifiable = left for a human)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'GARBAGE');
    const txDir = txDirFor(proj);
    const snapDir = path.join(txDir, 'snap-1');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'f0'), 'orig');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: f }]));
    fs.writeFileSync(path.join(snapDir, 'snap.complete'), '1');
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({ version: 1, status: 'applying', snapDir, steps: [{ i: 0, type: 'rewrite', path: f, status: 'done' }] }));
    const r = recoverDangling(proj);
    assert.strictEqual(r.recovered, 'none');
    assert.match(r.error, /no verifiable roots/);
  } finally { clean(proj); }
});

test('isPinned is FAIL-CLOSED: an opening frontmatter that never closes counts as pinned (formal MED #5)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'huge-fm.md');
    // A frontmatter opener with a pinned:true far down but NO closing fence within
    // the read window -> unverifiable -> must be treated as pinned (refuse to touch).
    write(f, '---\n' + 'x: y\n'.repeat(20000) + 'pinned: true\n'); // never closes in the window
    assert.strictEqual(isPinned(f), true, 'an unclosable frontmatter is fail-closed to pinned');
    // A normal, closed frontmatter without pinned still reads false.
    const g = path.join(store, 'ok.md');
    write(g, '---\ntopic: x\n---\nbody');
    assert.strictEqual(isPinned(g), false);
  } finally { clean(proj); }
});

test('fidelity interlock in applyPlan: an UNAPPROVED rewrite drop aborts before any mutation (doctrine B)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'note.md');
    write(f, 'See [[keep-this]] and the record.');
    // A rewrite that silently drops the wikilink, with NO approvedDrops -> abort.
    const bad = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'See the record.' }]));
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /fidelity: unapproved fact drop/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'See [[keep-this]] and the record.', 'nothing mutated on a fidelity abort');
    // The SAME drop, named in the plan's approvedDrops, is allowed through.
    const ok = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'See the record.' }], { approvedDrops: ['wikilink-drop:keep-this'] }));
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'See the record.');
  } finally { clean(proj); }
});

test('create refuses an existing target (fail loud, nothing clobbered)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'exists.md');
    write(f, 'already here');
    const r = applyPlan(planFor(proj, store, [{ type: 'create', path: f, content: 'clobber' }]));
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('already exists'));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'already here');
  } finally { clean(proj); }
});

test('recoverDangling: an interrupted apply (journal=applying + complete snapshot) rolls back wholesale', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'HALF-APPLIED GARBAGE');
    // fabricate the crash artifacts: snapshot of the ORIGINAL + a dangling journal
    const txDir = txDirFor(proj);
    const snapDir = path.join(txDir, 'snap-123');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'f0'), 'the original content');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: f }]));
    fs.writeFileSync(path.join(snapDir, 'snap.complete'), '123');
    const created = path.join(store, 'half-created.md');
    write(created, 'partial');
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({
      version: 1, status: 'applying', snapDir, roots: [store],
      steps: [
        { i: 0, type: 'rewrite', path: f, status: 'done' },
        { i: 1, type: 'create', path: created, status: 'done' },
        { i: 2, type: 'delete', path: path.join(store, 'never-reached.md'), status: 'pending' },
      ],
    }));
    const r = recoverDangling(proj);
    assert.strictEqual(r.recovered, 'rolled-back');
    assert.strictEqual(r.restored, 1);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'the original content');
    assert.strictEqual(fs.existsSync(created), false, 'interrupted create removed (all-or-nothing)');
    assert.strictEqual(fs.existsSync(path.join(txDir, 'journal.json')), false);
  } finally { clean(proj); }
});

test('recoverDangling: no snap.complete marker means nothing was ever mutated — journal just cleared', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'untouched');
    const txDir = txDirFor(proj);
    const snapDir = path.join(txDir, 'snap-9');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({ version: 1, status: 'applying', snapDir, steps: [] }));
    const r = recoverDangling(proj);
    assert.strictEqual(r.recovered, 'no-mutation');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'untouched');
    assert.strictEqual(fs.existsSync(path.join(txDir, 'journal.json')), false);
  } finally { clean(proj); }
});

test('recoverDangling: none without a journal; terminal statuses are cleaned', () => {
  const { proj } = sandbox();
  try {
    assert.deepStrictEqual(recoverDangling(proj), { recovered: 'none' });
    const txDir = txDirFor(proj);
    fs.mkdirSync(txDir, { recursive: true });
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({ status: 'committed' }));
    assert.strictEqual(recoverDangling(proj).recovered, 'cleaned');
    assert.strictEqual(fs.existsSync(path.join(txDir, 'journal.json')), false);
  } finally { clean(proj); }
});

test('sweepSnapshots keeps the newest N and removes the rest', () => {
  const { proj } = sandbox();
  try {
    const txDir = txDirFor(proj);
    for (const t of [100, 200, 300, 400, 500]) fs.mkdirSync(path.join(txDir, `snap-${t}`), { recursive: true });
    sweepSnapshots(txDir, 3);
    const left = fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).sort();
    assert.deepStrictEqual(left, ['snap-300', 'snap-400', 'snap-500']);
  } finally { clean(proj); }
});

test('plan-shape validation fails loud before any effect', () => {
  const { proj, store } = sandbox();
  try {
    assert.strictEqual(applyPlan(null).ok, false);
    assert.strictEqual(applyPlan({ projectRoot: proj, roots: [], actions: [] }).ok, false);
    assert.ok(applyPlan(planFor(proj, store, [{ type: 'chmod', path: path.join(store, 'x') }])).error.includes('unknown action type'));
    assert.ok(applyPlan(planFor(proj, store, [{ type: 'rewrite', path: 'relative.md', content: 'x' }])).error.includes('absolute'));
    assert.ok(applyPlan(planFor(proj, store, [{ type: 'rewrite', path: path.join(store, 'x.md') }])).error.includes('string content'));
    assert.ok(applyPlan(planFor(proj, store, [{ type: 'rewrite', path: path.join(store, 'x.md'), content: 'x', expectedOrig: 42 }])).error.includes('expectedOrig'));
  } finally { clean(proj); }
});

test('tx dir self-ignores: a .gitignore containing * lands inside .claude/coalwash (privacy is code-enforced)', () => {
  const { proj, store } = sandbox();
  try {
    const f1 = path.join(store, 'g1.md');
    write(f1, 'content');
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f1, content: 'new' }]));
    assert.strictEqual(r.ok, true, r.error);
    const gi = path.join(txDirFor(proj), '.gitignore');
    assert.ok(fs.existsSync(gi), 'self-ignore file must exist in the tx dir');
    assert.strictEqual(fs.readFileSync(gi, 'utf8'), '*\n', 'self-ignore is the catch-all pattern');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// GLOBAL-scope lock (design-pass item, MEMORY.md "THE SHARED GLOBAL SLICE"):
// a global-scope action ALSO locks beside the global state file so two
// DIFFERENT projects' runs can never interleave writes to the same global
// class-B file — a per-project lock alone cannot see across projects.
// ---------------------------------------------------------------------------

test('global-scope lock: a global-scope action takes a lock beside the global state file and releases it on success', () => {
  const { proj, store } = sandbox();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-ghome-')));
  try {
    const g = path.join(store, 'global.md');
    write(g, 'global content');
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: g, content: 'new global content', scope: 'global' }]), { home });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(fs.readFileSync(g, 'utf8'), 'new global content');
    assert.strictEqual(fs.existsSync(globalLockPath(home)), false, 'the global lock is released after a successful apply');
  } finally { clean(proj, home); }
});

test('global-scope lock: a held global lock defers a DIFFERENT project\'s global-scope run even though its OWN project lock is free', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-ghome2-')));
  const proj2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-proj2-')));
  const store2 = path.join(proj2, 'memory');
  fs.mkdirSync(store2, { recursive: true });
  try {
    // A fresh (non-stale) global lock held by "another project's run".
    fs.mkdirSync(path.dirname(globalLockPath(home)), { recursive: true });
    fs.writeFileSync(globalLockPath(home), JSON.stringify({ sessionId: 'other-project', at: Date.now(), token: 'x' }));
    const g2 = path.join(store2, 'global2.md');
    write(g2, 'v1');
    const r = applyPlan(planFor(proj2, store2, [{ type: 'rewrite', path: g2, content: 'v2', scope: 'global' }]), { home });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.deferred, true, 'the global lock defers even though proj2 never held any lock of its own');
    assert.match(r.error, /global scope/);
    assert.strictEqual(fs.readFileSync(g2, 'utf8'), 'v1', 'nothing touched while deferred');
    assert.strictEqual(fs.existsSync(path.join(txDirFor(proj2), '.coalwash.lock')), false, 'the per-project lock was never even acquired');
  } finally { clean(proj2, home); }
});

test('global-scope lock: a plan with NO global-scope actions never touches the global lock file at all', () => {
  const { proj, store } = sandbox();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-ghome3-')));
  try {
    const f = path.join(store, 'local.md');
    write(f, 'v1');
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'v2' }]), { home });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(fs.existsSync(globalLockPath(home)), false, 'no global-scope action -> the global lock file is never created');
  } finally { clean(proj, home); }
});

// ---------------------------------------------------------------------------
// R1 — external-writer guard (WHS KB946676 stale-commit / cloud-sync co-writer)
// ---------------------------------------------------------------------------

test('R1: a foreign write between plan-gating and apply aborts the txn via rollback; the file is named; the foreign write survives', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'the content the caller scanned');
    // the caller derived its rewrite from this content (recorded in the plan)...
    const plan = planFor(proj, store, [{ type: 'rewrite', path: f, content: 'rewritten from the scanned content', expectedOrig: 'the content the caller scanned' }]);
    // ...then a cloud-sync client clobbered the file during the wait before apply.
    write(f, 'FOREIGN WRITER CONTENT');
    const r = applyPlan(plan);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /external writer/);
    assert.ok(r.error.includes('f.md'), 'the report names the file');
    assert.strictEqual(r.rolledBack, true, 'aborted through the existing rollback path');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'FOREIGN WRITER CONTENT', 'nothing of the plan landed; the foreign write survives');
  } finally { clean(proj); }
});

test('R1: multi-file — the already-written file rolls back too; stale snapshots were reaped at preflight', () => {
  const { proj, store } = sandbox();
  try {
    const txDir = txDirFor(proj);
    for (const t of [10, 20, 30, 40, 50]) fs.mkdirSync(path.join(txDir, `snap-${t}`), { recursive: true }); // stale completed snaps, no journal
    const fa = path.join(store, 'a.md');
    const fb = path.join(store, 'b.md');
    write(fa, 'alpha original');
    write(fb, 'beta scanned');
    const plan = planFor(proj, store, [
      { type: 'rewrite', path: fa, content: 'alpha rewritten', expectedOrig: 'alpha original' },
      { type: 'rewrite', path: fb, content: 'beta rewritten', expectedOrig: 'beta scanned' },
    ]);
    write(fb, 'beta FOREIGN');
    const r = applyPlan(plan, { now: 1000 });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /external writer/);
    assert.strictEqual(fs.readFileSync(fa, 'utf8'), 'alpha original', 'the already-applied file is restored');
    assert.strictEqual(fs.readFileSync(fb, 'utf8'), 'beta FOREIGN', 'the foreign write is preserved');
    const stale = fs.readdirSync(txDir).filter((n) => /^snap-(10|20|30|40|50)$/.test(n)).sort();
    assert.deepStrictEqual(stale, ['snap-30', 'snap-40', 'snap-50'], 'preflight retention reaped the oldest stale snapshots even though this run aborted');
  } finally { clean(proj); }
});

test('R1: a delete target that changed since gating is NOT deleted (abort + restore)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'reviewed.md');
    write(f, 'the reviewed content');
    const plan = planFor(proj, store, [{ type: 'delete', path: f, expectedOrig: 'the reviewed content' }]); // no deletesApproved
    write(f, 'CHANGED AFTER THE PLAN WAS GATED');
    const r = applyPlan(plan);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /external writer/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'CHANGED AFTER THE PLAN WAS GATED', 'the changed file is never deleted — the plan authorized deleting what it SCANNED, not what is on disk now');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// R2 — snapshot restorability verify (GitLab all-backups-dead)
// ---------------------------------------------------------------------------

test('R2: an unwritable snapshot slot aborts BEFORE any change', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'precious.md');
    write(f, 'precious');
    // pre-plant a DIRECTORY where this run's first snapshot copy must land
    // (deterministic via the injectable now) -> the copy cannot produce a
    // restorable snapshot -> the run must refuse before touching anything.
    fs.mkdirSync(path.join(txDirFor(proj), 'snap-777', 'f0'), { recursive: true });
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'new' }]), { now: 777 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'precious', 'nothing mutated when the snapshot cannot be produced');
  } finally { clean(proj); }
});

test('R2: verifySnapshot detects a silently-corrupted copy and an unreadable copy; a faithful set passes', () => {
  const { proj, store } = sandbox();
  try {
    const f1 = path.join(store, 's1.md');
    const f2 = path.join(store, 's2.md');
    write(f1, 'source one');
    write(f2, 'source two');
    const snapDir = path.join(txDirFor(proj), 'snap-1');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.copyFileSync(f1, path.join(snapDir, 'f0'));
    fs.copyFileSync(f2, path.join(snapDir, 'f1'));
    const manifest = [{ snap: 'f0', original: f1 }, { snap: 'f1', original: f2 }];
    assert.deepStrictEqual(verifySnapshot(snapDir, manifest), [], 'a faithful snapshot verifies clean');
    // silent corruption (the GitLab class: the copy exists but cannot restore)
    fs.writeFileSync(path.join(snapDir, 'f0'), 'CORRUPTED', 'utf8');
    // unreadable copy
    fs.rmSync(path.join(snapDir, 'f1'));
    const bad = verifySnapshot(snapDir, manifest);
    assert.strictEqual(bad.length, 2);
    assert.ok(bad[0].includes('s1.md') && bad[0].includes('does not match'));
    assert.ok(bad[1].includes('s2.md') && bad[1].includes('unverifiable'));
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// R3 — own-artifact retention protects a dangling txn's snapshot (ReFS leak)
// ---------------------------------------------------------------------------

test('R3: sweep keeps N completed + NEVER the dangling txn\'s snapshot; unreadable or newer journal freezes the sweep', () => {
  const { proj } = sandbox();
  try {
    const txDir = txDirFor(proj);
    for (const t of [50, 100, 200, 300, 400, 500]) fs.mkdirSync(path.join(txDir, `snap-${t}`), { recursive: true });
    const journalPath = path.join(txDir, 'journal.json');
    // a dangling txn references the OLDEST snapshot
    fs.writeFileSync(journalPath, JSON.stringify({ version: 1, status: 'applying', snapDir: path.join(txDir, 'snap-50') }), 'utf8');
    sweepSnapshots(txDir, 3);
    let left = fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    assert.deepStrictEqual(left, ['snap-50', 'snap-300', 'snap-400', 'snap-500'], 'N newest completed kept PLUS the dangling snapshot (recovery owns it)');
    // a NEWER-schema journal: we cannot know what it references -> sweep nothing
    fs.writeFileSync(journalPath, JSON.stringify({ version: 99, status: 'applying', snapDir: path.join(txDir, 'snap-300') }), 'utf8');
    sweepSnapshots(txDir, 1);
    assert.strictEqual(fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).length, 4, 'newer-schema journal freezes the sweep entirely');
    // an unreadable journal: same freeze
    fs.writeFileSync(journalPath, '{ not json', 'utf8');
    sweepSnapshots(txDir, 1);
    assert.strictEqual(fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).length, 4, 'unreadable journal freezes the sweep entirely');
    // a TERMINAL journal protects nothing — plain retention applies
    fs.writeFileSync(journalPath, JSON.stringify({ version: 1, status: 'committed', snapDir: path.join(txDir, 'snap-50') }), 'utf8');
    sweepSnapshots(txDir, 2);
    left = fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    assert.deepStrictEqual(left, ['snap-400', 'snap-500'], 'a terminal journal gets no protection — plain retention');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// R4 — binary/unknown content: flag, never rewrite (e2defrag)
// ---------------------------------------------------------------------------

test('R4: NUL-bearing and unparseable-frontmatter targets are FLAGGED, never rewritten; the run continues on the rest', () => {
  const { proj, store } = sandbox();
  try {
    const NUL = String.fromCharCode(0); // control chars from char codes only (room rule)
    const fbin = path.join(store, 'binary.md');
    const ffm = path.join(store, 'broken-fm.md');
    const fok = path.join(store, 'clean.md');
    const binContent = 'data' + NUL + 'blob';
    const fmContent = '---\nnever: closes\nno closing fence anywhere';
    write(fbin, binContent);
    write(ffm, fmContent);
    write(fok, 'clean content');
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: fbin, content: 'should never land' },
      { type: 'rewrite', path: ffm, content: 'should never land' },
      { type: 'rewrite', path: fok, content: 'clean rewritten' },
    ]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.applied, 1, 'only the clean file was applied');
    assert.strictEqual(r.flagged.length, 2);
    assert.ok(r.flagged.some((x) => x.path === fs.realpathSync(fbin) && /NUL/.test(x.reason)));
    assert.ok(r.flagged.some((x) => x.path === fs.realpathSync(ffm) && /frontmatter/.test(x.reason)));
    assert.strictEqual(fs.readFileSync(fbin, 'utf8'), binContent, 'the binary file is byte-untouched');
    assert.strictEqual(fs.readFileSync(ffm, 'utf8'), fmContent, 'the unparseable file is byte-untouched');
    assert.strictEqual(fs.readFileSync(fok, 'utf8'), 'clean rewritten', 'the run continued on the rest');
    // every action flagged -> nothing to do, loud + flagged, nothing touched
    const r2 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: fbin, content: 'x' }]));
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.flagged.length, 1);
    assert.match(r2.error, /flagged/);
    assert.strictEqual(fs.readFileSync(fbin, 'utf8'), binContent);
    // the sniff unit itself
    assert.match(String(sniffUnrewritable(Buffer.from(binContent, 'utf8'))), /NUL/);
    assert.match(String(sniffUnrewritable(Buffer.from(fmContent, 'utf8'))), /frontmatter/);
    assert.strictEqual(sniffUnrewritable(Buffer.from('---\nok: yes\n---\nbody', 'utf8')), null, 'a CLOSED frontmatter is fine');
    assert.strictEqual(sniffUnrewritable(Buffer.from('plain text', 'utf8')), null);
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// R5 — artifact schema-version: newer journal is untouchable (XP/Vista)
// ---------------------------------------------------------------------------

test('R5: a NEWER-schema dangling journal refuses recovery — journal kept, disk unmodified — even though it COULD have replayed', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'f.md');
    write(f, 'HALF-APPLIED GARBAGE');
    const txDir = txDirFor(proj);
    const snapDir = path.join(txDir, 'snap-123');
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'f0'), 'the original content');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: f }]));
    fs.writeFileSync(path.join(snapDir, 'snap.complete'), '123');
    // identical to the restorable-journal fixture EXCEPT version 99: without
    // the schema gate this WOULD roll back — proving the gate is load-bearing.
    const journalBytes = JSON.stringify({
      version: 99, status: 'applying', snapDir, roots: [store],
      steps: [{ i: 0, type: 'rewrite', path: f, status: 'done' }],
    });
    fs.writeFileSync(path.join(txDir, 'journal.json'), journalBytes);
    const r = recoverDangling(proj);
    assert.strictEqual(r.recovered, 'none');
    assert.match(r.error, /newer/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'HALF-APPLIED GARBAGE', 'nothing restored/modified by the older tool');
    assert.strictEqual(fs.readFileSync(path.join(txDir, 'journal.json'), 'utf8'), journalBytes, 'the newer journal is byte-untouched');
    // terminal-LOOKING newer journal: cleanup is refused too (an older tool
    // must not delete a newer tool's artifact — the XP-deletes-Vista shape).
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({ version: 99, status: 'committed' }));
    const r2 = recoverDangling(proj);
    assert.strictEqual(r2.recovered, 'none');
    assert.ok(fs.existsSync(path.join(txDir, 'journal.json')), 'a terminal-looking newer journal is NOT cleaned up');
  } finally { clean(proj); }
});
// ---------------------------------------------------------------------------
// KEEPS-GATE (beta.12 — the r3 "laundering channel" close)
// ---------------------------------------------------------------------------

test('KEEPS-GATE: a rewrite erasing an adjudicated keep anchor is EXCLUDED (file untouched, named reason); the rest applies', () => {
  const { proj, store } = sandbox();
  try {
    const kept = path.join(store, 'kept.md');
    const other = path.join(store, 'other.md');
    const keptOrig = 'The decisive clause: asked three times deliberately. Filler prose.';
    write(kept, keptOrig);
    write(other, 'trim me');
    recordKeep(proj, { target: 'kept.md:decisive', reason: 'user-adjudicated', anchor: 'asked three times deliberately', anchorFile: kept });
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: kept, content: 'The decisive clause: (compressed). Filler prose.' }, // executor over-cut: anchor erased
      { type: 'rewrite', path: other, content: 'trimmed' },
    ]));
    assert.strictEqual(r.ok, true, r.error); // per-file failure: the rest of the plan proceeds
    assert.strictEqual(r.applied, 1);
    assert.strictEqual(fs.readFileSync(kept, 'utf8'), keptOrig, 'keep-protected file left untouched (auto-restored by exclusion)');
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'trimmed');
    assert.ok(r.flagged.some((f) => /keep enforcement/.test(f.reason) && /asked three times deliberately/.test(f.reason)),
      'the exclusion names the keep');
  } finally { clean(proj); }
});

test('KEEPS-GATE: an anchor MIGRATED to another file in the same txn passes (a merge keeps the fact alive)', () => {
  const { proj, store } = sandbox();
  try {
    const src = path.join(store, 'src.md');
    const dst = path.join(store, 'dst.md');
    write(src, 'Precious: the exact wording survives moves. Other stuff.');
    write(dst, 'Target file.');
    recordKeep(proj, { target: 'src.md:precious', anchor: 'the exact wording survives moves', anchorFile: src });
    const r = applyPlan(planFor(proj, store, [
      { type: 'delete', path: src },
      { type: 'rewrite', path: dst, content: 'Target file. Precious: the exact wording survives moves.' },
    ]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.applied, 2);
    assert.strictEqual(fs.existsSync(src), false, 'the merge-source delete proceeded');
    assert.match(fs.readFileSync(dst, 'utf8'), /the exact wording survives moves/);
  } finally { clean(proj); }
});

test('KEEPS-GATE: deleting the anchored file WITHOUT migrating the anchor is refused (every action excluded = loud fail)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'anchored.md');
    write(f, 'holds the anchor text here');
    recordKeep(proj, { target: 'anchored.md', anchor: 'the anchor text here', anchorFile: f });
    const r = applyPlan(planFor(proj, store, [{ type: 'delete', path: f }]));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /keep-protected|excluded/);
    assert.strictEqual(fs.existsSync(f), true, 'nothing deleted');
    assert.ok(r.flagged.some((x) => /keep enforcement/.test(x.reason)));
  } finally { clean(proj); }
});

test('KEEPS-GATE: a whitespace-reflowed anchor still matches (normalized form accepted, verbatim preferred)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'flow.md');
    write(f, 'Rule: the three word rule stands. Tail.');
    recordKeep(proj, { target: 'flow.md', anchor: 'the three word rule stands', anchorFile: f });
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: f, content: 'Rule: the three\nword  rule stands. Tail trimmed.' },
    ]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.applied, 1);
  } finally { clean(proj); }
});

test('KEEPS-GATE: GLOBAL keeps are consulted too (an adjudicated keep shields machine-wide)', () => {
  const { proj, store } = sandbox();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwa-home-')));
  try {
    const f = path.join(store, 'shared.md');
    write(f, 'Global wisdom: never trust a raw floor value. Extra.');
    recordGlobalKeep(home, { target: 'shared', anchor: 'never trust a raw floor value', anchorFile: f });
    const r = applyPlan(planFor(proj, store, [
      { type: 'rewrite', path: f, content: 'Global wisdom: (trimmed). Extra.' },
    ]), { home });
    assert.strictEqual(r.ok, false, 'the only action was keep-excluded');
    assert.ok(r.flagged.some((x) => /keep enforcement/.test(x.reason)));
    assert.match(fs.readFileSync(f, 'utf8'), /never trust a raw floor value/);
  } finally { clean(proj, home); }
});

test('KEEPS-GATE: pre-beta.12 keeps (no anchor handle) stay advisory — zero behavior change', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'old.md');
    write(f, 'old-shape target content');
    recordKeep(proj, { target: 'old.md:something', reason: 'no anchor recorded' });
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'rewritten freely' }]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'rewritten freely');
  } finally { clean(proj); }
});

test('the new gate classes are approvable BY NAME through approvedDrops (number-precision + evidence-anchor-drop)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'claims.md');
    write(f, 'Stamped 44,192 tokens; delivery verified (transcript c19e528b).');
    const content = 'Stamped ~44k tokens; delivery verified.';
    const blocked = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content }]));
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.error, /number-precision: 44192 \(survives only as 44k\)/);
    assert.match(blocked.error, /evidence-anchor-drop: c19e528b/);
    const approved = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content }],
      { approvedDrops: ['number-precision:44192', 'evidence-anchor-drop:c19e528b'] }));
    assert.strictEqual(approved.ok, true, approved.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), content);
  } finally { clean(proj); }
});

test('KEEPS-GATE fixpoint CASCADE: excluding file A removes the text that satisfied keep B -> B excluded on the next pass; both named, rest proceeds', () => {
  const { proj, store } = sandbox();
  try {
    const a = path.join(store, 'a.md');
    const b = path.join(store, 'b.md');
    const c = path.join(store, 'c.md');
    const aOrig = 'A-file: alpha anchor lives here. Padding.';
    const bOrig = 'B-file: beta anchor lives here. Padding.';
    write(a, aOrig);
    write(b, bOrig);
    write(c, 'C filler.');
    recordKeep(proj, { target: 'a.md:alpha', anchor: 'alpha anchor lives here', anchorFile: a });
    recordKeep(proj, { target: 'b.md:beta', anchor: 'beta anchor lives here', anchorFile: b });
    const r = applyPlan(planFor(proj, store, [
      // A's rewrite drops its OWN anchor but carries B's -> pass 1 excludes A
      // (alpha in no post text) while keep-B is satisfied ONLY via A's content.
      { type: 'rewrite', path: a, content: 'A-file: compressed. Quoting: beta anchor lives here.' },
      // B's rewrite drops beta from B itself -> once A is excluded, pass 2
      // finds beta in NO surviving post text -> B excluded too.
      { type: 'rewrite', path: b, content: 'B-file: compressed.' },
      { type: 'rewrite', path: c, content: 'C trimmed.' },
    ]));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.applied, 1, 'only the keep-free file applies');
    assert.strictEqual(fs.readFileSync(a, 'utf8'), aOrig, 'A untouched (pass-1 exclusion)');
    assert.strictEqual(fs.readFileSync(b, 'utf8'), bOrig, 'B untouched (pass-2 cascade exclusion)');
    assert.strictEqual(fs.readFileSync(c, 'utf8'), 'C trimmed.');
    const keepFlags = r.flagged.filter((f) => /keep enforcement/.test(f.reason));
    assert.strictEqual(keepFlags.length, 2, 'both exclusions surface by name');
    assert.ok(keepFlags.some((f) => f.reason.includes('alpha anchor lives here')));
    assert.ok(keepFlags.some((f) => f.reason.includes('beta anchor lives here')));
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// beta.12 item 4: the fat-bin/store.old retention sweep piggybacks on
// applyPlan's existing preflight housekeeping (the same touchpoint
// sweepSnapshots already uses).
// ---------------------------------------------------------------------------

test('applyPlan preflight ALSO sweeps the bins: an over-horizon fat-bin item is gone after a real apply run', () => {
  const { proj, store } = sandbox();
  try {
    const now = Date.now();
    const oldId = recordBinItem(proj, FAT_BIN_NAME, { content: 'ancient cut', now: now - (HORIZON_MS.fat + 86400000) });
    const freshId = recordBinItem(proj, FAT_BIN_NAME, { content: 'recent cut', now: now - 3600000 });
    const f = path.join(store, 'f.md');
    write(f, 'orig');
    const r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'new' }]));
    assert.strictEqual(r.ok, true, r.error);
    const remaining = listBin(proj, FAT_BIN_NAME).map((i) => i.id);
    assert.ok(!remaining.includes(oldId), 'the over-horizon bin item was swept away by the SAME apply run');
    assert.ok(remaining.includes(freshId), 'a recent bin item survives untouched');
  } finally { clean(proj); }
});
