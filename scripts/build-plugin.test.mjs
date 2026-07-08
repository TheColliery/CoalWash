import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDist, checkDist, DIST_ITEMS } from './build-plugin.mjs';

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
