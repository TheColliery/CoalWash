// 29fd (fire 694): a committed wash records its post-wash reading, so a copy
// of the pre-wash file brought back from outside is seen at the next look.
// Hermetic per hooks-safety.md §7: the REAL hooks/coalwash-conductor.js runs as
// a child with fixture stdin, and every path it can read lives in one temp root.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPlan, recoverDangling, __testHooks } from './apply.mjs';
import { runRetier } from './retier.mjs';
import { loadState } from './caliper.mjs';
// a namespace import, so a missing 699 export fails only its own tests, never the whole file
import * as calNs from './caliper.mjs';
import { restore } from './cli.mjs';
import { listBin, recordBinItem, FAT_BIN_NAME } from './tailings.mjs';
import { ccProjectSlug } from './class-b.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '..', 'hooks', 'coalwash-conductor.js');

// The real temp folder, captured BEFORE the redirect below; cleanup refuses anything outside it.
const TEMP_BASE = fs.realpathSync.native(os.tmpdir());
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP_BASE, 'cwpw-')));
const FAKE_HOME = path.join(ROOT, 'home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
Object.assign(process.env, {
  HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, TEMP: ROOT, TMP: ROOT, TMPDIR: ROOT,
  CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: path.join(ROOT, 'pdata'),
});
after(() => {
  const rel = path.relative(TEMP_BASE, ROOT);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) fs.rmSync(ROOT, { recursive: true, force: true });
});

// A store big enough to cross into OBESE, the same fixture shape the 29ez harness used.
const DUP_N = 220;
const dupLines = (i) => `- DUP-${i} entry, a fixed description so the line carries real weight for line ${i}`;
const MEM_ORIG = '# Memory\n\n' + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i)}\n${dupLines(i)}\n`).join('');
const MEM_DEDUP = '# Memory\n\n' + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i)}\n`).join('');
const OTHER_NOTE = '- a second entry whose delete is made to fail\n';

function makeCase(name) {
  const base = path.join(ROOT, 'cases', name);
  const c = { name, base, proj: path.join(base, 'proj'), home: path.join(base, 'home') };
  c.store = path.join(c.proj, 'memory');
  c.mem = path.join(c.store, 'MEMORY.md');
  c.other = path.join(c.store, 'other-note.md');
  fs.mkdirSync(c.store, { recursive: true });
  fs.mkdirSync(c.home, { recursive: true });
  fs.writeFileSync(path.join(c.proj, 'CLAUDE.md'), '# fixture project\n\n@memory/MEMORY.md\n');
  fs.writeFileSync(c.mem, MEM_ORIG);
  fs.writeFileSync(c.other, OTHER_NOTE);
  // the never-create guard: the hook writes state only where the platform's slug dir already exists
  fs.mkdirSync(path.join(c.home, '.claude', 'projects', ccProjectSlug(c.proj)), { recursive: true });
  fs.writeFileSync(path.join(c.base, 'transcript.jsonl'), '');
  return c;
}

// The real conductor, spawned as the platform spawns it.
function runHook(c, event, { stopActive = false, attended = false } = {}) {
  const payload = { session_id: `cwpw-${c.name}`, hook_event_name: event, cwd: c.proj, transcript_path: path.join(c.base, 'transcript.jsonl') };
  if (event === 'SessionStart') payload.source = 'startup';
  if (event === 'Stop') payload.stop_hook_active = stopActive;
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: c.home, USERPROFILE: c.home, TEMP: ROOT, TMP: ROOT, TMPDIR: ROOT,
    CLAUDE_PROJECT_DIR: c.proj, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: path.join(ROOT, 'pdata'),
    NODE_OPTIONS: '--max-old-space-size=2048', ...(attended ? { CLAUDE_CODE_SESSION_ATTENDED: '1' } : {}),
  };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), cwd: c.proj, env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  const out = (r.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { json = null; } }
  return { status: r.status, out, nudge: !!(json && json.decision === 'block'), reason: json && json.reason ? String(json.reason) : '' };
}

const opts = (c) => ({ projectRoot: c.proj, home: c.home, now: Date.now() });
const plan = (c, actions) => ({ projectRoot: c.proj, roots: [c.store], actions, sessionId: 'cwpw', deletesApproved: true });
const dedupAction = (c) => ({ type: 'rewrite', path: c.mem, content: MEM_DEDUP, expectedOrig: MEM_ORIG });
const otherDelAction = (c) => ({ type: 'delete', path: c.other, expectedOrig: OTHER_NOTE });
const stateOf = (c) => {
  const p = loadState(c.proj, c.home);
  return { lastObeseFat: p.lastObeseFat ?? null, alwaysLoadedBytes: p.lastVerdict ? p.lastVerdict.alwaysLoadedBytes : null };
};

// Arm the OBESE crossing, then let the first Stop nudge and consume it.
function armAndConsume(c) {
  runHook(c, 'SessionStart');
  const first = runHook(c, 'Stop');
  assert.ok(first.nudge, `pre-wash Stop must nudge (the crossing was armed): ${first.out.slice(0, 200)}`);
  return first;
}

test('witness: a copy of the pre-wash file brought back from outside re-arms the next look', (t) => {
  const c = makeCase('witness');
  const first = armAndConsume(c);
  t.diagnostic(`re-armed nudge reason (default config, first OBESE nudge): ${first.reason.slice(0, 400)}`);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  const cont = runHook(c, 'Stop', { stopActive: true });
  assert.strictEqual(cont.out, '', 'the Stop continuation after a wash stays silent (stop_hook_active)');
  fs.writeFileSync(c.mem, MEM_ORIG); // a sync client or a backup writes the pre-wash bytes back
  const memBefore = fs.readFileSync(c.mem, 'utf8');
  const look = runHook(c, 'Stop', { attended: true });
  t.diagnostic(`return ask after the outside copy: ${look.reason.slice(0, 600)}`);
  assert.ok(look.nudge, `the returned copy must be asked about at an attended look; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, /came back to the content it had before the last wash/, 'the look asks; it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), memBefore, 'the look washes nothing: the store bytes are unchanged');
});

test('control (a): the bin door restore followed by the hand write-back stays silent', () => {
  const c = makeCase('control-a');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  // the wash's removed lines, banked the way the 0h wiring banks a program cut
  const removed = Array.from({ length: DUP_N }, (_, i) => dupLines(i) + '\n').join('');
  const rec = recordBinItem(c.proj, FAT_BIN_NAME, { content: Buffer.from(removed), original: c.mem, origin: 'program-cut', now: Date.now() });
  const id = (rec && rec.id) || (listBin(c.proj, FAT_BIN_NAME)[0] || {}).id;
  assert.ok(id, 'the removed lines are in the fat bin under an id');
  const r = restore({ id, cwd: c.proj, home: c.home });
  assert.strictEqual(r.found, true, JSON.stringify(r));
  fs.writeFileSync(c.mem, MEM_ORIG); // the user writes the pre-wash file back by hand
  const look = runHook(c, 'Stop');
  assert.strictEqual(look.out, '', `a restored and acknowledged wash must not re-nudge; got: ${look.out.slice(0, 200)}`);
});

test('control (b): a run that fails and rolls back records nothing', () => {
  const c = makeCase('control-b');
  armAndConsume(c);
  const before = stateOf(c);
  const realRm = fs.rmSync;
  fs.rmSync = (p, ...rest) => {
    if (path.resolve(String(p)) === path.resolve(c.other)) throw new Error('injected delete failure');
    return realRm(p, ...rest);
  };
  let r;
  try { r = applyPlan(plan(c, [dedupAction(c), otherDelAction(c)]), opts(c)); } finally { fs.rmSync = realRm; }
  assert.strictEqual(r.ok, false, 'the injected delete failure must fail the run');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'the rollback restores the pre-run bytes');
  assert.deepStrictEqual(stateOf(c), before, 'a rolled-back run writes no post-wash reading');
  assert.strictEqual(runHook(c, 'Stop').out, '', 'and the next look stays silent');
});

test('control (c): a torn run recovered by recoverDangling records nothing', () => {
  const c = makeCase('control-c');
  armAndConsume(c);
  const before = stateOf(c);
  __testHooks.onFence = (where) => { if (where === 'the commit record') throw new Error('torn: injected crash before the commit record'); };
  try { applyPlan(plan(c, [dedupAction(c)]), opts(c)); } catch { /* the torn run ends here */ } finally { __testHooks.onFence = null; }
  recoverDangling(c.proj, { home: c.home, now: Date.now() });
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'recovery returns the store to its pre-run bytes');
  assert.deepStrictEqual(stateOf(c), before, 'a torn run writes no post-wash reading');
  assert.strictEqual(runHook(c, 'Stop').out, '', 'and the next look stays silent');
});

// control (d), 697: RE-TIER is the one applyPlan caller that can roll back AFTER
// the commit. Drives the real runRetier: the store is an agent-memory index that
// CLAUDE.md imports, so the gauge measures it. The post-commit top-anchor probe is
// made to miss at the fs layer: once the committed journal is removed, opening the
// store for reading throws ENOENT, so the probe finds no store text and rolls back.
const RT_R = { targetTokens: 500, armPct: 20, disarmPct: 10, headroomPct: 10 };
const rtEstate = (home) => ({ compressAfterDays: 14, purgeAfterDays: 180, deleteCold: false, archiveDir: path.join(home, 'archive'), indexEnabled: true });

test('control (d): a RE-TIER run rolled back after its commit records nothing, and the next look emits nothing', () => {
  const c = makeCase('control-d');
  const storeDir = path.join(c.proj, '.claude', 'agent-memory', 'main');
  const storeFile = path.join(storeDir, 'MEMORY.md');
  const body = '# Memory\n\n' + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i)} [[dup-anchor]]\n${dupLines(i)} [[dup-anchor]]\n`).join('');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(storeFile, body);
  fs.writeFileSync(path.join(c.proj, 'CLAUDE.md'), '# fixture project\n\n@.claude/agent-memory/main/MEMORY.md\n');
  armAndConsume(c);
  const before = stateOf(c);
  const preFile = fs.readFileSync(storeFile, 'utf8');
  const measured = (loadState(c.proj, c.home).lastVerdict.alwaysLoadedPaths || []).map((p) => path.resolve(p));
  assert.ok(measured.includes(path.resolve(storeFile)), 'precondition: the gauge measured the store file (non-vacuity)');
  const realRm = fs.rmSync;
  const realOpen = fs.openSync;
  let committed = false;
  fs.rmSync = (p, ...rest) => { if (String(p).endsWith('journal.json')) committed = true; return realRm(p, ...rest); };
  fs.openSync = (p, flags, ...rest) => {
    // a read-only open: a string flag 'r'/'rs', or a numeric flag with no write bit (repo-fs opens with O_RDONLY | O_NOFOLLOW)
    const writeBits = fs.constants.O_WRONLY | fs.constants.O_RDWR;
    const readOnly = flags === undefined || flags === 'r' || flags === 'rs' || (typeof flags === 'number' && (flags & writeBits) === 0);
    if (committed && String(p).startsWith(storeDir) && readOnly) {
      const e = new Error('ENOENT: injected post-commit loss of the store index'); e.code = 'ENOENT'; throw e;
    }
    return realOpen(p, flags, ...rest);
  };
  let res;
  try {
    res = runRetier({ projectRoot: c.proj, home: c.home, retier: RT_R, estate: rtEstate(c.home), now: Date.now() });
  } finally { fs.rmSync = realRm; fs.openSync = realOpen; }
  assert.strictEqual(res.ok, false, `the injected probe miss must fail the RE-TIER run: ${JSON.stringify(res).slice(0, 300)}`);
  assert.match(String(res.error || ''), /probe/, 'the failure is the post-commit top-anchor probe');
  assert.strictEqual(fs.readFileSync(storeFile, 'utf8'), preFile, 'the rollback restores the store bytes');
  assert.deepStrictEqual(stateOf(c), before, 'a RE-TIER run rolled back after its commit records no post-wash reading');
  assert.strictEqual(runHook(c, 'Stop').out, '', 'and the next look emits nothing');
});

// ---- 699 (BB-469): a look that finds the store back at its pre-wash content is a RETURN, and marks an ask ----
// Arm, wash by applyPlan, bring `content` back from outside, then look. Returns the look.
function returnFlow(c, content) {
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, content);
  return runHook(c, 'Stop');
}
const stateNow = (c) => loadState(c.proj, c.home);

test('699 (e): a look that finds the store back at its pre-wash content marks the crossing for an ask', () => {
  const c = makeCase('return-e');
  returnFlow(c, MEM_ORIG);
  assert.strictEqual(stateNow(c).returnAsk, true, 'the look at the pre-wash level is a return, so an ask is marked');
});

test('699 (f): growth past the pre-wash level re-arms with no ask marked', () => {
  const c = makeCase('growth-f');
  const grown = MEM_ORIG + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i + DUP_N)}
${dupLines(i + DUP_N)}
`).join('');
  const look = returnFlow(c, grown);
  assert.ok(look.nudge, 'growth past the level re-arms and nudges, as today'); // the re-arm is consumed by the same look, so the nudge is the evidence
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'growth is not a return, so no ask is marked');
});

test('699 (g): answering "leave it" consumes the crossing, and the next look emits nothing', () => {
  const c = makeCase('leave-g');
  returnFlow(c, MEM_ORIG);
  assert.strictEqual(stateNow(c).returnAsk, true, 'precondition: a return is pending');
  assert.strictEqual(typeof calNs.answerReturnLeave, 'function', 'the leave answer is exported');
  calNs.answerReturnLeave(c.home, c.proj);
  const s = stateNow(c);
  assert.strictEqual(s.returnAsk, undefined, 'the return mark is cleared');
  assert.strictEqual(s.postWash, undefined, 'the wash episode is cleared');
  assert.strictEqual(calNs.sanitizeCrossing(s.lastCrossing), null, 'no live crossing remains');
  assert.strictEqual(runHook(c, 'Stop').out, '', 'the next look is silent');
});

test('699 (h): a RE-TIER run rolled back after its commit leaves postWash and returnAsk unchanged', () => {
  const c = makeCase('rollback-h');
  const storeDir = path.join(c.proj, '.claude', 'agent-memory', 'main');
  const storeFile = path.join(storeDir, 'MEMORY.md');
  const body = '# Memory\n\n' + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i)} [[dup-anchor]]\n${dupLines(i)} [[dup-anchor]]\n`).join('');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(storeFile, body);
  fs.writeFileSync(path.join(c.proj, 'CLAUDE.md'), '# fixture project\n\n@.claude/agent-memory/main/MEMORY.md\n');
  armAndConsume(c);
  const r1 = runRetier({ projectRoot: c.proj, home: c.home, retier: RT_R, estate: rtEstate(c.home), now: Date.now() });
  assert.strictEqual(r1.ok, true, `the first RE-TIER run commits: ${JSON.stringify(r1).slice(0, 200)}`);
  fs.writeFileSync(storeFile, body); // the pre-wash bytes come back from outside
  runHook(c, 'Stop');
  assert.strictEqual(stateNow(c).returnAsk, true, 'precondition: the look marked a return');
  const snap = stateNow(c);
  const realRm = fs.rmSync;
  const realOpen = fs.openSync;
  let committed = false;
  fs.rmSync = (p, ...rest) => { if (String(p).endsWith('journal.json')) committed = true; return realRm(p, ...rest); };
  const writeBits = fs.constants.O_WRONLY | fs.constants.O_RDWR;
  fs.openSync = (p, flags, ...rest) => {
    const readOnly = flags === undefined || flags === 'r' || flags === 'rs' || (typeof flags === 'number' && (flags & writeBits) === 0);
    if (committed && String(p).startsWith(storeDir) && readOnly) {
      const e = new Error('ENOENT: injected post-commit loss of the store index'); e.code = 'ENOENT'; throw e;
    }
    return realOpen(p, flags, ...rest);
  };
  let r2;
  try {
    r2 = runRetier({ projectRoot: c.proj, home: c.home, retier: RT_R, estate: rtEstate(c.home), now: Date.now() });
  } finally { fs.rmSync = realRm; fs.openSync = realOpen; }
  assert.strictEqual(r2.ok, false, 'the injected probe miss rolls the second run back');
  const after = stateNow(c);
  assert.deepStrictEqual(after.postWash, snap.postWash, 'the rolled-back commit leaves the wash episode as it was');
  assert.strictEqual(after.returnAsk, snap.returnAsk, 'the rolled-back commit leaves the return mark as it was');
});

// ---- 702 (F700-1..3): a RETURN is the washed files' own pre-wash bytes coming back, never a fat level ----
test('702 (n) W700: new fat that brings no pre-wash bytes back is growth, not a return', () => {
  const c = makeCase('new-n');
  const fresh = MEM_DEDUP + Array.from({ length: 132 }, (_, i) => {
    const l = `- NEW-${i} entry, a fixed description so the line carries real weight for line ${i}\n`;
    return l + l;
  }).join('');
  const look = returnFlow(c, fresh);
  assert.ok(look.nudge, 'the new fat re-arms and nudges, as today (non-vacuity)');
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'no pre-wash bytes came back, so this is growth and no ask is marked');
});

test('702 (o): answerReturnLeave with no finite fat changes nothing and returns false', () => {
  const c = makeCase('nonfinite-o');
  returnFlow(c, MEM_ORIG);
  assert.strictEqual(stateNow(c).returnAsk, true, 'precondition: a return is pending');
  const sp = calNs.statePath(c.proj, c.home);
  const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
  delete j.lastVerdict.fatTokens;
  fs.writeFileSync(sp, JSON.stringify(j));
  assert.strictEqual(stateNow(c).lastVerdict.fatTokens, undefined, 'precondition: the fat is not finite');
  const before = JSON.stringify(stateNow(c));
  assert.strictEqual(calNs.answerReturnLeave(c.home, c.proj), false, 'refuses to act without a finite fat');
  assert.strictEqual(JSON.stringify(stateNow(c)), before, 'the state is unchanged');
});

test('702 (p): a FULL crossing that finds the store moved on from its pre-wash bytes clears the return mark', () => {
  const c = makeCase('full-p');
  returnFlow(c, MEM_ORIG);
  assert.strictEqual(stateNow(c).returnAsk, true, 'precondition: a return is pending');
  fs.writeFileSync(c.mem, MEM_ORIG + OTHER_NOTE); // the store has moved on: no washed file is back at its pre-wash bytes
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 9999 });
  const s = stateNow(c);
  assert.notStrictEqual(calNs.sanitizeCrossing(s.lastCrossing), null, 'precondition: the FULL crossing armed');
  assert.strictEqual(s.returnAsk, undefined, 'a crossing that finds no pre-wash bytes is growth, so the return mark clears');
});

// ---- 707 (LANE FIX, round 2): every arm that can reach a wash runs the same pre-wash check ----
// (q) the RISE branch to OBESE: a store read LEAN after the wash, then the pre-wash bytes come back.
test('707 (q): a rise to OBESE onto the pre-wash bytes is asked about, and washes nothing', () => {
  const c = makeCase('rise-q');
  armAndConsume(c); // a wash always follows a gauge: the look records the pre-wash reading
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  runHook(c, 'SessionStart');
  assert.strictEqual(stateNow(c).lastVerdict.band, 'LEAN', 'precondition: the washed store reads LEAN');
  fs.writeFileSync(c.mem, MEM_ORIG); // the pre-wash bytes come back: a rise, read by the gauge
  const before = fs.readFileSync(c.mem, 'utf8');
  runHook(c, 'SessionStart');
  assert.strictEqual(stateNow(c).lastVerdict.band, 'OBESE', 'precondition: the copy-back reads OBESE, a rise');
  const look = runHook(c, 'Stop', { attended: true });
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing: the store bytes are unchanged');
  assert.strictEqual(stateNow(c).returnAsk, true, 'the rise onto the pre-wash bytes is a return, so an ask is marked');
  assert.match(look.reason, /came back to the content it had before the last wash/, 'the attended look asks; it does not run the auto-Quick pass');
});

// (r) the RISE branch to FULL: the store is back at its pre-wash bytes when the FULL crossing arms.
test('707 (r): a rise to FULL onto the pre-wash bytes is asked about, and is not forced', () => {
  const c = makeCase('rise-r');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG); // the pre-wash bytes come back, with no look in between
  const before = fs.readFileSync(c.mem, 'utf8');
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 9999 });
  const look = runHook(c, 'Stop', { attended: true });
  assert.strictEqual(stateNow(c).returnAsk, true, 'the FULL rise onto the pre-wash bytes is a return: the one return check at the Stop asks and marks it');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing: the store bytes are unchanged');
  assert.match(look.reason, /came back to the content it had before the last wash/, 'the attended look asks; it does not run the forced Quick pass');
});

// ---- 711 (LANE ROUND 3): ONE return check at the Stop delivery holds the ask for every pass, whatever branch armed it ----
const ASK_TEXT = /came back to the content it had before the last wash/;
// The same growth as 702 (n): fresh pre-wash-free fat, no pre-wash bytes in it.
function growFresh() {
  return MEM_DEDUP + Array.from({ length: 132 }, (_, i) => {
    const l = `- NEW-${i} entry, a fixed description so the line carries real weight for line ${i}\n`;
    return l + l;
  }).join('');
}

// Timing 1: the pre-wash bytes come back BEFORE the look that would arm the crossing.
test('711 (t1) BEFORE the arm: pre-wash bytes back before the arming look, the look asks and washes nothing', () => {
  const c = makeCase('t1-before');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  runHook(c, 'SessionStart');
  fs.writeFileSync(c.mem, MEM_ORIG); // back before the look that arms
  const before = fs.readFileSync(c.mem, 'utf8');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the return must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the look asks; it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing: the store bytes are unchanged');
  assert.strictEqual(stateNow(c).returnAsk, true, 'the ask is marked once');
});

// Timing 2 (W708, F708-1's own witness): BETWEEN the arm and its Stop.
test('711 (W708) BETWEEN the arm and its Stop: a growth arm, the old bytes back, then an attended Stop asks and washes nothing', () => {
  const c = makeCase('w708');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  runHook(c, 'SessionStart');
  fs.writeFileSync(c.mem, growFresh());
  runHook(c, 'SessionStart'); // the growth arms a crossing at SessionStart
  assert.ok(calNs.sanitizeCrossing(stateNow(c).lastCrossing), 'precondition: a growth crossing is armed and pending');
  assert.ok(stateNow(c).postWash, 'precondition: growth leaves the wash episode standing (711 lifetime)');
  fs.writeFileSync(c.mem, MEM_ORIG); // the pre-wash bytes come back between the arm and its Stop
  const before = fs.readFileSync(c.mem, 'utf8');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the return must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'a return between the arm and its Stop asks, it is not the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing');
  assert.strictEqual(stateNow(c).returnAsk, true, 'the ask is marked once');
});

// Timing 3: AFTER a delivery. The growth is delivered, then the old bytes come back, and the next look asks.
test('711 (t3) AFTER a delivery: growth is delivered, then the old bytes back, and the next look asks and washes nothing', () => {
  const c = makeCase('t3-after');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  runHook(c, 'SessionStart');
  fs.writeFileSync(c.mem, growFresh());
  const grew = runHook(c, 'Stop');
  assert.ok(grew.nudge, 'precondition: the growth delivery went out');
  assert.ok(stateNow(c).postWash, 'precondition: the delivery leaves the wash episode standing');
  fs.writeFileSync(c.mem, MEM_ORIG); // the old bytes come back after the delivery
  const before = fs.readFileSync(c.mem, 'utf8');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the next look must ask; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the next look asks, it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing');
  assert.strictEqual(stateNow(c).returnAsk, true, 'the ask is marked once');
});

// Each FULL arm has its own witness. The FULL escalation arm: a plain FULL crossing consumed after a force, then an escalation.
test('711 (F-esc) the FULL escalation arm: a store back at its pre-wash bytes is asked, and the arm washes nothing', () => {
  const c = makeCase('full-esc');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG); // back at the pre-wash bytes
  const before = fs.readFileSync(c.mem, 'utf8');
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 1000, session: 'a' });
  calNs.consumeCrossing(c.home, c.proj, Date.now());
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'FULL', Date.now(), { quickTried: true, fatTokens: 2000, session: 'a' });
  assert.strictEqual(calNs.sanitizeCrossing(stateNow(c).lastCrossing).escalation, true, 'precondition: the FULL escalation arm fired');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the escalation must ask about the return; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the escalation asks about the return, it does not run the forced pass or the wizard');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing');
});

// The FULL re-loop arm: a consumed FULL crossing from another session, then growth with no force history.
test('711 (F-reloop) the FULL re-loop arm: a store back at its pre-wash bytes is asked, and the arm washes nothing', () => {
  const c = makeCase('full-reloop');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG);
  const before = fs.readFileSync(c.mem, 'utf8');
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 1000, session: 'a' });
  calNs.consumeCrossing(c.home, c.proj, Date.now());
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'FULL', Date.now(), { fatTokens: 2000, session: 'b' });
  const pending = calNs.sanitizeCrossing(stateNow(c).lastCrossing);
  assert.ok(pending && pending.escalation !== true, 'precondition: the FULL re-loop arm fired, not the escalation');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the re-loop must ask about the return; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the re-loop asks about the return, it does not run the forced pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing');
});

// F703-1: a bin-door restore closes the episode, so growth in another file later is never a return.
test('711 (F703-1) a bin-door restore closes the episode, so later growth in another file is never a return', () => {
  const c = makeCase('f703-711');
  fs.writeFileSync(path.join(c.proj, 'CLAUDE.md'), '# fixture project\n\n@memory/MEMORY.md\n@memory/other-note.md\n');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  const removed = Array.from({ length: DUP_N }, (_, i) => dupLines(i) + '\n').join('');
  const rec = recordBinItem(c.proj, FAT_BIN_NAME, { content: Buffer.from(removed), original: c.mem, origin: 'program-cut', now: Date.now() });
  const id = (rec && rec.id) || (listBin(c.proj, FAT_BIN_NAME)[0] || {}).id;
  assert.ok(id, 'the removed lines are in the fat bin under an id');
  const r = restore({ id, cwd: c.proj, home: c.home });
  assert.strictEqual(r.found, true, JSON.stringify(r));
  assert.strictEqual(stateNow(c).postWash, undefined, 'the bin door closes the wash episode');
  fs.writeFileSync(c.mem, MEM_ORIG); // the user writes the pre-wash file back by hand
  fs.writeFileSync(c.other, Array.from({ length: DUP_N }, (_, i) => `${dupLines(i + DUP_N)}\n${dupLines(i + DUP_N)}\n`).join(''));
  const look = runHook(c, 'Stop');
  assert.ok(look.nudge, 'growth in another file re-arms and nudges');
  assert.match(look.reason, /standing config authorizes the free mechanical Quick pass NOW/, 'growth gets the auto-Quick text, not the return ask');
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'growth after an undo is not a return');
});

// Roster: every pass-running delivery in the conductor sits behind the one return check, in source order.
test('711 roster: every pass-running delivery sits behind the one return check', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const checkAt = src.indexOf('caliper.returnMatches(proj)');
  const branchAt = src.indexOf('} else if (returned) {');
  assert.ok(checkAt > 0, 'the one return check exists in the conductor');
  assert.ok(branchAt > checkAt, 'the return branch comes after the one check');
  const sites = [...src.matchAll(/ask\.(obeseAutoQuick|forceAuto)\(/g)].map((m) => m.index);
  assert.ok(sites.length >= 2, `the roster finds the pass-running sites (found ${sites.length})`);
  for (const s of sites) assert.ok(s > branchAt, `a pass-running site at offset ${s} sits behind the return branch`);
});
