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
function run(cwd, home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('gauge --json: one call returns recover + platform + measure + verdict + breakEven, exit 0', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['gauge', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.strictEqual(g.recover.recovered, 'none');
    assert.strictEqual(g.platform, 'claude-code');
    assert.ok(g.measure.alwaysLoaded.tokensEst > 0, 'the seeded CLAUDE.md was measured');
    assert.ok(['LEAN', 'PLUMP', 'OBESE', 'FULL'].includes(g.verdict.band));
    assert.strictEqual(typeof g.breakEven.economical, 'boolean');
    assert.strictEqual(g.breakEven.floorUnmeasured, true, 'no floor stamped in a fresh sandbox');
  } finally { clean(home, proj); }
});

test('gauge is READ-ONLY toward CoalWash state: no state file, no stamp, no verdict cache is written', () => {
  const { home, proj } = sandbox();
  try {
    const r = run(proj, home, ['gauge', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', '.coalwash-state.json')), false,
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
    assert.match(lines[0], /^\[CoalWash\] (LEAN|PLUMP|OBESE|FULL) — always-loaded ~\d+ tok\/session \(~est\)/);
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

test('gauge() direct call: honors an explicit home/cwd and applies the floor sanitizer', () => {
  const { home, proj } = sandbox();
  // claudeBaseDir consults CLAUDE_CONFIG_DIR before the home argument — clear
  // it for the in-process call so the sandbox home stays hermetic.
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    // A poisoned (grossly-implausible) stored floor must be discarded, not trusted.
    const key = fs.realpathSync(proj);
    fs.writeFileSync(path.join(home, '.claude', '.coalwash-state.json'),
      JSON.stringify({ projects: { [key]: { leanFloorTokens: 10 ** 9 } } }), 'utf8');
    const g = gauge({ cwd: proj, home });
    assert.strictEqual(g.breakEven.floorUnmeasured, true, 'sanitizeLeanFloor discarded the poisoned floor');
    assert.match(gaugeLine(g), /no floor yet/);
  } finally {
    if (savedEnv !== undefined) process.env.CLAUDE_CONFIG_DIR = savedEnv;
    clean(home, proj);
  }
});
