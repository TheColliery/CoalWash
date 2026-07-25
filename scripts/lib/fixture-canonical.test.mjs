// FIXTURE-CANONICALITY GATE — the permanent guard for the CI-red class.
//
// WHAT WENT WRONG. Every containment comparison in the engine runs against
// `canonicalOrNull`, which uses `fs.realpathSync.native` because that is the ONLY
// variant that expands a win32 8.3 short name (the R3 security fix). The fixtures
// built their sandbox roots with plain `fs.realpathSync`, which does NOT expand it.
// Same call, wrong variant. On a runner whose HOME is `C:\Users\runneradmin` the
// OS mints the alias `RUNNER~1`, tmpdir inherits it, and every fixture path then
// disagreed with every engine path by exactly that component — 91 failures.
//
// WHY NOBODY COULD SEE IT. `C:\Users\zxc59` is short enough that Windows never
// generates an 8.3 alias AT ALL, so the dev box cannot produce the condition at
// any effort. Same family as the twin-pin vacuity finding and the empty-`projects/`
// perf blind spot: A TEST ENVIRONMENT THAT CANNOT EXPRESS THE FAILURE ALWAYS
// REPORTS GREEN. That is what this file exists to stop being true.
//
// WHAT IT ASSERTS: a fixture root must be canonical BY THE ENGINE'S OWN
// CANONICALIZER — not by "some realpath was called on it". Keying on
// `canonicalOrNull` is deliberate: it catches a raw `os.tmpdir()` join, the wrong
// realpath variant, and any future divergence, because it is definitionally the
// same function the containment checks use. A guard that re-implements the rule
// can drift from it; this one cannot.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalOrNull } from './config-load.mjs';

const LIB = path.dirname(fileURLToPath(import.meta.url));

test('a fixture root built the CORRECT way is canonical by the engine canonicalizer', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixcanon-')));
  try {
    assert.strictEqual(canonicalOrNull(root), root,
      'the engine must agree that a properly-built sandbox root is already canonical');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GUARD: a fixture root built the WRONG way is caught — raw tmpdir join, and the non-native realpath variant', () => {
  // (1) raw join, no realpath at all. Non-canonical wherever tmpdir is a symlink
  //     (macOS /var -> /private/var) or carries an 8.3 component (CI Windows).
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixraw-'));
  // (2) the exact CI defect: realpath called, but the variant that does not expand 8.3.
  const nonNative = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixnn-')));
  try {
    // On a box where tmpdir is already canonical AND has no 8.3 alias, both forms
    // happen to be canonical — the guard cannot fire, and saying so is the honest
    // move. It fires on macOS (symlinked tmpdir) and on any Windows host whose
    // tmpdir carries a short-name component, which is exactly CI.
    const tmpIsCanonical = canonicalOrNull(os.tmpdir()) === os.tmpdir();
    if (tmpIsCanonical) {
      assert.strictEqual(canonicalOrNull(raw), raw, 'sanity: on a canonical-tmpdir host even a raw join is canonical');
      assert.strictEqual(canonicalOrNull(nonNative), nonNative, 'sanity: same for the non-native variant');
      return; // not a skip: the assertions above DID run and did hold
    }
    assert.notStrictEqual(canonicalOrNull(raw), raw, 'a raw tmpdir join must be caught as non-canonical');
    assert.notStrictEqual(canonicalOrNull(nonNative), nonNative, 'the non-native realpath variant must be caught as non-canonical');
  } finally {
    fs.rmSync(raw, { recursive: true, force: true });
    fs.rmSync(nonNative, { recursive: true, force: true });
  }
});

// THE PORTABLE HALF — this one fires on EVERY platform, including a dev box whose
// tmpdir is already canonical, because it manufactures the non-canonicality itself
// instead of waiting for the host to supply it. That is what makes the guard real
// rather than something that only works on the machine that already broke.
test('GUARD (portable): a root reached through a symlink/junction is caught on ANY platform', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixlink-')));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real, { recursive: true });
  try {
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      t.skip(`cannot create a symlink/junction here (${e.code}) — the capability is genuinely absent, not assumed`);
      return;
    }
    assert.notStrictEqual(canonicalOrNull(link), link, 'a linked root is NOT canonical and the guard must say so');
    assert.strictEqual(canonicalOrNull(link), real, 'and it resolves to the real location');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// The sweep that fixed CI must stay swept: no test file may build a sandbox root
// with the non-expanding variant again. Source-level, so it fires on any box.
test('CONFORMANCE: no test file builds a sandbox root with the non-native realpath variant', () => {
  const offenders = [];
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith('.test.mjs'))) {
    // THIS file is exempt by name: it deliberately BUILDS the defect shape as a
    // specimen (the "wrong way" guard above), so scanning itself would make the
    // gate permanently red on its own evidence. Same collateral the CI sweep hit
    // in config-load.test.mjs, where a plain realpathSync IS the contrast being
    // drawn — a mechanical sweep cannot tell a specimen from a defect, so the
    // exemption is named here rather than discovered again later.
    if (f === 'fixture-canonical.test.mjs') continue;
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // the defect shape: plain realpathSync wrapping a temp-dir creation
      if (/fs\.realpathSync\((?!\s*\/\*)[^)]*mkdtempSync/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [], `use fs.realpathSync.native — the plain variant does not expand a win32 8.3 short name, which is what turned CI red:\n  ${offenders.join('\n  ')}`);
});
