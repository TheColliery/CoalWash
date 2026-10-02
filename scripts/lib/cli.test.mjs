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

// grad10-round-2 MED-5: readWriteguardSnapshot returns null both for "no row
// of this name exists" AND "a row exists but failed F1's integrity check" --
// the CLI used to say "not found" for both, so a genuine tamper read as a
// missing file, the wrong message at the worst moment. This test snapshots a
// REAL file (so the name IS listed by writeguard-list), then tampers the
// on-disk blob bytes directly (breaking the sidecar's recorded hash) --
// distinct from the "no-such-snap" case above, which never had a row at all.
test('0p writeguard-restore via CLI: a snapshot that IS listed but fails integrity verification gets its OWN message, never "not found"', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, '# Memory\n\n[link](https://x.com) v1.0.0 — the original bytes.\n', 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess', gov, { home });
    const name = path.basename(snap);
    fs.writeFileSync(snap, 'TAMPERED — no longer what the sidecar attests', 'utf8'); // in-place tamper, sidecar unchanged
    const list = run(proj, home, ['writeguard-list']);
    assert.ok(list.stdout.includes(name), 'the tampered snapshot is still LISTED (metadata only, no integrity check there)');
    const r = run(proj, home, ['writeguard-restore', name]);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '', 'no content -- unverified bytes are never served');
    assert.ok(r.stderr.includes('FAILED integrity verification'), r.stderr);
    assert.ok(!r.stderr.includes('not found'), `must NOT say "not found" for a snapshot that IS listed: ${r.stderr}`);
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// UMB-133 — config-status: the user-pulled report for both holes. hole (2)'s
// migration notice lives HERE, deliberately never on SessionStart (see
// hooks/coalwash-conductor.js's own comment on why); hole (1)'s ignored-path
// report is exposed here too, alongside its own ambient conductor test.
// ---------------------------------------------------------------------------

test('config-status: this file\'s own sandbox default (a ROOT legacy .coalwash.json) IS reported as a legacy read', () => {
  const { home, proj } = sandbox(); // sandbox() writes proj/.coalwash.json
  try {
    const r = run(proj, home, ['config-status']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`Config read from a LEGACY path (${path.join(proj, '.coalwash.json')})`), r.stdout);
    assert.ok(r.stdout.includes('canonical = .claude/coal/coalwash.json'), r.stdout);
  } finally { clean(home, proj); }
});

test('config-status: a canonical config (.claude/coal/coalwash.json) reports NOTHING -- the honest-empty-state line', () => {
  const { home, proj } = sandbox();
  try {
    fs.rmSync(path.join(proj, '.coalwash.json')); // remove the sandbox's own root legacy first
    fs.mkdirSync(path.join(proj, '.claude', 'coal'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'coal', 'coalwash.json'), '{}\n', 'utf8');
    const r = run(proj, home, ['config-status']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '[CoalWash] config: canonical, nothing to report.');
  } finally { clean(home, proj); }
});

test('config-status: a stray .coalwash.json under .gemini (bare) is reported as IGNORED, alongside the legacy notice', () => {
  const { home, proj } = sandbox(); // still carries the sandbox's own root legacy
  try {
    fs.mkdirSync(path.join(proj, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.gemini', '.coalwash.json'), '{}\n', 'utf8');
    const r = run(proj, home, ['config-status']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`IGNORED: ${path.join(proj, '.gemini', '.coalwash.json')} is not a config path`), r.stdout);
    assert.ok(r.stdout.includes('Config read from a LEGACY path'), 'both holes fire independently in one call');
  } finally { clean(home, proj); }
});

test('config-status --json: the raw resolution + ignored shape, machine-readable', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['config-status', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.resolution.legacy, true);
    assert.strictEqual(j.resolution.path, path.join(proj, '.coalwash.json'));
    assert.deepStrictEqual(j.ignored, []);
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
    // The fat figure is a LOWER BOUND and the line must say so in EITHER
    // shape — `certain fat ~N tok (lower bound)` when something was proven,
    // or `no provable fat (lower bound — ...)` when nothing was. Pinning the
    // bound label rather than one phrasing is stricter than the old
    // `/certain fat ~\d+ tok/`: that regex passed on a line making a bare
    // clean-bill claim, which is the defect this wording fixes.
    assert.match(gaugeLine(g), /\(lower bound/);
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
});

// grad9 R8-F6 (carried from round 8, never routed until now): the assertion
// this test used to make — that 'partial' reads as "recovered dangling run:
// partial", the SAME shape as a clean success — WAS THE BUG, encoded as an
// expected value. `recoverDangling` sets `error` alongside
// `recovered:'partial'` specifically because SOME restore failed or was
// refused (journal + snapshot kept, a mixed on-disk state) — the one outcome
// that most needs the reader's attention read exactly like full success and
// `rec.error` was never surfaced. RED-FIRST: swap cli.mjs to HEAD (pre-fix),
// this must fail (the old 'recovered dangling run: partial' text, no mention
// of the failure/refusal or that anything needs a look).
test('RED-FIRST/R8-F6: gaugeLine gives a PARTIAL recovery its own visible clause, distinct from a clean success', () => {
  const base = { verdict: { band: 'LEAN', bmi: 0 }, measure: { alwaysLoaded: { tokensEst: 1000 } } };
  const partial = gaugeLine({ ...base, recover: { recovered: 'partial', restored: 1, error: 'x' } });
  assert.match(partial, /PARTIALLY recovered/i, `a partial recovery must be visibly distinct from a clean one (got: ${partial})`);
  assert.doesNotMatch(partial, /recovered dangling run: partial/, 'must not read as the generic success clause');
  assert.match(partial, /--json/, 'must point at where the failure/refusal detail lives');
});

test('RED-FIRST/R8-F6 control: a clean success (rolled-back/cleaned/no-mutation) still reports as itself, unaffected by the partial-specific clause', () => {
  const base = { verdict: { band: 'LEAN', bmi: 0 }, measure: { alwaysLoaded: { tokensEst: 1000 } } };
  for (const recovered of ['rolled-back', 'cleaned', 'no-mutation']) {
    const line = gaugeLine({ ...base, recover: { recovered } });
    assert.match(line, new RegExp(`recovered dangling run: ${recovered}`), `${recovered} must still read as a plain success`);
    assert.doesNotMatch(line, /PARTIALLY/i);
  }
});


// ---------------------------------------------------------------------------
// CWK-081 — the capacity adapter's flag, on the one line a reader sees
// ---------------------------------------------------------------------------

test('CWK-081: gaugeLine NAMES a conservative-default ceiling where it is load-bearing (FULL), stays quiet about it where it is not (LEAN)', () => {
  const base = { measure: { alwaysLoaded: { tokensEst: 200000 } }, capacity: { capacityTokens: 167000, source: 'conservative-default', discovered: false } };
  const full = gaugeLine({ ...base, verdict: { band: 'FULL', bmi: 1 } });
  assert.match(full, /capacity ~167000 tok/, 'the number the band was judged against');
  assert.match(full, /CONSERVATIVE DEFAULT/, 'and that it is a DEFAULT, not a discovery — the blueprint flag, surfaced');
  const lean = gaugeLine({ ...base, verdict: { band: 'LEAN', bmi: 1 } });
  assert.ok(!/capacity ~/.test(lean), 'a store nowhere near the ceiling is not told about the ceiling');
});

test('CWK-081: a DISCOVERED ceiling is named on every band — it is a measurement, not a caveat', () => {
  const line = gaugeLine({
    verdict: { band: 'LEAN', bmi: 1 },
    measure: { alwaysLoaded: { tokensEst: 1000 } },
    capacity: { capacityTokens: 967000, source: 'stats-cache', discovered: true },
  });
  assert.match(line, /capacity ~967000 tok \(discovered: stats-cache\)/, line);
  assert.ok(!/CONSERVATIVE DEFAULT/.test(line));
});

test('CWK-081: a gauge object with NO capacity block renders exactly as before (every pre-CWK-081 caller unmoved)', () => {
  const line = gaugeLine({ verdict: { band: 'FULL', bmi: 1 }, measure: { alwaysLoaded: { tokensEst: 1000 } } });
  assert.ok(!/capacity ~/.test(line), line);
});

// r34c: the entry-point guard compared import.meta.url (Node resolves the entry file to its
// REALPATH) with argv[1] (the path it was invoked by). Through a symlink or a junction the two
// differed, main() never ran, and every command exited 0 with no output. A directory junction
// needs no admin rights on Windows; a host that cannot make one skips.
test('r34c: invoked through a directory junction, the CLI still runs (no subcommand: usage, exit 1)', (t) => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-junction-'));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true })); // rmSync does not follow a junction (probed)
  const link = path.join(holder, 'lib-link');
  try {
    fs.symlinkSync(here, link, 'junction');
  } catch (e) {
    return t.skip(`cannot create a junction or directory symlink on this host (${e.code || e.message})`);
  }
  const r = spawnSync(process.execPath, [path.join(link, 'cli.mjs')], {
    cwd: holder,
    env: { ...process.env, HOME: holder, USERPROFILE: holder, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.strictEqual(r.status, 1, `through the junction: exit ${r.status}, output ${JSON.stringify(r.stdout + r.stderr)}`);
  assert.match(r.stderr, /^usage: node scripts\/lib\/cli\.mjs/);
});

// ---------------------------------------------------------------------------
// CWK-137 D3 restore-door hint (the sizing ruling): estate.archiveDir is read from the GLOBAL config only, so a user who once set it in
// a PROJECT config would otherwise find estate-search / estate-restore silently looking somewhere else. Both say so on STDERR, on every
// run, when the project layer carries a value the clamp dropped: the ignored path, the directory this run actually read, the global
// config to set it in. Stdout and the exit code are untouched, so a script reading them sees the ordinary output.
// ---------------------------------------------------------------------------
const D3_HINT = /^\[CoalWash\] estate\.archiveDir[: ]/;
function d3ProjectArchiveDir(proj, value) {
  fs.writeFileSync(path.join(proj, '.coalwash.json'), JSON.stringify({ estate: { archiveDir: value } }));
}
const d3HintLines = (stderr) => stderr.split(/\r?\n/).filter((l) => D3_HINT.test(l));

test('CWK-137 D3 hint: estate-search names an ignored PROJECT estate.archiveDir on stderr -- the ignored path, the directory it read, the global config to use -- and leaves stdout and the exit code alone', () => {
  const { home, proj } = sandbox();
  try {
    const ignored = path.join(os.tmpdir(), 'cw-d3-cli-someone-elses-archive');
    d3ProjectArchiveDir(proj, ignored);
    const withValue = run(proj, home, ['estate-search', 'anything']);
    assert.strictEqual(withValue.status, 0, withValue.stderr);
    const lines = d3HintLines(withValue.stderr);
    assert.strictEqual(lines.length, 1, `exactly one hint line, got: ${withValue.stderr}`);
    const readDir = path.join(home, '.claude', 'coal', 'coalwash', 'estate-archive');
    assert.ok(lines[0].includes(`asks for ${ignored}, and that was ignored.`), 'names what the project config ASKED for, once, as a description');
    assert.strictEqual(lines[0].split(ignored).length - 1, 1, 'the repo-chosen value appears ONCE: never restated inside an imperative (N-2)');
    assert.ok(lines[0].includes('A cloned repo ships a project config, and it must not be able to choose where your own session transcripts are archived, so this key is read from the GLOBAL config only.'), 'states the security REASON (configure.mjs\'s own sentence), not only the mechanism (N-2)');
    assert.ok(lines[0].includes(`This run read ${readDir}.`), 'names the directory this run actually read, in the sentence that says so');
    assert.ok(lines[0].includes(path.join(home, '.claude', '.coalwash.json')), 'names the GLOBAL config the code reads (claudeBaseDir), not a literal ~/.claude');
    assert.ok(lines[0].includes(`If you set that path yourself and want it used, set estate.archiveDir in ${path.join(home, '.claude', '.coalwash.json')}, or move the archives that path holds into ${readDir}.`), 'every remedy is conditional on the user having set the path themselves (N-2)');
    assert.ok(!/(^|[.,] )(To use|Set|Use) /.test(lines[0]), 'no unconditional imperative at all');
    fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}');
    const without = run(proj, home, ['estate-search', 'anything']);
    assert.strictEqual(without.status, 0, without.stderr);
    assert.strictEqual(d3HintLines(without.stderr).length, 0, 'no project value, no hint');
    assert.strictEqual(withValue.stdout, without.stdout, 'stdout is the ordinary output, byte for byte');
    assert.strictEqual(withValue.status, without.status, 'and so is the exit code');
  } finally { clean(home, proj); }
});

test('CWK-137 D3 hint: estate-restore prints it on EVERY run, beside its ordinary not-found line; a hint never changes the exit code or stdout', () => {
  const { home, proj } = sandbox();
  try {
    d3ProjectArchiveDir(proj, path.join(os.tmpdir(), 'cw-d3-cli-restore-dir'));
    for (let i = 0; i < 2; i++) {
      const r = run(proj, home, ['estate-restore', 'no-such-session']);
      assert.strictEqual(r.status, 1, 'the ordinary not-found failure, exit 1');
      assert.strictEqual(d3HintLines(r.stderr).length, 1, `run ${i}: the hint is there every time, not only the first, and not only when the default dir is empty`);
      assert.match(r.stderr, /estate-restore: /, 'beside the ordinary error line, which is still printed');
      assert.strictEqual(r.stdout, '', 'stdout stays empty');
    }
  } finally { clean(home, proj); }
});

test('CWK-137 D3 hint: a user\'s own GLOBAL archiveDir is the directory named as "read"; a project value that only restates it draws no hint', () => {
  const { home, proj } = sandbox();
  try {
    const mine = path.join(home, 'my-archive');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify({ estate: { archiveDir: mine } }));
    d3ProjectArchiveDir(proj, path.join(os.tmpdir(), 'cw-d3-cli-other'));
    const other = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(other.status, 0, other.stderr);
    const lines = d3HintLines(other.stderr);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes(`This run read ${mine}.`), 'this run read the GLOBAL value');
    d3ProjectArchiveDir(proj, mine);
    assert.strictEqual(d3HintLines(run(proj, home, ['estate-search', 'x']).stderr).length, 0, 'the project restated the global value: nothing was ignored');
  } finally { clean(home, proj); }
});

test('CWK-137 D3 hint: the value comes from a cloned repo, so the line is ONE line and bounded -- a newline in it cannot forge a second stderr line (log injection)', () => {
  const { home, proj } = sandbox();
  try {
    d3ProjectArchiveDir(proj, `${path.join(os.tmpdir(), 'x')}\nFORGED-LINE ${'a'.repeat(5000)}`);
    const r = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(r.status, 0, r.stderr);
    const all = r.stderr.split(/\r?\n/);
    assert.ok(all.every((l) => !l.startsWith('FORGED-LINE')), 'the forged text did not start a line of its own');
    const lines = d3HintLines(r.stderr);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].length < 1500, `bounded, not ${lines[0].length} characters`);
  } finally { clean(home, proj); }
});

// CWK-137 D3 hint, R11d bounce 2 (N-3, N-4). Invisible characters are built with String.fromCharCode, never written as escapes or as
// literal characters, so this file cannot itself carry a bidi override.
// N-3: resolveArchiveDir drops a NON-absolute value on either layer, so a relative project value never directed archives anywhere and the D3
// clamp changed nothing for it. A line saying it was ignored "because global-only" names the wrong cause, and the remedy it gave (the same
// relative value in the global config) does nothing while silencing the hint: a mismatch the hint itself produced.
test('CWK-137 D3 hint: a RELATIVE project estate.archiveDir draws no hint -- the clamp changed nothing for it (N-3)', () => {
  const { home, proj } = sandbox();
  try {
    d3ProjectArchiveDir(proj, 'rel/archive');
    const r = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(d3HintLines(r.stderr).length, 0, `a relative value never directed anything: nothing to say, got ${r.stderr}`);
    fs.writeFileSync(path.join(home, '.claude', '.coalwash.json'), JSON.stringify({ estate: { archiveDir: 'rel/archive' } }));
    const r2 = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual(d3HintLines(r2.stderr).length, 0, 'the same relative value in the global config: still silent, and the run still reads the default');
    d3ProjectArchiveDir(proj, path.join(os.tmpdir(), 'cw-n3-absolute'));
    assert.strictEqual(d3HintLines(run(proj, home, ['estate-search', 'x']).stderr).length, 1, 'control: an ABSOLUTE ignored value is still reported, so the silence above is the filter and not a dead hint');
  } finally { clean(home, proj); }
});

// N-4: Cc/Zl/Zp were flattened but not Cf, the class that carries the right-to-left override (Trojan Source) and the zero-width characters.
// A repo-chosen path could display differently from the bytes it holds, in the line an agent may copy from.
test('CWK-137 D3 hint: invisible format characters from a cloned repo (a right-to-left override, a zero-width space) are flattened (N-4)', () => {
  const { home, proj } = sandbox();
  try {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    const base = path.join(os.tmpdir(), 'cw-n4-');
    d3ProjectArchiveDir(proj, `${base}${rlo}evil${zwsp}path`);
    const r = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = d3HintLines(r.stderr);
    assert.strictEqual(lines.length, 1);
    assert.ok(!lines[0].includes(rlo), 'the bidi override did not survive into the line');
    assert.ok(!lines[0].includes(zwsp), 'the zero-width space did not survive into the line');
    assert.ok(lines[0].includes(`${base} evil path`), 'each was flattened to one space and the readable part kept');
  } finally { clean(home, proj); }
});

// N-4 NIT: the 300-character cut sliced UTF-16 units and could leave a lone high surrogate, which a stderr write turns into U+FFFD.
test('CWK-137 D3 hint: the 300-character cut never splits a surrogate pair (N-4)', () => {
  const { home, proj } = sandbox();
  try {
    const base = path.join(os.tmpdir(), 'cw-n4s-');
    const emoji = String.fromCodePoint(0x1f600);
    d3ProjectArchiveDir(proj, `${base}${'a'.repeat(299 - base.length)}${emoji}${'b'.repeat(50)}`);
    const r = run(proj, home, ['estate-search', 'x']);
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = d3HintLines(r.stderr);
    assert.strictEqual(lines.length, 1);
    assert.ok(!r.stderr.includes(String.fromCharCode(0xfffd)), 'no U+FFFD: a lone surrogate written to stderr decodes as one');
    assert.ok(lines[0].includes(`${emoji}...`), 'the whole character was kept and the cut marker follows it (the cut is by code point)');
  } finally { clean(home, proj); }
});
