import { test } from 'node:test';
import assert from 'node:assert';
import { CONFIG_SCHEMA, validateValue, validateConfig, clampedRead } from './config-schema.mjs';

test('every schema key carries a valid default (the clamp target)', () => {
  for (const spec of CONFIG_SCHEMA) {
    assert.notStrictEqual(spec.def, undefined, `${spec.key} has no def`);
    assert.strictEqual(validateValue(spec, spec.def), null, `${spec.key} default fails its own spec`);
  }
});

test('standard-system keys keep the CoalMine shapes (one flock, one color)', () => {
  const lang = CONFIG_SCHEMA.find((s) => s.key === 'language');
  assert.deepStrictEqual(lang.values, ['auto', 'th', 'en', 'ja', 'zh', 'es']);
  assert.strictEqual(lang.def, 'auto');
  const um = CONFIG_SCHEMA.find((s) => s.key === 'updateMode');
  assert.deepStrictEqual(um.values, ['ask', 'auto', 'remind', 'off']);
  assert.strictEqual(um.def, 'ask');
  const ud = CONFIG_SCHEMA.find((s) => s.key === 'updateCheckDays');
  assert.strictEqual(ud.min, 1);
  assert.strictEqual(ud.max, 365);
  assert.strictEqual(ud.def, 14);
});

test('validateValue: bounds and types', () => {
  const int = { type: 'int', min: 1, max: 365 };
  assert.strictEqual(validateValue(int, 14), null);
  assert.ok(validateValue(int, 0));
  assert.ok(validateValue(int, 366));
  assert.ok(validateValue(int, 1.5));
  assert.ok(validateValue(int, 'x'));
  const num = { type: 'number', min: 1, max: 50 };
  assert.strictEqual(validateValue(num, 6.5), null);
  assert.ok(validateValue(num, NaN));
  const en = { type: 'enum', values: ['quick', 'full'] };
  assert.strictEqual(validateValue(en, 'QUICK'), null, 'enums compare case-insensitively');
  assert.ok(validateValue(en, 'turbo'));
  const b = { type: 'bool' };
  assert.strictEqual(validateValue(b, true), null);
  assert.ok(validateValue(b, 'true'));
});

test('validateConfig reports unknown keys and bad values, never throws', () => {
  const errors = validateConfig({ coalwashMode: 'auto', nonsense: 1, fullPercent: 999 });
  assert.ok(errors.some((e) => e.includes("'nonsense'")));
  assert.ok(errors.some((e) => e.includes("'fullPercent'")));
  assert.strictEqual(validateConfig({ coalwashMode: 'auto' }).length, 0);
  assert.deepStrictEqual(validateConfig(null), ['config must be a JSON object']);
  assert.deepStrictEqual(validateConfig([]), ['config must be a JSON object']);
});

test('clampedRead: valid passes through, invalid degrades to the default', () => {
  assert.strictEqual(clampedRead({ fullPercent: 10 }, 'fullPercent'), 10);
  assert.strictEqual(clampedRead({ fullPercent: 999 }, 'fullPercent'), 6);
  assert.strictEqual(clampedRead({ fullPercent: 'lots' }, 'fullPercent'), 6);
  assert.strictEqual(clampedRead({}, 'fullPercent'), 6);
  assert.strictEqual(clampedRead(undefined, 'fullPercent'), 6);
  assert.strictEqual(clampedRead({ updateCheckDays: 0 }, 'updateCheckDays'), 14, 'updateCheckDays:0 must NOT mean nag-every-session');
});

test('clampedRead normalizes enum case and clamps unknown enum values', () => {
  assert.strictEqual(clampedRead({ coalwashMode: 'OFF' }, 'coalwashMode'), 'off');
  assert.strictEqual(clampedRead({ coalwashMode: 'sideways' }, 'coalwashMode'), 'auto');
  assert.strictEqual(clampedRead({ quickVsFull: 'FULL' }, 'quickVsFull'), 'full');
});

test('clampedRead on an unknown key returns undefined (programming error, loud in tests)', () => {
  assert.strictEqual(clampedRead({}, 'noSuchKey'), undefined);
});

// ---------------------------------------------------------------------------
// beta.10: exercisePerBand (bandmap) + forceMode (enum)
// beta.12 band-collapse: the plump rung is retired (merged into the single
// obese ceiling) — exercisePerBand now maps only {obese, full}.
// F3 (beta.14, main-adjudicated per the 0f "OBESE never asks" ruling): the
// bandmap's values are PER-BAND — obese admits ONLY 'quick' (the old 'full'
// option routed an OBESE crossing to an ask); a legacy obese:'full' config
// clamps to 'quick' at read, per-band, without clobbering the other band.
// ---------------------------------------------------------------------------

test('exercisePerBand: factory default maps obese/full; values are PER-BAND — obese: quick only (F3), full: quick|full', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'exercisePerBand');
  assert.strictEqual(spec.type, 'bandmap');
  assert.deepStrictEqual(spec.def, { obese: 'quick', full: 'full' });
  assert.deepStrictEqual(spec.values, { obese: ['quick'], full: ['quick', 'full'] });
});

test('validateValue (bandmap): requires every sub-key, each one of ITS band\'s allowed values — obese:\'full\' is now a schema error (F3)', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'exercisePerBand');
  assert.strictEqual(validateValue(spec, { obese: 'quick', full: 'full' }), null);
  assert.strictEqual(validateValue(spec, { obese: 'QUICK', full: 'Full' }), null, 'case-insensitive');
  assert.strictEqual(validateValue(spec, { obese: 'quick', full: 'quick' }), null, 'full still admits quick');
  assert.ok(validateValue(spec, { obese: 'full', full: 'full' }), 'F3: obese no longer admits full — OBESE never asks');
  assert.ok(validateValue(spec, { obese: 'quick' }), 'missing full -> error');
  assert.ok(validateValue(spec, { obese: 'turbo', full: 'full' }), 'unknown value -> error');
  assert.ok(validateValue(spec, 'quick'), 'a non-object -> error');
  assert.ok(validateValue(spec, ['quick']), 'an array -> error');
  assert.ok(validateValue(spec, null), 'null -> error');
});

test('clampedRead (bandmap): valid passes through lowercased; each band clamps to ITS OWN default on doubt (per-band safer-value-wins, F3)', () => {
  assert.deepStrictEqual(clampedRead({ exercisePerBand: { obese: 'QUICK', full: 'FULL' } }, 'exercisePerBand'), { obese: 'quick', full: 'full' });
  assert.deepStrictEqual(clampedRead({ exercisePerBand: { obese: 'turbo', full: 'full' } }, 'exercisePerBand'), { obese: 'quick', full: 'full' });
  assert.deepStrictEqual(clampedRead({}, 'exercisePerBand'), { obese: 'quick', full: 'full' });
  assert.deepStrictEqual(clampedRead({ exercisePerBand: { obese: 'quick', full: 'full', extra: 'nonsense' } }, 'exercisePerBand'), { obese: 'quick', full: 'full' }, 'an extra sub-key never leaks through');
  assert.deepStrictEqual(clampedRead({ exercisePerBand: { plump: 'full', obese: 'quick', full: 'full' } }, 'exercisePerBand'), { obese: 'quick', full: 'full' }, 'a leftover plump sub-key from an old config is silently dropped, never trusted');
  // F3, the legacy-config clamp: obese:'full' silently reads 'quick' (no
  // breakage, CM v3.9.3 safer-value-wins) WITHOUT clobbering the user's
  // still-valid customization on the full band.
  assert.deepStrictEqual(clampedRead({ exercisePerBand: { obese: 'full', full: 'quick' } }, 'exercisePerBand'), { obese: 'quick', full: 'quick' }, 'legacy obese:full clamps per-band; the valid full:quick customization survives');
  // A malformed whole value still degrades every band to its default.
  assert.deepStrictEqual(clampedRead({ exercisePerBand: 'quick' }, 'exercisePerBand'), { obese: 'quick', full: 'full' });
});

// ---------------------------------------------------------------------------
// beta.12 item 6: managedPaths (stringList) — the auto-declaration config
// half of the byte-identical-across-roots managed-artifact exclusion.
// ---------------------------------------------------------------------------

test('managedPaths: stringList, factory default [] (the heuristic covers the common case with no config)', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'managedPaths');
  assert.strictEqual(spec.type, 'stringList');
  assert.deepStrictEqual(spec.def, []);
});

test('validateValue (stringList): an array of strings passes; anything else fails', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'managedPaths');
  assert.strictEqual(validateValue(spec, []), null);
  assert.strictEqual(validateValue(spec, ['.claude/rules/ecc']), null);
  assert.ok(validateValue(spec, 'not-an-array'));
  assert.ok(validateValue(spec, [1, 2]), 'non-string elements fail');
  assert.ok(validateValue(spec, null));
});

test('clampedRead (stringList): a valid array passes through as-is; any doubt degrades to []', () => {
  assert.deepStrictEqual(clampedRead({ managedPaths: ['a/b', 'c/d'] }, 'managedPaths'), ['a/b', 'c/d']);
  assert.deepStrictEqual(clampedRead({ managedPaths: 'nope' }, 'managedPaths'), []);
  assert.deepStrictEqual(clampedRead({}, 'managedPaths'), []);
});

test('forceMode: enum auto|ask|off, default auto', () => {
  const spec = CONFIG_SCHEMA.find((s) => s.key === 'forceMode');
  assert.deepStrictEqual(spec.values, ['auto', 'ask', 'off']);
  assert.strictEqual(spec.def, 'auto');
  assert.strictEqual(clampedRead({ forceMode: 'OFF' }, 'forceMode'), 'off');
  assert.strictEqual(clampedRead({ forceMode: 'sideways' }, 'forceMode'), 'auto');
  assert.strictEqual(clampedRead({}, 'forceMode'), 'auto');
});
