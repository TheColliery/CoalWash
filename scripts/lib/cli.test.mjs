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
import { fileURLToPath } from 'node:url';
import { gauge, gaugeLine } from './cli.mjs';
import { FAT_BIN_NAME, STORE_OLD_NAME, recordBinItem } from './bins.mjs';
import { snapshotOnFirstWrite } from './writeguard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-proj-')));
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
  const slug = fs.realpathSync(proj).replace(/[^A-Za-z0-9]/g, '-');
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
    assert.strictEqual(g.breakEven.floorUnmeasured, true, 'no floor stamped in a fresh sandbox');
  } finally { clean(home, proj); }
});

test('gauge is READ-ONLY toward CoalWash state: no state file, no stamp, no verdict cache is written', () => {
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

test('gauge() direct call: honors an explicit home/cwd and applies the floor sanitizer', () => {
  const { home, proj } = sandbox();
  // claudeBaseDir consults CLAUDE_CONFIG_DIR before the home argument — clear
  // it for the in-process call so the sandbox home stays hermetic.
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    // A poisoned (grossly-implausible) stored floor must be discarded, not trusted.
    const sp = projStatePath(home, proj);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ leanFloorTokens: 10 ** 9 }), 'utf8');
    const g = gauge({ cwd: proj, home });
    assert.strictEqual(g.breakEven.floorUnmeasured, true, 'sanitizeLeanFloor discarded the poisoned floor');
    assert.match(gaugeLine(g), /no floor yet/);
  } finally {
    if (savedEnv !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv;
    clean(home, proj);
  }
});
