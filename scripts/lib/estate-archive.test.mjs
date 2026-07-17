// Hermetic tests for estate-archive.mjs — the ULTRA estate tier (blueprint
// §19 P2 partial: compress + index + search + restore). Every test runs
// against a sandboxed HOME + project; the real ~/.claude is NEVER touched
// (the commission's hard boundary — the dir SHAPE is simulated, the one
// real-world check was the read-only `claude project --help` purge probe,
// documented in estate-archive.mjs's header).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveEstateCfg, resolveArchiveDir, chJournalGuard, listSessions,
  classifySessions, buildIndexRow, archiveSession, estateUltraScan,
  ultraBillLine, runEstate, runEstateReport, searchIndex, searchLines,
  restoreSession, ESTATE_INDEX_NAME, appendIndexRow, collectTombstones,
} from './estate-archive.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { acquireLock, globalLockPath } from './apply.mjs';
import { recordKeep } from './keeps.mjs';
import { CONFIG_SCHEMA, clampedRead, validateConfig } from './config-schema.mjs';

delete process.env.CLAUDE_CONFIG_DIR;

const DAY_MS = 86400000;
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwea-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwea-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function write(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function slugDirFor(home, proj) {
  return path.join(home, '.claude', 'projects', ccProjectSlug(proj));
}
function ageFile(p, ageDays, now = Date.now()) {
  const t = new Date(now - ageDays * DAY_MS);
  fs.utimesSync(p, t, t);
}
// A minimal CC-shaped transcript: timestamps + user/assistant turns.
function transcript(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
function fixtureTranscript() {
  return transcript([
    { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { role: 'user', content: 'Fix the Modloader wash pipeline in CoalWash please' }, cwd: 'x' },
    { type: 'assistant', timestamp: '2026-05-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on Modloader now. CoalWash gate holds.' }] } },
    { type: 'progress', timestamp: '2026-05-01T10:02:00Z' },
    { type: 'assistant', timestamp: '2026-05-01T10:03:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Modloader done.' }] } },
  ]);
}
// Seed one aged session (jsonl + meta sibling + tool-results overflow).
function seedSession(home, proj, id, ageDays, { content } = {}) {
  const slugDir = slugDirFor(home, proj);
  const jsonl = path.join(slugDir, `${id}.jsonl`);
  write(jsonl, content ?? fixtureTranscript());
  const meta = path.join(slugDir, `${id}.meta.json`);
  write(meta, '{"m":1}');
  const tool = path.join(slugDir, id, 'tool-results', 'r1.txt');
  write(tool, 'tool-output-'.repeat(10));
  for (const p of [jsonl, meta, tool]) ageFile(p, ageDays);
  return { jsonl, meta, tool };
}
function estateCfg(over = {}) {
  return { compressAfterDays: 14, purgeAfterDays: 180, deleteCold: false, archiveDir: '', indexEnabled: true, ...over };
}
// EXACTLY the key set CoalHearth's production writer persists (CoalHearth
// lib/state-snapshot.js buildStateSnapshot): status + checklist +
// modifiedFiles + inFlightAgents + activePlan — NO sessionId, ever. Nothing
// is imported from CH (hermetic); the shape is replicated so the fixture can
// never re-collude with a guard keyed on a field the sibling does not write
// (the MED-1 fixture-collusion lesson).
function chJournal(over = {}) {
  return JSON.stringify({
    status: 'in_progress',
    checklist: [{ step: 'wire the fix', done: false }],
    modifiedFiles: ['lib/thing.js'],
    inFlightAgents: [],
    activePlan: { goal: 'fix the thing', nextSteps: ['test it'], constraints: [] },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// config: schema clamp + ordering guard + archive dir resolution
// ---------------------------------------------------------------------------

test('config: estate clamps per sub-key — partial object fills defaults, an invalid sub-key degrades alone, unknown sub-key is a validate error', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'estate');
  assert.ok(spec, 'estate key present in the schema');
  assert.deepStrictEqual(clampedRead({}, 'estate'), spec.def, 'absent -> full defaults');
  assert.deepStrictEqual(
    clampedRead({ estate: { compressAfterDays: 7 } }, 'estate'),
    { ...spec.def, compressAfterDays: 7 },
    'partial object keeps the rest at defaults',
  );
  const clamped = clampedRead({ estate: { purgeAfterDays: -5, deleteCold: 'yes' } }, 'estate');
  assert.strictEqual(clamped.purgeAfterDays, 180, 'out-of-range int -> its own default');
  assert.strictEqual(clamped.deleteCold, false, 'wrong-typed bool -> its own default');
  assert.ok(validateConfig({ estate: { nope: 1 } }).some((e) => e.includes("unknown sub-key 'nope'")), 'unknown sub-key reported');
  assert.strictEqual(validateConfig({ estate: { compressAfterDays: 30 } }).length, 0, 'partial estate object is valid');
});

test('config: resolveEstateCfg ordering guard — an inverted purge<compress clamps purge UP (empty WARM band = less mutation, the safe direction); 0 stays never', () => {
  assert.strictEqual(resolveEstateCfg(estateCfg({ compressAfterDays: 100, purgeAfterDays: 50 })).purgeAfterDays, 100);
  assert.strictEqual(resolveEstateCfg(estateCfg({ purgeAfterDays: 0 })).purgeAfterDays, 0, '0 = never-COLD survives the guard');
});

test('config: resolveArchiveDir — "" and a RELATIVE dir both fall back to ~/.claude/coal/coalwash/estate-archive; an absolute dir is honored', () => {
  const { home } = sandbox();
  try {
    const def = path.join(home, '.claude', 'coal', 'coalwash', 'estate-archive');
    assert.strictEqual(resolveArchiveDir(estateCfg(), home), def);
    assert.strictEqual(resolveArchiveDir(estateCfg({ archiveDir: 'rel/dir' }), home), def, 'relative -> default (fail-safe)');
    const abs = path.join(home, 'elsewhere');
    assert.strictEqual(resolveArchiveDir(estateCfg({ archiveDir: abs }), home), path.resolve(abs));
  } finally { clean(home); }
});

// ---------------------------------------------------------------------------
// band classification
// ---------------------------------------------------------------------------

test('bands: mtime classifies active/warm/cold; the current session is ACTIVE regardless of age', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-fresh', 1);
    seedSession(home, proj, 'sess-warm', 30);
    seedSession(home, proj, 'sess-cold', 200);
    seedSession(home, proj, 'sess-current', 40); // old, but IS the caller's session

    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg(), currentSessionId: 'sess-current' });
    const band = Object.fromEntries(c.sessions.map((s) => [s.id, s.band]));
    assert.strictEqual(band['sess-fresh'], 'active', 'younger than compressAfterDays');
    assert.strictEqual(band['sess-warm'], 'warm');
    assert.strictEqual(band['sess-cold'], 'cold');
    assert.strictEqual(band['sess-current'], 'active', 'current-session guard is absolute');
  } finally { clean(home, proj); }
});

// --- MED-1: the CoalHearth guard, keyed on what CH ACTUALLY writes ---------

test('MED-1: a REAL-shaped CH in_progress journal (NO sessionId) with a FRESH mtime protects the newest session unit even when every transcript mtime reads old — and does NOT protect-everything', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-idle', 40);   // live-but-idle: transcript mtime reads old
    seedSession(home, proj, 'sess-older', 100); // a genuinely old sibling — must STILL archive
    write(path.join(proj, '.claude', 'coalhearth', 'session_handoff.json'), chJournal()); // just written = fresh mtime
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const band = Object.fromEntries(c.sessions.map((s) => [s.id, s.band]));
    assert.strictEqual(band['sess-idle'], 'active', 'fresh in_progress journal protects the NEWEST unit (fail toward protecting)');
    assert.strictEqual(band['sess-older'], 'warm', 'not protect-everything — older units still archive (ULTRA stays functional)');
    const g = chJournalGuard(proj);
    assert.strictEqual(g.inProgress, true);
    assert.strictEqual(g.sessionId, null, 'CH never persists sessionId — the guard must not require it');
  } finally { clean(home, proj); }
});

test('MED-1: a STALE in_progress journal (old mtime — a crashed months-old handoff) blocks nothing; the session archives end-to-end', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-idle', 40);
    const j = path.join(proj, '.claude', 'coalhearth', 'session_handoff.json');
    write(j, chJournal());
    ageFile(j, 40); // the journal itself is 40 days old — no live claim
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(c.sessions.find((s) => s.id === 'sess-idle').band, 'warm', 'a stale handoff must not freeze estate archiving forever');
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(res.archived.length, 1, 'archives end-to-end');
  } finally { clean(home, proj); }
});

test('MED-1: a future CH that DOES write sessionId gets id-exact protection regardless of freshness or which unit is newest', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-named', 40);
    seedSession(home, proj, 'sess-newer', 20);
    const j = path.join(proj, '.claude', 'coalhearth', 'session_handoff.json');
    write(j, chJournal({ sessionId: 'sess-named' }));
    ageFile(j, 40); // even stale: an id-NAMED in_progress handoff shields ITS session's resume material
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const band = Object.fromEntries(c.sessions.map((s) => [s.id, s.band]));
    assert.strictEqual(band['sess-named'], 'active', 'id match protects the named session');
    assert.strictEqual(band['sess-newer'], 'warm', 'a stale journal grants no newest-unit protection');
  } finally { clean(home, proj); }
});

test('bands: a session unit = jsonl + flat <sid>.* siblings + the <sid>/ dir; an orphan dir with no jsonl is NOT a session; a completed CH journal guards nothing', () => {
  const { home, proj } = sandbox();
  try {
    const slugDir = slugDirFor(home, proj);
    seedSession(home, proj, 'sess-a', 30);
    write(path.join(slugDir, 'orphan-dir', 'subagents', 'x.jsonl'), 'orphan'); // GH #59248 shape
    write(path.join(proj, '.claude', 'coalhearth', 'session_handoff.json'),
      chJournal({ status: 'completed' }));

    const l = listSessions({ projectRoot: proj, home });
    assert.strictEqual(l.sessions.length, 1, 'only the jsonl-anchored unit');
    const rels = l.sessions[0].files.map((f) => f.rel.split(path.sep).join('/')).sort();
    assert.deepStrictEqual(rels, ['sess-a.jsonl', 'sess-a.meta.json', 'sess-a/tool-results/r1.txt']);
    assert.strictEqual(chJournalGuard(proj).inProgress, false, 'completed journal = no guard');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// copy-verify-then-delete
// ---------------------------------------------------------------------------

test('archive success: originals gone, every .gz decompresses byte-exact, index row appended with the dig fields', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const origBytes = fs.readFileSync(files.jsonl);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.archived.length, 1);
    assert.strictEqual(res.failed.length, 0);
    for (const p of Object.values(files)) assert.ok(!fs.existsSync(p), `original deleted: ${p}`);
    const slug = ccProjectSlug(proj);
    const gz = path.join(res.archiveDir, slug, 'sess-warm.jsonl.gz');
    assert.ok(fs.existsSync(gz), 'archive written under <archiveDir>/<slug>/');
    assert.ok(zlib.gunzipSync(fs.readFileSync(gz)).equals(origBytes), 'archive round-trips byte-exact');

    const rows = fs.readFileSync(path.join(res.archiveDir, ESTATE_INDEX_NAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.sessionId, 'sess-warm');
    assert.strictEqual(r.projectSlug, slug);
    assert.strictEqual(r.startISO, '2026-05-01T10:00:00Z');
    assert.strictEqual(r.endISO, '2026-05-01T10:03:00Z');
    assert.strictEqual(r.msgCount, 3, 'user+assistant turns only (progress line skipped)');
    assert.ok(r.firstUserLine.startsWith('Fix the Modloader'), 'firstUserLine captured');
    assert.ok(r.topEntities.includes('Modloader') && r.topEntities.includes('CoalWash'), 'entities extracted');
    assert.strictEqual(r.bytes, res.archived[0].bytes);
  } finally { clean(home, proj); }
});

test('runBudget (maxSessionsPerRun): the ULTRA loop stops at a completed-unit boundary once the budget is reached — N archived, the rest budget-deferred, receipt names N/M, a SECOND run continues; every archived unit is whole (zero partial), every deferred original is untouched', () => {
  const { home, proj } = sandbox();
  try {
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
    const seeded = Object.fromEntries(ids.map((id) => [id, seedSession(home, proj, id, 30)]));
    const cfg = estateCfg({ runBudget: { maxSessionsPerRun: 2, maxBytesPerRun: 524288000 } });

    // run 1: budget 2 -> exactly 2 archived, 3 deferred, budgetReached
    const r1 = runEstate({ projectRoot: proj, home, estate: cfg });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.archived.length, 2, 'stopped at 2 (the budget) — never mid-unit');
    assert.strictEqual(r1.budgetDeferred, 3, 'the remaining 3 eligible units are deferred, not touched');
    assert.strictEqual(r1.budgetReached, true);
    assert.match(runEstateReport(r1), /archived 2\/5 eligible/, 'the receipt names N/M honestly');
    // the 2 archived units are WHOLE (originals gone, .gz round-trips); the 3
    // deferred units are byte-untouched (zero partial anywhere).
    const archivedIds = new Set(r1.archived.map((a) => a.id));
    let touched = 0;
    for (const id of ids) {
      const present = fs.existsSync(seeded[id].jsonl);
      if (archivedIds.has(id)) { assert.ok(!present, `archived ${id} original gone`); touched++; }
      else assert.ok(present, `deferred ${id} original untouched`);
    }
    assert.strictEqual(touched, 2, 'exactly the budgeted count was archived');

    // run 2 continues where run 1 stopped (the 3 survivors) -> 2 more archived
    const r2 = runEstate({ projectRoot: proj, home, estate: cfg });
    assert.strictEqual(r2.archived.length, 2, 'the second run picks up the remainder');
    assert.strictEqual(r2.budgetDeferred, 1);
    // run 3 finishes the last one, no budget hit
    const r3 = runEstate({ projectRoot: proj, home, estate: cfg });
    assert.strictEqual(r3.archived.length, 1);
    assert.strictEqual(r3.budgetReached, false, 'the tail run is under budget');
    for (const id of ids) assert.ok(!fs.existsSync(seeded[id].jsonl), `all 5 eventually archived: ${id}`);
  } finally { clean(home, proj); }
});

test('runBudget (maxBytesPerRun): a byte ceiling also stops at a unit boundary — the first eligible unit archives (0 < budget), the rest defer once bytesFreed crosses it', () => {
  const { home, proj } = sandbox();
  try {
    for (const id of ['b1', 'b2', 'b3']) seedSession(home, proj, id, 30);
    // 1-byte budget: before unit 1, bytesFreed 0 < 1 -> archive; after, bytesFreed > 1 -> defer the rest.
    const r = runEstate({ projectRoot: proj, home, estate: estateCfg({ runBudget: { maxSessionsPerRun: 100000, maxBytesPerRun: 1 } }) });
    assert.strictEqual(r.archived.length, 1, 'exactly one unit before the byte budget bites');
    assert.strictEqual(r.budgetDeferred, 2);
    assert.strictEqual(r.budgetReached, true);
  } finally { clean(home, proj); }
});

test('corrupted archive (verify mismatch): originals KEPT, partial .gz removed, failure reported — never a delete on a failed verify', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    // Inject a gzip that emits VALID gzip of the WRONG bytes -> byte-compare fails.
    const badGzip = () => zlib.gzipSync(Buffer.from('tampered'));
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg(), gzip: badGzip });

    assert.strictEqual(res.archived.length, 0);
    assert.strictEqual(res.failed.length, 1);
    assert.ok(res.failed[0].reason.includes('verify mismatch'));
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original kept: ${p}`);
    const slugDir = path.join(res.archiveDir, ccProjectSlug(proj));
    const leftovers = fs.existsSync(slugDir)
      ? fs.readdirSync(slugDir, { recursive: true }).filter((n) => String(n).endsWith('.gz')) : [];
    assert.deepStrictEqual(leftovers, [], 'partial archive cleaned up');
    assert.ok(!fs.existsSync(path.join(res.archiveDir, ESTATE_INDEX_NAME)), 'no index row for a failed session');
  } finally { clean(home, proj); }
});

test('mid-run interrupt (gzip throws on the 2nd file): every original intact — deletes are the LAST step per session', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    let calls = 0;
    const dyingGzip = (buf) => { if (++calls === 2) throw new Error('interrupted'); return zlib.gzipSync(buf); };
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg(), gzip: dyingGzip });

    assert.strictEqual(res.archived.length, 0);
    assert.strictEqual(res.failed.length, 1);
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original intact: ${p}`);
  } finally { clean(home, proj); }
});

test('external-writer guard: an original that changes between listing and delete aborts the session (originals kept)', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    // Simulate a live writer landing AFTER the listing snapshot.
    fs.appendFileSync(files.jsonl, JSON.stringify({ type: 'user', message: { content: 'late write' } }) + '\n');
    const r = archiveSession(sess, { slug: c.slug, archiveDir: path.join(home, 'arch'), gzip: zlib.gzipSync });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('changed during run'));
    assert.ok(fs.existsSync(files.jsonl), 'original kept');
  } finally { clean(home, proj); }
});

test('H4 durability: archiveSession fsyncs every .gz (writeDurable) BEFORE deleting the sole-copy originals', () => {
  const { home, proj } = sandbox();
  const realFsync = fs.fsyncSync;
  let fsyncCount = 0;
  fs.fsyncSync = (...a) => { fsyncCount++; return realFsync.apply(fs, a); };
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    const archiveDir = path.join(home, 'arch');
    const r = archiveSession(sess, { slug: c.slug, archiveDir, gzip: zlib.gzipSync });
    assert.strictEqual(r.ok, true, r.reason);
    const slugDir = path.join(archiveDir, ccProjectSlug(proj));
    const gz = fs.readdirSync(slugDir, { recursive: true }).map(String).filter((n) => n.endsWith('.gz'));
    assert.ok(gz.length >= 2, `.gz files written (${gz.length})`);
    // each .gz is fsync'd by writeDurable — file fsyncs dominate the count, so
    // >= gz.length holds only when the durable write is in place (the dir fsyncs
    // alone are fewer than the file count, and are a Windows no-op).
    assert.ok(fsyncCount >= gz.length, `every .gz fsync'd before delete (fsyncs ${fsyncCount} >= .gz ${gz.length})`);
    assert.strictEqual(fs.existsSync(files.jsonl), false, 'original deleted only after the durable archive');
  } finally { fs.fsyncSync = realFsync; clean(home, proj); }
});

test('#57(d) cloud-placeholder read poison (WARM): a session whose source is a dehydrated stub is SKIPPED (fail-closed), originals kept, nothing archived — never a copy-verify-delete on bytes we cannot truly read', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    const archiveDir = path.join(home, 'arch');
    // Inject the placeholder predicate (a real cloud placeholder cannot exist in
    // a sandbox): the jsonl reads as a dehydrated stub.
    const isPlaceholder = (p) => p === files.jsonl;
    const r = archiveSession(sess, { slug: c.slug, archiveDir, gzip: zlib.gzipSync, isPlaceholder });
    assert.strictEqual(r.ok, false, 'a placeholder source refuses the whole session');
    assert.ok(/cloud placeholder/.test(r.reason) && /#57d/.test(r.reason), r.reason);
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original kept: ${p}`);
    const slugDir = path.join(archiveDir, ccProjectSlug(proj));
    const anyGz = fs.existsSync(slugDir) ? fs.readdirSync(slugDir, { recursive: true }).map(String).filter((n) => n.endsWith('.gz')) : [];
    assert.deepStrictEqual(anyGz, [], 'nothing archived — no partial .gz left behind');
  } finally { clean(home, proj); }
});

// The ARCHIVE-side sibling of the external-writer guard above (originals side):
// a co-writer on a cross-volume / cloud-synced archiveDir clobbers an
// already-written+verified .gz in the wide write->delete window. ULTRA keeps
// NO snapshot, so the .gz is the SOLE handle — deleting the original with the
// .gz gone = silent byte loss. The delete-boundary re-verify must catch it.
test('archive-clobber TOCTOU (co-writer removes a verified .gz before the delete): the delete-boundary re-verify aborts — every original kept, no byte loss', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30); // 3 files: jsonl + meta + tool overflow
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    const archiveDir = path.join(home, 'arch');
    const slugDir = path.join(archiveDir, ccProjectSlug(proj));
    // A faithful stand-in for a sync client removing an already-verified .gz
    // between our synchronous fs calls: on the 2nd gzip, delete the .gz the
    // 1st file already wrote+verified. (In prod the co-writer acts at the OS
    // level in the same window; the seam makes the race deterministic.)
    let calls = 0;
    const clobberGzip = (buf) => {
      if (++calls === 2) {
        const gz = fs.readdirSync(slugDir, { recursive: true }).map(String).find((n) => n.endsWith('.gz'));
        if (gz) fs.rmSync(path.join(slugDir, gz), { force: true });
      }
      return zlib.gzipSync(buf);
    };
    const r = archiveSession(sess, { slug: c.slug, archiveDir, gzip: clobberGzip });
    assert.strictEqual(r.ok, false, 'aborts — the sole handle is gone, must not delete');
    assert.ok(/no longer verifies before delete/.test(r.reason), r.reason);
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original kept: ${p}`);
    // fail-closed cleanup: the surviving partial archive is swept too (nothing
    // half-written masquerades as a complete archive on a later restore).
    const leftovers = fs.existsSync(slugDir)
      ? fs.readdirSync(slugDir, { recursive: true }).map(String).filter((n) => n.endsWith('.gz')) : [];
    assert.deepStrictEqual(leftovers, [], 'partial archive cleaned up on abort');
  } finally { clean(home, proj); }
});

test('#56 loss class (delete_scope == verified_set): a file in <sid>/ NOT in the enumerated set SURVIVES the archive delete; the container is kept + the survivor surfaces in unpruned — never a whole-tree rm -rf', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    // A file lands under <sid>/ AFTER the listing snapshot (a walk that hit
    // SESSION_FILE_CAP, a post-listing writer, or a stat-skipped symlink): it is
    // NOT in sess.files, so enumerate+verify+delete never covers it. The old
    // rm -rf of <sid>/ destroyed it un-archived + unrecoverable.
    const slugDir = slugDirFor(home, proj);
    const survivor = path.join(slugDir, 'sess-warm', 'unindexed.jsonl');
    write(survivor, 'un-enumerated bytes that must survive');
    const r = archiveSession(sess, { slug: c.slug, archiveDir: path.join(home, 'arch'), gzip: zlib.gzipSync });
    assert.strictEqual(r.ok, true, 'the enumerated originals archive + delete normally');
    assert.ok(fs.existsSync(survivor), 'the un-enumerated file SURVIVES (delete-scope == verified-set)');
    assert.strictEqual(fs.readFileSync(survivor, 'utf8'), 'un-enumerated bytes that must survive', 'byte-exact, untouched');
    assert.ok(
      Array.isArray(r.unpruned) && r.unpruned.some((u) => u.split(path.sep).join('/').endsWith('sess-warm/unindexed.jsonl')),
      `the survivor is surfaced in unpruned (got ${JSON.stringify(r.unpruned)})`,
    );
    assert.ok(fs.existsSync(path.join(slugDir, 'sess-warm')), 'the <sid>/ container is kept because it is non-empty');
  } finally { clean(home, proj); }
});

test('#56: when <sid>/ ends fully empty after the enumerated deletes, the container AND its now-empty subdirs are swept (bottom-up rmdir), unpruned is [] — shared by WARM and deleteCold', () => {
  const { home, proj } = sandbox();
  try {
    // seedSession lays down <sid>/tool-results/r1.txt (all enumerated) — after the
    // deletes, tool-results/ and <sid>/ are empty and must be removed cleanly.
    seedSession(home, proj, 'sess-warm', 30);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(res.archived.length, 1);
    assert.deepStrictEqual(res.archived[0].unpruned, [], 'no survivors — every file was enumerated');
    assert.ok(!fs.existsSync(path.join(slugDirFor(home, proj), 'sess-warm')), 'empty container + empty subdirs swept');
    // deleteCold shares the SAME archiveSession removal code -> same guarantee.
    seedSession(home, proj, 'sess-cold', 200);
    const res2 = runEstate({ projectRoot: proj, home, estate: estateCfg({ deleteCold: true }) });
    const cold = res2.archived.find((a) => a.id === 'sess-cold');
    assert.deepStrictEqual(cold.unpruned, [], 'deleteCold path prunes the same way');
    assert.ok(!fs.existsSync(path.join(slugDirFor(home, proj), 'sess-cold')), 'cold container swept when empty');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// #57 write-side containment — archive DESTINATIONS (the GHSA-2hvf-7c8p-28fx
// mechanism: source enumeration contained, destination derivation not)
// ---------------------------------------------------------------------------

test('#57 (FILESYSTEM-SEMANTICS-ASSUMPTION / loss class #57): a session whose derived dest escapes the archive root is REFUSED before any write — nothing lands outside, originals kept, reason reported', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    // Craft the side-artifact escape: a rel that climbs OUT of <archiveDir>/<slug>/.
    // listSessions cannot produce this shape, but archiveSession must hold its
    // OWN invariant regardless of caller (the git lesson: the main target was
    // checked, the side-artifact path was not).
    sess.files[0] = { ...sess.files[0], rel: path.join('..', '..', 'outside', 'evil.jsonl') };
    const archiveDir = path.join(home, 'arch');
    const r = archiveSession(sess, { slug: c.slug, archiveDir, gzip: zlib.gzipSync });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /escapes the archive root/);
    assert.ok(!fs.existsSync(path.join(home, 'outside')), 'nothing landed outside the archive root');
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original kept: ${p}`);
  } finally { clean(home, proj); }
});

test('#57: a symlinked slug dir INSIDE the archive root redirecting outside is caught by the physical resolve — refused, nothing written through the link (junction = the unprivileged Windows shim)', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const c = classifySessions({ projectRoot: proj, home, estate: estateCfg() });
    const sess = c.sessions.find((s) => s.id === 'sess-warm');
    const archiveDir = path.join(home, 'arch');
    const outside = path.join(home, 'outside-target');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.symlinkSync(outside, path.join(archiveDir, c.slug), 'junction');
    const r = archiveSession(sess, { slug: c.slug, archiveDir, gzip: zlib.gzipSync });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /escapes the archive root/);
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'nothing written through the link');
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `original kept: ${p}`);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// #56639-class pin — deleteCold safe-default regression (the Archive-button
// drift: a UI/call-site layer silently hardcoding the destructive override)
// ---------------------------------------------------------------------------

test('#56639-class pin: the literal deleteCold:true appears in NO code line under scripts/ or skills/ outside test files — only the user config may flip it (comments/docs may NAME the lever; config-schema derives the default)', () => {
  const re = /deleteCold\s*:\s*true/;
  const walk = (dir, out) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, out);
      else if (/\.(mjs|js|cjs)$/.test(d.name) && !/\.test\.mjs$/.test(d.name)) out.push(p);
    }
    return out;
  };
  const files = [...walk(path.join(repoDir, 'scripts'), []), ...walk(path.join(repoDir, 'skills'), [])];
  assert.ok(files.length > 0, 'the walk found code files');
  for (const p of files) {
    const offenders = fs.readFileSync(p, 'utf8').split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => !line.trim().startsWith('//') && re.test(line))
      .map(({ i }) => `${p}:${i + 1}`);
    assert.deepStrictEqual(offenders, [], `deleteCold:true hardcoded in code (the destructive override belongs to the USER config alone): ${offenders.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// COLD band — report-only by default, archive-then-delete only on explicit deleteCold
// ---------------------------------------------------------------------------

test('deleteCold=false (default): a COLD session is NEVER touched — listed in the report, which names the first-party purge lever', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-cold', 200);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(res.coldListed.length, 1);
    assert.strictEqual(res.archived.length, 0);
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p), `cold original untouched: ${p}`);
    assert.ok(runEstateReport(res).includes('claude project purge'), 'report names the first-party lever');
  } finally { clean(home, proj); }
});

test('deleteCold=true (explicit): COLD archives-then-deletes with a death-certificate line and a cold-flagged index row', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-cold', 200);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg({ deleteCold: true }) });
    assert.strictEqual(res.archived.length, 1);
    assert.strictEqual(res.archived[0].cold, true);
    for (const p of Object.values(files)) assert.ok(!fs.existsSync(p), 'cold original deleted after verified archive');
    const cert = fs.readFileSync(path.join(res.archiveDir, ccProjectSlug(proj), 'death.log'), 'utf8');
    assert.ok(cert.includes('destroyed-cold sess-cold') && cert.includes('archived+verified first'), 'death certificate appended');
    const row = JSON.parse(fs.readFileSync(path.join(res.archiveDir, ESTATE_INDEX_NAME), 'utf8').trim());
    assert.strictEqual(row.cold, true);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// lock + run-gate + localOnly
// ---------------------------------------------------------------------------

test('lock: the global CoalWash lock held elsewhere -> deferred, nothing touched', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const other = acquireLock(globalLockPath(home), { sessionId: 'other-run' });
    assert.strictEqual(other.acquired, true);
    try {
      const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.deferred, true);
      assert.ok(fs.existsSync(files.jsonl), 'nothing touched while deferred');
    } finally { other.release(); }
  } finally { clean(home, proj); }
});

test('platform gate (armor #2): a non-Claude-Code home no-ops estateUltraScan + runEstate (conservative flag, nothing scanned); creating ~/.claude flips it back to scanning — keyed on detectPlatform, not a hardcode', () => {
  const { home, proj } = sandbox(); // sandbox() does NOT create ~/.claude
  const now = Date.now();
  try {
    // non-CC: detectPlatform === 'unknown' → explicit conservative no-op.
    const scan = estateUltraScan({ projectRoot: proj, home, now, estate: estateCfg() });
    assert.strictEqual(scan.platform, 'unknown');
    assert.ok(scan.flags.some((f) => f.includes('never auto-delete')), 'the verbatim conservative flag is surfaced');
    assert.strictEqual(scan.sessions, 0, 'no CC layout assumed — nothing scanned');
    const run = runEstate({ projectRoot: proj, home, now, estate: estateCfg() });
    assert.strictEqual(run.ok, true, 'a no-op is not an error');
    assert.strictEqual(run.platform, 'unknown');
    assert.strictEqual(run.archived.length, 0, 'nothing archived on a non-CC home');

    // flip: create ~/.claude + a WARM session → the gate now keys CC and scans/archives.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const { jsonl } = seedSession(home, proj, 'flip-sess', 30);
    const scan2 = estateUltraScan({ projectRoot: proj, home, now, estate: estateCfg() });
    assert.notStrictEqual(scan2.platform, 'unknown', 'a CC home is no longer gated');
    assert.ok(scan2.warm >= 1, 'the WARM session is now scanned');
    const run2 = runEstate({ projectRoot: proj, home, now, estate: estateCfg() });
    assert.ok(run2.archived.length >= 1, 'CC home: the session is archived');
    assert.strictEqual(fs.existsSync(jsonl), false, 'archived + deleted on the CC path');
  } finally { clean(home, proj); }
});

test('run-gate: no hook ever wires the estate mutators (0h-GUARD sibling — grep hooks/ must stay clean)', () => {
  const hooksDir = path.join(repoDir, 'hooks');
  for (const f of fs.readdirSync(hooksDir)) {
    if (!/\.(js|mjs|cjs)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(hooksDir, f), 'utf8');
    for (const name of ['estate-archive', 'runEstate', 'archiveSession', 'estateUltraScan']) {
      assert.ok(!src.includes(name), `${f} must not reference ${name} — ULTRA is wizard-consented only, never ambient`);
    }
  }
});

test('localOnly does NOT block ULTRA: a localOnly:true config still archives (no content-bearing sub exists; the engine never reads the key)', () => {
  const { home, proj } = sandbox();
  try {
    write(path.join(home, '.claude', '.coalwash.json'), JSON.stringify({ localOnly: true }));
    const files = seedSession(home, proj, 'sess-warm', 30);
    // The real CLI path (config load + clamp + run) via a child process, like the shipped commands run.
    const r = spawnSync(process.execPath, [path.join(repoDir, 'scripts', 'lib', 'cli.mjs'), 'estate-run'], {
      cwd: proj,
      env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: '' },
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, `estate-run exits 0 (stderr: ${r.stderr})`);
    assert.ok(r.stdout.includes('1 session(s) archived'), 'archived despite localOnly');
    assert.ok(!fs.existsSync(files.jsonl), 'original gone');
    // By-construction proof: the engine has no localOnly consumer — every
    // mention in estate-archive.mjs is a comment line, never code.
    const src = fs.readFileSync(path.join(repoDir, 'scripts', 'lib', 'estate-archive.mjs'), 'utf8');
    for (const line of src.split('\n')) {
      if (line.includes('localOnly')) assert.ok(line.trim().startsWith('//'), `localOnly must appear in comments only: ${line.trim()}`);
    }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// the dig doors — search + restore
// ---------------------------------------------------------------------------

test('estate-search: finds by entity and by firstUserLine text, case-insensitive; no match = the neutral line', () => {
  const { home, proj } = sandbox();
  try {
    seedSession(home, proj, 'sess-warm', 30);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(res.archived.length, 1);

    const byEntity = searchIndex('modloader', { archiveDir: res.archiveDir });
    assert.strictEqual(byEntity.length, 1, 'entity hit');
    const byFirstLine = searchIndex('wash pipeline', { archiveDir: res.archiveDir });
    assert.strictEqual(byFirstLine.length, 1, 'firstUserLine hit');
    assert.strictEqual(searchIndex('no-such-thing-xyz', { archiveDir: res.archiveDir }).length, 0);
    assert.ok(searchLines(byEntity).includes('sess-warm'));
    assert.ok(searchLines([]).includes('no match'));
  } finally { clean(home, proj); }
});

test('estate-restore: round-trips every file byte-exact to a scratch dir OUTSIDE the live tree; --to is honored; a traversal id is a clean error', () => {
  const { home, proj } = sandbox();
  try {
    const files = seedSession(home, proj, 'sess-warm', 30);
    const origJsonl = fs.readFileSync(files.jsonl);
    const origTool = fs.readFileSync(files.tool);
    const res = runEstate({ projectRoot: proj, home, estate: estateCfg() });

    const r = restoreSession('sess-warm', { archiveDir: res.archiveDir });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.files.length, 3);
    assert.ok(!r.dir.startsWith(path.join(home, '.claude')), 'default target is a scratch dir, never the live tree');
    assert.ok(fs.readFileSync(path.join(r.dir, 'sess-warm.jsonl')).equals(origJsonl), 'transcript byte-exact');
    assert.ok(fs.readFileSync(path.join(r.dir, 'sess-warm', 'tool-results', 'r1.txt')).equals(origTool), 'overflow byte-exact');
    clean(r.dir);

    const to = path.join(home, 'chosen-restore');
    const r2 = restoreSession('sess-warm', { archiveDir: res.archiveDir, to });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.dir, path.resolve(to));
    assert.ok(fs.existsSync(path.join(to, 'sess-warm.jsonl')));

    const bad = restoreSession('..' + path.sep + 'escape', { archiveDir: res.archiveDir });
    assert.strictEqual(bad.ok, false, 'traversal-shaped id rejected');
    assert.strictEqual(restoreSession('sess-unknown', { archiveDir: res.archiveDir }).ok, false, 'unknown session -> clean not-found');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// the bill (pre-consent scan) + index determinism
// ---------------------------------------------------------------------------

test('estateUltraScan + ultraBillLine: counts per band, MB now -> ~est after, names the archive dir; scan mutates nothing', () => {
  const { home, proj } = sandbox();
  try {
    const warm = seedSession(home, proj, 'sess-warm', 30);
    seedSession(home, proj, 'sess-fresh', 1);
    seedSession(home, proj, 'sess-cold', 200);
    const scan = estateUltraScan({ projectRoot: proj, home, estate: estateCfg() });
    assert.deepStrictEqual(
      { sessions: scan.sessions, active: scan.active, warm: scan.warm, cold: scan.cold },
      { sessions: 3, active: 1, warm: 1, cold: 1 },
    );
    assert.ok(scan.warmBytes > 0 && scan.estAfterBytes === Math.round(scan.warmBytes / 10));
    const line = ultraBillLine(scan);
    assert.ok(line.includes('~est 10:1') && line.includes(scan.archiveDir) && line.includes('report-only'));
    assert.ok(fs.existsSync(warm.jsonl), 'scan is read-only');
  } finally { clean(home, proj); }
});

test('buildIndexRow is deterministic and null-safe: same buffer -> same row; an unparseable/empty transcript degrades to null fields', () => {
  const buf = Buffer.from(fixtureTranscript());
  const a = buildIndexRow({ sessionId: 's', projectSlug: 'p', transcriptBuf: buf, totalBytes: 9, now: 0 });
  const b = buildIndexRow({ sessionId: 's', projectSlug: 'p', transcriptBuf: buf, totalBytes: 9, now: 0 });
  assert.deepStrictEqual(a, b, 'deterministic extraction');
  assert.ok(a.topEntities.length <= 10);
  const junk = buildIndexRow({ sessionId: 's', projectSlug: 'p', transcriptBuf: Buffer.from('not json\n{broken'), totalBytes: 2, now: 0 });
  assert.strictEqual(junk.msgCount, 0);
  assert.strictEqual(junk.firstUserLine, null);
  assert.strictEqual(junk.startISO, null);
  assert.deepStrictEqual(junk.topEntities, []);
});

test('#6 dig-index record-weighting: topEntities + firstUserLine are built from text/answer content ONLY — a thinking-part entity is DE-WEIGHTED TO ZERO (search noise), a text-part entity is kept (index/search quality; treatment stays whole-file byte-identity)', () => {
  const buf = Buffer.from(transcript([
    { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { role: 'user', content: 'Please help with ProjectAlpha' } },
    { type: 'assistant', timestamp: '2026-05-01T10:01:00Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'weighing ThinkingSecret versus DeepReasoning before I answer' },
      { type: 'text', text: 'Working on ProjectAlpha with the AnswerToken approach now.' },
    ] } },
  ]), 'utf8');
  const row = buildIndexRow({ sessionId: 's', projectSlug: 'slug', transcriptBuf: buf, totalBytes: buf.length, now: 0 });
  assert.ok(row.topEntities.includes('ProjectAlpha') && row.topEntities.includes('AnswerToken'), 'text/answer entities ARE indexed');
  assert.ok(!row.topEntities.includes('ThinkingSecret') && !row.topEntities.includes('DeepReasoning'), 'thinking-part entities are de-weighted to ZERO — never indexed (search noise)');
  assert.ok(row.firstUserLine.includes('ProjectAlpha'), 'firstUserLine is the user text');
  assert.ok(!row.firstUserLine.includes('ThinkingSecret'), 'no thinking leaks into the searchable first line');
});

test('#58 deletion-unaware restore (search): a dug-up row whose wording matches a gate-adjudicated keep anchor is ANNOTATED laterRemoved (advisory, STILL returned); an un-cut row is clean; the search never blocks', () => {
  const { home, proj } = sandbox();
  try {
    const archiveDir = path.join(home, 'arch');
    appendIndexRow(archiveDir, { sessionId: 'hit', projectSlug: 'p', firstUserLine: 'Investigate the SECRETLEGACYTOKEN rollback behavior', topEntities: ['SECRETLEGACYTOKEN'], bytes: 10, msgCount: 2 });
    appendIndexRow(archiveDir, { sessionId: 'clean', projectSlug: 'p', firstUserLine: 'Unrelated session about the login flow', topEntities: ['LoginFlow'], bytes: 10, msgCount: 2 });
    // the user later DELETED that fact — recorded as an adjudicated keep carrying the verbatim anchor
    recordKeep(proj, { target: 'MEMORY.md#legacy', anchor: 'SECRETLEGACYTOKEN', reason: 'removed', date: '2026-07-16' });
    const tombstones = collectTombstones({ projectRoot: proj, home });
    assert.ok(tombstones.anchors.some((a) => a.text === 'SECRETLEGACYTOKEN'), 'the keep anchor is in the registry');

    const hits = searchIndex('SECRETLEGACYTOKEN', { archiveDir, tombstones });
    assert.strictEqual(hits.length, 1, 'the search RETURNS the row — recovery is never blocked');
    assert.ok(Array.isArray(hits[0].laterRemoved) && hits[0].laterRemoved[0].anchor === 'SECRETLEGACYTOKEN', 'the row is annotated with the tombstone match');
    assert.match(searchLines(hits, { hasDeathLog: tombstones.hasDeathLog }), /later-removed\?.*SECRETLEGACYTOKEN/, 'the rendered line carries the advisory');

    const cleanRows = searchIndex('login', { archiveDir, tombstones });
    assert.strictEqual(cleanRows.length, 1);
    assert.strictEqual(cleanRows[0].laterRemoved, undefined, 'an un-cut fact is clean — no signal');
  } finally { clean(home, proj); }
});

test('#58 (restore): recovering a session whose FULL content holds pre-cut wording surfaces laterRemoved; recovery still succeeds; without a registry the restore is unannotated (backward-compatible)', () => {
  const { home, proj } = sandbox();
  try {
    const content = transcript([
      { type: 'user', timestamp: '2026-05-01T10:00:00Z', message: { role: 'user', content: 'do the thing' } },
      { type: 'assistant', timestamp: '2026-05-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'the SECRETLEGACYTOKEN was set to abc123 in that run' }] } },
    ]);
    seedSession(home, proj, 'sess-warm', 30, { content });
    const run = runEstate({ projectRoot: proj, home, estate: estateCfg() });
    assert.strictEqual(run.archived.length, 1);
    recordKeep(proj, { target: 'MEMORY.md', anchor: 'SECRETLEGACYTOKEN', date: '2026-07-16' });
    const tombstones = collectTombstones({ projectRoot: proj, home });

    const r = restoreSession('sess-warm', { archiveDir: run.archiveDir, to: path.join(home, 'restore-out'), tombstones });
    assert.strictEqual(r.ok, true, 'recovery succeeds byte-exact');
    assert.ok(Array.isArray(r.laterRemoved) && r.laterRemoved[0].anchor === 'SECRETLEGACYTOKEN', 'the restore is flagged laterRemoved');

    const r2 = restoreSession('sess-warm', { archiveDir: run.archiveDir, to: path.join(home, 'restore-out2') });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.laterRemoved, undefined, 'without a registry the restore is unannotated (unchanged behavior)');
  } finally { clean(home, proj); }
});
