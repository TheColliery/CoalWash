// Hermetic spawn tests for hooks/coalwash-ag.js (hooks-safety.md §7): spawn the
// REAL AG adapter as a child process with AG-SHAPED fixture stdin (snake_case
// core + camelCase toolCall.*) and a sandboxed HOME/TEMP/TMPDIR, so real
// session state, the real config, and the real tmp markers can never leak in
// (TMPDIR included — the adapter's per-session gauge marker lives in
// os.tmpdir(), which reads TMPDIR on POSIX and TEMP/TMP on Windows).
// Every case asserts the three observable surfaces:
//   (1) exit code 0 on every path (Phoenix #4);
//   (2) stderr silent — stdout ONLY the sanctioned single-line
//       {additionalContext} JSON (never {decision:'block'} — AG has no Stop-
//       block semantics; never the CC self-update nudge — deliberately
//       un-ported);
//   (3) the expected state effect (marker/state/snapshot written, crossing
//       consumed, or nothing touched).
//
// Cross-session-contamination regression (the CoalHearth AG-port bug class —
// a status-only "same session" proxy + a shim that never consumes state lets
// a dead session's state bleed into the next): pinned here two ways —
//   - the gauge guard is a session_id-KEYED tmp marker (new session = new
//     marker name; a dead session's marker is inert), asserted by the
//     re-gauge-on-new-session case;
//   - the Stop delivery CONSUMES the crossing at emission (lastCrossing.
//     consumed === true asserted), so nothing pends across sessions.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const HOOK = path.join(REPO, 'hooks', 'coalwash-ag.js');

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwag-proj-')));
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}'); // roots the project for the stop-at-home walk
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
// eventArg exercises the `node <file> <EventArg>` template form; stdin's
// hook_event_name (when present) is the primary source.
function run(cwd, home, input, eventArg) {
  return spawnSync(process.execPath, eventArg ? [HOOK, eventArg] : [HOOK], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
    input: input === undefined ? undefined : (typeof input === 'string' ? input : JSON.stringify(input)),
  });
}
function writeGlobalCfg(home, cfg) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify(cfg), 'utf8');
}
function seedClassB(home, proj, { claudeMdBytes = 100, indexBytes = 60 } = {}) {
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(claudeMdBytes), 'utf8');
  const slug = fs.realpathSync(proj).replace(/[^A-Za-z0-9]/g, '-');
  const mem = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'i'.repeat(indexBytes), 'utf8');
  return mem;
}
function projStatePath(home, proj) {
  const slug = fs.realpathSync(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'coalwash', 'state.json');
}
function seedState(home, proj, projState) {
  const p = projStatePath(home, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...projState, stateSchema: 1 }), 'utf8');
}
function readProjState(home, proj) {
  try {
    const raw = JSON.parse(fs.readFileSync(projStatePath(home, proj), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
// The child's os.tmpdir() = the sandbox home (env above), so gauge markers
// land there — enumerable without touching the real tmp.
function markers(home) {
  try { return fs.readdirSync(home).filter((n) => n.startsWith('coalwash-ag-gauge-')); } catch { return []; }
}
function assertGraceful(r) {
  assert.strictEqual(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.stderr, '', 'hook must be silent on stderr (Phoenix #13)');
  assert.strictEqual(r.signal, null, 'hook must not be killed by a signal');
}
function parseInjection(stdout) {
  const obj = JSON.parse(stdout.trim());
  assert.ok(typeof obj.additionalContext === 'string' && obj.additionalContext, 'additionalContext present');
  assert.ok(!('decision' in obj), 'never {decision:block} on AG — no Stop-block semantics there');
  return obj.additionalContext;
}

const GOV_BODY = '# Governance\n\nSee [the guide](https://example.com/guide) and version v1.2.3 on 2026-07-11. ' + 'x'.repeat(300);
function wgDir(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }

test('AG PreInvocation (first of a session): runs the SILENT gauge once — state + marker written, stdout EMPTY (no self-update nudge even when due)', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj); // fresh home: on the CC conductor the update nudge would print here — AG must not
    const r = run(proj, home, { hook_event_name: 'PreInvocation', session_id: 'ag-s1', cwd: proj });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'gauge is silent (band collapse) AND the CC-specific update nudge is un-ported');
    assert.ok(readProjState(home, proj).lastVerdict, 'the gauge measured + recorded a verdict');
    assert.strictEqual(markers(home).length, 1, 'one per-session marker written');
  } finally { clean(home, proj); }
});

test('AG PreInvocation (later calls, same session): the marker guards — no re-gauge; a NEW session_id re-gauges (dead marker inert)', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    run(proj, home, { hook_event_name: 'PreInvocation', session_id: 'ag-s1', cwd: proj });
    // Delete the state the first gauge wrote; a guarded second call must NOT recreate it.
    fs.rmSync(projStatePath(home, proj), { force: true });
    const r2 = run(proj, home, { hook_event_name: 'PreInvocation', session_id: 'ag-s1', cwd: proj });
    assertGraceful(r2);
    assert.strictEqual(r2.stdout, '');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'same session -> guarded, gauge did not run');
    // A NEW session gauges again (session-keyed marker: the old one is inert, not a cross-session proxy).
    const r3 = run(proj, home, { hook_event_name: 'PreInvocation', session_id: 'ag-s2', cwd: proj });
    assertGraceful(r3);
    assert.ok(readProjState(home, proj).lastVerdict, 'new session -> new marker -> gauge ran');
    assert.strictEqual(markers(home).length, 2, 'one marker per session');
  } finally { clean(home, proj); }
});

test('AG PreInvocation with NO session key: skips silently — no marker, no state (never gauge-per-model-call)', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(proj, home, { hook_event_name: 'PreInvocation', cwd: proj });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(markers(home).length, 0, 'no key -> no marker');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'no key -> no gauge');
  } finally { clean(home, proj); }
});

test('AG Stop with a pending FULL crossing: ONE {additionalContext} JSON line (the force directive) + the crossing is CONSUMED', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    seedState(home, proj, {
      lastVerdict: { band: 'FULL', reason: 'economic', economical: true, fatTokens: 9000, overCeiling: true, econLatched: true, perDay: 300, breakEvenDays: 2 },
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
    });
    const r = run(proj, home, { hook_event_name: 'Stop', session_id: 'ag-s1', cwd: proj });
    assertGraceful(r);
    const ctx = parseInjection(r.stdout);
    assert.ok(ctx.includes('[CoalWash]') && ctx.includes('FULL band'), ctx);
    assert.strictEqual(readProjState(home, proj).lastCrossing.consumed, true,
      'consume-at-emission holds on AG — nothing pends across sessions (the contamination regression)');
  } finally { clean(home, proj); }
});

test('AG Stop with nothing pending: fully silent', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    seedState(home, proj, { lastVerdict: { band: 'LEAN' } }); // no crossing, no warp-hole baseline
    const r = run(proj, home, { hook_event_name: 'Stop', session_id: 'ag-s1', cwd: proj });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
  } finally { clean(home, proj); }
});

test('AG PreToolUse (write_to_file, camelCase toolCall.args.filePath): the airbag snapshots the class-B file, silently', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r = run(proj, home, { hook_event_name: 'PreToolUse', session_id: 'ag-w1', cwd: proj, toolCall: { name: 'write_to_file', args: { filePath: gov } } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '', 'airbag is write-only');
    const snaps = fs.readdirSync(path.join(wgDir(proj), 'ag-w1')).filter((n) => n !== '.gitignore');
    assert.strictEqual(snaps.length, 1, 'one snapshot taken');
    assert.strictEqual(fs.readFileSync(path.join(wgDir(proj), 'ag-w1', snaps[0]), 'utf8'), GOV_BODY, 'byte-exact orig');
  } finally { clean(home, proj); }
});

test('AG PostToolUse after a structured-token drop: ONE {additionalContext} advisory (FYI, never a block decision)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    run(proj, home, { hook_event_name: 'PreToolUse', session_id: 'ag-w2', cwd: proj, toolCall: { name: 'write_to_file', args: { filePath: gov } } });
    fs.writeFileSync(gov, GOV_BODY.replace('[the guide](https://example.com/guide)', 'the guide'), 'utf8');
    const r = run(proj, home, { hook_event_name: 'PostToolUse', session_id: 'ag-w2', cwd: proj, toolCall: { name: 'write_to_file', args: { filePath: gov } } });
    assertGraceful(r);
    const ctx = parseInjection(r.stdout);
    assert.ok(ctx.includes('write-guard') && ctx.includes('link-drop'), ctx);
  } finally { clean(home, proj); }
});

test('AG unknown tool name: a no-op — nothing guarded, nothing written, silent (degrade-safe normalize)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r = run(proj, home, { hook_event_name: 'PreToolUse', session_id: 's', cwd: proj, toolCall: { name: 'read_file', args: { filePath: gov } } });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'unknown tool -> never guarded');
  } finally { clean(home, proj); }
});

test('AG garbage stdin (argv event fallback): exit 0, silent, no state', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(proj, home, 'not json at all', 'PreInvocation');
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(markers(home).length, 0, 'garbage payload has no session key -> skip');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false);
  } finally { clean(home, proj); }
});

test('AG coalwashMode off: the master kill holds through the adapter — Stop with a seeded crossing stays silent', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { coalwashMode: 'off' });
    seedState(home, proj, {
      lastVerdict: { band: 'FULL', reason: 'economic', fatTokens: 9000 },
      lastCrossing: { band: 'FULL', at: Date.now(), consumed: false },
    });
    const r = run(proj, home, { hook_event_name: 'Stop', session_id: 's', cwd: proj });
    assertGraceful(r);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(readProjState(home, proj).lastCrossing.consumed, false, 'off = fully inert, crossing untouched');
  } finally { clean(home, proj); }
});
