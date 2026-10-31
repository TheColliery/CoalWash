import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDist, checkDist, DIST_ITEMS, DEV_ONLY_LIBS } from './build-plugin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function scratchDist() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dist-')));
}

test('buildDist produces a clean, in-sync dist: manifest + hooks + engine, tests filtered out', () => {
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

test('CWK-174: every DEV_ONLY_LIBS entry never ships: absent from a fresh dist, checkDist still PASSES with them in source, and a hand-copied one fails loud', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    assert.ok(DEV_ONLY_LIBS.length >= 9, `the list is read from build-plugin.mjs (${DEV_ONLY_LIBS.length} entries)`);
    for (const rel of DEV_ONLY_LIBS) {
      assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} IS in source (dev tooling, gated by the suite)`);
      assert.strictEqual(fs.existsSync(path.join(dist, rel)), false, `${rel} is NOT in the dist (dev tooling, not plugin payload)`);
    }
    assert.deepStrictEqual(checkDist(dist), [], 'source-present + dist-absent is IN SYNC: the exclusion is what makes verify PASS');
    // ...and the exclusion is not a blind spot: a hand-copied dev-only lib in the dist is caught.
    for (const rel of DEV_ONLY_LIBS) {
      fs.copyFileSync(path.join(repoRoot, rel), path.join(dist, rel));
      assert.ok(checkDist(dist).some((d) => d.includes('dev-only lib present in plugin/') && d.includes(rel)), `a leaked ${rel} fails loud`);
      fs.rmSync(path.join(dist, rel));
    }
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

// board #56 (both fixtures below): a blind `.replace(/\n/g, '\r\n')` assumes the
// input is currently LF. On a CRLF working copy every existing `\r\n` becomes
// `\r\r\n`, which contentEquals's own single-pass `\r\n -> \n` normalization
// does not fully collapse — the pass matches the SECOND pair and consumes it,
// leaving a stray `\r` immediately ahead of the surviving `\n`, not a bare `\r`
// standing alone. That is a real, permanent divergence from the true source,
// independent of the working tree's own line-ending state. Fix: always
// normalize to a clean LF baseline FIRST, then re-encode in whichever style the
// REAL source is NOT currently using — so the fixture never starts from an
// ambiguous "is this already CRLF?" state and never glues `\r\r\n`.
function realHooksJson() {
  return fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json'), 'utf8');
}
function encodeOppositeOfSource(lfText) {
  return realHooksJson().includes('\r\n') ? lfText : lfText.replace(/\n/g, '\r\n');
}

test('board #56: a CRLF-vs-LF-only difference is NOT stale — content parity, not byte parity', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    const p = path.join(dist, 'hooks', 'hooks.json');
    const lf = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(p, encodeOppositeOfSource(lf));
    assert.notStrictEqual(fs.readFileSync(path.join(repoRoot, 'hooks', 'hooks.json')).compare(fs.readFileSync(p)), 0, 'sanity: the bytes really do differ');
    assert.deepStrictEqual(checkDist(dist), [], 'a pure line-ending difference must not read as stale');
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});

test('board #56: a REAL content difference across differing line-ending styles still fails loud — the normalization must not mask an actual edit', () => {
  const dist = scratchDist();
  try {
    buildDist(dist);
    const p = path.join(dist, 'hooks', 'hooks.json');
    const lf = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') + '\n// tampered';
    fs.writeFileSync(p, encodeOppositeOfSource(lf));
    const drift = checkDist(dist);
    assert.ok(drift.some((d) => d.includes('stale in plugin/') && d.includes('hooks.json')), drift.join('; '));
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

// r34c C: the main-module guard compared import.meta.url (Node resolves the entry file to its
// REALPATH) with argv[1] (the path it was invoked by). Through a symlink or a junction the two
// differ and neither the build nor --check ran: exit 0, no output. --check is read-only; its
// verdict line is asserted to APPEAR, not to be "in sync" (a concurrent test can plant into
// scripts/lib). A host that cannot make a directory junction skips.
test('r34c C: invoked through a directory junction, build-plugin.mjs --check still runs and prints its verdict', (t) => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-build-junction-'));
  t.after(() => fs.rmSync(holder, { recursive: true, force: true })); // rmSync does not follow a junction (probed)
  const link = path.join(holder, 'scripts-link');
  try {
    fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, 'junction');
  } catch (e) {
    return t.skip(`cannot create a junction or directory symlink on this host (${e.code || e.message})`);
  }
  const r = spawnSync(process.execPath, [path.join(link, 'build-plugin.mjs'), '--check'], { cwd: holder, encoding: 'utf8' });
  assert.match(r.stdout + r.stderr, /plugin\/ dist (in sync with source|OUT OF SYNC)/, `through the junction: exit ${r.status}, output ${JSON.stringify(r.stdout + r.stderr)}`);
});

// ---- CWK2-079: a link in a source the build copies is refused by name, and a link in plugin/ is named, never followed. ----
// The port of CoalLedger d36c2ea and 4e61638. Each witness builds from a fixture copy of the sources under os.tmpdir(), never the
// real repo. A directory junction needs no privilege on Windows; a file symlink does, so its leg probes and skips VISIBLY.

// A fixture copy of every DIST_ITEM source, so a witness can plant a link without touching the real tree.
function fixtureSources(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-build-src-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); // rmSync unlinks a link, it does not follow it (probed above)
  for (const rel of DIST_ITEMS) {
    const src = path.join(repoRoot, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(root, rel), { recursive: true });
  }
  return root;
}

function scratchDistFor(t) {
  const d = scratchDist();
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A folder outside every source and dist, holding one file. A link into it must never be read through.
function outsideFolder(t) {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-build-out-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'payload.txt'), 'outside the tree\n', 'utf8');
  return d;
}

// Creates a link, or skips the test VISIBLY (returns false) when the host refuses it.
function tryLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    t.skip(`cannot create a ${type} on this host (${e.code || e.message}); the Linux CI legs run this leg`);
    return false;
  }
}

test('CWK2-079: a directory junction inside a DIST_ITEM source is refused by name, and the old dist is left in place', (t) => {
  const clean = fixtureSources(t);
  const dist = scratchDistFor(t);
  buildDist(dist, clean);
  const linked = fixtureSources(t);
  if (!tryLink(t, outsideFolder(t), path.join(linked, 'hooks', 'linked'), 'junction')) return;
  assert.throws(() => buildDist(dist, linked), /hooks[\\/]linked: a link or junction in the source tree is refused/, 'the refusal names the junction in its own words, not a copy error that quotes the path');
  assert.ok(fs.existsSync(path.join(dist, '.claude-plugin', 'plugin.json')), 'the old dist survives a refused build');
  assert.deepStrictEqual(checkDist(dist, clean), [], 'the surviving dist is still in sync with the clean source');
});

test('CWK2-079: a junction at a PARENT folder of a DIST_ITEM is refused by name, and the old dist is left in place', (t) => {
  const clean = fixtureSources(t);
  const dist = scratchDistFor(t);
  buildDist(dist, clean);
  const linked = fixtureSources(t);
  fs.renameSync(path.join(linked, 'scripts'), path.join(linked, 'scripts-real'));
  if (!tryLink(t, path.join(linked, 'scripts-real'), path.join(linked, 'scripts'), 'junction')) return;
  assert.throws(() => buildDist(dist, linked), /scripts: a link or junction in the source tree is refused/, 'the refusal names the parent junction (scripts), not the child (scripts/lib)');
  assert.ok(fs.existsSync(path.join(dist, '.claude-plugin', 'plugin.json')), 'the old dist survives a refused build');
});

test('CWK2-079: a junction inside plugin/ is named by checkDist and never followed into its target', (t) => {
  const clean = fixtureSources(t);
  const dist = scratchDistFor(t);
  buildDist(dist, clean);
  if (!tryLink(t, outsideFolder(t), path.join(dist, 'hooks', 'linked'), 'junction')) return;
  const out = checkDist(dist, clean);
  assert.ok(out.some((l) => l.startsWith('link in plugin/') && l.includes(path.join('hooks', 'linked'))), `named: ${JSON.stringify(out)}`);
  assert.ok(!out.some((l) => l.includes('payload.txt')), `the junction's target is not followed: ${JSON.stringify(out)}`);
});

test('CWK2-079: a DANGLING junction in plugin/ is named, not read as an absent path', (t) => {
  const clean = fixtureSources(t);
  const dist = scratchDistFor(t);
  buildDist(dist, clean);
  const gone = path.join(os.tmpdir(), `cw-build-gone-${process.pid}-${Date.now()}`); // never created
  if (!tryLink(t, gone, path.join(dist, 'hooks', 'dangling'), 'junction')) return;
  const out = checkDist(dist, clean);
  assert.ok(out.some((l) => l.startsWith('link in plugin/') && l.includes('dangling')), `named: ${JSON.stringify(out)}`);
});

test('CWK2-079: a file symlink inside a DIST_ITEM source is refused by name (probed: needs privilege on Windows, skips visibly when absent)', (t) => {
  const src = fixtureSources(t);
  const dist = scratchDistFor(t);
  const target = path.join(outsideFolder(t), 'payload.txt');
  if (!tryLink(t, target, path.join(src, 'hooks', 'filelink.txt'), 'file')) return;
  assert.throws(() => buildDist(dist, src), /hooks[\\/]filelink\.txt: a link or junction in the source tree is refused/, 'the refusal names the file link in its own words');
});

test('CWK2-079: a junction at a parent folder inside plugin/ is named by checkDist, not walked', (t) => {
  const clean = fixtureSources(t);
  const dist = scratchDistFor(t);
  buildDist(dist, clean);
  fs.renameSync(path.join(dist, 'scripts'), path.join(dist, 'scripts-real'));
  if (!tryLink(t, path.join(dist, 'scripts-real'), path.join(dist, 'scripts'), 'junction')) return;
  const out = checkDist(dist, clean);
  assert.ok(out.some((l) => l.startsWith('link in plugin/') && l.endsWith('scripts')), `named: ${JSON.stringify(out)}`);
});
