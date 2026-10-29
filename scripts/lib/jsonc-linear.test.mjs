// Linear-time strip and malformed-input preservation for scripts/lib/jsonc.mjs (28c item a).
// The JSONC comment stripper used a lazy block-comment match that re-scanned to the end of the
// input for every unclosed opener, and a string match that did the same for every unclosed
// quote, so an input with many openers that never close cost time roughly quadratic in its size.
// The regex now consumes an unclosed opener to the end of the input in ONE match, and the
// callback keeps such an opener's text unchanged: a malformed config still fails JSON.parse,
// exactly as before, and a well-formed one parses to the same value byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './jsonc.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The regex as it stood before this change, kept as the reference for the differential test.
const OLD_RE = /"(?:\\.|[^"\\])*"|\/\/.*|\/\*[\s\S]*?\*\//g;
const oldStrip = (c) => c.replace(OLD_RE, (m) => (m[0] === '"' ? m : ''));

const SIZE = 48 * 1024;
// Neither shape closes: the block openers never meet a star-slash, and the escaped quotes never meet an unescaped one.
const SHAPES = {
  unclosedBlockOpeners: '/* a'.repeat(SIZE / 4),
  unclosedStringEscapes: '"' + '\\"'.repeat(SIZE / 3),
  // A string opener whose body ends in a lone backslash: the string branch fails there and restarts two characters on.
  danglingBackslash: '"\\'.repeat(SIZE / 2),
};
const BUDGET_MS = 50;

test('stripJsonc is linear: 48 KB of unclosed openers strips in under 50 ms (best of 3 runs)', () => {
  for (const [name, input] of Object.entries(SHAPES)) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = process.hrtime.bigint();
      stripJsonc(input);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.ok(Math.min(...times) < BUDGET_MS, `${name}: best of 3 = ${Math.min(...times).toFixed(1)} ms, budget ${BUDGET_MS} ms`);
  }
});

test('stripJsonc leaves an unclosed opener in place, so a malformed config still fails JSON.parse', () => {
  for (const [name, input] of Object.entries(SHAPES)) {
    assert.equal(stripJsonc(input), input, `${name}: the unclosed text is emitted unchanged`);
  }
  assert.throws(() => JSON.parse(stripJsonc('{"a":1} /* never closed')));
  assert.throws(() => JSON.parse(stripJsonc('{"a":"never closed')));
});

test('stripJsonc matches the previous regex byte for byte on well-formed JSON-with-comments', () => {
  const fixtures = [
    '',
    '{}',
    '{"url":"http://example.com","mode":"auto"}',
    '{"p":"C:\\\\","x":"a//b"}',
    '{"q":"he said \\"hi\\""}',
    '{\n  "a": "keep", // line comment with "quotes" inside\n  "b": "x" /* block */\n}',
    '{"s":"/* not a comment */","t":"// not either"} // trailing',
    '{"a":1 /**/ , "b":2 /* a */ /* b */}',
    '{"a":"x\\\\"} /* after an escaped-backslash value */',
    '/* header */ {"k": [1, 2, 3]} // footer */',
    '{"w":"a/*b","v":"c*/d"}',
  ];
  for (const f of fixtures) {
    assert.equal(stripJsonc(f), oldStrip(f), `differs on ${JSON.stringify(f)}`);
  }
});

// The two copies of the strip module ship the same parser: the plugin twin must match the source byte for byte.
test('scripts/lib/jsonc.mjs and plugin/scripts/lib/jsonc.mjs are byte-equal', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts/lib/jsonc.mjs'));
  const twin = fs.readFileSync(path.join(repo, 'plugin/scripts/lib/jsonc.mjs'));
  assert.ok(source.equals(twin), 'plugin twin diverged from scripts/lib/jsonc.mjs');
});
