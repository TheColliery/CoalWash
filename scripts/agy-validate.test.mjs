// Provenance: a copy of CoalLedger scripts/agy-validate.test.mjs (git blob c5474176778c2a873265c78201f3e72d889ed279), taken for the 29e AG transport. The body is CoalLedger's, unchanged.
// The Antigravity route: the AG manifest carries the marketplace fields, and agy's own validator reads the built
// plugin with no error and no missing-logo note. agy is probed, never decided by platform: where it is not on PATH the test skips VISIBLY.
// Strict mode cannot pass on this dist: plugin/ ships commands/ and hooks/hooks.json for the Claude Code route, and the AG
// validator names both as never loaded. So the test pins the warnings to exactly those two named entries and fails on any other.
// Named divergence: CoalHearth ships .antigravity-plugin/plugin.json beside its root plugin.json. AG reads only the root
// plugin.json, so that second file would be read by nothing and is not shipped here.
// Provenance: a copy of CoalHearth's scripts/agy-validate.test.mjs (84226de), itself a copy of CoalMine's (f75e52a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAgy, validateAgyPlugin, agyEnv } from './lib/agy-probe.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGY_TIMEOUT_MS = 120000;
// Pinned to agy 1.4.12's own report on this dist (`agy plugin validate plugin --json`, read 2026-10-31). `commands` and
// `hooks/hooks.json` are the Claude Code route's files, which AG never loads. `skills/coalwash/SKILL.md` is a body-length
// finding: AG loads the first 24000 bytes of a 28938-byte body. That is a skill-surface fact, owned by the skill's own belt,
// and it stays named here until that belt cuts the body.
const NAMED_WARNING_FILES = ['commands', 'hooks/hooks.json', 'skills/coalwash/SKILL.md'];
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('the AG manifest carries the marketplace fields and the Claude Code version', () => {
  const ag = readJson(path.join(repo, 'plugin.json'));
  const claude = readJson(path.join(repo, '.claude-plugin', 'plugin.json'));
  for (const key of ['displayName', 'description', 'version', 'logo', 'author']) {
    assert.ok(ag[key], `plugin.json has no ${key}`);
  }
  assert.equal(ag.name, claude.name, 'AG and Claude Code manifests disagree on name');
  assert.equal(ag.description, claude.description, 'AG and Claude Code manifests disagree on description');
  assert.equal(ag.author, claude.author.name, 'AG author is not the Claude Code author.name');
  assert.equal(ag.version, claude.version, 'AG and Claude Code manifests disagree on version');
  assert.ok(fs.existsSync(path.join(repo, ag.logo)), `logo ${ag.logo} is not in the repo`);
});

test('agy validate: the built plugin has no error, no missing-logo note, and only the named warnings', (t) => {
  // agy writes its config under the profile folders, so the run gets a temp HOME, removed after.
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'coalledger-agyval-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
  const env = agyEnv(home);
  // Skip ONLY when agy is absent; a probe that hangs or fails is a failure, not a skip.
  const probe = probeAgy({ timeoutMs: AGY_TIMEOUT_MS, env });
  if (probe.state === 'absent') { t.skip(`AG plugin validation not run: ${probe.reason}`); return; }
  assert.equal(probe.state, 'present', `agy probe failed (not a skip): ${probe.reason}`);

  const r = validateAgyPlugin({ pluginDir: path.join(repo, 'plugin'), env, timeoutMs: AGY_TIMEOUT_MS });
  assert.equal(r.error, undefined, `agy plugin validate did not run: ${r.error && r.error.code}`);
  // Exit status first: a report can parse and carry no error entry while the validator exited non-zero (agy --strict exits 1 on warnings alone).
  assert.equal(r.status, 0, `agy plugin validate exited ${r.status}, not 0: ${r.stderr}`);
  let report;
  try { report = JSON.parse(r.stdout); } catch (e) {
    assert.fail(`agy plugin validate printed no JSON report (exit ${r.status}): ${e.message}\n${r.stdout}\n${r.stderr}`);
  }

  const all = report.findings || [];
  assert.deepEqual(
    all.filter((f) => f.severity === 'error').map((f) => `${f.file}: ${f.message}`), [],
    'agy reports error entries on the built plugin',
  );
  assert.equal(all.some((f) => /no logo/.test(f.message)), false, 'agy still reports no logo');
  const warnings = all.filter((f) => f.severity === 'warning').map((f) => f.file).sort();
  assert.deepEqual(warnings, [...NAMED_WARNING_FILES].sort(), 'AG warnings differ from the named set');
});
