import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist, DIST_ITEMS } from './build-plugin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratchDist() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dist-')));
}

test('buildDist produces a clean, in-sync dist: manifest + bin + hooks + engine, tests filtered out', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    assert.deepStrictEqual(checkDist(dist), [], 'freshly built dist is in sync');
    assert.ok(fs.existsSync(path.join(dist, '.claude-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dist, 'hooks', 'coalwash-conductor.js')));
    assert.ok(fs.existsSync(path.join(dist, 'hooks', 'hooks.json')));
    assert.ok(fs.existsSync(path.join(dist, 'skills', 'coalwash', 'SKILL.md')), 'skill ships');
    assert.ok(fs.existsSync(path.join(dist, 'skills', 'coalwash', 'references', 'method.md')), 'references ship');
    assert.ok(fs.existsSync(path.join(dist, 'commands', 'stats.md')), 'commands ship');
    assert.ok(fs.existsSync(path.join(dist, 'scripts', 'lib', 'fidelity-gate.mjs')));
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.strictEqual(walk(dist).some((f) => /\.test\.[cm]?js$/.test(f)), false, 'no test files ship');
    assert.ok(DIST_ITEMS.length >= 4, 'dist item set stays explicit');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('the UNWIRED class-A engine never ships: absent from a fresh dist, checkDist still PASSES with it in source, and a hand-copied one fails loud', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    for (const name of ['explode.mjs', 'detonate.mjs']) {
      assert.ok(fs.existsSync(path.join(repoRoot, 'scripts', 'lib', name)), `${name} IS in source (landed, gated by the suite)`);
      assert.strictEqual(fs.existsSync(path.join(dist, 'scripts', 'lib', name)), false, `${name} is NOT in the dist (unwired -> unshipped)`);
    }
    assert.deepStrictEqual(checkDist(dist), [], 'source-present + dist-absent is IN SYNC — the exclusion is what makes verify PASS');
    // ...and the exclusion is not a blind spot: a hand-copied engine file is caught.
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', 'explode.mjs'), path.join(dist, 'scripts', 'lib', 'explode.mjs'));
    assert.ok(checkDist(dist).some((d) => d.includes('unwired class-A engine present in plugin/')), 'a leaked engine file fails loud');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('checkDist fails loud in both directions: stale file and orphan', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    fs.appendFileSync(path.join(dist, 'hooks', 'hooks.json'), '\n// tampered');
    let drift = checkDist(dist);
    assert.ok(drift.some((d) => d.includes('stale in plugin/')), drift.join('; '));
    buildDist(dist);
    fs.writeFileSync(path.join(dist, 'hooks', 'orphan.js'), '// no source');
    drift = checkDist(dist);
    assert.ok(drift.some((d) => d.includes('orphan in plugin/')), drift.join('; '));
    fs.mkdirSync(path.join(dist, 'unexpected-top'), { recursive: true });
    drift = checkDist(dist);
    assert.ok(drift.some((d) => d.includes('orphan top-level')), drift.join('; '));
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
