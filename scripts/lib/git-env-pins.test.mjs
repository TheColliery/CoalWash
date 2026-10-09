// The room's census PINS (09a): the canon census (git-env-census.mjs, adopted by blob id) ships no pin, so the rows this room keeps live in
// git-env-pins.mjs and are held here against the REAL tree. A row is live while its file exists with the pinned blob; a stale row fails here,
// never silently, and a row whose quoted finding lines drift from what the census reads fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanGitSpawns, collectScriptsMjs, gitBlobId } from './git-env-census.mjs';
import { CENSUS_PINS } from './git-env-pins.mjs';

const ROOM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every pin row is LIVE (its file exists with the pinned blob) and names how it ends: a stale row fails here, never silently', () => {
  assert.ok(Array.isArray(CENSUS_PINS) && CENSUS_PINS.length > 0);
  for (const row of CENSUS_PINS) {
    const abs = path.join(ROOM, ...row.rel.split('/'));
    assert.ok(fs.existsSync(abs), row.rel + ': pinned file is gone -- delete the row');
    assert.equal(gitBlobId(fs.readFileSync(abs, 'utf8')), row.blob, row.rel + ': the bytes changed -- re-copy from the source or delete the row (a row never follows an edit)');
    assert.match(row.why, /DELETE when (the canon fix lands|the census rule accepts)|KEEP while /);
  }
});

test('the real tree passes with exactly the pinned files exempt, and each pin hides only the real findings its row quotes, at the lines it names', () => {
  const files = collectScriptsMjs(ROOM);
  const withPins = scanGitSpawns(files, CENSUS_PINS);
  assert.deepEqual(withPins.findings, [], 'a finding outside the pinned files');
  assert.equal(withPins.exempted, CENSUS_PINS.length, 'every pin exempted its file');
  const bare = scanGitSpawns(files, []);
  const inside = new Set(bare.findings.map((f) => f.slice(0, f.indexOf(':'))));
  for (const rel of inside) assert.ok(CENSUS_PINS.some((row) => row.rel === rel), rel + ': a finding with no pin');
  for (const row of CENSUS_PINS) {
    const lines = bare.findings.filter((f) => f.startsWith(row.rel + ':')).map((f) => f.slice(row.rel.length + 1, f.indexOf(' ')));
    assert.ok(lines.length > 0, row.rel + ' is pinned but the census finds nothing in it: delete the row');
    const named = row.why.match(/at lines? ([\d, and]+)/)[1].match(/\d+/g);
    assert.deepEqual(lines, named, row.rel + ': the row quotes other lines than the census reads');
  }
});

test('no pin names a file the canon already passes: the rewritten secret-gate test, the release scripts and the room gates carry none', () => {
  for (const rel of ['scripts/secret-gate.test.mjs', 'scripts/release-notes.mjs', 'scripts/release-notes.test.mjs', 'scripts/verify.mjs', 'scripts/link-check.mjs']) {
    assert.ok(!CENSUS_PINS.some((row) => row.rel === rel), rel + ': no pin');
  }
});
