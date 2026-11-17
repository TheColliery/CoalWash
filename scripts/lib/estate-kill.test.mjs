// 29he fire 772 (PATCH 1.19.2, CW-070): the archive's index, its refused commit, its duplicate generation and its restore refusals.
// O-2 and O-1 are KILL legs: a child process runs the shipped runEstate and is killed (SIGKILL on itself, so no finally or exit
// handler runs) at one point; the next run, 31 minutes later (past the 30-minute stale-lock bound, which the killed child's lock needs),
// is checked. Every test runs in its own sandbox under the real temp folder (the ESTATE BAN): no real store, no real ~/.claude, no real
// transcript; a child gets an allowlisted environment (sandbox HOME, USERPROFILE, TEMP, TMP, TMPDIR; no CLAUDE_* key), a heap cap and a
// kill timeout.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEstate, runEstateReport, restoreSession, searchIndex, currentRows, resolveArchiveDir } from './estate-archive.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { acquireLock, globalLockPath, LOCK_STALE_MS } from './apply.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
const DAY = 86400000;
const LATER = 31 * 60 * 1000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = path.join(REPO, 'scripts', 'lib', 'estate-archive.mjs');
const TEMP = fs.realpathSync.native(os.tmpdir());
const SID = 'c7727727-7727-4772-8772-772772772772';
const PREFIX = 'cw-estate-772-';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, PREFIX)));
  const rel = path.relative(TEMP, root);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(root).startsWith(PREFIX)) throw new Error(`sandbox root ${root} is not a ${PREFIX} folder inside ${TEMP}`);
  t.after(() => {
    if (path.dirname(root) !== TEMP || !path.basename(root).startsWith(PREFIX)) throw new Error(`refusing to remove ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# fixture\n');
  const projDir = path.join(home, '.claude', 'projects', ccProjectSlug(proj));
  fs.mkdirSync(projDir, { recursive: true });
  return { root, home, proj, projDir, archiveDir: resolveArchiveDir({}, home), out: path.join(root, 'out') };
}
const line = (i, text) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: `2026-09-01T10:0${i}:00Z`, message: { role: i % 2 ? 'assistant' : 'user', content: text } });
const ORIGINAL = [line(0, 'Fix the gauge CW772-NEEDLE'), line(1, 'Working on the gauge'), line(2, 'The middle line, said once'), line(3, 'Gauge done')].join('\n') + '\n';
const V2 = ORIGINAL.replace('The middle line, said once', 'The middle line, said differently');
const transcriptPath = (s) => path.join(s.projDir, `${SID}.jsonl`);
function seed(s, content) {
  const p = transcriptPath(s);
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(p, t, t);
}
const run = (s, now = Date.now()) => runEstate({ projectRoot: s.proj, home: s.home, estate: {}, now });
const gzPathOf = (s) => path.join(s.archiveDir, ccProjectSlug(s.proj), `${SID}.jsonl.gz`);
function restoreText(s, opts = {}) {
  const to = path.join(s.out, `${opts.generation ?? 'current'}-${crypto.randomBytes(4).toString('hex')}`);
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to, ...opts });
  const p = path.join(to, `${SID}.jsonl`);
  return r.ok && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; // a generation can hold another file of the session and no transcript
}
const filesUnder = (dir, re) => {
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (re.test(e.name)) out.push(p); } };
  walk(dir);
  return out.sort();
};
// archive ORIGINAL, put it back live, rewrite it as V2 (not a superset), so the next archive keeps ORIGINAL as generation 1
function archiveThenRewrite(s) {
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seed(s, V2);
}

// The kill child: the shipped runEstate, one fs call wrapped to kill the process right after it runs.
const CHILD = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [engine, projectRoot, home, mode, target, marker] = process.argv.slice(2);
// fire 784 (t338 F2): the marker is written just before the kill, so the test knows the kill point was reached
const die = () => { fs.writeFileSync(marker, 'reached'); process.kill(process.pid, 'SIGKILL'); for (;;) { /* never past the kill */ } };
if (mode === 'throw-first') throw new Error('a broken harness: the child stops before it reaches any kill point');
const realRm = fs.rmSync;
const realRename = fs.renameSync;
if (mode === 'after-delete') fs.rmSync = function (p, ...r) { const out = realRm.call(fs, p, ...r); if (path.resolve(String(p)) === path.resolve(target)) die(); return out; };
if (mode === 'after-gen-rename') fs.renameSync = function (a, b, ...r) { const out = realRename.call(fs, a, b, ...r); if (/[.]gz[.]gen[0-9]+$/.test(String(b))) die(); return out; };
let commits = 0; // after-commit-rename: the Nth rename of a staged copy onto its final name (a kept generation or a newest copy)
if (mode === 'after-commit-rename') fs.renameSync = function (a, b, ...r) { const out = realRename.call(fs, a, b, ...r); if (/[.]coalwash-new$/.test(String(a)) && ++commits === Number(target)) die(); return out; };
const ea = await import(pathToFileURL(engine).href);
ea.runEstate({ projectRoot, home, estate: {} });
process.exitCode = 3; // reached only when the kill point never fired
`;
function killedRun(s, mode, target = '') {
  const child = path.join(s.root, 'kill-child.mjs');
  fs.writeFileSync(child, CHILD);
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT,
    HOME: s.home, USERPROFILE: s.home, TEMP: path.join(s.root, 'tmp'), TMP: path.join(s.root, 'tmp'), TMPDIR: path.join(s.root, 'tmp'),
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  const marker = path.join(s.root, 'kill-marker');
  fs.rmSync(marker, { force: true });
  const c = spawnSync(process.execPath, [child, ENGINE, s.proj, s.home, mode, target, marker], { cwd: s.proj, env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  assert.strictEqual(c.error, undefined, `the child ran and ended within its time (error: ${c.error && c.error.code})`);
  assert.notStrictEqual(c.status, 3, `the kill point fired (stderr: ${c.stderr})`);
  assert.notStrictEqual(c.status, 0, `the child was killed, not finished (stderr: ${c.stderr})`);
  assert.ok(fs.existsSync(marker), `the kill point was reached: the child wrote its marker just before the kill (status ${c.status}, stderr: ${c.stderr})`);
  return c;
}

test('O-2: a run killed after deleting a session and before its index row leaves it findable: the next run adds the row', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  killedRun(s, 'after-delete', transcriptPath(s));
  assert.strictEqual(fs.existsSync(transcriptPath(s)), false, 'the original was deleted before the kill');
  assert.strictEqual(fs.existsSync(gzPathOf(s)), true, 'the archive copy was committed before the kill');
  assert.strictEqual(searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).length, 0, 'the kill left no row');
  const res = run(s, Date.now() + LATER);
  const rows = searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir });
  assert.strictEqual(rows.length, 1, `the next run made the session findable (${JSON.stringify(res)})`);
  assert.strictEqual(rows[0].sessionId, SID);
  assert.strictEqual(rows[0].transcriptGzSha256, sha(fs.readFileSync(gzPathOf(s))), 'the row names the archive copy it describes');
  assert.strictEqual(res.reconciledRows, 1);
  assert.match(runEstateReport(res), /INDEXED: 1 archived session\(s\) had no index row/);
  assert.strictEqual(run(s, Date.now() + 2 * LATER).reconciledRows, undefined, 'a later run adds no second row');
  assert.strictEqual(searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).length, 1);
});

test('O-2 with F4: a re-archive killed before its row; the next run adds the row, and the earlier row is labelled with the generation that holds its copy', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  killedRun(s, 'after-delete', transcriptPath(s));
  run(s, Date.now() + LATER);
  const rows = searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir });
  assert.strictEqual(rows.length, 2, `the current copy and the kept generation are both findable: ${JSON.stringify(rows)}`);
  const current = rows.find((r) => r.generation === undefined);
  const earlier = rows.find((r) => r.generation === 1);
  assert.ok(current && current.transcriptGzSha256 === sha(fs.readFileSync(gzPathOf(s))), 'one row describes the current copy');
  assert.ok(earlier, 'the earlier row is labelled generation 1');
  assert.strictEqual(restoreText(s, { generation: 1 }), ORIGINAL, 'generation 1 is the copy that row describes');
  assert.strictEqual(restoreText(s), V2);
});

test('F4: a generation label is given only when the replacing row names the earlier row\'s own copy, never by position (a missing row)', () => {
  const r1 = { sessionId: 'x', projectSlug: 'p', transcriptGzSha256: 'A', firstUserLine: 'one' };
  const r3 = { sessionId: 'x', projectSlug: 'p', transcriptGzSha256: 'C', replacedGeneration: 2, replacedTranscriptGzSha256: 'B' }; // the row for copy B is missing
  const out = currentRows([r1, r3]);
  assert.ok(!out.some((r) => r.transcriptGzSha256 === 'A' && r.generation === 2), `copy A is not labelled as generation 2, which holds copy B: ${JSON.stringify(out)}`);
  assert.deepStrictEqual(out.map((r) => r.transcriptGzSha256), ['C'], 'the row that matches nothing is not shown as an earlier copy');
  const r2 = { sessionId: 'x', projectSlug: 'p', transcriptGzSha256: 'B', replacedGeneration: 1, replacedTranscriptGzSha256: 'A' };
  assert.deepStrictEqual(currentRows([r1, r2]).map((r) => [r.transcriptGzSha256, r.generation]), [['A', 1], ['B', undefined]], 'a matching row is labelled');
});

test('F-2: a refused commit never leaves a co-writer\'s bytes at this run\'s generation name; they are moved aside, not deleted, and the refusal says so', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const coWriter = zlib.gzipSync(Buffer.from('CO-WRITER BYTES\n'));
  const real = fs.renameSync;
  let res;
  fs.renameSync = function patched(a, b, ...r) { const out = real.call(fs, a, b, ...r); if (/\.gz\.gen1$/.test(String(b))) fs.writeFileSync(b, coWriter); return out; };
  try { res = run(s); } finally { fs.renameSync = real; }
  assert.strictEqual(res.archived.length, 0, JSON.stringify(res));
  const why = res.failed.map((f) => f.reason).join(' | ');
  assert.match(why, /archive no longer verifies before delete/);
  assert.ok(!why.includes("this run's copies were taken back"), why);
  const gens = filesUnder(s.archiveDir, /\.gz\.gen\d+$/);
  assert.ok(!gens.some((g) => fs.readFileSync(g).equals(coWriter)), 'no generation name holds the co-writer\'s bytes');
  assert.notStrictEqual(restoreText(s, { generation: 1 }), 'CO-WRITER BYTES\n', 'generation 1 never returns them as an earlier copy');
  const aside = filesUnder(s.archiveDir, /\.coalwash-aside$/);
  assert.strictEqual(aside.length, 1, 'the bytes this run did not verify are kept aside');
  assert.ok(fs.readFileSync(aside[0]).equals(coWriter));
  assert.ok(why.includes(aside[0]), `the refusal names where they went: ${why}`);
  assert.strictEqual(restoreText(s), ORIGINAL, 'the earlier copy is back at its archive name');
  assert.strictEqual(fs.readFileSync(transcriptPath(s), 'utf8'), V2, 'the live session stays');
});

test('F-2: a refused commit that put the earlier copy back keeps the generation it made of the verified bytes, and says what it took back and what it left', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const real = fs.renameSync;
  let res;
  let once = false; // the co-writer acts once: the clean-up's own put-back also renames onto the copy's name
  fs.renameSync = function patched(a, b, ...r) { const out = real.call(fs, a, b, ...r); if (!once && /\.jsonl\.gz$/.test(String(b))) { once = true; fs.writeFileSync(b, zlib.gzipSync(Buffer.from('changed\n'))); } return out; };
  try { res = run(s); } finally { fs.renameSync = real; }
  const why = res.failed.map((f) => f.reason).join(' | ');
  assert.match(why, /archive no longer verifies before delete/);
  const gens = filesUnder(s.archiveDir, /\.gz\.gen\d+$/);
  assert.strictEqual(gens.length, 1, 'the generation of the verified earlier bytes stays');
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(gens[0])).toString('utf8'), ORIGINAL);
  assert.match(why, /left this run's kept generation .* in place: it holds the earlier copy's bytes as they were verified/);
  assert.match(why, /put the earlier archived copy back at/);
  assert.ok(!why.includes("this run's copies were taken back"), why);
  assert.strictEqual(restoreText(s), ORIGINAL);
  assert.strictEqual(fs.readFileSync(transcriptPath(s), 'utf8'), V2);
});

test('F-2: when the earlier copy cannot be put back, the generation this run made of it is moved aside, never deleted (it is the only copy left)', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const earlierGz = fs.readFileSync(gzPathOf(s));
  const real = fs.renameSync;
  let commits = 0;
  let res;
  fs.renameSync = function patched(a, b, ...r) {
    if (/\.jsonl\.gz$/.test(String(b)) && ++commits > 1) throw Object.assign(new Error('EPERM: simulated put-back failure'), { code: 'EPERM' });
    const out = real.call(fs, a, b, ...r);
    if (/\.jsonl\.gz$/.test(String(b))) fs.writeFileSync(b, zlib.gzipSync(Buffer.from('changed\n')));
    return out;
  };
  try { res = run(s); } finally { fs.renameSync = real; }
  const why = res.failed.map((f) => f.reason).join(' | ');
  assert.match(why, /could not put the earlier archived copy back/);
  const holders = filesUnder(s.archiveDir, /./).filter((p) => fs.readFileSync(p).equals(earlierGz));
  assert.ok(holders.length >= 1, `the earlier copy's bytes still exist in the archive folder: ${why}`);
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(holders[0])).toString('utf8'), ORIGINAL);
  assert.strictEqual(fs.readFileSync(transcriptPath(s), 'utf8'), V2, 'the live session stays');
});

test('WD (lab 1.19.2): when another writer deletes this run\'s kept generation, the refusal says it is gone, not that it stays to be checked', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const real = fs.renameSync;
  let gen = null;
  let res;
  fs.renameSync = function patched(a, b, ...r) { const out = real.call(fs, a, b, ...r); if (/\.gz\.gen1$/.test(String(b))) { gen = String(b); fs.unlinkSync(b); } return out; };
  try { res = run(s); } finally { fs.renameSync = real; }
  assert.ok(gen, 'the generation rename ran');
  assert.strictEqual(res.archived.length, 0, JSON.stringify(res));
  const why = res.failed.map((f) => f.reason).join(' | ');
  assert.ok(!fs.existsSync(gen), 'nothing stands at the generation name');
  assert.ok(!why.includes('so it stays at that name'), `no word says it stays: ${why}`);
  assert.ok(why.includes(gen) && /was removed by another writer.*nothing stands at that name/.test(why), `the refusal says it is gone: ${why}`);
  assert.strictEqual(filesUnder(s.archiveDir, /\.coalwash-aside$/).length, 0, 'nothing was moved aside');
  assert.strictEqual(restoreText(s), ORIGINAL, 'the earlier copy is back at its archive name');
  assert.strictEqual(fs.readFileSync(transcriptPath(s), 'utf8'), V2, 'the live session stays');
});

// fire 793 (main's ruling on the 1.19.3 labtest F4 window): the 1.19.2 O-1 test asserted that ONE kept generation holding the earlier
// copy is reused; that one holder is then the only copy behind the live delete (LAB-RECORD section 1, T-24/M-20), so the ruling replaces
// it: one holder keeps a fresh copy, as 1.19.1 always did, and two holders are reused, so repeated kills keep at most two copies.
test('O-1 one holder: a run killed between a generation\'s rename and its copy\'s rename makes the next run keep a fresh copy, as 1.19.1 does', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  killedRun(s, 'after-gen-rename');
  assert.strictEqual(filesUnder(s.archiveDir, /\.gz\.gen\d+$/).length, 1, 'the kill left generation 1 beside the same copy');
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived.length, 1, JSON.stringify(res));
  assert.deepStrictEqual(filesUnder(s.archiveDir, /\.gz\.gen\d+$/).map((p) => path.basename(p)), [`${SID}.jsonl.gz.gen1`, `${SID}.jsonl.gz.gen2`], 'a fresh generation of the earlier copy');
  assert.strictEqual(res.archived[0].alreadyKept, undefined);
  assert.strictEqual(res.archived[0].generation, 2);
  assert.strictEqual(restoreText(s, { generation: 1 }), ORIGINAL);
  assert.strictEqual(restoreText(s, { generation: 2 }), ORIGINAL);
  assert.strictEqual(restoreText(s), V2);
  const rows = searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir });
  assert.ok(rows.some((r) => r.generation === 2), `search labels the earlier row with the generation that holds it: ${JSON.stringify(rows)}`);
});
// fire 796 (remedy (a)): the two-holder reuse is gone, so these two tests change from "no third copy" to "a fresh copy, as 1.19.1".
test('O-1 two holders: when two kept generations already hold the earlier copy, the next run still keeps a fresh third, as 1.19.1 does', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  fs.copyFileSync(gzPathOf(s), `${gzPathOf(s)}.gen1`);
  fs.copyFileSync(gzPathOf(s), `${gzPathOf(s)}.gen2`); // the state after a kill, then a fresh keep, then a second kill
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived.length, 1, JSON.stringify(res));
  assert.deepStrictEqual(filesUnder(s.archiveDir, /\.gz\.gen\d+$/).map((p) => path.basename(p)), [`${SID}.jsonl.gz.gen1`, `${SID}.jsonl.gz.gen2`, `${SID}.jsonl.gz.gen3`], 'a fresh third generation');
  assert.strictEqual(res.archived[0].alreadyKept, undefined);
  assert.strictEqual(res.archived[0].generation, 3);
  assert.ok(!/ALREADY-KEPT/.test(runEstateReport(res)), 'no line claims a copy was reused');
  for (const g of [1, 2, 3]) assert.strictEqual(restoreText(s, { generation: g }), ORIGINAL);
  assert.strictEqual(restoreText(s), V2);
});
test('O-1 two holders: the fresh generation is numbered after the highest kept one by number, not by name order (11 after 9 and 10)', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  fs.copyFileSync(gzPathOf(s), `${gzPathOf(s)}.gen9`);
  fs.copyFileSync(gzPathOf(s), `${gzPathOf(s)}.gen10`);
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived[0].generation, 11, JSON.stringify(res));
  assert.strictEqual(restoreText(s, { generation: 11 }), ORIGINAL);
});
test('O-1 two holders compare by content: two generations of the same size but other bytes do not stand in for the earlier copy', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const other = Buffer.from(fs.readFileSync(gzPathOf(s)));
  other[Math.floor(other.length / 2)] ^= 0xff; // same size, other bytes
  fs.writeFileSync(`${gzPathOf(s)}.gen1`, other);
  fs.writeFileSync(`${gzPathOf(s)}.gen2`, other);
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived.length, 1, JSON.stringify(res));
  assert.strictEqual(res.archived[0].alreadyKept, undefined, 'no reuse of copies that only match by size');
  assert.strictEqual(res.archived[0].generation, 3);
  assert.strictEqual(restoreText(s, { generation: 3 }), ORIGINAL, 'the earlier copy is kept fresh');
});

test('O-1 compares by content: a kept generation of the same size but other bytes does not stand in for the copy being replaced', (t) => {
  const s = sandbox(t);
  const A = ORIGINAL.replace('Gauge done', 'Gauge done1');
  const B = ORIGINAL.replace('Gauge done', 'Gauge done2').replace('said once', 'said 0nce');
  const C = ORIGINAL.replace('Gauge done', 'Gauge done3').replace('said once', 'said onc3');
  assert.strictEqual(zlib.gzipSync(A).length, zlib.gzipSync(B).length, 'precondition: A and B archive to the same size, so only a byte compare tells them apart');
  for (const v of [A, B, C]) {
    seed(s, v);
    assert.strictEqual(run(s).archived.length, 1);
    if (v !== C) assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  }
  const got = new Set([restoreText(s)]);
  for (let g = 1; g <= 3; g++) { const x = restoreText(s, { generation: g }); if (x !== null) got.add(x); }
  for (const v of [A, B, C]) assert.ok(got.has(v), `every archived version stays restorable (${got.size} restorable)`);
});

// fire 775 (INSPECT 774, witnesses scratchpad/29gd/i774-inputs.mjs input (b) and i774-oldrows.mjs, as room tests)
test('F774-1: a kept-generation label names the generation that holds the transcript\'s earlier copy, not another file\'s', (t) => {
  const s = sandbox(t);
  const SUB = path.join(s.projDir, SID, 'subagents', 'agent-1.jsonl');
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); const at = new Date(Date.now() - 30 * DAY); fs.utimesSync(p, at, at); };
  const T1 = [line(0, 'Needle CW775-NEEDLE transcript'), line(1, 'one'), line(2, 'middle said once')].join('\n') + '\n';
  const S1 = [line(0, 'subagent start'), line(1, 'sub middle said once')].join('\n') + '\n';
  const T2 = T1.replace('middle said once', 'middle said twice');
  const S2 = S1.replace('sub middle said once', 'sub middle said twice');
  put(transcriptPath(s), T1); put(SUB, S1);
  assert.strictEqual(run(s).archived.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  put(transcriptPath(s), T2); put(SUB, S2);
  // run 2: a co-writer alters only the subagent file's generation after its rename; the refused commit leaves the transcript's verified generation 1
  const coWriter = zlib.gzipSync(Buffer.from('CO-WRITER\n'));
  const real = fs.renameSync;
  fs.renameSync = function patched(a, b, ...r) { const out = real.call(fs, a, b, ...r); if (/agent-1\.jsonl\.gz\.gen1$/.test(String(b))) fs.writeFileSync(b, coWriter); return out; };
  try { assert.strictEqual(run(s, Date.now() + LATER).archived.length, 0); } finally { fs.renameSync = real; }
  // run 3: the transcript's earlier copy is already kept as generation 1; the subagent file's is kept now as generation 2
  const r3 = run(s, Date.now() + 2 * LATER);
  assert.strictEqual(r3.archived.length, 1, JSON.stringify(r3));
  const labelled = searchIndex('CW775-NEEDLE', { archiveDir: s.archiveDir }).filter((r) => Number.isInteger(r.generation));
  assert.strictEqual(labelled.length, 1, 'the earlier row is labelled once');
  const to = path.join(s.out, 'f774-1');
  const rr = restoreSession(SID, { archiveDir: s.archiveDir, to, generation: labelled[0].generation });
  assert.ok(rr.ok, JSON.stringify(rr));
  const got = path.join(to, `${SID}.jsonl`);
  assert.ok(fs.existsSync(got), `--generation ${labelled[0].generation}, the label search shows, returns the transcript`);
  assert.strictEqual(fs.readFileSync(got, 'utf8'), T1, 'and it is the copy that row describes');
});

test('F774-2: an index written before 1.19.2 keeps its kept-generation row in search, unlabelled (it cannot be matched)', () => {
  const rows = [
    { rowSchema: 2, sessionId: 's1', projectSlug: 'p', firstUserLine: 'the first archive (now kept as generation 1)' },
    { rowSchema: 2, sessionId: 's1', projectSlug: 'p', firstUserLine: 'the re-archive that kept it', replacedGeneration: 1 },
  ];
  const out = currentRows(rows);
  assert.deepStrictEqual(out.map((r) => [r.firstUserLine, r.generation]), [['the first archive (now kept as generation 1)', undefined], ['the re-archive that kept it', undefined]], 'both rows are listed; the older one carries no label it cannot prove');
  const prefixOnly = [{ rowSchema: 2, sessionId: 's2', projectSlug: 'p', firstUserLine: 'a prefix of the next' }, { rowSchema: 2, sessionId: 's2', projectSlug: 'p', firstUserLine: 'the superset' }];
  assert.deepStrictEqual(currentRows(prefixOnly).map((r) => r.firstUserLine), ['the superset'], 'a row whose copy the next one replaced as a prefix is still not shown');
});

// fire 784 (CodeRabbit t338 F2, witness scratchpad/29gd/w338b-run.mjs): the kill harness itself. A child that stops before it reaches
// any kill point (it exits 1, as a broken harness would) must fail the test, never pass as a kill.
test('F2 (t338): the kill harness rejects a child that never reached its kill point', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.throws(() => killedRun(s, 'throw-first'), /the kill point was reached/);
  assert.strictEqual(fs.existsSync(transcriptPath(s)), true, 'nothing ran: the session is untouched');
});

// fire 778 (labtest 1.19.2 G-1, witness U/scratchpad/cw-lab-1192/lbl-witness.mjs, as room tests). A transcript and a meta file, both
// edited between V0 and V1; the V1 run's commit renames are 1 transcript generation, 2 transcript newest, 3 meta generation, 4 meta
// newest. The V1 run stops right after one of them (KILLED, or its lock STOLEN), or after its transcript delete (KILLED), or does not
// stop with the transcript APPENDED (P); then the next run. Every label search shows must name a generation whose transcript copy is
// the row's own copy (its sha256 and what `--generation N` restores), and both versions stay restorable.
const LBL_V0 = { t: [line(0, 'first-version CW778-NEEDLE'), line(1, 'zero'), line(2, 'zero middle')].join('\n') + '\n', meta: '{"title":"v0"}\n' };
const LBL_V1 = { t: [line(0, 'second-version CW778-NEEDLE'), line(1, 'one'), line(2, 'one middle')].join('\n') + '\n', meta: '{"title":"v1 edited"}\n' };
const LBL_V1P = { t: LBL_V0.t + line(3, 'appended') + '\n', meta: '{"title":"v1 edited"}\n' };
const metaPath = (s) => path.join(s.projDir, `${SID}.meta.json`);
function lblPut(s, v) {
  for (const [p, text] of [[transcriptPath(s), v.t], [metaPath(s), v.meta]]) { fs.writeFileSync(p, text); const at = new Date(Date.now() - 30 * DAY); fs.utimesSync(p, at, at); }
}
function lblSetup(t, v1 = LBL_V1) {
  const s = sandbox(t);
  lblPut(s, LBL_V0);
  assert.strictEqual(run(s).archived.length, 1);
  lblPut(s, v1);
  return s;
}
function stolenAfterCommitRename(s, n) {
  const real = fs.renameSync;
  let commits = 0;
  fs.renameSync = function patched(a, b, ...r) {
    const out = real.call(fs, a, b, ...r);
    if (/\.coalwash-new$/.test(String(a)) && ++commits === n) {
      const old = new Date(Date.now() - LOCK_STALE_MS - 60000);
      fs.utimesSync(globalLockPath(s.home), old, old);
      assert.ok(acquireLock(globalLockPath(s.home), { sessionId: 'thief' }).acquired, 'the thief took the lock');
    }
    return out;
  };
  try { return run(s); } finally { fs.renameSync = real; }
}
function labelsHold(s, v1) {
  const slugDir = path.join(s.archiveDir, ccProjectSlug(s.proj));
  const rows = searchIndex('CW778-NEEDLE', { archiveDir: s.archiveDir });
  for (const r of rows.filter((x) => Number.isInteger(x.generation))) {
    const genGz = path.join(slugDir, `${SID}.jsonl.gz.gen${r.generation}`);
    assert.ok(fs.existsSync(genGz), `the row "${r.firstUserLine}" is labelled generation ${r.generation}, which holds no transcript`);
    assert.strictEqual(sha(fs.readFileSync(genGz)), r.transcriptGzSha256, `generation ${r.generation} holds the copy the row "${r.firstUserLine}" describes`);
    const got = restoreText(s, { generation: r.generation });
    assert.strictEqual(String(got).split('\n')[0].includes(r.firstUserLine.split(' ')[0]), true, `--generation ${r.generation} restores the row's copy`);
  }
  const all = new Set([restoreText(s)]);
  for (let g = 1; g <= 4; g++) { const x = restoreText(s, { generation: g }); if (x !== null) all.add(x); }
  for (const v of [LBL_V0.t, v1.t]) assert.ok([...all].some((x) => x !== null && x.startsWith(v)), 'every version stays restorable');
}

test('G-1 P: an appended transcript with an edited meta file labels no row with the meta file\'s generation', (t) => {
  const s = lblSetup(t, LBL_V1P);
  assert.strictEqual(run(s).archived.length, 1);
  labelsHold(s, LBL_V1P);
});
for (const n of [1, 2, 3, 4]) {
  test(`G-1 K${n}: a run KILLED right after commit rename ${n}, then the next run: every label names the copy its generation holds`, (t) => {
    const s = lblSetup(t);
    killedRun(s, 'after-commit-rename', String(n));
    run(s, Date.now() + LATER);
    labelsHold(s, LBL_V1);
  });
  test(`G-1 S${n}: a run whose lock is STOLEN right after commit rename ${n}, then the next run: every label names the copy its generation holds`, (t) => {
    const s = lblSetup(t);
    assert.strictEqual(stolenAfterCommitRename(s, n).robbed, 'global');
    run(s, Date.now() + LATER);
    labelsHold(s, LBL_V1);
  });
}
test('G-1 KD: a run KILLED right after its transcript delete, then the next run: every label names the copy its generation holds', (t) => {
  const s = lblSetup(t);
  killedRun(s, 'after-delete', transcriptPath(s));
  run(s, Date.now() + LATER);
  labelsHold(s, LBL_V1);
});

// fire 784 (CodeRabbit t338 F4, witness scratchpad/29gd/w338.mjs leg F4; the chief's ruling on row CW-073: every kept copy a run relies
// on is read back before any live file is deleted). The O-1 state (generation 1 already holds the archive copy byte for byte), the
// session edited (not a prefix), and an outside writer that overwrites that REUSED generation inside the window before the delete:
// (a) just before the commit renames the new copy over the archive name, (b) just after it.
function reusedGenWritten(t, moment) {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const gen1 = `${gzPathOf(s)}.gen1`;
  fs.copyFileSync(gzPathOf(s), gen1); // the O-1 state
  // fire 793 put this in the two-holder state, then the one state that reused; since fire 796 no state reuses, and the writer hits gen1,
  // a generation that existed before the run.
  fs.copyFileSync(gzPathOf(s), `${gzPathOf(s)}.gen2`);
  const real = fs.renameSync;
  let wrote = false;
  fs.renameSync = function patched(a, b, ...r) {
    const onto = /\.coalwash-new$/.test(String(a)) && path.resolve(String(b)) === path.resolve(gzPathOf(s));
    if (onto && moment === 'before' && !wrote) { fs.writeFileSync(gen1, 'an outside writer, not gzip\n'); wrote = true; }
    const out = real.call(fs, a, b, ...r);
    if (onto && moment === 'after' && !wrote) { fs.writeFileSync(gen1, 'an outside writer, not gzip\n'); wrote = true; }
    return out;
  };
  let res;
  try { res = run(s, Date.now() + LATER); } finally { fs.renameSync = real; }
  assert.ok(wrote, 'the outside writer struck inside the window');
  // fire 796 (remedy (a)): no generation is reused any more, so the run relies only on the fresh copy it kept (generation 3); a writer
  // on a pre-existing generation no longer stops the run (the 784 asserts "not archived" and "refused" held only while gen1 was reused),
  // and what must hold is the claim itself: the earlier version stays restorable, from the fresh copy.
  assert.strictEqual(res.archived.length, 1, `the run archives with its own fresh copy: ${JSON.stringify(res.failed)}`);
  assert.strictEqual(res.archived[0].generation, 3);
  assert.strictEqual(restoreText(s, { generation: 3 }), ORIGINAL, 'the earlier version stays restorable from the fresh copy');
  assert.strictEqual(restoreText(s), V2);
}
test('F4 (t338): an outside writer on a PRE-EXISTING generation just before the commit rename does not reach the earlier version: the run kept a fresh copy', (t) => reusedGenWritten(t, 'before'));
test('F4 (t338): an outside writer on a PRE-EXISTING generation just after the commit rename does not reach the earlier version: the run kept a fresh copy', (t) => reusedGenWritten(t, 'after'));

// fire 784 (CodeRabbit t338 F1, witness scratchpad/29gd/w338.mjs leg F1): an archived copy the index repair cannot open (EACCES, as a
// POSIX chmod 000 or a Windows deny ACL gives) is named in words, the run goes on with the other sessions, and it reports a failure.
test('F1 (t338): an archive the index repair cannot open is named, the other sessions still archive, and the run reports the failure', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  const SID2 = 'd7847847-7847-4784-8784-784784784784';
  const live2 = path.join(s.projDir, `${SID2}.jsonl`);
  fs.writeFileSync(live2, [line(0, 'another session F1-784'), line(1, 'two')].join('\n') + '\n');
  const at = new Date(Date.now() - 30 * DAY); fs.utimesSync(live2, at, at);
  const locked = path.resolve(gzPathOf(s));
  const real = fs.openSync;
  fs.openSync = function patched(p, ...r) {
    if (path.resolve(String(p)) === locked) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
    return real.call(fs, p, ...r);
  };
  let res;
  try { res = run(s, Date.now() + LATER); } finally { fs.openSync = real; }
  assert.deepStrictEqual(res.archived.map((a) => a.id), [SID2], `the other session still archives: ${JSON.stringify(res)}`);
  const why = res.failed.filter((f) => f.id === SID).map((f) => f.reason).join(' | ');
  assert.ok(why.includes(gzPathOf(s)) && /could not be opened \(EACCES\)/.test(why), `the archive is named in words: ${why}`);
  assert.strictEqual(res.indexRepairFailed, 1, 'the run counts the index repair it could not do, so the CLI exits non-zero');
  assert.match(runEstateReport(res), /KEPT c7727727-7727-4772-8772-772772772772: its archived transcript .* could not be opened \(EACCES\)/);
});

test('F1 (t338): a kept generation the index repair cannot open is named, the run goes on, and no label is guessed for it', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  killedRun(s, 'after-delete', transcriptPath(s)); // the re-archive's row is missing, so the next run's repair reads generation 1
  const locked = path.resolve(`${gzPathOf(s)}.gen1`);
  const real = fs.openSync;
  fs.openSync = function patched(p, ...r) {
    if (path.resolve(String(p)) === locked) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
    return real.call(fs, p, ...r);
  };
  let res;
  try { res = run(s, Date.now() + LATER); } finally { fs.openSync = real; }
  const why = res.failed.map((f) => f.reason).join(' | ');
  assert.ok(why.includes(`${gzPathOf(s)}.gen1`) && /could not be opened \(EACCES\)/.test(why), `the generation is named: ${why}`);
  assert.strictEqual(res.indexRepairFailed, 1);
  // 29hz fire 803 (t340 F7): changed from "the current copy still gets its row" (1). That row carried the current copy's sha, so the
  // next run's matching-hash shortcut skipped the session and the label was never set. Now no row is written; the next test repairs it.
  assert.ok(!res.reconciledRows, 'no row this run, so the next run repairs it');
  assert.ok(!searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).some((r) => Number.isInteger(r.generation)), 'no generation label is guessed for a copy it could not read');
});

// 29hz fire 803 (CodeRabbit t340 F7): once the kept generation reads again, the next run's index repair adds the row and labels it.
test('F7 (t340): after a generation read fails, the next run repairs the row and labels the generation', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  killedRun(s, 'after-delete', transcriptPath(s));
  const locked = path.resolve(`${gzPathOf(s)}.gen1`);
  const real = fs.openSync;
  fs.openSync = function patched(p, ...r) {
    if (path.resolve(String(p)) === locked) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
    return real.call(fs, p, ...r);
  };
  try { run(s, Date.now() + LATER); } finally { fs.openSync = real; }
  const res = run(s, Date.now() + 2 * LATER);
  assert.strictEqual(res.indexRepairFailed, undefined, JSON.stringify(res));
  assert.strictEqual(res.reconciledRows, 1, `the repair adds the row once the read succeeds: ${JSON.stringify(res)}`);
  assert.ok(searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).some((r) => r.generation === 1), 'the earlier copy is labelled generation 1');
});

// t336 F8 and F7 (witness scratchpad/29gd/w336.mjs, as room tests)
const damagedGz = () => { const g = Buffer.from(zlib.gzipSync(Buffer.from('damaged member\n'))); g[g.length - 8] ^= 0xff; return g; };

test('F8: a refusal after a damaged member still returns and names it, and says the files after the refusal were not restored', (t) => {
  const s = sandbox(t);
  const sdir = path.join(s.archiveDir, 'slug-f8', SID);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'a.jsonl.gz'), damagedGz());
  fs.writeFileSync(path.join(sdir, 'b.jsonl.gz'), zlib.gzipSync(Buffer.from('b'.repeat(100))));
  fs.writeFileSync(path.join(sdir, 'c.jsonl.gz'), zlib.gzipSync(Buffer.from('ccc')));
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to: path.join(s.out, 'f8'), sessionCeilBytes: 50 });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.damaged) && r.damaged.length === 1 && r.damaged[0].rel.endsWith('a.jsonl'), JSON.stringify(r));
  assert.ok(r.error.includes('a.jsonl'), r.error);
  assert.match(r.error, /restore refused on \S*b\.jsonl/);
  assert.match(r.error, /so the 1 file\(s\) after it were not restored/);
});

test('F7: estate-restore escapes control characters in the refusal it prints', (t) => {
  const s = sandbox(t);
  const sdir = path.join(s.archiveDir, 'slug-f7', SID);
  fs.mkdirSync(sdir, { recursive: true });
  const evil = `a${String.fromCodePoint(0x202e)}x${String.fromCodePoint(0x9b)}2K.jsonl.gz`;
  fs.writeFileSync(path.join(sdir, evil), damagedGz());
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT,
    HOME: s.home, USERPROFILE: s.home, TEMP: path.join(s.root, 'tmp'), TMP: path.join(s.root, 'tmp'), TMPDIR: path.join(s.root, 'tmp'),
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  const c = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'lib', 'cli.mjs'), 'estate-restore', SID], { cwd: s.proj, env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  assert.strictEqual(c.status, 1, c.stderr);
  const err = String(c.stderr);
  assert.ok(err.includes('does not decompress'), err);
  assert.strictEqual(err.includes(String.fromCodePoint(0x202e)), false, 'no raw U+202E reaches stderr');
  assert.strictEqual(err.includes(String.fromCodePoint(0x9b)), false, 'no raw U+009B reaches stderr');
});

test('K-E (lab 1.19.2): a session the same run then archives cleanly is not reported as an archive that does not decompress', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  fs.writeFileSync(gzPathOf(s), damagedGz()); // the archived copy is damaged, so its index row no longer matches it
  seed(s, V2);
  const res = run(s, Date.now() + LATER);
  assert.deepStrictEqual(res.archived.map((a) => a.id), [SID], `the session is archived cleanly: ${JSON.stringify(res)}`);
  assert.strictEqual(restoreText(s), V2, 'the new copy restores');
  const why = res.failed.filter((f) => f.id === SID).map((f) => f.reason).join(' | ');
  assert.ok(!/does not decompress/.test(why), `no stale hint for a session this run archived cleanly: ${why}`);
  assert.strictEqual(res.indexRepairFailed, undefined, 'the run does not count a repair this run made moot');
  // 788 (INSPECT 787 C2): the report now says the KEPT generation does not decompress, so only the repair's stale hint is barred here
  assert.ok(!/no index row was added for it; restore it by id/.test(runEstateReport(res)), runEstateReport(res));
});

test('K-E control: an archive that does not decompress and is NOT re-archived in the same run is still named', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  fs.writeFileSync(gzPathOf(s), damagedGz());
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived.length, 0);
  const why = res.failed.filter((f) => f.id === SID).map((f) => f.reason).join(' | ');
  assert.match(why, /does not decompress/);
});

test('Aside (lab 1.19.2): a later run lists the files a refused run moved aside, and leaves them where they are', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  const coWriter = zlib.gzipSync(Buffer.from('CO-WRITER BYTES\n'));
  const real = fs.renameSync;
  fs.renameSync = function patched(a, b, ...r) { const out = real.call(fs, a, b, ...r); if (/\.gz\.gen1$/.test(String(b))) fs.writeFileSync(b, coWriter); return out; };
  try { assert.strictEqual(run(s).archived.length, 0); } finally { fs.renameSync = real; }
  const aside = filesUnder(s.archiveDir, /\.coalwash-aside$/);
  assert.strictEqual(aside.length, 1);
  const res = run(s, Date.now() + LATER);
  assert.deepStrictEqual(res.asideFiles, aside, `the later run lists it: ${JSON.stringify(res)}`);
  const report = runEstateReport(res);
  assert.ok(report.includes('ASIDE: 1 file(s)') && report.includes(aside[0]), report);
  assert.ok(fs.readFileSync(aside[0]).equals(coWriter), 'listed, never moved or changed');
});

test('C1 (INSPECT 787): the ASIDE line escapes control characters in a file name, as the KEPT lines do', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  const name = `x${String.fromCodePoint(0x202e)}y${String.fromCodePoint(0x9b)}2K.jsonl.gz.gen1.${'ab'.repeat(12)}.coalwash-aside`;
  fs.writeFileSync(path.join(path.dirname(gzPathOf(s)), name), 'planted\n');
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.asideFiles.length, 1, JSON.stringify(res));
  const report = runEstateReport(res);
  const aside = report.split('\n').find((l) => l.startsWith('  ASIDE:'));
  assert.ok(aside, report);
  assert.strictEqual(aside.includes(String.fromCodePoint(0x202e)), false, 'no raw U+202E in the ASIDE line');
  assert.strictEqual(aside.includes(String.fromCodePoint(0x9b)), false, 'no raw U+009B in the ASIDE line');
  assert.ok(aside.includes('2K.jsonl.gz.gen1.'), `the name is still printed, escaped: ${aside}`);
});

test('C2 (INSPECT 787): a kept generation that does not decompress is reported as damaged, not as restorable', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  fs.writeFileSync(gzPathOf(s), damagedGz());
  seed(s, V2);
  const res = run(s, Date.now() + LATER);
  assert.deepStrictEqual(res.archived.map((a) => a.id), [SID], JSON.stringify(res));
  assert.strictEqual(res.archived[0].generation, 1, 'the damaged copy is kept as generation 1');
  assert.strictEqual(restoreText(s, { generation: 1 }), null, 'generation 1 does not restore a transcript');
  const line = runEstateReport(res).split('\n').find((l) => l.startsWith(`  KEPT-EARLIER ${SID}`));
  assert.ok(line, runEstateReport(res));
  assert.match(line, /generation 1/);
  assert.match(line, /does not decompress/, `the line says the kept copy is damaged: ${line}`);
  assert.ok(!/restore it with/.test(line), `no restore advice for a damaged copy: ${line}`);
});

// 29hz fire 803 (CodeRabbit t340 F1): the damaged label comes from the archive read that decides the keep (priorArchive, by the
// gunzip error code), not from the index repair's earlier read of the same name. (b) it holds with the index off; (a) a damaged copy
// swapped for a valid one after the repair's read is not called damaged.
test('F1 (t340): a kept copy that does not decompress is labelled damaged with the index off', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  fs.writeFileSync(gzPathOf(s), damagedGz());
  seed(s, V2);
  const res = runEstate({ projectRoot: s.proj, home: s.home, estate: { indexEnabled: false }, now: Date.now() + LATER });
  assert.strictEqual(res.archived[0] && res.archived[0].generation, 1, JSON.stringify(res));
  assert.strictEqual(res.archived[0].damagedGeneration, 1, 'labelled damaged without the index repair');
  assert.match(runEstateReport(res), /KEPT-EARLIER .*does not decompress/);
});

// 29ib fire 807 (INSPECT 806 F806-1): a damaged earlier copy LONGER than the new source. The length-bounded decode throws
// ERR_BUFFER_TOO_LARGE before zlib reaches the damage, so the mark is read again under the restore bound. Index on and off.
for (const idx of ['on', 'off']) {
  test(`F806-1: a damaged earlier copy longer than the new source is labelled damaged (index ${idx})`, (t) => {
    const s = sandbox(t);
    const long = Array.from({ length: 8000 }, (_, i) => line(i, `F806 ${crypto.createHash('sha256').update(String(i)).digest('hex')}`)).join('\n') + '\n';
    seed(s, long);
    assert.strictEqual(run(s).archived.length, 1);
    const g = Buffer.from(zlib.gzipSync(Buffer.from(long)));
    g[g.length - 8] ^= 0xff; // the CRC: the whole body decodes, then zlib reports the damage
    assert.ok(long.length > 1024 * 1024, 'the copy is past one decode chunk');
    fs.writeFileSync(gzPathOf(s), g);
    seed(s, line(0, 'a short new transcript, not a superset') + '\n');
    const res = runEstate({ projectRoot: s.proj, home: s.home, estate: idx === 'on' ? {} : { indexEnabled: false }, now: Date.now() + LATER });
    assert.strictEqual(res.archived[0] && res.archived[0].generation, 1, JSON.stringify(res));
    assert.strictEqual(res.archived[0].damagedGeneration, 1, 'labelled damaged');
    const report = runEstateReport(res);
    assert.ok(/does not decompress/.test(report) && !/restore it with/.test(report), report);
  });
}

test('F1 (t340): a damaged copy swapped for a valid one after the index repair read is not labelled damaged', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  fs.writeFileSync(gzPathOf(s), damagedGz());
  seed(s, V2);
  const real = zlib.gunzipSync;
  let swapped = false;
  zlib.gunzipSync = function patched(...a) {
    try { return real.apply(zlib, a); } catch (e) {
      if (!swapped) { swapped = true; fs.writeFileSync(gzPathOf(s), zlib.gzipSync(Buffer.from('ANOTHER VALID COPY\n'))); }
      throw e;
    }
  };
  let res;
  try { res = run(s, Date.now() + LATER); } finally { zlib.gunzipSync = real; }
  assert.ok(swapped, 'the outside writer swapped the copy after the repair read');
  assert.strictEqual(res.archived[0] && res.archived[0].generation, 1, JSON.stringify(res));
  assert.strictEqual(res.archived[0].damagedGeneration, undefined, 'the kept copy is valid, so it is not labelled damaged');
  const report = runEstateReport(res);
  assert.ok(!/does not decompress/.test(report) && /--generation 1/.test(report), `the restore advice, not the damaged line: ${report}`);
});

// fire 793 (labtest 1.19.3 F4 window, LAB-RECORD section 1, points T-24 and M-20; main's ruling: a fix is never weaker than the
// version before the defect). The class: can a run delete the live file while the only other copy of the earlier version sits at a
// name that existed before the run? The O-1 state (a run killed right after a generation's rename, so gen1 equals the archive copy),
// the files edited, and an outside writer that replaces gen1 with a valid impostor gzip or removes it, AFTER the read-back and just
// BEFORE the run's first live delete. Walked: the first fs.rmSync of a live file. Not walked: every other mutating call of the run
// (the lab harness f4-legs.mjs walks them all).
function heldVersions(s, rel) {
  const slugDir = path.join(s.archiveDir, ccProjectSlug(s.proj));
  const out = [];
  try { out.push(fs.readFileSync(path.join(s.projDir, rel), 'utf8')); } catch { /* not live */ }
  let names = []; try { names = fs.readdirSync(slugDir); } catch { /* none */ }
  for (const n of names.sort()) if (n.startsWith(`${rel}.gz`)) { try { out.push(zlib.gunzipSync(fs.readFileSync(path.join(slugDir, n))).toString('utf8')); } catch { /* not a copy */ } }
  return out;
}
function everyVersionHeld(s, when) {
  for (const [rel, vs] of [[`${SID}.jsonl`, [LBL_V0.t, LBL_V1.t]], [`${SID}.meta.json`, [LBL_V0.meta, LBL_V1.meta]]]) {
    const held = heldVersions(s, rel);
    for (const v of vs) assert.ok(held.includes(v), `${when}: ${rel} version "${v.slice(0, 40)}" is still on disk (live, the archive copy or a generation)`);
  }
}
for (const [state, rename, rel] of [['T', '1', `${SID}.jsonl`], ['M', '3', `${SID}.meta.json`]]) {
  for (const writer of ['replace', 'remove']) {
    test(`F4W (lab 1.19.3) state ${state}, writer ${writer}s the reused gen1 before the first live delete: no version is lost, or the session is not reported archived`, (t) => {
      const s = lblSetup(t);
      killedRun(s, 'after-commit-rename', rename);
      const slugDir = path.join(s.archiveDir, ccProjectSlug(s.proj));
      const gen1 = path.join(slugDir, `${rel}.gz.gen1`);
      assert.ok(fs.readFileSync(gen1).equals(fs.readFileSync(path.join(slugDir, `${rel}.gz`))), 'the O-1 state: gen1 holds the archive copy byte for byte');
      const live = path.resolve(s.projDir);
      const real = fs.rmSync;
      let struck = false;
      fs.rmSync = function patched(p, ...r) {
        if (!struck && path.resolve(String(p)).startsWith(live + path.sep)) {
          struck = true;
          if (writer === 'replace') fs.writeFileSync(gen1, zlib.gzipSync(Buffer.from('IMPOSTOR\n'))); else fs.unlinkSync(gen1);
        }
        return real.call(fs, p, ...r);
      };
      let res;
      try { res = run(s, Date.now() + LATER); } finally { fs.rmSync = real; }
      assert.ok(struck, 'the outside writer struck before the first live delete');
      // 29hz fire 803 (CodeRabbit t340 F3): "not reported archived" does not prove the live files stay (a run stopped during its
      // deletes reports no archived row), so every version is checked on this branch too.
      if (res.archived.length === 0) { everyVersionHeld(s, 'after the run'); return; }
      everyVersionHeld(s, 'after the run');
      run(s, Date.now() + 2 * LATER);
      everyVersionHeld(s, 'after the user\'s following run');
    });
  }
}

// fire 793 item 5 (labtest 1.19.3, points T-29/M-22 on 1.19.1; booked as INHERENT by main's ruling): a writer that hits EVERY kept
// generation of the file after the read-back and before the first live delete leaves no copy of the earlier version, and the run still
// reports the session archived. This states the observed behaviour, the same on 1.19.1 (bbe1a08); no read-back can close it, since the
// writer acts after the last read. It is a witness of a limit, not a guarantee.
for (const [state, rename, rel] of [['T', '1', `${SID}.jsonl`], ['M', '3', `${SID}.meta.json`]]) {
  for (const writer of ['replace', 'remove']) {
    test(`INHERENT (lab 1.19.3) state ${state}: a writer that ${writer}s EVERY kept generation before the first live delete loses the earlier version, as 1.19.1 does`, (t) => {
      const s = lblSetup(t);
      killedRun(s, 'after-commit-rename', rename);
      const slugDir = path.join(s.archiveDir, ccProjectSlug(s.proj));
      const live = path.resolve(s.projDir);
      const real = fs.rmSync;
      let struck = 0;
      fs.rmSync = function patched(p, ...r) {
        if (struck === 0 && path.resolve(String(p)).startsWith(live + path.sep)) {
          for (const n of fs.readdirSync(slugDir).filter((x) => x.startsWith(`${rel}.gz.gen`))) {
            const g = path.join(slugDir, n);
            if (writer === 'replace') fs.writeFileSync(g, zlib.gzipSync(Buffer.from('IMPOSTOR\n'))); else fs.unlinkSync(g);
            struck++;
          }
        }
        return real.call(fs, p, ...r);
      };
      let res;
      try { res = run(s, Date.now() + LATER); } finally { fs.rmSync = real; }
      assert.ok(struck >= 1, 'the writer hit every kept generation before the first live delete');
      assert.strictEqual(res.archived.length, 1, `the run reports the session archived: ${JSON.stringify(res.failed)}`);
      const v0 = rel.endsWith('.jsonl') ? LBL_V0.t : LBL_V0.meta;
      assert.strictEqual(heldVersions(s, rel).includes(v0), false, 'observed: no copy of the earlier version is left (the inherent limit)');
    });
  }
}

// fire 796 (INSPECT 795 F795-1, witness scratchpad/29gd/w795.mjs; the head's ruling, remedy (a)): in the two-holder state, a writer that
// strikes only the generations that existed BEFORE the run, after the read-back and just before the first live delete, must not lose
// the earlier version: the run keeps a fresh copy whenever it keeps the earlier one, as 1.19.1 always did.
for (const writer of ['pre-truncate', 'pre-remove', 'pre-renameover']) {
  test(`F795-1 two holders, writer ${writer} on the pre-existing generations before the first live delete: the earlier version stays restorable`, (t) => {
    const s = sandbox(t);
    archiveThenRewrite(s);
    const gz = gzPathOf(s);
    fs.copyFileSync(gz, `${gz}.gen1`);
    fs.copyFileSync(gz, `${gz}.gen2`); // the two-holder state
    const pre = [`${gz}.gen1`, `${gz}.gen2`];
    const impostor = zlib.gzipSync(Buffer.from(line(0, 'impostor-version F795') + '\n'));
    const real = fs.rmSync;
    let struck = false;
    fs.rmSync = function patched(p, ...r) {
      if (!struck && path.resolve(String(p)) === path.resolve(transcriptPath(s))) {
        struck = true;
        for (const g of pre) {
          if (writer === 'pre-truncate') fs.truncateSync(g, 0);
          else if (writer === 'pre-remove') fs.unlinkSync(g);
          else { const tmp = `${g}.w796`; fs.writeFileSync(tmp, impostor); fs.renameSync(tmp, g); }
        }
      }
      return real.call(fs, p, ...r);
    };
    let res;
    try { res = run(s, Date.now() + LATER); } finally { fs.rmSync = real; }
    assert.ok(struck, 'the writer struck before the first live delete');
    const got = [restoreText(s)];
    for (let g = 1; g <= 4; g++) got.push(restoreText(s, { generation: g }));
    assert.ok(got.includes(ORIGINAL), `the earlier version stays restorable (archived ${res.archived.length})`);
  });
}

// 29ig fire 813 (CodeRabbit t343 F1): a kept generation that the index repair reads as no bytes, without a throw (the reader
// returns { grew } when a writer appends during the read, { over } past the size bound, { notFile } for a non-file), is unread too:
// the repair names it and adds no row, so the next run repairs it. A folder at the generation's name never reaches the read
// (the listing takes files only), so the stub reports the size the reader sees: one byte short gives { grew }, past the bound { over }.
for (const [shape, sizeOf] of [['grew', (n) => n - 1], ['over', () => 512 * 1024 * 1024]]) {
  test(`F1 (t343): a kept generation the index repair reads as ${shape} is named, gets no row, and the next run labels it`, (t) => {
    const s = sandbox(t);
    archiveThenRewrite(s);
    killedRun(s, 'after-delete', transcriptPath(s)); // the re-archive's row is missing, so the next run's repair reads generation 1
    const gen1 = path.resolve(`${gzPathOf(s)}.gen1`);
    const realOpen = fs.openSync;
    const realFstat = fs.fstatSync;
    const genFds = new Set();
    fs.openSync = function patched(p, ...r) { const fd = realOpen.call(fs, p, ...r); if (path.resolve(String(p)) === gen1) genFds.add(fd); return fd; };
    fs.fstatSync = function patched(fd, ...r) {
      const st = realFstat.call(fs, fd, ...r);
      if (!genFds.has(fd)) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: sizeOf(st.size) });
    };
    let first;
    try { first = run(s, Date.now() + LATER); } finally { fs.openSync = realOpen; fs.fstatSync = realFstat; }
    const why = first.failed.map((f) => f.reason).join(' | ');
    assert.ok(why.includes(`${gzPathOf(s)}.gen1`), `the generation is named: ${why}`);
    assert.ok(!first.reconciledRows, `no row this run: ${JSON.stringify(first)}`);
    const res = run(s, Date.now() + 2 * LATER);
    assert.strictEqual(res.reconciledRows, 1, `the repair adds the row once the read succeeds: ${JSON.stringify(res)}`);
    assert.ok(searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).some((r) => r.generation === 1), 'the earlier copy is labelled generation 1');
  });
}

// 29ig fire 813 (CodeRabbit t343 F8; the head's ruling): a damaged kept copy of a session file other than its transcript is named in
// the report by its archive path. The transcript's own wording stays as it is.
test('F8 (t343): a damaged kept copy of a non-transcript file is named in the report by its archive path', (t) => {
  const s = sandbox(t);
  lblPut(s, LBL_V0);
  assert.strictEqual(run(s).archived.length, 1);
  const metaGz = path.join(s.archiveDir, ccProjectSlug(s.proj), `${SID}.meta.json.gz`);
  fs.writeFileSync(metaGz, damagedGz());
  lblPut(s, LBL_V1P); // the transcript is appended (a prefix, replaced); the meta file is edited, so its damaged copy is kept
  const res = run(s, Date.now() + LATER);
  assert.deepStrictEqual(res.archived.map((a) => a.id), [SID], JSON.stringify(res));
  const report = runEstateReport(res);
  const line = report.split('\n').find((l) => l.includes(`${metaGz}.gen1`));
  assert.ok(line, `the damaged meta copy is named by its archive path: ${report}`);
  assert.match(line, /does not decompress/);
  assert.ok(!/earlier archived transcript does not decompress/.test(report), 'the transcript is not called damaged');
});
