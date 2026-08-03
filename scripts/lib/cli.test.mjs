// Hermetic tests for cli.mjs — the one-shot gauge front door. Spawns the REAL
// CLI with a sandboxed HOME/cwd (the conductor.test.mjs idiom) and asserts the
// three observable surfaces: exit code, output shape, and the READ-ONLY
// contract (a CLI gauge writes NO CoalWash state — stamps/verdicts are the
// SessionStart conductor's session bookkeeping, not a measurement's).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gauge, gaugeLine, measureOnly } from './cli.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, recordBinItem } from './tailings.mjs';
import { snapshotOnFirstWrite } from './writeguard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');

function sandbox() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-home-')));
  const proj = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-proj-')));
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# gov\n' + 'a'.repeat(400), 'utf8');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // platform marker for detectPlatform
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
// task #13: per-project state lives beside the CC memory dir.
function projStatePath(home, proj) {
  const slug = fs.realpathSync.native(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'coalwash', 'state.json');
}
function run(cwd, home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('0p writeguard-restore via CLI: prints the byte-exact ORIGINAL to stdout (redirect to file), metadata to stderr — restore-by-reference, never re-typed', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const orig = '# Memory\n\n[link](https://x.com) v1.0.0 — the original bytes.\n';
    fs.writeFileSync(gov, orig, 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess', gov, { home });
    const name = path.basename(snap);
    const r = run(proj, home, ['writeguard-restore', name]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, orig, 'stdout is the byte-exact original — code-moved, model-untouched');
    assert.ok(r.stderr.includes(name) && r.stderr.includes('byte-exact'), r.stderr);
  } finally { clean(home, proj); }
});

test('0p writeguard-list via CLI: metadata only (name/bytes/session/path), never content; a missing snapshot restore fails LOUD (exit 1)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, '# Gov\n\n[a](https://x.com) body '.padEnd(200, 'y'), 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess', gov, { home });
    const list = run(proj, home, ['writeguard-list']);
    assert.strictEqual(list.status, 0, list.stderr);
    assert.ok(list.stdout.includes(path.basename(snap)) && list.stdout.includes('bytes'), list.stdout);
    assert.ok(!list.stdout.includes('[a](https://x.com)'), 'listing never leaks content');
    const miss = run(proj, home, ['writeguard-restore', 'no-such-snap']);
    assert.strictEqual(miss.status, 1);
    assert.strictEqual(miss.stdout, '', 'no content on a miss');
    assert.ok(miss.stderr.includes('not found'), miss.stderr);
  } finally { clean(home, proj); }
});

test('gauge --json: one call returns recover + platform + measure + verdict + breakEven, exit 0', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['gauge', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.strictEqual(g.recover.recovered, 'none');
    assert.strictEqual(g.platform, 'claude-code');
    assert.ok(g.measure.alwaysLoaded.tokensEst > 0, 'the seeded CLAUDE.md was measured');
    assert.ok(['LEAN', 'OBESE', 'FULL'].includes(g.verdict.band));
    assert.strictEqual(typeof g.breakEven.economical, 'boolean');
    assert.ok(Number.isFinite(g.breakEven.fatTokens), 'the MEASURED certain fat rides the breakEven block (task #4)');
    assert.ok(Number.isFinite(g.breakEven.muscleTokens), 'measured muscle reported beside it');
    assert.strictEqual(g.breakEven.floorUnmeasured, undefined, 'the floor family is GONE from the gauge output, not defaulted');
  } finally { clean(home, proj); }
});

test('gauge --json: roleMemories is PER-STORE in the output (per method.md §0) — a role-memory store must be visible from the door every caller uses, not just inside discoverClassB', () => {
  const { home, proj } = sandbox();
  try {
    fs.mkdirSync(path.join(proj, '.claude', 'agent-memory', 'coder'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'agent-memory', 'coder', 'MEMORY.md'), '# coder index', 'utf8');
    const r = run(proj, home, ['gauge', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.ok(Array.isArray(g.roleMemories), 'roleMemories must be a field on the gauge --json door, not just discoverClassB internals');
    assert.strictEqual(g.roleMemories.length, 1);
    assert.strictEqual(g.roleMemories[0].store, 'agent:coder');
  } finally { clean(home, proj); }
});

test('gauge writes no state when no dangling journal exists: no state file, no stamp, no verdict cache is written', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['gauge', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false,
      'a CLI gauge is a measurement, not a session event — it must not stamp');
  } finally { clean(home, proj); }
});

test('default output is the terse one-line gauge', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['gauge']);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'ONE line');
    assert.match(lines[0], /^\[CoalWash\] (LEAN|OBESE|FULL) — always-loaded ~\d+ tok\/session \(~est\)/);
  } finally { clean(home, proj); }
});

test('an unknown/missing subcommand fails LOUD: usage on stderr, exit 1', () => {
  const { home, proj } = sandbox();
  try {
    for (const args of [[], ['wash']]) {
      const r = run(proj, home, args);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /usage: node scripts\/lib\/cli\.mjs gauge/);
    }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// restore <id> — the 0-token human recovery door (0h). Pull-only, read-only:
// content → stdout (pipeable), the ONE summary line → stderr, never a store
// write.
// ---------------------------------------------------------------------------

test('restore round-trip via the CLI: content lands on stdout byte-identical, the one-line summary on stderr, exit 0', () => {
  const { home, proj } = sandbox();
  try {
    const content = 'cut line one\ncut line two\n';
    const id = recordBinItem(proj, FAT_BIN_NAME, { content, original: path.join(proj, 'f1.md') });
    const r = run(proj, home, ['restore', id]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, content, 'stdout is the pure content — pipeable to a file, byte-identical');
    const errLines = r.stderr.trim().split(/\r?\n/);
    assert.strictEqual(errLines.length, 1, 'exactly ONE summary line');
    assert.ok(errLines[0].includes(id), errLines[0]);
    assert.ok(errLines[0].includes(FAT_BIN_NAME), 'names which bin held it');
    assert.ok(errLines[0].includes(`${Buffer.byteLength(content)} bytes`), errLines[0]);
    assert.ok(errLines[0].includes('f1.md'), 'names the source file it was cut from');
    assert.ok(errLines[0].includes('nothing was written'), 'states the read-only truth');
  } finally { clean(home, proj); }
});

test('restore: an id living only in the wizard bin (store.old) is found second and reported as store.old', () => {
  const { home, proj } = sandbox();
  try {
    const id = recordBinItem(proj, STORE_OLD_NAME, { content: 'wizard-cut wording', origin: 'wizard-cut' });
    const r = run(proj, home, ['restore', id]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'wizard-cut wording');
    assert.ok(r.stderr.includes(STORE_OLD_NAME), 'the summary names the wizard bin');
  } finally { clean(home, proj); }
});

test('restore: an unknown id fails LOUD — exit 1, a clean not-found message naming both bins searched, empty stdout', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['restore', 'no-such-id']);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '', 'no content — nothing masquerades as a find');
    assert.ok(r.stderr.includes("id 'no-such-id' not found"), r.stderr);
    assert.ok(r.stderr.includes(FAT_BIN_NAME) && r.stderr.includes(STORE_OLD_NAME), 'names where it looked');
  } finally { clean(home, proj); }
});

test('restore: a missing id argument is a usage error — exit 1, usage on stderr', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['restore']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: node scripts\/lib\/cli\.mjs gauge \[--json\] \| restore <id>/);
  } finally { clean(home, proj); }
});

test('F1: a traversal-shaped id via the CLI is a clean not-found — exit 1, empty stdout, never a file read outside the bins', () => {
  const { home, proj } = sandbox();
  try {
    // A real secret OUTSIDE the bins that a traversal id would otherwise reach.
    fs.writeFileSync(path.join(proj, 'secret.md'), 'not yours', 'utf8');
    for (const evil of ['../../secret.md', '..\\..\\secret.md', '..']) {
      const r = run(proj, home, ['restore', evil]);
      assert.strictEqual(r.status, 1, `id ${JSON.stringify(evil)} must fail`);
      assert.strictEqual(r.stdout, '', 'no content ever escapes on a traversal id');
      assert.ok(r.stderr.includes('not found'), r.stderr);
    }
  } finally { clean(home, proj); }
});

test('gauge() direct call: honors an explicit home/cwd — and a poisoned stored floor changes NOTHING (task #4: no floor is ever read)', () => {
  const { home, proj } = sandbox();
  // claudeBaseDir consults CLAUDE_CONFIG_DIR before the home argument — clear
  // it for the in-process call so the sandbox home stays hermetic.
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    // A poisoned (grossly-implausible) stored floor is INERT: task #4 measures
    // fat and muscle from content, so no stored floor is consulted at all.
    const sp = projStatePath(home, proj);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ leanFloorTokens: 10 ** 9 }), 'utf8');
    const g = gauge({ cwd: proj, home });
    assert.ok(['LEAN', 'OBESE', 'FULL'].includes(g.verdict.band), 'the gauge ran on the explicit home/cwd');
    assert.strictEqual(g.breakEven.floorUnmeasured, undefined, 'no floor is consulted, poisoned or not');
    assert.match(gaugeLine(g), /certain fat ~\d+ tok/);
  } finally {
    if (savedEnv !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv;
    clean(home, proj);
  }
});

// measureOnly — the recovery-free entry an unattended runner (CI/Action) needs.
// PROVED BY TREE STATE, not by reading the code: plant a dangling journal (the
// exact input that makes gauge() write) and require the tree to come back
// byte-identical. Reading the source would only prove I read it right today.
function treeSnapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`D ${r}`); walk(abs, r); }
      else { const b = fs.readFileSync(abs); out.push(`F ${r} ${b.length} ${crypto.createHash('sha256').update(b).digest('hex')}`); }
    }
  };
  walk(dir, '');
  return out.join('\n');
}

test('measureOnly: writes NOTHING even with a dangling journal present — the tree is byte-identical after the call', () => {
  const { home, proj } = sandbox();
  try {
    // the exact input that makes gauge() write: a real dangling transaction
    const txDir = path.join(proj, '.claude', 'coalwash');
    const snapDir = path.join(txDir, 'snap-4242');
    fs.mkdirSync(snapDir, { recursive: true });
    const target = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(path.join(snapDir, 'f0'), 'SNAPSHOT CONTENT THAT MUST NOT BE RESTORED', 'utf8');
    fs.writeFileSync(path.join(snapDir, 'manifest.json'), JSON.stringify([{ snap: 'f0', original: target }]));
    fs.writeFileSync(path.join(snapDir, 'snap.complete'), '4242');
    fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify({
      version: 1, status: 'applying', snapDir, roots: [proj],
      steps: [{ i: 0, type: 'rewrite', path: target, status: 'done' }],
    }));

    const beforeProj = treeSnapshot(proj);
    const beforeHome = treeSnapshot(home);
    const r = measureOnly({ cwd: proj, home });

    // No `r &&` guard: measureOnly returns an unconditional object literal, so the
    // falsy branch is unreachable — CodeQL #27 was a true positive. A guard over an
    // impossible case proves nothing (the R4/TP-3 lesson), and if the contract ever
    // did change, `r.measure` throws and the test still fails.
    assert.ok(r.measure && r.verdict, 'it still measures and judges');
    assert.strictEqual(r.recover, undefined, 'no recovery result — it never ran one');
    assert.strictEqual(treeSnapshot(proj), beforeProj, 'PROJECT tree byte-identical: no restore, no journal deletion, no state write');
    assert.strictEqual(treeSnapshot(home), beforeHome, 'HOME tree byte-identical: no state/stamp written either');

    // and the control: gauge() on the SAME input DOES act, which is what makes
    // the assertion above meaningful rather than vacuous.
    gauge({ cwd: proj, home });
    assert.notStrictEqual(treeSnapshot(proj), beforeProj, 'gauge() DOES touch the tree — so measureOnly leaving it untouched is a real difference');
  } finally { clean(home, proj); }
});

test('measureOnly and gauge agree on every measurement field — the split changed nothing but the preflight', () => {
  const { home, proj } = sandbox();
  try {
    const m = measureOnly({ cwd: proj, home });
    const g = gauge({ cwd: proj, home });
    for (const k of ['projectRoot', 'platform']) assert.deepStrictEqual(g[k], m[k], k);
    assert.deepStrictEqual(g.verdict, m.verdict, 'same verdict');
    assert.deepStrictEqual(g.measure.alwaysLoaded.tokensEst, m.measure.alwaysLoaded.tokensEst, 'same footprint');
    assert.ok('recover' in g && !('recover' in m), 'the ONLY difference is the recover key');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// NESTED-HABITAT: THE INHERITED-ANCESTOR TIER (series law; the CoalTipple
// false-FULL the docket named, now measured). The CLAUDE.md up-tree walk loads
// the umbrella ANCESTOR's governance into every room on top of the room's own —
// and it all landed in `entries` as scope 'project', so the room's cap/verdict
// was computed on a habitat the room cannot act on. Measured 2026-07-25, one
// gauge run per room: the umbrella alone is 30,487 tok = 85% of the 36,000
// ceiling before a room holds one byte of its own, FALSE-FULLing three rooms.
//
// THE CONTROL BELOW IS THE POINT: "the room reads LEAN now" alone is equally
// consistent with "the wall stopped firing". A room over its OWN cap must still
// read FULL, or the fix is a broken gate wearing a green badge.
// ---------------------------------------------------------------------------
function nested({ umbrellaBytes, roomBytes }) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-home-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // platform marker
  const umb = path.join(home, 'work', 'umbrella');
  const room = path.join(umb, 'room');
  fs.mkdirSync(room, { recursive: true });
  // The umbrella: a CLAUDE.md whose @import closure is the bulk (this series'
  // real shape — CLAUDE.md is thin and pulls AGENTS.md + MEMORY.md + rules).
  if (umbrellaBytes > 0) {
    fs.writeFileSync(path.join(umb, 'CLAUDE.md'), '# umbrella\n@AGENTS.md\n@MEMORY.md\n', 'utf8');
    fs.writeFileSync(path.join(umb, 'AGENTS.md'), 'u'.repeat(Math.floor(umbrellaBytes / 2)), 'utf8');
    fs.writeFileSync(path.join(umb, 'MEMORY.md'), 'm'.repeat(Math.floor(umbrellaBytes / 2)), 'utf8');
  }
  // The room: its own CLAUDE.md (also the ROOT_MARKER, so findProjectRoot stops
  // HERE — innermost wins, the fail-closed direction) + its own MEMORY.md.
  fs.writeFileSync(path.join(room, '.coalwash.json'), '{}');
  fs.writeFileSync(path.join(room, 'CLAUDE.md'), '# room\n@MEMORY.md\n', 'utf8');
  fs.writeFileSync(path.join(room, 'MEMORY.md'), 'r'.repeat(roomBytes), 'utf8');
  return { home, umb, room };
}

test('NESTED-HABITAT: a room FALSE-FULLed by its inherited umbrella now reads LEAN — the cap is computed on room-owned only', () => {
  // Umbrella far over any plausible ceiling; the room itself is trivial.
  const { home, room } = nested({ umbrellaBytes: 400_000, roomBytes: 4_000 });
  try {
    const g = measureOnly({ cwd: room, home });
    assert.strictEqual(g.verdict.band, 'LEAN', `the room's OWN content is ~1k tok — it must not be FULL (got ${g.verdict.band}/${g.verdict.reason})`);
    // and the inherited cost is REPORTED, not merely invisible (law: it is real
    // per-session cost, it is just not this room's to wash or externalize).
    assert.ok(g.inherited.alwaysLoaded.tokensEst > g.verdict.hardCeilingTokens,
      'the ancestor tier is measured and exceeds the ceiling on its own — that is the number a reader needs to SEE');
    assert.ok(g.verdict.hardCeilingTokens >= g.measure.alwaysLoaded.tokensEst,
      'task #4: the FULL line RIDES the measured muscle (threshold = muscle + arm), so a pure-muscle room can never cross it');
  } finally { clean(home); }
});

// task #4 re-base of both controls: a giant DISTINCT 'R'-run is measured
// muscle now and correctly stays LEAN — the arming fixture is real duplicate
// fat (the estimator's own evidence) plus a CC-index-cap hit, the same two
// ingredients the shipped absolute-cap route requires.
function seedRoomFatAndCapIndex(home, room) {
  const dupFat = Array.from({ length: 60 }, () => 'this exact line is deliberate duplicate padding for the nested-habitat control').join('\n');
  fs.writeFileSync(path.join(room, 'CLAUDE.md'), '# room\n@MEMORY.md\n' + dupFat, 'utf8');
  const slug = fs.realpathSync.native(room).replace(/[^A-Za-z0-9]/g, '-');
  const mem = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'i'.repeat(26 * 1024), 'utf8'); // over CC_INDEX_CAP_BYTES
}

test('NESTED-HABITAT CONTROL: a room over its OWN cap still reads FULL — the wall did not stop firing', () => {
  // No umbrella at all; the room's own fat + index-cap hit is the trigger.
  const { home, room } = nested({ umbrellaBytes: 0, roomBytes: 4_000 });
  try {
    seedRoomFatAndCapIndex(home, room);
    const g = measureOnly({ cwd: room, home });
    assert.strictEqual(g.verdict.band, 'FULL', 'room-owned fat over the ceiling must still hit the wall');
    assert.strictEqual(g.verdict.reason, 'absolute-cap');
  } finally { clean(home); }
});

test('NESTED-HABITAT CONTROL 2: the umbrella is excluded, the room\'s own fat is NOT — a room that is BOTH still reads FULL', () => {
  const { home, room } = nested({ umbrellaBytes: 400_000, roomBytes: 4_000 });
  try {
    seedRoomFatAndCapIndex(home, room);
    const g = measureOnly({ cwd: room, home });
    assert.strictEqual(g.verdict.band, 'FULL', 'excluding the ancestor tier must not excuse the room\'s own fat');
  } finally { clean(home); }
});

// ---------------------------------------------------------------------------
// STATION-4 finding, answered in CODE: every recovery REFUSAL returns
// recovered:'none' + an error, so the terse line dropped all of them and a
// poisoned journal in a fresh checkout produced byte-identical output to no
// journal at all. 'none' WITHOUT an error still stays silent — that is the
// common path and it is genuinely nothing.
// ---------------------------------------------------------------------------
test('gaugeLine SURFACES a refused recovery, and stays silent when there was simply nothing to do', () => {
  const base = { verdict: { band: 'LEAN', bmi: 0 }, measure: { alwaysLoaded: { tokensEst: 1000 } } };
  const quiet = gaugeLine({ ...base, recover: { recovered: 'none' } });
  assert.ok(!/REFUSED|recovered dangling/.test(quiet), `no journal = no clause (got: ${quiet})`);
  const refused = gaugeLine({ ...base, recover: { recovered: 'none', error: 'containment: the derived project anchor (/x) is the home directory or an ancestor of it — refusing fail-closed' } });
  assert.match(refused, /dangling run REFUSED/, 'a refusal must be VISIBLE at the front door, not only under --json');
  assert.match(refused, /--json/, 'and it must point at where the reason lives');
  assert.ok(refused.length < quiet.length + 90, 'the terse line stays terse — the long reason belongs in --json');
  const done = gaugeLine({ ...base, recover: { recovered: 'rolled-back', restored: 2 } });
  assert.match(done, /recovered dangling run: rolled-back/, 'the success clause is unchanged');
  const partial = gaugeLine({ ...base, recover: { recovered: 'partial', restored: 1, error: 'x' } });
  assert.match(partial, /recovered dangling run: partial/, "'partial' reports as itself, never as a refusal");
});
