// 29oy fire 947, the reader class move (d), map 946 rows B5 to B9 and B11: a walk takes a child's kind from the listing, so a child folder
// swapped for a junction (Windows) or a directory symlink right AFTER the listing was followed, and the walk read, listed, removed or
// unlinked OUTSIDE its root. Each walk now checks, before it acts on or descends into a path, that the path's realpath is inside the
// walk root's realpath (fail closed). One test per walk site; the swap is a test-side seam on fs.readdirSync (it fires right after the
// walk lists the folder) and makes a REAL directory link, so each test probes that capability first and skips VISIBLY where it cannot.
// A swap between the per-path check and the act still follows (SECURITY.md Known limits): no test pins that residue.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __walkTestHooks as W, archiveSession } from './estate-archive.mjs';
import { __testHooks as A } from './apply.mjs';

const TMP = fs.realpathSync.native(os.tmpdir());
const HEX = 'a'.repeat(24);
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

// A temp root made here, asserted, and removed by a registered teardown.
function root(t, label) {
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP, `cw947-${label}-`)));
  t.after(() => {
    assert.ok(path.dirname(r) === TMP && path.basename(r).startsWith('cw947-'), `refusing to remove ${r}`);
    fs.rmSync(r, { recursive: true, force: true });
  });
  return r;
}
// The capability probe: can this account make a directory link here? (Windows makes a junction without a privilege; POSIX a dir symlink.)
function canLink(r) {
  const at = path.join(r, '.probe-link');
  try { linkDir(r, at); } catch (e) { return e && e.code ? e.code : 'error'; }
  try { fs.unlinkSync(at); } catch { try { fs.rmdirSync(at); } catch { /* removed with the root */ } }
  return null;
}
// The seam: right after the walk lists `listed`, its child `sub` is moved away and replaced by a link to `outside`. Restored by t.after.
function swapAfterListing(t, listed, sub, outside, aside) {
  const real = fs.readdirSync;
  let fired = false;
  fs.readdirSync = function (p, ...rest) {
    const res = real.call(fs, p, ...rest);
    if (!fired && path.resolve(String(p)) === path.resolve(listed)) {
      fired = true;
      fs.renameSync(sub, aside);
      linkDir(outside, sub);
    }
    return res;
  };
  const undo = () => { if (fs.readdirSync !== real) fs.readdirSync = real; };
  t.after(undo);
  return { undo, fired: () => fired };
}

test('B5 sessionGenerations: a session sub-folder swapped for a link right after the listing is not followed, so no outside generation is kept', (t) => {
  const r = root(t, 'b5');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const slugDir = path.join(r, 'archive', 's'); const sessDir = path.join(slugDir, 'abc');
  fs.mkdirSync(path.join(sessDir, 'sub'), { recursive: true });
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'x.jsonl.gz.gen3'), 'outside, not ours\n');
  const seam = swapAfterListing(t, sessDir, path.join(sessDir, 'sub'), out, path.join(r, 'sub-moved'));
  const gens = W.sessionGenerations(slugDir, 'abc');
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  assert.ok(!gens.has(3), 'no generation is taken from outside the session folder: ' + JSON.stringify([...gens.keys()]));
});

test('B6 restore sources: a session sub-folder swapped for a link right after the listing is not followed, so no outside .gz becomes a source', (t) => {
  const r = root(t, 'b6');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const sessDir = path.join(r, 'archive', 's', 'abc');
  fs.mkdirSync(path.join(sessDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'own.jsonl.gz'), 'ours\n');
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'y.jsonl.gz'), 'outside, not ours\n');
  const seam = swapAfterListing(t, sessDir, path.join(sessDir, 'sub'), out, path.join(r, 'sub-moved'));
  const sources = W.restoreSourcesUnder(sessDir, 'abc');
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  assert.ok(!sources.some((s) => s.gzPath.endsWith('y.jsonl.gz')), 'no outside .gz is a restore source: ' + JSON.stringify(sources));
  assert.ok(sources.some((s) => s.gzPath.endsWith('own.jsonl.gz')), 'the session\'s own copy still is');
});

test('B7 listAsides: a folder swapped for a link right after the listing is not followed, so no outside name is listed', (t) => {
  const r = root(t, 'b7');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const slugDir = path.join(r, 'archive', 's');
  fs.mkdirSync(path.join(slugDir, 'abc'), { recursive: true });
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'z.jsonl.gz.coalwash-aside'), 'outside, not ours\n');
  const seam = swapAfterListing(t, slugDir, path.join(slugDir, 'abc'), out, path.join(r, 'abc-moved'));
  const names = W.listAsides(slugDir);
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  assert.deepStrictEqual(names, [], 'no outside aside name is printed: ' + JSON.stringify(names));
});

test('B8 pruneEmptyDirs: a sub-folder swapped for a link right after the listing is not followed, so no outside folder is removed and no outside name is listed', (t) => {
  const r = root(t, 'b8');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const projDir = path.join(r, 'projects', 'slug'); const sess = path.join(projDir, 'abc');
  fs.mkdirSync(path.join(sess, 'sub'), { recursive: true });
  const out = path.join(r, 'outside'); fs.mkdirSync(path.join(out, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(out, 'keep.txt'), 'outside, not ours\n');
  const seam = swapAfterListing(t, sess, path.join(sess, 'sub'), out, path.join(r, 'sub-moved'));
  const survivors = [];
  W.pruneEmptyDirs(sess, projDir, survivors);
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  assert.ok(fs.existsSync(path.join(out, 'empty')), 'the empty folder outside is not removed');
  assert.ok(!survivors.some((s) => s.endsWith('keep.txt')), 'no outside name is listed: ' + JSON.stringify(survivors));
  assert.ok(survivors.includes(path.join('abc', 'sub')), 'the link itself is reported by its name inside the root: ' + JSON.stringify(survivors));
});

test('B9 the dead-link walk: a folder swapped for a link right after the listing is not followed, so no outside .md is read', (t) => {
  const r = root(t, 'b9');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const proj = path.join(r, 'proj');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'own.md'), '# ours\n');
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'o.md'), '# outside, not ours\n');
  const seam = swapAfterListing(t, proj, path.join(proj, 'sub'), out, path.join(r, 'sub-moved'));
  const files = [];
  A.collectMdFiles(proj, null, files);
  seam.undo();
  assert.ok(seam.fired(), 'the seam fired');
  const names = files.map((x) => String(x && x.p ? x.p : x));
  assert.ok(!names.some((p) => p.endsWith('o.md')), 'no outside .md is collected: ' + JSON.stringify(names));
  assert.ok(names.some((p) => p.endsWith('own.md')), 'the project\'s own .md still is');
});

test('B11 the staged-leftover sweep: a session sub-folder swapped for a link right after the listing is not followed, so no outside file is unlinked', (t) => {
  const r = root(t, 'b11');
  const why = canLink(r); if (why) return t.skip(`this account cannot make a directory link here (${why})`);
  const archiveDir = path.join(r, 'archive'); const sessDir = path.join(archiveDir, 's', 'abc');
  fs.mkdirSync(path.join(sessDir, 'sub'), { recursive: true });
  const out = path.join(r, 'outside'); fs.mkdirSync(out);
  const victim = path.join(out, `victim.gz.${HEX}.coalwash-tmp`);
  fs.writeFileSync(victim, 'outside, not ours\n');
  const seam = swapAfterListing(t, sessDir, path.join(sessDir, 'sub'), out, path.join(r, 'sub-moved'));
  let res;
  try { res = archiveSession({ id: 'abc', files: [] }, { slug: 's', archiveDir }); } finally { seam.undo(); }
  assert.ok(seam.fired(), 'the seam fired');
  assert.ok(fs.existsSync(victim), 'the outside file with a staged-temp name is never unlinked: ' + JSON.stringify(res));
});
