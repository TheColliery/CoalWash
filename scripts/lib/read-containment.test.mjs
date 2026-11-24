// E2-4 (09b fire 44): the READ half of CWK-137, as a CLASS. A bounded read CoalWash makes in its OWN folder
// (<project>/.claude/coalwash/** and a role store's own directory) is contained to that folder ITSELF: a link a cloned
// repository planted, resolving anywhere else (outside the project, or inside it but outside the folder), is refused and
// read as no data (hooks-safety.md section 6 row 10). One test per read KIND: snapshot manifest, snapshot copy, journal,
// keeps, bin item / index / death log, write-guard listing / snapshot / sidecar, role-store index / topic.
//
// THE LINK SHAPES, probed and never assumed. A directory link (a junction on Windows, no privilege needed) reaches only the
// kinds with a directory between the own folder and the file: a snapshot, a write-guard session. Every other kind is a FILE
// in the own folder, reachable only by a FILE symlink; that leg skips VISIBLY where the volume refuses one (Windows without
// Developer Mode), and CI's ubuntu/macOS legs run it. So each file kind also has a SIMULATED leg that runs everywhere:
// realpath(<planted path>) is made to answer a file outside the folder while the bytes on disk are a stand-in. Realpath is
// the one input the containment check decides on, so a site that skips the check reads the stand-in and a contained site
// refuses before the open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_DOC_BYTES, repoReadOutcome } from './config-load.mjs';
import { anchorDiff } from './anchor-diff.mjs';
import { recoverDangling, sweepSnapshots, verifySnapshot, applyPlan } from './apply.mjs';
import { loadKeeps, recordKeep, loadGlobalKeeps, globalKeepsPath } from './keeps.mjs';
import { restoreFromBin, binItemOutcome, listBin, readDeathLog, FAT_BIN_NAME } from './tailings.mjs';
import { restore } from './cli.mjs';
import { snapshotOnFirstWrite, readSnapshot, listWriteguard, readWriteguardSnapshot } from './writeguard.mjs';
import { collectStores, rollbackFromSnapshot } from './retier.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: the sandbox home only

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const SECRET = 'OUTSIDE-SECRET https://secret.example.com/api-token 987654321 `SECRET_KEY_NAME`\n';
const LEAK_RE = /secret\.example\.com|987654321|SECRET_KEY_NAME|OUTSIDE-SECRET/;
const MEMORY = '# memory\nnothing here\n';
// tailings.mjs keeps these two names private; they are the on-disk format, so the test spells them.
const BIN_INDEX = 'index.json';
const BIN_DEATH_LOG = 'death.log';

// One sandbox under the resolved temp root, removed by a registered t.after that first asserts its own target.
function sandbox(t, label) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, `cw-e24-${label}-`)));
  t.after(() => {
    assert.ok(dir.startsWith(TMP_ROOT + path.sep), `refusing to remove ${dir}: not under ${TMP_ROOT}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = path.join(dir, 'project');
  const outside = path.join(dir, 'outside');
  const home = path.join(dir, 'home');
  const own = path.join(project, '.claude', 'coalwash');
  for (const d of [project, outside, path.join(home, '.claude'), own]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# p\n');
  const mem = path.join(project, 'MEMORY.md');
  fs.writeFileSync(mem, MEMORY);
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, SECRET);
  return { dir, project, outside, home, own, mem, secret };
}

function dirLink(target, at) {
  try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
function fileLink(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return true; } catch { return false; }
}

// The SIMULATED file symlink: realpath(at) answers `to`, every other path resolves for real. Restored by t.after, and by
// the returned function for a test that reads the disk afterwards.
function fakeRealpath(t, at, to) {
  const real = fs.realpathSync.native;
  const key = path.resolve(at);
  const fake = (p, ...rest) => (path.resolve(String(p)) === key ? to : real(p, ...rest));
  fs.realpathSync.native = fake;
  const undo = () => { if (fs.realpathSync.native === fake) fs.realpathSync.native = real; };
  t.after(undo);
  return undo;
}

function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); }
function plantSnapshot(dir, original, body) {
  writeJson(path.join(dir, 'manifest.json'), [{ original, snap: 'f0' }]);
  fs.writeFileSync(path.join(dir, 'snap.complete'), '');
  fs.writeFileSync(path.join(dir, 'f0'), body);
}

// ---- snapshot manifest + snapshot copy (anchor-diff.mjs) ----------------------------------------------------------------

test('E2-4 control: a REAL snapshot naming the file is an anchor, so the legs below would read it if nothing refused them', (t) => {
  const s = sandbox(t, 'adctl');
  plantSnapshot(path.join(s.own, 'snap-1'), fs.realpathSync.native(s.mem), SECRET);
  const r = anchorDiff(s.mem, { projectRoot: s.project, home: s.home });
  assert.ok(r && r.candidates.some((c) => c.value === '987654321'), `report: ${JSON.stringify(r)}`);
});

test('E2-4 snapshot: a snapshot directory planted as a link OUT of the project is never read -- anchor-diff reports nothing', (t) => {
  const s = sandbox(t, 'adout');
  plantSnapshot(path.join(s.outside, 'fake'), fs.realpathSync.native(s.mem), SECRET);
  if (!dirLink(path.join(s.outside, 'fake'), path.join(s.own, 'snap-1'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.equal(anchorDiff(s.mem, { projectRoot: s.project, home: s.home }), null);
});

test('E2-4 snapshot: a link to a directory INSIDE the project but outside .claude/coalwash is refused too -- the folder itself, not the project', (t) => {
  const s = sandbox(t, 'adin');
  plantSnapshot(path.join(s.project, 'decoy'), fs.realpathSync.native(s.mem), SECRET);
  if (!dirLink(path.join(s.project, 'decoy'), path.join(s.own, 'snap-1'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.equal(anchorDiff(s.mem, { projectRoot: s.project, home: s.home }), null);
});

test('E2-4 snapshot copy: a snapshot copy that is a FILE symlink out of the project is never read', (t) => {
  const s = sandbox(t, 'adfile');
  const snap = path.join(s.own, 'snap-1');
  plantSnapshot(snap, fs.realpathSync.native(s.mem), '');
  fs.rmSync(path.join(snap, 'f0'));
  if (!fileLink(s.secret, path.join(snap, 'f0'))) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg below runs everywhere)'); return; }
  assert.equal(anchorDiff(s.mem, { projectRoot: s.project, home: s.home }), null);
});

test('E2-4 snapshot copy (simulated file link): a copy whose realpath is outside the folder is refused, not read', (t) => {
  const s = sandbox(t, 'adsim');
  const snap = path.join(s.own, 'snap-1');
  plantSnapshot(snap, fs.realpathSync.native(s.mem), SECRET);
  fakeRealpath(t, path.join(snap, 'f0'), s.secret);
  assert.equal(anchorDiff(s.mem, { projectRoot: s.project, home: s.home }), null);
});

test('E2-4 snapshot manifest (simulated file link): a manifest whose realpath is outside the folder names no anchor', (t) => {
  const s = sandbox(t, 'admani');
  const snap = path.join(s.own, 'snap-1');
  plantSnapshot(snap, fs.realpathSync.native(s.mem), SECRET);
  fakeRealpath(t, path.join(snap, 'manifest.json'), s.secret);
  assert.equal(anchorDiff(s.mem, { projectRoot: s.project, home: s.home }), null);
});

test('E2-4 regression (the reviewer\'s witness): `cli.mjs anchor-diff MEMORY.md --json` through a planted snapshot link prints no outside token', (t) => {
  const s = sandbox(t, 'adcli');
  plantSnapshot(path.join(s.outside, 'fake'), fs.realpathSync.native(s.mem), SECRET);
  if (!dirLink(path.join(s.outside, 'fake'), path.join(s.own, 'snap-1'))) { t.skip('this volume cannot make a directory link'); return; }
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, NODE_OPTIONS: '--max-old-space-size=2048' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'anchor-diff', 'MEMORY.md', '--json'],
    { cwd: s.project, env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', windowsHide: true });
  assert.equal(r.error, undefined, `spawn: ${r.error && r.error.message}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, LEAK_RE);
});

// ---- the transaction directory: journal, recovery manifest, retention, snapshot verify (apply.mjs) ----------------------

test('E2-4 journal (simulated file link): recoverDangling refuses a journal whose realpath is outside the folder and leaves it in place', (t) => {
  const s = sandbox(t, 'rdjour');
  const jp = path.join(s.own, 'journal.json');
  writeJson(jp, { version: 1, status: 'committed' });
  fakeRealpath(t, jp, s.secret);
  const r = recoverDangling(s.project, { home: s.home });
  assert.equal(r.recovered, 'none', JSON.stringify(r));
  assert.match(String(r.error), /journal unreadable/);
  assert.ok(fs.existsSync(jp), 'the journal is left for inspection, never removed');
});

test('E2-4 journal: a journal that is a FILE symlink out of the project is not replayed or removed', (t) => {
  const s = sandbox(t, 'rdjfile');
  writeJson(path.join(s.outside, 'journal.json'), { version: 1, status: 'committed' });
  const jp = path.join(s.own, 'journal.json');
  if (!fileLink(path.join(s.outside, 'journal.json'), jp)) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  const r = recoverDangling(s.project, { home: s.home });
  assert.equal(r.recovered, 'none', JSON.stringify(r));
  assert.ok(fs.lstatSync(jp).isSymbolicLink(), 'the planted link is left in place');
});

test('E2-4 recovery manifest (simulated file link): a snapshot manifest whose realpath is outside the folder is not replayed', (t) => {
  const s = sandbox(t, 'rdmani');
  const snap = path.join(s.own, 'snap-1');
  fs.mkdirSync(snap);
  fs.writeFileSync(path.join(snap, 'snap.complete'), '');
  writeJson(path.join(snap, 'manifest.json'), []);
  const jp = path.join(s.own, 'journal.json');
  writeJson(jp, { version: 1, status: 'pending', snapDir: snap, roots: [s.project], steps: [] });
  fakeRealpath(t, path.join(snap, 'manifest.json'), s.secret);
  const r = recoverDangling(s.project, { home: s.home });
  assert.equal(r.recovered, 'none', JSON.stringify(r));
  assert.match(String(r.error), /snapshot manifest unreadable/);
  assert.ok(fs.existsSync(jp), 'the journal is kept for a human');
});

test('E2-4 retention journal (simulated file link): sweepSnapshots freezes on a journal whose realpath is outside the folder', (t) => {
  const s = sandbox(t, 'swjour');
  for (const n of ['snap-1', 'snap-2']) fs.mkdirSync(path.join(s.own, n));
  const jp = path.join(s.own, 'journal.json');
  writeJson(jp, { version: 1, status: 'committed' });
  fakeRealpath(t, jp, s.secret);
  sweepSnapshots(s.own, 0);
  assert.ok(fs.existsSync(path.join(s.own, 'snap-1')) && fs.existsSync(path.join(s.own, 'snap-2')), 'cannot know what the journal protects -> sweep nothing');
});

test('E2-4 snapshot verify (simulated file link): a copy whose realpath is outside the folder is UNVERIFIABLE, never compared', (t) => {
  const s = sandbox(t, 'vsnap');
  const snap = path.join(s.own, 'snap-5');
  fs.mkdirSync(snap);
  fs.writeFileSync(path.join(snap, 'f0'), MEMORY);
  fakeRealpath(t, path.join(snap, 'f0'), s.secret);
  const bad = verifySnapshot(snap, [{ original: fs.realpathSync.native(s.mem), snap: 'f0' }]);
  assert.equal(bad.length, 1, JSON.stringify(bad));
  assert.match(bad[0], /unverifiable: copy outside-root/);
});

// ---- keeps.json (keeps.mjs) ------------------------------------------------------------------------------------------------

test('E2-4 keeps (simulated file link): a project keeps.json whose realpath is outside the folder protects nothing and is not merged on a record', (t) => {
  const s = sandbox(t, 'keeps');
  const kp = path.join(s.own, 'keeps.json');
  writeJson(kp, { v: 1, keeps: [{ target: 'PLANTED', reason: 'from outside' }] });
  const undo = fakeRealpath(t, kp, s.secret);
  assert.deepEqual(loadKeeps(s.project), []);
  const before = fs.readFileSync(kp, 'utf8');
  const r = recordKeep(s.project, { target: 'NEW', reason: 'r' });
  undo();
  // T-RD-KEEPS (named step, 29mm item R: "a refused link" is a read failure, not an empty store): the record is now refused by
  // name and writes nothing, where it used to rewrite the store without the outside keeps; the outside keeps are still never merged
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(String(r.error), /could not be read \(outside-root\); nothing was written/, r.error);
  const written = fs.readFileSync(kp, 'utf8');
  assert.equal(written, before, 'nothing was written');
  assert.doesNotMatch(written, /NEW/, 'the outside keeps were not merged into a rewrite');
});

test('E2-4 keeps: a project keeps.json that is a FILE symlink out of the project protects nothing', (t) => {
  const s = sandbox(t, 'keepsf');
  writeJson(path.join(s.outside, 'keeps.json'), { v: 1, keeps: [{ target: 'PLANTED' }] });
  if (!fileLink(path.join(s.outside, 'keeps.json'), path.join(s.own, 'keeps.json'))) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  assert.deepEqual(loadKeeps(s.project), []);
});

test('E2-4 keeps KEPT null: the user\'s GLOBAL keeps file is read even when it resolves elsewhere in home (a stow-style dotfile link)', (t) => {
  const s = sandbox(t, 'gkeeps');
  const gp = globalKeepsPath(s.home);
  writeJson(gp, { v: 1, keeps: [{ target: 'MINE' }] });
  const dot = path.join(s.home, 'dotfiles', 'keeps.json');
  writeJson(dot, {});
  fakeRealpath(t, gp, dot);
  assert.deepEqual(loadGlobalKeeps(s.home).map((k) => k.target), ['MINE'], 'a user-owned file is never contained to its folder');
});

// ---- the bins (tailings.mjs + cli restore) ---------------------------------------------------------------------------------

test('E2-4 bin item (simulated file link): restore refuses an item whose realpath is outside the bin', (t) => {
  const s = sandbox(t, 'binitem');
  const item = path.join(s.own, FAT_BIN_NAME, '1700000000009-dddddddddddd');
  fs.mkdirSync(path.dirname(item));
  fs.writeFileSync(item, SECRET);
  fakeRealpath(t, item, s.secret);
  assert.equal(restoreFromBin(s.project, FAT_BIN_NAME, '1700000000009-dddddddddddd'), null);
  const r = restore({ id: '1700000000009-dddddddddddd', cwd: s.project, home: s.home });
  assert.equal(r.found, false, JSON.stringify({ ...r, content: undefined }));
  assert.equal(r.refused && r.refused.why, 'outside-root', 'the reason the CLI keys its no-copy line on');
});

test('E2-4 bin item (the E2 dry witness): a bin item that is a FILE symlink out of the project is never restored', (t) => {
  const s = sandbox(t, 'binfile');
  const item = path.join(s.own, FAT_BIN_NAME, '1700000000009-dddddddddddd');
  fs.mkdirSync(path.dirname(item));
  if (!fileLink(s.secret, item)) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  assert.equal(restoreFromBin(s.project, FAT_BIN_NAME, '1700000000009-dddddddddddd'), null);
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, NODE_OPTIONS: '--max-old-space-size=2048' };
  delete env.NODE_TEST_CONTEXT;
  const c = spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'restore', '1700000000009-dddddddddddd'],
    { cwd: s.project, env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', windowsHide: true });
  assert.equal(c.status, 1, `stderr: ${c.stderr}`);
  assert.doesNotMatch(`${c.stdout}${c.stderr}`, LEAK_RE);
  assert.match(c.stderr, /resolves outside the bin/);
  assert.doesNotMatch(c.stderr, /copy it by hand/, 'never tell the user to copy a planted link');
});

test('E2-4 bin index (simulated file link): an index.json whose realpath is outside the bin lists nothing', (t) => {
  const s = sandbox(t, 'binidx');
  const idx = path.join(s.own, FAT_BIN_NAME, BIN_INDEX);
  writeJson(idx, [{ id: '1700000000009-dddddddddddd', at: 1, original: 'x', origin: 'program-cut' }]);
  fakeRealpath(t, idx, s.secret);
  assert.deepEqual(listBin(s.project, FAT_BIN_NAME), []);
});

test('E2-4 bin death log (simulated file link): a death log whose realpath is outside the bin reads as none', (t) => {
  const s = sandbox(t, 'binlog');
  const log = path.join(s.own, FAT_BIN_NAME, BIN_DEATH_LOG);
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, SECRET);
  fakeRealpath(t, log, s.secret);
  assert.equal(readDeathLog(s.project, FAT_BIN_NAME), '');
});

// ---- the write-guard airbag (writeguard.mjs) -------------------------------------------------------------------------------

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function plantWgSession(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(dir, `${name}.origpath`), `X\n${sha256(Buffer.from(body))}`);
}

test('E2-4 write-guard session planted as a link OUT of the project: not listed, never restored', (t) => {
  const s = sandbox(t, 'wgout');
  plantWgSession(path.join(s.outside, 'sess'), 'snapX', SECRET);
  fs.mkdirSync(path.join(s.own, 'writeguard'));
  if (!dirLink(path.join(s.outside, 'sess'), path.join(s.own, 'writeguard', 'evil'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.deepEqual(listWriteguard(s.project).filter((r) => r.session === 'evil'), []);
  assert.equal(readWriteguardSnapshot(s.project, 'snapX'), null);
});

test('E2-4 write-guard session linked to a directory INSIDE the project but outside the folder: not listed, never restored', (t) => {
  const s = sandbox(t, 'wgin');
  plantWgSession(path.join(s.project, 'decoy'), 'snapX', SECRET);
  fs.mkdirSync(path.join(s.own, 'writeguard'));
  if (!dirLink(path.join(s.project, 'decoy'), path.join(s.own, 'writeguard', 'evil'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.deepEqual(listWriteguard(s.project).filter((r) => r.session === 'evil'), []);
  assert.equal(readWriteguardSnapshot(s.project, 'snapX'), null);
});

test('E2-4 write-guard entry that is a FILE symlink out of the project: not listed', (t) => {
  const s = sandbox(t, 'wglist');
  const sess = path.join(s.own, 'writeguard', 's1');
  fs.mkdirSync(sess, { recursive: true });
  if (!fileLink(s.secret, path.join(sess, 'snapX'))) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it)'); return; }
  assert.deepEqual(listWriteguard(s.project).filter((r) => r.name === 'snapX'), []);
});

// A real airbag snapshot of MEMORY.md, taken the way an Edit takes it: { blob, sidecar, name }.
function airbag(s, session = 's1') {
  const blob = snapshotOnFirstWrite(s.project, session, s.mem, { home: s.home });
  assert.ok(blob, 'the fixture snapshot was taken');
  return { blob, sidecar: `${blob}.origpath`, name: path.basename(blob) };
}

test('E2-4 write-guard restore door, sidecar (simulated file link): a sidecar whose realpath is outside the folder verifies nothing', (t) => {
  const s = sandbox(t, 'wgside');
  const a = airbag(s);
  assert.ok(readWriteguardSnapshot(s.project, a.name), 'control: the real snapshot restores');
  fakeRealpath(t, a.sidecar, s.secret);
  assert.equal(readWriteguardSnapshot(s.project, a.name), null);
});

test('E2-4 write-guard restore door, blob (simulated file link): a snapshot whose realpath is outside the folder is never handed back', (t) => {
  const s = sandbox(t, 'wgblob');
  const a = airbag(s);
  fs.writeFileSync(a.blob, SECRET);
  fs.writeFileSync(a.sidecar, `${fs.realpathSync.native(s.mem)}\n${sha256(Buffer.from(SECRET))}`);
  fakeRealpath(t, a.blob, s.secret);
  assert.equal(readWriteguardSnapshot(s.project, a.name), null);
});

test('E2-4 write-guard baseline, sidecar (simulated file link): the seatbelt finds no baseline behind an outside sidecar', (t) => {
  const s = sandbox(t, 'wgbside');
  const a = airbag(s);
  assert.ok(readSnapshot(s.project, 's1', s.mem, { home: s.home }), 'control: the baseline reads');
  fakeRealpath(t, a.sidecar, s.secret);
  assert.equal(readSnapshot(s.project, 's1', s.mem, { home: s.home }), null);
});

test('E2-4 write-guard baseline, blob (simulated file link): the seatbelt reads no baseline whose realpath is outside the folder', (t) => {
  const s = sandbox(t, 'wgbblob');
  const a = airbag(s);
  fakeRealpath(t, a.blob, s.secret);
  assert.equal(readSnapshot(s.project, 's1', s.mem, { home: s.home }), null);
});

test('E2-4 write-guard airbag re-read (simulated file link): a fresh snapshot slot that resolves outside the folder is not attested', (t) => {
  const s = sandbox(t, 'wgnew');
  const { name } = airbag(s, 'a');
  fakeRealpath(t, path.join(s.own, 'writeguard', 'b', name), s.secret);
  assert.equal(snapshotOnFirstWrite(s.project, 'b', s.mem, { home: s.home }), null);
});

// ---- a role store's own directory (retier.mjs collectStores) ---------------------------------------------------------------

function roleStore(s, role = 'r1') {
  const dir = path.join(s.project, '.claude', 'agent-memory', role);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# index\n- [t](t.md)\n');
  fs.writeFileSync(path.join(dir, 't.md'), '# topic\nbody\n');
  return dir;
}

test('E2-4 role-store index (simulated file link): a MEMORY.md whose realpath is outside its store is not a store', (t) => {
  const s = sandbox(t, 'rsidx');
  const dir = roleStore(s);
  assert.ok(collectStores({ projectRoot: s.project, home: s.home }).some((x) => x.label === 'agent:r1'), 'control: the store is seen');
  fakeRealpath(t, path.join(dir, 'MEMORY.md'), s.secret);
  assert.ok(!collectStores({ projectRoot: s.project, home: s.home }).some((x) => x.label === 'agent:r1'));
});

test('E2-4 role-store topic (simulated file link): a topic whose realpath is outside its store is not read', (t) => {
  const s = sandbox(t, 'rstopic');
  const dir = roleStore(s);
  fakeRealpath(t, path.join(dir, 't.md'), s.secret);
  const store = collectStores({ projectRoot: s.project, home: s.home }).find((x) => x.label === 'agent:r1');
  assert.ok(store, 'the store itself is still seen');
  assert.ok(!store.topics.some((x) => x.basename === 't.md'), JSON.stringify(store.topics.map((x) => x.basename)));
});

test('E2-4 role-store index: a MEMORY.md that is a FILE symlink out of the project is not a store', (t) => {
  const s = sandbox(t, 'rsfile');
  const dir = roleStore(s);
  fs.rmSync(path.join(dir, 'MEMORY.md'));
  if (!fileLink(s.secret, path.join(dir, 'MEMORY.md'))) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  assert.ok(!collectStores({ projectRoot: s.project, home: s.home }).some((x) => x.label === 'agent:r1'));
});

// ---- the shape every contained site uses -----------------------------------------------------------------------------------

test('E2-4 the root is the folder ITSELF: a `..` spelling that starts inside .claude/coalwash and ends at the project root is refused there, read under the project root', (t) => {
  const s = sandbox(t, 'dotdot');
  fs.mkdirSync(path.join(s.own, 'snap-1')); // a real directory: POSIX resolves `..` after it physically, Windows lexically
  const spelled = [s.own, 'snap-1', '..', '..', '..', 'MEMORY.md'].join(path.sep);
  assert.equal(repoReadOutcome(spelled, s.own, MAX_DOC_BYTES).why, 'outside-root');
  assert.equal(String(repoReadOutcome(spelled, s.project, MAX_DOC_BYTES).buf), MEMORY, 'the same spelling under the project root is an ordinary read');
});

// ---- 09b fire 47: R46-1 (a linked bin FOLDER) and R46-2 (the two rollback reads of the run's own snapshot) ----------------

// R46-1: the CLI restore line for a refused bin folder. Spawned so the test reads the exact words a user sees.
function cliRestore(s, id) {
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, NODE_OPTIONS: '--max-old-space-size=2048' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(HERE, 'cli.mjs'), 'restore', id],
    { cwd: s.project, env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', windowsHide: true });
}
function assertFolderRefusal(s, label) {
  for (const id of ['1700000000009-dddddddddddd', '1700000000010-eeeeeeeeeeee']) {
    const r = restore({ id, cwd: s.project, home: s.home });
    assert.equal(r.found, false, `${label} ${id}`);
    assert.equal(r.refused && r.refused.why, 'refused-folder', `${label} ${id}: ${JSON.stringify({ ...r, content: undefined })}`);
    const c = cliRestore(s, id);
    assert.equal(c.status, 1, `stderr: ${c.stderr}`);
    assert.doesNotMatch(`${c.stdout}${c.stderr}`, LEAK_RE);
    assert.match(c.stderr, /is a link or not a plain directory/, c.stderr);
    assert.doesNotMatch(c.stderr, /copy it by hand/, 'never tell the user to copy a path through a planted folder');
    assert.doesNotMatch(c.stderr, / is in /, `never claim '${id}' is in the bin`);
  }
}

test('R46-1 bin folder: a fat-bin planted as a directory link out of the project is refused as a folder, never "copy it by hand"', (t) => {
  const s = sandbox(t, 'binlinkdir');
  const out = path.join(s.outside, 'bin');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, '1700000000009-dddddddddddd'), SECRET);
  if (!dirLink(out, path.join(s.own, FAT_BIN_NAME))) { t.skip('this volume cannot make a directory link'); return; }
  assert.equal(binItemOutcome(s.project, FAT_BIN_NAME, '1700000000009-dddddddddddd').why, 'refused-folder');
  assertFolderRefusal(s, 'fat-bin linked');
});

test('R46-1 bin folder: .claude/coalwash itself planted as a directory link is refused as a folder for both bins', (t) => {
  const s = sandbox(t, 'ownlinkdir');
  const out = path.join(s.outside, 'cw');
  fs.mkdirSync(path.join(out, FAT_BIN_NAME), { recursive: true });
  fs.writeFileSync(path.join(out, FAT_BIN_NAME, '1700000000009-dddddddddddd'), SECRET);
  fs.rmSync(s.own, { recursive: true, force: true });
  if (!dirLink(out, s.own)) { t.skip('this volume cannot make a directory link'); return; }
  assertFolderRefusal(s, '.claude/coalwash linked');
});

// R46-2, retier: rollbackFromSnapshot's manifest read is contained to the folder the snapshot sits in.
function plantRetierSnap(s) {
  const snap = path.join(s.own, 'snap-1');
  writeJson(path.join(snap, 'manifest.json'), [{ snap: 'f0', original: s.mem }]);
  fs.writeFileSync(path.join(snap, 'f0'), 'PRISTINE\n');
  fs.writeFileSync(s.mem, 'CHANGED\n');
  return snap;
}

test('R46-2 retier rollback manifest (simulated file link): a manifest whose realpath is outside reads as none (-1), nothing restored', (t) => {
  const s = sandbox(t, 'rtman');
  const snap = plantRetierSnap(s);
  fakeRealpath(t, path.join(snap, 'manifest.json'), s.secret);
  assert.equal(rollbackFromSnapshot(snap, [], [s.project]), -1);
  assert.equal(fs.readFileSync(s.mem, 'utf8'), 'CHANGED\n');
});

test('R46-2 retier rollback manifest: a manifest that is a FILE symlink out of the project reads as none (-1)', (t) => {
  const s = sandbox(t, 'rtmanfile');
  const snap = plantRetierSnap(s);
  const evil = path.join(s.outside, 'manifest.json');
  writeJson(evil, [{ snap: 'f0', original: s.mem }]);
  fs.rmSync(path.join(snap, 'manifest.json'));
  if (!fileLink(evil, path.join(snap, 'manifest.json'))) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  assert.equal(rollbackFromSnapshot(snap, [], [s.project]), -1);
  assert.equal(fs.readFileSync(s.mem, 'utf8'), 'CHANGED\n');
});

test('R46-2 retier rollback control: a real in-folder manifest still restores byte-exact', (t) => {
  const s = sandbox(t, 'rtctl');
  const snap = plantRetierSnap(s);
  assert.equal(rollbackFromSnapshot(snap, [], [s.project]), 0);
  assert.equal(fs.readFileSync(s.mem, 'utf8'), 'PRISTINE\n');
});

// R46-2, apply: the in-run rollback reads each snapshot copy contained to the tx dir. A delete step is made to fail AFTER
// verifySnapshot has passed, and at that moment the rewritten file's copy is swapped (`swap`) -- the window a concurrent
// local writer has.
function applyWithSwappedCopy(t, s, swap) {
  const store = path.join(s.project, 'memory');
  const f1 = path.join(store, 'f1.md');
  const f2 = path.join(store, 'f2.md');
  fs.mkdirSync(store);
  fs.writeFileSync(f1, 'original one\n');
  fs.writeFileSync(f2, 'original two\n');
  const real = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (String(p) === f2) {
      const snapDir = fs.readdirSync(s.own).filter((n) => n.startsWith('snap-')).map((n) => path.join(s.own, n))[0];
      const m = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8')).find((e) => e.original === f1);
      swap(path.join(snapDir, m.snap));
      const e = new Error(`ENOENT: no such file or directory, rm '${f2}'`); e.code = 'ENOENT'; throw e;
    }
    return real.call(fs, p, ...rest);
  };
  t.after(() => { fs.rmSync = real; });
  let r;
  try {
    r = applyPlan({ projectRoot: s.project, roots: [store], sessionId: 't-session', actions: [
      { type: 'rewrite', path: f1, content: 'rewritten one\n' },
      { type: 'delete', path: f2 },
    ] }, { projectRoot: s.project, home: s.home });
  } finally { fs.rmSync = real; }
  return { r, f1, f2 };
}

test('R46-2 apply rollback copy (simulated file link): a copy whose realpath is outside is one failed restore, never copied', (t) => {
  const s = sandbox(t, 'aprb');
  const { r, f1 } = applyWithSwappedCopy(t, s, (copy) => fakeRealpath(t, copy, s.secret));
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, 'partial', JSON.stringify(r));
  assert.equal(fs.readFileSync(f1, 'utf8'), 'rewritten one\n', 'the refused copy is not written over the original');
});

test('R46-2 apply rollback copy: a copy swapped for a FILE symlink out of the project is never copied into the original', (t) => {
  const s = sandbox(t, 'aprbfile');
  let linked = true;
  const { r, f1 } = applyWithSwappedCopy(t, s, (copy) => { fs.rmSync(copy); linked = fileLink(s.secret, copy); if (!linked) fs.writeFileSync(copy, 'original one\n'); });
  if (!linked) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it; the simulated leg runs everywhere)'); return; }
  assert.equal(r.rolledBack, 'partial', JSON.stringify(r));
  assert.doesNotMatch(fs.readFileSync(f1, 'utf8'), LEAK_RE);
});

test('R46-2 apply rollback control: an untouched snapshot still restores the original byte-exact', (t) => {
  const s = sandbox(t, 'aprbctl');
  const { r, f1, f2 } = applyWithSwappedCopy(t, s, () => {});
  assert.equal(r.rolledBack, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(f1, 'utf8'), 'original one\n');
  assert.equal(fs.readFileSync(f2, 'utf8'), 'original two\n');
});

// ---- T-29nj-1-CW (map 937): repoReadOutcome's identity is the lstat of the ONE realpath its post-open check resolved --------
// The reader opened by name, checked the post-open realpath for containment, then took the identity it compares the handle with
// from a SECOND resolution of the name (fs.statSync(file)). A name moved to X for the open, back for the realpath, and to X again for
// that second resolution passed both checks and the bytes of X were read (ALT-LINK, witnessed RED in scratchpad/29oj/w-map937.mjs).
// Fixture: a directory link root/link -> root/realA (a junction on Windows); A and B inside the root, X outside it. Every swap is a
// test-side seam on a node call (fs.openSync, fs.realpathSync.native, the identity stat), never a seam in shipped code. The folder
// residue (a component of the resolved path itself swapped, ALT-CHAIN) is a stated limit in SECURITY.md and is not pinned here.
function linkFixture(t, label) {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, `cw-t29nj-${label}-`)));
  t.after(() => {
    assert.ok(top.startsWith(TMP_ROOT + path.sep), `refusing to remove ${top}: not under ${TMP_ROOT}`);
    fs.rmSync(top, { recursive: true, force: true });
  });
  const root = path.join(top, 'root');
  const D = { A: path.join(root, 'realA'), B: path.join(root, 'realB'), X: path.join(top, 'outside') };
  for (const [k, d] of Object.entries(D)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'k.json'), `bytes of ${k}\n`); }
  const link = path.join(root, 'link');
  const point = (to) => {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* none yet */ } }
    if (!dirLink(to, link)) throw new Error('cannot make a directory link here');
  };
  // E1 t401 #1: the FIRST link is the capability probe. Where this account cannot make a directory link the test skips VISIBLY and
  // the caller returns on null; once the first link exists, a retarget that fails (point) still throws, so a test never passes on a
  // swap that did not happen.
  if (!dirLink(D.A, link)) { t.skip('this account cannot make a directory link here'); return null; }
  return { top, root, D, link, point, file: path.join(link, 'k.json') };
}
// Run repoReadOutcome on `file` with seams: R5 (just before the open), afterOpen, R7 (the post-open realpath of the name, its second
// call), ID (the identity read after the open: fs.statSync(name, bigint) in the old shape, fs.lstatSync(any, bigint) in the new one).
// `ino0` makes every bigint stat after the open report ino 0n (an inode-0 volume). `devX` (E1 t401 #3) makes the handle's bigint stat
// report another volume's dev. Every seam is restored before the result returns.
function readWithSeams(file, root, plan = {}) {
  const realOpen = fs.openSync, realStat = fs.statSync, realLstat = fs.lstatSync, realFstat = fs.fstatSync, realRp = fs.realpathSync.native;
  const zero = (s) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n });
  let opened = false, rpN = 0, idFired = false;
  const id = () => { if (opened && !idFired) { idFired = true; if (plan.ID) plan.ID(); } };
  fs.realpathSync.native = function (p, ...rest) {
    if (p === file) { rpN++; if (rpN === 2 && plan.R7) plan.R7(); }
    return realRp.call(fs.realpathSync, p, ...rest);
  };
  fs.openSync = function (p, ...rest) {
    if (p === file && !opened) { if (plan.R5) plan.R5(); try { return realOpen.call(fs, p, ...rest); } finally { opened = true; if (plan.afterOpen) plan.afterOpen(); } }
    return realOpen.call(fs, p, ...rest);
  };
  fs.statSync = function (p, opts, ...rest) {
    if (opts && opts.bigint) { id(); const s = realStat.call(fs, p, opts, ...rest); return plan.ino0 && opened ? zero(s) : s; }
    return realStat.call(fs, p, opts, ...rest);
  };
  fs.lstatSync = function (p, opts, ...rest) {
    if (opts && opts.bigint && opened) { id(); const s = realLstat.call(fs, p, opts, ...rest); return plan.ino0 ? zero(s) : s; }
    return realLstat.call(fs, p, opts, ...rest);
  };
  fs.fstatSync = function (fd, opts, ...rest) {
    const s = realFstat.call(fs, fd, opts, ...rest);
    const z = plan.ino0 && opts && opts.bigint ? zero(s) : s;
    return plan.devX && opts && opts.bigint ? Object.assign(Object.create(Object.getPrototypeOf(z)), z, { dev: z.dev + 1n }) : z;
  };
  try { return repoReadOutcome(file, root, MAX_DOC_BYTES); } finally {
    fs.openSync = realOpen; fs.statSync = realStat; fs.lstatSync = realLstat; fs.fstatSync = realFstat; fs.realpathSync.native = realRp;
  }
}
const said = (o) => (o.buf ? `READ ${String(o.buf).trim()}` : `refused why=${o.why}`);

test('T-29nj-1-CW leg 1 control: with no swap the read through the directory link returns A', (t) => {
  const f = linkFixture(t, 'ctl');
  if (!f) return;
  assert.equal(said(readWithSeams(f.file, f.root)), 'READ bytes of A');
});
test('T-29nj-1-CW leg 2 INSIDE: the name moved to B for the open, back to A for the post-open realpath, to B for the identity is refused, never read', (t) => {
  const f = linkFixture(t, 'in');
  if (!f) return;
  const o = readWithSeams(f.file, f.root, { R5: () => f.point(f.D.B), afterOpen: () => f.point(f.D.A), ID: () => f.point(f.D.B) });
  assert.equal(said(o), 'refused why=changed', 'the handle (B) is not the entry the checked realpath names (A)');
});
test('T-29nj-1-CW leg 3 OUTSIDE: the name moved outside for the open, back for the post-open realpath, outside again for the identity is refused, never read', (t) => {
  const f = linkFixture(t, 'out');
  if (!f) return;
  const o = readWithSeams(f.file, f.root, { R5: () => f.point(f.D.X), afterOpen: () => f.point(f.D.A), ID: () => f.point(f.D.X) });
  assert.equal(said(o), 'refused why=changed', 'the outside bytes are never returned');
  assert.ok(!o.buf || !/bytes of X/.test(String(o.buf)));
});
test('T-29nj-1-CW leg 4 single-swap regressions: the name moved outside just before the open, or just before the post-open realpath, is refused', (t) => {
  const f = linkFixture(t, 'one');
  if (!f) return;
  assert.equal(said(readWithSeams(f.file, f.root, { R5: () => f.point(f.D.X) })), 'refused why=changed', 'R5 to X');
  f.point(f.D.A);
  assert.equal(said(readWithSeams(f.file, f.root, { R7: () => f.point(f.D.X) })), 'refused why=changed', 'R7 to X');
});
test('T-29nj-1-CW leg 5 real file link: a file symlink retargeted outside for the open and the identity, back for the post-open realpath, is refused', (t) => {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'cw-t29nj-flink-')));
  t.after(() => {
    assert.ok(top.startsWith(TMP_ROOT + path.sep), `refusing to remove ${top}: not under ${TMP_ROOT}`);
    fs.rmSync(top, { recursive: true, force: true });
  });
  const root = path.join(top, 'root');
  const A = path.join(root, 'a.json'), X = path.join(top, 'x.json'), file = path.join(root, 'k.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(A, 'bytes of A\n'); fs.writeFileSync(X, 'bytes of X\n');
  try { fs.symlinkSync(A, file, 'file'); } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return t.skip('this account cannot make a file symlink');
    throw e;
  }
  const retarget = (to) => { fs.unlinkSync(file); fs.symlinkSync(to, file, 'file'); };
  const o = readWithSeams(file, root, { R5: () => retarget(X), afterOpen: () => retarget(A), ID: () => retarget(X) });
  assert.equal(said(o), 'refused why=changed', 'the outside file the link pointed at during the open is never read');
});
test('T-29nj-1-CW leg 6 inode-0: on a volume with no inode ids, a handle and a checked entry that differ in size are refused', (t) => {
  const f = linkFixture(t, 'ino0');
  if (!f) return;
  fs.writeFileSync(path.join(f.D.X, 'k.json'), 'bytes of X, longer than A\n');
  const o = readWithSeams(f.file, f.root, { ino0: true, R5: () => f.point(f.D.X), afterOpen: () => f.point(f.D.A) });
  assert.equal(said(o), 'refused why=changed', 'size and mtime stand in for the missing inode id');
});
test('T-29nj-1-CW leg 6 residual: on an inode-0 volume two different files with the same size and mtime still pass (the named limit of the size-and-mtime fallback)', (t) => {
  const f = linkFixture(t, 'ino0res');
  if (!f) return;
  const a = path.join(f.D.A, 'k.json'), x = path.join(f.D.X, 'k.json');
  const when = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(a, when, when); fs.utimesSync(x, when, when);
  const o = readWithSeams(f.file, f.root, { ino0: true, R5: () => f.point(f.D.X), afterOpen: () => f.point(f.D.A) });
  assert.equal(said(o), 'READ bytes of X', 'the residual: same size, same mtime, no inode id, nothing left to tell them apart');
});
// E1 t401 #3 (29oy fire 947): the inode-0 fallback compared size and mtime only, so a handle on ANOTHER volume with the same size and
// mtime passed. dev is compared too. No link is needed: one plain file, read with every bigint stat at ino 0n and the handle on another
// volume (dev + 1); the entry is the same file, so size and mtime match.
test('E1 t401 #3: on an inode-0 volume, a handle whose dev differs from the checked entry is refused even with the same size and mtime', (t) => {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'cw-t401-dev-')));
  t.after(() => {
    assert.ok(top.startsWith(TMP_ROOT + path.sep), `refusing to remove ${top}: not under ${TMP_ROOT}`);
    fs.rmSync(top, { recursive: true, force: true });
  });
  const root = path.join(top, 'root');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'k.json');
  fs.writeFileSync(file, 'bytes of A\n');
  assert.equal(said(readWithSeams(file, root, { ino0: true })), 'READ bytes of A', 'control: the same dev, size and mtime read');
  assert.equal(said(readWithSeams(file, root, { ino0: true, devX: true })), 'refused why=changed', 'another dev is another file, whatever its size and mtime');
});
