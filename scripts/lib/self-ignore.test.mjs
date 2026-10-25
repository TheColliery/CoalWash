// 14a fire 55 (PR #18, CodeRabbit r4231606757 / r4231606700): CoalWash's own folder, `<project>/.claude/coalwash/`, holds
// copies of memory content (the journal, the snapshots, the bins, the write-guard airbag). Its `.gitignore` used to be
// created `wx` with EEXIST taken as success, so a cloned repository that shipped that file permissive left every copy
// committable. These tests run a real transaction in a sandbox git repository and ask git itself what it ignores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitEnv } from './git-env.mjs';
import { applyPlan } from './apply.mjs';
import { ensureCatchAllIgnore, SELF_IGNORE_BODY } from './repo-fs.mjs';
import { snapshotOnFirstWrite } from './writeguard.mjs';
import { removeTree } from './test-plan.mjs';

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: gitEnv() }).status === 0;
const MEMORY = '# Memory\n\n- the user\'s own fact one\n- the user\'s own fact two\n';

function sandbox(t) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-selfignore-')));
  t.after(() => {
    assert.ok(root.startsWith(tmp + path.sep), `refusing to remove ${root}`);
    removeTree(root);
  });
  const proj = path.join(root, 'proj');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  for (const d of [proj, home, outside]) fs.mkdirSync(d);
  const r = spawnSync('git', ['init', '-q', '.'], { cwd: proj, env: gitEnv(root), encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, `git init: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(proj, '.git')), 'the fixture repository is its own');
  const store = path.join(proj, 'memory');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'MEMORY.md'), MEMORY);
  return { root, proj, home, outside, store, txDir: path.join(proj, '.claude', 'coalwash') };
}

// exit 0 = ignored, 1 = not ignored; anything else is an instrument failure, never read as either answer
function ignored(proj, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: proj, env: gitEnv(path.dirname(proj)), encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ok(r.status === 0 || r.status === 1, `git check-ignore ${rel}: status ${r.status} ${r.stderr}`);
  return r.status === 0;
}

function wash(s) {
  const plan = { projectRoot: s.proj, roots: [s.store], sessionId: 't-selfignore',
    actions: [{ type: 'rewrite', path: path.join(s.store, 'MEMORY.md'), content: MEMORY + '- a third fact\n' }] };
  return applyPlan(plan, { projectRoot: s.proj, home: s.home, keepSnapshots: 5 });
}

// every file CoalWash wrote in its own folder, as repo-relative paths (the .gitignore itself excluded)
function ownCopies(s) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
      else if (e.name !== '.gitignore') out.push(path.relative(s.proj, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(s.txDir)) walk(s.txDir);
  return out.sort();
}

for (const [label, body] of [['empty', ''], ['negation !*', '!*\n'], ['a comment', '# x\n'], ['a CRLF catch-all', '*\r\n']]) {
  test(`a planted ${label} .gitignore in .claude/coalwash/ is replaced by the catch-all, and git ignores every copy the transaction wrote`, { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
    const s = sandbox(t);
    fs.mkdirSync(s.txDir, { recursive: true });
    fs.writeFileSync(path.join(s.txDir, '.gitignore'), body);
    const res = wash(s);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(fs.readFileSync(path.join(s.txDir, '.gitignore'), 'latin1'), SELF_IGNORE_BODY);
    const copies = ownCopies(s);
    assert.ok(copies.some((c) => /\/snap-\d+\/f0$/.test(c)), `a snapshot copy was written: ${copies.join(', ')}`);
    for (const rel of [...copies, '.claude/coalwash/journal.json']) assert.ok(ignored(s.proj, rel), `${rel} is ignored by git`);
    assert.ok(!ignored(s.proj, 'memory/MEMORY.md'), 'the user\'s own memory file is NOT ignored');
  });
}

function canSymlinkFile(dir) {
  const target = path.join(dir, 'probe-target');
  const link = path.join(dir, 'probe-link');
  fs.writeFileSync(target, 'x');
  try { fs.symlinkSync(target, link, 'file'); return true; } catch { return false; } finally { fs.rmSync(link, { force: true }); fs.rmSync(target, { force: true }); }
}

test('a planted file LINK named .gitignore is replaced, never written through: the link target keeps its bytes and git ignores the copies', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  if (!canSymlinkFile(s.root)) { t.skip('this volume/user cannot create a file symlink'); return; }
  const victim = path.join(s.outside, 'victim.txt');
  fs.writeFileSync(victim, '!*\n');
  fs.mkdirSync(s.txDir, { recursive: true });
  fs.symlinkSync(victim, path.join(s.txDir, '.gitignore'), 'file');
  const res = wash(s);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.readFileSync(victim, 'utf8'), '!*\n', 'the link target was not written through');
  const st = fs.lstatSync(path.join(s.txDir, '.gitignore'));
  assert.ok(st.isFile() && !st.isSymbolicLink(), 'the link entry was replaced by a plain file');
  for (const rel of ownCopies(s)) assert.ok(ignored(s.proj, rel), `${rel} is ignored by git`);
});

// fire 63 (CodeRabbit t114): a directory link is a capability of the VOLUME and the user, never of the platform name, and what a rename over one does
// (replace the link entry, or refuse) is the volume's too. Both are probed here, in the test's own sandbox, and each outcome has its own gated test.
function canLinkDir(dir) {
  const target = path.join(dir, 'probe-dir-target');
  const link = path.join(dir, 'probe-dir-link');
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, link, 'junction'); return true; } catch { return false; } finally { fs.rmSync(link, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
}
function renameReplacesDirLink(dir) { // the shape replaceFile uses: a fresh temp file renamed over the existing entry
  const target = path.join(dir, 'probe-rn-target');
  const link = path.join(dir, 'probe-rn-link');
  const temp = path.join(dir, 'probe-rn-temp');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'junction');
  fs.writeFileSync(temp, 'x', { flag: 'wx' });
  try { fs.renameSync(temp, link); return true; } catch { return false; } finally {
    for (const p of [temp, link, target]) fs.rmSync(p, { recursive: true, force: true });
  }
}
function plantDirLink(t, s) {
  if (!canLinkDir(s.root)) { t.skip('this volume/user cannot create a directory link'); return false; }
  fs.writeFileSync(path.join(s.outside, 'keep.txt'), 'outside\n');
  fs.mkdirSync(s.txDir, { recursive: true });
  fs.symlinkSync(s.outside, path.join(s.txDir, '.gitignore'), 'junction'); // a junction on Windows, a directory symlink on POSIX
  return true;
}

test('a planted DIRECTORY link named .gitignore, on a volume where a rename replaces a directory link: the catch-all replaces it and git ignores the copies', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  if (!plantDirLink(t, s)) return;
  if (!renameReplacesDirLink(s.root)) { t.skip('on this volume a rename over a directory link is refused (the sibling test covers it)'); return; }
  const res = wash(s);
  assert.deepEqual(fs.readdirSync(s.outside), ['keep.txt'], 'nothing written into the link target');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(fs.readFileSync(path.join(s.txDir, '.gitignore'), 'latin1'), SELF_IGNORE_BODY);
  for (const rel of ownCopies(s)) assert.ok(ignored(s.proj, rel), `${rel} is ignored by git`);
});

test('a planted DIRECTORY link named .gitignore, on a volume where a rename over a directory link is refused: the transaction is refused before any journal or snapshot byte', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  if (!plantDirLink(t, s)) return;
  if (renameReplacesDirLink(s.root)) { t.skip('on this volume a rename replaces a directory link (the sibling test covers it)'); return; }
  const res = wash(s);
  assert.deepEqual(fs.readdirSync(s.outside), ['keep.txt'], 'nothing written into the link target');
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.error, /^self-ignore: /, res.error);
  assert.deepEqual(ownCopies(s), [], 'no journal, snapshot or lock was written');
  assert.equal(fs.readFileSync(path.join(s.store, 'MEMORY.md'), 'utf8'), MEMORY, 'the memory file is untouched');
});

test('a .gitignore that is a real directory cannot be replaced: the transaction is refused with a named reason and writes no copy', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.txDir, '.gitignore'), { recursive: true });
  const res = wash(s);
  assert.equal(res.ok, false);
  assert.match(res.error, /^self-ignore: cannot put the catch-all .* in place/, res.error);
  assert.deepEqual(ownCopies(s), [], 'no journal, snapshot or lock was written');
  assert.equal(fs.readFileSync(path.join(s.store, 'MEMORY.md'), 'utf8'), MEMORY);
});

test('ensureCatchAllIgnore: the exact catch-all is left alone (null, same inode), anything else is replaced, two racing callers both end on the catch-all', (t) => {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-catchall-')));
  t.after(() => { assert.ok(dir.startsWith(tmp + path.sep)); removeTree(dir); });
  const file = path.join(dir, '.gitignore');
  assert.equal(ensureCatchAllIgnore(dir), null, 'absent: created');
  // fire 63 (CodeQL #53-#56, js/file-system-race): the inode is read through an open fd, never by a path stat, so no check-then-act on `file` remains
  const inoOf = (p) => { const fd = fs.openSync(p, 'r'); try { return fs.fstatSync(fd, { bigint: true }).ino; } finally { fs.closeSync(fd); } };
  const ino = inoOf(file);
  assert.equal(ensureCatchAllIgnore(dir), null);
  assert.equal(inoOf(file), ino, 'the exact catch-all is not rewritten');
  for (const body of ['*', '*\n\n', ' *\n', '!*\n*\n', '*\n!x\n']) {
    fs.writeFileSync(file, body);
    assert.equal(ensureCatchAllIgnore(dir), null, JSON.stringify(body));
    assert.equal(fs.readFileSync(file, 'latin1'), SELF_IGNORE_BODY, JSON.stringify(body));
  }
  fs.writeFileSync(file, '!*\n');
  assert.deepEqual([ensureCatchAllIgnore(dir), ensureCatchAllIgnore(dir)], [null, null]);
  assert.equal(fs.readFileSync(file, 'latin1'), SELF_IGNORE_BODY);
  assert.deepEqual(fs.readdirSync(dir), ['.gitignore'], 'no temp left behind');
  assert.match(String(ensureCatchAllIgnore(path.join(dir, 'missing'))), /^cannot put the catch-all .* in place \(ENOENT\)$/, 'a create that fails for any reason but EEXIST is the refusal');
});

test('the write-guard airbag replaces a permissive tx-dir .gitignore before it snapshots, so git ignores the snapshot', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  const gov = path.join(s.proj, 'CLAUDE.md');
  fs.writeFileSync(gov, '# rules\n- one\n');
  fs.mkdirSync(s.txDir, { recursive: true });
  fs.writeFileSync(path.join(s.txDir, '.gitignore'), '!*\n');
  const snap = snapshotOnFirstWrite(s.proj, 't-wg', gov, { home: s.home });
  assert.ok(snap, 'the airbag took a snapshot');
  assert.equal(fs.readFileSync(path.join(s.txDir, '.gitignore'), 'latin1'), SELF_IGNORE_BODY);
  const copies = ownCopies(s);
  assert.ok(copies.length > 0);
  for (const rel of copies) assert.ok(ignored(s.proj, rel), `${rel} is ignored by git`);
  assert.ok(!ignored(s.proj, 'CLAUDE.md'));
});

test('the write-guard airbag takes NO snapshot when the tx-dir catch-all cannot be put in place', (t) => {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-wgrefuse-')));
  t.after(() => { assert.ok(root.startsWith(tmp + path.sep)); removeTree(root); });
  const proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'coalwash', '.gitignore'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'));
  const gov = path.join(proj, 'CLAUDE.md');
  fs.writeFileSync(gov, '# rules\n');
  assert.equal(snapshotOnFirstWrite(proj, 't-wg', gov, { home: path.join(root, 'home') }), null);
  // the session folder is made before the check (the catch-all needs its parent to exist); no FILE lands in it
  assert.deepEqual(ownCopies({ proj, txDir: path.join(proj, '.claude', 'coalwash') }), [], 'no snapshot or sidecar was written');
});

test('a bin and a keep refuse to write when their folder\'s catch-all cannot be put in place (a .gitignore that is a directory)', async (t) => {
  const { recordBinItem, FAT_BIN_NAME } = await import('./tailings.mjs');
  const { recordKeep } = await import('./keeps.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-binkeep-')));
  t.after(() => { assert.ok(proj.startsWith(tmp + path.sep)); removeTree(proj); });
  const tx = path.join(proj, '.claude', 'coalwash');
  fs.mkdirSync(path.join(tx, FAT_BIN_NAME, '.gitignore'), { recursive: true });
  assert.equal(recordBinItem(proj, FAT_BIN_NAME, { content: 'memory body\n', original: path.join(proj, 'MEMORY.md') }), null);
  assert.deepEqual(fs.readdirSync(path.join(tx, FAT_BIN_NAME)), ['.gitignore'], 'no bin item, index or lock');
  fs.mkdirSync(path.join(tx, '.gitignore'));
  assert.equal(recordKeep(proj, { target: path.join(proj, 'MEMORY.md'), reason: 'r', anchor: 'memory body' }).ok, false);
  assert.ok(!fs.existsSync(path.join(tx, 'keeps.json')), 'no keeps.json');
});

test('a lock called without selfIgnore (the global lock, in the user\'s own ~/.claude) never rewrites an existing .gitignore in its folder', async (t) => {
  const { acquireLock } = await import('./apply.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-lockdir-')));
  t.after(() => { assert.ok(dir.startsWith(tmp + path.sep)); removeTree(dir); });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const l = acquireLock(path.join(dir, '.coalwash-global.lock'), { sessionId: 't-lock' });
  assert.equal(l.acquired, true);
  l.release();
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n', 'the user\'s .gitignore is untouched');
});

// 15b fire 56, the head's ruling on census row 5: the GLOBAL lock lives in the user's own ~/.claude, which a user may
// version in a dotfiles repo, so it creates NO .gitignore there. The project tx and bin locks opt in (selfIgnore: true).
test('the global lock creates no .gitignore in an empty ~/.claude, and a project lock that opts in gets the catch-all', async (t) => {
  const { acquireLock } = await import('./apply.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-globallock-')));
  t.after(() => { assert.ok(root.startsWith(tmp + path.sep)); removeTree(root); });
  const claude = path.join(root, 'home', '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const g = acquireLock(path.join(claude, '.coalwash-global.lock'), { sessionId: 't-global' });
  assert.equal(g.acquired, true);
  g.release();
  assert.deepEqual(fs.readdirSync(claude), [], 'no .gitignore (and no lock left) in the user\'s ~/.claude');
  const tx = path.join(root, 'proj', '.claude', 'coalwash');
  fs.mkdirSync(tx, { recursive: true });
  const p = acquireLock(path.join(tx, '.coalwash.lock'), { sessionId: 't-proj', selfIgnore: true });
  assert.equal(p.acquired, true);
  p.release();
  assert.equal(fs.readFileSync(path.join(tx, '.gitignore'), 'latin1'), SELF_IGNORE_BODY, 'the project lock keeps the catch-all');
});

// 15b fire 56, census row 3: `snap-<now>` is a FRESH name. A planted entry at that name (a junction to elsewhere, or a
// directory a cloned repo committed) must refuse the transaction before the first snapshot byte, never take the copies.
const PLANT_NOW = 1760000000000;
for (const kind of ['junction', 'directory']) {
  test(`a planted snap-<now> ${kind} refuses the transaction before the first snapshot byte; no memory copy lands in it`, { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
    const s = sandbox(t);
    fs.mkdirSync(s.txDir, { recursive: true });
    const planted = path.join(s.txDir, `snap-${PLANT_NOW}`);
    if (kind === 'junction' && !canLinkDir(s.root)) { t.skip('this volume/user cannot create a directory link'); return; } // fire 63 (t114): probed, never assumed
    if (kind === 'junction') fs.symlinkSync(s.outside, planted, 'junction');
    else fs.mkdirSync(planted);
    const plan = { projectRoot: s.proj, roots: [s.store], sessionId: 't-fresh',
      actions: [{ type: 'rewrite', path: path.join(s.store, 'MEMORY.md'), content: MEMORY + '- a third fact\n' }] };
    const res = applyPlan(plan, { projectRoot: s.proj, home: s.home, keepSnapshots: 5, now: PLANT_NOW });
    assert.deepEqual(fs.readdirSync(s.outside), [], 'nothing written through a link');
    assert.deepEqual(fs.readdirSync(planted), [], 'nothing written into the planted folder');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.error, /^snapshot folder: /, res.error);
    assert.equal(fs.readFileSync(path.join(s.store, 'MEMORY.md'), 'utf8'), MEMORY, 'the memory file is untouched');
    assert.ok(!fs.existsSync(path.join(s.txDir, 'journal.json')), 'no journal');
  });
}

// 15b fire 59 (INSPECT L58-1): git ignore rules never apply to a TRACKED path, so a repository that commits a file inside
// CoalWash's own folder (keeps.json, a bin index, the journal, the .gitignore itself) would get CoalWash's writes staged by the
// next `git commit -a`. Every writer of that folder now refuses while git tracks anything there.
function gitc(s, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=cw', '-c', 'user.email=cw@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd: s.proj, env: gitEnv(s.root), encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function plantTracked(s, rel, body) {
  const p = path.join(s.txDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  gitc(s, 'add', '-f', path.relative(s.proj, p));
  gitc(s, 'commit', '-q', '-m', 'plant');
}
const ANCHOR = 'PRIVATE-MEMORY-ANCHOR quoted text 42';

test('L58-1: a TRACKED keeps.json is never written over: recordKeep refuses and git status stays clean', { skip: !HAS_GIT && 'git is not on PATH' }, async (t) => {
  const { recordKeep } = await import('./keeps.mjs');
  const s = sandbox(t);
  plantTracked(s, 'keeps.json', '[]\n');
  const r = recordKeep(s.proj, { target: path.join(s.store, 'MEMORY.md'), reason: 'x', anchor: ANCHOR });
  assert.equal(gitc(s, 'status', '--porcelain', '--', '.claude/coalwash'), '', 'no tracked file under .claude/coalwash changed');
  assert.ok(!fs.readFileSync(path.join(s.txDir, 'keeps.json'), 'utf8').includes(ANCHOR), 'the anchor reaches no tracked file');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^tracked: git tracks 1 file\(s\) in /, 'fire 63 (t114): the refusal names its reason');
});

test('L58-1 (A2): a TRACKED fat-bin/index.json is never written over: recordBinItem refuses and git status stays clean', { skip: !HAS_GIT && 'git is not on PATH' }, async (t) => {
  const { recordBinItem, FAT_BIN_NAME } = await import('./tailings.mjs');
  const s = sandbox(t);
  plantTracked(s, `${FAT_BIN_NAME}/index.json`, '[]\n');
  const id = recordBinItem(s.proj, FAT_BIN_NAME, { content: 'PRIVATE-BIN-CONTENT\n', original: path.join(s.store, 'MEMORY.md') });
  assert.equal(gitc(s, 'status', '--porcelain', '--', '.claude/coalwash'), '', 'no tracked file under .claude/coalwash changed');
  assert.equal(id, null);
});

for (const [label, rel, body] of [['journal.json', 'journal.json', '{}\n'], ['a permissive .gitignore', '.gitignore', '!*\n']]) {
  test(`L58-1: a TRACKED ${label} in CoalWash's folder refuses the transaction before any write; git status stays clean`, { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
    const s = sandbox(t);
    plantTracked(s, rel, body);
    const res = wash(s);
    assert.equal(gitc(s, 'status', '--porcelain', '--', '.claude/coalwash'), '', 'nothing tracked changed, the .gitignore included');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.error, /^tracked: /, res.error);
    assert.equal(fs.readFileSync(path.join(s.store, 'MEMORY.md'), 'utf8'), MEMORY);
  });
}

test('L58-1: a git query that ERRORS inside a repository (a corrupt index) refuses; it is never read as "nothing tracked"', { skip: !HAS_GIT && 'git is not on PATH' }, async (t) => {
  const { recordKeep } = await import('./keeps.mjs');
  const s = sandbox(t);
  plantTracked(s, 'keeps.json', '[]\n');
  fs.writeFileSync(path.join(s.proj, '.git', 'index'), 'not an index');
  const r = recordKeep(s.proj, { target: path.join(s.store, 'MEMORY.md'), reason: 'x', anchor: ANCHOR });
  assert.equal(r.ok, false);
  assert.ok(!fs.readFileSync(path.join(s.txDir, 'keeps.json'), 'utf8').includes(ANCHOR));
  assert.match(String(r.error), /^tracked: cannot tell whether git tracks files/, 'fire 63 (t114): the refusal names its reason');
});

test('L58-1: outside any repository nothing is tracked, so the writers work as before (no-external-assumption)', async (t) => {
  const { recordKeep } = await import('./keeps.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-norepo-')));
  t.after(() => { assert.ok(proj.startsWith(tmp + path.sep)); removeTree(proj); });
  assert.equal(recordKeep(proj, { target: path.join(proj, 'MEMORY.md'), reason: 'x', anchor: ANCHOR }).ok, true);
});

test('a project lock that opts in refuses when its folder\'s catch-all cannot be put in place (a .gitignore directory)', async (t) => {
  const { acquireLock } = await import('./apply.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-lockign-')));
  t.after(() => { assert.ok(dir.startsWith(tmp + path.sep)); removeTree(dir); });
  fs.mkdirSync(path.join(dir, '.gitignore'));
  const l = acquireLock(path.join(dir, '.coalwash.lock'), { sessionId: 't', selfIgnore: true });
  assert.equal(l.acquired, false);
  assert.match(l.reason, /^self-ignore: /);
  assert.ok(!fs.existsSync(path.join(dir, '.coalwash.lock')), 'no lock written');
});
