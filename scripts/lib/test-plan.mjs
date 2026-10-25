// The room's numbers for the canon wave runner, and the room's expectation check on what a run reported (09a). scripts/lib/wave-run.mjs (adopted by blob id
// from the .github canon) ships NO number of its own: the heap cap, the clock per test, the clock per file and the whole-run deadline are flags the room
// passes, and these are this room's. The shape is CoalLedger's scripts/lib/test-plan.mjs (09a), with this room's numbers and one change: a file that reports
// fewer tests than it declares is turned into a FAIL result (shortfallResults), so the run's ONE summary line reconciles it and reads RED.
//
// Dev tooling: scripts/test.mjs imports it, shipped code never does (build-plugin.mjs DEV_ONLY_LIBS; verify.mjs's lib roster names it).
// Since 09b every roster file runs under the canon runner: the 09a direct run of wave-run.test.mjs is gone (the canon's recorder child sets its own
// NODE_OPTIONS, K3), so this file holds only the numbers, the floor and, since fire 63, the tests' teardown removal (removeTree).
import fs from 'node:fs';

// BASIS, measured on this box, Node 24.19, 2026-10-09, 48 files through runWaves (scratchpad/09a/measure-waves.out; re-derive: that script, or the wave
// events of a run): the slowest file 78.3 s (apply.test.mjs) with up to three files running on a box already 73.6% busy; the whole run 333 s wall.
export const HEAP_MB = 2048; // dispatch-transport.md ninth amendment: every test child runs under a heap cap of 2048 MB or lower (the cap rides NODE_OPTIONS, so a test's own spawns inherit it)
export const SLOWEST_FILE_MS = 78300; // the BASIS above: apply.test.mjs under load, 2026-10-09 (re-measured 2026-10-14 alone, Node 24: 45.8-73.6 s, n=4)
// The CI basis (L54-1, 15b fire 56): CI's `gate (windows-latest · node 22)` cut apply.test.mjs at 120,006 ms on 78f24f2 (check-run 115828019366,
// 2026-10-14: "test timed out after 120000ms"). The green run on a4ea8a6 prints no per-file time (only the wave-run summary line), so this is a
// LOWER bound: the file takes at least this long on that leg. The clocks below are sized from the larger of the two bases.
export const CI_SLOWEST_FILE_MIN_MS = 120006;
// per TEST on Node 24 (--test-timeout), but per FILE on Node 22 (per test only since Node 24, nodejs/node #57672), so it is sized as a file clock:
// 3.04x the larger basis (CI_SLOWEST_FILE_MIN_MS). At 120000 it cut apply.test.mjs on CI's Windows Node 22 leg (78f24f2); 240000 (a4ea8a6) cleared the
// box's figure 3x but only the CI lower bound 2x (L54-1). The slowest single test is 20-39 s (apply.test.mjs's 8,000-name git fixture, 2026-10-14).
export const TEST_TIMEOUT_MS = 365000;
export const FILE_CLOCK_MS = 420000; // per FILE wall clock: 3.5x the larger basis, above the per-test bound; it ends a hang before the first test, which --test-timeout never reaches
export const RUN_TIMEOUT_MS = 600000; // the whole run, unchanged from CWK-154 (2): 1.8x the measured wave run (333 s), above the file clock so one hung file is ended by its own clock first, and inside the gate job's 15-minute timeout-minutes in ci.yml

// The suite's TEARDOWN removal (fire 63; PR #22's red, job 116559157309: EBUSY from apply.test.mjs's clean() on windows-latest). Windows refuses to
// remove a directory a live process holds as its cwd. When spawnSync kills Git for Windows' launcher (cmd\git.exe) on ENOBUFS or a timeout, the real
// git.exe it started lives on with its cwd inside the test project (2.9-7.6 s, n=6, this box, scratchpad/14a/e63-linger.out), and spawnSync cannot wait
// for a grandchild. So every teardown removal of a temp project that ran git goes through removeTree, which retries on EBUSY/EPERM/ENOTEMPTY with fresh
// calls until TEARDOWN_BUDGET_MS. Node's own rmSync { maxRetries: 24, retryDelay: 100 } is not the instrument, because on Node 24.19 / Windows it
// waits for one holding shape and not another (scratchpad/14a, each probe run twice): with git's cwd held in a SUBDIRECTORY of the removed tree it
// retried and cleared in 4.0-7.2 s (e63-retryopt.out, e63-retryopt-2.out, 6 of 6), but with the removed directory ITSELF held as a child's cwd it
// raised EPERM after 0 ms and removed nothing (e63-rmprobe.out, 2 of 2); and a retrying call made after one plain call had already failed did not
// clear the git shape in 30 s (e63-witness-retry24.out, 5 of 5). A loop of fresh calls cleared both shapes (e63-witness-fix.out, 10 of 10; the
// held-cwd test in test-plan.test.mjs). A directory still held past the budget throws: a real leak stays loud.
export const GIT_LINGER_MAX_MS = 7639; // the longest the real git.exe outlived the killed launcher on this box (e63-linger.out, n=6)
export const TEARDOWN_BUDGET_MS = 30000; // about 4x GIT_LINGER_MAX_MS, and well inside the per-test clock
export const TEARDOWN_POLL_MS = 100;
const HELD = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
export function removeTree(dir, { budgetMs = TEARDOWN_BUDGET_MS, pollMs = TEARDOWN_POLL_MS } = {}) {
  const until = Date.now() + budgetMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (!(e && HELD.has(e.code)) || Date.now() >= until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs); // a synchronous wait: teardowns run in finally blocks and t.after alike
    }
  }
}

// The expectation check (testing.md: a gate judges a run by the TAP test names it expects, never by the exit code and pass count alone). wave-run reads a
// file whose only result line names the file itself as VACUOUS (process.exit(0) before the tests, or inside the first), and names one gap open: a file whose
// test calls process.exit(0) AFTER another test already passed reports only the tests that finished, and reads as a PASS. This closes that gap with a lower
// bound read from the file: every `test(` call that starts a line in column 0 is a top-level registration that runs unconditionally, so the TAP summary
// cannot report fewer tests than that count unless the file stopped before registering them. Generated tests (a loop, a helper) only add to the count.
// NAMED LIMIT: it is a COUNT of the names a file declares, not the names: a PASS file's TAP is not kept by the canon runner (runWaves keeps it for FAIL and
// VACUOUS only), so a declared test replaced by another of the same count is not seen.
export function declaredTopLevelTests(text) {
  const m = String(text).replace(/\r\n/g, '\n').match(/^test(?:\.(?:skip|todo|only))?\(/gm);
  return m ? m.length : 0;
}

// results: the `results` array of runWaves (file, status, counts); read(file) returns the file's text or null. A PASS or SKIP file that reported fewer tests
// than it declares comes back as a FAIL result naming both numbers; every other result comes back unchanged. Returns a new array.
export function shortfallResults(results, read) {
  return results.map((r) => {
    if (r.status !== 'PASS' && r.status !== 'SKIP') return r; // a red file is already red
    const text = read(r.file);
    if (typeof text !== 'string') return r;
    const declared = declaredTopLevelTests(text);
    const reported = r.counts ? r.counts.tests : 0;
    if (declared <= reported) return r;
    return { ...r, status: 'FAIL', reason: `declares ${declared} top-level test(s) but the run reported ${reported} (it stopped before registering the rest: an exit, a throw the runner swallowed, or a hang the force-exit ended)` };
  });
}
