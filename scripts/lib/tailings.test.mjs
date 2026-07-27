import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FAT_BIN_NAME, STORE_OLD_NAME,
  recordBinItem, listBin, restoreFromBin,
  sweepFatBin, sweepStoreOld, readDeathLog, breadcrumb,
} from './tailings.mjs';
import { txDirFor } from './apply.mjs';
import { TIER1_KEEP_ALL_MS, HORIZON_MS } from './retention.mjs';

function sandbox() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwbin-proj-')));
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
    const id = recordBinItem(proj, FAT_BIN_NAME, { content: 'old cut', original: 'notes/old.md', now: now - (HORIZON_MS.fat + 86400000) }); // 31 days old
    const r = sweepFatBin(proj, { now });
    assert.deepStrictEqual(r, { destroyed: 1, kept: 0 });
    assert.strictEqual(restoreFromBin(proj, FAT_BIN_NAME, id), null, 'gone');
    assert.strictEqual(listBin(proj, FAT_BIN_NAME).length, 0, 'dropped from the index');
    const log = readDeathLog(proj, FAT_BIN_NAME);
    assert.ok(log.includes(id), 'the death certificate names the destroyed id');
    // name/age/rule — the full certificate this module's own header always
    // promised; the AXIS that fired and the SOURCE FILENAME both survive the
    // index entry's deletion (the lab P8 audit-trail finding).
    assert.ok(/age 31d, rule horizon\) original notes\/old\.md/.test(log), log);
    // A legacy item with no recorded original still certifies (placeholder '-').
    const id2 = recordBinItem(proj, FAT_BIN_NAME, { content: 'anon', now: now - (HORIZON_MS.fat + 86400000) });
    sweepFatBin(proj, { now });
    assert.ok(new RegExp(`destroyed ${id2} \\(age 31d, rule horizon\\) original -`).test(readDeathLog(proj, FAT_BIN_NAME)), 'no recorded source degrades to "-", never a crash');
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
// 0i SIZE-CAP ∧ TIME-HORIZON, floor-ordered (3ded5ec) — the sweep's second
// limit: budget = BIN_BUDGET_STORE_MULTIPLE x opts.storeBytes (the measured
// store, never the disk). Byte pressure evicts only past the 48h keep-all
// floor; an under-floor bin over cap rides over it and reports (capConflict
// + a cap-conflict death-log line). No storeBytes = the cap inert
// (horizon-only, the exact pre-0i behavior every sweep test above already pins).
// ---------------------------------------------------------------------------

test('0i: recordBinItem records the item\'s byte weight at birth', () => {
  const proj = sandbox();
  try {
    recordBinItem(proj, FAT_BIN_NAME, { content: 'abcd' }); // 4 ASCII bytes
    assert.strictEqual(listBin(proj, FAT_BIN_NAME)[0].bytes, 4);
  } finally { clean(proj); }
});

test('0i + snapper floor: a bin whose UNDER-FLOOR items alone exceed the cap keeps ALL of them, grows past the cap, and reports the conflict (loud, in-return AND in the log)', () => {
  const proj = sandbox();
  try {
    // Pinned mid-week (~87h past the weekly epoch): wall-clock here flakes for
    // ~4h after every weekly boundary — weekOf() regroups items across it.
    const now = 1750000000000;
    // Four young items (all inside the 48h keep-all floor), 100 bytes each.
    const ids = [4, 3, 2, 1].map((h) => recordBinItem(proj, FAT_BIN_NAME, { content: 'x'.repeat(100), now: now - h * 3600000 }));
    // storeBytes 100 -> budget 200 (2x): 400 bytes over a 200 budget, but the
    // 48h keep-all floor is untouchable by byte pressure (the lab P5 kill,
    // inverted) -> nothing dies; the unsatisfiable cap is REPORTED.
    const r = sweepFatBin(proj, { now, storeBytes: 100 });
    assert.deepStrictEqual(r, { destroyed: 0, kept: 4, capConflict: { budgetBytes: 200, keptBytes: 400 } });
    const remaining = listBin(proj, FAT_BIN_NAME).map((i) => i.id);
    for (const id of ids) assert.ok(remaining.includes(id), `${id} survives under the floor`);
    const log = readDeathLog(proj, FAT_BIN_NAME);
    assert.ok(/cap-conflict/.test(log), 'the conflict lands in the audit log too');
    assert.ok(log.includes('400') && log.includes('200'), 'the audit line names kept vs budget bytes');
    assert.ok(!/destroyed \S+ \(age/.test(log), 'no death certificate — nothing died');
  } finally { clean(proj); }
});

test('P5/P8 end-to-end (own fixture, the lab shape): a 25h-old pre-surgery whole-store image SURVIVES a size-bound sweep; only floor-cleared items die, each certified with rule + original filename', () => {
  const proj = sandbox();
  try {
    const now = 1750000000000; // pinned mid-week (epoch-flake lesson)
    const DAY = 86400000;
    // store.old: the wizard bin. One 25h-old whole-store image (the P8
    // victim's age) + three older per-cut records on distinct days.
    const image = recordBinItem(proj, STORE_OLD_NAME, { content: 'W'.repeat(300), original: 'STORE-IMAGE.md', origin: 'wizard-cut', now: now - 25 * 3600000 });
    const old7d = recordBinItem(proj, STORE_OLD_NAME, { content: 'a'.repeat(200), original: 'seven.md', origin: 'wizard-cut', now: now - 7 * DAY });
    const old5d = recordBinItem(proj, STORE_OLD_NAME, { content: 'b'.repeat(200), original: 'five.md', origin: 'wizard-cut', now: now - 5 * DAY });
    const old3d = recordBinItem(proj, STORE_OLD_NAME, { content: 'c'.repeat(200), original: 'three.md', origin: 'wizard-cut', now: now - 3 * DAY });
    // storeBytes 250 -> budget 500; bin holds 900. Size pressure evicts the
    // floor-cleared OLDEST first (7d -> 700, then 5d -> 500 = under budget,
    // stop); 3d survives because pressure stopped; the 25h image is under the
    // floor -> untouchable (the exact kill the lab measured, now impossible).
    const r = sweepStoreOld(proj, { now, storeBytes: 250 });
    assert.deepStrictEqual(r, { destroyed: 2, kept: 2 }, 'cap satisfied without touching the floor -> no capConflict field at all');
    assert.strictEqual(restoreFromBin(proj, STORE_OLD_NAME, image), 'W'.repeat(300), 'the 25h pre-surgery image survives AND round-trips byte-exact');
    assert.strictEqual(restoreFromBin(proj, STORE_OLD_NAME, old3d), 'c'.repeat(200), 'the newest cut survives (retrievability anchor)');
    assert.strictEqual(restoreFromBin(proj, STORE_OLD_NAME, old7d), null);
    assert.strictEqual(restoreFromBin(proj, STORE_OLD_NAME, old5d), null);
    const log = readDeathLog(proj, STORE_OLD_NAME);
    // The death certificate carries the AXIS and the SOURCE FILENAME — the
    // id->file mapping survives destruction inside the certificate itself
    // (the lab's P8 audit-trail finding: "no filename, no rule").
    assert.ok(new RegExp(`destroyed ${old7d} \\(age 7d, rule size-cap\\) original seven\\.md`).test(log), log);
    assert.ok(new RegExp(`destroyed ${old5d} \\(age 5d, rule size-cap\\) original five\\.md`).test(log), log);
    assert.ok(!log.includes(image), 'the image was never destroyed — no certificate for it');
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
    const DAY = 86400000;
    // Both PAST the 48h floor (size pressure only reaches floor-cleared
    // items now) and exactly a day apart -> always distinct day slots.
    const oldId = recordBinItem(proj, FAT_BIN_NAME, { content: 'x'.repeat(300), now: now - 4 * DAY });
    const newId = recordBinItem(proj, FAT_BIN_NAME, { content: 'y'.repeat(100), now: now - 3 * DAY });
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

// ---------------------------------------------------------------------------
// 0h-GUARD MIRROR (station-3 finding). The bin functions are run-gated: they run
// inside a REAL run, never off a hook/timer. `retier.test.mjs` and
// `estate-archive.test.mjs` each pin their own engine that way; the BIN layer
// never got the same pin, and it just became load-bearing — recoverDangling now
// WRITES a bin entry before undoing a create, and recoverDangling sits at
// `cli.mjs gauge` Step 0. The invariant holds today (the conductor imports only
// config-load/config-schema/class-b/caliper/writeguard), but "holds today" with
// no test is exactly how the next import lands silently.
//
// The check is TRANSITIVE on purpose: a hook that imported apply.mjs or cli.mjs
// would inherit the bin writers without ever naming them, so grepping the hook
// text for 'recordbinitem' alone would pass while the door stood open.
// ---------------------------------------------------------------------------
test('0h-GUARD: no hook reaches a bin WRITER, directly or through apply/cli (grep hooks/ = 0)', () => {
  // URL-relative so this needs no repo-root helper and no extra import.
  const hooksUrl = new URL('../../hooks/', import.meta.url);
  // MATCH SYNTAX, NEVER A RAW SUBSTRING — this guard's first cut used
  // `content.includes(...)` and immediately flagged the conductor for the COMMENT
  // that documents its compliance ("NOT a bin sweep / no retention.mjs"). A guard
  // that fires on the sentence asserting the invariant is worse than none: the
  // next person deletes the comment to get green. Third instance of this exact
  // substring-FP family in this repo (root-provenance's `jroots` ⊃ `roots` was
  // the second), so it is matched as a CALL and as an import SPECIFIER.
  const BANNED_CALLS = /\b(recordBinItem|sweepFatBin|sweepStoreOld|recoverDangling)\s*\(/;
  // Modules that CARRY a bin writer. retention.mjs is deliberately NOT here: it
  // exports the retention POLICY (horizons, budget math) and destroys nothing —
  // banning it would ban the wrong thing and teach the next reader the wrong rule.
  const BANNED_MODULES = ['apply.mjs', 'cli.mjs', 'tailings.mjs'];
  let checked = 0;
  for (const d of fs.readdirSync(hooksUrl, { withFileTypes: true })) {
    if (!d.isFile() || !/\.(js|mjs|cjs)$/.test(d.name)) continue;
    checked++;
    const content = fs.readFileSync(new URL(d.name, hooksUrl), 'utf8');
    const call = BANNED_CALLS.exec(content);
    assert.ok(!call, `hooks/${d.name} CALLS ${call && call[1]} — destruction and bin population are RUN-GATED, never hook-driven (0h)`);
    // Only real import/require syntax has a quoted specifier, so prose can never
    // match here.
    const specs = [...content.matchAll(/(?:from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const mod of BANNED_MODULES) {
      assert.ok(!specs.some((s) => s.endsWith(mod)),
        `hooks/${d.name} imports ${mod}, which carries the bin writers transitively — the run-gate is a REACHABILITY property, not a spelling one (recoverDangling now WRITES a bin entry and sits at gauge Step 0)`);
    }
  }
  assert.ok(checked > 0, 'no hook files were scanned — a guard that scans nothing passes vacuously');
});
