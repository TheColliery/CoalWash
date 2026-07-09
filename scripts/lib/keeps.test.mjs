import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepsPath, loadKeeps, recordKeep } from './keeps.mjs';
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
