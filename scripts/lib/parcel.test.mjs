// Hermetic tests for parcel.mjs — the L2 PARCEL AUDIT (ruling 0l). Sandbox
// fixtures only (never the live repo — the beta.15 lesson), no wall clocks.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyParcelCandidates, compareParcelToAdapter, SAMPLE_MIN_CHARS, SAMPLE_COMPARE_CHARS } from './parcel.mjs';

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwp-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwp-proj-')));
  return { home, proj };
}
function clean(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
// Snapshot a tree's file set + mtimes — the read-only proof instrument.
function treeState(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

test('0l verifier: a legit candidate (real file, head sample AS SEEN) round-trips to verified with bytes + tokensEst', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(proj, 'CLAUDE.md');
    const content = '# Governance for this room\n\nThis file is auto-loaded every session and carries the standing rules the agents follow. ' + 'x'.repeat(400);
    fs.writeFileSync(f, content, 'utf8');
    const { verified, rejected } = verifyParcelCandidates(
      [{ path: f, sample: content.slice(0, 200) }],
      { home, projectRoot: proj },
    );
    assert.strictEqual(rejected.length, 0, JSON.stringify(rejected));
    assert.strictEqual(verified.length, 1);
    assert.strictEqual(verified[0].path, fs.realpathSync(f));
    assert.strictEqual(verified[0].bytes, fs.statSync(f).size);
    assert.ok(verified[0].tokensEst > 0);
  } finally { clean(home, proj); }
});

test('0l verifier: whitespace-normalization tolerance — CRLF/LF, wrapped lines, and collapsed runs never false-reject a genuine sighting', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(f, '# Memory index\r\n\r\nLine one with   spaced   content here\r\nLine two continues the thought\r\n' + 'y'.repeat(300), 'utf8');
    // The agent saw it rendered: LF-joined, runs collapsed, wrapped differently.
    const seen = '# Memory index Line one with spaced content here\nLine two continues the thought';
    const { verified, rejected } = verifyParcelCandidates([{ path: f, sample: seen }], { home, projectRoot: proj });
    assert.strictEqual(rejected.length, 0, JSON.stringify(rejected));
    assert.strictEqual(verified.length, 1);
  } finally { clean(home, proj); }
});

test('0l verifier: a sample the disk head does NOT match is rejected — the anti-hallucination/anti-spoof certificate', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(f, 'The real head of the real file, which the agent never quoted correctly at all. ' + 'z'.repeat(200), 'utf8');
    const { verified, rejected } = verifyParcelCandidates(
      [{ path: f, sample: 'A confidently invented head that was never actually loaded into any context window.' }],
      { home, projectRoot: proj },
    );
    assert.strictEqual(verified.length, 0);
    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason.includes('does not match the observed sample'), rejected[0].reason);
  } finally { clean(home, proj); }
});

test('0l verifier: a mid-file quote is NOT a head — rejected (head means head)', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(proj, 'CLAUDE.md');
    const head = 'HEAD SECTION comes first in this file and is what actually loads first. ';
    const mid = 'MIDDLE SECTION text that a lazy candidate might quote instead of the head portion.';
    fs.writeFileSync(f, head + 'x'.repeat(5000) + mid, 'utf8');
    const { verified, rejected } = verifyParcelCandidates([{ path: f, sample: mid }], { home, projectRoot: proj });
    assert.strictEqual(verified.length, 0);
    assert.strictEqual(rejected.length, 1);
  } finally { clean(home, proj); }
});

test('0l verifier: traversal / absolute-outside / symlink-escape paths are rejected FAIL-CLOSED (realpath-and-contain, both sides)', (t) => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwp-outside-')));
  try {
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'outside content that must never verify as class-B of this project or home. ', 'utf8');
    const sample = 'outside content that must never verify as class-B of this project or home.';
    // Absolute path outside both trees + a relative traversal shape.
    const r1 = verifyParcelCandidates([
      { path: secret, sample },
      { path: path.join(proj, '..', path.basename(outside), 'secret.md'), sample },
    ], { home, projectRoot: proj });
    assert.strictEqual(r1.verified.length, 0);
    assert.strictEqual(r1.rejected.length, 2);
    for (const r of r1.rejected) assert.ok(/escapes|does not resolve/.test(r.reason), r.reason);

    // Symlink escape: a link INSIDE the project pointing OUTSIDE — the
    // physical side must fail containment. 'junction' = the unprivileged
    // Windows shim (umbrella lesson); unsupported -> skip VISIBLY.
    let linked = false;
    const link = path.join(proj, 'link-dir');
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* capability-gated */ }
    if (!linked) { t.diagnostic('symlink/junction unsupported here — escape case covered by the absolute/traversal rejects above'); return; }
    const viaLink = path.join(link, 'secret.md');
    const r2 = verifyParcelCandidates([{ path: viaLink, sample }], { home, projectRoot: proj });
    assert.strictEqual(r2.verified.length, 0, 'a symlink pointing outside LOOKS contained lexically — realpath must catch it');
    assert.ok(r2.rejected[0].reason.includes('escapes'), r2.rejected[0].reason);
  } finally { clean(home, proj, outside); }
});

test('0l verifier: missing file · unreadable sample floor · malformed candidates — every doubt rejects with a named reason, never throws', () => {
  const { home, proj } = sandbox();
  try {
    const tiny = path.join(proj, 'tiny.md');
    fs.writeFileSync(tiny, 'short file', 'utf8'); // whole content < SAMPLE_MIN_CHARS
    const real = path.join(proj, 'real.md');
    fs.writeFileSync(real, 'a'.repeat(500), 'utf8');
    const { verified, rejected } = verifyParcelCandidates([
      { path: path.join(proj, 'gone.md'), sample: 'whatever text this claims to have seen in context' }, // missing
      { path: real, sample: 'aaaa' }, // matches the head but too short to be falsifiable
      { path: tiny, sample: 'short file' }, // tiny file: the WHOLE content passes the floor
      { path: real }, // no sample at all
      {}, // no path
      null,
    ], { home, projectRoot: proj });
    assert.strictEqual(verified.length, 1, 'only the whole-content tiny file verifies');
    assert.strictEqual(verified[0].path, fs.realpathSync(tiny));
    assert.strictEqual(rejected.length, 5);
    assert.ok(rejected.some((r) => r.reason.includes('does not resolve')), 'missing file named');
    assert.ok(rejected.some((r) => r.reason.includes('too short')), 'substance floor named');
    assert.ok(rejected.some((r) => r.reason.includes('no sample')), 'sample-less candidate named');
    // Empty input shapes never throw.
    assert.deepStrictEqual(verifyParcelCandidates(null, { home, projectRoot: proj }), { verified: [], rejected: [] });
    assert.deepStrictEqual(verifyParcelCandidates([], {}), { verified: [], rejected: [] });
  } finally { clean(home, proj); }
});

test('0l verifier is READ-ONLY: no file created, no mtime changed anywhere in either tree', () => {
  const { home, proj } = sandbox();
  try {
    const f = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(f, 'governance head content for the read-only proof, long enough to verify. ' + 'r'.repeat(200), 'utf8');
    const before = { ...treeState(home), ...treeState(proj) };
    verifyParcelCandidates([
      { path: f, sample: 'governance head content for the read-only proof, long enough to verify.' },
      { path: path.join(proj, 'missing.md'), sample: 'some claimed but nonexistent head content here' },
    ], { home, projectRoot: proj });
    const after = { ...treeState(home), ...treeState(proj) };
    assert.deepStrictEqual(after, before, 'zero writes: same file set, same mtimes — a measurement helper, never a mutator');
  } finally { clean(home, proj); }
});

test('0l compare: matched / onlyInParcel (adapter miss = the drift flag) / onlyInAdapter partitions — recall entries excluded from the adapter side', () => {
  const A = 'C:\\fake\\proj\\CLAUDE.md';
  const B = 'C:\\fake\\proj\\MEMORY.md';
  const C = 'C:\\fake\\proj\\NEW-SURFACE.md'; // the platform added it; adapter doesn't know
  const D = 'C:\\fake\\proj\\rules.md'; // adapter lists it; agent didn't see it
  const R = 'C:\\fake\\home\\memory\\recall.md'; // recall: expected-absent
  const verified = [{ path: A, bytes: 1, tokensEst: 1 }, { path: B, bytes: 1, tokensEst: 1 }, { path: C, bytes: 1, tokensEst: 1 }];
  const adapter = [
    { path: A, alwaysLoaded: true },
    { path: B, alwaysLoaded: true },
    { path: D, alwaysLoaded: true },
    { path: R, alwaysLoaded: false }, // recall-loaded -> never in the diff
  ];
  const d = compareParcelToAdapter(verified, adapter);
  assert.deepStrictEqual(d.matched.sort(), [A, B].sort());
  assert.deepStrictEqual(d.onlyInParcel, [C], 'the platform-added surface is THE drift flag');
  assert.deepStrictEqual(d.onlyInAdapter, [D], 'informational: listed but not seen');
  assert.ok(!d.onlyInAdapter.includes(R), 'recall entries are expected-absent — excluded, never noise');
});

test('0l compare: case-fold on win32 semantics + malformed inputs degrade to empty partitions, never throw', () => {
  const p = 'C:\\fake\\proj\\CLAUDE.md';
  const d = compareParcelToAdapter(
    [{ path: process.platform === 'win32' ? p.toUpperCase() : p, bytes: 1, tokensEst: 1 }],
    [{ path: p, alwaysLoaded: true }],
  );
  assert.strictEqual(d.matched.length, 1, 'same physical file matches across case on Windows');
  assert.deepStrictEqual(compareParcelToAdapter(null, null), { matched: [], onlyInParcel: [], onlyInAdapter: [] });
  assert.deepStrictEqual(compareParcelToAdapter([{}, null], ['garbage']), { matched: [], onlyInParcel: [], onlyInAdapter: [] });
});

test('0l constants: the sample floor and compare window are sane, and the floor is below the window', () => {
  assert.ok(SAMPLE_MIN_CHARS > 0 && SAMPLE_COMPARE_CHARS > SAMPLE_MIN_CHARS);
});
