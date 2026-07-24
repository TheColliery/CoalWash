// Hermetic spawn tests for hooks/coalwash-ag.js (hooks-safety.md §7): spawn the
// REAL AG adapter as a child process with AG-v2.3.1-SHAPED fixture stdin
// (camelCase: conversationId / workspacePaths / toolCall.*) and a sandboxed
// HOME/TEMP/TMPDIR, so real session state, the real config, and the real tmp
// markers can never leak in (TMPDIR included — the adapter's per-conversation
// marker/queue/note files live in os.tmpdir(), which reads TMPDIR on POSIX and
// TEMP/TMP on Windows).
//
// Every case asserts the three observable surfaces:
//   (1) exit code 0 on every path (Phoenix #4);
//   (2) stderr silent — stdout EXACTLY ONE JSON document matching the event's
//       v2.3.1 output contract: PreInvocation {}|{injectSteps:[{ephemeral-
//       Message}]} · Stop {decision:'allow'}|{decision:'continue',reason} ·
//       PreToolUse {decision:'ask'} always · PostToolUse {} — and NEVER the
//       dead pilot-era {additionalContext} key, never {decision:'block'},
//       never 'allow'/'deny' on PreToolUse (no permission widening, no
//       sabotage);
//   (3) the expected state effect (marker/state/snapshot/queue written,
//       crossing consumed, or nothing touched).
//
// Cross-session-contamination regression (the CoalHearth AG-port bug class):
// the gauge guard is a conversationId-KEYED atomic wx tmp marker (new
// conversation = new marker name; a dead conversation's marker is inert),
// and the Stop delivery CONSUMES the crossing at emission — plus the AG-only
// loop belt: an IDENTICAL reason re-arriving after a failed state consume
// answers {decision:'allow'} instead of re-entering the loop.
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
// The event ALWAYS rides argv (the hooks.json template form) — AG stdin has no
// event name. cwd is set to the HOME sandbox (NOT the project) to mirror AG's
// real spawn cwd (the hooks.json dir); the adapter must chdir(workspacePaths[0]).
function run(home, input, eventArg) {
  return spawnSync(process.execPath, eventArg ? [HOOK, eventArg] : [HOOK], {
    cwd: home,
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
// The child's os.tmpdir() = the sandbox home (env above), so the adapter's
// per-conversation files land there — enumerable without touching real tmp.
function tmpEntries(home, prefix) {
  try { return fs.readdirSync(home).filter((n) => n.startsWith(prefix)); } catch { return []; }
}
function assertGraceful(r) {
  assert.strictEqual(r.status, 0, `hook must exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.stderr, '', 'hook must be silent on stderr (Phoenix #13)');
  assert.strictEqual(r.signal, null, 'hook must not be killed by a signal');
}
// Exactly ONE JSON document on stdout, and never the dead pilot-era key.
function parseAnswer(stdout) {
  const obj = JSON.parse(stdout);
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), 'stdout is one JSON object');
  assert.ok(!('additionalContext' in obj), 'the pilot-era additionalContext key is a DEAD LETTER — never emit it');
  return obj;
}
function injected(obj) {
  assert.ok(Array.isArray(obj.injectSteps) && obj.injectSteps.length === 1, 'exactly one injectSteps entry');
  const step = obj.injectSteps[0];
  assert.ok(typeof step.ephemeralMessage === 'string' && step.ephemeralMessage, 'ephemeralMessage present (never userMessage — a fabricated user turn)');
  assert.ok(!('userMessage' in step) && !('toolCall' in step), 'ephemeralMessage only');
  return step.ephemeralMessage;
}

const GOV_BODY = '# Governance\n\nSee [the guide](https://example.com/guide) and version v1.2.3 on 2026-07-11. ' + 'x'.repeat(300);
function wgDir(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }
function agPayload(proj, conv, extra = {}) {
  return { conversationId: conv, workspacePaths: [proj], transcriptPath: path.join(proj, 'transcript.jsonl'), ...extra };
}

test('AG PreInvocation (first of a conversation): silent gauge — {} answered, state + wx marker written, no update nudge even when due', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj); // fresh home: the CC conductor would print the update nudge here — AG must not
    const r = run(home, agPayload(proj, 'ag-c1'), 'PreInvocation');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {}, 'gauge is silent (band collapse) AND the CC-specific update nudge is un-ported');
    assert.ok(readProjState(home, proj).lastVerdict, 'the gauge measured + recorded a verdict (chdir to workspacePaths[0] worked)');
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-gauge-').length, 1, 'one per-conversation marker written');
  } finally { clean(home, proj); }
});

test('AG PreInvocation (later calls, same conversation): the marker guards — no re-gauge; a NEW conversationId re-gauges', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    run(home, agPayload(proj, 'ag-c1'), 'PreInvocation');
    fs.rmSync(projStatePath(home, proj), { force: true }); // a guarded second call must NOT recreate it
    const r2 = run(home, agPayload(proj, 'ag-c1'), 'PreInvocation');
    assertGraceful(r2);
    assert.deepStrictEqual(parseAnswer(r2.stdout), {});
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'same conversation -> guarded, gauge did not run');
    const r3 = run(home, agPayload(proj, 'ag-c2'), 'PreInvocation');
    assertGraceful(r3);
    assert.ok(readProjState(home, proj).lastVerdict, 'new conversation -> new marker -> gauge ran');
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-gauge-').length, 2, 'one marker per conversation');
  } finally { clean(home, proj); }
});

test('AG PreInvocation with NO conversation key: {} — no marker, no state (never gauge-per-model-call)', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(home, { workspacePaths: [proj] }, 'PreInvocation');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {});
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-gauge-').length, 0, 'no key -> no marker');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'no key -> no gauge');
  } finally { clean(home, proj); }
});

test('AG PreInvocation on a machine with NO ~/.claude: INERT by construction — {} and ~/.claude never created', () => {
  const { home, proj } = sandbox();
  try {
    fs.writeFileSync(path.join(proj, 'CLAUDE.md'), 'a'.repeat(80), 'utf8'); // class-B exists, but no ~/.claude -> platform unknown
    const r = run(home, agPayload(proj, 'ag-pure'), 'PreInvocation');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {});
    assert.strictEqual(fs.existsSync(path.join(home, '.claude')), false, 'pure-AG machine: nothing created (named limitation 1)');
  } finally { clean(home, proj); }
});

test('AG Stop with a pending FULL crossing: {decision:continue, reason:<directive>} + the crossing is CONSUMED + the belt note written', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    seedState(home, proj, {
      lastVerdict: { band: 'FULL', reason: 'economic', economical: true, fatTokens: 9000, overCeiling: true, econLatched: true, perDay: 300, breakEvenDays: 2 },
      lastCrossing: { band: 'FULL', at: Date.now() - 1000, consumed: false },
    });
    const r = run(home, agPayload(proj, 'ag-c1'), 'Stop');
    assertGraceful(r);
    const obj = parseAnswer(r.stdout);
    assert.strictEqual(obj.decision, 'continue', 'the enforcement analogue: continue + reason-as-system-message');
    assert.ok(obj.reason.includes('[CoalWash]') && obj.reason.includes('FULL band'), obj.reason);
    assert.strictEqual(readProjState(home, proj).lastCrossing.consumed, true,
      'consume-at-emission holds on AG — nothing pends across sessions (the contamination regression)');
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-stop-').length, 1, 'loop-belt note written');
  } finally { clean(home, proj); }
});

test('AG Stop loop belt: the SAME directive re-arriving after a failed state consume answers {decision:allow}, never a loop', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const state = {
      lastVerdict: { band: 'FULL', reason: 'economic', economical: true, fatTokens: 9000, overCeiling: true, econLatched: true, perDay: 300, breakEvenDays: 2 },
      lastCrossing: { band: 'FULL', at: Date.now() - 1000, consumed: false },
    };
    seedState(home, proj, state);
    const r1 = run(home, agPayload(proj, 'ag-c1'), 'Stop');
    assert.strictEqual(parseAnswer(r1.stdout).decision, 'continue');
    // Simulate the state consume FAILING to persist: re-seed the identical
    // unconsumed crossing. The reason regenerates byte-identically -> the
    // note hash matches -> allow, not a second forced turn.
    seedState(home, proj, state);
    const r2 = run(home, agPayload(proj, 'ag-c1'), 'Stop');
    assertGraceful(r2);
    assert.deepStrictEqual(parseAnswer(r2.stdout), { decision: 'allow' }, 'identical re-emission suppressed (loop belt)');
  } finally { clean(home, proj); }
});

test('AG Stop with nothing pending: {decision:allow} (decision is REQUIRED on Stop — never empty)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    seedState(home, proj, { lastVerdict: { band: 'LEAN' } }); // no crossing, no warp-hole baseline
    const r = run(home, agPayload(proj, 'ag-c1'), 'Stop');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), { decision: 'allow' });
  } finally { clean(home, proj); }
});

test('AG coalwashMode off: the master kill holds — Stop answers {decision:allow}, crossing untouched', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { coalwashMode: 'off' });
    seedState(home, proj, {
      lastVerdict: { band: 'FULL', reason: 'economic', fatTokens: 9000 },
      lastCrossing: { band: 'FULL', at: Date.now() - 1000, consumed: false },
    });
    const r = run(home, agPayload(proj, 'ag-c1'), 'Stop');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), { decision: 'allow' });
    assert.strictEqual(readProjState(home, proj).lastCrossing.consumed, false, 'off = fully inert, crossing untouched');
  } finally { clean(home, proj); }
});

test('AG PreToolUse (write_to_file, toolCall.args.TargetFile): {decision:ask} + the airbag snapshots the class-B file', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r = run(home, agPayload(proj, 'ag-w1', { toolCall: { name: 'write_to_file', args: { TargetFile: gov } }, stepIdx: 3 }), 'PreToolUse');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), { decision: 'ask' },
      "the neutral answer — never 'allow' (permission widening) nor 'deny' (sabotage)");
    const snaps = fs.readdirSync(path.join(wgDir(proj), 'ag-w1')).filter((n) => n !== '.gitignore');
    assert.strictEqual(snaps.length, 1, 'one snapshot taken');
    assert.strictEqual(fs.readFileSync(path.join(wgDir(proj), 'ag-w1', snaps[0]), 'utf8'), GOV_BODY, 'byte-exact orig');
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-wg-').length, 1, 'seatbelt queue armed');
  } finally { clean(home, proj); }
});

test('AG seatbelt (PostToolUse payload is unusable -> the sweep rides PreInvocation): drop advised once, re-armed by the next write', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const conv = 'ag-w2';
    run(home, agPayload(proj, conv, { toolCall: { name: 'write_to_file', args: { TargetFile: gov } } }), 'PreToolUse');
    fs.writeFileSync(gov, GOV_BODY.replace('[the guide](https://example.com/guide)', 'the guide'), 'utf8'); // the write lands, dropping a link
    const r1 = run(home, agPayload(proj, conv), 'PreInvocation');
    assertGraceful(r1);
    const msg = injected(parseAnswer(r1.stdout));
    assert.ok(msg.includes('write-guard') && msg.includes('link-drop'), msg);
    // Queue consumed -> the next PreInvocation is silent ({}), no repeat FYI.
    const r2 = run(home, agPayload(proj, conv), 'PreInvocation');
    assertGraceful(r2);
    assert.deepStrictEqual(parseAnswer(r2.stdout), {}, 'advise-per-write: no write since -> silent');
    // A new write to the same file re-arms the sweep (CC cadence).
    run(home, agPayload(proj, conv, { toolCall: { name: 'replace_file_content', args: { TargetFile: gov } } }), 'PreToolUse');
    const r3 = run(home, agPayload(proj, conv), 'PreInvocation');
    assertGraceful(r3);
    assert.ok(injected(parseAnswer(r3.stdout)).includes('link-drop'), 're-enqueued write re-advises (cumulative vs baseline)');
  } finally { clean(home, proj); }
});

test('AG PreToolUse unknown tool (view_file): {decision:ask}, nothing guarded, nothing written (degrade-safe normalize)', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off' });
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const r = run(home, agPayload(proj, 'ag-x', { toolCall: { name: 'view_file', args: { AbsolutePath: gov } } }), 'PreToolUse');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), { decision: 'ask' }, 'still answers the REQUIRED decision');
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'unknown tool -> never guarded');
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-wg-').length, 0, 'not enqueued');
  } finally { clean(home, proj); }
});

test('AG writeGuard off: PreToolUse still answers {decision:ask} but snapshots nothing; the PreInvocation sweep stays silent', () => {
  const { home, proj } = sandbox();
  try {
    writeGlobalCfg(home, { updateMode: 'off', writeGuard: 'off' });
    const gov = path.join(proj, 'AGENTS.md');
    fs.writeFileSync(gov, GOV_BODY, 'utf8');
    const conv = 'ag-off';
    const r = run(home, agPayload(proj, conv, { toolCall: { name: 'write_to_file', args: { TargetFile: gov } } }), 'PreToolUse');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), { decision: 'ask' });
    assert.strictEqual(fs.existsSync(wgDir(proj)), false, 'writeGuard off -> no snapshot');
    fs.writeFileSync(gov, 'gutted', 'utf8');
    const r2 = run(home, agPayload(proj, conv), 'PreInvocation');
    assertGraceful(r2);
    const obj = parseAnswer(r2.stdout);
    assert.ok(!('injectSteps' in obj) || !obj.injectSteps.length, 'no baseline -> sweep silent');
  } finally { clean(home, proj); }
});

test('AG PostToolUse (payload carries no toolCall): answers the documented {} and touches nothing', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(home, agPayload(proj, 'ag-c1', { stepIdx: 5, error: '' }), 'PostToolUse');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {});
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'no state written');
  } finally { clean(home, proj); }
});

test('AG garbage stdin + argv event: exit 0, {} answered, no state (fail-silent)', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(home, 'not json at all', 'PreInvocation');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {});
    assert.strictEqual(tmpEntries(home, 'coalwash-ag-gauge-').length, 0, 'garbage payload has no conversation key -> skip');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false);
  } finally { clean(home, proj); }
});

test('AG unknown/missing event: {} — never the CC gauge fallthrough', () => {
  const { home, proj } = sandbox();
  try {
    seedClassB(home, proj);
    const r = run(home, agPayload(proj, 'ag-c1'), 'SomethingNew');
    assertGraceful(r);
    assert.deepStrictEqual(parseAnswer(r.stdout), {});
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'unknown event never gauges');
  } finally { clean(home, proj); }
});
