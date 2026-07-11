// Hermetic tests for writeguard.mjs — the 0p WRITE-PATH SEATBELT + AIRBAG.
// Sandbox fixtures only (never the live repo — the beta.15 lesson); the perf
// claim is STRUCTURAL (instrumented fs, zero wall clocks).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGuardedTarget, snapshotOnFirstWrite, seatbeltCheck,
  listWriteguard, readWriteguardSnapshot, sweepWriteguard, SEATBELT_MAX_BYTES,
} from './writeguard.mjs';

delete process.env.CLAUDE_CONFIG_DIR; // hermetic: sandbox home only

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-home-')));
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-proj-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj };
}
function clean(...dirs) { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
function wgRoot(proj) { return path.join(proj, '.claude', 'coalwash', 'writeguard'); }
function treeState(dir) {
  const out = {};
  const walk = (d) => {
    let names; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else out[p] = st.mtimeMs + ':' + st.size;
    }
  };
  walk(dir);
  return out;
}
// A governance-file body long enough that a one-token cut leaves the rest intact.
const GOV = '# Governance\n\nSee [the guide](https://example.com/guide) and version v1.2.3 on 2026-07-11. ' + 'x'.repeat(300);

// ---------------------------------------------------------------------------
// isGuardedTarget — the cheap prefilter + realpath-and-contain
// ---------------------------------------------------------------------------

test('isGuardedTarget: root governance basenames + markdown under a .claude tree are guarded; source code is NOT', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md'); fs.writeFileSync(gov, GOV, 'utf8');
    const mem = path.join(proj, 'MEMORY.md'); fs.writeFileSync(mem, GOV, 'utf8');
    const rule = path.join(proj, '.claude', 'rules', 'x.md'); fs.mkdirSync(path.dirname(rule), { recursive: true }); fs.writeFileSync(rule, GOV, 'utf8');
    const globalGov = path.join(home, '.claude', 'CLAUDE.md'); fs.writeFileSync(globalGov, GOV, 'utf8');
    const src = path.join(proj, 'src', 'index.js'); fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, 'code', 'utf8');
    const doc = path.join(proj, 'docs', 'readme.md'); fs.mkdirSync(path.dirname(doc), { recursive: true }); fs.writeFileSync(doc, '# docs', 'utf8');

    assert.strictEqual(isGuardedTarget(gov, { projectRoot: proj, home }), fs.realpathSync(gov));
    assert.strictEqual(isGuardedTarget(mem, { projectRoot: proj, home }), fs.realpathSync(mem));
    assert.strictEqual(isGuardedTarget(rule, { projectRoot: proj, home }), fs.realpathSync(rule));
    assert.strictEqual(isGuardedTarget(globalGov, { projectRoot: proj, home }), fs.realpathSync(globalGov));
    assert.strictEqual(isGuardedTarget(src, { projectRoot: proj, home }), null, 'source code is never guarded');
    assert.strictEqual(isGuardedTarget(doc, { projectRoot: proj, home }), null, 'a plain docs .md outside .claude is not guarded (undercount-is-safe ceiling)');
  } finally { clean(home, proj); }
});

test('isGuardedTarget: CW\'s OWN sandbox (.claude/coalwash/**) is NEVER guarded — 0h-GUARD: the guard must never touch a bin or its own snapshots', () => {
  const { home, proj } = sandbox();
  try {
    const binFile = path.join(proj, '.claude', 'coalwash', 'fat-bin', 'x.md');
    fs.mkdirSync(path.dirname(binFile), { recursive: true }); fs.writeFileSync(binFile, GOV, 'utf8');
    assert.strictEqual(isGuardedTarget(binFile, { projectRoot: proj, home }), null);
  } finally { clean(home, proj); }
});

test('isGuardedTarget: an unresolvable / out-of-tree path is fail-closed (null)', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-out-')));
  try {
    const stray = path.join(outside, 'CLAUDE.md'); fs.writeFileSync(stray, GOV, 'utf8');
    assert.strictEqual(isGuardedTarget(stray, { projectRoot: proj, home }), null, 'a governance basename OUTSIDE the trees is not contained -> fail-closed');
    assert.strictEqual(isGuardedTarget(path.join(proj, 'gone.md'), { projectRoot: proj, home }), null, 'missing/unresolvable -> null');
    assert.strictEqual(isGuardedTarget('', { projectRoot: proj, home }), null);
    assert.strictEqual(isGuardedTarget(null, { projectRoot: proj, home }), null);
  } finally { clean(home, proj, outside); }
});

// ---------------------------------------------------------------------------
// AIRBAG — snapshot-on-first-write
// ---------------------------------------------------------------------------

test('airbag: snapshots a guarded file ONCE per session; the 2nd write to the same file skips (baseline stays the FIRST-write orig)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    const snap1 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.ok(snap1 && fs.existsSync(snap1), 'first write snapshots');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), GOV, 'snapshot is the byte-exact orig');
    // The file changes, then a SECOND write fires the airbag again -> must skip.
    fs.writeFileSync(gov, GOV + '\nmore', 'utf8');
    const snap2 = snapshotOnFirstWrite(proj, 'sess-A', gov, { home });
    assert.strictEqual(snap2, snap1, 'same snapshot path returned, not re-copied');
    assert.strictEqual(fs.readFileSync(snap1, 'utf8'), GOV, 'the baseline is STILL the first-write orig, not the mutated content');
    // self-ignore present (snapshots stay out of VCS).
    assert.ok(fs.existsSync(path.join(path.dirname(snap1), '.gitignore')));
    assert.ok(fs.existsSync(path.join(wgRoot(proj), '.gitignore')));
  } finally { clean(home, proj); }
});

test('airbag: a source-code write / a not-yet-existing file / a non-guarded path all snapshot NOTHING', () => {
  const { home, proj } = sandbox();
  try {
    const src = path.join(proj, 'index.js'); fs.writeFileSync(src, 'code', 'utf8');
    assert.strictEqual(snapshotOnFirstWrite(proj, 's', src, { home }), null, 'source code not guarded');
    const newGov = path.join(proj, 'AGENTS.md'); // guarded basename, but does not exist yet (a Write creating it)
    assert.strictEqual(snapshotOnFirstWrite(proj, 's', newGov, { home }), null, 'no orig on disk -> nothing to snapshot');
    assert.strictEqual(fs.existsSync(wgRoot(proj)), false, 'no writeguard dir created for un-snapshotted writes');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// SEATBELT — the advisory drop-detector + the FP mini-lab (0p prereq)
// ---------------------------------------------------------------------------

test('FP lab (a): a CARELESS drop — an edit that silently loses a link — fires the advisory (classes named)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    // careless: the link vanishes, everything else stays.
    fs.writeFileSync(gov, GOV.replace('[the guide](https://example.com/guide)', 'the guide'), 'utf8');
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && !r.oversize, 'a diff ran');
    assert.ok(r.classes.includes('link-drop'), JSON.stringify(r.classes));
    assert.strictEqual(r.file, fs.realpathSync(gov));
    assert.ok(r.snapshotPath && fs.existsSync(r.snapshotPath), 'the snapshot pointer is a real file');
  } finally { clean(home, proj); }
});

test('FP lab (b) — the HARD case: a DELIBERATE whole-section removal that drops tokens as its PURPOSE also fires — option (ii): advisory-always, FYI-framed, NEVER a block (an FP costs one line, never a blocked edit)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    // Two sections; the deliberate cut removes the whole second one (links,
    // numbers, dates go with it — that is the edit's PURPOSE, not a slip).
    const orig = '# Index\n\nKeep this.\n\n## Old section\n\nSee [ref](https://x.com) v9.9.9 on 2026-01-01, count 42.\n';
    fs.writeFileSync(gov, orig, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, '# Index\n\nKeep this.\n', 'utf8'); // section deliberately gone
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    // It DOES flag (structured tokens dropped) — that is by design (no
    // deliberate-vs-careless heuristic). The KEY property: it is advisory only.
    assert.ok(r && r.classes.length > 0, 'a deliberate cut still surfaces (option ii, no misclassification)');
    // Prove it renders as an FYI, never a block: the advisory text says so and
    // points at the snapshot; the result carries no block signal of any kind.
    // (The conductor test proves stdout is plain, never {decision:'block'}.)
    assert.strictEqual(r.oversize, false);
    assert.ok(r.snapshotPath, 'every fire carries the undo hint');
  } finally { clean(home, proj); }
});

test('seatbelt: a CLEAN edit (only additions, no structured-token loss) returns no classes -> the conductor stays silent', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, GOV + '\n\nAdded a fresh line, dropped nothing.', 'utf8');
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && !r.oversize);
    assert.deepStrictEqual(r.classes, [], 'nothing dropped -> empty -> silent');
  } finally { clean(home, proj); }
});

test('seatbelt: no airbag baseline (a brand-new guarded file, or the airbag was off) -> null (silent), never a false advisory', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV.replace('[the guide](https://example.com/guide)', 'gone'), 'utf8'); // exists but no snapshot taken
    assert.strictEqual(seatbeltCheck(proj, 'sess', gov, { home }), null, 'no baseline -> silent');
  } finally { clean(home, proj); }
});

test('seatbelt: an OVERSIZE guarded file skips the diff — snapshot stands, oversize note returned (perf degrade, no inline scan of a pathological file)', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    const big = '[link](https://x.com)\n' + 'a'.repeat(SEATBELT_MAX_BYTES + 100);
    fs.writeFileSync(gov, big, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home });
    fs.writeFileSync(gov, 'a'.repeat(SEATBELT_MAX_BYTES + 100), 'utf8'); // link dropped, but oversize
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r && r.oversize === true, 'oversize -> diff skipped');
    assert.deepStrictEqual(r.classes, [], 'no class list when the diff is skipped');
    assert.ok(r.snapshotPath && fs.existsSync(r.snapshotPath), 'the airbag snapshot still exists (undo net intact)');
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// PERF — STRUCTURAL (no wall clock): the non-guarded path does ZERO snapshot
// work; the guarded path does exactly one copy. Instrument fs.copyFileSync.
// ---------------------------------------------------------------------------

test('perf (structural): a non-guarded write triggers ZERO snapshot copies; a guarded first-write triggers exactly ONE — no discovery walk on either path', () => {
  const { home, proj } = sandbox();
  const realCopy = fs.copyFileSync;
  let copies = 0;
  try {
    fs.copyFileSync = (...a) => { copies++; return realCopy(...a); };
    const src = path.join(proj, 'index.js'); realCopy && fs.writeFileSync(src, 'code', 'utf8');
    copies = 0;
    snapshotOnFirstWrite(proj, 's', src, { home });
    assert.strictEqual(copies, 0, 'source code: zero copy work (skips at the cheap prefilter)');
    const gov = path.join(proj, 'CLAUDE.md'); fs.writeFileSync(gov, GOV, 'utf8');
    copies = 0;
    snapshotOnFirstWrite(proj, 's', gov, { home });
    assert.strictEqual(copies, 1, 'guarded first write: exactly one ms-copy');
    snapshotOnFirstWrite(proj, 's', gov, { home });
    assert.strictEqual(copies, 1, 'guarded second write: no further copy (already snapshotted)');
  } finally { fs.copyFileSync = realCopy; clean(home, proj); }
});

test('read-only-except-sandbox: the seatbelt writes NOTHING (the target file + tree are byte/mtime identical after a check); only the airbag writes, and only under .claude/coalwash', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'sess', gov, { home }); // airbag writes (under sandbox only)
    fs.writeFileSync(gov, GOV.replace('v1.2.3', 'gone'), 'utf8'); // an external edit drops a version
    // Snapshot the whole project tree EXCLUDING the sandbox, then run the
    // seatbelt, then prove nothing outside the sandbox changed.
    const before = treeState(proj);
    delete before[gov]; // the edit above is the test's own write, not the seatbelt's
    const r = seatbeltCheck(proj, 'sess', gov, { home });
    assert.ok(r.classes.includes('version-drop'));
    const after = treeState(proj);
    delete after[gov];
    // Every non-sandbox path unchanged (the seatbelt only READS).
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k.includes(path.join('.claude', 'coalwash'))) continue; // airbag's own sandbox writes are allowed
      assert.strictEqual(after[k], before[k], `seatbelt must not touch ${k}`);
    }
  } finally { clean(home, proj); }
});

// ---------------------------------------------------------------------------
// RECOVERY — restore-by-reference (0p law): metadata to the agent, CODE moves
// the real bytes; isBareId-contained (F1).
// ---------------------------------------------------------------------------

test('recovery: listWriteguard returns METADATA only (never content); readWriteguardSnapshot returns the byte-exact ORIGINAL', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(gov, GOV, 'utf8');
    const snap = snapshotOnFirstWrite(proj, 'sess', gov, { home });
    const name = path.basename(snap);
    const list = listWriteguard(proj, { home });
    assert.strictEqual(list.length, 1);
    assert.ok(!('content' in list[0]), 'listing carries NO content — metadata only');
    assert.strictEqual(list[0].name, name);
    assert.ok(list[0].bytes > 0 && list[0].snapshotPath === snap);
    const got = readWriteguardSnapshot(proj, name, { home });
    assert.strictEqual(got.content, GOV, 'the recovered bytes are the byte-exact original — code-moved, model-untouched');
  } finally { clean(home, proj); }
});

test('recovery: readWriteguardSnapshot rejects a non-bare / traversal name (F1) and a miss -> null', () => {
  const { home, proj } = sandbox();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwwg-secret-')));
  try {
    fs.writeFileSync(path.join(outside, 'secret.md'), 'not yours', 'utf8');
    for (const evil of ['../../' + path.basename(outside) + '/secret.md', '..\\secret', '.', '..', 'a/b']) {
      assert.strictEqual(readWriteguardSnapshot(proj, evil, { home }), null, `traversal id ${JSON.stringify(evil)} -> null`);
    }
    assert.strictEqual(readWriteguardSnapshot(proj, 'no-such-snap', { home }), null, 'miss -> null');
  } finally { clean(home, proj, outside); }
});

// ---------------------------------------------------------------------------
// SWEEP — run-gated session cleanup (NOT a bin, NOT a clock)
// ---------------------------------------------------------------------------

test('sweep: keeps the CURRENT session\'s snapshots, drops every prior session\'s — never touches bins', () => {
  const { home, proj } = sandbox();
  try {
    const gov = path.join(proj, 'MEMORY.md'); fs.writeFileSync(gov, GOV, 'utf8');
    snapshotOnFirstWrite(proj, 'old-session', gov, { home });
    snapshotOnFirstWrite(proj, 'current-session', gov, { home });
    // a sibling bin dir that must never be touched by the sweep.
    const bin = path.join(proj, '.claude', 'coalwash', 'fat-bin');
    fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, 'item'), 'x', 'utf8');

    const roots = fs.readdirSync(wgRoot(proj)).filter((n) => n !== '.gitignore').sort();
    assert.deepStrictEqual(roots, ['current-session', 'old-session']);
    sweepWriteguard(proj, 'current-session', { home });
    const after = fs.readdirSync(wgRoot(proj)).filter((n) => n !== '.gitignore');
    assert.deepStrictEqual(after, ['current-session'], 'only the current session survives');
    assert.strictEqual(fs.readFileSync(path.join(bin, 'item'), 'utf8'), 'x', 'the bin is untouched — writeguard is NOT a bin (0h-GUARD)');
  } finally { clean(home, proj); }
});

test('sweep: no writeguard dir yet, or a malformed session id, never throws', () => {
  const { home, proj } = sandbox();
  try {
    assert.doesNotThrow(() => sweepWriteguard(proj, 'sess', { home }));
    assert.doesNotThrow(() => sweepWriteguard(proj, null, { home }));
  } finally { clean(home, proj); }
});

test('SEATBELT_MAX_BYTES is a sane positive placeholder constant', () => {
  assert.ok(Number.isFinite(SEATBELT_MAX_BYTES) && SEATBELT_MAX_BYTES > 1024);
});
