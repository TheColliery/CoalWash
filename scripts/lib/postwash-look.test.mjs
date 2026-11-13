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
// CW_TEST_HOOK lets a mutation check point the same witnesses at a temporary copy of the hook (it must sit beside the real hook, so its ../scripts/lib imports resolve). Unset in every real run.
const HOOK = process.env.CW_TEST_HOOK || path.resolve(HERE, '..', '..', 'hooks', 'coalwash-conductor.js');

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
function runHook(c, event, { stopActive = false, attended = false, session = null } = {}) {
  const payload = { session_id: session || `cwpw-${c.name}`, hook_event_name: event, cwd: c.proj, transcript_path: path.join(c.base, 'transcript.jsonl') };
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
  return { status: r.status, out, nudge: !!(json && json.decision === 'block'), reason: json && json.reason ? String(json.reason) : '', system: json && json.systemMessage ? String(json.systemMessage) : '' };
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
// 709: the final look is attended by default, because the attended ask is what marks the episode asked; { attended: false } is the unattended return.
function returnFlow(c, content, { attended = true } = {}) {
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, content);
  return runHook(c, 'Stop', { attended });
}
const stateNow = (c) => loadState(c.proj, c.home);

test('699 (e): a look that finds the store back at its pre-wash content marks the crossing for an ask', () => {
  const c = makeCase('return-e');
  returnFlow(c, MEM_ORIG);
  assert.strictEqual(stateNow(c).returnAsk, true, 'the look at the pre-wash level is a return, so an ask is marked');
});

test('699 (f): growth past the pre-wash level re-arms with no ask marked', () => {
  const c = makeCase('growth-f');
  // growth with none of the removed text back (717 row 4): the pre-wash copies stay out, so this is not a return
  const grown = MEM_DEDUP + Array.from({ length: DUP_N }, (_, i) => `${dupLines(i + DUP_N)}
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
  runHook(c, 'Stop', { attended: true }); // 709: the attended look is the one that marks the return asked
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

// ---- 709 (ruling 2, main 2026-11-13): an unattended return washes nothing and leaves the ask ARMED; the next attended look asks ----
const CLI_PATH_709 = path.resolve(HERE, 'cli.mjs');

test('709 (j): unattended, a return emits no block, a systemMessage that says it will be asked when a user is present, said once per session; the store is unchanged', () => {
  const c = makeCase('unattended-709j');
  const look = returnFlow(c, MEM_ORIG, { attended: false });
  assert.strictEqual(look.nudge, false, `an unattended return must not hold the stop; got: ${look.out.slice(0, 200)}`);
  assert.match(look.system, /Nothing was washed/, `the user is told nothing was washed; systemMessage: ${look.system}`);
  assert.match(look.system, /asked about when a user is present/, `the unattended text names the next ask; systemMessage: ${look.system}`);
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'the store is unchanged');
  assert.strictEqual(runHook(c, 'Stop').system, '', 'the line is said once per session, so the second unattended Stop is silent');
});

test('709 (s): an unattended Stop after a return washes nothing and leaves the ask armed; the next attended Stop asks, with no growth in between', () => {
  const c = makeCase('armed-709s');
  returnFlow(c, MEM_ORIG, { attended: false }); // the unattended Stop
  const before = fs.readFileSync(c.mem, 'utf8');
  runHook(c, 'Stop'); // a second unattended look in the same session
  const s = stateNow(c);
  assert.notStrictEqual(calNs.sanitizeCrossing(s.lastCrossing), null, 'the crossing stays pending: an unattended look does not consume it');
  assert.notStrictEqual(s.returnAsk, true, 'an unattended look does not mark the episode asked');
  const look = runHook(c, 'Stop', { attended: true });
  assert.strictEqual(look.nudge, true, `the next attended Stop asks; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, /came back to the content it had before the last wash/, 'the attended look asks; it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing: the store bytes are unchanged');
  assert.strictEqual(stateNow(c).returnAsk, true, 'the attended ask marks the episode asked');
});

test('709 (k): return-leave answers "leave it", exits 0, and the next attended look is silent', () => {
  const c = makeCase('leave-709k');
  returnFlow(c, MEM_ORIG, { attended: false });
  const asked = runHook(c, 'Stop', { attended: true });
  assert.strictEqual(asked.nudge, true, `the attended look asks first; got: ${asked.out.slice(0, 200)}`);
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: c.home, USERPROFILE: c.home, TEMP: ROOT, TMP: ROOT, TMPDIR: ROOT,
    CLAUDE_PROJECT_DIR: c.proj, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: path.join(ROOT, 'pdata'),
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  const r = spawnSync(process.execPath, [CLI_PATH_709, 'return-leave'], { cwd: c.proj, env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  assert.strictEqual(r.status, 0, `return-leave must exit 0; stderr: ${String(r.stderr).slice(0, 300)}`);
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'the return mark is cleared');
  assert.strictEqual(stateNow(c).postWash, undefined, 'the wash episode is cleared');
  assert.strictEqual(runHook(c, 'Stop', { attended: true }).out, '', 'the next attended look is silent');
});

// ---- 717 (BB-474): a store counts as returned when TEXT the last wash removed is back, whatever else changed ----
// The wash removes the SECOND copy of every DUP line (MEM_ORIG -> MEM_DEDUP): one removed occurrence per DUP line.
// washThenWrite717: arm, wash, write `content`, then an ATTENDED look (the ask is what the rows judge).
function washThenWrite717(c, content) {
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, content);
  return runHook(c, 'Stop', { attended: true });
}

// Witness 1 (row 2): a restored copy plus one added line is asked about, with the bytes unchanged.
test('717 witness 1 (row 2): a restored copy with one line added is asked about, and washes nothing', () => {
  const c = makeCase('w717-1');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG + OTHER_NOTE);
  const before = fs.readFileSync(c.mem, 'utf8');
  const look = runHook(c, 'Stop', { attended: true });
  assert.ok(look.nudge, `the copy with a line added must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the look asks; it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), before, 'the look washes nothing: the store bytes are unchanged');
});

// Witness 2 (row 4): a file that merely grew, with none of the removed text back, is NOT asked, and behaves as today.
test('717 witness 2 (row 4): a file that merely grew, with none of the removed text back, is not asked', () => {
  const c = makeCase('w717-2');
  const look = returnFlow(c, growFresh());
  assert.ok(look.nudge, 'the growth re-arms and nudges, as today');
  assert.match(look.reason, /standing config authorizes the free mechanical Quick pass NOW/, 'growth keeps the auto-Quick text');
  assert.doesNotMatch(look.reason, ASK_TEXT, 'no removed text came back, so growth is not a return');
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'no return mark');
});

test('717 (row 1): the exact old copy back is asked about', () => {
  const look = washThenWrite717(makeCase('row1'), MEM_ORIG);
  assert.ok(look.nudge, `the exact copy must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the exact old copy is a return');
});

test('717 (row 3): only SOME of the removed text back is asked about', () => {
  const look = washThenWrite717(makeCase('row3'), MEM_DEDUP + Array.from({ length: 5 }, (_, i) => dupLines(i) + '\n').join(''));
  assert.ok(look.nudge, `some removed text back must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'five removed lines back is a return');
});

test('717 (row 5): removed text typed back by hand is asked about', () => {
  const look = washThenWrite717(makeCase('row5'), MEM_DEDUP + dupLines(7) + '\n');
  assert.ok(look.nudge, `one removed line typed back must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the typed-back removed line is a return');
});

test('717 (row 6): a removed duplicate whose other copy stayed is not asked while nothing changed, and is asked once its occurrence is back', () => {
  const c = makeCase('row6');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  const quiet1 = runHook(c, 'Stop', { attended: true });
  const quiet2 = runHook(c, 'Stop', { attended: true });
  assert.doesNotMatch(quiet1.reason, ASK_TEXT, 'an untouched store whose duplicate went is not asked about');
  assert.doesNotMatch(quiet2.reason, ASK_TEXT, 'and it is never asked about on a later look');
  fs.writeFileSync(c.mem, MEM_DEDUP + dupLines(0) + '\n'); // the removed occurrence itself comes back
  const back = runHook(c, 'Stop', { attended: true });
  assert.ok(back.nudge, `the removed occurrence back must be asked about; got stdout: ${back.out.slice(0, 200)}`);
  assert.match(back.reason, ASK_TEXT, 'the removed occurrence back is a return');
});

// Row 7: line endings and trailing blanks changed, the text the same: asked. Normalised: CRLF and trailing spaces/tabs per line.
test('717 (row 7): removed text back with line endings and trailing blanks changed is asked about', () => {
  const look = washThenWrite717(makeCase('row7'), MEM_ORIG.replace(/\n/g, '  \r\n'));
  assert.ok(look.nudge, `the same text with other line endings must be asked about; got stdout: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, ASK_TEXT, 'the normalised text is the removed text back');
});

test('717 (row 8): after "leave it" the same return is not asked again, and a later growth is ordinary', () => {
  const c = makeCase('row8');
  const first = washThenWrite717(c, MEM_ORIG);
  assert.match(first.reason, ASK_TEXT, 'precondition: the return was asked');
  calNs.answerReturnLeave(c.home, c.proj);
  const again = runHook(c, 'Stop', { attended: true });
  assert.strictEqual(again.out, '', 'the same copy is not asked about again after leave it');
  fs.writeFileSync(c.mem, MEM_ORIG + growFresh().slice(MEM_DEDUP.length)); // growth past the leave-it plateau (the 132 new pairs alone sit under it)
  const grow = runHook(c, 'Stop', { attended: true });
  assert.ok(grow.nudge, 'later growth nudges, as ordinary growth does');
  assert.match(grow.reason, /standing config authorizes the free mechanical Quick pass NOW/, 'later growth gets the auto-Quick text');
  assert.doesNotMatch(grow.reason, ASK_TEXT, 'and it is not a return');
});

// 720 (F718-1): a dev-era postWash with no `removed` record (the shape before the line rule) reads as no return: it never asks.
test('720 (F718-1): a dev-era postWash with no removed record never asks', () => {
  const c = makeCase('dev-era-720');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  const sp = calNs.statePath(c.proj, c.home);
  const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
  j.postWash = { at: Date.now(), preHashes: { [c.mem]: 'x'.repeat(64) } };
  fs.writeFileSync(sp, JSON.stringify(j));
  fs.writeFileSync(c.mem, MEM_ORIG); // the pre-wash bytes are back
  const look = runHook(c, 'Stop', { attended: true });
  assert.doesNotMatch(look.reason, ASK_TEXT, 'a postWash with no removed record is not a return');
  assert.strictEqual(stateNow(c).returnAsk, undefined, 'no return mark');
});

// 720 (F718-2): more removed lines than REMOVED_LINE_CAP: the untracked count is recorded beside the keys, not inside them.
const BIG_N = 1100;
const BIG_ORIG = '# Memory\n\n' + Array.from({ length: BIG_N }, (_, i) => `${dupLines(i)}\n${dupLines(i)}\n`).join('');
const BIG_DEDUP = '# Memory\n\n' + Array.from({ length: BIG_N }, (_, i) => `${dupLines(i)}\n`).join('');
test('720 (F718-2): removed lines past the cap are counted as untracked, beside the keys', () => {
  const c = makeCase('cap-720');
  fs.writeFileSync(c.mem, BIG_ORIG);
  armAndConsume(c);
  const w = applyPlan(plan(c, [{ type: 'rewrite', path: c.mem, content: BIG_DEDUP, expectedOrig: BIG_ORIG }]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  const pw = stateNow(c).postWash;
  const key = path.resolve(c.mem);
  assert.strictEqual(Object.keys(pw.removed[key]).length, calNs.REMOVED_LINE_CAP, 'the kept keys are the cap');
  assert.strictEqual(pw.untracked[key], BIG_N - calNs.REMOVED_LINE_CAP, 'the untracked count is recorded');
  assert.ok(Object.keys(pw.removed[key]).every((k) => /^[0-9a-f]{16}$/.test(k)), 'no count lives in the key space');
});

// ---- 719 row 9: an attended ask left unanswered is paced once per session, asked again at the next session's look, and nothing is washed meanwhile ----
test('719 (t): an unanswered attended ask is asked once per session, asked again next session, washes nothing, and return-leave closes it', () => {
  const c = makeCase('row9-719t');
  returnFlow(c, MEM_ORIG, { attended: false }); // the unattended return: the crossing is armed, nothing asked yet
  const first = runHook(c, 'Stop', { attended: true, session: 'sess-A' });
  assert.strictEqual(first.nudge, true, `the first attended look asks; got: ${first.out.slice(0, 200)}`);
  const memAfterAsk = fs.readFileSync(c.mem, 'utf8');
  const second = runHook(c, 'Stop', { attended: true, session: 'sess-A' });
  assert.strictEqual(second.out, '', 'a second attended look in the same session is silent');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), memAfterAsk, 'nothing is washed between the looks');
  const next = runHook(c, 'Stop', { attended: true, session: 'sess-B' });
  assert.strictEqual(next.nudge, true, `the next session's attended look asks again, with no growth; got: ${next.out.slice(0, 200)}`);
  assert.match(next.reason, /came back to the content it had before the last wash/, 'the look asks; it does not run the auto-Quick pass');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'the store is still at its pre-wash content');
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: c.home, USERPROFILE: c.home, TEMP: ROOT, TMP: ROOT, TMPDIR: ROOT,
    CLAUDE_PROJECT_DIR: c.proj, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: path.join(ROOT, 'pdata'),
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  const r = spawnSync(process.execPath, [CLI_PATH_709, 'return-leave'], { cwd: c.proj, env, encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL', windowsHide: true });
  assert.strictEqual(r.status, 0, `return-leave must exit 0; stderr: ${String(r.stderr).slice(0, 300)}`);
  assert.strictEqual(runHook(c, 'Stop', { attended: true, session: 'sess-C' }).out, '', 'after return-leave nothing is asked');
});

// ---- 725 (F712-1): each arm that re-arms a return clears the asked mark, so growth asks again in the same session ----
// One witness per arm. Each reaches its arm while a return stands (postWash matches), so only that arm's clear can let the
// next look ask again. A mutant that deletes one clear turns exactly its witness red. The FULL arms are reached at state level
// (recordCrossing), because a hook-level FULL needs a store above the FULL ceiling; the return they re-arm is the hook's own.
// The asked mark stays set for this session until an arm clears it.
test('725 (rise): a rise onto a standing return asks, and the next rise re-asks in the same session', () => {
  const c = makeCase('725-rise');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  runHook(c, 'SessionStart');
  assert.strictEqual(stateNow(c).lastVerdict.band, 'LEAN', 'precondition: the washed store reads LEAN');
  fs.writeFileSync(c.mem, MEM_ORIG); // the pre-wash bytes back: a rise onto a return
  const first = runHook(c, 'Stop', { attended: true });
  assert.match(first.reason, ASK_TEXT, 'the rise asks about the return');
  assert.strictEqual(runHook(c, 'Stop', { attended: true }).out, '', 'a second Stop in the same session is silent');
  fs.writeFileSync(c.mem, MEM_DEDUP);
  runHook(c, 'SessionStart');
  assert.strictEqual(stateNow(c).lastVerdict.band, 'LEAN', 'precondition: back to LEAN');
  fs.writeFileSync(c.mem, MEM_ORIG); // the rise re-arms through its own arm
  const again = runHook(c, 'Stop', { attended: true });
  assert.match(again.reason, ASK_TEXT, 'the re-armed rise asks again in the same session');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'nothing washed');
});

test('725 (FULL escalation): an escalation onto a standing return asks, and the next escalation re-asks in the same session', () => {
  const c = makeCase('725-esc');
  const S = `cwpw-${c.name}`;
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG);
  assert.match(runHook(c, 'Stop', { attended: true }).reason, ASK_TEXT, 'the return is asked');
  assert.strictEqual(runHook(c, 'Stop', { attended: true }).out, '', 'a second Stop in the same session is silent');
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 1000, session: S });
  calNs.consumeCrossing(c.home, c.proj, Date.now());
  calNs.markReturnAsked(c.home, c.proj, S); // the rise above cleared the mark: set it for this session again
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'FULL', Date.now(), { quickTried: true, fatTokens: 2000, session: S });
  assert.strictEqual(calNs.sanitizeCrossing(stateNow(c).lastCrossing).escalation, true, 'precondition: the FULL escalation arm fired');
  const again = runHook(c, 'Stop', { attended: true });
  assert.match(again.reason, ASK_TEXT, 'the escalation re-asks about the return in the same session');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'nothing washed');
});

test('725 (FULL re-loop): a FULL re-loop onto a standing return asks, and the next re-loop re-asks in the same session', () => {
  const c = makeCase('725-reloop');
  const S = `cwpw-${c.name}`;
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG);
  assert.match(runHook(c, 'Stop', { attended: true }).reason, ASK_TEXT, 'the return is asked');
  assert.strictEqual(runHook(c, 'Stop', { attended: true }).out, '', 'a second Stop in the same session is silent');
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'OBESE', Date.now(), { fatTokens: 1000, session: S });
  calNs.consumeCrossing(c.home, c.proj, Date.now());
  calNs.markReturnAsked(c.home, c.proj, S);
  calNs.recordCrossing(c.home, c.proj, 'FULL', 'FULL', Date.now(), { fatTokens: 2000, session: 'sess-other' });
  const pending = calNs.sanitizeCrossing(stateNow(c).lastCrossing);
  assert.ok(pending && pending.escalation !== true, 'precondition: the FULL re-loop arm fired, not the escalation');
  const again = runHook(c, 'Stop', { attended: true });
  assert.match(again.reason, ASK_TEXT, 'the re-loop re-asks about the return in the same session');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), MEM_ORIG, 'nothing washed');
});

test('725 (OBESE re-loop): growth past the watermark onto a standing return asks, and the next growth re-asks in the same session', () => {
  const c = makeCase('725-obese');
  armAndConsume(c);
  const w = applyPlan(plan(c, [dedupAction(c)]), opts(c));
  assert.strictEqual(w.ok, true, w.error);
  fs.writeFileSync(c.mem, MEM_ORIG);
  assert.match(runHook(c, 'Stop', { attended: true }).reason, ASK_TEXT, 'the return is asked');
  assert.strictEqual(runHook(c, 'Stop', { attended: true }).out, '', 'a second Stop in the same session is silent');
  const grown = MEM_ORIG + growFresh().slice(MEM_DEDUP.length); // the removed copies stay back; new fat grows past the watermark
  fs.writeFileSync(c.mem, grown);
  const again = runHook(c, 'Stop', { attended: true });
  assert.match(again.reason, ASK_TEXT, 'the OBESE re-loop re-asks about the return in the same session');
  assert.strictEqual(fs.readFileSync(c.mem, 'utf8'), grown, 'nothing washed');
});

// ---- 727 d2: an unattended return keeps the crossing armed; once the removed text goes again, the armed crossing is delivered exactly once ----
test('727 (d2): an unattended return keeps the crossing armed, and the armed crossing is delivered once the removed text leaves again', () => {
  const c = makeCase('d2-727');
  returnFlow(c, MEM_ORIG, { attended: false }); // the unattended return: the crossing stays armed, nothing is washed
  assert.ok(calNs.sanitizeCrossing(stateNow(c).lastCrossing), 'precondition: the unattended return leaves the crossing armed, not consumed');
  fs.writeFileSync(c.mem, MEM_DEDUP); // the removed text goes again (the user deletes the restored copy), so the return stops matching
  const look = runHook(c, 'Stop'); // the crossing is still armed: it is delivered as an ordinary pending crossing
  assert.strictEqual(look.nudge, true, `the armed crossing is delivered once the return no longer matches; got: ${look.out.slice(0, 200)}`);
  assert.match(look.reason, /standing config authorizes the free mechanical Quick pass NOW/, 'the ordinary auto-Quick text, as a growth crossing would carry');
  assert.strictEqual(runHook(c, 'Stop').out, '', 'delivered once: the next look is silent');
});
