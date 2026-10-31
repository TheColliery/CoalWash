// Hermetic tests for hooks/ag-conductor.js — the Antigravity transport for the
// two conductor paths the AG hook contract can carry today: the 0p airbag
// (PreToolUse on a write tool) and the prior-session writeguard sweep
// (SessionStart). Stop and the gauge's SessionStart line stay behind
// AG_DISCOVERY = false (unit D, AG discovery, is not built yet), so their
// tests pin the gate: silent while it is off, one line each while a fixture
// drives the in-process route() with it on.
//
// Spawn tests run the REAL file as a child process with a sandboxed HOME and
// TEMP (hooks-safety.md §7); route() is imported in-process only where a test
// needs the emitted lines back, with the same HOME pinned for its duration.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const AG_HOOK = path.join(REPO, 'hooks', 'ag-conductor.js');
const CC_HOOK = path.join(REPO, 'hooks', 'coalwash-conductor.js');
const requireCjs = createRequire(import.meta.url);

const CONVERSATION = 'conv-cur-1';
const PRIOR_CONVERSATION = 'conv-old-0';

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-proj-')));
  // Root the project the same way the CC conductor tests do (stop-at-home walk).
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  fs.writeFileSync(path.join(proj, 'MEMORY.md'), '# Fixture memory\n\n- Marker: CW-AG-FIXTURE.\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'plain project file, not class-B\n', 'utf8');
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
function sandboxEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' };
}
function spawnAg(cwd, home, argv, stdin) {
  return spawnSync(process.execPath, [AG_HOOK, ...argv], {
    cwd,
    env: sandboxEnv(home),
    encoding: 'utf8',
    timeout: 20000,
    input: stdin === undefined ? undefined : (typeof stdin === 'string' ? stdin : JSON.stringify(stdin)),
  });
}
// The AG payload shape measured on agy 1.4.12 (probe run 301): common fields
// plus toolCall for the tool events. No session_id, no cwd.
function toolPayload(proj, toolName, args) {
  return { conversationId: CONVERSATION, workspacePaths: [proj], modelName: 'fixture', toolCall: { name: toolName, args }, stepIdx: 1 };
}
function commonPayload(proj, extra = {}) {
  return { conversationId: CONVERSATION, workspacePaths: [proj], transcriptPath: '', artifactDirectoryPath: '', modelName: 'fixture', lastUserInput: '', ...extra };
}
function writeGlobalCfg(home, cfg) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify(cfg), 'utf8');
}
function wgRoot(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }
function projStatePath(home, proj) {
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'coalwash', 'state.json');
}
function seedClassB(home, proj) {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(100), 'utf8');
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  const mem = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'i'.repeat(60), 'utf8');
}
// Same pending-crossing fixture the CC conductor's 0d case uses: an unconsumed
// OBESE crossing with a cached verdict, default (quick) exercise.
function seedPendingCrossing(home, proj) {
  const p = projStatePath(home, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    stateSchema: 1,
    lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
    lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
  }), 'utf8');
  return p;
}
function readState(home, proj) {
  return JSON.parse(fs.readFileSync(projStatePath(home, proj), 'utf8'));
}

// In-process route() with HOME pinned to the sandbox; the cwd the route moves
// into is restored afterwards so the runner's own cwd is never left changed.
async function routeIn(home, payload, event, opts) {
  const saved = { cwd: process.cwd(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const { route } = requireCjs(AG_HOOK);
    return await route(payload, event, opts);
  } finally {
    process.chdir(saved.cwd);
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.USERPROFILE;
  }
}

// ---------------------------------------------------------------------------
// The airbag, spawned for real. Stdout is silent: the airbag is write-only.
// ---------------------------------------------------------------------------

test('edit_file on MEMORY.md snapshots it under the conversation folder and prints nothing', () => {
  const { home, proj } = sandbox();
  try {
    const r = spawnAg(proj, home, ['PreToolUse'], toolPayload(proj, 'edit_file', { Path: 'MEMORY.md' }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'the airbag is write-only: nothing on stdout');
    assert.strictEqual(r.stderr, '', 'nothing on stderr either (Phoenix #13)');
    const snapDir = path.join(wgRoot(proj), CONVERSATION);
    assert.ok(fs.existsSync(snapDir), 'the conversation folder was created');
    const snaps = fs.readdirSync(snapDir).filter((n) => n !== '.gitignore');
    assert.ok(snaps.length >= 1, 'at least one snapshot file exists for MEMORY.md');
  } finally { clean(home, proj); }
});

test('write_file on an absolute MEMORY.md path snapshots it the same way', () => {
  const { home, proj } = sandbox();
  try {
    const abs = path.join(proj, 'MEMORY.md');
    const r = spawnAg(proj, home, ['PreToolUse'], toolPayload(proj, 'write_file', { file_path: abs }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '');
    assert.ok(fs.existsSync(path.join(wgRoot(proj), CONVERSATION)), 'absolute path resolved and snapshotted');
  } finally { clean(home, proj); }
});

test('read_file and an edit to a non-class-B file write no snapshot', () => {
  const { home, proj } = sandbox();
  try {
    const read = spawnAg(proj, home, ['PreToolUse'], toolPayload(proj, 'read_file', { Path: 'MEMORY.md' }));
    assert.strictEqual(read.status, 0, read.stderr);
    const plain = spawnAg(proj, home, ['PreToolUse'], toolPayload(proj, 'edit_file', { Path: 'notes.txt' }));
    assert.strictEqual(plain.status, 0, plain.stderr);
    assert.strictEqual(plain.stdout, '');
    assert.ok(!fs.existsSync(path.join(wgRoot(proj), CONVERSATION)), 'no snapshot for a read or a non-governance write');
  } finally { clean(home, proj); }
});

test('a tool outside the write set (run_command) never reaches the airbag', () => {
  const { home, proj } = sandbox();
  try {
    const r = spawnAg(proj, home, ['PreToolUse'], toolPayload(proj, 'run_command', { CommandLine: 'echo hi > MEMORY.md' }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(wgRoot(proj), CONVERSATION)), 'a shell write is outside the airbag by design');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SessionStart: the writeguard sweep runs on AG too.
// ---------------------------------------------------------------------------

test('SessionStart sweeps prior-conversation snapshots and keeps the current one, silently', () => {
  const { home, proj } = sandbox();
  try {
    const prior = path.join(wgRoot(proj), PRIOR_CONVERSATION);
    const current = path.join(wgRoot(proj), CONVERSATION);
    fs.mkdirSync(prior, { recursive: true });
    fs.writeFileSync(path.join(prior, 'stale.snap'), 'old', 'utf8');
    // 29f F306-1: the prior conversation is 25 h idle, so the sweep may remove it. A fresh one is another live session's.
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(path.join(prior, 'stale.snap'), aged, aged);
    fs.utimesSync(prior, aged, aged);
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'live.snap'), 'new', 'utf8');
    const r = spawnAg(proj, home, ['SessionStart'], commonPayload(proj));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'with AG discovery off, SessionStart prints nothing');
    assert.ok(!fs.existsSync(prior), 'the prior conversation folder is gone');
    assert.ok(fs.existsSync(path.join(current, 'live.snap')), 'the current conversation folder is kept');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// Robustness: every bad input exits 0 and prints nothing.
// ---------------------------------------------------------------------------

test('garbage stdin, a missing workspace, and a missing conversationId all exit 0 silently', () => {
  const { home, proj } = sandbox();
  try {
    const garbage = spawnAg(proj, home, ['PreToolUse'], '{not json');
    assert.strictEqual(garbage.status, 0, garbage.stderr);
    assert.strictEqual(garbage.stdout, '');
    const noWorkspace = spawnAg(proj, home, ['PreToolUse'], { conversationId: CONVERSATION, toolCall: { name: 'edit_file', args: { Path: 'MEMORY.md' } } });
    assert.strictEqual(noWorkspace.status, 0, noWorkspace.stderr);
    assert.strictEqual(noWorkspace.stdout, '');
    const noConversation = spawnAg(proj, home, ['PreToolUse'], { workspacePaths: [proj], toolCall: { name: 'edit_file', args: { Path: 'MEMORY.md' } } });
    assert.strictEqual(noConversation.status, 0, noConversation.stderr);
    assert.strictEqual(noConversation.stdout, '');
    assert.ok(!fs.existsSync(wgRoot(proj)), 'none of the bad inputs wrote a snapshot');
  } finally { clean(home, proj); }
});

test('an unknown event name, and no event name at all, exit 0 silently', () => {
  const { home, proj } = sandbox();
  try {
    const unknown = spawnAg(proj, home, ['Bogus'], commonPayload(proj));
    assert.strictEqual(unknown.status, 0, unknown.stderr);
    assert.strictEqual(unknown.stdout, '');
    const none = spawnAg(proj, home, [], commonPayload(proj));
    assert.strictEqual(none.status, 0, none.stderr);
    assert.strictEqual(none.stdout, '');
  } finally { clean(home, proj); }
});

test('Stop with AG discovery off prints nothing and leaves a pending crossing unconsumed', () => {
  const { home, proj } = sandbox();
  try {
    seedPendingCrossing(home, proj);
    const r = spawnAg(proj, home, ['Stop'], commonPayload(proj, { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'Stop is off until unit D: no decision line');
    assert.strictEqual(readState(home, proj).lastCrossing.consumed, false, 'the CC crossing is not consumed by an AG Stop');
  } finally { clean(home, proj); }
});

test('requiring the CC conductor prints nothing and exports its handlers, under a HOME the test owns', (t) => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-require-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The probe echoes the HOME it ran under, so the witness is the HOME itself, never a comment about it.
  const probe = `const m = require(${JSON.stringify(CC_HOOK)}); process.stdout.write('KEYS:' + Object.keys(m).sort().join(',') + '|HOME:' + process.env.HOME);`;
  const r = spawnSync(process.execPath, ['-e', probe], { cwd: REPO, encoding: 'utf8', timeout: 20000, env: sandboxEnv(home) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, `KEYS:handleAirbag,handleSessionStart,handleStop,lib,readStdinJson|HOME:${home}`,
    'require is silent (no main() run), the five handlers are exported, and the probe ran under the test-owned HOME');
});

// ---------------------------------------------------------------------------
// The gated outputs, in-process through route(): one line each while
// AG discovery is on, none while it is off.
// ---------------------------------------------------------------------------

test('route Stop with AG discovery on emits one continue line for a pending crossing, then silent', async () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    seedPendingCrossing(home, proj);
    const lines = await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: true });
    assert.strictEqual(lines.length, 1, 'exactly one decision line');
    const decision = JSON.parse(lines[0]);
    assert.strictEqual(decision.decision, 'continue', 'AG blocks a stop with decision "continue"');
    assert.ok(decision.reason.includes('memory crossed the OBESE ceiling'), decision.reason);
    assert.ok(decision.reason.includes('Quick pass NOW, no ask'), decision.reason);
    assert.strictEqual(readState(home, proj).lastCrossing.consumed, true, 'consumed at emission');
    const again = await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: true });
    assert.deepStrictEqual(again, [], 'a second Stop for the same crossing stays silent');
  } finally { clean(home, proj); }
});

test('route SessionStart with AG discovery on emits one injectSteps line, with no self-update nudge', async () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    writeGlobalCfg(home, { scanEverything: true });
    const lines = await routeIn(home, commonPayload(proj), 'SessionStart', { agDiscovery: true });
    assert.strictEqual(lines.length, 1, 'exactly one line when the gauge has something to say');
    const doc = JSON.parse(lines[0]);
    assert.ok(Array.isArray(doc.injectSteps) && doc.injectSteps.length === 1, lines[0]);
    const text = doc.injectSteps[0].ephemeralMessage;
    assert.ok(text.includes('scanEverything is ON'), text);
    assert.ok(!text.includes('self-update due'), 'AG never gets the update nudge (updateNudge: false)');
  } finally { clean(home, proj); }
});

test('route SessionStart with AG discovery off emits nothing, even when the gauge has a line to say', async () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    writeGlobalCfg(home, { scanEverything: true });
    const lines = await routeIn(home, commonPayload(proj), 'SessionStart', { agDiscovery: false });
    assert.deepStrictEqual(lines, [], 'the gauge line waits for unit D');
  } finally { clean(home, proj); }
});

test('route Stop with AG discovery off returns nothing and does not consume the crossing', async () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    seedPendingCrossing(home, proj);
    const lines = await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: false });
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(readState(home, proj).lastCrossing.consumed, false);
  } finally { clean(home, proj); }
});
