import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepsPath, loadKeeps, recordKeep, globalKeepsPath, loadGlobalKeeps, recordGlobalKeep } from './keeps.mjs';
import { txDirFor } from './apply.mjs';

function sandbox() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome-')));
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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome2-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-proj-')));
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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-ghome3-')));
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
