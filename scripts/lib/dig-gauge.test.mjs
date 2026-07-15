// Hermetic tests for dig-gauge.mjs — ULTRA trigger #2, the PRE-READ tollgate.
// The measurement (digGauge) is tested in-process (pure stat, byte-exact
// fixtures); the once-per-session offer arm + never-block contract are tested
// by spawning the REAL CLI in a sandboxed HOME (the cli.test.mjs idiom). The
// zero-content-read invariant is pinned by instrumenting fs.readFileSync = 0
// (the caliper WARP-HOLE structural-gate shape).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digGauge, digGaugeLine } from './dig-gauge.mjs';
import { clampedRead } from './config-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'cli.mjs');
const TH = { singleFileTok: 100000, pileTok: 150000, fileCount: 8 }; // the factory priors

// Write `n` files of exact byte sizes into a fresh tmp dir; return their paths.
// Buffer.alloc(size) → `size` zero bytes → statSync.size === size (the ~est tok
// is round(size/4), tokensEstFromBytes).
function fixtures(sizes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-dig-'));
  return {
    dir,
    paths: sizes.map((size, i) => {
      const p = path.join(dir, `f${i}.jsonl`);
      fs.writeFileSync(p, Buffer.alloc(size));
      return p;
    }),
  };
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ---------------------------------------------------------------------------
// 1. each threshold class fires INDEPENDENTLY; a pile under all three = CLEAR
// ---------------------------------------------------------------------------

test('rule 1 (single) fires alone: one huge file, pile+count both under', () => {
  const { dir, paths } = fixtures([480000]); // 120000 tok >= 100000; only 1 file; total 120000 < 150000
  try {
    const v = digGauge(paths, TH);
    assert.strictEqual(v.band, 'CRUSHING');
    assert.deepStrictEqual(v.tripped, ['single'], 'ONLY the single-file rule');
    assert.strictEqual(v.largestTok, 120000);
  } finally { rm(dir); }
});

test('rule 2 (pile) fires alone: mid files summing over pileTok, none huge, count under', () => {
  const { dir, paths } = fixtures([160000, 160000, 160000, 160000]); // 40000 tok each; total 160000 tok >= 150000; 4 files
  try {
    const v = digGauge(paths, TH);
    assert.strictEqual(v.band, 'CRUSHING');
    assert.deepStrictEqual(v.tripped, ['pile'], 'ONLY the pile rule');
    assert.strictEqual(v.totalTok, 160000);
  } finally { rm(dir); }
});

test('rule 3 (count) fires alone: 8 tiny files, pile+single both under', () => {
  const { dir, paths } = fixtures(Array(8).fill(100)); // 25 tok each; total 200 tok; 8 files >= 8
  try {
    const v = digGauge(paths, TH);
    assert.strictEqual(v.band, 'CRUSHING');
    assert.deepStrictEqual(v.tripped, ['count'], 'ONLY the count/dispersion rule');
    assert.strictEqual(v.files, 8);
  } finally { rm(dir); }
});

test('CLEAR: a pile under all three thresholds', () => {
  const { dir, paths } = fixtures([1000, 1000, 1000]); // 250 tok each; total 750 tok; 3 files
  try {
    const v = digGauge(paths, TH);
    assert.strictEqual(v.band, 'CLEAR');
    assert.deepStrictEqual(v.tripped, []);
    assert.match(digGaugeLine(v), /CLEAR — 3 candidate file\(s\).*safe to read\./);
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// 2. boundary: EXACTLY at each threshold = CRUSHING (>= not >); one under = CLEAR
// ---------------------------------------------------------------------------

test('boundary single: tok exactly == singleFileTok is CRUSHING; one under is CLEAR', () => {
  let f = fixtures([400000]); // 100000 tok == 100000
  try { assert.strictEqual(digGauge(f.paths, TH).band, 'CRUSHING', '>= not >'); } finally { rm(f.dir); }
  f = fixtures([399996]); // 99999 tok < 100000
  try { assert.strictEqual(digGauge(f.paths, TH).band, 'CLEAR'); } finally { rm(f.dir); }
});

test('boundary pile: sum tok exactly == pileTok is CRUSHING; one under is CLEAR', () => {
  let f = fixtures([150000, 150000, 150000, 150000]); // total 600000 B == 150000 tok; each 37500 < single; 4 < 8
  try {
    const v = digGauge(f.paths, TH);
    assert.strictEqual(v.band, 'CRUSHING');
    assert.deepStrictEqual(v.tripped, ['pile']);
  } finally { rm(f.dir); }
  f = fixtures([150000, 150000, 150000, 149996]); // total 599996 B == 149999 tok
  try { assert.strictEqual(digGauge(f.paths, TH).band, 'CLEAR'); } finally { rm(f.dir); }
});

test('boundary count: exactly fileCount files is CRUSHING; one under is CLEAR', () => {
  let f = fixtures(Array(8).fill(100)); // count 8 == 8
  try {
    const v = digGauge(f.paths, TH);
    assert.strictEqual(v.band, 'CRUSHING');
    assert.deepStrictEqual(v.tripped, ['count']);
  } finally { rm(f.dir); }
  f = fixtures(Array(7).fill(100)); // count 7 < 8
  try { assert.strictEqual(digGauge(f.paths, TH).band, 'CLEAR'); } finally { rm(f.dir); }
});

// ---------------------------------------------------------------------------
// 3. ZERO content read — the gate reads METADATA only (fs.stat), never opens a
//    candidate. Instrument fs.readFileSync = 0 (the WARP-HOLE structural gate).
// ---------------------------------------------------------------------------

test('zero-content proof: digGauge opens ZERO file content (statSync only) yet returns the correct verdict', () => {
  const { dir, paths } = fixtures([480000, 100, 100]); // a huge file + two tiny → CRUSHING via single
  const real = fs.readFileSync;
  try {
    let contentReads = 0;
    fs.readFileSync = (...a) => { contentReads++; return real(...a); };
    const v = digGauge(paths, TH);
    assert.strictEqual(contentReads, 0, 'the gauge NEVER opens content — stat is metadata only, no bytes enter context');
    assert.strictEqual(v.band, 'CRUSHING', 'and it still verdicts correctly from stats alone');
    assert.strictEqual(v.largestTok, 120000);
    assert.strictEqual(v.files, 3);
  } finally { fs.readFileSync = real; rm(dir); }
});

test('a path that cannot be stat\'d (missing / unexpanded glob) is SKIPPED, never fatal', () => {
  const { dir, paths } = fixtures([1000]);
  try {
    const v = digGauge([...paths, path.join(dir, 'nope.jsonl'), path.join(dir, '*.jsonl')], TH);
    assert.strictEqual(v.files, 1, 'only the real file is a candidate');
    assert.strictEqual(v.skipped.length, 2, 'the missing path + the literal glob are skipped');
    assert.strictEqual(v.band, 'CLEAR');
  } finally { rm(dir); }
});

// ---------------------------------------------------------------------------
// CLI: once-per-session arm + never-block (spawn the real cli.mjs, sandbox HOME)
// ---------------------------------------------------------------------------

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-proj-')));
  fs.writeFileSync(path.join(proj, '.coalwash.json'), '{}'); // factory digCrush defaults
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function projStatePath(home, proj) {
  const slug = fs.realpathSync(proj).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', slug, 'coalwash', 'state.json');
}
function run(cwd, home, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CLAUDE_CONFIG_DIR: '' },
    encoding: 'utf8', timeout: 20000,
  });
}
const OFFER = 'Offer the user ULTRA once'; // the distinctive once-per-session offer phrase

test('4. once-per-session arm: first CRUSHING surfaces the offer, a 2nd same-session dig is silent (consumed), a NEW session re-arms', () => {
  const { home, proj } = sandbox();
  try {
    const big = path.join(proj, 'big.jsonl');
    fs.writeFileSync(big, Buffer.alloc(500000)); // 125000 tok >= 100000 → CRUSHING (single)

    const r1 = run(proj, home, ['dig-gauge', big, '--session', 's1']);
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.ok(r1.stdout.includes('dig-gauge: CRUSHING'), r1.stdout);
    assert.ok(r1.stdout.includes(OFFER), 'first CRUSHING this session SURFACES the offer');

    const r2 = run(proj, home, ['dig-gauge', big, '--session', 's1']);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.includes('dig-gauge: CRUSHING'), 'the verdict line still prints (the ~free reading)');
    assert.ok(!r2.stdout.includes(OFFER), 'a 2nd dig in the SAME session is silent on the offer (consumed)');

    const r3 = run(proj, home, ['dig-gauge', big, '--session', 's2']);
    assert.strictEqual(r3.status, 0, r3.stderr);
    assert.ok(r3.stdout.includes(OFFER), 'a NEW session re-arms the offer');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});

test('5. never-block: a CRUSHING verdict exits 0 (report-only) — declining proceeds with the raw dig; a --json crush is clean; no paths = usage error', () => {
  const { home, proj } = sandbox();
  try {
    const big = path.join(proj, 'big.jsonl');
    fs.writeFileSync(big, Buffer.alloc(500000));

    const crush = run(proj, home, ['dig-gauge', big, '--session', 'x']);
    assert.strictEqual(crush.status, 0, 'CRUSHING is REPORT-ONLY — never a non-zero exit, never a block');

    const j = run(proj, home, ['dig-gauge', big, '--json', '--session', 'y']);
    assert.strictEqual(j.status, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.strictEqual(parsed.band, 'CRUSHING');
    assert.strictEqual(parsed.surface, true);
    assert.ok(parsed.offer.includes(OFFER), 'the --json rail carries the ready offer text');

    const none = run(proj, home, ['dig-gauge']);
    assert.strictEqual(none.status, 1, 'a missing candidate list is a usage error (fail loud)');
    assert.match(none.stderr, /usage: node scripts\/lib\/cli\.mjs gauge/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});

test('a CLEAR dig via the CLI is fully READ-ONLY: prints the reading, offers nothing, writes NO state', () => {
  const { home, proj } = sandbox();
  try {
    const small = path.join(proj, 'small.jsonl');
    fs.writeFileSync(small, Buffer.alloc(1000));
    const r = run(proj, home, ['dig-gauge', small, '--session', 's1']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('dig-gauge: CLEAR'), r.stdout);
    assert.ok(!r.stdout.includes(OFFER), 'CLEAR never offers');
    assert.strictEqual(fs.existsSync(projStatePath(home, proj)), false, 'a CLEAR dig arms nothing → no state write');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 6. config clamps — the digCrush block, nested in estate, clamps per-sub-key
//    and fills a partial config's absent sub-keys (the trust-boundary fill)
// ---------------------------------------------------------------------------

test('6. digCrush clamps: out-of-range sub-key → its default; a partial block fills the rest; a malformed estate → all defaults', () => {
  const DEF = { singleFileTok: 100000, pileTok: 150000, fileCount: 8 };
  // an out-of-range sub-key degrades ALONE to its default; absent sub-keys fill.
  assert.deepStrictEqual(clampedRead({ estate: { digCrush: { singleFileTok: 5 } } }, 'estate').digCrush, DEF, 'singleFileTok 5 < 20000 → default; rest fill');
  assert.deepStrictEqual(clampedRead({ estate: { digCrush: { fileCount: 999 } } }, 'estate').digCrush, DEF, 'fileCount 999 > 50 → default; rest fill');
  // a valid partial customization is KEPT, the rest fill (per-sub-key, not all-or-nothing).
  assert.deepStrictEqual(clampedRead({ estate: { digCrush: { singleFileTok: 50000 } } }, 'estate').digCrush, { singleFileTok: 50000, pileTok: 150000, fileCount: 8 });
  // a fully malformed estate (or absent) → the whole default block, digCrush included.
  assert.deepStrictEqual(clampedRead({ estate: 'nope' }, 'estate').digCrush, DEF);
  assert.deepStrictEqual(clampedRead({}, 'estate').digCrush, DEF);
});

// ---------------------------------------------------------------------------
// 7. intOr re-enforces the schema min/max at the digGauge trust boundary — a
//    DIRECT caller (not the CLI's clampObject) cannot smuggle an out-of-range
//    threshold that would false-CRUSH every dig.
// ---------------------------------------------------------------------------

test('7. intOr trust-boundary re-clamp: out-of-range thresholds fall back to the factory priors (no false-CRUSH); valid in-range values pass through', () => {
  const { dir, paths } = fixtures([1000, 1000, 1000]); // 250 tok each, 3 files — CLEAR at the defaults
  try {
    // 0 / negative / below-min would each FALSE-CRUSH (fileCount 1 -> n>=1 always; singleFileTok 0 -> any file trips)
    const v = digGauge(paths, { singleFileTok: 0, pileTok: -5, fileCount: 1 });
    assert.strictEqual(v.band, 'CLEAR', 'out-of-range thresholds fell back to defaults — no false-CRUSH');
    assert.deepStrictEqual(v.thresholds, { singleFileTok: 100000, pileTok: 150000, fileCount: 8 }, 'the factory priors are re-enforced');
    // above-max also degrades to the default
    assert.deepStrictEqual(
      digGauge(paths, { singleFileTok: 999999999, pileTok: 999999999, fileCount: 999 }).thresholds,
      { singleFileTok: 100000, pileTok: 150000, fileCount: 8 },
    );
    // a VALID in-range custom threshold is still honored
    const v3 = digGauge(paths, { singleFileTok: 20000, pileTok: 40000, fileCount: 5 });
    assert.deepStrictEqual(v3.thresholds, { singleFileTok: 20000, pileTok: 40000, fileCount: 5 }, 'in-range values pass through');
    assert.strictEqual(v3.band, 'CLEAR');
  } finally { rm(dir); }
});
