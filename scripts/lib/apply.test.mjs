import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, recoverDangling, acquireLock, sweepSnapshots, isPinned, txDirFor, LOCK_STALE_MS } from './apply.mjs';

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
    ], { deletesApproved: true }));
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
    ], { deletesApproved: true }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, true);
    assert.strictEqual(fs.readFileSync(f1, 'utf8'), 'original one', 'mutated file restored from snapshot');
    assert.strictEqual(fs.existsSync(path.join(store, 'f9.md')), false, 'created file removed');
    assert.strictEqual(fs.readdirSync(store).some((n) => n.includes('.coalwash-tmp')), false, 'no tmp litter');
    assert.strictEqual(fs.existsSync(path.join(txDirFor(proj), '.coalwash.lock')), false, 'lock released after rollback');
  } finally { clean(proj); }
});

test('deletes without deletesApproved are refused LOUD, nothing touched (the human gate is code-enforced)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'keep.md');
    write(f, 'precious');
    const r = applyPlan(planFor(proj, store, [{ type: 'delete', path: f }]));
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('deletes not approved'));
    assert.ok(r.error.includes('keep.md'));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'precious');
    assert.strictEqual(fs.existsSync(txDirFor(proj)), false, 'refused before any tx artifact');
  } finally { clean(proj); }
});

test('PIN protection: pinned: true refuses BOTH delete and rewrite (gap #1)', () => {
  const { proj, store } = sandbox();
  try {
    const f = path.join(store, 'pinned.md');
    write(f, '---\npinned: true\n---\ncritical directive');
    assert.strictEqual(isPinned(f), true);
    const del = applyPlan(planFor(proj, store, [{ type: 'delete', path: f }], { deletesApproved: true }));
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
    const r2 = applyPlan(planFor(proj, store, [{ type: 'delete', path: path.join(store, 'ghost.md') }], { deletesApproved: true }));
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
    // The SAME drop, explicitly approved by the human, is allowed through.
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