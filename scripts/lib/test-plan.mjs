// The room's numbers for the canon wave runner, and the room's expectation check on what a run reported (09a). scripts/lib/wave-run.mjs (adopted by blob id
// from the .github canon) ships NO number of its own: the heap cap, the clock per test, the clock per file and the whole-run deadline are flags the room
// passes, and these are this room's. The shape is CoalLedger's scripts/lib/test-plan.mjs (09a), with this room's numbers and one change: a file that reports
// fewer tests than it declares is turned into a FAIL result (shortfallResults), so the run's ONE summary line reconciles it and reads RED.
//
// Dev tooling: scripts/test.mjs imports it, shipped code never does (build-plugin.mjs DEV_ONLY_LIBS; verify.mjs's lib roster names it).
import { spawnSync } from 'node:child_process';
import { classifyFile, nodeOptionsWithHeap } from './wave-run.mjs';

// BASIS, measured on this box, Node 24.19, 2026-10-09, 48 files through runWaves (scratchpad/09a/measure-waves.out; re-derive: that script, or the wave
// events of a run): the slowest file 78.3 s (apply.test.mjs) with up to three files running on a box already 73.6% busy; the whole run 333 s wall.
export const HEAP_MB = 2048; // dispatch-transport.md ninth amendment: every test child runs under a heap cap of 2048 MB or lower (the cap rides NODE_OPTIONS, so a test's own spawns inherit it)
export const TEST_TIMEOUT_MS = 120000; // per TEST (--test-timeout), the room's figure since CWK-154 (2): the slowest single test measured 2.2 s
export const FILE_CLOCK_MS = 300000; // per FILE wall clock: 3.8x the slowest file measured under load; it ends a hang before the first test, which --test-timeout never reaches
export const RUN_TIMEOUT_MS = 600000; // the whole run, unchanged from CWK-154 (2): 1.8x the measured wave run, inside the gate job's 15-minute timeout-minutes in ci.yml

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

// NAMED DIVERGENCE FROM THE CANON RUNNER (CoalLedger's, measured again here 2026-10-09): one test of scripts/lib/wave-run.test.mjs ("the stdout preload switches
// BOTH pipes") spawns a child that inherits NODE_OPTIONS; run BY wave-run, that env already carries the runner's own --import stdout-sync.mjs, which loads before
// the test's recorder and hides the two calls it counts, so the file is RED under the canon runner and GREEN under a plain `node --test`. It is run directly,
// with the same heap cap, clocks and TAP reading, and held out of the wave roster; delete this the day the canon test sets its own NODE_OPTIONS.
export const DIRECT_FILES = ['scripts/lib/wave-run.test.mjs'];

export function runDirect(file, { cwd, env }) {
  const childEnv = { ...env, NODE_OPTIONS: nodeOptionsWithHeap(env.NODE_OPTIONS, HEAP_MB) };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-timeout=${TEST_TIMEOUT_MS}`, '--test-force-exit', file], {
    cwd, env: childEnv, encoding: 'utf8', timeout: FILE_CLOCK_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 26,
  });
  const killedBy = r.error ? `killed at the file clock (${FILE_CLOCK_MS} ms): ${r.error.code || r.error.message}` : null;
  const res = classifyFile({ file, code: r.status, signal: r.signal, stdout: r.stdout || '', killedBy });
  res.name = file;
  if (res.status === 'FAIL' || res.status === 'VACUOUS') { res.stdout = r.stdout || ''; res.stderr = r.stderr || ''; }
  return res;
}
