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

test('O-1: a run killed between a generation\'s rename and its copy\'s rename does not make the next run keep the same bytes again', (t) => {
  const s = sandbox(t);
  archiveThenRewrite(s);
  killedRun(s, 'after-gen-rename');
  assert.strictEqual(filesUnder(s.archiveDir, /\.gz\.gen\d+$/).length, 1, 'the kill left generation 1 beside the same copy');
  const res = run(s, Date.now() + LATER);
  assert.strictEqual(res.archived.length, 1, JSON.stringify(res));
  assert.deepStrictEqual(filesUnder(s.archiveDir, /\.gz\.gen\d+$/).map((p) => path.basename(p)), [`${SID}.jsonl.gz.gen1`], 'no second generation of the same bytes');
  assert.deepStrictEqual(res.archived[0].alreadyKept, [{ rel: `${SID}.jsonl`, generation: 1 }]);
  assert.match(runEstateReport(res), /ALREADY-KEPT .*already kept, byte for byte, as generation 1/);
  assert.strictEqual(restoreText(s, { generation: 1 }), ORIGINAL);
  assert.strictEqual(restoreText(s), V2);
  const rows = searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir });
  assert.ok(rows.some((r) => r.generation === 1), `search labels the earlier row with the generation that holds it: ${JSON.stringify(rows)}`);
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
  assert.strictEqual(fs.existsSync(transcriptPath(s)), true, `the live session is not deleted when a kept copy it relies on no longer reads back: ${JSON.stringify(res)}`);
  assert.strictEqual(res.archived.length, 0, 'the session is not reported archived');
  assert.match(res.failed.map((f) => f.reason).join(' | '), /archive no longer verifies before delete/);
  assert.strictEqual(restoreText(s), ORIGINAL, 'the earlier version stays restorable (put back at its archive name)');
  assert.strictEqual(fs.readFileSync(transcriptPath(s), 'utf8'), V2);
}
test('F4 (t338): an outside writer on the REUSED generation just before the commit rename stops the delete; the earlier version stays restorable', (t) => reusedGenWritten(t, 'before'));
test('F4 (t338): an outside writer on the REUSED generation just after the commit rename stops the delete; the earlier version stays restorable', (t) => reusedGenWritten(t, 'after'));

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
  assert.strictEqual(res.reconciledRows, 1, 'the current copy still gets its row');
  assert.ok(!searchIndex('CW772-NEEDLE', { archiveDir: s.archiveDir }).some((r) => Number.isInteger(r.generation)), 'no generation label is guessed for a copy it could not read');
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
  assert.ok(!/does not decompress/.test(runEstateReport(res)), runEstateReport(res));
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
