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
  'scripts/lib/keeps.test.mjs',
  'scripts/lib/retention-policy.test.mjs',
  'scripts/lib/cli.test.mjs',
  'scripts/lib/receipt.test.mjs',
  'scripts/lib/conductor.test.mjs',
  'scripts/lib/ask.test.mjs',
  'scripts/lib/bins.test.mjs',
  'scripts/lib/quick.test.mjs',
  'scripts/lib/wizard.test.mjs',
  'scripts/lib/parcel.test.mjs',
  'scripts/lib/writeguard.test.mjs',
  'scripts/lib/anchor-diff.test.mjs',
  'scripts/lib/estate.test.mjs',
  'scripts/lib/estate-archive.test.mjs',
  'scripts/build-plugin.test.mjs',
];

const missing = TESTS.filter((t) => !fs.existsSync(path.join(repo, t)));
if (missing.length) {
  console.error(`test runner: ${missing.length} listed test file(s) MISSING — ${missing.join(', ')}`);
  process.exit(1);
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
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: repo, stdio: 'inherit' });
process.exit(r.status ?? 1);
