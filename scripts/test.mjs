#!/usr/bin/env node
// CoalWash test runner — the canonical gate suite. Enumerates EVERY test file
// explicitly and FAILS LOUD on drift in BOTH directions (listed-but-missing,
// on-disk-but-unlisted). Mirrors the CoalTipple/CoalHearth runner (node --test
// with a directory arg proved unreliable on Node 24; a missing listed file must
// fail loud, never silently zero-match).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  'scripts/build-plugin.test.mjs',
  'scripts/verify.test.mjs',
  'scripts/config-keys.test.mjs',
  'scripts/configure.test.mjs',
  'scripts/pointer-check.test.mjs',
  'scripts/link-check.test.mjs',
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
// The spawn site is the one worth stating: the child runs with
// stdio:'inherit', so it writes to OUR stdout directly and this process has no
// pending output of its own to lose — the natural exit still carries the
// child's status because nothing else sets exitCode afterwards. Proven by
// running it both ways rather than assumed (see the CWK-071 commit).
function main() {
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

  const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: repo, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
main();
