import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAT_BIN_NAME, STORE_OLD_NAME,
  recordBinItem, listBin, restoreFromBin,
  sweepFatBin, sweepStoreOld, readDeathLog, breadcrumb,
} from './bins.mjs';
import { txDirFor } from './apply.mjs';
import { TIER1_KEEP_ALL_MS, HORIZON_MS } from './retention.mjs';

function sandbox() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwbin-proj-')));
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

test('recordBinItem: writes the content verbatim, records it in the index, self-ignores the tx dir', () => {
  const proj = sandbox();
  try {
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'cut prose', original: '/some/file.md' });
    assert.ok(id, 'an id is returned');
    const list = listBin(proj, FAT_BIN_NAME);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, id);
    assert.strictEqual(list[0].original, '/some/file.md');
    assert.strictEqual(list[0].origin, 'program-cut', 'the default origin');
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), 'cut prose');
    const gitignore = path.join(txDirFor(proj), FAT_BIN_NAME, '.gitignore');
    assert.ok(fs.existsSync(gitignore), 'the bin dir is self-ignored (never version-controlled, same as the tx dir)');
  } finally { clean(proj); }
});

test('recordBinItem: origin defaults to program-cut; wizard-cut is honored when passed; any other value falls back to program-cut', () => {
  const proj = sandbox();
  try {
    recordBinItem(proj, STORE_OLD_NAME, { content: 'pre-surgery image', origin: 'wizard-cut' });
    recordBinItem(proj, STORE_OLD_NAME, { content: 'x', origin: 'bogus' });
    const list = listBin(proj, STORE_OLD_NAME);
    assert.strictEqual(list[0].origin, 'wizard-cut');
    assert.strictEqual(list[1].origin, 'program-cut', 'an unrecognized origin value never persists garbage');
  } finally { clean(proj); }
});

test('recordBinItem: non-string content degrades to an empty stash, never throws', () => {
  const proj = sandbox();
  try {
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: undefined });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), '');
  } finally { clean(proj); }
});

test('listBin: an empty/never-used bin is []; restoreFromBin on a missing id is null, not empty string', () => {
  const proj = sandbox();
  try {
    assert.deepStrictEqual(listBin(proj, FAT_BIN_NAME), []);
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, 'never-existed'), null);
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, ''), null);
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, null), null);
  } finally { clean(proj); }
});

test('F1: restoreFromBin rejects every traversal-shaped id as a plain not-found — bare program-generated names only', () => {
  const proj = sandbox();
  try {
    // Plant a real item AND a reachable outside-the-bin victim file.
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'legit' });
    const victim = path.join(txDirFor(proj), 'victim.txt'); // one level above the bin dir
    fs.writeFileSync(victim, 'secret outside the bin', 'utf8');
    for (const evil of ['../victim.txt', '..\\victim.txt', victim, '/etc/passwd', 'C:\\Windows\\win.ini', '.', '..', 'a/b', 'a\\b']) {
      assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, evil), null, `traversal id ${JSON.stringify(evil)} must be a not-found, never a read`);
    }
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), 'legit', 'a legitimate flat id still round-trips');
  } finally { clean(proj); }
});

test('F1: a POISONED index.json (traversal-shaped ids) is filtered at load — the sweep never rm\'s outside the bin, listBin never surfaces it', () => {
  const proj = sandbox();
  try {
    const dir = path.join(txDirFor(proj), FAT_BIN_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(txDirFor(proj), 'victim.txt');
    fs.writeFileSync(victim, 'must survive', 'utf8');
    const now = Date.now();
    // Poisoned entries aimed outside the bin, old enough that retention would
    // destroy them if they were ever trusted — the recoverDangling-class
    // recovery-path shape (a poisoned artifact shipped inside a cloned repo).
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([
      { id: '../victim.txt', at: now - (HORIZON_MS.fat + 86400000), bytes: 10 },
      { id: '..', at: now - (HORIZON_MS.fat + 86400000), bytes: 10 },
    ]), 'utf8');
    assert.deepStrictEqual(listBin(proj, FAT_BIN_NAME), [], 'poisoned ids never surface');
    const r = sweepFatBin(proj, { now });
    assert.deepStrictEqual(r, { destroyed: 0, kept: 0 }, 'nothing trusted, nothing swept');
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'must survive', 'the out-of-bin file was never touched');
  } finally { clean(proj); }
});

test('listBin: PULL-ONLY — never called by anything automatically; a corrupt index degrades to [], never throws', () => {
  const proj = sandbox();
  try {
    const dir = path.join(txDirFor(proj), FAT_BIN_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json', 'utf8');
    assert.doesNotThrow(() => listBin(proj, FAT_BIN_NAME));
    assert.deepStrictEqual(listBin(proj, FAT_BIN_NAME), []);

    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(['garbage', 42, { noId: true }, { id: 'ok', at: 1 }]), 'utf8');
    assert.deepStrictEqual(listBin(proj, FAT_BIN_NAME), [{ id: 'ok', at: 1 }], 'malformed entries are filtered, never crash the read');
  } finally { clean(proj); }
});

test('sweepFatBin/sweepStoreOld: nothing to sweep is a harmless no-op', () => {
  const proj = sandbox();
  try {
    assert.deepStrictEqual(sweepFatBin(proj), { destroyed: 0, kept: 0 });
    assert.deepStrictEqual(sweepStoreOld(proj), { destroyed: 0, kept: 0 });
  } finally { clean(proj); }
});

test('sweepFatBin: an item inside the 48h keep-all tier survives untouched', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'recent cut', now: now - 3600000 }); // 1h old
    const r = sweepFatBin(proj, { now });
    assert.deepStrictEqual(r, { destroyed: 0, kept: 1 });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), 'recent cut', 'still readable after the sweep');
  } finally { clean(proj); }
});

test('sweepFatBin: an item past the 30-day fat horizon is destroyed — verified gone, dropped from the index, death-certified', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'old cut', now: now - (HORIZON_MS.fat + 86400000) }); // 31 days old
    const r = sweepFatBin(proj, { now });
    assert.deepStrictEqual(r, { destroyed: 1, kept: 0 });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), null, 'gone');
    assert.strictEqual(listBin(proj, FAT_BIN_NAME).length, 0, 'dropped from the index');
    const log = readDeathLog(proj, FAT_BIN_NAME);
    assert.ok(log.includes(id), 'the death certificate names the destroyed id');
    assert.ok(/age 31d/.test(log), log);
  } finally { clean(proj); }
});

test('sweepStoreOld: uses the 60-day horizon, independent of the fat bin\'s 30-day one (the SAME item age survives store.old but dies in fat)', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const age45d = now - 45 * 86400000;
    recordBinItem(proj, FAT_BIN_NAME, { content: 'x', now: age45d });
    recordBinItem(proj, STORE_OLD_NAME, { content: 'x', now: age45d });
    assert.deepStrictEqual(sweepFatBin(proj, { now }), { destroyed: 1, kept: 0 }, '45d > the 30d fat horizon');
    assert.deepStrictEqual(sweepStoreOld(proj, { now }), { destroyed: 0, kept: 1 }, '45d is still within the 60d store.old horizon');
  } finally { clean(proj); }
});

test('sweep: density thinning still applies within a bin — multiple same-day items collapse to the newest survivor once past the 48h tier', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const dayOld = now - (TIER1_KEEP_ALL_MS + 3600000); // just past the keep-all tier, inside the daily-thinning band
    recordBinItem(proj, FAT_BIN_NAME, { content: 'older-write', now: dayOld });
    recordBinItem(proj, FAT_BIN_NAME, { content: 'newer-write', now: dayOld + 1000 });
    const r = sweepFatBin(proj, { now });
    assert.strictEqual(r.kept, 1, 'same day-slot thins to one survivor');
    const survivors = listBin(proj, FAT_BIN_NAME);
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, survivors[0].id), 'newer-write', 'the newer write in the slot survives');
  } finally { clean(proj); }
});

// ---------------------------------------------------------------------------
// 0i SIZE-CAP ∧ TIME-HORIZON, whichever binds first — the sweep's second
// limit: budget = BIN_BUDGET_STORE_MULTIPLE x opts.storeBytes (the measured
// store, never the disk). No storeBytes = the cap inert (horizon-only, the
// exact pre-0i behavior every sweep test above already pins).
// ---------------------------------------------------------------------------

test('0i: recordBinItem records the item\'s byte weight at birth', () => {
  const proj = sandbox();
  try {
    recordBinItem(proj, FAT_BIN_NAME, { content: 'abcd' }); // 4 ASCII bytes
    assert.strictEqual(listBin(proj, FAT_BIN_NAME)[0].bytes, 4);
  } finally { clean(proj); }
});

test('0i: a bin over its store-proportional budget is density-thinned from the OLDEST until under — young keep-all items included ("before items even age"), death-certified', () => {
  const proj = sandbox();
  try {
    // Pinned mid-week (~87h past the weekly epoch): wall-clock here flakes for
    // ~4h after every weekly boundary — weekOf() regroups the 1-4h-old items
    // across it, shifting WHICH two evict (counts hold, identities don't).
    const now = 1750000000000;
    // Four young items (all inside the 48h keep-all tier), 100 bytes each.
    const ids = [4, 3, 2, 1].map((h) => recordBinItem(proj, FAT_BIN_NAME, { content: 'x'.repeat(100), now: now - h * 3600000 }));
    // storeBytes 100 -> budget 200 (2x): 400 bytes must thin to <= 200 ->
    // the two OLDEST die (ids[0] = 4h old, ids[1] = 3h old).
    const r = sweepFatBin(proj, { now, storeBytes: 100 });
    assert.deepStrictEqual(r, { destroyed: 2, kept: 2 });
    const remaining = listBin(proj, FAT_BIN_NAME).map((i) => i.id);
    assert.ok(!remaining.includes(ids[0]) && !remaining.includes(ids[1]), 'the two oldest were evicted');
    assert.ok(remaining.includes(ids[2]) && remaining.includes(ids[3]), 'the newer two survive');
    const log = readDeathLog(proj, FAT_BIN_NAME);
    assert.ok(log.includes(ids[0]) && log.includes(ids[1]), 'size-cap destruction is death-certified like any other');
  } finally { clean(proj); }
});

test('0i: the SAME over-budget bin swept WITHOUT storeBytes (store never measured) is horizon-only — the cap layer stays inert, keep-on-doubt', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    for (const h of [4, 3, 2, 1]) recordBinItem(proj, FAT_BIN_NAME, { content: 'x'.repeat(100), now: now - h * 3600000 });
    assert.deepStrictEqual(sweepFatBin(proj, { now }), { destroyed: 0, kept: 4 }, 'no measured store -> no budget -> nothing size-evicted');
    assert.deepStrictEqual(sweepFatBin(proj, { now, storeBytes: 0 }), { destroyed: 0, kept: 4 }, 'zero/malformed storeBytes degrades the same way');
  } finally { clean(proj); }
});

test('0i: a legacy (pre-0i) index entry without bytes is stat-weighed at sweep time, so it participates in the cap instead of escaping it forever', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const oldId = recordBinItem(proj, FAT_BIN_NAME, { content: 'x'.repeat(300), now: now - 7200000 });
    const newId = recordBinItem(proj, FAT_BIN_NAME, { content: 'y'.repeat(100), now: now - 3600000 });
    // Strip the bytes fields — the pre-0i index shape.
    const dir = path.join(txDirFor(proj), FAT_BIN_NAME);
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).map(({ bytes, ...rest }) => rest);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx), 'utf8');
    // storeBytes 100 -> budget 200: 400 on disk -> the older 300-byte item
    // must die even though the index never recorded its weight.
    const r = sweepFatBin(proj, { now, storeBytes: 100 });
    assert.deepStrictEqual(r, { destroyed: 1, kept: 1 });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, oldId), null, 'the stat-weighed legacy item was evicted');
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, newId), 'y'.repeat(100));
  } finally { clean(proj); }
});

test('sweep: a doubt case (a future `at`) is KEPT, never destroyed — the broom asymmetry', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    // NaN cannot be tested via a written index.json: JSON has no NaN
    // representation (JSON.stringify(NaN) -> null, which reads back as 0 —
    // a valid, very-old epoch timestamp, not a doubt case at all). A future
    // timestamp round-trips through JSON fine and IS one of
    // retentionPlan's own doubt cases (see retention-policy.test.mjs).
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'x', now: now + 86400000 });
    const r = sweepFatBin(proj, { now });
    assert.deepStrictEqual(r, { destroyed: 0, kept: 1 });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), 'x');
  } finally { clean(proj); }
});

test('sweep: the two bins are independent — sweeping one never touches the other', () => {
  const proj = sandbox();
  try {
    const now = Date.now();
    const oldId = recordBinItem(proj, STORE_OLD_NAME, { content: 'still young for store.old', now: now - 45 * 86400000 });
    recordBinItem(proj, FAT_BIN_NAME, { content: 'irrelevant', now });
    sweepFatBin(proj, { now });
    assert.strictEqual(restoreFromBin(proj, STORE_OLD_NAME, oldId), 'still young for store.old', 'sweeping the fat bin never touches store.old');
  } finally { clean(proj); }
});

test('readDeathLog: empty/missing log reads as "", never throws', () => {
  const proj = sandbox();
  try {
    assert.strictEqual(readDeathLog(proj, FAT_BIN_NAME), '');
  } finally { clean(proj); }
});

test('breadcrumb: a fixed, program-side template — names the bin path and the never-invent rule; never agent-composed prose', () => {
  const line = breadcrumb({ date: '2026-07-11', binPath: '.claude/coalwash/fat-bin/abc123' });
  assert.strictEqual(line, '<!-- washed 2026-07-11 · removed content recoverable at .claude/coalwash/fat-bin/abc123 — check the bin/journal before re-deriving; never invent a missing memory -->');
});

test('breadcrumb: missing date/binPath degrade to safe defaults, never throw', () => {
  assert.doesNotThrow(() => breadcrumb());
  const line = breadcrumb();
  assert.match(line, /^<!-- washed \d{4}-\d{2}-\d{2} · removed content recoverable at \.claude\/coalwash\/fat-bin — check the bin\/journal before re-deriving; never invent a missing memory -->$/);
});
