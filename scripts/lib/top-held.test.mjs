// 29qc fire 968, ROUND 5 STEP 1 (main's c211 grant): THE TOP OF EVERY ROW of root-table-962.md, by run. Lifted into the room suite in
// 29qd fire 969 as scripts/lib/top-held.test.mjs (the reviewer's witness scratchpad/29oy/top-968.test.mjs, signed at d586845), with a
// visible skip wherever a directory link cannot be made.
// For each of the 30 rows: the row's TOP folder (the first folder it lists, or the folder its walk starts from) is made a link (a junction)
// to a folder OUTSIDE it, the row's real entry point is run, and a spy on the fs calls counts every call whose path resolves inside the
// link's target, with the lib file:line of the call. The row's test asserts: no listing of the target, and no name from it in the result.
// Each row also has a CONTROL: the same scene with a real top folder, asserting the entry point DOES list that top (so a green link test is
// not a run that stopped somewhere else). Rows whose top is reached only after a listing (a child folder) swap the child for a link right
// after that listing, as a race would. A test whose answer is main's to rule is marked `todo` (it reports, it does not fail the run).
// The library under test: CW_LIB (absolute path to a scripts/lib folder), else the folder this file sits in (lifted as a room test).
// Every scene lives in its own temp root under os.tmpdir() (prefix cwtop-), made, asserted and removed; HOME/USERPROFILE point at a guard
// folder made the same way, so nothing reaches the real home. Run: node --test --test-concurrency=1 top-968.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';

for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']) delete process.env[k];
const LIB = process.env.CW_LIB ? path.resolve(process.env.CW_LIB) : path.dirname(fileURLToPath(import.meta.url));
const lib = (f) => import(pathToFileURL(path.join(LIB, f)).href);
const TMP = fs.realpathSync.native(os.tmpdir());
const PREFIX = 'cwtop-';
const ownTemp = (T) => { try { return fs.realpathSync.native(T).startsWith(TMP + path.sep) && path.basename(T).startsWith(PREFIX); } catch { return false; } };
const removeOwn = (T) => { if (ownTemp(T)) fs.rmSync(T, { recursive: true, force: true }); };

const GUARD = fs.mkdtempSync(path.join(TMP, `${PREFIX}guardhome-`));
assert.ok(ownTemp(GUARD), 'guard home not under tmpdir');
process.env.USERPROFILE = GUARD; process.env.HOME = GUARD;
after(() => { removeOwn(GUARD); });

const tempRoot = (t) => { const T = fs.mkdtempSync(path.join(TMP, PREFIX)); assert.ok(ownTemp(T), 'temp root not under tmpdir'); t.after(() => removeOwn(T)); return T; };
const mk = (p, body = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const J = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
// The one skippable leg of a test: a directory link must be makeable here (probed in a temp root), else the test is skipped VISIBLY.
const skipNoLink = (t) => {
  const T = tempRoot(t); const at = path.join(T, 'probe-link');
  try { fs.symlinkSync(T, at, 'junction'); } catch (e) { t.skip(`this account cannot make a directory link here (${(e && e.code) || 'error'})`); return true; }
  return false;
};
// The real path of p, or of its deepest existing ancestor with the rest re-appended (a file about to be created inside a link's target).
const realish = (p) => { let cur = path.resolve(p); const rest = []; for (;;) { const r = real(cur); if (r) return path.join(r, ...rest.reverse()); const up = path.dirname(cur); if (up === cur) return null; rest.push(path.basename(cur)); cur = up; } };

const OPS = ['readdirSync', 'opendirSync', 'readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'mkdirSync', 'copyFileSync'];
const LISTS = ['readdirSync', 'opendirSync'];
const READS = ['readFileSync', 'openSync'];
const WRITES = ['writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'mkdirSync', 'copyFileSync'];
// The first lib frame of the current stack, as `file.mjs:line` (the listing's site).
const site = () => {
  for (const l of String(new Error().stack).split('\n').slice(3)) {
    if (!l.includes('/scripts/lib/')) continue;
    const m = /\/([A-Za-z0-9_-]+\.mjs):(\d+):\d+/.exec(l);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
};
// Count each fs call whose path resolves inside `watch`; optionally swap `swap.child` for a link to `swap.target` right after the first
// listing of `swap.after` (that call itself is not delayed).
function spy(watch, swap = null) {
  const w = real(watch);
  const hits = {}; const sites = new Set(); const orig = {}; let swapped = false;
  const afterReal = swap ? real(swap.after) : null;
  for (const op of OPS) {
    orig[op] = fs[op];
    fs[op] = function (p, ...a) {
      const r = typeof p === 'string' ? realish(p) : null;
      if (r && w && (r === w || r.startsWith(w + path.sep))) { hits[op] = (hits[op] || 0) + 1; const s = site(); if (s) sites.add(`${op}@${s}`); }
      const out = orig[op].call(fs, p, ...a);
      if (swap && !swapped && op === 'readdirSync' && typeof p === 'string' && real(p) === afterReal) {
        swapped = true;
        orig.rmSync.call(fs, swap.child, { recursive: true, force: true });
        fs.symlinkSync(swap.target, swap.child, 'junction');
      }
      return out;
    };
  }
  return { hits, sites, swapped: () => swapped, stop: () => { for (const op of OPS) fs[op] = orig[op]; } };
}
const sum = (hits, ops) => ops.reduce((n, op) => n + (hits[op] || 0), 0);
const flat = (v) => JSON.stringify(v, (k, x) => (x instanceof Map ? [...x.entries()] : x instanceof Set ? [...x] : x instanceof Error ? String(x) : x)) || '';
const printedNames = (out, tokens) => tokens.filter((n) => flat(out).includes(n));

// One scene: build(T, mode) -> { run, watch, tokens, swap? }. mode: 'link' (the top is a link to a folder outside), 'inlink' (the top is a
// link to another folder inside the project), 'real' (the control: a real top folder).
async function observe(t, label, build, mode) {
  const T = tempRoot(t);
  const sc = await build(T, mode);
  const s = spy(sc.watch, sc.swap || null);
  let out; let threw = null;
  try { out = await sc.run(); } catch (e) { threw = e; } finally { s.stop(); }
  const r = { listed: sum(s.hits, LISTS), read: sum(s.hits, READS), written: sum(s.hits, WRITES), printed: printedNames(out, sc.tokens || []), sites: [...s.sites].sort(), swapped: sc.swap ? s.swapped() : null, threw: threw ? String(threw && threw.message) : null };
  t.diagnostic(`${label} [${mode}] listed=${r.listed} read=${r.read} written=${r.written} printed=${JSON.stringify(r.printed)}${sc.swap ? ` swapped=${r.swapped}` : ''}${r.threw ? ` threw=${r.threw}` : ''} sites=${JSON.stringify(r.sites)}`);
  return r;
}
function row(id, title, build, { modes = ['link'], todo = null } = {}) {
  for (const mode of modes) {
    const what = mode === 'inlink' ? 'a top linked to another folder inside the project' : 'a top linked to a folder outside';
    test(`row ${id}: ${title}: ${what} is refused before its names are listed or printed`, todo ? { todo } : {}, async (t) => {
      if (skipNoLink(t)) return;
      const r = await observe(t, `row ${id}`, build, mode);
      if (build.swaps) assert.equal(r.swapped, true, 'the swap never happened: the scene did not reach the listing it races');
      assert.equal(r.listed, 0, `the link's target was listed ${r.listed} time(s) at ${r.sites.join(', ')}`);
      assert.deepEqual(r.printed, [], 'a name from the link target is in the result');
    });
  }
  test(`row ${id}: ${title}: CONTROL, a real top folder is listed by the same run`, async (t) => {
    const r = await observe(t, `row ${id}`, build, 'real');
    assert.ok(r.listed > 0, 'the run never listed the real top: the link test above proves nothing');
  });
}
// The top: a real folder at `at` filled by `fill`, or a link at `at` to a filled folder outside (T/out) or inside the project (`inside`).
function top(T, mode, at, fill, inside = null) {
  if (mode === 'real') { fill(at); return at; }
  const target = mode === 'inlink' ? inside : path.join(T, 'out');
  fill(target); J(target, at); return target;
}
const homeOf = (T) => { const H = path.join(T, 'home'); fs.mkdirSync(path.join(H, '.claude'), { recursive: true }); return H; };
const projOf = (T) => { const P = path.join(T, 'proj'); fs.mkdirSync(P, { recursive: true }); return P; };
const slugDirOf = async (H, P) => { const { ccProjectSlug } = await lib('class-b.mjs'); return path.join(H, '.claude', 'projects', ccProjectSlug(P)); };
const gz = (s) => zlib.gzipSync(Buffer.from(s));

// ---- row 1: anchor-diff.mjs oldestAnchor, top <project>/.claude/coalwash ----
row(1, 'oldestAnchor (anchorDiff)', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); mk(path.join(P, 'x.md'), '# x');
  const watch = top(T, mode, path.join(P, '.claude', 'coalwash'), (d) => { mk(path.join(d, 'snap-1', 'snap.complete'), ''); mk(path.join(d, 'snap-1', 'manifest.json'), '{}'); mk(path.join(d, 'zq968r1.txt')); });
  const { anchorDiff } = await lib('anchor-diff.mjs');
  return { watch, tokens: ['zq968r1'], run: () => anchorDiff(path.join(P, 'x.md'), { projectRoot: P, home: H }) };
});
// ---- row 2: apply.mjs collectMdFiles, top = the plan root ----
row(2, 'collectMdFiles (applyPlan dead-link scan)', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T);
  const at = path.join(P, 'docs');
  const watch = top(T, mode, at, (d) => { mk(path.join(d, 'zq968a.md'), '# a'); mk(path.join(d, 'b.md'), 'see zq968a.md'); });
  const { applyPlan } = await lib('apply.mjs');
  return { watch, tokens: ['b.md'], run: () => applyPlan({ roots: [at], actions: [{ type: 'delete', path: path.join(at, 'zq968a.md') }] }, { projectRoot: P, home: H }) };
});
// ---- row 3: apply.mjs sweepSnapshots, top <project>/.claude/coalwash ----
row(3, 'sweepSnapshots (applyPlan)', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); mk(path.join(P, 'a.md'), '# a');
  const watch = top(T, mode, path.join(P, '.claude', 'coalwash'), (d) => { for (const n of [1, 2, 3, 4]) mk(path.join(d, `snap-${n}`, 'snap.complete'), ''); });
  const { applyPlan } = await lib('apply.mjs');
  return { watch, tokens: ['snap-1'], run: () => applyPlan({ roots: [P], actions: [{ type: 'rewrite', path: path.join(P, 'a.md'), content: '# a2' }] }, { projectRoot: P, home: H, keepSnapshots: 1 }) };
});
// ---- rows 4, 5: caliper.mjs pruneStrayStateDirs and deadProjectStateFiles, through recordStamp ----
row(4, 'pruneStrayStateDirs (recordStamp), top <base>/projects', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const { ccProjectSlug } = await lib('class-b.mjs');
  const watch = top(T, mode, path.join(H, '.claude', 'projects'), (d) => { mk(path.join(d, 'C--zq968stray', 'coalwash', 'state.json'), JSON.stringify({ stateSchema: 3, projectRoot: path.join(P, 'sub') })); fs.mkdirSync(path.join(d, ccProjectSlug(P)), { recursive: true }); });
  const { recordStamp } = await lib('caliper.mjs');
  return { watch, tokens: ['zq968stray'], run: () => recordStamp(H, P, 1000, Date.now()) };
});
row(5, 'deadProjectStateFiles (recordStamp), top <base>/coal/coalwash', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const { ccProjectSlug } = await lib('class-b.mjs');
  const dead = path.join(T, 'gone', 'zq968dead');
  const watch = top(T, mode, path.join(H, '.claude', 'coal', 'coalwash'), (d) => { mk(path.join(d, `state-${ccProjectSlug(dead)}.json`), JSON.stringify({ stateSchema: 3, projectRoot: dead })); });
  const { recordStamp } = await lib('caliper.mjs');
  return { watch, tokens: ['zq968dead'], run: () => recordStamp(H, P, 1000, Date.now()) };
});
// ---- row 6: class-b.mjs walkRulesTree, global top <base>/rules and project top <project>/.claude/rules ----
row('6 (global)', 'walkRulesTree (discoverClassB), top <base>/rules', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T);
  const watch = top(T, mode, path.join(H, '.claude', 'rules'), (d) => mk(path.join(d, 'zq968g.md'), '# g'));
  const { discoverClassB } = await lib('class-b.mjs');
  return { watch, tokens: ['zq968g'], run: () => discoverClassB({ projectRoot: P, home: H, platform: 'claude-code' }) };
});
row('6 (project)', 'walkRulesTree (discoverClassB), top <project>/.claude/rules', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T);
  const watch = top(T, mode, path.join(P, '.claude', 'rules'), (d) => mk(path.join(d, 'zq968p.md'), '# p'), path.join(P, 'src'));
  const { discoverClassB } = await lib('class-b.mjs');
  return { watch, tokens: ['zq968p'], run: () => discoverClassB({ projectRoot: P, home: H, platform: 'claude-code' }) };
}, { modes: ['link', 'inlink'] });
// ---- row 7: class-b.mjs the memory-store walk, top <base>/projects/<slug>/memory ----
row(7, 'the memory-store walk (discoverClassB), top <base>/projects/<slug>/memory', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P); fs.mkdirSync(S, { recursive: true });
  const watch = top(T, mode, path.join(S, 'memory'), (d) => { mk(path.join(d, 'MEMORY.md'), '# m'); mk(path.join(d, 'zq968m.md'), '# t'); });
  const { discoverClassB } = await lib('class-b.mjs');
  return { watch, tokens: ['zq968m'], run: () => discoverClassB({ projectRoot: P, home: H, platform: 'claude-code' }) };
});
// ---- row 8: class-b.mjs discoverRoleMemories, top <project>/.claude/agent-memory ----
row(8, 'discoverRoleMemories, top <project>/.claude/agent-memory', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T);
  const watch = top(T, mode, path.join(P, '.claude', 'agent-memory'), (d) => mk(path.join(d, 'zq968role', 'MEMORY.md'), '# r'), path.join(P, 'src'));
  const { discoverRoleMemories } = await lib('class-b.mjs');
  return { watch, tokens: ['zq968role'], run: () => { const flags = []; const stores = discoverRoleMemories({ projectRoot: P, home: H, flags }); return { stores, flags }; } };
}, { modes: ['link', 'inlink'] });
// ---- row 9: estate-archive.mjs listSessions, top <base>/projects/<slug> ----
row(9, 'listSessions, top <base>/projects/<slug>', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P);
  const watch = top(T, mode, S, (d) => mk(path.join(d, 'zq968s.jsonl'), '{}\n'));
  const { listSessions } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968s'], run: () => listSessions({ projectRoot: P, home: H }) };
});
// ---- row 10: estate-archive.mjs walkFiles, top <slug>/<sid>/ (reached after the slug listing: swapped right after it) ----
const row10 = async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P);
  mk(path.join(S, 's1.jsonl'), '{}\n'); mk(path.join(S, 's1', 'a.txt'));
  const { listSessions } = await lib('estate-archive.mjs');
  const run = () => listSessions({ projectRoot: P, home: H });
  if (mode === 'real') return { watch: path.join(S, 's1'), tokens: ['zq968w'], run };
  const O = path.join(T, 'out'); mk(path.join(O, 'zq968w.txt'));
  return { watch: O, tokens: ['zq968w'], run, swap: { after: S, child: path.join(S, 's1'), target: O } };
};
row10.swaps = true;
row(10, 'walkFiles (listSessions), top <slug>/<sid>/ swapped after the slug listing', row10);
// ---- rows 11, 14: estate-archive.mjs reconcileIndex and listAsides through runEstate, top <archive>/<slug> ----
const archSlug = async (T, mode, fill) => {
  const H = homeOf(T); const P = projOf(T); const { ccProjectSlug } = await lib('class-b.mjs');
  const A = path.join(T, 'arch'); fs.mkdirSync(A, { recursive: true });
  const watch = top(T, mode, path.join(A, ccProjectSlug(P)), fill);
  return { H, P, A, watch, slug: ccProjectSlug(P) };
};
row(11, 'reconcileIndex (runEstate), top <archive>/<slug>', async (T, mode) => {
  const { H, P, A, watch } = await archSlug(T, mode, (d) => { mk(path.join(d, 'zq968k.jsonl.gz'), gz('{"cwd":"x"}\n')); mk(path.join(d, 'zq968k.aside')); });
  const { runEstate } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968k'], run: () => runEstate({ projectRoot: P, home: H, estate: { archiveDir: A }, now: Date.now() }) };
});
// ---- row 12: sessionGenerations; every caller holds the slug folder first: restoreSession is the run here (archiveSession is row 13's) ----
const restoreScene = async (T, mode) => {
  const { A, watch } = await archSlug(T, mode, (d) => { mk(path.join(d, 's1.jsonl.gz'), gz('{"a":1}\n')); mk(path.join(d, 's1.jsonl.gz.gen1'), gz('{"a":0}\n')); mk(path.join(d, 's1', 'zq968q.txt.gz'), gz('q')); });
  const { restoreSession } = await lib('estate-archive.mjs');
  const dest = path.join(T, 'dest');
  return { watch, tokens: ['zq968q'], run: () => restoreSession('s1', { archiveDir: A, to: dest }) };
};
row(12, 'sessionGenerations (restoreSession), top <archive>/<slug>', restoreScene);
test('row 12 (direct): sessionGenerations handed a slug folder that is a link lists it first (no caller hands it one)', { todo: 'a hazard for a new caller, not a finding: every caller holds or lstat-refuses the slug folder first' }, async (t) => {
  if (skipNoLink(t)) return;
  const r = await observe(t, 'row 12 direct', async (T, mode) => {
    const { watch, A, slug } = await archSlug(T, mode, (d) => mk(path.join(d, 's1.jsonl.gz.gen1'), gz('{}\n')));
    const { __walkTestHooks: h } = await lib('estate-archive.mjs');
    return { watch, tokens: ['s1.jsonl'], run: () => h.sessionGenerations(path.join(A, slug), 's1') };
  }, 'link');
  assert.equal(r.listed, 0, `listed at ${r.sites.join(', ')}`);
});
// ---- row 13: collectStagedLeftovers through archiveSession, top <archive>/<slug> ----
row(13, 'collectStagedLeftovers (archiveSession), top <archive>/<slug>', async (T, mode) => {
  const { H, P, A, watch, slug } = await archSlug(T, mode, (d) => mk(path.join(d, 'zq968c.txt')));
  const S = await slugDirOf(H, P); mk(path.join(S, 's1.jsonl'), '{"a":1}\n');
  const { listSessions, archiveSession } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968c'], run: () => { const sess = listSessions({ projectRoot: P, home: H }).sessions[0]; return archiveSession(sess, { slug, archiveDir: A, now: Date.now() }); } };
});
test('row 12 (direct, control): sessionGenerations lists a real slug folder', async (t) => {
  const r = await observe(t, 'row 12 direct', async (T, mode) => {
    const { watch, A, slug } = await archSlug(T, mode, (d) => mk(path.join(d, 's1.jsonl.gz.gen1'), gz('{}\n')));
    const { __walkTestHooks: h } = await lib('estate-archive.mjs');
    return { watch, tokens: [], run: () => h.sessionGenerations(path.join(A, slug), 's1') };
  }, 'real');
  assert.ok(r.listed > 0);
});
test('row 13 (direct): collectStagedLeftovers handed a slug folder that is a link lists it first (no caller hands it one)', { todo: 'a hazard for a new caller, not a finding: archiveSession lstat-refuses the slug folder first' }, async (t) => {
  if (skipNoLink(t)) return;
  const r = await observe(t, 'row 13 direct', async (T, mode) => {
    const { watch, A, slug } = await archSlug(T, mode, (d) => mk(path.join(d, 's1.zq968c.tmp')));
    const { __walkTestHooks: h } = await lib('estate-archive.mjs');
    return { watch, tokens: [], run: () => h.collectStagedLeftovers(path.join(A, slug), 's1') };
  }, 'link');
  assert.equal(r.listed, 0, `listed at ${r.sites.join(', ')}`);
});
// ---- row 14: listAsides, top <archive>/<slug> (the function itself; runEstate's call is in row 11's sites) ----
row(14, 'listAsides, top <archive>/<slug>', async (T, mode) => {
  const { A, watch, slug } = await archSlug(T, mode, (d) => mk(path.join(d, 'zq968x.aside')));
  const { __walkTestHooks: h } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968x'], run: () => h.listAsides(path.join(A, slug), real(A)) };
});
// ---- row 15: pruneEmptyDirs, top <base>/projects/<slug>/<sid>/ ----
row(15, 'pruneEmptyDirs, top <base>/projects/<slug>/<sid>', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P); fs.mkdirSync(S, { recursive: true });
  const watch = top(T, mode, path.join(S, 's1'), (d) => { fs.mkdirSync(path.join(d, 'empty'), { recursive: true }); mk(path.join(d, 'zq968e.txt')); });
  const { __walkTestHooks: h } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968e', 'empty'], run: () => { const survivors = []; h.pruneEmptyDirs(path.join(S, 's1'), S, survivors); return survivors; } };
});
// ---- row 16: restoreSourcesUnder, top <archive>/<slug>/<sid>/ ----
row(16, 'restoreSourcesUnder, top <archive>/<slug>/<sid>', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const { ccProjectSlug } = await lib('class-b.mjs'); void H;
  const A = path.join(T, 'arch'); const SL = path.join(A, ccProjectSlug(P)); fs.mkdirSync(SL, { recursive: true });
  const watch = top(T, mode, path.join(SL, 's1'), (d) => mk(path.join(d, 'zq968r.txt.gz'), gz('r')));
  const { __walkTestHooks: h } = await lib('estate-archive.mjs');
  return { watch, tokens: ['zq968r'], run: () => h.restoreSourcesUnder(path.join(SL, 's1'), 's1') };
});
// ---- row 17: restoreSessionInner; the slug level, and the archive root itself (a trusted root by main's c209) ----
row(17, 'restoreSessionInner (restoreSession), top <archive>/<slug>', restoreScene);
test('row 17 (archive root): the default archive folder <base>/coal/coalwash/estate-archive as a link to a folder outside', { todo: 'c209 names <archive> a trusted root resolved once: main rules whether its default, a literal path below <base>, is held' }, async (t) => {
  if (skipNoLink(t)) return;
  const r = await observe(t, 'row 17 archive root', async (T, mode) => {
    const H = homeOf(T); const P = projOf(T); const { ccProjectSlug } = await lib('class-b.mjs');
    const AL = path.join(H, '.claude', 'coal', 'coalwash', 'estate-archive');
    const watch = top(T, mode, AL, (d) => { mk(path.join(d, ccProjectSlug(P), 's1.jsonl.gz'), gz('{"zq968z":1}\n')); mk(path.join(d, 'zq968z-other', 'x')); });
    const { restoreSession, resolveArchiveDir } = await lib('estate-archive.mjs');
    return { watch, tokens: ['zq968z'], run: () => restoreSession('s1', { archiveDir: resolveArchiveDir({}, H), to: path.join(T, 'dest') }) };
  }, 'link');
  assert.equal(r.listed, 0, `listed at ${r.sites.join(', ')}; read=${r.read}`);
});
// ---- rows 18, 19, 23: estate.mjs, top <base>/projects ----
const projectsTop = (fnName, call) => async (T, mode) => {
  const H = homeOf(T);
  const watch = top(T, mode, path.join(H, '.claude', 'projects'), (d) => mk(path.join(d, 'C--zq968y', 'a.jsonl'), `${JSON.stringify({ cwd: path.join(T, 'no-such-968') })}\n`));
  const m = await lib('estate.mjs');
  return { watch, tokens: ['zq968y'], run: () => call(m[fnName], H) };
};
row(18, 'observedRetentionFloorDays, top <base>/projects', projectsTop('observedRetentionFloorDays', (f, H) => f({ home: H })));
row(19, 'observedMachineAgeDays, top <base>/projects', projectsTop('observedMachineAgeDays', (f, H) => f({ home: H })));
// ---- row 20: estate.mjs walkDir, top <slug>/<sid>/<sub>/ (reached after the session listing: swapped right after it) ----
const row20 = async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P);
  mk(path.join(S, 's1.jsonl'), '{}\n'); mk(path.join(S, 's1', 'sub', 'a.txt'));
  const { discoverEstateCC } = await lib('estate.mjs');
  const run = () => discoverEstateCC({ projectRoot: P, home: H });
  if (mode === 'real') return { watch: path.join(S, 's1', 'sub'), tokens: ['zq968u'], run };
  const O = path.join(T, 'out'); mk(path.join(O, 'zq968u.txt'));
  return { watch: O, tokens: ['zq968u'], run, swap: { after: path.join(S, 's1'), child: path.join(S, 's1', 'sub'), target: O } };
};
row20.swaps = true;
row(20, 'walkDir (discoverEstateCC), top <slug>/<sid>/<sub>/ swapped after the session listing', row20);
// ---- row 21: estate.mjs discoverEstateCC, top <base>/projects/<slug> ----
row(21, 'discoverEstateCC, top <base>/projects/<slug>', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P);
  const watch = top(T, mode, S, (d) => mk(path.join(d, 'zq968d.jsonl'), '{}\n'));
  const { discoverEstateCC } = await lib('estate.mjs');
  return { watch, tokens: ['zq968d'], run: () => discoverEstateCC({ projectRoot: P, home: H }) };
});
// ---- row 22: estate.mjs sniffCwd, top <base>/projects/<x> handed by row 23 (swapped right after the projects listing) ----
const row22 = async (T, mode) => {
  const H = homeOf(T); const X = path.join(H, '.claude', 'projects', 'C--zq968n');
  mk(path.join(X, 'a.jsonl'), `${JSON.stringify({ cwd: path.join(T, 'no-such-968') })}\n`);
  const { detectOrphanSlugs } = await lib('estate.mjs');
  const run = () => detectOrphanSlugs({ home: H });
  if (mode === 'real') return { watch: X, tokens: [], run };
  const O = path.join(T, 'out'); mk(path.join(O, 'b.jsonl'), `${JSON.stringify({ cwd: path.join(T, 'no-such-968-zq968o') })}\n`);
  return { watch: O, tokens: ['zq968o'], run, swap: { after: path.join(H, '.claude', 'projects'), child: X, target: O } };
};
row22.swaps = true;
row(22, 'sniffCwd (detectOrphanSlugs), top <base>/projects/<x> swapped after the projects listing', row22);
row(23, 'detectOrphanSlugs, top <base>/projects', projectsTop('detectOrphanSlugs', (f, H) => f({ home: H })));
// ---- rows 24, 25: retier.mjs collectStores ----
row(24, 'addStore (collectStores), main store top <base>/projects/<slug>/memory', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); const S = await slugDirOf(H, P); fs.mkdirSync(S, { recursive: true });
  const watch = top(T, mode, path.join(S, 'memory'), (d) => { mk(path.join(d, 'MEMORY.md'), '# m\n- [t](zq968t.md)\n'); mk(path.join(d, 'zq968t.md'), '# t'); });
  const { collectStores } = await lib('retier.mjs');
  return { watch, tokens: ['zq968t'], run: () => { const s = collectStores({ projectRoot: P, home: H }); return { stores: s, skipped: s.skipped }; } };
});
row(25, 'collectStores role listing, top <project>/.claude/agent-memory', async (T, mode) => {
  const H = homeOf(T); const P = projOf(T);
  const watch = top(T, mode, path.join(P, '.claude', 'agent-memory'), (d) => mk(path.join(d, 'zq968role', 'MEMORY.md'), '# r'), path.join(P, 'src'));
  const { collectStores } = await lib('retier.mjs');
  return { watch, tokens: ['zq968role'], run: () => { const s = collectStores({ projectRoot: P, home: H }); return { stores: s, skipped: s.skipped }; } };
}, { modes: ['link', 'inlink'] });
// ---- rows 26, 27: tailings.mjs, top <project>/.claude/coalwash/<bin> ----
const binTop = (call) => async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); void H;
  const { FAT_BIN_NAME } = await lib('tailings.mjs');
  const watch = top(T, mode, path.join(P, '.claude', 'coalwash', FAT_BIN_NAME), (d) => { mk(path.join(d, 'index.json'), JSON.stringify([{ id: 'zq968b' }])); mk(path.join(d, '.zq968tmp.1.2.tmp')); });
  const m = await lib('tailings.mjs');
  return { watch, tokens: ['zq968'], run: () => call(m, P, FAT_BIN_NAME) };
};
row(26, 'removeStaleTemps (sweepFatBin), top <project>/.claude/coalwash/<bin>', binTop((m, P) => m.sweepFatBin(P, { now: Date.now(), storeBytes: 1e6 })));
row(27, 'loadIndexRead (listBin), top <project>/.claude/coalwash/<bin>', binTop((m, P, name) => m.listBin(P, name)));
// ---- rows 28, 29, 30: writeguard.mjs; the writeguard root, then a session folder ----
const wgRoot = (call) => async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); void H;
  const watch = top(T, mode, path.join(P, '.claude', 'coalwash', 'writeguard'), (d) => { mk(path.join(d, 'zq968sess', 'a.snap')); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(path.join(d, 'zq968sess', 'a.snap'), old, old); fs.utimesSync(path.join(d, 'zq968sess'), old, old); });
  const m = await lib('writeguard.mjs');
  return { watch, tokens: ['zq968sess'], run: () => call(m, P) };
};
const wgSession = (call) => async (T, mode) => {
  const H = homeOf(T); const P = projOf(T); void H;
  const W = path.join(P, '.claude', 'coalwash', 'writeguard'); fs.mkdirSync(W, { recursive: true });
  const watch = top(T, mode, path.join(W, 'sessq'), (d) => { mk(path.join(d, 'zq968f.snap')); const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(path.join(d, 'zq968f.snap'), old, old); fs.utimesSync(d, old, old); });
  const m = await lib('writeguard.mjs');
  return { watch, tokens: ['zq968f'], run: () => call(m, P) };
};
row(28, 'listWriteguard, top the writeguard root', wgRoot((m, P) => m.listWriteguard(P)));
row('28 (session)', 'listWriteguard, top <writeguard>/<session>', wgSession((m, P) => m.listWriteguard(P)));
row('29/30', 'newestSessionMtime and sweepWriteguard, top the writeguard root', wgRoot((m, P) => m.sweepWriteguard(P, 'cur')));
row('29/30 (session)', 'newestSessionMtime and sweepWriteguard, top <writeguard>/<session>', wgSession((m, P) => m.sweepWriteguard(P, 'cur')));

// ---- the leg that kills mutant H4 (class-b.mjs heldPath: `containedIn(phys, [held])` read as a string prefix) ----
test('H4: heldPath refuses a sibling whose name begins with the held folder\'s name, and takes the folder\'s own file', async (t) => {
  const T = tempRoot(t); const R = path.join(T, 'h4');
  mk(path.join(R, 'a', 'own.txt'), 'own'); mk(path.join(R, 'ab', 'sibling.txt'), 'sibling');
  mk(path.join(R, 'projects', 'C--p', 'x.txt')); mk(path.join(R, 'projects', 'C--p-other', 'y.txt'));
  const { heldPath } = await lib('class-b.mjs');
  const rootPhys = real(R);
  assert.equal(heldPath(rootPhys, ['a'], path.join(R, 'ab', 'sibling.txt')), null, '<R>/ab/sibling.txt taken as inside <R>/a');
  assert.equal(heldPath(rootPhys, ['projects', 'C--p'], path.join(R, 'projects', 'C--p-other', 'y.txt')), null, 'a slug folder taken as inside its prefix sibling');
  assert.notEqual(heldPath(rootPhys, ['a'], path.join(R, 'a', 'own.txt')), null, 'the held folder\'s own file refused');
  assert.notEqual(heldPath(rootPhys, ['projects', 'C--p'], path.join(R, 'projects', 'C--p', 'x.txt')), null, 'the held slug\'s own file refused');
});
