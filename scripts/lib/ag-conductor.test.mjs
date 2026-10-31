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
import { sweepWriteguard } from './writeguard.mjs';

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
// 29g fire 412: the AG transport reads only its own state namespace (coalwash/ag/state.json under the project's slug dir).
// Where the AG state is written: under ~/.gemini/coal/coalwash/ag/ (29g fire 417: never under ~/.claude).
function agStatePath(home, proj) {
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.gemini', 'coal', 'coalwash', 'ag', `state-${slug}.json`);
}
function seedAgPendingCrossing(home, proj) {
  const p = agStatePath(home, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    stateSchema: 1,
    lastCrossing: { band: 'OBESE', at: Date.now(), consumed: false },
    lastVerdict: { band: 'OBESE', reason: 'bmi', economical: false, fatTokens: 1234, at: Date.now() },
  }), 'utf8');
  return p;
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

test('Stop reads only the AG namespace: a pending Claude Code crossing is not consumed, and nothing prints', () => {
  const { home, proj } = sandbox();
  try {
    seedPendingCrossing(home, proj);
    const r = spawnAg(proj, home, ['Stop'], commonPayload(proj, { terminationReason: 'NO_TOOL_CALL', fullyIdle: true }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, '', 'the AG namespace holds no pending crossing of its own, so no decision line');
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

// 29g fire 416 branch 3: this test pinned the AG Stop's OBESE auto-Quick directive (one continue line, consumed at emission). The AG route
// no longer delivers it: the Quick pass is agent-run and no cli.mjs command reaches it on AG. Replaced by the no-directive form below (D8 covers FULL).
test('route Stop with AG discovery on delivers no directive for a pending OBESE crossing, and consumes nothing', async () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    seedAgPendingCrossing(home, proj); // the AG namespace (29g fire 412)
    const lines = await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: true });
    assert.deepStrictEqual(lines, [], 'no OBESE auto-Quick directive on AG');
    assert.strictEqual(JSON.parse(fs.readFileSync(agStatePath(home, proj), 'utf8')).lastCrossing.consumed, false, 'nothing is consumed on AG');
  } finally { clean(home, proj); }
});

test('route SessionStart with AG discovery on emits one injectSteps line, with no self-update nudge', async () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, 'GEMINI.md'), 'a'.repeat(100), 'utf8'); // the AG project rule file: the AG discovery reads it, not the Claude Code layout (29g fire 412)
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

// ---------------------------------------------------------------------------
// 29g fire 412 step 3 (unit D): the adapter. AG discovery is on; the AG route reads and writes only its own state namespace; the airbag
// guards the AG project rule file GEMINI.md on the AG route only (AGENTS.md was already a guarded basename on both routes).
// ---------------------------------------------------------------------------

function fileDigest(p) { return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : 'absent'; }

test('D3a the AG transport is on: the route is built with discovery enabled', () => {
  const { AG_DISCOVERY } = requireCjs(AG_HOOK);
  assert.strictEqual(AG_DISCOVERY, true, 'unit D turns the AG gauge and Stop on');
});

test('D3b the AG gauge and Stop leave a pending Claude Code crossing and its state file byte-identical', async () => {
  const { home, proj } = sandbox();
  try {
    seedPendingCrossing(home, proj);
    const before = fileDigest(projStatePath(home, proj));
    await routeIn(home, commonPayload(proj), 'SessionStart', { agDiscovery: true });
    await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: true });
    assert.strictEqual(fileDigest(projStatePath(home, proj)), before, 'the Claude Code state file is not rewritten by an AG session');
    assert.strictEqual(JSON.parse(fs.readFileSync(projStatePath(home, proj), 'utf8')).lastCrossing.consumed, false, 'and its crossing is not consumed');
  } finally { clean(home, proj); }
});

test('D3c the airbag snapshots the project GEMINI.md on the AG route, and never a GEMINI.md under HOME', async () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, 'GEMINI.md'), '# project rules\n', 'utf8');
    const homeGemini = path.join(home, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(homeGemini), { recursive: true });
    fs.writeFileSync(homeGemini, '# global rules\n', 'utf8');
    await routeIn(home, toolPayload(proj, 'edit_file', { Path: path.join(proj, 'GEMINI.md') }), 'PreToolUse', { agDiscovery: true });
    await routeIn(home, toolPayload(proj, 'edit_file', { Path: homeGemini }), 'PreToolUse', { agDiscovery: true });
    const snaps = [];
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('GEMINI.md--') && !e.name.endsWith('.origpath')) snaps.push(p); } };
    walk(wgRoot(proj));
    assert.strictEqual(snaps.length, 1, `exactly the project GEMINI.md is snapshotted (found ${snaps.length})`);
    assert.strictEqual(fs.readFileSync(snaps[0], 'utf8'), '# project rules\n', 'the snapshot holds the project file\'s original bytes');
  } finally { clean(home, proj); }
});

// 29g fire 412 step 4: multi_replace_file_content is a real AG write tool (INSPECT 309, t233 major: grep of agy.exe names it), with its
// path in TargetFile. Before this step the airbag took no snapshot of an edit made through it.
test('D4 multi_replace_file_content on MEMORY.md snapshots it, with the path in TargetFile', async () => {
  const { home, proj } = sandbox();
  try {
    await routeIn(home, toolPayload(proj, 'multi_replace_file_content', { TargetFile: path.join(proj, 'MEMORY.md'), ReplacementChunks: [] }), 'PreToolUse', { agDiscovery: true });
    const snaps = [];
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('MEMORY.md--') && !e.name.endsWith('.origpath')) snaps.push(p); } };
    walk(wgRoot(proj));
    assert.strictEqual(snaps.length, 1, `one snapshot of MEMORY.md through multi_replace_file_content (found ${snaps.length})`);
  } finally { clean(home, proj); }
});

// 29g fire 412 step 5: the F306-1 class for AG's folders. An AG conversation and a Claude Code session on one project share the
// writeguard root. The 24-hour floor keeps a LIVE folder of either route from being swept by the other; a folder idle past the floor
// is swept by either route, which is the design. Witnesses D5a, D5b and D5c.
function ageFolder(dir, ageMs) {
  const t = new Date(Date.now() - ageMs);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) fs.utimesSync(path.join(dir, e.name), t, t);
  fs.utimesSync(dir, t, t);
}
function plantSession(proj, sessionId) {
  const dir = path.join(wgRoot(proj), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md--witness'), 'snapshot bytes\n', 'utf8');
  return dir;
}
test('D5a a fresh Claude Code session folder survives the AG sweep, and a stale one is removed by it', async () => {
  const { home, proj } = sandbox();
  try {
    const fresh = plantSession(proj, 'cc-sess-live');
    const stale = plantSession(proj, 'cc-sess-old');
    ageFolder(stale, 25 * 60 * 60 * 1000);
    await routeIn(home, commonPayload(proj), 'SessionStart', { agDiscovery: false });
    assert.ok(fs.existsSync(fresh), 'a live CC session survives an AG session start');
    assert.ok(!fs.existsSync(stale), 'a CC session idle past the 24-hour floor is swept (the design)');
  } finally { clean(home, proj); }
});
test('D5b an AG conversation folder survives a Claude Code sweep while it is live', () => {
  const { home, proj } = sandbox();
  try {
    const agLive = plantSession(proj, CONVERSATION);
    sweepWriteguard(proj, 'cc-sess-current', {});
    assert.ok(fs.existsSync(agLive), 'a live AG conversation folder survives a CC sweep');
  } finally { clean(home, proj); }
});
test('D5c a stale AG conversation folder is removed by the Claude Code sweep', () => {
  const { home, proj } = sandbox();
  try {
    const agStale = plantSession(proj, PRIOR_CONVERSATION);
    ageFolder(agStale, 25 * 60 * 60 * 1000);
    sweepWriteguard(proj, 'cc-sess-current', {});
    assert.ok(!fs.existsSync(agStale), 'an AG folder idle past the floor is swept by CC too');
  } finally { clean(home, proj); }
});

// 29g fire 412 step 7 (the adapter's root, a correctness fix found while wiring the CLI): an AG project has GEMINI.md and no other root
// marker. From a subfolder the airbag must still find the project root, or its snapshot lands where the CLI never reads it.
test('D7b the AG airbag from a subfolder snapshots the project GEMINI.md under the project root, not under the subfolder', async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-d7b-home-')));
  const bare = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-d7b-proj-')));
  fs.mkdirSync(path.join(bare, '.git')); // an AG project is a repository: the root is the repository root (29g fire 417)
  try {
    const sub = path.join(bare, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(bare, 'GEMINI.md'), '# AG project rules\n', 'utf8');
    await routeIn(home, toolPayload(sub, 'edit_file', { Path: path.join(bare, 'GEMINI.md') }), 'PreToolUse', { agDiscovery: true });
    const underRoot = [];
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.startsWith('GEMINI.md--') && !e.name.endsWith('.origpath')) underRoot.push(p); } };
    walk(path.join(bare, '.claude', 'coalwash', 'writeguard'));
    assert.strictEqual(underRoot.length, 1, 'the snapshot is under the project root (the walk found GEMINI.md above the subfolder)');
    assert.ok(!fs.existsSync(path.join(sub, '.claude')), 'nothing is written under the subfolder');
  } finally { clean(home, bare); }
});

// 29g fire 416 part 2 (branch 3): the Quick pass is agent-run (method §1: "no code in this engine dedups… YOU, the agent, compute and edit by
// hand") and no cli.mjs command reaches it, so --platform cannot point it at AG's files. The AG Stop therefore delivers NO directive: no FULL
// force, no OBESE auto-Quick, no wizard ask. The SessionStart notices and the airbag stay on.
function seedAgFullCrossing(home, proj) {
  const p = agStatePath(home, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    stateSchema: 1,
    lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
    lastVerdict: { band: 'FULL', reason: 'bmi', economical: true, fatTokens: 90000, at: Date.now() },
  }), 'utf8');
  return p;
}
test('D8 the AG Stop delivers no directive, even for a pending FULL crossing, and leaves the crossing unconsumed', async () => {
  const { home, proj } = sandbox();
  try {
    seedAgFullCrossing(home, proj);
    const lines = await routeIn(home, commonPayload(proj), 'Stop', { agDiscovery: true });
    assert.deepStrictEqual(lines, [], 'no force, no OBESE auto-Quick, no wizard ask on AG');
    assert.strictEqual(JSON.parse(fs.readFileSync(agStatePath(home, proj), 'utf8')).lastCrossing.consumed, false, 'nothing is consumed: no directive was delivered');
  } finally { clean(home, proj); }
});

// 29g fire 417, fix 1: the AG project root is the REPOSITORY root (the nearest ancestor holding .git), not the nearest folder that holds a
// rule file. From a subfolder, the AG state sits under the repo-root slug, and the footprint counts the repo-root GEMINI.md AND sub/AGENTS.md.
test('F417-1 AG from a subfolder: the project root is the repository root, and the footprint counts both rule files', async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-f1-home-')));
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-f1-repo-')));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const rootGemini = path.join(repo, 'GEMINI.md');
    const subAgents = path.join(sub, 'AGENTS.md');
    fs.writeFileSync(rootGemini, 'r'.repeat(120), 'utf8');
    fs.writeFileSync(subAgents, 'a'.repeat(40), 'utf8');
    await routeIn(home, commonPayload(sub), 'SessionStart', { agDiscovery: true });
    const st = agStatePath(home, repo);
    assert.ok(fs.existsSync(st), `the AG state sits under the repository root slug: ${st}`);
    const lv = JSON.parse(fs.readFileSync(st, 'utf8')).lastVerdict;
    assert.strictEqual(lv.alwaysLoadedBytes, fs.statSync(rootGemini).size + fs.statSync(subAgents).size, 'the footprint counts the repo-root GEMINI.md and sub/AGENTS.md');
    assert.strictEqual(fs.existsSync(agStatePath(home, sub)), false, 'nothing is recorded under the subfolder slug');
  } finally { clean(home, repo); }
});

// 29g fire 417, fix 2: an AG-only box never gets a Claude Code base dir. The AG state lives under ~/.gemini/coal/coalwash/ag/ (AG's own
// dir), and nothing on the AG route creates ~/.claude. A ~/.claude created by AG would turn detectPlatform to claude-code on that box.
test('F417-2 an AG-only HOME: after an AG SessionStart and a PreToolUse edit there is still no ~/.claude, and the AG state is under ~/.gemini', async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-f2-home-')));
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-f2-repo-')));
  try {
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, 'GEMINI.md'), 'g'.repeat(120), 'utf8');
    await routeIn(home, commonPayload(repo), 'SessionStart', { agDiscovery: true });
    await routeIn(home, toolPayload(repo, 'edit_file', { Path: path.join(repo, 'GEMINI.md') }), 'PreToolUse', { agDiscovery: true });
    assert.strictEqual(fs.existsSync(path.join(home, '.claude')), false, 'no ~/.claude on an AG-only box after the AG route ran');
    const slug = fs.realpathSync.native(repo).replace(/[^A-Za-z0-9]/g, '-');
    const st = path.join(home, '.gemini', 'coal', 'coalwash', 'ag', `state-${slug}.json`);
    assert.ok(fs.existsSync(st), `the AG state is under ~/.gemini/coal/coalwash/ag/: ${st}`);
  } finally { clean(home, repo); }
});
