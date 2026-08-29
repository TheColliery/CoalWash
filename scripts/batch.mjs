#!/usr/bin/env node
// CWK-019 step 1 — the per-run capture instrument. Runs scripts/test.mjs N
// times and logs EVERY run's full output to its own file, from run 1,
// unconditionally — never only-on-failure. Born from CWK-012's own failure:
// a batch run read 1114/1109/1 fail with no per-run capture, and the
// failing test's identity was permanently lost. Twice.
//
// Top-level scripts/ (not scripts/lib/), so it ships nowhere and trips no
// roster: DIST_ITEMS (build-plugin.mjs) carries scripts/lib only; verify.mjs's
// LIBS roster reads scripts/lib only; test.mjs's own roster covers *.test.mjs
// only. No dist change, no version, no CHANGELOG entry.
//
// Zero-dep, node builtins only. No test file for this — a top-level lab
// instrument, same standing as test.mjs itself (also unshipped, also
// untested — scripts-quality.md §2 binds scripts/lib/ shared logic, not a
// top-level CLI). No wall-clock assertions anywhere below: this instrument
// exists to DIAGNOSE a flake, not become one (CWK-012 site 1's own lesson).
//
// KNOWN BOUND, not a fix: there is no SIGINT/SIGTERM handler, so a batch
// process that is itself signalled (Ctrl-C, a harness tool-timeout kill)
// skips the `finally` block below entirely and stopContention() never runs.
// Observed once: the children died with the parent anyway on this host, so
// the theoretical leak has not materialized -- but that is a property of
// this host's process-group behaviour, not a guarantee this file makes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { runs: 5, contention: 0, help: false };
  for (const a of argv) {
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--runs=')) out.runs = Number(a.slice('--runs='.length));
    else if (a.startsWith('--contention=')) out.contention = Number(a.slice('--contention='.length));
  }
  return out;
}

function usage() {
  console.log(`usage: node scripts/batch.mjs [--runs=N] [--contention=K]

  --runs=N        run the gate suite N times (default 5). Every run's full
                  output is captured to its own log file from run 1.
  --contention=K  spawn K background CPU-burn processes for the duration of
                  the batch (default 0 = idle). The flake this instrument
                  exists to catch is load-dependent -- an idle batch proves
                  little. Reaped unconditionally when the batch ends, even
                  on an error partway through.

Logs land under scratchpad/batch-runs/<timestamp>/ (gitignored).
Exit code: 0 if every run was clean, 1 if any run had a failure.`);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Pure CPU burner, spawned via `node -e` — no extra file on disk, no
// scripts/lib/ litter (the exact class CWK-012 site 4 already fixed once).
const BURNER_SRC = "let x=0;const end=Date.now()+3600000;while(Date.now()<end){for(let i=0;i<5000000;i++)x+=Math.sqrt(i)%7;}";

function startContention(k) {
  const children = [];
  for (let i = 0; i < k; i++) {
    const child = spawn(process.execPath, ['-e', BURNER_SRC], { stdio: 'ignore' });
    child.on('error', () => { /* best-effort — a burner failing to spawn does not abort the batch */ });
    children.push(child);
  }
  return children;
}

// CWK-019 bounce F2: `child.killed` is set when the signal is successfully
// SENT, not when the child actually dies -- checking it immediately after
// kill() made the "did it die" question always answer yes, so the warning
// branch below could never fire (measured: killed=true exitCode=null
// signalCode=null right after kill(), for a process that was still very
// much alive). The real signal is the 'exit' event -- fired only once the
// OS has reaped the process -- so this WAITS for it, bounded, rather than
// sampling a flag that lies. A bounded wait for a real event is not a
// wall-clock ASSERTION (the rail this file itself declares) -- it never
// passes/fails a test on elapsed time; it only decides how long to keep
// checking before reporting "still alive" honestly.
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
    function onExit() { clearTimeout(timer); resolve(true); }
    child.once('exit', onExit);
  });
}

async function stopContention(children, timeoutMs = 2000) {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  // Surface anything that refused to die so a leaked spinner is visible,
  // never silent (CWK-019's own rail: a leaked spinner is worse than none).
  const exited = await Promise.all(children.map((c) => waitForExit(c, timeoutMs)));
  const stillAlive = children.filter((c, i) => !exited[i]);
  return stillAlive.length;
}

// Extract the aggregate `ℹ tests/pass/fail/cancelled/skipped/todo` block
// (the LAST occurrence -- test.mjs's single `node --test <files>` invocation
// prints one rollup at the end) and every distinct `✖ <name> (Nms)` failing
// test line (deduped -- each failure is printed once inline and again in the
// "failing tests:" recap, byte-identical both times).
function summarize(output) {
  const lines = output.split(/\r?\n/);
  const fields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const shape = {};
  for (const f of fields) {
    const re = new RegExp(`^ℹ ${f} (\\d+)$`);
    for (const line of lines) {
      const m = re.exec(line);
      if (m) shape[f] = Number(m[1]); // keep overwriting -- last match wins (the final rollup)
    }
  }
  const failNames = new Set();
  const failRe = /^✖ (.+?) \(\d+(?:\.\d+)?ms\)$/;
  for (const line of lines) {
    if (line === '✖ failing tests:') continue;
    const m = failRe.exec(line);
    if (m) failNames.add(m[1]);
  }
  return { shape, failNames: [...failNames] };
}

function shapeLine(shape) {
  if (!('tests' in shape)) return '(no ℹ tests summary line found in this run\'s output -- see the log file)';
  return `${shape.tests} tests / ${shape.pass} pass / ${shape.fail} fail / ${shape.skipped} skipped / ${shape.todo} todo`;
}

// CWK-019 bounce F1: when a whole test FILE aborts (node:test reports the
// FILE itself as the ✖, e.g. `✖ scripts\lib\conductor.test.mjs`, `'test
// failed'`), every test inside it is counted neither pass nor fail -- the
// `tests` figure silently shrinks and shapeLine alone never shows it. Run
// 1's own `tests` count is the batch's expected denominator; any later run
// that disagrees is flagged by name, never silently absorbed into a smaller
// "N tests" line.
function collapsedNote(shape, baselineTests) {
  if (baselineTests === null || !Number.isFinite(shape.tests) || shape.tests === baselineTests) return null;
  const diff = baselineTests - shape.tests;
  return diff > 0
    ? `⚠ ${shape.tests} tests, ${diff} FEWER than run 1 (${baselineTests}): a file likely aborted`
    : `⚠ ${shape.tests} tests, ${-diff} MORE than run 1 (${baselineTests}): unexpected -- investigate`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !Number.isFinite(args.runs) || args.runs < 1) { usage(); process.exitCode = args.help ? 0 : 1; return; }

  const logDir = path.join(repo, 'scratchpad', 'batch-runs', nowStamp());
  fs.mkdirSync(logDir, { recursive: true });

  let burners = [];
  if (args.contention > 0) {
    console.log(`[batch] starting ${args.contention}-way CPU contention (background, reaped at the end)`);
    burners = startContention(args.contention);
  }

  const results = [];
  let baselineTests = null; // set from run 1's own `tests` count -- the batch's expected denominator
  try {
    for (let i = 1; i <= args.runs; i++) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'test.mjs')], { cwd: repo, encoding: 'utf8' });
      const elapsedMs = Date.now() - t0; // reported as INFORMATION only, never asserted on
      const combined = (r.stdout || '') + (r.stderr || '');
      const logPath = path.join(logDir, `run-${String(i).padStart(String(args.runs).length, '0')}.log`);
      fs.writeFileSync(logPath, combined, 'utf8'); // captured from run 1, unconditionally -- never only-on-failure

      const { shape, failNames } = summarize(combined);
      if (baselineTests === null && Number.isFinite(shape.tests)) baselineTests = shape.tests;
      const collapse = collapsedNote(shape, baselineTests);
      const gateFailed = r.status !== 0 || (shape.fail ?? 1) !== 0 || collapse !== null;
      results.push({ run: i, gateFailed, shape, failNames, collapse, logPath, elapsedMs, status: r.status });

      console.log(`[batch] run ${i}/${args.runs}: ${shapeLine(shape)} (${(elapsedMs / 1000).toFixed(1)}s, exit ${r.status}) -> ${logPath}`);
      if (collapse) console.log(`[batch]   ${collapse}`); // printed regardless of gateFailed -- a collapsed denominator is its own signal
      if (gateFailed) {
        for (const name of failNames) console.log(`[batch]   ✖ ${name}`);
        if (failNames.length === 0 && !collapse) console.log('[batch]   (gate exited non-zero but no ✖ line matched -- read the log directly)');
      }
    }
  } finally {
    if (burners.length) {
      const leaked = await stopContention(burners);
      if (leaked > 0) console.log(`[batch] WARNING: ${leaked}/${burners.length} contention process(es) did not confirm exit after kill() -- check the OS process list`);
      else console.log(`[batch] contention reaped: ${burners.length}/${burners.length}`);
    }
  }

  const clean = results.filter((r) => !r.gateFailed).length;
  const dirty = results.filter((r) => r.gateFailed);
  console.log('');
  console.log(`[batch] ${results.length} runs, ${clean} clean, ${dirty.length} with failures. Logs: ${logDir}`);
  for (const r of dirty) {
    const parts = [];
    if (r.collapse) parts.push(r.collapse);
    if (r.failNames.length) parts.push(...r.failNames);
    if (parts.length === 0) parts.push('(unnamed -- read ' + r.logPath + ')');
    console.log(`[batch]   run ${r.run}: ${parts.join(' | ')}`);
  }
  process.exitCode = dirty.length > 0 ? 1 : 0;
}

main();
