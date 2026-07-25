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
    assert.ok(drift.some((d) => d.includes('no DIST_ITEM accounts for it')), drift.join('; '));
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('TP-6: a stray dot-dir under a DIST_ITEM never ships, and the exclusion is not a blind spot (a planted one fails loud)', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    // The real stray that motivated this: a CoalHearth journal written into the
    // engine dir by a command whose cwd was scripts/lib. Gitignored, so a git
    // install is safe — but the ZIP / --plugin-dir surfaces ship the tree as-is.
    assert.strictEqual(fs.existsSync(path.join(dist, 'scripts', 'lib', '.claude')), false, 'no .claude/ rides the engine dir into the dist');
    assert.deepStrictEqual(checkDist(dist), [], 'in sync with the stray present in source');
    fs.mkdirSync(path.join(dist, 'scripts', 'lib', '.claude', 'coalhearth'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'scripts', 'lib', '.claude', 'coalhearth', 'session_handoff.json'), '{"session":"leaked"}');
    assert.ok(checkDist(dist).some((d) => d.includes('stray dot-entry in plugin/')), 'a planted dot-dir fails loud, not silently cleared as "has a source"');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('TP-6 regression: the dot-dir exclusion is scoped BELOW the item — `.claude-plugin/plugin.json` is itself a dot-named DIST_ITEM and MUST still ship (a whole-path test dropped the manifest AND blinded checkDist to it)', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    const manifest = path.join(dist, '.claude-plugin', 'plugin.json');
    assert.ok(fs.existsSync(manifest), 'the plugin manifest ships');
    assert.strictEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).name, 'coalwash');
    // and its absence must be VISIBLE, not skipped by the exclusion
    fs.rmSync(manifest, { force: true });
    assert.ok(checkDist(dist).some((d) => d.includes('missing in plugin/')), 'a missing manifest fails loud');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('R2/TP-4: absence is asserted over EXACTLY the excluded set — a dist-only dot-FILE orphan is caught, not just a dot-DIR (the assert used to enumerate dirs only)', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    fs.writeFileSync(path.join(dist, 'scripts', 'lib', '.env'), 'SECRET=leaked');
    assert.ok(checkDist(dist).some((d) => d.includes('stray dot-entry in plugin/')), 'a dot-FILE orphan fails loud (pre-fix: checkDist() === [] while verify printed "nothing else leaked")');
    buildDist(dist);
    fs.mkdirSync(path.join(dist, 'scripts', 'lib', '.cache'), { recursive: true });
    assert.ok(checkDist(dist).some((d) => d.includes('stray dot-entry in plugin/')), 'a dot-DIR orphan still fails loud');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('R2/TP-5: a FILE-shaped DIST_ITEM has its PARENT dir enumerated — anything planted beside .claude-plugin/plugin.json is an orphan', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    assert.deepStrictEqual(checkDist(dist), [], 'clean build stays clean');
    fs.writeFileSync(path.join(dist, '.claude-plugin', 'marketplace.json'), '{"plugins":[]}');
    assert.ok(checkDist(dist).some((d) => d.includes('orphan in plugin/')), 'a repo file planted beside the manifest is caught (pre-fix: silent — only plugin.json itself was ever checked)');
    buildDist(dist);
    fs.mkdirSync(path.join(dist, '.claude-plugin', 'junk'), { recursive: true });
    assert.ok(checkDist(dist).some((d) => d.includes('orphan in plugin/')), 'a whole planted dir beside it is caught too');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('R3/TP-2: the dist gate accounts for EVERY entry at EVERY depth — plugin/scripts/ (parent of the directory item scripts/lib) was never walked', () => {
  const dist = scratchDist();
  try {
    for (const plant of [
      ['scripts', 'leak.mjs'],
      ['scripts', 'junk', 'deep', 'x.mjs'],
      ['scripts', '.claude', 'coalhearth', 'session_handoff.json'], // the literal R1 incident, one dir up
    ]) {
      buildDist(dist);
      assert.deepStrictEqual(checkDist(dist), [], 'clean build is clean');
      const p = path.join(dist, ...plant);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'leaked');
      assert.ok(checkDist(dist).length > 0, `planted ${plant.join('/')} must be caught (pre-fix: allowedTops admitted "scripts" and nothing walked it)`);
    }
    buildDist(dist);
    fs.mkdirSync(path.join(dist, 'scripts', 'emptyjunk'), { recursive: true });
    assert.ok(checkDist(dist).some((d) => d.includes('orphan in plugin/')), 'an empty planted dir is caught too');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('R4/TP-4: a planted *.test.* inside a DIST_ITEM fails loud — isTest was the third exclusion sharing the walks and the only one with no absence-assert (sweepUnaccounted skips it: it IS under a DIST_ITEM)', () => {
  const dist = scratchDist();
  try {
    for (const plant of [['scripts', 'lib', 'pwned.test.mjs'], ['hooks', 'pwned.test.js']]) {
      buildDist(dist);
      assert.deepStrictEqual(checkDist(dist), [], 'clean build is clean');
      fs.writeFileSync(path.join(dist, ...plant), '// planted');
      assert.ok(checkDist(dist).some((d) => d.includes('test artifact present in plugin/')), `${plant.join('/')} must fail loud`);
    }
    // a DIRECTORY named *.test.mjs was an unlimited unchecked subtree
    buildDist(dist);
    fs.mkdirSync(path.join(dist, 'scripts', 'lib', 'x.test.mjs', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'scripts', 'lib', 'x.test.mjs', 'deep', 'anything.js'), '// hidden subtree');
    assert.ok(checkDist(dist).some((d) => d.includes('test artifact present in plugin/')), 'a *.test.* DIRECTORY is caught too');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
