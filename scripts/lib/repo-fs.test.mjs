// CWK-137 -- containment regression tests: bounded reads and contained writes on
// repo-derived paths (mirrors CoalMine's scripts/lib/repo-fs.test.mjs in structure).
// Zero-dep (node:test + built-ins), per scripts-quality.md section 2.
//
// Every fixture lives in ONE sandbox under os.tmpdir(): a `project/` tree and an
// `outside/` directory beside it holding a `keep.txt` canary. The assertion is always
// the same shape: the function under test returns its refusal, and `outside/keep.txt`
// survives byte-identical.
//
// Link shapes are PROBED, never assumed: a directory link is a junction on Windows (no
// privilege needed; Node reports it as a symbolic link) and a symlink elsewhere. A
// file symlink, a FIFO and a device exist only where the platform allows; those legs
// probe and skip VISIBLY, one skippable leg per test -- CI's ubuntu/macOS legs are
// where they run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MAX_CONFIG_BYTES, MAX_DOC_BYTES, repoEntryKind, repoReadOutcome, readRepoFileBounded, readRepoBytesBounded, loadMergedConfig,
} from './config-load.mjs';
import { ownSandboxDir, RepoWriteRefused } from './repo-fs.mjs';
import { sweepWriteguard, snapshotOnFirstWrite } from './writeguard.mjs';
import { recordBinItem, restoreFromBin, sweepFatBin, readDeathLog, FAT_BIN_NAME } from './tailings.mjs';
import { acquireLock, applyPlan, sweepSnapshots, LOCK_STALE_MS } from './apply.mjs';
import { chJournalGuard, readRosterSids } from './estate-archive.mjs';
import { HORIZON_MS } from './retention.mjs';
import { restore } from './cli.mjs';
import { recordKeep } from './keeps.mjs';
import { discoverClassB } from './class-b.mjs';

const TMP_ROOT = fs.realpathSync.native(os.tmpdir());
const KEEP = 'keep me\n';

// The sandbox, removed by a registered t.after. The removal asserts its own target is
// under the resolved temp root first -- the shell rail's delete guard, in code.
function sandbox(t, label) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, `cw-repofs-${label}-`)));
  t.after(() => {
    assert.ok(dir.startsWith(TMP_ROOT + path.sep), `refusing to remove ${dir}: not under ${TMP_ROOT}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = path.join(dir, 'project');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), KEEP);
  return { dir, project, outside, keep: path.join(outside, 'keep.txt') };
}

// A directory link, or null when this volume cannot make one (the caller skips).
function dirLink(target, at) {
  try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}

test('a regular file is read; over the bound it is REFUSED with its reason, never truncated; prefixOnly samples it', (t) => {
  const { project } = sandbox(t, 'read');
  const f = path.join(project, 'a.json');
  fs.writeFileSync(f, '0123456789');
  assert.equal(readRepoFileBounded(f, project, 64), '0123456789');
  assert.equal(readRepoFileBounded(f, project, 5), null, 'over the bound -> null, not the first 5 bytes');
  assert.equal(repoReadOutcome(f, project, 5).why, 'over-bound');
  assert.equal(readRepoFileBounded(f, project, 4, true), '0123', 'prefixOnly -> the first maxBytes');
  assert.equal(repoReadOutcome(path.join(project, 'absent'), project, 64).why, 'absent');
  assert.equal(repoReadOutcome(project, project, 64).why, 'directory', 'a directory is never read');
  assert.deepEqual(readRepoBytesBounded(f, project, 64), Buffer.from('0123456789'));
  assert.ok(MAX_CONFIG_BYTES > 0 && MAX_DOC_BYTES > MAX_CONFIG_BYTES);
});

test('a read through a directory link that ESCAPES the project is refused; a link that stays inside is allowed', (t) => {
  const { project, outside } = sandbox(t, 'contain');
  fs.mkdirSync(path.join(project, 'real'));
  fs.writeFileSync(path.join(project, 'real', 'doc.md'), 'INSIDE');
  if (!dirLink(outside, path.join(project, 'linked-out')) || !dirLink(path.join(project, 'real'), path.join(project, 'linked-in'))) {
    t.skip('this volume cannot make a directory link');
    return;
  }
  assert.equal(repoEntryKind(path.join(project, 'linked-out'), project), null, 'the escaping link itself is refused');
  assert.equal(repoReadOutcome(path.join(project, 'linked-out', 'keep.txt'), project, 64).why, 'outside-root');
  assert.equal(readRepoFileBounded(path.join(project, 'linked-in', 'doc.md'), project, 64), 'INSIDE', 'a contained link is not refused');
  assert.equal(readRepoFileBounded(path.join(project, 'linked-out', 'keep.txt'), null, 64), KEEP, 'root null = no containment (the user\'s own files)');
});

test('ownSandboxDir returns the path through real (or not-yet-made) directories and REFUSES any link on the chain', (t) => {
  const { project, outside } = sandbox(t, 'chain');
  const want = path.join(project, '.claude', 'coalwash', 'writeguard');
  assert.equal(ownSandboxDir(project, '.claude', 'coalwash', 'writeguard'), want, 'nothing exists yet: the path, unrefused');
  fs.mkdirSync(path.join(project, '.claude'));
  if (!dirLink(outside, path.join(project, '.claude', 'coalwash'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.throws(() => ownSandboxDir(project, '.claude', 'coalwash', 'writeguard'), RepoWriteRefused, 'a link on the chain is refused');
  assert.throws(() => ownSandboxDir(project, '..', 'outside'), RepoWriteRefused, 'a segment is a plain name, never a traversal');
});

test('the SessionStart write-guard sweep never deletes through a linked sandbox directory', (t) => {
  const { project, outside, keep } = sandbox(t, 'sweep');
  fs.mkdirSync(path.join(project, '.claude', 'coalwash'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'older-session'));
  fs.writeFileSync(path.join(outside, 'older-session', 'keep.txt'), KEEP);
  if (!dirLink(outside, path.join(project, '.claude', 'coalwash', 'writeguard'))) { t.skip('this volume cannot make a directory link'); return; }
  sweepWriteguard(project, 'current-session', { home: path.join(project, 'home') });
  assert.equal(fs.readFileSync(keep, 'utf8'), KEEP, 'outside/keep.txt survives');
  assert.equal(fs.readFileSync(path.join(outside, 'older-session', 'keep.txt'), 'utf8'), KEEP, 'so does every directory beside it');
});

test('an unresolvable ROOT is reported as its own reason, never as the path escaping it', (t) => {
  const { project } = sandbox(t, 'rootreason');
  const f = path.join(project, 'a.json');
  fs.writeFileSync(f, '{}');
  const gone = path.join(project, 'no-such-root');
  assert.equal(repoReadOutcome(f, gone, 64).why, 'root-unresolvable');
  assert.equal(readRepoFileBounded(f, gone, 64), null, 'still refused: a root we cannot resolve contains nothing');
});

test('a failed re-read of a fresh snapshot leaves NO identity sidecar -- never the digest of an empty buffer', (t) => {
  const { dir, project } = sandbox(t, 'sidecar');
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(project, 'MEMORY.md'), ['# notes', 'some content', ''].join('\n'));
  const realOpen = fs.openSync;
  // Only the READ of the SNAPSHOT blob (its name carries the "MEMORY.md--<digest>" marker) is refused. A
  // write-mode open of the same name must go through: an earlier draft refused every open of that name, which
  // killed the snapshot WRITE first, so the test returned null before the re-read it claims to pin (red-first
  // against a mutant that records an empty-buffer digest stayed GREEN -- fire 4, row M11b).
  let refusedReads = 0;
  fs.openSync = (p, flags, ...rest) => {
    const reading = typeof flags === 'number' ? (flags & 3) === 0 : flags === 'r';
    if (reading && String(p).includes('MEMORY.md--') && !String(p).endsWith('.origpath')) { refusedReads += 1; throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' }); }
    return realOpen(p, flags, ...rest);
  };
  t.after(() => { fs.openSync = realOpen; });
  const snap = snapshotOnFirstWrite(project, 'sess', path.join(project, 'MEMORY.md'), { home: path.join(dir, 'home') });
  assert.equal(snap, null, 'no snapshot is claimed when it cannot be verified');
  assert.equal(refusedReads > 0, true, 'the re-read of the snapshot WAS attempted and refused (the write got that far)');
  const sessionDir = path.join(project, '.claude', 'coalwash', 'writeguard', 'sess');
  const sidecars = fs.readdirSync(sessionDir).filter((n) => n.endsWith('.origpath'));
  assert.deepEqual(sidecars, [], 'no sidecar attests a digest for a blob nobody could read back');
});

test('a bin item over the read bound is refused BY NAME at the restore door, never reported as absent', (t) => {
  const { dir, project } = sandbox(t, 'binbound');
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(path.join(project, '.git'));
  const home = path.join(dir, 'home');
  const id = recordBinItem(project, FAT_BIN_NAME, { content: Buffer.alloc(MAX_DOC_BYTES + 1, 97), original: 'big.md' });
  assert.ok(id, 'the oversize item was banked');
  // Boolean-only: an assertion's `actual` is serialised by assert AND by the test reporter, and a
  // 4 MiB Buffer there costs tens of GB (measured in fire 4: a 64 KiB Buffer diff = 22.9 GB of
  // external memory, which no heap cap bounds). No large value is ever an assertion operand.
  assert.equal(restoreFromBin(project, FAT_BIN_NAME, id) === null, true, 'the bytes are not handed back');
  // Field-by-field, never deepEqual of the whole result: on a regression `content` is a 4 MiB
  // Buffer, and assert's diff of it costs gigabytes and minutes (measured by the first
  // mutation run, which had to be killed at 16 GB).
  const r = restore({ id, cwd: project, home });
  assert.equal(r.found, false);
  assert.equal(r.refused && r.refused.bin, FAT_BIN_NAME);
  assert.equal(r.refused && r.refused.why, 'over-bound');
  const miss = restore({ id: 'no-such-item', cwd: project, home });
  assert.equal(miss.found, false, 'an ordinary miss is still just a miss');
  assert.equal(miss.refused, undefined);
});

test('a project config reached through a link that leaves the project is NOT merged into the effective config', (t) => {
  const { dir, project, outside } = sandbox(t, 'cfgmerge');
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# fixture\n');
  fs.writeFileSync(path.join(outside, 'coalwash.json'), JSON.stringify({ fileMaxSizeKb: 99 }));
  fs.mkdirSync(path.join(project, '.claude'));
  if (!dirLink(outside, path.join(project, '.claude', 'coal'))) { t.skip('this volume cannot make a directory link'); return; }
  const cfg = loadMergedConfig({ cwd: project, home: path.join(dir, 'home') });
  assert.notEqual(cfg.fileMaxSizeKb, 99, 'the outside file must not supply a setting');
});

// The FIFO leg exists only on POSIX: it probes mkfifo and SKIPS VISIBLY here (win32).
// CI's ubuntu/macOS legs are its venue -- it is NOT proven on this box.
test('a FIFO in the config position is refused as not-regular, without a read (POSIX)', (t) => {
  const { project } = sandbox(t, 'fifo');
  const fifo = path.join(project, 'AGENTS.md');
  if (process.platform === 'win32' || spawnSync('mkfifo', [fifo]).status !== 0) { t.skip('no mkfifo on this platform'); return; }
  assert.equal(repoReadOutcome(fifo, project, MAX_DOC_BYTES).why, 'not-regular');
  assert.equal(readRepoFileBounded(fifo, null, MAX_DOC_BYTES), null, 'refused even with no containment');
});

// The three writers that keep state under `<project>/.claude/coalwash/` each refuse a
// linked sandbox directory: the outside directory keeps exactly its one file.
function linkedSandbox(t, label) {
  const sb = sandbox(t, label);
  fs.mkdirSync(path.join(sb.project, '.claude'));
  if (!dirLink(sb.outside, path.join(sb.project, '.claude', 'coalwash'))) { t.skip('this volume cannot make a directory link'); return null; }
  return sb;
}

test('the bin writer refuses a linked sandbox directory, and nothing lands outside', (t) => {
  const sb = linkedSandbox(t, 'binlink');
  if (!sb) return;
  const id = recordBinItem(sb.project, FAT_BIN_NAME, { content: 'cut text', original: 'a.md' });
  assert.equal(id, null, 'the bin refuses to bank through a link');
  assert.deepEqual(fs.readdirSync(sb.outside), ['keep.txt']);
  assert.equal(fs.readFileSync(sb.keep, 'utf8'), KEEP);
});

test('the keeps writer refuses a linked sandbox directory, and nothing lands outside', (t) => {
  const sb = linkedSandbox(t, 'keeplink');
  if (!sb) return;
  const r = recordKeep(sb.project, { target: 'a.md', reason: 'test' });
  assert.equal(r.ok, false, 'the keep is not recorded through a link');
  assert.deepEqual(fs.readdirSync(sb.outside), ['keep.txt']);
});

test('a project rules tree that is a link out of the project is named as refused, not walked', (t) => {
  const { dir, project, outside } = sandbox(t, 'ruleslink');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'rule.md'), '# a rule\n');
  fs.mkdirSync(path.join(project, '.claude'));
  if (!dirLink(outside, path.join(project, '.claude', 'rules'))) { t.skip('this volume cannot make a directory link'); return; }
  const disc = discoverClassB({ projectRoot: project, home });
  assert.ok(disc.flags.some((f) => /refused path \(rules tree, scope project\)/.test(f)), `flags: ${JSON.stringify(disc.flags)}`);
  assert.ok(!disc.entries.some((e) => e.path.endsWith('rule.md')), 'nothing under the link is measured');
});

test('a project agent-memory root that is a link out of the project is named as refused -- no directory behind it becomes a role', (t) => {
  const { dir, project, outside } = sandbox(t, 'agentlink');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'stranger-role'));
  fs.writeFileSync(path.join(outside, 'stranger-role', 'MEMORY.md'), '# not ours\n');
  fs.mkdirSync(path.join(project, '.claude'));
  if (!dirLink(outside, path.join(project, '.claude', 'agent-memory'))) { t.skip('this volume cannot make a directory link'); return; }
  const disc = discoverClassB({ projectRoot: project, home });
  assert.ok(disc.flags.some((f) => /refused path \(role stores\)/.test(f)), `flags: ${JSON.stringify(disc.flags)}`);
  assert.ok(!disc.entries.some((e) => /stranger-role/.test(e.path)), 'no directory behind the link is measured as a role store');
});

// ---- fire 5: the write-side layers no earlier test reached (lock takeover, death log, edit-time airbag) ----------
// A FILE symlink needs a privilege some volumes do not grant (Windows without developer mode); probed, never assumed.
function fileLink(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return true; } catch { return false; }
}

// Fake what an open handle's fstat reports (`patch(stats)` mutates it): a link or a special file that appeared
// AFTER the path check is a race that cannot be produced deterministically on a real filesystem, and the fd
// re-check exists for exactly that window. Only handles opened by `match(path, flags)` are touched. The caller
// restores before asserting.
function fakeHandleStat(t, match, patch) {
  const realOpen = fs.openSync;
  const realFstat = fs.fstatSync;
  const fds = new Set();
  fs.openSync = (p, flags, ...rest) => {
    const fd = realOpen(p, flags, ...rest);
    if (match(String(p), flags)) fds.add(fd);
    return fd;
  };
  fs.fstatSync = (fd, ...rest) => {
    const s = realFstat(fd, ...rest);
    if (fds.has(fd)) patch(s);
    return s;
  };
  const restore = () => { fs.openSync = realOpen; fs.fstatSync = realFstat; };
  t.after(restore);
  return restore;
}

const OLD_ENOUGH = 2 * LOCK_STALE_MS; // added to `now`: every lock then reads as stale, whatever its real mtime

test('CWK-137: a stale lock that is a second name (hard link) for another file is refused BY NAME, and that file is untouched', (t) => {
  const { project, keep } = sandbox(t, 'lockhard');
  const lockPath = path.join(project, '.coalwash.lock');
  try { fs.linkSync(keep, lockPath); } catch { t.skip('this volume cannot make a hard link'); return; }
  const r = acquireLock(lockPath, { sessionId: 'x', now: Date.now() + OLD_ENOUGH });
  assert.equal(r.acquired, false);
  assert.match(String(r.reason), /not a plain file/, `reason: ${r.reason}`);
  assert.equal(fs.readFileSync(keep, 'utf8'), KEEP, 'the other name of the lock is byte-identical');
});

test('CWK-137: the stale-lock takeover re-checks the OPEN HANDLE -- a lock that gained a second name after the path check is not rewritten', (t) => {
  const { project } = sandbox(t, 'lockfd');
  const lockPath = path.join(project, '.coalwash.lock');
  fs.writeFileSync(lockPath, 'OLD LOCK BODY');
  const restore = fakeHandleStat(t, (p, flags) => p === lockPath && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDWR, (s) => { s.nlink = 2; });
  const r = acquireLock(lockPath, { sessionId: 'x', now: Date.now() + OLD_ENOUGH });
  restore();
  assert.equal(r.acquired, false);
  assert.match(String(r.reason), /changed under the takeover/, `reason: ${r.reason}`);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'OLD LOCK BODY', 'the lock file was neither truncated nor rewritten');
});

test('CWK-137: a stale lock that is a symlink to another file is refused, and that file is untouched', (t) => {
  const { project, keep } = sandbox(t, 'locksym');
  const lockPath = path.join(project, '.coalwash.lock');
  if (!fileLink(keep, lockPath)) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it)'); return; }
  const r = acquireLock(lockPath, { sessionId: 'x', now: Date.now() + OLD_ENOUGH });
  assert.equal(r.acquired, false);
  assert.match(String(r.reason), /not a plain file/, `reason: ${r.reason}`);
  assert.equal(fs.readFileSync(keep, 'utf8'), KEEP, 'the symlink target is byte-identical');
});

test('CWK-137: the bounded read re-checks the OPEN HANDLE -- a file that turned out not to be regular after the path check is refused, not read', (t) => {
  const { project } = sandbox(t, 'readfd');
  const f = path.join(project, 'a.json');
  fs.writeFileSync(f, '{"a":1}');
  const restore = fakeHandleStat(t, (p, flags) => p === f && typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY, (s) => { s.isFile = () => false; s.isDirectory = () => false; });
  const r = repoReadOutcome(f, project, 64);
  restore();
  assert.equal(r.why, 'not-regular', `outcome: ${JSON.stringify({ why: r.why, hasBuf: Boolean(r.buf) })}`);
  assert.equal(Boolean(r.buf), false, 'no bytes are handed back for a handle that is not a regular file');
});

// The death log: one destroyed item, then the certificate line. The bin dir is created by a first (recent) item.
function binWithOneOldItem(project, original) {
  const now = Date.now();
  recordBinItem(project, FAT_BIN_NAME, { content: 'recent', original: 'recent.md', now });
  recordBinItem(project, FAT_BIN_NAME, { content: 'old cut', original, now: now - (HORIZON_MS.fat + 86400000) });
  return { now, logPath: path.join(project, '.claude', 'coalwash', FAT_BIN_NAME, 'death.log') };
}

test('CWK-137: a death certificate is ONE line -- a line break inside an index `original` cannot forge a second one (CWE-117)', (t) => {
  const { project } = sandbox(t, 'certline');
  const hostile = 'notes/a.md\n2099-01-01T00:00:00.000Z destroyed FORGED (age 0d, rule horizon) original -';
  const { now } = binWithOneOldItem(project, hostile);
  assert.equal(sweepFatBin(project, { now }).destroyed, 1, 'the old item was destroyed');
  const lines = readDeathLog(project, FAT_BIN_NAME).split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'one destroyed item is one certificate line');
});

test('CWK-137: a death log that is a second name (hard link) for another file is not appended to, and the sweep still destroys the item', (t) => {
  const { project, keep } = sandbox(t, 'loghard');
  const { now, logPath } = binWithOneOldItem(project, 'y.md');
  try { fs.linkSync(keep, logPath); } catch { t.skip('this volume cannot make a hard link'); return; }
  assert.equal(sweepFatBin(project, { now }).destroyed, 1, 'the sweep itself is not blocked by the refused certificate');
  assert.equal(fs.readFileSync(keep, 'utf8'), KEEP, 'the other name of the log is byte-identical');
});

test('CWK-137: the death-log append re-checks the OPEN HANDLE -- a log that gained a second name after the path check is not written', (t) => {
  const { project } = sandbox(t, 'logfd');
  const { now, logPath } = binWithOneOldItem(project, 'y.md');
  fs.writeFileSync(logPath, '');
  const restore = fakeHandleStat(t, (p, flags) => p === logPath && typeof flags === 'number' && (flags & fs.constants.O_APPEND) !== 0, (s) => { s.nlink = 2; });
  const swept = sweepFatBin(project, { now });
  restore();
  assert.equal(swept.destroyed, 1, 'the sweep itself is not blocked by the refused certificate');
  assert.equal(fs.readFileSync(logPath, 'utf8'), '', 'nothing was appended through the handle');
});

test('CWK-137: a death log that is a symlink to another file is not appended to', (t) => {
  const { project, keep } = sandbox(t, 'logsym');
  const { now, logPath } = binWithOneOldItem(project, 'y.md');
  if (!fileLink(keep, logPath)) { t.skip('this volume cannot make a file symlink (CI ubuntu/macOS legs run it)'); return; }
  assert.equal(sweepFatBin(project, { now }).destroyed, 1);
  assert.equal(fs.readFileSync(keep, 'utf8'), KEEP, 'the symlink target is byte-identical');
});

test('CWK-137: the edit-time airbag will not snapshot THROUGH a linked session directory (and does snapshot beside it)', (t) => {
  const { dir, project, outside } = sandbox(t, 'airbag');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, 'MEMORY.md'), 'some notes\n');
  fs.mkdirSync(path.join(project, '.claude', 'coalwash', 'writeguard'), { recursive: true });
  if (!dirLink(outside, path.join(project, '.claude', 'coalwash', 'writeguard', 'linked'))) { t.skip('this volume cannot make a directory link'); return; }
  const refused = snapshotOnFirstWrite(project, 'linked', path.join(project, 'MEMORY.md'), { home });
  assert.equal(refused, null, 'no snapshot is written through the linked session directory');
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], 'nothing landed in the link target');
  const control = snapshotOnFirstWrite(project, 'plain', path.join(project, 'MEMORY.md'), { home });
  assert.equal(typeof control, 'string', 'the same call with an ordinary session directory DOES snapshot (the refusal above was the link)');
});

// ---- item 1b (fire 6): reads of repo-derived files the census found still raw -------------------------------------
// Each test plants the hostile shape INSIDE the project (where a clone puts it) and asserts on a boolean, a count or a
// short list -- never on the planted content. A file over the bound is `MAX_DOC_BYTES + 1` bytes of padding.
function overBoundFile(file, prefix) {
  fs.writeFileSync(file, prefix + 'x'.repeat(MAX_DOC_BYTES + 1));
}

test('CWK-137: the snapshot sweep does not read an over-bound journal -- it freezes and keeps every snapshot', (t) => {
  const { project } = sandbox(t, 'sweepj');
  const txDir = path.join(project, '.claude', 'coalwash');
  for (const n of ['snap-1', 'snap-2', 'snap-3']) fs.mkdirSync(path.join(txDir, n), { recursive: true });
  const journal = path.join(txDir, 'journal.json');
  overBoundFile(journal, '{"version":1,"status":"committed","pad":"');
  fs.appendFileSync(journal, '"}');
  sweepSnapshots(txDir, 1);
  const snaps = () => fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).sort();
  assert.deepEqual(snaps(), ['snap-1', 'snap-2', 'snap-3'], 'an unreadable journal freezes the sweep');
  fs.writeFileSync(journal, '{"version":1,"status":"committed"}');
  sweepSnapshots(txDir, 1);
  assert.deepEqual(snaps(), ['snap-3'], 'control: the same sweep with a readable journal DOES sweep (the freeze above was the bound)');
});

test('CWK-137: the snapshot sweep does not follow a journal that is a link out of the project', (t) => {
  const { project, outside } = sandbox(t, 'sweepl');
  const txDir = path.join(project, '.claude', 'coalwash');
  for (const n of ['snap-1', 'snap-2']) fs.mkdirSync(path.join(txDir, n), { recursive: true });
  if (!dirLink(outside, path.join(txDir, 'journal.json'))) { t.skip('this volume cannot make a directory link'); return; }
  sweepSnapshots(txDir, 1);
  assert.deepEqual(fs.readdirSync(txDir).filter((n) => n.startsWith('snap-')).sort(), ['snap-1', 'snap-2'], 'a journal we cannot read freezes the sweep');
});

test('CWK-137: the dead-link scan skips an over-bound .md instead of reading it whole', (t) => {
  const { dir, project } = sandbox(t, 'deadlink');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const store = path.join(project, 'memory');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'gone-a.md'), 'topic a\n');
  fs.writeFileSync(path.join(store, 'gone-b.md'), 'topic b\n');
  fs.writeFileSync(path.join(store, 'ref.md'), 'see gone-a.md for details\n');
  overBoundFile(path.join(store, 'big.md'), 'see gone-b.md ');
  const plan = {
    projectRoot: project, roots: [store], sessionId: 't-deadlink',
    actions: [{ type: 'delete', path: path.join(store, 'gone-a.md') }, { type: 'delete', path: path.join(store, 'gone-b.md') }],
  };
  const r = applyPlan(plan, { projectRoot: project, home });
  assert.equal(r.ok, true, `apply: ${r.error}`);
  assert.deepEqual([...r.deadLinks].sort(), ['gone-a.md'], 'the small referrer is counted; the over-bound one is not read');
});

test('CWK-137: the CoalHearth journal guard reads a bounded, contained file -- and an unreadable one is UNCERTAIN, never "no session"', (t) => {
  const { project } = sandbox(t, 'chj');
  const NONE = { inProgress: false, mtimeMs: null, sessionId: null };
  assert.deepEqual(chJournalGuard(project), NONE, 'no journal at all');
  const file = path.join(project, '.claude', 'coalhearth', 'session_handoff.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(chJournalGuard(project), NONE, 'garbage content is still "no session" (unchanged)');
  fs.writeFileSync(file, '{"status":"in_progress","sessionId":"abc"}');
  assert.equal(chJournalGuard(project).sessionId, 'abc', 'control: a readable in-progress journal is read');
  overBoundFile(file, '{"status":"in_progress","pad":"');
  fs.appendFileSync(file, '"}');
  const big = chJournalGuard(project);
  assert.equal(big.inProgress, true, 'an over-bound journal is UNCERTAIN, so it protects');
  assert.equal(big.mtimeMs, null, 'and it was not read (no mtime is claimed)');
});

test('CWK-137: the CoalHearth journal guard treats a journal that is a link out of the project as UNCERTAIN', (t) => {
  const { project, outside } = sandbox(t, 'chjl');
  fs.mkdirSync(path.join(project, '.claude', 'coalhearth'), { recursive: true });
  if (!dirLink(outside, path.join(project, '.claude', 'coalhearth', 'session_handoff.json'))) { t.skip('this volume cannot make a directory link'); return; }
  assert.equal(chJournalGuard(project).inProgress, true);
});

test('CWK-137: the roster reader is bounded -- an over-bound roster protects everything (unreachable), an absent one protects nothing', (t) => {
  const { project } = sandbox(t, 'roster');
  const file = path.join(project, '.claude', 'agent-roster.md');
  const SID = '0123abcd-0123-4abc-8def-0123456789ab';
  assert.deepEqual({ n: readRosterSids(project).sids.size, u: readRosterSids(project).unreachable }, { n: 0, u: false }, 'absent');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `| coder | ${SID} |\n`);
  assert.equal(readRosterSids(project).sids.has(SID), true, 'control: a readable roster yields its sids');
  overBoundFile(file, `| coder | ${SID} |\n`);
  assert.equal(readRosterSids(project).unreachable, true, 'over the bound: not read, so everything is protected');
});

test('CWK-137: applyPlan refuses to STAGE a rewrite target over the read bound, and leaves it untouched', (t) => {
  const { dir, project } = sandbox(t, 'stage');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const store = path.join(project, 'memory');
  fs.mkdirSync(store);
  const big = path.join(store, 'big.md');
  fs.writeFileSync(big, 'a'.repeat(MAX_DOC_BYTES + 1));
  const r = applyPlan({ projectRoot: project, roots: [store], sessionId: 't-stage', actions: [{ type: 'rewrite', path: big, content: 'b' }] }, { projectRoot: project, home });
  assert.equal(r.ok, false, 'the plan is refused');
  assert.match(String(r.error), /cannot read .* to stage it/, `error: ${String(r.error).slice(0, 160)}`);
  assert.equal(fs.statSync(big).size, MAX_DOC_BYTES + 1, 'the target is byte-length-identical');
});
