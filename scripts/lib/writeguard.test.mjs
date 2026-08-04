// Hermetic tests for writeguard.mjs — the 0p WRITE-PATH SEATBELT + AIRBAG.
// Sandbox fixtures only (never the live repo — the beta.15 lesson); the perf
// claim is STRUCTURAL (instrumented fs, zero wall clocks).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGuardedTarget, snapshotOnFirstWrite, seatbeltCheck,
  listWriteguard, readWriteguardSnapshot, sweepWriteguard, SEATBELT_MAX_BYTES,
} from './writeguard.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: sandbox home only

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-proj-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
function wgRoot(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }
function treeState(dir) {
  const out = {};
  const walk = (d) => {
    let names; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else out[p] = st.mtimeMs + ':' + st.size;
    }
  };
  walk(dir);
  return out;
}
// A governance-file body long enough that a one-token cut leaves the rest intact.
const GOV = '# Governance\n\nSee [the guide](https://example.com/guide) and version v1.2.3 on 2026-07-11. ' + 'x'.repeat(300);

// ---------------------------------------------------------------------------
// isGuardedTarget — the cheap prefilter + realpath-and-contain
// ---------------------------------------------------------------------------

test('isGuardedTarget: root governance basenames + markdown under a .claude tree are guarded; source code is NOT', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md'); fs.writeFileSync(gov, GOV, 'utf8');
    const mem = path.join(proj, 'MEMORY.md'); fs.writeFileSync(mem, GOV, 'utf8');
    const rule = path.join(proj, '.claude', 'rules', 'x.md'); fs.mkdirSync(path.dirname(rule), { recursive: true }); fs.writeFileSync(rule, GOV, 'utf8');
    const globalGov = path.join(home, '.claude', 'CLAUDE.md'); fs.writeFileSync(globalGov, GOV, 'utf8');
    const src = path.join(proj, 'src', 'index.js'); fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, 'code', 'utf8');
    const doc = path.join(proj, 'docs', 'readme.md'); fs.mkdirSync(path.dirname(doc), { recursive: true }); fs.writeFileSync(doc, '# docs', 'utf8');

    assert.strictEqual(isGuardedTarget(gov, { projectRoot: proj, home }), fs.realpathSync.native(gov));
    assert.strictEqual(isGuardedTarget(mem, { projectRoot: proj, home }), fs.realpathSync.native(mem));
    assert.strictEqual(isGuardedTarget(rule, { projectRoot: proj, home }), fs.realpathSync.native(rule));
    assert.strictEqual(isGuardedTarget(globalGov, { projectRoot: proj, home }), fs.realpathSync.native(globalGov));
    assert.strictEqual(isGuardedTarget(src, { projectRoot: proj, home }), null, 'source code is never guarded');
    assert.strictEqual(isGuardedTarget(doc, { projectRoot: proj, home }), null, 'a plain docs .md outside .claude is not guarded (undercount-is-safe ceiling)');
  } finally { clean(home, proj); }
});

test('isGuardedTarget: CW\'s OWN sandbox (.claude/coalwash/**) is NEVER guarded — 0h-GUARD: the guard must never touch a bin or its own snapshots', () => {
  const { home, proj } = sandbox();
  try {
    const binFile = path.join(proj, '.claude', 'coalwash', 'fat-bin', 'x.md');
    fs.mkdirSync(path.dirname(binFile), { recursive: true }); fs.writeFileSync(binFile, GOV, 'utf8');
    assert.strictEqual(isGuardedTarget(binFile, { projectRoot: proj, home }), null);
  } finally { clean(home, proj); }
});

test('isGuardedTarget: an unresolvable / out-of-tree path is fail-closed (null)', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-out-')));
  try {
    const stray = path.join(outside, 'CLAUDE.md'); fs.writeFileSync(stray, GOV, 'utf8');
    assert.strictEqual(isGuardedTarget(stray, { projectRoot: proj, home }), null, 'a governance basename OUTSIDE the trees is not contained -> fail-closed');
    assert.strictEqual(isGuardedTarget(path.join(proj, 'gone.md'), { projectRoot: proj, home }), null, 'missing/unresolvable -> null');
    assert.strictEqual(isGuardedTarget('', { projectRoot: proj, home }), null);
    assert.strictEqual(isGuardedTarget(null, { projectRoot: proj, home }), null);
  } finally { clean(home, proj, outside); }
});

// ---------------------------------------------------------------------------
// AIRBAG — snapshot-on-first-write
// ---------------------------------------------------------------------------

test('airbag: snapshots a guarded file ONCE per session; the 2nd write to the same file skips (baseline stays the FIRST-write orig)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    const snap1 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(snap1 && fs.existsSync(snap1), 'first write snapshots');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), GOV, 'snapshot is the byte-exact orig');
    // The file changes, then a SECOND write fires the airbag again -> must skip.
    fs.writeFileSync(gov, GOV + '\nmore', 'utf8');
    const snap2 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.strictEqual(snap2, snap1, 'same snapshot path returned, not re-copied');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), GOV, 'the baseline is STILL the first-write orig, not the mutated content');
    // self-ignore present (snapshots stay out of VCS).
    assert.ok(fs.existsSync(path.join(path.dirname(snap1), '.gitignore')));
    assert.ok(fs.existsSync(path.join(wgRoot(proj), '.gitignore')));
  } finally { clean(home, proj); }
});

// grad7 ruling Root C (F3, worse than named): the OLD `snapName` keyed
// purely on a 32-bit path hash, so `fs.existsSync(snap)` alone was trusted
// as "already snapshotted this session" — a round-8 worker CONSTRUCTED a
// real collision (two distinct governed files, same derived name) in 4.4M
// brute-force tries. Fixed by (1) sha256 instead of djb2 (closes the
// SPECIFIC brute-force attack) and (2) an identity sidecar verified before
// ANY existing slot is trusted (closes the general "believe the name"
// class, independent of hash strength). This test proves (2) directly —
// simulating a collision by planting a foreign occupant at the real derived
// slot, which is the state ANY successful hash collision would produce,
// without needing to actually break sha256 to prove the verification fires.
test('RED-FIRST/root-C: a foreign occupant at the derived snapshot slot (the state a hash collision produces) is NEVER trusted as this file\'s own baseline', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const trueOrig = GOV + '\nTHE TRUE ORIGINAL — this must survive, byte-exact.';
    fs.writeFileSync(gov, trueOrig, 'utf8');
    // Establish the REAL slot production code derives for `gov`, then wipe it
    // to simulate "before any snapshot exists" — production computes the path,
    // the test only ever reads it back, never precomputes the hash itself.
    const realSnap = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(realSnap && fs.existsSync(realSnap));
    fs.rmSync(realSnap, { force: true });
    fs.rmSync(`${realSnap}.origpath`, { force: true });
    assert.strictEqual(fs.existsSync(realSnap), false, 'setup: slot genuinely empty now');

    // Plant a FOREIGN occupant at that exact slot — content that belongs to a
    // DIFFERENT file, with a sidecar naming that different file's own path
    // (the collision shape: this slot's name matches `gov`'s derived name,
    // but the content and recorded identity are someone else's).
    const victimPath = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(realSnap, 'FOREIGN CONTENT — belongs to a different file entirely', 'utf8');
    fs.writeFileSync(`${realSnap}.origpath`, victimPath, 'utf8');

    // The real write we care about: gov's snapshot is requested again in the
    // SAME session. Pre-fix code would see `fs.existsSync(snap)` true and
    // return the foreign occupant's path as if it were gov's own baseline —
    // the seatbelt would then diff gov's real edits against SOMEONE ELSE's
    // original, comparing apples to oranges (or worse, silently "matching").
    const snap2 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(snap2, 'a fresh snapshot must still be taken for gov');
    assert.notStrictEqual(snap2, realSnap, 'must NOT reuse the foreign-occupied slot — a disambiguated new slot is required');
    assert.strictEqual(fs.readFileSync(snap2, 'utf8'), trueOrig, 'the NEW snapshot must hold GOV\'s own true original, never the foreign content');
    // grad9 F1: the sidecar now carries a SECOND line (the content hash) —
    // check the path line specifically, not the whole file verbatim.
    assert.strictEqual(fs.readFileSync(`${snap2}.origpath`, 'utf8').split('\n')[0], gov, 'the new slot\'s sidecar correctly identifies gov as its owner');
    // The foreign occupant is left completely untouched — never overwritten,
    // never treated as reclaimable.
    assert.strictEqual(fs.readFileSync(realSnap, 'utf8'), 'FOREIGN CONTENT — belongs to a different file entirely', 'the foreign occupant must survive untouched');
  } finally { clean(home, proj); }
});

test('RED-FIRST/root-C control: a REAL same-session re-write of the SAME file still hits the fast path (no spurious disambiguation)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    const snap1 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    fs.writeFileSync(gov, GOV + '\nedited', 'utf8'); // a real subsequent edit
    const snap2 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.strictEqual(snap2, snap1, 'the identity-verified fast path still returns the SAME slot for the SAME file — no unnecessary disambiguation');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), GOV, 'baseline is still the untouched first-write orig');
  } finally { clean(home, proj); }
});

// grad9 F1: round 8 named Root C as "no content-verify-before-trust"; the
// sha256 upgrade closed the NAME-collision route but verifyOrigPath still
// compared a PATH STRING only, never the blob's own bytes -- so a slot
// tampered IN PLACE (content overwritten, sidecar path left matching) was
// silently trusted as the file's own baseline. Coordinator's own fixture
// reproduced this live: legit snapshot -> blob overwritten -> re-entry ->
// "slot reused (no re-verify)? true". RED-FIRST: swap writeguard.mjs to HEAD
// (pre-F1), this must fail (the tampered slot gets reused).
test('RED-FIRST/F1: a blob tampered in place (sidecar path still matches, content does not) is NEVER trusted as this file\'s own baseline', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const trueOrig = GOV + '\nTHE TRUE ORIGINAL — this must survive, byte-exact.';
    fs.writeFileSync(gov, trueOrig, 'utf8');
    const snap1 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(snap1 && fs.existsSync(snap1));
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), trueOrig, 'setup: real baseline recorded');

    // TAMPER: overwrite the blob's bytes directly, in place — exactly the
    // coordinator's own reproduction. The sidecar (path + the ORIGINAL hash)
    // is left untouched, so a path-only check would still say "match".
    fs.writeFileSync(snap1, 'ATTACKER-CONTROLLED CONTENT', 'utf8');

    // Same file, same session, requested again. Pre-fix: path match alone
    // trusted the slot and reused the tampered blob as gov's baseline.
    const snap2 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(snap2, 'a fresh snapshot must still be taken');
    assert.notStrictEqual(snap2, snap1, 'the tampered slot must NOT be reused — disambiguated to a new slot');
    assert.strictEqual(fs.readFileSync(snap2, 'utf8'), trueOrig, 'the NEW snapshot must hold gov\'s own current true state, never the tampered blob');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), 'ATTACKER-CONTROLLED CONTENT', 'the tampered blob survives untouched, never silently "repaired"');
  } finally { clean(home, proj); }
});

// grad10 F1 [CRITICAL]: the write-path digest (above) gates SLOT REUSE.
// readWriteguardSnapshot — THE RESTORE DOOR, the one a human actually
// presses — searched every session dir by NAME ONLY and returned the
// NEWEST by mtime, no identity check at all. Coordinator's own
// reproduction, mirrored exactly: plant a rogue blob under the SAME
// canonical name in a DIFFERENT (unswept) session dir, with a newer mtime —
// no access to the live session's own slot, none to the governed file
// itself. The rogue even COPIES the legit sidecar verbatim (the lazy
// attack: reuses the true content's hash without re-signing for its own
// bytes) — exactly the shape `verifyBlobIntegrity` now catches.
test('RED-FIRST/F1-restore: a rogue blob planted under the SAME snapName in a DIFFERENT session dir, with a newer mtime, does NOT win the restore', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md');
    const trueOrig = '# coder MEMORY\n\nload-bearing craft nobody can regenerate\n';
    fs.mkdirSync(path.dirname(gov), { recursive: true });
    fs.writeFileSync(gov, trueOrig, 'utf8');

    // CLEAN CONTROL FIRST — nothing believed until this passes, same
    // discipline the coordinator's own fixture used.
    const snap = snapshotOnFirstWrite(proj, 'sess-live', gov, { home });
    fs.writeFileSync(gov, '# coder MEMORY\n\nrewritten\n', 'utf8');
    const clean = readWriteguardSnapshot(proj, path.basename(snap), { home });
    assert.strictEqual(clean && clean.content.toString('utf8'), trueOrig, 'setup: a clean restore returns the true original');

    // The legit snapshot is left ENTIRELY ALONE from here.
    const legitBytes = fs.readFileSync(snap, 'utf8');

    // Plant a rogue blob under the SAME name in a DIFFERENT session dir,
    // copying the legit sidecar verbatim (no re-signing for the rogue bytes).
    const slotName = path.basename(snap);
    const rogueDir = path.join(proj, '.claude', 'coalwash', 'writeguard', 'sess-other');
    fs.mkdirSync(rogueDir, { recursive: true });
    const rogue = path.join(rogueDir, slotName);
    fs.writeFileSync(rogue, '# coder MEMORY\n\n(rogue content)\n', 'utf8');
    for (const f of fs.readdirSync(path.dirname(snap))) {
      if (f.startsWith(slotName) && f !== slotName) fs.copyFileSync(path.join(path.dirname(snap), f), path.join(rogueDir, f));
    }
    const future = Date.now() / 1000 + 60;
    fs.utimesSync(rogue, future, future); // newer mtime — wins the OLD mtime-only sort

    const got = readWriteguardSnapshot(proj, path.basename(snap), { home });
    assert.strictEqual(fs.readFileSync(snap, 'utf8'), legitBytes, 'the legit snapshot must survive untouched on disk');
    assert.notStrictEqual(got && got.content.toString('utf8'), '# coder MEMORY\n\n(rogue content)\n', 'the rogue must NEVER be served');
    assert.strictEqual(got && got.content.toString('utf8'), trueOrig, 'the TRUE original must still be served — the newest VERIFIED candidate, not the newest candidate outright');
  } finally { clean(home, proj); }
});

test('RED-FIRST/F1-restore control: a rogue blob with NO copied sidecar at all is refused the same way (unverifiable, not merely mismatched)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const trueOrig = GOV + '\nTHE TRUE ORIGINAL for the no-sidecar rogue control.';
    fs.writeFileSync(gov, trueOrig, 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess-live', gov, { home });

    const slotName = path.basename(snap);
    const rogueDir = path.join(proj, '.claude', 'coalwash', 'writeguard', 'sess-other');
    fs.mkdirSync(rogueDir, { recursive: true });
    const rogue = path.join(rogueDir, slotName);
    fs.writeFileSync(rogue, 'bare rogue, no sidecar at all', 'utf8');
    const future = Date.now() / 1000 + 60;
    fs.utimesSync(rogue, future, future);

    const got = readWriteguardSnapshot(proj, path.basename(snap), { home });
    assert.strictEqual(got && got.content.toString('utf8'), trueOrig, 'the true original still wins — the sidecar-less rogue never verifies');
  } finally { clean(home, proj); }
});

test('airbag: a source-code write / a not-yet-existing file / a non-guarded path all snapshot NOTHING', () => {
  const { home, proj } = sandbox();
  try {
    const src = path.join(proj, 'index.js'); fs.writeFileSync(src, 'code', 'utf8');
    assert.strictEqual(snapshotOnFirstWrite(proj, 's', src, { home }), null, 'source code not guarded');
    const newGov = path.join(proj, 'AGENTS.md'); // guarded basename, but does not exist yet (a Write creating it)
    assert.strictEqual(snapshotOnFirstWrite(proj, 's', newGov, { home }), null, 'no orig on disk -> nothing to snapshot');
    assert.strictEqual(fs.existsSync(wgRoot(proj)), false, 'no writeguard dir created for un-snapshotted writes');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SEATBELT — the advisory drop-detector + the FP mini-lab (0p prereq)
// ---------------------------------------------------------------------------

test('FP lab (a): a CARELESS drop — an edit that silently loses a link — fires the advisory (classes named)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    // careless: the link vanishes, everything else stays.
    fs.writeFileSync(gov, GOV.replace('[the guide](https://example.com/guide)', 'the guide'), 'utf8');
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && !r.oversize, 'a diff ran');
    assert.ok(r.classes.includes('link-drop'), JSON.stringify(r.classes));
    assert.strictEqual(r.file, fs.realpathSync.native(gov));
    assert.ok(r.snapshotPath && fs.existsSync(r.snapshotPath), 'the snapshot pointer is a real file');
  } finally { clean(home, proj); }
});

test('FP lab (b) — the HARD case: a DELIBERATE whole-section removal that drops tokens as its PURPOSE also fires — option (ii): advisory-always, FYI-framed, NEVER a block (an FP costs one line, never a blocked edit)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    // Two sections; the deliberate cut removes the whole second one (links,
    // numbers, dates go with it — that is the edit's PURPOSE, not a slip).
    const orig = '# Index\n\nKeep this.\n\n## Old section\n\nSee [ref](https://x.com) v9.9.9 on 2026-01-01, count 42.\n';
    fs.writeFileSync(gov, orig, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, '# Index\n\nKeep this.\n', 'utf8'); // section deliberately gone
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    // It DOES flag (structured tokens dropped) — that is by design (no
    // deliberate-vs-careless heuristic). The KEY property: it is advisory only.
    assert.ok(r && r.classes.length > 0, 'a deliberate cut still surfaces (option ii, no misclassification)');
    // Prove it renders as an FYI, never a block: the advisory text says so and
    // points at the snapshot; the result carries no block signal of any kind.
    // (The conductor test proves stdout is plain, never {decision:'block'}.)
    assert.strictEqual(r.oversize, false);
    assert.ok(r.snapshotPath, 'every fire carries the undo hint');
  } finally { clean(home, proj); }
});

test('seatbelt: a CLEAN edit (only additions, no structured-token loss) returns no classes -> the conductor stays silent', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, GOV + '\n\nAdded a fresh line, dropped nothing.', 'utf8');
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && !r.oversize);
    assert.deepStrictEqual(r.classes, [], 'nothing dropped -> empty -> silent');
  } finally { clean(home, proj); }
});

test('seatbelt: no airbag baseline (a brand-new guarded file, or the airbag was off) -> null (silent), never a false advisory', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV.replace('[the guide](https://example.com/guide)', 'gone'), 'utf8'); // exists but no snapshot taken
    assert.strictEqual(seatbeltCheck(proj, 'sess', gov, { home }), null, 'no baseline -> silent');
  } finally { clean(home, proj); }
});

test('seatbelt: an OVERSIZE guarded file skips the diff — snapshot stands, oversize note returned (perf degrade, no inline scan of a pathological file)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const big = '[link](https://x.com)\n' + 'a'.repeat(SEATBELT_MAX_BYTES + 100);
    fs.writeFileSync(gov, big, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, 'a'.repeat(SEATBELT_MAX_BYTES + 100), 'utf8'); // link dropped, but oversize
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && r.oversize === true, 'oversize -> diff skipped');
    assert.deepStrictEqual(r.classes, [], 'no class list when the diff is skipped');
    assert.ok(r.snapshotPath && fs.existsSync(r.snapshotPath), 'the airbag snapshot still exists (undo net intact)');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// PERF — STRUCTURAL (no wall clock): the non-guarded path does ZERO snapshot
// work; the guarded path does exactly one copy. Instrument fs.copyFileSync.
// ---------------------------------------------------------------------------

test('perf (structural): a non-guarded write triggers ZERO snapshot copies; a guarded first-write triggers exactly ONE — no discovery walk on either path', () => {
  const { home, proj } = sandbox();
  const realCopy = fs.copyFileSync;
  let copies = 0;
  try {
    fs.copyFileSync = (...a) => { copies++; return realCopy(...a); };
    const src = path.join(proj, 'index.js'); realCopy && fs.writeFileSync(src, 'code', 'utf8');
    copies = 0;
    snapshotOnFirstWrite(proj, 's', src, { home });
    assert.strictEqual(copies, 0, 'source code: zero copy work (skips at the cheap prefilter)');
    const gov = path.join(proj, 'CLAUDE.md'); fs.writeFileSync(gov, GOV, 'utf8');
    copies = 0;
    snapshotOnFirstWrite(proj, 's', gov, { home });
    assert.strictEqual(copies, 1, 'guarded first write: exactly one ms-copy');
    snapshotOnFirstWrite(proj, 's', gov, { home });
    assert.strictEqual(copies, 1, 'guarded second write: no further copy (already snapshotted)');
  } finally { fs.copyFileSync = realCopy; clean(home, proj); }
});

test('read-only-except-sandbox: the seatbelt writes NOTHING (the target file + tree are byte/mtime identical after a check); only the airbag writes, and only under .claude/coalwash', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home }); // airbag writes (under sandbox only)
    fs.writeFileSync(gov, GOV.replace('v1.2.3', 'gone'), 'utf8'); // an external edit drops a version
    // Snapshot the whole project tree EXCLUDING the sandbox, then run the
    // seatbelt, then prove nothing outside the sandbox changed.
    const before = treeState(proj);
    delete before[gov]; // the edit above is the test's own write, not the seatbelt's
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r.classes.includes('version-drop'));
    const after = treeState(proj);
    delete after[gov];
    // Every non-sandbox path unchanged (the seatbelt only READS).
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k.includes(path.join('.claude', 'coalwash'))) continue; // airbag's own sandbox writes are allowed
      assert.strictEqual(after[k], before[k], `seatbelt must not touch ${k}`);
    }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// RECOVERY — restore-by-reference (0p law): metadata to the agent, CODE moves
// the real bytes; isBareId-contained (F1).
// ---------------------------------------------------------------------------

test('recovery: listWriteguard returns METADATA only (never content); readWriteguardSnapshot returns the byte-exact ORIGINAL', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess', gov, { home });
    const name = path.basename(snap);
    const list = listWriteguard(proj, { home });
    assert.strictEqual(list.length, 1);
    assert.ok(!('content' in list[0]), 'listing carries NO content — metadata only');
    assert.strictEqual(list[0].name, name);
    assert.ok(list[0].bytes > 0 && list[0].snapshotPath === snap);
    const got = readWriteguardSnapshot(proj, name, { home });
    assert.deepStrictEqual(got.content, Buffer.from(GOV, 'utf8'), 'the recovered bytes are the byte-exact original — code-moved, model-untouched');
  } finally { clean(home, proj); }
});

test('recovery: readWriteguardSnapshot rejects a non-bare / traversal name (F1) and a miss -> null', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-secret-')));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'not yours', 'utf8');
    for (const evil of ['../../' + path.basename(outside) + '/secret.md', '..\\secret', '.', '..', 'a/b']) {
      assert.strictEqual(readWriteguardSnapshot(proj, evil, { home }), null, `traversal id ${JSON.stringify(evil)} -> null`);
    }
    assert.strictEqual(readWriteguardSnapshot(proj, 'no-such-snap', { home }), null, 'miss -> null');
  } finally { clean(home, proj, outside); }
});

// ---------------------------------------------------------------------------
// SWEEP — run-gated session cleanup (NOT a bin, NOT a clock)
// ---------------------------------------------------------------------------

test('sweep: keeps the CURRENT session\'s snapshots, drops every prior session\'s — never touches bins', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md'); fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'old-session', gov, { home });
    snapshotOnFirstWrite(proj, 'current-session', gov, { home });
    // a sibling bin dir that must never be touched by the sweep.
    const bin = path.join(proj, '.claude', 'coalwash', 'fat-bin');
    fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'item'), 'x', 'utf8');

    const roots = fs.readdirSync(wgRoot(proj)).filter((n) => n !== '.gitignore').sort();
    assert.deepStrictEqual(roots, ['current-session', 'old-session']);
    sweepWriteguard(proj, 'current-session', { home });
    const after = fs.readdirSync(wgRoot(proj)).filter((n) => n !== '.gitignore');
    assert.deepStrictEqual(after, ['current-session'], 'only the current session survives');
    assert.strictEqual(fs.readFileSync(path.join(bin, 'item'), 'utf8'), 'x', 'the bin is untouched — writeguard is NOT a bin (0h-GUARD)');
  } finally { clean(home, proj); }
});

test('sweep: no writeguard dir yet, or a malformed session id, never throws', () => {
  const { home, proj } = sandbox();
  try {
    assert.doesNotThrow(() => sweepWriteguard(proj, 'sess', { home }));
    assert.doesNotThrow(() => sweepWriteguard(proj, null, { home }));
  } finally { clean(home, proj); }
});

test('SEATBELT_MAX_BYTES is a sane positive placeholder constant', () => {
  assert.ok(Number.isFinite(SEATBELT_MAX_BYTES) && SEATBELT_MAX_BYTES > 1024);
});

// G3-3's TWIN (2026-07-28). The bins and this door are one concept with two
// implementations. The snapshot itself was always byte-exact (copyFileSync);
// the READ-BACK went through 'utf8', so the recovery door re-encoded every
// non-UTF-8 byte as U+FFFD — while the CLI told the human "byte-exact original
// on stdout". This is the airbag: the ONLY undo net for a gitignored MEMORY.md.
test('G3-3 twin: readWriteguardSnapshot returns the ORIGINAL BYTES — a non-UTF-8 file is not transcoded by its own undo net', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-proj-')));
  try {
    const f = path.join(proj, 'MEMORY.md');
    // 0xE9 is 'e-acute' in CP1252 and is not valid UTF-8 — an ANSI-saved note.
    const bytes = Buffer.concat([Buffer.from('# memory\ncaf', 'ascii'), Buffer.from([0xe9]), Buffer.from('\n', 'ascii')]);
    fs.writeFileSync(f, bytes);
    const snapped = snapshotOnFirstWrite(proj, 'sess-g33', f, { home });
    assert.ok(snapped, `the airbag fired: ${JSON.stringify(snapped)}`);
    const rows = listWriteguard(proj, { home });
    assert.strictEqual(rows.length, 1, 'exactly one snapshot');
    const got = readWriteguardSnapshot(proj, rows[0].name, { home });
    assert.ok(got, 'the snapshot reads back');
    assert.deepStrictEqual(Buffer.from(got.content), bytes, 'the undo net hands back the bytes it caught — "byte-exact" must be true, not a claim');
    assert.strictEqual(got.bytes, bytes.length, 'the reported size is the real byte count');
  } finally { clean(home, proj); }
});
