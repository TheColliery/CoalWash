import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-release-shape.mjs');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-shape-test-'));
}

function run(cwd, stdin) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8', timeout: 30000, input: stdin });
}

test('verify-release-shape.mjs: matching title + body -> exit 0', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, JSON.stringify({ name: 'v1.0.0 - a fix', body: 'A fix.' }));
  assert.equal(res.status, 0, res.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: a published body that PRESERVES its trailing newline still matches -- rot-canary catch: the old code only trimmed the INTENDED side, so this exact shape would have false-failed every real release under this mechanism', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, JSON.stringify({ name: 'v1.0.0 - a fix', body: 'A fix.\n' }));
  assert.equal(res.status, 0, res.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: a title mismatch fails loud and names both strings, exit 1', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, JSON.stringify({ name: 'v1.0.0', body: 'A fix.' }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /TITLE MISMATCH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: a SAME-LENGTH body substitution is caught -- the exact CoalHearth em-dash-to-hyphen incident this rail exists for', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'The API—which is public—returns JSON.\n');
  const res = run(dir, JSON.stringify({ name: 'v1.0.0 - a fix', body: 'The API-which is public-returns JSON.' }));
  assert.equal(res.status, 1, 'same character COUNT, different bytes -- a length compare would have missed this');
  assert.match(res.stderr, /BODY MISMATCH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: no stdin at all fails loud rather than comparing against an empty string silently', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, '');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no published Release JSON on stdin/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: malformed JSON on stdin fails loud, names it, never crashes with a raw stack', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - a fix\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, '{not json');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify-release-shape.mjs: the derived files are missing (release-notes.mjs never ran) fails loud, names the problem', () => {
  const dir = scratch();
  const res = run(dir, JSON.stringify({ name: 'x', body: 'y' }));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /could not read the derived title\/body/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// UMB-392 / BA-14: outside the band the rail prints a NAMED warning and PASSES (a signal, never a refusal); a mismatch still fails.
function bandRun(summaryLen) {
  const dir = scratch();
  const title = `v1.0.0 - ${'a'.repeat(summaryLen)}`;
  fs.writeFileSync(path.join(dir, 'release-title.txt'), title + '\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, JSON.stringify({ name: title, body: 'A fix.' }));
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test('verify-release-shape.mjs: a summary of 60 or 75 characters (and 45) prints no warning', () => {
  for (const n of [60, 75, 45]) {
    const res = bandRun(n);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout + res.stderr, /release-title-band/, String(n));
  }
});

test('verify-release-shape.mjs: a summary of 76 or 44 characters warns by name and still passes, exit 0 -- nothing refuses', () => {
  for (const n of [76, 44, 211]) {
    const res = bandRun(n);
    assert.equal(res.status, 0, `${n}: ${res.stderr}`);
    assert.match(res.stdout, new RegExp(`WARNING release-title-band: the summary in the title is ${n} characters`), String(n));
    assert.match(res.stdout, /verify-release-shape: published title \+ body match/, 'the byte check still reports');
  }
});

test('verify-release-shape.mjs: a mismatch still fails with exit 1 even when the title is inside the band', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'release-title.txt'), 'v1.0.0 - ' + 'a'.repeat(60) + '\n');
  fs.writeFileSync(path.join(dir, 'release-body.md'), 'A fix.\n');
  const res = run(dir, JSON.stringify({ name: 'v1.0.0 - ' + 'b'.repeat(60), body: 'A fix.' }));
  assert.equal(res.status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
