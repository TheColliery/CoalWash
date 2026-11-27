// 29qt fire 989 (round 7, F3 in the class's shape; lab 1203/982, class-988): the case probe (volumeCaseFolds) stat-followed the flipped
// name, so a LINK at that name answered "the folder folds case" with the held folder's own identity, and containedIn / heldPath /
// pathWithin then read a case-variant as inside. Legs, each named by the class-988 leg it ports:
//   (a) P1 direct: containedIn and heldPath with a poison link at the flipped name, on a case-sensitive folder.
//   (b) P2/out: collectStores lists the sibling project's store through pathWithin's PERMIT side (poison present).
//   (c) the Claude-base WRITE route: RE-TIER must leave the other project's MEMORY.md unchanged (lab w-982base).
//   (d) the cache: a poisoned answer is not replayed after the link is removed and the folder swapped.
//   (e) pathWithin's miss: a base with no case to flip takes the caller's polarity (permit: no fold).
//   (f) C4/L1: a link ROOT is refused, never probed through (a regression guard; green before and after).
//   (g) H2: heldPath refuses a name that is `..`, empty, `.` or holds a separator (a regression guard).
//   (h) a link at the flipped name under <proj>/.claude (class-988 §4), on a case-sensitive folder; one link made on every platform.
//   (j) the PERMIT caller on a probe miss: a junction into the case-variant ancestor of a root with no case to flip (round 8, F990-3).
// NOT BUILDABLE HERE, named and not faked (class-988 §2): U1 (an entry gone between physicalForCreate and lstat) and U3 (an entry that
// realpath resolves while physicalOrNull refused its spelling). Each leg makes its folder case-sensitive by fsutil on Windows and
// proves it by the probe itself; a folder that folds skips visibly by name. Temp roots under %TEMP%, removed with their links first.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containedIn, heldPath, ccProjectSlug } from './class-b.mjs';
import { volumeCaseFolds, pathWithin, repoEntryKind, readRepoFileBounded } from './config-load.mjs';
import { runRetier, collectStores } from './retier.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
const WIN = process.platform === 'win32';
const TEMP = fs.realpathSync.native(os.tmpdir());
const PREFIX = 'cw-probe-989-';
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return 'absent'; } };
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const bigStore = (dir, tag) => {
  const lines = ['# Memory index', ''];
  for (let i = 0; i < 60; i += 1) {
    w(path.join(dir, `${tag}-topic-${i}.md`), `${tag} topic ${i}\n${'detail line for the topic body. '.repeat(20)}\n`);
    lines.push(`- [${tag} topic ${i}](${tag}-topic-${i}.md) — ${'a long description of what this topic holds, '.repeat(6)}`);
  }
  w(path.join(dir, 'MEMORY.md'), lines.join('\n') + '\n');
};
// A sandbox per leg: its own root and HOME, restored and removed by t.after. Links are unlinked (rmdir / unlink) before the
// recursive remove, so the remove never follows a link into a folder this leg does not own.
function sandbox(t) {
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, PREFIX)));
  if (path.dirname(T) !== TEMP || !path.basename(T).startsWith(PREFIX)) throw new Error(`sandbox ${T} is not a ${PREFIX} folder under ${TEMP}`);
  const links = [];
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const home = path.join(T, 'home');
  fs.mkdirSync(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => {
    for (const l of links) { try { fs.unlinkSync(l); } catch { try { fs.rmdirSync(l); } catch { /* gone */ } } }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(T, { recursive: true, force: true });
  });
  // `track` REGISTERS a link the leg already made, for the unlink; it never creates one (round 8, F990-1: a second create threw EEXIST).
  return { T, home, track: (l) => links.push(l), junction: (l, target) => { fs.symlinkSync(target, l, 'junction'); links.push(l); } };
}
// The folder is made case-sensitive ON WINDOWS by fsutil, while empty; elsewhere the probe decides. Returns false (and skips) when the
// probe, not the fixture, says the folder folds case.
function sensitiveFolder(t, dir, probeChild) {
  if (WIN) {
    const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.status !== 0) { t.skip(`NAMED SKIP: fsutil exit ${r.status}`); return false; }
  }
  return true;
}
// The precondition measures the CONTAINER, through a probe key of its own (`zz-precheck`), so no key a leg later poisons is measured
// (and cached) before the poison exists: the cache is per path string for the process lifetime.
function foldsOrSkip(t, container) {
  const key = path.join(container, 'zz-precheck');
  fs.mkdirSync(key, { recursive: true });
  if (volumeCaseFolds(key, false)) { t.skip('NAMED SKIP: this folder folds case, so there is no case-variant to separate'); return true; }
  return false;
}

// (a) P1 direct -------------------------------------------------------------------------------------------------------------
test('containedIn and heldPath: a case-variant of a held folder is OUTSIDE it when a link sits at the flipped name (P1, F3)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  w(path.join(cs, 'memory', 'f.md'), 'held'); w(path.join(cs, 'Memory', 'f.md'), 'OTHER');
  if (foldsOrSkip(t, cs)) return;
  const cand = fs.realpathSync.native(path.join(cs, 'Memory', 'f.md'));
  // The poison is made BEFORE any probe of the held key (the cache is per path string for the process).
  sb.junction(path.join(cs, 'MEMORY'), path.join(cs, 'memory'));
  assert.strictEqual(containedIn(cand, [path.join(cs, 'memory')]), false, 'poison: a link at the flipped name does not make the case-variant inside');
  assert.strictEqual(heldPath(cs, ['memory'], cand), null, 'poison: heldPath refuses the case-variant entry');
  assert.strictEqual(containedIn(fs.realpathSync.native(path.join(cs, 'memory', 'f.md')), [path.join(cs, 'memory')]), true, 'sanity: the same spelling is inside');
});

// (b) P2/out: the permit side of pathWithin, through RE-TIER's store listing ---------------------------------------------------
test('collectStores: a sibling project\'s store is not listed through a case-variant .claude link (P2/out, pathWithin permit side)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  const proj = path.join(cs, 'proj');
  w(path.join(proj, 'CLAUDE.md'), '# proj\n');
  w(path.join(sb.home, '.claude', 'projects', ccProjectSlug(proj), 'memory', 'MEMORY.md'), '# main\n');
  const tgt = path.join(cs, 'Proj', '.claude');
  w(path.join(cs, 'Proj', 'CLAUDE.md'), '# the other project\n');
  bigStore(path.join(tgt, 'agent-memory', 'victim'), 'TGT');
  if (foldsOrSkip(t, cs)) return;
  sb.junction(path.join(proj, '.claude'), tgt);
  sb.junction(path.join(tgt, 'AGENT-MEMORY'), path.join(tgt, 'agent-memory'));
  sb.junction(path.join(tgt, 'agent-memory', 'VICTIM'), path.join(tgt, 'agent-memory', 'victim'));
  sb.junction(path.join(cs, 'PROJ'), proj);
  const victimDir = fs.realpathSync.native(path.join(tgt, 'agent-memory', 'victim'));
  const stores = collectStores({ projectRoot: proj, home: sb.home });
  const listed = stores.filter((s) => { try { return fs.realpathSync.native(s.dir) === victimDir; } catch { return false; } });
  assert.strictEqual(listed.length, 0, 'the sibling project\'s store (Proj\\.claude\\agent-memory\\victim) is not listed');
});

// (c) the Claude-base WRITE route (lab w-982base) ----------------------------------------------------------------------------
test('RE-TIER: a memory folder reached through a case-variant slug folder does not rewrite the other project\'s MEMORY.md (w-982base)', (t) => {
  const sb = sandbox(t);
  const projects = path.join(sb.home, '.claude', 'projects'); fs.mkdirSync(projects, { recursive: true });
  if (!sensitiveFolder(t, projects)) return;
  const proj = path.join(sb.T, 'proj'); w(path.join(proj, 'CLAUDE.md'), '# proj\n');
  const S = ccProjectSlug(proj); const S2 = S.replace(/proj$/, 'Proj');
  const otherMem = path.join(projects, S2, 'memory'); bigStore(otherMem, 'OTHER');
  if (foldsOrSkip(t, projects)) return;
  sb.junction(path.join(projects, S), path.join(projects, S2));
  sb.junction(path.join(projects, S2, 'MEMORY'), otherMem);
  const victim = path.join(otherMem, 'MEMORY.md'); const before = sha(victim);
  const basePhys = fs.realpathSync.native(path.join(sb.home, '.claude'));
  assert.strictEqual(heldPath(basePhys, ['projects', S, 'memory'], path.join(projects, S, 'memory')), null, 'the memory root is refused');
  try { runRetier({ projectRoot: proj, home: sb.home }); } catch { /* a refusal leaves the bytes as they were */ }
  assert.strictEqual(sha(victim), before, 'the other project\'s MEMORY.md is unchanged');
});

// (d) the cache: a poisoned answer is not replayed ---------------------------------------------------------------------------
test('the case probe: a poisoned answer is not replayed after the link is removed and the folder swapped (cache, identity-keyed)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  const held = path.join(cs, 'held'); w(path.join(held, 'f.md'), 'x');
  if (foldsOrSkip(t, cs)) return;
  const link = path.join(cs, 'HELD');
  sb.junction(link, held);
  assert.strictEqual(volumeCaseFolds(held, false), false, 'with the poison link present the probe answers a measured false');
  try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
  fs.rmSync(held, { recursive: true, force: true });
  w(path.join(held, 'f.md'), 'y');
  assert.strictEqual(volumeCaseFolds(held, false), false, 'after the link is removed and the folder swapped, no earlier answer is replayed');
});

// (i) identity moved: the SAME path string now names a NEW folder in a case-SENSITIVE parent, so the earlier measured
// `true` is stale. Under the identity-keyed cache the new folder's dev+ino differs and the probe re-measures false;
// a cache that replays on the path string alone keeps `true` and fails here.
test('the case probe: a cached MEASURED answer is dropped when the folder at that path is replaced (identity moved)', (t) => {
  const sb = sandbox(t);
  const A = path.join(sb.T, 'A'); fs.mkdirSync(A);
  const P = path.join(A, 'held'); w(path.join(P, 'f.md'), 'x');
  if (!volumeCaseFolds(P, false)) { t.skip('NAMED SKIP: the sandbox folder is case-sensitive, so there is no insensitive answer to replay'); return; }
  fs.rmSync(A, { recursive: true, force: true });
  fs.mkdirSync(A);
  if (!sensitiveFolder(t, A)) return; // fsutil needs an EMPTY folder, which A is here
  // Round 9 (F993-2): the replacement parent must MEASURE case-sensitive before the assertion below means anything. A folding volume
  // (macOS APFS) cannot make it sensitive, so the probe decides and the leg skips by name there, instead of asserting on the wrong volume.
  if (foldsOrSkip(t, A)) return;
  w(path.join(P, 'f.md'), 'y');
  assert.strictEqual(volumeCaseFolds(P, false), false, 'the same path now names a new folder in a case-sensitive parent: the cached true is not replayed');
});

// (e) pathWithin's miss takes the caller's polarity -----------------------------------------------------------------------------
test('pathWithin: a base with no case to flip takes the caller\'s polarity: permit (default) does not fold, refuse opts in', (t) => {
  const sb = sandbox(t);
  const p = path.join(sb.T, 'p');
  const child = path.join(p, 't', '123', 'x');
  const base = path.join(p, 'T', '123');
  assert.strictEqual(pathWithin(child, base), false, 'permit (the default) does not fold on a miss');
  assert.strictEqual(pathWithin(child, base, false), false, 'permit, explicit');
  assert.strictEqual(pathWithin(child, base, true), true, 'refuse-side callers fold on a miss, by their declared side');
  void t;
});

// (f) C4/L1: a link ROOT is refused (regression guard) -----------------------------------------------------------------------
test('containedIn and heldPath: a link ROOT is refused, never probed through (C4/L1)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  w(path.join(cs, 'HELD', 'x.txt'), 'held'); w(path.join(cs, 'Held', 'x.txt'), 'OTHER');
  if (foldsOrSkip(t, cs)) return;
  sb.junction(path.join(cs, 'held'), path.join(cs, 'HELD'));
  const cand = fs.realpathSync.native(path.join(cs, 'Held', 'x.txt'));
  assert.strictEqual(containedIn(cand, [path.join(cs, 'held')]), false, 'a link root is refused');
  assert.strictEqual(heldPath(cs, ['held'], cand), null, 'heldPath refuses through a link held folder');
});

// (g) H2: names that walk out of the held folder (regression guard) ----------------------------------------------------------
test('heldPath: a name that is .., empty, . or holds a separator is refused (H2)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(path.join(cs, 'a'), { recursive: true });
  w(path.join(cs, 'a', 'x.txt'), 'x');
  const cand = fs.realpathSync.native(path.join(cs, 'a', 'x.txt'));
  for (const bad of ['..', '', '.', 'a/b']) {
    assert.strictEqual(heldPath(cs, [bad], cand), null, `the name ${JSON.stringify(bad)} is refused`);
  }
});

// (h) the link at the flipped name under <proj>/.claude (class-988 §4), made ONCE on every platform (round 8, F990-1). The folder is made
// case-sensitive first (fsutil on Windows), so the leg RUNS on this box. Its one link is a symlink where POSIX allows one and a junction on
// Windows, which needs no privilege; no platform gate decides whether the body runs, only the probe does (EEXIST = the folder folds case).
test('the case probe: a symlink at the flipped name under .claude answers a measured false, not a fold (class-988 §4)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  const claude = path.join(cs, 'proj', '.claude');
  w(path.join(claude, 'rules', 'f.md'), 'rules');
  // Probe the case-sensitivity by CREATING the flipped name, never by platform: EEXIST means this folder folds case.
  try { fs.mkdirSync(path.join(claude, 'Rules')); } catch (e) {
    if (e.code === 'EEXIST') { t.skip('NAMED SKIP: this folder folds case (the flipped name is the same folder)'); return; }
    throw e;
  }
  w(path.join(claude, 'Rules', 'f.md'), 'OTHER');
  const link = path.join(claude, 'RULES');
  try { fs.symlinkSync(path.join(claude, 'rules'), link, WIN ? 'junction' : 'dir'); } catch (e) {
    t.skip(`NAMED SKIP: a link cannot be made here (${e.code})`); return;
  }
  sb.track(link); // registered for the unlink; the one link made above is the one under test
  const cand = fs.realpathSync.native(path.join(claude, 'Rules', 'f.md'));
  assert.strictEqual(containedIn(cand, [path.join(claude, 'rules')]), false, 'a link at the flipped name does not make the case-variant inside');
});

// (j) the PERMIT caller on a probe MISS (round 8, F990-3: the maker's m4 survivor, made reachable). A base whose BASENAME has no case to
// flip misses the probe, so a PERMIT caller must NOT fold. Here the root is cs/T/123 and a junction inside it reaches cs/t/123, which holds
// the other folder's file: the case-variant ANCESTOR must be refused by both repoEntryKind and readRepoFileBounded.
test('repoEntryKind and readRepoFileBounded: a junction into the case-variant folder of a root with no case to flip is refused (permit side, probe miss)', (t) => {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  if (!sensitiveFolder(t, cs)) return;
  const root = path.join(cs, 'T', '123'); w(path.join(root, 'own.md'), 'own');
  const other = path.join(cs, 't', '123'); w(path.join(other, 'secret.md'), 'SECRET-OTHER');
  if (fs.statSync(path.join(cs, 'T'), { bigint: true }).ino === fs.statSync(path.join(cs, 't'), { bigint: true }).ino) {
    t.skip('NAMED SKIP: T and t are one folder on this volume, so there is no other folder to reach'); return;
  }
  const lnk = path.join(root, 'lnk');
  try { fs.symlinkSync(other, lnk, 'junction'); } catch (e) { t.skip(`NAMED SKIP: a junction cannot be made here (${e.code})`); return; }
  sb.track(lnk);
  const child = path.join(lnk, 'secret.md');
  const rootPhys = fs.realpathSync.native(root);
  assert.strictEqual(repoEntryKind(child, rootPhys), null, 'a PERMIT caller on a probe miss does not fold: the other folder is outside the root');
  assert.strictEqual(readRepoFileBounded(child, rootPhys, 1000), null, 'the bounded read refuses the other folder through the same permit side');
});
