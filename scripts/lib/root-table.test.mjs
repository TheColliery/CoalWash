// 29pt fire 963, THE ROOT TABLE (main's c209 ruling; the signed spec scratchpad/29oy/root-table-962.md). A row's root is the deepest
// folder its act reads, writes or deletes in, hand-joined from a trusted root (the Claude base, the archive root, the project root) and
// literal names, and only the candidate is resolved (node/runtime.md section 4). One test per WIDER row, each the reviewer's witness leg
// (scratchpad/29oy/w-962.mjs, w-962b.mjs, w-961.mjs) as a room test, plus F961-3's two arms for the slug level of listSessions:
//   (a) a slug folder that is a link out of the Claude base; (b) one that is a link to another slug folder inside it.
// Each test makes one temp root, asserted and removed by its own teardown, with a temp HOME (never the real one), and probes the
// directory-link capability it needs, skipping VISIBLY where none can be made (one skippable leg per test).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { __walkTestHooks as W, listSessions, archiveSession, classifySessions, runEstate, restoreSession, ESTATE_INDEX_NAME } from './estate-archive.mjs';
import { discoverEstateCC, detectOrphanSlugs, observedRetentionFloorDays, observedMachineAgeDays } from './estate.mjs';
import { collectStores, runRetier } from './retier.mjs';
import { anchorDiff } from './anchor-diff.mjs';
import { recordStamp } from './caliper.mjs';
import { ccProjectSlug, discoverClassB, discoverRoleMemories } from './class-b.mjs';
import { listWriteguard, sweepWriteguard } from './writeguard.mjs';

for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']) delete process.env[k];
const TMP = fs.realpathSync.native(os.tmpdir());
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const standing = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const under = (p, dir) => { const a = real(p); const d = real(dir); return !!(a && d && (a === d || a.startsWith(d + path.sep))); };
const gz = (s) => zlib.gzipSync(Buffer.from(s));
const line = (txt) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: txt } })}\n`;
const bigIndex = (title) => `# ${title}\n${Array.from({ length: 400 }, (_, i) => `- line ${i} ${'word '.repeat(10)}`).join('\n')}\n`;

function root(t, label) {
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP, `cw963-${label}-`)));
  t.after(() => {
    assert.ok(path.dirname(r) === TMP && path.basename(r).startsWith('cw963-'), `refusing to remove ${r}`);
    fs.rmSync(r, { recursive: true, force: true });
  });
  return r;
}
// The one skippable leg of a test: null when a directory link can be made here, else why not.
function noDirLink(r) {
  const at = path.join(r, '.probe-dir-link');
  try { linkDir(r, at); } catch (e) { return (e && e.code) || 'error'; }
  try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* removed with the root */ } }
  return null;
}
const homeIn = (r) => { const h = path.join(r, 'home'); fs.mkdirSync(path.join(h, '.claude', 'projects'), { recursive: true }); return h; };
const projIn = (r) => { const p = path.join(r, 'proj'); fs.mkdirSync(p, { recursive: true }); return p; };
// A seam on fs.readdirSync, undone by t.after. 'child': after `listed` is listed, its child `child` is moved aside and a directory link to
// `target` put in its place. 'self-after': after `listed` is listed, `listed` itself is swapped. 'self-before': right before `listed` is
// listed (after an earlier check of it), `listed` itself is swapped.
function seam(t, mode, listed, target, child = null) {
  const realReaddir = fs.readdirSync;
  let fired = false;
  const swap = (at) => { fs.renameSync(at, `${at}.moved`); linkDir(target, at); };
  fs.readdirSync = function (p, ...rest) {
    const hit = !fired && path.resolve(String(p)) === path.resolve(listed);
    if (hit && mode === 'self-before') { fired = true; swap(listed); }
    const res = realReaddir.call(fs, p, ...rest);
    if (hit && mode === 'child') { fired = true; swap(path.join(listed, child)); }
    if (hit && mode === 'self-after') { fired = true; swap(listed); }
    return res;
  };
  const undo = () => { if (fs.readdirSync !== realReaddir) fs.readdirSync = realReaddir; };
  t.after(undo);
  return { undo, fired: () => fired };
}
// Record calls of fs[name] whose path resolves inside `dir`; undone by t.after.
function spy(t, name, dir) {
  const orig = fs[name]; const hits = [];
  fs[name] = function (p, ...a) { if (typeof p === 'string' && under(p, dir)) hits.push(p); return orig.call(fs, p, ...a); };
  const stop = () => { if (fs[name] !== orig) fs[name] = orig; };
  t.after(stop);
  return { hits, stop };
}
const skipNoLink = (t, r) => { const why = noDirLink(r); if (why) { t.skip(`this account cannot make a directory link here (${why})`); return true; } return false; };

test('row 1 LA oldestAnchor: a snap-<n> that is a link to another folder of .claude/coalwash is never read as the anchor', (t) => {
  const r = root(t, 'la'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const file = path.join(P, 'notes.md'); mk(file, '# notes\nport 4401\n');
  const tx = path.join(P, '.claude', 'coalwash');
  mk(path.join(tx, 'other', 'snap.complete'), '');
  mk(path.join(tx, 'other', 'manifest.json'), JSON.stringify([{ snap: 'f0', original: real(file) }]));
  mk(path.join(tx, 'other', 'f0'), '# notes\nport 4401\nport 9999\n');
  linkDir(path.join(tx, 'other'), path.join(tx, 'snap-1'));
  assert.strictEqual(anchorDiff(file, { projectRoot: P, home: H }), null, 'the linked snap-1 was read as the anchor');
});

test('row 4 LB pruneStrayStateDirs: a projects/<name> that is a link to another folder of the Claude base has nothing opened in it', (t) => {
  const r = root(t, 'lb'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  fs.mkdirSync(path.join(H, '.claude', 'projects', ccProjectSlug(P)), { recursive: true });
  const elsewhere = path.join(H, '.claude', 'elsewhere');
  mk(path.join(elsewhere, 'coalwash', 'state.json'), JSON.stringify({ stateSchema: 3, projectRoot: path.join(r, 'gone') }));
  linkDir(elsewhere, path.join(H, '.claude', 'projects', 'C--evil-963'));
  const s = spy(t, 'openSync', elsewhere);
  recordStamp(H, P, 1000, Date.now());
  s.stop();
  assert.deepStrictEqual(s.hits, [], 'a state file behind the link was opened');
});

test('row 5 LC deadProjectStateFiles: coal/coalwash swapped after its listing for a link elsewhere in the Claude base deletes nothing there', (t) => {
  const r = root(t, 'lc'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  fs.mkdirSync(path.join(H, '.claude', 'projects', ccProjectSlug(P)), { recursive: true });
  const dead = path.join(r, 'gone', 'proj'); const name = `state-${ccProjectSlug(dead)}.json`;
  const rec = JSON.stringify({ stateSchema: 3, projectRoot: dead });
  const coal = path.join(H, '.claude', 'coal', 'coalwash'); mk(path.join(coal, name), rec);
  const other = path.join(H, '.claude', 'elsewhere2'); mk(path.join(other, name), rec);
  const sw = seam(t, 'self-after', coal, other);
  recordStamp(H, P, 1000, Date.now());
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(standing(path.join(other, name)), 'the same-named state file behind the link was deleted');
});

test('row 6 LD walkRulesTree: .claude/rules/sub swapped after its listing for a link to a project folder adds no governance entry', (t) => {
  const r = root(t, 'ld'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const rules = path.join(P, '.claude', 'rules'); mk(path.join(rules, 'sub', 'a.md'), '# rule a\n');
  mk(path.join(P, 'docs', 'x.md'), '# a project doc, not a rule\n');
  const sw = seam(t, 'child', rules, path.join(P, 'docs'), 'sub');
  const res = discoverClassB({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!res.entries.some((e) => e.path === real(path.join(P, 'docs', 'x.md'))), 'docs/x.md became a governance entry');
});

test('row 7 LE the memory-store walk: memory/sub swapped after its listing for a link to a project folder adds no memory entry', (t) => {
  const r = root(t, 'le'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const mem = path.join(H, '.claude', 'projects', ccProjectSlug(P), 'memory');
  mk(path.join(mem, 'MEMORY.md'), '# index\n'); mk(path.join(mem, 'sub', 'm.md'), '# m\n');
  mk(path.join(P, 'docs2', 'y.md'), '# another project doc\n');
  const sw = seam(t, 'child', mem, path.join(P, 'docs2'), 'sub');
  const res = discoverClassB({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  const all = [...res.entries, ...(res.inherited || [])];
  assert.ok(!all.some((e) => e.path === real(path.join(P, 'docs2', 'y.md'))), 'docs2/y.md became a memory entry');
});

test('row 8 LF discoverRoleMemories: a role swapped after the listing for a link to a project folder is no role store', (t) => {
  const r = root(t, 'lf'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const ab = path.join(P, '.claude', 'agent-memory'); mk(path.join(ab, 'coder', 'MEMORY.md'), '# coder\n');
  mk(path.join(P, 'docs3', 'MEMORY.md'), '# not a role store\n'); mk(path.join(P, 'docs3', 'z.md'), 'z\n');
  const sw = seam(t, 'child', ab, path.join(P, 'docs3'), 'coder');
  const res = discoverRoleMemories({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!res.some((s) => s.dir === real(path.join(P, 'docs3'))), 'a project folder was sized as a role store');
});

test('row 9 LG listSessions: projects/<slug> a link to another slug folder inside the Claude base archives and deletes nothing of it', (t) => {
  const r = root(t, 'lg'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const projects = path.join(H, '.claude', 'projects'); const slug = ccProjectSlug(P);
  const other = path.join(projects, 'C--other-963'); const osid = 'bbbb-0963';
  mk(path.join(other, `${osid}.jsonl`), line('another project live transcript'));
  linkDir(other, path.join(projects, slug));
  const s = listSessions({ projectRoot: P, home: H });
  for (const sess of s.sessions) archiveSession(sess, { slug, archiveDir: path.join(H, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.strictEqual(s.sessions.length, 0, 'a session of the other project was listed');
  assert.ok(standing(path.join(other, `${osid}.jsonl`)), "the other project's live transcript was deleted");
});

test('row 10 L10c walkFiles: <sid>/ swapped after the slug listing for a link to the slug folder memory/ archives and deletes nothing there', (t) => {
  const r = root(t, 'l10c'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const slug = ccProjectSlug(P); const projDir = path.join(H, '.claude', 'projects', slug); const sid = 'aaaa-1111';
  mk(path.join(projDir, `${sid}.jsonl`), '{"type":"user"}\n');
  mk(path.join(projDir, sid, 'tool-results', 'r.txt'), 'mine\n');
  mk(path.join(projDir, 'memory', 'MEMORY.md'), '# live memory index\n- a fact\n');
  const sw = seam(t, 'child', projDir, path.join(projDir, 'memory'), sid);
  const s = listSessions({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  const sess = s.sessions.find((x) => x.id === sid);
  if (sess) archiveSession(sess, { slug, archiveDir: path.join(H, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.ok(standing(path.join(projDir, 'memory', 'MEMORY.md')), 'the live memory index was archived and deleted');
});

test('row 11 LH-11 reconcileIndex: archive/<slug> a link to another slug folder of the archive indexes nothing of it under this slug', (t) => {
  const r = root(t, 'lh11'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const A = path.join(r, 'archive'); fs.mkdirSync(A); const estate = { archiveDir: A, indexEnabled: true };
  const slug = classifySessions({ projectRoot: P, home: H, estate }).slug;
  const SID = '0963aaaa-bbbb-4ccc-8ddd-eeeeffff0963';
  const other = path.join(A, 'C--other-963'); mk(path.join(other, `${SID}.jsonl.gz`), gz(line('OTHER-PROJECT-963 text')));
  linkDir(other, path.join(A, slug));
  try { runEstate({ projectRoot: P, home: H, estate }); } catch { /* a refusal is fine; the index is the measure */ }
  const idx = path.join(A, ESTATE_INDEX_NAME);
  const rows = standing(idx) ? fs.readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : [];
  assert.ok(!rows.some((x) => x && x.sessionId === SID && x.projectSlug === slug), "the other project's transcript was indexed under this slug");
});

test('row 12 LI sessionGenerations: <sid>/ swapped after the slug listing for a link to a sibling session lists none of its generations', (t) => {
  const r = root(t, 'li'); if (skipNoLink(t, r)) return;
  const S = path.join(r, 'archive', 'C--p'); const sid = 'aaaa-0963'; const sid2 = 'cccc-0963';
  mk(path.join(S, sid, 'a.jsonl.gz.gen1'), 'g'); mk(path.join(S, sid2, 'b.jsonl.gz.gen1'), 'g');
  const sw = seam(t, 'child', S, path.join(S, sid2), sid);
  const g = W.sessionGenerations(S, sid, real(S));
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  const rels = [...g.values()].flat().map((e) => e.rel);
  assert.ok(!rels.some((x) => x.endsWith('b.jsonl')), `a sibling's generation was listed as this session's: ${JSON.stringify(rels)}`);
});

test("row 13 LJ collectStagedLeftovers: <sid>/ swapped after the slug listing for a link to a sibling unlinks none of the sibling's staged files", (t) => {
  const r = root(t, 'lj'); if (skipNoLink(t, r)) return;
  const S = path.join(r, 'archive', 'C--p'); const sid = 'aaaa-0963'; const sid2 = 'cccc-0963';
  fs.mkdirSync(path.join(S, sid), { recursive: true });
  const staged = path.join(S, sid2, 'x.jsonl.gz.0123456789abcdef01234567.coalwash-new'); mk(staged, 'staged by another session');
  const sw = seam(t, 'child', S, path.join(S, sid2), sid);
  W.collectStagedLeftovers(S, sid);
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(standing(staged), "the sibling's staged file was unlinked");
});

test('row 14 LH-14 listAsides: archive/<slug> a link to another slug folder of the archive lists none of its asides', (t) => {
  const r = root(t, 'lh14'); if (skipNoLink(t, r)) return;
  const A = path.join(r, 'archive'); const other = path.join(A, 'C--other-963');
  mk(path.join(other, 'x.coalwash-aside'), 'aside');
  linkDir(other, path.join(A, 'C--mine'));
  assert.deepStrictEqual(W.listAsides(path.join(A, 'C--mine'), real(A)), [], "another project's aside was listed under this slug");
});

test('row 15 LK pruneEmptyDirs: a <sid> handed in as a link to the slug folder memory/ removes no folder there', (t) => {
  const r = root(t, 'lk'); if (skipNoLink(t, r)) return;
  const projDir = path.join(r, 'projects', 'C--p'); const sid = 'aaaa-0963';
  mk(path.join(projDir, 'memory', 'MEMORY.md'), '# index\n'); fs.mkdirSync(path.join(projDir, 'memory', 'empty'), { recursive: true });
  linkDir(path.join(projDir, 'memory'), path.join(projDir, sid));
  W.pruneEmptyDirs(path.join(projDir, sid), projDir, []);
  assert.ok(standing(path.join(projDir, 'memory', 'empty')), 'memory/empty was removed');
});

test("row 16 LL restoreSourcesUnder: <sid>/ a link to a sibling session folder makes none of the sibling's files a source", (t) => {
  const r = root(t, 'll'); if (skipNoLink(t, r)) return;
  const S = path.join(r, 'archive', 'C--p'); const sid = 'aaaa-0963'; const sid2 = 'cccc-0963';
  mk(path.join(S, sid2, 'sub.jsonl.gz'), gz('the sibling session')); linkDir(path.join(S, sid2), path.join(S, sid));
  assert.deepStrictEqual(W.restoreSourcesUnder(path.join(S, sid), sid, real(S)), [], "a sibling's file became a restore source");
});

test('row 17 LM2 restoreSessionInner: a slug folder swapped after the archive listing for a link to another slug is not read through', (t) => {
  const r = root(t, 'lm2'); if (skipNoLink(t, r)) return;
  const A = path.join(r, 'archive'); const sid = 'aaaa-0963';
  const y = path.join(A, 'C--y'); mk(path.join(y, `${sid}.jsonl.gz`), gz('{"type":"user"}\n'));
  fs.mkdirSync(path.join(A, 'C--x'));
  const sw = seam(t, 'child', A, y, 'C--x');
  const s1 = spy(t, 'openSync', y); const s2 = spy(t, 'readFileSync', y);
  restoreSession(sid, { archiveDir: A, to: path.join(r, 'to') });
  s1.stop(); s2.stop(); sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  const viaX = [...s1.hits, ...s2.hits].filter((p) => p.includes(`${path.sep}C--x${path.sep}`));
  assert.deepStrictEqual(viaX, [], 'a file was read through the swapped slug folder');
});

test('row 18 LN2-18 observedRetentionFloorDays: a slug folder swapped after the projects listing gives no floor read from elsewhere', (t) => {
  const r = root(t, 'ln18'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const projects = path.join(H, '.claude', 'projects');
  const el = path.join(H, '.claude', 'elsewhere3'); mk(path.join(el, 'old.jsonl'), '{}\n');
  const old = new Date(Date.now() - 400 * 86400000); fs.utimesSync(path.join(el, 'old.jsonl'), old, old);
  fs.mkdirSync(path.join(projects, 'C--x'));
  const sw = seam(t, 'child', projects, el, 'C--x');
  const a = observedRetentionFloorDays({ home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(a === null || a < 399, `a retention floor was read from the link target: ${a} days`);
});

test('row 19 LN2-19 observedMachineAgeDays: a slug folder swapped after the projects listing is not stat-ed through the link', (t) => {
  const r = root(t, 'ln19'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const projects = path.join(H, '.claude', 'projects');
  const el = path.join(H, '.claude', 'elsewhere3'); fs.mkdirSync(el, { recursive: true });
  fs.mkdirSync(path.join(projects, 'C--x'));
  const sw = seam(t, 'child', projects, el, 'C--x');
  const s = spy(t, 'statSync', el);
  observedMachineAgeDays({ home: H });
  s.stop(); sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.strictEqual(s.hits.filter((p) => real(p) === real(el)).length, 0, 'the link target itself was stat-ed');
});

test('row 20 LO-20 walkDir: <sid>/tool-results swapped for a link to another slug folder counts none of its files', (t) => {
  const r = root(t, 'lo20'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const projects = path.join(H, '.claude', 'projects'); const projDir = path.join(projects, ccProjectSlug(P)); const sid = 'aaaa-0963';
  mk(path.join(projDir, `${sid}.jsonl`), '{}\n'); mk(path.join(projDir, sid, 'tool-results', 'r.txt'), 'mine');
  const other = path.join(projects, 'C--other-963'); mk(path.join(other, 'theirs.txt'), 'theirs');
  const sw = seam(t, 'child', path.join(projDir, sid), other, 'tool-results');
  const e = discoverEstateCC({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!e.some((x) => x.path === real(path.join(other, 'theirs.txt'))), "another slug's file was counted");
});

test("row 21 LO-21 discoverEstateCC: <sid>/ swapped after the slug listing for a link to another slug adds none of its files to this estate", (t) => {
  const r = root(t, 'lo21'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const projects = path.join(H, '.claude', 'projects'); const projDir = path.join(projects, ccProjectSlug(P)); const sid = 'aaaa-0963';
  mk(path.join(projDir, `${sid}.jsonl`), '{}\n'); mk(path.join(projDir, sid, 'tool-results', 'r.txt'), 'mine');
  const other = path.join(projects, 'C--other-963'); mk(path.join(other, 'theirs.txt'), 'theirs');
  const sw = seam(t, 'child', projDir, other, sid);
  const e = discoverEstateCC({ projectRoot: P, home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!e.some((x) => x.path === real(path.join(other, 'theirs.txt'))), "another slug's file was counted in this estate");
});

test('row 23 LP2 detectOrphanSlugs: a slug folder swapped after the projects listing reports no orphan from the link target', (t) => {
  const r = root(t, 'lp2'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const projects = path.join(H, '.claude', 'projects');
  const el = path.join(H, '.claude', 'elsewhere5'); const gone = path.join(r, 'no-such-963');
  mk(path.join(el, 'a.jsonl'), `{"cwd":${JSON.stringify(gone)}}\n`);
  fs.mkdirSync(path.join(projects, 'C--x'));
  const sw = seam(t, 'child', projects, el, 'C--x');
  const o = detectOrphanSlugs({ home: H });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!o.some((x) => x.cwd === gone), 'an orphan was reported from the link target');
});

test('row 24 LQ addStore (main) and the apply gate: projects/<slug>/memory a link to a folder under home has nothing rewritten or created there', (t) => {
  const r = root(t, 'lq'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r);
  const notes = path.join(H, 'notes'); mk(path.join(notes, 'MEMORY.md'), bigIndex("a folder under home, not this project's memory"));
  fs.mkdirSync(path.join(H, '.claude', 'projects', ccProjectSlug(P)), { recursive: true });
  linkDir(notes, path.join(H, '.claude', 'projects', ccProjectSlug(P), 'memory'));
  const before = fs.readFileSync(path.join(notes, 'MEMORY.md'), 'utf8');
  assert.ok(!collectStores({ projectRoot: P, home: H }).some((s) => s.label === 'main'), 'the linked folder was collected as the main store');
  runRetier({ projectRoot: P, home: H, sessionId: 'w963' });
  assert.strictEqual(fs.readFileSync(path.join(notes, 'MEMORY.md'), 'utf8'), before, '~/notes/MEMORY.md was rewritten');
  assert.ok(!standing(path.join(notes, 'retier-overflow.md')), 'an overflow file was created in ~/notes');
});

test('row 25 L9d collectStores (roles): a role swapped after the listing for a link to the project root has nothing rewritten or created there', (t) => {
  const r = root(t, 'l9d'); if (skipNoLink(t, r)) return;
  const H = path.join(r, 'home'); fs.mkdirSync(path.join(H, '.claude'), { recursive: true }); const P = projIn(r);
  const agentBase = path.join(P, '.claude', 'agent-memory'); mk(path.join(agentBase, 'coder', 'MEMORY.md'), '# coder\n');
  mk(path.join(P, 'MEMORY.md'), bigIndex('project root index'));
  mk(path.join(P, 'plans.md'), 'a project root note nobody links\n');
  const before = fs.readFileSync(path.join(P, 'MEMORY.md'), 'utf8');
  const sw = seam(t, 'child', agentBase, P, 'coder');
  runRetier({ projectRoot: P, home: H, sessionId: 'w963' });
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.strictEqual(fs.readFileSync(path.join(P, 'MEMORY.md'), 'utf8'), before, 'the project-root MEMORY.md was rewritten');
  assert.ok(standing(path.join(P, 'plans.md')), 'a project-root file was deleted');
  assert.ok(!standing(path.join(P, 'retier-overflow.md')), 'an overflow file was created at the project root');
});

test('row 28 LR listWriteguard: a session folder swapped after its lstat for a link to a project folder lists none of its names', (t) => {
  const r = root(t, 'lr'); if (skipNoLink(t, r)) return;
  const P = projIn(r);
  const sd = path.join(P, '.claude', 'coalwash', 'writeguard', 'sessA');
  mk(path.join(sd, `mine--${'a'.repeat(64)}`), 'own');
  const other = path.join(P, 'other'); mk(path.join(other, `theirs--${'b'.repeat(64)}`), 'not a snapshot of ours');
  const sw = seam(t, 'self-before', sd, other);
  const l = listWriteguard(P);
  sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.ok(!l.some((x) => x.name.startsWith('theirs--')), 'a name of the link target was listed');
});

test("row 29 LS newestSessionMtime: a session folder swapped after its lstat is not entered, so none of the target's entries is lstat'd", (t) => {
  const r = root(t, 'ls'); if (skipNoLink(t, r)) return;
  const P = projIn(r);
  const sd = path.join(P, '.claude', 'coalwash', 'writeguard', 'old');
  mk(path.join(sd, 'f'), 'own'); const other = path.join(P, 'other'); mk(path.join(other, 'theirs.txt'), 'theirs');
  const sw = seam(t, 'self-before', sd, other);
  const s = spy(t, 'lstatSync', other);
  sweepWriteguard(P, 'current');
  s.stop(); sw.undo();
  assert.ok(sw.fired(), 'the seam did not fire');
  assert.deepStrictEqual(s.hits.filter((p) => p.endsWith('theirs.txt')), [], "an entry of the link target was lstat'd");
  assert.ok(standing(path.join(other, 'theirs.txt')), 'the link target lost a file');
});

test('F961-3 (a) listSessions: a slug folder that is a link out of the Claude base lists no session and deletes nothing', (t) => {
  const r = root(t, 'f961a'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r); const OUT = path.join(r, 'out'); const slug = ccProjectSlug(P);
  mk(path.join(OUT, 'cccc-3333.jsonl'), '{"type":"user","note":"outside the Claude base"}\n');
  linkDir(OUT, path.join(H, '.claude', 'projects', slug));
  const s = listSessions({ projectRoot: P, home: H });
  for (const sess of s.sessions) archiveSession(sess, { slug, archiveDir: path.join(H, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.strictEqual(s.sessions.length, 0, 'a session outside the Claude base was listed');
  assert.ok(standing(path.join(OUT, 'cccc-3333.jsonl')), 'the outside transcript was deleted');
});

test('F961-3 (b) listSessions: a slug folder that is a link to another slug folder inside the Claude base lists no session and deletes nothing', (t) => {
  const r = root(t, 'f961b'); if (skipNoLink(t, r)) return;
  const H = homeIn(r); const P = projIn(r); const slug = ccProjectSlug(P);
  const other = path.join(H, '.claude', 'projects', 'C--sibling-963'); mk(path.join(other, 'dddd-4444.jsonl'), line('a sibling project live transcript'));
  linkDir(other, path.join(H, '.claude', 'projects', slug));
  const s = listSessions({ projectRoot: P, home: H });
  for (const sess of s.sessions) archiveSession(sess, { slug, archiveDir: path.join(H, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.strictEqual(s.sessions.length, 0, 'a session of the sibling slug was listed');
  assert.ok(standing(path.join(other, 'dddd-4444.jsonl')), "the sibling slug's live transcript was deleted");
});
