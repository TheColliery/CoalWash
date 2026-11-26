// 29qh fire 976 (round 6, F1; reviewer 973 F1; lab 1202 F1): containedIn folded case on EVERY win32 folder, because it compared with
// path.relative. On a per-directory case-SENSITIVE folder (fsutil file setCaseSensitiveInfo) a case-variant sibling read as inside, so a
// junction to it was followed and a plan for one project rewrote its sibling. Ported from the lab's cs-leg.mjs (the in and out arms and
// the RE-TIER judgement), cs-base-leg.mjs (B9 and B7, the claude-base side) and the reviewer's w-973b.mjs (applyPlan). Each sensitive leg
// makes its own folder under %TEMP% and SKIPS VISIBLY by name where the flag cannot be set; the insensitive-folder control needs no
// privilege. Every leg sandboxes HOME, and removes its own junctions (rmdir, never a recursive delete through a link) before its root.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { containedIn, ccProjectSlug } from './class-b.mjs';
import { volumeCaseFolds } from './config-load.mjs';
import { applyPlan } from './apply.mjs';
import { runRetier } from './retier.mjs';
import { runEstate } from './estate-archive.mjs';

delete process.env.CLAUDE_CONFIG_DIR;
const WIN = process.platform === 'win32';
const TEMP = fs.realpathSync.native(os.tmpdir());
const PREFIX = 'cw-case-976-';
const DAY = 86400000;
const SID = '97676767-2222-4333-8444-555555555555';

const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12); } catch { return 'absent'; } };
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const bigStore = (dir, tag) => {
  const lines = ['# Memory index', ''];
  for (let i = 0; i < 60; i += 1) {
    w(path.join(dir, `${tag}-topic-${i}.md`), `${tag} topic ${i}\n${'detail line for the topic body. '.repeat(20)}\n`);
    lines.push(`- [${tag} topic ${i}](${tag}-topic-${i}.md) — ${'a long description of what this topic holds and when to read it, '.repeat(6)}`);
  }
  w(path.join(dir, 'MEMORY.md'), lines.join('\n') + '\n');
};
// The folder's own case flag, set on an EMPTY folder (the lab's order: every folder made inside it inherits the flag).
function caseSensitive(dir) {
  const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  return r.status === 0 ? null : `fsutil exit ${r.status} ${String(r.stdout || r.stderr || r.error || '').trim().slice(0, 80)}`;
}
// One sandbox per leg: its own root and HOME under %TEMP%, restored and removed by t.after (links unlinked first).
function sandbox(t) {
  const T = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, PREFIX)));
  if (path.dirname(T) !== TEMP || !path.basename(T).startsWith(PREFIX)) throw new Error(`sandbox ${T} is not a ${PREFIX} folder under ${TEMP}`);
  const links = [];
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const home = path.join(T, 'home');
  fs.mkdirSync(home);
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => {
    for (const l of links) { try { fs.rmdirSync(l); } catch { /* already gone */ } }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(T, { recursive: true, force: true });
  });
  return { T, home, junction: (l, target) => { fs.symlinkSync(target, l, 'junction'); links.push(l); } };
}

test('containedIn: a case-variant sibling of a folder is OUTSIDE it on a case-SENSITIVE folder (29qg F1)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive folder is made with fsutil)'); return; }
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  const why = caseSensitive(cs); if (why) { t.skip(`NAMED SKIP: ${why}`); return; }
  const proj = path.join(cs, 'proj'); const sib = path.join(cs, 'PROJ');
  w(path.join(proj, 'a.md'), 'project\n'); w(path.join(sib, 'a.md'), 'sibling\n');
  assert.strictEqual(volumeCaseFolds(proj, false), false, 'precondition: the probe measures cs as case-SENSITIVE');
  assert.strictEqual(containedIn(path.join(proj, 'a.md'), [proj]), true, 'sanity: the same spelling is inside');
  assert.strictEqual(containedIn(path.join(sib, 'a.md'), [proj]), false, 'a case-variant sibling is NOT inside on a case-sensitive folder');
});

test('containedIn: a case-variant of a root that is ABSENT is refused, never folded on a probe miss (mutant b)', (t) => {
  const sb = sandbox(t);
  const root = path.join(sb.T, 'Absent-Folder');
  assert.strictEqual(containedIn(path.join(root, 'a.md'), [root]), true, 'sanity: the same spelling is inside');
  assert.strictEqual(containedIn(path.join(sb.T, 'absent-folder', 'a.md'), [root]), false, 'a case-variant of an absent root is refused');
});

test('containedIn: a case-variant of a folder on a case-INSENSITIVE folder is still the same folder (no false refusal)', (t) => {
  const sb = sandbox(t);
  const dir = path.join(sb.T, 'Store'); w(path.join(dir, 'a.md'), 'x\n');
  if (!volumeCaseFolds(dir, false)) { t.skip('NAMED SKIP: this volume is case-sensitive, so there is no case-variant to fold'); return; }
  assert.strictEqual(containedIn(path.join(sb.T, 'STORE', 'a.md'), [dir]), true, 'an upper-case spelling of an insensitive folder is inside');
  assert.strictEqual(containedIn(path.join(sb.T, 'store', 'a.md'), [dir]), true, 'a lower-case spelling of an insensitive folder is inside');
});

test('applyPlan: a plan rooted in a case-variant SIBLING project does not rewrite it on a case-SENSITIVE folder (w-973b, 29qg)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive folder is made with fsutil)'); return; }
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  const why = caseSensitive(cs); if (why) { t.skip(`NAMED SKIP: ${why}`); return; }
  const proj = path.join(cs, 'proj'); const sib = path.join(cs, 'PROJ');
  w(path.join(proj, 'CLAUDE.md'), '# proj\n'); w(path.join(proj, '.claude', 'keep.md'), 'keep\n');
  const victim = path.join(sib, 'a.md'); w(victim, '# sibling project file\n');
  const before = sha(victim);
  const r = applyPlan({ roots: [sib], actions: [{ type: 'rewrite', path: victim, content: '# REWRITTEN by a plan for proj\n' }] }, { projectRoot: proj, home: sb.home });
  assert.strictEqual(r.ok, false, `a plan for proj must refuse the sibling: ok=${r.ok} error=${String(r.error || '').slice(0, 100)}`);
  assert.strictEqual(sha(victim), before, 'the sibling file is unchanged');
});

// cs-leg (in and out arms): the RE-TIER store reached through a junction. Only the in arm is red on the base: the out arm is refused there
// by repoEntryKind before containedIn is reached, and it stays a regression guard for the new primitive.
function retierArm(t, arm) {
  const sb = sandbox(t);
  const cs = path.join(sb.T, 'cs'); fs.mkdirSync(cs);
  const why = caseSensitive(cs); if (why) { t.skip(`NAMED SKIP: ${why}`); return null; }
  const proj = path.join(cs, 'proj');
  w(path.join(sb.home, '.claude', 'projects', ccProjectSlug(proj), 'memory', 'MEMORY.md'), '# main\n');
  w(path.join(proj, 'CLAUDE.md'), '# proj\n');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  if (arm === 'in') {
    bigStore(path.join(proj, '.claude', 'Agent-Memory', 'victim'), 'INNER');
    w(path.join(proj, '.claude', 'Rules', 'INNER-rule.md'), 'INNER rule\n');
    sb.junction(path.join(proj, '.claude', 'agent-memory'), path.join(proj, '.claude', 'Agent-Memory'));
    sb.junction(path.join(proj, '.claude', 'rules'), path.join(proj, '.claude', 'Rules'));
    return { victim: path.join(proj, '.claude', 'Agent-Memory', 'victim', 'MEMORY.md'), proj, home: sb.home };
  }
  const sib = path.join(cs, 'PROJ');
  bigStore(path.join(sib, '.claude', 'agent-memory', 'victim'), 'SIB');
  w(path.join(sib, '.claude', 'rules', 'SIB-rule.md'), 'SIB rule\n');
  sb.junction(path.join(proj, '.claude', 'agent-memory'), path.join(sib, '.claude', 'agent-memory'));
  sb.junction(path.join(proj, '.claude', 'rules'), path.join(sib, '.claude', 'rules'));
  return { victim: path.join(sib, '.claude', 'agent-memory', 'victim', 'MEMORY.md'), proj, home: sb.home };
}
test('RE-TIER (in arm): a store reached through a junction to a case-variant folder inside the project is not rewritten (cs-leg, 29qe)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive folder is made with fsutil)'); return; }
  const arm = retierArm(t, 'in');
  if (!arm) return;
  const before = sha(arm.victim);
  let r; try { r = runRetier({ projectRoot: arm.proj, home: arm.home }); } catch (e) { r = { ok: false, threw: e.message }; }
  assert.strictEqual(sha(arm.victim), before, `the case-variant store is unchanged (runRetier ok=${r.ok} ${String(r.reason || r.threw || '').slice(0, 90)})`);
});
test('RE-TIER (out arm): a store reached through a junction to a case-variant SIBLING project is not rewritten (cs-leg out, 29qe)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive folder is made with fsutil)'); return; }
  const arm = retierArm(t, 'out');
  if (!arm) return;
  const before = sha(arm.victim);
  let r; try { r = runRetier({ projectRoot: arm.proj, home: arm.home }); } catch (e) { r = { ok: false, threw: e.message }; }
  assert.strictEqual(sha(arm.victim), before, `the sibling store is unchanged (runRetier ok=${r.ok} ${String(r.reason || r.threw || '').slice(0, 90)})`);
});

// cs-base-leg: the claude-base side. The home is made case-sensitive while it is still empty; the slug folder of this project is a
// junction to the slug folder of ANOTHER project that differs only in case. The control names a different project outright.
function baseCase(t, otherName) {
  const sb = sandbox(t);
  const why = caseSensitive(sb.home); if (why) { t.skip(`NAMED SKIP: ${why}`); return null; }
  const proj = path.join(sb.T, 'proj'); w(path.join(proj, 'CLAUDE.md'), '# proj\n');
  const slug = ccProjectSlug(proj);
  const other = otherName || slug.toLowerCase();
  const projects = path.join(sb.home, '.claude', 'projects');
  return { sb, proj, slugDir: path.join(projects, slug), otherDir: path.join(projects, other) };
}
test('estate: a slug folder that is a junction to a case-variant slug of another project does not archive its transcript (cs-base-leg B9, 29qe)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive home is made with fsutil)'); return; }
  const x = baseCase(t, null);
  if (!x) return;
  const live = path.join(x.otherDir, `${SID}.jsonl`);
  w(live, Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `other project line ${i}` } })).join('\n') + '\n');
  const old = (Date.now() - 30 * DAY) / 1000; fs.utimesSync(live, old, old);
  x.sb.junction(x.slugDir, x.otherDir);
  let res; try { res = runEstate({ projectRoot: x.proj, home: x.sb.home, now: Date.now(), estate: {} }); } catch (e) { res = { threw: e.message }; }
  assert.ok(fs.existsSync(live), `the other project's live transcript is kept (archived=${(res && res.archived || []).length} threw=${res && res.threw || 'no'})`);
});
test('estate: CONTROL, a slug junction to a DIFFERENT-named project keeps that project transcript (cs-base-leg B9 control)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive home is made with fsutil)'); return; }
  const x = baseCase(t, 'C--other-976');
  if (!x) return;
  const live = path.join(x.otherDir, `${SID}.jsonl`);
  w(live, Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `other project line ${i}` } })).join('\n') + '\n');
  const old = (Date.now() - 30 * DAY) / 1000; fs.utimesSync(live, old, old);
  x.sb.junction(x.slugDir, x.otherDir);
  try { runEstate({ projectRoot: x.proj, home: x.sb.home, now: Date.now(), estate: {} }); } catch { /* a refusal is the control's expected outcome */ }
  assert.ok(fs.existsSync(live), 'the different-named project transcript is kept');
});
test('RE-TIER: a memory folder that is a junction to a case-variant project memory is not rewritten (cs-base-leg B7, 29qe)', (t) => {
  if (!WIN) { t.skip('NAMED SKIP: win32 only (the case-sensitive home is made with fsutil)'); return; }
  const x = baseCase(t, null);
  if (!x) return;
  bigStore(path.join(x.otherDir, 'memory'), 'OTHER');
  fs.mkdirSync(x.slugDir, { recursive: true });
  x.sb.junction(path.join(x.slugDir, 'memory'), path.join(x.otherDir, 'memory'));
  const victim = path.join(x.otherDir, 'memory', 'MEMORY.md'); const before = sha(victim);
  try { runRetier({ projectRoot: x.proj, home: x.sb.home }); } catch { /* a refusal leaves the bytes as they were */ }
  assert.strictEqual(sha(victim), before, "the other project's MEMORY.md is unchanged");
});
