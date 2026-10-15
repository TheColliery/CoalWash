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

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: gitEnv() }).status === 0;
const MEMORY = '# Memory\n\n- the user\'s own fact one\n- the user\'s own fact two\n';

function sandbox(t) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-selfignore-')));
  t.after(() => {
    assert.ok(root.startsWith(tmp + path.sep), `refusing to remove ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
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

test('a planted DIRECTORY link named .gitignore: either the catch-all replaces it, or the transaction is refused before any journal or snapshot byte', { skip: !HAS_GIT && 'git is not on PATH' }, (t) => {
  const s = sandbox(t);
  fs.writeFileSync(path.join(s.outside, 'keep.txt'), 'outside\n');
  fs.mkdirSync(s.txDir, { recursive: true });
  fs.symlinkSync(s.outside, path.join(s.txDir, '.gitignore'), 'junction'); // a junction on Windows, a directory symlink on POSIX
  const res = wash(s);
  assert.deepEqual(fs.readdirSync(s.outside), ['keep.txt'], 'nothing written into the link target');
  if (res.ok) {
    assert.equal(fs.readFileSync(path.join(s.txDir, '.gitignore'), 'latin1'), SELF_IGNORE_BODY);
    for (const rel of ownCopies(s)) assert.ok(ignored(s.proj, rel), `${rel} is ignored by git`);
  } else {
    assert.match(res.error, /^self-ignore: /, res.error);
    assert.deepEqual(ownCopies(s), [], 'no journal, snapshot or lock was written');
    assert.equal(fs.readFileSync(path.join(s.store, 'MEMORY.md'), 'utf8'), MEMORY, 'the memory file is untouched');
  }
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
  t.after(() => { assert.ok(dir.startsWith(tmp + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, '.gitignore');
  assert.equal(ensureCatchAllIgnore(dir), null, 'absent: created');
  const ino = fs.statSync(file, { bigint: true }).ino;
  assert.equal(ensureCatchAllIgnore(dir), null);
  assert.equal(fs.statSync(file, { bigint: true }).ino, ino, 'the exact catch-all is not rewritten');
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
  t.after(() => { assert.ok(root.startsWith(tmp + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
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
  t.after(() => { assert.ok(proj.startsWith(tmp + path.sep)); fs.rmSync(proj, { recursive: true, force: true }); });
  const tx = path.join(proj, '.claude', 'coalwash');
  fs.mkdirSync(path.join(tx, FAT_BIN_NAME, '.gitignore'), { recursive: true });
  assert.equal(recordBinItem(proj, FAT_BIN_NAME, { content: 'memory body\n', original: path.join(proj, 'MEMORY.md') }), null);
  assert.deepEqual(fs.readdirSync(path.join(tx, FAT_BIN_NAME)), ['.gitignore'], 'no bin item, index or lock');
  fs.mkdirSync(path.join(tx, '.gitignore'));
  assert.equal(recordKeep(proj, { target: path.join(proj, 'MEMORY.md'), reason: 'r', anchor: 'memory body' }).ok, false);
  assert.ok(!fs.existsSync(path.join(tx, 'keeps.json')), 'no keeps.json');
});

test('the lock only CREATES a missing catch-all in its folder and never rewrites an existing .gitignore (the global lock sits in the user\'s own ~/.claude)', async (t) => {
  const { acquireLock } = await import('./apply.mjs');
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'cw-lockdir-')));
  t.after(() => { assert.ok(dir.startsWith(tmp + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const l = acquireLock(path.join(dir, '.coalwash-global.lock'), { sessionId: 't-lock' });
  assert.equal(l.acquired, true);
  l.release();
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n', 'the user\'s .gitignore is untouched');
});
