import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepsPath, loadKeeps, recordKeep, globalKeepsPath, loadGlobalKeeps, recordGlobalKeep, pendingUserKeeps } from './keeps.mjs';
import { txDirFor } from './apply.mjs';

function sandbox() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('loadKeeps: [] when the file is missing, corrupt, or the wrong shape', () => {
  const proj = sandbox();
  try {
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    fs.writeFileSync(keepsPath(proj), '{ not json', 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.writeFileSync(keepsPath(proj), JSON.stringify({ not: 'the schema' }), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    fs.writeFileSync(keepsPath(proj), '', 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
    // a bare array (no schema wrapper) is not the shipped shape -> unreadable
    fs.writeFileSync(keepsPath(proj), JSON.stringify([{ target: 'x' }]), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), []);
  } finally { clean(proj); }
});

test('recordKeep: writes a retrievable entry; the shared sandbox dir self-ignores', () => {
  const proj = sandbox();
  try {
    const ok = recordKeep(proj, { target: 'dogfood-to-harden', reason: 'confirmed load-bearing 2026-07-09' });
    assert.strictEqual(ok, true);
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1);
    assert.strictEqual(keeps[0].target, 'dogfood-to-harden');
    assert.strictEqual(keeps[0].reason, 'confirmed load-bearing 2026-07-09');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(keeps[0].date), 'defaults to a YYYY-MM-DD date');
    const gi = path.join(txDirFor(proj), '.gitignore');
    assert.ok(fs.existsSync(gi), 'the shared sandbox dir self-ignores (privacy is code-enforced)');
    assert.strictEqual(fs.readFileSync(gi, 'utf8'), '*\n');
  } finally { clean(proj); }
});

test('recordKeep: re-adjudicating the SAME target upserts (no unbounded duplicate growth)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'first look', date: '2026-01-01' });
    recordKeep(proj, { target: 'x', reason: 'second look, still load-bearing', date: '2026-02-02' });
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1, 'the same target replaces, not accumulates');
    assert.strictEqual(keeps[0].reason, 'second look, still load-bearing');
    assert.strictEqual(keeps[0].date, '2026-02-02');
  } finally { clean(proj); }
});

test('recordKeep: multiple distinct targets coexist', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'a', reason: 'r1' });
    recordKeep(proj, { target: 'b', reason: 'r2' });
    const targets = loadKeeps(proj).map((k) => k.target).sort();
    assert.deepStrictEqual(targets, ['a', 'b']);
  } finally { clean(proj); }
});

test('recordKeep: refuses a missing/empty/non-string target, nothing written', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(recordKeep(proj, { reason: 'no target' }), false);
    assert.strictEqual(recordKeep(proj, { target: '' }), false);
    assert.strictEqual(recordKeep(proj, { target: 42 }), false);
    assert.strictEqual(recordKeep(proj), false);
    assert.strictEqual(fs.existsSync(keepsPath(proj)), false, 'nothing written on refusal');
  } finally { clean(proj); }
});

test('loadKeeps filters out malformed entries within an otherwise-valid keeps list', () => {
  const proj = sandbox();
  try {
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    fs.writeFileSync(keepsPath(proj), JSON.stringify({ v: 1, keeps: [{ target: 'ok' }, 'garbage', null, 42, { reason: 'no target field' }] }), 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), [{ target: 'ok' }]);
  } finally { clean(proj); }
});

test('keepsPath sits inside the same apply.mjs tx dir (<project>/.claude/coalwash/keeps.json)', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(keepsPath(proj), path.join(txDirFor(proj), 'keeps.json'));
  } finally { clean(proj); }
});

test('R5: the on-disk shape carries the schema version (v:1) so a future schema bump is detectable', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x' });
    const raw = JSON.parse(fs.readFileSync(keepsPath(proj), 'utf8'));
    assert.strictEqual(raw.v, 1);
    assert.ok(Array.isArray(raw.keeps));
  } finally { clean(proj); }
});

test('R5: a NEWER-schema keeps.json is READ-ONLY — loadKeeps [], recordKeep refuses, bytes untouched', () => {
  const proj = sandbox();
  try {
    fs.mkdirSync(txDirFor(proj), { recursive: true });
    const futureBytes = JSON.stringify({ v: 99, keeps: [{ target: 'future-thing', futureField: { nested: true } }] });
    fs.writeFileSync(keepsPath(proj), futureBytes, 'utf8');
    assert.deepStrictEqual(loadKeeps(proj), [], 'a newer schema is unreadable to this version, never guessed at');
    assert.strictEqual(recordKeep(proj, { target: 'y' }), false, 'an older tool must not rewrite a newer artifact');
    assert.strictEqual(fs.readFileSync(keepsPath(proj), 'utf8'), futureBytes, 'the newer file is byte-untouched');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// GLOBAL keeps (design-pass item, MEMORY.md "THE SHARED GLOBAL SLICE"): same
// shape/schema/upsert semantics, filed beside the global state file so an
// adjudicated keep on a global target shields it machine-wide.
// ---------------------------------------------------------------------------

test('global keeps: recordGlobalKeep writes beside the global state file, independent of any project', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome-')));
  try {
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    const ok = recordGlobalKeep(home, { target: 'global-claude-md-section', reason: 'shields it machine-wide' });
    assert.strictEqual(ok, true);
    const keeps = loadGlobalKeeps(home);
    assert.strictEqual(keeps.length, 1);
    assert.strictEqual(keeps[0].target, 'global-claude-md-section');
    assert.strictEqual(keeps[0].reason, 'shields it machine-wide');
    assert.ok(fs.existsSync(globalKeepsPath(home)));
    assert.strictEqual(globalKeepsPath(home), path.join(home, '.claude', '.coalwash-global-keeps.json'));
  } finally { clean(home); }
});

test('global keeps: upserts by target (same as the project store) and stays fully isolated from any project keeps.json', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome2-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
  try {
    recordGlobalKeep(home, { target: 'x', reason: 'first look', date: '2026-01-01' });
    recordGlobalKeep(home, { target: 'x', reason: 'second look, still load-bearing', date: '2026-02-02' });
    assert.strictEqual(loadGlobalKeeps(home).length, 1, 'the same target replaces, not accumulates');
    assert.strictEqual(loadGlobalKeeps(home)[0].reason, 'second look, still load-bearing');

    recordKeep(proj, { target: 'x', reason: 'project-local, unrelated' }); // same target NAME, different store
    assert.strictEqual(loadKeeps(proj).length, 1);
    assert.strictEqual(loadKeeps(proj)[0].reason, 'project-local, unrelated');
    assert.strictEqual(loadGlobalKeeps(home).length, 1, 'the project write never touched the global store');
    assert.strictEqual(loadGlobalKeeps(home)[0].reason, 'second look, still load-bearing');
  } finally { clean(home, proj); }
});

test('global keeps: [] on missing/corrupt/wrong-shape/newer-schema, same conservative behavior as the project store', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome3-')));
  try {
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    fs.mkdirSync(path.dirname(globalKeepsPath(home)), { recursive: true });
    fs.writeFileSync(globalKeepsPath(home), '{ not json', 'utf8');
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    const futureBytes = JSON.stringify({ v: 99, keeps: [{ target: 'future' }] });
    fs.writeFileSync(globalKeepsPath(home), futureBytes, 'utf8');
    assert.deepStrictEqual(loadGlobalKeeps(home), []);
    assert.strictEqual(recordGlobalKeep(home, { target: 'y' }), false, 'an older tool must not rewrite a newer artifact');
    assert.strictEqual(fs.readFileSync(globalKeepsPath(home), 'utf8'), futureBytes, 'the newer file is byte-untouched');
  } finally { clean(home); }
});

test('recordKeep persists the beta.12 enforcement handle (anchor + anchorFile); a handle-less keep stays the old shape', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'adjudicated', anchor: 'the exact protected span', anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'plain', reason: 'advisory only' });
    const keeps = loadKeeps(proj);
    const armed = keeps.find((k) => k.target === 'f.md:clause');
    assert.strictEqual(armed.anchor, 'the exact protected span');
    assert.strictEqual(armed.anchorFile, 'C:/store/f.md');
    const plain = keeps.find((k) => k.target === 'plain');
    assert.ok(!('anchor' in plain) && !('anchorFile' in plain), 'no undefined-field pollution on the pre-beta.12 shape');
  } finally { clean(proj); }
});

// grad6 W3-K2 (CoalBoard verdict): re-affirming an already-enforced keep
// (bumping just reason/date, the ordinary re-review shape) used to REBUILD
// the entry from only this call's own arguments -- omitting anchor/anchorFile
// silently downgraded it from mechanically ENFORCED to merely advisory, with
// no flag anywhere. Driven exactly as the wave drove it: record with an
// anchor, re-affirm without one, and the anchor must SURVIVE.
test('recordKeep: re-affirming WITHOUT anchor/anchorFile preserves the prior enforcement handle (never a silent downgrade)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first adjudication', anchor: 'the exact protected span', anchorFile: 'C:/store/f.md' });
    const reAffirmed = recordKeep(proj, { target: 'f.md:clause', reason: 'second look, still load-bearing', date: '2026-08-01' });
    assert.strictEqual(reAffirmed, true);
    const keeps = loadKeeps(proj);
    assert.strictEqual(keeps.length, 1);
    const entry = keeps[0];
    assert.strictEqual(entry.reason, 'second look, still load-bearing', 'the new reason/date must land');
    assert.strictEqual(entry.date, '2026-08-01');
    assert.strictEqual(entry.anchor, 'the exact protected span', 'the anchor must survive a re-affirm that did not supply one');
    assert.strictEqual(entry.anchorFile, 'C:/store/f.md', 'the anchorFile must survive too');
  } finally { clean(proj); }
});

test('recordKeep: a re-affirm that DOES supply a new anchor overrides (an intentional update, not a downgrade)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'f.md:clause', reason: 'first', anchor: 'old span', anchorFile: 'C:/store/f.md' });
    recordKeep(proj, { target: 'f.md:clause', reason: 'moved', anchor: 'new span', anchorFile: 'C:/store/f2.md' });
    const entry = loadKeeps(proj).find((k) => k.target === 'f.md:clause');
    assert.strictEqual(entry.anchor, 'new span');
    assert.strictEqual(entry.anchorFile, 'C:/store/f2.md');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// PENDING-USER (board #129, THE USER-OWNED CLASS): a keep whose own reason
// names the user as decision-holder must not settle silently. Opposite
// clearing rule from anchor/anchorFile on purpose (see keeps.mjs's own
// comment) -- undefined preserves, explicit false clears, explicit true sets.
// ---------------------------------------------------------------------------

test('recordKeep: pendingUser:true persists with a pendingSince date; plain keeps carry neither field', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'user-owned-thing', reason: 'this is the user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    recordKeep(proj, { target: 'plain', reason: 'ordinary agent-decided keep' });
    const keeps = loadKeeps(proj);
    const pending = keeps.find((k) => k.target === 'user-owned-thing');
    assert.strictEqual(pending.pendingUser, true);
    assert.strictEqual(pending.pendingSince, '2026-08-23');
    const plain = keeps.find((k) => k.target === 'plain');
    assert.ok(!('pendingUser' in plain) && !('pendingSince' in plain), 'no field pollution on an ordinary keep');
  } finally { clean(proj); }
});

test('recordKeep: re-affirming WITHOUT mentioning pendingUser PRESERVES it (the standing violation must not silently re-settle)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    // an ordinary re-affirm from a caller that has never heard of this mechanism
    const reAffirmed = recordKeep(proj, { target: 'x', reason: 'user own tradeoff, re-reviewed', date: '2026-09-01' });
    assert.strictEqual(reAffirmed, true);
    const entry = loadKeeps(proj).find((k) => k.target === 'x');
    assert.strictEqual(entry.reason, 'user own tradeoff, re-reviewed', 'the new reason must still land');
    assert.strictEqual(entry.pendingUser, true, 'pendingUser must survive an omit -- this is the whole point of the mechanism');
    assert.strictEqual(entry.pendingSince, '2026-08-23', 'the ORIGINAL pendingSince survives too, never reset by an unrelated re-affirm');
  } finally { clean(proj); }
});

test('recordKeep: pendingUser:false EXPLICITLY clears it (the only way -- the user actually answered)', () => {
  const proj = sandbox();
  try {
    recordKeep(proj, { target: 'x', reason: 'user own tradeoff', pendingUser: true, pendingSince: '2026-08-23' });
    recordKeep(proj, { target: 'x', reason: 'user confirmed keep, 2026-09-01', pendingUser: false });
    const entry = loadKeeps(proj).find((k) => k.target === 'x');
    assert.ok(!('pendingUser' in entry) && !('pendingSince' in entry), 'an explicit false clears both fields');
  } finally { clean(proj); }
});

test('pendingUserKeeps: filters to exactly the pending entries, [] on none/malformed input', () => {
  assert.deepStrictEqual(pendingUserKeeps([]), []);
  assert.deepStrictEqual(pendingUserKeeps(null), []);
  assert.deepStrictEqual(pendingUserKeeps(undefined), []);
  const list = [
    { target: 'a', pendingUser: true },
    { target: 'b' },
    { target: 'c', pendingUser: false },
    { target: 'd', pendingUser: 'true' }, // truthy string is NOT the boolean -- must not match
  ];
  assert.deepStrictEqual(pendingUserKeeps(list).map((k) => k.target), ['a']);
});

// U7 (CB board 2026-08-31) -- the same alias-at-the-temp class apply.mjs's
// writeDurable carries, at the SECONDARY sites the board's sweep clause points
// at. keeps.json lives in the PROJECT tree (txDirFor), the same trust zone as a
// class-B memory file: anything with project write access can pre-place an
// alias. The old temp was `<file>.tmp`, fully derivable, written with a plain
// writeFileSync -- which follows it. Cure = CSPRNG suffix + flag 'wx'.
//
// A hardlink is the unprivileged stand-in for the EPERM-blocked file symlink on
// this box; it aliases an inode the same way for a write.
function hardlinkCapable() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-hlprobe-'));
  try {
    const a = path.join(d, 'a');
    fs.writeFileSync(a, 'x');
    fs.linkSync(a, path.join(d, 'b'));
    return true;
  } catch {
    return false;
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

test('U7: recordKeep never writes THROUGH an alias planted at its temp -- the file outside the project is untouched and the record fails closed', (t) => {
  // ONE skippable leg, capability-PROBED: without hardlink creation the plant
  // cannot be built, so the test would pass vacuously rather than prove anything.
  if (!hardlinkCapable()) { t.skip('this volume refuses hardlink creation -- the unprivileged stand-in for the EPERM-blocked file symlink cannot be planted here'); return; }
  const proj = sandbox();
  const victim = path.join(proj, 'VICTIM-outside-the-store.txt');
  fs.writeFileSync(victim, 'VICTIM ORIGINAL', 'utf8');
  const realWrite = fs.writeFileSync;
  let planted = null;
  fs.writeFileSync = (p, ...rest) => {
    if (planted === null && typeof p === 'string' && p.includes('.tmp')) {
      planted = p;
      try { fs.linkSync(victim, p); } catch { /* a pre-existing entry is itself the fail-closed case */ }
    }
    return realWrite(p, ...rest);
  };
  let ok;
  try {
    ok = recordKeep(proj, { target: 'MEMORY.md', reason: 'u7' });
  } finally { fs.writeFileSync = realWrite; }
  try {
    assert.ok(planted, 'the plant fired (a temp path was written) -- otherwise this test proves nothing');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'VICTIM ORIGINAL', 'the file outside the project is UNTOUCHED (pre-fix the plain write follows the planted alias and truncates it)');
    assert.strictEqual(ok, false, 'the record fails closed on EEXIST at the O_EXCL temp, never silently through the alias');
    assert.deepStrictEqual(loadKeeps(proj), [], 'and nothing was recorded');
  } finally { clean(proj); }
});
