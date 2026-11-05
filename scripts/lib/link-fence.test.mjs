// Reads and appends of a path a repository, a bin record or a journal can name: a log is appended only through a handle that is
// proved to be the entry the path names; a bounded read is proved after its open; a pin read never blocks on a special file.
// Each witness goes red on the source before its fix. Symlink and FIFO legs are capability-gated by a probe and skip visibly.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendIndexRow } from './estate-archive.mjs';
import { repoReadOutcome } from './config-load.mjs';
import { collectStores } from './retier.mjs';

function tmp(prefix) { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }

test('appendIndexRow: a hard link at the index name is refused, and the file it links keeps its bytes', () => {
  const archive = tmp('cwg-idx-hl-');
  const outside = tmp('cwg-idx-out-');
  try {
    const target = path.join(outside, 'elsewhere.txt');
    fs.writeFileSync(target, 'before\n');
    fs.linkSync(target, path.join(archive, 'index.jsonl'));
    assert.strictEqual(appendIndexRow(archive, { sessionId: 'x' }), false, 'the row is refused, not written through the link');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'before\n', 'the linked file is unchanged');
  } finally { clean(archive, outside); }
});

test('appendIndexRow: a plain index still takes the row', () => {
  const archive = tmp('cwg-idx-plain-');
  try {
    assert.strictEqual(appendIndexRow(archive, { sessionId: 'a' }), true);
    assert.strictEqual(appendIndexRow(archive, { sessionId: 'b' }), true);
    const lines = fs.readFileSync(path.join(archive, 'index.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2, 'both rows land in the plain index');
  } finally { clean(archive); }
});

test('appendOwnLog: a new log is created owner-only where the volume keeps modes', async (t) => {
  const dir = tmp('cwg-log-mode-');
  try {
    const probe = path.join(dir, 'probe.bin');
    fs.writeFileSync(probe, 'p');
    fs.chmodSync(probe, 0o600);
    if ((fs.statSync(probe).mode & 0o777) !== 0o600) { t.skip('POSIX modes are not kept on this volume'); return; }
    const { appendOwnLog } = await import('./repo-fs.mjs');
    const log = path.join(dir, 'new.log');
    appendOwnLog(log, 'line\n');
    assert.strictEqual(fs.statSync(log).mode & 0o777, 0o600, 'a new log is owner-only');
  } finally { clean(dir); }
});

// A real swap of the name under an open handle cannot be made on this host: renaming over an open file is EPERM here (probed). So the
// open itself is made to return the handle of an entry OUTSIDE the root, while the path still names the inside file. The identity
// check must refuse that: the handle is not the entry the path names, and the outside bytes must never come back.
test('repoReadOutcome: a handle that is not the entry the path names is refused, and no bytes come back', (t) => {
  const root = tmp('cwg-swap-root-');
  const outside = tmp('cwg-swap-out-');
  try {
    const inside = path.join(root, 'doc.md');
    fs.writeFileSync(inside, 'inside bytes\n');
    const outsideFile = path.join(outside, 'doc.md');
    fs.writeFileSync(outsideFile, 'OUTSIDE BYTES\n');
    const realOpen = fs.openSync;
    t.mock.method(fs, 'openSync', (p, flags, mode) => {
      if (path.resolve(String(p)) === path.resolve(inside)) return realOpen(outsideFile, flags, mode);
      return realOpen(p, flags, mode);
    });
    const o = repoReadOutcome(inside, root, 1024);
    assert.ok(!o.buf, 'no bytes come back for a handle the path does not name');
    assert.strictEqual(o.why, 'changed');
  } finally { clean(root, outside); }
});

test('repoReadOutcome: a plain in-root file still reads whole', () => {
  const root = tmp('cwg-plain-root-');
  try {
    const f = path.join(root, 'doc.md');
    fs.writeFileSync(f, 'hello\n');
    assert.strictEqual(repoReadOutcome(f, root, 1024).buf.toString('utf8'), 'hello\n');
  } finally { clean(root); }
});

test('pinVerdict: a directory at the pin path reaches the fail-closed branch', async () => {
  const dir = tmp('cwg-pin-dir-');
  try {
    const { pinVerdict } = await import('./apply.mjs');
    const v = pinVerdict(dir);
    assert.strictEqual(v.pinned, true, 'an unreadable pin is treated as pinned (fail-closed)');
    assert.ok(v.why, 'the refusal names its reason');
  } finally { clean(dir); }
});

test('pinVerdict: a FIFO at the pin path returns at once, fail-closed', async (t) => {
  const dir = tmp('cwg-pin-fifo-');
  try {
    const fifo = path.join(dir, 'MEMORY.md');
    const made = spawnSync('mkfifo', [fifo], { timeout: 10000 });
    const isFifo = made.status === 0 && fs.existsSync(fifo) && fs.lstatSync(fifo).isFIFO();
    if (!isFifo) { t.skip('no real FIFO can be made on this host, so a FIFO pin path cannot be made here'); return; }
    const { pinVerdict } = await import('./apply.mjs');
    const v = pinVerdict(fifo);
    assert.strictEqual(v.pinned, true, 'a special file is not read as an unpinned file');
  } finally { clean(dir); }
});

test('collectStores: a linked role folder (directory junction) is not admitted, and nothing in it is rewritten', (t) => {
  const proj = tmp('cwg-junc-proj-');
  const home = tmp('cwg-junc-home-');
  try {
    const real = path.join(proj, '.claude', 'agent-memory', 'role-real');
    fs.mkdirSync(real, { recursive: true });
    const indexFile = path.join(real, 'MEMORY.md');
    fs.writeFileSync(indexFile, '# index\n');
    const alias = path.join(proj, '.claude', 'agent-memory', 'role-alias');
    try { fs.symlinkSync(real, alias, 'junction'); } catch (e) {
      if (e && ['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) { t.skip('no directory junction can be made on this host'); return; }
      throw e;
    }
    const stores = collectStores({ projectRoot: proj, home });
    assert.ok(!stores.some((s) => s.label === 'agent:role-alias'), 'a linked role folder is not admitted: ' + stores.map((s) => s.label).join(','));
    assert.strictEqual(fs.readFileSync(indexFile, 'utf8'), '# index\n', 'nothing in the linked folder is rewritten');
  } finally { clean(proj, home); }
});

test('collectStores: an index slot that links to a non-index file in the store is skipped with a named reason', (t) => {
  const proj = tmp('cwg-slot-proj-');
  const home = tmp('cwg-slot-home-');
  try {
    const dir = path.join(proj, '.claude', 'agent-memory', 'role-slot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'topic.md'), '# topic\n');
    try { fs.symlinkSync(path.join(dir, 'topic.md'), path.join(dir, 'MEMORY.md'), 'file'); } catch (e) {
      if (e && ['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) { t.skip('no file symlinks on this host, so a linked index slot cannot be made here'); return; }
      throw e;
    }
    const stores = collectStores({ projectRoot: proj, home });
    assert.ok(!stores.some((s) => s.label === 'agent:role-slot'), 'a slot that resolves to a non-index file is not admitted');
    assert.ok(stores.skipped && stores.skipped.some((s) => s.label === 'agent:role-slot' && s.reason), 'the skip names its reason');
  } finally { clean(proj, home); }
});

// 29bs fire 595 F592-5: Windows creates an entry at a dangling link's target through O_CREAT, so the log name is looked at first.
test('appendIndexRow: a dangling junction at the index name is refused and nothing appears at its target', (t) => {
  const archive = tmp('cwg-idx-dj-');
  const outside = tmp('cwg-idx-djo-');
  try {
    const target = path.join(outside, 'nowhere');
    try { fs.symlinkSync(target, path.join(archive, 'index.jsonl'), 'junction'); } catch (e) {
      if (e && ['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) { t.skip('no link can be made on this host'); return; }
      throw e;
    }
    assert.strictEqual(appendIndexRow(archive, { sessionId: 'x' }), false);
    assert.ok(!fs.existsSync(target), 'nothing appears at the link target');
  } finally { clean(archive, outside); }
});
