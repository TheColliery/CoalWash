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

import { physicalForCreate as pfcClassB, physicalOrNull as ponClassB } from './class-b.mjs';
import { pathWithin } from './config-load.mjs';
import { physicalForCreate as pfcClassA, isContainedIn } from './explode.mjs';

const WIN = process.platform === 'win32';

function buildCases() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'CW-TWINPIN-LONGNAME-')));
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
  return { root, dir, cases };
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

test('TWIN-PIN is not vacuous: the table contains at least one case whose verdict is NON-trivial on this platform', () => {
  const { root, dir, cases } = buildCases();
  try {
    assert.ok(cases.length >= 11, `table too small (${cases.length}) — a pin over nothing proves nothing`);
    const resolvable = cases.filter(([, i]) => typeof i === 'string' && i && pfcClassB(i) !== null);
    const refused = cases.filter(([, i]) => typeof i === 'string' && i && pfcClassB(i) === null);
    assert.ok(resolvable.length >= 4, 'the table drives real resolutions');
    assert.ok(refused.length >= 2, 'the table drives real refusals');
    assert.ok(pfcClassB(dir) !== null, 'sanity: an ordinary existing dir resolves');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
