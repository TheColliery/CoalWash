// gate-liveness.test.mjs — MUTATION-testing CoalWash's safety gates.
//
// Origin: mehvetero/move-test-gen's L3 mutation layer (partner skill; they
// credit our floor/ceiling doctrine, we port their mutation idea back) + the
// GitLab-2017 / Pixar-1998 "the safety net was never EXERCISED" lesson, made a
// STANDING test. It also automates the MED-1 class (a guard dead in the field,
// masked by a colluding fixture — the exact defect the sniper audit found by
// hand).
//
// THE CONTRACT, per gate: two runs of the REAL engine on ONE scenario —
//   FIRES  — construct the exact violation the gate guards; assert the engine
//            BLOCKS/ABORTS and NO loss lands. This is the DEAD-GATE SENTINEL:
//            if the gate were neutralized (a no-op) the block would not happen,
//            so THIS assertion flips RED. A gate whose disabling leaves the
//            suite green is a DEAD gate — a real finding, never papered over.
//   MUTANT — neutralize the gate's decisive check via a minimal, test-scoped
//            primitive patch (fs / Buffer / path / zlib — the shared module
//            objects every lib imports) or the gate's own sanctioned bypass,
//            re-run the SAME violation, assert the loss NOW lands. Proves the
//            gate — not something downstream — is what prevented the loss.
//
// TEST-SIDE ONLY: the engine is never weakened. Every patch is applied and
// restored SYNCHRONOUSLY (try/finally, no await between) so no sibling test
// can ever see a patched primitive; each test owns a fresh sandbox HOME/proj
// and the real ~/.claude is never touched.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { applyPlan } from './apply.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { classifySessions, archiveSession, runEstate, resolveArchiveDir } from './estate-archive.mjs';
import { moveVerify } from './retier.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // the sandbox home is the only platform signal

const DAY_MS = 86400000;

// Swap obj[key] for impl; returns a restore fn. try/finally, SYNC only.
function patch(obj, key, impl) {
  const orig = obj[key];
  obj[key] = impl;
  return () => { obj[key] = orig; };
}
function clean(...dirs) { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }
function write(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, 'utf8'); }

// apply.mjs sandbox: a project with a memory store (roots = [store]).
function applySandbox() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwgl-a-')));
  const store = path.join(proj, 'memory');
  fs.mkdirSync(store, { recursive: true });
  return { proj, store };
}
function planFor(proj, store, actions, extra = {}) {
  return { projectRoot: proj, roots: [store], actions, sessionId: 'gl-session', ...extra };
}

// estate/retier sandbox: a CC-shaped home (so detectPlatform === 'claude-code')
// + a project.
function ccSandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwgl-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwgl-proj-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function slugDir(home, proj) { return path.join(home, '.claude', 'projects', ccProjectSlug(proj)); }
function ageFile(p, ageDays, now) { const t = new Date(now - ageDays * DAY_MS); fs.utimesSync(p, t, t); }
function transcript() {
  return [
    { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { role: 'user', content: 'Fix the wash pipeline' }, cwd: 'x' },
    { type: 'assistant', timestamp: '2026-05-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}
function estateCfg(over = {}) { return { compressAfterDays: 14, purgeAfterDays: 180, deleteCold: false, archiveDir: '', indexEnabled: true, ...over }; }

// ===========================================================================
// GATE 1 — the fidelity gate (a structured-token drop blocks apply)
// ===========================================================================
test('GATE-LIVENESS 1 — fidelity gate is load-bearing: an un-approved [[wikilink]] drop BLOCKS apply; lifting the gate veto (approvedDrops) lands the drop for real', () => {
  const { proj, store } = applySandbox();
  try {
    const f = path.join(store, 'm.md');
    write(f, 'keep [[alpha]] and [[beta]] here');
    const lossy = 'keep [[alpha]] here'; // drops [[beta]]

    // FIRES: un-approved drop → blocked, file untouched (dead-gate sentinel).
    const blocked = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: lossy }]));
    assert.strictEqual(blocked.ok, false, 'DEAD GATE: fidelity did not block an un-approved [[beta]] drop');
    assert.match(blocked.error, /fidelity/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'keep [[alpha]] and [[beta]] here', 'file untouched while blocked');

    // MUTANT: lift the gate's veto for exactly that drop → the loss lands.
    const passed = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: lossy }], { approvedDrops: ['wikilink-drop:beta'] }));
    assert.strictEqual(passed.ok, true, passed.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), lossy, 'veto lifted → the [[beta]] drop is a REAL loss (gate was load-bearing)');
  } finally { clean(proj); }
});

// ===========================================================================
// GATE 2 — MOVE-VERIFY (verbatim-line survival authorizes the index rewrite)
// ===========================================================================
// NO production seam: MOVE-VERIFY's decisive checks are pure in-function logic
// (String.includes for moved-line survival + gateFiles for the union fidelity
// arm) with no cleanly patchable primitive — so per the wave's rule, liveness is
// the FIRES-half REAL-VIOLATION proof on the exported moveVerify, standing alone
// (no MUTANT half). Both arms + the valid-move pass are exercised. The runRetier
// INTEGRATION (a corrupted indexNew reaching moveVerify) can't be produced with
// real data — demotion moves whole lines VERBATIM by construction, so only a
// bug could corrupt indexNew, and a bug-injection seam is exactly what this wave
// refuses to ship. moveVerify blocking a real lossy input IS load-bearing proof.
test('GATE-LIVENESS 2 — MOVE-VERIFY is load-bearing: a demoted line MISSING from the overflow, OR a KEPT structured token DROPPED from the index rewrite, makes moveVerify BLOCK (ok:false); a verbatim move passes', () => {
  const orig = '# idx [[keep]]\n\n- [[move]] one `t1`\n';
  const indexNew = '# idx [[keep]]\n';   // [[keep]] retained on the (non-demotable) heading
  const moved = ['- [[move]] one `t1`']; // the demoted line
  const overflow = moved.join('\n') + '\n';

  // arm A — the moved line is NOT present verbatim in the overflow (a real lossy
  // move): moveVerify BLOCKS. A dead gate would return ok:true here.
  const missArm = moveVerify({ origIndex: orig, indexNew, overflowText: 'SOMETHING ELSE\n', movedLines: moved });
  assert.strictEqual(missArm.ok, false, 'DEAD GATE: a moved line absent from the overflow was not blocked');
  assert.ok(missArm.missing.length >= 1, 'the missing line is named');

  // arm B — the moved line IS in the overflow, but the index rewrite DROPS a
  // kept anchor ([[keep]]): the union fidelity arm BLOCKS. This is the arm that
  // catches a corrupted index rewrite runRetier would otherwise auto-approve.
  const dropArm = moveVerify({ origIndex: orig, indexNew: '# idx\n', overflowText: overflow, movedLines: moved });
  assert.strictEqual(dropArm.ok, false, 'DEAD GATE: a dropped kept anchor was not blocked by the union arm');
  assert.ok(dropArm.unionDrops.some((d) => d.type === 'wikilink-drop' && d.value === 'keep'), 'the union arm names the dropped anchor');

  // a fully-verbatim move (both arms satisfied) passes — not a blanket refuser.
  const good = moveVerify({ origIndex: orig, indexNew, overflowText: overflow, movedLines: moved });
  assert.strictEqual(good.ok, true, `a verbatim move must pass: ${[...good.missing, ...good.unionDrops.map((d) => d.type)].join()}`);
});

// ===========================================================================
// GATE 3a — verifySnapshot (the recovery COPY is verified before the marker)
// ===========================================================================
test('GATE-LIVENESS 3a — verifySnapshot is load-bearing: a corrupt snapshot copy aborts BEFORE any mutation; neutralized (compare says equal), the corrupt backup is trusted and the run commits over it', () => {
  const { proj, store } = applySandbox();
  try {
    const f = path.join(store, 'm.md');
    write(f, 'original');

    // corrupt ONLY the snapshot copy (dest under a snap- dir); every other copy
    // delegates to the real fs.copyFileSync.
    const origCopy = fs.copyFileSync;
    const impl = (src, dest) => { if (String(dest).includes(`${path.sep}snap-`)) { fs.writeFileSync(dest, 'CORRUPT-SNAPSHOT'); return; } return origCopy(src, dest); };

    // FIRES: the snapshot copy is corrupt → verifySnapshot fails → abort before mutation.
    const restore = patch(fs, 'copyFileSync', impl);
    let r;
    try { r = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'original updated' }])); } finally { restore(); }
    assert.strictEqual(r.ok, false, 'DEAD GATE: a corrupt snapshot was not caught');
    assert.match(r.error, /snapshot verify failed/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'original', 'file untouched — verify aborts before the completion marker + any write');

    // MUTANT: corrupt snapshot AND neutralize the compare → verify passes → the
    // run commits with a useless backup on disk.
    const restoreCopy = patch(fs, 'copyFileSync', impl);
    const restoreCmp = patch(Buffer, 'compare', () => 0);
    let r2;
    try { r2 = applyPlan(planFor(proj, store, [{ type: 'rewrite', path: f, content: 'original updated' }])); } finally { restoreCmp(); restoreCopy(); }
    assert.strictEqual(r2.ok, true, r2.error);
    assert.ok(!/snapshot verify failed/.test(r2.error || ''), 'verifySnapshot was the gate — neutralized, no verify abort');
    assert.strictEqual(fs.readFileSync(path.join(r2.snapshotDir, 'f0'), 'utf8'), 'CORRUPT-SNAPSHOT', 'a corrupt (unrestorable) backup was trusted = the loss verifySnapshot prevents');
  } finally { clean(proj); }
});

// ===========================================================================
// GATE 3b — copy-verify-then-delete (the archive is verified before the delete)
// ===========================================================================
test('GATE-LIVENESS 3b — copy-verify (ULTRA archive) is load-bearing: a .gz that does not round-trip keeps the original; neutralized (equals→true), the original is deleted behind an unrecoverable archive', () => {
  const { home, proj } = ccSandbox();
  const now = Date.now();
  const badGzip = (buf) => zlib.gzipSync(Buffer.from('WRONG-ARCHIVE')); // never round-trips to buf
  try {
    const id = 'sess-copyverify';
    const jsonl = path.join(slugDir(home, proj), `${id}.jsonl`);
    write(jsonl, transcript());
    ageFile(jsonl, 30, now); // WARM

    // FIRES: the archive fails its own read-back → session KEPT, original intact.
    const r = runEstate({ projectRoot: proj, home, now, estate: estateCfg(), gzip: badGzip });
    assert.strictEqual(r.archived.length, 0, 'DEAD GATE: a non-round-tripping archive was accepted');
    assert.ok(r.failed.some((f) => /verify mismatch/.test(f.reason)), 'copy-verify names the mismatch');
    assert.ok(fs.existsSync(jsonl), 'original kept when the archive fails copy-verify');

    // MUTANT: neutralize the byte-compare → the bad archive "verifies" → the
    // original is deleted behind an unrecoverable .gz.
    const restore = patch(Buffer.prototype, 'equals', () => true);
    let r2;
    try { r2 = runEstate({ projectRoot: proj, home, now, estate: estateCfg(), gzip: badGzip }); } finally { restore(); }
    assert.ok(r2.archived.length >= 1, 'equals→true: the bad archive is accepted');
    assert.ok(!fs.existsSync(jsonl), 'original DELETED behind an unrecoverable archive = the loss copy-verify prevents');
  } finally { clean(home, proj); }
});

// ===========================================================================
// GATE 4 — archive-delete-boundary re-verify (the 8b7fc71 TOCTOU fix)
// ===========================================================================
test('GATE-LIVENESS 4 — the delete-boundary TOCTOU re-verify is load-bearing: a .gz that verified at WRITE but is clobbered before the delete keeps the original; neutralized, the original is deleted behind the clobbered archive', () => {
  const { home, proj } = ccSandbox();
  const now = Date.now();
  const wrongGz = zlib.gzipSync(Buffer.from('CLOBBERED-AFTER-WRITE'));
  try {
    const id = 'sess-toctou';
    const jsonl = path.join(slugDir(home, proj), `${id}.jsonl`); // single-file session -> exactly 2 .gz reads
    write(jsonl, transcript());
    ageFile(jsonl, 30, now); // WARM

    // A per-.gz-read counter: read #1 = the WRITE-verify (real), read #2 = the
    // DELETE-boundary re-verify (a co-writer clobbered the .gz in between).
    function mkClobber() {
      let gzReads = 0; const orig = fs.readFileSync;
      return { impl: (p, ...rest) => { if (String(p).endsWith('.gz')) { gzReads++; if (gzReads >= 2) return wrongGz; } return orig(p, ...rest); }, orig };
    }

    // FIRES: real .equals — the re-verify sees the clobber → session KEPT.
    let c = mkClobber();
    let restore = patch(fs, 'readFileSync', c.impl);
    let r;
    try { r = runEstate({ projectRoot: proj, home, now, estate: estateCfg() }); } finally { restore(); }
    assert.strictEqual(r.archived.length, 0, 'DEAD GATE: a post-write archive clobber was not caught at the delete boundary');
    assert.ok(r.failed.some((f) => /no longer verifies before delete/.test(f.reason)), 'the TOCTOU re-verify names the boundary');
    assert.ok(fs.existsSync(jsonl), 'original kept when the archive is clobbered after write');

    // MUTANT: neutralize the re-verify byte-compare → the clobbered archive
    // passes → the original is deleted behind CLOBBERED bytes.
    c = mkClobber();
    const restoreRead = patch(fs, 'readFileSync', c.impl);
    const restoreEq = patch(Buffer.prototype, 'equals', () => true);
    let r2;
    try { r2 = runEstate({ projectRoot: proj, home, now, estate: estateCfg() }); } finally { restoreEq(); restoreRead(); }
    assert.ok(r2.archived.length >= 1, 'equals→true: the clobbered archive is accepted');
    assert.ok(!fs.existsSync(jsonl), 'original DELETED behind a clobbered archive = the loss the delete-boundary re-verify prevents');
  } finally { clean(home, proj); }
});

// ===========================================================================
// GATE 5 — containment (realpath-and-contain both sides, fail-closed)
// ===========================================================================
test('GATE-LIVENESS 5 — containment is load-bearing: a create escaping the declared roots is refused fail-closed; neutralized (path.relative faked contained), the out-of-roots write LANDS', () => {
  const { proj, store } = applySandbox();
  const escaped = path.join(proj, 'ESCAPED.md'); // outside roots = [store] (store = proj/memory)
  try {
    // FIRES: containment refuses the escape, nothing written outside.
    const r = applyPlan(planFor(proj, store, [{ type: 'create', path: escaped, content: 'x' }]));
    assert.strictEqual(r.ok, false, 'DEAD GATE: a path outside the declared roots was not refused');
    assert.match(r.error, /containment|escapes/);
    assert.strictEqual(fs.existsSync(escaped), false, 'nothing written outside the roots');

    // MUTANT: fake path.relative to a contained-looking rel → containedIn passes
    // for everything → the out-of-roots write lands. (apply.mjs uses
    // path.relative only inside containedIn, so this neutralizes exactly the
    // containment check.)
    const restore = patch(path, 'relative', () => 'inside');
    let r2;
    try { r2 = applyPlan(planFor(proj, store, [{ type: 'create', path: escaped, content: 'ESCAPED-WRITE' }])); } finally { restore(); }
    assert.strictEqual(r2.ok, true, r2.error);
    assert.strictEqual(fs.readFileSync(escaped, 'utf8'), 'ESCAPED-WRITE', 'containment neutralized → an out-of-roots write landed (load-bearing)');
  } finally { clean(proj); }
});

// ===========================================================================
// GATE 6 — the CoalHearth active-session guard (chJournalGuard) — MED-1
// ===========================================================================
test('GATE-LIVENESS 6 — chJournalGuard is load-bearing: a FRESH in-progress CH journal protects the newest (else-WARM) session from ULTRA; neutralized (journal reads idle), the LIVE session transcript is archived + deleted', () => {
  const { home, proj } = ccSandbox();
  const now = Date.now();
  const handoff = path.join(proj, '.claude', 'coalhearth', 'session_handoff.json');
  try {
    const id = 'sess-live';
    const jsonl = path.join(slugDir(home, proj), `${id}.jsonl`);
    write(jsonl, transcript());
    ageFile(jsonl, 30, now); // WARM by age — only the CH guard should protect it
    // CH's REAL key set (no sessionId — the MED-1 field): status + fresh mtime.
    write(handoff, JSON.stringify({ status: 'in_progress', checklist: [], modifiedFiles: [], inFlightAgents: [], activePlan: {} }));

    // FIRES: the fresh in-progress journal bands the newest unit 'active' → skipped.
    const r = runEstate({ projectRoot: proj, home, now, estate: estateCfg() });
    assert.strictEqual(r.activeSkipped, 1, 'DEAD GATE: the live CH session was not protected');
    assert.strictEqual(r.archived.length, 0, 'nothing archived under an active CH session');
    assert.ok(fs.existsSync(jsonl), 'the live transcript is intact');

    // MUTANT: neutralize the guard — the handoff now reads a non-in_progress
    // status → chJournalGuard returns none → the session bands WARM → archived + deleted.
    const orig = fs.readFileSync;
    const restore = patch(fs, 'readFileSync', (p, ...rest) => (typeof p === 'string' && p.endsWith('session_handoff.json')) ? '{"status":"idle"}' : orig(p, ...rest));
    let r2;
    try { r2 = runEstate({ projectRoot: proj, home, now, estate: estateCfg() }); } finally { restore(); }
    assert.strictEqual(r2.archived.length, 1, 'guard neutralized → the active session is archived');
    assert.ok(!fs.existsSync(jsonl), 'the LIVE session transcript was deleted out from under it = the loss chJournalGuard prevents');
  } finally { clean(home, proj); }
});

// ===========================================================================
// GATE 7 — the external-writer guard (foreign-change abort)
// ===========================================================================
test('GATE-LIVENESS 7 — the external-writer guard is load-bearing: a target changed by a foreign writer after gating aborts the run (foreign bytes preserved); neutralized (compare→0), the stale rewrite clobbers the foreign change', () => {
  const { proj, store } = applySandbox();
  try {
    const f = path.join(store, 'm.md');
    // We gated against "hello world" but a co-writer has since written "FOREIGN".
    const foreign = 'FOREIGN co-writer content';
    const action = { type: 'rewrite', path: f, content: 'hello world plus', expectedOrig: 'hello world' }; // no structured-token drop → passes fidelity

    // FIRES: disk != the gated baseline → abort, foreign bytes preserved.
    write(f, foreign);
    const r = applyPlan(planFor(proj, store, [action]));
    assert.strictEqual(r.ok, false, 'DEAD GATE: a foreign mid-run change was not detected');
    assert.match(r.error, /external writer/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), foreign, 'foreign bytes preserved; the stale rewrite was rejected');

    // MUTANT: neutralize the compare → the guard never fires → the stale rewrite
    // clobbers the foreign change.
    write(f, foreign);
    const restore = patch(Buffer, 'compare', () => 0);
    let r2;
    try { r2 = applyPlan(planFor(proj, store, [action])); } finally { restore(); }
    assert.strictEqual(r2.ok, true, r2.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello world plus', 'guard neutralized → the foreign change was clobbered = the loss it prevents');
  } finally { clean(proj); }
});

// ===========================================================================
// GATE 8 — #56 delete_scope == verified_set (rmdir-if-empty, never rm -rf)
// ===========================================================================
test('GATE-LIVENESS 8 — the #56 empty-only prune is load-bearing: an un-enumerated file under <sid>/ is KEPT + surfaced (never rm -rf); the rm -rf it replaced destroys that file', () => {
  const { home, proj } = ccSandbox();
  const now = Date.now();
  try {
    const id = 'sess-prune';
    const sdir = slugDir(home, proj);
    const jsonl = path.join(sdir, `${id}.jsonl`);
    write(jsonl, transcript());
    write(path.join(sdir, id, 'tool-results', 'r1.txt'), 'tool output'); // an enumerated overflow file
    for (const p of [jsonl, path.join(sdir, id, 'tool-results', 'r1.txt')]) ageFile(p, 30, now);

    const c = classifySessions({ projectRoot: proj, home, now, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === id);
    assert.ok(sess, 'session listed');

    // A file that appears AFTER the listing (never enumerated / verified).
    const late = path.join(sdir, id, 'LATE-ARRIVAL.txt');
    write(late, 'un-enumerated bytes that must survive');

    // FIRES: archive deletes the enumerated files; the late file is KEPT + surfaced,
    // its <sid>/ container NOT rm -rf'd.
    const r = archiveSession(sess, { slug: c.slug, archiveDir: resolveArchiveDir(estateCfg(), home), now });
    assert.strictEqual(r.ok, true, r.reason);
    assert.ok(r.unpruned.some((u) => u.endsWith('LATE-ARRIVAL.txt')), 'DEAD GATE: an un-enumerated file was not surfaced (may have been swept)');
    assert.ok(fs.existsSync(late), 'the un-enumerated file is KEPT (never rm -rf)');
    assert.ok(!fs.existsSync(jsonl), 'the enumerated transcript WAS archived + deleted (delete_scope == verified_set)');

    // MUTANT / counterfactual: the pre-#56 code rm -rf'd the whole <sid>/ (the
    // header's "the whole-tree rm -rf this used to do"). That alternative
    // destroys the survivor the empty-only prune preserved.
    assert.ok(fs.existsSync(late), 'guard kept it');
    fs.rmSync(path.join(sdir, id), { recursive: true, force: true }); // the rm -rf #56 replaced
    assert.ok(!fs.existsSync(late), 'the rm -rf #56 replaced would have DESTROYED the un-enumerated file (load-bearing)');
  } finally { clean(home, proj); }
});
