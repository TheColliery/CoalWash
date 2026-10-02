// TWIN-PIN GATE — the containment primitive is ONE concept with TWO implementations
// (shipped class-B in class-b.mjs/config-load.mjs, class-A in explode.mjs, kept local
// on purpose: the break harness loads that engine in isolation, so it must not drag
// the config-load chain in). For four blind waves that sync was a COMMENT asking the
// next person to keep them aligned, and TWICE the drift shipped a HIGH — the class-A
// side already knew "win32 case-folds" (R2) and "realpath does not normalize an 8.3
// short name" (R3) while the shipped guard did not. A promise is not a gate.
//
// WHY BEHAVIOUR, NOT BYTES. A byte/AST-equivalence pin would be DISHONEST here: the
// two bodies legitimately differ today — class-b calls the shared `pathExists`, the
// class-A twin inlines its own `fs.lstatSync` try/catch precisely because it may not
// import config-load. A body-comparison gate would be red on arrival and would have
// to be weakened until it proved nothing. Behaviour is also the thing that actually
// matters and it survives a legitimate refactor of either side: drive the SAME input
// table through both and require IDENTICAL verdicts.
//
// If a future change makes the twins legitimately diverge in BEHAVIOUR, that is a
// decision to make in the open — change this table and say why in the same commit.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { physicalForCreate as pfcClassB, physicalOrNull as ponClassB, containedIn } from './class-b.mjs';
import { pathWithin } from './config-load.mjs';
import { physicalForCreate as pfcClassA, isContainedIn, snapshotSource } from './explode.mjs';
import { detonate } from './detonate.mjs';

const WIN = process.platform === 'win32';

function buildCases() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-LONGNAME-')));
  const dir = path.join(root, 'store');
  const nested = path.join(dir, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  const legalTilde = path.join(dir, 'backup~1'); // LEGAL long name that looks 8.3-ish
  fs.mkdirSync(legalTilde, { recursive: true });

  const cases = [
    ['existing dir', dir],
    ['existing nested dir', nested],
    ['existing file', file],
    ['legal ~1 name', legalTilde],
    ['absent leaf', path.join(dir, 'nope.txt')],
    ['absent deep tail', path.join(dir, 'x', 'y', 'z.txt')],
    ['absent under a legal ~1 parent', path.join(legalTilde, 'new.txt')],
    ['dot-dot traversal', path.join(dir, '..', 'store', 'f.txt')],
    ['empty string', ''],
    ['non-string', 42],
    ['null', null],
  ];
  if (WIN) {
    cases.push(['UNC spelling', "\\\\localhost\\" + dir[0] + '$' + dir.slice(2)]);
    cases.push(['\\\\?\\ spelling', "\\\\?\\" + dir]);
    let short = '';
    try { short = execSync(`cmd /c for %I in ("${dir}") do @echo %~sI`, { encoding: 'utf8' }).trim(); } catch { short = ''; }
    // PROVE the capability is absent before treating it as absent (the R3 lesson):
    // an empty/unchanged result means this volume really has no 8.3 alias for `dir`.
    if (short && short !== dir) cases.push(['8.3 short name', short]);
  }
  // A PORTABLE path-shape REFUSAL, so the vacuity assertion below stays real on
  // POSIX instead of being switched off there. Every other refusing row above is
  // a win32 spelling (UNC / \\?\ / 8.3), which is exactly why the POSIX table had
  // nothing to refuse and the guard fired. A dangling symlink is refused by the
  // SAME fail-closed rule on both platforms: lstat says the segment exists, so the
  // walk may not climb past it, but realpath cannot resolve it (R4/TP-2).
  let linkOk = false;
  try {
    const dangling = path.join(dir, 'dangling-link');
    fs.symlinkSync(path.join(dir, 'no-such-target'), dangling, WIN ? 'junction' : 'dir');
    cases.push(['under a dangling symlink', path.join(dangling, 'x.txt')]);
    linkOk = true;
  } catch { /* capability genuinely absent — the caller skips VISIBLY, never silently */ }
  return { root, dir, cases, linkOk };
}

test('TWIN-PIN: physicalForCreate behaves IDENTICALLY in class-b.mjs and explode.mjs across the shared input table', () => {
  const { root, cases } = buildCases();
  try {
    const diffs = [];
    for (const [label, input] of cases) {
      let a, b;
      try { a = pfcClassB(input); } catch (e) { a = `THREW ${e.code || e.name}`; }
      try { b = pfcClassA(input); } catch (e) { b = `THREW ${e.code || e.name}`; }
      if (a !== b) diffs.push(`${label}: class-b=${JSON.stringify(a)} class-A=${JSON.stringify(b)}`);
    }
    assert.deepStrictEqual(diffs, [], `TWIN DRIFT in physicalForCreate — one side learned something the other did not:\n  ${diffs.join('\n  ')}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('TWIN-PIN: the case-folding containment compare behaves IDENTICALLY (config-load pathWithin vs explode isContainedIn)', () => {
  const { root, dir, cases } = buildCases();
  try {
    const base = ponClassB(dir); // canonical, as both are contracted to receive
    const diffs = [];
    for (const [label, input] of cases) {
      const child = typeof input === 'string' && input ? (ponClassB(input) ?? pfcClassB(input)) : null;
      let a, b;
      try { a = pathWithin(child, base); } catch (e) { a = `THREW ${e.name}`; }
      try { b = isContainedIn(child, base); } catch (e) { b = `THREW ${e.name}`; }
      if (a !== b) diffs.push(`${label} (child=${JSON.stringify(child)}): pathWithin=${a} isContainedIn=${b}`);
    }
    // CASE VARIANCE IS THE POINT. R2's HIGH was exactly a case-folding difference
    // between these two implementations, so a table whose children always share the
    // base's case CANNOT catch the drift this gate exists for — proven: the first
    // version of this pin stayed GREEN with one side's case-fold deliberately removed.
    for (const [label, variant] of [
      ['base upper-cased', base.toUpperCase()],
      ['base lower-cased', base.toLowerCase()],
      ['child upper-cased', path.join(base, 'a', 'b').toUpperCase()],
    ]) {
      let a, b;
      try { a = pathWithin(variant, base); } catch (e) { a = `THREW ${e.name}`; }
      try { b = isContainedIn(variant, base); } catch (e) { b = `THREW ${e.name}`; }
      if (a !== b) diffs.push(`case-variant ${label}: pathWithin=${a} isContainedIn=${b}`);
    }
    assert.deepStrictEqual(diffs, [], `TWIN DRIFT in the containment compare:\n  ${diffs.join('\n  ')}`);
    // and the pin is not vacuous: the table really does exercise both verdicts
    assert.strictEqual(pathWithin(base, base), true, 'same-dir is contained');
    assert.strictEqual(isContainedIn(base, base), true, 'same-dir is contained (twin)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// pathWithin CONTRACT PIN. Both arguments must ALREADY be canonical. That check
// replaced a silent lexical `path.resolve()` inside the function, which made a
// wrong-shaped argument LOOK handled — the exact R4/TP-2 shape ("correct only
// because every caller happens to be correct"). Unpinned, one refactor restores the
// fallback and nothing goes red, so the shapes are asserted here. BOTH sides: a
// containment compare has two inputs, and a guard that checks one is half a guard.
test('pathWithin REFUSES a non-canonical argument on EITHER side', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-CANON-')));
  const child = path.join(base, 'a', 'b');
  const S = path.sep;
  try {
    // Not vacuous: the canonical pair really is contained, so `false` below means
    // REFUSED, not "this function always says no".
    assert.strictEqual(pathWithin(child, base), true, 'canonical pair must be contained');

    for (const [label, bad] of [
      ['relative', `x${S}y`],
      ['non-normalized absolute', `${base}${S}a${S}..${S}b`],
      ['trailing separator', `${child}${S}`],
      ['empty string', ''],
      ['non-string', 42],
      ['null', null],
    ]) {
      assert.strictEqual(pathWithin(bad, base), false, `${label} as CHILD must be refused`);
      assert.strictEqual(pathWithin(child, bad), false, `${label} as BASE must be refused`);
    }

    // The cells that would answer TRUE if the guard were removed — i.e. exactly what
    // the silent lexical resolve used to do. These are the security-relevant flips.
    assert.strictEqual(pathWithin(`${base}${S}zz${S}..${S}a${S}b`, base), false,
      'a non-normalized CHILD that lexically resolves INSIDE base is still refused');
    assert.strictEqual(pathWithin(child, `${base}${S}zz${S}..`), false,
      'a non-normalized BASE that lexically resolves to a real container is still refused');
    assert.strictEqual(pathWithin(`${child}${S}`, base), false,
      'a trailing-separator child is refused, not silently stripped');
    assert.strictEqual(pathWithin('x', path.resolve('.')), false,
      'a relative child is refused, not resolved against the process cwd');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// DECLARED DEPENDENCY — this asserts a property of NODE, not of our logic.
// `containedIn` (class-b.mjs, and the byte-identical copy in apply.mjs) is the THIRD
// containment shape: `path.relative` over an array of roots, carrying NO explicit
// case-fold of its own. It is case-insensitive on win32 only because Node's win32
// `path.relative` folds case internally. We do not own that behaviour and never
// declared it. Asserting it here means that if it ever changes, it surfaces in OUR
// gate — not in a user's containment check. The twin-pin tests above cover the other
// two shapes (pathWithin / isContainedIn), which fold case explicitly.
test('DEPENDENCY (win32): path.relative case-folds, which is the only reason containedIn is case-insensitive', (t) => {
  if (!WIN) { t.skip('win32-only property — POSIX paths are case-SENSITIVE by design'); return; }
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-FOLD-')));
  const child = path.join(base, 'a', 'b');
  try {
    assert.strictEqual(containedIn(child, [base]), true, 'sanity: same-case child is contained');
    assert.strictEqual(containedIn(child.toUpperCase(), [base]), true,
      'case-variant CHILD is contained — RELIES ON Node win32 path.relative folding case');
    assert.strictEqual(containedIn(child, [base.toUpperCase()]), true,
      'case-variant BASE is contained — same Node dependency');
    // and not vacuous: a genuine outsider is still refused, case-fold or not.
    assert.strictEqual(containedIn(path.join(path.dirname(base), 'elsewhere'), [base]), false,
      'a genuine outsider is not contained');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// EVALUATED AGAINST THE CASES THAT ACTUALLY RAN — not against an assumed table.
// This guard fired on POSIX CI and it was RIGHT to: the UNC / \\?\ / 8.3 rows are
// win32-only, and the old counters additionally excluded every non-string case
// (`typeof i === 'string' && i`), so on POSIX the refusal count was structurally
// zero and the pin was proving nothing. Two fixes, not one: count the refusals the
// table really produces (a bad TYPE is a real refusal), and carry a portable
// path-shape refusal (the dangling symlink above) so the assertion has teeth on
// both platforms rather than being weakened on one.
test('TWIN-PIN is not vacuous: the cases that RAN on this platform drive both real resolutions and real refusals', (t) => {
  const { root, dir, cases, linkOk } = buildCases();
  try {
    assert.ok(cases.length >= 11, `table too small (${cases.length}) — a pin over nothing proves nothing`);
    const verdict = (i) => { try { return pfcClassB(i); } catch { return null; } };
    const resolvable = cases.filter(([, i]) => verdict(i) !== null);
    const refused = cases.filter(([, i]) => verdict(i) === null);
    assert.ok(resolvable.length >= 4, `the table drives real resolutions (got ${resolvable.length})`);
    assert.ok(refused.length >= 2, `the table drives real refusals (got ${refused.length} of ${cases.length} on ${process.platform})`);
    assert.ok(pfcClassB(dir) !== null, 'sanity: an ordinary existing dir resolves');
    // The PATH-SHAPE half, reported separately from the type-guard half: without a
    // shape refusal the pin would still pass on type errors alone, which is a
    // weaker claim than the one this file's title makes.
    if (!linkOk) {
      t.skip('no symlink/junction capability here — the portable path-shape refusal could not be built (capability proven absent, not assumed)');
      return;
    }
    const shapeRefusals = cases.filter(([l, i]) => typeof i === 'string' && i && verdict(i) === null);
    assert.ok(shapeRefusals.length >= 1, `at least one PATH-SHAPE refusal must run here, not just bad types (got ${shapeRefusals.length})`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// THE FOURTH TWIN — the SOURCE-SACRED DOOR PAIR, pinned through PUBLIC callers.
//
// A third canonicalizer lives inside the class-A engines themselves: detonate.mjs
// keeps a module-private `realOrNull` (a bare fs.realpathSync.native) beside
// explode.mjs's module-private `physicalOrNull`, which additionally refuses every
// win32 device/UNC spelling BY SHAPE (the R3/R4 law: a shape refusal belongs on the
// INPUT). Both helpers are private, and this file has never imported a private
// helper. It does not need to: two PUBLIC front doors carry the IDENTICAL
// containment expression against the same base, differing only in which helper
// resolves the src —
//
//   detonate(src, { outPath, snapshotDir })  gate-4 source-sacred belt
//   snapshotSource(src, snapshotDir)         the primitive's own self-guard
//
// so the pair is comparable behaviourally with no export and no API-surface growth.
// Both promise the same thing: a src resolving INSIDE the snapshot store is refused,
// because the manifest/blob writes that land there would corrupt the source.
//
// WHY IT EXISTS — MEASURED, NOT ARGUED. The belt was being handed a WRONG answer,
// not merely an unknown one, and refuse-polarity ("unknown refuses") is armour only
// against the latter. `.native` collapses `\\?\C:\x` but returns a UNC spelling
// VERBATIM, so a src passed as `\\localhost\C$\...\store\v.jsonl` compared against a
// drive-letter base answered 'outside' — for a file physically inside the store. The
// belt did not fire, `triggered:true`, and the refusal came from reduceFile's deeper
// floor instead: the same "carried by the guard behind it" shape as the
// namespaced-outPath finding one commit earlier. A UNC store is not exotic; a
// redirected Windows profile is one.
//
// TWO ASSERTIONS, DELIBERATELY OF DIFFERENT KINDS. Equality is the twin half and
// catches drift. It is also structurally blind to BOTH sides being weakened in step,
// which is precisely what a "consistency fix" does — so the second assertion is
// ABSOLUTE: every spelling of a src inside the store must be refused BEFORE the
// reducer runs. That one goes red on a coordinated weakening the equality cannot see.
// ---------------------------------------------------------------------------

// REFUSED means nothing was handed on. For detonate, `triggered === false` is the
// load-bearing half: an `ok:false` reached only because a DEEPER floor caught it is
// exactly the defect this pins, so it must NOT read as a refusal here.
const doorVerdictDetonate = (src, store, outPath) => {
  const r = detonate(src, { cutTypes: ['mode'], outPath, snapshotDir: store });
  return (r.ok === false && r.triggered === false) ? 'REFUSED' : 'ALLOWED';
};
const doorVerdictSnapshot = (src, store) => (snapshotSource(src, store).ok === false ? 'REFUSED' : 'ALLOWED');

function buildDoorCases() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-DOORS-')));
  const store = path.join(root, 'store');
  fs.mkdirSync(store, { recursive: true });
  const nd = Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: i % 3 ? 'user' : 'mode', i })).join('\n') + '\n';
  const inside = path.join(store, 'victim.jsonl');
  const outside = path.join(root, 'outside.jsonl');
  fs.writeFileSync(inside, nd);
  fs.writeFileSync(outside, nd);

  // [label, src spelling, does it physically live inside the store]
  const rows = [['plain INSIDE', inside, true], ['plain OUTSIDE', outside, false]];
  if (WIN) {
    // The device spellings are win32-only BY CONSTRUCTION — `physicalOrNull`'s shape
    // refusal is platform-gated, so on POSIX the two helpers are identical and there
    // is nothing to diverge. The POSIX leg still runs the plain rows, so the absolute
    // assertion below keeps its teeth there rather than being switched off.
    rows.push(['namespaced INSIDE', path.toNamespacedPath(inside), true]);
    rows.push(['namespaced OUTSIDE', path.toNamespacedPath(outside), false]);
    // PROVE the spelling reaches the file before pinning a verdict on it (the 8.3
    // lesson above): an unreachable admin share would make detonate refuse at gate 1
    // for a reason that has nothing to do with these twins.
    const unc = (p) => `\\\\localhost\\${p[0]}$${p.slice(2)}`;
    for (const [label, p, isIn] of [['UNC INSIDE', inside, true], ['UNC OUTSIDE', outside, false]]) {
      const u = unc(p);
      if (fs.existsSync(u)) rows.push([label, u, isIn]);
    }
  }
  return { root, store, rows };
}

test('TWIN-PIN: the source-sacred doors (detonate gate 4 / snapshotSource) agree on every spelling, and refuse an in-store src BEFORE the reducer runs', () => {
  const { root, store, rows } = buildDoorCases();
  try {
    assert.ok(rows.length >= 2, `table too small (${rows.length}) — a pin over nothing proves nothing`);
    const diffs = [];
    const seen = [];
    rows.forEach(([label, src, insideStore], i) => {
      let a, b;
      try { a = doorVerdictDetonate(src, store, path.join(root, `out-${i}.jsonl`)); } catch (e) { a = `THREW ${e.code || e.name}`; }
      try { b = doorVerdictSnapshot(src, store); } catch (e) { b = `THREW ${e.code || e.name}`; }
      seen.push([label, a, insideStore]);
      if (a !== b) diffs.push(`${label}: detonate-gate4=${a} snapshotSource=${b}`);
    });
    assert.deepStrictEqual(diffs, [], `TWIN DRIFT between the two source-sacred doors — one resolver learned something the other did not:\n  ${diffs.join('\n  ')}`);

    // ABSOLUTE half — the claim the equality above structurally cannot make.
    for (const [label, verdict, insideStore] of seen) {
      if (insideStore) {
        assert.strictEqual(verdict, 'REFUSED',
          `${label}: a src living INSIDE the snapshot store must be refused BEFORE the reducer runs, by EVERY spelling of it. ` +
          'Measured pre-fix on the UNC spelling: triggered:true, the belt silently skipped and reduceFile\'s floor did the refusing.');
      }
    }
    // Not vacuous: the table really drives an ALLOW too, so REFUSED above is a verdict
    // and not simply this door's only answer.
    assert.ok(seen.some(([, verdict, insideStore]) => !insideStore && verdict === 'ALLOWED'),
      `no row was ALLOWED (${seen.map(([l, v]) => `${l}=${v}`).join(', ')}) — a door that refuses everything proves nothing`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// THE CASE-FOLD PROBE TWIN — and the row that closes THIS GATE'S OWN DEFECT.
//
// WHY THIS ROW EXISTS. The drift that reverted `main` at `174f330` was caught by CI
// (macos-latest node 22) and NOT by this file, although this file is the gate whose
// entire job is catching exactly that. The reason is above: `buildCases()` builds an
// ordinary tmpdir, and on an ordinary tmpdir a platform rule and a volume probe give
// the SAME answer — so the table could not express the disagreement. A gate that
// cannot see the drift it exists for is the defect, not the drift.
//
// It is ALSO the price of duplication. class-A cannot import config-load.mjs (that
// chain pulls jsonc + config-schema, and the class-A engine must load in isolation
// and is excluded from the shipped dist), so the case-fold probe exists TWICE. A
// duplicated probe owes a pin over the probe itself — and, exactly as with the
// source-sacred door pair above, it is pinned through the two PUBLIC doors that
// carry it rather than by importing a private helper: `pathWithin` (class-B) and
// `isContainedIn` (class-A).
//
// CAPABILITY-PROBED, NEVER PLATFORM-GATED. Gating on `process.platform` would be the
// defect under test. The requirement is an OUTCOME — two same-name different-case
// directories that are genuinely distinct inodes — built with `fsutil file
// setCaseSensitiveInfo` on win32 (per-directory since 10 1803, no admin) or by plain
// mkdir on a case-sensitive POSIX volume. Absent, the caller skips VISIBLY.
//
// COVERAGE BOUND, because this row does NOT catch every one-sided state. It builds a
// case-SENSITIVE directory, so it has teeth exactly where one can be built (an
// fsutil-enabled NTFS directory, ext4) and SKIPS on a case-INSENSITIVE volume —
// which is macOS APFS by default, the very leg where the `af17017` drift was caught.
// The mirror-image drift there (a case-INSENSITIVE volume whose twins disagree) is
// caught by the ordinary-tmpdir row above once both twins probe, since that tmpdir IS
// the folding volume. Note the two states emit the SAME shape (`pathWithin=true
// isContainedIn=false`) for OPPOSITE reasons, so read the assertion message against
// the directory the row actually built, never as a general diagnosis.
function caseSensitiveDir() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-CASE-')));
  const holder = path.join(root, 'holder');
  fs.mkdirSync(holder);
  try { execSync(`fsutil file setCaseSensitiveInfo "${holder}" enable`, { stdio: 'ignore' }); } catch { /* not win32, or refused — the inode check below is the real verdict */ }
  try {
    const lower = path.join(holder, 'store');
    const upper = path.join(holder, 'Store');
    fs.mkdirSync(lower);
    fs.mkdirSync(upper); // on a FOLDING volume this throws EEXIST — capability absent
    const a = fs.statSync(lower, { bigint: true });
    const b = fs.statSync(upper, { bigint: true });
    if (a.ino === b.ino) { fs.rmSync(root, { recursive: true, force: true }); return null; }
    return { root, holder, lower, upper };
  } catch { fs.rmSync(root, { recursive: true, force: true }); return null; }
}

test('TWIN-PIN: the case-fold PROBE agrees across the twins on a genuinely case-SENSITIVE directory (the row the ordinary tmpdir table structurally cannot express)', (t) => {
  const cs = caseSensitiveDir();
  if (!cs) { t.skip('no case-sensitive directory can be built here (capability proven absent by distinct-inode check, not assumed)'); return; }
  try {
    const child = path.join(cs.upper, 'blob'); // physically in `Store/`, NOT in `store/`
    fs.mkdirSync(child);
    const base = cs.lower;                      // the declared store, a DISTINCT inode

    const a = pathWithin(child, base);
    const b = isContainedIn(child, base);

    // (1) THE ABSOLUTE HALF, ASSERTED UNCONDITIONALLY AND FIRST. `Store/blob` is a
    // DISTINCT inode from `store/` here, so it is NOT contained. This binds the class-A
    // side on its own, needs no cooperation from the other lane, and CANNOT be switched
    // off by the conditional below — a class-A regression to the platform rule reddens
    // here whatever config-load is doing. It is also the half a pure equality check
    // structurally cannot make: two sides weakened IN STEP (what a "consistency fix"
    // produces) agree with each other and are both wrong.
    assert.strictEqual(b, false,
      'explode isContainedIn admitted a case-variant SIBLING directory as contained. That is the ' +
      'PERMIT-polarity bypass measured end-to-end through restoreFromSnapshot: attacker-chosen ' +
      'bytes published from a directory the caller never declared.');

    // and the same directory still resolves a genuine child, so `false` above is a
    // verdict rather than this compare's only answer.
    const real = path.join(base, 'inner');
    fs.mkdirSync(real);
    assert.strictEqual(isContainedIn(real, base), true, 'a genuine child of the declared store IS contained');

    // (2) THE TWIN HALF — a CROSS-LANE invariant, and this file is checked out on a
    // single lane. Whether config-load has been converted is MEASURED, never assumed:
    // this directory does not fold, so a `pathWithin` still answering `true` for the
    // case-variant is still keying on `process.platform`.
    //
    // THE SKIP IS A DECLARED CROSS-LANE DEPENDENCY, NOT A DORMANT TEST, and the
    // difference is that it EXPIRES BY ITSELF. It is reachable only while the class-B
    // half is unlanded; the moment `af17017` re-lands, this measurement flips and the
    // equality below becomes a hard, permanent assertion with no further edit — nobody
    // has to remember to re-arm it. It also cannot hide a class-A regression, because
    // (1) above already ran unconditionally. TWIN-DRIFT LAW: the pair lands together,
    // so the pair GATE arms together with it, at the assembly — which is where
    // MEMORY.md already scopes this whole file ("twin-pin is a STATION-5-ONLY gate").
    //
    // BOUND, stated because the skip condition is genuinely ambiguous: `a === true`
    // cannot tell "class-B not landed yet" from "class-B landed and was later
    // REGRESSED to the platform rule" — both spell the same measurement, so a
    // regression on that lane would read here as a pending landing and skip. This row
    // is therefore NOT the class-B side's guard and must not be cited as one; that
    // side is guarded on its own lane by config-load.test.mjs's capability tests
    // (`RED-FIRST/capability-not-platform-name`, `RE-INSPECT/R2`). What this row owns
    // is the class-A half (asserted unconditionally above) and the CROSS check once
    // both halves are present.
    //
    // PROVEN, not asserted — all three states measured on this box before landing:
    // unlanded → skips with this reason; `af17017` applied → arms and passes 7/7 with
    // ZERO skips and no edit; armed + class-A reverted to the platform rule → RED.
    if (a === true) {
      t.skip('class-B half NOT LANDED: config-load pathWithin still folds on a case-SENSITIVE directory ' +
             '(measured pathWithin=true where the volume gives genuinely distinct inodes), i.e. still ' +
             'platform-keyed. The class-A side was asserted correct UNCONDITIONALLY above. Re-land the ' +
             'class-B half (af17017) and this row arms itself into a hard equality assertion.');
      return;
    }
    assert.strictEqual(a, b,
      `TWIN DRIFT on a case-SENSITIVE directory: config-load pathWithin=${a} vs explode isContainedIn=${b}. ` +
      'Both twins are capability-converted, so a disagreement here is real drift, not a pending landing.');
    assert.strictEqual(pathWithin(real, base), true, 'a genuine child of the declared store IS contained (twin)');
  } finally { fs.rmSync(cs.root, { recursive: true, force: true }); }
});
