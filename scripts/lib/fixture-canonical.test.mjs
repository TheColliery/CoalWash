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
// WHY NOBODY SAW IT. `C:\Users\zxc59` is short enough that Windows mints no 8.3
// alias for it, so the dev box's tmpdir never CARRIES one and only CI was handed
// the condition. The VOLUME still mints an alias for a long name on demand
// (measured), which is why the guard below now mints its own rather than wait for
// a host to supply one. Same family as the twin-pin vacuity finding and the
// empty-`projects/` perf blind spot: A TEST ENVIRONMENT THAT CANNOT EXPRESS THE
// FAILURE ALWAYS REPORTS GREEN. That is what this file exists to stop being true.
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
import { execSync } from 'node:child_process';
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

// THE TWO "WRONG WAY" SHAPES ARE TWO CLAIMS, NOT ONE. They need DIFFERENT
// capabilities from the host, and covering both with a single "is tmpdir
// canonical" gate keyed the second one to the wrong axis. macOS proved it: APFS
// has no 8.3 aliasing, but its tmpdir IS non-canonical (`/var` -> `/private/var`),
// so the shared gate opened — and both realpath variants resolve a symlink to the
// same string (measured on a win32 junction: plain === native === the real dir).
// The "wrong way" was therefore not wrong there, nothing was caught, and the leg
// failed on a host that cannot express the defect it guards. Split, and probe the
// capability each leg actually needs. The axis is the VOLUME, never the platform.

test('GUARD: a fixture root built the WRONG way — a raw tmpdir join — is caught', (t) => {
  // CAPABILITY: the host's own tmpdir must be non-canonical (macOS symlinks
  // `/var`; a Windows TEMP can carry a short-name component). Where tmpdir is
  // already canonical a raw join IS canonical — no defect exists to catch here,
  // and a visible skip beats a green tick over an assertion about a non-defect.
  if (canonicalOrNull(os.tmpdir()) === os.tmpdir()) {
    t.skip('tmpdir is already canonical on this host, so a raw join cannot be non-canonical — capability measured, not assumed');
    return;
  }
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixraw-'));
  try {
    assert.notStrictEqual(canonicalOrNull(raw), raw, 'a raw tmpdir join must be caught as non-canonical');
  } finally { fs.rmSync(raw, { recursive: true, force: true }); }
});

// 8.3 alias minting is the ONLY axis on which the two realpath variants diverge —
// both resolve symlinks — so this leg cannot borrow the tmpdir gate above. Nor may
// it wait for a tmpdir that HAPPENS to carry a short name: that is CI's
// `RUNNER~1`, an accident of one runner image's username length, and a guard
// living on an accident dies with it. It mints the alias itself, the same move the
// portable half below makes with its symlink.
// TWIN of the helper in config-load.test.mjs (which pins the PRIMITIVE side: that
// canonicalOrNull expands 8.3) and of the inline probe in twin-pin.test.mjs. Three
// copies, one fact — when one learns something about 8.3, the others learn it too.
// NAMED DIVERGENCE from those two: both sit behind a `platform === 'win32'` branch
// and so are never reached off Windows. This one is called UNGUARDED, by design —
// the platform must not be consulted here — which means POSIX really does run it,
// where `sh` chokes on the `( )` and writes a syntax error to stderr. Silencing
// that channel is the whole reason for the stdio triple: the throw is the signal,
// the noise is not.
function shortName(p) {
  try {
    return execSync(`cmd /c for %I in ("${p}") do @echo %~sI`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return p; }
}

test('GUARD: a fixture root built the WRONG way — the non-native realpath variant — is caught', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-fixnn-LONGNAME-FOR-8DOT3-')));
  try {
    // THE CAPABILITY, STATED AS ITSELF: can the wrong variant actually BE wrong on
    // this volume? Note what is compared — the two variants against each other, on
    // the most alias-prone spelling the volume will give us. Where no alias exists
    // `%~sI` hands back the path unchanged, and on a host with no cmd.exe at all
    // (the whole POSIX family) the helper's catch does the same, so BOTH cases end
    // at the same POSITIVE measurement on a real path: these two calls agree here.
    // That is what makes this a proven-absent capability and not a swallowed throw
    // (the R3 rule), and it is why no `process.platform` appears in this gate —
    // keying on the platform instead of the volume is the defect class this whole
    // file exists to stop.
    const aliased = shortName(dir);
    if (fs.realpathSync(aliased) === fs.realpathSync.native(aliased)) {
      t.skip('plain realpathSync and .native return the same string for every spelling this volume offers (no 8.3 alias mintable), so the non-native variant is not a defect here — capability measured, not assumed');
      return;
    }
    const nonNative = fs.realpathSync(aliased); // the exact CI defect: realpath called, wrong variant
    assert.notStrictEqual(canonicalOrNull(nonNative), nonNative, 'the non-native realpath variant must be caught as non-canonical');
    assert.strictEqual(canonicalOrNull(nonNative), dir, 'and it canonicalizes to the one real spelling of that root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
// ⚠ THE RULE IS NOT "EVERY FIXTURE PATH MUST BE CANONICAL" — READ THIS BEFORE
// "COMPLETING" THE SWEEP. There are two fixture path roles and they take OPPOSITE
// treatment:
//
//   EXPECTED VALUE (compared against engine output) — MUST be canonical. Otherwise
//     the test asserts the engine is wrong about a spelling the engine deliberately
//     normalizes. That is the class the CI-red sweep fixed, and it stays fixed.
//   INPUT (handed TO the engine) — SHOULD carry adversarial shapes, non-canonical
//     included. That IS the test surface. Canonicalizing inputs would blind the
//     suite to exactly the mixed-variant bug class we spent a day closing — and it
//     nearly happened: class-a correctly REFUSED to sweep its raw `tmp()` helpers,
//     because doing so would have MASKED a live engine bug (detonate.mjs's
//     `realOrNull` used the plain variant while the other side of its comparison
//     expanded, so a source-sacred containment refusal silently did not fire).
//
// So this scan is deliberately NARROW: it flags only the construction of a sandbox
// ROOT, which is the expectation-side idiom, and says nothing about a path built
// inline as an adversarial input. A root that is intentionally non-canonical
// because it IS the input under test declares itself with `fixture-input:` and the
// declaration is the review. A guard that cannot express this distinction should
// not pretend to — this one expresses it by staying narrow and by naming the part
// it does not police.
test('CONFORMANCE: no test file builds a sandbox ROOT with the non-native realpath variant (expectation side only — inputs are deliberately left alone)', () => {
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
      // An opt-out for a root that is non-canonical ON PURPOSE because it is the
      // INPUT under test. Declaring it is the review; silently sweeping it is the
      // thing that blinds the suite.
      if (/fixture-input:/.test(line)) return;
      // the defect shape: plain realpathSync wrapping a temp-dir creation
      if (/fs\.realpathSync\((?!\s*\/\*)[^)]*mkdtempSync/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [], `use fs.realpathSync.native — the plain variant does not expand a win32 8.3 short name, which is what turned CI red:\n  ${offenders.join('\n  ')}`);
});
