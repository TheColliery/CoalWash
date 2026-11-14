// 29gt fire 750: a re-archive never drops a byte the user once had (main's ruling). The estate archive used to write
// `<rel>.gz` over an earlier archive of the same session; when the second copy is not a superset of the first, the first
// copy's bytes were gone. Every test runs in its own sandbox under the real temp folder (the ESTATE BAN): no real store,
// no real ~/.claude, no real transcript.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEstate, restoreSession, searchIndex, archiveSession, listSessions, resolveArchiveDir } from './estate-archive.mjs';
import { ccProjectSlug } from './class-b.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
const DAY = 86400000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMP = fs.realpathSync.native(os.tmpdir());
const SID = 'a1111111-1111-4111-8111-111111111111';

// The sandbox root, asserted inside the real temp folder; its teardown is registered the line after it is made.
function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, 'cw-estate-29gt-')));
  const rel = path.relative(TEMP, root);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(root).startsWith('cw-estate-29gt-')) throw new Error(`sandbox root ${root} is not a cw-estate-29gt- folder inside ${TEMP}`);
  t.after(() => {
    if (path.dirname(root) !== TEMP || !path.basename(root).startsWith('cw-estate-29gt-')) throw new Error(`refusing to remove ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# fixture\n');
  const projDir = path.join(home, '.claude', 'projects', ccProjectSlug(proj));
  fs.mkdirSync(projDir, { recursive: true });
  return { root, home, proj, projDir, archiveDir: resolveArchiveDir({}, home), out: path.join(root, 'out') };
}
const line = (i, text) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: `2026-09-01T10:0${i}:00Z`, message: { role: i % 2 ? 'assistant' : 'user', content: text } });
const ORIGINAL = [line(0, 'Fix the Ledger gauge CW29GT-NEEDLE'), line(1, 'Working on the Ledger gauge'), line(2, 'The middle line, said once'), line(3, 'Ledger gauge done')].join('\n') + '\n';
function seed(s, content, ageDays = 30) {
  const p = path.join(s.projDir, `${SID}.jsonl`);
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}
const estate = {}; // the schema defaults: warm from 14 days, never deleteCold
const run = (s) => runEstate({ projectRoot: s.proj, home: s.home, estate });
function restoreTo(s, opts = {}) {
  const to = path.join(s.out, String(opts.generation ?? 'current') + '-' + Math.random().toString(16).slice(2, 8));
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to, ...opts });
  return { r, text: r.ok ? fs.readFileSync(path.join(to, `${SID}.jsonl`), 'utf8') : null };
}
// Every distinct copy the archive will give back: the default restore, then --generation 1..8 (an install that does not
// know the option returns its default copy each time, so copies are counted once each).
function everyRestorable(s) {
  const got = new Set();
  const cur = restoreTo(s);
  if (cur.text !== null) got.add(cur.text);
  for (let g = 1; g <= 8; g++) { const x = restoreTo(s, { generation: g }); if (x.r.ok && x.text !== null) got.add(x.text); }
  return [...got];
}
// archive -> restore into the projects folder -> rewrite -> age past the band -> archive again
function reArchive(s, rewrite) {
  seed(s, ORIGINAL);
  const r1 = run(s);
  assert.strictEqual(r1.archived.length, 1, JSON.stringify(r1));
  const back = restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir });
  assert.ok(back.ok, JSON.stringify(back));
  seed(s, rewrite(fs.readFileSync(path.join(s.projDir, `${SID}.jsonl`), 'utf8')));
  const r2 = run(s);
  assert.strictEqual(r2.archived.length, 1, JSON.stringify(r2));
}

test('W1: a re-archive of a session rewritten as a NON-prefix keeps every byte of the first archive restorable', (t) => {
  const s = sandbox(t);
  const EDITED = ORIGINAL.replace('The middle line, said once', 'The middle line, said differently');
  reArchive(s, () => EDITED);
  const got = everyRestorable(s);
  assert.ok(got.includes(EDITED), 'the newest copy is restorable');
  assert.ok(got.includes(ORIGINAL), `every byte of the first archive is still restorable (restorable copies: ${got.length})`);
});

test('W2: a re-archive of a session rewritten by APPEND keeps exactly one copy and loses nothing', (t) => {
  const s = sandbox(t);
  const APPENDED = ORIGINAL + line(4, 'one more line') + '\n';
  reArchive(s, (cur) => cur + line(4, 'one more line') + '\n');
  const got = everyRestorable(s);
  assert.deepStrictEqual(got, [APPENDED], 'one copy, the superset');
  assert.ok(got[0].startsWith(ORIGINAL), 'the first archive is its prefix');
});

const genFiles = (s) => {
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.gz\.gen\d+$/.test(e.name)) out.push(p); } };
  walk(s.archiveDir);
  return out.sort();
};
const childEnv = (s) => ({
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT,
  HOME: s.home, USERPROFILE: s.home, TEMP: path.join(s.root, 'tmp'), TMP: path.join(s.root, 'tmp'), TMPDIR: path.join(s.root, 'tmp'),
  CLAUDE_PROJECT_DIR: s.proj, NODE_OPTIONS: '--max-old-space-size=2048',
}); // an allowlist: no CLAUDE_CONFIG_DIR, no CLAUDE_PLUGIN_*, no CLAUDE_CODE_SESSION_ATTENDED
function cli(s, args) {
  fs.mkdirSync(path.join(s.root, 'tmp'), { recursive: true });
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'lib', 'cli.mjs'), ...args], { cwd: s.proj, env: childEnv(s), encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
}
const V2 = ORIGINAL.replace('The middle line, said once', 'The middle line, said differently');
const V3 = V2.replace('Ledger gauge done', 'Ledger gauge finished');
const gzPathOf = (s) => path.join(s.archiveDir, ccProjectSlug(s.proj), `${SID}.jsonl.gz`);
function damage(s) { const p = gzPathOf(s); const bad = Buffer.from(fs.readFileSync(p)); bad[bad.length - 6] ^= 0xff; fs.writeFileSync(p, bad); return bad; } // the CRC trailer no longer matches

test('(a) after three archives with two non-prefix rewrites, every earlier copy is restorable and each re-archive kept one generation', (t) => {
  const s = sandbox(t);
  reArchive(s, () => V2);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seed(s, V3);
  assert.strictEqual(run(s).archived[0].generation, 2, 'the second re-archive kept generation 2');
  const got = everyRestorable(s);
  for (const [name, v] of [['ORIGINAL', ORIGINAL], ['V2', V2], ['V3', V3]]) assert.ok(got.includes(v), `${name} is restorable`);
  assert.strictEqual(restoreTo(s).text, V3, 'the default restore returns the newest');
  assert.strictEqual(restoreTo(s, { generation: 1 }).text, ORIGINAL);
  assert.strictEqual(restoreTo(s, { generation: 2 }).text, V2);
});

test('(b) the prefix test reads CONTENT: a same-size rewrite and a longer non-prefix rewrite are each kept as a generation', (t) => {
  for (const [label, rewrite] of [
    ['same size', (cur) => cur.replace('said once', 'SAID ONCE')],
    ['longer, not a prefix', (cur) => 'X' + cur],
  ]) {
    const s = sandbox(t);
    reArchive(s, rewrite);
    assert.strictEqual(genFiles(s).length, 1, `${label}: the earlier copy was kept`);
    assert.strictEqual(restoreTo(s, { generation: 1 }).text, ORIGINAL, `${label}: generation 1 is the first archive, byte for byte`);
  }
});

test('(b) an earlier copy that does not decompress is kept, never judged a prefix', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  run(s);
  const bad = damage(s);
  seed(s, ORIGINAL + line(4, 'later') + '\n');
  assert.strictEqual(run(s).archived[0].generation, 1);
  assert.ok(fs.readFileSync(genFiles(s)[0]).equals(bad), 'the damaged copy was kept byte for byte');
});

test('(c) the CLI restore line says which copy it returned and how to reach the others; the usage names --generation', (t) => {
  const s = sandbox(t);
  reArchive(s, () => V2);
  const a = cli(s, ['estate-restore', SID, '--to', path.join(s.root, 'r1')]);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /restored the newest archived copy of session /);
  assert.match(a.stdout, /other copies kept: generation 1 — restore one with: cli\.mjs estate-restore \S+ --generation <N>/);
  const b = cli(s, ['estate-restore', SID, '--generation', '1', '--to', path.join(s.root, 'r2')]);
  assert.strictEqual(b.status, 0, b.stderr);
  assert.match(b.stdout, /restored generation 1 \(an earlier copy, kept when a later archive of this session was not a superset of it\)/);
  assert.match(b.stdout, /other copies kept: the newest/);
  assert.strictEqual(fs.readFileSync(path.join(s.root, 'r2', `${SID}.jsonl`), 'utf8'), ORIGINAL);
  const c = cli(s, ['estate-restore', SID, '--generation', '0']);
  assert.strictEqual(c.status, 1);
  assert.match(c.stderr, /--generation takes a whole number from 1 up/);
  assert.match(c.stderr, /estate-restore <sessionId> \[--generation <N>\]/);
  const d = cli(s, ['estate-restore', SID, '--generation', '7']);
  assert.strictEqual(d.status, 1);
  assert.match(d.stderr, /generation 7 of session .* is not in the archive .*earlier copies kept: generation 1/);
});

test('(d) estate-search lists one row per session: the newest, plus one marked row per kept generation; an append re-archive leaves one row', (t) => {
  const s = sandbox(t);
  reArchive(s, () => V2);
  const rows = searchIndex('CW29GT-NEEDLE', { archiveDir: s.archiveDir });
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  assert.strictEqual(rows[0].generation, 1, 'the earlier row is marked as generation 1');
  assert.strictEqual(rows[1].generation, undefined, 'the newest row is not marked');
  const out = cli(s, ['estate-search', 'CW29GT-NEEDLE']);
  assert.match(out.stdout, /\[earlier copy: generation 1 — estate-restore \S+ --generation 1\]/);
  const s2 = sandbox(t);
  reArchive(s2, (cur) => cur + line(4, 'more') + '\n');
  const raw = fs.readFileSync(path.join(s2.archiveDir, 'index.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(raw.length, 2, 'the index file still holds both appended rows');
  assert.strictEqual(searchIndex('CW29GT-NEEDLE', { archiveDir: s2.archiveDir }).length, 1, 'search shows one row');
});

test('W752-2: a prefix re-archive that fails partway keeps the earlier archived copy restorable', (t) => {
  const s = sandbox(t);
  seed(s, V2);
  run(s);
  const before = fs.readFileSync(gzPathOf(s));
  seed(s, V2 + line(4, 'one appended line') + '\n'); // a prefix superset: nothing is kept as a generation
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  // the seam: a gzip that writes bytes that do not verify, so the run fails AFTER the new copy is written over the old name
  const r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir, gzip: () => Buffer.from('not a gzip stream') });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(genFiles(s), [], 'a prefix keeps no generation');
  assert.ok(fs.existsSync(gzPathOf(s)) && fs.readFileSync(gzPathOf(s)).equals(before), 'the earlier archived copy is back at its name, byte for byte');
  assert.ok(everyRestorable(s).includes(V2), "the earlier copy's bytes are restorable after the failed run");
});

test('W752-1: a damaged generation is refused naming the newest copy and only the other kept generations, said once', (t) => {
  const s = sandbox(t);
  reArchive(s, () => V2); // generation 1 holds ORIGINAL, the newest copy holds V2
  const gen1 = genFiles(s)[0];
  const bad = Buffer.from(fs.readFileSync(gen1)); bad[bad.length - 6] ^= 0xff; fs.writeFileSync(gen1, bad);
  const r = cli(s, ['estate-restore', SID, '--generation', '1']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /generation 1 is damaged \(it does not decompress\), so nothing was restored from it/);
  assert.match(r.stderr, /restore the newest copy without --generation/);
  assert.doesNotMatch(r.stderr, /kept: generation 1\b/, 'the damaged generation is not offered back');
  assert.strictEqual((r.stderr.match(/with --generation/g) || []).length, 0, 'no other generation is kept, so no --generation advice');
  assert.strictEqual(restoreTo(s).text, V2, 'the newest copy it names is intact');
});

test('(e) a re-archive never deletes an earlier generation, even when it fails; deleteCold and the bands are untouched', (t) => {
  const s = sandbox(t);
  reArchive(s, () => V2);
  const before = genFiles(s).map((p) => [p, fs.readFileSync(p)]);
  assert.strictEqual(before.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seed(s, V3);
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  // a gzip that writes bytes that do not verify: the session fails and its partial archive is cleaned up
  const r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir, gzip: () => Buffer.from('not a gzip stream') });
  assert.strictEqual(r.ok, false);
  for (const [p, bytes] of before) assert.ok(fs.existsSync(p) && fs.readFileSync(p).equals(bytes), `${p} survived the failed run unchanged`);
  assert.ok(genFiles(s).length >= before.length, 'no generation file was removed');
  const got = everyRestorable(s);
  assert.ok(got.includes(ORIGINAL) && got.includes(V2), `every copy archived before the failed run is still restorable (${got.length} copies)`);
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'the failed run kept the original');
  assert.deepStrictEqual(Object.keys(estate), [], 'the run used the schema defaults: deleteCold stays off');
});

test('schema: rows written now carry rowSchema 2; an older estate (no rowSchema, no generation files, duplicate rows) still reads and restores', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  run(s);
  const rows = fs.readFileSync(path.join(s.archiveDir, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows[0].rowSchema, 2);
  const old = rows.map(({ rowSchema, ...rest }) => rest); // as an older install left it
  fs.writeFileSync(path.join(s.archiveDir, 'index.jsonl'), [old[0], { ...old[0], msgCount: 1 }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const found = searchIndex('CW29GT-NEEDLE', { archiveDir: s.archiveDir });
  assert.strictEqual(found.length, 1, 'duplicate older rows collapse to the last one');
  assert.strictEqual(found[0].msgCount, 1);
  const r = restoreTo(s);
  assert.strictEqual(r.text, ORIGINAL);
  assert.deepStrictEqual(r.r.generations, []);
});

test('(e) something already standing at the generation name refuses the re-archive: nothing written over, originals and the current copy kept', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  run(s);
  // a directory at the name is not counted as a generation (only files are), so the run picks generation 1 and finds it taken
  const planted = `${gzPathOf(s)}.gen1`;
  fs.mkdirSync(planted);
  fs.writeFileSync(path.join(planted, 'inside'), 'planted');
  const current = fs.readFileSync(gzPathOf(s));
  seed(s, V2);
  const r = run(s);
  assert.strictEqual(r.archived.length, 0);
  assert.match(r.failed[0].reason, /something already stands at the generation name/);
  assert.strictEqual(fs.readFileSync(path.join(planted, 'inside'), 'utf8'), 'planted', 'the planted entry is untouched');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(current), 'the current copy is untouched');
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'the original is kept');
});

test('a damaged archive is refused in plain words with zlib in brackets, and the refused restore leaves no empty folder in temp', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  run(s);
  damage(s);
  const r = cli(s, ['estate-restore', SID]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /the archived copy is damaged \(it does not decompress\), so nothing was restored from it/);
  assert.match(r.stderr, /\[zlib: [^\]]+\]/);
  assert.deepStrictEqual(fs.readdirSync(path.join(s.root, 'tmp')).filter((n) => n.startsWith('coalwash-estate-')), [], 'no empty restore folder is left behind');
});
