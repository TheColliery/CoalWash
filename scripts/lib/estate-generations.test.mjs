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
import { runEstate, runEstateReport, restoreSession, searchIndex, archiveSession, listSessions, resolveArchiveDir, resolveEstateCfg } from './estate-archive.mjs';
import { ccProjectSlug } from './class-b.mjs';
import { clampedRead } from './config-schema.mjs';
import { mergeSafety, PROJECT_BOUNDED_KEYS } from './config-load.mjs';

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
  // 29gz fire 762 (CodeRabbit t335 F7): an outcome, never the config's own spelling. Under the schema defaults a 200-day session
  // beside this one is listed cold, kept live and never archived, so deleteCold is off and the cold band is intact.
  const coldP = path.join(s.projDir, `${SID2}.jsonl`);
  fs.writeFileSync(coldP, ORIGINAL.replace('CW29GT-NEEDLE', 'CW29GT-COLD'));
  const longAgo = new Date(Date.now() - 200 * DAY);
  fs.utimesSync(coldP, longAgo, longAgo);
  const r2 = run(s);
  assert.ok(r2.coldListed.some((c) => c.id === SID2), 'the 200-day session is listed cold under the schema defaults');
  assert.ok(!r2.archived.some((a) => a.id === SID2) && fs.existsSync(coldP), 'and is kept live, never archived: deleteCold is off');
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

// ---------------------------------------------------------------------------
// 29gx fire 756: the generation bound (estate.maxGenerations) and the write, verify, then replace kill window
// ---------------------------------------------------------------------------

const SID2 = 'b2222222-2222-4222-8222-222222222222';
const V4 = V3.replace('Working on the Ledger gauge', 'Still working on the Ledger gauge');
// Archive ORIGINAL, then each later version as a non-prefix rewrite: one generation per rewrite.
function withGenerations(s, versions) {
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  for (const v of versions) {
    assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
    seed(s, v);
    const r = run(s);
    assert.strictEqual(r.archived.length, 1, JSON.stringify(r));
  }
}
const archiveBytes = (s) => {
  const out = new Map();
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.gz(\.gen\d+)?$/.test(e.name)) out.set(p, fs.readFileSync(p)); } };
  walk(s.archiveDir);
  return out;
};
const leftovers = (s) => {
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.coalwash-(new|tmp)$/.test(e.name)) out.push(p); } };
  walk(s.archiveDir);
  return out;
};

test('756 bound: past estate.maxGenerations an edited re-archive is refused in words; every copy and the live session are unchanged; other sessions still archive', (t) => {
  const s = sandbox(t);
  withGenerations(s, [V2, V3]); // generations 1 and 2 hold ORIGINAL and V2, the newest copy holds V3
  assert.strictEqual(genFiles(s).length, 2);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  const live = seed(s, V4); // a non-prefix rewrite: archiving it would need a third generation
  const other = path.join(s.projDir, `${SID2}.jsonl`);
  fs.writeFileSync(other, ORIGINAL.replace('CW29GT-NEEDLE', 'CW29GT-OTHER'));
  const aged = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(other, aged, aged);
  const before = archiveBytes(s);
  const liveBytes = fs.readFileSync(live);
  const r = runEstate({ projectRoot: s.proj, home: s.home, estate: { maxGenerations: 2 } });
  assert.deepStrictEqual(r.archived.map((a) => a.id), [SID2], 'the other session is still archived');
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].id, SID);
  const words = r.failed[0].reason;
  assert.match(words, /already keeps 2 generations, the most estate\.maxGenerations allows \(2\)/, 'what happened, with the key');
  assert.match(words, /nothing was archived or removed/, 'what was not done');
  assert.match(words, /raise estate\.maxGenerations/, 'what the person can do');
  assert.ok(runEstateReport(r).includes(`KEPT ${SID}: ${words}`), 'the refusal is named in the run output');
  for (const [p, bytes] of before) assert.ok(fs.existsSync(p) && fs.readFileSync(p).equals(bytes), `${p} is byte-identical`);
  assert.deepStrictEqual([...archiveBytes(s).keys()].filter((p) => !p.includes(SID2)).sort(), [...before.keys()].sort(), 'no copy of the refused session was added or removed');
  assert.ok(fs.readFileSync(live).equals(liveBytes), 'the live session is untouched');
  assert.deepStrictEqual(leftovers(s), [], 'no staged file is left behind');
  const st = cli(s, ['estate', '--json']);
  assert.strictEqual(st.status, 0, st.stderr);
  const rep = JSON.parse(st.stdout);
  assert.strictEqual(rep.generationRefusals && rep.generationRefusals.count, 1, 'the refusal is counted for /coalwash:stats');
  assert.match(rep.generationRefusals.since, /^\d{4}-\d{2}-\d{2}T/);
});

test('756 bound 0: no extra copy is kept, so an edited re-archive is refused and an appended one still archives', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  const first = fs.readFileSync(gzPathOf(s));
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seed(s, V2);
  const r = runEstate({ projectRoot: s.proj, home: s.home, estate: { maxGenerations: 0 } });
  assert.strictEqual(r.archived.length, 0);
  assert.match(r.failed[0].reason, /the most estate\.maxGenerations allows \(0\)/);
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(first), 'the archived copy is unchanged');
  assert.deepStrictEqual(genFiles(s), [], 'no generation was written');
  seed(s, ORIGINAL + line(4, 'appended') + '\n');
  const r2 = runEstate({ projectRoot: s.proj, home: s.home, estate: { maxGenerations: 0 } });
  assert.strictEqual(r2.archived.length, 1, 'an append needs no generation, so the bound never refuses it');
});

test('756 key: estate.maxGenerations defaults to 10, accepts 0 to 1000, and a non-number or out-of-range value reads as the default', () => {
  assert.strictEqual(clampedRead({}, 'estate').maxGenerations, 10);
  assert.strictEqual(resolveEstateCfg({}).maxGenerations, 10);
  for (const v of [0, 1, 1000]) {
    assert.strictEqual(clampedRead({ estate: { maxGenerations: v } }, 'estate').maxGenerations, v);
    assert.strictEqual(resolveEstateCfg({ maxGenerations: v }).maxGenerations, v);
  }
  for (const v of ['ten', '3', 2.5, -1, 1001, null, true, [3], {}]) {
    assert.strictEqual(clampedRead({ estate: { maxGenerations: v } }, 'estate').maxGenerations, 10, `clampedRead ${JSON.stringify(v)}`);
    assert.strictEqual(resolveEstateCfg({ maxGenerations: v }).maxGenerations, 10, `resolveEstateCfg ${JSON.stringify(v)}`);
  }
});

test('756 clamp: a project estate.maxGenerations may only LOWER the user\'s own value (the schema default when the global is absent)', () => {
  const m = (g, p, o) => mergeSafety(g, p, o).estate.maxGenerations;
  assert.strictEqual(m({ estate: { maxGenerations: 5 } }, { estate: { maxGenerations: 3 } }), 3, 'lower: honored');
  assert.strictEqual(m({ estate: { maxGenerations: 5 } }, { estate: { maxGenerations: 0 } }), 0, 'lower to 0: honored');
  assert.strictEqual(m({ estate: { maxGenerations: 5 } }, { estate: { maxGenerations: 8 } }), 5, 'raise: the global value stands');
  assert.strictEqual(m({}, { estate: { maxGenerations: 4 } }), 4, 'no global: lower than the default 10 is honored');
  const noGlobal = mergeSafety({}, { estate: { maxGenerations: 20 } }).estate;
  assert.strictEqual(clampedRead({ estate: noGlobal }, 'estate').maxGenerations, 10, 'no global: a raise past the default reads the default');
  const junk = mergeSafety({ estate: { maxGenerations: 5 } }, { estate: { maxGenerations: 'x' } }).estate;
  assert.strictEqual(junk.maxGenerations, 5, 'a value the schema rejects has no say');
  const unreadable = mergeSafety({ estate: { maxGenerations: 50 } }, { estate: { maxGenerations: 30 } }, { globalUnreadable: true }).estate;
  assert.strictEqual(clampedRead({ estate: unreadable }, 'estate').maxGenerations, 10, 'an unreadable global reads as the default, and 30 is a raise past it');
  assert.ok(PROJECT_BOUNDED_KEYS.includes('estate.maxGenerations'), 'a dropped project value is reported loud');
});

// The kill window (main's ruling 2): a child archives through archiveSession with a gzip whose bytes do not verify, and kills
// itself by SIGKILL at its k-th lock check after the gzip, before anything after that check runs. The tests sweep k from 1 until
// the child returns on its own, a fresh fixture each time, so a kill lands at every fence of the run. In b50d11f the second check
// came after the new copy had been written over the archive's own name, with the earlier copy held only in memory for a put-back.
const KILL_CHILD = [
  "import fs from 'node:fs';",
  "import { pathToFileURL } from 'node:url';",
  "import zlib from 'node:zlib';",
  'const [lib, projectRoot, home, archiveDir, slug, sid, marker, killAt, mode] = process.argv.slice(2);',
  'const { archiveSession, listSessions } = await import(pathToFileURL(lib).href);',
  'const sess = listSessions({ projectRoot, home }).sessions.find((x) => x.id === sid);',
  'let gzipped = false; let checks = 0;',
  'const r = archiveSession(sess, { slug, archiveDir,',
  "  gzip: () => { gzipped = true; return mode === 'wrong' ? zlib.gzipSync(Buffer.from('a valid gzip stream of the wrong bytes')) : Buffer.from('not a gzip stream'); },",
  "  lockState: () => { if (gzipped && ++checks === Number(killAt)) { fs.writeFileSync(marker, 'killed'); process.kill(process.pid, 'SIGKILL'); } return { state: 'own' }; } });",
  "fs.writeFileSync(marker, 'returned ' + JSON.stringify(r));",
].join('\n');
function killMidArchive(s, k, mode = 'bad') {
  const child = path.join(s.root, 'kill-child.mjs');
  fs.writeFileSync(child, KILL_CHILD);
  fs.mkdirSync(path.join(s.root, 'tmp'), { recursive: true });
  const marker = path.join(s.root, 'kill-marker');
  const r = spawnSync(process.execPath, [child, path.join(REPO, 'scripts', 'lib', 'estate-archive.mjs'), s.proj, s.home, s.archiveDir, ccProjectSlug(s.proj), SID, marker, String(k), mode],
    { cwd: s.proj, env: childEnv(s), encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  const said = fs.readFileSync(marker, 'utf8');
  if (said !== 'killed') { assert.strictEqual(r.status, 0, r.stderr); return false; } // the run returned before its k-th check
  assert.notStrictEqual(r.status, 0, `the killed child did not exit cleanly (signal ${r.signal})`);
  return true;
}
const KILL_MAX = 8; // more checks than one failing single-file run makes; the sweep fails loud if the run never returns
function sweepKills(t, version, after, mode = 'bad') {
  for (let k = 1; ; k++) {
    assert.ok(k <= KILL_MAX, `the run still had a lock check at k = ${KILL_MAX}`);
    const s = sandbox(t);
    seed(s, V2);
    assert.strictEqual(run(s).archived.length, 1);
    const earlier = fs.readFileSync(gzPathOf(s));
    seed(s, version);
    const killed = killMidArchive(s, k, mode);
    assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), `k=${k}: after the kill the archive name still holds the earlier copy, byte for byte`);
    assert.strictEqual(restoreTo(s).text, V2, `k=${k}: and it restores the earlier copy byte for byte`);
    assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), `k=${k}: the original was never removed`);
    const next = run(s);
    assert.strictEqual(next.archived.length, 1, JSON.stringify(next));
    assert.deepStrictEqual(leftovers(s), [], `k=${k}: the next run collected every staged file the killed run left`);
    after(s, everyCopyRestores(s), k);
    if (!killed) return k;
  }
}
function everyCopyRestores(s) {
  const cur = restoreTo(s);
  assert.ok(cur.r.ok, `the newest copy restores: ${JSON.stringify(cur.r)}`);
  const texts = [cur.text];
  for (const p of genFiles(s)) {
    const n = Number(/\.gen(\d+)$/.exec(p)[1]);
    const g = restoreTo(s, { generation: n });
    assert.ok(g.r.ok, `generation ${n} restores, nothing half-written was taken for a generation: ${JSON.stringify(g.r)}`);
    texts.push(g.text);
  }
  return texts;
}

test('756 kill: a prefix re-archive killed by SIGKILL at every lock check loses or corrupts no copy, and the next run collects what it left', (t) => {
  const LONGER = V2 + line(4, 'one appended line') + '\n';
  for (const mode of ['bad', 'wrong']) { // a gzip that does not decompress, then one that decompresses to the wrong bytes
    const checks = sweepKills(t, LONGER, (s, texts, k) => {
      assert.strictEqual(texts[0], LONGER, `${mode} k=${k}: the newest copy is the appended session`);
      assert.ok(texts[0].startsWith(V2), 'the earlier copy is its prefix (the designed append replace)');
      assert.strictEqual(texts.length, 1, `${mode} k=${k}: no damaged or duplicate generation was made`);
    }, mode);
    assert.ok(checks >= 2, `${mode}: the sweep reached the failure's own check (${checks})`);
  }
});

test('756 kill: a non-prefix re-archive killed by SIGKILL at every lock check loses or corrupts no copy, and the next run keeps the earlier one', (t) => {
  for (const mode of ['bad', 'wrong']) {
    const checks = sweepKills(t, V3, (s, texts, k) => {
      assert.deepStrictEqual(texts.slice().sort(), [V2, V3].sort(), `${mode} k=${k}: the newest copy and one generation holding the earlier copy, each byte for byte`);
    }, mode);
    assert.ok(checks >= 2, `${mode}: the sweep reached the failure's own check (${checks})`);
  }
});

// A session of two files: the transcript and one file in its own folder (the shape listSessions walks).
function seedTwo(s, transcript, extra) {
  seed(s, transcript);
  const dir = path.join(s.projDir, SID, 'tool-results');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'a.txt');
  fs.writeFileSync(p, extra);
  const aged = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(p, aged, aged);
  return p;
}

test('756 commit: a rename that fails inside the commit puts every replaced copy back and keeps the committed generation', (t) => {
  const s = sandbox(t);
  seedTwo(s, V2, 'extra file, first version\n');
  assert.strictEqual(run(s).archived.length, 1);
  const slugDir = path.dirname(gzPathOf(s));
  const extraGz = path.join(slugDir, SID, 'tool-results', 'a.txt.gz');
  const before = archiveBytes(s);
  assert.deepStrictEqual([...before.keys()].sort(), [gzPathOf(s), extraGz].sort());
  seedTwo(s, V2 + line(4, 'appended') + '\n', 'extra file, edited\n'); // the transcript is a prefix replace, the extra file keeps a generation
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const real = fs.renameSync;
  let n = 0;
  fs.renameSync = function patched(a, b) { if (++n === 3) throw Object.assign(new Error('EPERM: simulated, the third commit rename'), { code: 'EPERM' }); return real.call(fs, a, b); };
  let r;
  try { r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir }); } finally { fs.renameSync = real; }
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /archive commit failed: EPERM/);
  for (const [p, bytes] of before) assert.ok(fs.readFileSync(p).equals(bytes), `${path.basename(p)} is back as it was`);
  assert.deepStrictEqual(genFiles(s).map((p) => path.basename(p)), ['a.txt.gz.gen1'], 'the committed generation stays');
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(genFiles(s)[0])).toString(), 'extra file, first version\n');
  assert.deepStrictEqual(leftovers(s), [], 'no staged file is left behind');
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'the originals are kept');
});

test('756 stats: an archive with no refusal record reads 0 and prints no refusal line; a foreign or broken line is skipped; the record is no archive copy', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  run(s);
  let st = cli(s, ['estate', '--json']);
  assert.strictEqual(st.status, 0, st.stderr);
  assert.deepStrictEqual(JSON.parse(st.stdout).generationRefusals, { count: 0, since: null }, 'an archive written before the record existed');
  st = cli(s, ['estate']);
  assert.doesNotMatch(st.stdout, /generation-bound refusals/);
  const slug = ccProjectSlug(s.proj);
  const rec = (ts, extra = {}) => JSON.stringify({ timestamp: ts, severity: 'WARN', event: 'generation-bound-refusal', sessionId: SID, projectSlug: slug, kept: 2, bound: 2, ...extra });
  fs.writeFileSync(path.join(s.archiveDir, 'generation-refusals.jsonl'), [rec('2026-11-02T00:00:00.000Z'), 'not json', rec('2026-11-01T00:00:00.000Z'), rec('2026-10-01T00:00:00.000Z', { projectSlug: 'another-project' }), JSON.stringify({ event: 'other' })].join('\n') + '\n');
  st = cli(s, ['estate', '--json']);
  assert.deepStrictEqual(JSON.parse(st.stdout).generationRefusals, { count: 2, since: '2026-11-01T00:00:00.000Z' }, 'this project only, the earliest');
  assert.match(cli(s, ['estate']).stdout, /generation-bound refusals \(this project\): 2 since 2026-11-01T00:00:00\.000Z/);
  assert.strictEqual(restoreTo(s).text, ORIGINAL, 'restore reads past the record');
  assert.strictEqual(searchIndex('CW29GT-NEEDLE', { archiveDir: s.archiveDir }).length, 1, 'search reads past the record');
});

test('756 collector: only the staged-file names of the session being archived are removed; anything else is left alone', (t) => {
  const s = sandbox(t);
  seed(s, V2);
  assert.strictEqual(run(s).archived.length, 1);
  const slugDir = path.dirname(gzPathOf(s));
  const hex = 'ab'.repeat(12);
  const ours = [`${SID}.jsonl.gz.${hex}.coalwash-new`, `${SID}.jsonl.gz.gen1.${hex}.coalwash-new`, `${SID}.jsonl.gz.${hex}.coalwash-tmp`];
  const notOurs = [`${SID2}.jsonl.gz.${hex}.coalwash-new`, `${SID}.jsonl.gz.short.coalwash-new`, `${SID}.jsonl.${hex}.coalwash-new`, `${SID}.note.txt`];
  for (const n of [...ours, ...notOurs]) fs.writeFileSync(path.join(slugDir, n), 'leftover');
  const dirName = `${SID}.jsonl.gz.${'cd'.repeat(12)}.coalwash-new`;
  fs.mkdirSync(path.join(slugDir, dirName)); // a directory with a staged name is never removed
  seed(s, V3);
  assert.strictEqual(run(s).archived.length, 1);
  for (const n of ours) assert.ok(!fs.existsSync(path.join(slugDir, n)), `${n} collected`);
  for (const n of notOurs) assert.strictEqual(fs.readFileSync(path.join(slugDir, n), 'utf8'), 'leftover', `${n} left alone`);
  assert.ok(fs.statSync(path.join(slugDir, dirName)).isDirectory(), 'the directory is left alone');
  assert.deepStrictEqual(everyCopyRestores(s).slice().sort(), [V2, V3].sort());
});

test('756 verify: a staged generation that does not read back is never renamed onto its name', (t) => {
  const s = sandbox(t);
  seed(s, V2);
  assert.strictEqual(run(s).archived.length, 1);
  const earlier = fs.readFileSync(gzPathOf(s));
  seed(s, V3); // a non-prefix rewrite: the earlier copy is staged as generation 1
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const real = fs.writeSync;
  // the seam: a write of the earlier copy's bytes lands short, as a disk fault would leave it
  fs.writeSync = function patched(fd, data, ...rest) {
    if (Buffer.isBuffer(data) && data.equals(earlier)) return real.call(fs, fd, data.subarray(0, data.length >> 1));
    return real.call(fs, fd, data, ...rest);
  };
  let r;
  try { r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir }); } finally { fs.writeSync = real; }
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /the kept generation of .* does not read back/);
  assert.deepStrictEqual(genFiles(s), [], 'no generation was committed');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the earlier copy is unchanged');
  assert.deepStrictEqual(leftovers(s), [], 'no staged file is left behind');
});

test('756 commit: something that appears at the generation name after staging stops the commit and is left untouched', (t) => {
  const s = sandbox(t);
  seedTwo(s, V2, 'extra file\n');
  assert.strictEqual(run(s).archived.length, 1);
  const earlier = fs.readFileSync(gzPathOf(s));
  seedTwo(s, V3, 'extra file\n'); // the transcript keeps generation 1; the extra file is unchanged
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const planted = `${gzPathOf(s)}.gen1`;
  let calls = 0;
  // the seam: the gzip of the second file runs after the first file's generation is staged; a file appears at its name then
  const gzip = (buf) => { if (++calls === 2) fs.writeFileSync(planted, 'planted'); return zlib.gzipSync(buf); };
  const r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir, gzip });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /something already stands at the generation name/);
  assert.strictEqual(fs.readFileSync(planted, 'utf8'), 'planted', 'the entry at the name is untouched');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the earlier copy is unchanged');
  assert.deepStrictEqual(leftovers(s), [], 'no staged file is left behind');
});

// ---------------------------------------------------------------------------
// 29gz fire 762: PATCH 1.19.1 (CodeRabbit t335 F3, F2, F5; lab F-1, O-3, O-4)
// ---------------------------------------------------------------------------

// The seam of the reviewer's witness `scratchpad/29gd/w335.mjs`: fs.renameSync patched to flip one byte of a staged file just before
// it is renamed onto the name `onto` matches, standing in for an outside writer on the archive folder. Returns the run's result.
function archiveWithFlip(s, onto) {
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const real = fs.renameSync;
  let flipped = false;
  fs.renameSync = function patched(a, b) {
    if (!flipped && String(a).endsWith('.coalwash-new') && onto.test(String(b))) {
      const buf = fs.readFileSync(a);
      buf[buf.length >> 1] ^= 0x01;
      fs.writeFileSync(a, buf);
      flipped = true;
    }
    return real.call(fs, a, b);
  };
  let r;
  try { r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir }); } finally { fs.renameSync = real; }
  assert.ok(flipped, 'the seam fired: a staged file was altered before its rename');
  return r;
}
function v2ArchivedThenV3Live(s) {
  seed(s, V2);
  assert.strictEqual(run(s).archived.length, 1);
  const earlier = fs.readFileSync(gzPathOf(s));
  seed(s, V3); // a non-prefix rewrite: the earlier copy is kept as generation 1
  return earlier;
}

test('762 F3: a kept generation altered after its verify stops the run before any live file is deleted, and the earlier copy restores', (t) => {
  const s = sandbox(t);
  const earlier = v2ArchivedThenV3Live(s);
  const r = archiveWithFlip(s, /\.gen\d+$/);
  assert.strictEqual(r.ok, false, `the run must not report success: ${JSON.stringify(r)}`);
  assert.match(r.reason, /the kept generation of .* changed after it was verified/);
  assert.strictEqual(fs.readFileSync(path.join(s.projDir, `${SID}.jsonl`), 'utf8'), V3, 'the live session is untouched');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the earlier copy is back under its archive name, byte for byte');
  assert.strictEqual(restoreTo(s).text, V2, 'and it restores');
  assert.deepStrictEqual(leftovers(s), [], 'no staged file is left behind');
});

test('762 F3: a new copy altered after its verify stops the run before any live file is deleted, and the earlier copy restores', (t) => {
  const s = sandbox(t);
  const earlier = v2ArchivedThenV3Live(s);
  const r = archiveWithFlip(s, new RegExp(`${SID}\\.jsonl\\.gz$`));
  assert.strictEqual(r.ok, false, `the run must not report success: ${JSON.stringify(r)}`);
  assert.match(r.reason, /the archive copy of .* changed after it was verified/);
  assert.strictEqual(fs.readFileSync(path.join(s.projDir, `${SID}.jsonl`), 'utf8'), V3, 'the live session is untouched');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the earlier copy is back under its archive name, byte for byte');
  assert.strictEqual(restoreTo(s).text, V2, 'and it restores');
});

test('762 F2: a lock taken over between two commit renames stops the run there, before the next rename, with no clean-up', (t) => {
  const s = sandbox(t);
  const earlier = v2ArchivedThenV3Live(s);
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const genPath = `${gzPathOf(s)}.gen1`;
  // the seam: the lock reads as taken over from the moment the generation has been renamed onto its name
  const lockState = () => (fs.existsSync(genPath) ? { state: 'stolen' } : { state: 'own' });
  const r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir, lockState });
  assert.strictEqual(r.robbed, 'global', JSON.stringify(r));
  assert.match(r.reason, /stopped before the commit of the archive copy of/);
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the archive copy was not renamed after the theft');
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'no live file was deleted');
  assert.strictEqual(leftovers(s).length, 1, 'robbed means no clean-up: the staged copy stays for the next run to collect');
});

test('762 F2: a lock taken over just before the generation rename stops the run there: nothing is renamed and nothing is cleaned up', (t) => {
  const s = sandbox(t);
  const earlier = v2ArchivedThenV3Live(s);
  const sess = listSessions({ projectRoot: s.proj, home: s.home }).sessions.find((x) => x.id === SID);
  const slugDir = path.dirname(gzPathOf(s));
  // the seam: the lock reads as taken over once both staged files exist (the loop is done and the commit is next)
  const staged = () => fs.readdirSync(slugDir).filter((n) => n.endsWith('.coalwash-new')).length;
  const lockState = () => (staged() >= 2 ? { state: 'stolen' } : { state: 'own' });
  const r = archiveSession(sess, { slug: ccProjectSlug(s.proj), archiveDir: s.archiveDir, lockState });
  assert.strictEqual(r.robbed, 'global', JSON.stringify(r));
  assert.match(r.reason, /stopped before the commit of the kept generation of/);
  assert.deepStrictEqual(genFiles(s), [], 'the generation was not renamed onto its name');
  assert.ok(fs.readFileSync(gzPathOf(s)).equals(earlier), 'the archive copy was not renamed');
  assert.strictEqual(leftovers(s).length, 2, 'robbed means no clean-up: both staged files stay for the next run to collect');
});

// A two-file session archived twice with an edit between: generation 1 holds both earlier files. The transcript is the first file
// restore reads (the slug folder's flat files come before the session folder).
const EXTRA1 = 'extra file, first version\n';
const EXTRA2 = 'extra file, edited\n';
function twoFileTwoArchives(s) {
  seedTwo(s, V2, EXTRA1);
  assert.strictEqual(run(s).archived.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seedTwo(s, V3, EXTRA2);
  const r = run(s);
  assert.strictEqual(r.archived.length, 1, JSON.stringify(r));
  assert.strictEqual(genFiles(s).length, 2, 'generation 1 holds both earlier files');
}
// The two files of the copy, by the name each has in the restore target, its archive path, and the bytes it holds in each copy.
const F1_FILES = {
  transcript: { rel: (sid) => `${sid}.jsonl`, gz: (s) => gzPathOf(s), newest: V3, gen1: V2 },
  extra: { rel: (sid) => path.join(sid, 'tool-results', 'a.txt'), gz: (s) => path.join(path.dirname(gzPathOf(s)), SID, 'tool-results', 'a.txt.gz'), newest: EXTRA2, gen1: EXTRA1 },
};
for (const [leg, suffix, args, key] of [['the newest copy', '', [], 'newest'], ['generation 1', '.gen1', ['--generation', '1'], 'gen1']]) {
  for (const [badName, goodName] of [['transcript', 'extra'], ['extra', 'transcript']]) {
    test(`762 F-1: a restore of ${leg} with its ${badName} file damaged still writes the intact file, names the damaged one, and exits non-zero`, (t) => {
      const s = sandbox(t);
      twoFileTwoArchives(s);
      const bad = F1_FILES[badName].gz(s) + suffix;
      fs.writeFileSync(bad, 'these are not gzip bytes');
      const to = path.join(s.out, 'f1');
      const r = cli(s, ['estate-restore', SID, ...args, '--to', to]);
      const good = F1_FILES[goodName];
      assert.strictEqual(r.status, 1, 'the copy is not whole, so the exit is non-zero');
      assert.strictEqual(fs.readFileSync(path.join(to, good.rel(SID)), 'utf8'), good[key], 'the intact file is written');
      assert.ok(!fs.existsSync(path.join(to, F1_FILES[badName].rel(SID))), 'nothing damaged is written out');
      assert.match(r.stderr, /restore incomplete: .*damaged in 1 of 2 file\(s\)/);
      assert.ok(r.stderr.includes(`${F1_FILES[badName].rel(SID)}, archived at `) && r.stderr.includes(path.basename(bad)), 'the damaged file and the path where its bytes still are');
      assert.match(r.stderr, /gunzip/, 'what the person can do');
      assert.ok(r.stderr.includes('1 file(s) were written to ') && r.stderr.includes(`  ${good.rel(SID)} (`), 'which files were written');
    });
  }
}

test('762 O-3: a torn index line is followed by the next row on its own line, so search still finds the later session', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  const idx = path.join(s.archiveDir, 'index.jsonl');
  fs.appendFileSync(idx, '{"sessionId":"torn-half-of-a-row","projectSl'); // a writer killed halfway through a row
  const other = path.join(s.projDir, `${SID2}.jsonl`);
  fs.writeFileSync(other, ORIGINAL.replace('CW29GT-NEEDLE', 'CW29GT-OTHER'));
  const aged = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(other, aged, aged);
  assert.strictEqual(run(s).archived.length, 1);
  assert.deepStrictEqual(searchIndex('CW29GT-OTHER', { archiveDir: s.archiveDir }).map((r) => r.sessionId), [SID2], 'the row after the torn line is found');
  fs.appendFileSync(idx, '{"sessionId":"torn-at-the-end'); // a torn line at the very end
  assert.strictEqual(searchIndex('CW29GT-NEEDLE', { archiveDir: s.archiveDir }).length, 1, 'rows before a torn last line still read');
  assert.strictEqual(searchIndex('CW29GT-OTHER', { archiveDir: s.archiveDir }).length, 1);
});

test('762 O-3: a torn refusal record is followed by the next record on its own line, so the stats count still sees it', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  assert.strictEqual(run(s).archived.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok);
  seed(s, V2);
  const rec = path.join(s.archiveDir, 'generation-refusals.jsonl');
  fs.writeFileSync(rec, '{"timestamp":"2026-11-01T00:00:00.000Z","event":"generation-bound-ref'); // a torn record
  const r = runEstate({ projectRoot: s.proj, home: s.home, estate: { maxGenerations: 0 } });
  assert.strictEqual(r.generationRefusals, 1);
  let st = cli(s, ['estate', '--json']);
  assert.strictEqual(JSON.parse(st.stdout).generationRefusals.count, 1, 'the record after the torn line is counted');
  fs.appendFileSync(rec, '{"timestamp":"2026-11-02T00:00:00.000Z","event":"gen'); // a torn line at the very end
  st = cli(s, ['estate', '--json']);
  assert.strictEqual(JSON.parse(st.stdout).generationRefusals.count, 1, 'records before a torn last line still count');
});

// F5: a link (a junction on Windows, a directory symlink elsewhere) where the archive keeps a project's or a session's folder. Making
// one is a capability of the volume and the account, so it is probed by trying, and a test that cannot make one skips visibly.
function linkDir(target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
const STAGED_NAME = (stem) => `${stem}.${'ab'.repeat(12)}.coalwash-new`;

test('762 F5: a linked project folder in the archive refuses the session before any sweep; nothing outside is removed', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  const outside = path.join(s.root, 'outside');
  fs.mkdirSync(outside);
  const bait = path.join(outside, STAGED_NAME(`${SID}.jsonl.gz`));
  fs.writeFileSync(bait, 'outside');
  fs.mkdirSync(s.archiveDir, { recursive: true });
  if (!linkDir(outside, path.join(s.archiveDir, ccProjectSlug(s.proj)))) { t.skip('this volume or account cannot make a directory link'); return; }
  const r = run(s);
  assert.strictEqual(fs.readFileSync(bait, 'utf8'), 'outside', 'the file behind the link is untouched');
  assert.strictEqual(r.archived.length, 0);
  assert.match(r.failed[0].reason, /is a link or not a folder/);
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'the live session stays');
});

test('762 F5: a linked session folder in the archive refuses the session before any sweep; nothing outside is removed', (t) => {
  const s = sandbox(t);
  seed(s, ORIGINAL);
  const outside = path.join(s.root, 'outside');
  fs.mkdirSync(outside);
  const bait = path.join(outside, STAGED_NAME('a.txt.gz'));
  fs.writeFileSync(bait, 'outside');
  const slugDir = path.join(s.archiveDir, ccProjectSlug(s.proj));
  fs.mkdirSync(slugDir, { recursive: true });
  if (!linkDir(outside, path.join(slugDir, SID))) { t.skip('this volume or account cannot make a directory link'); return; }
  const r = run(s);
  assert.strictEqual(fs.readFileSync(bait, 'utf8'), 'outside', 'the file behind the link is untouched');
  assert.strictEqual(r.archived.length, 0);
  assert.match(r.failed[0].reason, /is a link or not a folder/);
  assert.ok(fs.existsSync(path.join(s.projDir, `${SID}.jsonl`)), 'the live session stays');
});
