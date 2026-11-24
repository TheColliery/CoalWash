// 29ps fire 958, THE CLASS LIST (fire 957, main's c208 ruling 1): a function that lists a folder and then uses a listed name as a root, a
// path to open, stat, read, copy, move or delete, or an index key. The rows still UNCHECKED at cf9b128 (and one CHECKED row whose root
// was wider than its folder), one test each, the inspector's witnesses as room legs:
//   L8   reconcileIndex (F956-1): archive/<slug> a directory link out of the archive root.
//   L9   collectStores (F957-2): <project>/.claude/agent-memory a link to a folder under HOME; L9b a role folder swapped after the listing.
//   L10  listSessions/walkFiles (F957-1): <sid>/ swapped after the slug listing for a link to ANOTHER slug folder; L10b the session
//        folder swapped after listSessions, before archiveSession's delete.
//   L11  sniffCwd (F957-4): the first .jsonl of a slug folder a FILE symlink to an outside file.
//   L12  pruneStrayStateDirs (F957-3): projects/<name> a link to an outside folder holding coalwash/state.json.
// Each test makes one temp root, asserted and removed by its own teardown, with a temp HOME (never the real one), and probes the link
// capability it needs, skipping VISIBLY where it cannot be made.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { classifySessions, runEstate, listSessions, archiveSession, ESTATE_INDEX_NAME } from './estate-archive.mjs';
import { collectStores } from './retier.mjs';
import { recordStamp } from './caliper.mjs';
import { detectOrphanSlugs } from './estate.mjs';
import { ccProjectSlug } from './class-b.mjs';

for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']) delete process.env[k];
const TMP = fs.realpathSync.native(os.tmpdir());
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const standing = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function root(t, label) {
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP, `cw958-${label}-`)));
  t.after(() => {
    assert.ok(path.dirname(r) === TMP && path.basename(r).startsWith('cw958-'), `refusing to remove ${r}`);
    fs.rmSync(r, { recursive: true, force: true });
  });
  return r;
}
function canDirLink(r) {
  const at = path.join(r, '.probe-dir-link');
  try { linkDir(r, at); } catch (e) { return (e && e.code) || 'error'; }
  try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* removed with the root */ } }
  return null;
}
function canFileLink(r) {
  const target = path.join(r, '.probe-target'); const at = path.join(r, '.probe-file-link');
  fs.writeFileSync(target, 'x');
  try { fs.symlinkSync(target, at, 'file'); } catch (e) { return (e && e.code) || 'error'; }
  try { fs.unlinkSync(at); } catch { /* removed with the root */ }
  return null;
}
// After the FIRST listing of `listed`, `sub` is moved aside and a directory link to `outside` put in its place; undone by t.after.
function swapAfterListing(t, listed, sub, outside, aside) {
  const real = fs.readdirSync;
  let fired = false;
  fs.readdirSync = function (p, ...rest) {
    const res = real.call(fs, p, ...rest);
    if (!fired && path.resolve(String(p)) === path.resolve(listed)) { fired = true; fs.renameSync(sub, aside); linkDir(outside, sub); }
    return res;
  };
  const undo = () => { if (fs.readdirSync !== real) fs.readdirSync = real; };
  t.after(undo);
  return { undo, fired: () => fired };
}

test('F956-1 L8 reconcileIndex: an archive/<slug> that is a link out of the archive root is never read, so no outside transcript is indexed', (t) => {
  const r = root(t, 'l8');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const proj = path.join(r, 'proj'); fs.mkdirSync(proj);
  const archiveDir = path.join(r, 'archive'); fs.mkdirSync(archiveDir);
  const estate = { archiveDir, indexEnabled: true };
  const slug = classifySessions({ projectRoot: proj, home, estate }).slug;
  const SID = '0958aaaa-bbbb-4ccc-8ddd-eeeeffff0958';
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, `${SID}.jsonl.gz`), zlib.gzipSync(Buffer.from(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'OUTSIDE-L8' } })}\n`)));
  linkDir(out, path.join(archiveDir, slug));
  const res = runEstate({ projectRoot: proj, home, estate });
  const idx = path.join(archiveDir, ESTATE_INDEX_NAME);
  const text = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8') : '';
  assert.ok(!text.includes(SID), 'no index row comes from a transcript outside the archive root: ' + JSON.stringify({ reconciledRows: res && res.reconciledRows }));
});

test('F957-2 L9 collectStores: a .claude/agent-memory that is a link out of the project makes no role store, and says so', (t) => {
  const r = root(t, 'l9');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); const proj = path.join(r, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  mk(path.join(home, 'notes', 'diary', 'MEMORY.md'), '# diary index\n- see [plans](plans.md)\n');
  mk(path.join(home, 'notes', 'diary', 'plans.md'), 'port: 4401\n');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  linkDir(path.join(home, 'notes'), path.join(proj, '.claude', 'agent-memory'));
  const stores = collectStores({ projectRoot: proj, home });
  const labels = stores.map((s) => s.label);
  assert.ok(!labels.includes('agent:diary'), 'no folder outside the project becomes a role store: ' + JSON.stringify(labels));
  assert.ok((stores.skipped || []).some((s) => /agent-memory/.test(String(s.reason) + String(s.label))), 'the refusal is reported: ' + JSON.stringify(stores.skipped));
});

test('F957-2 L9b collectStores: a role folder swapped after the agent-memory listing for a link to a folder under HOME is not a role store', (t) => {
  const r = root(t, 'l9b');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); const proj = path.join(r, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  mk(path.join(home, 'notes', 'diary', 'MEMORY.md'), '# diary index\n');
  const agentBase = path.join(proj, '.claude', 'agent-memory');
  mk(path.join(agentBase, 'coder', 'MEMORY.md'), '# coder\n');
  const seam = swapAfterListing(t, agentBase, path.join(agentBase, 'coder'), path.join(home, 'notes', 'diary'), path.join(r, 'coder-moved'));
  const stores = collectStores({ projectRoot: proj, home });
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  const outsideDirs = stores.filter((s) => s.label !== 'main' && !s.dir.startsWith(fs.realpathSync.native(proj) + path.sep));
  assert.deepStrictEqual(outsideDirs.map((s) => s.label), [], 'a role store is held to the project root, never to home');
});

test('F957-1 L10 listSessions: a session folder swapped after the slug listing for a link to another slug folder takes none of its files, and archiving deletes nothing of it', (t) => {
  const r = root(t, 'l10');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); const proj = path.join(r, 'proj'); fs.mkdirSync(proj);
  const projects = path.join(home, '.claude', 'projects');
  const slug = ccProjectSlug(proj); const projDir = path.join(projects, slug);
  const sid = 'aaaa-1111'; const other = path.join(projects, 'C--other-project'); const osid = 'bbbb-2222';
  mk(path.join(projDir, `${sid}.jsonl`), '{"type":"user","cwd":"x"}\n');
  mk(path.join(projDir, sid, 'tool-results', 'r.txt'), 'mine\n');
  mk(path.join(other, `${osid}.jsonl`), '{"type":"user","note":"another project live transcript"}\n');
  const seam = swapAfterListing(t, projDir, path.join(projDir, sid), other, path.join(r, 'sid-moved'));
  const listed = listSessions({ projectRoot: proj, home });
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  const sess = listed.sessions.find((x) => x.id === sid);
  const rels = sess ? sess.files.map((f) => f.rel) : [];
  assert.ok(!rels.some((x) => x.includes('C--other-project') || x.includes(osid)), 'no file of another slug folder joins the session: ' + JSON.stringify(rels));
  if (sess) archiveSession(sess, { slug, archiveDir: path.join(home, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.ok(standing(path.join(other, `${osid}.jsonl`)), "the other project's live transcript is never deleted");
});

test('F957-1 L10b archiveSession: the session folder swapped after listSessions for a link to another slug folder holding the same bytes is never deleted through', (t) => {
  const r = root(t, 'l10b');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); const proj = path.join(r, 'proj'); fs.mkdirSync(proj);
  const projects = path.join(home, '.claude', 'projects');
  const slug = ccProjectSlug(proj); const projDir = path.join(projects, slug);
  const sid = 'aaaa-1111'; const other = path.join(projects, 'C--other-project');
  mk(path.join(projDir, `${sid}.jsonl`), '{"type":"user","cwd":"x"}\n');
  mk(path.join(projDir, sid, 'tool-results', 'r.txt'), 'same bytes\n');
  mk(path.join(other, 'tool-results', 'r.txt'), 'same bytes\n'); // the other folder's own file, byte-equal to ours
  // the same size and modification time too, so the archive's pre-delete stat (size and mtime) cannot tell the two files apart
  const when = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(path.join(projDir, sid, 'tool-results', 'r.txt'), when, when);
  fs.utimesSync(path.join(other, 'tool-results', 'r.txt'), when, when);
  const listed = listSessions({ projectRoot: proj, home });
  const sess = listed.sessions.find((x) => x.id === sid);
  assert.ok(sess && sess.files.length === 2, 'control: the session lists its two files');
  fs.renameSync(path.join(projDir, sid), path.join(r, 'sid-moved'));
  linkDir(other, path.join(projDir, sid));
  const res = archiveSession(sess, { slug, archiveDir: path.join(home, 'arch'), now: Date.now() + 400 * 86400000 });
  assert.ok(standing(path.join(other, 'tool-results', 'r.txt')), "the other folder's file is never deleted through the swapped session folder: " + JSON.stringify(res && (res.reason || res.ok)));
});

test('F957-4 L11 sniffCwd (through detectOrphanSlugs): a .jsonl that is a file link to an outside file is never read', (t) => {
  const r = root(t, 'l11');
  const why = canFileLink(r); if (why) return t.skip(`this account cannot make a file symlink here (${why}): the leg needs one`);
  const home = path.join(r, 'home'); const out = path.join(r, 'out');
  const slugDir = path.join(home, '.claude', 'projects', 'C--gone-958');
  fs.mkdirSync(slugDir, { recursive: true });
  const planted = path.join(r, 'no-such-dir-958');
  mk(path.join(out, 'secret.jsonl'), `{"cwd":${JSON.stringify(planted)}}\n`);
  fs.symlinkSync(path.join(out, 'secret.jsonl'), path.join(slugDir, 'a.jsonl'), 'file');
  const orphans = detectOrphanSlugs({ home });
  assert.ok(!orphans.some((o) => o.cwd === planted), 'no cwd is read from an outside file: ' + JSON.stringify(orphans.map((o) => o.cwd)));
});

test('F957-3 L12 pruneStrayStateDirs (through recordStamp): a projects/<name> that is a link out of the Claude base has no state file opened', (t) => {
  const r = root(t, 'l12');
  const why = canDirLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const home = path.join(r, 'home'); const proj = path.join(r, 'proj'); const out = path.join(r, 'out');
  fs.mkdirSync(proj, { recursive: true });
  const projects = path.join(home, '.claude', 'projects');
  fs.mkdirSync(path.join(projects, ccProjectSlug(proj)), { recursive: true });
  mk(path.join(out, 'coalwash', 'state.json'), JSON.stringify({ stateSchema: 3, projectRoot: path.join(r, 'elsewhere') }));
  linkDir(out, path.join(projects, 'C--evil-958'));
  const outPhys = fs.realpathSync.native(out);
  const seen = [];
  const real = fs.openSync;
  fs.openSync = function (p, ...a) {
    try { const rp = fs.realpathSync.native(String(p)); if (rp.startsWith(outPhys + path.sep)) seen.push(String(p)); } catch { /* not there */ }
    return real.call(fs, p, ...a);
  };
  try { recordStamp(home, proj, 1000, Date.now()); } finally { fs.openSync = real; }
  assert.deepStrictEqual(seen.map((p) => path.relative(r, p)), [], 'no state file outside the Claude base is opened');
});
