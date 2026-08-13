// VERIFY-GATE LIVENESS — the gate must REPORT its own failure, never die of it.
//
// WHAT WENT WRONG. verify.mjs carried two STATIC top-level imports of
// scripts/lib/ modules. ESM resolves a static import while linking the module
// graph, BEFORE the first try/catch in the file exists — so on a sparse
// caretaker bench (scripts/lib/ checked out minus config-schema.mjs) the gate
// died with a raw ERR_MODULE_NOT_FOUND and printed ZERO `FAIL <item>` lines.
// Every per-check wrap in that file was correct: a per-check wrap structurally
// cannot cover the file's own imports.
//
// WHY THIS OUTRANKS TIDINESS: a gate that dies is indistinguishable from a gate
// that was never run. The bench reported nothing, which reads exactly like
// nothing to report.
//
// WHAT THIS ASSERTS: the REAL verify.mjs, run against an EMPTY tree (the
// maximal form of "a required file is missing"), honours the fail-loud contract
// scripts-quality.md §1 sets and verify.mjs's own header claims — non-zero
// exit, one enumerated FAIL line per missing item, its own summary line, and no
// raw stack trace.
//
// PROVED RED, not assumed: restoring either static import empties stdout and
// puts an ERR_MODULE_NOT_FOUND trace on stderr, flipping assertions 2-4.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify.mjs');

test('verify.mjs REPORTS missing scripts/lib files instead of dying on them', () => {
  // verify.mjs derives `repo` from its OWN location, so a lone copy in an empty
  // tree makes every required file missing — no repo copy, no mutation of the
  // real checkout. Fixture root canonicalized the engine's way (.native).
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-verifygate-')));
  try {
    const dest = path.join(root, 'scripts', 'verify.mjs');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(VERIFY, dest);

    const r = spawnSync(process.execPath, [dest], { encoding: 'utf8' });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';

    assert.notStrictEqual(r.status, 0, `fail LOUD: everything is missing, exit must be non-zero\n${stdout}`);
    assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND/, `the gate must not die on its own imports\n${stderr}`);
    assert.doesNotMatch(stderr, /^\s+at /m, `a raw stack trace is the banned failure mode\n${stderr}`);
    // The two libs verify.mjs used to import statically; any lib would do, these
    // are the ones whose absence used to be fatal.
    for (const lib of ['config-schema.mjs', 'jsonc.mjs']) {
      assert.ok(stdout.includes(`FAIL scripts/lib/${lib} missing`),
        `every missing lib gets its own enumerated FAIL line (${lib})\n${stdout}`);
    }
    assert.match(stdout, /\nVERIFY: FAIL \(\d+\)/, `the run must reach its own summary line\n${stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// board #64: DESC_CAP walked skill/command frontmatter only; plugin.json's own
// description field was unchecked. This runs the REAL verify.mjs against a
// full-tree copy (every top-level path verify.mjs itself reads — see the
// `path.join(repo, ...)` enumeration this list is drawn from) so both the
// pristine-passes and the over-cap-fails legs exercise the actual gate, not a
// stand-in. Proved RED first, by hand, before this test existed — see
// desccap-cw-return.md for the manual transcript.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('verify.mjs: an over-cap .claude-plugin/plugin.json description FAILs the gate', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-desccap-')));
  try {
    for (const rel of [
      '.claude-plugin', '.github', 'LICENSE', 'NOTICE', 'commands', 'hooks',
      'platform-configs', 'plugin', 'scripts', 'skills',
    ]) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(root, rel), { recursive: true });
    }
    const dest = path.join(root, 'scripts', 'verify.mjs');
    const run = () => spawnSync(process.execPath, [dest], { encoding: 'utf8' });

    const clean = run();
    assert.strictEqual(clean.status, 0, `pristine copy must PASS\n${clean.stdout}${clean.stderr}`);
    assert.match(clean.stdout, /ok\s+\.claude-plugin\/plugin\.json: \d+ chars \(cap 1024\)/,
      `pristine PASS line must name the real char count\n${clean.stdout}`);

    const pjPath = path.join(root, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.description = 'x'.repeat(1100);
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const over = run();
    assert.strictEqual(over.status, 1, 'an over-cap plugin.json description must FAIL with exit 1');
    assert.match(over.stdout, /FAIL\s+\.claude-plugin\/plugin\.json: description 1100 chars exceeds the 1024-char cap/,
      `the FAIL line must name the file, the exact length, and the cap\n${over.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verify.mjs: a truthy NON-STRING plugin.json description FAILs loud, never silently reads as 0 chars', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-desccap-nonstring-')));
  try {
    for (const rel of [
      '.claude-plugin', '.github', 'LICENSE', 'NOTICE', 'commands', 'hooks',
      'platform-configs', 'plugin', 'scripts', 'skills',
    ]) {
      const src = path.join(REPO, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(root, rel), { recursive: true });
    }
    const pjPath = path.join(root, '.claude-plugin', 'plugin.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    pj.description = 123; // truthy non-string — must never read as 0 chars and pass
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8');

    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, 'a non-string description must FAIL, not silently pass as 0 chars');
    assert.match(r.stdout, /FAIL\s+\.claude-plugin\/plugin\.json: description is not a string \(number\)/,
      `must name the actual type, not silently report 0 chars\n${r.stdout}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
