// scripts/lib/test-plan.mjs: the room's wave-run numbers and the declared-test floor (09a; testing.md, the TAP-names MUST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plan from './test-plan.mjs';
import { declaredTopLevelTests, shortfallResults, HEAP_MB, TEST_TIMEOUT_MS, FILE_CLOCK_MS, RUN_TIMEOUT_MS } from './test-plan.mjs';

const ROOM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('declaredTopLevelTests counts the test( calls that start a line in column 0, the skip/todo/only forms included, in LF and in CRLF', () => {
  const lf = ["import { test } from 'node:test';", "test('a', () => {});", "test.skip('b', () => {});", "test.todo('c');", "test.only('d', () => {});", ''].join('\n');
  assert.equal(declaredTopLevelTests(lf), 4);
  assert.equal(declaredTopLevelTests(lf.replace(/\n/g, '\r\n')), 4);
});

test('declaredTopLevelTests never counts an indented, a commented-out or a member test( call: the floor is a LOWER bound', () => {
  const text = ["for (const v of list) {", "  test(`row ${v}`, () => {});", "}", "// test('old', () => {});", "t.test('sub', () => {});", "contest('x');", ''].join('\n');
  assert.equal(declaredTopLevelTests(text), 0);
});

test('shortfallResults turns a PASS that reported fewer tests than it declares into a FAIL naming both numbers, and leaves every other result alone', () => {
  const text = ["test('one', () => {});", "test('two', () => { process.exit(0); });", "test('three', () => {});", ''].join('\n');
  const read = (f) => (f === 'gone.test.mjs' ? null : text);
  const results = [
    { file: 'short.test.mjs', status: 'PASS', counts: { tests: 1 } },
    { file: 'whole.test.mjs', status: 'PASS', counts: { tests: 3 } },
    { file: 'more.test.mjs', status: 'PASS', counts: { tests: 7 } },
    { file: 'red.test.mjs', status: 'FAIL', counts: { tests: 0 }, reason: 'not ok: x' },
    { file: 'skipped.test.mjs', status: 'SKIP', counts: { tests: 2 } },
    { file: 'gone.test.mjs', status: 'PASS', counts: { tests: 1 } },
  ];
  const out = shortfallResults(results, read);
  assert.deepEqual(out.map((r) => r.status), ['FAIL', 'PASS', 'PASS', 'FAIL', 'FAIL', 'PASS']);
  assert.match(out[0].reason, /^declares 3 top-level test\(s\) but the run reported 1 /);
  assert.equal(out[3].reason, 'not ok: x', 'a red file keeps its own reason');
  assert.equal(results[0].status, 'PASS', 'the input array is not mutated');
});

test('the room numbers are finite and nest (test < file < run), and every roster file runs under the wave runner (no direct run, 09b)', () => {
  for (const n of [HEAP_MB, TEST_TIMEOUT_MS, FILE_CLOCK_MS, RUN_TIMEOUT_MS]) assert.ok(Number.isInteger(n) && n > 0);
  assert.ok(HEAP_MB <= 2048, 'dispatch-transport.md: a test child runs under a heap cap of 2048 MB or lower');
  assert.ok(TEST_TIMEOUT_MS < FILE_CLOCK_MS && FILE_CLOCK_MS < RUN_TIMEOUT_MS);
  assert.equal(plan.DIRECT_FILES, undefined, 'the 09a direct run is gone');
  assert.equal(plan.runDirect, undefined, 'the 09a direct run is gone');
  const runner = fs.readFileSync(path.join(ROOM, 'scripts', 'test.mjs'), 'utf8');
  assert.match(runner, /runWaves\(\{ files: TESTS, /, 'the whole roster goes to the wave runner');
  assert.ok(runner.includes("'scripts/lib/wave-run.test.mjs'"), 'wave-run.test.mjs is on the roster');
});
