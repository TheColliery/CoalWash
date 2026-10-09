#!/usr/bin/env node
// CoalWash test runner — the canonical gate suite. Enumerates EVERY test file
// explicitly and FAILS LOUD on drift in BOTH directions (listed-but-missing,
// on-disk-but-unlisted). Mirrors the CoalTipple/CoalHearth runner (node --test
// with a directory arg proved unreliable on Node 24; a missing listed file must
// fail loud, never silently zero-match).
//
// 09a: the files run through the canon wave runner (scripts/lib/wave-run.mjs, adopted by blob id from the .github canon): one
// `node --test --test-reporter=tap --test-force-exit` child per file, the next admitted only while a fresh machine reading says
// BREATHE (machine-reading.mjs, CoalFace's file), under the room's heap cap (it rides NODE_OPTIONS, so a test's own spawns inherit
// it), the clock per test, the wall clock per file and the whole-run deadline that kills the child TREE, with stdout-sync.mjs
// preloaded so a force-exited file keeps its tail. The numbers and the room's checks are scripts/lib/test-plan.mjs. The suite is
// judged by what the TAP says (testing.md, the TAP-names MUST): a file that exits 0 before its tests register is VACUOUS (the
// canon), and a file that reports fewer tests than it declares at top level is FAIL (the room's floor), so either turns the run RED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TESTS = [
  'scripts/lib/jsonc.test.mjs',
  'scripts/lib/config-schema.test.mjs',
  'scripts/lib/config-load.test.mjs',
  'scripts/lib/class-b.test.mjs',
  'scripts/lib/caliper.test.mjs',
  'scripts/lib/fidelity-gate.test.mjs',
  'scripts/lib/apply.test.mjs',
  'scripts/lib/input-contract.test.mjs',
  'scripts/lib/keeps.test.mjs',
  'scripts/lib/retention-policy.test.mjs',
  'scripts/lib/cli.test.mjs',
  'scripts/lib/dig-gauge.test.mjs',
  'scripts/lib/explode.test.mjs',
  'scripts/lib/detonate.test.mjs',
  'scripts/lib/classa-no-auto.test.mjs',
  'scripts/lib/receipt.test.mjs',
  'scripts/lib/conductor.test.mjs',
  'scripts/lib/ask.test.mjs',
  'scripts/lib/tailings.test.mjs',
  'scripts/lib/broom.test.mjs',
  'scripts/lib/wizard.test.mjs',
  'scripts/lib/parcel.test.mjs',
  'scripts/lib/writeguard.test.mjs',
  'scripts/lib/anchor-diff.test.mjs',
  'scripts/lib/estate.test.mjs',
  'scripts/lib/estate-archive.test.mjs',
  'scripts/lib/retier.test.mjs',
  'scripts/lib/gate-liveness.test.mjs',
  'scripts/lib/twin-pin.test.mjs',
  'scripts/lib/fixture-canonical.test.mjs',
  'scripts/lib/root-provenance.test.mjs',
  'scripts/lib/repo-fs.test.mjs',
  'scripts/build-plugin.test.mjs',
  'scripts/verify.test.mjs',
  'scripts/config-keys.test.mjs',
  'scripts/configure.test.mjs',
  'scripts/pointer-check.test.mjs',
  'scripts/link-check.test.mjs',
  'scripts/git-env.test.mjs',
  'scripts/lib/git-env-census.test.mjs',
  'scripts/lib/git-env-pins.test.mjs',
  'scripts/lib/wave-run.test.mjs',
  'scripts/lib/test-plan.test.mjs',
  'scripts/workflow-hygiene.test.mjs',
  'scripts/secret-scan.test.mjs',
  'scripts/secret-gate.test.mjs',
  'scripts/release-notes.test.mjs',
  'scripts/verify-release-shape.test.mjs',
  'scripts/lib/release-shape.test.mjs',
];

// CWK-071 (node/runtime.md §7): process.exitCode + a natural exit at all three
// sites, never process.exit() — it 'forces the process to exit as quickly as
// possible even with asynchronous operations pending, including I/O to
// process.stdout and process.stderr'.
//
// WRAPPED IN main() rather than converted in place, and the wrap is what keeps
// the SEMANTICS identical: these were three EARLY EXITS at module top level,
// so setting exitCode alone would have let a missing-file run fall straight
// through into the orphan scan and then SPAWN the suite anyway. `return`
// reproduces the stop; the flag carries the code.
//
// 09a: main() is async (the wave runner is), and the entry catches its rejection (node/runtime.md §7: an async entrypoint's
// rejection escapes a sync try/catch and would crash with a stack, not a named FAIL line).
async function main() {
  const missing = TESTS.filter((t) => !fs.existsSync(path.join(repo, t)));
  if (missing.length) {
    console.error(`test runner: ${missing.length} listed test file(s) MISSING — ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const onDisk = [];
  for (const dir of ['scripts', 'scripts/lib', 'hooks']) {
    for (const f of fs.readdirSync(path.join(repo, dir))) {
      if (f.endsWith('.test.mjs') || f.endsWith('.test.js')) onDisk.push(`${dir}/${f}`);
    }
  }
  const orphans = onDisk.filter((f) => !TESTS.includes(f));
  if (orphans.length) {
    console.error(`test runner: ${orphans.length} on-disk test(s) NOT in the suite — ${orphans.join(', ')}. Add to scripts/test.mjs.`);
    process.exitCode = 1;
    return;
  }

  // node/runtime.md §1: the room's own libs are imported inside main, so a missing one is a named FAIL line and a red exit, never a link-time stack.
  let wave;
  let plan;
  try {
    wave = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'wave-run.mjs')).href);
    plan = await import(pathToFileURL(path.join(repo, 'scripts', 'lib', 'test-plan.mjs')).href);
  } catch (e) {
    console.log(`FAIL test runner: cannot load the wave runner or scripts/lib/test-plan.mjs (${e && e.code ? e.code : e.message}) -- restore it from git; the suite is not run without it`);
    process.exitCode = 1;
    return;
  }
  // COALWASH_TEST_CONCURRENCY=1 (opt-in): one file at a time with no machine reading (the canon runner's --serial). Any other value is
  // ignored: since 09a the width is the live reading's, never a count of ours (AGENTS.md THE MACHINE BOUND).
  const serial = process.env.COALWASH_TEST_CONCURRENCY === '1';
  let run;
  try {
    run = await wave.runWaves({ files: TESTS, cwd: repo, env: process.env, heapMb: plan.HEAP_MB, fileTimeoutMs: plan.TEST_TIMEOUT_MS, fileClockMs: plan.FILE_CLOCK_MS, deadlineMs: plan.RUN_TIMEOUT_MS, serial });
  } catch (e) {
    console.log(`FAIL test runner: the run did not start (${e && e.message ? e.message : 'error'})`);
    process.exitCode = 1;
    return;
  }
  // Every file is put back in roster order, the declared-test floor is applied, and ONE summary line reconciles the whole roster. Since 09b
  // every file runs under the wave runner, wave-run.test.mjs included (the canon's recorder child sets its own NODE_OPTIONS, K3).
  const byFile = new Map(run.results.map((r) => [r.file, r]));
  const results = plan.shortfallResults(TESTS.map((f) => byFile.get(f)), (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } });
  for (const r of results) {
    if (r.status === 'PASS' || r.status === 'SKIP') continue;
    console.log(`${r.status} ${r.name || r.file}: ${r.reason}`);
    if (r.stdout || r.stderr) console.error(`--- ${r.name || r.file} (${r.status}) ---\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  const summary = wave.summarize(results, TESTS.length);
  console.log(summary.line);
  process.exitCode = summary.red ? 1 : 0;
}
main().catch((e) => {
  console.log(`FAIL test runner: crashed (${e && e.message ? e.message : 'error'})`);
  process.exitCode = 1;
});
