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
