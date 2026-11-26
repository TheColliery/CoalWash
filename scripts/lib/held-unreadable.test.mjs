// 29qh fire 974 (round 6, F2, lab 1202 F2): an entry that EXISTS, is no link, and whose own real path cannot be taken is NAMED, never
// dropped. Ported from the lab's f1-leg.mjs and deny-leg.mjs (scratchpad/cw-lab-1202), and the reviewer's w-973.mjs (row 16). The deny is
// REAL, never a thrown error: on Windows `icacls <file> /deny <user>:(R)`, which makes realpathSync.native throw EPERM before any open (the
// room's t338 test throws only from openSync, so the real path still resolved there and that test stayed green on the regression). On
// POSIX the file is chmod 000: the real path still resolves there, so the leg checks the same named result by another route. A leg whose
// deny cannot be made (no icacls, root on POSIX, an ACL that does not bite) skips VISIBLY by name; one skippable leg per test. Every
// sandbox lifts its own denies before it removes its own temp root.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEstate, restoreSession, resolveArchiveDir } from './estate-archive.mjs';
import { ccProjectSlug, heldPath } from './class-b.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
const DAY = 86400000;
const LATER = 31 * 60 * 1000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'scripts', 'lib', 'cli.mjs');
const TEMP = fs.realpathSync.native(os.tmpdir());
const PREFIX = 'cw-unread-974-';
const USER = os.userInfo().username;
const WIN = process.platform === 'win32';
const SID = 'a9749749-7497-4974-8974-974974974974';
const SID2 = 'b9749749-7497-4974-8974-974974974974';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const line = (i, text) => JSON.stringify({ type: i % 2 ? 'assistant' : 'user', timestamp: `2026-09-01T10:0${i}:00Z`, message: { role: i % 2 ? 'assistant' : 'user', content: text } });
const body = (tag, n) => Array.from({ length: n }, (_, i) => line(i, `${tag} payload ${i} `.repeat(4))).join('\n') + '\n';
const icacls = (...a) => spawnSync('icacls', a, { encoding: 'utf8', timeout: 30000, windowsHide: true });

function sandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, PREFIX)));
  if (path.dirname(root) !== TEMP || !path.basename(root).startsWith(PREFIX)) throw new Error(`sandbox root ${root} is not a ${PREFIX} folder inside ${TEMP}`);
  const denied = [];
  const lift = () => {
    for (const p of denied.splice(0)) {
      if (WIN) icacls(p, '/remove:d', USER);
      else { try { fs.chmodSync(p, 0o600); } catch { /* gone */ } }
    }
  };
  t.after(() => {
    lift(); // the deny goes before the folder is removed
    if (path.dirname(root) !== TEMP || !path.basename(root).startsWith(PREFIX)) throw new Error(`refusing to remove ${root}`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# fixture\n');
  const projDir = path.join(home, '.claude', 'projects', ccProjectSlug(proj));
  fs.mkdirSync(projDir, { recursive: true });
  const archiveDir = resolveArchiveDir({}, home);
  return { root, home, proj, projDir, archiveDir, slugArch: path.join(archiveDir, ccProjectSlug(proj)), out: path.join(root, 'out'), denied, lift };
}
function put(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  const at = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(p, at, at);
}
const run = (s, now = Date.now()) => runEstate({ projectRoot: s.proj, home: s.home, estate: {}, now });
// A REAL read deny on `p`. Returns null when it holds, else the reason it cannot be made here (the caller skips by that name).
function denyRead(s, p) {
  if (WIN) {
    const r = icacls(p, '/deny', `${USER}:(R)`);
    if (r.error || r.status !== 0) return `icacls /deny did not run on this box (${r.error ? r.error.code : `exit ${r.status}`})`;
    s.denied.push(p);
    try { fs.realpathSync.native(p); return 'a deny-read ACE does not stop realpathSync.native on this volume'; } catch { /* the deny bites */ }
    return null;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'running as root: chmod 000 does not stop a read';
  fs.chmodSync(p, 0o000);
  s.denied.push(p);
  try { fs.closeSync(fs.openSync(p, 'r')); return 'chmod 000 does not stop an open on this volume'; } catch { /* the deny bites */ }
  return null;
}
const skipName = (why) => `NO REAL DENY: ${why}`;

test('F2 row 11 (f1-leg): the CLI names an archive the index repair cannot open, archives the other session, exits 1, loses nothing; after lifting exits 0', (t) => {
  const s = sandbox(t);
  put(path.join(s.projDir, `${SID}.jsonl`), body('alpha', 60));
  const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, TEMP: path.join(s.root, 'tmp'), TMP: path.join(s.root, 'tmp'), TMPDIR: path.join(s.root, 'tmp'), NODE_OPTIONS: '--max-old-space-size=512' };
  delete env.CLAUDE_CONFIG_DIR;
  const cli = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: s.proj, env, encoding: 'utf8', timeout: 110000, killSignal: 'SIGKILL', windowsHide: true }); return { code: r.status, all: `${r.stdout || ''}\n${r.stderr || ''}` }; };
  assert.strictEqual(cli('estate-run').code, 0, 'the first run archives the first session');
  const gz = path.join(s.slugArch, `${SID}.jsonl.gz`);
  const before = sha(gz);
  put(path.join(s.projDir, `${SID2}.jsonl`), body('bravo', 50));
  const why = denyRead(s, gz);
  if (why) { t.skip(skipName(why)); return; }
  const r1 = cli('estate-run');
  s.lift();
  assert.strictEqual(r1.code, 1, `the run with a denied archive exits 1: ${r1.all}`);
  assert.ok(r1.all.includes(gz) && /could not be opened/.test(r1.all), `the denied archive is named in words: ${r1.all}`);
  assert.ok(!fs.existsSync(path.join(s.projDir, `${SID2}.jsonl`)), 'the other session was archived');
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(path.join(s.slugArch, `${SID2}.jsonl.gz`))).toString('utf8'), body('bravo', 50), "the other session's copy is whole");
  assert.strictEqual(sha(gz), before, 'the denied archive is untouched');
  assert.strictEqual(cli('estate-run').code, 0, 'after the deny is lifted the next run exits 0');
});

test('F2 row 11 (deny-leg IDX): runEstate counts the index repair it could not do and names the denied archive in failed', (t) => {
  const s = sandbox(t);
  put(path.join(s.projDir, `${SID}.jsonl`), body('idx', 6));
  assert.strictEqual(run(s).archived.length, 1);
  const gz = path.join(s.slugArch, `${SID}.jsonl.gz`);
  put(path.join(s.projDir, `${SID2}.jsonl`), body('idx2', 6));
  const why = denyRead(s, gz);
  if (why) { t.skip(skipName(why)); return; }
  const r = run(s, Date.now() + LATER);
  s.lift();
  assert.deepStrictEqual(r.archived.map((a) => a.id), [SID2], `the other session still archives: ${JSON.stringify(r)}`);
  assert.strictEqual(r.indexRepairFailed, 1, `the failed repair is counted: ${JSON.stringify(r)}`);
  const said = r.failed.filter((f) => f.id === SID).map((f) => f.reason).join(' | ');
  assert.ok(said.includes(gz) && /could not be opened \((EPERM|EACCES)\)/.test(said), `the denied archive is named: ${said}`);
  assert.ok(fs.existsSync(gz), 'the archive is kept');
});

test('F2 row 17 (deny-leg RST): restore of a session whose archived copy cannot be read says it failed on that file, never "not found"', (t) => {
  const s = sandbox(t);
  put(path.join(s.projDir, `${SID}.jsonl`), body('rst', 6));
  assert.strictEqual(run(s).archived.length, 1);
  const gz = path.join(s.slugArch, `${SID}.jsonl.gz`);
  const why = denyRead(s, gz);
  if (why) { t.skip(skipName(why)); return; }
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to: path.join(s.out, 'x') });
  s.lift();
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(String(r.error), /not found/, `the archive is there; the restore never says it is not: ${r.error}`);
  assert.match(String(r.error), new RegExp(`restore failed on ${SID}\\.jsonl: .*(EPERM|EACCES)`), `the denied copy is named with its code: ${r.error}`);
  assert.ok(fs.existsSync(gz), 'the archive is kept');
});

test('F2 row 16 (w-973 SRC): a restore whose <sid>/ copy cannot be read is never ok and names that copy', (t) => {
  const s = sandbox(t);
  put(path.join(s.projDir, `${SID}.jsonl`), body('src', 6));
  put(path.join(s.projDir, SID, 'subagents', 'agent-zq974.jsonl'), body('sub', 4));
  assert.strictEqual(run(s).archived.length, 1);
  const sub = path.join(s.slugArch, SID, 'subagents', 'agent-zq974.jsonl.gz');
  assert.ok(fs.existsSync(sub), 'the <sid>/ copy was archived');
  const why = denyRead(s, sub);
  if (why) { t.skip(skipName(why)); return; }
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to: path.join(s.out, 'x') });
  s.lift();
  assert.strictEqual(r.ok, false, `a restore that leaves a file out is never a success: ${JSON.stringify(r)}`);
  assert.match(String(r.error), /restore failed on .*agent-zq974\.jsonl: .*(EPERM|EACCES)/, `the denied copy is named: ${r.error}`);
});

// Row 12 (sessionGenerations): a session with a kept generation 1 of its transcript and of a <sid>/ subagent file.
function withGeneration(s) {
  const live = path.join(s.projDir, `${SID}.jsonl`);
  const sub = path.join(s.projDir, SID, 'subagents', 'agent-g974.jsonl');
  put(live, body('v1', 3)); put(sub, body('sub-v1', 3));
  assert.strictEqual(run(s).archived.length, 1);
  assert.ok(restoreSession(SID, { archiveDir: s.archiveDir, to: s.projDir }).ok, 'the session goes back to the live tree');
  put(live, body('v2', 3)); put(sub, body('sub-v2', 3));
  assert.strictEqual(run(s, Date.now() + LATER).archived.length, 1, 'the second archive keeps generation 1');
  const top = path.join(s.slugArch, `${SID}.jsonl.gz.gen1`);
  const subGen = path.join(s.slugArch, SID, 'subagents', 'agent-g974.jsonl.gz.gen1');
  assert.ok(fs.existsSync(top) && fs.existsSync(subGen), 'both copies are kept as generation 1');
  return { top, subGen };
}

test('F2 row 12 (:1036): a --generation restore whose kept transcript copy cannot be read is never ok and names that copy', (t) => {
  const s = sandbox(t);
  const { top } = withGeneration(s);
  const why = denyRead(s, top);
  if (why) { t.skip(skipName(why)); return; }
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to: path.join(s.out, 'g'), generation: 1 });
  s.lift();
  assert.strictEqual(r.ok, false, `a restore that leaves the transcript out is never a success: ${JSON.stringify(r)}`);
  assert.match(String(r.error), new RegExp(`restore failed on ${SID}\\.jsonl: .*(EPERM|EACCES)`), `the denied copy is named: ${r.error}`);
});

test('F2 row 12 (:1045): a --generation restore whose kept <sid>/ copy cannot be read is never ok and names that copy', (t) => {
  const s = sandbox(t);
  const { subGen } = withGeneration(s);
  const why = denyRead(s, subGen);
  if (why) { t.skip(skipName(why)); return; }
  const r = restoreSession(SID, { archiveDir: s.archiveDir, to: path.join(s.out, 'g'), generation: 1 });
  s.lift();
  assert.strictEqual(r.ok, false, `a restore that leaves the <sid>/ copy out is never a success: ${JSON.stringify(r)}`);
  assert.match(String(r.error), /restore failed on .*agent-g974\.jsonl: .*(EPERM|EACCES)/, `the denied copy is named: ${r.error}`);
});

test('F2 heldPath: the third answer names an unreadable entry inside the held folder; the default answer is unchanged', (t) => {
  const s = sandbox(t);
  const rootPhys = fs.realpathSync.native(s.root);
  const inside = path.join(s.root, 'held', 'denied.txt');
  const outsideFile = path.join(s.root, 'other', 'denied.txt');
  for (const p of [inside, outsideFile]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x\n'); }
  const why = WIN ? (denyRead(s, inside) || denyRead(s, outsideFile)) : 'on POSIX a read deny leaves the real path resolvable, so there is no third answer to give';
  if (why) { t.skip(skipName(why)); return; }
  const third = heldPath(rootPhys, ['held'], inside, null, { unreadable: true });
  assert.deepStrictEqual(third, { unreadable: 'EPERM' }, `an entry that exists, is no link, and cannot be resolved is named: ${JSON.stringify(third)}`);
  assert.strictEqual(heldPath(rootPhys, ['held'], inside), null, 'the default answer stays the refusal (the 43 silent sites keep theirs)');
  assert.strictEqual(heldPath(rootPhys, ['held'], outsideFile, null, { unreadable: true }), null, 'an unreadable entry OUTSIDE the held folder is still refused');
  assert.strictEqual(heldPath(rootPhys, ['held'], path.join(s.root, 'held', 'missing.txt'), null, { unreadable: true }), path.join(rootPhys, 'held', 'missing.txt'), 'a path not made yet is answered as before');
});

test('F2 heldPath: the third answer is never given to a link, even with the option', (t) => {
  const s = sandbox(t);
  const rootPhys = fs.realpathSync.native(s.root);
  const target = path.join(s.root, 'elsewhere');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.join(s.root, 'held'), { recursive: true });
  const link = path.join(s.root, 'held', 'link');
  try { fs.symlinkSync(target, link, WIN ? 'junction' : 'dir'); } catch (e) { t.skip(`NO LINK: a directory link cannot be made here (${e.code})`); return; }
  assert.strictEqual(heldPath(rootPhys, ['held'], link, null, { unreadable: true }), null, 'a link out of the held folder is refused');
  assert.strictEqual(heldPath(rootPhys, ['held'], path.join(link, 'f.txt'), null, { unreadable: true }), null, 'a path through that link is refused');
  // A DANGLING link inside the held folder: it exists to lstat and its real path throws, as an unreadable entry's does; it is a link, so
  // it never gets the third answer.
  const gone = path.join(s.root, 'gone');
  fs.mkdirSync(gone);
  const dangling = path.join(s.root, 'held', 'dangling');
  fs.symlinkSync(gone, dangling, WIN ? 'junction' : 'dir');
  fs.rmdirSync(gone);
  let resolves = true; try { fs.realpathSync.native(dangling); } catch { resolves = false; }
  assert.strictEqual(resolves, false, 'the fixture: the dangling link does not resolve');
  assert.strictEqual(heldPath(rootPhys, ['held'], dangling, null, { unreadable: true }), null, 'a dangling link is refused, never named unreadable');
});
