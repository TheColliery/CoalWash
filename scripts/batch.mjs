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

function stopContention(children) {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  // Best-effort reap confirmation -- do not block the batch on it, but
  // surface anything that refused to die so a leaked spinner is visible,
  // never silent (CWK-019's own rail: a leaked spinner is worse than none).
  const stillAlive = children.filter((c) => c.exitCode === null && c.signalCode === null && !c.killed);
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
  try {
    for (let i = 1; i <= args.runs; i++) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'test.mjs')], { cwd: repo, encoding: 'utf8' });
      const elapsedMs = Date.now() - t0; // reported as INFORMATION only, never asserted on
      const combined = (r.stdout || '') + (r.stderr || '');
      const logPath = path.join(logDir, `run-${String(i).padStart(String(args.runs).length, '0')}.log`);
      fs.writeFileSync(logPath, combined, 'utf8'); // captured from run 1, unconditionally -- never only-on-failure

      const { shape, failNames } = summarize(combined);
      const gateFailed = r.status !== 0 || (shape.fail ?? 1) !== 0;
      results.push({ run: i, gateFailed, shape, failNames, logPath, elapsedMs, status: r.status });

      console.log(`[batch] run ${i}/${args.runs}: ${shapeLine(shape)} (${(elapsedMs / 1000).toFixed(1)}s, exit ${r.status}) -> ${logPath}`);
      if (gateFailed) {
        for (const name of failNames) console.log(`[batch]   ✖ ${name}`);
        if (failNames.length === 0) console.log('[batch]   (gate exited non-zero but no ✖ line matched -- read the log directly)');
      }
    }
  } finally {
    if (burners.length) {
      const leaked = stopContention(burners);
      if (leaked > 0) console.log(`[batch] WARNING: ${leaked}/${burners.length} contention process(es) did not confirm exit after kill() -- check the OS process list`);
      else console.log(`[batch] contention reaped: ${burners.length}/${burners.length}`);
    }
  }

  const clean = results.filter((r) => !r.gateFailed).length;
  const dirty = results.filter((r) => r.gateFailed);
  console.log('');
  console.log(`[batch] ${results.length} runs, ${clean} clean, ${dirty.length} with failures. Logs: ${logDir}`);
  for (const r of dirty) {
    const names = r.failNames.length ? r.failNames.join(' | ') : '(unnamed -- read ' + r.logPath + ')';
    console.log(`[batch]   run ${r.run}: ${names}`);
  }
  process.exitCode = dirty.length > 0 ? 1 : 0;
}

main();
