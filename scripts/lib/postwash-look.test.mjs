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
function runHook(c, event, { stopActive = false } = {}) {
  const payload = { session_id: `cwpw-${c.name}`, hook_event_name: event, cwd: c.proj, transcript_path: path.join(c.base, 'transcript.jsonl') };
  if (event === 'SessionStart') payload.source = 'startup';
  if (event === 'Stop') payload.stop_hook_active = stopActive;
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: c.home, USERPROFILE: c.home, TEMP: ROOT, TMP: ROOT, TMPDIR: ROOT,
    CLAUDE_PROJECT_DIR: c.proj, CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), CLAUDE_PLUGIN_DATA: path.join(ROOT, 'pdata'),
    NODE_OPTIONS: '--max-old-space-size=2048',
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
  const look = runHook(c, 'Stop');
  t.diagnostic(`re-armed nudge after the outside copy: ${look.reason.slice(0, 600)}`);
  assert.ok(look.nudge, `the returned copy must be seen at the next look; got stdout: ${look.out.slice(0, 200)}`);
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
