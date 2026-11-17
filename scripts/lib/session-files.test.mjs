// 29ig fire 813 (CW-055, the marker with no remover): does any per-session file the shipped hooks write outlive every hook and sweep?
// The shipped hooks run here as a user's install runs them: the Claude Code route from plugin/hooks/hooks.json (coalwash-conductor.js,
// no argv) and the Antigravity route from plugin/hooks.json (ag-conductor.js <Event>). Each route runs every wired event for session A,
// then for session B, in a sandbox (TEMP/TMP/TMPDIR/HOME/USERPROFILE at a temp folder, the project another temp folder).
// A per-session file is a new path whose name carries the session id. The CoalWash hooks write one kind: the writeguard snapshot under
// <project>/.claude/coalwash/writeguard/<session>/. The 29ep reading says the next SessionStart sweeps it; this measures it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WRITEGUARD_LIVE_MS } from './writeguard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = path.join(REPO, 'plugin');
const STEP_TIMEOUT_MS = 60_000;
const SESSION_A = 'cw055-session-a';
const SESSION_B = 'cw055-session-b';
const CLEAR_KEYS = ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CONFIG_DIR'];

function sandbox(t) {
  const tmp = fs.realpathSync.native(os.tmpdir());
  const home = fs.mkdtempSync(path.join(tmp, 'cw055-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proj = fs.mkdtempSync(path.join(tmp, 'cw055-proj-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  fs.writeFileSync(path.join(proj, 'MEMORY.md'), '# Fixture memory\n\n- Marker: CW-055.\n', 'utf8');
  const env = { ...process.env };
  for (const k of CLEAR_KEYS) delete env[k];
  return { home, proj, env: { ...env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home } };
}

// Every file under the two sandbox roots, as paths relative to the root they sit under.
function listing(sb) {
  const out = [];
  const walk = (root, label, rel = '') => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, d.name) : d.name;
      if (d.isDirectory()) walk(root, label, r); else out.push(`${label}:${r.split(path.sep).join('/')}`);
    }
  };
  walk(sb.home, 'home');
  walk(sb.proj, 'proj');
  return out.sort();
}

function spawnHook(sb, script, argv, payload) {
  const r = spawnSync(process.execPath, [script, ...argv], { cwd: sb.proj, env: sb.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: STEP_TIMEOUT_MS });
  assert.equal(r.error, undefined, `${path.basename(script)} ${argv.join(' ')}: ran without timing out`);
  assert.equal(r.status, 0, `${path.basename(script)} ${argv.join(' ')}: exits 0 (${String(r.stderr).slice(0, 200)})`);
}

// The Claude Code route: every event plugin/hooks/hooks.json wires, in session order.
function ccSession(sb, session) {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'], 'the CC manifest wires four events');
  const script = path.join(PLUGIN, 'hooks', 'coalwash-conductor.js');
  const mem = path.join(sb.proj, 'MEMORY.md');
  const base = { session_id: session, cwd: sb.proj, transcript_path: path.join(sb.home, `${session}.jsonl`) };
  spawnHook(sb, script, [], { ...base, hook_event_name: 'SessionStart', source: 'startup' });
  spawnHook(sb, script, [], { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: mem } });
  fs.appendFileSync(mem, `- Edited in ${session}.\n`);
  spawnHook(sb, script, [], { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: mem } });
  spawnHook(sb, script, [], { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {} });
  spawnHook(sb, script, [], { ...base, hook_event_name: 'Stop', stop_hook_active: false });
}

// The Antigravity route: every event plugin/hooks.json wires, with the measured agy payload shape.
function agSession(sb, session) {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.coalwash).sort(), ['PreToolUse', 'SessionStart', 'Stop'], 'the AG manifest wires three events');
  const base = { conversationId: session, workspacePaths: [sb.proj], modelName: 'fixture', stepIdx: 1 };
  const script = path.join(PLUGIN, 'hooks', 'ag-conductor.js');
  spawnHook(sb, script, ['SessionStart'], base);
  spawnHook(sb, script, ['PreToolUse'], { ...base, toolCall: { name: 'edit_file', args: { Path: 'MEMORY.md' } } });
  fs.appendFileSync(path.join(sb.proj, 'MEMORY.md'), `- Edited in ${session}.\n`);
  spawnHook(sb, script, ['Stop'], base);
}

const carries = (p, session) => p.includes(session);

// Ages every file and folder under the writeguard folder of a session past the live window, as a day passing would.
function ageSession(sb, session) {
  const dir = path.join(sb.proj, '.claude', 'coalwash', 'writeguard', session);
  const old = new Date(Date.now() - WRITEGUARD_LIVE_MS - 60 * 60 * 1000);
  for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), old, old);
  fs.utimesSync(dir, old, old);
}

for (const [route, runSession] of [['Claude Code', ccSession], ['Antigravity', agSession]]) {
  test(`${route} route: the only per-session files are the writeguard snapshots, and the next session's SessionStart removes them once past the live window`, (t) => {
    const sb = sandbox(t);
    const before = listing(sb);
    runSession(sb, SESSION_A);
    const afterA = listing(sb);
    const newA = afterA.filter((p) => !before.includes(p));
    const perA = newA.filter((p) => carries(p, SESSION_A));
    t.diagnostic(`${route}: session A wrote ${newA.length} new file(s); per-session: ${perA.join(', ') || 'none'}`);
    assert.ok(perA.length > 0, 'session A wrote a snapshot (the airbag fired), so the sweep has something to remove');
    for (const p of perA) assert.match(p, new RegExp(`^proj:\\.claude/coalwash/writeguard/${SESSION_A}/`), `every per-session file is a writeguard snapshot: ${p}`);
    ageSession(sb, SESSION_A);
    runSession(sb, SESSION_B);
    const afterB = listing(sb);
    const leftA = afterB.filter((p) => carries(p, SESSION_A));
    const perB = afterB.filter((p) => carries(p, SESSION_B));
    t.diagnostic(`${route}: after session B, session A files left: ${leftA.length}; session B per-session: ${perB.join(', ') || 'none'}`);
    assert.deepEqual(leftA, [], 'session B removed every per-session file of session A');
    for (const p of perB) assert.match(p, new RegExp(`^proj:\\.claude/coalwash/writeguard/${SESSION_B}/`), `every per-session file is a writeguard snapshot: ${p}`);
  });

  test(`${route} route: inside the live window, the next session keeps the prior session's snapshot (by design, the 24-hour window)`, (t) => {
    const sb = sandbox(t);
    runSession(sb, SESSION_A);
    const perA = listing(sb).filter((p) => carries(p, SESSION_A));
    assert.ok(perA.length > 0, 'session A wrote a snapshot');
    runSession(sb, SESSION_B);
    assert.deepEqual(listing(sb).filter((p) => carries(p, SESSION_A)), perA, 'a snapshot younger than the live window stays');
  });
}
