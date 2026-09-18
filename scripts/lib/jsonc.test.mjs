import { test } from 'node:test';
import assert from 'node:assert';
import { stripJsonc, parseJsonc } from './jsonc.mjs';

test('strips line and block comments but not string contents', () => {
  const src = '{\n  // line comment\n  "a": "keep // this", /* block */ "b": 1\n}';
  const parsed = JSON.parse(stripJsonc(src));
  assert.deepStrictEqual(parsed, { a: 'keep // this', b: 1 });
});

test('a string ending in a literal backslash does not leak escape state (CM #12)', () => {
  const src = '{ "p": "C:\\\\", "q": 2 } // tail';
  const parsed = JSON.parse(stripJsonc(src));
  assert.strictEqual(parsed.p, 'C:\\');
  assert.strictEqual(parsed.q, 2);
});

test('parseJsonc drops __proto__/constructor/prototype (prototype-pollution guard)', () => {
  const poisoned = '{ "__proto__": { "polluted": true }, "constructor": 1, "prototype": 2, "ok": 3 }';
  const parsed = parseJsonc(poisoned);
  assert.strictEqual(parsed.ok, 3);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.keys(parsed).includes('constructor'), false);
  assert.strictEqual(Object.keys(parsed).includes('prototype'), false);
});

test('parseJsonc parses a commented factory-style config', () => {
  const parsed = parseJsonc('{\n  // the mode\n  "coalwashMode": "auto"\n}');
  assert.deepStrictEqual(parsed, { coalwashMode: 'auto' });
});
